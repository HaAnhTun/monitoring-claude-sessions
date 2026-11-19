// CAW-145 (design 09 B3 and B8): the launcher of a window of the person's own terminal. Every seam is a fake (the spawner, the file
// system, the clock, the logger), so the argv of each route, the refusals, the environment and the limits run on any host.
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostPlatform } from '../platform/host.ts';
import type { EnvSource } from './env.ts';
import { TerminalError, type TerminalErrorCode } from './errors.ts';
import {
  NATIVE_MIN_GAP_MS,
  NATIVE_PER_MINUTE,
  NATIVE_SPAWN_TIMEOUT_MS,
  WT_CACHE_MS,
  WT_PREFIX,
  WT_SEPARATOR,
  createNativeTerminal,
  realNativeSpawner,
  type NativeFs,
  type NativeSpawner,
} from './native-terminal.ts';

const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const FOLDER = 'D:\\work\\app';
const LOCAL = 'C:\\Users\\tester\\AppData\\Local';
const WT = `${LOCAL}\\Microsoft\\WindowsApps\\wt.exe`;
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const SHIM = 'C:\\npm\\claude.cmd';
const EXE = 'C:\\bin\\claude.exe';

interface Rig {
  readonly terminal: ReturnType<typeof createNativeTerminal>;
  readonly spawn: ReturnType<typeof vi.fn<NativeSpawner>>;
  readonly logs: { level: string; event: string; fields: unknown }[];
  readonly lookups: string[];
  now: number;
}

interface RigOptions {
  platform?: HostPlatform;
  files?: readonly string[];
  entries?: readonly string[];
  dirs?: readonly string[];
  env?: EnvSource;
  args?: readonly string[];
  keep?: readonly string[];
  command?: string;
  spawn?: NativeSpawner;
}

function rig(o: RigOptions = {}): Rig {
  // Windows compares paths without regard to case, and PATHEXT spells its extensions in upper case
  const lower = (list: readonly string[]): Set<string> => new Set(list.map((item) => item.toLowerCase()));
  const files = lower(o.files ?? [SHIM, CMD]);
  const entries = lower(o.entries ?? [WT]);
  const dirs = lower(o.dirs ?? [FOLDER]);
  const lookups: string[] = [];
  const fs: NativeFs = {
    isFile: (p) => files.has(p.toLowerCase()),
    isDirectory: (p) => dirs.has(p.toLowerCase()),
    hasEntry: (p) => {
      lookups.push(p);
      return entries.has(p.toLowerCase()) || files.has(p.toLowerCase());
    },
  };
  const spawn = vi.fn<NativeSpawner>(o.spawn ?? (() => Promise.resolve()));
  const logs: Rig['logs'] = [];
  const state = { now: 1_000_000 };
  const log = (level: string) => (event: string, fields?: unknown) => {
    logs.push({ level, event, fields });
  };
  const env: EnvSource = o.env ?? {
    Path: 'relative\\bin;C:\\npm;C:\\bin',
    SystemRoot: 'C:\\Windows',
    PATHEXT: '.exe;.cmd',
    LOCALAPPDATA: LOCAL,
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_SESSION_ID: 'abc',
    MCS_HOOK_DISABLE: '1',
    NO_COLOR: '1',
    KEEP_ME: 'yes',
  };
  const terminal = createNativeTerminal({
    platform: o.platform ?? 'win32',
    env: () => env,
    fs,
    config: { command: o.command ?? 'claude', args: [...(o.args ?? [])], envKeep: [...(o.keep ?? [])] },
    launch: spawn,
    clock: { now: () => state.now },
    logger: { info: log('info'), warn: log('warn') },
  });
  return {
    terminal,
    spawn,
    logs,
    lookups,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<TerminalErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    if (error instanceof TerminalError) return error.code;
    throw error;
  }
}

const open = (r: Rig, o: { folder?: string; sessionId?: string; fork?: boolean } = {}) =>
  r.terminal.open({ folder: o.folder ?? FOLDER, sessionId: o.sessionId ?? SID, fork: o.fork ?? false });

