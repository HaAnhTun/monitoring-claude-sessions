// The only module that loads the SQLite binding (03 4.5, ADR 0020, ADR 0064, I-14; the ESLint rule and the boundary test
// of driver.test.ts keep it that way). The binding is Node's built-in `node:sqlite`: no native dependency. A change of
// `node:sqlite` between Node versions stays inside this file; callers see the same surface as before.
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { DbError, type DbConstraintKind, type DbErrorCode } from './errors.ts';

export type SqlValue = number | bigint | string | Uint8Array | null;
/** Positional values, or named values (the key is the name without its `@`, `:` or `$` prefix). */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/**
 * A prepared statement. `R` is the row shape the caller declares (03 4.5): this module does not validate rows. Repositories
 * that read JSON columns of unknown content validate them with zod where the shape matters. Rows are null-prototype
 * objects (as `node:sqlite` returns them).
 */
export interface Stmt<R> {
  run(params?: SqlParams): { changes: number; lastInsertRowid: number };
  get(params?: SqlParams): R | undefined;
  all(params?: SqlParams): R[];
}

export interface SqlDriver {
  readonly path: string;
  readonly readonly: boolean;
  /** Cached by SQL text (LRU of `STATEMENT_CACHE_SIZE`). */
  prepare<R = Record<string, SqlValue>>(sql: string): Stmt<R>;
  exec(sql: string): void;
  /**
   * Runs `fn` in one transaction (a savepoint when already inside one) and rolls back when it throws. `fn` must be
   * synchronous: a callback that returns a promise is refused with a TypeError and rolled back (DA-I12).
   */
  transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;
  /** The rows of `PRAGMA <text>` (an empty array for a pragma that is set). */
  pragma(text: string): unknown;
  /** SQLite online backup API: copies pages in steps and leaves the event loop free between them. */
  backupTo(destPath: string, onProgress?: (p: { totalPages: number; remainingPages: number }) => void): Promise<void>;
  close(): void;
}

/** Prepared statements kept per connection (03 4.5). */
export const STATEMENT_CACHE_SIZE = 200;
/** How long SQLite waits for a lock before it answers SQLITE_BUSY (03 3.2 step 1: `timeout: 5000`). */
export const BUSY_TIMEOUT_MS = 5000;
/** Pages the online backup copies per step (the SQLite and `node:sqlite` default). */
const BACKUP_PAGES_PER_STEP = 100;

// ---- loading: `node:sqlite` prints an ExperimentalWarning on some Node versions (22.x, 24 before 24.22). It is dropped
// for this one load only; every other warning, and every later warning, reaches process.emitWarning unchanged.

type SqliteModule = typeof NodeSqlite;
let sqliteModule: SqliteModule | undefined;

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeof typeOrOptions === 'object' && typeOrOptions !== null && 'type' in typeOrOptions
        ? typeOrOptions.type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const text = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  return type === 'ExperimentalWarning' && text.startsWith('SQLite');
}

function loadSqlite(): SqliteModule {
  if (sqliteModule !== undefined) return sqliteModule;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back unchanged after the load; called below with `process` as `this`
  const original = process.emitWarning;
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    Reflect.apply(original, process, [warning, ...rest]);
  };
  process.emitWarning = filtered;
  try {
    // createRequire, not a static import: the load must happen inside the swap above (ADR 0064 decision 2)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- require() answers any; the type is the module's own declaration
    const loaded: SqliteModule = createRequire(import.meta.url)('node:sqlite');
    sqliteModule = loaded;
    return loaded;
  } finally {
    process.emitWarning = original;
  }
}

// ---- errors: `node:sqlite` throws an Error with `code: 'ERR_SQLITE_ERROR'` and the numeric extended result code in
// `errcode` (ADR 0064 decision 8). Its message can name a column or echo a CHECK expression and is never copied.

const PRIMARY_NAMES: Readonly<Record<number, string>> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS',
  23: 'SQLITE_AUTH',
  24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE',
  26: 'SQLITE_NOTADB',
  27: 'SQLITE_NOTICE',
  28: 'SQLITE_WARNING',
};

