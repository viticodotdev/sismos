/**
 * EMSC standing_order websocket — persistent push listener that replaces the
 * REST poll as the realtime feed source.
 *
 * The live websocket pushes create/update/delete frames for every event as it
 * is indexed, seconds-to-minutes ahead of the FDSNWS REST catalog. We filter on
 * arrival (region + magnitude floor) and publish occurrence/revision alerts to
 * ntfy. There is deliberately NO origin-time window here — each frame is judged
 * the instant it arrives, so a late-indexed event can never slide past a poll
 * window again.
 *
 * State is in-memory (an alerted-unid Set and a last-magnitude Map), so it
 * survives reconnects within one long-lived process. The self-host container is
 * the only place a persistent connection can live — do not run this on a
 * stateless deployment.
 */

import { eventUrl, markdownMessage, publishNtfy, type NtfyConfig } from "./ntfy"
import { eventMatchesRegion, type RegionDef } from "./regions"

/** Build a ws-feed handle ({ start(), stop() }) backed by an in-memory WsFeed. */
export function createWsFeed(config: WsFeedConfig): WsFeedHandle & { handleMessage(msg: WsMessage): Promise<WsResult> } {
  return new WsFeed(config)
}

export const WS_URL = "wss://www.seismicportal.eu/standing_order/websocket"

/** Magnitude shift (since last seen) that triggers a revision alert on 'update'. */
export const DEFAULT_UPDATE_ALERT_MAG_DELTA = 0.3

export interface WsFeedConfig {
  regions: RegionDef[] | "all"
  minMagnitude: number
  updateAlertMagDelta: number
  ntfy: NtfyConfig
  dryRun: boolean
  onError?: (err: unknown) => void
}

export interface WsEvent {
  unid: string
  time: string | null
  mag: number | null
  magtype: string | null
  flynn_region: string
  lat: number
  lon: number
  depth: number | null
}

export interface WsMessage {
  action: string
  data?: { properties?: Record<string, unknown> }
}

export interface WsResult {
  action: string
  unid: string
  published: boolean
  skipped?: string
}

