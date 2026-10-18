// `ops.lifecycle.*` (01 4.7-4.10, 6.5): start, stop, status, verify, restart and serveForeground with scripted processes, a
// scripted control channel and scripted HTTP, over a real workspace in a temp folder. What a real runtime does with these
// calls is proven by the integration and resilience tests (T-LC-01, 02, 06, 08, 09, 13, 15).
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

import {
  McsError,
  RUNTIME_VERSION,
  StateFileSchema,
  systemClock,
  type CliErrorCode,
  type InstanceFile,
  type StateFile,
} from '@mcs/shared';
import type { ControlRequest } from '@mcs/shared/protocol';
import { buildRepo, buildTaskWorkspace, useTempDirs, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { createLogger, type Logger } from '../log/logger.ts';
import { readRouteFile, routeFilePath } from '../ingest/routes-file.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import {
  restart,
  serveForeground,
  start,
  status,
  stop,
  summarizeSessions,
  verify,
  type LifecycleDeps,
  type ProcessApi,
} from './lifecycle.ts';
import type { ControlAttempt, HttpAttempt, IdentifyResponse, ProbeResult, ProbeState } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();

const ID = '11111111-2222-4333-8444-555555555555';
const PORT = 18123;
const URL_OF = (port: number): string => `http://127.0.0.1:${String(port)}`;
const TOKEN = 'ab'.repeat(32);
const LF = String.fromCharCode(10);
const SERVER_PID = 4242;

// ---- the world: a workspace, a runtime folder, and scripted processes ----------------------------------------------------------

class FakeChild extends EventEmitter {
  pid: number | undefined;
  unrefCalls = 0;
  readonly killedWith: (string | number | undefined)[] = [];

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  kill(signal?: string | number): boolean {
    this.killedWith.push(signal);
    return true;
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly child: FakeChild;
}

interface Options {
  readonly slug?: string;
  readonly config?: Record<string, unknown>;
  readonly runtime?: Record<string, unknown>;
  /** `false`: a pre-4.0 workspace without `instance.json`. */
  readonly instance?: Partial<InstanceFile> | false;
  /** `false`: no server entry in the runtime folder (an unbuilt runtime). */
  readonly built?: boolean;
  readonly stamp?: string;
  readonly noTasks?: boolean;
}

interface World {
  readonly root: string;
  readonly repo: string;
  readonly ctx: OpContext;
  readonly ws: WorkspaceRef;
  readonly runtimeDir: string;
  readonly deps: LifecycleDeps;
  readonly log: { event: string }[];
  // scripts
  probes: ProbeResult[];
  /** What the control channel answers to `shutdown` (default: yes, and the process then exits). */
  controlAnswer: (message: ControlRequest) => ControlAttempt;
  exitOnShutdown: boolean;
  /** The pid survives `forceKill` (a process that cannot be killed). */
  stubborn: boolean;
  httpRoutes: Map<string, HttpAttempt>;
  dbVersion: { userVersion: number; latest: number } | null;
  openResult: boolean;
  // records
  readonly alive: Set<number>;
  readonly commandLines: Map<number, string | null>;
  readonly killed: number[];
  readonly requests: ControlRequest[];
  readonly spawns: SpawnCall[];
  readonly foreground: SpawnCall[];
  readonly opened: string[];
  readonly waits: { pid: number; timeoutMs: number }[];
  readonly probeCalls: { runtimeDir: string | undefined }[];
  /** What the next `spawnDetached` does besides returning a child (write to boot.log, schedule an exit). */
  onSpawn: (child: FakeChild, fds: { stdoutFd: number; stderrFd: number }) => void;
  now(): number;
}

function silentLogger(): { logger: Logger; events: { event: string }[] } {
  const logger = createLogger({ file: null, level: 'error', rotate: false, clock: systemClock });
  return { logger, events: [] };
}

function world(o: Options = {}): World {
  const root = makeTemp('lifecycle').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const slug = o.slug ?? 'demo';
  if (o.noTasks !== true) {
    buildTaskWorkspace(repo, {
      slug,
      config: { title: 'FIXTURE demo', port: PORT, ...o.config },
      ...(o.runtime === undefined ? {} : { runtime: o.runtime }),
      ...(o.instance === false ? {} : { instance: { instanceId: ID, ...o.instance } }),
    });
  }
  const runtimeDir = path.join(root, 'skill', 'runtime');
  mkdirSync(path.join(runtimeDir, 'packages', 'server', 'dist'), { recursive: true });
  if (o.built !== false) writeFileSync(path.join(runtimeDir, 'packages', 'server', 'dist', 'main.js'), '// stand-in\n');
  writeFileSync(
    path.join(runtimeDir, '.mcs-build.json'),
    JSON.stringify({ schemaVersion: 1, runtimeVersion: RUNTIME_VERSION, codeStamp: o.stamp ?? 'abcdef0123' }),
  );
  const { logger, events } = silentLogger();
  const ctx: OpContext = {
    repo,
    root: tasksRoot,
    skillDir: defaultSkillDir(),
    runtimeDir,
    launcherPath: path.join(root, 'skill', 'scripts', 'mcs.mjs'),
    env: { MCS_HOME: path.join(root, 'mcs-home'), PATH: process.env['PATH'] },
    clock: systemClock,
    log: logger,
  };
  let virtual = 0;
  const w: World = {
    root,
    repo,
    ctx,
    ws: o.noTasks === true ? resolveWorkspace(tasksRoot, 'default') : resolveWorkspace(tasksRoot, slug),
    runtimeDir,
    log: events,
    probes: [],
    controlAnswer: () => ({ kind: 'reply', response: { v: 1, ok: true, op: 'shutdown', phase: 'stopping' } }),
    exitOnShutdown: true,
    stubborn: false,
    httpRoutes: new Map(),
    dbVersion: null,
    openResult: true,
    alive: new Set(),
    commandLines: new Map(),
    killed: [],
    requests: [],
    spawns: [],
    foreground: [],
    opened: [],
    waits: [],
    probeCalls: [],
    onSpawn: () => undefined,
    now: () => virtual,
    deps: {},
  };
  const processes: ProcessApi = {
    pidAlive: (pid) => w.alive.has(pid),
    commandLineOf: (pid) => Promise.resolve(w.commandLines.get(pid) ?? null),
    forceKill: (pid) => {
      w.killed.push(pid);
      if (!w.stubborn) w.alive.delete(pid);
      return Promise.resolve();
    },
    waitForExit: (pid, timeoutMs) => {
      w.waits.push({ pid, timeoutMs });
      return Promise.resolve(!w.alive.has(pid));
    },
  };
  const deps: LifecycleDeps = {
    probe: (_ws, probeOptions) => {
      w.probeCalls.push({ runtimeDir: probeOptions?.runtimeDir });
      const script = w.probes;
      const first = script.length > 1 ? script.shift() : script[0];
      if (first === undefined) return Promise.reject(new Error('the test scripted no probe result'));
      return Promise.resolve(first);
    },
    processes,
    control: (_address, message) => {
      w.requests.push(message);
      const answer = w.controlAnswer(message);
      if (answer.kind === 'reply' && message.op === 'shutdown' && w.exitOnShutdown) w.alive.delete(SERVER_PID);
      return Promise.resolve(answer);
    },
    httpGet: (url) => {
      const route = [...w.httpRoutes.entries()].find(([suffix]) => url.endsWith(suffix));
      return Promise.resolve(route?.[1] ?? { ok: false, reason: 'refused' });
    },
    spawnDetached: (file, args, spawnOptions) => {
      const child = new FakeChild(SERVER_PID);
      w.spawns.push({ file, args, cwd: spawnOptions.cwd, env: spawnOptions.env, child });
      w.onSpawn(child, spawnOptions);
      return child as never;
    },
    spawnForeground: (file, args, spawnOptions) => {
      const child = new FakeChild(SERVER_PID);
      w.foreground.push({ file, args, cwd: spawnOptions.cwd, env: spawnOptions.env, child });
      return child as never;
    },
    openUrl: (url) => {
      w.opened.push(url);
      return Promise.resolve(w.openResult);
    },
    peekDb: () => w.dbVersion,
    sleep: async (ms) => {
      virtual += ms;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    now: () => virtual,
  };
  return Object.assign(w, { deps });
}

// ---- builders --------------------------------------------------------------------------------------------------------------------

function identity(over: Partial<IdentifyResponse> = {}): IdentifyResponse {
  return {
    v: 1,
    ok: true,
    op: 'identify',
    instanceId: ID,
    pid: SERVER_PID,
    phase: 'ready',
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
    port: PORT,
    url: URL_OF(PORT),
    startedAt: '2026-10-12T08:00:00.000Z',
    ...over,
  };
}

/** `foreign`: the seven keys of a state file that this runtime did not write (a pre-4.0 monitor's, no `engine`). */
function stateFileOf(pid: number, port = PORT, writer: 'node' | 'foreign' = 'node'): StateFile {
  const base = { pid, url: URL_OF(port), port, started: 1_700_000_000.5, version: '3.0.0', task: 'demo', config: null };
  return StateFileSchema.parse(
    writer === 'node'
      ? {
          ...base,
          schema_version: 1,
          engine: 'node',
          instanceId: ID,
          runtimeVersion: RUNTIME_VERSION,
          codeStamp: 'abcdef0123',
        }
      : base,
  );
}

function probeOf(state: ProbeState, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    state,
    engine: null,
    pid: null,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: `scripted ${state}`,
    ...over,
  };
}

const stopped = (): ProbeResult => probeOf('stopped');

function running(pid = SERVER_PID, port = PORT): ProbeResult {
  const answer = identity({ pid, port, url: URL_OF(port) });
  return probeOf('running', {
    engine: 'node',
    pid,
    url: URL_OF(port),
    port,
    identity: answer,
    stateFile: stateFileOf(pid, port),
  });
}

function hungProbe(pid: number | null): ProbeResult {
  return probeOf('unhealthy', {
    engine: 'node',
    pid,
    reason: 'a runtime holds the control channel but does not answer',
  });
}

function writeState(w: World, state: StateFile): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + LF);
  writeFileSync(path.join(w.ws.dir, 'state.json'), bytes);
  return bytes;
}

