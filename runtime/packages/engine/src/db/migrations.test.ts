import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APPLICATION_ID } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { openSqlite, pragmaValue, type SqlDriver } from './driver.ts';
import { DbError, type DbErrorCode } from './errors.ts';
import {
  applyPendingMigrations,
  assertIdentity,
  defaultMigrationsDir,
  loadMigrationFiles,
  migrationStatus,
  type MigrationFile,
} from './migrations.ts';

const tempDir = useTempDirs();

/** sha256 of the LF-normalised `0001_initial.sql` as committed with WP-09 (frozen from then on, plan section 12 rule 5). */
const FROZEN_0001_SHA256 = '46f37fde62d11692f355e178419ee52d9d70ae8910d53e42cc0435f4f6b05da3';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SHIPPED_DIR = new URL('../../migrations/', import.meta.url);

function header(version: number, name: string, ...directives: string[]): string {
  return [`-- mcs:migration version=${String(version)} name=${name}`, ...directives, ''].join('\n');
}

const SECOND_OK = `${header(2, 'add_probe')}CREATE TABLE probe_two (id INTEGER PRIMARY KEY, note TEXT) STRICT;\n`;
const SECOND_BROKEN = `${header(2, 'broken')}CREATE TABLE half_done (x INTEGER) STRICT;\nINSERT INTO does_not_exist VALUES (1);\n`;
const SECOND_REBUILD = `${header(2, 'rebuild_projects', '-- mcs:foreign_keys=off')}
CREATE TABLE projects_new (id INTEGER PRIMARY KEY, project_key TEXT NOT NULL UNIQUE, dir_name TEXT NOT NULL,
  root_path TEXT, first_seen_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, note TEXT) STRICT;
INSERT INTO projects_new (id, project_key, dir_name, root_path, first_seen_at, last_activity_at)
  SELECT id, project_key, dir_name, root_path, first_seen_at, last_activity_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
`;
const SECOND_ORPHAN = `${header(2, 'orphan', '-- mcs:foreign_keys=off')}
INSERT INTO events (session_id, kind, sources, ts, ts_source, received_at, natural_key)
VALUES (999, 'tool.call', 1, 1, 'record', 1, 'orphan-key');
`;

function memory(): SqlDriver {
  return openSqlite(':memory:', { readonly: false, fileMustExist: false, timeoutMs: 1000 });
}

function writeDir(files: Readonly<Record<string, string | Buffer>>): URL {
  const dir = tempDir('migrations').path;
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return pathToFileURL(`${dir}/`);
}

