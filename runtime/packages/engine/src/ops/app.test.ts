// `ops.app` (06 2.4, 3): the lifecycle of the user instance over scripted dependencies. The workspace is the real one that
// `ensureUserInstance` makes in a temp MCS_HOME; the lifecycle operations, the probe, the control channel, the browser, the
// autostart shortcut and the upgrade are scripted, so every sequence is proven without a process, a port or a window. What the
// real operations do is proven by the lifecycle tests and, on real processes, by the integration tests of the user instance.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError, RUNTIME_VERSION, type AutostartStatus, type CliErrorCode, type UpgradeResult } from '@mcs/shared';
import { ACCESS_CODE_TTL_SECONDS, appBrowserUrl, buildLoginUrl, type ControlRequest } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import type { OpenOutcome } from '../platform/browser.ts';
import { userBrowserProfileDirOf, userInstanceDirOf, userOpContext, userRootOf } from '../user-instance/paths.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import {
  restartUser,
  serveUser,
  startUser,
  statusUser,
  stopUser,
  openUser,
  userInstanceExists,
  verifyUser,
  type UserDeps,
  type UserLifecycle,
} from './app.ts';
import type {
  ServeResult,
  StartInput,
  StartResult,
  StatusReport,
  StopInput,
  StopResult,
  VerifyResult,
} from './lifecycle.ts';
import type { ControlAttempt, IdentifyResponse, ProbeResult, ProbeState } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

const TOKEN = 'ab'.repeat(32);
const CODE = 'Zx9_-'.repeat(8); // 40 characters of the access code alphabet
const PORT = 18123;
const SERVER_PID = 4242;
const EXPIRES = '2026-11-14T10:02:00.000Z';
const NODE_PATH = 'C:\\node\\node.exe';

// ---- the world -------------------------------------------------------------------------------------------------------------------

interface Calls {
  readonly start: { ctx: OpContext; input: StartInput }[];
  readonly stop: StopInput[];
  readonly status: unknown[];
  readonly verify: unknown[];
  readonly serve: { port?: number | undefined; logLevel?: string | undefined; task?: string | undefined }[];
  readonly upgrade: { task: string; yes?: boolean }[];
  readonly control: ControlRequest[];
  readonly browser: { url: string; mode: 'window' | 'tab'; profileDir: string }[];
  readonly autostart: { launcherPath: string; nodePath: string }[];
  readonly settings: { port?: number | undefined }[];
  readonly order: string[];
}

interface World {
  readonly ctx: OpContext;
  readonly home: string;
  readonly calls: Calls;
  readonly deps: UserDeps;
  /** The workspace of the user instance (exists once something has ensured it). */
  readonly ws: () => WorkspaceRef;
  // scripts
  probes: ProbeResult[];
  /** The port that `lifecycle.start` reports. */
  startPort: number;
  startFails: McsError | null;
  upgradeAnswers: UpgradeResult[];
  upgradeFails: McsError | null;
  /** What the control channel answers to `access`, `terminals` and `shutdown`. */
  access: ControlAttempt;
  terminals: ControlAttempt;
  browserAnswer: OpenOutcome;
  autostartAnswer: 'absent' | 'current' | 'refreshed' | 'foreign-target' | Error;
  autostartState: AutostartStatus;
  settings: { effectivePort: number; openAppWindow: boolean };
  stamp: string | null;
  stopFails: McsError | null;
  stopResult: StopResult | null;
  statusReport: StatusReport;
  statusExit: 0 | 1;
}

function accessReply(code = CODE): ControlAttempt {
  return {
    kind: 'reply',
    response: { v: 1, ok: true, op: 'access', code, expiresAt: EXPIRES, ttlSeconds: ACCESS_CODE_TTL_SECONDS },
  };
}

function terminalsReply(live: number, max = 8): ControlAttempt {
  return { kind: 'reply', response: { v: 1, ok: true, op: 'terminals', live, max, sessions: [] } };
}

const AUTOSTART_OFF: AutostartStatus = {
  supported: true,
  enabled: false,
  shortcut: null,
  target: null,
  arguments: null,
  targetExists: null,
  matchesLauncher: null,
  note: null,
};

function probeOf(state: ProbeState, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    state,
    engine: state === 'stopped' ? null : 'node',
    pid: state === 'stopped' ? null : SERVER_PID,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: `scripted ${state}`,
    ...over,
  };
}

function runningProbe(instanceId: string, over: Partial<IdentifyResponse> = {}, port = PORT): ProbeResult {
  const identity: IdentifyResponse = {
    v: 1,
    ok: true,
    op: 'identify',
    instanceId,
    pid: SERVER_PID,
    phase: 'ready',
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'stamp-a',
    port,
    url: `http://127.0.0.1:${String(port)}`,
    startedAt: '2026-11-14T08:00:00.000Z',
    ...over,
  };
  return probeOf('running', { port, url: `http://127.0.0.1:${String(port)}`, identity });
}

function dryRun(over: Partial<UpgradeResult['plan']> = {}): UpgradeResult {
  return {
    task: 'user',
    outcome: 'dry-run',
    plan: {
      runtimeFrom: '4.0.0',
      runtimeTo: RUNTIME_VERSION,
      db: null,
      files: [],
      needed: true,
      backup: '20261114T100000Z-upgrade',
      ...over,
    },
    backup: null,
    integrity: null,
    restart: null,
    pruned: [],
    exitCode: 0,
  };
}

function current(): UpgradeResult {
  return {
    task: 'user',
    outcome: 'current',
    plan: {
      runtimeFrom: RUNTIME_VERSION,
      runtimeTo: RUNTIME_VERSION,
      db: null,
      files: [],
      needed: false,
      backup: null,
    },
    backup: null,
    integrity: null,
    restart: null,
    pruned: [],
    exitCode: 0,
  };
}

function upgraded(backup: string): UpgradeResult {
  return { ...dryRun(), outcome: 'upgraded', backup };
}

