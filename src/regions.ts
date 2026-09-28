/**
 * Region catalog — named, selectable monitoring regions. Extend by adding an
 * entry; nothing else changes. Each region is a bbox and/or name-keyword
 * filter. REGIONS env picks which fire ("all" = blanket global pass).
 */

export interface RegionDef {
  id: string
  label: string
  bbox?: { minlatitude: number; maxlatitude: number; minlongitude: number; maxlongitude: number }
  keywords?: string[]
}

export const REGION_CATALOG: Record<string, RegionDef> = {
  dr: {
    id: "dr",
    label: "Dominican Republic",
    bbox: { minlatitude: 17.0, maxlatitude: 20.5, minlongitude: -72.5, maxlongitude: -68.0 },
    keywords: ["DOMINICAN REPUBLIC"],
  },
  pr: {
    id: "pr",
    label: "Puerto Rico",
    bbox: { minlatitude: 17.2, maxlatitude: 19.0, minlongitude: -67.5, maxlongitude: -65.0 },
    keywords: ["PUERTO RICO"],
  },
  haiti: {
    id: "haiti",
    label: "Haiti",
    bbox: { minlatitude: 17.5, maxlatitude: 20.5, minlongitude: -75.0, maxlongitude: -71.5 },
    keywords: ["HAITI"],
  },
  caribbean: {
    id: "caribbean",
    label: "Caribbean",
    // Greater + Lesser Antilles arc and surrounding plate boundary.
    bbox: { minlatitude: 8.0, maxlatitude: 28.0, minlongitude: -90.0, maxlongitude: -58.0 },
  },
}

export const REGION_IDS: string[] = Object.keys(REGION_CATALOG)

/** Resolve a region selection; unknown ids throw so a typo fails loudly. */
export function resolveRegions(selection: string | undefined): RegionDef[] | "all" {
  const raw = (selection ?? "").trim()
  if (!raw || raw === "all") return "all"
  const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  const out: RegionDef[] = []
  for (const id of ids) {
    const def = REGION_CATALOG[id]
    if (!def) throw new Error(`Unknown region id: ${id} (known: ${REGION_IDS.join(", ")}, all)`)
    out.push(def)
  }
  return out
}

/** The narrowest bbox across a set of regions (one EMSC query covers all). */
export function unionBbox(regions: RegionDef[]): { minlatitude: number; maxlatitude: number; minlongitude: number; maxlongitude: number } {
  const boxes = regions.map((r) => r.bbox).filter((b): b is NonNullable<typeof b> => !!b)
  if (boxes.length === 0) return { minlatitude: -90, maxlatitude: 90, minlongitude: -180, maxlongitude: 180 }
  return {
    minlatitude: Math.min(...boxes.map((b) => b.minlatitude)),
    maxlatitude: Math.max(...boxes.map((b) => b.maxlatitude)),
    minlongitude: Math.min(...boxes.map((b) => b.minlongitude)),
    maxlongitude: Math.max(...boxes.map((b) => b.maxlongitude)),
  }
}

export function eventMatchesRegion(region: RegionDef, flynnRegion: string, lat: number, lon: number): boolean {
  const r = flynnRegion.toUpperCase()
  if (region.keywords && region.keywords.some((k) => r.includes(k))) return true
  if (region.bbox) {
    return (
      lat >= region.bbox.minlatitude &&
      lat <= region.bbox.maxlatitude &&
      lon >= region.bbox.minlongitude &&
      lon <= region.bbox.maxlongitude
    )
  }
  return false
}