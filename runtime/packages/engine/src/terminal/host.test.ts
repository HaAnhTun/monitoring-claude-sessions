// The terminal host (CAW-31, design 02 section 8, design 03 5.4 and 6, ADR 0084): the engine object that the server's terminal
// ports are made of. The terminal service is the real one over `FakePtyBackend`; the folder service and the linker are scripts.
// Nothing here starts a process or touches the disk.
import { TerminalSectionSchema, TerminalSessionInfoSchema, type TerminalLink, type TerminalSection } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResumeRefusal, type ResumePlan } from '../folders/resume.ts';
import type { TerminalLinker, TerminalProbe } from '../link/types.ts';
import { TerminalError } from './errors.ts';
import { FakePtyBackend, type FakePty, type FakePtyBackendOptions } from './fake-pty.ts';
import {
  TerminalApiError,
  capabilitiesOf,
  createTerminalHost,
  type HostExit,
  type HostViewer,
  type TerminalHost,
} from './host.ts';
import { createTerminalService, type TerminalDeps, type TerminalService } from './manager.ts';
import { KILL_TREE_WAIT_MS } from './session.ts';
import type { UnsupportedReason } from './types.ts';

// FIXTURE: invented paths, names and ids.
const TOOLS = 'C:\\tools';
const CLAUDE_EXE = `${TOOLS}\\claude.exe`;
const FOLDER = 'D:\\work\\proj';
const OTHER = 'D:\\work\\other';
const SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

class FakeLinker implements Pick<TerminalLinker, 'track' | 'forget' | 'link' | 'onChange'> {
  readonly tracked: TerminalProbe[] = [];
  readonly forgotten: string[] = [];
  readonly links = new Map<string, TerminalLink>();
  readonly listeners = new Set<(name: string, link: TerminalLink) => void>();

  track(probe: TerminalProbe): void {
    this.tracked.push(probe);
  }

  forget(name: string): void {
    this.forgotten.push(name);
  }

  link(name: string): TerminalLink | null {
    return this.links.get(name) ?? null;
  }

  onChange(listener: (name: string, link: TerminalLink) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(name: string, link: TerminalLink): void {
    this.links.set(name, link);
    for (const listener of [...this.listeners]) listener(name, link);
  }
}

function linkedLink(): TerminalLink {
  return {
    status: 'linked',
    sessionId: SESSION_ID,
    previousSessionIds: [],
    basis: 'registry-pid',
    confidence: 'high',
    since: '2026-01-01T00:00:01.000Z',
    claudePid: 4242,
    transcript: 'tracked',
    registryStatus: 'idle',
    waitingFor: null,
    reason: null,
    shared: false,
  };
}

function plan(over: Partial<ResumePlan> = {}): ResumePlan {
  return {
    sessionId: SESSION_ID,
    folderPath: FOLDER,
    folderKey: 'd--work-proj',
    args: ['--resume', SESSION_ID],
    mode: 'resume',
    expectsSameId: true,
    redirectTo: null,
    ...over,
  };
}

class TestViewer implements HostViewer {
  readonly chunks: Buffer[] = [];
  readonly sizes: { cols: number; rows: number }[] = [];
  readonly exits: HostExit[] = [];

  onData(chunk: Uint8Array): void {
    this.chunks.push(Buffer.from(chunk));
  }

  onSize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }

