// E10 as a test (01 S4): contention between real processes, release by death, and a holder that never releases.
// The contenders import the built `dist/platform/mutex.js`, so the integration gate builds the runtime first.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { killAllTracked, spawnTracked, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireMutex, tryAcquireMutex } from '../../src/platform/mutex.ts';
import { forceKill, pidAlive, waitForExit } from '../../src/platform/process.ts';

const runtimeDir = fileURLToPath(new URL('../../../../', import.meta.url));
const distMutex = path.join(runtimeDir, 'packages', 'engine', 'dist', 'platform', 'mutex.js');
const makeTemp = useTempDirs();

afterEach(async () => {
  await killAllTracked();
});

function uniqueName(): string {
  return `mcs-int-mutex-${randomBytes(6).toString('hex')}`;
}

function builtModuleUrl(): string {
  if (!existsSync(distMutex)) throw new Error(`${distMutex} is missing: run the integration gate (it builds first)`);
  return pathToFileURL(distMutex).href;
}

const CONTENDER = `
import { appendFileSync } from 'node:fs';
const [, , moduleUrl, name, logFile, holdMs] = process.argv;
const { acquireMutex } = await import(moduleUrl);
const mutex = await acquireMutex(name, { timeoutMs: 60000 });
appendFileSync(logFile, 'enter ' + process.pid + '\\n');
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
appendFileSync(logFile, 'leave ' + process.pid + '\\n');
await mutex.release();
`;

const HOLDER = `
import { writeFileSync } from 'node:fs';
const [, , moduleUrl, name, readyFile, mode] = process.argv;
const { acquireMutex } = await import(moduleUrl);
await acquireMutex(name, { timeoutMs: 10000 });
writeFileSync(readyFile, String(process.pid));
if (mode === 'idle') setInterval(() => undefined, 1000);
`;

function script(dir: string, name: string, source: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  return file;
}

describe('mutex between processes (E10)', () => {
  it('five contenders never hold the mutex together: enter and leave strictly alternate', async () => {
    const dir = makeTemp('mutex-int').path;
    const contender = script(dir, 'contender.mjs', CONTENDER);
    const log = path.join(dir, 'events.log');
    writeFileSync(log, '');
    const name = uniqueName();
    const url = builtModuleUrl();
    const children = Array.from({ length: 5 }, () =>
      spawnTracked(process.execPath, [contender, url, name, log, '150']),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0]);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    let holder: string | null = null;
    let peak = 0;
    let live = 0;
    for (const line of lines) {
      const [event, pid] = line.split(' ');
      if (event === 'enter') {
        live += 1;
        peak = Math.max(peak, live);
        expect(holder).toBeNull();
        holder = pid ?? null;
      } else {
        live -= 1;
        expect(holder).toBe(pid);
        holder = null;
      }
    }
    expect(peak).toBe(1);
    expect(new Set(lines.map((line) => line.split(' ')[1])).size).toBe(5);
  }, 120_000);

  it('this process cannot take a mutex another process holds, and gets it back the moment the holder is killed', async () => {
    const dir = makeTemp('mutex-int').path;
    const holder = script(dir, 'holder.mjs', HOLDER);
    const ready = path.join(dir, 'ready.txt');
    const name = uniqueName();
    const child = spawnTracked(process.execPath, [holder, builtModuleUrl(), name, ready, 'idle']);
    await waitFor(() => existsSync(ready) && readFileSync(ready, 'utf8') !== '', {
      timeoutMs: 20_000,
      what: 'the holder',
    });

    expect(await tryAcquireMutex(name)).toBeNull();
    const refused = await acquireMutex(name, { timeoutMs: 300 }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'INTERNAL' });

    await forceKill(child.pid);
    const started = performance.now();
    const mutex = await acquireMutex(name, { timeoutMs: 5000 });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(mutex.name).toBe(name);
    await mutex.release();
    expect(await waitForExit(child.pid, 5000)).toBe(true);
  }, 60_000);

  it('a process that never releases still exits on its own, and the OS frees the mutex', async () => {
    const dir = makeTemp('mutex-int').path;
    const holder = script(dir, 'holder.mjs', HOLDER);
    const ready = path.join(dir, 'ready.txt');
    const name = uniqueName();
    const child = spawnTracked(process.execPath, [holder, builtModuleUrl(), name, ready, 'exit']);
    const code = await child.exited;
    expect(code).toBe(0);
    expect(pidAlive(child.pid)).toBe(false);
    const mutex = await acquireMutex(name, { timeoutMs: 5000 });
    await mutex.release();
  }, 60_000);

  it('serialises writers: a second acquire waits for the release and then proceeds', async () => {
    const name = uniqueName();
    const first = await acquireMutex(name, { timeoutMs: 1000 });
    const order: string[] = [];
    const second = acquireMutex(name, { timeoutMs: 10_000 }).then(async (mutex) => {
      order.push('second acquired');
      await mutex.release();
    });
    await delay(300);
    expect(order).toEqual([]);
    order.push('first releasing');
    await first.release();
    await second;
    expect(order).toEqual(['first releasing', 'second acquired']);
  });
});