function writeToken(w: World): void {
  mkdirSync(path.join(w.ws.dir, 'run'), { recursive: true });
  writeFileSync(path.join(w.ws.dir, 'run', 'control.token'), TOKEN + LF);
}

const fileOf = (w: World, ...parts: string[]): string => path.join(w.ws.dir, ...parts);

const markerLine = (w: World): string =>
  `"node.exe" "${path.join(w.runtimeDir, 'packages', 'server', 'dist', 'main.js')}" serve --mcs-instance=${ID} --instance-dir=${w.ws.dir}`;

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

function expectCode(error: McsError, code: CliErrorCode): void {
  expect(error.code, error.message).toBe(code);
}

/** `start` against a server that comes up: the first probe says stopped, the later ones say running with the child pid. */
function bootsOk(w: World, pid = SERVER_PID): void {
  w.probes = [stopped(), probeOf('starting', { engine: 'node', pid }), running(pid)];
}

// ---- start -------------------------------------------------------------------------------------------------------------------------

describe('start: a stopped instance (01 4.7)', () => {
  it('spawns the detached server with the marker argv and reports started', async () => {
    const w = world();
    bootsOk(w);
    const result = await start(w.ctx, { task: 'demo', port: 18124, logLevel: 'debug' }, w.deps);
    expect(result).toMatchObject({
      outcome: 'started',
      slug: 'demo',
      url: URL_OF(PORT),
      pid: SERVER_PID,
      engine: 'node',
      exitCode: 0,
      message: [`started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`],
    });
    expect(w.spawns).toHaveLength(1);
    const spawn = w.spawns[0];
    expect(spawn?.file).toBe(process.execPath);
    expect(spawn?.args).toEqual([
      path.join(w.runtimeDir, 'packages', 'server', 'dist', 'main.js'),
      'serve',
      `--mcs-instance=${ID}`,
      `--instance-dir=${w.ws.dir}`,
      '--port=18124',
      '--log-level=debug',
    ]);
    expect(spawn?.cwd).toBe(w.ws.dir);
    expect(spawn?.env['MCS_HOOK_DISABLE']).toBe('1');
    expect(spawn?.env['MCS_HOME']).toBe(w.ctx.env['MCS_HOME']);
    expect(spawn?.child.unrefCalls).toBeGreaterThan(0);
  });

  it('passes no --port and no --log-level when none was given (the server reads config.json)', async () => {
    const w = world();
    bootsOk(w);
    await start(w.ctx, { task: 'demo' }, w.deps);
    expect(w.spawns[0]?.args.slice(2)).toEqual([`--mcs-instance=${ID}`, `--instance-dir=${w.ws.dir}`]);
  });

  it('asks the probe about the runtime folder, so that a hung runtime can be found', async () => {
    const w = world();
    bootsOk(w);
    await start(w.ctx, { task: 'demo' }, w.deps);
    expect(w.probeCalls[0]?.runtimeDir).toBe(w.runtimeDir);
  });

  it('rotates logs/boot.log into boot.log.1 and gives the server a fresh boot.log', async () => {
    const w = world();
    mkdirSync(fileOf(w, 'logs'), { recursive: true });
    writeFileSync(fileOf(w, 'logs', 'boot.log'), 'the last boot said this' + LF);
    bootsOk(w);
    w.onSpawn = (_child, fds) => {
      writeSync(fds.stdoutFd, 'this boot says that' + LF);
    };
    await start(w.ctx, { task: 'demo' }, w.deps);
    expect(readFileSync(fileOf(w, 'logs', 'boot.log.1'), 'utf8')).toBe('the last boot said this' + LF);
    expect(readFileSync(fileOf(w, 'logs', 'boot.log'), 'utf8')).toBe('this boot says that' + LF);
  });

  it('gives stdout and stderr the same boot.log descriptor and closes the CLI copy', async () => {
    const w = world();
    bootsOk(w);
    const fds: { stdoutFd: number; stderrFd: number }[] = [];
    w.onSpawn = (_child, pair) => {
      fds.push(pair);
    };
    await start(w.ctx, { task: 'demo' }, w.deps);
    expect(fds).toHaveLength(1);
    expect(fds[0]?.stdoutFd).toBe(fds[0]?.stderrFd);
    expect(() => writeSync(fds[0]?.stdoutFd ?? -1, 'x')).toThrow();
  });

  it('opens the URL when asked, and a browser that cannot be opened is a warning, not a failure', async () => {
    const w = world();
    bootsOk(w);
    const ok = await start(w.ctx, { task: 'demo', open: true }, w.deps);
    expect(w.opened).toEqual([URL_OF(PORT)]);
    expect(ok.opened).toBe(true);
    expect(ok.warnings).toEqual([]);

    const x = world();
    bootsOk(x);
    x.openResult = false;
    const failed = await start(x.ctx, { task: 'demo', open: true }, x.deps);
    expect(failed.exitCode).toBe(0);
    expect(failed.opened).toBe(false);
    expect(failed.warnings).toEqual([`could not open a browser; open ${URL_OF(PORT)}`]);
  });

  it('does not open anything without --open', async () => {
    const w = world();
    bootsOk(w);
    await start(w.ctx, { task: 'demo' }, w.deps);
    expect(w.opened).toEqual([]);
  });

  it('refuses an unknown task with TASK_NOT_FOUND and a hint, spawning nothing', async () => {
    const w = world();
    w.probes = [stopped()];
    const error = await failure(start(w.ctx, { task: 'nope' }, w.deps));
    expectCode(error, 'TASK_NOT_FOUND');
    expect(error.hint).toContain('mcs init');
    expect(w.spawns).toEqual([]);
  });

  it('an unbuilt runtime (no server entry) is START_FAILED with the build hint, spawning nothing', async () => {
    const w = world({ built: false });
    w.probes = [stopped()];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(error.hint).toContain('npm run build');
    expect(w.spawns).toEqual([]);
    expect(existsSync(fileOf(w, 'logs', 'boot.log'))).toBe(false);
  });

  it('a bundle runtime folder starts its mcs-server.mjs (ADR 0062)', async () => {
    const w = world();
    const bundle = path.join(w.root, 'skill', 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'mcs-server.mjs'), '// stand-in\n');
    bootsOk(w);
    const result = await start({ ...w.ctx, runtimeDir: bundle }, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('started');
    expect(w.spawns[0]?.args[0]).toBe(path.join(bundle, 'mcs-server.mjs'));
    expect(w.spawns[0]?.args[1]).toBe('serve');
  });

  it('a bundle without its server entry is START_FAILED with the reinstall hint, spawning nothing', async () => {
    const w = world();
    const bundle = path.join(w.root, 'skill', 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'mcs-cli.mjs'), '// stand-in\n');
    w.probes = [stopped()];
    const error = await failure(start({ ...w.ctx, runtimeDir: bundle }, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(error.message).toContain('mcs-server.mjs');
    expect(error.hint).toContain('reinstall');
    expect(error.hint).not.toContain('npm');
    expect(w.spawns).toEqual([]);
  });
});

describe('start: the default workspace and adoption (01 4.7 step 2, 6.2)', () => {
  it('creates the workspace "default" on demand when no task is given', async () => {
    const w = world({ noTasks: true });
    bootsOk(w);
    const result = await start(w.ctx, {}, w.deps);
    expect(result.slug).toBe('default');
    expect(result.createdDefault).toBe(true);
    expect(result.message[0]).toBe("created default workspace 'default'");
    expect(existsSync(path.join(w.ctx.root, 'default', 'instance.json'))).toBe(true);
    expect(existsSync(path.join(w.ctx.root, 'default', 'task.json'))).toBe(true);
    expect(w.spawns).toHaveLength(1);
  });

  it('uses the workspace "default" when it exists, without creating anything', async () => {
    const w = world({ slug: 'default' });
    bootsOk(w);
    const result = await start(w.ctx, {}, w.deps);
    expect(result.slug).toBe('default');
    expect(result.createdDefault).toBe(false);
    expect(result.message).toEqual([`started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`]);
  });

  it('adopts a legacy workspace: instance.json appears, the legacy files stay byte for byte, and one line says so', async () => {
    const w = world({ instance: false });
    const before = {
      config: readFileSync(fileOf(w, 'config.json')),
      task: readFileSync(fileOf(w, 'task.json')),
    };
    w.probes = [stopped(), running(SERVER_PID)];
    // the identity of an adopted workspace is new: the scripted probe cannot know it, so only the files are checked
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result.adopted).toBe(true);
    expect(result.message).toContain('added Node runtime files: instance.json');
    expect(existsSync(fileOf(w, 'instance.json'))).toBe(true);
    expect(readFileSync(fileOf(w, 'config.json')).equals(before.config)).toBe(true);
    expect(readFileSync(fileOf(w, 'task.json')).equals(before.task)).toBe(true);
    expect(existsSync(fileOf(w, 'runtime.json'))).toBe(false);
    const audit = readFileSync(fileOf(w, 'audit', 'changes.md'), 'utf8');
    expect(audit.match(/adopt-instance/g)).toHaveLength(1);
  });
});

