import { describe, expect, test } from "bun:test"
import { WsFeed, type WsMessage } from "../src/ws-feed"
import { resolveRegions } from "../src/regions"
import { WS_CREATE, WS_DELETE, WS_UPDATE } from "./fixtures/ws-messages"

function makeFetchMock() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init as RequestInit })
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = orig
    },
  }
}

function feed(opts: { minMagnitude?: number; regions?: ReturnType<typeof resolveRegions> } = {}) {
  return new WsFeed({
    regions: opts.regions ?? resolveRegions("dr"),
    minMagnitude: opts.minMagnitude ?? 0,
    updateAlertMagDelta: 0.3,
    ntfy: { baseUrl: "https://ntfy.test", topic: "earthquakes-dr" },
    dryRun: false,
  })
}

/** Clone a fixture and override its action / properties. */
function build(fixture: WsMessage, opts: { action?: string; props?: Record<string, unknown> } = {}): WsMessage {
  const data = fixture.data ?? { properties: {} }
  return {
    action: opts.action ?? fixture.action,
    data: { ...data, properties: { ...(data.properties ?? {}), ...(opts.props ?? {}) } },
  }
}

const UNID = String(WS_CREATE.data?.properties?.unid)

describe("ws-feed create filtering", () => {
  test("create in region publishes", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      const res = await f.handleMessage(build(WS_CREATE, { props: { flynn_region: "DOMINICAN REPUBLIC REGION" } }))
      expect(res.published).toBe(true)
      expect(mock.calls).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })

  test("create out of region does not publish", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      const res = await f.handleMessage(
        build(WS_CREATE, { props: { flynn_region: "CASPIAN SEA", lat: 40.0, lon: 50.0 } }),
      )
      expect(res.published).toBe(false)
      expect(res.skipped).toBe("region")
      expect(mock.calls).toHaveLength(0)
    } finally {
      mock.restore()
    }
  })

  test("replayed create is deduped", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      const inRegion = { flynn_region: "DOMINICAN REPUBLIC REGION" }
      await f.handleMessage(build(WS_CREATE, { props: inRegion }))
      const again = await f.handleMessage(build(WS_CREATE, { props: inRegion }))
      expect(again.published).toBe(false)
      expect(again.skipped).toBe("dedupe")
      expect(mock.calls).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })

  test("delete is ignored (log only)", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      const res = await f.handleMessage(WS_DELETE)
      expect(res.published).toBe(false)
      expect(res.skipped).toBe("ignored")
      expect(mock.calls).toHaveLength(0)
    } finally {
      mock.restore()
    }
  })
})

describe("ws-feed update revisions", () => {
  test("update with small mag change does not re-alert", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      await f.handleMessage(build(WS_CREATE, { props: { flynn_region: "DOMINICAN REPUBLIC REGION" } })) // mag 2.0
      const res = await f.handleMessage(build(WS_UPDATE, { props: { unid: UNID, mag: 2.1 } }))
      expect(res.published).toBe(false)
      expect(res.skipped).toBe("no-change")
      expect(mock.calls).toHaveLength(1) // only the original create
    } finally {
      mock.restore()
    }
  })

  test("update crossing the delta publishes", async () => {
    const mock = makeFetchMock()
    try {
      const f = feed()
      await f.handleMessage(build(WS_CREATE, { props: { flynn_region: "DOMINICAN REPUBLIC REGION" } })) // mag 2.0
      const res = await f.handleMessage(build(WS_UPDATE, { props: { unid: UNID, mag: 2.4 } })) // delta 0.4
      expect(res.published).toBe(true)
      expect(mock.calls).toHaveLength(2)
    } finally {
      mock.restore()
    }
  })

  test("update crossing the MIN_MAGNITUDE floor publishes", async () => {
    const mock = makeFetchMock()
    try {
      // floor 3.0: create at 2.0 is below floor, so only a later crossing alerts.
      const f = feed({ minMagnitude: 3.0 })
      const created = await f.handleMessage(build(WS_CREATE, { props: { flynn_region: "DOMINICAN REPUBLIC REGION" } })) // mag 2.0
      expect(created.published).toBe(false)
      expect(created.skipped).toBe("minmag")
      const res = await f.handleMessage(build(WS_UPDATE, { props: { unid: UNID, mag: 3.0 } })) // crossed floor
      expect(res.published).toBe(true)
      expect(mock.calls).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })
})