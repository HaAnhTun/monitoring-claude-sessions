// The server process: argv, the boot sequence of 01 4.4 with its exit codes (4.1), the port scan (4.11), the wiring of the
// control channel, the HTTP app and the instance runtime, `state.json` and the token (4.6, 8.2), and the graceful shutdown
// (4.5, `shutdown.ts`). `bootServer` is the whole sequence as a function that returns instead of exiting, so a test boots a
// real instance in-process; `serveMain` adds the signals and returns the exit code that `main.ts` passes to `process.exit`.
//
// Steps of 01 4.4, and what differs here:
//   1 argv (exit 17)  2 identity (11)  3 control channel (12)  6 build stamp (18)  4+5+7 logger, configuration and database
//   (10, 11, 14, 15, 16, 17) -- `buildInstanceContext` (WP-16) does these three in one call, in the order configuration,
//   logger, database; the stamp is read before it, because it needs the stamp  8 web build and HTTP app  9 bind (13)
//   10 token, then state.json  11 `runtime.start()`, phase ready. Any failure after step 3 cleans up what exists and exits.
import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Server as NetServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AtomicWriteError,
  assertNotLink,
  atomicWriteFile,
  backupDb,
  buildInstanceContext,
  compareAndDelete,
  createInstanceRuntime,
  DB_OPEN_EXIT_CODES,
  ensureWorkspaceDir,
  isDbError,
  layoutOfRuntimeDir,
  readInstanceFile,
  readSmallFile,
  readTaskFile,
  resolveWorkspace,
  SpoolSegmentNotFoundError,
  testHook,
  workspacePath,
  type InstanceContext,
  type InstanceRuntime,
  type LogLevel,
  type RuntimeFactories,
  type RuntimeLayoutMode,
  type WorkspaceRef,
  skillDirOfRuntimeDir,
} from '@mcs/engine';
import {
  LogLevelSchema,
  McsError,
  RUNTIME_VERSION,
  UUID_V4_RE,
  isoMsZ,
  systemClock,
  type CliErrorCode,
  type Clock,
} from '@mcs/shared';
import type { ControlPhase } from '@mcs/shared/protocol';
import { z } from 'zod';

import { createApp, createHttpServer, loadStaticSite, type StaticSite } from './app.ts';
import {
  controlAddress,
  openControlChannel,
  validateBackupDest,
  type BackupOutcome,
  type ControlChannel,
  type ReplayOutcome,
} from './control-channel.ts';
import { readLegacyTask } from './routes/meta.ts';
import {
  createShutdownGate,
  runShutdown,
  type ShutdownGate,
  type ShutdownOutcome,
  type ShutdownReason,
} from './shutdown.ts';
import {
  STATE_FILE_NAME,
  buildStateFile,
  readExistingState,
  writeStateFile,
  type BuiltStateFile,
  type ExistingState,
} from './state-file.ts';

// ---- exit codes (01 4.1, registry 7.3) -------------------------------------------------------------------------------------

export const SERVER_EXIT_CODES = {
  OK: 0,
  CONFIG_INVALID: 10,
  IDENTITY_MISMATCH: 11,
  INSTANCE_LOCKED: 12,
  PORT_EXHAUSTED: 13,
  DB_ERROR: 14,
  DB_NEWER_THAN_RUNTIME: 15,
  DB_UPGRADE_REQUIRED: 16,
  WORKSPACE_INVALID: 17,
  BUILD_INVALID: 18,
  INTERNAL: 70,
} as const;

export type ServerExitName = keyof typeof SERVER_EXIT_CODES;
export type ServerExitCode = (typeof SERVER_EXIT_CODES)[ServerExitName];
/** An exit code that says the boot failed. */
export type ServerFailureCode = Exclude<ServerExitCode, 0>;

