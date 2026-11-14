import { readFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { killAllTracked, makeTempDir, spawnTracked, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { childStats, type ChildResult, type ChildSpec } from './exec.ts';
import type { HostPlatform } from './host.ts';
import {
  commandLineOf,
  createProcessHelpers,
  forceKill,
  forceKillTree,
  isValidPid,
  listDescendantPids,
  pidAlive,
  processStartTimes,
  waitForExit,
  type ProcessDeps,
} from './process.ts';

afterEach(async () => {
  await killAllTracked();
});

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function result(stdout: string, extra: Partial<ChildResult> = {}): ChildResult {
  return { ok: true, code: 0, stdout, stderr: '', error: null, truncated: false, durationMs: 1, ...extra };
}

interface RigState {
  specs: ChildSpec[];
  kills: { pid: number; signal: NodeJS.Signals | 0 }[];
  sleeps: number[];
  clock: { t: number };
  /** Pids reported alive by the kill(pid, 0) probe; others throw ESRCH. */
  alive: Set<number>;
  /** pid -> error thrown by kill(pid, 'SIGKILL'). */
  killErrors: Map<number, NodeJS.ErrnoException>;
  /** Result queue for exec; the last entry repeats. */
  replies: ChildResult[];
  /** Raw /proc cmdline per pid. */
  proc: Map<number, string>;
  /** Called after every sleep (lets a test make a pid die while waiting). */
  onSleep: (ms: number) => void;
}

/** The state plus the dependencies that read and write it. */
type Rig = RigState & { deps: ProcessDeps };

function rig(platform: HostPlatform = 'win32'): Rig {
  const r: RigState = {
    specs: [],
    kills: [],
    sleeps: [],
    clock: { t: 10_000 },
    alive: new Set(),
    killErrors: new Map(),
    replies: [result('')],
    proc: new Map(),
    onSleep: () => undefined,
  };
  const deps: ProcessDeps = {
    platform,
    exec: (spec) => {
      r.specs.push(spec);
      const reply = r.replies.length > 1 ? r.replies.shift() : r.replies[0];
      return Promise.resolve(reply ?? result(''));
    },
    resolve: (name) =>
      Promise.resolve(
        name === 'taskkill'
          ? 'C:\\Windows\\System32\\taskkill.exe'
          : name === 'ps'
            ? '/bin/ps'
            : 'C:\\ps\\powershell.exe',
      ),
    now: () => r.clock.t,
    sleep: (ms) => {
      r.sleeps.push(ms);
      r.clock.t += ms;
      r.onSleep(ms);
      return Promise.resolve();
    },
    kill: (pid, signal) => {
      r.kills.push({ pid, signal });
      if (signal === 0) {
        if (!r.alive.has(pid)) throw errno('ESRCH');
        return;
      }
      const failure = r.killErrors.get(pid);
      if (failure !== undefined) throw failure;
      r.alive.delete(pid);
    },
    readCmdline: (pid) => Promise.resolve(r.proc.get(pid) ?? null),
  };
  return Object.assign(r, { deps });
}

function decodedScript(spec: ChildSpec | undefined): string {
  const args = spec?.args ?? [];
  expect(args[args.length - 2]).toBe('-EncodedCommand');
  return Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');
}

describe('isValidPid', () => {
  it('accepts positive integers of at most ten digits', () => {
    for (const pid of [1, 4, 4242, 2_147_483_647, 4_294_967_295, 9_999_999_999]) expect(isValidPid(pid)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_000_000, 2 ** 53, 1e21]) {
      expect(isValidPid(pid)).toBe(false);
    }
  });
});

describe('pidAlive (scripted signal 0)', () => {
  it('is true for a pid the probe accepts, true for EPERM (alive, not ours), false for ESRCH and other errors', () => {
    const r = rig();
    const helpers = createProcessHelpers(r.deps);
    r.alive.add(100);
    expect(helpers.pidAlive(100)).toBe(true);
    expect(helpers.pidAlive(101)).toBe(false);
    r.deps = {
      ...r.deps,
      kill: () => {
        throw errno('EPERM');
      },
    };
    expect(createProcessHelpers(r.deps).pidAlive(5)).toBe(true);
    r.deps = {
      ...r.deps,
      kill: () => {
        throw errno('EINVAL');
      },
    };
    expect(createProcessHelpers(r.deps).pidAlive(5)).toBe(false);
    r.deps = {
      ...r.deps,
      kill: () => {
        throw new Error('weird');
      },
    };
    expect(createProcessHelpers(r.deps).pidAlive(5)).toBe(false);
  });

  it('never signals for an invalid pid and only ever uses signal 0', () => {
    const r = rig();
    const helpers = createProcessHelpers(r.deps);
    for (const pid of [0, -3, 1.5, Number.NaN, 2 ** 40]) expect(helpers.pidAlive(pid)).toBe(false);
    expect(r.kills).toEqual([]);
    r.alive.add(7);
    helpers.pidAlive(7);
    expect(r.kills).toEqual([{ pid: 7, signal: 0 }]);
  });
});

describe('commandLineOf (scripted)', () => {
  it('on Windows runs one constant -EncodedCommand CIM query of kind powershell.cmdline', async () => {
    const r = rig('win32');
    r.replies = [result('"C:\\node.exe" x.js\r\n')];
    const line = await createProcessHelpers(r.deps).commandLineOf(4242);
    expect(line).toBe('"C:\\node.exe" x.js');
    expect(r.specs).toHaveLength(1);
    const [spec] = r.specs;
    expect(spec).toMatchObject({
      kind: 'powershell.cmdline',
      file: 'C:\\ps\\powershell.exe',
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
      encoding: 'utf8',
    });
    expect(spec?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(decodedScript(spec)).toBe(
      "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=4242').CommandLine",
    );
  });

  it('removes exactly one trailing line break and returns null for empty output or a failed query', async () => {
    const r = rig('win32');
    const helpers = createProcessHelpers(r.deps);
    r.replies = [result('a b\r\n\r\n')];
    expect(await helpers.commandLineOf(1)).toBe('a b\r\n');
    r.replies = [result('\r\n')];
    expect(await helpers.commandLineOf(2)).toBeNull();
    r.replies = [result('')];
    expect(await helpers.commandLineOf(3)).toBeNull();
    r.replies = [result('', { ok: false, error: 'TIMEOUT', code: null })];
    expect(await helpers.commandLineOf(4)).toBeNull();
  });

  it('returns null without spawning for an invalid pid or when PowerShell cannot be resolved', async () => {
    const r = rig('win32');
    const helpers = createProcessHelpers(r.deps);
    for (const pid of [0, -1, 1.5, Number.NaN, 12345678901]) expect(await helpers.commandLineOf(pid)).toBeNull();
    expect(r.specs).toEqual([]);
    const none = createProcessHelpers({ ...r.deps, resolve: () => Promise.resolve(null) });
    expect(await none.commandLineOf(10)).toBeNull();
    expect(r.specs).toEqual([]);
  });

  it('caches a value for 5 s per pid and asks again afterwards', async () => {
    const r = rig('win32');
    r.replies = [result('one\r\n')];
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.commandLineOf(10)).toBe('one');
    r.clock.t += 4999;
    expect(await helpers.commandLineOf(10)).toBe('one');
    expect(r.specs).toHaveLength(1);
    r.clock.t += 2;
    r.replies = [result('two\r\n')];
    expect(await helpers.commandLineOf(10)).toBe('two');
    expect(r.specs).toHaveLength(2);
    expect(await helpers.commandLineOf(11)).toBe('two');
    expect(r.specs).toHaveLength(3);
  });

  it('does not cache null results', async () => {
    const r = rig('win32');
    r.replies = [result(''), result('later\r\n')];
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.commandLineOf(10)).toBeNull();
    expect(await helpers.commandLineOf(10)).toBe('later');
    expect(r.specs).toHaveLength(2);
  });

  it('keeps at most 64 pids and evicts the oldest first', async () => {
    const r = rig('win32');
    r.replies = [result('x\r\n')];
    const helpers = createProcessHelpers(r.deps);
    for (let pid = 1; pid <= 64; pid += 1) await helpers.commandLineOf(pid);
    expect(r.specs).toHaveLength(64);
    await helpers.commandLineOf(65);
    expect(r.specs).toHaveLength(65);
    await helpers.commandLineOf(2);
    expect(r.specs).toHaveLength(65);
    await helpers.commandLineOf(1);
    expect(r.specs).toHaveLength(66);
  });

  it('on Linux reads /proc/<pid>/cmdline, NUL as space, trailing space trimmed, without spawning', async () => {
    const r = rig('linux');
    r.proc.set(9, 'node\u0000/srv/a.js\u0000--x=1\u0000');
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.commandLineOf(9)).toBe('node /srv/a.js --x=1');
    expect(await helpers.commandLineOf(10)).toBeNull();
    expect(r.specs).toEqual([]);
  });

  it('on macOS runs ps -o command= -p <pid> with kind ps', async () => {
    const r = rig('darwin');
    r.replies = [result('/usr/bin/node a.js\n')];
    const line = await createProcessHelpers(r.deps).commandLineOf(77);
    expect(line).toBe('/usr/bin/node a.js');
    expect(r.specs[0]).toMatchObject({ kind: 'ps', file: '/bin/ps', args: ['-o', 'command=', '-p', '77'] });
  });
});