function shipped(): string {
  return readFileSync(fileURLToPath(new URL('0001_initial.sql', SHIPPED_DIR)), 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function counter(start = 1_000, step = 5): () => number {
  let current = start - step;
  return () => {
    current += step;
    return current;
  };
}

function migrated(files: readonly MigrationFile[] = loadMigrationFiles()): SqlDriver {
  const db = memory();
  applyPendingMigrations(db, files, { runtimeVersion: '3.0.0', expectedInstanceId: INSTANCE_ID, now: counter() });
  return db;
}

describe('loadMigrationFiles (03 4.1)', () => {
  it('reads the shipped folder next to dist/: 0001_initial.sql is version 1, name initial, foreign keys on', () => {
    const files = loadMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.map((file) => file.version)).toEqual(files.map((_, index) => index + 1));
    expect(files[0]).toMatchObject({ version: 1, name: 'initial', foreignKeysOff: false });
    expect(files[0]?.sql.startsWith('-- mcs:migration version=1 name=initial\n')).toBe(true);
  });

  it('freezes 0001_initial.sql: its LF-normalised sha256 is the recorded checksum', () => {
    expect(loadMigrationFiles()[0]?.checksum).toBe(FROZEN_0001_SHA256);
    expect(sha256(shipped().replace(/\r\n/g, '\n'))).toBe(FROZEN_0001_SHA256);
  });

  it('is the same file when given the folder explicitly', () => {
    expect(loadMigrationFiles(SHIPPED_DIR)).toEqual(loadMigrationFiles());
  });

  it('the default folder follows the layout: packages/engine/migrations in the source layout', () => {
    expect(fileURLToPath(defaultMigrationsDir())).toBe(fileURLToPath(SHIPPED_DIR));
  });

  it('the default folder follows the layout: <bundle>/migrations next to a bundle entry (a hand-built bundle)', () => {
    const bundle = join(tempDir('mig-bundle').path, 'skill', 'bundle');
    mkdirSync(join(bundle, 'migrations'), { recursive: true });
    writeFileSync(join(bundle, 'mcs-server.mjs'), '');
    writeFileSync(join(bundle, 'mcs-cli.mjs'), '');
    writeFileSync(join(bundle, 'migrations', '0001_initial.sql'), shipped());
    const dir = defaultMigrationsDir(pathToFileURL(join(bundle, 'mcs-cli.mjs')).href);
    expect(fileURLToPath(dir)).toBe(join(bundle, 'migrations') + sep);
    expect(loadMigrationFiles(dir)).toEqual(loadMigrationFiles());
  });

  it('computes the checksum after removing a BOM and converting CRLF to LF (a Windows checkout changes nothing)', () => {
    const lf = SECOND_OK;
    const crlf = lf.replaceAll('\n', '\r\n');
    const bom = String.fromCharCode(0xfeff) + crlf;
    const base = { '0001_initial.sql': shipped() };
    const a = loadMigrationFiles(writeDir({ ...base, '0002_add_probe.sql': lf }))[1];
    const b = loadMigrationFiles(writeDir({ ...base, '0002_add_probe.sql': crlf }))[1];
    const c = loadMigrationFiles(writeDir({ ...base, '0002_add_probe.sql': bom }))[1];
    expect(a?.checksum).toBe(sha256(lf));
    expect(b?.checksum).toBe(a?.checksum);
    expect(c?.checksum).toBe(a?.checksum);
    expect(c?.sql).toBe(lf);
    const changed = loadMigrationFiles(writeDir({ ...base, '0002_add_probe.sql': lf.replace('note', 'nota') }))[1];
    expect(changed?.checksum).not.toBe(a?.checksum);
  });

  it('sorts by version whatever order the folder lists', () => {
    const dir = writeDir({
      '0003_c.sql': header(3, 'c') + 'SELECT 3;\n',
      '0001_a.sql': header(1, 'a') + 'SELECT 1;\n',
      '0002_b.sql': header(2, 'b') + 'SELECT 2;\n',
    });
    expect(loadMigrationFiles(dir).map((file) => file.name)).toEqual(['a', 'b', 'c']);
  });

  it('ignores files that are not .sql', () => {
    const dir = writeDir({ '0001_a.sql': header(1, 'a') + 'SELECT 1;\n', 'README.md': '# notes\n', '.gitkeep': '' });
    expect(loadMigrationFiles(dir)).toHaveLength(1);
  });

  it('reads the optional foreign_keys=off directive from the leading comment lines', () => {
    const dir = writeDir({
      '0001_a.sql': header(1, 'a') + 'SELECT 1;\n',
      '0002_b.sql': header(2, 'b', '-- mcs:foreign_keys=off', '-- more notes') + 'SELECT 2;\n',
    });
    expect(loadMigrationFiles(dir).map((file) => file.foreignKeysOff)).toEqual([false, true]);
  });

  it('does not read a directive that sits after the first statement', () => {
    const dir = writeDir({ '0001_a.sql': header(1, 'a') + 'SELECT 1;\n-- mcs:foreign_keys=off\n' });
    expect(loadMigrationFiles(dir)[0]?.foreignKeysOff).toBe(false);
  });

  it('answers migrations_missing for a missing or empty folder', () => {
    failure(
      () => loadMigrationFiles(pathToFileURL(`${join(tempDir('migrations').path, 'nope')}/`)),
      'migrations_missing',
    );
    failure(() => loadMigrationFiles(writeDir({})), 'migrations_missing');
    failure(() => loadMigrationFiles(writeDir({ 'README.md': 'only notes' })), 'migrations_missing');
  });

  it('answers migration_gap for a version that is missing, duplicated or does not start at 1', () => {
    const one = header(1, 'a') + 'SELECT 1;\n';
    failure(
      () => loadMigrationFiles(writeDir({ '0001_a.sql': one, '0003_c.sql': header(3, 'c') + 'SELECT 1;\n' })),
      'migration_gap',
    );
    failure(() => loadMigrationFiles(writeDir({ '0002_b.sql': header(2, 'b') + 'SELECT 1;\n' })), 'migration_gap');
    failure(
      () => loadMigrationFiles(writeDir({ '0001_a.sql': one, '0001_other.sql': header(1, 'other') + 'SELECT 1;\n' })),
      'migration_gap',
    );
  });

  it('refuses a file name that does not match the pattern, naming the file but no SQL', () => {
    const bad = ['0001_Bad.sql', '1_a.sql', '0001-a.sql', '0001_.sql', `0001_${'a'.repeat(49)}.sql`, '0001_a.SQL'];
    for (const name of bad) {
      const error = failure(
        () => loadMigrationFiles(writeDir({ [name]: header(1, 'a') + 'SELECT secret_marker;\n' })),
        'migration_failed',
      );
      expect(error.message).not.toContain('secret_marker');
    }
  });

  it('refuses a header that is missing or disagrees with the file name', () => {
    const cases: Record<string, string> = {
      'no header': 'SELECT 1;\n',
      'other first line': '-- hello\nSELECT 1;\n',
      'wrong version': header(2, 'a') + 'SELECT 1;\n',
      'wrong name': header(1, 'b') + 'SELECT 1;\n',
      'extra text': '-- mcs:migration version=1 name=a extra\nSELECT 1;\n',
      'upper case name': '-- mcs:migration version=1 name=A\nSELECT 1;\n',
    };
    for (const sql of Object.values(cases)) {
      failure(() => loadMigrationFiles(writeDir({ '0001_a.sql': sql })), 'migration_failed');
    }
  });

  it('refuses a foreign_keys directive value other than off', () => {
    failure(
      () => loadMigrationFiles(writeDir({ '0001_a.sql': header(1, 'a', '-- mcs:foreign_keys=on') + 'SELECT 1;\n' })),
      'migration_failed',
    );
  });
});

describe('migrationStatus (03 4.3)', () => {
  it('reports a file without tables as new, with every migration pending', () => {
    const files = loadMigrationFiles();
    const status = migrationStatus(memory(), files);
    expect(status).toEqual({ dbVersion: 0, latest: files.length, pending: files, isNew: true });
  });

  it('reports a migrated database as current', () => {
    const files = loadMigrationFiles();
    const status = migrationStatus(migrated(), files);
    expect(status.isNew).toBe(false);
    expect(status.dbVersion).toBe(files.length);
    expect(status.latest).toBe(files.length);
    expect(status.pending).toEqual([]);
  });

  it('lists the shipped versions above the highest applied one as pending', () => {
    const files = loadMigrationFiles(writeDir({ '0001_initial.sql': shipped(), '0002_add_probe.sql': SECOND_OK }));
    const db = migrated(files.slice(0, 1));
    const status = migrationStatus(db, files);
    expect(status).toMatchObject({ dbVersion: 1, latest: 2, isNew: false });
    expect(status.pending.map((file) => file.version)).toEqual([2]);
  });

  it('refuses an applied migration whose shipped file changed (migration_checksum_mismatch names the version)', () => {
    const files = loadMigrationFiles();
    const db = migrated(files);
    const edited = files.map((file) => ({ ...file, checksum: sha256(`${file.sql}-- edited\n`) }));
    const error = failure(() => migrationStatus(db, edited), 'migration_checksum_mismatch');
    expect(error.version).toBe(1);
    expect(error.message).toContain('1');
  });

  it('refuses a database newer than the runtime, by a schema_migrations row and by user_version alone', () => {
    const files = loadMigrationFiles();
    const byRow = migrated(files);
    byRow
      .prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (?, ?, ?, 1, ?, 0)',
      )
      .run([99, 'future', 'a'.repeat(64), '9.9.9']);
    byRow.pragma('user_version = 99');
    failure(() => migrationStatus(byRow, files), 'db_newer_than_runtime');
    const byPragma = migrated(files);
    byPragma.pragma('user_version = 99');
    failure(() => migrationStatus(byPragma, files), 'db_newer_than_runtime');
  });

  it('refuses applied versions that are not exactly 1..max (migration_gap)', () => {
    const three = loadMigrationFiles(
      writeDir({
        '0001_initial.sql': shipped(),
        '0002_add_probe.sql': SECOND_OK,
        '0003_third.sql': `${header(3, 'third')}SELECT 3;\n`,
      }),
    );
    const db = migrated(three.slice(0, 1));
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (?, ?, ?, 1, ?, 0)',
    ).run([3, 'third', three[2]?.checksum ?? '', '3.0.0']);
    failure(() => migrationStatus(db, three), 'migration_gap');
  });

  it('refuses an applied version that no shipped file explains (migration_unknown)', () => {
    const files = loadMigrationFiles();
    const db = migrated(files);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (?, ?, ?, 1, ?, 0)',
    ).run([2, 'ghost', 'b'.repeat(64), '3.0.0']);
    const withGap: MigrationFile[] = [
      ...files,
      { version: 3, name: 'later', checksum: 'c'.repeat(64), sql: '', foreignKeysOff: false },
    ];
    failure(() => migrationStatus(db, withGap), 'migration_unknown');
  });

  it('answers db_not_mcs for a database that has tables but no schema_migrations', () => {
    const db = memory();
    db.exec('CREATE TABLE stranger (x INTEGER) STRICT');
    failure(() => migrationStatus(db, loadMigrationFiles()), 'db_not_mcs');
  });

  it('never writes: the file bytes are unchanged by a status call', () => {
    const path = join(tempDir('status').path, 'status.sqlite');
    const db = openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    const files = loadMigrationFiles();
    applyPendingMigrations(db, files, { runtimeVersion: '3.0.0', expectedInstanceId: INSTANCE_ID, now: counter() });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = sha256Bytes(readFileSync(path));
    const reader = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    migrationStatus(reader, files);
    reader.close();
    expect(sha256Bytes(readFileSync(path))).toBe(before);
  });
});

