import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_LABEL = 'mcs-test-fixture';

export interface TempDir {
  readonly path: string;
  remove(): void;
}

export function makeTempDir(purpose: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), `mcs-${purpose}-`));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// @wp-begin WP-06
export { useTempDirs } from './temp.ts';
export { VITEST_PORTS, allocatePort, assertPortClosed, type PortRange } from './ports.ts';
export { eventLoopLagProbe, waitFor } from './wait.ts';
export { FIXTURE_EPOCH_MS, FakeClock } from './clock.ts';
export { killAllTracked, runCli, spawnTracked, type TrackedProcess } from './processes.ts';
export { hermeticEnv, makeJunction, spawnImpostor, startInstance, type StartedInstance } from './isolation.ts';
export { httpRequest, readSse } from './http.ts';
export { CANARY, scanForCanaries } from './canary.ts';
export { TranscriptBuilder, bigTranscript, type UsageFixture } from './transcript.ts';
export { buildClaudeHome, type ClaudeHome, type SessionSpec } from './claude-home.ts';
export { hookPayload, runHookHandler, type HookEventName, type RunHookOptions } from './hooks.ts';
export { buildRepo, buildTaskWorkspace, snapshotTree } from './workspace.ts';
export { buildDemo, type DemoLetter, type DemoOptions, type DemoResult, type DemoSession } from './demo.ts';
export { FILE_HOLDER_SKIP_REASON, holdFileOpen, type FileHolder } from './file-holder.ts';
// @wp-end WP-06

// @wp-begin WP-42
// @wp-end WP-42

// @wp-begin WP-55
// @wp-end WP-55
