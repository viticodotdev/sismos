/**
 * The poll cycle: fetch EMSC over the window, keep events in the selected
 * regions, dedupe by unid, publish each new one to ntfy.
 *
 * The window covers exactly one poll interval (no overlap), so each event
 * appears in exactly one poll and no external store is needed for dedupe —
 * the in-memory set only guards a single poll that repeats (wide test windows).
 * A failed publish does NOT mark the event seen, so the next tick retries.
 */

import { queryEmscEvents, type EmscEvent } from "./emsc"
import type { DedupeStore } from "./dedupe"
import { buildNtfyPayload, publishNtfy, type NtfyConfig } from "./ntfy"
import { eventMatchesRegion, resolveRegions, unionBbox, type RegionDef } from "./regions"

export interface PollConfig {
  windowMinutes: number
  minMagnitude: number
  regions: RegionDef[] | "all"
  dryRun: boolean
}

export const DEFAULT_POLL_CONFIG: PollConfig = {
  windowMinutes: 5,
  minMagnitude: 0,
  regions: "all",
  dryRun: false,
}

export interface PollResult {
  fetched: number
  regionEvents: number
  newEvents: number
  published: number
  failed: number
  errors: string[]
  events: Array<EmscEvent & { published: boolean; regions: string[] }>
}

function toIso(offsetMinutes: number): string {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString()
}

function eventTitle(e: EmscEvent): string {
  const mag = e.mag != null ? `M${e.mag.toFixed(1)}` : "No mag"
  return `${mag} — ${e.flynn_region}`
}

function eventMessage(e: EmscEvent, regionLabels: string[]): string {
  const depth = e.depth != null ? `${e.depth.toFixed(1)} km deep` : "depth unknown"
  const when = new Date(e.time).toLocaleString("en-US", {
    timeZone: "America/Santo_Domingo",
    dateStyle: "medium",
    timeStyle: "short",
  })
  const where = regionLabels.length > 0 ? `Matches: ${regionLabels.join(", ")}` : "No region match (blanket mode)"
  return [
    `Time: ${when} (Santo Domingo)`,
    `Depth: ${depth}`,
    `Location: ${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}`,
    where,
    `Event: ${e.unid}`,
  ].join("\n")
}

export async function pollAndAlert(opts: {
  poll?: Partial<PollConfig>
  dedupe: DedupeStore
  ntfy: NtfyConfig
}): Promise<PollResult> {
  const poll: PollConfig = { ...DEFAULT_POLL_CONFIG, ...opts.poll }
  const result: PollResult = { fetched: 0, regionEvents: 0, newEvents: 0, published: 0, failed: 0, errors: [], events: [] }

  const starttime = toIso(poll.windowMinutes)

  let events: EmscEvent[]
  try {
    // Blanket mode queries the whole world; otherwise union the regions' bboxes.
    const bbox = poll.regions === "all" ? undefined : unionBbox(poll.regions)
    events = await queryEmscEvents({ starttime, bbox, minmag: poll.minMagnitude })
    result.fetched = events.length
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`EMSC fetch: ${msg}`)
    return result
  }

  // An event can match several regions — alert once, list them all.
  const selected: Array<EmscEvent & { regions: string[] }> = []
  for (const e of events) {
    if (poll.regions === "all") {
      selected.push({ ...e, regions: [] })
      continue
    }
    const matched = poll.regions.filter((r) => eventMatchesRegion(r, e.flynn_region, e.lat, e.lon))
    if (matched.length > 0) selected.push({ ...e, regions: matched.map((r) => r.label) })
  }
  result.regionEvents = selected.length

  for (const e of selected) {
    try {
      if (await opts.dedupe.seen(e.unid)) continue
      result.newEvents += 1
      if (!poll.dryRun) {
        await publishNtfy(
          opts.ntfy,
          buildNtfyPayload({
            title: eventTitle(e),
            message: eventMessage(e, e.regions),
            tags: ["earthquake"],
            priority: e.mag != null && e.mag >= 5 ? 4 : 3,
            click: `https://www.seismicportal.eu/realtime.html#${e.unid}`,
          }),
        )
      }
      await opts.dedupe.markSeen(e.unid)
      result.published += 1
      result.events.push({ ...e, published: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.failed += 1
      result.errors.push(`${e.unid}: ${msg}`)
      result.events.push({ ...e, published: false })
    }
  }

  return result
}

export { resolveRegions }