describe('start: what is already there (01 4.7 step 6)', () => {
  it('a running instance: already running, nothing is spawned', async () => {
    const w = world();
    w.probes = [running()];
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'already-running', pid: SERVER_PID, url: URL_OF(PORT), exitCode: 0 });
    expect(result.message).toEqual([`already running: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`]);
    expect(w.spawns).toEqual([]);
    expect(existsSync(fileOf(w, 'logs', 'boot.log'))).toBe(false);
  });

  it('a monitor that this runtime did not start blocks start: INSTANCE_RUNNING names pid and url (ADR 0066)', async () => {
    const w = world();
    w.alive.add(888);
    w.probes = [probeOf('unmanaged-running', { engine: null, pid: 888, url: URL_OF(PORT), port: PORT })];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'INSTANCE_RUNNING');
    expect(error.message).toContain('pid 888');
    expect(error.message).toContain(URL_OF(PORT));
    expect(error.message).toContain('not started by this runtime');
    expect(w.spawns).toEqual([]);
    expect(w.killed).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it('a runtime that answers control but not HTTP is START_FAILED and is not replaced', async () => {
    const w = world();
    w.probes = [probeOf('unhealthy', { engine: 'node', pid: 321, identity: identity({ pid: 321 }) })];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(error.message).toContain('pid 321');
    expect(error.message).toContain('control channel');
    expect(error.hint).toContain('mcs doctor --task demo');
    expect(error.hint).toContain('mcs restart --task demo');
    expect(w.spawns).toEqual([]);
  });

  it('a start in progress by someone else: waits for it and reports an instance that is running', async () => {
    const w = world();
    w.probes = [
      probeOf('starting', { engine: 'node', pid: 321, identity: identity({ pid: 321, phase: 'starting' }) }),
      probeOf('starting', { engine: 'node', pid: 321, identity: identity({ pid: 321, phase: 'starting' }) }),
      running(321),
    ];
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('already-running');
    expect(result.message).toEqual([`already running: ${URL_OF(PORT)} (pid 321)`]);
    expect(w.spawns).toEqual([]);
  });

  it('a start in progress that dies before it is ready is START_FAILED', async () => {
    const w = world();
    w.probes = [
      probeOf('starting', { engine: 'node', pid: 321, identity: identity({ pid: 321, phase: 'starting' }) }),
      stopped(),
    ];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(w.spawns).toEqual([]);
  });

  it('a runtime that is stopping: waits for its exit, then starts', async () => {
    const w = world();
    w.probes = [
      probeOf('stopping', { engine: 'node', pid: 321, identity: identity({ pid: 321, phase: 'stopping' }) }),
      stopped(),
      probeOf('starting', { engine: 'node', pid: SERVER_PID }),
      running(SERVER_PID),
    ];
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('started');
    expect(w.waits[0]?.pid).toBe(321);
    expect(w.spawns).toHaveLength(1);
  });

  it.each(['stale', 'foreign-pid'] as const)('%s: carries on and starts', async (state) => {
    const w = world();
    w.probes = [probeOf(state, { engine: 'node', pid: 999 }), running(SERVER_PID)];
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('started');
    expect(w.spawns).toHaveLength(1);
  });
});

describe('start: checks before anything is spawned (01 4.7 steps 4 and 5, T-LC-02)', () => {
  it('an invalid regex in config.json: nothing is spawned and no boot.log appears', async () => {
    const w = world({ config: { session_rules: [{ match: '(unclosed', label: 'x' }] } });
    w.probes = [stopped()];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expect(['CONFIG_INVALID', 'REGEX_UNSUPPORTED']).toContain(error.code);
    expect(error.message).toContain('session_rules');
    expect(w.spawns).toEqual([]);
    expect(existsSync(fileOf(w, 'logs', 'boot.log'))).toBe(false);
  });

  it('a database newer than this runtime is DB_NEWER_THAN_RUNTIME', async () => {
    const w = world();
    w.dbVersion = { userVersion: 9, latest: 1 };
    w.probes = [stopped()];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'DB_NEWER_THAN_RUNTIME');
    expect(w.spawns).toEqual([]);
  });

  it('a database older than this runtime is DB_UPGRADE_REQUIRED with the upgrade command as the hint', async () => {
    const w = world();
    w.dbVersion = { userVersion: 1, latest: 3 };
    w.probes = [stopped()];
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'DB_UPGRADE_REQUIRED');
    expect(error.hint).toBe('mcs upgrade --task demo --restart');
    expect(w.spawns).toEqual([]);
  });

  it('a database at the current version, none yet, or a fresh file (version 0) starts', async () => {
    for (const dbVersion of [null, { userVersion: 3, latest: 3 }, { userVersion: 0, latest: 3 }]) {
      const w = world();
      w.dbVersion = dbVersion;
      bootsOk(w);
      expect((await start(w.ctx, { task: 'demo' }, w.deps)).outcome).toBe('started');
    }
  });
});

