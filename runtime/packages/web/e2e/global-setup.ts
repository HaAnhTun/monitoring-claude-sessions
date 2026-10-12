// Global setup and teardown of the walking-skeleton smoke (LF-2). The instance is started by the LF-5 harness (real CLI:
// init, configure, start; FIXTURE transcripts; temp MCS_HOME and CLAUDE_CONFIG_DIR; hooks disabled), and its URL and the
// expected values go to the spec through one environment variable. The returned function is the teardown: it stops the
// instance, asserts that the port is closed and that the temp tree is gone. Run it inside the `run` lock (plan section 3).
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { assertPortClosed } from '@mcs/testkit';

// eslint-disable-next-line no-restricted-imports -- the LF-5 harness is test code of @mcs/server that its exports map does not publish; LF-2 reuses it by relative path as the brief says
import { startSkeletonInstance } from '../../server/test/helpers/skeleton-instance.ts';
import { SKELETON_ENV } from './fixture-env.ts';

/** Playwright E2E ports (plan section 3.2). */
const PLAYWRIGHT_PORT_RANGE: [number, number] = [18500, 18599];

export default async function globalSetup(): Promise<() => Promise<void>> {
  const instance = await startSkeletonInstance({ portRange: PLAYWRIGHT_PORT_RANGE });
  process.env[SKELETON_ENV] = JSON.stringify({ baseUrl: instance.baseUrl, expected: instance.expected });
  // The harness keeps everything below one temp root: `<root>/repo` is the repository it created.
  const tempRoot = dirname(instance.repoDir);

  return async () => {
    Reflect.deleteProperty(process.env, SKELETON_ENV);
    await instance.stop();
    await assertPortClosed(instance.port);
    if (existsSync(tempRoot)) throw new Error(`the temp tree of the instance is still there: ${tempRoot}`);
  };
}