/** Every exit code once, so that a code added to the table above is also named here (a missing key does not compile). */
const NAME_OF_CODE: Readonly<Record<ServerExitCode, ServerExitName>> = {
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

/** The name of an exit code; `INTERNAL` for a number that is not one of ours. */
export function exitNameOf(code: number): ServerExitName {
  return Object.entries(NAME_OF_CODE).find(([key]) => Number(key) === code)?.[1] ?? 'INTERNAL';
}

/** The CLI error codes that a failed boot step can carry, and the exit code of each (01 4.1); the rest is INTERNAL. */
const EXIT_OF_ERROR_CODE: Readonly<Partial<Record<CliErrorCode, ServerFailureCode>>> = {
  CONFIG_INVALID: 10,
  CONFIG_SCHEMA_MISSING: 10,
  CONFIG_SCHEMA_UNSUPPORTED: 10,
  CONFIG_UNREADABLE: 10,
  REGEX_UNSUPPORTED: 10,
  IDENTITY_MISMATCH: 11,
  PORT_EXHAUSTED: 13,
  DB_ERROR: 14,
  DB_NEWER_THAN_RUNTIME: 15,
  DB_UPGRADE_REQUIRED: 16,
  WORKSPACE_INVALID: 17,
  SLUG_INVALID: 17,
  WORKSPACE_ESCAPE: 17,
  WORKSPACE_SYMLINK: 17,
  TASK_NOT_FOUND: 17,
  INSTANCE_NOT_INITIALIZED: 17,
  USAGE: 17,
};

/** The exit code of a failure of a boot step: the `McsError` code, or the open code of a database error (03 3.2). */
export function exitCodeOfError(error: unknown): ServerFailureCode {
  if (isDbError(error)) return DB_OPEN_EXIT_CODES[error.code];
  if (error instanceof McsError) return EXIT_OF_ERROR_CODE[error.code] ?? SERVER_EXIT_CODES.INTERNAL;
  return SERVER_EXIT_CODES.INTERNAL;
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'INTERNAL';
}

/**
 * The answer of the control op `ingest-replay` (01 4.3). A segment that is not on disk is a bad request (02 2.7); any other
 * failure is answered `NOT_READY` and logged by its code only (a message may hold a path), so the connection is never dropped
 * without a reply.
 */
export async function ingestReplayOutcome(
  runtime: Pick<InstanceRuntime, 'ingestReplay'> | undefined,
  fromSegment: string | null,
  warn: (event: string, fields: Readonly<Record<string, unknown>>) => void,
): Promise<ReplayOutcome> {
  if (runtime === undefined) return { ok: false, error: 'NOT_READY' };
  try {
    return { ok: true, segments: (await runtime.ingestReplay(fromSegment)).segments };
  } catch (error) {
    if (error instanceof SpoolSegmentNotFoundError) return { ok: false, error: 'BAD_REQUEST' };
    warn('ingest_replay_failed', { code: errorCodeOf(error) });
    return { ok: false, error: 'NOT_READY' };
  }
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 300);
}

// ---- argv (01 4.1) ---------------------------------------------------------------------------------------------------------

export interface ServeArgs {
  readonly instanceId: string;
  readonly instanceDir: string;
  readonly port?: number;
  readonly logLevel?: LogLevel;
}

export type ParsedArgv =
  { readonly ok: true; readonly args: ServeArgs } | { readonly ok: false; readonly message: string };

const USAGE = 'usage: serve --mcs-instance=<uuid> --instance-dir=<absolute path> [--port=<n>] [--log-level=<level>]';
const KNOWN_OPTIONS: ReadonlySet<string> = new Set(['mcs-instance', 'instance-dir', 'port', 'log-level']);

function shown(text: string): string {
  return JSON.stringify(text.slice(0, 60));
}

/**
 * `serve --mcs-instance=<id> --instance-dir=<abs> [--port=<n>] [--log-level=<level>]`: the order of the options is free, an
 * unknown or repeated option is an error, and `--port=0` is "not given" (legacy). The message is one line and ends with the usage.
 */