describe('start: a server that does not come up (01 4.7 steps 9 and 11)', () => {
  it('a child that exits during the start: the name of the exit code and the tail of boot.log', async () => {
    const w = world();
    w.probes = [stopped(), probeOf('stopped')];
    w.onSpawn = (child, fds) => {
      const lines = Array.from({ length: 30 }, (_, i) => `boot line ${String(i + 1)}`);
      writeSync(fds.stderrFd, lines.join(LF) + LF);
      setImmediate(() => {
        child.emit('exit', 13, null);
      });
    };
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(error.message.split(LF)[0]).toBe('runtime exited during start (PORT_EXHAUSTED)');
    expect(error.message).toContain('boot line 30');
    expect(error.message).toContain('boot line 11');
    expect(error.message).not.toContain('boot line 10' + LF);
    expect(error.hint).toBe('mcs doctor --task demo');
  });

  it('exit code 12 means a concurrent start won: re-probes and reports the winner', async () => {
    const w = world();
    w.probes = [stopped(), stopped(), running(777)];
    w.onSpawn = (child) => {
      setImmediate(() => {
        child.emit('exit', 12, null);
      });
    };
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('already-running');
    expect(result.pid).toBe(777);
  });

  it('every exit code of 01 4.1 has its name', async () => {
    const names: [number, string][] = [
      [10, 'CONFIG_INVALID'],
      [11, 'IDENTITY_MISMATCH'],
      [14, 'DB_ERROR'],
      [15, 'DB_NEWER_THAN_RUNTIME'],
      [16, 'DB_UPGRADE_REQUIRED'],
      [17, 'WORKSPACE_INVALID'],
      [18, 'BUILD_INVALID'],
      [70, 'INTERNAL'],
    ];
    for (const [code, name] of names) {
      const w = world();
      w.probes = [stopped()];
      w.onSpawn = (child) => {
        setImmediate(() => {
          child.emit('exit', code, null);
        });
      };
      const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
      expect(error.message.split(LF)[0]).toBe(`runtime exited during start (${name})`);
    }
  });

  it('a process that cannot be started at all (ENOENT) is START_FAILED', async () => {
    const w = world();
    w.probes = [stopped()];
    w.onSpawn = (child) => {
      child.pid = undefined;
      setImmediate(() => {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
      });
    };
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_FAILED');
    expect(error.message).toContain('ENOENT');
  });

  it('a timeout kills the child it started, removes the state file that names it and says so (T-LC-08)', async () => {
    const w = world();
    w.probes = [stopped(), probeOf('starting', { engine: 'node', pid: SERVER_PID })];
    w.alive.add(SERVER_PID);
    w.onSpawn = (_child, fds) => {
      writeSync(fds.stderrFd, 'still booting' + LF);
      writeState(w, stateFileOf(SERVER_PID));
    };
    const error = await failure(start(w.ctx, { task: 'demo', timeoutMs: 1500 }, w.deps));
    expectCode(error, 'START_TIMEOUT');
    expect(error.message.split(LF)[0]).toBe('runtime did not become healthy within 1.5 s');
    expect(error.message).toContain('still booting');
    expect(error.hint).toBe('mcs doctor --task demo');
    expect(error.details).toMatchObject({ pid: SERVER_PID, timeoutMs: 1500 });
    expect(w.killed).toEqual([SERVER_PID]);
    expect(w.waits).toContainEqual({ pid: SERVER_PID, timeoutMs: 5000 });
    expect(existsSync(fileOf(w, 'state.json'))).toBe(false);
    expect(w.now()).toBeGreaterThanOrEqual(1500);
  });

  it('a timeout leaves a state file that names another process alone', async () => {
    const w = world();
    w.probes = [stopped(), probeOf('starting', { engine: 'node', pid: SERVER_PID })];
    w.alive.add(SERVER_PID);
    w.onSpawn = () => {
      writeState(w, stateFileOf(31337));
    };
    await failure(start(w.ctx, { task: 'demo', timeoutMs: 1000 }, w.deps));
    expect(existsSync(fileOf(w, 'state.json'))).toBe(true);
  });

  it('uses process.startTimeoutMs of the configuration when --timeout-ms is not given', async () => {
    const w = world({ runtime: { process: { startTimeoutMs: 2000 } } });
    w.probes = [stopped()];
    w.alive.add(SERVER_PID);
    const error = await failure(start(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'START_TIMEOUT');
    expect(error.message.split(LF)[0]).toBe('runtime did not become healthy within 2 s');
  });

  it('is running only when the control channel names this child: another pid keeps it waiting', async () => {
    const w = world();
    w.probes = [stopped(), running(999)];
    w.alive.add(SERVER_PID);
    const error = await failure(start(w.ctx, { task: 'demo', timeoutMs: 1000 }, w.deps));
    expectCode(error, 'START_TIMEOUT');
  });

  it('is running only when state.json names the same pid and port (read back)', async () => {
    const w = world();
    const wrongState: ProbeResult = { ...running(), stateFile: stateFileOf(SERVER_PID, PORT + 1) };
    w.probes = [stopped(), wrongState];
    w.alive.add(SERVER_PID);
    const error = await failure(start(w.ctx, { task: 'demo', timeoutMs: 1000 }, w.deps));
    expectCode(error, 'START_TIMEOUT');
  });
});

describe('start: a state file that this runtime did not write (ADR 0066)', () => {
  it('a pre-4.0 workspace with a live foreign monitor is adopted, then refused, and nothing is signalled', async () => {
    const w = world({ instance: false });
    w.alive.add(888);
    w.probes = [probeOf('unmanaged-running', { engine: null, pid: 888, url: URL_OF(PORT), port: PORT })];
    const error = await failure(start(w.ctx, { task: 'demo', port: 18200 }, w.deps));
    expectCode(error, 'INSTANCE_RUNNING');
    expect(existsSync(fileOf(w, 'instance.json'))).toBe(true);
    expect(w.spawns).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('a foreign state file whose pid is dead is stale: start replaces it with its own runtime', async () => {
    const w = world();
    const file = stateFileOf(888, PORT, 'foreign');
    w.probes = [
      probeOf('stale', { engine: null, pid: 888, stateFile: file, stateFileBytes: writeState(w, file) }),
      running(SERVER_PID),
    ];
    const result = await start(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'started', engine: 'node', exitCode: 0 });
    expect(w.spawns).toHaveLength(1);
    expect(w.killed).toEqual([]);
  });
});

// ---- stop ---------------------------------------------------------------------------------------------------------------------------

describe('stop: nothing to stop and stale files (01 4.9)', () => {
  it('no state file: nothing to stop, exit 0 (legacy text)', async () => {
    const w = world();
    w.probes = [stopped()];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'nothing-to-stop', exitCode: 0 });
    expect(result.message).toEqual([`nothing to stop (no state file ${fileOf(w, 'state.json')})`]);
    expect(w.killed).toEqual([]);
  });

  it.each(['stale', 'foreign-pid'] as const)(
    '%s: removes the state file, says nothing was killed, and kills nothing',
    async (state) => {
      const w = world();
      const file = stateFileOf(999);
      const bytes = writeState(w, file);
      w.probes = [probeOf(state, { engine: 'node', pid: 999, stateFile: file, stateFileBytes: bytes })];
      w.alive.add(999);
      const result = await stop(w.ctx, { task: 'demo' }, w.deps);
      expect(result.outcome).toBe('stale-removed');
      expect(result.exitCode).toBe(0);
      expect(result.message).toEqual([
        "pid 999 is not this instance's runtime (already stopped or pid reused); removed the stale state file, nothing was killed",
      ]);
      expect(existsSync(fileOf(w, 'state.json'))).toBe(false);
      expect(w.killed).toEqual([]);
      expect(w.requests).toEqual([]);
    },
  );

  it('does not delete a state file that changed after the probe (compare-and-delete)', async () => {
    const w = world();
    const file = stateFileOf(999);
    const bytes = writeState(w, file);
    w.probes = [probeOf('stale', { engine: 'node', pid: 999, stateFile: file, stateFileBytes: bytes })];
    writeState(w, stateFileOf(1001));
    await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(existsSync(fileOf(w, 'state.json'))).toBe(true);
  });

  it('without --task and without a default workspace: no default instance', async () => {
    const w = world({ noTasks: true });
    w.probes = [stopped()];
    const error = await failure(stop(w.ctx, {}, w.deps));
    expectCode(error, 'TASK_NOT_FOUND');
    expect(error.message).toBe('no default instance (use --task)');
    expect(existsSync(path.join(w.ctx.root, 'default'))).toBe(false);
  });
});

describe('stop: the graceful path (01 4.9)', () => {
  it('sends shutdown with the token of the instance, waits for the exit and cleans up', async () => {
    const w = world();
    writeToken(w);
    const file = stateFileOf(SERVER_PID);
    writeState(w, file);
    w.alive.add(SERVER_PID);
    w.probes = [running()];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'stopped', forced: false, exitCode: 0, pid: SERVER_PID });
    expect(result.message).toEqual([`stopped runtime pid ${String(SERVER_PID)} (${URL_OF(PORT)})`]);
    expect(w.requests).toEqual([{ v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'stop' }]);
    expect(w.killed).toEqual([]);
    expect(w.waits[0]).toEqual({ pid: SERVER_PID, timeoutMs: 10_000 });
    // the server removes its state file itself; one that still names the pid is removed by the CLI
    expect(existsSync(fileOf(w, 'state.json'))).toBe(false);
  });

  it('never puts the token in a result', async () => {
    const w = world();
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [running()];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('--timeout-ms is the wait for the exit, and process.stopTimeoutMs of the configuration is the default', async () => {
    const w = world({ runtime: { process: { stopTimeoutMs: 7000 } } });
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [running()];
    await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(w.waits[0]?.timeoutMs).toBe(7000);
    const x = world();
    writeToken(x);
    x.alive.add(SERVER_PID);
    x.probes = [running()];
    await stop(x.ctx, { task: 'demo', timeoutMs: 1234 }, x.deps);
    expect(x.waits[0]?.timeoutMs).toBe(1234);
  });

  it('an invalid configuration does not stop `stop` from stopping (the default timeout applies)', async () => {
    const w = world({ config: { session_rules: [{ match: '(unclosed', label: 'x' }] } });
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [running()];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('stopped');
    expect(w.waits[0]?.timeoutMs).toBe(10_000);
  });

  it('a runtime that is stopping is only waited for: no request is sent', async () => {
    const w = world();
    w.probes = [
      probeOf('stopping', {
        engine: 'node',
        pid: SERVER_PID,
        url: URL_OF(PORT),
        identity: identity({ phase: 'stopping' }),
      }),
    ];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('stopped');
    expect(w.requests).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('a runtime that is starting is asked to shut down like a running one', async () => {
    const w = world();
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [probeOf('starting', { engine: 'node', pid: SERVER_PID, identity: identity({ phase: 'starting' }) })];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('stopped');
    expect(w.requests).toHaveLength(1);
  });

  it('control answers but HTTP does not (unhealthy with an identity): still the graceful path first', async () => {
    const w = world();
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [probeOf('unhealthy', { engine: 'node', pid: SERVER_PID, identity: identity() })];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'stopped', forced: false });
  });
});

