// Live helpers of the walking-skeleton instance (LF-7): they change a RUNNING instance from another process (the Playwright
// worker), the way a Claude Code session would, by writing FIXTURE transcript files below its watched folder, and they stop
// the instance while a page is open. The expected values are computed by the same naive calculation as the start-up fixture
// (`expectedOf` reads the files back from disk). Nothing here starts a process of its own except the CLI `stop`.
import { join } from 'node:path';

import { TranscriptBuilder, runCli } from '@mcs/testkit';

import {
  FIXTURE_PROJECT,
  FIXTURE_SESSION_A,
  FIXTURE_SESSION_C,
  LABEL_A,
  LABEL_C,
  expectedOf,
  type ExpectedSession,
  type SkeletonPaths,
} from './skeleton-instance.ts';

const USAGE_C = {
  input_tokens: 31,
  output_tokens: 77,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 400,
};
const USAGE_A_LIVE = {
  input_tokens: 13,
  output_tokens: 222,
  cache_read_input_tokens: 1300,
  cache_creation_input_tokens: 60,
};

function cwdOf(paths: SkeletonPaths): string {
  return join(paths.claudeDir, 'FIXTURE-cwd', FIXTURE_PROJECT);
}

/**
 * Adds a NEW session ("Skeleton gamma", one finished turn, written now) to the watched folder. The instance has a label rule
 * for it. Returns what the pages must show once it is imported.
 */
export function addFixtureSession(paths: SkeletonPaths, nowMs: number = Date.now()): ExpectedSession {
  const builder = new TranscriptBuilder({ sessionId: FIXTURE_SESSION_C, cwd: cwdOf(paths), startMs: nowMs - 5_000 });
  builder.user('FIXTURE gamma: add a live session');
  builder.assistant({ messageId: 'msg_fixture_gamma_1', usage: USAGE_C, stop: null });
  builder.turnEnd();
  builder.write(join(paths.projectDir, `${FIXTURE_SESSION_C}.jsonl`));
  return expectedOf(paths.projectDir, FIXTURE_SESSION_C, LABEL_C, 'turn_ended', 0);
}

/**
 * Appends one more finished turn to the EXISTING session alpha, so its token totals grow while it stays "Turn ended". Returns
 * the new expected values of alpha (computed from the files on disk).
 */
export function appendFixtureTurn(paths: SkeletonPaths, nowMs: number = Date.now()): ExpectedSession {
  const builder = new TranscriptBuilder({
    sessionId: FIXTURE_SESSION_A,
    cwd: cwdOf(paths),
    startMs: nowMs - 5_000,
    uuidSeed: 'fixture-alpha-live-turn',
  });
  builder.user('FIXTURE alpha: one more question');
  builder.assistant({ messageId: 'msg_fixture_alpha_live', usage: USAGE_A_LIVE, stop: null });
  builder.turnEnd();
  builder.appendTo(join(paths.projectDir, `${FIXTURE_SESSION_A}.jsonl`), 0);
  return expectedOf(paths.projectDir, FIXTURE_SESSION_A, LABEL_A, 'turn_ended', 0);
}

/** Stops the instance through the real CLI (the page keeps running); the harness `stop()` then only cleans up. */
export async function haltSkeletonInstance(paths: SkeletonPaths): Promise<void> {
  const result = await runCli(['stop', '--task', paths.slug, '--repo', paths.repoDir], {
    mcsHome: paths.mcsHome,
    env: { CLAUDE_CONFIG_DIR: paths.claudeDir },
  });
  if (result.code !== 0) {
    const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 600);
    throw new Error(`stopping the skeleton instance failed, exit ${String(result.code)}: ${text}`);
  }
}