function world(): World {
  const root = makeTemp('app-ops').path;
  const skillDir = defaultSkillDir();
  const runtimeDir = path.join(root, 'skill', 'runtime');
  const base = {
    skillDir,
    runtimeDir,
    launcherPath: path.join(root, 'skill', 'scripts', 'caw.mjs'),
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    clock: new FakeClock(Date.UTC(2026, 10, 14, 10)),
    log: silent,
  };
  const ctx = userOpContext(base);
  const calls: Calls = {
    start: [],
    stop: [],
    status: [],
    verify: [],
    serve: [],
    upgrade: [],
    control: [],
    browser: [],
    autostart: [],
    settings: [],
    order: [],
  };
  const ws = (): WorkspaceRef => resolveWorkspace(ctx.root, 'user');
  const w: World = {
    ctx,
    home: base.env.MCS_HOME,
    calls,
    deps: {},
    ws,
    probes: [probeOf('stopped')],
    startPort: PORT,
    startFails: null,
    upgradeAnswers: [current()],
    upgradeFails: null,
    access: accessReply(),
    terminals: terminalsReply(0),
    browserAnswer: { opened: true, how: 'default-browser' },
    autostartAnswer: 'absent',
    autostartState: AUTOSTART_OFF,
    settings: { effectivePort: PORT, openAppWindow: false },
    stamp: 'stamp-a',
    stopFails: null,
    stopResult: null,
    statusReport: { running: false, state_file: '', engine: null, probe: 'stopped', instance_id: null },
    statusExit: 1,
  };

  const instanceIdOf = (): string => {
    const text = readFileSync(path.join(ws().dir, 'instance.json'), 'utf8');
    return (JSON.parse(text) as { instanceId: string }).instanceId;
  };
  const startResult = (): StartResult => ({
    outcome: 'started',
    slug: 'user',
    dir: ws().dir,
    instanceId: instanceIdOf(),
    engine: 'node',
    url: `http://127.0.0.1:${String(w.startPort)}`,
    pid: SERVER_PID,
    createdDefault: false,
    adopted: false,
    opened: null,
    exitCode: 0,
    message: [`started: http://127.0.0.1:${String(w.startPort)} (pid ${String(SERVER_PID)})`],
    warnings: [],
  });
  const lifecycle: UserLifecycle = {
    start: (c, input = {}) => {
      calls.order.push('start');
      calls.start.push({ ctx: c, input });
      if (w.startFails !== null) return Promise.reject(w.startFails);
      writeToken(w); // the server writes its control token when it comes up
      return Promise.resolve(startResult());
    },
    stop: (_c, input = {}) => {
      calls.order.push('stop');
      calls.stop.push(input);
      if (w.stopFails !== null) return Promise.reject(w.stopFails);
      w.probes = [probeOf('stopped')]; // the app is gone after a stop
      return Promise.resolve(
        w.stopResult ?? {
          outcome: 'stopped',
          slug: 'user',
          pid: SERVER_PID,
          url: `http://127.0.0.1:${String(PORT)}`,
          forced: false,
          reason: null,
          terminalsEnded: 0,
          exitCode: 0,
          message: [`stopped runtime pid ${String(SERVER_PID)} (http://127.0.0.1:${String(PORT)})`],
        },
      );
    },
    status: (_c, input) => {
      calls.order.push('status');
      calls.status.push(input);
      return Promise.resolve({ report: w.statusReport, exitCode: w.statusExit });
    },
    verify: (_c, input) => {
      calls.order.push('verify');
      calls.verify.push(input);
      const result: VerifyResult = {
        slug: 'user',
        url: `http://127.0.0.1:${String(PORT)}`,
        sessions: 0,
        exitCode: 0,
        message: ['verified'],
      };
      return Promise.resolve(result);
    },
    serveForeground: (_c, input = {}) => {
      calls.order.push('serve');
      calls.serve.push({ port: input.port, logLevel: input.logLevel, task: input.task });
      const result: ServeResult = { slug: 'user', exitCode: 0, message: [], warnings: [], interrupted: false };
      return Promise.resolve(result);
    },
  };
  const deps: UserDeps = {
    lifecycle,
    probe: () => {
      const next = w.probes.length > 1 ? w.probes.shift() : w.probes[0];
      return Promise.resolve(next ?? probeOf('stopped'));
    },
    control: (_address, message) => {
      calls.order.push(`control:${message.op}`);
      calls.control.push(message);
      if (message.op === 'access') return Promise.resolve(w.access);
      if (message.op === 'terminals') return Promise.resolve(w.terminals);
      return Promise.resolve({ kind: 'absent' });
    },
    upgrade: (_c, input) => {
      calls.order.push(input.yes === true ? 'upgrade:apply' : 'upgrade:plan');
      calls.upgrade.push({ task: input.task, ...(input.yes === undefined ? {} : { yes: input.yes }) });
      if (w.upgradeFails !== null) return Promise.reject(w.upgradeFails);
      const answer = w.upgradeAnswers.length > 1 ? w.upgradeAnswers.shift() : w.upgradeAnswers[0];
      return Promise.resolve(answer ?? current());
    },
    openBrowser: (input) => {
      calls.order.push('browser');
      calls.browser.push(input);
      return Promise.resolve(w.browserAnswer);
    },
    autostart: (_c, target) => {
      calls.order.push('autostart');
      calls.autostart.push(target);
      return w.autostartAnswer instanceof Error
        ? Promise.reject(w.autostartAnswer)
        : Promise.resolve(w.autostartAnswer);
    },
    autostartStatus: () => Promise.resolve(w.autostartState),
    settings: (_c, _ws, cli) => {
      calls.settings.push(cli);
      return Promise.resolve(w.settings);
    },
    stamp: () => Promise.resolve(w.stamp),
    nodePath: NODE_PATH,
  };
  return Object.assign(w, { deps });
}

/** Makes the token file the open flow reads. */
function writeToken(w: World): void {
  mkdirSync(path.join(w.ws().dir, 'run'), { recursive: true });
  writeFileSync(path.join(w.ws().dir, 'run', 'control.token'), `${TOKEN}\n`);
}

/** The user instance exists (the real `ensureUserInstance` ran) and `lifecycle.start` finds it already running. */
async function runningWorld(over: Partial<IdentifyResponse> = {}, port = PORT): Promise<World> {
  const w = world();
  await startUser(w.ctx, {}, w.deps); // creates the workspace
  w.calls.order.length = 0;
  w.calls.start.length = 0;
  w.calls.upgrade.length = 0;
  w.calls.control.length = 0;
  w.calls.browser.length = 0;
  w.calls.autostart.length = 0;
  w.calls.settings.length = 0;
  const id = (JSON.parse(readFileSync(path.join(w.ws().dir, 'instance.json'), 'utf8')) as { instanceId: string })
    .instanceId;
  w.probes = [runningProbe(id, over, port)];
  w.settings = { effectivePort: port, openAppWindow: false };
  return w;
}

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

