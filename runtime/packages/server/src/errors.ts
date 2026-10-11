// The error envelope and the error mapper of the server (03 5.2 step 9, registry 7.1). Every refusal and every failure of an
// API request is `{ error: { code, message, requestId, details? } }`: `code` from the shared catalogue, `message` one fixed
// English sentence per code (numbers allowed, never a request value, a path or a stack), `details` only for validation
// (`{ path, issue }`, the Zod issue code, never the rejected value).
import { isDbError } from '@mcs/engine';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  REQUEST_ID_RE,
  type ErrorCode,
  type ErrorDetail,
  type ErrorEnvelope,
} from '@mcs/shared';
import type { Response } from 'express';
import { randomInt } from 'node:crypto';

import { GUARD_ERROR_MESSAGES, requestInfo } from './http/guards.ts';

/** What a route handler throws to answer with a catalogue code (`NotFoundError` of the engine maps to the same codes). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(code: ErrorCode, options: { readonly details?: readonly ErrorDetail[]; readonly cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.details = options.details;
  }
}

/** One fixed English sentence per code (03 5.2). The codes of the guards keep the sentences of the guards. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  ...GUARD_ERROR_MESSAGES,
  param_repeated: 'A query parameter was repeated; give one comma-separated value.',
  cursor_invalid: 'The cursor does not belong to this request; start again from the first page.',
  range_invalid: 'The time range is not valid.',
  range_too_large: 'The time range is too large.',
  filter_requires_scope: 'This filter needs a session or a window of at most 7 days.',
  query_too_short: 'The search text is too short.',
  route_not_found: 'There is no such route.',
  session_not_found: 'The monitor does not know this session.',
  agent_not_found: 'The session has no such agent.',
  event_not_found: 'There is no such event.',
  work_item_not_found: 'There is no such work item.',
  alert_not_found: 'There is no such alert.',
  panel_disabled: 'This panel is not enabled for this instance.',
  probe_not_found: 'No hook probe with this id has been committed.',
  completion_target_not_found: 'No session, label or attempt matches the target.',
  transcript_gone: 'The transcript file no longer exists.',
  search_busy: 'Too many searches are running; try again shortly.',
  export_busy: 'An export is already running.',
  internal_error: 'The server could not complete the request.',
  db_busy: 'The database is busy; try again shortly.',
  disk_full: 'The disk of the monitor is full.',
  stream_limit: 'Too many live streams are open.',
  shutting_down: 'The monitor is shutting down.',
};

/** `Retry-After` in seconds (03 5.2 and 6.4). */
const RETRY_AFTER_SECONDS: Readonly<Partial<Record<ErrorCode, string>>> = {
  db_busy: '1',
  search_busy: '2',
  export_busy: '2',
};

export interface SendErrorOptions {
  /** The `Allow` header of a 405. */
  readonly allow?: readonly string[];
  /** `{ path, issue }` entries; none are written when the list is empty. */
  readonly details?: readonly ErrorDetail[];
}

function newRequestId(): string {
  let id = 'r-';
  for (let i = 0; i < 12; i += 1) id += randomInt(36).toString(36);
  return id;
}

/** The request id `requestContext` set, or a new one stamped on the response now. */
export function ensureRequestId(res: Response): string {
  const known = requestInfo(res)?.requestId ?? res.getHeader('X-Request-Id');
  if (typeof known === 'string' && REQUEST_ID_RE.test(known)) return known;
  const id = newRequestId();
  res.setHeader('X-Request-Id', id);
  return id;
}

/** Sends the envelope of `code` (status from the shared catalogue) and ends the response; a response already begun is ended. */
export function sendError(res: Response, code: ErrorCode, opts: SendErrorOptions = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const error: ErrorEnvelope['error'] = { code, message: ERROR_MESSAGES[code], requestId: ensureRequestId(res) };
  const envelope: ErrorEnvelope =
    opts.details === undefined || opts.details.length === 0
      ? { error }
      : { error: { ...error, details: [...opts.details] } };
  const retryAfter = RETRY_AFTER_SECONDS[code];
  if (retryAfter !== undefined) res.setHeader('Retry-After', retryAfter);
  if (opts.allow !== undefined) res.setHeader('Allow', opts.allow.join(', '));
  res.setHeader('Cache-Control', 'no-store');
  res.status(ERROR_HTTP_STATUS[code]).json(envelope);
}

// ---- the mapper ---------------------------------------------------------------------------------------------------

export interface MappedError {
  readonly code: ErrorCode;
  readonly details?: readonly ErrorDetail[];
  /** True for an unexpected failure: the caller records it in the server error ring and the log. */
  readonly internal: boolean;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

function stringProperty(value: object, name: string): string | undefined {
  const property: unknown = Reflect.get(value, name);
  return typeof property === 'string' ? property : undefined;
}

/** The engine's `NotFoundError(code)` (03 12.1): recognised by its name, so that source and build copies of the class both map. */
function notFoundCodeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name !== 'NotFoundError' && error.constructor.name !== 'NotFoundError') return undefined;
  const code = stringProperty(error, 'code');
  if (code === undefined || !ERROR_CODE_SET.has(code)) return undefined;
  const known = ERROR_CODES.find((candidate) => candidate === code);
  return known !== undefined && ERROR_HTTP_STATUS[known] === 404 ? known : undefined;
}

/**
 * 03 5.2 step 9: `DbError` `db_busy` is 503 `db_busy`, `db_full` is 503 `disk_full`, any other `DbError` is 500
 * `internal_error`; a router decoding failure (a `URIError`) is 400 `validation_failed`; anything else is 500 `internal_error`.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return error.details === undefined
      ? { code: error.code, internal: false }
      : { code: error.code, details: error.details, internal: false };
  }
  if (isDbError(error)) {
    if (error.code === 'db_busy') return { code: 'db_busy', internal: false };
    if (error.code === 'db_full') return { code: 'disk_full', internal: false };
    return { code: 'internal_error', internal: true };
  }
  const notFound = notFoundCodeOf(error);
  if (notFound !== undefined) return { code: notFound, internal: false };
  if (error instanceof URIError) {
    return { code: 'validation_failed', details: [{ path: 'path', issue: 'invalid_format' }], internal: false };
  }
  return { code: 'internal_error', internal: true };
}
