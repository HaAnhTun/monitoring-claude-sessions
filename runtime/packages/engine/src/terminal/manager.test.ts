import { join } from 'node:path';

import { TerminalSectionSchema, type Clock, type TerminalSection } from '@mcs/shared';
import { CANARY, FIXTURE_EPOCH_MS, FakeClock, scanFilesFor, scanForCanaries, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOG_FIELD_NAMES, createLogger } from '../log/logger.ts';
import type { HostPlatform } from '../platform/host.ts';
import { TERMINAL_ERROR_CODES, TerminalError, type TerminalErrorCode } from './errors.ts';
import { FakePtyBackend, type FakePty, type FakePtyBackendOptions } from './fake-pty.ts';
import { LIVENESS_PROBE_MS, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS } from './limits.ts';
import {
  CLAUDE_PIDS_TTL_MS,
  WATCHDOG_MISSES,
  claudeFacts,
  createTerminalService,
  shortenHome,
  type TerminalDeps,
  type TerminalLogger,
  type TerminalService,
} from './manager.ts';
import { KILL_TREE_WAIT_MS } from './session.ts';
import type {
  ChildRegistry,
  SessionExit,
  SessionInfo,
  SweepResult,
  TerminalChange,
  UnsupportedReason,
  Viewer,
  ViewerEnd,
} from './types.ts';

// FIXTURE: invented paths and names. The backend is a script, the file system is a set of strings, the process table is a Set:
// no process starts and nothing touches the disk (except the one test that writes a log file into a temp folder).
const HOME = 'C:\\Users\\fixture';
const TOOLS = 'C:\\tools';
const CLAUDE_EXE = `${TOOLS}\\claude.exe`;
const CLAUDE_CMD = `${TOOLS}\\claude.cmd`;
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const FOLDER = 'D:\\work\\proj';
const ACCENTED_FOLDER = 'D:\\work\\R\u00e9sum\u00e9 Dir';

const tempDir = useTempDirs();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- fakes ---------------------------------------------------------------------------------------------------------------

class TestViewer implements Viewer {
  readonly chunks: Buffer[] = [];
  readonly ends: ViewerEnd[] = [];

  send(chunk: Uint8Array): void {
    this.chunks.push(Buffer.from(chunk));
  }

  end(reason: ViewerEnd): void {
    this.ends.push(reason);
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('latin1');
  }
}

class FakeRegistry implements ChildRegistry {
  readonly added: { pid: number; at: number }[] = [];
  readonly removed: number[] = [];
  closes = 0;
  sweeps = 0;
  sweepResult: SweepResult = { files: 0, killed: 0, skipped: 0 };
  sweepError: Error | null = null;

  add(pid: number, spawnedAtMs: number): void {
    this.added.push({ pid, at: spawnedAtMs });
  }

  remove(pid: number): void {
    this.removed.push(pid);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }

