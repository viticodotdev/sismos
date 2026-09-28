import { Elysia, t } from "elysia"
import { pollAndAlert, resolveRegions, type PollConfig } from "../src/poller"
import { runFeltSource, type FeltSourceConfig } from "../src/felt-source"
import { dedupeInMemory } from "../src/dedupe"
import { ntfyConfigFromEnv } from "../src/ntfy"

export interface PollRun {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

export interface RunOpts {
  region?: string
  minmag?: number
  window?: number
  /** felt-source: min felt count for a new felt event. URL ?felt-alert-at=. */
  feltAlertAt?: number
  /** felt-source: min felt-count climb to fire a jump alert. URL ?felt-jump-by=. */
  feltJumpBy?: number
  dryRun?: boolean
}

function err(status: number, error: string): PollRun {
  return { ok: false, status, body: { error } }
}

/**
 * One poll cycle runs BOTH independent sources:
 *  - feed: a new quake happened (occurrence)
 *  - felt: people are feeling something (new felt event or a climbed count)
 * Config: query overrides > env > defaults. In dry-run the ntfy target is
 * stubbed and nothing is published. Shared by the HTTP route and the self-host
 * scheduler so both behave identically.
 */
export async function runPollCycle(opts?: RunOpts): Promise<PollRun> {
  const dryRun = opts?.dryRun ?? false

  // --- feed source config ---
  const pollConfig: Partial<PollConfig> = { dryRun }
  if (opts?.window !== undefined) {
    if (!Number.isFinite(opts.window) || opts.window <= 0) return err(400, `window must be a positive number of minutes, got: ${opts.window}`)
    pollConfig.windowMinutes = opts.window
  }
  const regionSel = opts?.region ?? process.env.REGIONS
  let regions: PollConfig["regions"]
  try {
    regions = resolveRegions(regionSel)
    pollConfig.regions = regions
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e))
  }
  const rawMinMag = opts?.minmag ?? process.env.MIN_MAGNITUDE
  const minMag = Number(rawMinMag ?? 0)
  if (!Number.isFinite(minMag)) return err(400, `minmag must be a number, got: ${rawMinMag}`)
  pollConfig.minMagnitude = minMag

  // --- felt source config (separate) ---
  const feltConfig: Partial<FeltSourceConfig> = { dryRun, regions }
  const rawAlertAt = opts?.feltAlertAt ?? process.env.FELT_ALERT_AT
  const feltAlertAt = Number(rawAlertAt ?? 5)
  if (!Number.isFinite(feltAlertAt) || feltAlertAt < 0) return err(400, `FELT_ALERT_AT must be a non-negative number, got: ${rawAlertAt}`)
  feltConfig.feltAlertAt = feltAlertAt
  const rawJumpBy = opts?.feltJumpBy ?? process.env.FELT_JUMP_BY
  const feltJumpBy = Number(rawJumpBy ?? 15)
  if (!Number.isFinite(feltJumpBy) || feltJumpBy < 0) return err(400, `FELT_JUMP_BY must be a non-negative number, got: ${rawJumpBy}`)
  feltConfig.feltJumpBy = feltJumpBy
  const rawCooldown = process.env.FELT_COOLDOWN_MIN
  if (rawCooldown) {
    const cd = Number(rawCooldown)
    if (!Number.isFinite(cd) || cd < 0) return err(400, `FELT_COOLDOWN_MIN must be a non-negative number, got: ${rawCooldown}`)
    feltConfig.cooldownSec = cd * 60
  }

  const ntfy = dryRun ? { baseUrl: "dryrun://", topic: "none", token: undefined } : ntfyConfigFromEnv(process.env)

  const feed = await pollAndAlert({ poll: pollConfig, dedupe: dedupeInMemory(), ntfy })
  const felt = await runFeltSource({ config: feltConfig, ntfy })

  const errors = [...feed.errors, ...felt.errors]
  const status = errors.length > 0 ? 502 : 200

  return {
    ok: errors.length === 0,
    status,
    body: {
      ok: errors.length === 0,
      sources: {
        feed: {
          mode: regions === "all" ? "blanket" : "regions",
          regions: regions === "all" ? ["all"] : regions.map((r) => r.id),
          minMagnitude: pollConfig.minMagnitude,
          fetched: feed.fetched,
          regionEvents: feed.regionEvents,
          newEvents: feed.newEvents,
          published: feed.published,
          events: feed.events.map((e) => ({ unid: e.unid, mag: e.mag, region: e.flynn_region, published: e.published })),
        },
        felt: {
          feltAlertAt: feltConfig.feltAlertAt,
          feltJumpBy: feltConfig.feltJumpBy,
          seen: felt.seen,
          newEvents: felt.newEvents,
          jumps: felt.jumps,
          alerts: felt.alerts,
        },
      },
      published: feed.published + felt.alerts.filter((a) => !feltConfig.dryRun).length,
      failed: feed.failed,
      errors,
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
          feltAlertAt: query.feltAlertAt !== undefined ? Number(query.feltAlertAt) : undefined,
          feltJumpBy: query.feltJumpBy !== undefined ? Number(query.feltJumpBy) : undefined,
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
          feltAlertAt: t.Optional(t.String()),
          feltJumpBy: t.Optional(t.String()),
        }),
      },
    )
}

export const app = buildApp()