describe('forceKill (scripted)', () => {
  it('on Windows runs taskkill.exe /PID <pid> /F through kind taskkill (10 s, 64 KiB)', async () => {
    const r = rig('win32');
    await createProcessHelpers(r.deps).forceKill(4242);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({
      kind: 'taskkill',
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4242', '/F'],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
      encoding: 'utf8',
    });
    expect(r.kills).toEqual([]);
  });

  it('counts exit code 128 (process not found) as success', async () => {
    const r = rig('win32');
    r.replies = [
      result('', { ok: false, code: 128, error: 'NONZERO_EXIT', stderr: 'ERROR: The process "5" not found.' }),
    ];
    await expect(createProcessHelpers(r.deps).forceKill(5)).resolves.toBeUndefined();
  });

  it('rejects with an McsError STOP_FAILED for any other failure, naming only the first stderr line', async () => {
    const r = rig('win32');
    r.replies = [
      result('', { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'ERROR: Access is denied.\r\nsecond line' }),
    ];
    const error = await createProcessHelpers(r.deps)
      .forceKill(5)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'STOP_FAILED' });
    expect((error as McsError).message).toContain('Access is denied');
    expect((error as McsError).message).not.toContain('second line');

    r.replies = [result('', { ok: false, code: null, error: 'TIMEOUT' })];
    await expect(createProcessHelpers(r.deps).forceKill(5)).rejects.toMatchObject({ code: 'STOP_FAILED' });

    const none = createProcessHelpers({ ...r.deps, resolve: () => Promise.resolve(null) });
    await expect(none.forceKill(5)).rejects.toMatchObject({ code: 'STOP_FAILED' });
  });

  it('on POSIX sends SIGKILL, ignores ESRCH and reports EPERM', async () => {
    const r = rig('linux');
    r.alive.add(300);
    const helpers = createProcessHelpers(r.deps);
    await helpers.forceKill(300);
    expect(r.kills).toEqual([{ pid: 300, signal: 'SIGKILL' }]);
    r.killErrors.set(301, errno('ESRCH'));
    await expect(helpers.forceKill(301)).resolves.toBeUndefined();
    r.killErrors.set(302, errno('EPERM'));
    await expect(helpers.forceKill(302)).rejects.toMatchObject({ code: 'STOP_FAILED' });
    expect(r.specs).toEqual([]);
  });

  it('rejects an invalid pid with a RangeError and does nothing', async () => {
    const r = rig('win32');
    const helpers = createProcessHelpers(r.deps);
    for (const pid of [0, -1, 1.5, Number.NaN, 12345678901]) {
      await expect(helpers.forceKill(pid)).rejects.toBeInstanceOf(RangeError);
    }
    expect(r.specs).toEqual([]);
    expect(r.kills).toEqual([]);
  });

  it('forgets the cached command line of the killed pid', async () => {
    const r = rig('win32');
    r.replies = [result('before\r\n')];
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.commandLineOf(40)).toBe('before');
    r.replies = [result('', { code: 0 }), result('after\r\n')];
    await helpers.forceKill(40);
    expect(await helpers.commandLineOf(40)).toBe('after');
  });
});

