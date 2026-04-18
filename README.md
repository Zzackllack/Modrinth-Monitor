# Modrinth Monitor

Lightweight Playwright-based monitor that verifies a Modrinth modpack download page by performing a real browser download and basic integrity checks.

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
- `MIN_DELAY_HOURS` / `MAX_DELAY_HOURS`: numeric bounds for randomized scheduler delay (defaults to ~3–4 hours)
- `LOG_LEVEL`: `info`|`debug`|`error` (optional)

When running via Docker Compose you can set these in the compose file or via an `.env` file.

## Behavior and Architecture

- The scheduler (`src/scheduler.js`) runs a Playwright test periodically at a randomized interval.
- Playwright performs a browser-based download and saves the file into `DOWNLOAD_DIR`.
- After download the agent verifies the file exists and is larger than 0 bytes.
- The project is intentionally low-frequency to avoid heavy scraping and to respect site usage policies.

## Tests

The Playwright test in `tests/modrinth-download.spec.ts` is the primary verification harness. Run it with `pnpm exec playwright test`.

## Docker & VPN (optional)

The repository includes a `docker-compose.yml` and `Dockerfile` to run the monitor inside a container. The intended pattern is to run the monitor container attached to a VPN container (for example Gluetun) so all outbound traffic is routed through the VPN.

## Contributing

If you want to extend or harden the monitor, some potential ideas I have are:

- Adding checksum validation to detect corrupted or changed files
- Adding notifications (Discord/Slack/email) for failures
- Implementing retention for downloaded files

Please open issues or PRs for improvements. I am probably not going to add features myself as I am happy with the current state, but I am open to review contributions.

## License

This repository does not include a license file. Add a license if you intend to publish or share widely.