describe('CAW-145 the argv of every route (arrays, never a shell string)', () => {
  it('Windows Terminal with a .cmd shim: new-tab, -d, --, the absolute cmd.exe, /d /k, the shim, then the arguments', async () => {
    const r = rig();
    await expect(open(r)).resolves.toBe('windows-terminal');
    expect(r.spawn).toHaveBeenCalledTimes(1);
    const [file, args, o] = r.spawn.mock.calls[0] ?? [];
    expect(file).toBe(WT);
    expect(args).toEqual(['new-tab', '-d', FOLDER, '--', CMD, '/d', '/k', SHIM, '--resume', SID]);
    expect(o?.cwd).toBe(FOLDER);
  });

  it('Windows Terminal with a claude.exe: the program and its arguments follow the separator', async () => {
    const r = rig({ files: [EXE, CMD] });
    await expect(open(r)).resolves.toBe('windows-terminal');
    expect(r.spawn.mock.calls[0]?.[1]).toEqual(['new-tab', '-d', FOLDER, '--', EXE, '--resume', SID]);
  });

  it('the console route with a shim: the absolute cmd.exe with /d /k and no Windows Terminal prefix', async () => {
    const r = rig({ entries: [] });
    await expect(open(r)).resolves.toBe('console');
    const [file, args, o] = r.spawn.mock.calls[0] ?? [];
    expect(file).toBe(CMD);
    expect(args).toEqual(['/d', '/k', SHIM, '--resume', SID]);
    expect(o?.cwd).toBe(FOLDER);
  });

  it('the console route with a claude.exe: the program itself', async () => {
    const r = rig({ files: [EXE, CMD], entries: [] });
    await expect(open(r)).resolves.toBe('console');
    const [file, args] = r.spawn.mock.calls[0] ?? [];
    expect(file).toBe(EXE);
    expect(args).toEqual(['--resume', SID]);
  });

  it('the configured arguments come first, then --resume, then --fork-session for a copy', async () => {
    const r = rig({ args: ['--model', 'x'], entries: [] });
    await open(r, { fork: true });
    expect(r.spawn.mock.calls[0]?.[1]).toEqual(['/d', '/k', SHIM, '--model', 'x', '--resume', SID, '--fork-session']);
  });

  it('pins the Windows Terminal prefix in one constant', () => {
    expect(WT_PREFIX).toEqual(['new-tab', '-d']);
    expect(WT_SEPARATOR).toBe('--');
  });

  it('a folder is normalized again: forward slashes become backslashes', async () => {
    const r = rig();
    await open(r, { folder: 'D:/work/app' });
    expect(r.spawn.mock.calls[0]?.[2]?.cwd).toBe(FOLDER);
    expect(r.spawn.mock.calls[0]?.[1]?.[2]).toBe(FOLDER);
  });
});