describe('applyPendingMigrations (03 4.3 migrateDb steps 2-3)', () => {
  const options = (
    now: () => number = counter(),
  ): { runtimeVersion: string; expectedInstanceId: string; now: () => number } => ({
    runtimeVersion: '3.0.0',
    expectedInstanceId: INSTANCE_ID,
    now,
  });

  it('creates the schema of a new database: bootstrap table, user_version, application_id and the meta rows of 3.3', () => {
    const files = loadMigrationFiles();
    const db = memory();
    expect(applyPendingMigrations(db, files, options(counter(1_700_000_000_000, 5)))).toEqual(
      files.map((file) => file.version),
    );
    expect(pragmaValue(db, 'user_version')).toBe(files.length);
    expect(pragmaValue(db, 'application_id')).toBe(APPLICATION_ID);
    expect(pragmaValue(db, 'foreign_key_check')).toBeUndefined();
    const meta = Object.fromEntries(
      db
        .prepare<{ key: string; value: string }>('SELECT key, value FROM meta')
        .all()
        .map((row) => [row.key, row.value]),
    );
    expect(meta).toEqual({
      instance_id: INSTANCE_ID,
      db_format: 'mcs-monitor-db',
      created_at: new Date(1_700_000_000_005).toISOString(),
      created_by_runtime: '3.0.0',
      privacy_profile: 'metadata-v1',
    });
    const row = db.prepare('SELECT * FROM schema_migrations WHERE version = 1').get();
    expect(row).toEqual({
      version: 1,
      name: 'initial',
      checksum: FROZEN_0001_SHA256,
      applied_at: 1_700_000_000_005,
      runtime_version: '3.0.0',
      duration_ms: 5,
    });
  });

  it('creates 28 own tables, schema_migrations and sqlite_sequence, and 52 indexes with the automatic ones (03 3.5, X14)', () => {
    const db = migrated();
    const count = (sql: string): number => db.prepare<{ n: number }>(sql).get()?.n ?? -1;
    expect(count("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")).toBe(30);
    expect(
      count(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'schema_migrations')",
      ),
    ).toBe(28);
    expect(count("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index'")).toBe(52);
  });

  it('applies the pending files in order and records each one', () => {
    const files = loadMigrationFiles(writeDir({ '0001_initial.sql': shipped(), '0002_add_probe.sql': SECOND_OK }));
    const db = migrated(files.slice(0, 1));
    expect(applyPendingMigrations(db, files.slice(1), options())).toEqual([2]);
    expect(pragmaValue(db, 'user_version')).toBe(2);
    expect(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'add_probe' },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'probe_two'").get()).toEqual({ n: 1 });
  });

  it('skips a migration another process applied in the meantime (re-checked inside the transaction)', () => {
    const files = loadMigrationFiles();
    const db = migrated(files);
    expect(applyPendingMigrations(db, files, options())).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: files.length });
    expect(db.prepare('SELECT count(*) AS n FROM meta').get()).toEqual({ n: 5 });
  });

  it('rolls a failing migration back as a whole and reports migration_failed with the version and SQLite code, never SQL', () => {
    const files = loadMigrationFiles(writeDir({ '0001_initial.sql': shipped(), '0002_broken.sql': SECOND_BROKEN }));
    const db = migrated(files.slice(0, 1));
    const error = failure(() => applyPendingMigrations(db, files.slice(1), options()), 'migration_failed');
    expect(error.version).toBe(2);
    expect(error.sqliteCode).toBe('SQLITE_ERROR');
    expect(error.message).not.toContain('does_not_exist');
    expect(error.message).not.toContain('INSERT');
    expect(pragmaValue(db, 'user_version')).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half_done'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    expect(pragmaValue(db, 'foreign_keys')).toBe(1);
  });

  it('keeps the migrations that already succeeded when a later one fails', () => {
    const files = loadMigrationFiles(
      writeDir({
        '0001_initial.sql': shipped(),
        '0002_add_probe.sql': SECOND_OK,
        '0003_broken.sql': SECOND_BROKEN.replace('version=2 name=broken', 'version=3 name=broken'),
      }),
    );
    const db = migrated(files.slice(0, 1));
    failure(() => applyPendingMigrations(db, files.slice(1), options()), 'migration_failed');
    expect(pragmaValue(db, 'user_version')).toBe(2);
  });

  it('turns off foreign keys outside the transaction for a table rebuild and turns them back on', () => {
    const files = loadMigrationFiles(
      writeDir({ '0001_initial.sql': shipped(), '0002_rebuild_projects.sql': SECOND_REBUILD }),
    );
    const db = migrated(files.slice(0, 1));
    db.prepare(
      "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('p', 'P', 1, 1)",
    ).run();
    db.prepare(
      'INSERT INTO sessions (session_uid, project_id, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 1, 1, 1, 1, 1)',
    ).run(['aaaaaaaa-0000-4000-8000-000000000001']);
    applyPendingMigrations(db, files.slice(1), options());
    // with foreign keys on, DROP TABLE would have set sessions.project_id to NULL (ON DELETE SET NULL)
    expect(db.prepare('SELECT project_id FROM sessions').get()).toEqual({ project_id: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM pragma_table_info('projects') WHERE name = 'note'").get()).toEqual({
      n: 1,
    });
    expect(pragmaValue(db, 'foreign_keys')).toBe(1);
  });

  it('rejects a migration that leaves a foreign key violation (migration_fk_violation) and rolls it back', () => {
    const files = loadMigrationFiles(writeDir({ '0001_initial.sql': shipped(), '0002_orphan.sql': SECOND_ORPHAN }));
    const db = migrated(files.slice(0, 1));
    const error = failure(() => applyPendingMigrations(db, files.slice(1), options()), 'migration_fk_violation');
    expect(error.version).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(pragmaValue(db, 'user_version')).toBe(1);
    expect(pragmaValue(db, 'foreign_keys')).toBe(1);
  });
});

