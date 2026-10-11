// The instance context (01 4.4a, slice S8; registry 2.2): the one object every server-side service receives. The server main
// builds it once per process; the parity harness (06 5.4), the in-process integration tests and the benchmark scripts build
// it with the same function and no HTTP. `buildInstanceContext` reads the identity files, resolves the configuration, opens
// the database and calls `createQueries` with the six deps of registry C09; its failures are `McsError`s whose codes are
// the boot exit names of 01 4.1 (10 CONFIG_INVALID, 11 IDENTITY_MISMATCH, 14 DB_ERROR, 15 DB_NEWER_THAN_RUNTIME,
// 16 DB_UPGRADE_REQUIRED, 17 WORKSPACE_INVALID).
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  McsError,
  systemClock,
  type ChildKind,
  type ChildKindStats,
  type CliErrorCode,
  type Clock,
  type HealthReport,
  type HookProbeResult,
  type IngestHealth,
  type InstanceFile,
  type InstanceInfo,
  type PanelStats,
  type SessionDetail,
} from '@mcs/shared';
import { resolveMcsHome, type ControlPhase } from '@mcs/shared/protocol';
import { z } from 'zod';

import { entriesBetween, type AuditRef } from '../audit/reader.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { isDbError, type DbError } from '../db/errors.ts';
import { DB_OPEN_EXIT_CODES, openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { createLogger, type Logger, type LogLevel } from '../log/logger.ts';
import { childStats, execFileText, resolveExecutable } from '../platform/exec.ts';
import { readInstanceFile, readTaskFile } from '../workspace/adopt.ts';
import { resolveWorkspace, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { createErrorRing, type ErrorRing } from './error-ring.ts';

/** The process helpers of 06 3.6 behind one object, so that tests inject fakes (01 4.4a `ExecApi`). */
export interface ExecApi {
  readonly execFileText: typeof execFileText;
  readonly resolveExecutable: typeof resolveExecutable;
  readonly childStats: typeof childStats;
}

/** What the health report and the control channel need to know about this process (01 4.4a, 4.6, 4.13, 5.3). */
export interface RuntimeProcessInfo {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly runtimeVersion: string;
  readonly bootCodeStamp: string;
  /** True when the previous run of this instance ended without a clean shutdown (01 4.13). */
  readonly previousRunUnclean: boolean;
  /** The phase of the control channel (01 4.3). */
  phase(): ControlPhase;
  /** The build stamp on disk against the one this process booted with; the disk is re-read at most every 10 s (01 5.3). */
  outdated(): { outdated: boolean; reason: 'code_stamp_changed' | 'runtime_version_changed' | null };
  /** True while `state.json` names another live process (the watchdog flag of 01 4.6). */
  ownershipConflict(): boolean;
}

export interface InstanceContext {
  readonly instanceId: string;
  readonly slug: string;
  /** `realpath` of the workspace: the one name every design uses for it (registry C07; there is no `workspaceDir`). */
  readonly instanceDir: string;
  /** `config.monitor.repo`: absolute (01 2.3 step 3). */
  readonly repoDir: string;
  /** `CLAUDE_CONFIG_DIR` (absolute) or `<home>/.claude` (01 2.10). */
  readonly claudeHome: string;
  /** `resolveMcsHome(env)` (02 2.6.1). */
  readonly mcsHome: string;
  readonly skillDir: string;
  readonly runtimeDir: string;
  /** Immutable for the process lifetime (`configure` reports `restart_needed`). */
  readonly config: ResolvedConfig;
  /** `instance.json` as read at boot. */
  readonly instance: InstanceFile;
  readonly hooksEnabled: boolean;
  readonly clock: Clock;
  readonly db: InstanceDb;
  /** `{ instanceId }`: passed first to every repository and query call. */
  readonly scope: RepoContext;
  readonly queries: EngineQueries & TranscriptQueries;
  readonly errors: ErrorRing;
  readonly exec: ExecApi;
  readonly logger: Logger;
  readonly process: RuntimeProcessInfo;
}

export interface BuildContextInput {
  /** The workspace folder, absolute (`--instance-dir`). */
  readonly instanceDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cli: { readonly port?: number; readonly logLevel?: LogLevel };
  readonly skillDir: string;
  readonly runtimeDir: string;
  /** What `runtime/.mcs-build.json` said at boot (01 4.4 step 6). */
  readonly build: { readonly runtimeVersion: string; readonly codeStamp: string };
  readonly clock?: Clock;
  readonly exec?: ExecApi;
  /** Default: `<workspace>/logs/runtime.log` at the configured level, which this function then owns. */
  readonly logger?: Logger;
  readonly claudeHome?: string;
  readonly mcsHome?: string;
  /** The only mode there is: read-only CLI access uses the DbReader (01 6.1), never a context. */
  readonly dbMode?: 'serve';
  /** Tests: fixed values. The server: live getters. */
  readonly processInfo?: Partial<RuntimeProcessInfo>;
}

// ---- late bindings -------------------------------------------------------------------------------------------------------

/** Things that exist only after the context: the panel service and the state watchdog (both made by `createInstanceRuntime`). */
interface LateBindings {
  panelStats: (() => PanelStats) | null;
  ownershipConflict: (() => boolean) | null;
}

/** Keyed by the context object; a context assembled by hand has no entry and so nothing to bind. */
const lateBindings = new WeakMap<object, LateBindings>();

/**
 * Late binding of the panel statistics (the panel service is created after the context): `QueryDeps.panelStats` answers `{}`
 * until this is called, once, by `createInstanceRuntime`. A context that `buildInstanceContext` did not make is ignored.
 */
export function bindPanelStats(ctx: InstanceContext, get: () => PanelStats): void {
  const late = lateBindings.get(ctx);
  if (late === undefined) return;
  if (late.panelStats !== null) throw new Error('bindPanelStats: the panel statistics are already bound');
  late.panelStats = get;
}

/**
 * Late binding of the ownership flag of 01 4.6 (the state watchdog is created after the context): `ctx.process.ownershipConflict()`
 * answers false until this is called, once, by `createInstanceRuntime`. A context that `buildInstanceContext` did not make
 * is ignored.
 */
export function bindOwnershipConflict(ctx: InstanceContext, get: () => boolean): void {
  const late = lateBindings.get(ctx);
  if (late === undefined) return;
  if (late.ownershipConflict !== null) throw new Error('bindOwnershipConflict: the ownership flag is already bound');
  late.ownershipConflict = get;
}

/** What `QueryDeps.panelStats` answers for this context right now. */
export function panelStatsOf(ctx: InstanceContext): PanelStats {
  return lateBindings.get(ctx)?.panelStats?.() ?? {};
}

// ---- process info --------------------------------------------------------------------------------------------------------

/** The disk stamp is looked at most this often (01 5.3). */
const OUTDATED_REREAD_MS = 10_000;

const BuildStampFileSchema = z.object({ runtimeVersion: z.string(), codeStamp: z.string() });

function readBuildStamp(file: string): { runtimeVersion: string; codeStamp: string } | null {
  try {
    const parsed = BuildStampFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type OutdatedAnswer = ReturnType<RuntimeProcessInfo['outdated']>;

function createProcessInfo(i: BuildContextInput, clock: Clock, late: LateBindings): RuntimeProcessInfo {
  const over = i.processInfo ?? {};
  const stampFile = path.join(i.runtimeDir, '.mcs-build.json');
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let answer: OutdatedAnswer = { outdated: false, reason: null };
  // A missing or unreadable stamp (a rebuild in progress) keeps the last answer: it says nothing about this process.
  const outdated = (): OutdatedAnswer => {
    const now = clock.now();
    if (now - lastReadAt >= OUTDATED_REREAD_MS) {
      lastReadAt = now;
      const disk = readBuildStamp(stampFile);
      if (disk !== null) {
        answer =
          disk.codeStamp === i.build.codeStamp
            ? { outdated: false, reason: null }
            : {
                outdated: true,
                reason:
                  disk.runtimeVersion === i.build.runtimeVersion ? 'code_stamp_changed' : 'runtime_version_changed',
              };
      }
    }
    return { ...answer };
  };
  return {
    pid: over.pid ?? process.pid,
    startedAtMs: over.startedAtMs ?? clock.now(),
    runtimeVersion: over.runtimeVersion ?? i.build.runtimeVersion,
    bootCodeStamp: over.bootCodeStamp ?? i.build.codeStamp,
    previousRunUnclean: over.previousRunUnclean ?? false,
    phase: over.phase ?? ((): ControlPhase => 'starting'),
    outdated: over.outdated ?? outdated,
    ownershipConflict: over.ownershipConflict ?? ((): boolean => late.ownershipConflict?.() ?? false),
  };
}

// ---- failures -----------------------------------------------------------------------------------------------------------

const EXIT_NAME = {
  11: 'IDENTITY_MISMATCH',
  14: 'DB_ERROR',
  15: 'DB_NEWER_THAN_RUNTIME',
  16: 'DB_UPGRADE_REQUIRED',
} as const satisfies Record<11 | 14 | 15 | 16, CliErrorCode>;

/** The boot error of a failed database open: the code of its exit code in `DB_OPEN_EXIT_CODES` (03 3.2, 4.5). */
export function mapDbOpenError(error: DbError): McsError {
  return new McsError(EXIT_NAME[DB_OPEN_EXIT_CODES[error.code]], error.message, {
    cause: error,
    details: { reason: error.code },
  });
}

/** Codes that 01 4.1 files under exit 17 (bad argv, files, links) and exit 10 (config or regex). */
const WORKSPACE_CODES: ReadonlySet<string> = new Set([
  'SLUG_INVALID',
  'WORKSPACE_ESCAPE',
  'WORKSPACE_SYMLINK',
  'TASK_NOT_FOUND',
]);
const CONFIG_CODES: ReadonlySet<string> = new Set([
  'CONFIG_SCHEMA_MISSING',
  'CONFIG_SCHEMA_UNSUPPORTED',
  'CONFIG_UNREADABLE',
  'REGEX_UNSUPPORTED',
]);

function renamed(error: McsError, code: CliErrorCode): McsError {
  return new McsError(code, error.message, {
    cause: error,
    details: { reason: error.code },
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  });
}

function workspaceOf(instanceDir: string): WorkspaceRef {
  const dir = path.resolve(instanceDir);
  try {
    return resolveWorkspace(path.dirname(dir), path.basename(dir));
  } catch (error) {
    if (error instanceof McsError && WORKSPACE_CODES.has(error.code)) throw renamed(error, 'WORKSPACE_INVALID');
    throw error;
  }
}

/** `instance.json` (it must exist and belong to the folder) and `task.json` (it must name the folder). */
async function readIdentity(ws: WorkspaceRef): Promise<InstanceFile> {
  try {
    const instance = await readInstanceFile(ws);
    if (instance === null) {
      throw new McsError('WORKSPACE_INVALID', `${ws.dir} has no instance.json`, { hint: `mcs init --task ${ws.slug}` });
    }
    await readTaskFile(ws);
    return instance;
  } catch (error) {
    if (error instanceof McsError && WORKSPACE_CODES.has(error.code)) throw renamed(error, 'WORKSPACE_INVALID');
    throw error;
  }
}

async function configOf(i: BuildContextInput, ws: WorkspaceRef): Promise<ResolvedConfig> {
  try {
    return await resolveConfig({ workspace: ws, env: i.env, cli: i.cli, skillDir: i.skillDir });
  } catch (error) {
    if (error instanceof McsError && CONFIG_CODES.has(error.code)) throw renamed(error, 'CONFIG_INVALID');
    throw error;
  }
}

// ---- homes --------------------------------------------------------------------------------------------------------------

function claudeHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.claude');
}

function mcsHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  try {
    return resolveMcsHome(env);
  } catch (error) {
    throw new McsError('CONFIG_INVALID', error instanceof Error ? error.message : 'no MCS home folder', {
      cause: error,
    });
  }
}

// ---- the context --------------------------------------------------------------------------------------------------------

const DEFAULT_EXEC: ExecApi = { execFileText, resolveExecutable, childStats };

interface QueryDepsParts {
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly ws: WorkspaceRef;
  readonly logger: Logger;
  readonly process: RuntimeProcessInfo;
  readonly exec: ExecApi;
  readonly panelStats: () => PanelStats;
}

/** The six deps of 03 12.1 `QueryDeps` for the server (registry C09); the DbReader passes `config`, `now` and `audit` only. */
function queryDepsOf(p: QueryDepsParts): QueryDeps {
  return {
    config: p.config,
    now: () => p.clock.now(),
    audit: { entriesBetween: (fromMs, toMs, limit) => entriesBetween(p.ws, fromMs, toMs, limit, { log: p.logger }) },
    process: p.process,
    childStats: p.exec.childStats,
    panelStats: p.panelStats,
  };
}

/** The factories `buildInstanceContext` calls; a test seam in the style of `createLoggerWith`. */
export interface ContextDeps {
  readonly createQueries: (db: InstanceDb, deps: QueryDeps) => EngineQueries & TranscriptQueries & AuditQueries;
}

export function buildInstanceContext(i: BuildContextInput): Promise<InstanceContext> {
  return buildInstanceContextWith(i, { createQueries: contextFactories.createQueries });
}

export async function buildInstanceContextWith(i: BuildContextInput, deps: ContextDeps): Promise<InstanceContext> {
  const clock = i.clock ?? systemClock;
  const ws = workspaceOf(i.instanceDir);
  const instance = await readIdentity(ws);
  const config = await configOf(i, ws);
  const mcsHome = i.mcsHome ?? mcsHomeOf(i.env);
  const claudeHome = i.claudeHome ?? claudeHomeOf(i.env);

  const ownLogger = i.logger === undefined;
  const logger =
    i.logger ??
    createLogger({
      file: workspacePath(ws, 'logs', 'runtime.log'),
      level: config.runtime.logLevel,
      rotate: true,
      clock,
    });
  const release = async (db: InstanceDb | null): Promise<void> => {
    db?.close();
    if (ownLogger) await logger.close();
  };

  let db: InstanceDb;
  try {
    db = openInstanceDb({
      path: workspacePath(ws, 'data', 'monitor.db'),
      expectedInstanceId: instance.instanceId,
      mode: i.dbMode ?? 'serve',
      runtimeVersion: i.build.runtimeVersion,
      clock,
    });
  } catch (error) {
    await release(null);
    throw isDbError(error) ? mapDbOpenError(error) : error;
  }

  try {
    const exec = i.exec ?? DEFAULT_EXEC;
    const late: LateBindings = { panelStats: null, ownershipConflict: null };
    const processInfo = createProcessInfo(i, clock, late);
    const queries = deps.createQueries(
      db,
      queryDepsOf({
        config,
        clock,
        ws,
        logger,
        process: processInfo,
        exec,
        panelStats: () => late.panelStats?.() ?? {},
      }),
    );
    const ctx: InstanceContext = Object.freeze({
      instanceId: instance.instanceId,
      slug: ws.slug,
      instanceDir: ws.realDir,
      repoDir: config.monitor.repo,
      claudeHome,
      mcsHome,
      skillDir: i.skillDir,
      runtimeDir: i.runtimeDir,
      config,
      instance,
      hooksEnabled: instance.hooks.enabled,
      clock,
      db,
      scope: Object.freeze({ instanceId: instance.instanceId }),
      queries,
      errors: createErrorRing(clock),
      exec,
      logger,
      process: processInfo,
    });
    lateBindings.set(ctx, late);
    return ctx;
  } catch (error) {
    await release(db);
    throw error;
  }
}

// ---- the query layer of design 03, and a stub of it ----------------------------------------------------------------------------
// `packages/engine/src/query/index.ts` (WP-17) does not exist yet. Until it does, `contextFactories.createQueries` is a stub
// with the signature of 03 12.1 that throws when called; the block of WP-17 at the end of this file registers the real one: an
// import, then `contextFactories.createQueries = createQueries;`. The assignment is checked against the signature below. The
// interfaces here are the part of 03 12.1 that WP-17 seeds (`instanceInfo`, `health`, `ingestHealth`, `hookProbe`); WP-17 widens
// them with `export interface EngineQueries extends <the real interface> {}` in its block (an interface of the same name
// merges), and the same for `TranscriptQueries`.

/** `entriesBetween` bound to the workspace of the instance (01 7.1, I-19). */
export interface AuditReader {
  entriesBetween(fromMs: number, toMs: number, limit: number): Promise<AuditRef[]>;
}

/** 03 12.1: the server passes all six; the CLI DbReader passes `config`, `now` and `audit`. */
export interface QueryDeps {
  readonly config: ResolvedConfig;
  readonly now: () => number;
  readonly audit: AuditReader;
  readonly process?: RuntimeProcessInfo;
  readonly childStats?: () => Record<ChildKind, ChildKindStats>;
  readonly panelStats?: () => PanelStats;
}

export interface EngineQueries {
  instanceInfo(ctx: RepoContext): InstanceInfo;
  health(ctx: RepoContext): HealthReport;
  ingestHealth(ctx: RepoContext): IngestHealth & { asOfSeq: number };
  hookProbe(ctx: RepoContext, probeSessionId: string): HookProbeResult | null;
}

export type TranscriptQueries = object;

export interface AuditQueries {
  sessionAuditRefs(detail: Pick<SessionDetail, 'startedAt' | 'endedAt' | 'lastActivityAt'>): Promise<AuditRef[]>;
}

const notBuilt = (): never => {
  throw new McsError('INTERNAL', 'the query layer is not built yet (WP-17)');
};

/** What `buildInstanceContext` calls to make `ctx.queries`: the stub until WP-17 registers `createQueries`. */
export const contextFactories: {
  createQueries: (db: InstanceDb, deps: QueryDeps) => EngineQueries & TranscriptQueries & AuditQueries;
} = {
  // `notBuilt` returns `never`, so it has the signature without a stand-in object for the members that later blocks merge in.
  createQueries: notBuilt,
};

// The block of WP-17, the owner of the real `createQueries` (see above). It is empty until that work package lands.
// @wp-begin WP-17
import { createQueries, type EngineQueries as QueryLayerEngineQueries } from '../query/index.ts';

// The seed `EngineQueries` above is widened with the real interface of `query/index.ts`: an interface of the same name
// merges, so every member that a later work package adds there is a member of `ctx.queries` without a change here. The
// asynchronous `AuditQueries.sessionAuditRefs` is part of it, because the route handler of `getSession` awaits it on `ctx.queries` (03 6.3).
export interface EngineQueries extends QueryLayerEngineQueries, AuditQueries {}

// The real query layer replaces the stub of `contextFactories` (registry C09: the six deps are passed by `queryDepsOf`).
contextFactories.createQueries = createQueries;
// @wp-end WP-17
