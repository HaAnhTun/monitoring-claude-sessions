// What a failed transaction of the ingest writer was, in names only (02 4.6 step 7, CAW-146): the code of the error, the
// constraint and the table SQLite named, and the kind of the batch and item that could not be stored. It feeds the log line
// `ingest_commit_failed` and the detail of a `PERSIST_FAILED` record. Nothing here reads a value of a row: the texts are the
// names of the schema (`DbError.table`, `DbError.constraintTarget`), the closed sets of the pipeline (batch source, item kind,
// event kind) and the message of a check the repositories make themselves, which is built from the code alone.
import { isDbError } from '../db/errors.ts';
import { clipCodePoints } from '../platform/fsx.ts';

import { INGEST_ERROR_DETAIL_MAX_CP } from './errors.ts';

/** The part of an item this module reads (structural, so that the writer can import it without a cycle). */
export interface FailedItemShape {
  readonly kind: string;
  readonly events: readonly { readonly k: string }[];
}

export interface CommitFailure {
  /** The `DbError` code, else the name of the error class, else `unknown`. */
  readonly code: string;
  /** Only for `db_constraint`: `check`, `unique`, `foreignkey`, `notnull`, `datatype` or `other`. */
  readonly constraint: string | null;
  /** The SQLite result name (`SQLITE_CONSTRAINT_CHECK`); null for an error that did not come from SQLite. */
  readonly sqliteCode: string | null;
  /** The table of the failing statement. */
  readonly table: string | null;
  /** What SQLite named (columns, an index, a CHECK), or the reason of a check a repository made itself. */
  readonly target: string | null;
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** Reads the names out of `error`. The message of an error that is not a `DbError` is never read: it can carry data. */
export function describeFailure(error: unknown): CommitFailure {
  if (isDbError(error)) {
    // a constraint a repository checks itself (`the agent does not exist in this session`) has no SQLite code: its message
    // is a constant of the code and says which reference was missing
    const ownCheck = error.code === 'db_constraint' && error.sqliteCode === undefined;
    return {
      code: error.code,
      constraint: error.constraint ?? null,
      sqliteCode: error.sqliteCode ?? null,
      table: error.table ?? null,
      target: error.constraintTarget ?? (ownCheck ? error.message : null),
    };
  }
  const name = error instanceof Error && ERROR_NAME.test(error.name) ? error.name : 'unknown';
  return { code: name, constraint: null, sqliteCode: null, table: null, target: null };
}

const EVENTS_NAMED = 6;

/** The event kinds of an item, each once, in order: `activity, tool.start`. */
function eventKinds(item: FailedItemShape): string[] {
  const kinds = [...new Set(item.events.map((event) => event.k))];
  return kinds.length > EVENTS_NAMED ? [...kinds.slice(0, EVENTS_NAMED), 'more'] : kinds;
}

/** The value of a log field: the logger keeps only `[\w.:/@-]`, at most 128 characters (05 5.3 S-LOG-1). */
function logSafe(text: string): string {
  return text
    .replace(/[^\w.:/@-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
}

/**
 * The fields of `ingest_commit_failed`, within the closed field list of the logger: `code` (the error), `status` (the SQLite
 * result name, else the kind of the constraint), `phase` (`<table>/<what SQLite named>`), `kind` (`<batch source>/<item
 * kind>/<event kinds>` when one item failed, else the batch source) and `count` (the items of the failed transaction).
 */
export function commitFailureLogFields(
  failure: CommitFailure,
  attempt: { readonly source: string; readonly items: readonly FailedItemShape[] },
): Record<string, string | number> {
  const status = failure.sqliteCode ?? failure.constraint;
  const where = [failure.table, failure.target].filter((part) => part !== null).join('/');
  const [only] = attempt.items;
  const what =
    attempt.items.length === 1 && only !== undefined
      ? `${attempt.source}/${only.kind}/${eventKinds(only).join(':') || 'none'}`
      : attempt.source;
  return {
    code: failure.code,
    ...(status === null ? {} : { status: logSafe(status) }),
    ...(where === '' ? {} : { phase: logSafe(where) }),
    kind: logSafe(what),
    count: attempt.items.length,
  };
}

/**
 * The detail of a `PERSIST_FAILED` record, at most 200 code points:
 * `item could not be stored (db_constraint check; tool_calls; summary IS NULL OR length(summary) <= 160; transcript record: tool.start)`.
 */
export function persistFailedDetail(failure: CommitFailure, source: string, item: FailedItemShape | undefined): string {
  const error = failure.constraint === null ? failure.code : `${failure.code} ${failure.constraint}`;
  const kinds = item === undefined ? [] : eventKinds(item);
  const what =
    item === undefined ? source : `${source} ${item.kind}${kinds.length === 0 ? '' : `: ${kinds.join(', ')}`}`;
  const parts = [error, failure.table, failure.target === null ? null : clipCodePoints(failure.target, 80), what];
  return clipCodePoints(
    `item could not be stored (${parts.filter((part) => part !== null).join('; ')})`,
    INGEST_ERROR_DETAIL_MAX_CP,
  );
}
