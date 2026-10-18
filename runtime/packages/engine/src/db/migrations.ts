// The only code that applies DDL (03 4.1-4.3, ADR 0021): forward-only SQL files, sha256 checksums, one IMMEDIATE
// transaction per file, a backup gate for a database that already holds tables, and the identity of a monitor database
// (`application_id` and `meta.instance_id`, DA-I3). The files ship as plain files next to `dist/` (the runtime folder is
// the template): `src/db/` and `dist/db/` are both two levels below the engine package folder that holds `migrations/`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APPLICATION_ID, isoMsZ, systemClock } from '@mcs/shared';

import { layoutOfModule, type LayoutFs } from '../platform/layout.ts';

import { BUSY_TIMEOUT_MS, openSqlite, pragmaNumber, type SqlDriver } from './driver.ts';
import { DbError } from './errors.ts';

export interface MigrationFile {
  version: number;
  name: string;
  /** sha256 (hex) of the text after removing a UTF-8 BOM and converting CRLF to LF. */
  checksum: string;
  /** The normalised text that is executed. */
  sql: string;
  /** The file carries `-- mcs:foreign_keys=off` (table rebuilds): foreign keys are off outside its transaction. */
  foreignKeysOff: boolean;
}

export interface MigrationStatus {
  /** Highest applied version; 0 for a file without tables. */
  dbVersion: number;
  /** Highest shipped version. */
  latest: number;
  pending: MigrationFile[];
  /** A file without tables: a database that was never created. */
  isNew: boolean;
}

/** Folder and optional test hook shared by the functions that read the shipped files. */
export interface MigrationsLocation {
  /** Folder of the `.sql` files (a `file:` URL); default: {@link defaultMigrationsDir}. */
  migrationsDir?: URL;
}

/**
 * The shipped migrations folder (a `file:` URL with a trailing slash) of the layout `moduleUrl` belongs to (ADR 0062):
 * `<bundle>/migrations/` next to a bundle entry, `packages/engine/migrations/` in the source layout.
 */
export function defaultMigrationsDir(moduleUrl: string | URL = import.meta.url, fs?: LayoutFs): URL {
  return pathToFileURL(layoutOfModule(moduleUrl, fs).migrationsDir + sep);
}
/** U+FEFF: what a UTF-8 byte order mark decodes to. */
const UTF8_BOM = String.fromCharCode(0xfeff);
const FILE_NAME_RE = /^(\d{4})_([a-z0-9_]{1,48})\.sql$/;
const HEADER_RE = /^-- mcs:migration version=(\d+) name=([a-z0-9_]{1,48})$/;
const DIRECTIVE_RE = /^-- mcs:foreign_keys=(\S+)$/;

