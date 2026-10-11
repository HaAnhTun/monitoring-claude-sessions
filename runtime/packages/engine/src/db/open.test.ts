import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { APPLICATION_ID, WAL_RETRY } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { openSqlite, pragmaValue, type SqlDriver } from './driver.ts';
import { DB_ERROR_CODES, DbError, type DbErrorCode } from './errors.ts';
import { DB_OPEN_EXIT_CODES, enableWal, openInstanceDb, type OpenMode } from './open.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function dbPath(): string {
  return join(tempDir('open').path, 'monitor.db');
}

function open(
  path: string,
  mode: OpenMode = 'serve',
  extra: { instanceId?: string } = {},
): ReturnType<typeof openInstanceDb> {
  return openInstanceDb({ path, expectedInstanceId: extra.instanceId ?? INSTANCE_ID, mode, runtimeVersion: '3.0.0' });
}

function failure(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected the call to throw a DbError');
}

/** A driver whose `pragma('journal_mode = WAL')` fails `busyTimes` times with `code`, then answers `answer`. */
function walStub(
  busyTimes: number,
  code: DbErrorCode = 'db_busy',
  answer = 'wal',
): { driver: SqlDriver; calls: () => number } {
  let calls = 0;
  const unused = (): never => {
    throw new Error('not used by enableWal');
  };
  const driver: SqlDriver = {
    path: 'stub',
    readonly: false,
    prepare: unused,
    exec: unused,
    transaction: unused,
    backupTo: unused,
    close: unused,
    pragma: (text) => {
      expect(text).toBe('journal_mode = WAL');
      calls += 1;
      if (calls <= busyTimes) throw new DbError(code, 'stub failure');
      return [{ journal_mode: answer }];
    },
  };
  return { driver, calls: () => calls };
}

describe('DB_OPEN_EXIT_CODES (03 3.2, ADR 0021)', () => {
  it('maps identity failures to 11, a newer database to 15, an older one to 16 and every other failure to 14', () => {
    const expected: Partial<Record<DbErrorCode, 11 | 15 | 16>> = {
      db_identity_mismatch: 11,
      db_not_mcs: 11,
      db_newer_than_runtime: 15,
      migration_unknown: 15,
      db_migration_required: 16,
    };
    expect(Object.keys(DB_OPEN_EXIT_CODES).sort()).toEqual([...DB_ERROR_CODES].sort());
    for (const code of DB_ERROR_CODES) expect(DB_OPEN_EXIT_CODES[code], code).toBe(expected[code] ?? 14);
  });
});

describe('enableWal (03 3.2 step 3, DA-T-DB-15)', () => {
  it('succeeds at once when the database accepts WAL', () => {
    const { driver, calls } = walStub(0);
    const sleeps: number[] = [];
    enableWal(driver, (ms) => sleeps.push(ms));
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a busy switch with a 25 ms pause and succeeds on the 4th attempt after 3 busy answers', () => {
    const { driver, calls } = walStub(3);
    const sleeps: number[] = [];
    enableWal(driver, (ms) => sleeps.push(ms));
    expect(calls()).toBe(4);
    expect(sleeps).toEqual([WAL_RETRY.delayMs, WAL_RETRY.delayMs, WAL_RETRY.delayMs]);
  });

  it('fails with db_busy after 20 attempts (21 busy answers are never reached)', () => {
    const { driver, calls } = walStub(21);
    const sleeps: number[] = [];
    const error = failure(() => {
      enableWal(driver, (ms) => sleeps.push(ms));
    });
    expect(error.code).toBe('db_busy');
    expect(calls()).toBe(WAL_RETRY.attempts);
    expect(sleeps).toHaveLength(WAL_RETRY.attempts - 1);
  });

  it('does not retry an error that is not a busy answer', () => {
    const { driver, calls } = walStub(5, 'db_readonly');
    expect(
      failure(() => {
        enableWal(driver, () => undefined);
      }).code,
    ).toBe('db_readonly');
    expect(calls()).toBe(1);
  });

  it('fails with db_io when the location cannot hold a WAL database', () => {
    const { driver } = walStub(0, 'db_busy', 'delete');
    expect(
      failure(() => {
        enableWal(driver, () => undefined);
      }).code,
    ).toBe('db_io');
  });

  it('really sleeps (blocking) between attempts when no sleeper is injected', () => {
    const { driver } = walStub(1);
    const started = performance.now();
    enableWal(driver);
    expect(performance.now() - started).toBeGreaterThanOrEqual(WAL_RETRY.delayMs - 5);
  });
});

