// `ops.instanceUpgrade` (01 5.4, ADR 0009, ADR 0021): `upgrade`, `db migrate` and `db rebuild` of an existing Node-era instance.
// All three are dry runs unless `--yes` is given, hold the task mutex for the whole read, plan, backup, change, audit sequence,
// refuse a workspace with a live monitor (a monitor that this runtime did not start is never stopped) and refuse downgrades.
//
// The order of `upgrade` is fixed: plan, stop (only with `--restart`), backup (`data/backups/<id>-upgrade`), database
// migrations, integrity check, `instance.json`, audit. A migration that fails restores the database from the backup, writes no
// `upgrade` entry and reports `DB_ERROR` with the backup id. `config.json`, `task.json`, `README.md` and the bytes of the audit
// trail are never written (INV-09); a workspace without `instance.json` is refused: converting a pre-4.0 workspace is
// `mcs migrate-workspace` (ADR 0068).
import { existsSync } from 'node:fs';

import {
  McsError,
  RUNTIME_VERSION,
  isoSecondsZ,
  type DbMigrateResult,
  type DbPlan,
  type DbRebuildResult,
  type InstanceFile,
  type UpgradePlan,
  type UpgradeResult,
} from '@mcs/shared';

import { appendChange } from '../audit/writer.ts';
import { BUSY_TIMEOUT_MS, openSqlite, pragmaValue } from '../db/driver.ts';
import { migrateDb as migrateDatabase, planDbMigrations } from '../db/migrations.ts';
import { backupStamp } from '../migrate/backup.ts';
import { writeInstanceFile } from '../workspace/adopt.ts';
import { assertNotLink } from '../workspace/fsio.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import {
  assertNotLive,
  databaseFiles,
  dbFailure,
  folderName,
  humanBytes,
  liveError,
  make,
  migrationsOf,
  moveDatabase,
  probeOf,
  pruneAfter,
  requireInstance,
  restoreDatabaseFiles,
  type BackupOpDeps,
  type MadeBackup,
} from './backup.ts';
import { start, stop } from './lifecycle.ts';
import { isLiveState } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

// ---- versions ------------------------------------------------------------------------------------------------------------------------

const SEMVER_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/;

function identifiersOf(prerelease: string): (string | number)[] {
  return prerelease.split('.').map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part));
}

/**
 * Negative when `a` is the older version, positive when it is the newer, 0 when they are equal (semver precedence: the three
 * numbers, then a release is newer than its pre-release, then the pre-release identifiers one by one). A text that is not a
 * version compares by code unit order, so the answer is stable rather than an exception.
 */
