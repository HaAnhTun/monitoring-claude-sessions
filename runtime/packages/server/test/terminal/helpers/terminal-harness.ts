// The L2 terminal harness (design 08 section 3.2): the production app of a user instance with the REAL engine host behind it,
// in this process, on every OS. It is server test code because it imports the server sources and `@mcs/engine`.
//
//   const h = await startTerminalHarness();
//   const made = await h.http('POST', '/api/v3/terminal/sessions', { body: { path: h.work } });   // the harness cookie is sent
//   const { client } = await h.ws(name);                  // RawWsClient after `ready` and `live`
//   h.backend.last?.emitData('hello');                    // the scripted pseudo terminal of the session just created
//   await h.close();                                      // throws when a port, a socket, a timer or a process is left
//
// What is real: the app (`createApp`: guards, error mapper, contracts), the terminal side as the boot code builds it
// (`createTerminalServer`: auth, terminal, event, socket and folder routes, the gateway, the upgrade listener), the access service
// (the code of `mint()` goes through the real exchange route), the engine host over the terminal service (`createUserServices`:
// names, limits, replay, kill, census, linker, folder service), a workspace of kind `user` with its database, and an HTTP server on
// a port of the testkit. What is scripted: the pseudo terminal (`FakePtyBackend`, so nothing is ever spawned), the clock
// (`FakeClock`), the process table of the linker (no descendants), the folder dialog and the native terminal window (none: the
// routes answer as on a host without them) and the exit hook of the process (not registered).
//
// The pids of the scripted terminals start at `FAKE_FIRST_PID`, a number no operating system hands out: the terminal service is
// the real one, with the real tree kill behind its escalation, so a fake pid must never be able to name a real process. The price:
// the liveness watchdog of the service (a real 5 s timer) finds such a pid gone and ends the session after two probes, about 10 s
// of real time. L2 tests are shorter than that; a test that needs a session for longer runs on a real terminal (project `pty`).
//
// The leak check of `close()`: from the first line of `startTerminalHarness` every timer, socket, listener, watcher and child
// process that this process creates is recorded by identity (`node:async_hooks`); after the shutdown `close()` waits for them to
// be released and throws, naming the kinds, when one that keeps the event loop alive is still there. That covers what the app and
// the engine started, what `http()` and `ws()` opened, and also what the test itself left open while the harness ran; what another
// harness started or opened is its own.
// (Counting `process.getActiveResourcesInfo()` before and after, as the design says, was measured to be unreliable under Vitest:
// its own short task-update timer is in the first count and hides one leaked timer.)
//
// Design 02's own suites use `FakeTerminalPorts` (`fake-terminal.ts`: a scriptable host that records calls); this harness is the
// combination, for the tests that must see the engine and the server agree. Call `close()` in the test or `closeTerminalHarnesses()`
// in `afterEach`.
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createDaMemoryReader,
  createLogger,
  createUserServices,
  defaultSkillDir,
  hostPlatform,
  initWorkspace,
  userRootOf,
  type AccessService,
  type HostPlatform,
  type InstanceContext,
  type TerminalHost,
} from '@mcs/engine';
import { FakePtyBackend } from '@mcs/engine/testing';
import { RUNTIME_VERSION } from '@mcs/shared';
import {
  FakeClock,
  allocatePort,
  assertPortClosed,
  httpRequest,
  makeTempDir,
  openTerminalSocket,
  waitFor,
  type OpenedTerminalSocket,
  type TempDir,
} from '@mcs/testkit';

import { createApp, createHttpServer, type ServerTiming } from '../../../src/app.ts';
import { createAccessVerifier } from '../../../src/http/access-guard.ts';
import { readLegacyTask } from '../../../src/routes/meta.ts';
import type { TerminalEventLimits } from '../../../src/terminal/events.ts';
import type { TerminalSocketLimits } from '../../../src/terminal/gateway.ts';
import { createTerminalServer } from '../../../src/terminal/index.ts';
import { cookieFromReply, pageOrigin, postExchange, writeHeaders } from './auth.ts';

/** The pid of the first scripted terminal: above every pid Windows, Linux or macOS hands out, so it names no real process. */
export const FAKE_FIRST_PID = 2_000_000_000;
/** The instance id of every harness (invented). */
export const HARNESS_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const START = Date.UTC(2026, 9, 11, 14, 5, 7);
const SETTLE_MS = 5000;

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