  sweep(): Promise<SweepResult> {
    this.sweeps += 1;
    if (this.sweepError !== null) return Promise.reject(this.sweepError);
    return Promise.resolve(this.sweepResult);
  }
}

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function capturingLogger(): { logger: TerminalLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: LogCall['level']) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      calls.push({ level, event, fields });
    };
  return { calls, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

interface RigOptions {
  readonly config?: Partial<TerminalSection>;
  readonly backend?: FakePtyBackend;
  readonly backendOptions?: FakePtyBackendOptions;
  readonly platform?: HostPlatform;
  readonly env?: Record<string, string | undefined>;
  readonly files?: readonly string[];
  readonly folders?: readonly string[];
  readonly registry?: boolean;
  readonly logger?: TerminalLogger;
  readonly clock?: Clock;
  readonly descendants?: (root: number) => Promise<readonly number[] | null>;
}

function terminalConfig(overrides: Partial<TerminalSection> = {}): TerminalSection {
  return { ...TerminalSectionSchema.parse(undefined), ...overrides };
}

function rig(o: RigOptions = {}) {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const backend = o.backend ?? new FakePtyBackend(o.backendOptions);
  const registry = o.registry === false ? null : new FakeRegistry();
  const files = new Set(o.files ?? [CLAUDE_EXE]);
  const folders = new Set(o.folders ?? [FOLDER, 'D:\\work\\other', ACCENTED_FOLDER]);
  const trees: number[] = [];
  const syncKills: number[] = [];
  const dead = new Set<number>();
  const lookups: number[] = [];
  const { logger, calls } = capturingLogger();
  // PATHEXT in lower case: the fake file system compares exactly, the real one ignores the case of an extension.
  const env: Record<string, string | undefined> = o.env ?? {
    PATH: TOOLS,
    PATHEXT: '.exe;.cmd',
    SystemRoot: 'C:\\Windows',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    KEEPME: 'kept',
  };
  const deps: TerminalDeps = {
    backend,
    config: terminalConfig(o.config),
    logger: o.logger ?? logger,
    clock: o.clock ?? clock,
    platform: o.platform ?? 'win32',
    env: () => env,
    fs: { isDirectory: (p) => folders.has(p), isFile: (p) => files.has(p) },
    killTree: (pid) => {
      trees.push(pid);
      return Promise.resolve();
    },
    killSync: (pid) => {
      syncKills.push(pid);
    },
    pidAlive: (pid) => !dead.has(pid),
    descendants:
      o.descendants ??
      ((root) => {
        lookups.push(root);
        return Promise.resolve(null);
      }),
    registry,
    home: HOME,
  };
  const service = createTerminalService(deps);
  const changes: TerminalChange[] = [];
  service.onChange((change) => changes.push(change));
  return {
    service,
    backend,
    registry,
    clock,
    calls,
    trees,
    syncKills,
    dead,
    lookups,
    files,
    folders,
    env,
    changes,
    deps,
  };
}

type Rig = ReturnType<typeof rig>;

function isTimerHandle(value: unknown): value is { hasRef(): boolean } {
  return typeof value === 'object' && value !== null && 'hasRef' in value && typeof value.hasRef === 'function';
}

/** Lets the microtasks of a `create` run (a fake pty is already started). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function failure(promise: Promise<unknown>): Promise<TerminalError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TerminalError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a TerminalError');
}

async function create(
  r: Rig,
  folder = FOLDER,
  extra: { resume?: string; fork?: boolean; cols?: number; rows?: number } = {},
) {
  const info = await r.service.create({ folder, ...extra });
  const pty = r.backend.last;
  if (pty === undefined) throw new Error('nothing was spawned');
  return { info, pty };
}

function ptyOf(r: Rig, info: SessionInfo): FakePty {
  const found = r.backend.spawns.find((s) => s.pty.pid === info.pid)?.pty;
  if (found === undefined) throw new Error('no pty for this session');
  return found;
}

function endedChanges(r: Rig): Extract<TerminalChange, { type: 'ended' }>[] {
  return r.changes.filter((c): c is Extract<TerminalChange, { type: 'ended' }> => c.type === 'ended');
}

// ---- create: the happy path ------------------------------------------------------------------------------------------------

describe('create (design 01 section 3.10, the 12 steps)', () => {
  it('starts claude in the folder and answers with the session info', async () => {
    const r = rig();
    const info = await r.service.create({ folder: FOLDER });
    expect(info).toEqual({
      name: 'proj-1',
      cwd: FOLDER,
      pid: 1000,
      startedAt: FIXTURE_EPOCH_MS,
      cols: 120,
      rows: 30,
      viewers: 0,
    });
    expect(r.backend.spawns).toHaveLength(1);
    const spawn = r.backend.spawns[0];
    expect(spawn?.cmd).toBe(CLAUDE_EXE);
    expect(spawn?.args).toEqual([]);
    expect(spawn?.cwd).toBe(FOLDER);
    expect(spawn?.cols).toBe(120);
    expect(spawn?.rows).toBe(30);
  });

  it('writes the folder in its normalized spelling and names the session after its last segment', async () => {
    const r = rig();
    const info = await r.service.create({ folder: '"d:/work/proj/"' });
    expect(info.cwd).toBe(FOLDER);
    expect(info.name).toBe('proj-1');
    const other = await r.service.create({ folder: '/mnt/d/work/Résumé Dir' });
    expect(other.cwd).toBe(ACCENTED_FOLDER);
    expect(other.name).toBe('R_sum__Dir-1');
  });

  it('gives the child the environment of the server minus the stripped names, plus the terminal variables', async () => {
    const r = rig();
    await create(r);
    const env = r.backend.spawns[0]?.env ?? {};
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(env['KEEPME']).toBe('kept');
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
  });

  it('keeps the names that terminal.envKeep lists', async () => {
    const r = rig({ config: { envKeep: ['CLAUDE_CODE_ENTRYPOINT'] } });
    await create(r);
    expect(r.backend.spawns[0]?.env['CLAUDE_CODE_ENTRYPOINT']).toBe('cli');
    expect(r.backend.spawns[0]?.env['CLAUDECODE']).toBeUndefined();
  });

  it('reads the environment at every create, not once', async () => {
    const r = rig();
    await create(r);
    r.env['KEEPME'] = 'changed';
    await create(r);
    expect(r.backend.spawns.map((s) => s.env['KEEPME'])).toEqual(['kept', 'changed']);
  });

  it('puts the configured arguments in front of --resume <id>', async () => {
    const r = rig({ config: { args: ['--verbose'] } });
    await create(r, FOLDER, { resume: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    expect(r.backend.spawns[0]?.args).toEqual(['--verbose', '--resume', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
  });

  it('adds --fork-session after --resume <id> for a copy of a session', async () => {
    const r = rig({ config: { args: ['--verbose'] } });
    await create(r, FOLDER, { resume: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', fork: true });
    expect(r.backend.spawns[0]?.args).toEqual([
      '--verbose',
      '--resume',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      '--fork-session',
    ]);
  });

  it('starts a .cmd shim through cmd.exe with the command line as one string', async () => {
    const r = rig({ files: [CLAUDE_CMD, CMD_EXE] });
    await create(r);
    expect(r.backend.spawns[0]?.cmd).toBe(CMD_EXE);
    expect(r.backend.spawns[0]?.args).toBe(`/d /s /c ""${CLAUDE_CMD}""`);
  });

  it('clamps the size and uses the MTOP default when none or a bad one is given', async () => {
    const r = rig();
    const small = await r.service.create({ folder: FOLDER, cols: 5, rows: 1 });
    expect([small.cols, small.rows]).toEqual([MIN_COLS, MIN_ROWS]);
    const large = await r.service.create({ folder: FOLDER, cols: 9999, rows: 9999 });
    expect([large.cols, large.rows]).toEqual([MAX_COLS, MAX_ROWS]);
    const odd = await r.service.create({ folder: FOLDER, cols: Number.NaN, rows: 40.9 });
    expect([odd.cols, odd.rows]).toEqual([120, 40]);
    expect(r.backend.spawns.map((s) => [s.cols, s.rows])).toEqual([
      [MIN_COLS, MIN_ROWS],
      [MAX_COLS, MAX_ROWS],
      [120, 40],
    ]);
  });

  it('stamps startedAt with the service clock, registers the root pid and emits created with version 1', async () => {
    const r = rig();
    r.clock.advance(1234);
    const info = await r.service.create({ folder: FOLDER });
    expect(info.startedAt).toBe(FIXTURE_EPOCH_MS + 1234);
    expect(r.registry?.added).toEqual([{ pid: 1000, at: FIXTURE_EPOCH_MS + 1234 }]);
    expect(r.changes).toEqual([{ type: 'created', session: info, version: 1 }]);
  });

  it('counts the name up per folder name for the life of the service and never reuses one', async () => {
    const r = rig();
    const first = await r.service.create({ folder: FOLDER });
    const second = await r.service.create({ folder: FOLDER });
    const other = await r.service.create({ folder: 'D:\\work\\other' });
    expect([first.name, second.name, other.name]).toEqual(['proj-1', 'proj-2', 'other-1']);
    await r.service.kill('proj-1');
    const third = await r.service.create({ folder: FOLDER });
    expect(third.name).toBe('proj-3');
  });

  it('logs terminal.started with the pid and the live count, and nothing else', async () => {
    const r = rig();
    await create(r);
    expect(r.calls.filter((c) => c.event === 'terminal.started')).toEqual([
      { level: 'info', event: 'terminal.started', fields: { pid: 1000, count: 1 } },
    ]);
  });
});

// ---- create: steps 1 to 8 are synchronous ------------------------------------------------------------------------------------

describe('create: the count and the name are taken before any await', () => {
  it('counts a starting session at once, in liveCount, in status and against the limit', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { maxSessions: 1 } });
    const first = r.service.create({ folder: FOLDER });
    // nothing awaited yet: the slot is already taken
    expect(r.service.liveCount()).toBe(1);
    expect(r.service.status().sessions).toBe(1);
    expect(r.service.list()).toEqual([]);
    const second = r.service.create({ folder: FOLDER });
    expect((await failure(second)).code).toBe('SESSION_LIMIT');
    r.backend.last?.start();
    await first;
    expect(r.service.liveCount()).toBe(1);
    expect(r.service.list()).toHaveLength(1);
  });

  it('does not overshoot the limit when many creates race, and hands out distinct names', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { maxSessions: 3 } });
    const attempts = Array.from({ length: 5 }, () => r.service.create({ folder: FOLDER }));
    for (const spawn of r.backend.spawns) spawn.pty.start();
    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((x): x is PromiseFulfilledResult<SessionInfo> => x.status === 'fulfilled');
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const { reason } of rejected) expect(reason).toMatchObject({ code: 'SESSION_LIMIT' });
    expect(new Set(fulfilled.map((x) => x.value.name)).size).toBe(3);
    expect(fulfilled.map((x) => x.value.name).sort()).toEqual(['proj-1', 'proj-2', 'proj-3']);
    // a refused create never reached the backend
    expect(r.backend.spawns).toHaveLength(3);
  });

  it('numbers concurrent creates of one folder without a collision', async () => {
    const r = rig();
    const infos = await Promise.all(Array.from({ length: 6 }, () => r.service.create({ folder: FOLDER })));
    expect(infos.map((i) => i.name)).toEqual(['proj-1', 'proj-2', 'proj-3', 'proj-4', 'proj-5', 'proj-6']);
  });

  it('refuses at the limit counting the live sessions too', async () => {
    const r = rig({ config: { maxSessions: 2 } });
    await create(r);
    await create(r);
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('SESSION_LIMIT');
    await r.service.kill('proj-1');
    await expect(r.service.create({ folder: FOLDER })).resolves.toMatchObject({ name: 'proj-3' });
  });
});

// ---- create: every error code ------------------------------------------------------------------------------------------------

describe('create: the error codes', () => {
  async function codeOf(r: Rig, req: Parameters<TerminalService['create']>[0] = { folder: FOLDER }) {
    const error = await failure(r.service.create(req));
    // a refused create starts nothing and holds nothing
    expect(r.service.liveCount()).toBe(0);
    expect(r.service.list()).toEqual([]);
    return error.code;
  }

  const unsupported: readonly (readonly [UnsupportedReason, TerminalErrorCode])[] = [
    ['unsupported-os', 'UNSUPPORTED_OS'],
    ['os-too-old', 'UNSUPPORTED_OS'],
    ['native-missing', 'NATIVE_MISSING'],
    ['native-load-failed', 'NATIVE_LOAD_FAILED'],
  ];
  for (const [reason, code] of unsupported) {
    it(`${code} for a backend that is ${reason}, before anything else is looked at`, async () => {
      const r = rig({ backendOptions: { support: { supported: false, reason } }, folders: [], files: [] });
      expect(await codeOf(r, { folder: 'not even a folder' })).toBe(code);
      expect(r.backend.spawns).toEqual([]);
    });
  }

  it('SHUTTING_DOWN comes first, before the unsupported backend', async () => {
    const r = rig({ backendOptions: { support: { supported: false, reason: 'native-missing' } } });
    r.service.beginDrain();
    expect(await codeOf(r)).toBe('SHUTTING_DOWN');
  });

  it('SESSION_LIMIT', async () => {
    const r = rig({ config: { maxSessions: 1 } });
    await create(r);
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('SESSION_LIMIT');
  });

  const folders: readonly (readonly [string, string])[] = [
    ['an empty text', ''],
    ['a relative path', 'work\\proj'],
    ['a UNC path', '\\\\server\\share\\proj'],
    ['a control character', 'D:\\work\\pr\u0007oj'],
    ['a stream name', 'D:\\work\\proj:evil'],
    ['a device name', 'D:\\work\\NUL'],
  ];
  for (const [label, folder] of folders) {
    it(`FOLDER_INVALID for ${label}`, async () => {
      expect(await codeOf(rig(), { folder })).toBe('FOLDER_INVALID');
    });
  }

  it('FOLDER_NOT_FOUND for a valid path that is no directory', async () => {
    expect(await codeOf(rig(), { folder: 'D:\\work\\missing' })).toBe('FOLDER_NOT_FOUND');
  });

  it('CLAUDE_NOT_FOUND when the command is on no search path', async () => {
    expect(await codeOf(rig({ files: [] }))).toBe('CLAUDE_NOT_FOUND');
  });

  it('CLAUDE_NOT_FOUND for the configured command that does not exist', async () => {
    expect(await codeOf(rig({ config: { command: 'D:\\tools\\other.exe' } }))).toBe('CLAUDE_NOT_FOUND');
  });

  it('COMMAND_UNSUPPORTED for a program that is neither an executable nor a shim', async () => {
    const r = rig({
      files: [`${TOOLS}\\claude.ps1`],
      env: { PATH: TOOLS, PATHEXT: '.ps1', SystemRoot: 'C:\\Windows' },
    });
    expect(await codeOf(r)).toBe('COMMAND_UNSUPPORTED');
  });

  it('ARGS_UNSAFE for a copy without a session to resume', async () => {
    expect(await codeOf(rig(), { folder: FOLDER, fork: true })).toBe('ARGS_UNSAFE');
  });

  it('ARGS_UNSAFE for a resume id that is no session id', async () => {
    expect(await codeOf(rig(), { folder: FOLDER, resume: 'x; calc' })).toBe('ARGS_UNSAFE');
  });

  it('ARGS_UNSAFE for an argument that cmd.exe would expand, on the shim route only', async () => {
    const shim = rig({ files: [CLAUDE_CMD, CMD_EXE], config: { args: ['%PATH%'] } });
    expect(await codeOf(shim)).toBe('ARGS_UNSAFE');
    const direct = rig({ config: { args: ['%PATH%'] } });
    await expect(direct.service.create({ folder: FOLDER })).resolves.toMatchObject({ name: 'proj-1' });
  });

  it('SPAWN_FAILED when the backend throws, without the text of the error', async () => {
    const r = rig();
    r.backend.spawnError = new Error(`File not found: ${CLAUDE_EXE} ${CANARY.key}`);
    const error = await failure(r.service.create({ folder: FOLDER }));
    expect(error.code).toBe('SPAWN_FAILED');
    expect(error.message).not.toContain(CANARY.key);
    expect(error.message).not.toContain(CLAUDE_EXE);
    expect(error.cause).toBeUndefined();
    expect(r.calls.filter((c) => c.event === 'terminal.spawn_failed')).toEqual([
      { level: 'warn', event: 'terminal.spawn_failed', fields: { code: 'SPAWN_FAILED' } },
    ]);
  });

  it('keeps the code of a TerminalError that the backend throws', async () => {
    const r = rig();
    r.backend.spawnError = new TerminalError('NATIVE_LOAD_FAILED');
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('NATIVE_LOAD_FAILED');
  });

  it('SPAWN_FAILED when the child never starts (exit before the first output)', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    const attempt = r.service.create({ folder: FOLDER });
    r.backend.last?.failStart(new Error(`exit 267 in ${CLAUDE_EXE}`));
    const error = await failure(attempt);
    expect(error.code).toBe('SPAWN_FAILED');
    expect(error.message).not.toContain(CLAUDE_EXE);
    expect(error.cause).toBeUndefined();
  });

  it('keeps START_TIMEOUT from the backend', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    const attempt = r.service.create({ folder: FOLDER });
    r.backend.last?.failStart(new TerminalError('START_TIMEOUT'));
    expect((await failure(attempt)).code).toBe('START_TIMEOUT');
  });

  it('START_TIMEOUT when no first output arrives within terminal.startTimeoutMs', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { startTimeoutMs: 4000 } });
    const attempt = r.service.create({ folder: FOLDER });
    const settled = failure(attempt);
    await vi.advanceTimersByTimeAsync(3999);
    expect(r.service.liveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await settled).code).toBe('START_TIMEOUT');
  });

  it('lists a code for every TerminalErrorCode: the service raises them or leaves them to its callers', () => {
    // Raised by `create` (rows above) or by a session reached through `get` (next test).
    const raised: TerminalErrorCode[] = [
      'UNSUPPORTED_OS',
      'NATIVE_MISSING',
      'NATIVE_LOAD_FAILED',
      'CLAUDE_NOT_FOUND',
      'COMMAND_UNSUPPORTED',
      'ARGS_UNSAFE',
      'FOLDER_INVALID',
      'FOLDER_NOT_FOUND',
      'SESSION_LIMIT',
      'SPAWN_FAILED',
      'START_TIMEOUT',
      'SHUTTING_DOWN',
      'SESSION_ENDED',
      'MESSAGE_TOO_LARGE',
    ];
    // Reported by return value (`get` gives undefined, `kill` gives false; the server answers SESSION_NOT_FOUND) or internal
    // to the name allocator (`sessionBase` always makes a valid base, so NAME_INVALID cannot be reached from the service).
    const byValue: TerminalErrorCode[] = ['SESSION_NOT_FOUND', 'NAME_INVALID'];
    expect([...raised, ...byValue].sort()).toEqual([...TERMINAL_ERROR_CODES].sort());
  });

  it('SESSION_ENDED and MESSAGE_TOO_LARGE come from the session that get() returns', async () => {
    const r = rig({ config: { maxInputBytes: 1024 } });
    const { info } = await create(r);
    const session = r.service.get(info.name);
    expect(() => session?.write('x'.repeat(2000))).toThrow(expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }));
    await r.service.kill(info.name);
    expect(() => session?.attach(new TestViewer())).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
  });
});

// ---- failure paths free the slot --------------------------------------------------------------------------------------------

describe('create: a failed start frees the slot and leaves nothing running', () => {
  it('after a synchronous spawn failure', async () => {
    const r = rig({ config: { maxSessions: 1 } });
    r.backend.spawnError = new Error('boom');
    await failure(r.service.create({ folder: FOLDER }));
    expect(r.service.liveCount()).toBe(0);
    r.backend.spawnError = null;
    await expect(r.service.create({ folder: FOLDER })).resolves.toMatchObject({ pid: 1000 });
    expect(r.registry?.added).toHaveLength(1);
  });

  it('after START_TIMEOUT: the process is killed first and nothing is registered', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { maxSessions: 1, startTimeoutMs: 1000 } });
    const attempt = failure(r.service.create({ folder: FOLDER }));
    await vi.advanceTimersByTimeAsync(1000);
    await attempt;
    expect(r.backend.last?.killCalls).toBe(1);
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.added).toEqual([]);
    expect(r.changes).toEqual([]);
    r.backend.ptyOptions = {};
    await expect(r.service.create({ folder: FOLDER })).resolves.toBeDefined();
  });

  it('after the child failed to start: killed, slot free, no event, no registry entry', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { maxSessions: 1 } });
    const attempt = failure(r.service.create({ folder: FOLDER }));
    r.backend.last?.failStart();
    await attempt;
    expect(r.backend.last?.killCalls).toBe(1);
    expect(r.service.liveCount()).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.registry?.added).toEqual([]);
  });

  it('a burnt name is not handed out again: the next session of the folder is -2', async () => {
    const r = rig();
    r.backend.spawnError = new Error('boom');
    await failure(r.service.create({ folder: FOLDER }));
    r.backend.spawnError = null;
    expect((await r.service.create({ folder: FOLDER })).name).toBe('proj-2');
  });

  it('a failure of one create does not touch the others', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    const ok = r.service.create({ folder: FOLDER });
    const bad = failure(r.service.create({ folder: FOLDER }));
    r.backend.spawns[1]?.pty.failStart();
    await bad;
    r.backend.spawns[0]?.pty.start();
    await expect(ok).resolves.toMatchObject({ name: 'proj-1' });
    expect(r.service.liveCount()).toBe(1);
  });
});

// ---- list, get, kill ---------------------------------------------------------------------------------------------------------

describe('list, get, kill', () => {
  it('lists the live sessions sorted by start time, then by name', async () => {
    const r = rig();
    await r.service.create({ folder: 'D:\\work\\other' });
    r.clock.advance(1000);
    await r.service.create({ folder: FOLDER });
    await r.service.create({ folder: 'D:\\work\\other' });
    // same start time: by name, as MTOP sorted them
    expect(r.service.list().map((s) => s.name)).toEqual(['other-1', 'other-2', 'proj-1']);
    r.clock.advance(1);
    await r.service.create({ folder: FOLDER });
    expect(r.service.list().map((s) => s.name)).toEqual(['other-1', 'other-2', 'proj-1', 'proj-2']);
  });

  it('sorts equal start times by the code units of the name, not by the locale', async () => {
    const r = rig({ folders: ['D:\\work\\b', 'D:\\work\\a', 'D:\\work\\B'] });
    await r.service.create({ folder: 'D:\\work\\b' });
    await r.service.create({ folder: 'D:\\work\\a' });
    await r.service.create({ folder: 'D:\\work\\B' });
    expect(r.service.list().map((s) => s.name)).toEqual(['B-1', 'a-1', 'b-1']);
  });

  it('get gives the session that answers info(); an unknown or invalid name gives undefined', async () => {
    const r = rig();
    const { info } = await create(r);
    expect(r.service.get(info.name)?.info()).toEqual(info);
    expect(r.service.get('nope-1')).toBeUndefined();
    expect(r.service.get('../etc')).toBeUndefined();
    expect(r.service.get('')).toBeUndefined();
  });

  it('the session of get shares the output of the pty and reports the viewers', async () => {
    const r = rig();
    const { info, pty } = await create(r);
    const viewer = new TestViewer();
    r.service.get(info.name)?.attach(viewer);
    pty.emitData('hello');
    expect(viewer.text).toContain('hello');
    expect(r.service.list()[0]?.viewers).toBe(1);
    expect(r.changes.map((c) => c.type)).toEqual(['created', 'updated']);
  });

  it('kill ends the session, removes it from the list and the registry, and emits ended', async () => {
    const r = rig();
    const { info } = await create(r);
    await expect(r.service.kill(info.name)).resolves.toBe(true);
    expect(r.service.list()).toEqual([]);
    expect(r.service.get(info.name)).toBeUndefined();
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.removed).toEqual([info.pid]);
    const ended = endedChanges(r);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.exit.reason).toBe('killed');
    expect(ended[0]?.session.name).toBe(info.name);
    expect(ended[0]?.version).toBe(2);
  });

  it('kill gives false for an unknown name, an invalid name and a name that was already killed', async () => {
    const r = rig();
    const { info } = await create(r);
    await expect(r.service.kill('nope-1')).resolves.toBe(false);
    await expect(r.service.kill('../x')).resolves.toBe(false);
    await expect(r.service.kill(info.name)).resolves.toBe(true);
    await expect(r.service.kill(info.name)).resolves.toBe(false);
  });

  it('a session that exits by itself leaves the list and frees its slot', async () => {
    const r = rig({ config: { maxSessions: 1 } });
    const { info, pty } = await create(r);
    pty.emitExit(0);
    expect(r.service.list()).toEqual([]);
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.removed).toEqual([info.pid]);
    expect(endedChanges(r)[0]?.exit).toEqual({ code: 0, reason: 'exited' });
    await expect(r.service.create({ folder: FOLDER })).resolves.toBeDefined();
  });

  it('tells a viewer how the session ended', async () => {
    const r = rig();
    const { info, pty } = await create(r);
    const viewer = new TestViewer();
    r.service.get(info.name)?.attach(viewer);
    pty.emitExit(3);
    expect(viewer.ends).toEqual([{ reason: 'exited', exit: { code: 3, reason: 'exited' } }]);
  });

  it('logs the exit with the pid, the code and the duration', async () => {
    const r = rig();
    const { pty } = await create(r);
    r.clock.advance(2500);
    pty.emitExit(0);
    expect(r.calls.filter((c) => c.event === 'terminal.exited')).toEqual([
      { level: 'info', event: 'terminal.exited', fields: { pid: 1000, code: 0, durationMs: 2500 } },
    ]);
  });
});

// ---- killAll, beginDrain, shutdown --------------------------------------------------------------------------------------------

describe('killAll', () => {
  it('asks every process to end in the same tick, in parallel, and resolves when all are gone', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } } });
    await create(r);
    await create(r);
    await create(r);
    const all = r.service.killAll();
    expect(r.backend.spawns.map((s) => s.pty.killCalls)).toEqual([1, 1, 1]);
    let done = false;
    void all.then(() => {
      done = true;
    });
    r.backend.spawns[0]?.pty.emitExit(1);
    r.backend.spawns[1]?.pty.emitExit(1);
    await settle();
    expect(done).toBe(false);
    r.backend.spawns[2]?.pty.emitExit(1);
    await all;
    expect(r.service.list()).toEqual([]);
    expect(endedChanges(r).map((c) => c.exit.reason)).toEqual(['killed', 'killed', 'killed']);
  });

  it('always resolves, also when a process refuses to die (the session is then declared lost)', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    await create(r);
    const all = r.service.killAll();
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await all;
    expect(r.trees).toEqual([1000]);
    expect(endedChanges(r)[0]?.exit.reason).toBe('lost');
  });

  it('resolves at once when nothing is running', async () => {
    const r = rig();
    await expect(r.service.killAll()).resolves.toBeUndefined();
  });
});

describe('beginDrain', () => {
  it('makes create refuse with SHUTTING_DOWN and leaves what runs alone', async () => {
    const r = rig();
    const { info } = await create(r);
    r.service.beginDrain();
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('SHUTTING_DOWN');
    expect(r.service.liveCount()).toBe(1);
    expect(r.service.get(info.name)).toBeDefined();
    expect(r.backend.spawns).toHaveLength(1);
  });

  it('is idempotent and does not stop the service by itself', async () => {
    const r = rig();
    const { info } = await create(r);
    r.service.beginDrain();
    r.service.beginDrain();
    await expect(r.service.kill(info.name)).resolves.toBe(true);
    expect(r.registry?.closes).toBe(0);
  });

  it('cancels a create that is still starting: the process is killed and the create refused', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    const attempt = failure(r.service.create({ folder: FOLDER }));
    r.service.beginDrain();
    r.backend.last?.start();
    expect((await attempt).code).toBe('SHUTTING_DOWN');
    expect(r.backend.last?.killCalls).toBe(1);
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.added).toEqual([]);
  });
});

describe('shutdown', () => {
  it('refuses new sessions, ends every session as shutdown, closes the registry and leaves no timer', async () => {
    const r = rig();
    const { info } = await create(r);
    await create(r);
    const viewer = new TestViewer();
    r.service.get(info.name)?.attach(viewer);
    await r.service.shutdown();
    expect(r.service.list()).toEqual([]);
    expect(r.service.liveCount()).toBe(0);
    expect(viewer.ends[0]?.reason).toBe('shutdown');
    expect(endedChanges(r).map((c) => c.exit.reason)).toEqual(['shutdown', 'shutdown']);
    expect(r.registry?.closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('SHUTTING_DOWN');
  });

  it('is idempotent: a second call waits for the first and closes the registry once', async () => {
    const r = rig();
    await create(r);
    const first = r.service.shutdown();
    const second = r.service.shutdown();
    await Promise.all([first, second]);
    await r.service.shutdown();
    expect(r.registry?.closes).toBe(1);
  });

  it('resolves when the service never ran anything and has no registry', async () => {
    const r = rig({ registry: false });
    await expect(r.service.shutdown()).resolves.toBeUndefined();
  });

  it('cancels a create that is still starting without waiting for the start timeout', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } }, config: { startTimeoutMs: 60_000 } });
    const attempt = failure(r.service.create({ folder: FOLDER }));
    await r.service.shutdown();
    expect((await attempt).code).toBe('SHUTTING_DOWN');
    expect(r.backend.last?.killCalls).toBe(1);
    expect(r.service.liveCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is bounded: a process that never dies does not keep it past the kill timeout plus the grace', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    await create(r);
    const done = r.service.shutdown();
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await done;
    expect(r.registry?.closes).toBe(1);
  });

  it('survives a registry that fails to close', async () => {
    const r = rig();
    await create(r);
    const registry = r.registry;
    if (registry === null) throw new Error('no registry');
    vi.spyOn(registry, 'close').mockRejectedValue(new Error('disk full'));
    await expect(r.service.shutdown()).resolves.toBeUndefined();
  });
});

// ---- liveCount ----------------------------------------------------------------------------------------------------------------

describe('liveCount (design 01 amendment A4)', () => {
  it('counts starting, live and lost sessions', async () => {
    const r = rig({
      backendOptions: { pty: { autoExitOnKill: false } },
      config: { killTimeoutMs: 1000, maxSessions: 8 },
    });
    // live
    await create(r);
    // lost: the process ignores the kill and the tree kill
    const stubborn = await create(r);
    const ended = r.service.kill(stubborn.info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    expect(endedChanges(r)[0]?.exit.reason).toBe('lost');
    // starting
    r.backend.ptyOptions = { autoStart: false, autoExitOnKill: false };
    const starting = r.service.create({ folder: FOLDER });
    expect(r.service.list().map((s) => s.name)).toEqual(['proj-1']);
    expect(r.service.liveCount()).toBe(3);
    r.backend.last?.start();
    await starting;
    expect(r.service.liveCount()).toBe(3);
  });

  it('stops counting a lost session when its process is gone, and then forgets its registry entry', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    const ended = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    expect(r.service.liveCount()).toBe(1);
    // the registry still lists it: a sweep of a later start can end it
    expect(r.registry?.removed).toEqual([]);
    r.dead.add(info.pid);
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.removed).toEqual([info.pid]);
  });

  it('does not count a lost session whose process is already gone', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    r.dead.add(info.pid);
    const ended = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.removed).toEqual([info.pid]);
  });

  it('a lost session does not take a slot of terminal.maxSessions', async () => {
    const r = rig({
      backendOptions: { pty: { autoExitOnKill: false } },
      config: { killTimeoutMs: 1000, maxSessions: 1 },
    });
    const { info } = await create(r);
    const ended = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    await expect(r.service.create({ folder: FOLDER })).resolves.toBeDefined();
  });

  it('is zero for a service that never started a session', () => {
    expect(rig().service.liveCount()).toBe(0);
  });
});

// ---- the liveness watchdog --------------------------------------------------------------------------------------------------

describe('liveness watchdog (design 01 section 4.3)', () => {
  it('declares a session lost after two consecutive misses and never tree-kills a pid that may be reused', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    expect(WATCHDOG_MISSES).toBe(2);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    expect(r.service.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    // the second miss: the session is told to end, and falls back to lost
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    expect(r.service.list()).toEqual([]);
    expect(endedChanges(r)[0]?.exit).toEqual({ code: null, reason: 'lost' });
    expect(r.trees).toEqual([]);
    expect(r.registry?.removed).toEqual([info.pid]);
    expect(r.service.liveCount()).toBe(0);
  });

  it('tells the viewers when it declares a session lost', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    const viewer = new TestViewer();
    r.service.get(info.name)?.attach(viewer);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(2 * LIVENESS_PROBE_MS + 1000 + KILL_TREE_WAIT_MS);
    expect(viewer.ends).toHaveLength(1);
    expect(viewer.ends[0]?.exit?.reason).toBe('lost');
  });

  it('does not count, probe or kill a pid that another program took after the watchdog found it gone', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(WATCHDOG_MISSES * LIVENESS_PROBE_MS);
    // the session is being ended; a stranger gets the pid before the wait for the exit event is over
    r.dead.delete(info.pid);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    expect(endedChanges(r)[0]?.exit).toEqual({ code: null, reason: 'lost' });
    // the process that the session started is gone, so no lost child is kept for the stranger
    expect(r.service.liveCount()).toBe(0);
    expect(r.registry?.removed).toEqual([info.pid]);
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([]);
    expect(r.trees).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a session that the watchdog is ending out of the exit hook, whose pid may belong to a stranger by now', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const first = await create(r);
    const second = await create(r);
    r.dead.add(first.info.pid);
    await vi.advanceTimersByTimeAsync(WATCHDOG_MISSES * LIVENESS_PROBE_MS);
    // the first session is being ended after two misses and is still listed; the second one is a live child
    expect(r.service.list().map((s) => s.pid)).toEqual([first.info.pid, second.info.pid]);
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([second.info.pid]);
  });

  it('lists no processes for a session that the watchdog is ending', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(WATCHDOG_MISSES * LIVENESS_PROBE_MS);
    await expect(r.service.claudePids(info.name)).resolves.toEqual([]);
    expect(r.lookups).toEqual([]);
  });

  it('one miss followed by a live probe resets the count', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    r.dead.delete(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS + 1000 + KILL_TREE_WAIT_MS);
    expect(r.service.list()).toHaveLength(1);
    expect(r.changes.map((c) => c.type)).toEqual(['created']);
  });

  it('does not touch a session whose exit event arrives', async () => {
    const r = rig();
    const { info, pty } = await create(r);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(5 * LIVENESS_PROBE_MS);
    expect(endedChanges(r)).toHaveLength(1);
    expect(endedChanges(r)[0]?.exit.reason).toBe('exited');
  });

  it('runs only while a session or a lost process exists', async () => {
    const r = rig();
    expect(vi.getTimerCount()).toBe(0);
    const { info } = await create(r);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await r.service.kill(info.name);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps probing a lost process until it is gone', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    const ended = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    r.dead.add(info.pid);
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_MS);
    expect(r.registry?.removed).toEqual([info.pid]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not keep the process alive by itself (the interval is unref-ed)', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const r = rig();
    await create(r);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(LIVENESS_PROBE_MS);
    const handle: unknown = spy.mock.results[0]?.value;
    if (!isTimerHandle(handle)) throw new Error('setInterval did not return a timer');
    expect(handle.hasRef()).toBe(false);
  });
});

// ---- emergencyKillSync -------------------------------------------------------------------------------------------------------

describe('emergencyKillSync', () => {
  it('kills the root pid of every live session synchronously and starts nothing', async () => {
    const r = rig();
    await create(r);
    await create(r);
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([1000, 1001]);
    // no pty.kill(): it forks a helper, which cannot happen while the process exits
    expect(r.backend.spawns.map((s) => s.pty.killCalls)).toEqual([0, 0]);
    expect(r.trees).toEqual([]);
  });

  it('also kills a lost process that is still alive, and skips a session that ended', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const first = await create(r);
    const ended = r.service.kill(first.info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    const second = await create(r);
    second.pty.emitExit(0);
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([first.info.pid]);
  });

  it('never throws, even when the kill of a pid fails, and still reaches the next pid', async () => {
    const r = rig();
    const kills: number[] = [];
    const failing = createTerminalService({
      ...r.deps,
      killSync: (pid) => {
        kills.push(pid);
        throw new Error('EPERM');
      },
    });
    await failing.create({ folder: FOLDER });
    await failing.create({ folder: FOLDER });
    expect(() => {
      failing.emergencyKillSync();
    }).not.toThrow();
    expect(kills).toHaveLength(2);
  });

  it('refuses new sessions afterwards and skips a starting process whose pid is not known yet', async () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    const attempt = failure(r.service.create({ folder: FOLDER }));
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([]);
    r.backend.last?.start();
    expect((await attempt).code).toBe('SHUTTING_DOWN');
    expect((await failure(r.service.create({ folder: FOLDER }))).code).toBe('SHUTTING_DOWN');
  });

  it('does nothing when no session exists', () => {
    const r = rig();
    r.service.emergencyKillSync();
    expect(r.syncKills).toEqual([]);
  });
});

// ---- change events -----------------------------------------------------------------------------------------------------------

describe('onChange', () => {
  it('numbers the changes 1, 2, 3 ... in the order they happen', async () => {
    const r = rig();
    const { info } = await create(r);
    const session = r.service.get(info.name);
    const viewer = new TestViewer();
    session?.attach(viewer);
    session?.detach(viewer);
    session?.resize(100, 40);
    await vi.advanceTimersByTimeAsync(100);
    await r.service.kill(info.name);
    expect(r.changes.map((c) => [c.type, c.version])).toEqual([
      ['created', 1],
      ['updated', 2],
      ['updated', 3],
      ['updated', 4],
      ['ended', 5],
    ]);
    const resized = r.changes[3];
    expect(resized?.session).toMatchObject({ cols: 100, rows: 40, viewers: 0 });
  });

  it('keeps counting when nobody listens', async () => {
    const r = rig();
    const unsubscribe = r.service.onChange(() => undefined);
    unsubscribe();
    await create(r);
    const late: TerminalChange[] = [];
    r.service.onChange((c) => late.push(c));
    await create(r);
    expect(late.map((c) => c.version)).toEqual([2]);
  });

  it('stops delivering after unsubscribe', async () => {
    const r = rig();
    const seen: TerminalChange[] = [];
    const off = r.service.onChange((c) => seen.push(c));
    await create(r);
    off();
    off();
    await create(r);
    expect(seen).toHaveLength(1);
  });

  it('a listener that throws neither reaches the caller nor the other listeners, and is logged by code only', async () => {
    const r = rig();
    const seen: TerminalChange[] = [];
    r.service.onChange(() => {
      throw new Error(`listener failed for ${CANARY.key}`);
    });
    r.service.onChange((c) => seen.push(c));
    await expect(r.service.create({ folder: FOLDER })).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
    const logged = r.calls.filter((c) => c.event === 'terminal.listener_failed');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('warn');
    expect(JSON.stringify(logged)).not.toContain(CANARY.key);
  });

  it('a listener may call the service from inside a change', async () => {
    const r = rig();
    const counts: number[] = [];
    r.service.onChange(() => counts.push(r.service.liveCount()));
    const { info } = await create(r);
    await r.service.kill(info.name);
    expect(counts).toEqual([1, 0]);
  });

  it('tells the exit of the session in the ended change', async () => {
    const r = rig();
    const { pty } = await create(r);
    pty.emitExit(7);
    const exit: SessionExit | undefined = endedChanges(r)[0]?.exit;
    expect(exit).toEqual({ code: 7, reason: 'exited' });
  });
});

// ---- claudePids --------------------------------------------------------------------------------------------------------------

describe('claudePids', () => {
  function withTree(tree: Record<number, readonly number[] | null | Error>) {
    const asked: number[] = [];
    const r = rig({
      descendants: (root) => {
        asked.push(root);
        const answer = tree[root];
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer ?? null);
      },
    });
    return { r, asked };
  }

  it('answers the root and its descendants, ascending, without duplicates', async () => {
    const { r } = withTree({ 1000: [1500, 1200, 1500, 1000] });
    const { info } = await create(r);
    await expect(r.service.claudePids(info.name)).resolves.toEqual([1000, 1200, 1500]);
  });

  it('asks once per five seconds', async () => {
    const { r, asked } = withTree({ 1000: [1200] });
    const { info } = await create(r);
    await r.service.claudePids(info.name);
    r.clock.advance(CLAUDE_PIDS_TTL_MS - 1);
    await r.service.claudePids(info.name);
    expect(asked).toEqual([1000]);
    r.clock.advance(1);
    await r.service.claudePids(info.name);
    expect(asked).toEqual([1000, 1000]);
  });

  it('lets concurrent callers share one question', async () => {
    const { r, asked } = withTree({ 1000: [1200] });
    const { info } = await create(r);
    const [a, b, c] = await Promise.all([
      r.service.claudePids(info.name),
      r.service.claudePids(info.name),
      r.service.claudePids(info.name),
    ]);
    expect(asked).toEqual([1000]);
    expect([a, b, c]).toEqual([
      [1000, 1200],
      [1000, 1200],
      [1000, 1200],
    ]);
  });

  it('falls back to the root pid when the lookup has no answer or fails', async () => {
    const { r } = withTree({ 1000: null, 1001: new Error('powershell failed') });
    const first = await create(r);
    const second = await create(r);
    await expect(r.service.claudePids(first.info.name)).resolves.toEqual([1000]);
    await expect(r.service.claudePids(second.info.name)).resolves.toEqual([1001]);
  });

  it('answers an empty list for an unknown session and for one that ended', async () => {
    const { r, asked } = withTree({ 1000: [1200] });
    const { info } = await create(r);
    await r.service.claudePids(info.name);
    await expect(r.service.claudePids('nope-1')).resolves.toEqual([]);
    await r.service.kill(info.name);
    await expect(r.service.claudePids(info.name)).resolves.toEqual([]);
    expect(asked).toEqual([1000]);
  });

  it('does not report a stale answer for a session that ended while the question was open', async () => {
    let release: (value: readonly number[]) => void = () => undefined;
    const r = rig({
      descendants: () =>
        new Promise<readonly number[]>((resolve) => {
          release = resolve;
        }),
    });
    const { info } = await create(r);
    const pending = r.service.claudePids(info.name);
    await r.service.kill(info.name);
    release([1200]);
    await expect(pending).resolves.toEqual([1000, 1200]);
    await expect(r.service.claudePids(info.name)).resolves.toEqual([]);
  });
});

// ---- sweepOrphans ------------------------------------------------------------------------------------------------------------

describe('sweepOrphans', () => {
  it('runs the registry sweep and returns its counts', async () => {
    const r = rig();
    if (r.registry !== null) r.registry.sweepResult = { files: 2, killed: 1, skipped: 1 };
    await expect(r.service.sweepOrphans()).resolves.toEqual({ files: 2, killed: 1, skipped: 1 });
    expect(r.registry?.sweeps).toBe(1);
  });

  it('logs counts only, and only when there was something to sweep', async () => {
    const r = rig();
    await r.service.sweepOrphans();
    expect(r.calls.filter((c) => c.event === 'terminal.sweep')).toEqual([]);
    if (r.registry !== null) r.registry.sweepResult = { files: 2, killed: 1, skipped: 1 };
    await r.service.sweepOrphans();
    expect(r.calls.filter((c) => c.event === 'terminal.sweep').map((c) => c.fields)).toEqual([
      { phase: 'files', count: 2 },
      { phase: 'killed', count: 1 },
      { phase: 'skipped', count: 1 },
    ]);
  });

  it('answers zeros without a registry and when the sweep throws', async () => {
    const none = rig({ registry: false });
    await expect(none.service.sweepOrphans()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });
    const broken = rig();
    if (broken.registry !== null) broken.registry.sweepError = new Error('EPERM');
    await expect(broken.service.sweepOrphans()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });
  });
});

// ---- status ------------------------------------------------------------------------------------------------------------------

describe('status', () => {
  it('describes a supported service', async () => {
    const r = rig({ config: { maxSessions: 4, conptyDll: true } });
    await create(r);
    expect(r.service.status()).toEqual({
      supported: true,
      reason: null,
      backend: 'fake',
      claude: { found: true, kind: 'exe', display: CLAUDE_EXE },
      sessions: 1,
      maxSessions: 4,
      conptyDll: true,
    });
  });

  it('gives the reason of an unsupported backend and still says what it found', () => {
    const r = rig({ backendOptions: { support: { supported: false, reason: 'native-missing' } } });
    expect(r.service.status()).toMatchObject({ supported: false, reason: 'native-missing', sessions: 0 });
  });

  it('resolves claude at every call, so an install that happens later is seen', () => {
    const r = rig({ files: [] });
    expect(r.service.status().claude).toEqual({ found: false, kind: null, display: null });
    r.files.add(CLAUDE_EXE);
    expect(r.service.status().claude.found).toBe(true);
  });

  it('shortens the home folder to ~ in the program it shows, and reports a shim as a shim', () => {
    const shim = `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`;
    const r = rig({
      files: [shim],
      env: { PATH: `${HOME}\\AppData\\Roaming\\npm`, PATHEXT: '.cmd', SystemRoot: 'C:\\Windows' },
    });
    expect(r.service.status().claude).toEqual({
      found: true,
      kind: 'shim',
      display: '~\\AppData\\Roaming\\npm\\claude.cmd',
    });
  });

  it('has no kind for a program it cannot start', () => {
    const r = rig({
      files: [`${TOOLS}\\claude.ps1`],
      env: { PATH: TOOLS, PATHEXT: '.ps1', SystemRoot: 'C:\\Windows' },
    });
    expect(r.service.status().claude).toEqual({ found: true, kind: null, display: `${TOOLS}\\claude.ps1` });
  });

  it('counts a starting session in sessions', () => {
    const r = rig({ backendOptions: { pty: { autoStart: false } } });
    void failure(r.service.create({ folder: FOLDER })).catch(() => undefined);
    expect(r.service.status().sessions).toBe(1);
  });
});

describe('claudeFacts and shortenHome', () => {
  const posixFs = {
    isFile: (p: string) => p === '/usr/bin/claude',
    isExecutable: (p: string) => p === '/usr/bin/claude',
  };

  it('finds a program on a POSIX host as an exe', () => {
    expect(
      claudeFacts({
        command: 'claude',
        env: { PATH: '/usr/bin' },
        platform: 'linux',
        fs: posixFs,
        home: '/home/fixture',
      }),
    ).toEqual({ found: true, kind: 'exe', display: '/usr/bin/claude' });
  });

  it('shortens only at a folder boundary and ignores case on Windows', () => {
    expect(shortenHome('C:\\Users\\fixture\\bin\\claude.exe', 'C:\\Users\\fixture', 'win32')).toBe(
      '~\\bin\\claude.exe',
    );
    expect(shortenHome('c:\\users\\FIXTURE\\bin', 'C:\\Users\\fixture', 'win32')).toBe('~\\bin');
    expect(shortenHome('C:\\Users\\fixture', 'C:\\Users\\fixture', 'win32')).toBe('~');
    expect(shortenHome('C:\\Users\\fixture2\\bin', 'C:\\Users\\fixture', 'win32')).toBe('C:\\Users\\fixture2\\bin');
    expect(shortenHome('C:\\Users\\fixture\\bin', 'C:\\Users\\fixture\\', 'win32')).toBe('~\\bin');
    expect(shortenHome('/home/fixture/bin/claude', '/home/fixture', 'linux')).toBe('~/bin/claude');
    expect(shortenHome('/home/Fixture/bin', '/home/fixture', 'linux')).toBe('/home/Fixture/bin');
  });

  it('leaves the path alone for an empty or root home', () => {
    expect(shortenHome('C:\\bin\\claude.exe', '', 'win32')).toBe('C:\\bin\\claude.exe');
    expect(shortenHome('/bin/claude', '/', 'linux')).toBe('/bin/claude');
    expect(shortenHome('C:\\bin\\claude.exe', 'C:\\', 'win32')).toBe('C:\\bin\\claude.exe');
  });
});

// ---- what reaches the log ------------------------------------------------------------------------------------------------------

describe('logging (design 01 section 7)', () => {
  const EVENTS = new Set([
    'terminal.native',
    'terminal.started',
    'terminal.exited',
    'terminal.kill',
    'terminal.spawn_failed',
    'terminal.sweep',
    'terminal.viewer_evicted',
    'terminal.listener_failed',
  ]);
  const SAFE_VALUE = /^[\w.:/@-]{0,128}$/;

  it('uses only the closed list of fields, the events of the design and values the logger accepts', async () => {
    const r = rig({
      backendOptions: { pty: { autoExitOnKill: false } },
      config: { killTimeoutMs: 1000 },
      folders: [`D:\\work\\${CANARY.key}`, FOLDER],
    });
    const named = await r.service.create({ folder: `D:\\work\\${CANARY.key}` });
    const { info, pty } = await create(r);
    const viewer = new TestViewer();
    r.service.get(info.name)?.attach(viewer);
    pty.emitData(`${CANARY.prompt} ${CANARY.toolResult}`);
    r.backend.spawnError = new Error(`File not found ${CLAUDE_EXE} ${CANARY.thinking}`);
    await failure(r.service.create({ folder: FOLDER }));
    r.backend.spawnError = null;
    const killed = r.service.kill(named.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await killed;
    pty.emitExit(0);
    expect(r.calls.length).toBeGreaterThan(4);
    for (const call of r.calls) {
      expect(EVENTS.has(call.event), call.event).toBe(true);
      for (const [key, value] of Object.entries(call.fields ?? {})) {
        expect(LOG_FIELD_NAMES as readonly string[], key).toContain(key);
        if (typeof value === 'string') expect(value).toMatch(SAFE_VALUE);
      }
    }
    const everything = JSON.stringify(r.calls);
    for (const canary of Object.values(CANARY)) expect(everything).not.toContain(canary);
    // JSON writes a backslash twice: look for the text as it is and as JSON spells it
    for (const text of ['proj-1', named.name, FOLDER, CLAUDE_EXE, 'D:\\']) {
      expect(everything).not.toContain(text);
      expect(everything).not.toContain(JSON.stringify(text).slice(1, -1));
    }
  });

  it('writes nothing that names a folder, a session or terminal output into a real log file', async () => {
    const dir = tempDir('terminal-log').path;
    const file = join(dir, 'runtime.log');
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const logger = createLogger({ file, level: 'debug', rotate: false, clock });
    const r = rig({
      logger,
      clock,
      folders: [`D:\\work\\${CANARY.key}`],
      backendOptions: { pty: { autoExitOnKill: false } },
      config: { killTimeoutMs: 1000 },
    });
    const info = await r.service.create({ folder: `D:\\work\\${CANARY.key}` });
    const pty = ptyOf(r, info);
    pty.emitData(`${CANARY.prompt}\r\n${CANARY.toolResult}\r\n`);
    r.backend.spawnError = new Error(`failed at ${CLAUDE_EXE} ${CANARY.envToken}`);
    await failure(r.service.create({ folder: `D:\\work\\${CANARY.key}` }));
    const killed = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await killed;
    vi.useRealTimers();
    await logger.close();
    expect(scanForCanaries([file], [])).toEqual([]);
    expect(scanFilesFor([file], [info.name, 'D:\\work', CLAUDE_EXE, 'xterm'])).toEqual([]);
    expect(scanFilesFor([file], ['terminal.started', 'terminal.spawn_failed', 'terminal.kill'])).toHaveLength(3);
  });

  it('logs a kill that has to escalate by phase and pid only', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const { info } = await create(r);
    const killed = r.service.kill(info.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await killed;
    expect(r.calls.filter((c) => c.event === 'terminal.kill').map((c) => [c.level, c.fields])).toEqual([
      ['info', { pid: 1000, phase: 'request' }],
      ['warn', { pid: 1000, phase: 'escalate' }],
      ['error', { pid: 1000, phase: 'lost' }],
    ]);
  });

  it('logs the eviction of a slow viewer by code', async () => {
    const r = rig();
    const { info, pty } = await create(r);
    const viewer = new TestViewer();
    viewer.send = () => {
      throw new Error('peer gone');
    };
    r.service.get(info.name)?.attach(viewer, { replay: false });
    pty.emitData('x');
    expect(r.calls.filter((c) => c.event === 'terminal.viewer_evicted').map((c) => c.fields)).toEqual([
      { code: 'error' },
    ]);
  });
});

describe('replay is bounded per session by terminal.replayBytes', () => {
  it('keeps the tail of a large output within the configured size', async () => {
    const r = rig({ config: { replayBytes: 64 * 1024 } });
    const { info, pty } = await create(r);
    for (let i = 0; i < 40; i += 1) pty.emitData('a'.repeat(8000));
    const viewer = new TestViewer();
    const attached = r.service.get(info.name)?.attach(viewer);
    expect(attached?.replayedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(attached?.replayedBytes).toBeGreaterThan(48 * 1024);
  });
});