export function parseServeArgv(argv: readonly string[]): ParsedArgv {
  const problem = (message: string): ParsedArgv => ({ ok: false, message: `bad command line: ${message}; ${USAGE}` });
  const [command, ...rest] = argv;
  if (command !== 'serve') return problem(`the command must be "serve", not ${shown(command ?? '')}`);
  const values = new Map<string, string>();
  for (const token of rest) {
    const match = /^--([a-z-]+)=([\s\S]*)$/.exec(token);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined) return problem(`unexpected argument ${shown(token)}`);
    if (!KNOWN_OPTIONS.has(name)) return problem(`unknown option --${name}`);
    if (values.has(name)) return problem(`--${name} is given twice`);
    values.set(name, value);
  }
  const instanceId = values.get('mcs-instance');
  if (instanceId === undefined || !UUID_V4_RE.test(instanceId)) {
    return problem('--mcs-instance must be the version 4 uuid of the instance');
  }
  const instanceDir = values.get('instance-dir');
  if (instanceDir === undefined || instanceDir === '' || instanceDir.includes('\0') || !path.isAbsolute(instanceDir)) {
    return problem('--instance-dir must be the absolute path of the workspace');
  }
  const portText = values.get('port');
  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535)
      return problem('--port must be an integer from 1 to 65535');
    port = Number(portText) === 0 ? undefined : Number(portText);
  }
  const levelText = values.get('log-level');
  let logLevel: LogLevel | undefined;
  if (levelText !== undefined) {
    const level = LogLevelSchema.safeParse(levelText);
    if (!level.success) return problem(`--log-level must be one of ${LogLevelSchema.options.join(', ')}`);
    logLevel = level.data;
  }
  return {
    ok: true,
    args: {
      instanceId,
      instanceDir,
      ...(port === undefined ? {} : { port }),
      ...(logLevel === undefined ? {} : { logLevel }),
    },
  };
}

// ---- the build stamp (01 4.4 step 6) -----------------------------------------------------------------------------------------

export interface BuildStamp {
  readonly runtimeVersion: string;
  readonly codeStamp: string;
}

const BuildStampSchema = z.object({ runtimeVersion: z.string(), codeStamp: z.string().regex(/^[0-9a-f]{10}$/) });
const BUILD_STAMP_FILE = '.mcs-build.json';

/**
 * `<runtimeDir>/.mcs-build.json`: present, well formed, and written for this runtime version; otherwise exit 18
 * (BUILD_INVALID). The message names the file and the way out of the layout (ADR 0062 item 5): rebuild a checkout, reinstall
 * a bundle.
 */
