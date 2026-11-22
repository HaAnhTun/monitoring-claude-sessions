// The one error type of the database layer (03 4.3, registry 2.6 and 7.4). Messages are built from the code alone:
// a SQLite message can name a column or an expression of a CHECK, and a driver message can echo a statement, so
// neither is ever copied into a DbError (DA-I2, rule "never SQL text with data").
//
// A constraint error also says where it failed, in two fields of their own (CAW-146): `table`, the table name at the head
// of the failing statement, and `constraintTarget`, what the SQLite message named. Both are names of the schema (a table,
// columns, an index, a CHECK by its name or by the expression the migration wrote), kept only when the text has the exact
// form SQLite gives it; a value of a row is never part of either (driver.ts, `constraintTargetOf`).

/** Closed set of codes, in the order of registry 7.4. HTTP mapping: `db_busy` 503, `db_full` 503 `disk_full`, others 500. */
export const DB_ERROR_CODES = [
  'db_busy',
  'db_locked',
  'db_not_mcs',
  'db_identity_mismatch',
  'db_corrupt',
  'db_readonly',
  'db_full',
  'db_io',
  'db_cantopen',
  'db_constraint',
  'db_migration_required',
  'db_newer_than_runtime',
  'migration_checksum_mismatch',
  'migration_gap',
  'migration_unknown',
  'migration_failed',
  'migration_fk_violation',
  'migrations_missing',
  'backup_required',
  'backup_failed',
  'scope_mismatch',
] as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

/** Kind of a `db_constraint` error, from the SQLite extended result code. */
export type DbConstraintKind = 'unique' | 'check' | 'foreignkey' | 'notnull' | 'datatype' | 'other';

export interface DbErrorDetails {
  /** Only for `db_constraint`. */
  constraint?: DbConstraintKind;
  /** The migration version of a `migration_*` error. */
  version?: number;
  /** The SQLite result code name (for example `SQLITE_BUSY`), kept for diagnosis. */
  sqliteCode?: string;
  /** Only for `db_constraint`: the table the failing statement writes (an identifier of the schema). */
  table?: string;
  /**
   * Only for `db_constraint`: what SQLite named, as the schema writes it (`agents.session_id, agents.agent_uid`, an index,
   * the name or the expression of a CHECK). Never a value of a row.
   */
  constraintTarget?: string;
  /** The original error, when it carries no data worth hiding (a non-SQLite error). */
  cause?: unknown;
}

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly constraint: DbConstraintKind | undefined;
  readonly version: number | undefined;
  readonly sqliteCode: string | undefined;
  readonly table: string | undefined;
  readonly constraintTarget: string | undefined;

  constructor(code: DbErrorCode, message: string, details: DbErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DbError';
    this.code = code;
    this.constraint = details.constraint;
    this.version = details.version;
    this.sqliteCode = details.sqliteCode;
    this.table = details.table;
    this.constraintTarget = details.constraintTarget;
  }
}

/** True for a `DbError`, and, when `code` is given, only for that code. */
export function isDbError(error: unknown, code?: DbErrorCode): error is DbError {
  return error instanceof DbError && (code === undefined || error.code === code);
}
