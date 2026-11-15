// The lifecycle of the user instance (06 2.4, 3): `startUser`, `stopUser`, `restartUser`, `statusUser`, `openUser`, `serveUser` and
// `verifyUser`. The instance is an ordinary workspace (slug `user` in the user root), so the generic operations of `lifecycle.ts`
// do the work; this module adds what only the app has: the workspace is made on demand, a stale runtime or database is upgraded
// before a start (the person never runs `upgrade`), the autostart shortcut is healed, a busy port is reported, and the browser is
// opened at a login URL with a one-time access code.
//
// The access code: it is minted over the control channel only when it is shown or opened (`open`, `print`), lives in memory, and
// leaves this module in exactly two places: `login` of a result (`--print`, or a browser that could not be opened) and the
// `login:` line of `--print`. It is never in a warning, an error, a log line or a message of any other kind (06 5.2).
//
// Every effect is injectable (`UserDeps`), so the sequences are tested with scripted dependencies; the lifecycle operations
// themselves are proven by `lifecycle.test.ts` and the integration tests of the user instance.
import { access } from 'node:fs/promises';
import path from 'node:path';

import { McsError, type AutostartStatus, type UpgradeResult } from '@mcs/shared';
import { CONTROL_CLIENT_TIMEOUT_MS, appBrowserUrl, buildLoginUrl, type ControlRequest } from '@mcs/shared/protocol';

import { resolveConfig } from '../config/resolve.ts';
import type { LogLevel } from '../log/logger.ts';
import { openLoginUrl, type OpenOutcome } from '../platform/browser.ts';
import { ensureUserInstance, type EnsureUserInstanceResult } from '../user-instance/ensure.ts';
import {
  USER_DEFAULT_PORT,
  USER_INSTANCE_SLUG,
  userBrowserProfileDirOf,
  userInstanceDirOf,
  userOpContext,
} from '../user-instance/paths.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import {
  autostartStatus,
  refreshAutostartIfEnabled,
  type AutostartRefresh,
  type AutostartTarget,
} from './autostart.ts';
import { run as upgradeRun, type UpgradeDeps, type UpgradeInput } from './instance-upgrade.ts';
import { readCodeStamp } from './instances.ts';
import {
  readToken,
  serveForeground,
  start,
  status,
  stop,
  verify,
  type LifecycleDeps,
  type ServeInput,
  type ServeResult,
  type StartInput,
  type StartResult,
  type StatusReport,
  type StatusResult,
  type StopInput,
  type StopPurpose,
  type StopResult,
  type TargetInput,
  type VerifyResult,
} from './lifecycle.ts';
import {
  controlAddressOf,
  isLiveState,
  probeInstance,
  requestControl,
  type ControlAttempt,
  type ProbeResult,
} from './probe.ts';
import type { OpContext } from './workspace.ts';

// ---- inputs, results ------------------------------------------------------------------------------------------------------------

export interface UserStartInput {
  /** `--port`: the base port of the scan for a start (a running app keeps its own). */
  readonly port?: number;
  readonly logLevel?: LogLevel;
  /** Overrides `process.startTimeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * Open the browser at a login URL once the app runs. The CLI passes `!--no-open`; without it nothing is opened and no code is
   * minted.
   */
  readonly open?: boolean;
  /** `--window` or `--tab`; without it `app.openAppWindow` of the configuration decides. */
  readonly browser?: 'window' | 'tab';
  /** `--print`: mint a code and show the login URL instead of opening a browser. */
  readonly print?: boolean;
}

