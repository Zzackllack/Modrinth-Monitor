import { defineConfig } from '@playwright/test';
import path from 'path';

const projectName = 'modrinth-monitor';
const downloadsPath =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');

// Set by src/egress/egress-manager.js before each attempt. A stale value must
// never survive, so an empty server means "no proxy" rather than "inherit".
const proxyServer = (process.env.MONITOR_PROXY_SERVER || '').trim();
const proxyUsername = process.env.MONITOR_PROXY_USERNAME || '';
const proxyPassword = process.env.MONITOR_PROXY_PASSWORD || '';

const proxy = proxyServer
  ? {
      server: proxyServer,
      ...(proxyUsername
        ? { username: proxyUsername, password: proxyPassword }
        : {}),
    }
  : undefined;

export default defineConfig({
  testDir: './tests',
  globalSetup: './src/setup-visit.ts',
  timeout: 90_000,
  retries: 1,
  fullyParallel: false,
  reporter: [['list']],
  workers: 1,
  projects: [
    {
      name: projectName,
      use: {
        browserName: 'chromium',
        headless: true,
        acceptDownloads: true,
        actionTimeout: 30_000,
        navigationTimeout: 45_000,
        viewport: { width: 1280, height: 720 },
        proxy,
        launchOptions: {
          args: [
            '--disable-dev-shm-usage',
            // Loopback is bypassed by default; the local proxy check needs it
            // to prove that the tunnel works end to end.
            '--proxy-bypass-list=<-loopback>',
          ],
        },
        contextOptions: {
          baseURL: process.env.MODRINTH_URL,
          downloadsPath,
        },
      },
    },
  ],
});
