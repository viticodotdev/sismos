import { describe, expect, test } from "bun:test"
import {
  eventMatchesRegion,
  REGION_CATALOG,
  resolveRegions,
  unionBbox,
} from "../src/regions"
import { dedupeInMemory } from "../src/dedupe"

describe("resolveRegions", () => {
  test("'all' and empty resolve to blanket", () => {
    expect(resolveRegions("all")).toBe("all")
    expect(resolveRegions("")).toBe("all")
    expect(resolveRegions(undefined)).toBe("all")
  })

  test("comma-separated ids resolve to defs", () => {
    const r = resolveRegions("dr,pr")
    expect(r).not.toBe("all")
    expect((r as unknown[]).map((x) => (x as { id: string }).id)).toEqual(["dr", "pr"])
  })

  test("unknown id throws loudly", () => {
    expect(() => resolveRegions("mars")).toThrow(/Unknown region id: mars/)
  })
})

describe("eventMatchesRegion", () => {
  test("dr matches by keyword and bbox", () => {
    const dr = REGION_CATALOG.dr
    expect(eventMatchesRegion(dr, "DOMINICAN REPUBLIC REGION", 18.5, -70.5)).toBe(true)
    expect(eventMatchesRegion(dr, "MONA PASSAGE, DOMINICAN REPUBLIC", 18.9, -68.5)).toBe(true)
    // in bbox but wrong region name (bbox is a secondary net)
    expect(eventMatchesRegion(dr, "HAITI REGION", 18.7, -71.9)).toBe(true)
    // outside bbox + wrong name
    expect(eventMatchesRegion(dr, "PUERTO RICO REGION", 18.3, -66.0)).toBe(false)
  })

  test("caribbean matches by bbox only (no keywords)", () => {
    const carib = REGION_CATALOG.caribbean
    expect(eventMatchesRegion(carib, "ANY REGION NAME", 15.0, -70.0)).toBe(true)
    expect(eventMatchesRegion(carib, "ANY REGION NAME", 30.0, -70.0)).toBe(false) // too far north
  })

  test("case-insensitive keyword", () => {
    const dr = REGION_CATALOG.dr
    expect(eventMatchesRegion(dr, "dominican republic region", 18.5, -70.5)).toBe(true)
  })
})

describe("unionBbox", () => {
  test("joins multiple region boxes", () => {
    const box = unionBbox([REGION_CATALOG.dr, REGION_CATALOG.pr])
    expect(box.minlatitude).toBe(17.0) // dr's min
    expect(box.maxlatitude).toBe(20.5) // dr's max
    expect(box.minlongitude).toBe(-72.5) // dr's min
    expect(box.maxlongitude).toBe(-65.0) // pr's max
  })
})

describe("dedupeInMemory", () => {
  test("seen only after markSeen", async () => {
    const store = dedupeInMemory()
    expect(await store.seen("20260928_0000106")).toBe(false)
    await store.markSeen("20260928_0000106")
    expect(await store.seen("20260928_0000106")).toBe(true)
    expect(await store.seen("20260928_0000107")).toBe(false)
  })
})


describe("feltCountForEvent", () => {
  test("parses the felt count from a matching event", async () => {
    const { feltCountForEvent } = await import("../src/felt")
    // stub the global fetch to return the real API shape we validated live
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ ev_unid: "20260927_0000285", ev_nbtestimonies: 464 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const n = await feltCountForEvent("20260927_0000285")
      expect(n).toBe(464)
    } finally {
      globalThis.fetch = orig
    }
  })

  test("returns 0 for an event with no felt reports (204)", async () => {
    const { feltCountForEvent } = await import("../src/felt")
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    try {
      const n = await feltCountForEvent("20260928_0000106")
      expect(n).toBe(0)
    } finally {
      globalThis.fetch = orig
    }
  })
})
