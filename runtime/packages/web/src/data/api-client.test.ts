import { ERROR_CODES, ERROR_HTTP_STATUS, type ErrorCode } from '@mcs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, describeFailure, handlingFor, type ApiErrorKind } from './api-errors.ts';
import { createApiClient, type ResponseSchema } from './api-client.ts';
import { createEndpointTracker } from './endpoint-tracker.ts';
import type { EndpointName } from './endpoints.ts';
import { createQueryClient, retryDelay, shouldRetry } from './query-client.ts';

interface Thing {
  n: number;
}

/** A structural schema (the client never imports zod): accepts `{ n: number }`. */
const thingSchema: ResponseSchema<Thing> = {
  safeParse(value) {
    if (typeof value === 'object' && value !== null && 'n' in value && typeof value.n === 'number') {
      return { success: true, data: { n: value.n } };
    }
    return { success: false, error: { issues: [{ path: ['n'] }] } };
  },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function envelope(code: string, message: string, status: number, requestId = 'r-0123456789ab'): Response {
  return json({ error: { code, message, requestId } }, status);
}

type FetchFn = typeof fetch;

function clientWith(impl: FetchFn, extra: { timeoutMs?: number; now?: () => number; baseUrl?: string } = {}) {
  const fetchImpl = vi.fn<FetchFn>(impl);
  const client = createApiClient({ fetchImpl, ...extra });
  return { client, fetchImpl };
}

/** A fetch that never answers and rejects with an AbortError when its signal fires. */
function hangingFetch(): FetchFn {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

const endpoint = (name: string): EndpointName => name as EndpointName;

function urlOf(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('describeFailure', () => {
  it('keeps the legacy texts and updates the network and contract ones', () => {
    expect(describeFailure('timeout', 0, '', 8000)).toBe('No answer from the monitor within 8 s');
    expect(describeFailure('network', 0, '', 8000)).toBe(
      'Cannot reach the monitor (is the runtime still running? Try `$MCS status`)',
    );
    expect(describeFailure('parse', 0, '', 8000)).toBe('The monitor sent an unreadable response');
    expect(describeFailure('contract', 0, '', 8000)).toBe('The monitor sent data this page does not understand');
    expect(describeFailure('http', 403, '', 8000)).toBe(
      'Request rejected (403): open this page via 127.0.0.1 or localhost',
    );
    expect(describeFailure('http', 404, 'no such thing', 8000)).toBe('Not found: no such thing');
    expect(describeFailure('http', 404, '', 8000)).toBe('Not found (404)');
    expect(describeFailure('http', 500, 'kaput', 8000)).toBe('Monitor error (500): kaput');
    expect(describeFailure('http', 503, '', 8000)).toBe('Monitor error (503)');
    expect(describeFailure('http', 400, 'bad filter', 8000)).toBe('Request failed (400): bad filter');
  });

  it('never shows an aborted request as an error text of its own', () => {
    expect(describeFailure('aborted', 0, '', 8000)).toBe('The request was cancelled');
  });
});

describe('createApiClient: requests', () => {
  it('builds baseUrl + path + sorted query and omits null, undefined, empty and false', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })), { baseUrl: 'http://h.invalid:1' });
    await client.get('sessions', '/api/v3/sessions', thingSchema, {
      query: {
        z: 'last',
        a: 'first',
        none: null,
        missing: undefined,
        empty: '',
        no: false,
        yes: true,
        num: 5,
        list: ['x', 'y'],
        emptyList: [],
      },
    });
    const url = urlOf(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toBe('http://h.invalid:1/api/v3/sessions?a=first&list=x%2Cy&num=5&yes=1&z=last');
  });

  it('sends the JSON accept header, no-store and same-origin credentials', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    await client.get('instance', '/api/v3/instance', thingSchema);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.cache).toBe('no-store');
    expect(init?.credentials).toBe('same-origin');
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toBe('/api/v3/instance');
  });

  it('returns the validated body and records the success time', async () => {
    const { client } = clientWith(() => Promise.resolve(json({ n: 7, extra: 'dropped' })), { now: () => 1000 });
    expect(await client.get('health', '/api/v3/health', thingSchema)).toEqual({ n: 7 });
    expect(client.tracker.get('health')).toMatchObject({
      name: 'health',
      lastSuccess: 1000,
      failures: 0,
      inFlight: 0,
      lastError: null,
    });
  });
});

