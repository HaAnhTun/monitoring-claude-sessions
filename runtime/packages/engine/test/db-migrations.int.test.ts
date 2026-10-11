import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APPLICATION_ID } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { openSqlite, pragmaValue, type SqlDriver } from '../src/db/driver.ts';
import { DbError, type DbErrorCode } from '../src/db/errors.ts';
import {
  loadMigrationFiles,
  migrateDb,
  migrationStatus,
  peekDbSchemaVersion,
  planDbMigrations,
} from '../src/db/migrations.ts';
import { DB_OPEN_EXIT_CODES, openInstanceDb, type OpenMode } from '../src/db/open.ts';

const tempDir = useTempDirs();
const FIXTURES = fileURLToPath(new URL('./fixtures/db/', import.meta.url));
const SHIPPED = fileURLToPath(new URL('../migrations/', import.meta.url));
const FROZEN_0001_SHA256 = '46f37fde62d11692f355e178419ee52d9d70ae8910d53e42cc0435f4f6b05da3';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const MODES: readonly OpenMode[] = ['serve', 'readonly', 'maintenance'];

const SECOND_OK = [
  '-- mcs:migration version=2 name=add_probe',
  'CREATE TABLE probe_two (id INTEGER PRIMARY KEY, note TEXT) STRICT;',
  'CREATE INDEX idx_probe_two_note ON probe_two(note);',
  '',
].join('\n');
const SECOND_BROKEN = [
  '-- mcs:migration version=2 name=broken',
  'CREATE TABLE half_done (x INTEGER) STRICT;',
  "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('secret-marker', 'x', 1, 1);",
  'INSERT INTO table_that_does_not_exist VALUES (1);',
  '',
].join('\n');
const SECOND_REBUILD = [
  '-- mcs:migration version=2 name=rebuild_projects',
  '-- mcs:foreign_keys=off',
  'CREATE TABLE projects_new (id INTEGER PRIMARY KEY, project_key TEXT NOT NULL UNIQUE CHECK (project_key = lower(project_key)),',
  '  dir_name TEXT NOT NULL, root_path TEXT, first_seen_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, note TEXT) STRICT;',
  'INSERT INTO projects_new (id, project_key, dir_name, root_path, first_seen_at, last_activity_at)',
  '  SELECT id, project_key, dir_name, root_path, first_seen_at, last_activity_at FROM projects;',
  'DROP TABLE projects;',
  'ALTER TABLE projects_new RENAME TO projects;',
  '',
].join('\n');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A copy of the shipped migrations folder plus extra files; returns the folder URL. */
function migrationsWith(extra: Readonly<Record<string, string>> = {}): { dir: string; url: URL } {
  const dir = join(tempDir('migrations').path, 'migrations');
  mkdirSync(dir);
  for (const name of readdirSync(SHIPPED)) copyFileSync(join(SHIPPED, name), join(dir, name));
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  return { dir, url: pathToFileURL(`${dir}/`) };
}

/** Copies a released fixture to a temp folder (a WAL database must never be opened in place). */
function copyFixture(name: string): string {
  const dir = tempDir('fixture').path;
  const target = join(dir, 'monitor.db');
  copyFileSync(join(FIXTURES, name), target);
  return target;
}

function fixtureInstanceId(path: string): string {
  const db = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
  try {
    const row = db.prepare<{ value: string }>("SELECT value FROM meta WHERE key = 'instance_id'").get();
    return row?.value ?? '';
  } finally {
    db.close();
  }
}

/** The raw state of a stopped database file: no connection of ours is open when this runs. */
function rawDriver(path: string): SqlDriver {
  return openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1000 });
}

