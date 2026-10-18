// Engine operations behind `start`, `stop`, `status`, `restart`, `verify` and `serve` (01 4.7-4.10, 4.14, registry 2.1):
// typed input, typed result, `McsError` for every expected failure. The CLI renders these results; nothing here prints.
//
// Ground rules (ADR 0004, ADR 0006): the server is started detached through `spawnDetached` with the marker argv; the
// classification of an instance is `probeInstance` (probe.ts) and never needs a command line; a process is killed only
// after its command line proves that it is the runtime of this instance, and a pid without that proof is never killed;
// every kill goes through `forceKill`. A monitor that this runtime did not start (`unmanaged-running`, ADR 0066) is never
// signalled: it blocks `start`, `verify` and `serve`, and `stop` refuses it.
//
// Every effect is injected through `LifecycleDeps` (processes, control channel, HTTP, spawn, clock), so that the decision
// logic is tested with scripted processes (lifecycle.test.ts) and proven again on real processes by the integration and
// resilience tests (T-LC-01, 02, 06, 08, 09, 13, 15).
import { closeSync, existsSync, openSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import {
  McsError,
  queryString,
  routes,
  toQuery,
  type InstanceFile,
  type LegacyState,
  type StateFile,
} from '@mcs/shared';
import { resolveMcsHome, type ControlRequest } from '@mcs/shared/protocol';
import type { z } from 'zod';

import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { peekDbSchemaVersion } from '../db/migrations.ts';
import { readRouteFile, routeFilePath } from '../ingest/routes-file.ts';
import type { LogLevel } from '../log/logger.ts';
import { execFileText, resolveExecutable, spawnDetached, spawnForeground } from '../platform/exec.ts';
import { atomicWriteFile, readSmallFile, tailLines } from '../platform/fsx.ts';
import { hostPlatform } from '../platform/host.ts';
import { layoutOfRuntimeDir, type RuntimeLayout } from '../platform/layout.ts';
import { hasRuntimeMarker } from '../platform/markers.ts';
import { commandLineOf, forceKill, isValidPid, pidAlive, waitForExit } from '../platform/process.ts';
import { adoptWorkspace, ensureWorkspaceDir, readInstanceFile } from '../workspace/adopt.ts';
import { assertNotLink, compareAndDelete } from '../workspace/fsio.ts';
import { listWorkspaceSlugs } from '../workspace/list.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import {
  controlAddressOf,
  httpGet,
  isLiveState,
  isLoopbackBase,
  isRunningState,
  jsonBodyOf,
  probeInstance,
  readStateSnapshot,
  requestControl,
  type ControlAttempt,
  type HttpAttempt,
  type ProbeOptions,
  type ProbeResult,
} from './probe.ts';
import { init, openWorkspace, type OpContext } from './workspace.ts';

const LF = String.fromCharCode(10);
const DEFAULT_SLUG = 'default';
const DEFAULT_NAME = 'Default monitor';
/** `process.stopTimeoutMs` when the configuration cannot be read (the key's own default, 01 4.9). */
const FALLBACK_STOP_TIMEOUT_MS = 10_000;
const FORCED_KILL_WAIT_MS = 5000;
const POLL_MS = 100;
const BOOT_LOG_TAIL_LINES = 20;
const BOOT_LOG_LINE_CHARS = 300;
const HTTP_TIMEOUT_MS = 5000;
const CONTROL_TIMEOUT_MS = 2000;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HOUR_MS = 3_600_000;

// ---- the effects ---------------------------------------------------------------------------------------------------------------

export type SpawnDetachedFn = typeof spawnDetached;
/** The handle of a spawned process (`node:child_process` is imported by `platform/exec.ts` only). */
type SpawnedProcess = ReturnType<SpawnDetachedFn>;
export type SpawnForegroundFn = typeof spawnForeground;

/** The process helpers of `platform/process.ts`. */
export interface ProcessApi {
  pidAlive(pid: number): boolean;
  commandLineOf(pid: number): Promise<string | null>;
  forceKill(pid: number): Promise<void>;
  waitForExit(pid: number, timeoutMs: number, pollMs?: number): Promise<boolean>;
}

export type LifecycleCommand = 'start' | 'stop' | 'status' | 'verify' | 'restart' | 'serve';