/** Extended result codes that diagnostics name (sqlite3.h); any other extended code reads as its primary name. */
const EXTENDED_NAMES: Readonly<Record<number, string>> = {
  261: 'SQLITE_BUSY_RECOVERY',
  517: 'SQLITE_BUSY_SNAPSHOT',
  773: 'SQLITE_BUSY_TIMEOUT',
  262: 'SQLITE_LOCKED_SHAREDCACHE',
  518: 'SQLITE_LOCKED_VTAB',
  264: 'SQLITE_READONLY_RECOVERY',
  520: 'SQLITE_READONLY_CANTLOCK',
  776: 'SQLITE_READONLY_ROLLBACK',
  1032: 'SQLITE_READONLY_DBMOVED',
  1288: 'SQLITE_READONLY_CANTINIT',
  1544: 'SQLITE_READONLY_DIRECTORY',
  266: 'SQLITE_IOERR_READ',
  522: 'SQLITE_IOERR_SHORT_READ',
  778: 'SQLITE_IOERR_WRITE',
  1034: 'SQLITE_IOERR_FSYNC',
  267: 'SQLITE_CORRUPT_VTAB',
  523: 'SQLITE_CORRUPT_SEQUENCE',
  779: 'SQLITE_CORRUPT_INDEX',
  270: 'SQLITE_CANTOPEN_NOTEMPDIR',
  526: 'SQLITE_CANTOPEN_ISDIR',
  782: 'SQLITE_CANTOPEN_FULLPATH',
  1038: 'SQLITE_CANTOPEN_CONVPATH',
  1550: 'SQLITE_CANTOPEN_SYMLINK',
  275: 'SQLITE_CONSTRAINT_CHECK',
  531: 'SQLITE_CONSTRAINT_COMMITHOOK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2323: 'SQLITE_CONSTRAINT_VTAB',
  2579: 'SQLITE_CONSTRAINT_ROWID',
  2835: 'SQLITE_CONSTRAINT_PINNED',
  3091: 'SQLITE_CONSTRAINT_DATATYPE',
};

const SQLITE_CONSTRAINT = 19;

/** True for an error that `node:sqlite` raised for a SQLite result code. */
function isSqliteError(error: unknown): error is Error & { code: 'ERR_SQLITE_ERROR' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_SQLITE_ERROR';
}

function errcodeOf(error: unknown): number | undefined {
  if (!isSqliteError(error) || !('errcode' in error)) return undefined;
  const { errcode } = error;
  return typeof errcode === 'number' && Number.isInteger(errcode) && errcode > 0 ? errcode : undefined;
}

function sqliteName(errcode: number): string {
  return EXTENDED_NAMES[errcode] ?? PRIMARY_NAMES[errcode & 0xff] ?? 'SQLITE_UNKNOWN';
}

function constraintKind(errcode: number): DbConstraintKind {
  switch (errcode) {
    case 2067: // UNIQUE
    case 1555: // PRIMARYKEY
    case 2579: // ROWID
      return 'unique';
    case 275:
      return 'check';
    case 787:
      return 'foreignkey';
    case 1299:
      return 'notnull';
    case 3091:
      return 'datatype';
    default:
      return 'other';
  }
}

function classify(errcode: number): { code: DbErrorCode; text: string; constraint?: DbConstraintKind } {
  switch (errcode & 0xff) {
    case SQLITE_CONSTRAINT: {
      const constraint = constraintKind(errcode);
      return { code: 'db_constraint', text: `database constraint failed (${constraint})`, constraint };
    }
    case 5:
      return { code: 'db_busy', text: 'database is busy' };
    case 6:
      return { code: 'db_locked', text: 'database table is locked' };
    case 11:
    case 26:
      return { code: 'db_corrupt', text: 'database file is corrupt or is not a database' };
    case 8:
      return { code: 'db_readonly', text: 'database is read-only' };
    case 13:
      return { code: 'db_full', text: 'database or disk is full' };
    case 10:
      return { code: 'db_io', text: 'database I/O error' };
    case 14:
      return { code: 'db_cantopen', text: 'database file cannot be opened' };
    default:
      // Every other result code (SQLITE_ERROR for a statement SQLite rejects, SQLITE_RANGE, SQLITE_MISUSE, ...) has no
      // code of its own in the closed set of registry 7.4: db_io, with the SQLite code name kept for diagnosis.
      return { code: 'db_io', text: 'database operation failed' };
  }
}