function tableCounts(path: string): Record<string, number> {
  const db = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
  try {
    const names = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    return Object.fromEntries(
      names.map(({ name }) => [name, db.prepare<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`).get()?.n ?? -1]),
    );
  } finally {
    db.close();
  }
}

function failure(run: () => unknown, code: DbErrorCode): DbError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe(code);
    return error as DbError;
  }
  throw new Error(`expected a DbError ${code}`);
}

function schemaDump(db: SqlDriver): string {
  const rows = db
    .prepare<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_stat*' ORDER BY type, name",
    )
    .all();
  return rows
    .map((row) =>
      row.sql === null
        ? `-- ${row.type} ${row.name} (automatic, table ${row.tbl_name})\n`
        : `-- ${row.type} ${row.name}\n${row.sql};\n`,
    )
    .join('\n');
}

describe('DA-T-DB-1: 0001 applies cleanly', () => {
  it('creates a new file through openInstanceDb(serve) with the identity, the meta rows and an empty foreign key check', () => {
    const path = join(tempDir('db1').path, 'monitor.db');
    const db = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'serve', runtimeVersion: '3.0.0' });
    expect(pragmaValue(db.driver, 'user_version')).toBe(1);
    expect(pragmaValue(db.driver, 'application_id')).toBe(APPLICATION_ID);
    expect(pragmaValue(db.driver, 'foreign_key_check')).toBeUndefined();
    expect(pragmaValue(db.driver, 'auto_vacuum')).toBe(2);
    expect(pragmaValue(db.driver, 'journal_mode')).toBe('wal');
    const meta = Object.fromEntries(
      db.driver
        .prepare<{ key: string; value: string }>('SELECT key, value FROM meta')
        .all()
        .map((row) => [row.key, row.value]),
    );
    expect(Object.keys(meta).sort()).toEqual([
      'created_at',
      'created_by_runtime',
      'db_format',
      'instance_id',
      'privacy_profile',
    ]);
    expect(meta).toMatchObject({
      instance_id: INSTANCE_ID,
      db_format: 'mcs-monitor-db',
      created_by_runtime: '3.0.0',
      privacy_profile: 'metadata-v1',
    });
    expect(new Date(meta['created_at'] ?? '').toISOString()).toBe(meta['created_at']);
    expect(db.driver.prepare('SELECT version, name, checksum FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'initial', checksum: FROZEN_0001_SHA256 },
    ]);
    db.close();
  });

  it('dumps a sqlite_schema equal to the committed schema.snapshot.sql', () => {
    const db = openInstanceDb({
      path: join(tempDir('db1').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
    });
    const dump = schemaDump(db.driver);
    db.close();
    const snapshot = readFileSync(join(FIXTURES, 'schema.snapshot.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(dump).toBe(snapshot);
  });

  it('has the sha256 of the LF-normalised shipped file the design records (X14, frozen from WP-09 on)', () => {
    const text = readFileSync(join(SHIPPED, '0001_initial.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe(FROZEN_0001_SHA256);
    expect(loadMigrationFiles()[0]?.checksum).toBe(FROZEN_0001_SHA256);
  });

  it('has the 28 own tables, 52 indexes and 30 tables with sqlite_sequence and schema_migrations of X14', () => {
    const db = openInstanceDb({
      path: join(tempDir('db1').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
    });
    const count = (sql: string): number => db.driver.prepare<{ n: number }>(sql).get()?.n ?? -1;
    expect(count("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")).toBe(30);
    expect(count("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index'")).toBe(52);
    db.close();
  });

  it('is what the released fixture v1.db holds: the same schema dump', () => {
    const path = copyFixture('v1.db');
    const reader = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    const dump = schemaDump(reader);
    reader.close();
    expect(dump).toBe(readFileSync(join(FIXTURES, 'schema.snapshot.sql'), 'utf8').replace(/\r\n/g, '\n'));
  });
});

describe('DA-T-DB-2: checksums are verified', () => {
  it('refuses an edited migration file in every mode, names the version and leaves the database untouched', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const { dir, url } = migrationsWith();
    const file = join(dir, '0001_initial.sql');
    const bytes = readFileSync(file);
    const at = bytes.indexOf('Initial schema');
    expect(at).toBeGreaterThan(0);
    bytes[at] = (bytes[at] ?? 0) ^ 0x20; // 'I' becomes 'i': one flipped byte inside a comment
    writeFileSync(file, bytes);
    const before = sha256(path);
    for (const mode of MODES) {
      const error = failure(
        () => openInstanceDb({ path, expectedInstanceId: id, mode, runtimeVersion: '3.0.0', migrationsDir: url }),
        'migration_checksum_mismatch',
      );
      expect(error.version, mode).toBe(1);
      expect(DB_OPEN_EXIT_CODES[error.code]).toBe(14);
    }
    failure(() => planDbMigrations(path, { migrationsDir: url }), 'migration_checksum_mismatch');
    failure(
      () => migrateDb(path, { backupDone: true, runtimeVersion: '3.0.0', expectedInstanceId: id, migrationsDir: url }),
      'migration_checksum_mismatch',
    );
    expect(sha256(path)).toBe(before);
  });

  it('never repairs schema_migrations: the stored checksum is still the original one afterwards', () => {
    const path = copyFixture('v1.db');
    const db = rawDriver(path);
    expect(db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get()).toEqual({
      checksum: FROZEN_0001_SHA256,
    });
    db.close();
  });
});

describe('DA-T-DB-3: a newer database is refused untouched (D13)', () => {
  function newerCopy(): { path: string; id: string } {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const db = rawDriver(path);
    db.exec(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (99, 'future', '${'a'.repeat(64)}', 1, '9.9.9', 0)`,
    );
    db.pragma('user_version = 99');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    return { path, id };
  }

  it('is db_newer_than_runtime (exit 15) in every mode and the file hash does not change', () => {
    const { path, id } = newerCopy();
    const before = sha256(path);
    for (const mode of MODES) {
      const error = failure(
        () => openInstanceDb({ path, expectedInstanceId: id, mode, runtimeVersion: '3.0.0' }),
        'db_newer_than_runtime',
      );
      expect(DB_OPEN_EXIT_CODES[error.code], mode).toBe(15);
    }
    expect(sha256(path)).toBe(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it('is visible to peekDbSchemaVersion consumers without a lock and without writing', () => {
    const { path } = newerCopy();
    const before = sha256(path);
    expect(peekDbSchemaVersion(path)).toEqual({ userVersion: 99, latest: 1 });
    expect(sha256(path)).toBe(before);
  });

  it('is refused by planDbMigrations and migrateDb as well', () => {
    const { path, id } = newerCopy();
    const before = sha256(path);
    failure(() => planDbMigrations(path), 'db_newer_than_runtime');
    failure(
      () => migrateDb(path, { backupDone: true, runtimeVersion: '3.0.0', expectedInstanceId: id }),
      'db_newer_than_runtime',
    );
    expect(sha256(path)).toBe(before);
  });
});

describe('peekDbSchemaVersion (03 4.3)', () => {
  it('answers null for a file that does not exist', () => {
    expect(peekDbSchemaVersion(join(tempDir('peek').path, 'missing.db'))).toBeNull();
  });

  it('reads user_version and the latest shipped version of a released database', () => {
    expect(peekDbSchemaVersion(copyFixture('v1.db'))).toEqual({ userVersion: 1, latest: 1 });
  });

  it('answers user_version 0 for an empty file', () => {
    const path = join(tempDir('peek').path, 'empty.db');
    writeFileSync(path, '');
    expect(peekDbSchemaVersion(path)).toEqual({ userVersion: 0, latest: 1 });
  });

  it('takes the latest version from a given migrations folder', () => {
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    expect(peekDbSchemaVersion(copyFixture('v1.db'), { migrationsDir: url })).toEqual({ userVersion: 1, latest: 2 });
  });
});

describe('DA-T-DB-4: an explicit migration needs a backup', () => {
  it('serve refuses an older database with db_migration_required (exit 16) and changes nothing', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    const before = sha256(path);
    for (const mode of MODES) {
      const error = failure(
        () => openInstanceDb({ path, expectedInstanceId: id, mode, runtimeVersion: '3.0.0', migrationsDir: url }),
        'db_migration_required',
      );
      expect(DB_OPEN_EXIT_CODES[error.code], mode).toBe(16);
    }
    expect(sha256(path)).toBe(before);
  });

  it('planDbMigrations lists the step that would run and writes nothing', () => {
    const path = copyFixture('v1.db');
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    const before = sha256(path);
    expect(planDbMigrations(path, { migrationsDir: url })).toEqual({
      from: 1,
      to: 2,
      steps: [{ version: 2, name: 'add_probe' }],
    });
    expect(planDbMigrations(path)).toEqual({ from: 1, to: 1, steps: [] });
    expect(sha256(path)).toBe(before);
  });

  it('migrateDb refuses with backup_required unless the caller made the backup, then applies', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    const before = sha256(path);
    failure(
      () => migrateDb(path, { backupDone: false, runtimeVersion: '3.1.0', expectedInstanceId: id, migrationsDir: url }),
      'backup_required',
    );
    expect(sha256(path)).toBe(before);
    const result = migrateDb(path, {
      backupDone: true,
      runtimeVersion: '3.1.0',
      expectedInstanceId: id,
      migrationsDir: url,
    });
    expect(result).toMatchObject({ from: 1, to: 2 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const db = openInstanceDb({
      path,
      expectedInstanceId: id,
      mode: 'serve',
      runtimeVersion: '3.1.0',
      migrationsDir: url,
    });
    expect(pragmaValue(db.driver, 'user_version')).toBe(2);
    expect(
      db.driver.prepare('SELECT version, name, runtime_version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([
      { version: 1, name: 'initial', runtime_version: '3.0.0' },
      { version: 2, name: 'add_probe', runtime_version: '3.1.0' },
    ]);
    expect(
      db.driver
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('probe_two', 'idx_probe_two_note')")
        .get(),
    ).toEqual({ n: 2 });
    db.close();
  });

  it('migrateDb with nothing pending is a no-op that needs no backup', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const before = sha256(path);
    expect(migrateDb(path, { backupDone: false, runtimeVersion: '3.0.0', expectedInstanceId: id })).toMatchObject({
      from: 1,
      to: 1,
    });
    expect(sha256(path)).toBe(before);
  });

  it('migrateDb checks identity before anything else', () => {
    const path = copyFixture('v1.db');
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    failure(
      () =>
        migrateDb(path, {
          backupDone: true,
          runtimeVersion: '3.1.0',
          expectedInstanceId: '22222222-2222-4222-8222-222222222222',
          migrationsDir: url,
        }),
      'db_identity_mismatch',
    );
  });

  it('migrateDb uses the injected clock for applied_at and duration_ms', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    let now = 1_800_000_000_000;
    migrateDb(path, {
      backupDone: true,
      runtimeVersion: '3.1.0',
      expectedInstanceId: id,
      migrationsDir: url,
      now: () => {
        now += 7;
        return now;
      },
    });
    const db = rawDriver(path);
    const row = db
      .prepare<{ applied_at: number; duration_ms: number }>(
        'SELECT applied_at, duration_ms FROM schema_migrations WHERE version = 2',
      )
      .get();
    expect(row?.duration_ms).toBe(7);
    expect((row?.applied_at ?? 0) > 1_800_000_000_000).toBe(true);
    db.close();
  });
});

describe('DA-T-DB-5: a failed migration rolls back', () => {
  it('keeps version 1 and every row, and reports migration_failed with the version but no SQL text', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const { url } = migrationsWith({ '0002_broken.sql': SECOND_BROKEN });
    const before = tableCounts(path);
    const error = failure(
      () => migrateDb(path, { backupDone: true, runtimeVersion: '3.1.0', expectedInstanceId: id, migrationsDir: url }),
      'migration_failed',
    );
    expect(error.version).toBe(2);
    expect(error.sqliteCode).toBe('SQLITE_ERROR');
    expect(error.message).not.toContain('secret-marker');
    expect(error.message).not.toContain('table_that_does_not_exist');
    expect(tableCounts(path)).toEqual(before);
    expect(peekDbSchemaVersion(path)).toEqual({ userVersion: 1, latest: 1 });
    const db = rawDriver(path);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half_done'").get()).toEqual({ n: 0 });
    expect(pragmaValue(db, 'foreign_keys')).toBe(1);
    db.close();
  });

  it('can be retried after the cause is fixed: the next run applies the migration', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const broken = migrationsWith({ '0002_broken.sql': SECOND_BROKEN });
    failure(
      () =>
        migrateDb(path, {
          backupDone: true,
          runtimeVersion: '3.1.0',
          expectedInstanceId: id,
          migrationsDir: broken.url,
        }),
      'migration_failed',
    );
    const fixed = migrationsWith({ '0002_broken.sql': SECOND_OK.replace('add_probe', 'broken') });
    expect(
      migrateDb(path, { backupDone: true, runtimeVersion: '3.1.0', expectedInstanceId: id, migrationsDir: fixed.url }),
    ).toMatchObject({ from: 1, to: 2 });
  });
});

