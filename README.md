# Modrinth Monitor

A simple Modrinth monitor that checks the given modpack by downloading it and checking the file.

## Commands

For development:

```bash
pnpm exec playwright test --ui # Open the Playwright test runner UI
pnpm exec playwright test # Run the tests in headless mode
```

For production:

```bash
docker compose up --build -d
```