const expectCode = (error: McsError, code: CliErrorCode): void => {
  expect(error.code, error.message).toBe(code);
};

const URL_OF = (port: number): string => appBrowserUrl(port);

// ---- startUser -----------------------------------------------------------------------------------------------------------------

describe('startUser: the app is not running (06 2.4)', () => {
  it('makes the instance, plans the upgrade, starts it through the lifecycle, and opens nothing and mints nothing without open', async () => {
    const w = world();
    const result = await startUser(w.ctx, { port: 18200, logLevel: 'debug', timeoutMs: 9000 }, w.deps);
    expect(readFileSync(path.join(userInstanceDirOf(w.ctx.env), 'instance.json'), 'utf8')).toContain('"kind": "user"');
    expect(w.calls.order).toEqual(['upgrade:plan', 'start', 'autostart']);
    expect(w.calls.upgrade).toEqual([{ task: 'user' }]);
    expect(w.calls.start).toHaveLength(1);
    expect(w.calls.start[0]?.input).toEqual({ task: 'user', port: 18200, logLevel: 'debug', timeoutMs: 9000 });
    expect(w.calls.start[0]?.ctx.root).toBe(userRootOf(w.ctx.env));
    expect(w.calls.control).toEqual([]);
    expect(w.calls.browser).toEqual([]);
    expect(result).toMatchObject({
      scope: 'user',
      outcome: 'started',
      slug: 'user',
      engine: 'node',
      pid: SERVER_PID,
      url: `http://127.0.0.1:${String(PORT)}`,
      browserUrl: URL_OF(PORT),
      createdDefault: true,
      portNote: null,
      outdated: false,
      upgraded: null,
      login: null,
      browser: null,
      opened: null,
      exitCode: 0,
      warnings: [],
    });
    expect(result.message).toEqual([
      `started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`,
      'next: caw open  (caw open --print gives a login URL)',
    ]);
  });

  it("does not pass open to the lifecycle: the browser is this module's business, not the generic start's", async () => {
    const w = world();
    await startUser(w.ctx, { open: true }, w.deps);
    expect(Object.hasOwn(w.calls.start[0]?.input ?? {}, 'open')).toBe(false);
  });

  it('uses a context of the user root whatever root the caller gave', async () => {
    const w = world();
    const wrong: OpContext = { ...w.ctx, repo: path.join(w.home, 'elsewhere'), root: path.join(w.home, 'elsewhere') };
    await startUser(wrong, {}, w.deps);
    expect(w.calls.start[0]?.ctx.root).toBe(userRootOf(w.ctx.env));
    expect(w.calls.start[0]?.ctx.repo).toBe(userRootOf(w.ctx.env));
  });

  it('a lifecycle refusal (a database from a newer runtime, a hung monitor) propagates and nothing else happens', async () => {
    const w = world();
    w.startFails = new McsError('DB_NEWER_THAN_RUNTIME', 'the database is newer');
    expectCode(await failure(startUser(w.ctx, { open: true }, w.deps)), 'DB_NEWER_THAN_RUNTIME');
    expect(w.calls.browser).toEqual([]);
    expect(w.calls.control).toEqual([]);
    expect(w.calls.autostart).toEqual([]);
  });
});