export interface TerminalHarnessOptions {
  /** Shorter limits and intervals of the socket gateway and of the event feed. */
  readonly limits?: { readonly socket?: Partial<TerminalSocketLimits>; readonly events?: Partial<TerminalEventLimits> };
  /** Where the fake clock starts (epoch ms). Default: a fixed instant in 2026. */
  readonly now?: number;
  /** The platform the terminal service resolves its program for. Default: the host. */
  readonly platform?: HostPlatform;
  /** `terminal.*` overrides of the instance (`maxSessions`, `killTimeoutMs`, ...). `command` is set by the harness. */
  readonly terminal?: Readonly<Record<string, unknown>>;
  /**
   * `'scripted'` (default): the `FakePtyBackend` of the harness. `'platform'`: the engine selects the backend of `platform`
   * itself, as a real instance does, with an addon loader that always fails: a platform without a terminal says `unsupported-os`
   * and one with a terminal says `native-load-failed`. Nothing can be spawned either way (`backend.spawns` stays empty).
   */
  readonly backend?: 'scripted' | 'platform';
  /** The instance id (a lowercase uuid v4; it names the cookie). Default {@link HARNESS_INSTANCE_ID}. */
  readonly instanceId?: string;
  /** Shorter timings of the HTTP server (the headers timeout and how often it is checked). */
  readonly timing?: ServerTiming;
}

export interface HarnessRequest {
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. A `POST` without a body sends `{}`. */
  readonly body?: unknown;
  /** The `Cookie` value; default the cookie of the harness, `null` sends none. */
  readonly cookie?: string | null;
  /** The `Origin` header; default the origin of the page for a `POST`, none for a `GET`; `null` sends none. */
  readonly origin?: string | null;
}

export interface TerminalHarness {
  readonly port: number;
  /** The access code that was exchanged for {@link cookie}: spent, so the exchange route refuses it now. */
  readonly code: string;
  /** The `<name>=<value>` pair of the session, as the exchange route set it. */
  readonly cookie: string;
  /** The engine host the routes were given (the server's `TerminalPorts`). */
  readonly ports: TerminalHost;
  /** The scripted pseudo terminals: `backend.spawns`, `backend.last`, `backend.spawnError`. */
  readonly backend: FakePtyBackend;
  /** The real access service: `mint()` gives a fresh code. */
  readonly access: AccessService;
  readonly clock: FakeClock;
  readonly ctx: InstanceContext;
  /** A folder that exists, for a session. */
  readonly work: string;
  /** The log of the instance, for a scan of what must never be written; after `close()` it is the complete log. */
  readLog(): string;
  /** One request on a fresh connection; `json` is the parsed body or `null`. */
  http(
    method: 'GET' | 'POST',
    urlPath: string,
    request?: HarnessRequest,
  ): Promise<HttpReply & { readonly json: unknown }>;
  /** The terminal socket of a session after `ready` and `live`; closed by `close()` when the test left it open. */
  ws(name: string, opts?: { readonly cookie?: string; readonly origin?: string }): Promise<OpenedTerminalSocket>;
  /**
   * Ends everything in the order of the real shutdown and asserts that nothing is left: the port is closed, and no timer,
   * socket, listener, watcher or child process that was created while the harness ran still keeps the event loop alive.
   * Idempotent.
   */
  close(): Promise<void>;
}

const open: TerminalHarness[] = [];

// ---- the leak watch ---------------------------------------------------------------------------------------------------------------

/** The async resource types that can outlive a harness: timers, sockets, listeners, watchers, child processes. */
const WATCHED_TYPES: ReadonlySet<string> = new Set([
  'Timeout',
  'TCPWRAP',
  'TCPSERVERWRAP',
  'UDPWRAP',
  'FSEVENTWRAP',
  'STATWATCHER',
  'PROCESSWRAP',
]);

/** The harness in whose asynchronous context a resource was created; nothing for what a test created itself. */
const ownerOf = new AsyncLocalStorage<symbol>();
/**
 * The port of each open harness. A socket that a server accepts is created outside every asynchronous context, so it carries no
 * owner: the port it is bound to says whose it is.
 */
const portOwners = new Map<number, symbol>();

/** The local and the remote port of a socket or listener handle; nothing for a timer, a watcher or a handle that is closed. */
function portsOf(resource: object): number[] {
  const ports: number[] = [];
  for (const method of ['getsockname', 'getpeername']) {
    const read: unknown = Reflect.get(resource, method);
    if (typeof read !== 'function') continue;
    const out: { port?: unknown } = {};
    try {
      Reflect.apply(read, resource, [out]);
    } catch {
      continue;
    }
    if (typeof out.port === 'number') ports.push(out.port);
  }
  return ports;
}

