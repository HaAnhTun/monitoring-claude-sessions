import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import * as ports from './ports.ts';
import * as temp from './temp.ts';
import { allocatePort, assertPortClosed, makeTempDir, VITEST_PORTS } from './index.ts';

describe('testkit scaffold', () => {
  it('creates and removes a temp dir', () => {
    const dir = makeTempDir('scaffold');
    expect(existsSync(dir.path)).toBe(true);
    dir.remove();
    expect(existsSync(dir.path)).toBe(false);
  });

  it('allocates a free port inside the requested range', async () => {
    const range = [18500, 18599] as const;
    const port = await allocatePort(range);
    expect(port).toBeGreaterThanOrEqual(range[0]);
    expect(port).toBeLessThanOrEqual(range[1]);
  });

  it('defaults to the Vitest range and skips a port that is busy', async () => {
    const [min, max] = VITEST_PORTS;
    const first = await allocatePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen({ port: first, host: '127.0.0.1', exclusive: true }, resolve);
    });
    try {
      const second = await allocatePort();
      expect(second).toBeGreaterThanOrEqual(min);
      expect(second).toBeLessThanOrEqual(max);
      expect(second).not.toBe(first);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });

  it('exports the real port and temp helpers, not stubs of its own', () => {
    expect(allocatePort).toBe(ports.allocatePort);
    expect(makeTempDir).toBe(temp.makeTempDir);
    expect(VITEST_PORTS).toBe(ports.VITEST_PORTS);
  });

  it('marks every temp folder as a fixture', () => {
    const dir = makeTempDir('scaffold');
    try {
      expect(readFileSync(join(dir.path, 'FIXTURE.md'), 'utf8')).toBe(temp.FIXTURE_MARKER_TEXT);
    } finally {
      dir.remove();
    }
  });

  it('keeps a port reserved until it is released, so two callers never share one', async () => {
    const first = await allocatePort();
    const second = await allocatePort();
    try {
      expect(second).not.toBe(first);
    } finally {
      await assertPortClosed(first);
      await assertPortClosed(second);
    }
  });
});