describe('startUser: the auto-upgrade (06 1.10, D13)', () => {
  it('plans first, and when the plan says dry-run applies it with yes: the person never runs `upgrade`', async () => {
    const w = world();
    w.upgradeAnswers = [dryRun(), upgraded('20261114T100000Z-upgrade')];
    const result = await startUser(w.ctx, {}, w.deps);
    expect(w.calls.order).toEqual(['upgrade:plan', 'upgrade:apply', 'start', 'autostart']);
    expect(w.calls.upgrade).toEqual([{ task: 'user' }, { task: 'user', yes: true }]);
    expect(result.upgraded).toEqual({
      backup: '20261114T100000Z-upgrade',
      runtimeFrom: '4.0.0',
      runtimeTo: RUNTIME_VERSION,
    });
    expect(result.message).toContain(
      `upgraded the app: runtime 4.0.0 -> ${RUNTIME_VERSION} (backup 20261114T100000Z-upgrade)`,
    );
    expect(result.message.at(-1)).toBe('next: caw open  (caw open --print gives a login URL)');
  });

  it('nothing to upgrade: one call, no backup', async () => {
    const w = world();
    const result = await startUser(w.ctx, {}, w.deps);
    expect(w.calls.upgrade).toEqual([{ task: 'user' }]);
    expect(result.upgraded).toBeNull();
  });

  it('a runtime older than the instance (DOWNGRADE_REFUSED) propagates before anything starts, opens or is minted', async () => {
    const w = world();
    w.upgradeFails = new McsError('DOWNGRADE_REFUSED', 'this instance was upgraded by a newer runtime', {
      hint: 'run the command with the newer runtime',
    });
    const error = await failure(startUser(w.ctx, { open: true }, w.deps));
    expectCode(error, 'DOWNGRADE_REFUSED');
    expect(error.hint).toBe('run the command with the newer runtime');
    expect(w.calls.start).toEqual([]);
    expect(w.calls.browser).toEqual([]);
    expect(w.calls.control).toEqual([]);
  });

  it('is skipped when a monitor is live but not running (starting, hung): the generic start refuses or follows it', async () => {
    for (const state of ['starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const) {
      const w = world();
      w.probes = [probeOf(state)];
      await startUser(w.ctx, {}, w.deps);
      expect(w.calls.upgrade, state).toEqual([]);
      expect(w.calls.start, state).toHaveLength(1);
    }
  });

  it('is done for a stale or foreign state file, which no process holds', async () => {
    for (const state of ['stale', 'foreign-pid'] as const) {
      const w = world();
      w.probes = [probeOf(state)];
      await startUser(w.ctx, {}, w.deps);
      expect(w.calls.upgrade, state).toEqual([{ task: 'user' }]);
    }
  });
});

describe('startUser: the app already runs', () => {
  it('reports it without starting, upgrading or restarting anything', async () => {
    const w = await runningWorld();
    const result = await startUser(w.ctx, {}, w.deps);
    expect(w.calls.start).toEqual([]);
    expect(w.calls.upgrade).toEqual([]);
    expect(w.calls.stop).toEqual([]);
    expect(result).toMatchObject({
      scope: 'user',
      outcome: 'already-running',
      pid: SERVER_PID,
      url: `http://127.0.0.1:${String(PORT)}`,
      browserUrl: URL_OF(PORT),
      createdDefault: false,
      outdated: false,
      upgraded: null,
      exitCode: 0,
      warnings: [],
    });
    expect(result.message[0]).toBe(`already running: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`);
  });

  it('an outdated one is only warned about, never restarted; live terminals are named and --force is mentioned', async () => {
    const w = await runningWorld({ codeStamp: 'stamp-old' });
    w.stamp = 'stamp-new';
    w.terminals = terminalsReply(2);
    const result = await startUser(w.ctx, {}, w.deps);
    expect(result.outdated).toBe(true);
    expect(result.warnings).toEqual([
      'the running app is outdated; run `caw restart --force` to use the new code (2 terminal sessions are live and would end)',
    ]);
    expect(w.calls.stop).toEqual([]);
    expect(w.calls.start).toEqual([]);
  });

  it('an outdated one without terminals says plain `caw restart`; with an unknown census too', async () => {
    const quiet = await runningWorld({ codeStamp: 'stamp-old' });
    quiet.stamp = 'stamp-new';
    expect((await startUser(quiet.ctx, {}, quiet.deps)).warnings).toEqual([
      'the running app is outdated; run `caw restart` to use the new code',
    ]);
    const unknown = await runningWorld({ codeStamp: 'stamp-old' });
    unknown.stamp = 'stamp-new';
    unknown.terminals = { kind: 'silent', reason: 'timeout' };
    expect((await startUser(unknown.ctx, {}, unknown.deps)).warnings).toEqual([
      'the running app is outdated; run `caw restart` to use the new code',
    ]);
  });

  it('a stamp that cannot be read is not "outdated"', async () => {
    const w = await runningWorld({ codeStamp: 'stamp-old' });
    w.stamp = null;
    const result = await startUser(w.ctx, {}, w.deps);
    expect(result.outdated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(w.calls.control).toEqual([]);
  });

  it('says that --port is ignored when it names another port than the one the app runs on', async () => {
    const w = await runningWorld();
    const result = await startUser(w.ctx, { port: 18999 }, w.deps);
    expect(result.warnings).toEqual([`--port 18999 is ignored: the app is already running on port ${String(PORT)}`]);
    expect(w.calls.settings).toEqual([{}]);
    const same = await startUser(w.ctx, { port: PORT }, w.deps);
    expect(same.warnings).toEqual([]);
  });
});

describe('startUser: the port note (06 1.5)', () => {
  it('says that the configured port was busy and which one is used', async () => {
    const w = world();
    w.startPort = 7691;
    w.settings = { effectivePort: 7690, openAppWindow: false };
    const result = await startUser(w.ctx, {}, w.deps);
    expect(result).toMatchObject({
      configuredPort: 7690,
      portNote: '7690 was busy; using 7691',
      browserUrl: URL_OF(7691),
    });
    expect(result.message).toContain('note: 7690 was busy; using 7691');
    expect(result.message[0]).toBe(`started: ${URL_OF(7691)} (pid ${String(SERVER_PID)})`);
  });

  it('has no note when the configured port is the one used, and reads the configuration with the --port of the call', async () => {
    const w = world();
    const result = await startUser(w.ctx, { port: PORT }, w.deps);
    expect(result.portNote).toBeNull();
    expect(result.configuredPort).toBe(PORT);
    expect(w.calls.settings).toEqual([{ port: PORT }]);
    expect(result.message.some((line) => line.startsWith('note:'))).toBe(false);
  });

  it('describes a busy configured port of an instance that already runs on the next one', async () => {
    const w = await runningWorld({}, 7691);
    w.settings = { effectivePort: 7690, openAppWindow: false };
    const result = await startUser(w.ctx, {}, w.deps);
    expect(result.portNote).toBe('7690 was busy; using 7691');
  });
});

describe('startUser: the autostart shortcut (06 2.7, amendment A5)', () => {
  it('asks to heal it with the launcher and the node of this run, after the start, and says nothing when it is absent or current', async () => {
    for (const answer of ['absent', 'current'] as const) {
      const w = world();
      w.autostartAnswer = answer;
      const result = await startUser(w.ctx, {}, w.deps);
      expect(w.calls.autostart).toEqual([{ launcherPath: w.ctx.launcherPath, nodePath: NODE_PATH }]);
      expect(w.calls.order.indexOf('autostart')).toBeGreaterThan(w.calls.order.indexOf('start'));
      expect(result.warnings, answer).toEqual([]);
      expect(result.message.join('\n'), answer).not.toContain('autostart');
    }
  });

  it('says it when the shortcut was rewritten', async () => {
    const w = world();
    w.autostartAnswer = 'refreshed';
    expect((await startUser(w.ctx, {}, w.deps)).message).toContain('refreshed the autostart shortcut');
  });

  it('a shortcut of another launcher is not touched: the warning names the command that refreshes it', async () => {
    const w = world();
    w.autostartAnswer = 'foreign-target';
    expect((await startUser(w.ctx, {}, w.deps)).warnings).toEqual([
      'the autostart shortcut points to another launcher; run `caw autostart enable` to refresh it',
    ]);
  });

  it('a failure to heal is a warning, never a failed start', async () => {
    const w = world();
    w.autostartAnswer = new McsError(
      'INTERNAL',
      'could not create the autostart shortcut: Windows refused the shortcut object.',
    );
    const result = await startUser(w.ctx, {}, w.deps);
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('started');
    expect(result.warnings).toEqual([
      'could not refresh the autostart shortcut: could not create the autostart shortcut: Windows refused the shortcut object.',
    ]);
    const other = world();
    other.autostartAnswer = new Error('D:\\profile\\secret path exploded');
    expect((await startUser(other.ctx, {}, other.deps)).warnings).toEqual(['could not refresh the autostart shortcut']);
  });

  it('is also healed when the app already runs', async () => {
    const w = await runningWorld();
    await startUser(w.ctx, {}, w.deps);
    expect(w.calls.autostart).toHaveLength(1);
  });
});

const idOf = (w: World): string =>
  (JSON.parse(readFileSync(path.join(w.ws().dir, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;

describe('startUser: the open flow (06 2.4, 2.5, 5.2)', () => {
  it('mints one code over the control channel with the token, builds the login URL and opens it in a tab; no code is shown', async () => {
    const w = world();
    const result = await startUser(w.ctx, { open: true }, w.deps);
    expect(w.calls.control).toEqual([{ v: 1, op: 'access', instanceId: idOf(w), token: TOKEN }]);
    expect(w.calls.browser).toEqual([
      { url: buildLoginUrl(PORT, CODE), mode: 'tab', profileDir: userBrowserProfileDirOf(w.ctx.env) },
    ]);
    expect(w.calls.order.slice(-3)).toEqual(['autostart', 'control:access', 'browser']);
    expect(result).toMatchObject({ browser: 'default-browser', login: null, opened: true });
    expect(result.message).toContain('opened: default browser tab');
    expect(result.message.some((line) => line.startsWith('next:'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('opens the login URL of the real port, not of the configured one', async () => {
    const w = world();
    w.startPort = 7691;
    w.settings = { effectivePort: 7690, openAppWindow: false };
    await startUser(w.ctx, { open: true }, w.deps);
    expect(w.calls.browser[0]?.url).toBe(buildLoginUrl(7691, CODE));
  });

  it('opens an already running app too', async () => {
    const w = await runningWorld();
    await startUser(w.ctx, { open: true }, w.deps);
    expect(w.calls.start).toEqual([]);
    expect(w.calls.control).toHaveLength(1);
    expect(w.calls.browser).toHaveLength(1);
  });

  it('the mode is --window or --tab, else app.openAppWindow of the configuration', async () => {
    const modes: [{ browser?: 'window' | 'tab' }, boolean, 'window' | 'tab'][] = [
      [{}, false, 'tab'],
      [{}, true, 'window'],
      [{ browser: 'window' }, false, 'window'],
      [{ browser: 'tab' }, true, 'tab'],
    ];
    for (const [input, openAppWindow, mode] of modes) {
      const w = world();
      w.settings = { effectivePort: PORT, openAppWindow };
      await startUser(w.ctx, { open: true, ...input }, w.deps);
      expect(w.calls.browser[0]?.mode, JSON.stringify([input, openAppWindow])).toBe(mode);
    }
  });

  it('says "opened: app window" for a window, and a window that fell back to a tab says why', async () => {
    const window = world();
    window.browserAnswer = { opened: true, how: 'app-window' };
    const opened = await startUser(window.ctx, { open: true, browser: 'window' }, window.deps);
    expect(opened).toMatchObject({ browser: 'app-window', opened: true });
    expect(opened.message).toContain('opened: app window');

    for (const [fallback, why] of [
      ['no-browser', 'Edge or Chrome was not found'],
      ['spawn-failed', 'it did not start'],
    ] as const) {
      const w = world();
      w.browserAnswer = { opened: true, how: 'default-browser', fallback };
      const result = await startUser(w.ctx, { open: true, browser: 'window' }, w.deps);
      expect(result.browser).toBe('default-browser');
      expect(result.warnings).toEqual([`an app window was requested but ${why}; opened a browser tab instead`]);
    }
  });

  it('the test-file hook of the browser module counts as a default browser', async () => {
    const w = world();
    w.browserAnswer = { opened: true, how: 'test-file' };
    expect((await startUser(w.ctx, { open: true }, w.deps)).browser).toBe('default-browser');
  });

  it('a browser that could not be opened leaves the unused login URL in `login`, and never in a warning or a line', async () => {
    const w = world();
    w.browserAnswer = { opened: false, reason: 'spawn-failed' };
    const result = await startUser(w.ctx, { open: true }, w.deps);
    expect(result).toMatchObject({
      exitCode: 0,
      browser: null,
      opened: false,
      login: { url: buildLoginUrl(PORT, CODE), expiresAt: EXPIRES, ttlSeconds: ACCESS_CODE_TTL_SECONDS },
    });
    expect(result.warnings).toEqual(['could not open a browser (spawn-failed)']);
    expect(JSON.stringify([result.warnings, result.message])).not.toContain(CODE);
    expect(result.message.some((line) => line.startsWith('next:'))).toBe(false);
  });

  it('--print mints a code and shows it instead of opening a browser', async () => {
    const w = world();
    const result = await startUser(w.ctx, { print: true }, w.deps);
    expect(w.calls.browser).toEqual([]);
    expect(w.calls.control).toHaveLength(1);
    expect(result).toMatchObject({
      browser: null,
      opened: null,
      login: { url: buildLoginUrl(PORT, CODE), expiresAt: EXPIRES, ttlSeconds: 120 },
    });
    expect(result.message).toContain(`login: ${buildLoginUrl(PORT, CODE)}  (single use, 120 s)`);
    expect(result.message.some((line) => line.startsWith('next:'))).toBe(false);
  });

  it('--print wins over open: one code, nothing opened', async () => {
    const w = world();
    await startUser(w.ctx, { open: true, print: true }, w.deps);
    expect(w.calls.browser).toEqual([]);
    expect(w.calls.control).toHaveLength(1);
  });

  it('a code is minted only when it is shown or opened: no mint without open or print', async () => {
    const w = world();
    await startUser(w.ctx, { open: false }, w.deps);
    await startUser(w.ctx, {}, w.deps);
    expect(w.calls.control).toEqual([]);
  });

  it('when the app cannot give a code, opening is a warning and the start stands; --print is the error', async () => {
    const answers: [string, ControlAttempt | 'no-token'][] = [
      ['UNSUPPORTED', { kind: 'refusal', error: 'UNSUPPORTED' }],
      ['silent', { kind: 'silent', reason: 'timeout' }],
      ['absent', { kind: 'absent' }],
      ['wrong op', { kind: 'reply', response: { v: 1, ok: true, op: 'shutdown', phase: 'stopping' } }],
    ];
    for (const [name, answer] of answers) {
      const quiet = world();
      quiet.access = answer as ControlAttempt;
      const started = await startUser(quiet.ctx, { open: true }, quiet.deps);
      expect(started.outcome, name).toBe('started');
      expect(started.browser, name).toBeNull();
      expect(started.login, name).toBeNull();
      expect(started.warnings[0], name).toMatch(/^could not get a login code \(.+\); run `caw open` to try again$/);
      expect(quiet.calls.browser, name).toEqual([]);

      const loud = world();
      loud.access = answer as ControlAttempt;
      const error = await failure(startUser(loud.ctx, { print: true }, loud.deps));
      expectCode(error, 'API_ERROR');
      expect(error.message, name).toMatch(/^the app did not give a login code \(.+\)$/);
      expect(JSON.stringify([error.message, error.hint])).not.toContain(TOKEN);
    }
  });
});

describe('startUser: no token', () => {
  it('print is INSTANCE_NOT_RUNNING with a hint, open is a warning', async () => {
    const make = (): { w: World; deps: UserDeps } => {
      const w = world();
      const base = w.deps.lifecycle;
      if (base === undefined) throw new Error('the world scripts a lifecycle');
      // a lifecycle whose start leaves no usable control token behind
      const deps: UserDeps = {
        ...w.deps,
        lifecycle: {
          ...base,
          start: async (c, input = {}) => {
            const result = await base.start(c, input);
            writeFileSync(path.join(w.ws().dir, 'run', 'control.token'), 'not a token\n');
            return result;
          },
        },
      };
      return { w, deps };
    };
    const loud = make();
    const error = await failure(startUser(loud.w.ctx, { print: true }, loud.deps));
    expectCode(error, 'INSTANCE_NOT_RUNNING');
    expect(error.message).toBe('cannot ask the app for a login code: there is no control token');
    expect(error.hint).toBe('run `caw restart`, or `caw start` when the app is not running');
    expect(loud.w.calls.control).toEqual([]);

    const quiet = make();
    const result = await startUser(quiet.w.ctx, { open: true }, quiet.deps);
    expect(result.warnings).toEqual([
      'could not get a login code (there is no control token); run `caw open` to try again',
    ]);
    expect(quiet.w.calls.browser).toEqual([]);
  });
});

// ---- stopUser and restartUser --------------------------------------------------------------------------------------------------

describe('stopUser (06 3)', () => {
  it('nothing to stop when the app was never started: no workspace is made, the lifecycle is not asked', async () => {
    const w = world();
    const result = await stopUser(w.ctx, { force: true }, w.deps);
    expect(result).toEqual({
      scope: 'user',
      outcome: 'nothing-to-stop',
      slug: 'user',
      pid: null,
      url: null,
      forced: false,
      reason: null,
      terminalsEnded: 0,
      exitCode: 0,
      message: ['nothing to stop (the app was never started)'],
    });
    expect(w.calls.stop).toEqual([]);
    expect(existsSync(userInstanceDirOf(w.ctx.env))).toBe(false);
  });

  it('asks the lifecycle for the guarded stop of the user workspace, with --force and --timeout-ms', async () => {
    const w = await runningWorld();
    const result = await stopUser(w.ctx, { timeoutMs: 1234, force: true }, w.deps);
    expect(w.calls.stop).toEqual([{ task: 'user', purpose: 'stop', timeoutMs: 1234, force: true }]);
    expect(result).toMatchObject({ scope: 'user', outcome: 'stopped', exitCode: 0 });
  });

  it('without options the stop is told neither a timeout nor force', async () => {
    const w = await runningWorld();
    await stopUser(w.ctx, {}, w.deps);
    expect(w.calls.stop).toEqual([{ task: 'user', purpose: 'stop' }]);
    expect(Object.hasOwn(w.calls.stop[0] ?? {}, 'force')).toBe(false);
  });

  it('a refusal because terminals are live propagates with its details (exit 3)', async () => {
    const w = await runningWorld();
    w.stopFails = new McsError(
      'TERMINALS_LIVE',
      '2 terminal sessions are live (api-1, web-1); stopping would end them',
      {
        details: { live: 2, sessions: ['api-1', 'web-1'] },
      },
    );
    const error = await failure(stopUser(w.ctx, {}, w.deps));
    expectCode(error, 'TERMINALS_LIVE');
    expect(error.details).toEqual({ live: 2, sessions: ['api-1', 'web-1'] });
  });

  it('carries the number of ended terminals of a forced stop', async () => {
    const w = await runningWorld();
    w.stopResult = {
      outcome: 'stopped',
      slug: 'user',
      pid: SERVER_PID,
      url: null,
      forced: false,
      reason: null,
      terminalsEnded: 2,
      exitCode: 0,
      message: ['stopped runtime pid 4242 (-)', 'ended 2 terminal sessions'],
    };
    const result = await stopUser(w.ctx, { force: true }, w.deps);
    expect(result.terminalsEnded).toBe(2);
    expect(result.message).toContain('ended 2 terminal sessions');
  });
});

describe('restartUser (06 2.3, 3)', () => {
  it('is a guarded stop, and only when that succeeded, a start with the same options', async () => {
    const w = await runningWorld();
    const result = await restartUser(w.ctx, { force: true, port: 18300, logLevel: 'info', timeoutMs: 8000 }, w.deps);
    expect(w.calls.order.filter((step) => step === 'stop' || step === 'start')).toEqual(['stop', 'start']);
    expect(w.calls.stop).toEqual([{ task: 'user', purpose: 'restart', force: true }]);
    expect(w.calls.start[0]?.input).toEqual({ task: 'user', port: 18300, logLevel: 'info', timeoutMs: 8000 });
    expect(result).toMatchObject({ scope: 'user', exitCode: 0 });
    expect(result.stop.outcome).toBe('stopped');
    expect(result.start.outcome).toBe('started');
    expect(result.message[0]).toContain('stopped runtime pid');
    expect(result.message).toContain(`started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`);
  });

  it('a restart that applies an update also migrates: the start plans the upgrade after the stop', async () => {
    const w = await runningWorld();
    w.upgradeAnswers = [dryRun(), upgraded('20261114T100000Z-upgrade')];
    const result = await restartUser(w.ctx, {}, w.deps);
    expect(w.calls.order.filter((step) => step !== 'control:terminals')).toEqual(
      expect.arrayContaining(['stop', 'upgrade:plan', 'upgrade:apply', 'start']),
    );
    expect(w.calls.order.indexOf('stop')).toBeLessThan(w.calls.order.indexOf('upgrade:plan'));
    expect(result.start.upgraded?.backup).toBe('20261114T100000Z-upgrade');
  });

  it('a refused stop (terminals are live) changes nothing and starts nothing', async () => {
    const w = await runningWorld();
    w.stopFails = new McsError('TERMINALS_LIVE', '1 terminal session is live (api-1); restarting would end it');
    expectCode(await failure(restartUser(w.ctx, {}, w.deps)), 'TERMINALS_LIVE');
    expect(w.calls.start).toEqual([]);
    expect(w.calls.upgrade).toEqual([]);
  });

  it('with the app never started it says there was nothing to stop and starts (and so creates) it', async () => {
    const w = world();
    const result = await restartUser(w.ctx, {}, w.deps);
    expect(result.stop).toMatchObject({ outcome: 'nothing-to-stop' });
    expect(w.calls.stop).toEqual([]);
    expect(result.start.outcome).toBe('started');
    expect(result.message[0]).toBe('nothing to stop (the app was never started)');
  });

  it('opens the browser after the start when asked, like start', async () => {
    const w = await runningWorld();
    await restartUser(w.ctx, { open: true }, w.deps);
    expect(w.calls.browser).toHaveLength(1);
    expect(w.calls.order.indexOf('browser')).toBeGreaterThan(w.calls.order.indexOf('start'));
  });
});

// ---- statusUser ---------------------------------------------------------------------------------------------------------------

describe('statusUser (06 2.3)', () => {
  it('an app that was never started: not running, a hint, exit 1, no workspace made, the lifecycle not asked', async () => {
    const w = world();
    const result = await statusUser(w.ctx, w.deps);
    expect(w.calls.status).toEqual([]);
    expect(existsSync(userInstanceDirOf(w.ctx.env))).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      scope: 'user',
      running: false,
      engine: null,
      probe: 'stopped',
      instance_id: null,
      state_file: path.join(userInstanceDirOf(w.ctx.env), 'state.json'),
      hint: 'never started: run `caw start`',
      configured_port: 7690,
      port_note: null,
      terminals: null,
      autostart: 'off',
      home: userInstanceDirOf(w.ctx.env),
      logs_dir: path.join(userInstanceDirOf(w.ctx.env), 'logs'),
    });
  });

  it('a running app: the legacy report plus the scope, the ports, the terminals, the autostart, the folder and the logs', async () => {
    const w = await runningWorld();
    w.terminals = terminalsReply(2, 8);
    w.autostartState = {
      ...AUTOSTART_OFF,
      enabled: true,
      shortcut: 'C:\\s\\x.lnk',
      target: NODE_PATH,
      arguments: 'x',
      targetExists: true,
      matchesLauncher: true,
    };
    w.statusReport = {
      running: true,
      state_file: path.join(w.ws().dir, 'state.json'),
      url: `http://127.0.0.1:${String(PORT)}`,
      pid: SERVER_PID,
      outdated: false,
      engine: 'node',
      probe: 'running',
      instance_id: idOf(w),
    };
    w.statusExit = 0;
    const result = await statusUser(w.ctx, w.deps);
    expect(w.calls.status).toEqual([{ task: 'user' }]);
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.report).toMatchObject({
      ...w.statusReport,
      scope: 'user',
      configured_port: PORT,
      port_note: null,
      terminals: { live: 2, max: 8 },
      autostart: 'on',
      home: w.ws().dir,
      logs_dir: path.join(w.ws().dir, 'logs'),
    });
    expect(w.calls.control).toEqual([{ v: 1, op: 'terminals', instanceId: idOf(w), token: TOKEN }]);
  });

  it('names a busy configured port, and leaves the terminals out when the census cannot be had', async () => {
    const w = await runningWorld({}, 7691);
    w.settings = { effectivePort: 7690, openAppWindow: false };
    w.terminals = { kind: 'silent', reason: 'timeout' };
    w.statusReport = {
      running: true,
      state_file: '',
      url: 'http://127.0.0.1:7691',
      engine: 'node',
      probe: 'running',
      instance_id: idOf(w),
    };
    w.statusExit = 0;
    const result = await statusUser(w.ctx, w.deps);
    expect(result.report).toMatchObject({
      configured_port: 7690,
      port_note: '7690 was busy; using 7691',
      terminals: null,
    });
  });

  it('asks no census of an app that does not run, and passes the exit code of the lifecycle through', async () => {
    const w = await runningWorld();
    w.statusReport = { running: false, state_file: '', engine: 'node', probe: 'stale', instance_id: idOf(w) };
    w.statusExit = 1;
    const result = await statusUser(w.ctx, w.deps);
    expect(result.exitCode).toBe(1);
    expect(result.report.terminals).toBeNull();
    expect(w.calls.control).toEqual([]);
  });

  it('a stale autostart shortcut is a warning, and unsupported autostart is its own value', async () => {
    const w = await runningWorld();
    w.statusReport = {
      running: true,
      state_file: '',
      url: `http://127.0.0.1:${String(PORT)}`,
      engine: 'node',
      probe: 'running',
      instance_id: idOf(w),
    };
    w.statusExit = 0;
    w.autostartState = {
      ...AUTOSTART_OFF,
      enabled: true,
      shortcut: 'C:\\s\\x.lnk',
      target: NODE_PATH,
      arguments: 'x',
      targetExists: true,
      matchesLauncher: false,
      note: 'the shortcut points to another launcher; run `caw autostart enable` to refresh it',
    };
    const stale = await statusUser(w.ctx, w.deps);
    expect(stale.report.autostart).toBe('on');
    expect(stale.warnings).toEqual([
      'the shortcut points to another launcher; run `caw autostart enable` to refresh it',
    ]);
    w.autostartState = { ...AUTOSTART_OFF, supported: false };
    expect((await statusUser(w.ctx, w.deps)).report.autostart).toBe('unsupported');
  });
});

// ---- openUser ----------------------------------------------------------------------------------------------------------------

describe('openUser (06 2.3, 2.4)', () => {
  it('opens a running app: one code, one browser, nothing started', async () => {
    const w = await runningWorld();
    const result = await openUser(w.ctx, {}, w.deps);
    expect(w.calls.start).toEqual([]);
    expect(w.calls.control).toEqual([{ v: 1, op: 'access', instanceId: idOf(w), token: TOKEN }]);
    expect(w.calls.browser).toEqual([
      { url: buildLoginUrl(PORT, CODE), mode: 'tab', profileDir: userBrowserProfileDirOf(w.ctx.env) },
    ]);
    expect(result).toMatchObject({
      scope: 'user',
      url: URL_OF(PORT),
      port: PORT,
      browser: 'default-browser',
      login: null,
      exitCode: 0,
    });
    expect(result.message).toContain('opened: default browser tab');
    expect(result.start.outcome).toBe('already-running');
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('starts the app when it is not running, then opens it once', async () => {
    const w = world();
    const result = await openUser(w.ctx, { timeoutMs: 7000 }, w.deps);
    expect(w.calls.start[0]?.input).toEqual({ task: 'user', timeoutMs: 7000 });
    expect(w.calls.control).toHaveLength(1);
    expect(w.calls.browser).toHaveLength(1);
    expect(result.start.outcome).toBe('started');
    expect(result.message[0]).toBe(`started: ${URL_OF(PORT)} (pid ${String(SERVER_PID)})`);
    expect(result.message.some((line) => line.startsWith('next:'))).toBe(false);
  });

  it('--no-start never starts and never makes the instance: INSTANCE_NOT_RUNNING', async () => {
    const never = world();
    const error = await failure(openUser(never.ctx, { noStart: true }, never.deps));
    expectCode(error, 'INSTANCE_NOT_RUNNING');
    expect(error.hint).toBe('run `caw start`, or leave out --no-start');
    expect(never.calls.start).toEqual([]);
    expect(existsSync(userInstanceDirOf(never.ctx.env))).toBe(false);

    const stopped = await runningWorld();
    stopped.probes = [probeOf('stopped')];
    expectCode(await failure(openUser(stopped.ctx, { noStart: true }, stopped.deps)), 'INSTANCE_NOT_RUNNING');
    expect(stopped.calls.start).toEqual([]);
    expect(stopped.calls.control).toEqual([]);
  });

  it('--no-start opens an app that runs', async () => {
    const w = await runningWorld();
    const result = await openUser(w.ctx, { noStart: true }, w.deps);
    expect(result.browser).toBe('default-browser');
    expect(w.calls.start).toEqual([]);
  });

  it('--print shows the login URL and opens nothing; --window and --tab choose the mode', async () => {
    const printed = await runningWorld();
    const result = await openUser(printed.ctx, { print: true }, printed.deps);
    expect(printed.calls.browser).toEqual([]);
    expect(result.login).toEqual({ url: buildLoginUrl(PORT, CODE), expiresAt: EXPIRES, ttlSeconds: 120 });
    expect(result.browser).toBeNull();
    expect(result.message).toContain(`login: ${buildLoginUrl(PORT, CODE)}  (single use, 120 s)`);

    const window = await runningWorld();
    await openUser(window.ctx, { browser: 'window' }, window.deps);
    expect(window.calls.browser[0]?.mode).toBe('window');
  });

  it('a browser that cannot be opened leaves the login URL in `login` and a warning without it; the code was unused', async () => {
    const w = await runningWorld();
    w.browserAnswer = { opened: false, reason: 'no-browser' };
    const result = await openUser(w.ctx, {}, w.deps);
    expect(result.browser).toBeNull();
    expect(result.login?.url).toBe(buildLoginUrl(PORT, CODE));
    expect(result.warnings).toEqual(['could not open a browser (no-browser)']);
    expect(JSON.stringify([result.warnings, result.message])).not.toContain(CODE);
    expect(result.exitCode).toBe(0);
  });

  it('a code that cannot be had is an error here: opening was the whole point', async () => {
    const w = await runningWorld();
    w.access = { kind: 'refusal', error: 'UNSUPPORTED' };
    const error = await failure(openUser(w.ctx, {}, w.deps));
    expectCode(error, 'API_ERROR');
    expect(error.message).toBe('the app did not give a login code (UNSUPPORTED)');
    expect(w.calls.browser).toEqual([]);
  });
});

// ---- serveUser and verifyUser -------------------------------------------------------------------------------------------------

describe('serveUser (06 2.3)', () => {
  it('makes the instance, plans the upgrade, then runs the lifecycle in the foreground on the user workspace', async () => {
    const w = world();
    w.upgradeAnswers = [dryRun(), upgraded('b')];
    const result = await serveUser(w.ctx, { port: 18400, logLevel: 'debug' }, w.deps);
    expect(w.calls.order).toEqual(['upgrade:plan', 'upgrade:apply', 'serve']);
    expect(w.calls.serve).toEqual([{ task: 'user', port: 18400, logLevel: 'debug' }]);
    expect(result).toMatchObject({ slug: 'user', exitCode: 0 });
    expect(existsSync(path.join(userInstanceDirOf(w.ctx.env), 'instance.json'))).toBe(true);
  });

  it('does not touch the upgrade when a monitor is live: the lifecycle refuses with INSTANCE_RUNNING itself', async () => {
    const w = world();
    w.probes = [probeOf('running')];
    await serveUser(w.ctx, {}, w.deps);
    expect(w.calls.upgrade).toEqual([]);
    expect(w.calls.serve).toHaveLength(1);
  });

  it('a refused downgrade stops it before the server', async () => {
    const w = world();
    w.upgradeFails = new McsError('DOWNGRADE_REFUSED', 'newer');
    expectCode(await failure(serveUser(w.ctx, {}, w.deps)), 'DOWNGRADE_REFUSED');
    expect(w.calls.serve).toEqual([]);
  });
});

describe('verifyUser (06 2.3)', () => {
  it('an app that was never started is INSTANCE_NOT_RUNNING with the start hint, and nothing is made', async () => {
    const w = world();
    const error = await failure(verifyUser(w.ctx, w.deps));
    expectCode(error, 'INSTANCE_NOT_RUNNING');
    expect(error.hint).toBe('run `caw start`');
    expect(w.calls.verify).toEqual([]);
    expect(existsSync(userInstanceDirOf(w.ctx.env))).toBe(false);
  });

  it('asks the lifecycle to verify the user workspace', async () => {
    const w = await runningWorld();
    const result = await verifyUser(w.ctx, w.deps);
    expect(w.calls.verify).toEqual([{ task: 'user' }]);
    expect(result.exitCode).toBe(0);
  });
});

describe('userInstanceExists', () => {
  it('is true once the workspace has its task.json, false before', async () => {
    const w = world();
    expect(await userInstanceExists(w.ctx)).toBe(false);
    await startUser(w.ctx, {}, w.deps);
    expect(await userInstanceExists(w.ctx)).toBe(true);
  });

  it('does not look at the root of the context but at the user root of the environment', async () => {
    const w = world();
    await startUser(w.ctx, {}, w.deps);
    const elsewhere: OpContext = { ...w.ctx, root: path.join(w.home, 'no-such-root') };
    expect(await userInstanceExists(elsewhere)).toBe(true);
  });
});