describe('waitForExit (scripted)', () => {
  it('returns true at once for a pid that is already gone, without sleeping', async () => {
    const r = rig();
    expect(await createProcessHelpers(r.deps).waitForExit(50, 5000)).toBe(true);
    expect(r.sleeps).toEqual([]);
  });

  it('polls every 100 ms by default until the pid disappears', async () => {
    const r = rig();
    r.alive.add(50);
    let polls = 0;
    r.onSleep = () => {
      polls += 1;
      if (polls === 3) r.alive.delete(50);
    };
    expect(await createProcessHelpers(r.deps).waitForExit(50, 5000)).toBe(true);
    expect(r.sleeps).toEqual([100, 100, 100]);
  });

  it('honours pollMs and returns false when the pid is still alive at the deadline', async () => {
    const r = rig();
    r.alive.add(50);
    expect(await createProcessHelpers(r.deps).waitForExit(50, 1000, 250)).toBe(false);
    expect(r.sleeps.every((ms) => ms <= 250)).toBe(true);
    expect(r.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1000);
    expect(r.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(1000);
  });

  it('never spins: a poll interval of zero or less still sleeps at least 1 ms between checks', async () => {
    const r = rig();
    r.alive.add(50);
    expect(await createProcessHelpers(r.deps).waitForExit(50, 20, 0)).toBe(false);
    expect(r.sleeps.length).toBeGreaterThan(0);
    expect(r.sleeps.length).toBeLessThanOrEqual(20);
    expect(r.sleeps.every((ms) => ms >= 1)).toBe(true);
  });

  it('checks once when the timeout is zero', async () => {
    const r = rig();
    r.alive.add(50);
    expect(await createProcessHelpers(r.deps).waitForExit(50, 0)).toBe(false);
    expect(r.sleeps).toEqual([]);
  });
});

describe('forceKillTree (scripted)', () => {
  it('on Windows runs taskkill.exe /PID <pid> /T /F through kind taskkill (10 s, 64 KiB)', async () => {
    const r = rig('win32');
    await createProcessHelpers(r.deps).forceKillTree(4242);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({
      kind: 'taskkill',
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4242', '/T', '/F'],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
      encoding: 'utf8',
    });
    expect(r.kills).toEqual([]);
  });

  it('counts exit code 128 (process not found) as success', async () => {
    const r = rig('win32');
    r.replies = [
      result('', { ok: false, code: 128, error: 'NONZERO_EXIT', stderr: 'ERROR: The process "5" not found.' }),
    ];
    await expect(createProcessHelpers(r.deps).forceKillTree(5)).resolves.toBeUndefined();
  });

  it('rejects with an McsError STOP_FAILED for any other failure, naming only the first stderr line', async () => {
    const r = rig('win32');
    r.replies = [
      result('', { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'ERROR: Access is denied.\r\nsecond line' }),
    ];
    const error = await createProcessHelpers(r.deps)
      .forceKillTree(5)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'STOP_FAILED' });
    expect((error as McsError).message).toContain('Access is denied');
    expect((error as McsError).message).not.toContain('second line');

    r.replies = [result('', { ok: false, code: null, error: 'TIMEOUT' })];
    await expect(createProcessHelpers(r.deps).forceKillTree(5)).rejects.toMatchObject({ code: 'STOP_FAILED' });

    const none = createProcessHelpers({ ...r.deps, resolve: () => Promise.resolve(null) });
    await expect(none.forceKillTree(5)).rejects.toMatchObject({ code: 'STOP_FAILED' });
  });

  it('on POSIX sends SIGKILL to the pid, ignores ESRCH and reports EPERM', async () => {
    const r = rig('linux');
    r.alive.add(300);
    const helpers = createProcessHelpers(r.deps);
    await helpers.forceKillTree(300);
    expect(r.kills).toEqual([{ pid: 300, signal: 'SIGKILL' }]);
    r.killErrors.set(301, errno('ESRCH'));
    await expect(helpers.forceKillTree(301)).resolves.toBeUndefined();
    r.killErrors.set(302, errno('EPERM'));
    await expect(helpers.forceKillTree(302)).rejects.toMatchObject({ code: 'STOP_FAILED' });
    expect(r.specs).toEqual([]);
  });

  it('refuses an invalid pid with a RangeError and does nothing', async () => {
    const r = rig('win32');
    const helpers = createProcessHelpers(r.deps);
    for (const pid of [0, -1, 1.5, Number.NaN, 12345678901]) {
      await expect(helpers.forceKillTree(pid)).rejects.toBeInstanceOf(RangeError);
    }
    expect(r.specs).toEqual([]);
    expect(r.kills).toEqual([]);
  });

  it('forgets the cached command line of the killed pid', async () => {
    const r = rig('win32');
    r.replies = [result('before\r\n')];
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.commandLineOf(40)).toBe('before');
    r.replies = [result('', { code: 0 }), result('after\r\n')];
    await helpers.forceKillTree(40);
    expect(await helpers.commandLineOf(40)).toBe('after');
  });

  it('leaves forceKill as it was: no /T', async () => {
    const r = rig('win32');
    await createProcessHelpers(r.deps).forceKill(9);
    expect(r.specs[0]?.args).toEqual(['/PID', '9', '/F']);
  });
});

