import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { McsError } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { hostPlatform } from './host.ts';
import {
  MutexTimeoutError,
  acquireMutex,
  computeMutexName,
  createLockFileBackend,
  createMutexApi,
  mutexName,
  socketAddress,
  tryAcquireMutex,
  type MutexBackend,
  type ProcessMutex,
} from './mutex.ts';

const makeTemp = useTempDirs();

/** A name nobody else uses, so parallel test files never collide on the OS-wide mutex namespace. */
function uniqueName(): string {
  return `mcs-test-mutex-${randomBytes(6).toString('hex')}`;
}

describe('mutexName / computeMutexName', () => {
  it('hashes a lower-cased key on win32: the table of the launcher parity test', () => {
    const table: [kind: 'task' | 'bootstrap' | 'settings', key: string, expected: string][] = [
      ['task', 'D:\\work\\tasks\\nightly', 'mcs-task-0d768e8f13d6368c'],
      ['task', 'd:\\work\\tasks\\nightly', 'mcs-task-0d768e8f13d6368c'],
      ['bootstrap', 'D:\\skills\\monitoring\\runtime', 'mcs-bootstrap-7c1f9db02ad19cb9'],
      ['settings', 'C:\\Users\\Example\\.claude\\settings.json', 'mcs-settings-ea618506215108ce'],
      ['task', '/Home/User/Tasks/Nightly', 'mcs-task-28cb65c9ad75eb7d'],
      ['task', '', 'mcs-task-e3b0c44298fc1c14'],
    ];
    for (const [kind, key, expected] of table) {
      expect(computeMutexName(kind, key, 'win32')).toBe(expected);
    }
  });

  it('keeps the case of the key on every other platform', () => {
    expect(computeMutexName('task', 'D:\\work\\tasks\\nightly', 'linux')).toBe('mcs-task-4aceb57b7eb20555');
    expect(computeMutexName('task', 'd:\\work\\tasks\\nightly', 'linux')).toBe('mcs-task-0d768e8f13d6368c');
    expect(computeMutexName('bootstrap', 'D:\\skills\\monitoring\\runtime', 'darwin')).toBe(
      'mcs-bootstrap-93e554cafcc8479d',
    );
    expect(computeMutexName('settings', 'C:\\Users\\Example\\.claude\\settings.json', 'other')).toBe(
      'mcs-settings-ba36260938a14406',
    );
    expect(computeMutexName('task', '/Home/User/Tasks/Nightly', 'linux')).toBe('mcs-task-489c16f4428ffaba');
    expect(computeMutexName('task', '/home/user/tasks/nightly', 'linux')).toBe('mcs-task-28cb65c9ad75eb7d');
  });

  it('is mcs-<kind>- plus the first 16 hex digits of the SHA-256 of the UTF-8 key', () => {
    const key = 'D:\\t\u00e4sks\\\u65e5\u672c';
    const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
    expect(computeMutexName('task', key, 'linux')).toBe(`mcs-task-${digest}`);
    expect(computeMutexName('task', key, 'linux')).toMatch(/^mcs-task-[0-9a-f]{16}$/);
  });

  it('separates the three kinds for one key', () => {
    const names = (['task', 'bootstrap', 'settings'] as const).map((kind) => computeMutexName(kind, 'same', 'linux'));
    expect(new Set(names).size).toBe(3);
  });

  it('mutexName follows the host platform', () => {
    const key = 'D:\\Mixed\\Case';
    expect(mutexName('task', key)).toBe(computeMutexName('task', key, hostPlatform));
  });
});

describe('socketAddress', () => {
  it('is the named pipe on win32, the abstract socket on linux, and none elsewhere', () => {
    expect(socketAddress('win32', 'mcs-task-abc')).toBe('\\\\.\\pipe\\mcs-task-abc');
    expect(socketAddress('linux', 'mcs-task-abc')).toBe('\u0000mcs-task-abc');
    expect(socketAddress('darwin', 'mcs-task-abc')).toBeNull();
    expect(socketAddress('other', 'mcs-task-abc')).toBeNull();
  });
});

