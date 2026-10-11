// API failures as the UI sees them (04-ui.md 5.1): the `ApiError` thrown by the client, the readable failure texts (legacy
// `describeFailure`, updated) and the table that says what the UI does for each status and error code.
import type { ErrorCode } from '@mcs/shared';

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
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly info: ApiErrorInfo;

  constructor(message: string, info: ApiErrorInfo) {
    super(message);
    this.info = info;
  }
}

/** Human, actionable message for a failed request. */
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

export interface ErrorHandling {
  action: ErrorAction;
  retry: RetryPlan;
  /** The text the UI shows; for rejected filters it quotes the envelope message. */
  message: string;
  /** A line for the health details (the disk-full note, or the unknown code); `null` when there is none. */
  healthNote: string | null;
}

const REJECTED_FILTER_CODES: readonly ErrorCode[] = [
  'validation_failed',
  'param_repeated',
  'range_invalid',
  'range_too_large',
  'filter_requires_scope',
  'query_too_short',
];
const REFUSED_ADDRESS_CODES: readonly ErrorCode[] = ['host_not_allowed', 'origin_not_allowed', 'cross_site_request'];
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

/** What the UI does for a failure, by status first and by code only where 04 5.1 lists one. */
export function handlingFor(error: ApiError): ErrorHandling {
  const { kind, status, code } = error.info;
  const none = null;
  if (kind === 'aborted') return { action: 'aborted', retry: 'no', message: error.message, healthNote: none };
  if (kind === 'contract') return { action: 'contract', retry: 'no', message: error.message, healthNote: none };
  if (kind !== 'http') return { action: 'transport', retry: 'backoff', message: error.message, healthNote: none };

  if (status === 400 && code === 'cursor_invalid') {
    return {
      action: 'restart-list',
      retry: 'no',
      message: 'The list changed; reloaded from the top',
      healthNote: none,
    };
  }
  if (status === 400 && has(REJECTED_FILTER_CODES, code)) {
    const text = error.info.serverMessage ?? '';
    return {
      action: 'rejected-filter',
      retry: 'no',
      message: `The monitor rejected this filter${text === '' ? '' : `: ${text}`}`,
      healthNote: none,
    };
  }
  if (status === 403 && has(REFUSED_ADDRESS_CODES, code)) {
    return {
      action: 'refused-address',
      retry: 'no',
      message: "The monitor refused this page's address. Open the URL printed by `$MCS status --task <slug>`.",
      healthNote: none,
    };
  }
  if (status === 404 && code === 'panel_disabled') {
    return { action: 'panel-removed', retry: 'no', message: error.message, healthNote: none };
  }
  if (status === 404 && has(NOT_FOUND_CODES, code)) {
    return { action: 'not-found', retry: 'no', message: error.message, healthNote: none };
  }
  if (status === 410 && code === 'transcript_gone') {
    return {
      action: 'transcript-gone',
      retry: 'no',
      message: 'The transcript file is gone from disk',
      healthNote: none,
    };
  }
  if (status === 429) {
    return {
      action: 'busy',
      retry: 'once',
      message: 'The monitor is busy with another request. Try again in a moment.',
      healthNote: none,
    };
  }
  if (status === 500 && code === 'internal_error') {
    const id = error.info.requestId;
    return {
      action: 'internal',
      retry: 'backoff',
      message: `The monitor hit an internal error${id === null ? '' : ` (request ${id})`}`,
      healthNote: none,
    };
  }
  if (status === 503 && has(UNAVAILABLE_CODES, code)) {
    return {
      action: 'unavailable',
      retry: 'backoff',
      message: error.message,
      healthNote: code === 'disk_full' ? "The monitor's disk is full" : none,
    };
  }
  // Forward compatibility: grouped by status. Server failures are retried, client failures are not.
  return {
    action: 'other',
    retry: status >= 500 ? 'backoff' : 'no',
    message: error.message,
    healthNote: code,
  };
}