export interface LifecycleDeps {
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  readonly processes?: ProcessApi;
  readonly control?: (address: string, message: ControlRequest, o: { timeoutMs: number }) => Promise<ControlAttempt>;
  readonly httpGet?: (url: string, o: { timeoutMs: number }) => Promise<HttpAttempt>;
  readonly spawnDetached?: SpawnDetachedFn;
  readonly spawnForeground?: SpawnForegroundFn;
  /** Asks the desktop to open `url` (`--open`); `false` when it could not be asked. */
  readonly openUrl?: (url: string) => Promise<boolean>;
  /** `PRAGMA user_version` of the database file against the newest migration; `null` when there is no database. */
  readonly peekDb?: (file: string) => { readonly userVersion: number; readonly latest: number } | null;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in ms: deadlines only. */
  readonly now?: () => number;
  readonly signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

interface Effects {
  readonly probe: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  readonly processes: ProcessApi;
  readonly control: (address: string, message: ControlRequest, o: { timeoutMs: number }) => Promise<ControlAttempt>;
  readonly httpGet: (url: string, o: { timeoutMs: number }) => Promise<HttpAttempt>;
  readonly spawnDetached: SpawnDetachedFn;
  readonly spawnForeground: SpawnForegroundFn;
  readonly openUrl: (url: string) => Promise<boolean>;
  readonly peekDb: (file: string) => { readonly userVersion: number; readonly latest: number } | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly signals: Pick<NodeJS.Process, 'on' | 'off'>;
}

const REAL_PROCESSES: ProcessApi = { pidAlive, commandLineOf, forceKill, waitForExit };

async function openInBrowser(url: string): Promise<boolean> {
  if (!isLoopbackBase(url)) return false;
  const file = await resolveExecutable('opener');
  if (file === null) return false;
  const result = await execFileText({
    kind: 'opener',
    file,
    args: [`${url}/`],
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    encoding: 'utf8',
  });
  // the exit code of the desktop opener is advisory (explorer.exe answers 1 when it worked)
  return result.ok || result.error === 'NONZERO_EXIT';
}

function peekDatabase(file: string): { userVersion: number; latest: number } | null {
  try {
    return peekDbSchemaVersion(file);
  } catch {
    // not a readable database: the server decides, with its own exit code and message
    return null;
  }
}

function effects(deps: LifecycleDeps): Effects {
  return {
    probe: deps.probe ?? probeInstance,
    processes: deps.processes ?? REAL_PROCESSES,
    control: deps.control ?? requestControl,
    httpGet: deps.httpGet ?? httpGet,
    spawnDetached: deps.spawnDetached ?? spawnDetached,
    spawnForeground: deps.spawnForeground ?? spawnForeground,
    openUrl: deps.openUrl ?? openInBrowser,
    peekDb: deps.peekDb ?? peekDatabase,
    sleep: deps.sleep ?? ((ms) => sleepMs(ms)),
    now: deps.now ?? (() => performance.now()),
    signals: deps.signals ?? process,
  };
}

// ---- results ----------------------------------------------------------------------------------------------------------------------

export interface TargetInput {
  /** The task slug; without it the workspace `default` (created on demand by `start`, `restart` and `serve`). */
  readonly task?: string;
}

export interface StartInput extends TargetInput {
  readonly port?: number;
  readonly logLevel?: LogLevel;
  readonly open?: boolean;
  /** Overrides `process.startTimeoutMs`. */
  readonly timeoutMs?: number;
}

export type StartOutcome = 'started' | 'already-running';

export interface StartResult {
  readonly outcome: StartOutcome;
  readonly slug: string;
  readonly dir: string;
  readonly instanceId: string;
  readonly engine: 'node';
  readonly url: string | null;
  readonly pid: number | null;
  readonly createdDefault: boolean;
  readonly adopted: boolean;
  /** `--open`: whether the desktop was asked to open the URL; `null` without `--open`. */
  readonly opened: boolean | null;
  readonly exitCode: 0 | 1;
  /** The result lines, in order (legacy text). */
  readonly message: readonly string[];
  /** `warning:` lines. */
  readonly warnings: readonly string[];
}

export interface StopInput extends TargetInput {
  /** Overrides `process.stopTimeoutMs`. */
  readonly timeoutMs?: number;
}

export type StopOutcome = 'nothing-to-stop' | 'stale-removed' | 'stopped' | 'stopped-forced';

export interface StopResult {
  readonly outcome: StopOutcome;
  readonly slug: string;
  readonly pid: number | null;
  readonly url: string | null;
  readonly forced: boolean;
  /** Why the graceful path was given up (forced stops only). */
  readonly reason: string | null;
  readonly exitCode: 0 | 1;
  readonly message: readonly string[];
}

/** The output of `status` (01 4.10): the legacy keys first, in the legacy order, then the keys that are new in Node. */
export interface StatusReport {
  running: boolean;
  state_file: string;
  url?: string;
  pid?: number;
  uptime_s?: number;
  code_stamp?: string;
  outdated?: boolean;
  task?: { id: string; name: string; description: string } | null;
  config_source?: 'task';
  recent_errors?: { at: string; where: string; message: string }[];
  reader?: unknown;
  sessions?: { RUNNING: number; IDLE: number; COMPLETED: number; FAILED: number; UNKNOWN: number };
  partial_sessions?: number;
  newest_session_age_s?: number | null;
  stale_state_file?: StateFile;
  hint?: string;
  engine: 'node' | null;
  probe: ProbeResult['state'];
  instance_id: string | null;
  runtime_version?: string;
  outdated_reason?: 'code_stamp_changed' | 'runtime_version_changed' | null;
  db_schema_version?: number;
  ingestion?: { status: string; reasons: string[] };
}

export interface StatusResult {
  readonly report: StatusReport;
  /** 0 iff the monitor of this runtime runs. */
  readonly exitCode: 0 | 1;
}

export interface VerifyResult {
  readonly slug: string;
  readonly url: string | null;
  /** The total of the sessions page. */
  readonly sessions: number | null;
  readonly exitCode: 0 | 1;
  readonly message: readonly string[];
}

export interface RestartResult {
  readonly slug: string;
  readonly stop: StopResult | null;
  readonly start: StartResult | null;
  readonly exitCode: 0 | 1;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
}

export interface ServeInput extends TargetInput {
  readonly port?: number;
  readonly logLevel?: LogLevel;
  readonly open?: boolean;
  /** The legacy `--state-file`: accepted and ignored (warning). */
  readonly stateFile?: string;
}

export interface ServeResult {
  readonly slug: string;
  readonly exitCode: 0 | 1;
  readonly message: readonly string[];
  readonly warnings: readonly string[];
  /** A SIGINT, SIGBREAK or SIGHUP arrived and was forwarded. */
  readonly interrupted: boolean;
}

// ---- shared helpers ---------------------------------------------------------------------------------------------------------------------

function errnoOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'ERROR';
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** The server exit codes of 01 4.1 by name (registry 7.3); the server module has the same table (CR-WP-19-1). */
const SERVER_EXIT_NAMES: Readonly<Record<number, string>> = {
  0: 'OK',
  10: 'CONFIG_INVALID',
  11: 'IDENTITY_MISMATCH',
  12: 'INSTANCE_LOCKED',
  13: 'PORT_EXHAUSTED',
  14: 'DB_ERROR',
  15: 'DB_NEWER_THAN_RUNTIME',
  16: 'DB_UPGRADE_REQUIRED',
  17: 'WORKSPACE_INVALID',
  18: 'BUILD_INVALID',
  70: 'INTERNAL',
};

const INSTANCE_LOCKED = 12;

function exitName(code: number | null, signal: string | null): string {
  if (code === null) return signal === null ? 'killed' : `killed by ${signal}`;
  return SERVER_EXIT_NAMES[code] ?? `exit code ${String(code)}`;
}

/** Whole seconds when it is, else one decimal: `20`, `1.5`. */
function secondsText(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  out['MCS_HOOK_DISABLE'] = '1';
  return out;
}

interface Target {
  readonly ws: WorkspaceRef;
  readonly created: boolean;
}

/**
 * The workspace a command works on (01 6.2): `--task`, else `default`. `create`: `default` is made on demand (init with the
 * name `Default monitor`, audited by init); `existing`: no `default` is `no default instance (use --task)`.
 */
async function resolveTarget(ctx: OpContext, task: string | undefined, mode: 'create' | 'existing'): Promise<Target> {
  if (task !== undefined) return { ws: await openWorkspace(ctx, task), created: false };
  if ((await listWorkspaceSlugs(ctx.root)).includes(DEFAULT_SLUG)) {
    return { ws: await openWorkspace(ctx, DEFAULT_SLUG), created: false };
  }
  if (mode === 'existing') {
    throw new McsError('TASK_NOT_FOUND', 'no default instance (use --task)', {
      hint: 'pass --task <slug>; `mcs start` creates the default workspace',
    });
  }
  await init(ctx, { name: DEFAULT_NAME, slug: DEFAULT_SLUG });
  return { ws: await openWorkspace(ctx, DEFAULT_SLUG), created: true };
}

/** Where the monitor that this runtime did not start lives: its pid and URL, for the messages that refuse it. */
function unmanagedWhere(probe: ProbeResult): string {
  return `pid ${probe.pid === null ? '?' : String(probe.pid)}, ${probe.url ?? '?'}`;
}

/**
 * The refusal of `start`, `verify` and `serve` for an `unmanaged-running` workspace (ADR 0066): a monitor that this
 * runtime did not start answers there; it is never signalled, so the user stops it with the tool that started it.
 */
function unmanagedRunning(ws: WorkspaceRef, probe: ProbeResult): McsError {
  return new McsError(
    'INSTANCE_RUNNING',
    `a monitor runs '${ws.slug}' (${unmanagedWhere(probe)}) that was not started by this runtime; it is left alone`,
    {
      hint: 'stop that monitor with the tool that started it, then run this command again',
      details: { state: probe.state, pid: probe.pid, url: probe.url },
    },
  );
}

/**
 * The server entry of the runtime folder in either layout (ADR 0062); a source runtime that is not built and a bundle that
 * lost its server entry cannot start.
 */
function serverMainOf(ctx: OpContext): string {
  let layout: RuntimeLayout;
  try {
    layout = layoutOfRuntimeDir(ctx.runtimeDir);
  } catch (error) {
    throw new McsError('START_FAILED', `no runtime found in ${ctx.runtimeDir}`, {
      hint: error instanceof McsError && error.hint !== undefined ? error.hint : 'reinstall the skill',
      cause: error,
    });
  }
  const main = layout.serverEntry;
  if (!existsSync(main)) {
    throw layout.mode === 'bundle'
      ? new McsError('START_FAILED', `the bundled server is missing: ${main}`, {
          hint: 'reinstall the skill (the bundle folder is incomplete)',
        })
      : new McsError('START_FAILED', `the server is not built: ${main} is missing`, {
          hint: 'run `npm run build` in the runtime folder',
        });
  }
  return main;
}

/** `serve --mcs-instance=<id> --instance-dir=<dir> [--port=<n>] [--log-level=<level>]` (01 4.1; the order is fixed). */
function serveArgv(
  main: string,
  ws: WorkspaceRef,
  instanceId: string,
  o: { port?: number | undefined; logLevel?: LogLevel | undefined },
): string[] {
  return [
    main,
    'serve',
    `--mcs-instance=${instanceId}`,
    `--instance-dir=${ws.dir}`,
    ...(o.port === undefined ? [] : [`--port=${String(o.port)}`]),
    ...(o.logLevel === undefined ? [] : [`--log-level=${o.logLevel}`]),
  ];
}

/** The configuration, or `null` when it does not resolve: `stop` must still be able to stop. */
async function configOrNull(ctx: OpContext, ws: WorkspaceRef): Promise<ResolvedConfig | null> {
  try {
    return await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  } catch {
    return null;
  }
}

/** The token of `run/control.token` (64 hex digits), or `null`. Never logged, never returned to a caller. */
async function readToken(ws: WorkspaceRef): Promise<string | null> {
  const file = workspacePath(ws, 'run', 'control.token');
  try {
    assertNotLink(file);
    const text = (await readSmallFile(file, 4096)).toString('utf8').trim();
    return TOKEN_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Deletes `file` only if it still holds the bytes that were read (a replaced file belongs to somebody else). */
async function deleteIfUnchanged(file: string): Promise<void> {
  try {
    await compareAndDelete(file, await readSmallFile(file, 64 * 1024));
  } catch {
    // gone already, or not ours to delete
  }
}

/** Removes `state.json` when it names `pid`: the file of a process that is known to be gone (or was just killed). */
async function removeStateOf(ws: WorkspaceRef, pid: number): Promise<void> {
  const { stateFile, bytes } = await readStateSnapshot(ws);
  if (stateFile?.pid === pid && bytes !== null) await compareAndDelete(workspacePath(ws, 'state.json'), bytes);
}

async function bootLogTail(ws: WorkspaceRef): Promise<string[]> {
  try {
    const lines = await tailLines(workspacePath(ws, 'logs', 'boot.log'), BOOT_LOG_TAIL_LINES);
    return lines.filter((line) => line.trim() !== '').map((line) => line.slice(0, BOOT_LOG_LINE_CHARS));
  } catch {
    return [];
  }
}

/** `logs/boot.log` becomes `boot.log.1` (when it can) and a fresh `boot.log` is opened for the server (01 4.7 step 7). */
async function openBootLog(ws: WorkspaceRef): Promise<number> {
  await ensureWorkspaceDir(ws, 'logs');
  const file = workspacePath(ws, 'logs', 'boot.log');
  const previous = `${file}.1`;
  assertNotLink(file);
  assertNotLink(previous);
  try {
    await rename(file, previous);
  } catch {
    // no boot.log yet, or another start holds it open: the new file is made regardless
  }
  return openSync(file, 'w');
}

// ---- start --------------------------------------------------------------------------------------------------------------------------------

type StartBase = Omit<
  StartResult,
  'outcome' | 'engine' | 'url' | 'pid' | 'opened' | 'exitCode' | 'message' | 'warnings'
>;

function startedOutcome(
  base: StartBase,
  outcome: StartOutcome,
  probe: ProbeResult,
  message: string[],
  warnings: string[],
  opened: boolean | null = null,
): StartResult {
  return {
    ...base,
    outcome,
    engine: 'node',
    url: probe.url,
    pid: probe.pid,
    opened,
    exitCode: 0,
    message,
    warnings,
  };
}

function describePid(pid: number | null): string {
  return pid === null ? 'pid unknown' : `pid ${String(pid)}`;
}

/** Waits (01 4.7 step 6 "starting") until another start finishes: running, or an error. */
async function followOtherStart(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  first: ProbeResult,
  timeoutMs: number,
): Promise<ProbeResult> {
  const deadline = e.now() + timeoutMs;
  let probe = first;
  while (probe.state === 'starting') {
    if (e.now() >= deadline) {
      throw new McsError(
        'START_TIMEOUT',
        `the runtime that was starting (${describePid(probe.pid)}) did not become healthy within ${secondsText(timeoutMs)} s`,
        {
          hint: `mcs doctor --task ${ws.slug}`,
        },
      );
    }
    await e.sleep(POLL_MS);
    probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  }
  if (probe.state === 'running') return probe;
  throw new McsError(
    'START_FAILED',
    `the runtime that was starting (${describePid(first.pid)}) did not become ready (${probe.state})`,
    {
      hint: `mcs doctor --task ${ws.slug}`,
    },
  );
}

function checkDatabase(e: Effects, ws: WorkspaceRef): void {
  const peek = e.peekDb(workspacePath(ws, 'data', 'monitor.db'));
  if (peek === null) return;
  if (peek.userVersion > peek.latest) {
    throw new McsError(
      'DB_NEWER_THAN_RUNTIME',
      `the database of '${ws.slug}' is at schema version ${String(peek.userVersion)}, newer than this runtime supports (${String(peek.latest)})`,
      { hint: 'start it with a runtime that is at least as new' },
    );
  }
  // version 0 is a file that was never migrated: the server creates its schema
  if (peek.userVersion > 0 && peek.userVersion < peek.latest) {
    throw new McsError(
      'DB_UPGRADE_REQUIRED',
      `the database of '${ws.slug}' is at schema version ${String(peek.userVersion)}, older than this runtime (${String(peek.latest)})`,
      { hint: `mcs upgrade --task ${ws.slug} --restart` },
    );
  }
}

/**
 * `ops.lifecycle.start` (01 4.7): resolves (or creates, or adopts) the workspace, validates the configuration and the
 * database version, classifies the instance, and then starts the detached server and waits until the control channel says
 * ready, HTTP health answers with this instance's id and `state.json` names the child. Idempotent: a running instance is
 * reported, never replaced.
 */
export async function start(ctx: OpContext, input: StartInput = {}, deps: LifecycleDeps = {}): Promise<StartResult> {
  const e = effects(deps);
  const target = await resolveTarget(ctx, input.task, 'create');
  const { ws } = target;
  const message: string[] = target.created ? [`created default workspace '${ws.slug}'`] : [];
  const warnings: string[] = [];
  const adoption = await adoptWorkspace(ws, { clock: ctx.clock });
  if (adoption.adopted) message.push('added Node runtime files: instance.json');
  const instance = adoption.instance;
  const base = {
    slug: ws.slug,
    dir: ws.dir,
    instanceId: instance.instanceId,
    createdDefault: target.created,
    adopted: adoption.adopted,
  };

  const config = await resolveConfig({
    workspace: ws,
    env: ctx.env,
    cli: {
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.logLevel === undefined ? {} : { logLevel: input.logLevel }),
    },
    skillDir: ctx.skillDir,
  });
  const startTimeoutMs = input.timeoutMs ?? config.runtime.process.startTimeoutMs;
  checkDatabase(e, ws);

  let probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  for (let round = 0; probe.state === 'stopping' && round < 3; round += 1) {
    if (probe.pid !== null) await e.processes.waitForExit(probe.pid, config.runtime.process.stopTimeoutMs);
    probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  }
  if (probe.state === 'starting') probe = await followOtherStart(ctx, e, ws, probe, startTimeoutMs);
  if (probe.state === 'running') {
    message.push(`already running: ${probe.url ?? '?'} (pid ${String(probe.pid)})`);
    return startedOutcome(base, 'already-running', probe, message, warnings);
  }
  if (probe.state === 'unmanaged-running') throw unmanagedRunning(ws, probe);
  if (probe.state === 'stopping') {
    throw new McsError('START_FAILED', `runtime ${describePid(probe.pid)} is still stopping`, {
      hint: `run \`mcs doctor --task ${ws.slug}\``,
    });
  }
  if (probe.state === 'unhealthy') {
    throw new McsError('START_FAILED', `runtime ${describePid(probe.pid)} answers its control channel but not HTTP`, {
      hint: `run \`mcs doctor --task ${ws.slug}\` or \`mcs restart --task ${ws.slug}\``,
      details: { state: probe.state },
    });
  }

  return launch(ctx, e, ws, base, message, warnings, input, startTimeoutMs);
}

interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** 01 4.7 steps 7 to 11: boot.log, the detached spawn, the wait for a healthy child, success or a killed child. */
async function launch(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  base: StartBase,
  message: string[],
  warnings: string[],
  input: StartInput,
  timeoutMs: number,
): Promise<StartResult> {
  const main = serverMainOf(ctx);
  const fd = await openBootLog(ws);
  const watch: { exit: Exit | null; failure: string | null } = { exit: null, failure: null };
  let child: SpawnedProcess;
  try {
    child = e.spawnDetached(process.execPath, serveArgv(main, ws, base.instanceId, input), {
      cwd: ws.dir,
      env: childEnv(ctx.env),
      stdoutFd: fd,
      stderrFd: fd,
    });
    // the same tick: a spawn that failed reports on `error` on the next one and an unhandled `error` ends this process
    child.once('exit', (code, signal) => {
      watch.exit = { code, signal };
    });
    child.once('error', (error) => {
      watch.failure = errnoOf(error);
    });
  } finally {
    closeSync(fd);
  }

  const deadline = e.now() + timeoutMs;
  let waitedForSpawnError = false;
  for (;;) {
    if (child.pid === undefined || watch.failure !== null) {
      if (watch.failure === null && !waitedForSpawnError) {
        waitedForSpawnError = true;
        await e.sleep(10);
        continue;
      }
      throw new McsError('START_FAILED', `cannot start the runtime process (${watch.failure ?? 'no pid'})`, {
        hint: `mcs doctor --task ${ws.slug}`,
      });
    }
    if (watch.exit !== null) return afterEarlyExit(ctx, e, ws, base, message, warnings, watch.exit, timeoutMs);
    const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
    if (isOurs(probe, child.pid)) {
      child.unref();
      const url = probe.url ?? '';
      message.push(`started: ${url} (pid ${String(child.pid)})`);
      let opened: boolean | null = null;
      if (input.open === true) {
        opened = await e.openUrl(url);
        if (!opened) warnings.push(`could not open a browser; open ${url}`);
      }
      return startedOutcome(base, 'started', probe, message, warnings, opened);
    }
    if (e.now() >= deadline) break;
    await e.sleep(POLL_MS);
  }
  return timedOut(e, ws, child.pid, timeoutMs);
}

/** The control channel says ready with the pid of our child, HTTP health matched (the probe), and state.json names the child. */
function isOurs(probe: ProbeResult, pid: number): boolean {
  return (
    probe.state === 'running' &&
    probe.identity?.pid === pid &&
    probe.stateFile?.pid === pid &&
    probe.stateFile.port === probe.identity.port
  );
}

async function failedStart(
  ws: WorkspaceRef,
  headline: string,
  hint: string,
  details: Record<string, unknown>,
): Promise<McsError> {
  const tail = await bootLogTail(ws);
  return new McsError('START_FAILED', [headline, ...tail].join(LF), { hint, details });
}

async function afterEarlyExit(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  base: StartBase,
  message: string[],
  warnings: string[],
  exit: Exit,
  timeoutMs: number,
): Promise<StartResult> {
  if (exit.code === INSTANCE_LOCKED) {
    // another start won the control channel (T-ISO-19): report that runtime like step 6
    let probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
    if (probe.state === 'starting') probe = await followOtherStart(ctx, e, ws, probe, timeoutMs);
    if (probe.state === 'running') {
      message.push(`already running: ${probe.url ?? '?'} (pid ${String(probe.pid)})`);
      return startedOutcome(base, 'already-running', probe, message, warnings);
    }
    if (probe.state === 'unmanaged-running') throw unmanagedRunning(ws, probe);
  }
  throw await failedStart(
    ws,
    `runtime exited during start (${exitName(exit.code, exit.signal)})`,
    `mcs doctor --task ${ws.slug}`,
    {
      exitCode: exit.code,
    },
  );
}

/** 01 4.7 step 11: the child is ours with certainty, so it is killed without a marker check. */
async function timedOut(e: Effects, ws: WorkspaceRef, pid: number, timeoutMs: number): Promise<never> {
  if (isValidPid(pid)) {
    await e.processes.forceKill(pid);
    await e.processes.waitForExit(pid, FORCED_KILL_WAIT_MS);
    await removeStateOf(ws, pid);
  }
  const tail = await bootLogTail(ws);
  throw new McsError(
    'START_TIMEOUT',
    [`runtime did not become healthy within ${secondsText(timeoutMs)} s`, ...tail].join(LF),
    { hint: `mcs doctor --task ${ws.slug}`, details: { pid, timeoutMs } },
  );
}

// ---- stop ----------------------------------------------------------------------------------------------------------------------------------

/** The route file says "stopped" when a stop killed the server (02 2.6.2: the server's own shutdown path did not run). */
async function markRouteStopped(ctx: OpContext, instanceId: string, spoolHours: number | null): Promise<void> {
  try {
    const mcsHome = resolveMcsHome(ctx.env);
    const route = readRouteFile(mcsHome, instanceId);
    if (route === null) return;
    const now = ctx.clock.now();
    const stopped = {
      ...route,
      stoppedAt: now,
      spoolUntil: spoolHours === null ? null : now + spoolHours * HOUR_MS,
      updatedAt: now,
    };
    await atomicWriteFile(routeFilePath(mcsHome, instanceId), `${JSON.stringify(stopped, null, 2)}${LF}`);
  } catch (error) {
    ctx.log.warn('route_stop_failed', { code: errnoOf(error) });
  }
}

function stopResult(
  base: Pick<StopResult, 'slug'>,
  outcome: StopOutcome,
  probe: ProbeResult | null,
  message: string,
  extra: { forced?: boolean; reason?: string } = {},
): StopResult {
  return {
    outcome,
    slug: base.slug,
    pid: probe?.pid ?? null,
    url: probe?.url ?? null,
    forced: extra.forced ?? false,
    reason: extra.reason ?? null,
    exitCode: 0,
    message: [message],
  };
}

const staleMessage = (pid: number | null): string =>
  `pid ${pid === null ? '?' : String(pid)} is not this instance's runtime (already stopped or pid reused); removed the stale state file, nothing was killed`;

/** Removes `state.json` as the probe read it (compare-and-delete): a file written since belongs to somebody else. */
async function removeStaleState(ws: WorkspaceRef, probe: ProbeResult): Promise<void> {
  if (probe.stateFileBytes !== null) await compareAndDelete(workspacePath(ws, 'state.json'), probe.stateFileBytes);
}

/**
 * `ops.lifecycle.stop` (01 4.9). Graceful first (control `shutdown` with the token of the instance, then a wait for the
 * exit). The forced path is the only one that kills: the command line of the pid must carry the runtime marker of this
 * instance (`hasRuntimeMarker`); a pid without that proof is never killed. A monitor that this runtime did not start
 * (`unmanaged-running`) is refused with `NOT_OUR_PROCESS` and never signalled (ADR 0066).
 */
export async function stop(ctx: OpContext, input: StopInput = {}, deps: LifecycleDeps = {}): Promise<StopResult> {
  const e = effects(deps);
  const { ws } = await resolveTarget(ctx, input.task, 'existing');
  const instance = await readInstanceFile(ws);
  const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  const config = await configOrNull(ctx, ws);
  const waitMs = input.timeoutMs ?? config?.runtime.process.stopTimeoutMs ?? FALLBACK_STOP_TIMEOUT_MS;

  switch (probe.state) {
    case 'stopped':
      return stopResult(
        ws,
        'nothing-to-stop',
        probe,
        `nothing to stop (no state file ${workspacePath(ws, 'state.json')})`,
      );
    case 'stale':
    case 'foreign-pid':
      await removeStaleState(ws, probe);
      return stopResult(ws, 'stale-removed', probe, staleMessage(probe.pid));
    case 'unmanaged-running':
      throw new McsError(
        'NOT_OUR_PROCESS',
        `a monitor runs '${ws.slug}' (${unmanagedWhere(probe)}) that was not started by this runtime; it is not signalled`,
        {
          hint: 'stop that monitor with the tool that started it',
          details: { state: probe.state, pid: probe.pid, url: probe.url },
        },
      );
    case 'running':
    case 'starting':
    case 'stopping':
    case 'unhealthy':
      return stopRuntime(ctx, e, ws, instance, probe, waitMs, config);
  }
}

function forcedReasonOf(attempt: ControlAttempt): string | null {
  switch (attempt.kind) {
    case 'reply':
      return null;
    case 'refusal':
      return `shutdown refused (${attempt.error})`;
    case 'absent':
      return 'the control channel is gone';
    case 'silent':
      return `the control channel is silent (${attempt.reason})`;
  }
}

async function stopRuntime(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  instance: InstanceFile | null,
  probe: ProbeResult,
  waitMs: number,
  config: ResolvedConfig | null,
): Promise<StopResult> {
  const pid = probe.pid;
  if (pid === null || !isValidPid(pid)) {
    throw new McsError('STOP_FAILED', 'hung runtime without a known pid', {
      hint: `run \`mcs doctor --task ${ws.slug}\``,
    });
  }
  const instanceId = instance?.instanceId ?? probe.identity?.instanceId ?? null;
  if (instanceId === null) {
    throw new McsError('STOP_FAILED', `cannot tell which instance pid ${String(pid)} belongs to`, {
      hint: `run \`mcs doctor --task ${ws.slug}\``,
    });
  }

  let forcedReason: string | null = null;
  if (probe.state === 'unhealthy' && probe.identity === null) {
    // a hung runtime goes straight to the forced path (01 4.9)
    forcedReason = 'the runtime holds the control channel but does not answer';
  } else if (probe.state !== 'stopping') {
    const token = await readToken(ws);
    if (token === null) {
      forcedReason = 'there is no control token';
    } else {
      const attempt = await e.control(
        controlAddressOf(instanceId),
        { v: 1, op: 'shutdown', instanceId, token, reason: 'stop' },
        { timeoutMs: CONTROL_TIMEOUT_MS },
      );
      // an `absent` channel may be a runtime that is already on its way out: the wait below decides
      forcedReason = attempt.kind === 'absent' ? null : forcedReasonOf(attempt);
    }
  }
  if (forcedReason === null) {
    if (await e.processes.waitForExit(pid, waitMs)) {
      await removeStateOf(ws, pid);
      return stopResult(ws, 'stopped', probe, `stopped runtime pid ${String(pid)} (${probe.url ?? '?'})`);
    }
    forcedReason = `still alive after ${String(waitMs)} ms`;
  }
  return forceStop(ctx, e, ws, instanceId, probe, pid, forcedReason, config);
}

async function forceStop(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  instanceId: string,
  probe: ProbeResult,
  pid: number,
  reason: string,
  config: ResolvedConfig | null,
): Promise<StopResult> {
  const line = await e.processes.commandLineOf(pid);
  if (line === null) {
    throw new McsError(
      'NOT_OUR_PROCESS',
      `the command line of pid ${String(pid)} could not be read; nothing was killed`,
      {
        hint: `run \`mcs doctor --task ${ws.slug}\``,
      },
    );
  }
  if (!hasRuntimeMarker(line, instanceId)) {
    throw new McsError(
      'NOT_OUR_PROCESS',
      `pid ${String(pid)} does not carry this instance's runtime marker; nothing was killed`,
      {
        hint: `run \`mcs doctor --task ${ws.slug}\``,
      },
    );
  }
  await e.processes.forceKill(pid);
  if (!(await e.processes.waitForExit(pid, FORCED_KILL_WAIT_MS))) {
    throw new McsError('STOP_FAILED', `pid ${String(pid)} still alive after stop request`);
  }
  await removeStateOf(ws, pid);
  await deleteIfUnchanged(workspacePath(ws, 'run', 'control.token'));
  await markRouteStopped(ctx, instanceId, config?.runtime.hooks.spoolWhileStoppedHours ?? null);
  return stopResult(
    ws,
    'stopped-forced',
    probe,
    `stopped runtime pid ${String(pid)} (${probe.url ?? '?'}) (forced: ${reason})`,
    {
      forced: true,
      reason,
    },
  );
}

// ---- reading the running server ------------------------------------------------------------------------------------------------------

type Fetched<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** One GET, parsed and validated against a shared response schema; the problem says what is wrong, in one phrase. */
async function fetchValidated<S extends z.ZodType>(
  e: Effects,
  base: string,
  route: string,
  schema: S,
): Promise<Fetched<z.output<S>>> {
  const attempt = await e.httpGet(`${base}${route}`, { timeoutMs: HTTP_TIMEOUT_MS });
  if (!attempt.ok) return { ok: false, problem: `no answer (${attempt.reason})` };
  if (attempt.reply.status !== 200) return { ok: false, problem: `status ${String(attempt.reply.status)}` };
  const body = jsonBodyOf(attempt.reply);
  if (body === undefined) return { ok: false, problem: 'the body is not JSON' };
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const [issue] = parsed.error.issues;
  const where = issue === undefined || issue.path.length === 0 ? 'the body' : issue.path.map(String).join('.');
  const more = parsed.error.issues.length > 1 ? ` (and ${String(parsed.error.issues.length - 1)} more)` : '';
  return { ok: false, problem: `invalid body: ${where}: ${issue?.message ?? 'does not match the schema'}${more}` };
}

/** What `status` counts from the sessions of the server: legacy states, partial sessions, and the newest activity. */
export interface SessionLike {
  readonly state: { readonly legacyState: LegacyState };
  readonly partial: boolean;
  readonly lastActivityAt: string;
}

export interface SessionSummaryCounts {
  readonly sessions: { RUNNING: number; IDLE: number; COMPLETED: number; FAILED: number; UNKNOWN: number };
  readonly partial: number;
  /** Seconds since the newest activity, one decimal; `null` without sessions. */
  readonly newestAgeS: number | null;
}

export function summarizeSessions(items: readonly SessionLike[], nowMs: number): SessionSummaryCounts {
  const sessions = { RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 };
  let partial = 0;
  let newest: number | null = null;
  for (const item of items) {
    sessions[item.state.legacyState] += 1;
    if (item.partial) partial += 1;
    const at = Date.parse(item.lastActivityAt);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return {
    sessions,
    partial,
    newestAgeS: newest === null ? null : Math.max(0, Math.round((nowMs - newest) / 100) / 10),
  };
}

const SESSION_PAGES_MAX = 5;
const SESSION_PAGE_SIZE = 200;

/** The newest sessions, at most `SESSION_PAGES_MAX` pages of 200 (the server's page maximum). */
async function fetchSessions(e: Effects, base: string): Promise<SessionLike[] | null> {
  const items: SessionLike[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SESSION_PAGES_MAX; page += 1) {
    const query = queryString(toQuery({ limit: SESSION_PAGE_SIZE, cursor }));
    const fetched = await fetchValidated(e, base, `/api/v3/sessions?${query}`, routes.listSessions.response);
    if (!fetched.ok) return null;
    items.push(...fetched.value.items);
    cursor = fetched.value.nextCursor;
    if (cursor === null) break;
  }
  return items;
}

// ---- status ----------------------------------------------------------------------------------------------------------------------------

function parseStamp(text: string): { runtimeVersion: string; codeStamp: string } | null {
  try {
    const value = recordOf(JSON.parse(text));
    const runtimeVersion = value?.['runtimeVersion'];
    const codeStamp = value?.['codeStamp'];
    return typeof runtimeVersion === 'string' && typeof codeStamp === 'string' ? { runtimeVersion, codeStamp } : null;
  } catch {
    return null;
  }
}

/** The build stamp of the runtime folder; `null` while a rebuild is writing it, or when it is damaged. */
async function currentStamp(ctx: OpContext): Promise<{ runtimeVersion: string; codeStamp: string } | null> {
  try {
    return parseStamp((await readSmallFile(path.join(ctx.runtimeDir, '.mcs-build.json'), 64 * 1024)).toString('utf8'));
  } catch {
    return null;
  }
}

const outdatedHint = (slug: string): string =>
  `the runtime code changed since this instance started: run \`mcs restart --task ${slug}\` (or \`mcs upgrade --task ${slug} --restart\` when the database needs an upgrade)`;

/**
 * `ops.lifecycle.status` (01 4.10): `probeInstance`, and for a running instance the health, the legacy health and the
 * sessions of the server. The keys are the legacy ones first, then the new ones. Exit 0 iff the monitor of this runtime
 * runs; a monitor that this runtime did not start is reported from the probe alone (nothing is fetched from it).
 */
export async function status(ctx: OpContext, input: TargetInput = {}, deps: LifecycleDeps = {}): Promise<StatusResult> {
  const e = effects(deps);
  const { ws } = await resolveTarget(ctx, input.task, 'existing');
  const instance = await readInstanceFile(ws);
  const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  const report = await buildReport(ctx, e, ws, instance, probe);
  return { report, exitCode: isRunningState(probe.state) ? 0 : 1 };
}

async function buildReport(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  instance: InstanceFile | null,
  probe: ProbeResult,
): Promise<StatusReport> {
  const stateFile = workspacePath(ws, 'state.json');
  const tail = { engine: probe.engine, probe: probe.state, instance_id: instance?.instanceId ?? null };
  if (probe.state === 'running') return runningReport(ctx, e, ws, probe, stateFile, tail);
  const live = isLiveState(probe.state);
  const hint = hintOf(ws, probe);
  return {
    running: false,
    state_file: stateFile,
    ...(live && probe.url !== null ? { url: probe.url } : {}),
    ...(live && probe.pid !== null ? { pid: probe.pid } : {}),
    ...(!live && probe.stateFile !== null ? { stale_state_file: probe.stateFile } : {}),
    ...(hint === null ? {} : { hint }),
    ...tail,
  };
}

function hintOf(ws: WorkspaceRef, probe: ProbeResult): string | null {
  if (probe.state === 'unhealthy') {
    return probe.identity === null
      ? `a runtime holds the control channel but does not answer; run \`mcs stop --task ${ws.slug}\` (it verifies the process before it kills)`
      : `runtime ${describePid(probe.pid)} answers its control channel but not HTTP; run \`mcs doctor --task ${ws.slug}\` or \`mcs restart --task ${ws.slug}\``;
  }
  if (probe.state === 'starting') return 'the runtime is starting; run status again in a moment';
  if (probe.state === 'stopping') return 'the runtime is stopping';
  if (probe.state === 'unmanaged-running') {
    return `a monitor that was not started by this runtime runs here (${unmanagedWhere(probe)}); stop it with the tool that started it`;
  }
  return null;
}

async function runningReport(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  probe: ProbeResult,
  stateFile: string,
  tail: { engine: 'node' | null; probe: ProbeResult['state']; instance_id: string | null },
): Promise<StatusReport> {
  const base = probe.url ?? '';
  const identity = probe.identity;
  const [health, legacy, sessions, stamp] = await Promise.all([
    fetchValidated(e, base, '/api/v3/health', routes.health.response),
    fetchValidated(e, base, '/api/health', routes.legacyHealth.response),
    fetchSessions(e, base),
    currentStamp(ctx),
  ]);
  const codeStamp = identity?.codeStamp;
  const outdated = stamp !== null && codeStamp !== undefined && stamp.codeStamp !== codeStamp;
  const reason = !outdated
    ? null
    : stamp.runtimeVersion === identity?.runtimeVersion
      ? ('code_stamp_changed' as const)
      : ('runtime_version_changed' as const);
  const counts = sessions === null ? null : summarizeSessions(sessions, ctx.clock.now());
  const uptime = legacy.ok ? legacy.value.uptime : null;
  return {
    running: true,
    state_file: stateFile,
    url: base,
    ...(probe.pid === null ? {} : { pid: probe.pid }),
    ...(uptime === null ? {} : { uptime_s: uptime }),
    ...(codeStamp === undefined ? {} : { code_stamp: codeStamp }),
    outdated,
    ...(legacy.ok ? { task: legacy.value.task, config_source: legacy.value.config_source } : {}),
    ...(health.ok
      ? {
          recent_errors: health.value.errors
            .slice(0, 5)
            .map((item) => ({ at: item.at, where: item.where ?? item.source, message: item.message })),
        }
      : {}),
    ...(legacy.ok ? { reader: legacy.value.reader } : {}),
    ...(counts === null
      ? {}
      : { sessions: counts.sessions, partial_sessions: counts.partial, newest_session_age_s: counts.newestAgeS }),
    ...(outdated ? { hint: outdatedHint(ws.slug) } : {}),
    ...tail,
    ...(identity === null ? {} : { runtime_version: identity.runtimeVersion }),
    outdated_reason: reason,
    ...(health.ok
      ? {
          db_schema_version: health.value.db.schemaVersion,
          ingestion: { status: health.value.ingestion.status, reasons: health.value.ingestion.reasons },
        }
      : {}),
  };
}

// ---- verify ---------------------------------------------------------------------------------------------------------------------------------

interface EndpointCheck {
  readonly path: string;
  readonly schema: z.ZodType;
  /** Reads the instance id of a valid body, to compare with the instance's own. */
  readonly instanceIdOf: (body: unknown) => string | null;
}

function instanceIdField(body: unknown): string | null {
  const id = recordOf(body)?.['instanceId'];
  return typeof id === 'string' ? id : null;
}

const VERIFY_ENDPOINTS: readonly EndpointCheck[] = [
  { path: '/api/v3/health', schema: routes.health.response, instanceIdOf: instanceIdField },
  { path: '/api/v3/instance', schema: routes.instance.response, instanceIdOf: instanceIdField },
  {
    path: `/api/v3/sessions?${queryString(toQuery({ limit: 1, includeTotal: true }))}`,
    schema: routes.listSessions.response,
    instanceIdOf: () => null,
  },
  { path: '/api/v3/overview', schema: routes.overview.response, instanceIdOf: () => null },
  { path: '/api/health', schema: routes.legacyHealth.response, instanceIdOf: instanceIdField },
];

/**
 * `ops.lifecycle.verify` (01 4.10): the five endpoints answer 200 with bodies that match the shared schemas, and the ones
 * that carry an instance id carry this instance's. Every problem is reported, not only the first.
 */
export async function verify(ctx: OpContext, input: TargetInput = {}, deps: LifecycleDeps = {}): Promise<VerifyResult> {
  const e = effects(deps);
  const { ws } = await resolveTarget(ctx, input.task, 'existing');
  const instance = await readInstanceFile(ws);
  const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  if (probe.state === 'unmanaged-running') throw unmanagedRunning(ws, probe);
  if (probe.state !== 'running' || probe.url === null) {
    throw new McsError(
      'INSTANCE_NOT_RUNNING',
      `no healthy monitor for this target (state file: ${workspacePath(ws, 'state.json')})`,
      {
        hint: `mcs start --task ${ws.slug}`,
      },
    );
  }
  const url = probe.url;
  const expected = instance?.instanceId ?? probe.identity?.instanceId ?? null;
  const problems: string[] = [];
  let sessions: number | null = null;
  for (const endpoint of VERIFY_ENDPOINTS) {
    const fetched = await fetchValidated(e, url, endpoint.path, endpoint.schema);
    if (!fetched.ok) {
      problems.push(`${endpoint.path}: ${fetched.problem}`);
      continue;
    }
    const id = endpoint.instanceIdOf(fetched.value);
    if (id !== null && expected !== null && id !== expected) {
      problems.push(`${endpoint.path}: the body belongs to another instance (${id.slice(0, 8)})`);
    }
    if (endpoint.path.startsWith('/api/v3/sessions')) {
      const total = recordOf(fetched.value)?.['total'];
      sessions = typeof total === 'number' ? total : null;
    }
  }
  if (problems.length > 0) throw new McsError('API_ERROR', problems.join('; '), { details: { problems } });
  return {
    slug: ws.slug,
    url,
    sessions,
    exitCode: 0,
    message: [
      `verified ${url}: health, instance, sessions (${sessions === null ? '?' : String(sessions)}), overview all valid`,
    ],
  };
}

// ---- restart ------------------------------------------------------------------------------------------------------------------------------

/** `ops.lifecycle.restart` (01 4.10): `stop`, and only if it succeeded, `start` with the same options. */
export async function restart(
  ctx: OpContext,
  input: StartInput = {},
  deps: LifecycleDeps = {},
): Promise<RestartResult> {
  const target = await resolveTarget(ctx, input.task, 'create');
  const { ws } = target;
  const message: string[] = target.created ? [`created default workspace '${ws.slug}'`] : [];
  const stopped = await stop(ctx, { task: ws.slug }, deps);
  message.push(...stopped.message);
  const started = await start(ctx, { ...input, task: ws.slug }, deps);
  message.push(...started.message);
  return {
    slug: ws.slug,
    stop: stopped,
    start: started,
    exitCode: started.exitCode,
    message,
    warnings: started.warnings,
  };
}

// ---- serve (foreground) -----------------------------------------------------------------------------------------------------------------

const FORWARDED_SIGNALS = ['SIGINT', 'SIGBREAK', 'SIGHUP'] as const;

/** Resolves when the runtime answers ready, then opens the URL (`serve --open`); gives up when `cancelled()` says so. */
async function openWhenReady(
  ctx: OpContext,
  e: Effects,
  ws: WorkspaceRef,
  timeoutMs: number,
  cancelled: () => boolean,
): Promise<void> {
  const deadline = e.now() + timeoutMs;
  while (!cancelled() && e.now() < deadline) {
    const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
    if (probe.state === 'running' && probe.url !== null) {
      await e.openUrl(probe.url);
      return;
    }
    await e.sleep(POLL_MS);
  }
}

/**
 * `ops.lifecycle.serveForeground` (01 4.10): the server runs attached to this terminal, with the same argv (and so the same
 * marker) as `start`. SIGINT, SIGBREAK and SIGHUP are forwarded as the control `shutdown` (and, where the host has real
 * signals, as the signal itself). The exit code of the server is mapped: 0 to 0, anything else is an error that names it.
 */
export async function serveForeground(
  ctx: OpContext,
  input: ServeInput = {},
  deps: LifecycleDeps = {},
): Promise<ServeResult> {
  const e = effects(deps);
  const target = await resolveTarget(ctx, input.task, 'create');
  const { ws } = target;
  const message: string[] = target.created ? [`created default workspace '${ws.slug}'`] : [];
  const warnings: string[] = [];
  const adoption = await adoptWorkspace(ws, { clock: ctx.clock });
  if (adoption.adopted) message.push('added Node runtime files: instance.json');
  const instance = adoption.instance;
  if (input.stateFile !== undefined) {
    warnings.push(`--state-file is ignored by the Node runtime (it always uses ${workspacePath(ws, 'state.json')})`);
  }
  const probe = await e.probe(ws, { runtimeDir: ctx.runtimeDir });
  if (probe.state === 'unmanaged-running') throw unmanagedRunning(ws, probe);
  if (isLiveState(probe.state)) {
    throw new McsError(
      'INSTANCE_RUNNING',
      `the instance '${ws.slug}' is already running (${describePid(probe.pid)}, ${probe.state})`,
      {
        hint: `mcs stop --task ${ws.slug}`,
      },
    );
  }
  const config = await resolveConfig({
    workspace: ws,
    env: ctx.env,
    cli: {
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.logLevel === undefined ? {} : { logLevel: input.logLevel }),
    },
    skillDir: ctx.skillDir,
  });
  const main = serverMainOf(ctx);
  const child = e.spawnForeground(process.execPath, serveArgv(main, ws, instance.instanceId, input), {
    cwd: ws.dir,
    env: childEnv(ctx.env),
  });

  const ended = new Promise<Exit | { readonly failure: string }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      resolve({ failure: errnoOf(error) });
    });
  });
  let interrupted = false;
  let done = false;
  const forward = async (signal: (typeof FORWARDED_SIGNALS)[number]): Promise<void> => {
    interrupted = true;
    const token = await readToken(ws);
    if (token !== null) {
      await e.control(
        controlAddressOf(instance.instanceId),
        { v: 1, op: 'shutdown', instanceId: instance.instanceId, token, reason: 'signal' },
        { timeoutMs: CONTROL_TIMEOUT_MS },
      );
    }
    // a console delivers Ctrl+C to the child itself; elsewhere a signal sent to this process has to be passed on
    if (hostPlatform !== 'win32') child.kill(signal);
  };
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = (): void => {
      void forward(signal).catch(() => undefined);
    };
    e.signals.on(signal, handler);
    return { signal, handler };
  });
  const opening =
    input.open === true
      ? openWhenReady(ctx, e, ws, config.runtime.process.startTimeoutMs, () => done)
      : Promise.resolve();
  let outcome: Exit | { readonly failure: string };
  try {
    outcome = await ended;
  } finally {
    done = true;
    for (const { signal, handler } of handlers) e.signals.off(signal, handler);
  }
  await opening.catch(() => undefined);

  if ('failure' in outcome) {
    throw new McsError('START_FAILED', `cannot start the runtime process (${outcome.failure})`, {
      hint: `mcs doctor --task ${ws.slug}`,
    });
  }
  if (outcome.code !== 0) {
    throw new McsError('START_FAILED', `runtime exited (${exitName(outcome.code, outcome.signal)})`, {
      hint: `mcs doctor --task ${ws.slug}`,
      details: { exitCode: outcome.code },
    });
  }
  return { slug: ws.slug, exitCode: 0, message, warnings, interrupted };
}