// ---- where a constraint failed (CAW-146): names of the schema only

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const COLUMN = `${IDENT}[.]${IDENT}`;
/** `t.a, t.b` (UNIQUE, PRIMARY KEY, NOT NULL) or `index 'name'` (a unique index over expressions). */
const COLUMNS_OR_INDEX = new RegExp(`^(?:${COLUMN}(?:, ${COLUMN})*|index '${IDENT}')$`);
const DATATYPE_COLUMN = new RegExp(`^cannot store [A-Z]+ value in [A-Z]+ column (${COLUMN})$`);
/** The statements that write one table, with the name of the table right after their first keywords. */
const WS = '[ \t\r\n]';
const WRITTEN_TABLE = new RegExp(
  `^${WS}*(?:INSERT(?:${WS}+OR${WS}+[A-Za-z]+)?${WS}+INTO|REPLACE${WS}+INTO|UPDATE(?:${WS}+OR${WS}+[A-Za-z]+)?|DELETE${WS}+FROM)` +
    `${WS}+(${IDENT})(?=${WS}|[(]|$)`,
  'i',
);
/** One line of printable ASCII: the name or the expression of a CHECK as a migration writes it. */
const CHECK_TEXT = /^[ -~]+$/;
const CHECK_TEXT_MAX = 120;

/**
 * What the message of a constraint failure names, kept only in the exact form SQLite builds it from the schema:
 * `UNIQUE constraint failed: t.a, t.b`, `NOT NULL constraint failed: t.c`, `CHECK constraint failed: <the name or the
 * expression of the CREATE TABLE>`, `cannot store TEXT value in INTEGER column t.c`. SQLite puts no value of the row into
 * these texts. A message of any other form gives nothing: the text a trigger raises, a foreign key failure (which names
 * nothing), or words that do not belong to the kind of the result code.
 */
function constraintTargetOf(kind: DbConstraintKind, message: string): string | undefined {
  const after = (prefix: string): string | undefined =>
    message.startsWith(prefix) ? message.slice(prefix.length) : undefined;
  switch (kind) {
    case 'unique': {
      const rest = after('UNIQUE constraint failed: ');
      return rest !== undefined && COLUMNS_OR_INDEX.test(rest) ? rest : undefined;
    }
    case 'notnull': {
      const rest = after('NOT NULL constraint failed: ');
      return rest !== undefined && COLUMNS_OR_INDEX.test(rest) ? rest : undefined;
    }
    case 'check': {
      const rest = after('CHECK constraint failed: ');
      return rest !== undefined && CHECK_TEXT.test(rest) ? rest.slice(0, CHECK_TEXT_MAX) : undefined;
    }
    case 'datatype':
      return DATATYPE_COLUMN.exec(message)?.[1];
    case 'foreignkey':
    case 'other':
      return undefined;
  }
}

/** The table a statement writes, from its first keywords; undefined for any other statement (a WITH, a script, a quoted name). */
function writtenTableOf(statement: string | undefined): string | undefined {
  return statement === undefined ? undefined : WRITTEN_TABLE.exec(statement)?.[1];
}

function fromErrcode(errcode: number, message?: string, statement?: string): DbError {
  const sqliteCode = sqliteName(errcode);
  const mapped = classify(errcode);
  const text = `${mapped.text} (${sqliteCode})`;
  if (mapped.constraint === undefined) return new DbError(mapped.code, text, { sqliteCode });
  const table = writtenTableOf(statement);
  const constraintTarget = message === undefined ? undefined : constraintTargetOf(mapped.constraint, message);
  return new DbError(mapped.code, text, {
    sqliteCode,
    constraint: mapped.constraint,
    ...(table === undefined ? {} : { table }),
    ...(constraintTarget === undefined ? {} : { constraintTarget }),
  });
}