describe('stop: the forced path verifies the marker before any kill (01 4.9, ADR 0006, T-LC-06)', () => {
  it('kills a runtime that carries the marker when the shutdown is refused', async () => {
    const w = world();
    writeToken(w);
    writeState(w, stateFileOf(SERVER_PID));
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.controlAnswer = () => ({ kind: 'refusal', error: 'FORBIDDEN' });
    w.probes = [running()];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ outcome: 'stopped-forced', forced: true, exitCode: 0 });
    expect(result.message).toEqual([
      `stopped runtime pid ${String(SERVER_PID)} (${URL_OF(PORT)}) (forced: shutdown refused (FORBIDDEN))`,
    ]);
    expect(w.killed).toEqual([SERVER_PID]);
    expect(w.waits).toContainEqual({ pid: SERVER_PID, timeoutMs: 5000 });
    expect(existsSync(fileOf(w, 'state.json'))).toBe(false);
    expect(existsSync(fileOf(w, 'run', 'control.token'))).toBe(false);
  });

  it('kills a hung runtime straight away, without a shutdown request', async () => {
    const w = world();
    writeToken(w);
    writeState(w, stateFileOf(SERVER_PID));
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.probes = [hungProbe(SERVER_PID)];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('stopped-forced');
    expect(result.reason).toContain('control channel');
    expect(w.requests).toEqual([]);
    expect(w.killed).toEqual([SERVER_PID]);
  });

  it('goes to the forced path when there is no token, when the channel is gone, or when it is silent', async () => {
    for (const how of ['no-token', 'absent', 'silent'] as const) {
      const w = world();
      if (how !== 'no-token') writeToken(w);
      w.alive.add(SERVER_PID);
      w.exitOnShutdown = false;
      w.commandLines.set(SERVER_PID, markerLine(w));
      w.controlAnswer = () => (how === 'silent' ? { kind: 'silent', reason: 'timeout' } : { kind: 'absent' });
      w.probes = [running()];
      const result = await stop(w.ctx, { task: 'demo' }, w.deps);
      expect(result.outcome, how).toBe('stopped-forced');
      expect(w.killed, how).toEqual([SERVER_PID]);
    }
  });

  it('a runtime that is still alive at the deadline after an accepted shutdown is killed', async () => {
    const w = world();
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.exitOnShutdown = false;
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.probes = [running()];
    const result = await stop(w.ctx, { task: 'demo', timeoutMs: 1500 }, w.deps);
    expect(result.outcome).toBe('stopped-forced');
    expect(result.reason).toBe('still alive after 1500 ms');
    expect(w.waits[0]).toEqual({ pid: SERVER_PID, timeoutMs: 1500 });
  });

  it('NEVER kills a pid whose command line lacks the marker (an impostor): NOT_OUR_PROCESS, exit 1, nothing deleted', async () => {
    const w = world();
    writeToken(w);
    writeState(w, stateFileOf(SERVER_PID));
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, `"node.exe" -e "setInterval(()=>{},60000)"`);
    w.probes = [hungProbe(SERVER_PID)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'NOT_OUR_PROCESS');
    expect(error.message).toBe(
      `pid ${String(SERVER_PID)} does not carry this instance's runtime marker; nothing was killed`,
    );
    expect(w.killed).toEqual([]);
    expect(w.alive.has(SERVER_PID)).toBe(true);
    expect(existsSync(fileOf(w, 'state.json'))).toBe(true);
    expect(existsSync(fileOf(w, 'run', 'control.token'))).toBe(true);
  });

  it('NEVER kills a runtime of another instance (the marker names the instance)', async () => {
    const w = world();
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, markerLine(w).replace(ID, '99999999-8888-4777-8666-555555555555'));
    w.probes = [hungProbe(SERVER_PID)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'NOT_OUR_PROCESS');
    expect(w.killed).toEqual([]);
  });

  it('NEVER kills a pid whose command line cannot be read', async () => {
    const w = world();
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, null);
    w.probes = [hungProbe(SERVER_PID)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'NOT_OUR_PROCESS');
    expect(error.message).toContain('could not be read');
    expect(w.killed).toEqual([]);
  });

  it('a runtime that survives the kill is STOP_FAILED (legacy text)', async () => {
    const w = world();
    w.alive.add(SERVER_PID);
    w.stubborn = true;
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.probes = [hungProbe(SERVER_PID)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'STOP_FAILED');
    expect(error.message).toBe(`pid ${String(SERVER_PID)} still alive after stop request`);
  });

  it('a hung runtime whose pid is unknown is STOP_FAILED with the doctor hint, and nothing is killed', async () => {
    const w = world();
    w.probes = [hungProbe(null)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'STOP_FAILED');
    expect(error.message).toContain('hung runtime without a known pid');
    expect(error.hint).toContain('mcs doctor');
    expect(w.killed).toEqual([]);
  });

  it('a pid that is not a valid pid is never passed to the operating system', async () => {
    const w = world();
    w.probes = [hungProbe(0)];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'STOP_FAILED');
    expect(w.killed).toEqual([]);
  });

  it('marks the route file stopped after a forced stop, with spoolUntil from hooks.spoolWhileStoppedHours', async () => {
    const w = world({ runtime: { hooks: { spoolWhileStoppedHours: 2 } } });
    const mcsHome = w.ctx.env['MCS_HOME'] ?? '';
    mkdirSync(path.join(mcsHome, 'routes'), { recursive: true });
    const workspace = w.ws.dir.split(path.sep).join('/');
    writeFileSync(
      routeFilePath(mcsHome, ID),
      JSON.stringify({
        v: 1,
        instanceId: ID,
        workspace,
        spoolDir: `${workspace}/data/spool`,
        stateFile: `${workspace}/state.json`,
        enabled: true,
        match: { transcriptsDirs: [], sessionIds: [] },
        stoppedAt: null,
        spoolUntil: null,
        updatedAt: 1,
      }),
    );
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.probes = [hungProbe(SERVER_PID)];
    const before = Date.now();
    await stop(w.ctx, { task: 'demo' }, w.deps);
    const route = readRouteFile(mcsHome, ID);
    expect(route?.stoppedAt).toBeGreaterThanOrEqual(before);
    expect((route?.spoolUntil ?? 0) - (route?.stoppedAt ?? 0)).toBe(2 * 3_600_000);
    expect(route?.enabled).toBe(true);
  });

  it('a stop without a route file writes none', async () => {
    const w = world();
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, markerLine(w));
    w.probes = [hungProbe(SERVER_PID)];
    await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(existsSync(path.join(w.ctx.env['MCS_HOME'] ?? '', 'routes'))).toBe(false);
  });
});