export interface WsFeedHandle {
  start(): void
  stop(): void
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseWsMessage(raw: string): WsMessage | null {
  try {
    return JSON.parse(raw) as WsMessage
  } catch {
    return null
  }
}

function eventFromMessage(msg: WsMessage): WsEvent | null {
  const p = msg.data?.properties
  if (!p) return null
  const unid = p.unid != null ? String(p.unid) : ""
  const lat = toNum(p.lat)
  const lon = toNum(p.lon)
  if (!unid || lat === null || lon === null) return null
  return {
    unid,
    time: p.time != null ? String(p.time) : null,
    mag: toNum(p.mag),
    magtype: p.magtype != null ? String(p.magtype) : null,
    flynn_region: p.flynn_region != null ? String(p.flynn_region) : "",
    lat,
    lon,
    depth: toNum(p.depth),
  }
}

function magLabel(m: number | null): string {
  return m === null ? "No mag" : `M${m.toFixed(1)}`
}

function fmtTime(iso: string | null): string {
  if (!iso) return "unknown"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "unknown"
  return d.toLocaleString("en-US", {
    timeZone: "America/Santo_Domingo",
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function fmtLocation(e: WsEvent): string {
  return `${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}`
}

function fmtDepth(e: WsEvent): string {
  return e.depth === null ? "depth unknown" : `${e.depth.toFixed(1)} km deep`
}

export class WsFeed implements WsFeedHandle {
  /** unids already alerted on 'create' — reconnect-replay guard. */
  private alerted = new Set<string>()
  /** last magnitude seen per unid, for revision delta / floor-crossing. */
  private lastMag = new Map<string, number>()

  private ws: WebSocket | null = null
  private stopped = false
  private backoffMs = 1_000
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly cfg: WsFeedConfig) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(WS_URL)
    } catch (err) {
      this.onError(err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.backoffMs = 1_000 // reset backoff on a healthy connection
    }
    ws.onmessage = (ev) => {
      const msg = parseWsMessage(String(ev.data))
      if (msg) void this.handleMessage(msg)
    }
    ws.onerror = (ev) => {
      this.onError(ev)
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.stopped) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private onError(err: unknown): void {
    if (this.cfg.onError) this.cfg.onError(err)
    else console.error(`[ws-feed] ${err instanceof Error ? err.message : String(err)}`)
  }

  private inRegions(e: WsEvent): boolean {
    if (this.cfg.regions === "all") return true
    return this.cfg.regions.some((r) => eventMatchesRegion(r, e.flynn_region, e.lat, e.lon))
  }

  async handleMessage(msg: WsMessage): Promise<WsResult> {
    if (msg.action === "delete") {
      const unid = msg.data?.properties?.unid != null ? String(msg.data.properties.unid) : ""
      console.log(`[ws-feed] delete ignored: ${unid || "unknown"}`)
      return { action: "delete", unid, published: false, skipped: "ignored" }
    }

    const e = eventFromMessage(msg)
    if (!e) return { action: msg.action, unid: "", published: false, skipped: "unparsable" }

    if (msg.action === "create") return await this.handleCreate(e)
    if (msg.action === "update") return await this.handleUpdate(e)
    return { action: msg.action, unid: e.unid, published: false, skipped: "unknown-action" }
  }

  private async handleCreate(e: WsEvent): Promise<WsResult> {
    if (!this.inRegions(e)) return { action: "create", unid: e.unid, published: false, skipped: "region" }
    // Track magnitude for in-region events even below the floor, so a later
    // 'update' that crosses the floor can still fire a revision.
    if (e.mag !== null) this.lastMag.set(e.unid, e.mag)
    if (e.mag === null || e.mag < this.cfg.minMagnitude) {
      return { action: "create", unid: e.unid, published: false, skipped: "minmag" }
    }
    if (this.alerted.has(e.unid)) return { action: "create", unid: e.unid, published: false, skipped: "dedupe" }

    if (!this.cfg.dryRun) {
      try {
const occ = this.occurrencePayload(e)
        await publishNtfy(this.cfg.ntfy, occ.message, occ.opts)
      } catch (err) {
        this.onError(err)
        return { action: "create", unid: e.unid, published: false, skipped: "publish-error" }
      }
    }
    this.alerted.add(e.unid)
    return { action: "create", unid: e.unid, published: true }
  }

  private async handleUpdate(e: WsEvent): Promise<WsResult> {
    const prev = this.lastMag.get(e.unid)
    if (e.mag !== null) this.lastMag.set(e.unid, e.mag)
    if (prev === undefined || e.mag === null) {
      return { action: "update", unid: e.unid, published: false, skipped: "no-baseline" }
    }

    const delta = Math.abs(e.mag - prev)
    const crossedFloor = prev < this.cfg.minMagnitude && e.mag >= this.cfg.minMagnitude
    if (delta < this.cfg.updateAlertMagDelta && !crossedFloor) {
      return { action: "update", unid: e.unid, published: false, skipped: "no-change" }
    }

    if (!this.cfg.dryRun) {
      try {
        const rev = this.revisionPayload(e, prev, crossedFloor)
      await publishNtfy(this.cfg.ntfy, rev.message, rev.opts)
      } catch (err) {
        this.onError(err)
        return { action: "update", unid: e.unid, published: false, skipped: "publish-error" }
      }
    }
    this.alerted.add(e.unid)
    return { action: "update", unid: e.unid, published: true }
  }

  private occurrencePayload(e: WsEvent) {
    const region = e.flynn_region || "Unknown region"
    const title = `${magLabel(e.mag)} — ${region}`
    return {
      message: markdownMessage(title, [
        { label: "Magnitude", value: e.mag === null ? "no magnitude" : `${e.mag.toFixed(1)}${e.magtype ? ` (${e.magtype})` : ""}` },
        { label: "Region", value: region },
        { label: "Time", value: fmtTime(e.time) },
        { label: "Depth", value: fmtDepth(e) },
        { label: "Location", value: fmtLocation(e) },
        { label: "Event", value: e.unid },
      ]),
      opts: {
        title,
        tags: ["earthquake"],
        priority: e.mag !== null && e.mag >= 5 ? 4 : 3,
        click: eventUrl(e.unid),
      },
    }
  }

  private revisionPayload(e: WsEvent, prevMag: number, crossedFloor: boolean) {
    const region = e.flynn_region || "Unknown region"
    const title = `${magLabel(e.mag)} revision — ${region}`
    return {
      message: markdownMessage(title, [
        { label: "Magnitude", value: `${magLabel(prevMag)} → ${magLabel(e.mag)}${e.magtype ? ` (${e.magtype})` : ""}` },
        { label: "Region", value: region },
        { label: "Time", value: fmtTime(e.time) },
        { label: "Event", value: e.unid },
      ]),
      opts: {
        title,
        tags: ["earthquake", crossedFloor ? "warning" : "revision"],
        priority: e.mag !== null && e.mag >= 5 ? 4 : 3,
        click: eventUrl(e.unid),
      },
    }
  }
}