const START_SCRIPT = (pids: string): string =>
  `$ErrorActionPreference='SilentlyContinue'; Get-Process -Id ${pids} | ForEach-Object { '' + $_.Id + [char]9 + $_.StartTime.ToUniversalTime().ToString('o') }; 'MCS-START-END'`;

const TREE_SCRIPT =
  "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + [char]9 + $_.ParentProcessId }; 'MCS-TREE-END'";

describe('processStartTimes (scripted)', () => {
  it('runs one constant -EncodedCommand script of kind powershell.processes over the validated pids', async () => {
    const r = rig('win32');
    r.replies = [result('MCS-START-END\r\n')];
    await createProcessHelpers(r.deps).processStartTimes([10, 20]);
    expect(r.specs).toHaveLength(1);
    const [spec] = r.specs;
    expect(spec).toMatchObject({
      kind: 'powershell.processes',
      file: 'C:\\ps\\powershell.exe',
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
      encoding: 'utf8',
    });
    expect(spec?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(decodedScript(spec)).toBe(START_SCRIPT('10,20'));
  });

  it('maps each pid to the epoch milliseconds of its ISO UTC start time; a pid that is gone has no entry', async () => {
    const r = rig('win32');
    r.replies = [
      result(
        [
          '10\t2026-11-14T10:20:30.1234567Z',
          '20\t2026-01-01T00:00:00.5Z',
          '30\t2026-01-01T00:00:01Z',
          'MCS-START-END',
        ].join('\r\n'),
      ),
    ];
    const times = await createProcessHelpers(r.deps).processStartTimes([10, 20, 30, 40]);
    expect(times).toEqual(
      new Map([
        [10, Date.UTC(2026, 10, 14, 10, 20, 30, 123)],
        [20, Date.UTC(2026, 0, 1, 0, 0, 0, 500)],
        [30, Date.UTC(2026, 0, 1, 0, 0, 1, 0)],
      ]),
    );
  });

  it('needs the end marker: a listing that did not reach it is null', async () => {
    const r = rig('win32');
    r.replies = [result('10\t2026-11-14T10:20:30.1234567Z\r\n')];
    expect(await createProcessHelpers(r.deps).processStartTimes([10])).toBeNull();
    r.replies = [result('')];
    expect(await createProcessHelpers(r.deps).processStartTimes([10])).toBeNull();
  });

  it('is null for truncated output, a failed query, an unresolved PowerShell and an exec that throws', async () => {
    const r = rig('win32');
    r.replies = [result('10\t2026-11-14T10:20:30Z\r\nMCS-START-END\r\n', { truncated: true })];
    expect(await createProcessHelpers(r.deps).processStartTimes([10])).toBeNull();
    r.replies = [result('', { ok: false, code: null, error: 'TIMEOUT' })];
    expect(await createProcessHelpers(r.deps).processStartTimes([10])).toBeNull();
    const none = createProcessHelpers({ ...r.deps, resolve: () => Promise.resolve(null) });
    expect(await none.processStartTimes([10])).toBeNull();
    const throwing = createProcessHelpers({
      ...r.deps,
      exec: () => Promise.reject(new Error('boom')),
    });
    expect(await throwing.processStartTimes([10])).toBeNull();
    const throwingSync = createProcessHelpers({
      ...r.deps,
      resolve: () => {
        throw new Error('boom');
      },
    });
    expect(await throwingSync.processStartTimes([10])).toBeNull();
  });

  it('ignores stray, malformed and unrequested rows and everything after the marker', async () => {
    const r = rig('win32');
    r.replies = [
      result(
        [
          'WARNING: something',
          '10\tnot a time',
          '10\t2026-11-14T10:20:30Z extra',
          '99\t2026-11-14T10:20:30Z',
          '10\t2026-11-14T10:20:30Z',
          'MCS-START-END',
          '20\t2026-11-14T10:20:30Z',
        ].join('\n'),
      ),
    ];
    const times = await createProcessHelpers(r.deps).processStartTimes([10, 20]);
    expect(times).toEqual(new Map([[10, Date.UTC(2026, 10, 14, 10, 20, 30)]]));
  });

  it('never puts an invalid pid into the script, removes duplicates, and does not spawn when none is left', async () => {
    const r = rig('win32');
    r.replies = [result('MCS-START-END\r\n')];
    const helpers = createProcessHelpers(r.deps);
    expect(await helpers.processStartTimes([7, 0, -1, 1.5, Number.NaN, 7, 12345678901, 8])).toEqual(new Map());
    expect(decodedScript(r.specs[0])).toBe(START_SCRIPT('7,8'));
    r.specs.length = 0;
    expect(await helpers.processStartTimes([0, -2, Number.NaN])).toEqual(new Map());
    expect(await helpers.processStartTimes([])).toEqual(new Map());
    expect(r.specs).toEqual([]);
  });

  it('refuses more than 256 pids without spawning (null)', async () => {
    const r = rig('win32');
    const helpers = createProcessHelpers(r.deps);
    const many = Array.from({ length: 257 }, (_, index) => index + 1);
    expect(await helpers.processStartTimes(many)).toBeNull();
    expect(r.specs).toEqual([]);
    r.replies = [result('MCS-START-END\r\n')];
    expect(await helpers.processStartTimes(many.slice(0, 256))).toEqual(new Map());
  });

  it('is null without spawning off Windows', async () => {
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      const r = rig(platform);
      expect(await createProcessHelpers(r.deps).processStartTimes([10])).toBeNull();
      expect(r.specs).toEqual([]);
    }
  });
});

