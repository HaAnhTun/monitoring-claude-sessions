import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useTempDirs } from '@mcs/testkit';
import { Linter } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { openSqlite, pragmaValue, STATEMENT_CACHE_SIZE, toDbError, type SqlDriver, type SqlValue } from './driver.ts';
import { DbError, isDbError, type DbConstraintKind, type DbErrorCode } from './errors.ts';

const tempDir = useTempDirs();
const RUNTIME_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function memory(): SqlDriver {
  return openSqlite(':memory:', { readonly: false, fileMustExist: false, timeoutMs: 1000 });
}

function fileDb(name = 'db.sqlite'): { path: string; open: () => SqlDriver } {
  const path = join(tempDir('driver').path, name);
  return { path, open: () => openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1000 }) };
}

/** An error shaped like the ones `node:sqlite` throws (ADR 0064 decision 8). */
function sqliteError(errcode: number, message = 'low level message'): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'low level text' });
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

describe('toDbError: SQLite result codes (03 4.3, ADR 0064 decision 8)', () => {
  // [errcode, DbError code, SQLite name kept in sqliteCode, constraint kind]
  const table: readonly (readonly [number, DbErrorCode, string, DbConstraintKind?])[] = [
    [5, 'db_busy', 'SQLITE_BUSY'],
    [261, 'db_busy', 'SQLITE_BUSY_RECOVERY'],
    [517, 'db_busy', 'SQLITE_BUSY_SNAPSHOT'],
    [773, 'db_busy', 'SQLITE_BUSY_TIMEOUT'],
    [6, 'db_locked', 'SQLITE_LOCKED'],
    [262, 'db_locked', 'SQLITE_LOCKED_SHAREDCACHE'],
    [8, 'db_readonly', 'SQLITE_READONLY'],
    [1032, 'db_readonly', 'SQLITE_READONLY_DBMOVED'],
    [10, 'db_io', 'SQLITE_IOERR'],
    [778, 'db_io', 'SQLITE_IOERR_WRITE'],
    [11, 'db_corrupt', 'SQLITE_CORRUPT'],
    [267, 'db_corrupt', 'SQLITE_CORRUPT_VTAB'],
    [13, 'db_full', 'SQLITE_FULL'],
    [14, 'db_cantopen', 'SQLITE_CANTOPEN'],
    [526, 'db_cantopen', 'SQLITE_CANTOPEN_ISDIR'],
    [26, 'db_corrupt', 'SQLITE_NOTADB'],
    [19, 'db_constraint', 'SQLITE_CONSTRAINT', 'other'],
    [275, 'db_constraint', 'SQLITE_CONSTRAINT_CHECK', 'check'],
    [787, 'db_constraint', 'SQLITE_CONSTRAINT_FOREIGNKEY', 'foreignkey'],
    [1299, 'db_constraint', 'SQLITE_CONSTRAINT_NOTNULL', 'notnull'],
    [1555, 'db_constraint', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'unique'],
    [2067, 'db_constraint', 'SQLITE_CONSTRAINT_UNIQUE', 'unique'],
    [2579, 'db_constraint', 'SQLITE_CONSTRAINT_ROWID', 'unique'],
    [3091, 'db_constraint', 'SQLITE_CONSTRAINT_DATATYPE', 'datatype'],
    [1811, 'db_constraint', 'SQLITE_CONSTRAINT_TRIGGER', 'other'],
    // an extended code of primary 19 that the driver does not name: still a constraint, kind other, primary name
    [(60 << 8) | 19, 'db_constraint', 'SQLITE_CONSTRAINT', 'other'],
  ];

  for (const [errcode, code, sqliteCode, constraint] of table) {
    it(`maps errcode ${String(errcode)} to ${code} (${sqliteCode})`, () => {
      const mapped = toDbError(sqliteError(errcode));
      expect(mapped).toBeInstanceOf(DbError);
      expect(mapped.code).toBe(code);
      expect(mapped.sqliteCode).toBe(sqliteCode);
      expect(mapped.constraint).toBe(constraint);
      expect(mapped.message).toContain(sqliteCode);
    });
  }

  it('maps every other SQLite code to db_io and keeps a SQLITE_* name for diagnosis', () => {
    const others: readonly (readonly [number, string])[] = [
      [1, 'SQLITE_ERROR'],
      [21, 'SQLITE_MISUSE'],
      [7, 'SQLITE_NOMEM'],
      [3, 'SQLITE_PERM'],
      [17, 'SQLITE_SCHEMA'],
      [25, 'SQLITE_RANGE'],
      [(9 << 8) | 1, 'SQLITE_ERROR'],
      [99, 'SQLITE_UNKNOWN'],
    ];
    for (const [errcode, sqliteCode] of others) {
      const mapped = toDbError(sqliteError(errcode));
      expect(mapped.code, String(errcode)).toBe('db_io');
      expect(mapped.sqliteCode, String(errcode)).toBe(sqliteCode);
      expect(mapped.constraint).toBeUndefined();
    }
  });

  it('maps a node:sqlite error without a usable errcode to db_io and does not keep it (its message can hold data)', () => {
    for (const errcode of [undefined, 'SQLITE_BUSY', 0, 1.5]) {
      const original = Object.assign(new Error('UNIQUE constraint failed: t.secret'), {
        code: 'ERR_SQLITE_ERROR',
        errcode,
      });
      const mapped = toDbError(original);
      expect(mapped.code).toBe('db_io');
      expect(mapped.sqliteCode).toBeUndefined();
      expect(mapped.cause).toBeUndefined();
      expect(mapped.message).not.toContain('secret');
    }
  });

  it('does not take an error with a string SQLITE_* code (the old driver shape) for a SQLite error', () => {
    const original = Object.assign(new Error('old driver'), { code: 'SQLITE_BUSY' });
    const mapped = toDbError(original);
    expect(mapped.code).toBe('db_io');
    expect(mapped.sqliteCode).toBeUndefined();
    expect(mapped.cause).toBe(original);
  });

  it('maps an error that is not from SQLite to db_io and keeps it as the cause', () => {
    const original = new TypeError('not a sqlite error');
    const mapped = toDbError(original);
    expect(mapped.code).toBe('db_io');
    expect(mapped.sqliteCode).toBeUndefined();
    expect(mapped.cause).toBe(original);
    expect(toDbError('plain string').code).toBe('db_io');
    expect(toDbError(undefined).code).toBe('db_io');
  });

  it('returns a DbError unchanged', () => {
    const original = new DbError('db_corrupt', 'corrupt');
    expect(toDbError(original)).toBe(original);
  });

  it('never copies the SQLite message into the DbError message (it can name data)', () => {
    for (const errcode of [2067, 275, 1, 14]) {
      const mapped = toDbError(sqliteError(errcode, 'UNIQUE constraint failed: events.event_uid SECRET-VALUE'));
      expect(mapped.message).not.toContain('SECRET-VALUE');
      expect(mapped.message).not.toContain('event_uid');
      expect(mapped.cause).toBeUndefined();
    }
  });
});

