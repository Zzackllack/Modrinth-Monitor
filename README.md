# Modrinth Monitor

Lightweight Playwright-based monitor that visits a Modrinth modpack page and optionally performs a real browser download with basic integrity checks.

**Key goals:**

- Validate the modpack download button and flow
- Ensure the downloaded file is present and non-empty
- Run on a low-frequency randomized schedule inside Docker
- Keep traffic looking organic: not every visit is a download, and not every visit leaves from the same country or network

**Contents**

- `src/` — runtime: scheduler, egress routing, proxy pool, logging helpers
- `src/net/` — small primitives: geo buckets, host formatting, HTTP, concurrency
- `src/egress/` — route planning, Gluetun client, proxy feeds/checker/pool, journal
- `tests/` — Playwright test: `modrinth-download.spec.ts`
- `checks/` — unit and local browser checks (no external network required)
- `playwright.config.ts` — Playwright configuration
- `Dockerfile`, `docker-compose.yml` — containerization and runtime

## Quickstart

Prerequisites: Node (20+), pnpm or npm, Docker (for container runs).

Development (run tests locally):

```bash
pnpm install
pnpm exec playwright install --with-deps
pnpm exec playwright test --ui    # interactive runner
pnpm exec playwright test         # headless run
```

Run in Docker (production):

```bash
cp .env.example .env
# edit .env: VPN credentials, EGRESS_MODE, download percentage, ...
docker compose up --build -d
```

Local runs default to `EGRESS_MODE=direct`, so nothing below is required to run the tests.

## Configuration

The agent reads configuration from environment variables. The full list lives in `.env.example`; the important groups are:

### Visit behavior

- `MODRINTH_URL`: URL of the Modrinth project or download page to monitor (required)
- `DOWNLOAD_DIR`: directory where Playwright should save downloads (default: `downloads`)
- `DOWNLOAD_PERCENTAGE`: percentage of visits that attempt a download, from `0` to `100` (default: `100`). Decimal percentages are supported. `0` visits the page without clicking Download; `100` downloads on every visit.
- `MIN_DELAY_MINUTES` / `MAX_DELAY_MINUTES`: randomized scheduler delay (defaults to ~3–4 hours)
- `ONE_SHOT`: run one cycle and exit
- `LOG_LEVEL`: `info`|`debug`|`error` (optional)

### Egress routing

- `EGRESS_MODE`: `direct`, `vpn`, `proxy` or `mixed` (default: `direct`, compose default: `mixed`)
- `EGRESS_VPN_SHARE`: in `mixed` mode, percentage of runs that use the VPN (default: `50`)
- `EGRESS_COUNTRY_WEIGHTS`: relative country weights, default `US=1,DE=1,other=1` (one third each)
- `EGRESS_OTHER_COUNTRIES`: optional explicit country list for the `other` bucket
- `EGRESS_MAX_RETRIES`: total attempts per run (default: `3`)
- `EGRESS_RETRY_DELAY_SECONDS`: pause between attempts (default: `10`)
- `EGRESS_PROXY_FALLBACK`: `vpn`, `direct` or `none` when no proxy is healthy (default: `vpn`)
- `EGRESS_VERIFY_COUNTRY`: verify the observed exit country before browsing (default: `true`)

Country weights accept ISO 3166-1 alpha-2 codes and the `other` bucket. Weights are relative, so `US=2,DE=1,other=1` means 50% / 25% / 25%. A bucket for a country the provider does not offer will fail that attempt and count against the retry budget.

### VPN route (Gluetun)

- `GLUETUN_CONTROL_URL`: control server base URL (default: `http://localhost:8000`)
- `GLUETUN_CONTROL_USER` / `GLUETUN_CONTROL_PASSWORD`: basic auth
- `VPN_PROXY_URL`: Gluetun's built-in HTTP proxy (`http://vpn:8888` in compose). Without it, the monitor must share the VPN network namespace.
- `GLUETUN_CITY_POOL`, `GLUETUN_REGION_POOL`, `GLUETUN_HOSTNAME_POOL`: optional constraints within the selected country
- `VPN_CONNECT_TIMEOUT_SECONDS`, `VPN_RESTART_TIMEOUT_SECONDS`, `VPN_STATUS_POLL_SECONDS`: tunnel restart budget

