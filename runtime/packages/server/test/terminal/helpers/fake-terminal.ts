// The fake terminal host of the server suites (CAW-20, design 02 8 and 10): a `TerminalPorts` whose sessions are scriptable and
// whose every call is recorded, so a test can say what reached the port (and that a refused request never did). Nothing here
// starts a process or touches the disk. All names, folders and ids are invented.
//
// `startTerminalApp` builds the rest of a user instance around it: a real workspace and database in a temp folder, the real access
// service on a fake clock, the real app (guards, error mapper) with the auth, terminal and event routes mounted as the boot code
// mounts them, a real HTTP server on a port of the testkit and a real log file. A suite calls `stopTerminalApps` after each test.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createAccessService,
  createLogger,
  defaultSkillDir,
  initWorkspace,
  type AccessService,
  type InstanceContext,
} from '@mcs/engine';
import { RUNTIME_VERSION, type TerminalCapabilities, type TerminalLink, type TerminalSessionInfo } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, makeTempDir, type TempDir } from '@mcs/testkit';

import { createApp, createHttpServer, type ServerTiming } from '../../../src/app.ts';
import { createAccessVerifier } from '../../../src/http/access-guard.ts';
import { createAuthRoutes } from '../../../src/routes/auth.ts';
import { readLegacyTask } from '../../../src/routes/meta.ts';
import { createTerminalRoutes } from '../../../src/routes/terminal.ts';
import { createTerminalSocketRoutes } from '../../../src/routes/terminal-socket.ts';
import {
  createTerminalEventsRoutes,
  type TerminalEventLimits,
  type TerminalEvents,
} from '../../../src/terminal/events.ts';
import { createTerminalGateway, type TerminalSocketLimits } from '../../../src/terminal/gateway.ts';
import type {
  FolderPickerPort,
  TerminalAttachment,
  TerminalExit,
  TerminalGateway,
  TerminalPorts,
  TerminalSessionPort,
  TerminalSessionsPort,
  TerminalViewer,
} from '../../../src/terminal/ports.ts';
import { createUpgradeRegistry } from '../../../src/terminal/upgrade.ts';

// FIXTURE: invented data for tests
export const FAKE_CREATED_AT = '2026-10-11T14:05:07.000Z';
export const FAKE_SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** What a failure of the engine looks like to the server: an `Error` named `TerminalError` with a `code` (and details). */
export class FakeTerminalError extends Error {
  readonly code: string;
  readonly details: readonly { readonly path: string; readonly issue: string }[] | undefined;

  constructor(code: string, details?: readonly { readonly path: string; readonly issue: string }[]) {
    super('a fixed sentence that holds no path and no name');
    this.name = 'TerminalError';
    this.code = code;
    this.details = details;
  }
}

/** A link that has not resolved yet (the shape the host embeds right after a start). */
export function pendingLink(): TerminalLink {
  return {
    status: 'pending',
    sessionId: null,
    previousSessionIds: [],
    basis: null,
    confidence: null,
    since: null,
    claudePid: null,
    transcript: 'none',
    registryStatus: null,
    waitingFor: null,
    reason: null,
    shared: false,
  };
}

/** The capabilities of a host where everything works. */
export function availableCapabilities(): TerminalCapabilities {
  return { available: true, reason: null, folderPicker: true, resume: true, maxSessions: 8 };
}

/** The capabilities of a host that cannot run a terminal, with the reason. */
export function unavailableCapabilities(
  reason: TerminalCapabilities['reason'] = 'unsupported_os',
): TerminalCapabilities {
  return { available: false, reason, folderPicker: false, resume: false, maxSessions: 0 };
}

/** A session row; any field may be overridden. */
export function sessionInfo(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    name: 'demo-1',
    path: 'C:\\work\\demo',
    createdAt: FAKE_CREATED_AT,
    cols: 120,
    rows: 30,
    viewers: 0,
    link: pendingLink(),
    folderKey: 'c--work-demo',
    ...overrides,
  };
}

/** One scriptable session: it records what the gateway does to it and lets a test emit output, resizes and the exit. */
export class FakeSession implements TerminalSessionPort {
  readonly name: string;
  info: TerminalSessionInfo;
  replay: Uint8Array = new Uint8Array(0);
  readonly viewers = new Set<TerminalViewer>();
  readonly written: Uint8Array[] = [];
  readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
  cols: number;
  rows: number;

  constructor(info: TerminalSessionInfo) {
    this.name = info.name;
    this.info = info;
    this.cols = info.cols;
    this.rows = info.rows;
  }

  attach(viewer: TerminalViewer): TerminalAttachment {
    this.viewers.add(viewer);
    return {
      replay: this.replay,
      cols: this.cols,
      rows: this.rows,
      detach: () => {
        this.viewers.delete(viewer);
      },
    };
  }

