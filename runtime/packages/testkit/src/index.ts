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
// @wp-end WP-06

// @wp-begin WP-42
// @wp-end WP-42

// @wp-begin WP-55
// @wp-end WP-55
