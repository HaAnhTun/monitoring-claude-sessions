import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { allocatePort, makeTempDir, VITEST_PORTS } from './index.ts';

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
});