  onExit(exit: HostExit): void {
    this.exits.push(exit);
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

interface RigOptions {
  readonly config?: Partial<TerminalSection>;
  readonly support?: { supported: false; reason: UnsupportedReason };
  readonly backendOptions?: FakePtyBackendOptions;
  readonly files?: readonly string[];
  readonly folders?: readonly string[];
  readonly picker?: { pick: (signal: AbortSignal) => Promise<string | null> } | null;
}

function rig(o: RigOptions = {}) {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const backend = new FakePtyBackend({
    ...o.backendOptions,
    ...(o.support === undefined ? {} : { support: o.support }),
  });
  const files = new Set(o.files ?? [CLAUDE_EXE]);
  const folders = new Set(o.folders ?? [FOLDER, OTHER]);
  const dead = new Set<number>();
  const deps: TerminalDeps = {
    backend,
    config: { ...TerminalSectionSchema.parse(undefined), ...o.config },
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    clock,
    platform: 'win32',
    env: () => ({ PATH: TOOLS, PATHEXT: '.exe;.cmd', SystemRoot: 'C:\\Windows' }),
    fs: { isDirectory: (p) => folders.has(p), isFile: (p) => files.has(p) },
    killTree: () => Promise.resolve(),
    killSync: () => undefined,
    pidAlive: (pid) => !dead.has(pid),
    descendants: () => Promise.resolve(null),
    registry: null,
    home: 'C:\\Users\\fixture',
  };
  const service: TerminalService = createTerminalService(deps);
  const linker = new FakeLinker();
  const planResume = vi.fn<(id: string, o?: { fork?: boolean }) => Promise<ResumePlan>>(() => Promise.resolve(plan()));
  const pick = vi.fn<(signal: AbortSignal) => Promise<string | null>>(() => Promise.resolve(null));
  const picker = o.picker === undefined ? { pick } : o.picker;
  const host: TerminalHost = createTerminalHost({ service, folders: { planResume }, linker, picker, clock });
  return { host, service, backend, linker, planResume, clock, deps, pick };
}

type Rig = ReturnType<typeof rig>;

function ptyOf(r: Rig, name: string): FakePty {
  const pid = r.service.list().find((s) => s.name === name)?.pid;
  const found = r.backend.spawns.find((s) => s.pty.pid === pid)?.pty;
  if (found === undefined) throw new Error('no pty for this session');
  return found;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('sessions.create: the row of a new session', () => {
  it('starts claude in the folder and answers with a row that matches the contract', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    expect(TerminalSessionInfoSchema.parse(row)).toEqual(row);
    expect(row).toEqual({
      name: 'proj-1',
      path: FOLDER,
      createdAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
      cols: 120,
      rows: 30,
      viewers: 0,
      link: row.link,
      folderKey: 'd--work-proj',
    });
    expect(row.link).toMatchObject({ status: 'pending', sessionId: null, transcript: 'none', shared: false });
    expect(r.backend.spawns[0]?.cwd).toBe(FOLDER);
    expect(r.backend.spawns[0]?.args).toEqual([]);
  });

  it('tracks the link right after the create, with the pid, the folder and a spawn time taken before the create', async () => {
    const r = rig();
    const before = r.clock.now();
    const pending = r.host.sessions.create({ path: FOLDER });
    r.clock.advance(5000);
    const row = await pending;
    expect(r.linker.tracked).toEqual([
      {
        name: row.name,
        pid: 1000,
        cwd: FOLDER,
        spawnedAtMs: before,
        resumeSessionId: null,
        fork: false,
        nameToken: null,
      },
    ]);
  });

  it('tracks before the caller hears of the session (the link never misses a start)', async () => {
    const r = rig();
    const order: string[] = [];
    void r.host.sessions.create({ path: FOLDER }).then(() => order.push('resolved'));
    const original = r.linker.track.bind(r.linker);
    r.linker.track = (probe) => {
      order.push('track');
      original(probe);
    };
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['track', 'resolved']);
  });

  it('shows the link the linker holds', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    r.linker.links.set(row.name, linkedLink());
    expect(r.host.sessions.list()[0]?.link).toEqual(linkedLink());
  });

  it('gives no folder key for a folder name that Claude cuts (the key would be a prefix of a longer one)', async () => {
    const long = ['D:', 'a'.repeat(120), 'b'.repeat(100)].join(String.fromCharCode(92));
    const r = rig({ folders: [long] });
    const row = await r.host.sessions.create({ path: long });
    expect(row.folderKey).toBeNull();
  });

  it('keeps the engine error for a folder that is not a folder (the server maps it)', async () => {
    const r = rig();
    const error = await failure(r.host.sessions.create({ path: 'D:\\work\\missing' }));
    expect(error).toBeInstanceOf(TerminalError);
    expect((error as TerminalError).code).toBe('FOLDER_NOT_FOUND');
    expect(r.linker.tracked).toHaveLength(0);
  });

  it('answers terminal_limit when the per-instance cap is reached, and tracks nothing for the refused one', async () => {
    const r = rig({ config: { maxSessions: 2 } });
    await r.host.sessions.create({ path: FOLDER });
    await r.host.sessions.create({ path: OTHER });
    const error = await failure(r.host.sessions.create({ path: FOLDER }));
    expect(error).toBeInstanceOf(TerminalApiError);
    expect((error as TerminalApiError).code).toBe('terminal_limit');
    expect(r.linker.tracked).toHaveLength(2);
  });
});