describe('openInstanceDb: modes (03 4.5)', () => {
  it('serve creates a missing file at the latest schema with the identity of the instance', () => {
    const path = dbPath();
    const db = open(path);
    expect(existsSync(path)).toBe(true);
    expect(db.mode).toBe('serve');
    expect(db.instanceId).toBe(INSTANCE_ID);
    expect(db.driver.readonly).toBe(false);
    expect(pragmaValue(db.driver, 'application_id')).toBe(APPLICATION_ID);
    expect(pragmaValue(db.driver, 'user_version')).toBeGreaterThanOrEqual(1);
    expect(db.driver.prepare('SELECT value FROM meta WHERE key = ?').get(['instance_id'])).toEqual({
      value: INSTANCE_ID,
    });
    db.close();
  });

  it('serve opens an existing database of the same instance and the same schema', () => {
    const path = dbPath();
    open(path).close();
    const again = open(path);
    expect(again.driver.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    again.close();
  });

  it('serve adopts an existing empty file as a new database', () => {
    const path = dbPath();
    writeFileSync(path, '');
    const db = open(path);
    expect(pragmaValue(db.driver, 'application_id')).toBe(APPLICATION_ID);
    db.close();
  });

  it.each(['readonly', 'maintenance'] as const)(
    '%s needs an existing file: a missing one is db_cantopen (exit 14)',
    (mode) => {
      const error = failure(() => open(dbPath(), mode));
      expect(error.code).toBe('db_cantopen');
      expect(DB_OPEN_EXIT_CODES[error.code]).toBe(14);
    },
  );

  it.each(['readonly', 'maintenance'] as const)('%s refuses an empty file it did not create (db_not_mcs)', (mode) => {
    const path = dbPath();
    writeFileSync(path, '');
    expect(failure(() => open(path, mode)).code).toBe('db_not_mcs');
  });

  it('readonly opens a database of the same instance, never writes and refuses writes with db_readonly', () => {
    const path = dbPath();
    open(path).close();
    const db = open(path, 'readonly');
    expect(db.mode).toBe('readonly');
    expect(db.driver.readonly).toBe(true);
    expect(pragmaValue(db.driver, 'query_only')).toBe(1);
    expect(failure(() => db.driver.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run()).code).toBe(
      'db_readonly',
    );
    db.close();
  });

  it('maintenance is a writer on an existing database', () => {
    const path = dbPath();
    open(path).close();
    const db = open(path, 'maintenance');
    expect(db.driver.readonly).toBe(false);
    db.driver.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run();
    db.close();
  });
});

describe('openInstanceDb: identity (DA-I3, DA-T-DB-7)', () => {
  it('refuses another instance id with db_identity_mismatch (exit 11) in every mode', () => {
    const path = dbPath();
    open(path).close();
    for (const mode of ['serve', 'readonly', 'maintenance'] as const) {
      const error = failure(() => open(path, mode, { instanceId: OTHER_INSTANCE_ID }));
      expect(error.code, mode).toBe('db_identity_mismatch');
      expect(DB_OPEN_EXIT_CODES[error.code]).toBe(11);
    }
  });

  it('refuses a SQLite file with another application_id with db_not_mcs (exit 11)', () => {
    const path = dbPath();
    const stranger = openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    stranger.exec('CREATE TABLE t (x INTEGER) STRICT');
    stranger.pragma('application_id = 42');
    stranger.close();
    for (const mode of ['serve', 'readonly', 'maintenance'] as const) {
      const error = failure(() => open(path, mode));
      expect(error.code, mode).toBe('db_not_mcs');
      expect(DB_OPEN_EXIT_CODES[error.code]).toBe(11);
    }
  });

  it('refuses a file that is not a database at all with db_corrupt (exit 14)', () => {
    const path = dbPath();
    writeFileSync(path, Buffer.alloc(8192, 0x41));
    const error = failure(() => open(path, 'serve'));
    expect(error.code).toBe('db_corrupt');
    expect(DB_OPEN_EXIT_CODES[error.code]).toBe(14);
  });

  it('assertScope accepts the instance of the database and refuses any other with scope_mismatch', () => {
    const db = open(dbPath());
    expect(() => {
      db.assertScope({ instanceId: INSTANCE_ID });
    }).not.toThrow();
    const error = failure(() => {
      db.assertScope({ instanceId: OTHER_INSTANCE_ID });
    });
    expect(error.code).toBe('scope_mismatch');
    expect(error.message).not.toContain(OTHER_INSTANCE_ID);
    db.close();
  });

  it('leaves a refused file behind unchanged and closes the connection it opened', () => {
    const path = dbPath();
    open(path).close();
    const before = readFileSync(path);
    expect(failure(() => open(path, 'serve', { instanceId: OTHER_INSTANCE_ID })).code).toBe('db_identity_mismatch');
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('openInstanceDb: pragmas (03 3.2, ADR 0020)', () => {
  it('sets WAL, incremental auto-vacuum and the connection pragmas on a writer', () => {
    const db = open(dbPath());
    const value = (name: string): unknown => pragmaValue(db.driver, name);
    expect(value('journal_mode')).toBe('wal');
    expect(value('auto_vacuum')).toBe(2);
    expect(value('synchronous')).toBe(1);
    expect(value('foreign_keys')).toBe(1);
    expect(value('temp_store')).toBe(2);
    expect(value('cache_size')).toBe(-16000);
    expect(value('journal_size_limit')).toBe(67108864);
    expect(value('query_only')).toBe(0);
    db.close();
  });

  it('keeps the journal mode and the schema of a read-only connection as they are', () => {
    const path = dbPath();
    open(path).close();
    const db = open(path, 'readonly');
    expect(pragmaValue(db.driver, 'journal_mode')).toBe('wal');
    expect(pragmaValue(db.driver, 'foreign_keys')).toBe(1);
    db.close();
  });
});

describe('InstanceDb', () => {
  it('has a new 8-hex epoch for every open', () => {
    const path = dbPath();
    const first = open(path);
    const second = open(path, 'readonly');
    expect(first.epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(second.epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(first.epoch).not.toBe(second.epoch);
    second.close();
    first.close();
  });

  it('reads headSeq from sqlite_sequence of the changes table: 0 while empty, the last seq afterwards', () => {
    const db = open(dbPath());
    expect(db.headSeq()).toBe(0);
    db.driver.exec("INSERT INTO changes (at, kind, op) VALUES (1, 'health', 'upsert'), (2, 'health', 'upsert')");
    expect(db.headSeq()).toBe(2);
    db.driver.exec('DELETE FROM changes');
    expect(db.headSeq()).toBe(2); // valid after pruning: AUTOINCREMENT never reuses a seq
    db.close();
  });

  it('reads the clock option for created_at and exposes it', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openInstanceDb({
      path: dbPath(),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock,
    });
    expect(db.clock).toBe(clock);
    expect(db.driver.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()).toEqual({
      value: new Date(FIXTURE_EPOCH_MS).toISOString(),
    });
    db.close();
  });

  it('close() is idempotent', () => {
    const db = open(dbPath());
    db.close();
    expect(() => {
      db.close();
    }).not.toThrow();
  });

  it('closes a writer cleanly: the WAL is folded back so the file is complete on its own', () => {
    const path = dbPath();
    const db = open(path);
    db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'kept')");
    db.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    const reader = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(reader.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({ value: 'kept' });
    reader.close();
  });
});

describe('openInstanceDb: shipped migrations folder', () => {
  it('fails with migrations_missing when the folder given is empty', () => {
    const dir = tempDir('open').path;
    mkdirSync(join(dir, 'none'));
    const error = failure(() =>
      openInstanceDb({
        path: dbPath(),
        expectedInstanceId: INSTANCE_ID,
        mode: 'serve',
        runtimeVersion: '3.0.0',
        migrationsDir: pathToFileURL(`${join(dir, 'none')}/`),
      }),
    );
    expect(error.code).toBe('migrations_missing');
    expect(DB_OPEN_EXIT_CODES[error.code]).toBe(14);
  });
});