  write(data: Uint8Array): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
    for (const viewer of [...this.viewers]) viewer.onSize(cols, rows);
  }

  /** Output of the process: appended to the replay and sent to every viewer. */
  emit(data: Uint8Array): void {
    const next = new Uint8Array(this.replay.length + data.length);
    next.set(this.replay);
    next.set(data, this.replay.length);
    this.replay = next;
    for (const viewer of [...this.viewers]) viewer.onData(data);
  }

  /** The process ended: every viewer is told. */
  end(exit: TerminalExit): void {
    for (const viewer of [...this.viewers]) viewer.onExit(exit);
  }
}

class FakeSessionsPort implements TerminalSessionsPort {
  readonly byName = new Map<string, FakeSession>();
  readonly listeners = new Set<() => void>();
  readonly created: { readonly path: string }[] = [];
  readonly killed: string[] = [];
  /** Throws on the next `create` (then clears itself). */
  createFailure: Error | undefined;
  killFailure: Error | undefined;
  /** What `create` answers; by default a session named `demo-<n>` in the requested folder. */
  nextCreated: TerminalSessionInfo | undefined;
  private counter = 0;

  list(): readonly TerminalSessionInfo[] {
    return [...this.byName.values()].map((session) => ({ ...session.info, viewers: session.viewers.size }));
  }

  get(name: string): TerminalSessionPort | null {
    return this.byName.get(name) ?? null;
  }

  create(input: { readonly path: string }): Promise<TerminalSessionInfo> {
    this.created.push({ path: input.path });
    const failure = this.createFailure;
    if (failure !== undefined) {
      this.createFailure = undefined;
      return Promise.reject(failure);
    }
    this.counter += 1;
    const info = this.nextCreated ?? sessionInfo({ name: `demo-${String(this.counter)}`, path: input.path });
    this.nextCreated = undefined;
    this.add(new FakeSession(info));
    return Promise.resolve(info);
  }