describe('stop: a monitor that this runtime did not start (01 4.9 last row, ADR 0066)', () => {
  const VIEWER_LINE = `python ${['viewer', 'py'].join('.')} serve --task demo`;
  const foreign = (w: World, state: 'unmanaged-running' | 'foreign-pid'): ProbeResult => {
    const file = stateFileOf(888, PORT, 'foreign');
    return probeOf(state, {
      engine: null,
      pid: 888,
      url: URL_OF(PORT),
      port: PORT,
      stateFile: file,
      stateFileBytes: writeState(w, file),
    });
  };

  it('refuses a live unmanaged monitor with NOT_OUR_PROCESS, names pid and url, signals nothing', async () => {
    const w = world();
    w.alive.add(888);
    w.commandLines.set(888, VIEWER_LINE);
    w.probes = [foreign(w, 'unmanaged-running')];
    const error = await failure(stop(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'NOT_OUR_PROCESS');
    expect(error.message).toContain('pid 888');
    expect(error.message).toContain(URL_OF(PORT));
    expect(w.killed).toEqual([]);
    expect(w.requests).toEqual([]);
    expect(existsSync(fileOf(w, 'state.json'))).toBe(true);
  });

  it('a pid-reuse impostor named like a viewer is a stale file: removed, nothing killed', async () => {
    const w = world();
    w.alive.add(888);
    w.commandLines.set(888, VIEWER_LINE);
    w.probes = [foreign(w, 'foreign-pid')];
    const result = await stop(w.ctx, { task: 'demo' }, w.deps);
    expect(result.outcome).toBe('stale-removed');
    expect(w.killed).toEqual([]);
    expect(existsSync(fileOf(w, 'state.json'))).toBe(false);
  });

  it('a stubborn unmanaged monitor is still never signalled', async () => {
    const w = world();
    w.alive.add(888);
    w.stubborn = true;
    w.commandLines.set(888, VIEWER_LINE);
    w.probes = [foreign(w, 'unmanaged-running')];
    expectCode(await failure(stop(w.ctx, { task: 'demo' }, w.deps)), 'NOT_OUR_PROCESS');
    expect(w.killed).toEqual([]);
  });
});

// ---- status ---------------------------------------------------------------------------------------------------------------------------

const BODY = {
  health: (over: Record<string, unknown> = {}) => ({
    checkedAt: '2026-10-12T12:00:00.000Z',
    status: 'ok',
    instanceId: ID,
    asOfSeq: 10,
    epoch: '0a1b2c3d',
    runtime: {
      version: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      outdated: false,
      pid: SERVER_PID,
      startedAt: '2026-10-12T10:00:00.000Z',
      uptimeMs: 7_200_000,
      eventLoopDelayP99Ms: 1,
      rssBytes: 100_000_000,
      heapUsedBytes: 50_000_000,
      cpuUserMicros: 1000,
      cpuSystemMicros: 500,
      sseClients: 0,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    },
    db: {
      ok: true,
      sizeBytes: 1_000_000,
      walBytes: 0,
      freeDiskBytes: 10_000_000_000,
      schemaVersion: 1,
      lastError: null,
    },
    ingestion: {
      status: 'ok',
      reasons: [],
      hooks: {
        enabled: false,
        installed: null,
        lastReceivedAt: null,
        lastEventAt: null,
        spoolPendingBytes: 0,
        spoolLagMs: null,
        errorsLastHour: 0,
        lastError: null,
      },
      transcripts: {
        dirFound: true,
        filesTracked: 1,
        lastScanAt: null,
        lastImportedAt: null,
        importLagMs: 0,
        pendingBytes: 0,
        invalidLines: 0,
        errorsLastHour: 0,
        lastError: null,
      },
    },
    children: Object.fromEntries(
      ['git', 'docker', 'powershell.processes', 'powershell.cmdline', 'ps', 'taskkill', 'icacls', 'node', 'opener'].map(
        (kind) => [kind, { spawned: 0, failed: 0, timedOut: 0, totalMs: 0 }],
      ),
    ),
    panels: {},
    alerts: [],
    errors: [],
    ...over,
  }),
  legacy: (over: Record<string, unknown> = {}) => ({
    ok: true,
    version: RUNTIME_VERSION,
    pid: SERVER_PID,
    started: 1_700_000_000.5,
    uptime: 7200.5,
    now: 1_700_007_200.5,
    code_stamp: 'abcdef0123',
    engine: 'node',
    instanceId: ID,
    task: { id: 'demo', name: 'FIXTURE demo', description: '' },
    config_source: 'task',
    errors: [],
    reader: {},
    ...over,
  }),
  page: (items: unknown[] = [], over: Record<string, unknown> = {}) => ({
    items,
    nextCursor: null,
    asOfSeq: 10,
    total: items.length,
    totalIsLowerBound: false,
    limit: 200,
    ...over,
  }),
  instance: () => ({
    instanceId: ID,
    slug: 'demo',
    title: 'FIXTURE demo',
    description: null,
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
    dbSchemaVersion: 1,
    headSeq: 10,
    epoch: '0a1b2c3d',
    staleAfterMs: 30_000,
    heartbeatMs: 15_000,
    windowHours: 24,
    ui: {
      theme: 'auto',
      density: 'comfortable',
      newestFirst: false,
      showTools: true,
      showThinking: false,
      showPrompts: true,
    },
    panels: { git: true, machine: true, attempts: true, ledger: true, chainLog: true, logs: true },
    poll: {
      healthMs: 5000,
      sessionsMs: 6000,
      overviewMs: 5000,
      transcriptMs: 1500,
      machineMs: 2000,
      logsMs: 3000,
      attemptsMs: 6000,
    },
    features: { transcriptSearch: 'session', costEstimates: false, usageTrend: true, hooks: false },
    retention: { summary: 'FIXTURE retention summary' },
    commands: {
      status: 'mcs status',
      restart: 'mcs restart',
      inspect: 'mcs inspect',
      export: 'mcs export',
      backup: 'mcs backup',
      cleanupDryRun: 'mcs cleanup',
    },
    limits: { pageMax: 200, eventsQueryWindowDays: 7, searchBudgetMsMax: 10_000, textChars: 4000 },
  }),
  overview: () => ({
    asOfSeq: 10,
    generatedAt: '2026-10-12T12:00:00.000Z',
    window: { from: null, to: '2026-10-12T12:00:00.000Z', source: 'window_hours' },
    metrics: [],
    recentActivity: [],
    recentErrors: [],
    alerts: { open: 0, critical: 0, items: [] },
  }),
};

const ok = (body: unknown): HttpAttempt => ({ ok: true, reply: { status: 200, body: JSON.stringify(body) } });

function serve(w: World, overrides: Record<string, unknown> = {}): void {
  w.httpRoutes.set('/api/v3/health', ok(BODY.health(overrides['health'] as Record<string, unknown> | undefined)));
  w.httpRoutes.set('/api/health', ok(BODY.legacy(overrides['legacy'] as Record<string, unknown> | undefined)));
  w.httpRoutes.set('/api/v3/instance', ok(BODY.instance()));
  w.httpRoutes.set('/api/v3/sessions?includeTotal=1&limit=1', ok(BODY.page([], { total: 7, limit: 1 })));
  w.httpRoutes.set('/api/v3/sessions?limit=200', ok(BODY.page([])));
  w.httpRoutes.set('/api/v3/overview', ok(BODY.overview()));
}

describe('status (01 4.10)', () => {
  it('a stopped instance: running false, the state file path, exit 1, and the new keys', async () => {
    const w = world();
    w.probes = [stopped()];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(1);
    expect(result.report).toEqual({
      running: false,
      state_file: fileOf(w, 'state.json'),
      engine: null,
      probe: 'stopped',
      instance_id: ID,
    });
  });

  it('a stale state file is shown as stale_state_file, as the legacy status did', async () => {
    const w = world();
    const file = stateFileOf(999);
    w.probes = [probeOf('stale', { engine: 'node', pid: 999, stateFile: file, stateFileBytes: new Uint8Array() })];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(1);
    expect(result.report.running).toBe(false);
    expect(result.report.stale_state_file).toEqual(file);
    expect(result.report.probe).toBe('stale');
  });

  it('a running instance: the legacy keys first, then the new ones, exit 0', async () => {
    const w = world();
    serve(w);
    w.probes = [running()];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(0);
    const report = result.report;
    expect(Object.keys(report)).toEqual([
      'running',
      'state_file',
      'url',
      'pid',
      'uptime_s',
      'code_stamp',
      'outdated',
      'task',
      'config_source',
      'recent_errors',
      'reader',
      'sessions',
      'partial_sessions',
      'newest_session_age_s',
      'engine',
      'probe',
      'instance_id',
      'runtime_version',
      'outdated_reason',
      'db_schema_version',
      'ingestion',
    ]);
    expect(report).toMatchObject({
      running: true,
      url: URL_OF(PORT),
      pid: SERVER_PID,
      uptime_s: 7200.5,
      code_stamp: 'abcdef0123',
      outdated: false,
      task: { id: 'demo', name: 'FIXTURE demo', description: '' },
      config_source: 'task',
      recent_errors: [],
      reader: {},
      sessions: { RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 },
      partial_sessions: 0,
      newest_session_age_s: null,
      engine: 'node',
      probe: 'running',
      instance_id: ID,
      runtime_version: RUNTIME_VERSION,
      outdated_reason: null,
      db_schema_version: 1,
      ingestion: { status: 'ok', reasons: [] },
    });
    expect(report).not.toHaveProperty('hint');
    expect(report).not.toHaveProperty('stale_state_file');
  });

  it('outdated: the code stamp of the running process differs from runtime/.mcs-build.json', async () => {
    const w = world({ stamp: 'ffffffffff' });
    serve(w);
    w.probes = [running()];
    const report = (await status(w.ctx, { task: 'demo' }, w.deps)).report;
    expect(report).toMatchObject({ outdated: true, outdated_reason: 'code_stamp_changed' });
    expect(report.hint).toBe(
      'the runtime code changed since this instance started: run `mcs restart --task demo` (or `mcs upgrade --task demo --restart` when the database needs an upgrade)',
    );
  });

  it('outdated by version: another runtimeVersion in the stamp file says so', async () => {
    const w = world({ stamp: 'ffffffffff' });
    writeFileSync(
      path.join(w.runtimeDir, '.mcs-build.json'),
      JSON.stringify({ schemaVersion: 1, runtimeVersion: '9.9.9', codeStamp: 'ffffffffff' }),
    );
    serve(w);
    w.probes = [running()];
    expect((await status(w.ctx, { task: 'demo' }, w.deps)).report).toMatchObject({
      outdated: true,
      outdated_reason: 'runtime_version_changed',
    });
  });

  it('a missing stamp file says nothing is outdated (a rebuild may be running)', async () => {
    const w = world();
    writeFileSync(path.join(w.runtimeDir, '.mcs-build.json'), 'not json');
    serve(w);
    w.probes = [running()];
    expect((await status(w.ctx, { task: 'demo' }, w.deps)).report).toMatchObject({
      outdated: false,
      outdated_reason: null,
    });
  });

  it('the recent errors are the newest five, as at, where and message', async () => {
    const w = world();
    const errors = Array.from({ length: 8 }, (_, i) => ({
      at: `2026-10-12T11:0${String(i)}:00.000Z`,
      source: 'ingest',
      code: 'X',
      where: i % 2 === 0 ? `file ${String(i)}` : null,
      message: `problem ${String(i)}`,
      sessionId: null,
    }));
    serve(w, { health: { errors } });
    w.probes = [running()];
    const report = (await status(w.ctx, { task: 'demo' }, w.deps)).report;
    expect(report.recent_errors).toHaveLength(5);
    expect(report.recent_errors?.[0]).toEqual({ at: errors[0]?.at, where: 'file 0', message: 'problem 0' });
    expect(report.recent_errors?.[1]).toEqual({ at: errors[1]?.at, where: 'ingest', message: 'problem 1' });
  });

  it('a body that does not match its schema leaves the keys out; the instance is still running', async () => {
    const w = world();
    serve(w);
    w.httpRoutes.set('/api/v3/health', ok({ nonsense: true }));
    w.httpRoutes.set('/api/v3/sessions?limit=200', { ok: false, reason: 'timeout' });
    w.probes = [running()];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ running: true, probe: 'running', url: URL_OF(PORT), pid: SERVER_PID });
    expect(result.report).not.toHaveProperty('db_schema_version');
    expect(result.report).not.toHaveProperty('sessions');
  });

  it('a runtime that answers control but not HTTP is not running and says what to do', async () => {
    const w = world();
    w.probes = [
      probeOf('unhealthy', { engine: 'node', pid: 321, identity: identity({ pid: 321 }), url: URL_OF(PORT) }),
    ];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ running: false, probe: 'unhealthy', pid: 321 });
    expect(result.report.hint).toContain('mcs doctor --task demo');
  });

  it('a monitor that this runtime did not start: unmanaged-running, engine null, exit 1, nothing fetched', async () => {
    const w = world();
    w.httpRoutes.set('/api/health', ok({ ok: true, pid: 888 }));
    w.probes = [probeOf('unmanaged-running', { engine: null, pid: 888, url: URL_OF(PORT), port: PORT })];
    const fetched: string[] = [];
    const realGet = w.deps.httpGet;
    const deps: LifecycleDeps = {
      ...w.deps,
      httpGet: (url, o) => {
        fetched.push(url);
        if (realGet === undefined) throw new Error('no scripted http');
        return realGet(url, o);
      },
    };
    const result = await status(w.ctx, { task: 'demo' }, deps);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      running: false,
      url: URL_OF(PORT),
      pid: 888,
      engine: null,
      probe: 'unmanaged-running',
    });
    expect(result.report.hint).toContain('not started by this runtime');
    expect(fetched).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('a pre-4.0 workspace without instance.json is reported, not delegated: instance_id null', async () => {
    const w = world({ instance: false });
    w.probes = [stopped()];
    const result = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(result).toMatchObject({ exitCode: 1, report: { running: false, instance_id: null, probe: 'stopped' } });
    expect(result).not.toHaveProperty('delegated');
  });
});