describe('createApiClient: failures', () => {
  it('maps a network failure and counts it', async () => {
    const { client } = clientWith(() => Promise.reject(new TypeError('fetch failed')), { now: () => 5 });
    const error = await failureOf(client.get('overview', '/api/v3/overview', thingSchema));
    expect(error.info).toMatchObject({ kind: 'network', status: 0, code: null, endpoint: 'overview', requestId: null });
    expect(error.message).toContain('Cannot reach the monitor');
    expect(client.tracker.get('overview')).toMatchObject({
      failures: 1,
      inFlight: 0,
      lastError: { kind: 'network', status: 0, t: 5 },
    });
  });

  it('times out a hanging request and reports the configured timeout in whole seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client } = clientWith(hangingFetch(), { timeoutMs: 8000 });
    const pending = failureOf(client.get('health', '/api/v3/health', thingSchema));
    await vi.advanceTimersByTimeAsync(8001);
    const error = await pending;
    expect(error.info.kind).toBe('timeout');
    expect(error.message).toBe('No answer from the monitor within 8 s');
    expect(error.info.timeoutMs).toBe(8000);
    expect(client.tracker.get('health')?.failures).toBe(1);
  });

  it('lets one call override the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client } = clientWith(hangingFetch(), { timeoutMs: 60_000 });
    const pending = failureOf(client.get('health', '/api/v3/health', thingSchema, { timeoutMs: 2000 }));
    await vi.advanceTimersByTimeAsync(2001);
    expect((await pending).message).toBe('No answer from the monitor within 2 s');
  });

  it('treats a caller abort as aborted and does not count a failure', async () => {
    const { client } = clientWith(hangingFetch());
    const ctrl = new AbortController();
    const pending = failureOf(client.get('sessions', '/api/v3/sessions', thingSchema, { signal: ctrl.signal }));
    expect(client.tracker.get('sessions')?.inFlight).toBe(1);
    ctrl.abort();
    const error = await pending;
    expect(error.info.kind).toBe('aborted');
    expect(client.tracker.get('sessions')).toMatchObject({ failures: 0, inFlight: 0, lastError: null });
  });

  it('does not call fetch when the caller signal is already aborted', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    const ctrl = new AbortController();
    ctrl.abort();
    const error = await failureOf(client.get('sessions', '/api/v3/sessions', thingSchema, { signal: ctrl.signal }));
    expect(error.info.kind).toBe('aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.tracker.get('sessions')?.failures ?? 0).toBe(0);
  });

  it('keeps the last error across a later aborted request', async () => {
    let call = 0;
    const hang = hangingFetch();
    const { client } = clientWith((url, init) => {
      call += 1;
      return call === 1 ? Promise.resolve(envelope('internal_error', 'kaput', 500)) : hang(url, init);
    });
    await failureOf(client.get('sessions', '/api/v3/sessions', thingSchema));
    const ctrl = new AbortController();
    const second = failureOf(client.get('sessions', '/api/v3/sessions', thingSchema, { signal: ctrl.signal }));
    ctrl.abort();
    await second;
    expect(client.tracker.get('sessions')).toMatchObject({ failures: 1, lastError: { status: 500 } });
  });

  it('maps a v3 error envelope: code, request id and the server message', async () => {
    const { client } = clientWith(() => Promise.resolve(envelope('session_not_found', 'No such session', 404)));
    const error = await failureOf(client.get('session', '/api/v3/sessions/x', thingSchema));
    expect(error.info).toEqual({
      kind: 'http',
      status: 404,
      code: 'session_not_found',
      endpoint: 'session',
      requestId: 'r-0123456789ab',
      serverMessage: 'No such session',
    });
    expect(error.message).toBe('Not found: No such session');
    expect(error.name).toBe('ApiError');
  });

  it('gives code null for an unknown code, a malformed envelope or a non-JSON body', async () => {
    const bodies: (() => Response)[] = [
      () => envelope('brand_new_code', 'hmm', 400),
      () => json({ error: 'legacy string' }, 400),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    ];
    for (const make of bodies) {
      const { client } = clientWith(() => Promise.resolve(make()));
      const error = await failureOf(client.get('sessions', '/api/v3/sessions', thingSchema));
      expect(error.info.kind).toBe('http');
      expect(error.info.code).toBeNull();
    }
  });

  it('uses the X-Request-Id header when the envelope is unusable', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(new Response('oops', { status: 500, headers: { 'X-Request-Id': 'r-abcdefghijkl' } })),
    );
    const error = await failureOf(client.get('sessions', '/api/v3/sessions', thingSchema));
    expect(error.info.requestId).toBe('r-abcdefghijkl');
  });

  it('reads Retry-After seconds from a 429', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'search_busy', message: 'busy', requestId: 'r-0123456789ab' } }), {
          status: 429,
          headers: { 'Retry-After': '3' },
        }),
      ),
    );
    const error = await failureOf(client.get('transcriptSearch', '/api/v3/search/transcript', thingSchema));
    expect(error.info.retryAfterMs).toBe(3000);
  });

  it('maps a 2xx body that is not JSON to parse', async () => {
    const { client } = clientWith(() => Promise.resolve(new Response('not json', { status: 200 })));
    const error = await failureOf(client.get('health', '/api/v3/health', thingSchema));
    expect(error.info.kind).toBe('parse');
    expect(error.message).toBe('The monitor sent an unreadable response');
    expect(client.tracker.get('health')?.failures).toBe(1);
  });

  it('surfaces a contract failure with the endpoint and warns with issue paths, never values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = clientWith(() => Promise.resolve(json({ n: 'secret-value' })));
    const error = await failureOf(client.get('overview', '/api/v3/overview', thingSchema));
    expect(error.info).toMatchObject({ kind: 'contract', status: 200, endpoint: 'overview' });
    expect(error.message).toBe('The monitor sent data this page does not understand (overview)');
    expect(client.tracker.get('overview')).toMatchObject({ failures: 1, lastError: { kind: 'contract' } });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('n');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value');
  });

  it('resets the failure count on the next success', async () => {
    let ok = false;
    const { client } = clientWith(() =>
      Promise.resolve(ok ? json({ n: 1 }) : envelope('internal_error', 'kaput', 500)),
    );
    await failureOf(client.get('health', '/api/v3/health', thingSchema));
    await failureOf(client.get('health', '/api/v3/health', thingSchema));
    expect(client.tracker.get('health')?.failures).toBe(2);
    ok = true;
    await client.get('health', '/api/v3/health', thingSchema);
    expect(client.tracker.get('health')).toMatchObject({ failures: 0 });
  });
});