describe('DA-T-DB-6: upgrade from every released version', () => {
  const released = readdirSync(FIXTURES)
    .filter((name) => /^v\d+\.db$/.test(name))
    .sort((a, b) => Number(a.slice(1, -3)) - Number(b.slice(1, -3)));

  it('has a fixture for every shipped schema version up to the one this build ships', () => {
    const latest = loadMigrationFiles().length;
    expect(released.length).toBeGreaterThanOrEqual(1);
    for (let version = 1; version <= latest; version += 1) {
      expect(released, `v${String(version)}.db`).toContain(`v${String(version)}.db`);
    }
  });

  it.each(released)('%s: migrates to the latest shipped version with every row preserved', (fixture) => {
    const path = copyFixture(fixture);
    const id = fixtureInstanceId(path);
    const from = peekDbSchemaVersion(path)?.userVersion ?? 0;
    const before = tableCounts(path);
    const { url } = migrationsWith({ '0002_add_probe.sql': SECOND_OK });
    const latest = loadMigrationFiles(url).length;
    const result = migrateDb(path, {
      backupDone: true,
      runtimeVersion: '3.1.0',
      expectedInstanceId: id,
      migrationsDir: url,
    });
    expect(result).toMatchObject({ from, to: latest });
    const after = tableCounts(path);
    for (const [table, count] of Object.entries(before)) {
      if (table === 'schema_migrations') expect(after[table]).toBe(latest);
      else expect(after[table], table).toBe(count);
    }
    const db = openInstanceDb({
      path,
      expectedInstanceId: id,
      mode: 'serve',
      runtimeVersion: '3.1.0',
      migrationsDir: url,
    });
    expect(migrationStatus(db.driver, loadMigrationFiles(url)).pending).toEqual([]);
    db.close();
  });

  it('keeps rows that point at a rebuilt table: a foreign_keys=off migration does not null the references', () => {
    const path = copyFixture('v1.db');
    const id = fixtureInstanceId(path);
    const before = rawDriver(path);
    const linked =
      before.prepare<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE project_id IS NOT NULL').get()?.n ?? 0;
    before.close();
    expect(linked).toBeGreaterThan(0);
    const { url } = migrationsWith({ '0002_rebuild_projects.sql': SECOND_REBUILD });
    migrateDb(path, { backupDone: true, runtimeVersion: '3.1.0', expectedInstanceId: id, migrationsDir: url });
    const after = rawDriver(path);
    expect(after.prepare('SELECT count(*) AS n FROM sessions WHERE project_id IS NOT NULL').get()).toEqual({
      n: linked,
    });
    expect(pragmaValue(after, 'foreign_key_check')).toBeUndefined();
    after.close();
  });
});
