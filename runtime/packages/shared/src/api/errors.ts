// The HTTP error catalogue and the error envelope (03 5.2, registry 7.1). `ErrorCode` is the only type of that name in
// `@mcs/shared`; the CLI union is `CliErrorCode` (`../errors.ts`, registry C19).
import { z } from 'zod';

/** Every code, grouped by HTTP status exactly as in the table of 03 5.2. */
export const ERROR_CODES = [
  'validation_failed',
  'param_repeated',
  'body_invalid_json',
  'cursor_invalid',
  'range_invalid',
  'range_too_large',
  'filter_requires_scope',
  'query_too_short',
  'host_not_allowed',
  'origin_not_allowed',
  'cross_site_request',
  'csrf_rejected',
  'route_not_found',
  'session_not_found',
  'agent_not_found',
  'event_not_found',
  'work_item_not_found',
  'alert_not_found',
  'panel_disabled',
  'probe_not_found',
  'completion_target_not_found',
  'method_not_allowed',
  'instance_mismatch',
  'transcript_gone',
  'payload_too_large',
  'uri_too_long',
  'unsupported_media_type',
  'search_busy',
  'export_busy',
  'internal_error',
  'db_busy',
  'disk_full',
  'stream_limit',
  'shutting_down',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** The HTTP status of each code; the type makes a missing or extra code a compile error. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  param_repeated: 400,
  body_invalid_json: 400,
  cursor_invalid: 400,
  range_invalid: 400,
  range_too_large: 400,
  filter_requires_scope: 400,
  query_too_short: 400,
  host_not_allowed: 403,
  origin_not_allowed: 403,
  cross_site_request: 403,
  csrf_rejected: 403,
  route_not_found: 404,
  session_not_found: 404,
  agent_not_found: 404,
  event_not_found: 404,
  work_item_not_found: 404,
  alert_not_found: 404,
  panel_disabled: 404,
  probe_not_found: 404,
  completion_target_not_found: 404,
  method_not_allowed: 405,
  instance_mismatch: 409,
  transcript_gone: 410,
  payload_too_large: 413,
  uri_too_long: 414,
  unsupported_media_type: 415,
  search_busy: 429,
  export_busy: 429,
  internal_error: 500,
  db_busy: 503,
  disk_full: 503,
  stream_limit: 503,
  shutting_down: 503,
};

/**
 * Codes that stay in the union but that no v3 route can produce today (03 5.2 "Reserved codes"). The contract meta-test of
 * DA-T-API-3 exempts exactly these two.
 */
export const RESERVED_ERROR_CODES: readonly ErrorCode[] = ['csrf_rejected', 'alert_not_found'];

/** `X-Request-Id`: `r-` and twelve base36 characters. */
export const REQUEST_ID_RE = /^r-[0-9a-z]{12}$/;

/** `details[]`: where (a dotted query path) and the Zod issue code. Never the rejected value (exp X6). */
export const ErrorDetailSchema = z.strictObject({ path: z.string(), issue: z.string() });

export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().regex(REQUEST_ID_RE),
    details: z.array(ErrorDetailSchema).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
