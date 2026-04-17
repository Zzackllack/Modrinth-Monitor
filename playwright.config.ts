import { defineConfig } from '@playwright/test';
import path from 'path';

const projectName = 'modrinth-monitor';
const downloadsPath =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');

export default defineConfig({
  testDir: './tests',
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
        launchOptions: {
          args: ['--disable-dev-shm-usage'],
        },
        contextOptions: {
          recordVideo: undefined,
          baseURL: process.env.MODRINTH_URL,
          downloadsPath,
        },
      },
    },
  ],
});
