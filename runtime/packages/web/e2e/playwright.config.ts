// Playwright configuration of the walking-skeleton smoke (LF-2). The installed Chrome is used (no browser download), one
// worker, no retries, and no `webServer` block: the global setup starts the instance itself, on a port the testkit allocates.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  preserveOutput: 'failures-only',
  use: {
    channel: 'chrome',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
