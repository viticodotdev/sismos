import { Elysia, t } from "elysia"
import { pollAndAlert, resolveRegions, type PollConfig } from "../src/poller"
import { dedupeInMemory } from "../src/dedupe"
import { ntfyConfigFromEnv } from "../src/ntfy"

export interface PollRun {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

/**
 * One poll cycle: resolve config (query overrides > env > defaults), fetch
 * EMSC, filter, dedupe, publish. Shared by the HTTP route and the self-host
 * scheduler so both behave identically. In dry-run the ntfy target is stubbed
 * and nothing is published.
 */
export async function runPollCycle(opts?: {
  region?: string
  minmag?: number
  window?: number
  felt?: number
  dryRun?: boolean
}): Promise<PollRun> {
  const dryRun = opts?.dryRun ?? false
  const pollConfig: Partial<PollConfig> = { dryRun }

  // Felt-response escalation threshold (0 = disabled). URL ?felt= overrides env.
  const feltRaw = opts?.felt ?? process.env.FELT_ESCALATE_AT
  const feltEscalateAt = Number(feltRaw ?? 20)
  if (!Number.isFinite(feltEscalateAt) || feltEscalateAt < 0) {
    return { ok: false, status: 400, body: { error: `FELT_ESCALATE_AT must be a non-negative number, got: ${feltRaw}` } }
  }
  pollConfig.feltEscalateAt = feltEscalateAt

  if (opts?.window !== undefined) {
    if (!Number.isFinite(opts.window) || opts.window <= 0) {
      return { ok: false, status: 400, body: { error: `window must be a positive number of minutes, got: ${opts.window}` } }
    }
    pollConfig.windowMinutes = opts.window
  }

  const regionSel = opts?.region ?? process.env.REGIONS
  try {
    pollConfig.regions = resolveRegions(regionSel)
  } catch (err) {
    return { ok: false, status: 400, body: { error: err instanceof Error ? err.message : String(err) } }
  }

  const rawMinMag = opts?.minmag ?? process.env.MIN_MAGNITUDE
  const minMag = Number(rawMinMag ?? 0)
  if (!Number.isFinite(minMag)) {
    return { ok: false, status: 400, body: { error: `minmag must be a number, got: ${rawMinMag}` } }
  }
  pollConfig.minMagnitude = minMag

  const ntfy = dryRun ? { baseUrl: "dryrun://", topic: "none", token: undefined } : ntfyConfigFromEnv(process.env)
  const result = await pollAndAlert({ poll: pollConfig, dedupe: dedupeInMemory(), ntfy })

  return {
    ok: result.errors.length === 0,
    status: result.errors.length > 0 ? 502 : 200,
    body: {
      ok: result.errors.length === 0,
      mode: pollConfig.regions === "all" ? "blanket" : "regions",
      regions: pollConfig.regions === "all" ? ["all"] : pollConfig.regions.map((r) => r.id),
      minMagnitude: pollConfig.minMagnitude,
      feltEscalateAt: pollConfig.feltEscalateAt ?? 0,
      fetched: result.fetched,
      regionEvents: result.regionEvents,
      newEvents: result.newEvents,
      published: result.published,
      failed: result.failed,
      errors: result.errors,
      events: result.events.map((e) => ({ unid: e.unid, mag: e.mag, region: e.flynn_region, published: e.published, feltCount: e.feltCount })),
    },
  }
}

export function buildApp(opts?: { dryRun?: boolean }) {
  const dryRun = opts?.dryRun ?? false

  return new Elysia()
    .get("/health", () => ({ ok: true, service: "dr-seismic-alerts", ts: new Date().toISOString() }))
    .get(
      "/api/cron",
      async ({ set, query }) => {
        const run = await runPollCycle({
          region: query.region,
          minmag: query.minmag !== undefined ? Number(query.minmag) : undefined,
          window: query.window !== undefined ? Number(query.window) : undefined,
          felt: query.felt !== undefined ? Number(query.felt) : undefined,
          dryRun,
        })
        set.status = run.status
        set.headers = { "Content-Type": "application/json" }
        return run.body
      },
      {
        query: t.Object({
          region: t.Optional(t.String()),
          minmag: t.Optional(t.String()),
          window: t.Optional(t.String()),
          felt: t.Optional(t.String()),
        }),
      },
    )
}

export const app = buildApp()