/**
 * Maps a `node:sqlite` error (`code: 'ERR_SQLITE_ERROR'`, numeric `errcode`) to a DbError. The message is built from the
 * code only: the SQLite message can name a column or echo a CHECK expression. A SQLite error without a usable `errcode`
 * becomes `db_io` without a cause (its message can still hold data); any other error becomes `db_io` and keeps the cause.
 * A constraint error also carries the table of `statement` (the text of the statement that failed, when the caller has it)
 * and what the SQLite message named, as names of the schema (`DbError.table`, `DbError.constraintTarget`).
 */
export function toDbError(error: unknown, statement?: string): DbError {
  if (error instanceof DbError) return error;
  const errcode = errcodeOf(error);
  if (errcode !== undefined) return fromErrcode(errcode, error instanceof Error ? error.message : undefined, statement);
  if (isSqliteError(error)) return new DbError('db_io', 'database operation failed');
  return new DbError('db_io', 'database operation failed', { cause: error });
}

/** A SQLite failure becomes a DbError; any other error (a programming error: closed database, out of range) is kept. */
function mapError(error: unknown, statement?: string): unknown {
  return isSqliteError(error) ? toDbError(error, statement) : error;
}

/**
 * Runs `fn`; a SQLite failure becomes a DbError, any other error (a programming error) passes through untouched.
 * `statement` is the text of the prepared statement that `fn` runs: a constraint error then names its table.
 */
function guard<T>(fn: () => T, statement?: string): T {
  try {
    return fn();
  } catch (error) {
    throw mapError(error, statement);
  }
}

// ---- statements

