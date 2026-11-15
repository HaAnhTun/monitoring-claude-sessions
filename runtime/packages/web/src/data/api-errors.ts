// API failures as the UI sees them (04-ui.md 5.1): the `ApiError` thrown by the client, the English diagnostic texts of
// `describeFailure` (for logs and tests), the catalogue message of every failure (`apiErrorMessage`, `describeApiError`) and the
// table that says what the UI does for each status and error code.
import type { ErrorCode } from '@mcs/shared';

import type { ArgsTuple, MessageKey, TFunction } from '../i18n/types.ts';
import type { EndpointName } from './endpoints.ts';

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'parse' | 'contract' | 'aborted';

export interface ApiErrorInfo {
  kind: ApiErrorKind;
  /** The HTTP status, 0 when there was no response. */
  status: number;
  /** The catalogue code of the envelope; `null` when the envelope is missing, malformed or carries an unknown code. */
  code: ErrorCode | null;
  endpoint: EndpointName;
  /** `X-Request-Id`, from the envelope or the header. */
  requestId: string | null;
  /** The envelope message, kept apart from the display text so the filter bar can quote it. */
  serverMessage?: string;
  /** `Retry-After` of a 429 or 503, in milliseconds (capped at 30 s). */
  retryAfterMs?: number;
  /** A timeout only: how long the request waited, in milliseconds. */
  timeoutMs?: number;
  /** Set to `'POST'` by `ApiClient.post` and absent for a read, so a failed write can be told from a failed read (ADR 0099). */
  method?: 'POST';
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly info: ApiErrorInfo;

  constructor(message: string, info: ApiErrorInfo) {
    super(message);
    this.info = info;
  }
}

/**
 * Human, actionable message for a failed request. It is English on purpose: it is the diagnostic in `ApiError.message` for logs
 * and tests. What the UI shows comes from `apiErrorMessage` and `describeApiError` through the catalogue (ADR 0072 decision 5).
 */
export function describeFailure(kind: ApiErrorKind, status: number, serverMessage: string, timeoutMs: number): string {
  if (kind === 'timeout') return `No answer from the monitor within ${String(Math.round(timeoutMs / 1000))} s`;
  if (kind === 'network') return 'Cannot reach the monitor (is the runtime still running? Try `$MCS status`)';
  if (kind === 'parse') return 'The monitor sent an unreadable response';
  if (kind === 'contract') return 'The monitor sent data this page does not understand';
  if (kind === 'aborted') return 'The request was cancelled';
  if (status === 403) return 'Request rejected (403): open this page via 127.0.0.1 or localhost';
  if (status === 404) return serverMessage === '' ? 'Not found (404)' : `Not found: ${serverMessage}`;
  if (status >= 500) return `Monitor error (${String(status)})${serverMessage === '' ? '' : `: ${serverMessage}`}`;
  return `Request failed (${String(status)})${serverMessage === '' ? '' : `: ${serverMessage}`}`;
}

// ---- what a failure says, as a catalogue message --------------------------------------------------------------------------

/**
 * A message of the catalogue that is not rendered yet: its key and arguments, so the view picks the language when it draws.
 * `text(t)` renders it in the language of `t`; the one function that builds a message pairs the key with its arguments, and
 * `t` type-checks that pair there.
 */
export interface ApiErrorMessage {
  readonly messageKey: MessageKey;
  readonly args: Readonly<Record<string, string | number>> | undefined;
  readonly text: (t: TFunction) => string;
}

function say<K extends MessageKey>(messageKey: K, ...args: ArgsTuple<K>): ApiErrorMessage {
  return { messageKey, args: args[0], text: (t) => t(messageKey, ...args) };
}

/** The codes of the terminal area whose words take no argument. */
const PLAIN_CODE_KEYS = {
  access_code_invalid: 'error.handling.accessInvalid',
  terminal_unavailable: 'error.handling.terminalUnavailable',
  claude_not_found: 'error.handling.claudeNotFound',
  folder_invalid: 'error.handling.folderInvalid',
  folder_not_found: 'error.handling.folderInvalid',
  terminal_not_found: 'error.handling.terminalNotFound',
  terminal_limit: 'error.handling.terminalLimit',
  resume_unavailable: 'error.handling.notResumable',
  picker_busy: 'error.handling.pickerBusy',
  folder_limit: 'error.handling.folderLimit',
} as const satisfies Partial<Record<ErrorCode, MessageKey>>;

function isPlainCode(code: ErrorCode): code is keyof typeof PLAIN_CODE_KEYS {
  return Object.hasOwn(PLAIN_CODE_KEYS, code);
}

/**
 * The words of the codes of the access and terminal area (ADR 0099), `null` for any other failure. They come from the catalogue
 * and never from the server text, so a message cannot echo what the person typed or pasted. `access_required` reads by what it
 * was: a read the page could not show (the locked view, "Access link needed") or a write that was refused.
 */