describe('the end of a session', () => {
  it('forgets the link when the process exits, and the row leaves the list', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    ptyOf(r, row.name).emitExit(0);
    expect(r.linker.forgotten).toEqual([row.name]);
    expect(r.host.sessions.list()).toEqual([]);
    expect(r.host.sessions.get(row.name)).toBeNull();
  });

  it('forgets the link before it tells the listeners, so that a list read in the callback is already without it', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const seen: { forgotten: number; listed: number }[] = [];
    r.host.sessions.subscribe(() => {
      seen.push({ forgotten: r.linker.forgotten.length, listed: r.host.sessions.list().length });
    });
    ptyOf(r, row.name).emitExit(0);
    expect(seen.at(-1)).toEqual({ forgotten: 1, listed: 0 });
  });

  it('kill: true for a live session and its viewers hear killed: true; false for an unknown name', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const viewer = new TestViewer();
    r.host.sessions.get(row.name)?.attach(viewer);
    expect(await r.host.sessions.kill(row.name)).toBe(true);
    expect(viewer.exits).toHaveLength(1);
    expect(viewer.exits[0]).toMatchObject({ killed: true, signal: null });
    expect(await r.host.sessions.kill('nothing-9')).toBe(false);
    expect(r.linker.forgotten).toEqual([row.name]);
  });

  it('a process that exits by itself ends its viewers with its code and killed: false', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const viewer = new TestViewer();
    r.host.sessions.get(row.name)?.attach(viewer);
    ptyOf(r, row.name).emitExit(3);
    expect(viewer.exits).toEqual([{ code: 3, signal: null, killed: false }]);
  });

  it('a stop of the service (shutdown) ends the viewers without the word killed', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const viewer = new TestViewer();
    r.host.sessions.get(row.name)?.attach(viewer);
    await r.service.shutdown();
    expect(viewer.exits).toHaveLength(1);
    expect(viewer.exits[0]?.killed).toBe(false);
  });
});

describe('attach: the snapshot and the subscription in one synchronous call', () => {
  it('replays what was printed before, then forwards what comes after, with no byte lost or doubled', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const pty = ptyOf(r, row.name);
    pty.emitData('before one ');
    pty.emitData('before two ');
    const viewer = new TestViewer();
    const attachment = r.host.sessions.get(row.name)?.attach(viewer);
    if (attachment === undefined) throw new Error('no attachment');
    expect(Buffer.from(attachment.replay).toString('utf8')).toBe('before one before two ');
    expect(viewer.text).toBe('');
    pty.emitData('after');
    expect(viewer.text).toBe('after');
    expect(Buffer.from(attachment.replay).toString('utf8')).not.toContain('after');
    expect({ cols: attachment.cols, rows: attachment.rows }).toEqual({ cols: 120, rows: 30 });
  });

  it('is an empty replay for a session that printed nothing', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const attachment = r.host.sessions.get(row.name)?.attach(new TestViewer());
    expect(attachment?.replay.byteLength).toBe(0);
  });

  it('joins several viewers, counts them in the row and lets each one leave on its own', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const port = r.host.sessions.get(row.name);
    const a = new TestViewer();
    const b = new TestViewer();
    const attachA = port?.attach(a);
    port?.attach(b);
    expect(r.host.sessions.list()[0]?.viewers).toBe(2);
    attachA?.detach();
    attachA?.detach();
    expect(r.host.sessions.list()[0]?.viewers).toBe(1);
    ptyOf(r, row.name).emitData('x');
    expect(a.text).toBe('');
    expect(b.text).toBe('x');
  });

  it('throws SESSION_ENDED for a session that ended between the get and the attach', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const port = r.host.sessions.get(row.name);
    ptyOf(r, row.name).emitExit(0);
    const error = (() => {
      try {
        port?.attach(new TestViewer());
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(TerminalError);
    expect((error as TerminalError).code).toBe('SESSION_ENDED');
  });

  it('ends a viewer that throws from onData, with the reason as the signal and no exit code', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const exits: HostExit[] = [];
    r.host.sessions.get(row.name)?.attach({
      onData: () => {
        throw new Error('dead peer');
      },
      onSize: () => undefined,
      onExit: (exit) => exits.push(exit),
    });
    ptyOf(r, row.name).emitData('x');
    expect(exits).toEqual([{ code: null, signal: 'error', killed: false }]);
  });

  it('passes input and size to the process', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const port = r.host.sessions.get(row.name);
    port?.write(new TextEncoder().encode('hello'));
    expect(ptyOf(r, row.name).writtenText).toBe('hello');
    port?.resize(100, 40);
    await vi.advanceTimersByTimeAsync(200);
    expect(ptyOf(r, row.name).sizes.at(-1)).toEqual({ cols: 100, rows: 40 });
  });

  it('tells every attached viewer of an applied resize once, and a viewer that came later at that size is not told', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const port = r.host.sessions.get(row.name);
    const first = new TestViewer();
    port?.attach(first);
    port?.resize(100, 40);
    await vi.advanceTimersByTimeAsync(200);
    expect(first.sizes).toEqual([{ cols: 100, rows: 40 }]);
    const late = new TestViewer();
    const attachment = port?.attach(late);
    expect({ cols: attachment?.cols, rows: attachment?.rows }).toEqual({ cols: 100, rows: 40 });
    expect(late.sizes).toEqual([]);
    // a change of the viewer count is an update too, but the size is the same: nobody is told again
    expect(first.sizes).toHaveLength(1);
  });
});