describe('listDescendantPids (scripted)', () => {
  it('runs one constant CIM script of kind powershell.processes', async () => {
    const r = rig('win32');
    r.replies = [result('MCS-TREE-END\r\n')];
    await createProcessHelpers(r.deps).listDescendantPids(100);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]).toMatchObject({
      kind: 'powershell.processes',
      file: 'C:\\ps\\powershell.exe',
      timeoutMs: 20_000,
      maxOutputBytes: 1_048_576,
      encoding: 'utf8',
    });
    expect(decodedScript(r.specs[0])).toBe(TREE_SCRIPT);
  });

  it('computes the tree in Node: every descendant, the root excluded, ascending', async () => {
    const r = rig('win32');
    r.replies = [
      result(
        ['1\t0', '100\t1', '103\t101', '101\t100', '102\t100', '104\t103', '200\t5', '201\t200', 'MCS-TREE-END'].join(
          '\r\n',
        ),
      ),
    ];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toEqual([101, 102, 103, 104]);
    r.replies = [result(['100\t1', '200\t100', 'MCS-TREE-END'].join('\n'))];
    expect(await createProcessHelpers(r.deps).listDescendantPids(999)).toEqual([]);
  });

  it('survives a parent cycle (pid reuse) without looping and without returning the root', async () => {
    const r = rig('win32');
    r.replies = [result(['100\t101', '101\t100', '102\t102', 'MCS-TREE-END'].join('\n'))];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toEqual([101]);
  });

  it('ignores stray and malformed rows and everything after the marker', async () => {
    const r = rig('win32');
    r.replies = [
      result(['WARNING: x', '101\tabc', '0\t100', '101\t100 ', '101\t100', 'MCS-TREE-END', '102\t100'].join('\n')),
    ];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toEqual([101]);
  });

  it('needs the end marker; truncated output, a failed query and a throwing exec give null', async () => {
    const r = rig('win32');
    r.replies = [result('101\t100\r\n')];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toBeNull();
    r.replies = [result('101\t100\r\nMCS-TREE-END\r\n', { truncated: true })];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toBeNull();
    r.replies = [result('', { ok: false, code: 1, error: 'NONZERO_EXIT' })];
    expect(await createProcessHelpers(r.deps).listDescendantPids(100)).toBeNull();
    const throwing = createProcessHelpers({ ...r.deps, exec: () => Promise.reject(new Error('boom')) });
    expect(await throwing.listDescendantPids(100)).toBeNull();
    const none = createProcessHelpers({ ...r.deps, resolve: () => Promise.resolve(null) });
    expect(await none.listDescendantPids(100)).toBeNull();
  });

  it('is null without spawning for an invalid root and off Windows', async () => {
    const r = rig('win32');
    for (const pid of [0, -1, 1.5, Number.NaN, 12345678901]) {
      expect(await createProcessHelpers(r.deps).listDescendantPids(pid)).toBeNull();
    }
    expect(r.specs).toEqual([]);
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      const other = rig(platform);
      expect(await createProcessHelpers(other.deps).listDescendantPids(100)).toBeNull();
      expect(other.specs).toEqual([]);
    }
  });
});

