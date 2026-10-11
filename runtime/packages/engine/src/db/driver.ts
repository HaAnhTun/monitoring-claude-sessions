// The only module that imports the native SQLite binding (03 4.5, ADR 0020, I-14; the ESLint rule and the grep test of
// driver.test.ts keep it that way). Switching to `node:sqlite` when the Node floor reaches 24.15 changes this file only
// (03 O-2: not exercised yet, better-sqlite3 is the only driver).
import Database from 'better-sqlite3';

import { DbError, type DbConstraintKind, type DbErrorCode } from './errors.ts';

export type SqlValue = number | bigint | string | Uint8Array | null;
/** Positional values, or named values (the key is the name without its `@`, `:` or `$` prefix). */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/**
 * A prepared statement. `R` is the row shape the caller declares (03 4.5): this module does not validate rows. Repositories
 * that read JSON columns of unknown content validate them with zod where the shape matters.
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
  /** The rows of a pragma, as better-sqlite3 returns them (an empty array for a pragma that is set). */
  pragma(text: string): unknown;
  /** SQLite online backup API: copies pages in steps and leaves the event loop free between them. */
  backupTo(destPath: string, onProgress?: (p: { totalPages: number; remainingPages: number }) => void): Promise<void>;
  close(): void;
}

/** Prepared statements kept per connection (03 4.5). */
export const STATEMENT_CACHE_SIZE = 200;
/** How long SQLite waits for a lock before it answers SQLITE_BUSY (03 3.2 step 1: `timeout: 5000`). */
export const BUSY_TIMEOUT_MS = 5000;
/** Pages the online backup copies per step (the better-sqlite3 default; its progress callback must return a number). */
const BACKUP_PAGES_PER_STEP = 100;

function sqliteCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

function constraintKind(sqliteCode: string): DbConstraintKind {
  switch (sqliteCode) {
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY':
    case 'SQLITE_CONSTRAINT_ROWID':
      return 'unique';
    case 'SQLITE_CONSTRAINT_CHECK':
      return 'check';
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
      return 'foreignkey';
    case 'SQLITE_CONSTRAINT_NOTNULL':
      return 'notnull';
    case 'SQLITE_CONSTRAINT_DATATYPE':
      return 'datatype';
    default:
      return 'other';
  }
}

function classify(sqliteCode: string): { code: DbErrorCode; text: string; constraint?: DbConstraintKind } {
  if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    const constraint = constraintKind(sqliteCode);
    return { code: 'db_constraint', text: `database constraint failed (${constraint})`, constraint };
  }
  if (sqliteCode.startsWith('SQLITE_BUSY')) return { code: 'db_busy', text: 'database is busy' };
  if (sqliteCode.startsWith('SQLITE_LOCKED')) return { code: 'db_locked', text: 'database table is locked' };
  if (sqliteCode.startsWith('SQLITE_CORRUPT') || sqliteCode === 'SQLITE_NOTADB') {
    return { code: 'db_corrupt', text: 'database file is corrupt or is not a database' };
  }
  if (sqliteCode.startsWith('SQLITE_READONLY')) return { code: 'db_readonly', text: 'database is read-only' };
  if (sqliteCode === 'SQLITE_FULL') return { code: 'db_full', text: 'database or disk is full' };
  if (sqliteCode.startsWith('SQLITE_IOERR')) return { code: 'db_io', text: 'database I/O error' };
  if (sqliteCode.startsWith('SQLITE_CANTOPEN')) return { code: 'db_cantopen', text: 'database file cannot be opened' };
  // Every other result code (SQLITE_ERROR for a statement SQLite rejects, SQLITE_MISUSE, SQLITE_NOMEM, ...) has no code
  // of its own in the closed set of registry 7.4: db_io, with the SQLite code kept for diagnosis.
  return { code: 'db_io', text: 'database operation failed' };
}

/**
 * Maps a better-sqlite3 error (`err.code`, `SQLITE_*`; `node:sqlite` would use `err.errcode`) to a DbError. The message is
 * built from the code only: the SQLite message can name a column or echo a CHECK expression.
 */
export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const sqliteCode = sqliteCodeOf(error);
  if (sqliteCode === undefined) return new DbError('db_io', 'database operation failed', { cause: error });
  const mapped = classify(sqliteCode);
  return new DbError(mapped.code, `${mapped.text} (${sqliteCode})`, {
    sqliteCode,
    ...(mapped.constraint === undefined ? {} : { constraint: mapped.constraint }),
  });
}

/** Runs `fn`; a SQLite failure becomes a DbError, any other error (a programming error) passes through untouched. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (sqliteCodeOf(error) !== undefined) throw toDbError(error);
    throw error;
  }
}

function isPositional(params: SqlParams): params is readonly SqlValue[] {
  return Array.isArray(params);
}

function bindings(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  return isPositional(params) ? [...params] : [params];
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

type RawStatement = Database.Statement;

function wrapStatement(raw: RawStatement): Stmt<unknown> {
  return {
    run: (params) => {
      const result = guard(() => raw.run(...bindings(params)));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (params) => guard(() => raw.get(...bindings(params))),
    all: (params) => guard(() => raw.all(...bindings(params))),
  };
}

/** Opens a connection. `timeoutMs` is the busy timeout: how long SQLite waits for a lock before it answers SQLITE_BUSY. */
export function openSqlite(
  path: string,
  opts: { readonly: boolean; fileMustExist: boolean; timeoutMs: number },
): SqlDriver {
  const raw = guard(
    () => new Database(path, { readonly: opts.readonly, fileMustExist: opts.fileMustExist, timeout: opts.timeoutMs }),
  );
  // Least recently used first. The row type `R` of `prepare<R>` is the caller's declaration (03 4.5), so the cache keeps
  // `Stmt<unknown>` and `prepare` hands it out under the row type the caller named.
  const cache = new Map<string, Stmt<unknown>>();

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
      const statement = wrapStatement(guard(() => raw.prepare(sql)));
      if (cache.size >= STATEMENT_CACHE_SIZE) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(sql, statement);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- same seam as above: the caller's row type
      return statement as Stmt<R>;
    },
    exec: (sql) => {
      guard(() => raw.exec(sql));
    },
    transaction: <T>(fn: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T => {
      const run = raw.transaction(() => {
        const result = fn();
        if (isThenable(result)) {
          // better-sqlite3 refuses the promise and rolls back; the abandoned continuation must not become an unhandled rejection
          void Promise.resolve(result).catch(noop);
        }
        return result;
      });
      return guard(() => (mode === 'immediate' ? run.immediate() : run.deferred()));
    },
    pragma: (text) => guard(() => raw.pragma(text)),
    // 03 O-3: @types/better-sqlite3 9.6.0 declares backup() and its progress option, so this compiles without a local
    // module augmentation. The SQLite online backup API is used as is; the consistency of a copy taken while the
    // connection keeps writing is proven by DA-T-E-3 (test/db-backup.int.test.ts).
    backupTo: async (destPath, onProgress) => {
      try {
        await (onProgress === undefined
          ? raw.backup(destPath)
          : raw.backup(destPath, {
              progress: ({ totalPages, remainingPages }) => {
                onProgress({ totalPages, remainingPages });
                return BACKUP_PAGES_PER_STEP;
              },
            }));
      } catch (error) {
        if (sqliteCodeOf(error) !== undefined) throw toDbError(error);
        throw error;
      }
    },
    close: () => {
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