describe('tryAcquireMutex / release (OS primitive of this host)', () => {
  it('grants the mutex once, refuses a second holder, and grants again after release', async () => {
    const name = uniqueName();
    const first = await tryAcquireMutex(name);
    expect(first).not.toBeNull();
    expect(first?.name).toBe(name);
    expect(await tryAcquireMutex(name)).toBeNull();
    await first?.release();
    const again = await tryAcquireMutex(name);
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('release is idempotent', async () => {
    const mutex = await tryAcquireMutex(uniqueName());
    await mutex?.release();
    await expect(mutex?.release()).resolves.toBeUndefined();
  });

  it('keeps different names independent', async () => {
    const a = await tryAcquireMutex(uniqueName());
    const b = await tryAcquireMutex(uniqueName());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a?.release();
    await b?.release();
  });
});

describe('acquireMutex (real primitive)', () => {
  it('waits for the holder, reports the wait, and then acquires', async () => {
    const name = uniqueName();
    const holder = await tryAcquireMutex(name);
    const waits: number[] = [];
    setTimeoutRelease(holder, 200);
    const started = performance.now();
    const mutex = await acquireMutex(name, { timeoutMs: 5000, onWait: (ms) => waits.push(ms) });
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.length).toBeLessThanOrEqual(10);
    expect([...waits].sort((a, b) => a - b)).toEqual(waits);
    await mutex.release();
  });

  it('acquires at once when free and never calls onWait', async () => {
    let called = false;
    const mutex = await acquireMutex(uniqueName(), {
      timeoutMs: 1000,
      onWait: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    await mutex.release();
  });

  it('throws a MutexTimeoutError (an McsError) after the timeout, naming the mutex', async () => {
    const name = uniqueName();
    const holder = await tryAcquireMutex(name);
    const error = await acquireMutex(name, { timeoutMs: 200 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MutexTimeoutError);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'INTERNAL', details: { reason: 'MUTEX_TIMEOUT', name } });
    const waited = (error as MutexTimeoutError).details?.['waitedMs'];
    expect(typeof waited === 'number' && waited >= 200).toBe(true);
    await holder?.release();
  });
});

function setTimeoutRelease(mutex: ProcessMutex | null, ms: number): void {
  void delay(ms).then(() => mutex?.release());
}

describe('mutex names become pipe or file names, so only plain names are accepted', () => {
  const bad = ['', '.', '..', '../x', '..\\x', 'a/b', 'a\\b', 'a b', '.hidden', 'x'.repeat(129), 'nul\u0000', 'café'];

  it('tryAcquireMutex and acquireMutex reject them with a RangeError', async () => {
    for (const name of bad) {
      await expect(tryAcquireMutex(name)).rejects.toBeInstanceOf(RangeError);
      await expect(acquireMutex(name, { timeoutMs: 10 })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('the lock file backend never leaves its folder', async () => {
    const dir = path.join(makeTemp('mutex').path, 'locks');
    const backend = createLockFileBackend({ dir, pidAlive: () => true });
    for (const name of bad) await expect(backend.tryAcquire(name)).rejects.toBeInstanceOf(RangeError);
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts the names mutexName produces and 128 plain characters', async () => {
    const dir = makeTemp('mutex').path;
    const backend = createLockFileBackend({ dir, pidAlive: () => true });
    for (const name of [
      mutexName('task', 'x'),
      mutexName('bootstrap', 'y'),
      mutexName('settings', 'z'),
      'a'.repeat(128),
    ]) {
      const mutex = await backend.tryAcquire(name);
      expect(mutex).not.toBeNull();
      await mutex?.release();
    }
  });
});

describe('createMutexApi with a scripted backend', () => {
  function scripted(grantOn: number): { backend: MutexBackend; attempts: () => number } {
    let attempts = 0;
    const backend: MutexBackend = {
      tryAcquire: (name) => {
        attempts += 1;
        return Promise.resolve(attempts >= grantOn ? { name, release: () => Promise.resolve() } : null);
      },
    };
    return { backend, attempts: () => attempts };
  }

  function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let t = 1000;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
      sleeps,
    };
  }

  it('polls every 25 to 50 ms and reports the time waited so far', async () => {
    const { backend, attempts } = scripted(6);
    const c = clock();
    const api = createMutexApi(backend, { now: c.now, sleep: c.sleep, random: () => 0.5 });
    const waits: number[] = [];
    const mutex = await api.acquireMutex('mcs-x', { timeoutMs: 10_000, onWait: (ms) => waits.push(ms) });
    expect(mutex.name).toBe('mcs-x');
    expect(attempts()).toBe(6);
    expect(c.sleeps).toHaveLength(5);
    expect(c.sleeps.every((ms) => ms >= 25 && ms <= 50)).toBe(true);
    expect(waits).toHaveLength(5);
    expect(waits[0]).toBe(0);
    expect(waits.at(-1)).toBe(c.sleeps.slice(0, 4).reduce((sum, ms) => sum + ms, 0));
  });

  it('covers the whole 25-50 ms jitter range', async () => {
    for (const [random, expected] of [
      [0, 25],
      [0.999999, 49.999975],
    ] as const) {
      const { backend } = scripted(2);
      const c = clock();
      const api = createMutexApi(backend, { now: c.now, sleep: c.sleep, random: () => random });
      await api.acquireMutex('mcs-x', { timeoutMs: 10_000 });
      expect(c.sleeps[0]).toBeCloseTo(expected, 4);
    }
  });

  it('gives up with a MutexTimeoutError once the timeout has passed, never sleeping past it', async () => {
    const { backend } = scripted(Number.MAX_SAFE_INTEGER);
    const c = clock();
    const api = createMutexApi(backend, { now: c.now, sleep: c.sleep, random: () => 0.5 });
    const error = await api.acquireMutex('mcs-x', { timeoutMs: 200 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MutexTimeoutError);
    expect(c.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(200);
    expect((error as MutexTimeoutError).details?.['waitedMs']).toBe(200);
  });

  it('tries exactly once with a zero timeout', async () => {
    const { backend, attempts } = scripted(Number.MAX_SAFE_INTEGER);
    const c = clock();
    const api = createMutexApi(backend, { now: c.now, sleep: c.sleep, random: () => 0.5 });
    await expect(api.acquireMutex('mcs-x', { timeoutMs: 0 })).rejects.toBeInstanceOf(MutexTimeoutError);
    expect(attempts()).toBe(1);
    expect(c.sleeps).toEqual([]);
  });

  it('survives an onWait that throws', async () => {
    const { backend } = scripted(3);
    const c = clock();
    const api = createMutexApi(backend, { now: c.now, sleep: c.sleep, random: () => 0.5 });
    const mutex = await api.acquireMutex('mcs-x', {
      timeoutMs: 10_000,
      onWait: () => {
        throw new Error('progress printer failed');
      },
    });
    expect(mutex.name).toBe('mcs-x');
  });
});

describe('lock file backend (macOS and unknown platforms; UNVERIFIED on a real macOS)', () => {
  function backendIn(dir: string, alive: (pid: number) => boolean = () => true) {
    return createLockFileBackend({ dir, pidAlive: alive, pid: 4242, now: () => Date.now() });
  }

  it('creates <dir>/<name>.lock holding pid, nonce and creation time, and removes it on release', async () => {
    const dir = path.join(makeTemp('mutex').path, 'locks', 'mutex');
    const backend = backendIn(dir);
    const mutex = await backend.tryAcquire('mcs-task-aa');
    expect(mutex?.name).toBe('mcs-task-aa');
    const file = path.join(dir, 'mcs-task-aa.lock');
    const content = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; nonce: string; createdAt: number };
    expect(content.pid).toBe(4242);
    expect(content.nonce).toMatch(/^[0-9a-f]{16,}$/);
    expect(typeof content.createdAt).toBe('number');
    await mutex?.release();
    expect(existsSync(file)).toBe(false);
    await expect(mutex?.release()).resolves.toBeUndefined();
  });

  it('refuses a second holder while the owner pid is alive', async () => {
    const dir = makeTemp('mutex').path;
    const backend = backendIn(dir);
    const first = await backend.tryAcquire('mcs-task-bb');
    expect(await backend.tryAcquire('mcs-task-bb')).toBeNull();
    await first?.release();
    expect(await backend.tryAcquire('mcs-task-bb')).not.toBeNull();
  });

  it('takes over a lock whose owner is dead: stale file renamed away, new lock created', async () => {
    const dir = makeTemp('mutex').path;
    writeFileSync(
      path.join(dir, 'mcs-task-cc.lock'),
      JSON.stringify({ pid: 99, nonce: 'deadbeefdeadbeef', createdAt: 1 }),
    );
    const backend = backendIn(dir, (pid) => pid !== 99);
    const mutex = await backend.tryAcquire('mcs-task-cc');
    expect(mutex).not.toBeNull();
    const content: unknown = JSON.parse(readFileSync(path.join(dir, 'mcs-task-cc.lock'), 'utf8'));
    expect(content).toMatchObject({ pid: 4242 });
    expect(readdirSync(dir).filter((file) => file.includes('.stale-'))).toEqual([]);
  });

  it('does not take over a lock of a live owner', async () => {
    const dir = makeTemp('mutex').path;
    writeFileSync(
      path.join(dir, 'mcs-task-dd.lock'),
      JSON.stringify({ pid: 99, nonce: 'aaaaaaaaaaaaaaaa', createdAt: 1 }),
    );
    const backend = backendIn(dir, () => true);
    expect(await backend.tryAcquire('mcs-task-dd')).toBeNull();
    expect(JSON.parse(readFileSync(path.join(dir, 'mcs-task-dd.lock'), 'utf8'))).toMatchObject({ pid: 99 });
  });

  it('release never deletes a lock that another process took over (nonce check)', async () => {
    const dir = makeTemp('mutex').path;
    const backend = backendIn(dir);
    const mutex = await backend.tryAcquire('mcs-task-ee');
    const file = path.join(dir, 'mcs-task-ee.lock');
    writeFileSync(file, JSON.stringify({ pid: 7, nonce: 'ffffffffffffffff', createdAt: 2 }));
    await mutex?.release();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: 7, nonce: 'ffffffffffffffff' });
  });

  it('treats a fresh unreadable lock file as held (its creator may still be writing it)', async () => {
    const dir = makeTemp('mutex').path;
    writeFileSync(path.join(dir, 'mcs-task-ff.lock'), '');
    const backend = backendIn(dir, () => false);
    expect(await backend.tryAcquire('mcs-task-ff')).toBeNull();
  });

  it('treats an old unreadable lock file as stale', async () => {
    const dir = makeTemp('mutex').path;
    const file = path.join(dir, 'mcs-task-gg.lock');
    writeFileSync(file, '{not json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const backend = backendIn(dir, () => true);
    expect(await backend.tryAcquire('mcs-task-gg')).not.toBeNull();
  });

  it('creates the lock folder when it is missing', async () => {
    const dir = path.join(makeTemp('mutex').path, 'a', 'b');
    mkdirSync(path.dirname(dir), { recursive: true });
    const backend = backendIn(dir);
    expect(await backend.tryAcquire('mcs-task-hh')).not.toBeNull();
    expect(existsSync(path.join(dir, 'mcs-task-hh.lock'))).toBe(true);
  });
});
