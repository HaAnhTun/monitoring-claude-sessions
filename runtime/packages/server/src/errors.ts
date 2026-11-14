// The error envelope and the error mapper of the server (03 5.2 step 9, registry 7.1). Every refusal and every failure of an
// API request is `{ error: { code, message, requestId, details? } }`: `code` from the shared catalogue, `message` one fixed
// English sentence per code (numbers allowed, never a request value, a path or a stack), `details` only for validation
// (`{ path, issue }`, the Zod issue code, never the rejected value).
import { isDbError } from '@mcs/engine';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  REQUEST_ID_RE,
  TERMINAL_ERROR_CODES,
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
  access_required: 'An access link is required: open the app with the link printed by the command line tool.',
  access_code_invalid: 'The access code is not valid, has expired or was already used.',
  access_rate_limited: 'Too many wrong access codes; wait and try again.',
  upgrade_required: 'This path needs a WebSocket upgrade.',
  terminal_unavailable: 'Terminals are not available on this system.',
  claude_not_found: 'The claude command could not be found.',
  folder_invalid: 'The folder does not exist or is not allowed.',
  terminal_not_found: 'There is no such terminal session.',
  terminal_limit: 'Too many terminal sessions are running.',
  resume_unavailable: 'This session cannot be resumed in a terminal.',
  picker_busy: 'A folder dialog is already open.',
};

/** `Retry-After` in seconds (03 5.2 and 6.4). */
const RETRY_AFTER_SECONDS: Readonly<Partial<Record<ErrorCode, string>>> = {
  db_busy: '1',
  search_busy: '2',
  export_busy: '2',
  // the access service passes the real wait as `retryAfterSeconds`; this is the window of its limiter when it does not
  access_rate_limited: '60',
};

/** The headers a code always carries (02 2.2): the challenge of the access code and the upgrade a socket path asks for. */
const CODE_HEADERS: Readonly<Partial<Record<ErrorCode, Readonly<Record<string, string>>>>> = {
  access_required: { 'WWW-Authenticate': 'CAW-Access' },
  access_code_invalid: { 'WWW-Authenticate': 'CAW-Access' },
  upgrade_required: { Upgrade: 'websocket', Connection: 'Upgrade' },
};

export interface SendErrorOptions {
  /** The `Allow` header of a 405. */
  readonly allow?: readonly string[];
  /** `{ path, issue }` entries; none are written when the list is empty. */
  readonly details?: readonly ErrorDetail[];
  /** The wait of a 429 in seconds (rounded up, at least 1); it replaces the static `Retry-After` of the code. */
  readonly retryAfterSeconds?: number;
  /** Ask the client to drop the connection: a body that was refused is never read (it wins over a header of the code). */
  readonly closeConnection?: boolean;
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
  for (const [name, value] of Object.entries(CODE_HEADERS[code] ?? {})) res.setHeader(name, value);
  const retryAfter =
    opts.retryAfterSeconds === undefined || !Number.isFinite(opts.retryAfterSeconds)
      ? RETRY_AFTER_SECONDS[code]
      : String(Math.max(1, Math.ceil(opts.retryAfterSeconds)));
  if (retryAfter !== undefined) res.setHeader('Retry-After', retryAfter);
  if (opts.allow !== undefined) res.setHeader('Allow', opts.allow.join(', '));
  if (opts.closeConnection === true) res.setHeader('Connection', 'close');
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

/** What the terminal service of the engine throws (design 01 3.2): its own vocabulary, mapped here to the catalogue. */
const TERMINAL_CODE_MAP: Readonly<Record<string, { readonly code: ErrorCode; readonly internal?: true }>> = {
  UNSUPPORTED_OS: { code: 'terminal_unavailable' },
  NATIVE_MISSING: { code: 'terminal_unavailable' },
  NATIVE_LOAD_FAILED: { code: 'terminal_unavailable' },
  COMMAND_UNSUPPORTED: { code: 'terminal_unavailable' },
  ARGS_UNSAFE: { code: 'terminal_unavailable' },
  SPAWN_FAILED: { code: 'terminal_unavailable', internal: true },
  START_TIMEOUT: { code: 'terminal_unavailable', internal: true },
  CLAUDE_NOT_FOUND: { code: 'claude_not_found' },
  FOLDER_INVALID: { code: 'folder_invalid' },
  FOLDER_NOT_FOUND: { code: 'folder_invalid' },
  SESSION_LIMIT: { code: 'terminal_limit' },
  SESSION_NOT_FOUND: { code: 'terminal_not_found' },
  SESSION_ENDED: { code: 'terminal_not_found' },
  NAME_INVALID: { code: 'terminal_not_found' },
  MESSAGE_TOO_LARGE: { code: 'payload_too_large' },
  SHUTTING_DOWN: { code: 'shutting_down' },
};

const TERMINAL_API_CODE_SET: ReadonlySet<string> = new Set(TERMINAL_ERROR_CODES);

/** The `{ path, issue }` list a terminal error may carry; anything of another shape is ignored (never a message or a value). */
function detailsOf(error: object): readonly ErrorDetail[] | undefined {
  const value: unknown = Reflect.get(error, 'details');
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries: readonly unknown[] = value;
  const details: ErrorDetail[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const path = stringProperty(entry, 'path');
    const issue = stringProperty(entry, 'issue');
    if (path === undefined || issue === undefined) return undefined;
    details.push({ path, issue });
  }
  return details;
}

/**
 * The engine's `TerminalError(code)`: recognised by its name like `NotFoundError`, so that source and build copies both map. The
 * engine codes are upper case ("SESSION_LIMIT"); a lower case code of `TERMINAL_ERROR_CODES` passes through. The message is
 * never read: the envelope carries the fixed sentence of the code. An unknown code is an internal failure.
 */
function terminalErrorOf(error: unknown): MappedError | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name !== 'TerminalError' && error.constructor.name !== 'TerminalError') return undefined;
  const raw = stringProperty(error, 'code');
  const details = detailsOf(error);
  const withDetails = (code: ErrorCode, internal: boolean): MappedError =>
    details === undefined ? { code, internal } : { code, details, internal };
  if (raw !== undefined && TERMINAL_API_CODE_SET.has(raw)) {
    const known = TERMINAL_ERROR_CODES.find((candidate) => candidate === raw);
    if (known !== undefined) return withDetails(known, false);
  }
  const mapped = raw !== undefined && Object.hasOwn(TERMINAL_CODE_MAP, raw) ? TERMINAL_CODE_MAP[raw] : undefined;
  if (mapped === undefined) return { code: 'internal_error', internal: true };
  return withDetails(mapped.code, mapped.internal === true);
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
  const terminal = terminalErrorOf(error);
  if (terminal !== undefined) return terminal;
  if (error instanceof URIError) {
    return { code: 'validation_failed', details: [{ path: 'path', issue: 'invalid_format' }], internal: false };
  }
  return { code: 'internal_error', internal: true };
}
