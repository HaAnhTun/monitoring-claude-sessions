// The identity-checked open of an instance database (03 3.2, 4.5, DA-I3, DA-I4, D13). One writer connection lives in the
// server process; the CLI opens read-only, or as the single writer only while no server runs. A database newer than the
// runtime is refused untouched; an older one is never migrated here (only `migrateDb`, after a verified backup).
import { randomBytes } from 'node:crypto';

import { WAL_RETRY, systemClock, type Clock } from '@mcs/shared';

import { BUSY_TIMEOUT_MS, openSqlite, pragmaValue, type SqlDriver } from './driver.ts';
import { DbError, isDbError, type DbErrorCode } from './errors.ts';
import {
  applyPendingMigrations,
  assertIdentity,
  isEmptyDatabase,
  loadMigrationFiles,
  migrationStatus,
  type MigrationFile,
  type MigrationsLocation,
} from './migrations.ts';

/** Every repository call carries one: the instance it believes it works for (DA-I3). */
export interface RepoContext {
  readonly instanceId: string;
}

/** `maintenance` = the writer on a stopped instance (`db migrate`, `cleanup --scope data`). */
export type OpenMode = 'serve' | 'readonly' | 'maintenance';

export interface InstanceDb {
  readonly driver: SqlDriver;
  readonly instanceId: string;
  readonly mode: OpenMode;
  /** 8 hex characters, new for every open: one epoch is one server process lifetime (03 9.2). */
  readonly epoch: string;
  /** The time source of this database: `WriteTx.now` and the `changes.at` of its transactions. */
  readonly clock: Clock;
  /** `DbError('scope_mismatch')` unless `ctx.instanceId` is the instance of this database. */
  assertScope(ctx: RepoContext): void;
  /** `coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0)`: valid after pruning (03 9.1). */
  headSeq(): number;
  /** Writer modes run `PRAGMA optimize` first. Idempotent. */
  close(): void;
}

export interface OpenInstanceDbOptions extends MigrationsLocation {
  path: string;
  expectedInstanceId: string;
  mode: OpenMode;
  runtimeVersion: string;
  /** Time source (default: the system clock). */
  clock?: Clock;
  /**
   * `readonly` only: read the file as it is, with no `-wal` or `-shm` file created or read (`openSqlite` `immutable`). Only for a
   * database that no process has open and that has no committed frames in a `-wal` file; the `DbReader` checks both.
   */
  immutable?: boolean;
}

/** Boot exit code of the server for each way an open can fail (03 3.2; registry 7.3). `migration_unknown` counts as newer. */
export const DB_OPEN_EXIT_CODES: Readonly<Record<DbErrorCode, 11 | 14 | 15 | 16>> = Object.freeze({
  db_busy: 14,
  db_locked: 14,
  db_not_mcs: 11,
  db_identity_mismatch: 11,
  db_corrupt: 14,
  db_readonly: 14,
  db_full: 14,
  db_io: 14,
  db_cantopen: 14,
  db_constraint: 14,
  db_migration_required: 16,
  db_newer_than_runtime: 15,
  migration_checksum_mismatch: 14,
  migration_gap: 14,
  migration_unknown: 15,
  migration_failed: 14,
  migration_fk_violation: 14,
  migrations_missing: 14,
  backup_required: 14,
  backup_failed: 14,
  scope_mismatch: 14,
});

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread for `ms`: the open is synchronous and the pause is 25 ms at most 19 times. */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/**
 * `PRAGMA journal_mode = WAL`, retried while another process holds the file during its own switch (cold-start race
 * [research:stack-versions.md 2.2]): at most `WAL_RETRY.attempts` attempts, `WAL_RETRY.delayMs` apart, then `db_busy`.
 * Any other failure, and a location that answers another journal mode, fails at once.
 */