### Proxy route

- `PROXY_SOURCES`: `proxifly`, `monosans`, `thespeedx`, `clarketm`, `hookzof`, or any raw-text URL
- `PROXY_PROTOCOLS`: default `http,https,socks5`
- `PROXY_REFRESH_MINUTES`: feed refresh interval (default: `30`)
- `PROXY_MAX_CANDIDATES`: parallel candidate checks per batch (default: `6`)
- `PROXY_CHECK_TIMEOUT_MS`, `PROXY_COOLDOWN_MINUTES`, `PROXY_CHECK_URL`
- `PROXY_CACHE_FILE`, `GEO_CACHE_FILE`, `EGRESS_LOG_FILE`

## Behavior and Architecture

- The scheduler (`src/scheduler.js`) runs a Playwright test periodically at a randomized interval.
- Playwright always opens the page and verifies that the download button is visible. Visit-only runs then finish successfully without clicking it or saving a file.
- On runs selected for downloading, Playwright performs a browser-based download and saves the file into `DOWNLOAD_DIR`.
- After download the agent verifies the file exists and is larger than 0 bytes.
- Logs include `visit.mode.selected` with the configured percentage and chosen mode, and `download.skipped` for visits only.

### Egress per run

1. `EGRESS_MODE` and `EGRESS_VPN_SHARE` pick the network kind for this run.
2. `EGRESS_COUNTRY_WEIGHTS` picks a country bucket (`US`, `DE`, `other`). The `other` bucket resolves to a random non-preferred country for VPN routes, or to any proxy not exiting in a preferred country.
3. The route is prepared and validated:
   - **VPN**: Gluetun settings are patched, the tunnel is restarted, and the exit IP's country is checked (through Gluetun's HTTP proxy when `VPN_PROXY_URL` is set).
   - **Public proxy**: candidates are health-checked with a real request (TCP + CONNECT/SOCKS handshake + TLS + HTTP GET). The first proxy that works *and* exits in the requested bucket is used. Dead candidates are cooled down with exponential backoff.
4. A pre-flight request to `MODRINTH_URL` goes through the same browser route.
5. Playwright starts with `MONITOR_PROXY_SERVER` pointing at the selected route.
6. If the run fails, the proxy is marked bad and the whole attempt is retried with a fresh route, up to `EGRESS_MAX_RETRIES`.

Only browser traffic is routed through the selected egress. Proxy-feed refresh and proxy health checks necessarily originate from the container's own network, so do not treat this as a anonymity system for the scheduler itself.

### Download vs. visit ratio

`DOWNLOAD_PERCENTAGE` controls the analytics conversion rate. `100` means every visit also downloads (a 1:1 conversion), which is not organic. Set something like `DOWNLOAD_PERCENTAGE=25` so roughly one in four visits clicks Download; the rest only load the page. Each run makes an independent random choice and Playwright's own retries preserve it.

## Proxy pool

- Feeds are fetched concurrently at startup and every `PROXY_REFRESH_MINUTES`. A failing feed is logged and skipped; others still load.
- `proxifly` is the primary feed: it is regenerated every few minutes and includes exit-country metadata, which makes geographic selection cheap. `monosans` adds volume.
- Entries are deduped by protocol/host/port and capped by `PROXY_MAX_POOL_SIZE` with country diversity preserved.
- Health checks are strict: a proxy must complete a CONNECT or SOCKS handshake, negotiate TLS with the check endpoint, and return a valid response. TCP-only checks are not used.
- IPv4 and IPv6 proxy literals are both supported, as are `http`, `https`, `socks4`/`socks4a` and `socks5`/`socks5h`. SOCKS proxies requiring credentials are skipped because Chromium cannot send them.
- Health state (last success, latency, failure count, observed exit IP/country) is persisted to `PROXY_CACHE_FILE` so restarts reuse a warm pool.