describe('createApiClient: post (ADR 0099)', () => {
  const POST = '/api/v3/terminal/sessions';

  it('TC-UI-02: sends a JSON body with the content type and the X-MCS-Request header, no-store, same-origin', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 2 })));
    expect(await client.post(endpoint('terminalCreateSession'), POST, { path: 'FIXTURE-folder' }, thingSchema)).toEqual(
      {
        n: 2,
      },
    );
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(urlOf(input)).toBe(POST);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ path: 'FIXTURE-folder' }));
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-MCS-Request': '1',
    });
    expect(init?.cache).toBe('no-store');
    expect(init?.credentials).toBe('same-origin');
  });

  it('prepends the base url and sends an empty object body as {}', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })), { baseUrl: 'http://h.invalid:1' });
    await client.post(endpoint('authLogout'), '/api/v3/auth/logout', {}, thingSchema);
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toBe('http://h.invalid:1/api/v3/auth/logout');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  it('accepts a body of exactly 4096 bytes and refuses one byte more with a TypeError, before any request', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    const overhead = JSON.stringify({ text: '' }).length;
    const exact = { text: 'a'.repeat(4096 - overhead) };
    await client.post(endpoint('addFolder'), '/api/v3/folders', exact, thingSchema);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const tooBig = { text: 'a'.repeat(4096 - overhead + 1) };
    await expect(client.post(endpoint('addFolder'), '/api/v3/folders', tooBig, thingSchema)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.tracker.get('addFolder')).toMatchObject({ inFlight: 0, failures: 0 });
  });

  it('measures the guard in UTF-8 bytes, not characters', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    // 1500 three-byte characters are 4500 bytes but only 1500 characters.
    const wide = { text: '€'.repeat(1500) };
    await expect(client.post(endpoint('addFolder'), '/api/v3/folders', wide, thingSchema)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never repeats the body in the guard error', async () => {
    const { client } = clientWith(() => Promise.resolve(json({ n: 1 })));
    const marker = 'FIXTURE-body-marker';
    const error: unknown = await client
      .post(endpoint('addFolder'), '/api/v3/folders', { text: marker + 'a'.repeat(5000) }, thingSchema)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).not.toContain(marker);
  });

  it('refuses a body that has no JSON form with a TypeError', async () => {
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    await expect(client.post(endpoint('authLogout'), '/x', undefined, thingSchema)).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry: one fetch for a 500, a 503 and a network failure', async () => {
    for (const make of [
      () => Promise.resolve(envelope('internal_error', 'kaput', 500)),
      () => Promise.resolve(envelope('terminal_unavailable', 'no', 503)),
      () => Promise.reject(new TypeError('down')),
    ]) {
      const { client, fetchImpl } = clientWith(make);
      await failureOf(client.post(endpoint('terminalCreateSession'), POST, { path: 'p' }, thingSchema));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the error kinds of get: http with the envelope, network, parse and contract', async () => {
    const http = clientWith(() => Promise.resolve(envelope('folder_invalid', 'Bad folder', 400)));
    const failed = await failureOf(
      http.client.post(endpoint('addFolder'), '/api/v3/folders', { path: 'p' }, thingSchema),
    );
    expect(failed.info).toMatchObject({
      kind: 'http',
      status: 400,
      code: 'folder_invalid',
      endpoint: 'addFolder',
      requestId: 'r-0123456789ab',
      serverMessage: 'Bad folder',
      method: 'POST',
    });

    const network = clientWith(() => Promise.reject(new TypeError('down')));
    expect((await failureOf(network.client.post(endpoint('authLogout'), '/x', {}, thingSchema))).info).toMatchObject({
      kind: 'network',
      method: 'POST',
    });

    const parse = clientWith(() => Promise.resolve(new Response('not json', { status: 200 })));
    expect((await failureOf(parse.client.post(endpoint('authLogout'), '/x', {}, thingSchema))).info.kind).toBe('parse');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const contract = clientWith(() => Promise.resolve(json({ n: 'x' })));
    expect((await failureOf(contract.client.post(endpoint('authLogout'), '/x', {}, thingSchema))).info).toMatchObject({
      kind: 'contract',
    });
    warn.mockRestore();
  });

  it('leaves the info of a failed get without a method, so the two stay distinguishable', async () => {
    const { client } = clientWith(() => Promise.resolve(envelope('access_required', 'Sign in', 401)));
    const error = await failureOf(client.get('terminalState', '/api/v3/terminal/state', thingSchema));
    expect(Object.hasOwn(error.info, 'method')).toBe(false);
  });

  it('reads Retry-After from a 429 of a write', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'access_rate_limited', message: 'slow', requestId: 'r-0123456789ab' } }),
          { status: 429, headers: { 'Retry-After': '12' } },
        ),
      ),
    );
    const error = await failureOf(client.post(endpoint('authExchange'), '/api/v3/auth/exchange', {}, thingSchema));
    expect(error.info).toMatchObject({ status: 429, code: 'access_rate_limited', retryAfterMs: 12_000 });
  });

  it('times out after the default and honours the per-call timeout and the caller abort', async () => {
    vi.useFakeTimers();
    const slow = clientWith(hangingFetch(), { timeoutMs: 8000 });
    const first = failureOf(slow.client.post(endpoint('terminalCreateSession'), POST, { path: 'p' }, thingSchema));
    await vi.advanceTimersByTimeAsync(8000);
    expect((await first).info).toMatchObject({ kind: 'timeout', timeoutMs: 8000, method: 'POST' });

    const longer = clientWith(hangingFetch(), { timeoutMs: 8000 });
    const second = failureOf(
      longer.client.post(endpoint('terminalPickFolder'), '/x', {}, thingSchema, { timeoutMs: 600_000 }),
    );
    await vi.advanceTimersByTimeAsync(599_000);
    expect(longer.client.tracker.get('terminalPickFolder')?.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await second).info).toMatchObject({ kind: 'timeout', timeoutMs: 600_000 });

    const ctrl = new AbortController();
    const aborting = clientWith(hangingFetch());
    const third = failureOf(
      aborting.client.post(endpoint('terminalPickFolder'), '/x', {}, thingSchema, { signal: ctrl.signal }),
    );
    ctrl.abort();
    expect((await third).info.kind).toBe('aborted');
    expect(aborting.client.tracker.get('terminalPickFolder')).toMatchObject({ failures: 0, inFlight: 0 });
  });

  it('does not start a request when the signal was already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { client, fetchImpl } = clientWith(() => Promise.resolve(json({ n: 1 })));
    const error = await failureOf(client.post(endpoint('authLogout'), '/x', {}, thingSchema, { signal: ctrl.signal }));
    expect(error.info.kind).toBe('aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tracks a write under its endpoint name like a read', async () => {
    const { client } = clientWith(() => Promise.resolve(json({ n: 1 })), { now: () => 500 });
    await client.post(endpoint('terminalKillSession'), '/x', {}, thingSchema);
    expect(client.tracker.get('terminalKillSession')).toMatchObject({ lastSuccess: 500, failures: 0, inFlight: 0 });
  });
});

