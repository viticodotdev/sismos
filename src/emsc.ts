/**
 * EMSC realtime earthquake feed — FDSNWS REST client.
 *
 * The live page's websocket is push-only and replays nothing on reconnect, so
 * it can't be polled from a serverless/self-hosted poller. The SAME event
 * stream is served queryable by time window + bbox. format=geojson is NOT
 * accepted (400); use format=json.
 */

export interface EmscEvent {
  unid: string
  time: string // ISO 8601 UTC
  mag: number | null
  magtype: string | null
  flynn_region: string
  depth: number | null
  lat: number
  lon: number
  place?: string
  lastupdate?: string
}

export const EMSC_QUERY_URL = "https://www.seismicportal.eu/fdsnws/event/1/query"

export async function queryEmscEvents(opts: {
  starttime: string
  endtime?: string
  bbox?: { minlatitude: number; maxlatitude: number; minlongitude: number; maxlongitude: number }
  minmag?: number
  limit?: number
}): Promise<EmscEvent[]> {
  const params = new URLSearchParams({
    starttime: opts.starttime,
    format: "json",
    limit: String(opts.limit ?? 200),
  })
  if (opts.endtime) params.set("endtime", opts.endtime)
  if (opts.bbox) {
    params.set("minlatitude", String(opts.bbox.minlatitude))
    params.set("maxlatitude", String(opts.bbox.maxlatitude))
    params.set("minlongitude", String(opts.bbox.minlongitude))
    params.set("maxlongitude", String(opts.bbox.maxlongitude))
  }
  if (opts.minmag !== undefined) params.set("minmagnitude", String(opts.minmag))

  const res = await fetch(`${EMSC_QUERY_URL}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "dr-seismic-alerts/1.0 (ntfy alert bot)" },
    signal: AbortSignal.timeout(20_000),
  })
  // 204 = no events in the window — the normal quiet case, not an error.
  if (res.status === 204) return []
  if (!res.ok) throw new Error(`EMSC query failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`)

  const raw = await res.text()
  if (!raw.trim()) return []
  const body = JSON.parse(raw) as {
    type?: string
    features?: Array<{
      properties: Record<string, unknown>
      geometry?: { coordinates?: [number, number, number?] }
    }>
  }

  const features = body.features ?? []
  return features.map((f) => {
    const p = f.properties
    const [lon, lat, depth] = f.geometry?.coordinates ?? [0, 0, 0]
    const rawMag = p.magnitude ?? p.mag
    return {
      unid: String(p.unid ?? ""),
      time: String(p.time ?? ""),
      mag: typeof rawMag === "number" ? rawMag : null,
      magtype: p.magtype != null ? String(p.magtype) : null,
      flynn_region: String(p.flynn_region ?? p.place ?? ""),
      depth: typeof depth === "number" ? depth : null,
      lat,
      lon,
      place: p.place != null ? String(p.place) : undefined,
      lastupdate: p.lastupdate != null ? String(p.lastupdate) : undefined,
    }
  })
}