  kill(name: string): Promise<boolean> {
    this.killed.push(name);
    const failure = this.killFailure;
    if (failure !== undefined) {
      this.killFailure = undefined;
      return Promise.reject(failure);
    }
    const session = this.byName.get(name);
    if (session === undefined) return Promise.resolve(false);
    session.end({ code: null, signal: 'SIGKILL', killed: true });
    this.remove(name);
    return Promise.resolve(true);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  add(session: FakeSession): void {
    this.byName.set(session.name, session);
    this.notify();
  }

  remove(name: string): void {
    this.byName.delete(name);
    this.notify();
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A dialog that answers when the test says so; an abort of its signal is recorded and settles it with `null`. */
export class FakePicker implements FolderPickerPort {
  calls = 0;
  aborted = 0;
  /** Throws on the next `pick` (then clears itself). */
  failure: Error | undefined;
  /** The answer of an immediate pick. */
  mode: string | null = null;
  /** Keeps the dialog open until `settle` is called (or the signal aborts). */
  hold = false;
  private pending: ((path: string | null) => void) | undefined;

  pick(signal: AbortSignal): Promise<string | null> {
    this.calls += 1;
    // one dialog at a time, as the engine's picker (a second concurrent call is `picker_busy`)
    if (this.pending !== undefined) return Promise.reject(new FakeTerminalError('picker_busy'));
    const failure = this.failure;
    if (failure !== undefined) {
      this.failure = undefined;
      return Promise.reject(failure);
    }
    if (!this.hold) return Promise.resolve(this.mode);
    return new Promise<string | null>((resolve) => {
      this.pending = resolve;
      signal.addEventListener(
        'abort',
        () => {
          this.aborted += 1;
          if (this.pending === resolve) this.pending = undefined;
          resolve(null);
        },
        { once: true },
      );
    });
  }

  /** Closes the open dialog with the folder the person chose. */
  settle(path: string | null): void {
    this.pending?.(path);
    this.pending = undefined;
  }

  get open(): boolean {
    return this.pending !== undefined;
  }
}

/** The terminal host of the tests: everything the routes and the event feed ask of it, scriptable and recorded. */
export class FakeTerminalPorts implements TerminalPorts {
  capabilitiesValue: TerminalCapabilities = availableCapabilities();
  readonly sessions = new FakeSessionsPort();
  readonly fakePicker = new FakePicker();
  hasPicker = true;
  readonly resumed: { readonly sessionId: string; readonly fork: boolean }[] = [];
  resumeFailure: Error | undefined;
  nextResumed: TerminalSessionInfo | undefined;
  capabilityReads = 0;

  readonly capabilities = (): TerminalCapabilities => {
    this.capabilityReads += 1;
    return this.capabilitiesValue;
  };

  get picker(): FolderPickerPort | null {
    return this.hasPicker ? this.fakePicker : null;
  }

  resume(input: { readonly sessionId: string; readonly fork: boolean }): Promise<TerminalSessionInfo> {
    this.resumed.push({ sessionId: input.sessionId, fork: input.fork });
    const failure = this.resumeFailure;
    if (failure !== undefined) {
      this.resumeFailure = undefined;
      return Promise.reject(failure);
    }
    const info =
      this.nextResumed ?? sessionInfo({ name: 'resumed-1', link: { ...pendingLink(), sessionId: input.sessionId } });
    this.nextResumed = undefined;
    this.sessions.add(new FakeSession(info));
    return Promise.resolve(info);
  }

  /** Adds a live session (the feed and the state see it at once). */
  addSession(overrides: Partial<TerminalSessionInfo> = {}): FakeSession {
    const session = new FakeSession(sessionInfo(overrides));
    this.sessions.add(session);
    return session;
  }

  removeSession(name: string): void {
    this.sessions.remove(name);
  }

  /** Tells the subscribers that a link changed (the membership did not). */
  touch(): void {
    this.sessions.notify();
  }

  /** The number of listeners on the session list: the feed holds one only while a client is connected. */
  get listenerCount(): number {
    return this.sessions.listeners.size;
  }
}

// ---- the app around the host ---------------------------------------------------------------------------------------------------

// FIXTURE: invented data for tests
export const FAKE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const START = Date.UTC(2026, 9, 11, 14, 5, 7);

export interface TerminalApp {
  readonly port: number;
  readonly ctx: InstanceContext;
  readonly clock: FakeClock;
  readonly access: AccessService;
  /** The host the routes were given (`null` when the app was started without one). */
  readonly ports: FakeTerminalPorts | null;
  /** The log file of the instance: a test scans it for what must never be written. */
  readonly logFile: string;
  /** The feed of the event route, once mounted. */
  readonly events: () => TerminalEvents;
  /** The HTTP server (a test looks at its connections). */
  readonly server: Server;
  /** The socket gateway; present when the app was started with the `socket` option. */
  readonly gateway: TerminalGateway | null;
}

export interface TerminalAppOptions {
  /** The host; default a fresh `FakeTerminalPorts`; `null` is an instance without a usable host. */
  readonly ports?: FakeTerminalPorts | null;
  /** Shorter limits of the event feed. */
  readonly eventLimits?: Partial<TerminalEventLimits>;
  /**
   * Mounts the socket route, creates the gateway and wires the `upgrade` listener of the server, as the boot code does for a
   * user instance (CAW-25). `limits` shortens the limits and intervals of the gateway. Without it no socket exists.
   */
  readonly socket?: { readonly limits?: Partial<TerminalSocketLimits> };
  /** `server.requestTimeoutMs` of the HTTP server; default the configured one. */
  readonly requestTimeoutMs?: number;
  /** Shortened timings of the HTTP server (the headers and keep-alive timeouts and the check interval). */
  readonly timing?: ServerTiming;
}

const running: {
  server: Server;
  ctx: InstanceContext;
  port: number;
  temp: TempDir;
  gateway: TerminalGateway | null;
}[] = [];

/** Starts one user instance with the access, terminal and event routes. */
export async function startTerminalApp(options: TerminalAppOptions = {}): Promise<TerminalApp> {
  const ports = options.ports === undefined ? new FakeTerminalPorts() : options.ports;
  const temp = makeTempDir('terminal-app-int');
  const root = temp.path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(START);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => FAKE_INSTANCE_ID });
  const logFile = path.join(root, 'runtime.log');
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: createLogger({ file: logFile, level: 'debug', rotate: false, clock }),
  });
  const access = createAccessService({ clock });
  const port = await allocatePort();
  let events: TerminalEvents | undefined;
  const upgrades = createUpgradeRegistry();
  const gateway =
    options.socket === undefined
      ? null
      : createTerminalGateway({
          access,
          logger: ctx.logger,
          ...(options.socket.limits === undefined ? {} : { limits: options.socket.limits }),
        });
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    access: createAccessVerifier(access, ctx.instanceId),
    extraModules: [
      createAuthRoutes({ access, instanceId: ctx.instanceId }),
      createTerminalRoutes({ ports, epoch: ctx.db.epoch, now: () => ctx.clock.now() }),
      createTerminalEventsRoutes({
        ports,
        access,
        epoch: ctx.db.epoch,
        now: () => ctx.clock.now(),
        ...(options.eventLimits === undefined ? {} : { limits: options.eventLimits }),
        onEvents: (created) => {
          events = created;
        },
      }),
      ...(gateway === null ? [] : [createTerminalSocketRoutes({ ports, gateway, upgrades })]),
    ],
  });
  const server = createHttpServer(
    app,
    options.requestTimeoutMs ?? ctx.config.runtime.server.requestTimeoutMs,
    options.timing,
  );
  if (gateway !== null) server.on('upgrade', upgrades.listener(app));
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  running.push({ server, ctx, port, temp, gateway });
  return {
    port,
    ctx,
    clock,
    access,
    ports,
    logFile,
    server,
    gateway,
    events: () => {
      if (events === undefined) throw new Error('the event routes are not mounted');
      return events;
    },
  };
}

/** Closes every app `startTerminalApp` started (call it in `afterEach`). */
export async function stopTerminalApps(): Promise<void> {
  for (const { server, ctx, port, temp, gateway } of running.splice(0)) {
    // `closeAllConnections` does not know an upgraded socket: the gateway closes its own first (design 02 5.5)
    await gateway?.closeAll(1001, 'shutting_down');
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await ctx.logger.close();
    await assertPortClosed(port);
    temp.remove();
  }
}