describe('resume: the plan of the folder service, then a terminal', () => {
  it('asks the plan with the fork flag and starts claude --resume <id> in the planned folder, tracked as a resume', async () => {
    const r = rig();
    const row = await r.host.resume({ sessionId: SESSION_ID, fork: false });
    expect(r.planResume).toHaveBeenCalledWith(SESSION_ID, { fork: false });
    expect(r.backend.spawns[0]?.cwd).toBe(FOLDER);
    expect(r.backend.spawns[0]?.args).toEqual(['--resume', SESSION_ID]);
    expect(r.linker.tracked[0]).toMatchObject({ name: row.name, resumeSessionId: SESSION_ID, fork: false });
  });

  it('a copy adds --fork-session and is tracked as a fork', async () => {
    const r = rig();
    r.planResume.mockResolvedValueOnce(
      plan({ args: ['--resume', SESSION_ID, '--fork-session'], mode: 'fork', expectsSameId: false }),
    );
    await r.host.resume({ sessionId: SESSION_ID, fork: true });
    expect(r.planResume).toHaveBeenCalledWith(SESSION_ID, { fork: true });
    expect(r.backend.spawns[0]?.args).toEqual(['--resume', SESSION_ID, '--fork-session']);
    expect(r.linker.tracked[0]).toMatchObject({ resumeSessionId: SESSION_ID, fork: true });
  });

  it.each([
    ['transcript_gone'],
    ['folder_missing'],
    ['folder_unknown'],
    ['live_in_terminal'],
    ['live_elsewhere'],
  ] as const)(
    'maps the refusal %s to resume_unavailable with the reason as the issue, and starts nothing',
    async (code) => {
      const r = rig();
      r.planResume.mockRejectedValueOnce(new ResumeRefusal(code, code === 'live_in_terminal' ? 'proj-9' : null));
      const error = await failure(r.host.resume({ sessionId: SESSION_ID, fork: false }));
      expect(error).toBeInstanceOf(TerminalApiError);
      expect(error).toMatchObject({
        name: 'TerminalError',
        code: 'resume_unavailable',
        details: [{ path: 'sessionId', issue: code }],
      });
      expect((error as Error).message).not.toContain('proj-9');
      expect(r.backend.spawns).toHaveLength(0);
      expect(r.linker.tracked).toHaveLength(0);
    },
  );

  it('keeps session_not_found for a session the monitor does not know', async () => {
    const r = rig();
    r.planResume.mockRejectedValueOnce(new ResumeRefusal('session_not_found'));
    const error = await failure(r.host.resume({ sessionId: SESSION_ID, fork: false }));
    expect(error).toMatchObject({ name: 'TerminalError', code: 'session_not_found' });
    expect((error as TerminalApiError).details).toBeUndefined();
  });

  it('lets any other failure of the plan through untouched', async () => {
    const r = rig();
    const boom = new Error('disk');
    r.planResume.mockRejectedValueOnce(boom);
    expect(await failure(r.host.resume({ sessionId: SESSION_ID, fork: false }))).toBe(boom);
  });

  it('is terminal_limit at the cap, and the engine error of a folder that vanished after the plan', async () => {
    const full = rig({ config: { maxSessions: 1 } });
    await full.host.sessions.create({ path: OTHER });
    expect(await failure(full.host.resume({ sessionId: SESSION_ID, fork: false }))).toMatchObject({
      code: 'terminal_limit',
    });
    const gone = rig();
    gone.planResume.mockResolvedValueOnce(plan({ folderPath: 'D:\\work\\vanished' }));
    const error = await failure(gone.host.resume({ sessionId: SESSION_ID, fork: false }));
    expect((error as TerminalError).code).toBe('FOLDER_NOT_FOUND');
  });
});

