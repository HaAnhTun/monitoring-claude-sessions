import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

function sqliteError(code: string, message = 'low level message'): Error {
  return Object.assign(new Error(message), { name: 'SqliteError', code });
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

describe('toDbError: SQLite error codes (03 4.3)', () => {
  const table: readonly (readonly [string, DbErrorCode, DbConstraintKind?])[] = [
    ['SQLITE_BUSY', 'db_busy'],
    ['SQLITE_BUSY_RECOVERY', 'db_busy'],
    ['SQLITE_BUSY_SNAPSHOT', 'db_busy'],
    ['SQLITE_BUSY_TIMEOUT', 'db_busy'],
    ['SQLITE_LOCKED', 'db_locked'],
    ['SQLITE_LOCKED_SHAREDCACHE', 'db_locked'],
    ['SQLITE_CORRUPT', 'db_corrupt'],
    ['SQLITE_CORRUPT_VTAB', 'db_corrupt'],
    ['SQLITE_NOTADB', 'db_corrupt'],
    ['SQLITE_READONLY', 'db_readonly'],
    ['SQLITE_READONLY_DBMOVED', 'db_readonly'],
    ['SQLITE_FULL', 'db_full'],
    ['SQLITE_IOERR', 'db_io'],
    ['SQLITE_IOERR_WRITE', 'db_io'],
    ['SQLITE_CANTOPEN', 'db_cantopen'],
    ['SQLITE_CANTOPEN_ISDIR', 'db_cantopen'],
    ['SQLITE_CONSTRAINT', 'db_constraint', 'other'],
    ['SQLITE_CONSTRAINT_UNIQUE', 'db_constraint', 'unique'],
    ['SQLITE_CONSTRAINT_PRIMARYKEY', 'db_constraint', 'unique'],
    ['SQLITE_CONSTRAINT_CHECK', 'db_constraint', 'check'],
    ['SQLITE_CONSTRAINT_FOREIGNKEY', 'db_constraint', 'foreignkey'],
    ['SQLITE_CONSTRAINT_NOTNULL', 'db_constraint', 'notnull'],
    ['SQLITE_CONSTRAINT_DATATYPE', 'db_constraint', 'datatype'],
    ['SQLITE_CONSTRAINT_TRIGGER', 'db_constraint', 'other'],
    ['SQLITE_CONSTRAINT_ROWID', 'db_constraint', 'unique'],
  ];

  for (const [sqliteCode, code, constraint] of table) {
    it(`maps ${sqliteCode} to ${code}`, () => {
      const mapped = toDbError(sqliteError(sqliteCode));
      expect(mapped).toBeInstanceOf(DbError);
      expect(mapped.code).toBe(code);
      expect(mapped.sqliteCode).toBe(sqliteCode);
      expect(mapped.constraint).toBe(constraint);
    });
  }

  it('maps every other SQLite code to db_io and keeps the code for diagnosis', () => {
    for (const sqliteCode of ['SQLITE_ERROR', 'SQLITE_MISUSE', 'SQLITE_NOMEM', 'SQLITE_PERM', 'SQLITE_SCHEMA']) {
      const mapped = toDbError(sqliteError(sqliteCode));
      expect(mapped.code).toBe('db_io');
      expect(mapped.sqliteCode).toBe(sqliteCode);
    }
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
    const mapped = toDbError(
      sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: events.event_uid SECRET-VALUE'),
    );
    expect(mapped.message).not.toContain('SECRET-VALUE');
    expect(mapped.message).not.toContain('event_uid');
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
    expect(failure(() => openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1 })).code).toBe(
      'db_cantopen',
    );
    expect(failure(() => openSqlite(path, { readonly: false, fileMustExist: true, timeoutMs: 1 })).code).toBe(
      'db_cantopen',
    );
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
    expect(() => db.prepare('SELECT ?').get([1, 2])).toThrow(RangeError);
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
      await expect(db.backupTo(missingFolder)).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });
  });

  it('close() is idempotent and a closed driver refuses statements', () => {
    const db = memory();
    db.close();
    db.close();
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
});

describe('driver boundary (DA-T-DB-18, 03 4.5, ADR 0020, I-14)', () => {
  const MODULE = ['better', 'sqlite3'].join('-');
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

  /** True when the source really imports `module`: an import or export declaration, require() or import(). Strings do not count. */
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
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        if ((isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) && isModule(node.arguments[0])) return true;
      }
      return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
    };
    return visit(file);
  }

  // Probe sources are assembled from parts: scripts/check-deps.mjs scans source text with a regex and must not take the
  // text of a probe for a real import.
  const quoted = (name: string): string => `'${name}'`;
  const call = (fn: string): string => `${fn}(${quoted(MODULE)})`;
  const statement = (...parts: string[]): string => `${parts.join(' ')};`;

  it('the detector finds imports in every form and ignores the module name inside a string', () => {
    const forms = [
      statement('import Database', 'from', quoted(MODULE)),
      statement('import type { Database }', 'from', quoted(MODULE)),
      statement('export { default }', 'from', quoted(MODULE)),
      statement('const db =', call('require')),
      statement('const db = await', call('import')),
      statement('import db =', call('require')),
    ];
    for (const form of forms) expect(importsModule('probe.ts', form, MODULE), form).toBe(true);
    const inString = statement('const probe =', JSON.stringify(statement('import x', 'from', quoted(MODULE))));
    expect(importsModule('probe.ts', inString, MODULE)).toBe(false);
    const inComment = `// ${statement('import x', 'from', quoted(MODULE))}\nexport const a = 1;\n`;
    expect(importsModule('probe.ts', inComment, MODULE)).toBe(false);
    expect(importsModule('probe.ts', statement('import x', 'from', quoted('zod')), MODULE)).toBe(false);
  });

  it('lets exactly one file import the native module: packages/engine/src/db/driver.ts', () => {
    const roots = [join(RUNTIME_ROOT, 'packages'), join(RUNTIME_ROOT, 'tests'), join(RUNTIME_ROOT, 'scripts')];
    const importers = roots
      .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory() === true)
      .flatMap(sourceFiles)
      .filter((file) => importsModule(file, readFileSync(file, 'utf8'), MODULE))
      .map((file) => relative(RUNTIME_ROOT, file).replaceAll('\\', '/'));
    expect(importers).toEqual(['packages/engine/src/db/driver.ts']);
  });

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

  const PROBE = `${statement('import Database', 'from', quoted(MODULE))}\nexport const probe = Database;\n`;

  it('ESLint negative probes: the import is an error anywhere but in driver.ts', async () => {
    for (const file of [
      'packages/engine/src/db/other.ts',
      'packages/engine/src/index.ts',
      'packages/server/src/probe.ts',
      'packages/cli/src/probe.ts',
      'packages/shared/src/probe.ts',
    ]) {
      expect(await lintErrors(file, PROBE), file).toHaveLength(1);
    }
  });

  it('ESLint positive probe: driver.ts may import it', async () => {
    expect(await lintErrors('packages/engine/src/db/driver.ts', PROBE)).toEqual([]);
  });
});
