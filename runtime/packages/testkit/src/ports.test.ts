import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allocatePort, assertPortClosed, VITEST_PORTS } from './ports.ts';
import { makeTempDir } from './temp.ts';

const servers: Server[] = [];

function listenOn(port: number): Promise<void> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe('VITEST_PORTS', () => {
  it('is 18000-18499 (05 4.5)', () => {
    expect(VITEST_PORTS).toEqual([18000, 18499]);
  });
});

describe('allocatePort', () => {
  it('uses the block of 50 that belongs to VITEST_POOL_ID', async () => {
    vi.stubEnv('VITEST_POOL_ID', '3');
    const port = await allocatePort();
    expect(port).toBeGreaterThanOrEqual(18100);
    expect(port).toBeLessThanOrEqual(18149);
    await assertPortClosed(port);
  });

  it('wraps the pool id after ten blocks', async () => {
    vi.stubEnv('VITEST_POOL_ID', '11');
    const port = await allocatePort();
    expect(port).toBeGreaterThanOrEqual(18000);
    expect(port).toBeLessThanOrEqual(18049);
    await assertPortClosed(port);
  });

  it('defaults to block 0 without a pool id', async () => {
    vi.stubEnv('VITEST_POOL_ID', '');
    const port = await allocatePort();
    expect(port).toBeGreaterThanOrEqual(18000);
    expect(port).toBeLessThanOrEqual(18049);
    await assertPortClosed(port);
  });

  it('never hands the same port out twice while it is reserved', async () => {
    const a = await allocatePort();
    const b = await allocatePort();
    expect(a).not.toBe(b);
    await assertPortClosed(a);
    await assertPortClosed(b);
  });

  it('keeps a Playwright range inside its bounds', async () => {
    const port = await allocatePort([18500, 18599]);
    expect(port).toBeGreaterThanOrEqual(18500);
    expect(port).toBeLessThanOrEqual(18599);
    await assertPortClosed(port);
  });

  it('scans another range from its start and skips busy ports', async () => {
    const first = await allocatePort([18500, 18599]);
    await assertPortClosed(first);
    await listenOn(first);
    const second = await allocatePort([18500, 18599]);
    expect(second).toBe(first + 1);
    await assertPortClosed(second);
  });

  it('throws when the range is full', async () => {
    const only = await allocatePort([18590, 18599]);
    await assertPortClosed(only);
    await listenOn(only);
    await expect(allocatePort([only, only])).rejects.toThrow(/no free port/);
  });

  it('frees a reservation through assertPortClosed', async () => {
    const only = await allocatePort([18598, 18598]);
    await expect(allocatePort([18598, 18598])).rejects.toThrow(/no free port/);
    await assertPortClosed(only);
    await expect(allocatePort([18598, 18598])).resolves.toBe(only);
    await assertPortClosed(only);
  });

  it('rejects ranges that are not valid port ranges', async () => {
    await expect(allocatePort([18010, 18000])).rejects.toThrow(RangeError);
    await expect(allocatePort([0, 10])).rejects.toThrow(RangeError);
    await expect(allocatePort([65000, 70000])).rejects.toThrow(RangeError);
  });

  it('never returns a port of the live monitor, the blog or the owner ranges', async () => {
    for (const forbidden of [8765, 8784, 3000, 3100, 8080, 8089]) {
      await expect(allocatePort([forbidden, forbidden])).rejects.toThrow(RangeError);
    }
    await expect(allocatePort([8700, 8800])).rejects.toThrow(RangeError);
  });
});

describe('assertPortClosed', () => {
  it('resolves for a closed port', async () => {
    const port = await allocatePort([18560, 18569]);
    await expect(assertPortClosed(port)).resolves.toBeUndefined();
  });

  it('throws and names the port when something still listens', async () => {
    const port = await allocatePort([18570, 18579]);
    await listenOn(port);
    await expect(assertPortClosed(port)).rejects.toThrow(String(port));
  });
});

describe('port blocks across four forks', () => {
  it('never overlap and stay inside the block of the pool id', async () => {
    const temp = makeTempDir('ports');
    try {
      const portsUrl = pathToFileURL(join(import.meta.dirname, 'ports.ts')).href;
      const script = join(temp.path, 'child.mjs');
      writeFileSync(
        script,
        [
          `const { allocatePort } = await import(${JSON.stringify(portsUrl)});`,
          'const out = [];',
          'for (let i = 0; i < 6; i += 1) out.push(await allocatePort());',
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n'),
      );
      const runs = [1, 2, 3, 4].map(
        (poolId) =>
          new Promise<number[]>((resolve, reject) => {
            const child = spawn(process.execPath, ['--no-warnings', script], {
              env: { ...process.env, VITEST_POOL_ID: String(poolId) },
              stdio: ['ignore', 'pipe', 'inherit'],
              windowsHide: true,
            });
            let out = '';
            child.stdout.on('data', (chunk: Buffer) => {
              out += chunk.toString('utf8');
            });
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code === 0) resolve(JSON.parse(out) as number[]);
              else reject(new Error(`child ${String(poolId)} exited with ${String(code)}`));
            });
          }),
      );
      const results = await Promise.all(runs);
      const seen = new Set<number>();
      results.forEach((ports, index) => {
        const min = 18000 + index * 50;
        expect(ports).toHaveLength(6);
        for (const port of ports) {
          expect(port).toBeGreaterThanOrEqual(min);
          expect(port).toBeLessThanOrEqual(min + 49);
          expect(seen.has(port)).toBe(false);
          seen.add(port);
        }
      });
    } finally {
      temp.remove();
    }
  });
});