describe('real processes', () => {
  it('pidAlive: this process is alive, an unused pid is not, junk is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it('commandLineOf(own pid) contains node, and a second call within 5 s spawns nothing', async () => {
    const first = await commandLineOf(process.pid);
    expect(first?.toLowerCase()).toContain('node');
    const before = childStats()['powershell.cmdline'].spawned + childStats().ps.spawned;
    const second = await commandLineOf(process.pid);
    expect(second).toBe(first);
    expect(childStats()['powershell.cmdline'].spawned + childStats().ps.spawned).toBe(before);
  });

  it('commandLineOf rejects invalid pids without spawning', async () => {
    const before = childStats()['powershell.cmdline'].spawned;
    for (const pid of [0, -1, 1.5, Number.NaN, 12345678901]) expect(await commandLineOf(pid)).toBeNull();
    expect(childStats()['powershell.cmdline'].spawned).toBe(before);
  });

  it('commandLineOf shows the arguments of another process', async () => {
    const child = spawnTracked(process.execPath, [
      '-e',
      'setInterval(() => undefined, 1000)',
      '--',
      '--marker-arg-7f3a',
    ]);
    const line = await commandLineOf(child.pid);
    expect(line).toContain('--marker-arg-7f3a');
  }, 30_000);

  it('forceKill ends a running child, waitForExit sees it go, and the kill went through taskkill on Windows', async () => {
    const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 1000)']);
    expect(pidAlive(child.pid)).toBe(true);
    const before = childStats().taskkill.spawned;
    await forceKill(child.pid);
    expect(await waitForExit(child.pid, 5000)).toBe(true);
    expect(pidAlive(child.pid)).toBe(false);
    await child.exited;
    if (process.platform === 'win32') expect(childStats().taskkill.spawned).toBe(before + 1);
  }, 30_000);

  it('forceKill of a pid that is already dead resolves', async () => {
    const child = spawnTracked(process.execPath, ['-e', '0']);
    await child.exited;
    expect(await waitForExit(child.pid, 5000)).toBe(true);
    await expect(forceKill(child.pid)).resolves.toBeUndefined();
  }, 30_000);

  it('waitForExit returns false for a process that stays alive', async () => {
    expect(await waitForExit(process.pid, 250, 50)).toBe(false);
  });
});

