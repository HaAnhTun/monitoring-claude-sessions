import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useTempDirs, spawnTracked, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { openSqlite, pragmaValue } from '../src/db/driver.ts';
import { DbError } from '../src/db/errors.ts';
import * as engine from '../src/index.ts';
import { DB_OPEN_EXIT_CODES, openInstanceDb } from '../src/db/open.ts';
import { withWriteTx } from '../src/db/write.ts';

const tempDir = useTempDirs();
const FIXTURES = fileURLToPath(new URL('./fixtures/db/', import.meta.url));
const ENGINE_DIST_OPEN = fileURLToPath(new URL('../dist/db/open.js', import.meta.url));
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Written into a temp folder and run with `node`: it opens the database through the built `dist/db/open.js` (the
 * migrations folder is resolved next to dist/), waits for a common start time and reports the outcome in a JSON file.
 */
const CHILD_SCRIPT = `
import { writeFileSync } from 'node:fs';
const [openModule, dbPath, instanceId, startAt, resultPath] = process.argv.slice(2);
const result = { ok: false, code: null, message: null, epoch: null };
try {
  const { openInstanceDb } = await import(openModule);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < Number(startAt)) Atomics.wait(wait, 0, 0, 1);
  const db = openInstanceDb({ path: dbPath, expectedInstanceId: instanceId, mode: 'serve', runtimeVersion: '3.0.0' });
  result.ok = true;
  result.epoch = db.epoch;
  db.close();
} catch (error) {
  result.code = typeof error?.code === 'string' ? error.code : null;
  result.message = String(error?.message ?? error);
}
writeFileSync(resultPath, JSON.stringify(result));
`;

describe('DA-T-DB-15: the WAL switch survives a cold-start race', () => {
  it('lets four processes open one new file at the same moment: all succeed and the schema exists exactly once', async () => {
    expect(
      existsSync(ENGINE_DIST_OPEN),
      'build the engine first (npm run build): the children run dist/db/open.js',
    ).toBe(true);
    const dir = tempDir('race').path;
    const script = join(dir, 'child-open.mjs');
    writeFileSync(script, CHILD_SCRIPT);
    const dbPath = join(dir, 'monitor.db');
    const startAt = Date.now() + 2500;
    const results = [0, 1, 2, 3].map((index) => join(dir, `result-${String(index)}.json`));
    const children = results.map((resultPath) =>
      spawnTracked(process.execPath, [
        script,
        pathToFileURL(ENGINE_DIST_OPEN).href,
        dbPath,
        INSTANCE_ID,
        String(startAt),
        resultPath,
      ]),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    const outcomes = await Promise.all(
      results.map((resultPath) =>
        waitFor(() =>
          existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>) : null,
        ),
      ),
    );
    for (const outcome of outcomes) expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    expect(new Set(outcomes.map((outcome) => outcome['epoch'])).size).toBe(4);

    const db = openInstanceDb({
      path: dbPath,
      expectedInstanceId: INSTANCE_ID,
      mode: 'readonly',
      runtimeVersion: '3.0.0',
    });
    expect(db.driver.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    expect(db.driver.prepare('SELECT count(*) AS n FROM meta').get()).toEqual({ n: 5 });
    expect(pragmaValue(db.driver, 'user_version')).toBe(1);
    expect(pragmaValue(db.driver, 'journal_mode')).toBe('wal');
    expect(pragmaValue(db.driver, 'quick_check')).toBe('ok');
    db.close();
  }, 30_000);
});

describe('migrations are resolved next to dist/ (03 4.1, verifier line of WP-09)', () => {
  it('finds 0001_initial.sql from the built module, not from the source folder', async () => {
    const built = fileURLToPath(new URL('../dist/db/migrations.js', import.meta.url));
    expect(existsSync(built), 'build the engine first (npm run build)').toBe(true);
    const loaded = (await import(pathToFileURL(built).href)) as {
      loadMigrationFiles: () => { version: number; name: string; checksum: string }[];
    };
    const files = loaded.loadMigrationFiles();
    expect(files[0]).toMatchObject({
      version: 1,
      name: 'initial',
      checksum: '46f37fde62d11692f355e178419ee52d9d70ae8910d53e42cc0435f4f6b05da3',
    });
  });
});

describe('DA-T-DB-16: read-only access never writes', () => {
  function populated(): string {
    const path = join(tempDir('readonly').path, 'monitor.db');
    const db = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'serve', runtimeVersion: '3.0.0' });
    withWriteTx(db, { instanceId: INSTANCE_ID }, (tx) => {
      db.driver.exec(
        "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('p', 'P', 1, 1)",
      );
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    db.close();
    return path;
  }

  it('leaves the file bytes and the modification time unchanged after queries', () => {
    const path = populated();
    const beforeHash = sha256(path);
    const beforeMtime = statSync(path).mtimeMs;
    const db = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'readonly', runtimeVersion: '3.0.0' });
    expect(db.headSeq()).toBe(1);
    expect(db.driver.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
    expect(db.driver.prepare('SELECT count(*) AS n FROM changes').get()).toEqual({ n: 1 });
    expect(pragmaValue(db.driver, 'quick_check')).toBe('ok');
    db.close();
    expect(sha256(path)).toBe(beforeHash);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
  });

  it('refuses a write with db_readonly and still leaves the file unchanged', () => {
    const path = populated();
    const beforeHash = sha256(path);
    const db = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'readonly', runtimeVersion: '3.0.0' });
    let error: unknown;
    try {
      db.driver.exec(
        "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('q', 'Q', 1, 1)",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('db_readonly');
    db.close();
    expect(sha256(path)).toBe(beforeHash);
  });

  it('sees what a concurrent writer commits (X1)', () => {
    const path = populated();
    const writer = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'serve', runtimeVersion: '3.0.0' });
    const reader = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'readonly', runtimeVersion: '3.0.0' });
    expect(reader.headSeq()).toBe(1);
    withWriteTx(writer, { instanceId: INSTANCE_ID }, (tx) =>
      tx.changes.reserve('attempt', 'upsert', { entityId: null, sessionUid: null }),
    );
    expect(reader.headSeq()).toBe(2);
    reader.close();
    writer.close();
  });

  it('opens a database whose -wal and -shm files were removed at the last close', () => {
    const path = populated();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    const db = openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'readonly', runtimeVersion: '3.0.0' });
    expect(db.mode).toBe('readonly');
    db.close();
  });
});