describe('summarizeSessions (the counts of status)', () => {
  const session = (
    legacyState: 'RUNNING' | 'IDLE' | 'COMPLETED' | 'FAILED' | 'UNKNOWN',
    partial: boolean,
    at: string,
  ) => ({
    state: { legacyState },
    partial,
    lastActivityAt: at,
  });

  it('counts the legacy states, the partial sessions and the age of the newest activity', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z');
    const counts = summarizeSessions(
      [
        session('RUNNING', false, '2026-10-12T11:59:30.000Z'),
        session('RUNNING', true, '2026-10-12T11:00:00.000Z'),
        session('IDLE', false, '2026-10-12T10:00:00.000Z'),
        session('FAILED', false, '2026-10-12T09:00:00.000Z'),
        session('UNKNOWN', true, '2026-10-11T09:00:00.000Z'),
      ],
      now,
    );
    expect(counts).toEqual({
      sessions: { RUNNING: 2, IDLE: 1, COMPLETED: 0, FAILED: 1, UNKNOWN: 1 },
      partial: 2,
      newestAgeS: 30,
    });
  });

  it('has no age without sessions, and never a negative one (a clock that went back)', () => {
    expect(summarizeSessions([], 0)).toEqual({
      sessions: { RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 },
      partial: 0,
      newestAgeS: null,
    });
    expect(
      summarizeSessions([session('IDLE', false, '2026-10-12T12:00:10.000Z')], Date.parse('2026-10-12T12:00:00.000Z'))
        .newestAgeS,
    ).toBe(0);
  });

  it('ignores a time it cannot read', () => {
    expect(summarizeSessions([session('IDLE', false, 'not a time')], 1000).newestAgeS).toBeNull();
  });
});

// ---- verify -------------------------------------------------------------------------------------------------------------------------------

describe('verify (01 4.10)', () => {
  it('checks the five endpoints against the shared schemas and reports the session count', async () => {
    const w = world();
    serve(w);
    w.probes = [running()];
    const result = await verify(w.ctx, { task: 'demo' }, w.deps);
    expect(result.exitCode).toBe(0);
    expect(result.sessions).toBe(7);
    expect(result.message).toEqual([`verified ${URL_OF(PORT)}: health, instance, sessions (7), overview all valid`]);
  });

  it('collects every problem: an endpoint that does not answer, an error status, a body of the wrong shape', async () => {
    const w = world();
    serve(w);
    w.httpRoutes.set('/api/v3/overview', { ok: false, reason: 'timeout' });
    w.httpRoutes.set('/api/v3/instance', { ok: true, reply: { status: 500, body: '{}' } });
    w.httpRoutes.set('/api/health', ok({ ok: true }));
    w.probes = [running()];
    const error = await failure(verify(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'API_ERROR');
    const parts = error.message.split('; ');
    expect(parts.some((p) => p.startsWith('/api/v3/overview: '))).toBe(true);
    expect(parts.some((p) => p.startsWith('/api/v3/instance: '))).toBe(true);
    expect(parts.some((p) => p.startsWith('/api/health: '))).toBe(true);
    expect(parts.some((p) => p.startsWith('/api/v3/health: '))).toBe(false);
  });

  it('a body that is not JSON is a problem of its endpoint', async () => {
    const w = world();
    serve(w);
    w.httpRoutes.set('/api/v3/health', { ok: true, reply: { status: 200, body: '<html>' } });
    w.probes = [running()];
    const error = await failure(verify(w.ctx, { task: 'demo' }, w.deps));
    expect(error.message).toContain('/api/v3/health: ');
    expect(error.message).toContain('not JSON');
  });

  it('every endpoint must belong to this instance', async () => {
    const w = world();
    serve(w, { legacy: { instanceId: '99999999-8888-4777-8666-555555555555' } });
    w.probes = [running()];
    const error = await failure(verify(w.ctx, { task: 'demo' }, w.deps));
    expect(error.message).toContain('/api/health: ');
    expect(error.message).toContain('instance');
  });

  it('an instance that is not running is INSTANCE_NOT_RUNNING (legacy text)', async () => {
    const w = world();
    w.probes = [stopped()];
    const error = await failure(verify(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'INSTANCE_NOT_RUNNING');
    expect(error.message).toBe(`no healthy monitor for this target (state file: ${fileOf(w, 'state.json')})`);
  });

  it('a monitor that this runtime did not start is not verified: INSTANCE_RUNNING names pid and url', async () => {
    const w = world();
    w.probes = [probeOf('unmanaged-running', { engine: null, pid: 888, url: URL_OF(PORT) })];
    const error = await failure(verify(w.ctx, { task: 'demo' }, w.deps));
    expectCode(error, 'INSTANCE_RUNNING');
    expect(error.message).toContain('pid 888');
    expect(error.message).toContain(URL_OF(PORT));
    expect(w.killed).toEqual([]);
  });
});

// ---- restart -------------------------------------------------------------------------------------------------------------------------------

describe('restart (01 4.10)', () => {
  it('is stop, then start with the same options: two lines', async () => {
    const w = world();
    writeToken(w);
    w.alive.add(SERVER_PID);
    w.probes = [running(), stopped(), running(SERVER_PID)];
    const result = await restart(w.ctx, { task: 'demo', port: 18200 }, w.deps);
    expect(result.exitCode).toBe(0);
    expect(result.message).toEqual([
      `stopped runtime pid ${String(SERVER_PID)} (${URL_OF(PORT)})`,
      `started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`,
    ]);
    expect(w.requests).toHaveLength(1);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0]?.args).toContain('--port=18200');
  });

  it('with nothing running it says so and starts', async () => {
    const w = world();
    w.probes = [stopped(), stopped(), running(SERVER_PID)];
    const result = await restart(w.ctx, { task: 'demo' }, w.deps);
    expect(result.message[0]).toBe(`nothing to stop (no state file ${fileOf(w, 'state.json')})`);
    expect(result.message.at(-1)).toBe(`started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`);
  });

  it('starts only when the stop succeeded', async () => {
    const w = world();
    w.alive.add(SERVER_PID);
    w.commandLines.set(SERVER_PID, 'node impostor.js');
    w.probes = [hungProbe(SERVER_PID)];
    expectCode(await failure(restart(w.ctx, { task: 'demo' }, w.deps)), 'NOT_OUR_PROCESS');
    expect(w.spawns).toEqual([]);
  });

  it('creates the default workspace on demand, once', async () => {
    const w = world({ noTasks: true });
    w.probes = [stopped(), stopped(), running(SERVER_PID)];
    const result = await restart(w.ctx, {}, w.deps);
    expect(result.message[0]).toBe("created default workspace 'default'");
    expect(result.message.filter((line) => line.startsWith('created default'))).toHaveLength(1);
    expect(result.slug).toBe('default');
  });
});

