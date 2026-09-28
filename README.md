# Seismic Alerts

Polls the EMSC realtime earthquake feed and pushes alerts to a self-hosted ntfy
server for the regions you pick. Runs on Vercel (cron → serverless function →
ntfy) with **no external state**: no Redis, no database, just env vars.

## Realtime source: websocket, not REST polling

The EMSC live page serves a **push-only websocket**
(`wss://www.seismicportal.eu/standing_order/websocket`) that delivers every
event create/update/delete the moment EMSC indexes it. A persistent listener is
the correct realtime source: the FDSNWS REST catalog lags the websocket by
seconds-to-minutes, so a time-windowed REST poll can miss events entirely (the
origin-time window slides past an event before the REST index picks it up).
This service uses the websocket on self-host (a persistent container can hold
the connection); it filters on arrival, never by window.

The FDSNWS REST endpoint remains available as a bounded startup/watchdog
catch-up, but it is not the realtime ingest path.

## Regions

Selectable, defined in `src/regions.ts` (extend the catalog there):

| id | label | bbox | name keywords |
|---|---|---|---|
| `dr` | Dominican Republic | 17.0–20.5, -72.5…-68.0 | DOMINICAN REPUBLIC |
| `pr` | Puerto Rico | 17.2–19.0, -67.5…-65.0 | PUERTO RICO |
| `haiti` | Haiti | 17.5–20.5, -75.0…-71.5 | HAITI |
| `caribbean` | Caribbean | 8–28, -90…-58 | (bbox only) |
| `all` | **blanket** — every event globally, no filter | — | — |

`all` is the pipeline-proving mode: on a quiet day it still fetches events
from anywhere, so you can confirm fetch → filter → publish all work.

## Two independent sources

The service treats the realtime feed and EMSC's felt reports as two separate
sources of truth, each able to fire its own alert rather than one modifying the
other.

**Feed** — fires when a new quake happens in a region (occurrence). The primary
path is a persistent EMSC standing-order **websocket listener** (`src/ws-feed.ts`)
that pushes create/update frames the instant EMSC indexes them, filtering on
arrival (region + magnitude) with no origin-time window — so an event can never
slip past a poll. A magnitude revision of `>= UPDATE_ALERT_MAG_DELTA` (or one
that crosses the magnitude floor) on an `update` frame also alerts. A bounded
REST poll remains only as a watchdog/backstop (self-poll / `/api/cron`).

**Felt** — fires on human response, which moves on its own:
- *new felt event*: a quake people report feeling (`ev_nbtestimonies >= FELT_ALERT_AT`)
  — catches quakes the feed missed (under the magnitude floor) — ntfy tag `felt`
- *jump*: an event's felt count climbs by `>= FELT_JUMP_BY` since last seen —
  escalating impact; ntfy tag `felt` + `upload`

The felt count is sent with ntfy priority 4 once it passes 50 reports. The felt
lookup is best-effort; a failure never blocks the feed alert.

All ntfy alerts (feed and felt) are sent as **markdown**: a bold key-fact title
line, then labeled `Field: value` lines, with a `## Details` heading when there
are more than four fields.

## API

- `GET /health` — liveness.
- `GET /api/cron?region=<ids|all>&minmag=<n>&window=<minutes>` — run one poll.
  - `region` — comma-separated ids or `all` (default: `REGIONS` env, else `all`)
  - `minmag` — minimum magnitude (default: `MIN_MAGNITUDE` env, else 0)
  - `window` — how far back to query in minutes (default 5). Use a large window
    for a test sweep, e.g. `?region=all&window=120`.
  - `felt-alert-at` — min felt reports to alert on a new felt event (env
    `FELT_ALERT_AT`, default 5). 0 disables. Low values (1-3) are good for a
    test run.
  - `felt-jump-by` — felt-count climb that triggers a jump alert (env
    `FELT_JUMP_BY`, default 15). 0 disables.

## Config (env) — that's all there is

```
NTFY_BASE_URL=https://ntfy.example.com   # your ntfy server
NTFY_TOPIC=earthquakes
NTFY_ACCESS_TOKEN=                        # optional; empty for anonymous publish
REGIONS=dr                                # default regions on cron (or "all")
MIN_MAGNITUDE=0                           # default floor
FELT_ALERT_AT=5      # alert on a new felt event at >= N reports
FELT_JUMP_BY=15      # felt-count climb that triggers a jump alert
FELT_COOLDOWN_MIN=30 # min between repeat alerts for the same event
WS_FEED=true         # realtime websocket feed (self-host)
UPDATE_ALERT_MAG_DELTA=0.3 # revision alert on magnitude shift of at least this
```

The realtime path needs no external store: the websocket listener keeps an
in-memory alerted-unid set and last-magnitude map, which survive reconnects
within the long-lived self-host container. The REST backstop poll (self-poll or
`/api/cron`) is windowed with no overlap, so it too runs stateless; a skipped
tick there is acceptable since it is only a catch-up, not the primary path.

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
