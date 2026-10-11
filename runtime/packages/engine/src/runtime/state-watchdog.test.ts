// The state.json watchdog (01 4.6, T-LC-07 at unit level): restore ours when the file is gone, unreadable or names a dead
// process; never touch a file that names another live process, and say so in the ownership flag.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogFields, LogLevel, Logger } from '../log/logger.ts';
import { createErrorRing, type ErrorRing } from './error-ring.ts';
import { createStateWatchdog, type StateWatchdog, type WatchdogContext } from './state-watchdog.ts';

const makeTemp = useTempDirs();
const OWN_PID = 4_000_001; // not a live process: the context says this is "us"
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.useRealTimers();
});

interface LoggedCall {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
}

function fakeLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const record =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      calls.push({ level, event, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  return { logger, calls };
}

/** A pid that certainly belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (child.pid === 0) throw new Error('could not start a child to learn a dead pid');
  return child.pid;
}

function stateText(pid: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    pid,
    url: 'http://127.0.0.1:18999',
    port: 18999,
    started: 1_700_000_000.5,
    version: '3.0.0',
    task: 'demo',
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId: INSTANCE_ID,
    runtimeVersion: '3.0.0',
    codeStamp: 'abcdef0123',
    startedAt: '2026-01-01T00:00:00.000Z',
    nodeVersion: 'v24.0.0',
    control: 'pipe',
    ...extra,
  })}\n`;
}

/** The seven keys a legacy viewer writes (01 1.7). */
function legacyState(pid: number): string {
  const body = {
    pid,
    url: 'http://127.0.0.1:8765',
    port: 8765,
    started: 1.5,
    version: '2.0.2',
    task: 'demo',
    config: null,
  };
  return `${JSON.stringify(body)}\n`;
}

interface Setup {
  readonly dir: string;
  readonly file: string;
  readonly ours: Buffer;
  readonly calls: LoggedCall[];
  readonly errors: ErrorRing;
  readonly watchdog: StateWatchdog;
  readonly bytesCalls: () => number;
}

function setup(o: { bytes?: Buffer | null; intervalMs?: number } = {}): Setup {
  const dir = makeTemp('watchdog').path;
  const file = path.join(dir, 'state.json');
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const errors = createErrorRing(clock);
  const { logger, calls } = fakeLogger();
  const ours = Buffer.from(stateText(OWN_PID));
  const bytes = o.bytes === undefined ? ours : o.bytes;
  let count = 0;
  const ctx: WatchdogContext = {
    instanceDir: dir,
    logger,
    errors,
    process: { pid: OWN_PID },
    config: { runtime: { process: { stateWatchdogMs: o.intervalMs ?? 15_000 } } },
  };
  const watchdog = createStateWatchdog(ctx, {
    stateFileBytes: () => {
      count += 1;
      return bytes;
    },
  });
  return { dir, file, ours, calls, errors, watchdog, bytesCalls: () => count };
}

function events(calls: readonly LoggedCall[], event: string): LoggedCall[] {
  return calls.filter((call) => call.event === event);
}

describe('createStateWatchdog: one tick', () => {
  it('is named state-watchdog and starts without a conflict', () => {
    const { watchdog } = setup();
    expect(watchdog.name).toBe('state-watchdog');
    expect(watchdog.ownershipConflict()).toBe(false);
  });

  it('does nothing when the runtime has no state file of its own', async () => {
    const { watchdog, file, calls } = setup({ bytes: null });
    await watchdog.tickNow();
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
    expect(watchdog.ownershipConflict()).toBe(false);
  });

  it('restores our bytes when the file is gone and logs state_file_restored', async () => {
    const { watchdog, file, ours, calls } = setup();
    await watchdog.tickNow();
    expect(readFileSync(file)).toEqual(ours);
    const restored = events(calls, 'state_file_restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.fields).toMatchObject({ status: 'absent' });
    expect(watchdog.ownershipConflict()).toBe(false);
  });

  it('restores our bytes when the file cannot be parsed or breaks the schema', async () => {
    const { watchdog, file, ours, calls } = setup();
    writeFileSync(file, '{ not json');
    await watchdog.tickNow();
    expect(readFileSync(file)).toEqual(ours);
    writeFileSync(file, `${JSON.stringify({ pid: 'abc' })}\n`);
    await watchdog.tickNow();
    expect(readFileSync(file)).toEqual(ours);
    expect(events(calls, 'state_file_restored').map((call) => call.fields['status'])).toEqual([
      'unparsable',
      'unparsable',
    ]);
  });

  it('restores our bytes when the file names a process that is dead', async () => {
    const { watchdog, file, ours, calls } = setup();
    writeFileSync(file, legacyState(deadPid()));
    await watchdog.tickNow();
    expect(readFileSync(file)).toEqual(ours);
    expect(events(calls, 'state_file_restored')[0]?.fields).toMatchObject({ status: 'dead_pid' });
    expect(watchdog.ownershipConflict()).toBe(false);
  });

  it('leaves a file alone that names another live process and raises the ownership flag once', async () => {
    const { watchdog, file, calls } = setup();
    const foreign = stateText(process.pid, { instanceId: INSTANCE_ID });
    writeFileSync(file, foreign);
    await watchdog.tickNow();
    await watchdog.tickNow();
    expect(readFileSync(file, 'utf8')).toBe(foreign);
    expect(watchdog.ownershipConflict()).toBe(true);
    const conflicts = events(calls, 'ownership_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.fields).toMatchObject({ pid: process.pid });
    expect(events(calls, 'state_file_restored')).toEqual([]);
  });

  it('treats a legacy-format file of a live process the same way', async () => {
    const { watchdog, file } = setup();
    writeFileSync(file, legacyState(process.pid));
    await watchdog.tickNow();
    expect(readFileSync(file, 'utf8')).toBe(legacyState(process.pid));
    expect(watchdog.ownershipConflict()).toBe(true);
  });

  it('drops the flag and restores ours once the other process is gone', async () => {
    const { watchdog, file, ours } = setup();
    writeFileSync(file, legacyState(process.pid));
    await watchdog.tickNow();
    expect(watchdog.ownershipConflict()).toBe(true);
    writeFileSync(file, legacyState(deadPid()));
    await watchdog.tickNow();
    expect(watchdog.ownershipConflict()).toBe(false);
    expect(readFileSync(file)).toEqual(ours);
  });

  it('does not rewrite a file that already holds our bytes, or one that names our own pid', async () => {
    const { watchdog, file, ours, calls } = setup();
    writeFileSync(file, ours);
    await watchdog.tickNow();
    const changedPort = stateText(OWN_PID, { port: 18998, url: 'http://127.0.0.1:18998' });
    writeFileSync(file, changedPort);
    await watchdog.tickNow();
    expect(readFileSync(file, 'utf8')).toBe(changedPort);
    expect(calls).toEqual([]);
    expect(watchdog.ownershipConflict()).toBe(false);
  });

  it('skips the tick when the file cannot be read for another reason than being absent', async () => {
    const { watchdog, file, calls } = setup();
    mkdirSync(file); // a folder where the file should be: reading it fails, but not with "missing"
    await expect(watchdog.tickNow()).resolves.toBeUndefined();
    expect(existsSync(file)).toBe(true);
    expect(events(calls, 'state_file_restored')).toEqual([]);
  });

  it('never throws out of a tick: a failure is logged, kept in the error ring and the next tick still runs', async () => {
    const dir = makeTemp('watchdog-fail').path;
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const errors = createErrorRing(clock);
    const { logger, calls } = fakeLogger();
    let fail = true;
    const watchdog = createStateWatchdog(
      {
        instanceDir: dir,
        logger,
        errors,
        process: { pid: OWN_PID },
        config: { runtime: { process: { stateWatchdogMs: 15_000 } } },
      },
      {
        stateFileBytes: () => {
          if (fail) throw new Error('state bytes unavailable');
          return Buffer.from(stateText(OWN_PID));
        },
      },
    );
    await expect(watchdog.tickNow()).resolves.toBeUndefined();
    expect(events(calls, 'state_watchdog_failed')).toHaveLength(1);
    expect(errors.list()[0]).toMatchObject({ source: 'runtime', code: 'STATE_WATCHDOG_FAILED' });
    fail = false;
    await watchdog.tickNow();
    expect(existsSync(path.join(dir, 'state.json'))).toBe(true);
  });
});

describe('createStateWatchdog: the timer', () => {
  it('ticks every stateWatchdogMs after start and never after stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watchdog, bytesCalls } = setup({ bytes: null, intervalMs: 15_000 });
    await watchdog.start();
    expect(bytesCalls()).toBe(0); // the file was written just before start: the first look is one interval later
    await vi.advanceTimersByTimeAsync(14_999);
    expect(bytesCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bytesCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bytesCalls()).toBe(2);
    await watchdog.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bytesCalls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start is idempotent and stop before start is harmless', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watchdog, bytesCalls } = setup({ bytes: null, intervalMs: 1000 });
    await watchdog.stop();
    await watchdog.start();
    await watchdog.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bytesCalls()).toBe(1);
    await watchdog.stop();
  });

  it('stop waits for a tick that is running, so nothing is written after it returned', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { watchdog, file, ours } = setup({ intervalMs: 1000 });
    await watchdog.start();
    await vi.advanceTimersByTimeAsync(1000); // the tick starts and waits for the file system
    await watchdog.stop();
    expect(readFileSync(file)).toEqual(ours);
  });
});
