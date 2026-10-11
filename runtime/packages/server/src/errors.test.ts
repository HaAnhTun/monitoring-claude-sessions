// The error mapper and the envelope sender (03 5.2 step 9, DA-T-API-3): one fixed message per code, the status and the
// headers of each code, and the mapping of everything a handler or the engine can throw.
import { DbError } from '@mcs/engine';
import { ERROR_CODES, ERROR_HTTP_STATUS, ErrorEnvelopeSchema, REQUEST_ID_RE, type ErrorCode } from '@mcs/shared';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';

import { ApiError, ERROR_MESSAGES, mapError, sendError } from './errors.ts';
import { GUARD_ERROR_MESSAGES } from './http/guards.ts';

/** The parts of an Express response that `sendError` uses. */
class FakeResponse {
  statusCode = 0;
  headersSent = false;
  body: unknown = undefined;
  readonly headers = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    return this;
  }

  end(): this {
    this.headersSent = true;
    return this;
  }
}

function send(code: ErrorCode, opts?: Parameters<typeof sendError>[2]): FakeResponse {
  const res = new FakeResponse();
  res.setHeader('X-Request-Id', 'r-abcdefghijkl');
  sendError(res as unknown as Response, code, opts);
  return res;
}

describe('ERROR_MESSAGES', () => {
  it('has one fixed English sentence for every code, and never a template or a request value', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const message = ERROR_MESSAGES[code];
      expect(message.length, code).toBeGreaterThan(8);
      expect(message, code).toMatch(/^[A-Z][A-Za-z0-9 ,;.'/-]+[.]$/);
      expect(message, code).not.toContain('${');
    }
  });

  it('agrees with the guards for the codes the guards send', () => {
    for (const [code, message] of Object.entries(GUARD_ERROR_MESSAGES)) {
      expect(ERROR_MESSAGES[code as ErrorCode], code).toBe(message);
    }
  });
});

describe('sendError', () => {
  it('sends the envelope with the status of the catalogue and the request id of the response', () => {
    for (const code of ERROR_CODES) {
      const res = send(code);
      expect(res.statusCode, code).toBe(ERROR_HTTP_STATUS[code]);
      const parsed = ErrorEnvelopeSchema.safeParse(res.body);
      expect(parsed.success, code).toBe(true);
      expect(res.body, code).toEqual({
        error: { code, message: ERROR_MESSAGES[code], requestId: 'r-abcdefghijkl' },
      });
      expect(res.getHeader('cache-control'), code).toBe('no-store');
    }
  });

  it('adds Retry-After for the busy codes and Allow for a 405', () => {
    expect(send('db_busy').getHeader('retry-after')).toBe('1');
    expect(send('search_busy').getHeader('retry-after')).toBe('2');
    expect(send('export_busy').getHeader('retry-after')).toBe('2');
    expect(send('internal_error').getHeader('retry-after')).toBeUndefined();
    expect(send('method_not_allowed', { allow: ['GET', 'HEAD'] }).getHeader('allow')).toBe('GET, HEAD');
    expect(send('method_not_allowed').getHeader('allow')).toBeUndefined();
  });

  it('carries details only when there are some', () => {
    const details = [{ path: 'limit', issue: 'too_big' }];
    expect(send('validation_failed', { details }).body).toEqual({
      error: {
        code: 'validation_failed',
        message: ERROR_MESSAGES.validation_failed,
        requestId: 'r-abcdefghijkl',
        details,
      },
    });
    expect(send('validation_failed', { details: [] }).body).not.toHaveProperty('error.details');
  });

  it('makes a request id when the response has none, and ends a response whose headers were sent', () => {
    const bare = new FakeResponse();
    sendError(bare as unknown as Response, 'route_not_found');
    const body = ErrorEnvelopeSchema.parse(bare.body);
    expect(body.error.requestId).toMatch(REQUEST_ID_RE);
    expect(bare.getHeader('x-request-id')).toBe(body.error.requestId);

    const sent = new FakeResponse();
    sent.headersSent = true;
    sendError(sent as unknown as Response, 'internal_error');
    expect(sent.body).toBeUndefined();
    expect(sent.statusCode).toBe(0);
  });
});

describe('mapError', () => {
  it('maps an ApiError to its code and details, without recording it as internal', () => {
    const details = [{ path: 'a', issue: 'invalid_type' }];
    expect(mapError(new ApiError('session_not_found'))).toEqual({ code: 'session_not_found', internal: false });
    expect(mapError(new ApiError('validation_failed', { details }))).toEqual({
      code: 'validation_failed',
      details,
      internal: false,
    });
  });

  it('maps the database errors: busy to 503 db_busy, full to 503 disk_full, every other one to internal_error', () => {
    expect(mapError(new DbError('db_busy', 'busy'))).toEqual({ code: 'db_busy', internal: false });
    expect(mapError(new DbError('db_full', 'full'))).toEqual({ code: 'disk_full', internal: false });
    for (const code of ['db_corrupt', 'db_io', 'db_locked', 'db_readonly', 'scope_mismatch'] as const) {
      expect(mapError(new DbError(code, 'x')), code).toEqual({ code: 'internal_error', internal: true });
    }
  });

  it('maps a NotFoundError of the engine (03 12.1) to the 404 code it carries', () => {
    class NotFoundError extends Error {
      readonly code = 'session_not_found';
    }
    expect(mapError(new NotFoundError('x'))).toEqual({ code: 'session_not_found', internal: false });
    class NotFoundErrorOfAnotherKind extends Error {
      override readonly name = 'NotFoundError';
      readonly code = 'internal_error';
    }
    expect(mapError(new NotFoundErrorOfAnotherKind('x')).code).toBe('internal_error');
    class OtherError extends Error {
      readonly code = 'session_not_found';
    }
    expect(mapError(new OtherError('x'))).toEqual({ code: 'internal_error', internal: true });
  });

  it('maps a failed percent-decoding of the router to validation_failed', () => {
    const error = Object.assign(new URIError('bad'), { status: 400, statusCode: 400 });
    expect(mapError(error)).toEqual({
      code: 'validation_failed',
      details: [{ path: 'path', issue: 'invalid_format' }],
      internal: false,
    });
  });

  it('maps everything else to internal_error and says it is internal', () => {
    expect(mapError(new Error('boom'))).toEqual({ code: 'internal_error', internal: true });
    expect(mapError('a string')).toEqual({ code: 'internal_error', internal: true });
    expect(mapError(undefined)).toEqual({ code: 'internal_error', internal: true });
    expect(mapError(null)).toEqual({ code: 'internal_error', internal: true });
  });
});
