import { buildApp, runPollCycle } from "./app"
import { ntfyConfigFromEnv } from "./ntfy"
import { resolveRegions } from "./regions"
import { DEFAULT_UPDATE_ALERT_MAG_DELTA, createWsFeed } from "./ws-feed"

const port = Number(process.env.PORT ?? 3000)
// Local dev and self-host default to dry-run so a bare boot can never push to
// a real ntfy topic. Set DRY_RUN=0 to publish for real.
const dryRun = process.env.DRY_RUN !== "0"
const app = buildApp({ dryRun })
app.listen(port)
console.log(`dr-seismic-alerts listening on http://localhost:${port}`)

// Self-host mode: no external cron can reach a NetBird-internal service, so
// the container polls itself. Enabled with SELF_POLL=true (the Docker default);
// Vercel deployments leave it off and rely on the Managed Cron hitting /api/cron.
if (process.env.SELF_POLL === "true") {
  const intervalMin = Number(process.env.POLL_INTERVAL_MINUTES ?? 5)
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    console.error(`POLL_INTERVAL_MINUTES must be a positive number, got: ${process.env.POLL_INTERVAL_MINUTES}`)
    process.exit(1)
  }
  const tick = async () => {
    try {
      // Respect the same dry-run flag as the HTTP routes.
      const run = await runPollCycle({ dryRun })
      console.log(`[poll] ${run.status} fetched=${run.body.fetched} published=${run.body.published} failed=${run.body.failed} errors=${JSON.stringify(run.body.errors)}`)
    } catch (err) {
      console.error(`[poll] ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Poll once shortly after boot (don't wait a full interval), then every interval.
  setTimeout(tick, 3_000)
  setInterval(tick, intervalMin * 60_000)
  console.log(`self-poll every ${intervalMin} min (SELF_POLL=true)`)

  // Real-time websocket feed — the primary feed source; the REST poll above is
  // now a watchdog/backstop. Disable with WS_FEED=false.
  if (process.env.WS_FEED !== "false") {
    try {
      const regions = resolveRegions(process.env.REGIONS)
      const minMagnitude = Number(process.env.MIN_MAGNITUDE ?? 0)
      const updateAlertMagDelta = Number(process.env.UPDATE_ALERT_MAG_DELTA ?? DEFAULT_UPDATE_ALERT_MAG_DELTA)
      // Mirror runPollCycle: dry-run skips a real ntfy target (bare boots have
      // no NTFY_* env and must still come up).
      const ntfy = dryRun ? { baseUrl: "dryrun://", topic: "none", token: undefined } : ntfyConfigFromEnv(process.env)
      const feed = createWsFeed({
        regions,
        minMagnitude: Number.isFinite(minMagnitude) ? minMagnitude : 0,
        updateAlertMagDelta,
        ntfy,
        dryRun,
        onError: (err: unknown) => console.error(`[ws-feed] ${err instanceof Error ? err.message : String(err)}`),
      })
      feed.start()
      console.log(`ws-feed listening (regions=${process.env.REGIONS ?? "all"}, dryRun=${dryRun})`)
    } catch (err) {
      console.error(`[ws-feed] failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
