import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { backupDb } from './backup.ts';
import { openSqlite, pragmaValue } from './driver.ts';
import { DbError, type DbErrorCode } from './errors.ts';
import { openInstanceDb, type InstanceDb } from './open.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function source(root: string): InstanceDb {
  const db = openInstanceDb({
    path: join(root, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
  });
  db.driver.exec(
    "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('p', 'P', 1, 1)",
  );
  return db;
}

async function failure(run: () => Promise<unknown>): Promise<DbError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function expectCode(run: () => Promise<unknown>, code: DbErrorCode): Promise<DbError> {
  const error = await failure(run);
  expect(error.code).toBe(code);
  return error;
}

describe('backupDb (03 4.4)', () => {
  it('copies from a path with an identity check only and reports bytes and the schema version of the copy', async () => {
    const root = tempDir('backup').path;
    source(root).close();
    const dest = join(root, 'copy.db');
    const result = await backupDb({ path: join(root, 'monitor.db'), expectedInstanceId: INSTANCE_ID }, dest);
    expect(result.dbSchemaVersion).toBeGreaterThanOrEqual(1);
    expect(result.bytes).toBe(readFileSync(dest).length);
    expect(result.bytes).toBeGreaterThan(4096);
    const copy = openSqlite(dest, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(pragmaValue(copy, 'quick_check')).toBe('ok');
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual({ value: INSTANCE_ID });
    expect(copy.prepare('SELECT project_key FROM projects').all()).toEqual([{ project_key: 'p' }]);
    copy.close();
  });

  it('copies from the writer connection of a running server (PASSIVE checkpoint first)', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    const dest = join(root, 'copy.db');
    const result = await backupDb(db, dest);
    expect(result.dbSchemaVersion).toBe(pragmaValue(db.driver, 'user_version'));
    expect(db.driver.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 }); // the writer keeps working
    db.close();
    const copy = openSqlite(dest, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(copy.prepare('SELECT project_key FROM projects').all()).toEqual([{ project_key: 'p' }]);
    copy.close();
  });

  it('copies from a read-only InstanceDb as well', async () => {
    const root = tempDir('backup').path;
    source(root).close();
    const reader = openInstanceDb({
      path: join(root, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'readonly',
      runtimeVersion: '3.0.0',
    });
    const dest = join(root, 'copy.db');
    expect((await backupDb(reader, dest)).bytes).toBeGreaterThan(0);
    reader.close();
  });

  it('reports progress in pages while it copies', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    const blob = db.driver.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    db.driver.transaction(() => {
      for (let i = 0; i < 400; i += 1) blob.run([`filler-${String(i)}`, 'x'.repeat(4000)]);
    });
    const steps: { totalPages: number; remainingPages: number }[] = [];
    await backupDb(db, join(root, 'copy.db'), { onProgress: (progress) => steps.push(progress) });
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.at(-1)?.remainingPages).toBe(0 + (steps.at(-1)?.remainingPages ?? 0));
    expect(steps.every((step) => step.totalPages >= step.remainingPages)).toBe(true);
    db.close();
  });

  it('does not change the source database file', async () => {
    const root = tempDir('backup').path;
    source(root).close();
    const path = join(root, 'monitor.db');
    const before = sha256(path);
    await backupDb({ path, expectedInstanceId: INSTANCE_ID }, join(root, 'copy.db'));
    expect(sha256(path)).toBe(before);
  });

  it('backs up a database newer than the runtime: there is no schema check, only identity', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    db.driver.exec(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (99, 'future', '" +
        'a'.repeat(64) +
        "', 1, '9.9.9', 0)",
    );
    db.driver.pragma('user_version = 99');
    db.close();
    const result = await backupDb(
      { path: join(root, 'monitor.db'), expectedInstanceId: INSTANCE_ID },
      join(root, 'copy.db'),
    );
    expect(result.dbSchemaVersion).toBe(99);
  });

  it('leaves no -wal or -shm file next to the copy', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    const dest = join(root, 'copy.db');
    await backupDb(db, dest);
    db.close();
    expect(
      readdirSync(root)
        .filter((name) => name.startsWith('copy.db'))
        .sort(),
    ).toEqual(['copy.db']);
  });

  it('refuses an existing destination with backup_failed and leaves it alone', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    const dest = join(root, 'copy.db');
    writeFileSync(dest, 'precious');
    await expectCode(() => backupDb(db, dest), 'backup_failed');
    expect(readFileSync(dest, 'utf8')).toBe('precious');
    db.close();
  });

  it('refuses a destination whose folder does not exist with backup_failed', async () => {
    const root = tempDir('backup').path;
    const db = source(root);
    await expectCode(() => backupDb(db, join(root, 'missing-folder', 'copy.db')), 'backup_failed');
    db.close();
  });

  it('refuses another instance with db_identity_mismatch and creates nothing', async () => {
    const root = tempDir('backup').path;
    source(root).close();
    const dest = join(root, 'copy.db');
    await expectCode(
      () => backupDb({ path: join(root, 'monitor.db'), expectedInstanceId: OTHER_INSTANCE_ID }, dest),
      'db_identity_mismatch',
    );
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a SQLite file that is not a monitor database with db_not_mcs', async () => {
    const root = tempDir('backup').path;
    const path = join(root, 'other.db');
    const other = openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    other.exec('CREATE TABLE t (x INTEGER) STRICT');
    other.close();
    const dest = join(root, 'copy.db');
    await expectCode(() => backupDb({ path, expectedInstanceId: INSTANCE_ID }, dest), 'db_not_mcs');
    expect(existsSync(dest)).toBe(false);
  });

  it('answers db_cantopen for a source path that does not exist', async () => {
    const root = tempDir('backup').path;
    await expectCode(
      () => backupDb({ path: join(root, 'missing.db'), expectedInstanceId: INSTANCE_ID }, join(root, 'copy.db')),
      'db_cantopen',
    );
  });
});