describe('capabilities (the shared reasons)', () => {
  const FOUND = { found: true };
  const MISSING = { found: false };

  it.each([
    ['unsupported-os', 'unsupported_os'],
    ['os-too-old', 'unsupported_os'],
    ['native-missing', 'addon_missing'],
    ['native-load-failed', 'addon_missing'],
  ] as const)('a host that cannot run it (%s) is unavailable with the reason %s', (reason, expected) => {
    expect(capabilitiesOf({ supported: false, reason, claude: FOUND }, { folderPicker: true, maxSessions: 8 })).toEqual(
      { available: false, reason: expected, folderPicker: false, resume: false, maxSessions: 0 },
    );
  });

  it('claude that is not found is claude_not_found, after the host reasons', () => {
    expect(
      capabilitiesOf({ supported: true, reason: null, claude: MISSING }, { folderPicker: true, maxSessions: 8 }),
    ).toEqual({ available: false, reason: 'claude_not_found', folderPicker: false, resume: false, maxSessions: 0 });
    expect(
      capabilitiesOf(
        { supported: false, reason: 'native-missing', claude: MISSING },
        { folderPicker: true, maxSessions: 8 },
      ).reason,
    ).toBe('addon_missing');
  });

  it('a host where everything works says so, with the picker and the cap', () => {
    expect(
      capabilitiesOf({ supported: true, reason: null, claude: FOUND }, { folderPicker: true, maxSessions: 8 }),
    ).toEqual({ available: true, reason: null, folderPicker: true, resume: true, maxSessions: 8 });
    expect(
      capabilitiesOf({ supported: true, reason: null, claude: FOUND }, { folderPicker: false, maxSessions: 3 }),
    ).toEqual({ available: true, reason: null, folderPicker: false, resume: true, maxSessions: 3 });
  });

  it('the host reads the service, so a scripted backend that is unsupported is unavailable', () => {
    const r = rig({ support: { supported: false, reason: 'native-missing' } });
    expect(r.host.capabilities()).toMatchObject({ available: false, reason: 'addon_missing' });
  });

  it('the host without claude on the path is claude_not_found, and with it available with the configured cap', () => {
    expect(rig({ files: [] }).host.capabilities()).toMatchObject({ available: false, reason: 'claude_not_found' });
    expect(rig({ config: { maxSessions: 5 } }).host.capabilities()).toEqual({
      available: true,
      reason: null,
      folderPicker: true,
      resume: true,
      maxSessions: 5,
    });
    expect(rig({ picker: null }).host.capabilities().folderPicker).toBe(false);
  });
});

describe('the picker', () => {
  it('is the folder picker it was given, or null where there is no dialog', () => {
    const r = rig();
    expect(r.host.picker).not.toBeNull();
    expect(rig({ picker: null }).host.picker).toBeNull();
  });
});

