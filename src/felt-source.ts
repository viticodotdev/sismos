/**
 * Felt reports as an independent source of truth.
 *
 * Unlike the feed (which fires on "a new quake happened"), this detector fires
 * on "people are feeling something" — a signal that moves on its own. Two
 * triggers, both configurable:
 *
 *   1. NEW FELT EVENT   — a unid appears in the felt service with
 *      ev_nbtestimonies >= feltAlertAt (catches quakes the feed dropped, e.g.
 *      below the magnitude floor).
 *   2. FELT JUMP        — an event's felt count climbs by >= feltJumpBy since
 *      we last saw it (escalating human impact the feed never reports).
 *
 * State is a module-level Map of unid -> {count, lastAlert}, so it persists
 * across ticks in the long-lived self-host container. On Vercel (fresh process
 * per invocation) state resets each call, so felt-as-source only works
 * reliably on self-host — do not enable on a stateless deployment.
 */

import type { MarkdownField, NtfyConfig } from "./ntfy"
import { buildNtfyPayload, markdownMessage, publishNtfy } from "./ntfy"
import { unionBbox, type RegionDef } from "./regions"

const FELT_URL = "https://www.seismicportal.eu/testimonies-ws/api/search"

export interface FeltSourceConfig {
  /** Min felt count for a NEW felt event to alert on. 0 = disable new-event trigger. */
  feltAlertAt: number
  /** Min felt-count climb to fire a jump alert. 0 = disable the jump trigger. */
  feltJumpBy: number
  /** Min seconds between felt alerts for the SAME unid (anti-spam on creeping counts). */
  cooldownSec: number
  regions: RegionDef[] | "all"
  dryRun: boolean
}

export const DEFAULT_FELT_SOURCE_CONFIG: FeltSourceConfig = {
  feltAlertAt: 5,
  feltJumpBy: 15,
  cooldownSec: 30 * 60, // 30 min
  regions: "all",
  dryRun: false,
}

export interface FeltEvent {
  unid: string
  feltCount: number
  mag: number | null
  region: string
  eventTime: string
}

export interface FeltAlert {
  unid: string
  kind: "new" | "jump" | "rearm"
  feltCount: number
  prevCount?: number
  mag: number | null
  region: string
  eventTime: string
}

export interface FeltSourceResult {
  ok: boolean
  status: number
  seen: number
  newEvents: number
  jumps: number
  alerts: FeltAlert[]
  errors: string[]
}

interface FeltState {
  count: number
  lastAlertAt: number
}

const state = new Map<string, FeltState>()
/** true once the first pass has recorded baseline counts (startup flood guard). */
let warmedUp = false
/** Only alert on a NEW felt event when it is this fresh (hours). */
const NEW_EVENT_AGE_HOURS = 48