describe('released fixtures open without a migration', () => {
  it('opens a copy of v1.db for serving, reading and maintenance', () => {
    const dir = tempDir('fixture').path;
    const path = join(dir, 'monitor.db');
    copyFileSync(join(FIXTURES, 'v1.db'), path);
    const probe = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    const id = probe.prepare<{ value: string }>("SELECT value FROM meta WHERE key = 'instance_id'").get()?.value ?? '';
    probe.close();
    for (const mode of ['serve', 'readonly', 'maintenance'] as const) {
      const db = openInstanceDb({ path, expectedInstanceId: id, mode, runtimeVersion: '3.0.0' });
      expect(db.driver.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({
        n: expect.any(Number) as number,
      });
      db.close();
    }
  });
});

describe('the engine entry exports the database contract (registry 2.6)', () => {
  it('exports the names WP-09 produces', () => {
    const names = [
      'openSqlite',
      'toDbError',
      'DbError',
      'openInstanceDb',
      'DB_OPEN_EXIT_CODES',
      'migrationStatus',
      'loadMigrationFiles',
      'planDbMigrations',
      'migrateDb',
      'peekDbSchemaVersion',
      'backupDb',
      'withWriteTx',
      'onCommitted',
    ];
    for (const name of names) expect(engine, name).toHaveProperty(name);
    expect(engine.DB_OPEN_EXIT_CODES).toBe(DB_OPEN_EXIT_CODES);
  });
});

describe('writer modes against a stopped instance', () => {
  it('refuses to adopt a file with tables of its own as a new database', () => {
    const path = join(tempDir('adopt').path, 'monitor.db');
    const stranger = openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    stranger.exec('CREATE TABLE precious (x INTEGER) STRICT');
    stranger.close();
    const before = sha256(path);
    let error: unknown;
    try {
      openInstanceDb({ path, expectedInstanceId: INSTANCE_ID, mode: 'serve', runtimeVersion: '3.0.0' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('db_not_mcs');
    expect(sha256(path)).toBe(before);
  });
});