describe('toDbError: real SQLite errors', () => {
  it('maps constraint violations of a STRICT table to db_constraint with the right kind', () => {
    const db = memory();
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        u TEXT UNIQUE,
        n TEXT NOT NULL DEFAULT 'x',
        c INTEGER CHECK (c IS NULL OR c > 0),
        p INTEGER REFERENCES parent(id)
      ) STRICT;`);
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("INSERT INTO t (id, u) VALUES (1, 'a')").run();
    const probes: readonly (readonly [string, DbConstraintKind])[] = [
      ["INSERT INTO t (id, u) VALUES (2, 'a')", 'unique'],
      ["INSERT INTO t (id, u) VALUES (1, 'b')", 'unique'],
      ['INSERT INTO t (id, n) VALUES (3, NULL)', 'notnull'],
      ['INSERT INTO t (id, c) VALUES (4, 0)', 'check'],
      ['INSERT INTO t (id, p) VALUES (5, 99)', 'foreignkey'],
      ["INSERT INTO t (id, c) VALUES (6, 'yesterday')", 'datatype'],
    ];
    for (const [sql, kind] of probes) {
      const error = failure(() => db.prepare(sql).run());
      expect(error.code, sql).toBe('db_constraint');
      expect(error.constraint, sql).toBe(kind);
    }
    db.close();
  });

  it('maps a busy database to db_busy', () => {
    const holder = fileDb().open();
    holder.exec('CREATE TABLE t (x INTEGER) STRICT');
    holder.transaction(() => {
      const second = openSqlite(holder.path, { readonly: false, fileMustExist: false, timeoutMs: 1 });
      try {
        expect(failure(() => second.transaction(() => 1, 'immediate')).code).toBe('db_busy');
      } finally {
        second.close();
      }
    }, 'immediate');
    holder.close();
  });

  it('maps a missing file with fileMustExist to db_cantopen', () => {
    const path = join(tempDir('driver').path, 'missing.sqlite');
    const readOnly = failure(() => openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1 }));
    expect(readOnly.code).toBe('db_cantopen');
    expect(readOnly.sqliteCode).toBe('SQLITE_CANTOPEN');
    const readWrite = failure(() => openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1 }));
    expect(readWrite.code).toBe('db_cantopen');
    expect(readWrite.sqliteCode).toBe('SQLITE_CANTOPEN');
    expect(readWrite.message).toBe(readOnly.message);
  });

  it('creates nothing when fileMustExist refuses a missing read-write path', () => {
    const path = join(tempDir('driver').path, 'missing.sqlite');
    failure(() => openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1 }));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it('creates the file when fileMustExist is false', () => {
    const path = join(tempDir('driver').path, 'created.sqlite');
    openSqlite(path, { readonly: false, fileMustExist: false, timeoutMs: 1 }).close();
    expect(existsSync(path)).toBe(true);
  });

  it('maps a directory to db_cantopen', () => {
    const dir = tempDir('driver').path;
    for (const readonly of [false, true]) {
      expect(failure(() => openSqlite(dir, { readonly, fileMustExist: true, timeoutMs: 1 })).code).toBe('db_cantopen');
    }
  });

  it('maps a write on a read-only connection to db_readonly', () => {
    const { path, open } = fileDb();
    const writer = open();
    writer.exec('CREATE TABLE t (x INTEGER) STRICT');
    writer.close();
    const reader = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(reader.readonly).toBe(true);
    expect(failure(() => reader.prepare('INSERT INTO t (x) VALUES (1)').run()).code).toBe('db_readonly');
    reader.close();
  });

  it('maps a file that is not a database to db_corrupt', () => {
    const path = join(tempDir('driver').path, 'garbage.sqlite');
    writeFileSync(path, Buffer.alloc(8192, 0x41));
    const error = failure(() => {
      const db = openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1000 });
      try {
        db.exec('SELECT count(*) FROM sqlite_schema');
      } finally {
        db.close();
      }
    });
    expect(error.code).toBe('db_corrupt');
  });
});

describe('SqlDriver (03 4.5)', () => {
  it('exposes path and readonly, and prepares, runs, reads and executes', () => {
    const { path, open } = fileDb();
    const db = open();
    expect(db.path).toBe(path);
    expect(db.readonly).toBe(false);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER) STRICT');
    const insert = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)');
    expect(insert.run(['a', 1])).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(insert.run(['b', 2]).lastInsertRowid).toBe(2);
    expect(db.prepare<{ name: string }>('SELECT name FROM t WHERE id = ?').get([2])).toEqual({ name: 'b' });
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get([99])).toBeUndefined();
    expect(db.prepare<{ id: number }>('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
    db.close();
  });

  it('binds named parameters with every SQLite prefix and positional parameters from an array', () => {
    const db = memory();
    db.exec('CREATE TABLE t (a INTEGER, b TEXT) STRICT');
    db.prepare('INSERT INTO t (a, b) VALUES (@a, :b)').run({ a: 1, b: 'x' });
    db.prepare('INSERT INTO t (a, b) VALUES ($a, $b)').run({ a: 2, b: 'y' });
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run([3, 'z']);
    expect(db.prepare('SELECT a, b FROM t ORDER BY a').all()).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
      { a: 3, b: 'z' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM t WHERE a > ?').get([1])).toEqual({ n: 2 });
    db.close();
  });

  it('round-trips null, bigint, text and bytes', () => {
    const db = memory();
    db.exec('CREATE TABLE t (i INTEGER, s TEXT, b BLOB, absent TEXT) STRICT');
    const values: SqlValue[] = [42n, 'text', Uint8Array.from([1, 2, 3, 255]), null];
    db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)').run(values);
    const row = db.prepare<{ i: number; s: string; b: Uint8Array; absent: null }>('SELECT * FROM t').get();
    expect(row?.i).toBe(42);
    expect(row?.s).toBe('text');
    expect(row?.b).toBeInstanceOf(Uint8Array);
    expect([...(row?.b ?? [])]).toEqual([1, 2, 3, 255]);
    expect(row?.absent).toBeNull();
    db.close();
  });

  it('caches prepared statements by SQL text', () => {
    const db = memory();
    expect(db.prepare('SELECT 1 AS one')).toBe(db.prepare('SELECT 1 AS one'));
    expect(db.prepare('SELECT 1 AS one')).not.toBe(db.prepare('SELECT 2 AS two'));
    db.close();
  });

  it('evicts the least recently used statement beyond 200', () => {
    expect(STATEMENT_CACHE_SIZE).toBe(200);
    const db = memory();
    const sql = (i: number): string => `SELECT ${String(i)} AS v`;
    const first = db.prepare(sql(0));
    const second = db.prepare(sql(1));
    for (let i = 2; i < STATEMENT_CACHE_SIZE; i += 1) db.prepare(sql(i));
    expect(db.prepare(sql(0))).toBe(first); // touching statement 0 makes statement 1 the least recently used
    db.prepare(sql(STATEMENT_CACHE_SIZE));
    expect(db.prepare(sql(0))).toBe(first);
    expect(db.prepare(sql(1))).not.toBe(second);
    db.close();
  });

  it('does not expose iterate(): long reads page by keyset', () => {
    const db = memory();
    expect('iterate' in db).toBe(false);
    expect('iterate' in db.prepare('SELECT 1')).toBe(false);
    db.close();
  });

  it('turns a SQLite failure into a DbError at prepare time as well', () => {
    const db = memory();
    const syntax = failure(() => db.prepare('SELEKT 1'));
    expect(syntax.code).toBe('db_io');
    expect(syntax.sqliteCode).toBe('SQLITE_ERROR');
    expect(isDbError(syntax, 'db_io')).toBe(true);
    expect(
      failure(() => {
        db.exec('CREATE TABLE');
      }).sqliteCode,
    ).toBe('SQLITE_ERROR');
    db.close();
  });

  it('lets an error that is not from SQLite pass through untouched', () => {
    const db = memory();
    // node:sqlite refuses an integer it cannot represent as a number (ERR_OUT_OF_RANGE): a programming error
    expect(() => db.prepare('SELECT 9007199254740993 AS n').get()).toThrow(RangeError);
    db.close();
  });

  it('maps too many positional values to db_io (SQLITE_RANGE)', () => {
    const db = memory();
    const error = failure(() => db.prepare('SELECT ?').get([1, 2]));
    expect(error.code).toBe('db_io');
    expect(error.sqliteCode).toBe('SQLITE_RANGE');
    db.close();
  });

  describe('transaction()', () => {
    it('commits when the callback returns and returns its value', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      expect(db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run().changes)).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
      db.close();
    });

    it('rolls back and rethrows the original error when the callback throws', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      const boom = new Error('boom');
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (1)').run();
          throw boom;
        }),
      ).toThrow(boom);
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });

    it('uses savepoints when nested: the inner failure undoes only the inner work', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        expect(() =>
          db.transaction(() => {
            db.prepare('INSERT INTO t VALUES (2)').run();
            throw new Error('inner');
          }),
        ).toThrow('inner');
        db.prepare('INSERT INTO t VALUES (3)').run();
      });
      expect(db.prepare('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 3 }]);
      db.close();
    });

    it('leaves the outer transaction usable after a savepoint failure, two levels deep', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      const insert = (x: number): void => {
        db.prepare('INSERT INTO t VALUES (?)').run([x]);
      };
      db.transaction(() => {
        insert(1);
        db.transaction(() => {
          insert(2);
          expect(() =>
            db.transaction(() => {
              insert(3);
              throw new Error('deepest');
            }),
          ).toThrow('deepest');
          insert(4);
        });
        expect(() =>
          db.transaction(() => {
            insert(5);
            throw new Error('second');
          }, 'immediate'),
        ).toThrow('second');
        insert(6);
      });
      expect(db.prepare('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 2 }, { x: 4 }, { x: 6 }]);
      expect(db.transaction(() => db.prepare('SELECT count(*) AS n FROM t').get())).toEqual({ n: 4 });
      db.close();
    });

    it('rolls back an inner savepoint that was released when the outer callback throws afterwards', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      expect(() =>
        db.transaction(() => {
          db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run());
          throw new Error('after the inner commit');
        }),
      ).toThrow('after the inner commit');
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });

    it('rethrows the original error when the rollback itself fails (closed connection)', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      const boom = new Error('original');
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (1)').run();
          db.close(); // the rollback that follows cannot run on a closed connection
          throw boom;
        }),
      ).toThrow(boom);
    });

    it('rethrows the original error when the savepoint is gone before its rollback', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      const boom = new Error('original');
      db.transaction(() => {
        expect(() =>
          db.transaction(() => {
            db.exec('RELEASE mcs_1'); // ROLLBACK TO of this savepoint then fails with SQLITE_ERROR
            throw boom;
          }),
        ).toThrow(boom);
        db.prepare('INSERT INTO t VALUES (1)').run();
      });
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
      db.close();
    });

    it('maps a SQLite failure inside the callback to a DbError and rolls back', () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER PRIMARY KEY) STRICT');
      const error = failure(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (1)').run();
          return db.prepare('INSERT INTO t VALUES (1)').run();
        }),
      );
      expect(error.constraint).toBe('unique');
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });

    it('refuses a callback that returns a promise (DA-I12) and rolls back its synchronous part', async () => {
      const db = memory();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      expect(() =>
        db.transaction(async () => {
          db.prepare('INSERT INTO t VALUES (1)').run();
          await Promise.resolve();
          db.prepare('INSERT INTO t VALUES (2)').run();
        }),
      ).toThrow(TypeError);
      // checked before any microtask runs: the synchronous insert was undone
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      // let the abandoned continuation settle before the connection closes (its rejection, if any, must not escape)
      await Promise.resolve();
      await Promise.resolve();
      db.close();
    });

    it('takes the write lock at once in immediate mode and not in deferred mode', () => {
      const { path, open } = fileDb();
      const first = open();
      first.exec('CREATE TABLE t (x INTEGER) STRICT');
      const second = openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1 });
      first.transaction(() => {
        expect(failure(() => second.transaction(() => 1, 'immediate')).code).toBe('db_busy');
        expect(second.transaction(() => 7, 'deferred')).toBe(7); // deferred takes no lock before the first statement
      }, 'immediate');
      second.close();
      first.close();
    });
  });

  describe('pragma()', () => {
    it('returns the rows of a pragma, and pragmaValue reads the first value', () => {
      const db = memory();
      expect(db.pragma('user_version')).toEqual([{ user_version: 0 }]);
      db.pragma('user_version = 7');
      expect(pragmaValue(db, 'user_version')).toBe(7);
      expect(pragmaValue(db, 'application_id')).toBe(0);
      db.close();
    });

    it('returns undefined from pragmaValue for a pragma without rows', () => {
      const db = memory();
      expect(pragmaValue(db, 'foreign_key_check')).toBeUndefined();
      db.close();
    });
  });

  describe('backupTo()', () => {
    it('copies a database through the SQLite online backup API and reports progress', async () => {
      const source = fileDb('source.sqlite');
      const db = source.open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, payload BLOB) STRICT');
      const insert = db.prepare('INSERT INTO t (payload) VALUES (?)');
      db.transaction(() => {
        for (let i = 0; i < 1500; i += 1) insert.run([new Uint8Array(1024)]);
      });
      const target = join(dirname(source.path), 'copy.sqlite');
      const steps: { totalPages: number; remainingPages: number }[] = [];
      await db.backupTo(target, (progress) => steps.push(progress));
      expect(steps.length).toBeGreaterThan(1);
      expect(steps.every((step) => step.totalPages > 0 && step.remainingPages >= 0)).toBe(true);
      db.close();
      const copy = openSqlite(target, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
      expect(copy.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1500 });
      expect(pragmaValue(copy, 'quick_check')).toBe('ok');
      copy.close();
    });

    it('maps a failure of the online backup to a DbError and leaves the source usable', async () => {
      const source = fileDb('source.sqlite');
      const db = source.open();
      db.exec('CREATE TABLE t (x INTEGER) STRICT');
      const missingFolder = join(dirname(source.path), 'no-such-folder', 'copy.sqlite');
      const error: unknown = await db.backupTo(missingFolder).then(
        () => undefined,
        (failed: unknown) => failed,
      );
      expect(isDbError(error, 'db_cantopen')).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });
  });

  it('close() is idempotent and a closed driver refuses statements', () => {
    const db = memory();
    const kept = db.prepare('SELECT 1 AS one');
    db.close();
    db.close();
    expect(() => db.prepare('SELECT 1 AS one')).toThrow();
    expect(() => kept.get()).toThrow();
    expect(() => {
      db.exec('SELECT 1');
    }).toThrow();
  });

  it('close() in the middle of a transaction discards its work', () => {
    const { path, open } = fileDb();
    const db = open();
    db.exec('CREATE TABLE t (x INTEGER) STRICT');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        db.close();
        throw new Error('stop');
      }),
    ).toThrow('stop');
    const again = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(again.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    again.close();
  });
});

describe('driver boundary (DA-T-DB-18, 03 4.5, ADR 0020, ADR 0064, I-14)', () => {
  // Module names are assembled from parts: scripts/check-deps.mjs scans source text with a regex and must not take the
  // text of a probe for a real import.
  const MODULE = ['node', 'sqlite'].join(':');
  const LEGACY = ['better', 'sqlite3'].join('-');
  const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.vite']);

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(full));
      else if (/[.](?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(full);
    }
    return found;
  }

  /**
   * True when the source really loads `module`: an import or export declaration (type-only included), `import x =
   * require()`, or any call whose first argument is the module name (`require()`, `import()`,
   * `createRequire(...)(...)`, a stored `createRequire` result, `process.getBuiltinModule()`). Strings and comments do
   * not count.
   */
  function importsModule(fileName: string, source: string, module: string): boolean {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const isModule = (node: ts.Node | undefined): boolean =>
      node !== undefined && ts.isStringLiteralLike(node) && node.text === module;
    const visit = (node: ts.Node): boolean => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isModule(node.moduleSpecifier)) return true;
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isModule(node.moduleReference.expression)
      ) {
        return true;
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isModule(node.argument.literal)) {
        return true;
      }
      if (ts.isCallExpression(node) && isModule(node.arguments[0])) return true;
      return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
    };
    return visit(file);
  }

  const quoted = (name: string): string => `'${name}'`;
  const statement = (...parts: string[]): string => `${parts.join(' ')};`;

  function importForms(module: string): string[] {
    const call = (fn: string): string => `${fn}(${quoted(module)})`;
    return [
      statement('import Database', 'from', quoted(module)),
      statement('import type { DatabaseSync }', 'from', quoted(module)),
      statement('import type * as S', 'from', quoted(module)),
      statement('export { default }', 'from', quoted(module)),
      statement('const db =', call('require')),
      statement('const db = await', call('import')),
      statement('import db =', call('require')),
      statement('const db =', call('createRequire(import.meta.url)')),
      `const req = createRequire(import.meta.url);\n${statement('const db =', call('req'))}`,
      statement('const db =', call('process.getBuiltinModule')),
      statement(`type S = typeof import(${quoted(module)})`),
    ];
  }

  it('the detector finds imports in every form and ignores the module name inside a string or a comment', () => {
    for (const module of [MODULE, LEGACY]) {
      for (const form of importForms(module)) expect(importsModule('probe.ts', form, module), form).toBe(true);
      const inString = statement('const probe =', JSON.stringify(statement('import x', 'from', quoted(module))));
      expect(importsModule('probe.ts', inString, module)).toBe(false);
      const inComment = `// ${statement('import x', 'from', quoted(module))}\nexport const a = 1;\n`;
      expect(importsModule('probe.ts', inComment, module)).toBe(false);
      expect(importsModule('probe.ts', `export const name = ${quoted(module)};\n`, module)).toBe(false);
      expect(importsModule('probe.ts', statement('import x', 'from', quoted('zod')), module)).toBe(false);
    }
  });

  /** Files under packages/, tests/ and scripts/ that load each module. A file that never names it is not parsed. */
  function importersOf(modules: readonly string[]): Map<string, string[]> {
    const roots = [join(RUNTIME_ROOT, 'packages'), join(RUNTIME_ROOT, 'tests'), join(RUNTIME_ROOT, 'scripts')];
    const found = new Map<string, string[]>(modules.map((module) => [module, []]));
    for (const file of roots
      .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory() === true)
      .flatMap(sourceFiles)) {
      const source = readFileSync(file, 'utf8');
      for (const module of modules) {
        if (source.includes(module) && importsModule(file, source, module)) {
          found.get(module)?.push(relative(RUNTIME_ROOT, file).replaceAll('\\', '/'));
        }
      }
    }
    return found;
  }

  it('lets exactly one file load node:sqlite (packages/engine/src/db/driver.ts) and no file import better-sqlite3', () => {
    const importers = importersOf([MODULE, LEGACY]);
    expect(importers.get(MODULE)).toEqual(['packages/engine/src/db/driver.ts']);
    // ADR 0064: no native production dependency
    expect(importers.get(LEGACY)).toEqual([]);
  }, 60_000);

  async function lintErrors(file: string, code: string): Promise<string[]> {
    const loaded: unknown = await import(pathToFileURL(join(RUNTIME_ROOT, 'eslint.config.js')).href);
    const configs = (loaded as { default: Linter.Config[] }).default;
    expect(Array.isArray(configs)).toBe(true);
    // Only the import rule runs: the typed rules need a TypeScript program, which a virtual probe file does not have.
    const slim: Linter.Config[] = configs.map((config) => {
      const { rules, languageOptions, ...rest } = config;
      const importRule = rules?.['no-restricted-imports'];
      return {
        ...rest,
        ...(importRule === undefined ? {} : { rules: { 'no-restricted-imports': importRule } }),
        ...(languageOptions === undefined ? {} : { languageOptions: { ...languageOptions, parserOptions: {} } }),
      };
    });
    const linter = new Linter({ cwd: RUNTIME_ROOT, configType: 'flat' });
    return linter
      .verify(code, slim, { filename: join(RUNTIME_ROOT, file) })
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => `${String(message.line)}: ${message.message}`);
  }

  const PROBE = `${statement('import { DatabaseSync }', 'from', quoted(MODULE))}\nexport const probe = DatabaseSync;\n`;
  const TYPE_PROBE = `${statement('import type { DatabaseSync }', 'from', quoted(MODULE))}\nexport type Probe = DatabaseSync;\n`;
  const LEGACY_PROBE = `${statement('import Database', 'from', quoted(LEGACY))}\nexport const probe = Database;\n`;
  const ELSEWHERE = [
    'packages/engine/src/db/other.ts',
    'packages/engine/src/index.ts',
    'packages/engine/src/platform/exec.ts',
    'packages/server/src/probe.ts',
    'packages/cli/src/probe.ts',
    'packages/shared/src/probe.ts',
    'packages/shared/src/protocol/probe.ts',
  ];

  it('ESLint negative probes: importing node:sqlite is an error anywhere but in driver.ts', async () => {
    for (const file of ELSEWHERE) {
      expect(await lintErrors(file, PROBE), file).toHaveLength(1);
      expect(await lintErrors(file, TYPE_PROBE), file).toHaveLength(1);
    }
  });

  it('ESLint negative probes: importing better-sqlite3 is an error everywhere, driver.ts included', async () => {
    for (const file of [...ELSEWHERE, 'packages/engine/src/db/driver.ts']) {
      expect(await lintErrors(file, LEGACY_PROBE), file).toHaveLength(1);
    }
  });

  it('ESLint positive probe: driver.ts may import node:sqlite', async () => {
    expect(await lintErrors('packages/engine/src/db/driver.ts', PROBE)).toEqual([]);
    expect(await lintErrors('packages/engine/src/db/driver.ts', TYPE_PROBE)).toEqual([]);
  });
});
