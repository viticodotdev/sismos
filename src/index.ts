import { buildApp, runPollCycle } from "./app"

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
}
