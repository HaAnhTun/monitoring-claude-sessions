// Playwright configuration of the terminal browser tests (design 08 section 3.8): a real app instance per spec file (`fixture.ts`),
// the fake claude behind a real pseudo console, the installed Chrome with a fresh profile (no browser download; `MCS_PW_CHANNEL`
// picks another channel, an empty value the bundled Chromium). One worker, no retries, no `webServer` block and no global setup:
// the worker fixture starts and stops the instance. Windows only (terminals are Windows-only in this release); run it through
// `npm run test:e2e:terminal` inside the `run` lock, after `npm run build`.
//
// Nothing Playwright writes may hold what a terminal showed or a login link: traces, screenshots and videos are off, and the
// output folder is in the temp folder of the system, never inside the repository.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/** The ports of the Playwright suites (plan section 3.2): the instances and the second origin of this suite listen only here. */
export const TERMINAL_E2E_PORTS: readonly [number, number] = [18500, 18599];

const channel = process.env['MCS_PW_CHANNEL'] ?? 'chrome';

export default defineConfig({
  testDir: '.',
  testMatch: 'specs/**/*.spec.ts',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: join(tmpdir(), 'mcs-e2e-terminal-playwright'),
  preserveOutput: 'never',
  use: {
    ...(channel === '' ? {} : { channel }),
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