export function enableWal(driver: SqlDriver, sleep: (ms: number) => void = sleepSync): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (pragmaValue(driver, 'journal_mode = WAL') !== 'wal') {
        throw new DbError('db_io', 'this location cannot hold a WAL database');
      }
      return;
    } catch (error) {
      if (!isDbError(error, 'db_busy') || attempt >= WAL_RETRY.attempts) throw error;
      sleep(WAL_RETRY.delayMs);
    }
  }
}

const CONNECTION_PRAGMAS = [
  'synchronous = NORMAL',
  'foreign_keys = ON', // explicit: the SQLite build of the driver may default to OFF
  'temp_store = MEMORY',
  'cache_size = -16000',
  'journal_size_limit = 67108864',
] as const;

function prepareConnection(
  driver: SqlDriver,
  o: OpenInstanceDbOptions,
  files: readonly MigrationFile[],
  clock: Clock,
): void {
  const fresh = isEmptyDatabase(driver);
  if (fresh && o.mode !== 'serve') {
    throw new DbError('db_not_mcs', 'the file is empty: only the server creates a database');
  }
  if (!fresh) {
    // identity first (11), then the version (15, 16); nothing is written before both are known
    assertIdentity(driver, o.expectedInstanceId);
    const status = migrationStatus(driver, files);
    if (status.pending.length > 0) {
      throw new DbError('db_migration_required', 'the database schema is older than this runtime: run the upgrade', {
        version: status.dbVersion,
      });
    }
  }
  if (o.mode !== 'readonly') {
    if (fresh) driver.exec('PRAGMA auto_vacuum = INCREMENTAL'); // cannot change after the first table [exp:X7]
    enableWal(driver);
  }
  for (const pragma of CONNECTION_PRAGMAS) driver.pragma(pragma);
  if (o.mode === 'readonly') driver.pragma('query_only = 1');
  if (fresh) {
    applyPendingMigrations(driver, files, {
      runtimeVersion: o.runtimeVersion,
      expectedInstanceId: o.expectedInstanceId,
      now: () => clock.now(),
    });
    // a process that raced us may have created the file for another instance
    assertIdentity(driver, o.expectedInstanceId);
  }
}

function closeQuietly(driver: SqlDriver): void {
  try {
    driver.close();
  } catch {
    // the original failure is the one worth reporting
  }
}

/**
 * Opens (and, in `serve` mode, creates) the database of one instance. `serve` creates a missing file at the latest schema
 * and refuses an older one (`db_migration_required`); `readonly` and `maintenance` need an existing file. Every mode refuses
 * another instance (`db_identity_mismatch`), a foreign file (`db_not_mcs`) and a newer schema (`db_newer_than_runtime`).
 */
export function openInstanceDb(o: OpenInstanceDbOptions): InstanceDb {
  const files = loadMigrationFiles(o.migrationsDir);
  const clock = o.clock ?? systemClock;
  const driver = openSqlite(o.path, {
    readonly: o.mode === 'readonly',
    fileMustExist: o.mode !== 'serve',
    timeoutMs: BUSY_TIMEOUT_MS,
    ...(o.mode === 'readonly' && o.immutable === true ? { immutable: true } : {}),
  });
  try {
    prepareConnection(driver, o, files, clock);
  } catch (error) {
    closeQuietly(driver);
    throw error;
  }

  let closed = false;
  return {
    driver,
    instanceId: o.expectedInstanceId,
    mode: o.mode,
    epoch: randomBytes(4).toString('hex'),
    clock,
    assertScope: (ctx) => {
      if (ctx.instanceId !== o.expectedInstanceId) {
        throw new DbError('scope_mismatch', 'the call belongs to another instance');
      }
    },
    headSeq: () =>
      driver
        .prepare<{ seq: number }>("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0) AS seq")
        .get()?.seq ?? 0,
    close: () => {
      if (closed) return;
      closed = true;
      if (o.mode !== 'readonly') {
        try {
          driver.exec('PRAGMA optimize');
        } catch {
          // best effort: a busy database must still close
        }
      }
      driver.close();
    },
  };
}