/** True when the resource belongs to another harness: it was created in that harness's context, or it is a socket of its port. */
function ownedByAnother(self: symbol, owner: symbol | undefined, resource: object): boolean {
  if (owner !== undefined) return owner !== self;
  return portsOf(resource).some((port) => {
    const other = portOwners.get(port);
    return other !== undefined && other !== self;
  });
}

interface Watched {
  readonly type: string;
  readonly resource: object;
  readonly owner: symbol | undefined;
}

/** False for a timer or a handle that was told not to keep the process alive (`unref()`); true when that cannot be asked. */
function keepsLoopAlive(resource: object): boolean {
  const hasRef: unknown = Reflect.get(resource, 'hasRef');
  if (typeof hasRef !== 'function') return true;
  try {
    return Reflect.apply(hasRef, resource, []) !== false;
  } catch {
    return true;
  }
}

interface LeakWatch {
  /** From now on new resources are not recorded (the waiting of `close()` itself uses timers). */
  stopRecording(): void;
  /** The recorded resources that were not released and keep the event loop alive, as `Type xN`. */
  left(): string[];
  dispose(): void;
}

/** Records every watched resource that is created from now on, and forgets it when it is released. */
function watchLeaks(self: symbol): LeakWatch {
  const live = new Map<number, Watched>();
  let recording = true;
  const hook = createHook({
    init(asyncId, type, _triggerAsyncId, resource) {
      if (recording && WATCHED_TYPES.has(type)) live.set(asyncId, { type, resource, owner: ownerOf.getStore() });
    },
    destroy(asyncId) {
      live.delete(asyncId);
    },
  }).enable();
  return {
    stopRecording: () => {
      recording = false;
    },
    left: () => {
      const counts = new Map<string, number>();
      for (const { type, resource, owner } of live.values()) {
        // what another harness started is that harness's to close
        if (ownedByAnother(self, owner, resource)) continue;
        if (keepsLoopAlive(resource)) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      return [...counts].map(([type, count]) => `${type} x${String(count)}`);
    },
    dispose: () => {
      hook.disable();
      live.clear();
    },
  };
}

/** The addon loader of `backend: 'platform'`: there is no addon in the harness, so no real terminal can ever be started. */
function failingAddonLoader(): never {
  throw new Error('startTerminalHarness: the L2 harness loads no terminal addon');
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** Starts one user instance in this process (see the file header). */
export function startTerminalHarness(options: TerminalHarnessOptions = {}): Promise<TerminalHarness> {
  const self = Symbol('terminal harness');
  const leaks = watchLeaks(self);
  const temp = makeTempDir('terminal-harness');
  return ownerOf
    .run(self, () => start(options, leaks, temp, self))
    .catch((error: unknown) => {
      leaks.dispose();
      try {
        temp.remove();
      } catch {
        // a start that failed half way may still hold a file of the folder; the error of the start is what matters
      }
      throw error;
    });
}

async function start(
  options: TerminalHarnessOptions,
  leaks: LeakWatch,
  temp: TempDir,
  self: symbol,
): Promise<TerminalHarness> {
  const root = temp.path;
  const platform = options.platform ?? hostPlatform;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const env = { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') };
  const userRoot = userRootOf(env);
  mkdirSync(userRoot, { recursive: true });
  const clock = new FakeClock(options.now ?? START);
  const { ws } = await initWorkspace({
    repo: userRoot,
    root: userRoot,
    name: 'Claude Agent Workspace',
    slug: 'user',
    kind: 'user',
    clock,
    newId: () => options.instanceId ?? HARNESS_INSTANCE_ID,
  });
  // a file that exists is all the command resolution asks for: the scripted pseudo terminal never runs it
  const command = path.join(root, platform === 'win32' ? 'fake-claude.exe' : 'fake-claude');
  writeFileSync(command, '', { mode: 0o755 });
  writeFileSync(
    path.join(ws.dir, 'runtime.json'),
    JSON.stringify({ schema_version: 1, terminal: { ...options.terminal, command } }),
  );
  const work = path.join(root, 'work');
  mkdirSync(work);
  const logFile = path.join(root, 'runtime.log');
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env,
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: createLogger({ file: logFile, level: 'debug', rotate: false, clock }),
  });

  const backend = new FakePtyBackend({ firstPid: FAKE_FIRST_PID });
  const user = createUserServices(
    ctx,
    { ingest: { hintSession: () => undefined } },
    {
      terminal:
        options.backend === 'platform'
          ? { platform, env: () => ({}), home: root, load: failingAddonLoader }
          : { backend, env: () => ({}), platform, home: root },
      picker: null,
      native: null,
      folders: { daMemory: createDaMemoryReader({ dir: path.join(root, 'no-da-memory'), cacheMs: 0 }), homeDir: root },
      tree: { descendants: () => Promise.resolve(new Set<number>()) },
      // the synchronous kill at process exit is for a real server; a scripted pid is never signalled
      exitHook: { on: () => undefined, off: () => undefined },
    },
  );
  const access = user.accessService;
  const host = user.terminal;
  if (access === undefined || access === null || host === undefined || host === null) {
    throw new Error('startTerminalHarness: the user services have no access service or no terminal host');
  }
  const started: (typeof user.components)[number][] = [];
  for (const component of user.components) {
    await component.start();
    started.push(component);
  }

  const terminal = createTerminalServer({
    ctx,
    ports: host,
    access,
    folders: user.folders ?? null,
    logger: ctx.logger,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    access: createAccessVerifier(access, ctx.instanceId),
    extraModules: terminal.modules,
  });
  const server: Server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs, options.timing);
  server.on('upgrade', terminal.upgrades.listener(app));
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  portOwners.set(port, self);

  const sockets: OpenedTerminalSocket[] = [];
  let finalLog: string | null = null;
  const readLog = (): string => finalLog ?? readFileSync(logFile, 'utf8');
  let closing: Promise<void> | null = null;
  const shutDown = async (): Promise<void> => {
    for (const socket of sockets.splice(0)) socket.client.destroy();
    // the sockets of the terminal first: `closeAllConnections` does not know an upgraded socket (design 02 5.5)
    await terminal.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    for (const component of started.reverse()) await component.stop(clock.now());
    ctx.db.close();
    await ctx.logger.close();
    finalLog = readFileSync(logFile, 'utf8');
    await assertPortClosed(port);
    // a closed handle is released a turn of the event loop later: the check waits for that, not for a leak
    leaks.stopRecording();
    await waitFor(() => leaks.left().length === 0, {
      what: 'the handles of the harness to be released',
      timeoutMs: SETTLE_MS,
      intervalMs: 20,
    }).catch(() => undefined);
    const left = leaks.left();
    leaks.dispose();
    portOwners.delete(port);
    temp.remove();
    if (left.length > 0) {
      throw new Error(`startTerminalHarness: close() left handles behind: ${left.join(', ')}`);
    }
  };

  // ---- the session of the harness: a real code through the real exchange route ----------------------------------------------------

  let code: string;
  let cookie: string;
  try {
    code = access.mint().code;
    const reply = await postExchange(port, code);
    const pair = cookieFromReply(reply);
    if (reply.status !== 200 || pair === null) {
      throw new Error(`startTerminalHarness: the exchange answered ${String(reply.status)}`);
    }
    cookie = pair;
  } catch (error) {
    await shutDown().catch(() => undefined);
    throw error;
  }

  const harness: TerminalHarness = {
    port,
    code,
    cookie,
    ports: host,
    backend,
    access,
    clock,
    ctx,
    work,
    readLog,
    // the client side of a request or a socket made through the harness belongs to it, like the server side
    http: (method, urlPath, request = {}) =>
      ownerOf.run(self, async () => {
        const credential = request.cookie === undefined ? cookie : request.cookie;
        const origin = request.origin === undefined ? (method === 'POST' ? pageOrigin(port) : null) : request.origin;
        const reply = await httpRequest(port, urlPath, {
          method,
          headers: {
            ...(method === 'POST' ? writeHeaders() : {}),
            ...(credential === null ? {} : { Cookie: credential }),
            ...request.headers,
          },
          ...(origin === null ? {} : { origin }),
          ...(method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
        });
        return { ...reply, json: parseJson(reply.body) };
      }),
    ws: (name, opts = {}) =>
      ownerOf.run(self, async () => {
        const socket = await openTerminalSocket(port, name, {
          cookie: opts.cookie ?? cookie,
          origin: opts.origin ?? pageOrigin(port),
        });
        sockets.push(socket);
        return socket;
      }),
    close: () => {
      closing ??= shutDown();
      const index = open.indexOf(harness);
      if (index >= 0) open.splice(index, 1);
      return closing;
    },
  };
  open.push(harness);
  return harness;
}

/** Closes every harness that is still open (call it in `afterEach`); the leak check of each `close()` applies. */
export async function closeTerminalHarnesses(): Promise<void> {
  const failures: unknown[] = [];
  for (const harness of [...open]) {
    try {
      await harness.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
