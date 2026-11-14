// The error mapper and the envelope sender (03 5.2 step 9, DA-T-API-3): one fixed message per code, the status and the
// headers of each code, and the mapping of everything a handler or the engine can throw.
import { DbError } from '@mcs/engine';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  REQUEST_ID_RE,
  TERMINAL_ERROR_CODES,
  type ErrorCode,
} from '@mcs/shared';
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
      expect(message, code).toMatch(/^[A-Z][A-Za-z0-9 ,:;.'/-]+[.]$/);
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

  it('adds the headers of the access and upgrade codes (02 2.2)', () => {
    for (const code of ['access_required', 'access_code_invalid'] as const) {
      expect(send(code).getHeader('www-authenticate'), code).toBe('CAW-Access');
      expect(send(code).getHeader('retry-after'), code).toBeUndefined();
    }
    const upgrade = send('upgrade_required');
    expect(upgrade.statusCode).toBe(426);
    expect(upgrade.getHeader('upgrade')).toBe('websocket');
    expect(upgrade.getHeader('connection')).toBe('Upgrade');
    for (const code of ERROR_CODES) {
      if (code === 'access_required' || code === 'access_code_invalid') continue;
      expect(send(code).getHeader('www-authenticate'), code).toBeUndefined();
      if (code !== 'upgrade_required') expect(send(code).getHeader('upgrade'), code).toBeUndefined();
    }
  });

  it('retryAfterSeconds sets Retry-After in whole seconds, at least 1, and replaces the static value', () => {
    expect(send('access_rate_limited', { retryAfterSeconds: 17 }).getHeader('retry-after')).toBe('17');
    expect(send('access_rate_limited', { retryAfterSeconds: 16.2 }).getHeader('retry-after')).toBe('17');
    expect(send('access_rate_limited', { retryAfterSeconds: 0 }).getHeader('retry-after')).toBe('1');
    expect(send('access_rate_limited').statusCode).toBe(429);
    expect(send('access_rate_limited').getHeader('retry-after')).toBe('60');
    expect(send('db_busy', { retryAfterSeconds: 5 }).getHeader('retry-after')).toBe('5');
    expect(send('access_rate_limited', { retryAfterSeconds: Number.NaN }).getHeader('retry-after')).toBe('60');
  });

  it('closeConnection sets Connection: close, and only when asked', () => {
    expect(send('payload_too_large', { closeConnection: true }).getHeader('connection')).toBe('close');
    expect(send('payload_too_large').getHeader('connection')).toBeUndefined();
    expect(send('payload_too_large', { closeConnection: false }).getHeader('connection')).toBeUndefined();
    expect(send('upgrade_required', { closeConnection: true }).getHeader('connection')).toBe('close');
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

  describe('a TerminalError of the engine (name, code and optional details)', () => {
    class TerminalError extends Error {
      readonly code: string;
      readonly details: unknown;
      constructor(code: string, details?: unknown) {
        super('a message that holds /home/someone/secret');
        this.name = 'TerminalError';
        this.code = code;
        this.details = details;
      }
    }

    it.each([
      ['UNSUPPORTED_OS', 'terminal_unavailable', false],
      ['NATIVE_MISSING', 'terminal_unavailable', false],
      ['NATIVE_LOAD_FAILED', 'terminal_unavailable', false],
      ['COMMAND_UNSUPPORTED', 'terminal_unavailable', false],
      ['ARGS_UNSAFE', 'terminal_unavailable', false],
      ['SPAWN_FAILED', 'terminal_unavailable', true],
      ['START_TIMEOUT', 'terminal_unavailable', true],
      ['CLAUDE_NOT_FOUND', 'claude_not_found', false],
      ['FOLDER_INVALID', 'folder_invalid', false],
      ['FOLDER_NOT_FOUND', 'folder_invalid', false],
      ['SESSION_LIMIT', 'terminal_limit', false],
      ['SESSION_NOT_FOUND', 'terminal_not_found', false],
      ['SESSION_ENDED', 'terminal_not_found', false],
      ['NAME_INVALID', 'terminal_not_found', false],
      ['MESSAGE_TOO_LARGE', 'payload_too_large', false],
      ['SHUTTING_DOWN', 'shutting_down', false],
    ] as const)('maps %s to %s (internal: %s)', (engineCode, code, internal) => {
      expect(mapError(new TerminalError(engineCode))).toEqual({ code, internal });
    });

    it('passes the codes of TERMINAL_ERROR_CODES through, with details of the shape { path, issue }', () => {
      for (const code of TERMINAL_ERROR_CODES) {
        expect(mapError(new TerminalError(code)), code).toEqual({ code, internal: false });
      }
      const details = [{ path: 'sessionId', issue: 'not_resumable' }];
      expect(mapError(new TerminalError('resume_unavailable', details))).toEqual({
        code: 'resume_unavailable',
        details,
        internal: false,
      });
      expect(mapError(new TerminalError('FOLDER_INVALID', details)).details).toEqual(details);
    });

    it('drops details of another shape and never forwards the message', () => {
      for (const bad of [[{ path: 'a' }], [{ path: 'a', issue: 1 }], ['x'], [], 'text', { path: 'a', issue: 'b' }]) {
        const mapped = mapError(new TerminalError('FOLDER_INVALID', bad));
        expect(mapped, JSON.stringify(bad)).toEqual({ code: 'folder_invalid', internal: false });
      }
      expect(JSON.stringify(mapError(new TerminalError('SESSION_LIMIT')))).not.toContain('secret');
    });

    it('treats an unknown or missing code as an internal failure, and ignores a look-alike that is not a TerminalError', () => {
      expect(mapError(new TerminalError('NOPE'))).toEqual({ code: 'internal_error', internal: true });
      expect(mapError(new TerminalError('constructor'))).toEqual({ code: 'internal_error', internal: true });
      const noCode = new Error('x');
      noCode.name = 'TerminalError';
      expect(mapError(noCode)).toEqual({ code: 'internal_error', internal: true });
      class Other extends Error {
        readonly code = 'SESSION_LIMIT';
      }
      expect(mapError(new Other('x'))).toEqual({ code: 'internal_error', internal: true });
    });
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