/** A child that starts a grandchild, writes the grandchild pid to the file named by its first argument, then idles. */
const GRANDCHILD_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });",
  'writeFileSync(process.argv[1], String(grandchild.pid));',
  'setInterval(() => undefined, 1000);',
].join('\n');

function readPid(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8');
    return /^[0-9]+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

describe.runIf(process.platform === 'win32')('real processes: tree helpers (Windows)', () => {
  it('processStartTimes reads this process and a child; a pid that is gone has no entry', async () => {
    const expectedStart = Date.now() - process.uptime() * 1000;
    const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 1000)']);
    const gone = spawnTracked(process.execPath, ['-e', '0']);
    await gone.exited;
    expect(await waitForExit(gone.pid, 5000)).toBe(true);
    const before = childStats()['powershell.processes'].spawned;
    const times = await processStartTimes([process.pid, child.pid, gone.pid]);
    expect(childStats()['powershell.processes'].spawned).toBe(before + 1);
    expect(times).not.toBeNull();
    const own = times?.get(process.pid);
    const childStart = times?.get(child.pid);
    expect(own).toBeDefined();
    expect(childStart).toBeDefined();
    expect(Math.abs((own ?? 0) - expectedStart)).toBeLessThan(10_000);
    expect(childStart ?? 0).toBeGreaterThanOrEqual((own ?? 0) - 1000);
    expect(Math.abs((childStart ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(times?.has(gone.pid)).toBe(false);
  }, 60_000);

  it('listDescendantPids finds a grandchild and forceKillTree ends the whole tree', async () => {
    const dir = makeTempDir('proc-tree');
    try {
      const marker = path.join(dir.path, 'grandchild.pid');
      const child = spawnTracked(process.execPath, ['-e', GRANDCHILD_SCRIPT, marker]);
      const grandchild = await waitFor(() => readPid(marker), { timeoutMs: 20_000, what: 'the grandchild pid file' });
      expect(pidAlive(grandchild)).toBe(true);
      const descendants = await listDescendantPids(child.pid);
      expect(descendants).toContain(grandchild);
      expect(descendants).not.toContain(child.pid);
      const before = childStats().taskkill.spawned;
      await forceKillTree(child.pid);
      expect(childStats().taskkill.spawned).toBe(before + 1);
      expect(await waitForExit(child.pid, 10_000)).toBe(true);
      expect(await waitForExit(grandchild, 10_000)).toBe(true);
      await child.exited;
    } finally {
      dir.remove();
    }
  }, 60_000);

  it('forceKillTree of a pid that is already dead resolves', async () => {
    const child = spawnTracked(process.execPath, ['-e', '0']);
    await child.exited;
    expect(await waitForExit(child.pid, 5000)).toBe(true);
    await expect(forceKillTree(child.pid)).resolves.toBeUndefined();
  }, 30_000);
});

describe('real processes: tree helpers refuse junk', () => {
  it('forceKillTree rejects invalid pids without spawning; the other two never spawn for them', async () => {
    const before = { ...childStats() };
    for (const pid of [0, -1, 1.5, Number.NaN]) await expect(forceKillTree(pid)).rejects.toBeInstanceOf(RangeError);
    expect(await processStartTimes([0, -1])).toEqual(new Map());
    expect(await listDescendantPids(0)).toBeNull();
    const after = childStats();
    expect(after.taskkill.spawned).toBe(before.taskkill.spawned);
    expect(after['powershell.processes'].spawned).toBe(before['powershell.processes'].spawned);
  });
});
