# Modrinth Monitor

Lightweight Playwright-based monitor that visits a Modrinth modpack page and optionally performs a real browser download with basic integrity checks.

**Key goals:**

- Validate the modpack download button and flow
- Ensure the downloaded file is present and non-empty
- Run on a low-frequency randomized schedule inside Docker (optionally routed through a VPN)

**Contents**

- `src/` — runtime: `scheduler.js`, logger and helper logic
- `tests/` — Playwright test: `modrinth-download.spec.ts`
- `playwright.config.ts` — Playwright configuration
- `Dockerfile`, `docker-compose.yml` — containerization and runtime

## Quickstart

Prerequisites: Node (16+), pnpm or npm, Docker (for container runs).

Development (run tests locally):

```bash
pnpm install
pnpm exec playwright install --with-deps
pnpm exec playwright test --ui    # interactive runner
pnpm exec playwright test         # headless run
```

Run in Docker (production):

```bash
docker compose up --build -d
```

## Configuration

The agent reads configuration from environment variables. Important ones:

- `MODRINTH_URL`: URL of the Modrinth project or download page to monitor (required)
- `DOWNLOAD_DIR`: directory where Playwright should save downloads (optional; defaults to `downloads`)
- `DOWNLOAD_PERCENTAGE`: percentage of visits that attempt a download, from `0` to `100` (default: `100`). Decimal percentages are supported. `0` visits the page without clicking Download; `100` downloads on every visit.
- `MIN_DELAY_HOURS` / `MAX_DELAY_HOURS`: numeric bounds for randomized scheduler delay (defaults to ~3–4 hours)
- `LOG_LEVEL`: `info`|`debug`|`error` (optional)

When running via Docker Compose you can set these in the compose file or via an `.env` file.

For example, set `DOWNLOAD_PERCENTAGE=30` in `.env` for downloads on roughly 30% of runs and visits only on roughly 70%. Locally, use `DOWNLOAD_PERCENTAGE=30 pnpm test`; local commands read exported environment variables, not `.env` automatically. Each run makes an independent random choice, so small samples can differ from the configured percentage. Retries retain the same choice.

## Behavior and Architecture

- The scheduler (`src/scheduler.js`) runs a Playwright test periodically at a randomized interval.
- Playwright always opens the page and verifies that the download button is visible. Visit-only runs then finish successfully without clicking it or saving a file.
- On runs selected for downloading, Playwright performs a browser-based download and saves the file into `DOWNLOAD_DIR`.
- After download the agent verifies the file exists and is larger than 0 bytes.
- Logs include `visit.mode.selected` with the configured percentage and chosen mode, and `download.skipped` for visits only. The percentage controls download attempts; it does not guarantee an analytics conversion rate or a successful download.
- The project is intentionally low-frequency to avoid heavy scraping and to respect site usage policies.

## Tests

The Playwright test in `tests/modrinth-download.spec.ts` is the primary verification harness. Run it with `pnpm exec playwright test`.

Run `pnpm run test:unit` for download policy checks and `pnpm run test:local` for browser checks against a local fixture, without contacting Modrinth.

## Docker & VPN (optional)

The repository includes a `docker-compose.yml` and `Dockerfile` to run the monitor inside a container. The intended pattern is to run the monitor container attached to a VPN container (for example Gluetun) so all outbound traffic is routed through the VPN.

## Contributing

If you want to extend or harden the monitor, some potential ideas I have are:

- Adding checksum validation to detect corrupted or changed files
- Adding notifications (Discord/Slack/email) for failures
- Implementing retention for downloaded files

Please open issues or PRs for improvements. I am probably not going to add features myself as I am happy with the current state, but I am open to review contributions.

## License

This repository is licensed under the Unlicense, you can do whatever you want with it. See `LICENSE` for details.