export async function readBuildStamp(
  runtimeDir: string,
  mode: RuntimeLayoutMode = 'source',
): Promise<{ readonly ok: true; readonly stamp: BuildStamp } | { readonly ok: false; readonly message: string }> {
  const hint = mode === 'bundle' ? 'reinstall the skill' : 'run `npm run build` in the runtime folder';
  const label = `${mode === 'bundle' ? 'bundle' : 'runtime'}/${BUILD_STAMP_FILE}`;
  let bytes: Buffer;
  try {
    bytes = await readSmallFile(path.join(runtimeDir, BUILD_STAMP_FILE), 64 * 1024);
  } catch {
    return { ok: false, message: `${label} is missing or unreadable: ${hint}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, message: `${label} is not valid JSON: ${hint}` };
  }
  const parsed = BuildStampSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: `${label} has no runtimeVersion and codeStamp: ${hint}` };
  }
  if (parsed.data.runtimeVersion !== RUNTIME_VERSION) {
    return {
      ok: false,
      message: `${label} was written for runtime ${parsed.data.runtimeVersion}, this code is ${RUNTIME_VERSION}: ${hint}`,
    };
  }
  return { ok: true, stamp: { runtimeVersion: parsed.data.runtimeVersion, codeStamp: parsed.data.codeStamp } };
}

// ---- the folders of the runtime layout (ADR 0062 item 2) -------------------------------------------------------------------

export interface RuntimeFolders {
  readonly mode: RuntimeLayoutMode;
  readonly skillDir: string;
  readonly webDir: string;
  /** Bundle layout: `<runtimeDir>/migrations`. Undefined: the engine default (the folder of the running engine module). */
  readonly migrationsDir: URL | undefined;
}

/**
 * The folders of a runtime folder through the layout resolver. A folder the resolver does not know (a test fixture laid out
 * as `<skill>/runtime` with only the stamp) keeps the source-layout paths. Only a bundle names its own migrations folder.
 */
export function runtimeFoldersOf(runtimeDir: string): RuntimeFolders {
  try {
    const layout = layoutOfRuntimeDir(runtimeDir);
    return {
      mode: layout.mode,
      skillDir: layout.skillDir,
      webDir: layout.webDir,
      // a source folder keeps the engine default: a test install that only has a server shim has no migrations of its own
      migrationsDir: layout.mode === 'bundle' ? pathToFileURL(layout.migrationsDir + path.sep) : undefined,
    };
  } catch {
    return {
      mode: 'source',
      skillDir: skillDirOfRuntimeDir(runtimeDir),
      webDir: path.join(runtimeDir, 'packages', 'web', 'dist'),
      migrationsDir: undefined,
    };
  }
}

// ---- the port scan (01 4.11) ---------------------------------------------------------------------------------------------------

/** The server binds the loopback address and nothing else; there is no option for it (01 8.2). */
export const BIND_HOST = '127.0.0.1';

/** `base .. min(65535, base + scan)`, in order. */
export function scanPorts(base: number, scan: number): number[] {
  const last = Math.min(65535, base + scan);
  const ports: number[] = [];
  for (let port = base; port <= last; port += 1) ports.push(port);
  return ports;
}

export type BindResult =
  { readonly ok: true; readonly port: number } | { readonly ok: false; readonly message: string };

type ListenAttempt =
  { readonly kind: 'listening' } | { readonly kind: 'busy' } | { readonly kind: 'error'; readonly code: string };

function listenOnce(server: NetServer, port: number, host: string): Promise<ListenAttempt> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      // address in use, or a port that Windows keeps out of use (excluded ranges): try the next one
      resolve(
        error.code === 'EADDRINUSE' || error.code === 'EACCES'
          ? { kind: 'busy' }
          : { kind: 'error', code: error.code ?? 'ERROR' },
      );
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve({ kind: 'listening' });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host });
  });
}

/**
 * Binds the first free port of `base .. base + scan` (01 4.11). The bind is the reservation: no port file, no pre-check. An
 * error other than "in use" stops the scan with its code. `host` is a seam for the tests; the server always passes the default.
 */
export async function bindFirstFreePort(
  server: NetServer,
  base: number,
  scan: number,
  host: string = BIND_HOST,
): Promise<BindResult> {
  const ports = scanPorts(base, scan);
  for (const port of ports) {
    const attempt = await listenOnce(server, port, host);
    if (attempt.kind === 'listening') return { ok: true, port };
    if (attempt.kind === 'error') {
      return { ok: false, message: `cannot listen on ${host}:${String(port)} (${attempt.code})` };
    }
  }
  const last = ports.at(-1) ?? base;
  return { ok: false, message: `no free port in ${String(base)}..${String(last)} on ${host}` };
}

// ---- the boot ---------------------------------------------------------------------------------------------------------------------

export interface BootInput {
  /** The arguments after the script: `['serve', '--mcs-instance=...', ...]`. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `<skill>/runtime`. */
  readonly runtimeDir: string;
  /** Default: the skill folder of the layout of `runtimeDir` (`runtimeFoldersOf`). */
  readonly skillDir?: string;
  readonly clock?: Clock;
  /** Where the boot prints its failures (the detached server's stderr is `logs/boot.log`); default: file descriptor 2. */
  readonly stderr?: (text: string) => void;
  /** The shutdown trigger; the signal handlers of `serveMain` and the tests hold the same one. Default: a new one. */
  readonly gate?: ShutdownGate;
  /** Test seam: replaces factories of the runtime one by one. */
  readonly factories?: Partial<RuntimeFactories>;
}

export interface RunningServer {
  readonly ctx: InstanceContext;
  readonly runtime: InstanceRuntime;
  readonly address: string;
  /** The bound port; `null` when a shutdown ended the boot before the bind. */
  readonly port: number | null;
  readonly url: string | null;
  /** Resolves when the shutdown is complete (the logger is flushed): the process may exit with `exitCode`. */
  readonly closed: Promise<ShutdownOutcome>;
  /** The first request wins; the shutdown runs the six steps of 01 4.5. */
  requestShutdown(reason: ShutdownReason): void;
}

export type BootResult =
  | { readonly ok: true; readonly server: RunningServer }
  | { readonly ok: false; readonly exitCode: ServerFailureCode; readonly message: string };

function writeStderr(text: string): void {
  try {
    writeSync(2, text);
  } catch {
    // nobody reads this stream (a closed console); the failure is still the exit code
  }
}

/** The `run/control.token` file: 64 hex characters and one LF, written atomically, readable by this user only on POSIX. */
async function writeTokenFile(file: string, bytes: Uint8Array): Promise<void> {
  assertNotLink(path.dirname(file));
  assertNotLink(file);
  try {
    await atomicWriteFile(file, bytes, { mode: 0o600 });
  } catch (error) {
    if (error instanceof AtomicWriteError) {
      throw new McsError('WORKSPACE_INVALID', `cannot write the control token: ${error.code}`, { cause: error });
    }
    throw error;
  }
}

const HTTP_DRAIN_MS = 500;
const FAILURE_STOP_MS = 1000;

/** Resolves `promise`'s value, or `'timeout'` after `ms`; the timer never outlives the call. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Runs a cleanup action and swallows its failure: what is being reported (or ended) matters more. */
async function quietly(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch {
    // best effort
  }
}

/** What exists at a given moment of the boot: what a failure or a shutdown has to close. */
interface Resources {
  ctx?: InstanceContext;
  runtime?: InstanceRuntime;
  http?: Server;
  /** The bytes of `state.json` this process wrote or would have written (the watchdog compares against them). */
  state?: BuiltStateFile;
  /** True when this process wrote `state.json` (it did not when a live legacy viewer owns the file). */
  stateWritten?: boolean;
  /** The bytes of `run/control.token` once written. */
  token?: Uint8Array;
}

export async function bootServer(input: BootInput): Promise<BootResult> {
  const clock = input.clock ?? systemClock;
  const stderr = input.stderr ?? writeStderr;
  const gate = input.gate ?? createShutdownGate();
  const runtimeDir = path.resolve(input.runtimeDir);
  const folders = runtimeFoldersOf(runtimeDir);
  const skillDir = input.skillDir ?? folders.skillDir;

  const fail = (exitCode: ServerFailureCode, message: string, detail?: string): BootResult => {
    stderr(
      `mcs-server: ${exitNameOf(exitCode)} (${String(exitCode)}): ${message}\n${detail === undefined ? '' : `${detail}\n`}`,
    );
    return { ok: false, exitCode, message };
  };
  const failFrom = (error: unknown): BootResult => {
    const exitCode = exitCodeOfError(error);
    const message = error instanceof Error ? firstLine(error.message) : 'an unexpected failure';
    const stack = exitCode === SERVER_EXIT_CODES.INTERNAL && error instanceof Error ? error.stack : undefined;
    return fail(exitCode, message === '' ? 'an unexpected failure' : message, stack);
  };

  // 1. argv
  const parsed = parseServeArgv(input.argv);
  if (!parsed.ok) return fail(SERVER_EXIT_CODES.WORKSPACE_INVALID, parsed.message);
  const args = parsed.args;

  // 2. identity (01 3.2): the workspace, instance.json, task.json and the instance id of the command line agree
  let ws: WorkspaceRef;
  try {
    const dir = path.resolve(args.instanceDir);
    ws = resolveWorkspace(path.dirname(dir), path.basename(dir));
    const instance = await readInstanceFile(ws);
    if (instance === null) {
      throw new McsError(
        'WORKSPACE_INVALID',
        'the folder has no instance.json: start it with `mcs start` (or `mcs init`) first',
      );
    }
    await readTaskFile(ws);
    if (instance.instanceId !== args.instanceId) {
      throw new McsError('IDENTITY_MISMATCH', 'the instance id of the command line is not the one of instance.json');
    }
  } catch (error) {
    return failFrom(error);
  }

  // the build stamp is a read of the runtime folder, not of the instance; its failure is reported after the lock (step 6)
  const stampResult = await readBuildStamp(runtimeDir, folders.mode);
  const address = controlAddress(args.instanceId);
  const startedAtMs = clock.now();
  const token = randomBytes(32).toString('hex');
  let port: number | null = null;
  let ready = false;
  let stopping = false;
  let bootDone = false;
  const currentPhase = (): ControlPhase =>
    stopping || gate.reason !== null ? 'stopping' : ready ? 'ready' : 'starting';
  const res: Resources = {};
  // events before the logger exists (identify at the very start) are not worth a log file
  const lateLog = (level: 'debug' | 'info' | 'warn') => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    res.ctx?.logger[level](event, fields);
  };

  // 3. the control channel: the instance lock. Nothing else of the instance has been touched.
  let channel: ControlChannel | null;
  try {
    channel = await openControlChannel({
      address,
      instanceId: args.instanceId,
      token: () => token,
      phase: currentPhase,
      identity: () => ({
        pid: process.pid,
        runtimeVersion: stampResult.ok ? stampResult.stamp.runtimeVersion : RUNTIME_VERSION,
        codeStamp: stampResult.ok ? stampResult.stamp.codeStamp : '',
        port,
        url: port === null ? null : `http://${BIND_HOST}:${String(port)}`,
        startedAt: isoMsZ(startedAtMs),
      }),
      onShutdown: (reason) => {
        gate.request(reason);
      },
      onBackup: async (dest): Promise<BackupOutcome> => {
        const ctx = res.ctx;
        if (ctx === undefined) return { ok: false, error: 'BACKUP_FAILED' };
        if (!(await validateBackupDest(workspacePath(ws, 'data', 'backups'), dest)))
          return { ok: false, error: 'BAD_REQUEST' };
        try {
          return { ok: true, ...(await backupDb(ctx.db, dest)) };
        } catch (error) {
          ctx.logger.warn('backup_failed', { code: errorCodeOf(error) });
          return { ok: false, error: 'BACKUP_FAILED' };
        }
      },
      onIngestReplay: (fromSegment): Promise<ReplayOutcome> =>
        ingestReplayOutcome(res.runtime, fromSegment, lateLog('warn')),
      logger: { debug: lateLog('debug'), info: lateLog('info'), warn: lateLog('warn') },
      ignoreRequests: testHook('IGNORE_CONTROL', input.env) !== undefined,
    });
  } catch (error) {
    return failFrom(error);
  }
  if (channel === null) {
    return fail(
      SERVER_EXIT_CODES.INSTANCE_LOCKED,
      'the control channel of this instance is taken: another runtime is running',
    );
  }
  const openChannel: ControlChannel = channel;

  // ---- what undoes the boot (a failure) and what ends a run (the shutdown) share these closers --------------------------------

  const closeHttp = async (): Promise<void> => {
    const http = res.http;
    if (http === undefined) return;
    const closed = new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
    http.closeIdleConnections();
    if ((await within(closed, HTTP_DRAIN_MS)) === 'timeout') {
      http.closeAllConnections();
      await closed;
    }
  };
  let databaseClosed = false;
  const closeDatabase = (): void => {
    const ctx = res.ctx;
    if (ctx === undefined || databaseClosed) return;
    databaseClosed = true;
    try {
      ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      ctx.logger.warn('db_checkpoint_failed', { code: errorCodeOf(error) });
    }
    ctx.db.close();
  };
  const removeFiles = async (): Promise<void> => {
    const ctx = res.ctx;
    if (ctx === undefined) return;
    const failures: unknown[] = [];
    // compare-and-delete: a file that someone else wrote in the meantime (a legacy viewer, a newer runtime) stays
    const attempt = async (file: string, bytes: Uint8Array | undefined): Promise<void> => {
      if (bytes === undefined) return;
      try {
        await compareAndDelete(file, bytes);
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(
      path.join(ctx.instanceDir, STATE_FILE_NAME),
      res.stateWritten === true ? res.state?.bytes : undefined,
    );
    await attempt(path.join(ctx.instanceDir, 'run', 'control.token'), res.token);
    if (failures.length > 0) throw failures[0];
  };

  /** A failed boot: stop what started, close what opened, take back what was written, and report the failure. */
  const abort = async (result: BootResult): Promise<BootResult> => {
    await quietly(() => res.runtime?.stop(clock.now() + FAILURE_STOP_MS));
    await quietly(closeHttp);
    await quietly(closeDatabase);
    await quietly(removeFiles);
    await quietly(() => openChannel.close());
    await quietly(() => res.ctx?.logger.close());
    return result;
  };

  if (!stampResult.ok) return abort(fail(SERVER_EXIT_CODES.BUILD_INVALID, stampResult.message));
  const stamp = stampResult.stamp;

  try {
    // a state.json left behind by a run that did not end cleanly (01 4.13), read before this process writes its own
    const stateFile = path.join(ws.dir, STATE_FILE_NAME);
    const existing: ExistingState = await readExistingState(stateFile);
    const previousRunUnclean = existing.kind === 'stale';

    // 4, 5, 7. configuration, logger, database, queries
    let ctx: InstanceContext;
    try {
      ctx = await buildInstanceContext({
        instanceDir: ws.dir,
        env: input.env,
        cli: {
          ...(args.port === undefined ? {} : { port: args.port }),
          ...(args.logLevel === undefined ? {} : { logLevel: args.logLevel }),
        },
        skillDir,
        runtimeDir,
        build: stamp,
        ...(folders.migrationsDir === undefined ? {} : { migrationsDir: folders.migrationsDir }),
        clock,
        processInfo: { pid: process.pid, startedAtMs, previousRunUnclean, phase: currentPhase },
      });
    } catch (error) {
      return await abort(failFrom(error));
    }
    res.ctx = ctx;
    if (existing.kind === 'stale') ctx.logger.warn('previous_run_unclean', { code: existing.reason });

    const runtime = createInstanceRuntime(ctx, {
      stateFileBytes: () => res.state?.bytes ?? null,
      ...(input.factories === undefined ? {} : { factories: input.factories }),
    });
    res.runtime = runtime;

    // ---- the handle that the caller gets, and the shutdown that ends it ----------------------------------------------------------

    let resolveClosed: (outcome: ShutdownOutcome) => void = () => undefined;
    const closed = new Promise<ShutdownOutcome>((resolve) => {
      resolveClosed = resolve;
    });
    let shutdownRun: Promise<void> | null = null;
    const shutdown = (reason: ShutdownReason): void => {
      shutdownRun ??= (async () => {
        const outcome = await runShutdown({
          clock,
          graceMs: ctx.config.runtime.server.shutdownGraceMs,
          logger: ctx.logger,
          reason,
          steps: {
            enterStopping: () => {
              stopping = true;
            },
            closeHttp,
            stopRuntime: (deadlineMs) => runtime.stop(deadlineMs),
            closeDatabase,
            removeFiles,
            closeControl: () => openChannel.close(),
          },
        });
        if (outcome.deadlineExceededAtStep !== null) {
          // the deadline passed: whatever is still open is dropped without waiting (the process exits next)
          await quietly(() => {
            res.http?.closeAllConnections();
            res.http?.close();
          });
          await quietly(closeDatabase);
          await quietly(() => openChannel.close());
        }
        await ctx.logger.close();
        resolveClosed(outcome);
      })();
    };
    gate.onRequest((reason) => {
      if (bootDone) shutdown(reason);
    });
    const server: RunningServer = {
      ctx,
      runtime,
      address,
      get port() {
        return port;
      },
      get url() {
        return port === null ? null : `http://${BIND_HOST}:${String(port)}`;
      },
      closed,
      requestShutdown: (reason) => {
        gate.request(reason);
      },
    };
    /** A shutdown asked for during the boot is honoured here, at a point where everything that exists can be closed. */
    const honourEarlyShutdown = (): BootResult | null => {
      if (gate.reason === null) return null;
      bootDone = true;
      shutdown(gate.reason);
      return { ok: true, server };
    };

    if (testHook('BOOT_HANG', input.env) !== undefined) {
      // T-LC-08: a boot that never becomes ready; a shutdown request still ends it
      await new Promise<void>((resolve) => {
        gate.onRequest(() => {
          resolve();
        });
      });
    }
    const early = honourEarlyShutdown();
    if (early !== null) return early;

    // 8. the web build in memory (a rebuild under a running server cannot break the served UI), then the HTTP app
    let site: StaticSite | null = null;
    try {
      site = await loadStaticSite(folders.webDir);
      if (site === null) ctx.logger.info('static_site_absent');
    } catch (error) {
      ctx.logger.warn('static_site_failed', { code: errorCodeOf(error) });
      ctx.errors.push({
        source: 'server',
        code: 'STATIC_SITE_FAILED',
        where: 'boot',
        message: 'the web build could not be loaded; the API is served without the web UI',
      });
    }
    const task = await readLegacyTask(ctx.instanceDir);
    const app = createApp({
      ctx,
      port: () => port ?? ctx.config.effectivePort,
      // the ingest service is private to the runtime until it exposes `nudge()` (CR-WP-18-3): the spool poll reads the same segment
      nudge: () => undefined,
      task,
      runtime,
      site,
    });
    const http = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
    res.http = http;

    // 9. bind (the bind is the reservation)
    const bound = await bindFirstFreePort(http, ctx.config.effectivePort, ctx.config.runtime.server.portScan);
    if (!bound.ok) return await abort(fail(SERVER_EXIT_CODES.PORT_EXHAUSTED, bound.message));
    port = bound.port;
    http.on('error', (error: NodeJS.ErrnoException) => {
      ctx.logger.error('http_server_error', { code: error.code ?? 'ERROR' });
    });
    const earlyAfterBind = honourEarlyShutdown();
    if (earlyAfterBind !== null) return earlyAfterBind;

    // 10. the token, then state.json (only after the bind, so a reader never sees a port that is not ours)
    await ensureWorkspaceDir(ws, 'run');
    const tokenBytes = new TextEncoder().encode(`${token}\n`);
    await writeTokenFile(path.join(ctx.instanceDir, 'run', 'control.token'), tokenBytes);
    res.token = tokenBytes;
    res.state = buildStateFile({
      pid: process.pid,
      port: bound.port,
      startedAtMs,
      runtimeVersion: stamp.runtimeVersion,
      codeStamp: stamp.codeStamp,
      slug: ctx.slug,
      instanceId: ctx.instanceId,
      nodeVersion: process.version,
      control: address,
    });
    if (existing.kind === 'conflict') {
      // a live legacy viewer owns the file (started with `$V serve`, bypassing the checks): leave it, say so, keep serving
      ctx.logger.warn('ownership_conflict', { pid: existing.pid });
    } else {
      await writeStateFile(path.join(ctx.instanceDir, STATE_FILE_NAME), res.state);
      res.stateWritten = true;
    }

    // 11. ingestion, sweeper, timers, the state watchdog, the route file
    await runtime.start();
    ready = true;
    ctx.logger.info('runtime_ready', { port: bound.port, pid: process.pid });
    bootDone = true;
    if (gate.reason !== null) shutdown(gate.reason);
    return { ok: true, server };
  } catch (error) {
    return abort(failFrom(error));
  }
}

// ---- the process ------------------------------------------------------------------------------------------------------------------

export interface ServeMainInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtimeDir: string;
  readonly stderr?: (text: string) => void;
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;

/**
 * The server process: signals and fatal errors around `bootServer`. Resolves with the exit code (0 after a graceful or a
 * late shutdown, the code of 01 4.1 when the boot failed); `main.ts` passes it to `process.exit`.
 */
export async function serveMain(input: ServeMainInput): Promise<number> {
  const stderr = input.stderr ?? writeStderr;
  const gate = createShutdownGate();
  let running: RunningServer | null = null;
  const onSignal = (): void => {
    gate.request('signal');
  };
  const onFatal = (error: unknown): void => {
    if (running === null) {
      // during the boot: nothing is worth saving but the message (the OS frees the pipe, the database is WAL-safe)
      stderr(
        `mcs-server: INTERNAL (70): ${error instanceof Error ? (error.stack ?? error.message) : 'a value was thrown'}\n`,
      );
      process.exit(SERVER_EXIT_CODES.INTERNAL);
    }
    // after the boot a failure of one task must not end the monitoring: record it by code and keep serving
    running.ctx.logger.error('uncaught_error', { code: errorCodeOf(error) });
    running.ctx.errors.push({
      source: 'server',
      code: 'INTERNAL',
      where: 'process',
      message: 'an uncaught error was recorded',
    });
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  try {
    const result = await bootServer({ ...input, stderr, gate });
    if (!result.ok) return result.exitCode;
    running = result.server;
    return (await result.server.closed).exitCode;
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  }
}