export function compareSemver(a: string, b: string): number {
  const x = SEMVER_RE.exec(a);
  const y = SEMVER_RE.exec(b);
  if (x === null || y === null) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const ia = identifiersOf(pa);
  const ib = identifiersOf(pb);
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    const l = ia[i];
    const r = ib[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    if (typeof l === 'number') return -1;
    if (typeof r === 'number') return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// ---- shared parts ------------------------------------------------------------------------------------------------------------------------

/** The steps of an applied `upgrade` or `db migrate` before which `UpgradeDeps.beforeStep` runs (tests inject faults there). */
export type UpgradeStep = 'backup' | 'migrate' | 'integrity' | 'instance' | 'audit';

export interface UpgradeDeps extends BackupOpDeps {
  /** `stop` and `start` for `--restart` (default: the real ones). */
  readonly lifecycle?: { readonly stop: typeof stop; readonly start: typeof start };
  /** Runs before each step of an applied run; what it throws is the failure of that step. */
  readonly beforeStep?: (step: UpgradeStep) => void | Promise<void>;
}

/** The plan of the database: `null` when there is no database or one that was never migrated (the first start creates it). */
function planDatabase(ctx: OpContext, ws: WorkspaceRef, deps: UpgradeDeps): DbPlan | null {
  const file = workspacePath(ws, 'data', 'monitor.db');
  assertNotLink(file);
  if (!existsSync(file)) return null;
  try {
    const plan = planDbMigrations(file, migrationsOf(ctx, deps));
    return plan.from === 0 ? null : plan;
  } catch (error) {
    throw dbFailure(error);
  }
}

/** `PRAGMA quick_check` of the database read-only: the migrated file must be whole. */
function assertIntegrity(file: string): void {
  const db = openSqlite(file, { readonly: true, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
  try {
    if (pragmaValue(db, 'quick_check') !== 'ok') {
      throw new McsError('DB_ERROR', 'the migrated database does not pass PRAGMA quick_check');
    }
  } finally {
    db.close();
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected failure';
}

/**
 * A migration (or its integrity check) failed: the database is put back from the backup made first, so the instance is as
 * it was before the command. The error names the backup; when even the restore fails, it says how to do it by hand.
 */
async function rollBack(
  ws: WorkspaceRef,
  made: MadeBackup,
  cause: unknown,
  deps: Pick<BackupOpDeps, 'rename'>,
): Promise<never> {
  const hint = `mcs backup restore --task ${ws.slug} --id ${made.id} --yes`;
  try {
    await restoreDatabaseFiles(ws, made.dir, made.manifest, deps);
  } catch (restoreError) {
    throw new McsError(
      'DB_ERROR',
      `the database migration failed (${describeFailure(cause)}) and restoring the database from backup ${made.id} failed too (${describeFailure(restoreError)})`,
      { hint, details: { backup: made.id }, cause },
    );
  }
  throw new McsError(
    'DB_ERROR',
    `the database migration failed (${describeFailure(cause)}); the database was restored from backup ${made.id}`,
    {
      hint: `fix the cause and run the command again; the backup is data/backups/${made.id}/`,
      details: { backup: made.id },
      cause,
    },
  );
}

/**
 * Backup, migrations, integrity check (01 5.4 steps 6-7) for a database with pending steps. Returns the backup. Anything
 * that fails after the backup restores the database from it.
 */
async function migrateWithBackup(
  ctx: OpContext,
  ws: WorkspaceRef,
  instance: InstanceFile,
  deps: UpgradeDeps,
): Promise<MadeBackup> {
  const step = async (name: UpgradeStep): Promise<void> => {
    await deps.beforeStep?.(name);
  };
  await step('backup');
  const made = await make(ctx, ws, instance, { reason: 'upgrade' }, deps);
  const file = workspacePath(ws, 'data', 'monitor.db');
  // the instance could have been started since the plan: the backup stays, the database is not touched
  await assertNotLive(ctx, ws, deps);
  try {
    await step('migrate');
    migrateDatabase(file, {
      backupDone: true,
      runtimeVersion: RUNTIME_VERSION,
      expectedInstanceId: instance.instanceId,
      now: () => ctx.clock.now(),
      ...migrationsOf(ctx, deps),
    });
    await step('integrity');
    assertIntegrity(file);
  } catch (error) {
    return rollBack(ws, made, dbFailure(error), deps);
  }
  return made;
}

function dbText(db: DbPlan | null): string {
  return db === null ? 'none' : String(db.to);
}

function stepsText(db: DbPlan): string {
  return db.steps.map((s) => `${String(s.version).padStart(4, '0')} ${s.name}`).join(', ');
}

const mutexOptions = (deps: Pick<BackupOpDeps, 'mutexTimeoutMs'>): { timeoutMs?: number } =>
  deps.mutexTimeoutMs === undefined ? {} : { timeoutMs: deps.mutexTimeoutMs };

// ---- upgrade -------------------------------------------------------------------------------------------------------------------------

export interface UpgradeInput {
  readonly task: string;
  /** `--yes`: apply. Without it (or with `--dry-run`) the plan is printed and nothing is changed. */
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  /** `--restart`: stop the running server before the backup and start it again at the end. */
  readonly restart?: boolean;
  /**
   * `--force` (user instance, 06 3): the stop of `--restart` ends live terminals instead of refusing with `TERMINALS_LIVE`.
   * Without `--restart` it changes nothing: a live monitor is still refused.
   */
  readonly force?: boolean;
}

interface Applied {
  readonly result: UpgradeResult;
  /** The upgrade is done and `--restart` asked for a start. */
  readonly startAfter: boolean;
}

function buildPlan(ctx: OpContext, ws: WorkspaceRef, instance: InstanceFile, deps: UpgradeDeps): UpgradePlan {
  const db = planDatabase(ctx, ws, deps);
  const needed = compareSemver(instance.runtimeVersion, RUNTIME_VERSION) < 0 || (db?.steps.length ?? 0) > 0;
  return {
    runtimeFrom: instance.runtimeVersion,
    runtimeTo: RUNTIME_VERSION,
    db,
    files: [],
    needed,
    backup: needed ? folderName(`${backupStamp(ctx.clock.now())}-upgrade`) : null,
  };
}

/** The refusal of a runtime older than the one that last upgraded the instance (01 5.7). */
function assertNotDowngrade(instance: InstanceFile): void {
  if (compareSemver(instance.runtimeVersion, RUNTIME_VERSION) > 0) {
    throw new McsError(
      'DOWNGRADE_REFUSED',
      `this instance was upgraded by runtime ${instance.runtimeVersion}, newer than this runtime (${RUNTIME_VERSION}); nothing was changed`,
      { hint: 'run the command with the newer runtime, or restore a backup made before that upgrade' },
    );
  }
}

/** Stops the server for `--restart`: ours is stopped, one of another runtime is refused, anything else is just left. */
async function stopForRestart(
  ctx: OpContext,
  ws: WorkspaceRef,
  deps: UpgradeDeps,
  restart: boolean,
  force: boolean,
): Promise<boolean> {
  const probe = await probeOf(ctx, ws, deps);
  if (!isLiveState(probe.state)) return false;
  if (!restart || probe.state === 'unmanaged-running') throw liveError(ws, probe, probe.state !== 'unmanaged-running');
  // a user instance refuses while terminals are live unless forced; that refusal ends the upgrade before anything is written
  const stopped = await (deps.lifecycle?.stop ?? stop)(ctx, {
    task: ws.slug,
    purpose: 'upgrade',
    ...(force ? { force: true } : {}),
  });
  if (stopped.exitCode !== 0) {
    throw new McsError('STOP_FAILED', `the server could not be stopped: ${stopped.message.join(' ')}`, {
      hint: `mcs stop --task ${ws.slug}`,
    });
  }
  await assertNotLive(ctx, ws, deps);
  return true;
}

/** The error of a step that failed after `--restart` stopped the server: the message says the server is down. */
function withStoppedNote(error: unknown, ws: WorkspaceRef): unknown {
  if (!(error instanceof McsError)) return error;
  return new McsError(
    error.code,
    `${error.message}; the server was stopped for the upgrade (\`mcs start --task ${ws.slug}\` starts it again)`,
    {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
      cause: error,
    },
  );
}

async function applyUpgrade(
  ctx: OpContext,
  ws: WorkspaceRef,
  instance: InstanceFile,
  plan: UpgradePlan,
  input: UpgradeInput,
  deps: UpgradeDeps,
): Promise<Applied> {
  const restart = input.restart === true;
  const stopped = await stopForRestart(ctx, ws, deps, restart, input.force === true);
  const migrated = (plan.db?.steps.length ?? 0) > 0;
  try {
    let backup: MadeBackup;
    if (migrated) {
      backup = await migrateWithBackup(ctx, ws, instance, deps);
    } else {
      await deps.beforeStep?.('backup');
      backup = await make(ctx, ws, instance, { reason: 'upgrade' }, deps);
    }
    await deps.beforeStep?.('instance');
    await writeInstanceFile(ws, {
      ...instance,
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: plan.db === null ? instance.dbSchemaVersion : plan.db.to,
      upgradedAt: isoSecondsZ(ctx.clock.now()),
    });
    await deps.beforeStep?.('audit');
    await appendChange(
      ws,
      {
        action: 'upgrade',
        summary: `runtime ${plan.runtimeFrom} -> ${plan.runtimeTo}; db schema ${plan.db === null ? 'none' : `${String(plan.db.from)} -> ${String(plan.db.to)}`}; files: none`,
        reason: null,
        files: migrated ? ['instance.json', 'data/monitor.db'] : ['instance.json'],
        validation: migrated ? 'migrations applied; integrity ok' : 'no migrations pending',
        outcome: `upgraded; backup ${backup.id}`,
      },
      ctx.clock.now(),
    );
    const pruned = await pruneAfter(ctx, ws, [backup.id]);
    return {
      startAfter: restart,
      result: {
        task: ws.slug,
        outcome: 'upgraded',
        plan,
        backup: backup.id,
        integrity: migrated ? 'ok' : null,
        restart: restart ? { stopped, started: false, url: null, pid: null } : null,
        pruned,
        exitCode: 0,
      },
    };
  } catch (error) {
    throw stopped ? withStoppedNote(error, ws) : error;
  }
}

/**
 * `ops.instanceUpgrade.run` (`mcs upgrade`, 01 5.4): brings the instance to this runtime. A dry run (no `--yes`, or
 * `--dry-run`) prints the plan; with `--yes` it makes the `upgrade` backup first, migrates the database, records the runtime
 * version in `instance.json` and audits. `--restart` also stops a running server first and starts it at the end (a failed
 * start is `exitCode: 1` with the upgrade already done).
 */
export async function run(ctx: OpContext, input: UpgradeInput, deps: UpgradeDeps = {}): Promise<UpgradeResult> {
  const ws = await openWorkspace(ctx, input.task);
  const apply = input.yes === true && input.dryRun !== true;
  const done = await withTaskMutex(
    ws,
    async (): Promise<Applied> => {
      const instance = await requireInstance(ws);
      assertNotDowngrade(instance);
      const plan = buildPlan(ctx, ws, instance, deps);
      const base: Omit<UpgradeResult, 'outcome'> = {
        task: ws.slug,
        plan,
        backup: null,
        integrity: null,
        restart: null,
        pruned: [],
        exitCode: 0,
      };
      if (!plan.needed) return { startAfter: false, result: { ...base, outcome: 'current' } };
      if (!apply) {
        const restart = input.restart === true ? { stopped: false, started: false, url: null, pid: null } : null;
        return { startAfter: false, result: { ...base, outcome: 'dry-run', restart } };
      }
      return applyUpgrade(ctx, ws, instance, plan, input, deps);
    },
    mutexOptions(deps),
  );
  if (!done.startAfter) return done.result;
  // the mutex is released: a start takes seconds, and other commands of the task must not wait for it
  try {
    const started = await (deps.lifecycle?.start ?? start)(ctx, { task: ws.slug });
    return {
      ...done.result,
      restart: {
        stopped: done.result.restart?.stopped ?? false,
        started: started.exitCode === 0,
        url: started.url,
        pid: started.pid,
      },
      exitCode: started.exitCode,
    };
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    ctx.log.warn('upgrade_restart_failed', { code: error.code });
    throw new McsError(
      error.code,
      `the upgrade is done (backup ${done.result.backup ?? '-'}), but the server did not start: ${error.message}`,
      {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        details: { upgraded: true, backup: done.result.backup },
        cause: error,
      },
    );
  }
}

/** What `--restart` did, one line per step. */
function restartLines(result: UpgradeResult): string[] {
  const { restart } = result;
  if (restart === null) return [];
  return [
    ...(restart.stopped ? ['stopped the running server first'] : []),
    restart.started
      ? `started: ${restart.url ?? '?'} (pid ${restart.pid === null ? '?' : String(restart.pid)})`
      : 'the server was not started',
  ];
}

/** The text of `upgrade`. */
export function runLines(result: UpgradeResult): string[] {
  const { plan } = result;
  if (result.outcome === 'current') {
    return [`already current: runtime ${plan.runtimeTo}, db schema ${dbText(plan.db)}`];
  }
  const dbLine =
    plan.db === null
      ? 'database: none yet (the first start creates it at the current schema)'
      : plan.db.steps.length === 0
        ? `database: schema ${String(plan.db.from)}, nothing to migrate`
        : `database: schema ${String(plan.db.from)} -> ${String(plan.db.to)} (${stepsText(plan.db)})`;
  if (result.outcome === 'dry-run') {
    return [
      `task '${result.task}': upgrade plan (dry run, nothing written)`,
      `  runtime: ${plan.runtimeFrom} -> ${plan.runtimeTo}`,
      `  ${dbLine}`,
      '  files: none',
      `  backup first: ${plan.backup ?? '-'}`,
      ...(result.restart === null
        ? []
        : ['  --restart: a running server is stopped first and started again at the end']),
    ];
  }
  return [
    `upgraded task '${result.task}': runtime ${plan.runtimeFrom} -> ${plan.runtimeTo}; ${dbLine}`,
    `backup: ${result.backup === null ? '-' : folderName(result.backup)}`,
    ...(result.integrity === null ? [] : ['integrity: ok']),
    ...(result.pruned.length > 0
      ? [`removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`]
      : []),
    ...restartLines(result),
  ];
}

// ---- db migrate ---------------------------------------------------------------------------------------------------------------------------

export interface DbMigrateInput {
  readonly task: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

/**
 * `ops.instanceUpgrade.migrateDb` (`mcs db migrate`, 01 5.4): the database half of `upgrade` (the deterministic "run the
 * migrations" command): plan, `upgrade` backup, migrations, integrity check, the `dbSchemaVersion` mirror in `instance.json`,
 * audit `db-migrate`. The runtime version of `instance.json` is not touched.
 */
export async function migrateDb(
  ctx: OpContext,
  input: DbMigrateInput,
  deps: UpgradeDeps = {},
): Promise<DbMigrateResult> {
  const ws = await openWorkspace(ctx, input.task);
  const apply = input.yes === true && input.dryRun !== true;
  return withTaskMutex(
    ws,
    async (): Promise<DbMigrateResult> => {
      const instance = await requireInstance(ws);
      const db = planDatabase(ctx, ws, deps);
      const base: Omit<DbMigrateResult, 'outcome'> = { task: ws.slug, db, backup: null, integrity: null, pruned: [] };
      if (db === null) return { ...base, outcome: 'no-database' };
      if (db.steps.length === 0) return { ...base, outcome: 'current' };
      if (!apply) return { ...base, outcome: 'dry-run' };
      await assertNotLive(ctx, ws, deps);
      const made = await migrateWithBackup(ctx, ws, instance, deps);
      await deps.beforeStep?.('instance');
      await writeInstanceFile(ws, { ...instance, dbSchemaVersion: db.to });
      await deps.beforeStep?.('audit');
      await appendChange(
        ws,
        {
          action: 'db-migrate',
          summary: `db schema ${String(db.from)} -> ${String(db.to)}`,
          reason: null,
          files: ['instance.json', 'data/monitor.db'],
          validation: 'migrations applied; integrity ok',
          outcome: `migrated; backup ${made.id}`,
        },
        ctx.clock.now(),
      );
      const pruned = await pruneAfter(ctx, ws, [made.id]);
      return { ...base, outcome: 'migrated', backup: made.id, integrity: 'ok', pruned };
    },
    mutexOptions(deps),
  );
}

/** The text of `db migrate`. */
export function migrateLines(result: DbMigrateResult): string[] {
  const { db } = result;
  switch (result.outcome) {
    case 'no-database':
      return [`task '${result.task}' has no database yet; the first start creates it at the current schema`];
    case 'current':
      return [`already current: db schema ${dbText(db)}`];
    case 'dry-run':
      return [
        `task '${result.task}': db migrate plan (dry run, nothing written)`,
        `  database: schema ${String(db?.from ?? 0)} -> ${String(db?.to ?? 0)} (${db === null ? '' : stepsText(db)})`,
        `  backup first: ${folderName('<UTC stamp>-upgrade')}`,
      ];
    case 'migrated':
      return [
        `migrated task '${result.task}': db schema ${String(db?.from ?? 0)} -> ${String(db?.to ?? 0)} (${db === null ? '' : stepsText(db)})`,
        `backup: ${result.backup === null ? '-' : folderName(result.backup)}`,
        'integrity: ok',
        ...(result.pruned.length > 0
          ? [`removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`]
          : []),
      ];
  }
}

// ---- db rebuild ---------------------------------------------------------------------------------------------------------------------------

export interface DbRebuildInput {
  readonly task: string;
  readonly yes?: boolean;
  /** `--confirm SLUG`: the typed slug of the task. */
  readonly confirm?: string;
}

/**
 * `ops.instanceUpgrade.rebuildDb` (`mcs db rebuild`, 01 5.4): for a corrupt or unwanted database. The instance must be
 * stopped. The database files are moved (no SQLite open) into a `db-rebuild` backup with `dbCopy: 'raw'`, `instance.json`
 * records `dbSchemaVersion` 0, and the next `start` creates a new database and imports again from the transcripts and the
 * spool segments that are still on disk. Without `--yes` it prints the plan; `--yes` without `--confirm <slug>` is refused.
 */
export async function rebuildDb(
  ctx: OpContext,
  input: DbRebuildInput,
  deps: UpgradeDeps = {},
): Promise<DbRebuildResult> {
  const ws = await openWorkspace(ctx, input.task);
  return withTaskMutex(
    ws,
    async (): Promise<DbRebuildResult> => {
      const instance = await requireInstance(ws);
      const apply = input.yes === true;
      if (apply && input.confirm !== ws.slug) {
        throw new McsError(
          'CONFIRMATION_REQUIRED',
          `db rebuild moves the database away: type the task name with --confirm ${ws.slug}; nothing was changed`,
          { hint: `mcs db rebuild --task ${ws.slug} --yes --confirm ${ws.slug}` },
        );
      }
      if (apply) await assertNotLive(ctx, ws, deps);
      const files = await databaseFiles(ws);
      const base: Omit<DbRebuildResult, 'applied'> = { task: ws.slug, files, backup: null, pruned: [] };
      if (!apply || files.length === 0) return { ...base, applied: false };
      await deps.beforeStep?.('backup');
      const made = await moveDatabase(ctx, ws, instance, deps);
      await deps.beforeStep?.('instance');
      await writeInstanceFile(ws, { ...instance, dbSchemaVersion: 0 });
      await deps.beforeStep?.('audit');
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      await appendChange(
        ws,
        {
          action: 'db-rebuild',
          summary: `database moved to backup ${made.id} (${String(bytes)} bytes); a new database is created at the next start`,
          reason: null,
          files: ['data/monitor.db', 'instance.json'],
          validation: `sha256 recorded for ${String(made.manifest.files.length)} files`,
          outcome: `moved; backup ${made.id}`,
        },
        ctx.clock.now(),
      );
      const pruned = await pruneAfter(ctx, ws, [made.id]);
      return { ...base, applied: true, backup: made.id, pruned };
    },
    mutexOptions(deps),
  );
}

/** The text of `db rebuild`. */
export function rebuildLines(result: DbRebuildResult): string[] {
  if (result.files.length === 0) {
    return [`task '${result.task}' has no database; there is nothing to move (the next start creates one)`];
  }
  const moved = result.files.map((f) => `${f.path} (${humanBytes(f.bytes)})`).join(', ');
  if (!result.applied) {
    return [
      `task '${result.task}': db rebuild plan (dry run, nothing moved)`,
      `  moves into a db-rebuild backup: ${moved}`,
      '  the next start creates a new database and imports again from the transcripts inside import.lookbackHours and from the spool segments that are still retained',
      '  lost: hook-only evidence older than the spool retention, reconciliation records, alert history and the change log (connected dashboards reload)',
      `  the old database comes back with: mcs backup restore --task ${result.task} --id <the backup id> --yes`,
      `run again with --yes --confirm ${result.task} to apply`,
    ];
  }
  const id = result.backup ?? '-';
  return [
    `moved the database to ${folderName(id)}: ${moved}`,
    'the next mcs start creates a new database and re-imports (this can take minutes for large transcripts)',
    `the old database comes back with: mcs backup restore --task ${result.task} --id ${id} --yes`,
    ...(result.pruned.length > 0
      ? [`removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`]
      : []),
  ];
}