describe('CAW-145 refusals before anything starts', () => {
  it('a semicolon in the folder is refused on the Windows Terminal route (it would be read as a command separator)', async () => {
    const folder = 'D:\\work;app';
    const r = rig({ dirs: [folder] });
    await expect(codeOf(open(r, { folder }))).resolves.toBe('FOLDER_INVALID');
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a relative, UNC or empty folder is FOLDER_INVALID and a folder that is gone is FOLDER_NOT_FOUND', async () => {
    const r = rig();
    for (const folder of ['work\\app', '\\\\host\\share\\x', '']) {
      await expect(codeOf(open(r, { folder })), folder).resolves.toBe('FOLDER_INVALID');
    }
    await expect(codeOf(open(r, { folder: 'D:\\gone' }))).resolves.toBe('FOLDER_NOT_FOUND');
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a session id that is not a Claude id is ARGS_UNSAFE', async () => {
    const r = rig();
    for (const sessionId of ['short', 'abc def 12345', '--dangerous-flag-1', 'a&b-12345678', `${SID}\n`]) {
      await expect(codeOf(open(r, { sessionId })), sessionId).resolves.toBe('ARGS_UNSAFE');
    }
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['(', 'C:\\npm (x)\\claude.cmd'],
    ['&', 'C:\\npm&evil\\claude.cmd'],
    ['%', 'C:\\npm%PATH%\\claude.cmd'],
    ['"', 'C:\\npm"x\\claude.cmd'],
    ['^', 'C:\\npm^x\\claude.cmd'],
  ])('a shim path with %s is refused', async (_name, shim) => {
    const r = rig({
      files: [shim, CMD],
      env: { Path: shim.slice(0, shim.lastIndexOf('\\')), SystemRoot: 'C:\\Windows', PATHEXT: '.cmd' },
    });
    const code = await codeOf(open(r));
    // an unresolvable spelling is no file at all; a resolvable one is refused by the launch rules
    expect(['ARGS_UNSAFE', 'COMMAND_UNSUPPORTED', 'CLAUDE_NOT_FOUND']).toContain(code);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a shim path with a parenthesis or an ampersand that resolves is ARGS_UNSAFE (cmd.exe would read it)', async () => {
    const shim = 'C:\\npm (x)\\claude.cmd';
    const r = rig({ files: [shim, CMD], command: shim });
    await expect(codeOf(open(r))).resolves.toBe('ARGS_UNSAFE');
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('no claude on the search path is CLAUDE_NOT_FOUND', async () => {
    const r = rig({ files: [CMD] });
    await expect(codeOf(open(r))).resolves.toBe('CLAUDE_NOT_FOUND');
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('an unsupported extension is COMMAND_UNSUPPORTED', async () => {
    const r = rig({ files: ['C:\\bin\\claude.com.ps1', CMD], command: 'C:\\bin\\claude.com.ps1' });
    expect(['COMMAND_UNSUPPORTED', 'CLAUDE_NOT_FOUND']).toContain(await codeOf(open(r)));
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a host that is not Windows has nothing to open: not available, and open is UNSUPPORTED_OS', async () => {
    const r = rig({ platform: 'linux' });
    expect(r.terminal.capabilities()).toEqual({ available: false, via: null });
    await expect(codeOf(open(r, { folder: '/work/app' }))).resolves.toBe('UNSUPPORTED_OS');
    expect(r.spawn).not.toHaveBeenCalled();
  });
});

describe('CAW-145 finding Windows Terminal (an app execution alias is a link that stat cannot read)', () => {
  it('finds wt.exe by an entry test, not by isFile', () => {
    const r = rig({ entries: [WT], files: [SHIM, CMD] });
    expect(r.terminal.capabilities()).toEqual({ available: true, via: 'windows-terminal' });
    expect(r.lookups).toContain(WT);
  });

  it('prefers a wt.exe of an absolute PATH entry, and ignores a relative one', async () => {
    const onPath = 'C:\\tools\\wt.exe';
    const r = rig({
      entries: [onPath, WT],
      env: {
        Path: 'relative;wt;C:\\tools;C:\\npm',
        SystemRoot: 'C:\\Windows',
        PATHEXT: '.exe;.cmd',
        LOCALAPPDATA: LOCAL,
      },
    });
    await open(r);
    expect(r.spawn.mock.calls[0]?.[0]).toBe(onPath);
    expect(r.lookups.some((p) => p.startsWith('relative') || p.startsWith('wt'))).toBe(false);
  });

  it('falls back to the console when there is no wt.exe anywhere', () => {
    const r = rig({ entries: [] });
    expect(r.terminal.capabilities()).toEqual({ available: true, via: 'console' });
  });

  it('caches the answer for a minute and looks again after it', () => {
    const r = rig();
    r.terminal.capabilities();
    const first = r.lookups.length;
    expect(first).toBeGreaterThan(0);
    r.now += WT_CACHE_MS - 1;
    r.terminal.capabilities();
    expect(r.lookups.length).toBe(first);
    r.now += 2;
    r.terminal.capabilities();
    expect(r.lookups.length).toBeGreaterThan(first);
  });
});

describe('CAW-145 the environment of the window', () => {
  it('strips the Claude markers, keeps the colour variables and PATH, sets none of the xterm variables', async () => {
    const r = rig({ entries: [] });
    await open(r);
    const env = r.spawn.mock.calls[0]?.[2]?.env ?? {};
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SESSION_ID', 'MCS_HOOK_DISABLE']) {
      expect(env, name).not.toHaveProperty(name);
    }
    for (const name of ['TERM', 'COLORTERM', 'TERM_PROGRAM']) expect(env, name).not.toHaveProperty(name);
    expect(env['NO_COLOR']).toBe('1');
    expect(env['KEEP_ME']).toBe('yes');
    expect(env['Path']).toBe('relative\\bin;C:\\npm;C:\\bin');
    expect(env['NoDefaultCurrentDirectoryInExePath']).toBe('1');
  });

  it('honours terminal.envKeep', async () => {
    const r = rig({ entries: [], keep: ['CLAUDE_CODE_ENTRYPOINT'] });
    await open(r);
    expect(r.spawn.mock.calls[0]?.[2]?.env['CLAUDE_CODE_ENTRYPOINT']).toBe('cli');
  });
});

describe('CAW-145 the log holds the way and the copy flag, and nothing else', () => {
  it('logs one info line after the start, with no folder, id or path anywhere', async () => {
    const r = rig();
    await open(r, { fork: true });
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toEqual({
      level: 'info',
      event: 'terminal.native_open',
      fields: { kind: 'windows-terminal', phase: 'fork' },
    });
    const text = JSON.stringify(r.logs);
    for (const secret of [SID, FOLDER, 'work', 'app', WT, SHIM, CMD, 'tester']) expect(text).not.toContain(secret);
  });

  it('logs a code word only for a failed start', async () => {
    const r = rig({ entries: [], spawn: () => Promise.reject(new Error(`boom ${FOLDER} ${SID}`)) });
    await expect(codeOf(open(r))).resolves.toBe('SPAWN_FAILED');
    expect(r.logs).toEqual([{ level: 'warn', event: 'terminal.native_open_failed', fields: { code: 'SPAWN_FAILED' } }]);
    expect(JSON.stringify(r.logs)).not.toContain(SID);
  });

  it('an error never carries the folder, the id or a path', async () => {
    const r = rig({ spawn: () => Promise.reject(new Error(`boom ${FOLDER} ${SID}`)) });
    const error = await open(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminalError);
    const text = `${(error as Error).message} ${(error as Error).name}`;
    for (const secret of [SID, FOLDER, WT, SHIM]) expect(text).not.toContain(secret);
  });
});

describe('CAW-145 abuse limits', () => {
  it('one open at a time: a second while the first is starting is SESSION_LIMIT', async () => {
    let release: () => void = () => undefined;
    const r = rig({
      spawn: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const first = open(r);
    await expect(codeOf(open(r))).resolves.toBe('SESSION_LIMIT');
    release();
    await expect(first).resolves.toBe('windows-terminal');
  });

  it('at least 1.5 s between two opens', async () => {
    const r = rig();
    await open(r);
    r.now += NATIVE_MIN_GAP_MS - 1;
    await expect(codeOf(open(r))).resolves.toBe('SESSION_LIMIT');
    r.now += 1;
    await expect(open(r)).resolves.toBe('windows-terminal');
    expect(r.spawn).toHaveBeenCalledTimes(2);
  });

  it('at most 12 in a rolling minute', async () => {
    const r = rig();
    for (let i = 0; i < NATIVE_PER_MINUTE; i += 1) {
      await open(r);
      r.now += NATIVE_MIN_GAP_MS;
    }
    // 12 * 1.5 s = 18 s: still inside the minute
    await expect(codeOf(open(r))).resolves.toBe('SESSION_LIMIT');
    r.now += 60_000;
    await expect(open(r)).resolves.toBe('windows-terminal');
  });

  it('a refused request does not use up the allowance', async () => {
    const r = rig();
    await expect(codeOf(open(r, { sessionId: 'bad' }))).resolves.toBe('ARGS_UNSAFE');
    await expect(open(r)).resolves.toBe('windows-terminal');
  });

  it('a failed start frees the one-at-a-time slot', async () => {
    let fail = true;
    const r = rig({ spawn: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve()) });
    await expect(codeOf(open(r))).resolves.toBe('SPAWN_FAILED');
    fail = false;
    r.now += NATIVE_MIN_GAP_MS;
    await expect(open(r)).resolves.toBe('windows-terminal');
  });
});

describe('CAW-145 the real spawner: starts, errors and the 2 s answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeChild(): EventEmitter {
    return new EventEmitter();
  }

  it('resolves on the spawn event and passes the file, the arguments, the folder and the environment', async () => {
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const spawn = realNativeSpawner(launch as never);
    const done = spawn('C:\\x\\wt.exe', ['a', 'b'], { cwd: FOLDER, env: { A: '1' } });
    expect(launch).toHaveBeenCalledWith('C:\\x\\wt.exe', ['a', 'b'], { cwd: FOLDER, env: { A: '1' } });
    child.emit('spawn');
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects on an error event, attached in the same tick', async () => {
    const child = fakeChild();
    const spawn = realNativeSpawner((() => child) as never);
    const done = spawn('C:\\x\\wt.exe', [], { cwd: FOLDER, env: {} });
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    child.emit('error', new Error('ENOENT'));
    await expect(done).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the launch throws', async () => {
    const spawn = realNativeSpawner(() => {
      throw new Error('refused');
    });
    await expect(spawn('C:\\x\\wt.exe', [], { cwd: FOLDER, env: {} })).rejects.toBeInstanceOf(Error);
  });

  it('settles at 2 s when the process never answers', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = realNativeSpawner((() => child) as never);
    const done = spawn('C:\\x\\wt.exe', [], { cwd: FOLDER, env: {} });
    const settled = vi.fn();
    done.then(settled, settled);
    await vi.advanceTimersByTimeAsync(NATIVE_SPAWN_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toHaveBeenCalledTimes(1);
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(NATIVE_SPAWN_TIMEOUT_MS).toBe(2000);
  });

  it('clears its timer once the process answered', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = realNativeSpawner((() => child) as never);
    const done = spawn('C:\\x\\wt.exe', [], { cwd: FOLDER, env: {} });
    child.emit('spawn');
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
});