/** Created by the runner, never by a migration file (03 4.2). */
const BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version         INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  checksum        TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at      INTEGER NOT NULL,
  runtime_version TEXT NOT NULL CHECK (length(runtime_version) BETWEEN 1 AND 32),
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;`;

function invalidFile(fileName: string, reason: string): DbError {
  return new DbError('migration_failed', `invalid migration file ${fileName}: ${reason}`);
}

function normalise(text: string): string {
  return (text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text).replaceAll('\r\n', '\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseFile(folder: string, fileName: string): MigrationFile {
  const nameMatch = FILE_NAME_RE.exec(fileName);
  if (nameMatch === null) throw invalidFile(fileName, 'the name must match NNNN_snake_name.sql');
  const sql = normalise(readFileSync(join(folder, fileName), 'utf8'));
  const lines = sql.split('\n');
  const headerMatch = HEADER_RE.exec(lines[0] ?? '');
  if (headerMatch === null) throw invalidFile(fileName, 'the first line must be "-- mcs:migration version=N name=x"');
  const version = Number(nameMatch[1]);
  if (Number(headerMatch[1]) !== version || headerMatch[2] !== nameMatch[2]) {
    throw invalidFile(fileName, 'the header disagrees with the file name');
  }
  let foreignKeysOff = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    if (!line.startsWith('--')) break;
    const directive = DIRECTIVE_RE.exec(line);
    if (directive === null) continue;
    if (directive[1] !== 'off') throw invalidFile(fileName, 'the only foreign_keys directive is "off"');
    foreignKeysOff = true;
  }
  return { version, name: headerMatch[2] ?? '', checksum: sha256(sql), sql, foreignKeysOff };
}

/**
 * Reads, validates and sorts the migration files: names `NNNN_name.sql`, header equal to the name, versions 1..n without a
 * gap (`migration_gap`). A missing or empty folder is `migrations_missing`.
 */
export function loadMigrationFiles(dir: URL = defaultMigrationsDir()): MigrationFile[] {
  const folder = fileURLToPath(dir);
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.sql'));
  } catch {
    throw new DbError('migrations_missing', 'the migrations folder is missing');
  }
  if (names.length === 0) throw new DbError('migrations_missing', 'the migrations folder holds no .sql file');
  const files = names.map((name) => parseFile(folder, name)).sort((a, b) => a.version - b.version);
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new DbError('migration_gap', 'migration versions must be 1..n without a gap or a duplicate', {
        version: file.version,
      });
    }
  });
  return files;
}

function latestOf(files: readonly MigrationFile[]): number {
  return files.reduce((highest, file) => Math.max(highest, file.version), 0);
}

function countUserTables(db: SqlDriver): number {
  const row = db
    .prepare<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .get();
  return row?.n ?? 0;
}

function hasTable(db: SqlDriver, name: string): boolean {
  return db.prepare("SELECT 1 AS one FROM sqlite_schema WHERE type = 'table' AND name = ?").get([name]) !== undefined;
}

/** True for a database that was never created: no table, `user_version` 0 and no foreign `application_id`. */
export function isEmptyDatabase(db: SqlDriver): boolean {
  if (countUserTables(db) !== 0 || pragmaNumber(db, 'user_version') !== 0) return false;
  const applicationId = pragmaNumber(db, 'application_id');
  return applicationId === 0 || applicationId === APPLICATION_ID;
}

/** DA-I3: `application_id` must be ours (`db_not_mcs`) and `meta.instance_id` must be the expected one. */
export function assertIdentity(db: SqlDriver, expectedInstanceId: string): void {
  if (pragmaNumber(db, 'application_id') !== APPLICATION_ID) {
    throw new DbError('db_not_mcs', 'the file is not a monitor database (application_id)');
  }
  const row = hasTable(db, 'meta')
    ? db.prepare<{ value: string }>("SELECT value FROM meta WHERE key = 'instance_id'").get()
    : undefined;
  if (row?.value !== expectedInstanceId) {
    throw new DbError('db_identity_mismatch', 'the database belongs to another instance (or has no identity)');
  }
}

/** `application_id` only: the check of a caller that does not know the instance id (a plan, a backup source). */
export function assertApplicationId(db: SqlDriver): void {
  if (pragmaNumber(db, 'application_id') !== APPLICATION_ID) {
    throw new DbError('db_not_mcs', 'the file is not a monitor database (application_id)');
  }
}

/**
 * Read-only: compares the applied migrations with the shipped files (03 4.3 `migrationStatus`). Checks, in order: a
 * database newer than the runtime, an applied version no file explains, a changed file, holes in the applied versions.
 */
export function migrationStatus(db: SqlDriver, files: readonly MigrationFile[]): MigrationStatus {
  const latest = latestOf(files);
  const userVersion = pragmaNumber(db, 'user_version');
  if (countUserTables(db) === 0 && userVersion === 0) {
    return { dbVersion: 0, latest, pending: [...files], isNew: true };
  }
  if (!hasTable(db, 'schema_migrations')) {
    throw new DbError('db_not_mcs', 'the database has tables but no schema_migrations table');
  }
  const applied = db
    .prepare<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all();
  const highest = applied.at(-1)?.version ?? 0;
  if (Math.max(highest, userVersion) > latest) {
    throw new DbError('db_newer_than_runtime', 'the database was written by a newer runtime', {
      version: Math.max(highest, userVersion),
    });
  }
  const shipped = new Map(files.map((file) => [file.version, file]));
  for (const row of applied) {
    const file = shipped.get(row.version);
    if (file === undefined) {
      throw new DbError('migration_unknown', `applied migration ${String(row.version)} has no shipped file`, {
        version: row.version,
      });
    }
    if (file.checksum !== row.checksum) {
      throw new DbError(
        'migration_checksum_mismatch',
        `migration ${String(row.version)} was edited after it was applied: restore the original file from git`,
        { version: row.version },
      );
    }
  }
  applied.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new DbError('migration_gap', 'the applied migration versions are not 1..n', { version: row.version });
    }
  });
  return { dbVersion: highest, latest, pending: files.filter((file) => file.version > highest), isNew: false };
}

/** `[01 4.7 step 5]`: no lock, read-only open, `PRAGMA user_version` only. `null` when the file does not exist. */
export function peekDbSchemaVersion(
  path: string,
  opts: MigrationsLocation = {},
): { userVersion: number; latest: number } | null {
  if (!existsSync(path)) return null;
  const latest = latestOf(loadMigrationFiles(opts.migrationsDir));
  const db = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
  try {
    return { userVersion: pragmaNumber(db, 'user_version'), latest };
  } finally {
    db.close();
  }
}

/** `[01 5.4 step 3]`: what `upgrade` / `db migrate` would apply. Read-only; refuses what `migrationStatus` refuses. */
export function planDbMigrations(
  path: string,
  opts: MigrationsLocation = {},
): { from: number; to: number; steps: { version: number; name: string }[] } {
  const files = loadMigrationFiles(opts.migrationsDir);
  const db = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
  try {
    const status = migrationStatus(db, files);
    if (!status.isNew) assertApplicationId(db);
    return {
      from: status.dbVersion,
      to: status.latest,
      steps: status.pending.map(({ version, name }) => ({ version, name })),
    };
  } finally {
    db.close();
  }
}

export interface ApplyOptions {
  runtimeVersion: string;
  expectedInstanceId: string;
  now: () => number;
}

function migrationFailure(file: MigrationFile, error: unknown): unknown {
  if (!(error instanceof DbError)) return error; // a programming error is not a migration failure
  if (error.code.startsWith('migration_')) return error;
  const detail = error.sqliteCode ?? error.code;
  return new DbError('migration_failed', `migration ${String(file.version)} (${file.name}) failed: ${detail}`, {
    version: file.version,
    ...(error.sqliteCode === undefined ? {} : { sqliteCode: error.sqliteCode }),
  });
}

/** Version 1 also writes the identity of the database (03 3.3, 4.3 step 3). */
function writeIdentity(db: SqlDriver, o: ApplyOptions, createdAt: number): void {
  db.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
  const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  insert.run(['instance_id', o.expectedInstanceId]);
  insert.run(['db_format', 'mcs-monitor-db']);
  insert.run(['created_at', isoMsZ(createdAt)]);
  insert.run(['created_by_runtime', o.runtimeVersion]);
  insert.run(['privacy_profile', 'metadata-v1']);
}

function applyOne(db: SqlDriver, file: MigrationFile, o: ApplyOptions): boolean {
  const started = o.now();
  // `PRAGMA foreign_keys` is ignored inside a transaction [exp:X10]: switch it around the transaction.
  if (file.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
  try {
    return db.transaction(() => {
      db.exec(BOOTSTRAP_SQL);
      // another process may have applied this file while we waited for the write lock
      if (db.prepare('SELECT 1 AS one FROM schema_migrations WHERE version = ?').get([file.version]) !== undefined) {
        return false;
      }
      db.exec(file.sql);
      const finished = o.now();
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      ).run([file.version, file.name, file.checksum, finished, o.runtimeVersion, Math.max(0, finished - started)]);
      db.exec(`PRAGMA user_version = ${String(file.version)}`);
      if (file.version === 1) writeIdentity(db, o, finished);
      const violations = db.pragma('foreign_key_check');
      if (Array.isArray(violations) && violations.length > 0) {
        throw new DbError('migration_fk_violation', `migration ${String(file.version)} left a foreign key violation`, {
          version: file.version,
        });
      }
      return true;
    }, 'immediate');
  } catch (error) {
    throw migrationFailure(file, error);
  } finally {
    if (file.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Applies the files in order, each in its own `BEGIN IMMEDIATE` transaction with `foreign_key_check`. Returns the versions
 * this call applied (a version another process applied first is skipped). Earlier files stay applied when a later one
 * fails: each step is atomic and the caller's backup is the recovery point. The caller has made the backup and, for a
 * database that already holds tables, holds the instance stopped.
 */
export function applyPendingMigrations(db: SqlDriver, pending: readonly MigrationFile[], o: ApplyOptions): number[] {
  const applied: number[] = [];
  for (const file of pending) if (applyOne(db, file, o)) applied.push(file.version);
  return applied;
}

export interface MigrateDbOptions extends MigrationsLocation {
  /** The caller made the `upgrade` backup (`backupDb`, `[01 5.4]`). Required when anything is pending. */
  backupDone: boolean;
  runtimeVersion: string;
  expectedInstanceId: string;
  now?: () => number;
}

/**
 * `[01 5.4 step 7]`: applies the pending migrations of an existing monitor database. The caller holds the task mutex and
 * the instance is stopped. `backup_required` when there is something to apply and `backupDone` is false.
 */
export function migrateDb(path: string, opts: MigrateDbOptions): { from: number; to: number; durationMs: number } {
  const now = opts.now ?? ((): number => systemClock.now());
  const started = now();
  const files = loadMigrationFiles(opts.migrationsDir);
  const db = openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
  try {
    if (isEmptyDatabase(db)) {
      throw new DbError('db_not_mcs', 'the file is empty: a new database is created by openInstanceDb in serve mode');
    }
    assertIdentity(db, opts.expectedInstanceId);
    const status = migrationStatus(db, files);
    if (status.pending.length === 0) return { from: status.dbVersion, to: status.dbVersion, durationMs: 0 };
    if (!opts.backupDone) {
      throw new DbError('backup_required', 'migrating a database that holds data needs a verified backup first');
    }
    applyPendingMigrations(db, status.pending, {
      runtimeVersion: opts.runtimeVersion,
      expectedInstanceId: opts.expectedInstanceId,
      now,
    });
    db.exec('PRAGMA optimize');
    return { from: status.dbVersion, to: status.latest, durationMs: Math.max(0, now() - started) };
  } finally {
    db.close();
  }
}