Free proxies are unreliable by nature: expect slow first checks and frequent failures. The pool tolerates this by trying candidates in parallel batches and falling back to the VPN when enabled.

## Logging

Every run writes structured JSON to stdout and appends the same records to `EGRESS_LOG_FILE` (rotated at 5 MB). Relevant actions:

- `egress.route.planned` — mode, kind, bucket, requested country
- `egress.proxy.ready` / `egress.vpn.ready` — chosen proxy id or VPN selection, observed country, exit IP, latency
- `egress.probe.ok` / `egress.probe.failed` — pre-flight through the actual route
- `egress.attempt.start` / `egress.attempt.success` / `egress.attempt.failed` — per attempt, with errors
- `egress.retry.scheduled`, `egress.exhausted` — retry budget
- `proxy.source.loaded` / `proxy.source.failed`, `proxy.refresh.completed`, `proxy.candidate.failed`, `proxy.candidate.mismatch`
- `visit.mode.selected` — download decision plus egress metadata, from the Playwright side

Example:

```json
{"ts":"2026-11-11T00:12:03.114Z","action":"egress.proxy.ready","routeId":"1-proxy-US-9f2c1a44","kind":"proxy","bucket":"US","requestedCountry":"US","country":"US","proxy":"https://209.50.255.91:1080","ip":"209.50.255.91","latencyMs":412}
{"ts":"2026-11-11T00:12:03.918Z","action":"egress.attempt.success","attempt":1,"routeId":"1-proxy-US-9f2c1a44","kind":"proxy","bucket":"US","country":"US","proxy":"https://209.50.255.91:1080"}
{"ts":"2026-11-11T00:12:04.002Z","action":"visit.mode.selected","downloadPercentage":25,"visitMode":"visit","egressKind":"proxy","egressCountry":"US","egressProxy":"https://209.50.255.91:1080"}
```

Proxy credentials are never logged and the journal/cache files are written with mode `0600`.

## Docker & VPN

The compose setup runs Gluetun with `HTTPPROXY=on` and puts the monitor on the normal compose network. VPN runs point Chromium at `http://vpn:8888`; proxy runs use a validated public proxy. That is what makes per-run switching possible without restarting containers or re-creating network namespaces.

- The Gluetun control server requires auth. Compose sets a basic-auth role from `GLUETUN_CONTROL_USER` / `GLUETUN_CONTROL_PASSWORD` (default `monitor` / `change-me`). Change these in `.env`.
- `FIREWALL_INPUT_PORTS=8000,8888` keeps the control server and HTTP proxy reachable inside the compose network. Neither port is published to the host.
- A custom `gluetun-auth/config.toml` is still supported by Gluetun, but is no longer required.
- `EGRESS_MODE=direct` with compose still waits for the VPN health check; remove the `depends_on` block if you run without Gluetun.

## Tests

- `pnpm run test:unit` — geo buckets, route planning, proxy parsing, proxy tunnel checks (HTTP/SOCKS5/IPv6 fixtures), pool selection/cooldown/persistence, retry and fallback logic.
- `pnpm run test:local` — starts a local fixture page and a local forward proxy, then runs Playwright headless in three modes: visit only, download, and visit through the proxy.
- `pnpm exec playwright test` — the real Modrinth flow.

## Contributing

Ideas that would still be useful:

- Checksum validation for downloaded files
- Notifications (Discord/Slack/email) for failures
- Retention policy for downloaded files
- A small status endpoint exposing pool health

Please open issues or PRs for improvements.

## License

This repository is licensed under the Unlicense, you can do whatever you want with it. See `LICENSE` for details.
