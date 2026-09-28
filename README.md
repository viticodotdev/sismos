# DR Seismic Alerts

Polls the EMSC realtime earthquake feed and pushes alerts to a self-hosted ntfy
server for the regions you pick. Runs on Vercel (cron → serverless function →
ntfy) with **no external state**: no Redis, no database, just env vars.

## Why REST, not the websocket

The EMSC live page is a **push-only websocket** (`wss://www.seismicportal.eu/standing_order/websocket`)
that replays nothing on reconnect. You cannot "poll" it reliably from a
serverless function — reconnecting misses events that fired while you were
disconnected, and a serverless instance cannot hold a connection open. The
**same event stream** is served by the FDSNWS REST API
(`/fdsnws/event/1/query?format=json`), queryable by time window + bbox, with the
same stable `unid` ids. So the poller queries REST over exactly one poll
interval per tick (no overlap) and publishes each event once. No persistent
connection, no missed-event replay problem.

## Regions

Selectable, defined in `src/regions.ts` (extend the catalog there):

| id | label | bbox | name keywords |
|---|---|---|---|
| `dr` | Dominican Republic | 17.0–20.5, -72.5…-68.0 | DOMINICAN REPUBLIC |
| `pr` | Puerto Rico | 17.2–19.0, -67.5…-65.0 | PUERTO RICO |
| `haiti` | Haiti | 17.5–20.5, -75.0…-71.5 | HAITI |
| `caribbean` | Caribbean | 8–28, -90…-58 | (bbox only) |
| `all` | **blanket** — every event globally, no filter | — | — |

`all` is the pipeline-proving mode: on a quiet DR day it still fetches events
from anywhere, so you can confirm fetch → filter → publish all work.

## Two independent sources

The service treats the realtime feed and EMSC's felt reports as two separate
sources of truth, each able to fire its own alert rather than one modifying the
other.

**Feed** — fires when a new quake happens in a region (occurrence). This is the
REST poll that checks the origin-time window each tick.

**Felt** — fires on human response, which moves on its own:
- *new felt event*: a quake people report feeling (`ev_nbtestimonies >= FELT_ALERT_AT`)
  — catches quakes the feed missed (under the magnitude floor) — ntfy tag `felt`
- *jump*: an event's felt count climbs by `>= FELT_JUMP_BY` since last seen —
  escalating impact; ntfy tag `felt` + `upload`

The felt count is sent with ntfy priority 4 once it passes 50 reports. The felt
lookup is best-effort; a failure never blocks the feed alert.

## API

- `GET /health` — liveness.
- `GET /api/cron?region=<ids|all>&minmag=<n>&window=<minutes>` — run one poll.
  - `region` — comma-separated ids or `all` (default: `REGIONS` env, else `all`)
  - `minmag` — minimum magnitude (default: `MIN_MAGNITUDE` env, else 0)
  - `window` — how far back to query in minutes (default 5). Use a large window
    for a test sweep, e.g. `?region=all&window=120`.
  - `felt` — felt-report escalation threshold (default: `FELT_ESCALATE_AT` env,
    else 20). An event felt by at least this many people gets a high-priority
    alert with a `⚠ HIGH FELT` banner. `1` is a good test value; `0` disables
    the felt lookup.

## Config (env) — that's all there is

```
NTFY_BASE_URL=https://ntfy.example.com   # your ntfy server
NTFY_TOPIC=earthquakes-dr
NTFY_ACCESS_TOKEN=                        # optional; empty for anonymous publish
REGIONS=dr                                # default regions on cron (or "all")
MIN_MAGNITUDE=0                           # default floor
FELT_ALERT_AT=5                            # alert on a new felt event at >= N reports
FELT_JUMP_BY=15                            # felt-count climb that triggers a jump alert
FELT_COOLDOWN_MIN=30                       # min between repeat alerts for the same event
```

Exactly one trade, and it's deliberate: the default window (5 min) equals the
cron interval, so each event belongs to exactly one poll and needs no storage
to dedupe. A skipped or delayed cron tick can therefore miss an event. For a
personal earthquake alert that is the right trade — if you later want
miss-proofing, add a small store (Upstash Redis) and widen the window; the code
keeps `unid` for that.

## Deploy

Two ways to run it.

### Self-host (Coolify / Docker) — no public domain needed

The container polls EMSC on its own interval (`SELF_POLL=true`), so nothing
external needs to reach it — it only makes outbound calls to EMSC and your ntfy
server. Reach the health page over your internal network.

```bash
cp .env.example .env      # fill in NTFY_* (REGIONS/MIN_MAGNITUDE optional)
docker compose up -d
# health: http://<host>:3000/health
```

On Coolify, add this repo as a Docker Compose deployment and set env vars in the
UI; no domain or proxy rewrite is required.

### Vercel (cron)

`/api/cron` is hit by Vercel's Managed Cron (5-min; **Pro plan — Hobby caps cron
at once per day**, too coarse for quakes). Leave `SELF_POLL` unset so the
container doesn't double-poll.

```bash
bun install
bun dev                 # local, defaults to dry-run — never pushes to real ntfy
DRY_RUN=0 bun dev       # local, real publish (needs ntfy env)
vercel deploy --prod
```

## Test

```bash
bun test    # region resolution, bbox union, region matching, dedupe
```