/** Query the felt service for events in a bbox that have at least 1 report. */
async function queryFelt(bbox?: { minlatitude: number; maxlatitude: number; minlongitude: number; maxlongitude: number }): Promise<FeltEvent[]> {
  const params = new URLSearchParams({ format: "json", limit: "100", minnbtestimonies: "1" })
  if (bbox) {
    params.set("minlatitude", String(bbox.minlatitude))
    params.set("maxlatitude", String(bbox.maxlatitude))
    params.set("minlongitude", String(bbox.minlongitude))
    params.set("maxlongitude", String(bbox.maxlongitude))
  }
  const res = await fetch(`${FELT_URL}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "dr-seismic-alerts/1.0 (ntfy alert bot)" },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 204) return []
  if (!res.ok) throw new Error(`Felt query failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`)
  const raw = await res.text()
  if (!raw.trim()) return []
  const list = JSON.parse(raw) as Array<{
    ev_unid?: string
    ev_nbtestimonies?: number
    ev_mag_value?: number
    ev_region?: string
    ev_event_time?: string
  }>
  return list
    .filter((e) => e.ev_unid)
    .map((e) => ({
      unid: String(e.ev_unid),
      feltCount: e.ev_nbtestimonies ?? 0,
      mag: typeof e.ev_mag_value === "number" ? e.ev_mag_value : null,
      region: String(e.ev_region ?? "Unknown"),
      eventTime: String(e.ev_event_time ?? ""),
    }))
}

/**
 * Run one felt detection pass: query the felt service, compare against the
 * persisted per-unid state, emit alerts for new felt events and climbed counts.
 * Returns the alerts that were (or would be) published.
 */
export async function runFeltSource(opts: {
  config?: Partial<FeltSourceConfig>
  ntfy: NtfyConfig
}): Promise<FeltSourceResult> {
  const cfg: FeltSourceConfig = { ...DEFAULT_FELT_SOURCE_CONFIG, ...opts.config }
  const result: FeltSourceResult = { ok: false, status: 200, seen: 0, newEvents: 0, jumps: 0, alerts: [], errors: [] }

  if (cfg.feltAlertAt <= 0 && cfg.feltJumpBy <= 0) {
    result.status = 200
    result.ok = true
    return result // both triggers disabled
  }

  const bbox = cfg.regions === "all" ? undefined : unionBbox(cfg.regions)

  let events: FeltEvent[]
  try {
    events = await queryFelt(bbox)
  } catch (err) {
    result.status = 502
    result.errors.push(`Felt query: ${err instanceof Error ? err.message : String(err)}`)
    return result
  }
  result.seen = events.length

  for (const e of events) {
    try {
      const prev = state.get(e.unid)
      const now = Date.now()

      // New event: first sighting above the alert threshold.
      if (!prev) {
        state.set(e.unid, { count: e.feltCount, lastAlertAt: 0 })
        // Startup flood guard: on the first pass we only record baseline state,
        // we do not alert on everything already in the felt catalog (a 6-day-old
        // quake that predates the service is not news). After warm-up, only
        // alert when the event time is recent.
        const fresh = isFresh(e.eventTime)
        if (warmedUp && fresh && e.feltCount >= cfg.feltAlertAt) {
          result.newEvents += 1
          result.alerts.push({ unid: e.unid, kind: "new", feltCount: e.feltCount, mag: e.mag, region: e.region, eventTime: e.eventTime })
        }
        continue
      }

      // Known event: only emit a jump when it actually climbed enough.
      const delta = e.feltCount - prev.count
      state.set(e.unid, { count: e.feltCount, lastAlertAt: prev.lastAlertAt })
      if (delta < cfg.feltJumpBy) continue

      // Respect cooldown for the same unid (creeping counts would otherwise spam).
      if (prev.lastAlertAt > 0 && now - prev.lastAlertAt < cfg.cooldownSec * 1000) continue
      state.set(e.unid, { count: e.feltCount, lastAlertAt: now })

      result.jumps += 1
      result.alerts.push({
        unid: e.unid,
        kind: "jump",
        feltCount: e.feltCount,
        prevCount: prev.count,
        mag: e.mag,
        region: e.region,
        eventTime: e.eventTime,
      })
    } catch (err) {
      result.errors.push(`${e.unid}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  warmedUp = true

  // Publish.
  for (const a of result.alerts) {
    try {
      if (!cfg.dryRun) {
        await publishNtfy(
          opts.ntfy,
          buildNtfyPayload({
            title: a.kind === "jump" ? `${a.region} — felt climbing` : `${a.region} — felt response`,
            message: feltMessage(a),
            tags: ["felt", a.kind === "jump" ? "upload" : "new"],
            priority: a.feltCount >= 50 ? 4 : 3,
            click: `https://www.seismicportal.eu/realtime.html#${a.unid}`,
          }),
        )
      }
    } catch (err) {
      result.errors.push(`${a.unid} publish: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.ok = result.errors.length === 0
  if (result.errors.length > 0) result.status = 502
  return result
}

function feltMessage(a: FeltAlert): string {
  const mag = a.mag != null ? `M${a.mag.toFixed(1)}` : "no magnitude"
  const when = fmtTime(a.eventTime)
  // Title carries the felt count + kind; the body fields must not repeat it.
  const titleFact = a.kind === "jump" ? `${a.region} — felt climbing` : `${a.region} — felt`
  const fields: MarkdownField[] = [
    { label: "Felt by", value: `${a.feltCount} people` },
    { label: "Magnitude", value: mag },
    { label: "Time", value: when },
  ]
  if (a.kind === "jump") fields.push({ label: "Climb", value: `${a.prevCount ?? "?"} → ${a.feltCount}` })
  fields.push({ label: "Event", value: a.unid })
  return markdownMessage(titleFact, fields)
}

/** EMSC times arrive like "2026-09-28T10:44:59.090 UTC"; that " UTC" suffix is
 * not valid ISO, so new Date() returns Invalid Date. Normalize to "Z" first. */
function isFresh(raw: string): boolean {
  const iso = (raw || "").trim().replace(/ UTC$/, "Z")
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return true // undated: err toward not dropping
  return Date.now() - d.getTime() < NEW_EVENT_AGE_HOURS * 3_600_000
}

function fmtTime(raw: string): string {
  if (!raw) return "unknown"
  const iso = raw.trim().replace(/ UTC$/, "Z")
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "unknown"
  return d.toLocaleString("en-US", { timeZone: "America/Santo_Domingo", dateStyle: "medium", timeStyle: "short" })
}
