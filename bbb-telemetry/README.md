# BBB client telemetry: OpenTelemetry + ObserveRTC

Opt-in performance telemetry for the BigBlueButton HTML5 client, plus a server switch that turns it
on or off for the whole server.

This directory lives in the `hackweek-telemetry` branch, which is BigBlueButton 4.0.1
(`v4.0.x-develop` @ `3758c946b9`) plus the telemetry commits. The client and middleware code is in
the tree (`bigbluebutton-html5/imports/ui/core/telemetry/`, `bbb-graphql-middleware/`). This
directory holds the server switch, and [Deploy a server from this branch](#deploy-a-server-from-this-branch)
explains how to run a full BigBlueButton server with it.

**What a session can answer when telemetry is on:**
- which component is slow to render;
- which request is slow, and whether it went over HTTP/2 or HTTP/1.1;
- which GraphQL operation is slow to answer;
- what the WebRTC quality looks like per participant, using [ObserveRTC](https://observertc.org).

**Where the data goes:** as OpenTelemetry (OTLP) metrics and logs, through an OpenTelemetry
Collector on the server, to any OTLP backend. This guide uses SigNoz Cloud.

**The switch is a config file, read when the server boots.** `/etc/bigbluebutton/bbb-telemetry.yml`
says whether this server starts with telemetry on or off. At every boot, `bbb-telemetry.service`
applies it before `bbb-apps-akka` and `bbb-web` start, and logs one line saying which state the
server is in.

**Off is the default.** When it is off:
- the collector is not running;
- nginx has no `/api/telemetry` location;
- the client loads neither the OTLP sink nor ObserveRTC.

So **neither OpenTelemetry nor ObserveRTC generates any metric or log.**

---

## Contents

1. [Directory layout](#directory-layout)
2. [How it works](#how-it-works)
3. [Requirements](#requirements)
4. [Deploy a server from this branch](#deploy-a-server-from-this-branch)
5. [Install the server switch](#2-install-the-server-switch)
6. [Configure](#3-configure)
7. [Turn telemetry on or off](#4-turn-telemetry-on-or-off)
8. [View the data](#5-view-the-data)
9. [What is collected and what is not](#what-is-collected-and-what-is-not)
10. [Troubleshooting](#troubleshooting)
11. [Uninstall](#uninstall)
12. [Measured cost](#measured-cost)

---

## Directory layout

| Path | What it is |
|---|---|
| `config.yml` | The switch. `install.sh` copies it to `/etc/bigbluebutton/bbb-telemetry.yml`. |
| `bin/bbb-telemetry` | Applies the switch: client settings, collector container, nginx location, plus the log line. |
| `systemd/bbb-telemetry.service` | Runs `bbb-telemetry apply --boot` at every boot, before `bbb-apps-akka` and `bbb-web`. |
| `install.sh` | Installs everything above. It never turns telemetry on. |
| `bbb-telemetry.env.example` | Collector secrets (SigNoz region and ingestion key). Installed as `/etc/bigbluebutton/bbb-telemetry.env`, mode 600. |
| `otel/otel-collector-signoz.yaml` | Collector config that forwards to SigNoz Cloud. |
| `otel/otel-collector-debug.yaml` | Collector config that sends nothing out and prints everything to `docker logs`. |
| `nginx/telemetry.nginx` | `location /api/telemetry/`, authorized with the session token, the same way as `/graphql`. |

Elsewhere in the branch:

| Path | What it is |
|---|---|
| `bigbluebutton-html5/imports/ui/core/telemetry/` | Client telemetry: store, observers, GraphQL timing link, OTLP sink, repro trail, ObserveRTC wrapper |
| `bigbluebutton-html5/public/compatibility/observertc-client-monitor.min.js` | ObserveRTC, downloaded only when the observer is on |
| `bigbluebutton-html5/private/config/settings.yml` | `public.app.telemetry` defaults (all off) |
| `bbb-graphql-middleware/internal/` | `gql_mutation_duration_*` and `gql_subscription_first_data_*` histograms |
| `bigbluebutton-tests/playwright/telemetry/` | E2E tests (`@ci`) |
| `docs/docs/development/client-telemetry.md` | Developer docs: every setting and metric |

## How it works

```
 browser (bbb-html5)                                        BBB server
 ┌───────────────────────────────────────┐
 │ React.Profiler on 13 app areas         │
 │ PerformanceObserver: resource,         │  POST /api/telemetry/v1/{metrics,logs}
 │   navigation, longtask, event          │  x-session-token           ┌──────────────┐
 │ Apollo link timing (GraphQL)           │ ─────── same origin ─────▶ │ nginx        │
 │ ObserveRTC (wraps RTCPeerConnection)   │                            │ auth_request │
 │ repro trail (click / keydown)          │                            └──────┬───────┘
 │              │                         │                                   │ 127.0.0.1:4318
 │   in-memory store: ring buffers +      │                     ┌─────────────▼────────────┐
 │   histograms (OTel semantic names)     │                     │ OTel Collector           │──▶ SigNoz Cloud
 │     │            │            │        │                     │ container                │    (or any OTLP
 │     ▼            ▼            ▼        │                     │ bbb-telemetry-otel       │     backend)
 │  debug       client       OTLP/HTTP    │                     │ + Prometheus scrape:     │
 │  window      logger       JSON sink    │                     │   graphql-middleware     │
 │  (Alt+K)     (perf_*)     (~1 KB)      │                     │   :8378, LiveKit :6789,  │
 └───────────────────────────────────────┘                     │   bbb-webrtc-sfu :6759   │
                                                                └──────────────────────────┘
```

`bbb-telemetry apply` turns the config file into these four pieces of server state:

| `bbb-telemetry.yml` | Client (`public.app.telemetry` in `/etc/bigbluebutton/bbb-html5.yml`) | Collector | nginx `/api/telemetry` |
|---|---|---|---|
| `enabled: false` | `enabled: false`, `exporter: none`, `logToServer: false`, `webrtcMonitor.enabled: false` | removed | removed (404) |
| `enabled: true` | `enabled: true`, `exporter: otlp`, `logToServer` from the file | running | installed |
| `enabled: true` + `observer.enabled: true` | the row above plus `webrtcMonitor.enabled: true` | running | installed |

**Fail-safe:** if the collector cannot start, `apply` falls back to the disabled state and logs why.
This happens when the env file is missing, the port is taken or the config is invalid. Clients then
never post to an endpoint that is down.

## Requirements

- A clean Ubuntu 24.04 64-bit server, as BigBlueButton 4.0 requires (`docs/docs/administration/install.md`):
  8 CPU cores and 16 GB of memory recommended (4 cores / 8 GB minimum), a public hostname and IP. The production build of the client alone needs about 4 GB of RAM: on a 2-CPU
  machine that was already running dev servers it froze the box, so build on a machine with spare
  memory, or on another machine, and copy `dist/`.
- `yq` v4, which ships with BigBlueButton; `docker`; `nginx`; `systemd`.
- Node.js 22 and npm for the client build. Go (the version in `bbb-graphql-middleware/go.mod`) for
  the middleware.
- Optional: a [SigNoz Cloud](https://signoz.io) account, or any other OTLP backend.

## Deploy a server from this branch

**1. Install BigBlueButton 4.0** with the official installer. It installs every service: akka-apps,
bbb-web, Hasura, the graphql services, FreeSWITCH, bbb-webrtc-sfu, LiveKit, nginx and the
recording pipeline. See `docs/docs/administration/install.md` for every option. For
example:

```bash
wget -qO- https://raw.githubusercontent.com/bigbluebutton/bbb-install/v4.0.x-release/bbb-install.sh \
  | sudo bash -s -- -v noble-400 -s bbb.example.com -e admin@example.com
```

Check that a plain meeting works before going on (`sudo bbb-conf --check`, then join a room).

**2. Get this branch on the server:**

```bash
git clone --branch hackweek-telemetry git@github.com:guiiBecker/-P-bbb.git bigbluebutton
cd bigbluebutton
```

**3. Deploy the client** with the telemetry code. `deploy.sh` runs the production build, copies
`dist/` to `/usr/share/bigbluebutton/html5-client/` and restarts nginx:

```bash
cd bigbluebutton-html5 && ./deploy.sh && cd ..
```

**4. Deploy the middleware.** This step is optional: it only adds the server-side GraphQL
histograms. `deploy.sh` builds the binary, replaces `/usr/bin/bbb-graphql-middleware` and restarts
the service:

```bash
cd bbb-graphql-middleware && ./deploy.sh && cd ..
```

**5. Install the telemetry switch.** It stays off until you turn it on:

```bash
cd bbb-telemetry && sudo ./install.sh
```

Then configure it ([section 3](#3-configure)) and turn it on ([section 4](#4-turn-telemetry-on-or-off)).

Only the client and the middleware differ from the packages, so a package upgrade (`apt upgrade`)
puts the stock client back. If that happens, run step 3 again. akka-apps reads its client settings
catalog from the packaged `settings.yml`, which has no `public.app.telemetry` block. That is fine:
the client falls back to its built-in defaults, and akka only logs `unknown-key` warnings for the
keys `bbb-telemetry` writes.

## 2. Install the server switch

```bash
cd bigbluebutton/bbb-telemetry   # this directory, in the hackweek-telemetry branch
sudo ./install.sh
```

`install.sh` does the following:
- installs `/usr/local/bin/bbb-telemetry`;
- installs the collector and nginx files into `/usr/local/share/bbb-telemetry/`;
- creates `/etc/bigbluebutton/bbb-telemetry.yml` (off) and `/etc/bigbluebutton/bbb-telemetry.env`
  (600), but only if they do not exist yet;
- installs and enables `bbb-telemetry.service`.

It does **not** turn telemetry on, and re-running it never overwrites your config or secrets.

> Coming from the hackweek `infra/up.sh`? Remove its container first, because it holds port 4318:
> `sudo docker rm -f hackweek-otel && sudo rm -f /etc/bigbluebutton/nginx/telemetry.nginx`.

## 3. Configure

### `/etc/bigbluebutton/bbb-telemetry.yml`

```yaml
telemetry:
  enabled: false          # master switch: client metrics + the OTel collector
  logToServer: true       # also send logs: periodic summaries + the repro trail on client errors
  observer:
    enabled: false        # ObserveRTC WebRTC quality monitor (needs telemetry.enabled)
  collector:
    config: otel/otel-collector-signoz.yaml   # or otel/otel-collector-debug.yaml
    envFile: /etc/bigbluebutton/bbb-telemetry.env
    image: otel/opentelemetry-collector-contrib:0.120.0
    memory: 300m
```

| Key | Default | Meaning |
|---|---|---|
| `telemetry.enabled` | `false` | Server switch. When false, nothing below matters, and nothing is generated. |
| `telemetry.logToServer` | `true` | Sends the OTLP **logs**: `bbb.perf_summary` every 30 s, and `bbb.repro_trail` on client errors (at most 1 a minute, 5 a session). When false, only metrics are sent. |
| `telemetry.observer.enabled` | `false` | Loads ObserveRTC: score, RTT, `bbb.kind=webrtc` summaries and `bbb.webrtc_issue` logs, labelled by source (`livekit` or `sfu`). |
| `telemetry.collector.config` | `otel/otel-collector-signoz.yaml` | Collector config. A relative path resolves against `/usr/local/share/bbb-telemetry`. |
| `telemetry.collector.envFile` | `/etc/bigbluebutton/bbb-telemetry.env` | Passed to the container with `--env-file`. |
| `telemetry.collector.image` | `otel/opentelemetry-collector-contrib:0.120.0` | Collector image. |
| `telemetry.collector.memory` | `300m` | Container memory limit. The configs also set a `memory_limiter` of 250 MiB. |

Finer client settings are documented in `docs/docs/development/client-telemetry.md`, and you can override them in
`/etc/bigbluebutton/bbb-html5.yml` under `public.app.telemetry`. They include `sampleRate`,
`flushIntervalMs`, `thresholds.*` and `webrtcMonitor.collectingPeriodMs`. `bbb-telemetry` only
writes `enabled`, `exporter`, `logToServer` and `webrtcMonitor.enabled`, and leaves every other key
alone.

### `/etc/bigbluebutton/bbb-telemetry.env`

```bash
SIGNOZ_REGION=us                 # us, us2, eu, in... (from your SigNoz URL)
SIGNOZ_INGESTION_KEY=...         # SigNoz: Settings -> Ingestion Settings
BBB_TELEMETRY_ENVIRONMENT=production
```

### Another backend

Copy `otel/otel-collector-signoz.yaml` and replace the `otlp/signoz` exporter with your backend's
exporter (Grafana Cloud, Datadog, Honeycomb, a self-hosted Prometheus with `prometheusremotewrite`,
and so on). Point `telemetry.collector.config` at the new file with an absolute path, then run
`apply`. Validate the file first:

```bash
sudo docker run --rm --env-file /etc/bigbluebutton/bbb-telemetry.env -v "$PWD/my.yaml:/c.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.120.0 validate --config=/c.yaml
```

For a first test without any backend, use `otel/otel-collector-debug.yaml` and read `docker logs`.

## 4. Turn telemetry on or off

**At boot.** Set `telemetry.enabled` in the file and reboot, or just leave it: `bbb-telemetry.service`
applies the file before `bbb-apps-akka` starts. Because akka reads `bbb-html5.yml` only when it
starts, no restart is needed.

**On a running server:**

```bash
sudo bbb-telemetry on               # telemetry on, ObserveRTC unchanged
sudo bbb-telemetry on --observer    # telemetry and ObserveRTC on
sudo bbb-telemetry off              # everything off
sudo bbb-telemetry apply --restart  # after editing the file by hand
sudo bbb-telemetry status           # config, client settings, collector, nginx, last log lines
```

> `on`, `off` and `apply --restart` restart `bbb-apps-akka` **and** `bbb-web`, which **ends the
> meetings in progress**. Restarting akka alone would leave bbb-web with ghost meetings. Without
> `--restart`, `apply` changes the files and the collector and tells you to restart later. Until you
> do, new meetings keep the old client settings.

**The startup message.** Every `apply`, including the one at boot, logs one line:

```
BBB telemetry is ENABLED: client metrics and logs go to nginx /api/telemetry, then to the OTel collector (bbb-telemetry-otel, otel/otel-collector-signoz.yaml). ObserveRTC WebRTC monitor: on.
```
```
BBB telemetry is DISABLED: the OTel collector is not running and the client loads neither the OTLP sink nor ObserveRTC, so no telemetry metrics or logs are generated.
```

Read the message in either place:

```bash
journalctl -t bbb-telemetry -b            # this boot
journalctl -u bbb-telemetry.service       # the boot-time runs
cat /var/log/bigbluebutton/bbb-telemetry.log
```

Each line also has a severity: `notice` for the state, `warning` when a restart is still needed or an
option is ignored, `err` for failures (which then fall back to DISABLED).

To preview what `apply` would do without changing anything, run
`sudo DRY_RUN=1 bbb-telemetry apply`.

## 5. View the data

### In the client (no backend needed)

- **Debug window:** press Alt+K in a meeting. The **Performance** section shows five tables:
  - a summary per kind (render, request, graphql, longtask, interaction, webrtc);
  - requests by protocol;
  - the slowest components, requests and GraphQL operations.

  It also has "Copy JSON", "Copy repro trail" and "Clear" buttons. If your deployment sets
  `enableDebugWindow: false`, turn it on in `bbb-html5.yml`.
- **Browser console:**
  - `bbbTelemetry.dump()` returns everything (`enabled`, stats, slowest entries, WebRTC);
  - `bbbTelemetry.stats()` returns p50/p95/max per kind;
  - `bbbTelemetry.trail()` returns the repro trail.

  `dump().enabled === false` means telemetry is off for this session.

### What the collector receives

```bash
sudo docker logs -f bbb-telemetry-otel
```

With the signoz config, the collector prints one line per batch. With the debug config, it prints
every data point and log record.

### In SigNoz

**What arrives:**

| Signal | Name | From | How often |
|---|---|---|---|
| Logs | `bbb.perf_summary` | each session (`logToServer`) | every 30 s, one record per kind with new measurements |
| Logs | `bbb.repro_trail` | each session (`logToServer`) | only on client errors (at most 1/min, 5/session) |
| Logs | `bbb.perf_summary` with `bbb.kind = 'webrtc'` | each session (`observer`) | every 30 s while media is up, one record per source |
| Logs | `bbb.webrtc_issue` | each session (`observer`) | when ObserveRTC detects an issue (frozen video, congestion...), at most 1 per type and source a minute |
| Metrics | `bbb.client.*` | each session | every 30 s |
| Metrics | `bbb.client.webrtc.score`, `.rtt` | each session (`observer`) | every 30 s |
| Metrics | `gql_*`, `bbb_application_reach_latency_milliseconds` | `bbb-graphql-middleware` | every 15 s, even with no meeting |
| Metrics | `livekit_*`, `sfu_livekit_*` | LiveKit (:6789), `bbb-webrtc-sfu` (:6759) | every 15 s |

Client data has `service.name = bbb-html5-client`. No traces are sent, so the *Services* page stays
empty; that is expected.

**Logs Explorer:**
1. Open **Logs → Logs Explorer**.
2. Set the time range to **Last 15 minutes**, filter with `service.name = 'bbb-html5-client'`, and
   click **Run Query**.
3. Open a row. The **body** is a readable summary, for example
   `graphql: 52 measurements, p50 582 ms, p95 869 ms, max 1115 ms. Slowest: getNotificationStream first-data 1115 ms | ...`.
   The **attributes** carry `bbb.kind`, `bbb.p50_ms`, `bbb.p95_ms`, `bbb.max_ms` and `bbb.slowest`.
4. Pick **Live** in the time range to follow new records as they come in.
5. Click **Save this view** to keep a filter.

| To see | Filter |
|---|---|
| summaries only | `event.name = 'bbb.perf_summary'` |
| incidents (repro trails) | `event.name = 'bbb.repro_trail'` |
| WebRTC quality | `bbb.kind = 'webrtc'` |
| LiveKit only / bbb-webrtc-sfu only | `bbb.kind = 'webrtc' AND bbb.webrtc.source = 'livekit'` / `= 'sfu'` |
| poor WebRTC sessions | `bbb.kind = 'webrtc' AND bbb.webrtc.score < 3` |
| audio/video issues (ObserveRTC) | `event.name = 'bbb.webrtc_issue'` (type in `bbb.webrtc.issue_type`) |
| slow GraphQL | `bbb.kind = 'graphql' AND bbb.p95_ms >= 500` |
| slow renders | `bbb.kind = 'render' AND bbb.max_ms >= 100` |
| one session | `session.id = '<id>'` (a random id per browser tab) |

**Reading a repro trail.** In a `bbb.repro_trail` record:
- `exception.type` and `exception.message` say what broke;
- `bbb.incident.trigger` says where it came from: `react_error`, `graphql_error`, `network_error`,
  `uncaught_error` or `unhandled_rejection`;
- the body is the trail as JSON. Each action has a `type` (click, keydown, mutation), the control's
  `dataTest` and `deltaMs`.

To turn it into a test, save the body as `trail.json` and run this inside
`bigbluebutton-tests/playwright`:

```bash
node core/scripts/trail-to-spec.js trail.json > repro/repro.spec.ts
```

**Dashboard.** Go to **Dashboards → New Dashboard → Blank**, then add one **Time Series** panel for
each row:

| Panel | Metric | Aggregation | Group by |
|---|---|---|---|
| Slowest subscriptions on join | `bbb.client.graphql.first_data.duration` | p95 | `bbb.operation.name` |
| Mutations and queries | `bbb.client.graphql.round_trip.duration` | p95 | `bbb.operation.name` |
| Slow components | `bbb.client.render.duration` | p95 | `bbb.subtree.id` |
| HTTP/2 vs HTTP/1.1 | `bbb.client.request.duration` | count | `network.protocol.version` |
| Page freezes | `bbb.client.long_task.duration` | max | — |
| WebSocket reconnects | `bbb.client.websocket.connect.duration` | count | `bbb.connect.phase` |
| Server side | `gql_mutation_total` | rate | `operationName` |
| WebRTC quality (0–5) | `bbb.client.webrtc.score` | min | `bbb.webrtc.source` |
| WebRTC RTT | `bbb.client.webrtc.rtt` | max | `bbb.webrtc.source` |
| Quality seen by LiveKit | `livekit_quality_score` | avg | — |
| LiveKit jitter | `livekit_forward_jitter` | p95 | — |

Depending on the SigNoz version, metric names show with dots or with underscores. Type `bbb` in the
metric picker to find them.

**Alert on client errors.** Go to **Alerts → New Alert**, pick the **Logs** type, filter with
`event.name = 'bbb.repro_trail'`, and set the condition to count > 0 in 5 minutes. Then pick a
channel.

## What is collected and what is not

**Sent:**
- GraphQL operation names;
- React subtree ids;
- the HTTP protocol;
- the controls' `data-test`, except ones built from user content (marked `data-telemetry-redact`, or not shaped like an id);
- request paths on this server, **without query strings and with ids replaced by `:id`**; only the host for other servers;
- the user agent;
- a random session id per tab;
- the error message, cut at 200 characters, on incidents only.

**Never sent:**
- meeting or user ids;
- tokens;
- typed text, chat or names;
- presentation content;
- audio or video.

ObserveRTC logs carry numeric fields only.

The repro trail records **which control** was used, never what was typed. Character keys are not
recorded at all. This was verified live: chat text sent during the tests is absent from every payload.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `port 4318 is already in use by another process` | Another collector holds the port, often the hackweek `hackweek-otel`. Remove it, then run `apply` again. |
| `... needs SIGNOZ_REGION and SIGNOZ_INGESTION_KEY, but ... does not exist` | Create `/etc/bigbluebutton/bbb-telemetry.env` from `bbb-telemetry.env.example`, or use the debug config. |
| `collector did not start: ...` | The message ends with the collector's last log lines. Validate the config with the `validate` command in [Another backend](#another-backend). |
| ENABLED is logged but sessions show `dump().enabled === false` | The client settings changed after akka started: run `sudo systemctl restart bbb-apps-akka bbb-web`. Also check that the client was deployed from this branch (step 3 of the deploy); an `apt upgrade` puts the stock client back. |
| Collector receives nothing, but the browser shows `401` on `/api/telemetry` | Expected for requests without a valid session token. Real sessions send `x-session-token`. |
| Browser shows `404` on `/api/telemetry` | Telemetry is off (no nginx location), or nginx was not reloaded. |
| SigNoz shows server metrics but no client data | Nobody has joined a meeting since the restart. The first client batch arrives about 30 s after join. |
| akka logs `unknown-key` warnings for `public.app.telemetry` | The packaged `settings.yml` catalog predates these keys. They are warnings only, unless `clientSettingsOverrideStrictValidation=true`. |

## Uninstall

```bash
sudo bbb-telemetry off
sudo systemctl disable --now bbb-telemetry.service
sudo rm -f /usr/local/bin/bbb-telemetry /etc/systemd/system/bbb-telemetry.service
sudo rm -rf /usr/local/share/bbb-telemetry
sudo rm -f /etc/bigbluebutton/bbb-telemetry.yml /etc/bigbluebutton/bbb-telemetry.env
sudo systemctl daemon-reload
```

`apply` keeps the previous `bbb-html5.yml` as `bbb-html5.yml.bak-bbb-telemetry`.

## Measured cost

Measured on 2026-10-19 with the client in development mode on a 2-CPU server. Production numbers
are still to be measured.

| What | Result |
|---|---|
| Telemetry module in the bundle | 4.3 KB gzip (about 0.2% of the 1.94 MB bundle) |
| OTLP sink, hand-written | 1.0 KB gzip; the OpenTelemetry SDK would cost 20 KB (metrics only) to 57 KB (everything) |
| ObserveRTC | 68 KB gzip, in its own file, downloaded only when the observer is on |
| Join time, telemetry off vs on (median of 3) | 6,133 vs 6,043 ms (noise) |
| Main-thread CPU, off vs on | 2.1% vs 2.3% |
| Main-thread CPU, observer off vs on (audio connected) | 3.4% vs 3.4% |
| Telemetry off | 0 measurements, 0 requests, ObserveRTC not downloaded, native `RTCPeerConnection` |