function isPositional(params: SqlParams): params is readonly SqlValue[] {
  return Array.isArray(params);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function noop(): void {
  // intentionally empty: swallows the outcome of an abandoned promise
}

function wrapStatement(raw: NodeSqlite.StatementSync, sql: string): Stmt<unknown> {
  return {
    run: (params) => {
      const result = guard(
        () => (params === undefined ? raw.run() : isPositional(params) ? raw.run(...params) : raw.run(params)),
        sql,
      );
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (params) =>
      guard(
        () => (params === undefined ? raw.get() : isPositional(params) ? raw.get(...params) : raw.get(params)),
        sql,
      ),
    all: (params) =>
      guard(
        () => (params === undefined ? raw.all() : isPositional(params) ? raw.all(...params) : raw.all(params)),
        sql,
      ),
  };
}

/** Undoes a failed transaction step. A failing undo is dropped: the caller rethrows the original error (ADR 0064 5). */
function undoQuietly(raw: NodeSqlite.DatabaseSync, statements: readonly string[]): void {
  try {
    // SQLite may already have rolled the whole transaction back (SQLITE_FULL, SQLITE_IOERR, ...): nothing left to undo.
    if (!raw.isTransaction) return;
    for (const sql of statements) raw.exec(sql);
  } catch {
    // intentionally empty: the original error is what the caller needs to see
  }
}

/** Opens a connection. `timeoutMs` is the busy timeout: how long SQLite waits for a lock before it answers SQLITE_BUSY. */
export function openSqlite(
  path: string,
  opts: {
    readonly: boolean;
    fileMustExist: boolean;
    timeoutMs: number;
    /**
     * Read-only only: open the file as `immutable`. SQLite then creates and reads no `-wal` or `-shm` file, so a read leaves
     * nothing behind, but it assumes that no process writes the file meanwhile and that no committed frames wait in a
     * `-wal` file. The caller guarantees both (the `DbReader` of a stopped instance).
     */
    immutable?: boolean;
  },
): SqlDriver {
  const { DatabaseSync: Database, backup } = loadSqlite();
  // `node:sqlite` has no `fileMustExist`: a read-write open creates a missing file. The check below refuses it first,
  // with the error a SQLITE_CANTOPEN failure gives. A file deleted between the check and the open is created empty;
  // the caller's identity checks (open.ts: application_id, instance id) then refuse that empty file. A read-only open of
  // a missing file fails natively with SQLITE_CANTOPEN.
  if (opts.fileMustExist && !opts.readonly && path !== ':memory:' && !existsSync(path)) throw fromErrcode(14);
  // Linux opens a folder read-only and only the first read fails (SQLITE_IOERR): a folder is refused here with the
  // SQLITE_CANTOPEN that Windows gives natively, so the error code is the same on every host (WP-87, Docker run).
  if (path !== ':memory:' && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) throw fromErrcode(14);
  const location =
    opts.immutable === true && opts.readonly && path !== ':memory:' ? `${pathToFileURL(path).href}?immutable=1` : path;
  const raw = guard(() => new Database(location, { readOnly: opts.readonly, timeout: opts.timeoutMs }));
  // Least recently used first. The row type `R` of `prepare<R>` is the caller's declaration (03 4.5), so the cache keeps
  // `Stmt<unknown>` and `prepare` hands it out under the row type the caller named.
  const cache = new Map<string, Stmt<unknown>>();
  let depth = 0;
  let closed = false;

  function transaction<T>(fn: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T {
    const nested = raw.isTransaction;
    const savepoint = `mcs_${String(depth)}`; // depth 1 is the first savepoint inside a BEGIN
    const [begin, finish, undo] = nested
      ? [`SAVEPOINT ${savepoint}`, `RELEASE ${savepoint}`, [`ROLLBACK TO ${savepoint}`, `RELEASE ${savepoint}`]]
      : [mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED', 'COMMIT', ['ROLLBACK']];
    guard(() => {
      raw.exec(begin);
    });
    depth += 1;
    try {
      const result = fn();
      if (isThenable(result)) {
        // the abandoned continuation must not become an unhandled rejection
        void Promise.resolve(result).catch(noop);
        throw new TypeError('A transaction callback must be synchronous: it returned a promise');
      }
      raw.exec(finish);
      return result;
    } catch (error) {
      undoQuietly(raw, undo);
      throw mapError(error);
    } finally {
      depth -= 1;
    }
  }

  return {
    path,
    readonly: opts.readonly,
    prepare<R = Record<string, SqlValue>>(sql: string): Stmt<R> {
      const cached = cache.get(sql);
      if (cached !== undefined) {
        cache.delete(sql);
        cache.set(sql, cached);
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- R is the row type the caller declares (03 4.5); this module never validates rows
        return cached as Stmt<R>;
      }
      const statement = wrapStatement(
        guard(() => raw.prepare(sql)),
        sql,
      );
      if (cache.size >= STATEMENT_CACHE_SIZE) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(sql, statement);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- same seam as above: the caller's row type
      return statement as Stmt<R>;
    },
    exec: (sql) => {
      guard(() => {
        raw.exec(sql);
      });
    },
    transaction,
    // A setter answers [] and a getter its rows (verified for user_version, journal_mode, wal_checkpoint, quick_check).
    pragma: (text) => guard(() => raw.prepare(`PRAGMA ${text}`).all()),
    // The consistency of a copy taken while the connection keeps writing is proven by DA-T-E-3 (test/db-backup.int.test.ts).
    backupTo: async (destPath, onProgress) => {
      try {
        await backup(raw, destPath, {
          rate: BACKUP_PAGES_PER_STEP,
          ...(onProgress === undefined
            ? {}
            : {
                progress: ({ totalPages, remainingPages }: { totalPages: number; remainingPages: number }) => {
                  onProgress({ totalPages, remainingPages });
                },
              }),
        });
      } catch (error) {
        throw mapError(error);
      }
    },
    // Idempotent: the native close of a closed database throws. Closing finalizes open statements and rolls back an
    // open transaction; a cached statement used afterwards throws ERR_INVALID_STATE, like `prepare` does.
    close: () => {
      if (closed) return;
      closed = true;
      cache.clear();
      raw.close();
    },
  };
}

/** The first value of the first row of `PRAGMA <text>`, or `undefined` when the pragma returns no row. */
export function pragmaValue(driver: SqlDriver, text: string): unknown {
  const rows = driver.pragma(text);
  if (!Array.isArray(rows)) return undefined;
  const first: unknown = rows[0];
  if (typeof first !== 'object' || first === null) return undefined;
  return Object.values(first)[0];
}

/** Like `pragmaValue`, for a pragma that answers an integer (`user_version`, `application_id`, ...). */
export function pragmaNumber(driver: SqlDriver, text: string): number {
  const value = pragmaValue(driver, text);
  if (typeof value !== 'number') throw new DbError('db_io', `PRAGMA ${text} did not answer a number`);
  return value;
}