function codedMessage(error: ApiError): ApiErrorMessage | null {
  const { status, code, retryAfterMs, method } = error.info;
  if (code === null) return null;
  if (code === 'access_required') {
    return status === 401
      ? say(method === 'POST' ? 'error.handling.accessRequired' : 'error.handling.accessLocked')
      : null;
  }
  if (code === 'access_rate_limited') {
    return retryAfterMs === undefined
      ? say('error.handling.busy')
      : say('error.handling.accessRateLimited', { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
  }
  return isPlainCode(code) ? say(PLAIN_CODE_KEYS[code]) : null;
}

/**
 * What a failure says, as a catalogue key and arguments. It is derived from `ApiError.info` only (kind, status, the envelope
 * message and the timeout), never from the English text in `ApiError.message`.
 */
export function apiErrorMessage(error: ApiError): ApiErrorMessage {
  const { kind, status, timeoutMs } = error.info;
  const detail = error.info.serverMessage ?? '';
  switch (kind) {
    case 'timeout':
      return timeoutMs === undefined
        ? say('error.api.timeoutPlain')
        : say('error.api.timeout', { seconds: Math.round(timeoutMs / 1000) });
    case 'network':
      return say('error.api.network');
    case 'parse':
      return say('error.api.parse');
    case 'contract':
      return say('error.api.contract');
    case 'aborted':
      return say('error.api.aborted');
    case 'http':
      break;
  }
  const coded = codedMessage(error);
  if (coded !== null) return coded;
  if (status === 403) return say('error.api.forbidden');
  if (status === 404) return detail === '' ? say('error.api.notFound') : say('error.api.notFoundDetail', { detail });
  if (status >= 500) {
    return detail === '' ? say('error.api.server', { status }) : say('error.api.serverDetail', { status, detail });
  }
  return detail === '' ? say('error.api.failed', { status }) : say('error.api.failedDetail', { status, detail });
}

/**
 * The reason of a failure as text in the language of `t`: an `ApiError` through the catalogue, any other `Error` by its own
 * message (a diagnostic), `undefined` when there is nothing to say.
 */
export function describeApiError(error: Error | undefined, t: TFunction): string | undefined {
  if (error === undefined) return undefined;
  // The reason is quoted inside a sentence of its own: the full stop the server put at the end of its message would double.
  if (error instanceof ApiError)
    return apiErrorMessage(error)
      .text(t)
      .replace(/[. ]+$/u, '');
  return error.message === '' ? undefined : error.message;
}

// ---- the error-code table of 04 5.1 ------------------------------------------------------------------------------------

export type ErrorAction =
  /** The infinite list restarts at its first page (5.3 rule 2). */
  | 'restart-list'
  /** `ErrorState` "The monitor rejected this filter"; the filter bar stays editable. */
  | 'rejected-filter'
  /** Full-page refusal of the page's address. */
  | 'refused-address'
  /** The not-found states of 3.4. */
  | 'not-found'
  /**
   * A read answered `access_required`: the page keeps its frame and the view says "Access link needed" (ADR 0099). The
   * session is marked locked by `useAuthSession`.
   */
  | 'locked'
  /** A write answered `access_required`, or `access_code_invalid`: the dialog closes, the locked state shows. */
  | 'access-required'
  /** `access_rate_limited` (429): the locked state says "try again in N s" from `retryAfterMs`. */
  | 'access-rate-limited'
  /** `terminal_limit` (429): a toast. */
  | 'terminal-limit'
  /** `terminal_unavailable` or `claude_not_found` (503): the pane notice by the capability reason. */
  | 'terminal-unavailable'
  /** The panel is removed from the workspace panels (4.4.1). */
  | 'panel-removed'
  /** The transcript `gone` state. */
  | 'transcript-gone'
  /** Retried once after the `Retry-After`, then "busy" text. */
  | 'busy'
  | 'internal'
  /** 503: the monitor is busy, restarting or out of disk. */
  | 'unavailable'
  /** Network, timeout or unreadable response. */
  | 'transport'
  | 'contract'
  | 'aborted'
  /** Any other status or code, grouped by status. */
  | 'other';

/** `no`: never retried; `once`: one retry after `Retry-After`; `backoff`: up to three retries with backoff. */
export type RetryPlan = 'no' | 'once' | 'backoff';

/** What to do for a failure. `messageKey` and `args` are the text the UI shows; render it with `text(t)`. */
export interface ErrorHandling extends ApiErrorMessage {
  action: ErrorAction;
  retry: RetryPlan;
  /** A line for the health details (the disk-full note, or the unknown code); `null` when there is none. */
  healthNote: ApiErrorMessage | null;
}

const REJECTED_FILTER_CODES: readonly ErrorCode[] = [
  'validation_failed',
  'param_repeated',
  'range_invalid',
  'range_too_large',
  'filter_requires_scope',
  'query_too_short',
];
const REFUSED_ADDRESS_CODES: readonly ErrorCode[] = [
  'host_not_allowed',
  'origin_not_allowed',
  'cross_site_request',
  'csrf_rejected',
];
/** Codes of the terminal area that are known and complete: no note for the health details (ADR 0099). */
const KNOWN_OTHER_CODES: readonly ErrorCode[] = ['resume_unavailable', 'picker_busy', 'folder_limit'];
const NOT_FOUND_CODES: readonly ErrorCode[] = [
  'session_not_found',
  'agent_not_found',
  'event_not_found',
  'work_item_not_found',
  'route_not_found',
];
const UNAVAILABLE_CODES: readonly ErrorCode[] = ['db_busy', 'disk_full', 'shutting_down', 'stream_limit'];

function has(list: readonly ErrorCode[], code: ErrorCode | null): boolean {
  return code !== null && list.includes(code);
}

function handling(
  action: ErrorAction,
  retry: RetryPlan,
  message: ApiErrorMessage,
  healthNote: ApiErrorMessage | null = null,
): ErrorHandling {
  return { action, retry, messageKey: message.messageKey, args: message.args, text: message.text, healthNote };
}

/**
 * The codes of ADR 0099, decided before the generic groups: a 429 or a 503 of these codes is not "busy" or "unavailable" (a
 * retry would not help, and the words differ). `null` for any other failure.
 */
function accessHandling(error: ApiError, generic: ApiErrorMessage): ErrorHandling | null {
  const { status, code, method } = error.info;
  if (status === 401 && code === 'access_required') {
    return handling(method === 'POST' ? 'access-required' : 'locked', 'no', generic);
  }
  if (status === 401 && code === 'access_code_invalid') return handling('access-required', 'no', generic);
  // The retry plans below are the ones of the query client, which treats every 429 as "once" and every 503 as "backoff"
  // (`shouldRetry`, kept in step by a test); they matter to reads only: a write never retries (ADR 0099).
  if (status === 429 && code === 'access_rate_limited') return handling('access-rate-limited', 'once', generic);
  if (status === 429 && code === 'terminal_limit') return handling('terminal-limit', 'once', generic);
  if (status === 503 && (code === 'terminal_unavailable' || code === 'claude_not_found')) {
    return handling('terminal-unavailable', 'backoff', generic);
  }
  if ((status === 400 && code === 'folder_invalid') || (status === 404 && code === 'folder_not_found')) {
    return handling('rejected-filter', 'no', generic);
  }
  return null;
}

/** What the UI does for a failure, by status first and by code only where 04 5.1 lists one. */
export function handlingFor(error: ApiError): ErrorHandling {
  const { kind, status, code } = error.info;
  const generic = apiErrorMessage(error);
  if (kind === 'aborted') return handling('aborted', 'no', generic);
  if (kind === 'contract') return handling('contract', 'no', generic);
  if (kind !== 'http') return handling('transport', 'backoff', generic);

  const access = accessHandling(error, generic);
  if (access !== null) return access;

  if (status === 400 && code === 'cursor_invalid') {
    return handling('restart-list', 'no', say('error.handling.listChanged'));
  }
  if (status === 400 && has(REJECTED_FILTER_CODES, code)) {
    const detail = error.info.serverMessage ?? '';
    return handling(
      'rejected-filter',
      'no',
      detail === '' ? say('error.handling.rejectedFilter') : say('error.handling.rejectedFilterDetail', { detail }),
    );
  }
  if (status === 403 && has(REFUSED_ADDRESS_CODES, code)) {
    return handling('refused-address', 'no', say('error.handling.refusedAddress'));
  }
  if (status === 404 && code === 'panel_disabled') return handling('panel-removed', 'no', generic);
  if (status === 404 && code === 'terminal_not_found') return handling('not-found', 'no', generic);
  if (status === 404 && has(NOT_FOUND_CODES, code)) return handling('not-found', 'no', generic);
  if (status === 410 && code === 'transcript_gone') {
    return handling('transcript-gone', 'no', say('error.handling.transcriptGone'));
  }
  if (status === 429) return handling('busy', 'once', say('error.handling.busy'));
  if (status === 500 && code === 'internal_error') {
    const id = error.info.requestId;
    return handling(
      'internal',
      'backoff',
      id === null ? say('error.handling.internal') : say('error.handling.internalRequest', { id }),
    );
  }
  if (status === 503 && has(UNAVAILABLE_CODES, code)) {
    return handling('unavailable', 'backoff', generic, code === 'disk_full' ? say('error.handling.diskFull') : null);
  }
  // Forward compatibility: grouped by status. Server failures are retried, client failures are not.
  return handling(
    'other',
    status >= 500 ? 'backoff' : 'no',
    generic,
    code === null || has(KNOWN_OTHER_CODES, code) ? null : say('error.handling.unknownCode', { code }),
  );
}