describe('assertIdentity (DA-I3, DA-T-DB-7)', () => {
  it('accepts a database created for the expected instance', () => {
    expect(() => {
      assertIdentity(migrated(), INSTANCE_ID);
    }).not.toThrow();
  });

  it('answers db_identity_mismatch for another instance id, without naming either id', () => {
    const error = failure(() => {
      assertIdentity(migrated(), '22222222-2222-4222-8222-222222222222');
    }, 'db_identity_mismatch');
    expect(error.message).not.toContain(INSTANCE_ID);
    expect(error.message).not.toContain('22222222');
  });

  it('answers db_not_mcs when application_id is not the MCS value', () => {
    const db = migrated();
    db.pragma('application_id = 12345');
    failure(() => {
      assertIdentity(db, INSTANCE_ID);
    }, 'db_not_mcs');
  });

  it('answers db_not_mcs for a plain SQLite file and db_identity_mismatch when the meta row is gone', () => {
    const plain = memory();
    plain.exec('CREATE TABLE t (x INTEGER) STRICT');
    failure(() => {
      assertIdentity(plain, INSTANCE_ID);
    }, 'db_not_mcs');
    const noRow = migrated();
    noRow.exec("DELETE FROM meta WHERE key = 'instance_id'");
    failure(() => {
      assertIdentity(noRow, INSTANCE_ID);
    }, 'db_identity_mismatch');
  });
});
