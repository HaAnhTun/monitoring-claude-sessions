// Playwright configuration of the visual QA tool (WP-122): `shots.spec.ts` captures the view matrix, `qa-selftest.spec.ts` proves the
// tool itself. The installed Chrome is used (no browser download; `MCS_PW_CHANNEL` picks another channel, an empty value the bundled
// Chromium), one worker, no retries. Everything Playwright writes goes next to the pictures, never inside the repository.
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { resolveShotsDir } from './global-setup.ts';

const channel = process.env['MCS_PW_CHANNEL'] ?? 'chrome';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  // one test shoots a whole column of the matrix: every view of one window size, theme and language
  timeout: 300_000,
  expect: { timeout: 15_000 },
  outputDir: join(resolveShotsDir(process.env['MCS_SHOTS_DIR']), '.playwright'),
  preserveOutput: 'failures-only',
  use: {
    ...(channel === '' ? {} : { channel }),
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