describe('endpoint tracker', () => {
  it('counts concurrent in-flight requests per endpoint', async () => {
    const releases: (() => void)[] = [];
    const { client } = clientWith(
      () =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve(json({ n: 1 }));
          });
        }),
    );
    const a = client.get('timeline', '/api/v3/x', thingSchema);
    const b = client.get('timeline', '/api/v3/x', thingSchema);
    expect(client.tracker.get('timeline')?.inFlight).toBe(2);
    for (const release of releases) release();
    await Promise.all([a, b]);
    expect(client.tracker.get('timeline')?.inFlight).toBe(0);
    expect(client.tracker.get('config')).toBeNull();
  });

  it('coalesces notifications of one tick into one call and stops after unsubscribe', async () => {
    const tracker = createEndpointTracker();
    const listener = vi.fn();
    const off = tracker.subscribe(listener);
    tracker.begin('health');
    tracker.begin('overview');
    tracker.settle('health', { ok: true, at: 1 });
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    tracker.settle('overview', { ok: true, at: 2 });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns a stable snapshot until something changes', () => {
    const tracker = createEndpointTracker();
    tracker.begin('health');
    const first = tracker.snapshot();
    expect(tracker.snapshot()).toBe(first);
    tracker.settle('health', { ok: false, at: 3, error: { message: 'm', status: 500, kind: 'http' } });
    expect(tracker.snapshot()).not.toBe(first);
    expect(tracker.snapshot()[0]).toMatchObject({ name: 'health', failures: 1, lastError: { message: 'm', t: 3 } });
  });

  it('a throwing listener cannot break the others', async () => {
    const tracker = createEndpointTracker();
    const good = vi.fn();
    tracker.subscribe(() => {
      throw new Error('listener bug');
    });
    tracker.subscribe(good);
    tracker.begin('health');
    await Promise.resolve();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

// The key and arguments of every row of the table are covered by api-errors.test.ts; this block keeps the agreement with the
// retry policy of the query client.
describe('error-code table of 04 5.1 (handlingFor) and the query retry policy', () => {
  function http(status: number, code: ErrorCode | null): ApiError {
    return new ApiError('m', { kind: 'http', status, code, endpoint: 'sessions', requestId: 'r-0123456789ab' });
  }

  it('every catalogue code has a handling row whose retry agrees with the query retry policy', () => {
    for (const code of ERROR_CODES) {
      const error = http(ERROR_HTTP_STATUS[code], code);
      expect(shouldRetry(0, error), code).toBe(handlingFor(error).retry !== 'no');
    }
  });

  it('transport kinds: network, timeout and parse retry, contract and aborted do not', () => {
    const kinds: [ApiErrorKind, boolean][] = [
      ['network', true],
      ['timeout', true],
      ['parse', true],
      ['contract', false],
      ['aborted', false],
    ];
    for (const [kind, retried] of kinds) {
      const error = new ApiError('m', { kind, status: 0, code: null, endpoint: 'health', requestId: null });
      expect(handlingFor(error).retry !== 'no', kind).toBe(retried);
      expect(shouldRetry(0, error), kind).toBe(retried);
    }
  });
});

describe('query client defaults (04 5.2)', () => {
  const server = (status: number) =>
    new ApiError('m', { kind: 'http', status, code: null, endpoint: 'sessions', requestId: null });

  it('retries 5xx up to three times and 429 once; never 4xx, contract or aborted', () => {
    expect(shouldRetry(0, server(500))).toBe(true);
    expect(shouldRetry(2, server(503))).toBe(true);
    expect(shouldRetry(3, server(500))).toBe(false);
    expect(shouldRetry(0, server(429))).toBe(true);
    expect(shouldRetry(1, server(429))).toBe(false);
    expect(shouldRetry(0, server(404))).toBe(false);
    expect(shouldRetry(0, server(400))).toBe(false);
  });

  it('backs off 2 s, 4 s, 8 s and waits Retry-After or 2 s for a 429', () => {
    expect([0, 1, 2].map((n) => retryDelay(n, server(500)))).toEqual([2000, 4000, 8000]);
    expect(retryDelay(0, server(429))).toBe(2000);
    const withHeader = new ApiError('m', {
      kind: 'http',
      status: 429,
      code: 'search_busy',
      endpoint: 'sessions',
      requestId: null,
      retryAfterMs: 5000,
    });
    expect(retryDelay(0, withHeader)).toBe(5000);
  });

  it('createQueryClient applies the documented defaults and can turn retries off for tests', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions().queries;
    expect(defaults).toMatchObject({
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      throwOnError: false,
      structuralSharing: true,
    });
    expect(typeof defaults?.retry).toBe('function');
    expect(createQueryClient({ retry: false }).getDefaultOptions().queries?.retry).toBe(false);
  });
});

describe('legacy: api tracks last success / last error per endpoint and keeps the error', () => {
  it('legacy: api tracks last success / last error per endpoint and keeps the error', async () => {
    let t = 1000;
    const steps: (() => Promise<Response>)[] = [
      () => Promise.resolve(json({ n: 1 })),
      () => Promise.reject(new TypeError('down')),
      () => Promise.resolve(envelope('route_not_found', 'gone', 404)),
      () => Promise.resolve(new Response('<<<', { status: 200 })),
      () => Promise.resolve(envelope('internal_error', 'kaput', 500)),
      () => Promise.resolve(json({ n: 2 })),
    ];
    const { client } = clientWith(() => (steps.shift() ?? (() => Promise.reject(new Error('no step'))))(), {
      now: () => t,
    });
    const x = endpoint('health');
    expect(await client.get(x, '/api/x', thingSchema)).toEqual({ n: 1 });
    expect(client.tracker.get(x)?.lastSuccess).toBe(1000);
    t = 2000;
    expect((await failureOf(client.get(x, '/api/x', thingSchema))).info.kind).toBe('network');
    let rec = client.tracker.get(x);
    expect(rec?.lastSuccess).toBe(1000);
    expect(rec?.lastError).toMatchObject({ kind: 'network', t: 2000 });
    expect((await failureOf(client.get(x, '/api/x', thingSchema))).info.status).toBe(404);
    expect((await failureOf(client.get(x, '/api/x', thingSchema))).info.kind).toBe('parse');
    expect((await failureOf(client.get(x, '/api/x', thingSchema))).message).toMatch(/Monitor error \(500\): kaput/);
    expect(client.tracker.get(x)?.failures).toBe(4);
    t = 3000;
    await client.get(x, '/api/x', thingSchema);
    rec = client.tracker.get(x);
    expect(rec).toMatchObject({ lastSuccess: 3000, failures: 0 });
    expect(rec?.lastError).not.toBeNull();
  });
});
