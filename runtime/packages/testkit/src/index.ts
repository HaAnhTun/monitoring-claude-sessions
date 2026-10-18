import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
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

export type PortRange = readonly [min: number, max: number];

/** Real-process Vitest tests (4.5). The block-per-worker rule of 4.4 replaces the spread below in slice S2. */
export const VITEST_PORTS: PortRange = [18000, 18499];

/** Picks a free loopback port inside `range` (default VITEST_PORTS; Playwright passes [18500, 18599]). */
export async function allocatePort(range: PortRange = VITEST_PORTS): Promise<number> {
  const [min, max] = range;
  const span = max - min + 1;
  const start = min + ((process.pid * 7919 + Number(process.env['VITEST_POOL_ID'] ?? 0) * 101) % span);
  for (let i = 0; i < span; i += 1) {
    const port = min + ((start - min + i) % span);
    if (await isFree(port)) {
      return port;
    }
  }
  throw new Error(`no free port in ${String(min)}-${String(max)}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

// @wp-begin WP-06
export { useTempDirs } from './temp.ts';
export { assertPortClosed } from './ports.ts';
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