describe('census: what a stop must not drop', () => {
  it('counts the live sessions and lists them oldest first with their start as ISO text', async () => {
    const r = rig();
    await r.host.sessions.create({ path: FOLDER });
    r.clock.advance(1000);
    await r.host.sessions.create({ path: OTHER });
    expect(r.host.census.count()).toBe(2);
    expect(r.host.census.sessions(50)).toEqual([
      { name: 'proj-1', startedAt: new Date(FIXTURE_EPOCH_MS).toISOString() },
      { name: 'other-1', startedAt: new Date(FIXTURE_EPOCH_MS + 1000).toISOString() },
    ]);
    expect(r.host.census.sessions(1)).toHaveLength(1);
    expect(r.host.census.sessions(0)).toEqual([]);
  });

  it('counts a session that is still starting', () => {
    const r = rig();
    const backend = new FakePtyBackend({ pty: { autoStart: false } });
    const slow = createTerminalService({ ...r.deps, backend });
    const host = createTerminalHost({
      service: slow,
      folders: { planResume: r.planResume },
      linker: r.linker,
      picker: null,
      clock: r.clock,
    });
    void host.sessions.create({ path: FOLDER }).catch(() => undefined);
    expect(host.census.count()).toBe(1);
    expect(host.census.sessions(50)).toEqual([]);
  });

  it('counts a session that was lost (its process ignored the kill and is no longer watched)', async () => {
    const r = rig({ backendOptions: { pty: { autoExitOnKill: false } }, config: { killTimeoutMs: 1000 } });
    const row = await r.host.sessions.create({ path: FOLDER });
    const ended = r.host.sessions.kill(row.name);
    await vi.advanceTimersByTimeAsync(1000 + KILL_TREE_WAIT_MS);
    await ended;
    expect(r.host.sessions.list()).toEqual([]);
    expect(r.host.census.count()).toBe(1);
    expect(r.host.census.sessions(50)).toEqual([]);
  });

  it('beginDrain stops new sessions (SHUTTING_DOWN) and ends nothing', async () => {
    const r = rig();
    await r.host.sessions.create({ path: FOLDER });
    r.host.census.beginDrain();
    r.host.census.beginDrain();
    const error = await failure(r.host.sessions.create({ path: OTHER }));
    expect((error as TerminalError).code).toBe('SHUTTING_DOWN');
    expect(r.host.census.count()).toBe(1);
  });
});

describe('subscribe: membership and link changes', () => {
  it('runs on a create, on an end and on a change of a link, and no more after the way out is called', async () => {
    const r = rig();
    const calls: string[] = [];
    const stop = r.host.sessions.subscribe(() => calls.push('change'));
    const row = await r.host.sessions.create({ path: FOLDER });
    const afterCreate = calls.length;
    expect(afterCreate).toBeGreaterThan(0);
    r.linker.emit(row.name, linkedLink());
    expect(calls.length).toBe(afterCreate + 1);
    ptyOf(r, row.name).emitExit(0);
    expect(calls.length).toBeGreaterThan(afterCreate + 1);
    stop();
    const stopped = calls.length;
    await r.host.sessions.create({ path: FOLDER });
    r.linker.emit('proj-2', linkedLink());
    expect(calls.length).toBe(stopped);
  });

  it('is not moved by output (a change of membership, a viewer or a link only)', async () => {
    const r = rig();
    const row = await r.host.sessions.create({ path: FOLDER });
    const calls: string[] = [];
    r.host.sessions.subscribe(() => calls.push('change'));
    ptyOf(r, row.name).emitData('output');
    expect(calls).toEqual([]);
  });

  it('isolates a listener that throws', async () => {
    const r = rig();
    const calls: string[] = [];
    r.host.sessions.subscribe(() => {
      throw new Error('listener');
    });
    r.host.sessions.subscribe(() => calls.push('second'));
    await r.host.sessions.create({ path: FOLDER });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('close() takes the host off the service and the linker', async () => {
    const r = rig();
    const calls: string[] = [];
    r.host.sessions.subscribe(() => calls.push('change'));
    r.host.close();
    expect(r.linker.listeners.size).toBe(0);
    await r.service.create({ folder: FOLDER });
    expect(calls).toEqual([]);
  });
});
