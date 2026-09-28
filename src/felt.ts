/**
 * EMSC felt reports (Testimonies) — client.
 *
 * Two endpoints, both live-verified against real DR data:
 *
 * 1. Felt summary: /api/search?format=json&limit=N&minlatitude=..&maxlatitude=..
 *    Returns events with `ev_nbtestimonies` (count of people who felt it) and
 *    the event params. Used to escalate an alert based on felt response — a
 *    M4.8 with 464 reports is a different alert than one nobody noticed.
 *
 * 2. Full testimonies: /api/search?unids=[UNID]&includeTestimonies=true
 *    Returns a ZIP with <unid>.csv (per-testimony: lon,lat,time,source,
 *    intensity,durationfactor) + events.csv (aggregate). Only worth fetching
 *    when you want geographic detail (e.g. "N reports near Santo Domingo");
 *    the summary count alone needs just the first endpoint.
 */

export interface FeltSummary {
  unid: string
  feltCount: number
}

const TESTIMONIES_URL = "https://www.seismicportal.eu/testimonies-ws/api/search"

/**
 * Fetch the felt count for a single event by its unid. Returns 0 when the
 * event is absent from the felt service or has no reports (the common case
 * for small quakes). Param matching mirrors the FDSN naming we already use.
 */
export async function feltCountForEvent(
  unid: string,
  bbox?: { minlatitude: number; maxlatitude: number; minlongitude: number; maxlongitude: number },
): Promise<number> {
  const params = new URLSearchParams({ format: "json", limit: "50", unids: `[${unid}]` })
  if (bbox) {
    params.set("minlatitude", String(bbox.minlatitude))
    params.set("maxlatitude", String(bbox.maxlatitude))
    params.set("minlongitude", String(bbox.minlongitude))
    params.set("maxlongitude", String(bbox.maxlongitude))
  }
  const res = await fetch(`${TESTIMONIES_URL}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "dr-seismic-alerts/1.0 (ntfy alert bot)" },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 204) return 0
  if (!res.ok) throw new Error(`Felt summary failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`)
  const raw = await res.text()
  if (!raw.trim()) return 0
  const list = JSON.parse(raw) as Array<{ ev_unid?: string; ev_nbtestimonies?: number }>
  const hit = list.find((e) => e.ev_unid === unid)
  return hit?.ev_nbtestimonies ?? 0
}