// ---- serve ---------------------------------------------------------------------------------------------------------------------------------

describe('serveForeground (01 4.10)', () => {
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  /** The server of the call has been spawned (the workspace, the configuration and the probe come first). */
  const spawned = (w: World): Promise<FakeChild> =>
    waitFor(() => w.foreground[0]?.child ?? null, { what: 'the foreground server' });

  it('spawns the server in the foreground with the same argv as start, and maps exit 0 to 0', async () => {
    const w = world();
    w.probes = [stopped()];
    const running$ = serveForeground(w.ctx, { task: 'demo', port: 18300, logLevel: 'info' }, w.deps);
    await spawned(w);
    expect(w.foreground).toHaveLength(1);
    const call = w.foreground[0];
    expect(call?.file).toBe(process.execPath);
    expect(call?.args).toEqual([
      path.join(w.runtimeDir, 'packages', 'server', 'dist', 'main.js'),
      'serve',
      `--mcs-instance=${ID}`,
      `--instance-dir=${w.ws.dir}`,
      '--port=18300',
      '--log-level=info',
    ]);
    expect(call?.cwd).toBe(w.ws.dir);
    expect(call?.env['MCS_HOOK_DISABLE']).toBe('1');
    call?.child.emit('exit', 0, null);
    expect(await running$).toMatchObject({ exitCode: 0, interrupted: false });
  });

  it('any other exit code is START_FAILED with the name of the code', async () => {
    const w = world();
    w.probes = [stopped()];
    const done = failure(serveForeground(w.ctx, { task: 'demo' }, w.deps));
    await spawned(w);
    w.foreground[0]?.child.emit('exit', 12, null);
    const error = await done;
    expectCode(error, 'START_FAILED');
    expect(error.message).toContain('INSTANCE_LOCKED');
  });

  it('refuses to serve over a runtime that is running, starting or hung, or a live viewer: INSTANCE_RUNNING', async () => {
    for (const probe of [
      running(),
      probeOf('starting', { engine: 'node', pid: 321 }),
      hungProbe(321),
      probeOf('unmanaged-running', { engine: null, pid: 888, url: URL_OF(PORT) }),
    ]) {
      const w = world();
      w.probes = [probe];
      const error = await failure(serveForeground(w.ctx, { task: 'demo' }, w.deps));
      expectCode(error, 'INSTANCE_RUNNING');
      expect(w.foreground).toEqual([]);
    }
  });

  it('a stale or foreign state file does not block it', async () => {
    const w = world();
    w.probes = [probeOf('stale', { engine: 'node', pid: 999 })];
    const done = serveForeground(w.ctx, { task: 'demo' }, w.deps);
    await spawned(w);
    expect(w.foreground).toHaveLength(1);
    w.foreground[0]?.child.emit('exit', 0, null);
    await done;
  });

  it('warns that --state-file is ignored', async () => {
    const w = world();
    w.probes = [stopped()];
    const done = serveForeground(w.ctx, { task: 'demo', stateFile: 'whatever.json' }, w.deps);
    await spawned(w);
    w.foreground[0]?.child.emit('exit', 0, null);
    const result = await done;
    expect(result.warnings).toEqual([
      `--state-file is ignored by the Node runtime (it always uses ${fileOf(w, 'state.json')})`,
    ]);
  });

  it('forwards SIGINT as a control shutdown with the token, and exits 0 when the server then exits 0 (T-LC-15)', async () => {
    const w = world();
    writeToken(w);
    w.probes = [stopped()];
    const signals = new EventEmitter();
    const done = serveForeground(w.ctx, { task: 'demo' }, { ...w.deps, signals: signals as never });
    await spawned(w);
    signals.emit('SIGINT');
    await waitFor(() => w.requests.length > 0, { what: 'the shutdown request' });
    expect(w.requests).toEqual([{ v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'signal' }]);
    w.foreground[0]?.child.emit('exit', 0, null);
    const result = await done;
    expect(result).toMatchObject({ exitCode: 0, interrupted: true });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGBREAK')).toBe(0);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
  });

  it('SIGBREAK and SIGHUP are forwarded too, and a missing token does not break the wait', async () => {
    const w = world();
    w.probes = [stopped()];
    const signals = new EventEmitter();
    const done = serveForeground(w.ctx, { task: 'demo' }, { ...w.deps, signals: signals as never });
    await spawned(w);
    signals.emit('SIGBREAK');
    signals.emit('SIGHUP');
    await settle();
    expect(w.requests).toEqual([]);
    w.foreground[0]?.child.emit('exit', 0, null);
    expect((await done).interrupted).toBe(true);
  });

  it('on a host that has real signals the child gets the signal as well', async () => {
    const w = world();
    w.probes = [stopped()];
    const signals = new EventEmitter();
    const done = serveForeground(w.ctx, { task: 'demo' }, { ...w.deps, signals: signals as never });
    await spawned(w);
    signals.emit('SIGINT');
    const child = w.foreground[0]?.child;
    // the signal follows the control shutdown, which reads the token from disk first: one tick is not enough on Linux
    if (process.platform === 'win32') {
      await settle();
      expect(child?.killedWith).toEqual([]);
    } else {
      await waitFor(() => (child?.killedWith.length ?? 0) > 0, { what: 'the forwarded signal' });
      expect(child?.killedWith).toEqual(['SIGINT']);
    }
    child?.emit('exit', 0, null);
    await done;
  });

  it('removes its signal handlers even when the server fails', async () => {
    const w = world();
    w.probes = [stopped()];
    const signals = new EventEmitter();
    const done = failure(serveForeground(w.ctx, { task: 'demo' }, { ...w.deps, signals: signals as never }));
    await spawned(w);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    w.foreground[0]?.child.emit('exit', 17, null);
    await done;
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('creates the default workspace on demand', async () => {
    const w = world({ noTasks: true });
    w.probes = [stopped()];
    const done = serveForeground(w.ctx, {}, w.deps);
    await spawned(w);
    expect(w.foreground).toHaveLength(1);
    w.foreground[0]?.child.emit('exit', 0, null);
    const result = await done;
    expect(result.message).toEqual(["created default workspace 'default'"]);
    expect(readdirSync(w.ctx.root)).toContain('default');
  });

  it('opens the URL once the server is ready, when asked', async () => {
    const w = world();
    w.probes = [stopped(), probeOf('starting', { engine: 'node', pid: SERVER_PID }), running()];
    const done = serveForeground(w.ctx, { task: 'demo', open: true }, w.deps);
    await waitFor(() => w.opened.length > 0, { what: 'the browser to be asked' });
    expect(w.opened).toEqual([URL_OF(PORT)]);
    w.foreground[0]?.child.emit('exit', 0, null);
    await done;
  });
});
