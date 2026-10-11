import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  RESERVED_ERROR_CODES,
  type ErrorCode,
} from './errors.ts';

// 03 5.2 table, spelled out once more here on purpose: a drift in either place fails.
const TABLE: Record<number, string[]> = {
  400: [
    'validation_failed',
    'param_repeated',
    'body_invalid_json',
    'cursor_invalid',
    'range_invalid',
    'range_too_large',
    'filter_requires_scope',
    'query_too_short',
  ],
  403: ['host_not_allowed', 'origin_not_allowed', 'cross_site_request', 'csrf_rejected'],
  404: [
    'route_not_found',
    'session_not_found',
    'agent_not_found',
    'event_not_found',
    'work_item_not_found',
    'alert_not_found',
    'panel_disabled',
    'probe_not_found',
    'completion_target_not_found',
  ],
  405: ['method_not_allowed'],
  409: ['instance_mismatch'],
  410: ['transcript_gone'],
  413: ['payload_too_large'],
  414: ['uri_too_long'],
  415: ['unsupported_media_type'],
  429: ['search_busy', 'export_busy'],
  500: ['internal_error'],
  503: ['db_busy', 'disk_full', 'stream_limit', 'shutting_down'],
};

describe('ErrorCode catalogue (03 5.2, registry 7.1)', () => {
  it('has exactly the codes of the table, each with its HTTP status', () => {
    const expected = Object.entries(TABLE).flatMap(([status, codes]) => codes.map((c) => [c, Number(status)] as const));
    expect([...ERROR_CODES].sort()).toEqual(expected.map(([c]) => c).sort());
    for (const [code, status] of expected) {
      expect(ERROR_HTTP_STATUS[code as ErrorCode], code).toBe(status);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('are lowercase snake_case and never CLI-style upper case', () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('reserves exactly csrf_rejected and alert_not_found (97 F-4)', () => {
    expect([...RESERVED_ERROR_CODES].sort()).toEqual(['alert_not_found', 'csrf_rejected']);
  });

  it('the schema accepts catalogue codes only', () => {
    expect(ErrorCodeSchema.safeParse('cursor_invalid').success).toBe(true);
    expect(ErrorCodeSchema.safeParse('CURSOR_INVALID').success).toBe(false);
    expect(ErrorCodeSchema.safeParse('cursor_expired').success).toBe(false);
  });
});

describe('ErrorEnvelope (03 5.2)', () => {
  const ok = { error: { code: 'validation_failed', message: 'Invalid query.', requestId: 'r-0123456789ab' } };

  it('parses with and without details', () => {
    expect(ErrorEnvelopeSchema.safeParse(ok).success).toBe(true);
    const withDetails = {
      error: { ...ok.error, details: [{ path: 'limit', issue: 'too_big' }] },
    };
    expect(ErrorEnvelopeSchema.safeParse(withDetails).success).toBe(true);
  });

  it('is strict and checks the request id shape', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...ok.error, extra: 1 } }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...ok.error, requestId: 'x' } }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...ok.error, code: 'nope' } }).success).toBe(false);
    expect(
      ErrorEnvelopeSchema.safeParse({ error: { ...ok.error, details: [{ path: 'q', issue: 'x', value: 'secret' }] } })
        .success,
    ).toBe(false);
  });
});
