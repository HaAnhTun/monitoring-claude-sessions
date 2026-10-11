import { McsError } from '@mcs/shared';
import { killAllTracked, spawnTracked } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { childStats, type ChildResult, type ChildSpec } from './exec.ts';
import type { HostPlatform } from './host.ts';
import {
  commandLineOf,
  createProcessHelpers,
  forceKill,
  isValidPid,
  pidAlive,
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