/** The login URL of a minted code. It holds the code, so it is only ever shown when asked for or when a browser could not be opened. */
export interface UserLogin {
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export interface UserStartResult extends StartResult {
  readonly scope: 'user';
  /** `http://127.0.0.1:<port>/`: what text mode prints. `url` stays the loopback address of `state.json`. */
  readonly browserUrl: string;
  /** The port the configuration asks for (`--port` of a start that started it, else `runtime.json` over `config.json`). */
  readonly configuredPort: number;
  /** `7690 was busy; using 7691`; `null` when the app runs on the configured port. */
  readonly portNote: string | null;
  /** The running app was started by code that is no longer the installed code. It is only warned about, never restarted. */
  readonly outdated: boolean;
  readonly upgraded: {
    readonly backup: string | null;
    readonly runtimeFrom: string;
    readonly runtimeTo: string;
  } | null;
  /** Set only when it is shown: `--print`, or a browser that could not be opened (the code was unused). */
  readonly login: UserLogin | null;
  /** What opened; `null`: nothing did. */
  readonly browser: 'app-window' | 'default-browser' | null;
}

export interface UserStopInput {
  readonly timeoutMs?: number;
  /** End live terminals instead of refusing with `TERMINALS_LIVE`. */
  readonly force?: boolean;
}

export interface UserStopResult extends StopResult {
  readonly scope: 'user';
}

export interface UserRestartResult {
  readonly scope: 'user';
  readonly stop: UserStopResult;
  readonly start: UserStartResult;
  readonly exitCode: 0 | 1;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
}

/** The legacy report of `status` plus what only the app has (06 2.3). */
export interface UserStatusReport extends StatusReport {
  readonly scope: 'user';
  /** The port the configuration asks for. */
  readonly configured_port: number | null;
  readonly port_note: string | null;
  /** Live terminals and the limit; `null` when the app does not run or could not be asked. */
  readonly terminals: { readonly live: number; readonly max: number } | null;
  readonly autostart: 'on' | 'off' | 'unsupported';
  /** The folder of the instance. */
  readonly home: string;
  readonly logs_dir: string;
}

export interface UserStatusResult {
  readonly report: UserStatusReport;
  /** 0 iff the app runs. */
  readonly exitCode: 0 | 1;
  readonly warnings: readonly string[];
}

export interface UserOpenInput {
  readonly browser?: 'window' | 'tab';
  readonly print?: boolean;
  /** Never start the app: `INSTANCE_NOT_RUNNING` when it does not run. */
  readonly noStart?: boolean;
  readonly timeoutMs?: number;
}

export interface UserOpenResult {
  readonly scope: 'user';
  readonly url: string;
  readonly port: number;
  /** What it took to have a running app: `already-running` when nothing had to be started. */
  readonly start: StartResult;
  readonly login: UserLogin | null;
  readonly browser: 'app-window' | 'default-browser' | null;
  readonly exitCode: 0;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
}

export interface UserServeInput {
  readonly port?: number;
  readonly logLevel?: LogLevel;
}

// ---- dependencies ---------------------------------------------------------------------------------------------------------------

/** The lifecycle operations of `lifecycle.ts` that the user operations call (the real ones by default). */
export interface UserLifecycle {
  readonly start: (ctx: OpContext, input?: StartInput, deps?: LifecycleDeps) => Promise<StartResult>;
  readonly stop: (ctx: OpContext, input?: StopInput, deps?: LifecycleDeps) => Promise<StopResult>;
  readonly status: (ctx: OpContext, input?: TargetInput, deps?: LifecycleDeps) => Promise<StatusResult>;
  readonly verify: (ctx: OpContext, input?: TargetInput, deps?: LifecycleDeps) => Promise<VerifyResult>;
  readonly serveForeground: (ctx: OpContext, input?: ServeInput, deps?: LifecycleDeps) => Promise<ServeResult>;
}

/** What the operations read of the configuration of the user instance. */
export interface UserSettings {
  readonly effectivePort: number;
  readonly openAppWindow: boolean;
}

export interface UserDeps extends LifecycleDeps {
  readonly ensure?: (ctx: OpContext) => Promise<EnsureUserInstanceResult>;
  readonly lifecycle?: UserLifecycle;
  /** `ops.instanceUpgrade.run`: a dry run first, then `yes: true` when the plan needs it. */
  readonly upgrade?: (ctx: OpContext, input: UpgradeInput) => Promise<UpgradeResult>;
  readonly openBrowser?: (input: {
    readonly url: string;
    readonly mode: 'window' | 'tab';
    readonly profileDir: string;
  }) => Promise<OpenOutcome>;
  /** Heals the autostart shortcut when it is on (`refreshAutostartIfEnabled`). */
  readonly autostart?: (ctx: OpContext, target: AutostartTarget) => Promise<AutostartRefresh>;
  readonly autostartStatus?: (ctx: OpContext, o: { readonly launcherPath: string }) => Promise<AutostartStatus>;
  /** The configuration of the instance; `cli.port` is the `--port` of the call. */
  readonly settings?: (ctx: OpContext, ws: WorkspaceRef, cli: { readonly port?: number }) => Promise<UserSettings>;
  /** The build stamp of the runtime folder; `null` when it cannot be read. */
  readonly stamp?: (runtimeDir: string) => Promise<string | null>;
  /** The `node.exe` that runs this process (the target of the autostart shortcut). Default: `process.execPath`. */
  readonly nodePath?: string;
}

interface Effects {
  readonly ensure: (ctx: OpContext) => Promise<EnsureUserInstanceResult>;
  readonly lifecycle: UserLifecycle;
  readonly probe: (ws: WorkspaceRef, o?: { runtimeDir?: string }) => Promise<ProbeResult>;
  readonly control: (address: string, message: ControlRequest, o: { timeoutMs: number }) => Promise<ControlAttempt>;
  readonly upgrade: (ctx: OpContext, input: UpgradeInput) => Promise<UpgradeResult>;
  readonly openBrowser: NonNullable<UserDeps['openBrowser']>;
  readonly autostart: NonNullable<UserDeps['autostart']>;
  readonly autostartStatus: NonNullable<UserDeps['autostartStatus']>;
  readonly settings: NonNullable<UserDeps['settings']>;
  readonly stamp: (runtimeDir: string) => Promise<string | null>;
  readonly nodePath: string;
}

async function realSettings(ctx: OpContext, ws: WorkspaceRef, cli: { readonly port?: number }): Promise<UserSettings> {
  const config = await resolveConfig({
    workspace: ws,
    env: ctx.env,
    cli: cli.port === undefined ? {} : { port: cli.port },
    skillDir: ctx.skillDir,
  });
  return { effectivePort: config.effectivePort, openAppWindow: config.runtime.app.openAppWindow };
}

function effects(deps: UserDeps): Effects {
  const upgradeDeps: UpgradeDeps = {
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    ...(deps.control === undefined ? {} : { control: deps.control }),
  };
  return {
    ensure: deps.ensure ?? ((ctx) => ensureUserInstance(ctx)),
    lifecycle: deps.lifecycle ?? { start, stop, status, verify, serveForeground },
    probe: deps.probe ?? probeInstance,
    control: deps.control ?? requestControl,
    upgrade: deps.upgrade ?? ((ctx, input) => upgradeRun(ctx, input, upgradeDeps)),
    openBrowser: deps.openBrowser ?? ((input) => openLoginUrl(input)),
    autostart: deps.autostart ?? ((ctx, target) => refreshAutostartIfEnabled(ctx, target)),
    autostartStatus: deps.autostartStatus ?? ((ctx, o) => autostartStatus(ctx, o)),
    settings: deps.settings ?? realSettings,
    stamp: deps.stamp ?? readCodeStamp,
    nodePath: deps.nodePath ?? process.execPath,
  };
}

// ---- small helpers ---------------------------------------------------------------------------------------------------------------

/** True when `<MCS_HOME>/instances/user/task.json` exists: the workspace of the app was made. Only the environment is read. */
export async function userInstanceExists(ctx: Pick<OpContext, 'env'>): Promise<boolean> {
  const file = path.join(userInstanceDirOf(ctx.env), 'task.json');
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const NEXT_LINE = 'next: caw open  (caw open --print gives a login URL)';
const NEVER_STARTED = 'never started: run `caw start`';

/** The context of the user instance whatever root the caller built: the repository and the tasks root are both the user root. */
const userContext = (ctx: OpContext): OpContext => userOpContext(ctx);

const userWorkspace = (ctx: OpContext): WorkspaceRef => resolveWorkspace(ctx.root, USER_INSTANCE_SLUG);

function describePid(pid: number | null): string {
  return pid === null ? '?' : String(pid);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The port of an address like `http://127.0.0.1:7691`. */
function portOf(url: string | null): number {
  let port = Number.NaN;
  try {
    if (url !== null) port = Number(new URL(url).port);
  } catch {
    // not an address: refused below
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new McsError('START_FAILED', 'the app does not report a usable address', { hint: 'run `caw status`' });
  }
  return port;
}

async function liveTerminals(
  e: Effects,
  ws: WorkspaceRef,
  instanceId: string,
): Promise<{ readonly live: number; readonly max: number } | null> {
  const token = await readToken(ws);
  if (token === null) return null;
  const attempt = await e.control(
    controlAddressOf(instanceId),
    { v: 1, op: 'terminals', instanceId, token },
    { timeoutMs: CONTROL_CLIENT_TIMEOUT_MS },
  );
  return attempt.kind === 'reply' && attempt.response.op === 'terminals'
    ? { live: attempt.response.live, max: attempt.response.max }
    : null;
}

// ---- the upgrade before a start (06 1.10) ----------------------------------------------------------------------------------

type Upgraded = NonNullable<UserStartResult['upgraded']>;

/**
 * The person never runs `upgrade`: before the app starts, a plan says whether the runtime version or the database schema is
 * behind, and when it is the upgrade is applied (backup first, migrations, integrity check, `instance.json`, audit). A runtime
 * that is older than the instance (`DOWNGRADE_REFUSED`) and a database from a newer one propagate with their hints.
 */
async function upgradeIfNeeded(ctx: OpContext, e: Effects): Promise<Upgraded | null> {
  const plan = await e.upgrade(ctx, { task: USER_INSTANCE_SLUG });
  if (plan.outcome !== 'dry-run') return null;
  const applied = await e.upgrade(ctx, { task: USER_INSTANCE_SLUG, yes: true });
  return { backup: applied.backup, runtimeFrom: plan.plan.runtimeFrom, runtimeTo: plan.plan.runtimeTo };
}

// ---- opening the browser (06 2.5, 5.2) --------------------------------------------------------------------------------------------

interface Minted {
  readonly code: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

/** A problem that stopped a login: `details.reason` is the short form that a warning can carry. Never holds the token or a code. */
function loginProblem(
  code: 'INSTANCE_NOT_RUNNING' | 'API_ERROR',
  message: string,
  reason: string,
  hint: string,
): McsError {
  return new McsError(code, message, { hint, details: { reason } });
}

async function mintCode(e: Effects, ws: WorkspaceRef, instanceId: string): Promise<Minted> {
  const token = await readToken(ws);
  if (token === null) {
    throw loginProblem(
      'INSTANCE_NOT_RUNNING',
      'cannot ask the app for a login code: there is no control token',
      'there is no control token',
      'run `caw restart`, or `caw start` when the app is not running',
    );
  }
  const attempt = await e.control(
    controlAddressOf(instanceId),
    { v: 1, op: 'access', instanceId, token },
    { timeoutMs: CONTROL_CLIENT_TIMEOUT_MS },
  );
  if (attempt.kind === 'reply' && attempt.response.op === 'access') {
    const { code, expiresAt, ttlSeconds } = attempt.response;
    return { code, expiresAt, ttlSeconds };
  }
  const reason =
    attempt.kind === 'refusal'
      ? attempt.error
      : attempt.kind === 'reply'
        ? 'an answer that is no login code'
        : attempt.kind === 'absent'
          ? 'the control channel is gone'
          : 'no answer';
  throw loginProblem('API_ERROR', `the app did not give a login code (${reason})`, reason, 'run `caw restart`');
}

interface Shown {
  readonly login: UserLogin | null;
  readonly browser: 'app-window' | 'default-browser' | null;
  readonly opened: boolean | null;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
}

const NOTHING_SHOWN: Shown = { login: null, browser: null, opened: null, message: [], warnings: [] };

const FALLBACK_WHY = { 'no-browser': 'Edge or Chrome was not found', 'spawn-failed': 'it did not start' } as const;

/**
 * Mints a code and either shows it (`print`) or opens the login URL. A browser that cannot be opened leaves the URL in `login`:
 * the code was never used, so showing it is the fallback. Throws the problem of a code that cannot be had.
 */
async function showLogin(
  ctx: OpContext,
  e: Effects,
  o: {
    readonly ws: WorkspaceRef;
    readonly instanceId: string;
    readonly port: number;
    readonly settings: UserSettings;
    readonly mode: 'print' | 'open';
    readonly browser: 'window' | 'tab' | undefined;
  },
): Promise<Shown> {
  const minted = await mintCode(e, o.ws, o.instanceId);
  const url = buildLoginUrl(o.port, minted.code);
  const login: UserLogin = { url, expiresAt: minted.expiresAt, ttlSeconds: minted.ttlSeconds };
  if (o.mode === 'print') {
    return {
      ...NOTHING_SHOWN,
      login,
      message: [`login: ${url}  (single use, ${String(minted.ttlSeconds)} s)`],
    };
  }
  const mode = o.browser ?? (o.settings.openAppWindow ? 'window' : 'tab');
  const outcome = await e.openBrowser({ url, mode, profileDir: userBrowserProfileDirOf(ctx.env) });
  if (!outcome.opened) {
    return { ...NOTHING_SHOWN, login, opened: false, warnings: [`could not open a browser (${outcome.reason})`] };
  }
  const browser = outcome.how === 'app-window' ? 'app-window' : 'default-browser';
  return {
    login: null,
    browser,
    opened: true,
    message: [`opened: ${browser === 'app-window' ? 'app window' : 'default browser tab'}`],
    warnings:
      outcome.fallback === undefined
        ? []
        : [`an app window was requested but ${FALLBACK_WHY[outcome.fallback]}; opened a browser tab instead`],
  };
}

// ---- start -------------------------------------------------------------------------------------------------------------------------

interface Begun {
  readonly ws: WorkspaceRef;
  readonly instanceId: string;
  readonly created: boolean;
  readonly started: StartResult;
  readonly port: number;
  readonly configuredPort: number;
  readonly portNote: string | null;
  readonly outdated: boolean;
  readonly upgraded: Upgraded | null;
  readonly settings: UserSettings;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
}

function runningResult(ensured: EnsureUserInstanceResult, probe: ProbeResult): StartResult {
  return {
    outcome: 'already-running',
    slug: ensured.ws.slug,
    dir: ensured.ws.dir,
    instanceId: ensured.instance.instanceId,
    engine: 'node',
    url: probe.url,
    pid: probe.pid,
    createdDefault: false,
    adopted: false,
    opened: null,
    exitCode: 0,
    message: [],
    warnings: [],
  };
}

async function outdatedWarning(e: Effects, ws: WorkspaceRef, instanceId: string): Promise<string> {
  const terminals = await liveTerminals(e, ws, instanceId);
  if (terminals === null || terminals.live === 0) {
    return 'the running app is outdated; run `caw restart` to use the new code';
  }
  const n = terminals.live;
  return `the running app is outdated; run \`caw restart --force\` to use the new code (${String(n)} terminal ${plural(n, 'session is', 'sessions are')} live and would end)`;
}

/**
 * Everything of a start up to the open flow (06 2.4): the workspace, the probe, the upgrade, the start or the report of the running
 * app, the autostart healing and the port note.
 */
async function begin(ctx: OpContext, e: Effects, input: UserStartInput): Promise<Begun> {
  const ensured = await e.ensure(ctx);
  const { ws } = ensured;
  const instanceId = ensured.instance.instanceId;
  const message: string[] = [];
  const warnings: string[] = [];

  const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  let started: StartResult;
  let upgraded: Upgraded | null = null;
  let outdated = false;
  if (probe.state === 'running') {
    started = runningResult(ensured, probe);
    const running = probe.identity?.codeStamp;
    const stamp = await e.stamp(ctx.runtimeDir);
    if (running !== undefined && stamp !== null && stamp !== running) {
      outdated = true;
      warnings.push(await outdatedWarning(e, ws, instanceId));
    }
  } else {
    // a monitor that is live but not running (starting, hung) is refused or followed by the generic start; upgrading under it would fail
    if (!isLiveState(probe.state)) upgraded = await upgradeIfNeeded(ctx, e);
    started = await e.lifecycle.start(ctx, {
      task: USER_INSTANCE_SLUG,
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.logLevel === undefined ? {} : { logLevel: input.logLevel }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }
  const port = portOf(started.url);
  const fresh = started.outcome === 'started';
  if (!fresh && input.port !== undefined && input.port !== port) {
    warnings.push(`--port ${String(input.port)} is ignored: the app is already running on port ${String(port)}`);
  }

  if (upgraded !== null) {
    message.push(
      `upgraded the app: runtime ${upgraded.runtimeFrom} -> ${upgraded.runtimeTo} (backup ${upgraded.backup ?? '-'})`,
    );
  }
  message.push(`${fresh ? 'started' : 'already running'}: ${appBrowserUrl(port)} (pid ${describePid(started.pid)})`);

  const settings = await e.settings(ctx, ws, fresh && input.port !== undefined ? { port: input.port } : {});
  const portNote =
    port === settings.effectivePort ? null : `${String(settings.effectivePort)} was busy; using ${String(port)}`;
  if (portNote !== null) message.push(`note: ${portNote}`);

  // best effort: a shortcut that cannot be healed never fails a start that worked
  try {
    const healed = await e.autostart(ctx, { launcherPath: ctx.launcherPath, nodePath: e.nodePath });
    if (healed === 'refreshed') message.push('refreshed the autostart shortcut');
    if (healed === 'foreign-target') {
      warnings.push('the autostart shortcut points to another launcher; run `caw autostart enable` to refresh it');
    }
  } catch (error) {
    warnings.push(`could not refresh the autostart shortcut${error instanceof McsError ? `: ${error.message}` : ''}`);
  }

  return {
    ws,
    instanceId,
    created: ensured.created,
    started,
    port,
    configuredPort: settings.effectivePort,
    portNote,
    outdated,
    upgraded,
    settings,
    message,
    warnings,
  };
}

/**
 * `caw start` of the user instance (06 2.4): makes the workspace, upgrades a stale runtime or database (backup first), starts the
 * app or reports the one that runs, heals the autostart shortcut, notes a busy port, and with `open` opens the browser at a login
 * URL (`print` shows the URL instead). A running app that is outdated is warned about and never restarted.
 */
export async function startUser(
  ctx: OpContext,
  input: UserStartInput = {},
  deps: UserDeps = {},
): Promise<UserStartResult> {
  const uctx = userContext(ctx);
  const e = effects(deps);
  const begun = await begin(uctx, e, input);
  const mode = input.print === true ? 'print' : input.open === true ? 'open' : null;
  let shown = NOTHING_SHOWN;
  if (mode !== null) {
    try {
      shown = await showLogin(uctx, e, {
        ws: begun.ws,
        instanceId: begun.instanceId,
        port: begun.port,
        settings: begun.settings,
        mode,
        browser: input.browser,
      });
    } catch (error) {
      // a start that worked is not undone by a login that could not be had; only `--print` asked for nothing else
      if (mode === 'print' || !(error instanceof McsError)) throw error;
      const reason = error.details?.['reason'];
      shown = {
        ...NOTHING_SHOWN,
        warnings: [
          `could not get a login code (${typeof reason === 'string' ? reason : error.code}); run \`caw open\` to try again`,
        ],
      };
    }
  }
  return {
    ...begun.started,
    scope: 'user',
    createdDefault: begun.created,
    opened: shown.opened,
    exitCode: 0,
    message: [...begun.message, ...shown.message, ...(mode === null ? [NEXT_LINE] : [])],
    warnings: [...begun.warnings, ...shown.warnings],
    browserUrl: appBrowserUrl(begun.port),
    configuredPort: begun.configuredPort,
    portNote: begun.portNote,
    outdated: begun.outdated,
    upgraded: begun.upgraded,
    login: shown.login,
    browser: shown.browser,
  };
}

// ---- stop and restart ----------------------------------------------------------------------------------------------------------------

async function stopFor(
  ctx: OpContext,
  e: Effects,
  input: UserStopInput,
  purpose: StopPurpose,
  deps: UserDeps,
): Promise<UserStopResult> {
  if (!(await userInstanceExists(ctx))) {
    return {
      scope: 'user',
      outcome: 'nothing-to-stop',
      slug: USER_INSTANCE_SLUG,
      pid: null,
      url: null,
      forced: false,
      reason: null,
      terminalsEnded: 0,
      exitCode: 0,
      message: ['nothing to stop (the app was never started)'],
    };
  }
  const result = await e.lifecycle.stop(
    ctx,
    {
      task: USER_INSTANCE_SLUG,
      purpose,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.force === true ? { force: true } : {}),
    },
    deps,
  );
  return { ...result, scope: 'user' };
}

/**
 * `caw stop` of the user instance: the guarded stop of `lifecycle.stop` (live terminals refuse with `TERMINALS_LIVE`, exit 3,
 * unless `force`). An app that was never started is `nothing to stop`, and nothing is made.
 */
export function stopUser(ctx: OpContext, input: UserStopInput = {}, deps: UserDeps = {}): Promise<UserStopResult> {
  return stopFor(userContext(ctx), effects(deps), input, 'stop', deps);
}

/**
 * `caw restart`: the guarded stop, and only when it succeeded the same start as `startUser`, which also upgrades: a restart that
 * applies an update migrates too.
 */
export async function restartUser(
  ctx: OpContext,
  input: UserStartInput & { readonly force?: boolean } = {},
  deps: UserDeps = {},
): Promise<UserRestartResult> {
  const uctx = userContext(ctx);
  const stopped = await stopFor(uctx, effects(deps), input.force === true ? { force: true } : {}, 'restart', deps);
  const started = await startUser(
    uctx,
    {
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.logLevel === undefined ? {} : { logLevel: input.logLevel }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.open === undefined ? {} : { open: input.open }),
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.print === undefined ? {} : { print: input.print }),
    },
    deps,
  );
  return {
    scope: 'user',
    stop: stopped,
    start: started,
    exitCode: started.exitCode,
    message: [...stopped.message, ...started.message],
    warnings: started.warnings,
  };
}

// ---- status -----------------------------------------------------------------------------------------------------------------------------

function autostartValue(state: AutostartStatus): UserStatusReport['autostart'] {
  if (!state.supported) return 'unsupported';
  return state.enabled ? 'on' : 'off';
}

/**
 * `caw status` of the user instance: the legacy report of `lifecycle.status` and the scope, the configured port and the note of a
 * busy one, the live terminals, the autostart state, the folder and the logs. An app that was never started is not running, with a
 * hint and without a workspace made. Exit 0 iff the app runs.
 */
export async function statusUser(ctx: OpContext, deps: UserDeps = {}): Promise<UserStatusResult> {
  const uctx = userContext(ctx);
  const e = effects(deps);
  const dir = userInstanceDirOf(uctx.env);
  const autostart = await e.autostartStatus(uctx, { launcherPath: uctx.launcherPath });
  const warnings = autostart.enabled && autostart.note !== null ? [autostart.note] : [];

  if (!(await userInstanceExists(uctx))) {
    return {
      report: {
        scope: 'user',
        running: false,
        state_file: path.join(dir, 'state.json'),
        hint: NEVER_STARTED,
        engine: null,
        probe: 'stopped',
        instance_id: null,
        configured_port: USER_DEFAULT_PORT,
        port_note: null,
        terminals: null,
        autostart: autostartValue(autostart),
        home: dir,
        logs_dir: path.join(dir, 'logs'),
      },
      exitCode: 1,
      warnings,
    };
  }

  const ws = userWorkspace(uctx);
  const { report, exitCode } = await e.lifecycle.status(uctx, { task: USER_INSTANCE_SLUG }, deps);
  const settings = await e.settings(uctx, ws, {});
  let portNote: string | null = null;
  if (report.url !== undefined) {
    const port = portOf(report.url);
    if (port !== settings.effectivePort) portNote = `${String(settings.effectivePort)} was busy; using ${String(port)}`;
  }
  const terminals =
    report.running && report.instance_id !== null ? await liveTerminals(e, ws, report.instance_id) : null;
  return {
    report: {
      ...report,
      scope: 'user',
      configured_port: settings.effectivePort,
      port_note: portNote,
      terminals,
      autostart: autostartValue(autostart),
      home: ws.dir,
      logs_dir: path.join(ws.dir, 'logs'),
    },
    exitCode,
    warnings,
  };
}

// ---- open, serve, verify ----------------------------------------------------------------------------------------------------------

/**
 * `caw open`: starts the app when it does not run (not with `noStart`), mints a code and opens the browser at the login URL;
 * `print` shows the URL instead. Unlike a start, a code that cannot be had is an error here.
 */
export async function openUser(
  ctx: OpContext,
  input: UserOpenInput = {},
  deps: UserDeps = {},
): Promise<UserOpenResult> {
  const uctx = userContext(ctx);
  const e = effects(deps);
  if (input.noStart === true) {
    const running =
      (await userInstanceExists(uctx)) &&
      (await e.probe(userWorkspace(uctx), { runtimeDir: uctx.runtimeDir })).state === 'running';
    if (!running) {
      throw new McsError('INSTANCE_NOT_RUNNING', 'the app is not running (--no-start)', {
        hint: 'run `caw start`, or leave out --no-start',
      });
    }
  }
  const begun = await begin(uctx, e, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs });
  const shown = await showLogin(uctx, e, {
    ws: begun.ws,
    instanceId: begun.instanceId,
    port: begun.port,
    settings: begun.settings,
    mode: input.print === true ? 'print' : 'open',
    browser: input.browser,
  });
  return {
    scope: 'user',
    url: appBrowserUrl(begun.port),
    port: begun.port,
    start: begun.started,
    login: shown.login,
    browser: shown.browser,
    exitCode: 0,
    message: [...begun.message, ...shown.message],
    warnings: [...begun.warnings, ...shown.warnings],
  };
}

/**
 * `caw serve`: the instance in the foreground. The workspace is made and a stale runtime or database upgraded first, unless a
 * monitor is live (the lifecycle then refuses with `INSTANCE_RUNNING`). Ctrl+C is forwarded as a `signal` shutdown, which is never
 * guarded.
 */
export async function serveUser(ctx: OpContext, input: UserServeInput = {}, deps: UserDeps = {}): Promise<ServeResult> {
  const uctx = userContext(ctx);
  const e = effects(deps);
  const { ws } = await e.ensure(uctx);
  const probe = await e.probe(ws, { runtimeDir: uctx.runtimeDir });
  if (!isLiveState(probe.state)) await upgradeIfNeeded(uctx, e);
  return e.lifecycle.serveForeground(
    uctx,
    {
      task: USER_INSTANCE_SLUG,
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.logLevel === undefined ? {} : { logLevel: input.logLevel }),
    },
    deps,
  );
}

/** `caw verify`: the five endpoint checks against the user instance; an app that was never started is `INSTANCE_NOT_RUNNING`. */
export async function verifyUser(ctx: OpContext, deps: UserDeps = {}): Promise<VerifyResult> {
  const uctx = userContext(ctx);
  if (!(await userInstanceExists(uctx))) {
    throw new McsError('INSTANCE_NOT_RUNNING', 'the app was never started: there is nothing to verify', {
      hint: 'run `caw start`',
    });
  }
  return effects(deps).lifecycle.verify(uctx, { task: USER_INSTANCE_SLUG }, deps);
}
