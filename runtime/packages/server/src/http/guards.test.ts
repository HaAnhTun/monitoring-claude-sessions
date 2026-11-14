// Request guards (05 5.3 S-NET, ADR 0045, 03 5.2, SEC-02..05): Host, Origin and fetch metadata, the URL limit, the
// JSON + custom header rule for mutations, the hook nudge rules, and the uniform error envelope, on a real Express app
// with explicit Host headers. Every expected code is typed `ErrorCode`, so renaming a code breaks the type check.
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ErrorEnvelopeSchema, REQUEST_ID_RE, type ErrorCode } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeTempDir,
  spawnTracked,
  waitFor,
} from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GUARD_ERROR_MESSAGES,
  MAX_URL_LENGTH,
  NUDGE_MAX_BODY_BYTES,
  allowedHosts,
  allowedOrigins,
  csrfGuard,
  hostGuard,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
  nudgeGuard,
  optionsGuard,
  requestContext,
  requestInfo,
  uriLimit,
} from './guards.ts';

const INSTANCE_ID = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const OTHER_INSTANCE_ID = '1c7a1a5f-7d2f-4b57-8e1b-1b6c4a8d0f22';
const RUNTIME = '3.0.0+abc1234';
/** Text that must never come back in a response: it is put in hostile headers and bodies. */
const MARKER = 'leak-marker-7f3a';

type RequestOptions = NonNullable<Parameters<typeof httpRequest>[2]>;
type Reply = Awaited<ReturnType<typeof httpRequest>>;

/**
 * The test app: the guards in front of a few routes on a real Express 5 app, in a child process of plain Node. It is not
 * started in the Vitest worker because Vitest passes `--conditions import` to its workers (from `ssr.resolve.conditions`
 * of `vitest.config.ts`); with that flag `require('is-promise')` resolves to the ES module, Express 5's router calls the
 * namespace object as a function, and every handler that answers after it has returned (the nudge guard reads the body
 * first) ends in a 500 (change request CR-WP-08-1). Node 24 runs the TypeScript source of the guards directly.
 */
const APP_SOURCE = `
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const [guardsUrl, runtimeDir, portText, instanceId, runtimeStamp] = process.argv.slice(-5);
const require = createRequire(runtimeDir + '/package.json');
const express = require('express');
const g = await import(guardsUrl);
const port = Number(portText);
const app = express();
app.disable('x-powered-by');
app.use(...g.guardChain({ instanceId, runtime: runtimeStamp, port }));
app.use(g.optionsGuard());
app.get('/api/v3/ping', (_req, res) => {
  res.json({ ok: true, id: g.requestInfo(res)?.requestId ?? null });
});
app.get('/index.html', (_req, res) => {
  res.type('html').send('<!doctype html><title>x</title>');
});
for (const method of ['post', 'put', 'delete']) {
  app[method]('/api/v3/mutate', g.csrfGuard(), (_req, res) => {
    res.status(204).end();
  });
}
app.post('/api/v3/ingest/nudge', g.nudgeGuard({ instanceId }), (_req, res) => {
  res.status(204).end();
});
app.all('/api/v3/ping', g.methodNotAllowed(['GET', 'HEAD']));
createServer(app).listen(port, '127.0.0.1');
`;

/** `<skill>/runtime` with forward slashes: this file sits four folders below it. */
const RUNTIME_DIR = fileURLToPath(new URL('../../../../', import.meta.url))
  .replace(/[\\/]+$/, '')
  .replaceAll('\\', '/');
const temp = makeTempDir('guards');
let port = 0;

beforeAll(async () => {
  port = await allocatePort();
  const app = spawnTracked(
    process.execPath,
    [
      '--conditions=@mcs/source',
      '--input-type=module',
      '--eval',
      APP_SOURCE,
      '--',
      new URL('./guards.ts', import.meta.url).href,
      RUNTIME_DIR,
      String(port),
      INSTANCE_ID,
      RUNTIME,
    ],
    { env: hermeticEnv(temp.path) },
  );
  const died = app.exited.then((code) => {
    throw new Error(`the guards test app exited with code ${String(code)} before it answered`);
  });
  const answers = waitFor(async () => (await httpRequest(port, '/api/v3/ping')).status === 200, {
    what: 'the guards test app',
    timeoutMs: 15_000,
  });
  await Promise.race([answers, died]);
});

afterAll(async () => {
  await killAllTracked();
  await assertPortClosed(port);
  temp.remove();
});

const send = (path: string, opts: RequestOptions = {}): Promise<Reply> => httpRequest(port, path, opts);

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };

const postJson = (path: string, body: string, opts: RequestOptions = {}): Promise<Reply> =>
  httpRequest(port, path, { method: 'POST', body, ...opts, headers: { ...JSON_HEADERS, ...opts.headers } });

/** One raw HTTP exchange for requests that a client library would not send (no Host, duplicates, chunked, binary). */
function raw(data: string | Buffer, closeAfterWrite = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split < 0 ? text : text.slice(0, split);
      const lines = head.split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status, headers, body: split < 0 ? '' : text.slice(split + 4) });
    });
    socket.write(data);
    if (closeAfterWrite) socket.end();
  });
}

function expectNoCors(reply: Reply): void {
  for (const name of Object.keys(reply.headers)) expect(name.startsWith('access-control-'), name).toBe(false);
}

/** The reply is the uniform envelope: right status, right code, request id echoed, no stack, no leaked request data. */
function expectError(reply: Reply, status: number, code: ErrorCode): void {
  expect(reply.status, reply.body).toBe(status);
  expect(reply.headers['content-type']).toMatch(/^application\/json/);
  const envelope = ErrorEnvelopeSchema.parse(JSON.parse(reply.body));
  expect(envelope.error.code).toBe(code);
  expect(envelope.error.requestId).toMatch(REQUEST_ID_RE);
  expect(envelope.error.requestId).toBe(reply.headers['x-request-id']);
  expect(Object.keys(envelope.error).sort()).toEqual(
    envelope.error.details === undefined
      ? ['code', 'message', 'requestId']
      : ['code', 'details', 'message', 'requestId'],
  );
  expect(reply.body).not.toContain(MARKER);
  expect(reply.body).not.toMatch(/\bat\s+\S+\s+\(|node_modules|\.ts:\d+|[A-Za-z]:\\/);
  expectNoCors(reply);
}

// ---- unit helpers: a response and request that record what a guard does with them -------------------------------------

interface Recorded {
  status: number;
  body: unknown;
  headers: Map<string, string>;
  /** `res.locals`: an Express response always has one, and the nudge guard now publishes the body it consumed there. */
  locals: Record<string, unknown>;
  /** Called when the guard sends its JSON answer. */
  onJson?: () => void;
}

function mockRes(): { res: never; seen: Recorded } {
  const seen: Recorded = { status: 0, body: undefined, headers: new Map(), locals: {} };
  const res = {
    headersSent: false,
    locals: seen.locals,
    getHeader: (name: string) => seen.headers.get(name.toLowerCase()),
    setHeader: (name: string, value: string) => {
      seen.headers.set(name.toLowerCase(), value);
      return res;
    },
    removeHeader: (name: string) => {
      seen.headers.delete(name.toLowerCase());
    },
    status: (code: number) => {
      seen.status = code;
      return res;
    },
    json: (body: unknown) => {
      seen.body = body;
      seen.onJson?.();
      return res;
    },
    end: () => res,
  };
  return { res: res as never, seen };
}

function mockReq(fields: Record<string, unknown>): never {
  return fields as never;
}

/** Runs one middleware and reports whether it called next() and what it sent. */
function run(
  handler: (req: never, res: never, next: () => void) => unknown,
  req: never,
): { passed: boolean; seen: Recorded } {
  const { res, seen } = mockRes();
  let passed = false;
  handler(req, res, () => {
    passed = true;
  });
  return { passed, seen };
}

/** Runs a middleware that answers or calls next() later; resolves at the first of the two. */
function runAsync(
  handler: (req: never, res: never, next: (error?: unknown) => void) => unknown,
  req: never,
): Promise<{ passed: boolean; error: unknown; seen: Recorded }> {
  const { res, seen } = mockRes();
  return new Promise((resolve) => {
    seen.onJson = () => {
      resolve({ passed: false, error: undefined, seen });
    };
    handler(req, res, (error) => {
      resolve({ passed: error === undefined, error, seen });
    });
  });
}

/** A request whose body arrives as `chunks`: a real stream with the headers a guard reads. */
function bodyRequest(headers: Record<string, string>, chunks: readonly (string | Buffer)[]): never {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c)));
  return Object.assign(stream, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  }) as never;
}

function errorCodeOf(seen: Recorded): unknown {
  const body = seen.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = body.error;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

describe('pure checks', () => {
  it('allows exactly the two Host values of the bound port, ignoring case', () => {
    expect([...allowedHosts(18123)]).toEqual(['127.0.0.1:18123', 'localhost:18123']);
    for (const ok of ['127.0.0.1:18123', 'localhost:18123', 'LOCALHOST:18123', 'LocalHost:18123']) {
      expect(isAllowedHost(ok, 18123), ok).toBe(true);
    }
    for (const bad of [
      undefined,
      '',
      ' ',
      '0.0.0.0',
      '0.0.0.0:18123',
      '[::1]:18123',
      '[::1]',
      '::1',
      '127.0.0.1',
      'localhost',
      '127.0.0.1:18124',
      '127.0.0.1:018123',
      '127.0.0.1:18123.',
      '127.0.0.1.:18123',
      'localhost.:18123',
      '127.1:18123',
      '2130706433:18123',
      '0x7f.0.0.1:18123',
      'user@127.0.0.1:18123',
      '127.0.0.1:18123@evil.example',
      '127.0.0.1:18123 evil.example',
      '127.0.0.1:18123,evil.example',
      ' 127.0.0.1:18123',
      '127.0.0.1:18123 ',
      '127.0.0.1.evil.com:18123',
      'localhost.evil.com:18123',
      'evil.example',
      'evil.example:18123',
      '127.0.0.1:18123\n',
      '127.0.0.1:1812',
      '127.0.0.1:181234',
      `localho${String.fromCodePoint(0x17f)}t:18123`,
      `${String.fromCodePoint(0x212a)}ocalhost:18123`,
    ]) {
      expect(isAllowedHost(bad, 18123), JSON.stringify(bad)).toBe(false);
    }
  });

  it('allows exactly the two Origin values of the bound port', () => {
    expect([...allowedOrigins(18123)]).toEqual(['http://127.0.0.1:18123', 'http://localhost:18123']);
    expect(isAllowedOrigin('http://127.0.0.1:18123', 18123)).toBe(true);
    expect(isAllowedOrigin('http://localhost:18123', 18123)).toBe(true);
    for (const bad of [
      undefined,
      'null',
      '',
      'http://127.0.0.1',
      'http://127.0.0.1:18124',
      'https://127.0.0.1:18123',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://evil.example',
      'http://127.0.0.1.evil.com:18123',
      'http://localhost.evil.com:18123',
      'http://[::1]:18123',
      'http://0.0.0.0:18123',
      'HTTP://LOCALHOST:18123',
      'http://LOCALHOST:18123',
      'http://127.0.0.1:18123/',
      'http://127.0.0.1:18123, http://evil.example',
      'file://',
      'chrome-extension://abcdefghijklmnop',
      '127.0.0.1:18123',
    ]) {
      expect(isAllowedOrigin(bad, 18123), JSON.stringify(bad)).toBe(false);
    }
  });

  it('recognises application/json with parameters only', () => {
    for (const ok of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
      'application/json;charset=UTF-8',
      ' application/json ',
    ]) {
      expect(isJsonContentType(ok), ok).toBe(true);
    }
    for (const bad of [
      undefined,
      '',
      'text/plain',
      'application/jsonx',
      'application/json-patch+json',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/json',
      'application/ld+json',
      'json',
    ]) {
      expect(isJsonContentType(bad), String(bad)).toBe(false);
    }
  });

  it('has one fixed English sentence per code it can send, with no request data', () => {
    for (const [code, message] of Object.entries(GUARD_ERROR_MESSAGES)) {
      expect(message, code).toMatch(/^[A-Z][^\n]*\.$/);
    }
    expect(MAX_URL_LENGTH).toBe(8192);
    expect(NUDGE_MAX_BODY_BYTES).toBe(256);
  });
});

describe('requestContext', () => {
  it('stamps every response, success or error, with a request id and the instance and runtime headers', async () => {
    const ok = await send('/api/v3/ping');
    const badOrigin = await send('/api/v3/ping', { origin: `http://${MARKER}.example` });
    const missing = await send('/api/v3/ping', { method: 'POST' });
    for (const reply of [ok, badOrigin, missing]) {
      expect(reply.headers['x-request-id']).toMatch(REQUEST_ID_RE);
      expect(reply.headers['x-mcs-instance']).toBe(INSTANCE_ID);
      expect(reply.headers['x-mcs-runtime']).toBe(RUNTIME);
    }
    expect(ok.headers['x-request-id']).not.toBe(badOrigin.headers['x-request-id']);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, id: ok.headers['x-request-id'] });
  });

  it('tells a refused Host nothing but a request id: a rebound page can read that answer', async () => {
    const reply = await send('/api/v3/ping', { host: 'evil.example' });
    expectError(reply, 403, 'host_not_allowed');
    expect(reply.headers['x-request-id']).toMatch(REQUEST_ID_RE);
    expect(reply.headers['x-mcs-instance']).toBeUndefined();
    expect(reply.headers['x-mcs-runtime']).toBeUndefined();
    expect(JSON.stringify(reply.headers)).not.toContain(INSTANCE_ID);
    expect(reply.body).not.toContain(INSTANCE_ID);
  });

  it('records the start time from the clock it is given and can use another id generator', () => {
    const handler = requestContext({
      instanceId: INSTANCE_ID,
      runtime: RUNTIME,
      clock: { now: () => 1234 },
      newRequestId: () => 'r-aaaaaaaaaaaa',
    });
    const { res, seen } = mockRes();
    handler(mockReq({}), res, () => undefined);
    expect(seen.headers.get('x-request-id')).toBe('r-aaaaaaaaaaaa');
    expect(requestInfo(res)).toEqual({ requestId: 'r-aaaaaaaaaaaa', startedAtMs: 1234 });
  });

  it('refuses an instance id or runtime stamp that is not header safe', () => {
    expect(() => requestContext({ instanceId: 'not-a-uuid', runtime: RUNTIME })).toThrow(RangeError);
    expect(() => requestContext({ instanceId: INSTANCE_ID, runtime: 'a\r\nSet-Cookie: x' })).toThrow(RangeError);
    expect(() => requestContext({ instanceId: INSTANCE_ID, runtime: '' })).toThrow(RangeError);
    expect(() => requestContext({ instanceId: INSTANCE_ID, runtime: 'x'.repeat(200) })).toThrow(RangeError);
  });
});

describe('Host guard (SEC-02, T1)', () => {
  it('answers 200 for 127.0.0.1:<port> and localhost:<port> in any case, on API, static and HEAD', async () => {
    const p = String(port);
    for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `LOCALHOST:${p}`, `LocalHost:${p}`]) {
      const api = await send('/api/v3/ping', { host });
      expect(api.status, host).toBe(200);
      expectNoCors(api);
      expect((await send('/index.html', { host })).status, host).toBe(200);
      expect((await send('/api/v3/ping', { host, method: 'HEAD' })).status, host).toBe(200);
    }
  });

  it('answers 403 host_not_allowed for every other Host, without echoing it', async () => {
    const p = String(port);
    const hosts = [
      `${MARKER}.example`,
      `${MARKER}.example:${p}`,
      `127.0.0.1.${MARKER}.com`,
      `127.0.0.1.${MARKER}.com:${p}`,
      `localhost.${MARKER}.com:${p}`,
      '0.0.0.0',
      `0.0.0.0:${p}`,
      `[::1]:${p}`,
      '[::1]',
      '127.0.0.1',
      'localhost',
      `127.0.0.1:${String(port + 1)}`,
      `localhost:${String(port + 1)}`,
      `127.0.0.1:0${p}`,
      `127.0.0.1:${p}.`,
      `127.0.0.1.:${p}`,
      `localhost.:${p}`,
      `127.1:${p}`,
      `2130706433:${p}`,
      `user@127.0.0.1:${p}`,
      `127.0.0.1:${p}@${MARKER}.example`,
      `127.0.0.1:${p} ${MARKER}.example`,
      `127.0.0.1:${p},${MARKER}.example`,
    ];
    for (const host of hosts) {
      const code: ErrorCode = 'host_not_allowed';
      expectError(await send('/api/v3/ping', { host }), 403, code);
    }
  });

  it('guards every method and path, and wins over every later check', async () => {
    const code: ErrorCode = 'host_not_allowed';
    const host = `${MARKER}.example`;
    expectError(await send('/index.html', { host }), 403, code);
    expectError(await send('/api/v3/does-not-exist', { host }), 403, code);
    expectError(await send('/api/v3/ping', { host, method: 'OPTIONS' }), 403, code);
    expectError(await send('/api/v3/ping', { host, method: 'POST' }), 403, code);
    expectError(await send('/api/v3/ping', { host, origin: 'null' }), 403, code);
    expectError(await send('/api/v3/ping', { host, headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, code);
    expectError(await send(`/api/v3/ping?p=${'a'.repeat(9000)}`, { host }), 403, code);
    expectError(
      await postJson('/api/v3/ingest/nudge', JSON.stringify({ instanceId: INSTANCE_ID }), { host }),
      403,
      code,
    );
  });

  it('answers 403 for an empty Host and for an HTTP/1.0 request without one (a client library fills both in)', async () => {
    const code: ErrorCode = 'host_not_allowed';
    expectError(await raw('GET /api/v3/ping HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'), 403, code);
    expectError(await raw('GET /api/v3/ping HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'), 403, code);
    expectError(await raw('GET /api/v3/ping HTTP/1.0\r\n\r\n'), 403, code);
  });

  it('refuses a request with two Host headers, whichever comes first', async () => {
    const good = `127.0.0.1:${String(port)}`;
    for (const [first, second] of [
      [good, `${MARKER}.example`],
      [`${MARKER}.example`, good],
      [good, good],
    ] as const) {
      const reply = await raw(
        `GET /api/v3/ping HTTP/1.1\r\nHost: ${first}\r\nHost: ${second}\r\nConnection: close\r\n\r\n`,
      );
      expect([400, 403], `${first} + ${second} -> ${String(reply.status)}`).toContain(reply.status);
      if (reply.status === 403) expectError(reply, 403, 'host_not_allowed');
    }
  });

  it('reads the port again for every request when it is given as a function', () => {
    let bound = 4321;
    const handler = hostGuard(() => bound);
    const request = (host: string) => mockReq({ headers: { host }, rawHeaders: ['Host', host] });
    expect(run(handler, request('127.0.0.1:4321')).passed).toBe(true);
    const refused = run(handler, request('127.0.0.1:1234'));
    expect(refused.passed).toBe(false);
    expect(refused.seen.status).toBe(403);
    expect(errorCodeOf(refused.seen)).toBe('host_not_allowed');
    bound = 1234;
    expect(run(handler, request('127.0.0.1:1234')).passed).toBe(true);
    expect(run(handler, request('127.0.0.1:4321')).passed).toBe(false);
  });

  it('refuses a request whose raw headers hold no Host or two of them, even when the parsed value is good', () => {
    const handler = hostGuard(4321);
    expect(run(handler, mockReq({ headers: { host: '127.0.0.1:4321' }, rawHeaders: [] })).passed).toBe(false);
    expect(
      run(handler, mockReq({ headers: { host: '127.0.0.1:4321' }, rawHeaders: ['Host', 'a', 'HOST', 'b'] })).passed,
    ).toBe(false);
  });
});

describe('Origin guard (SEC-03, T2, T3, I-31)', () => {
  it('accepts a request without Origin and the two exact origins', async () => {
    expect((await send('/api/v3/ping')).status).toBe(200);
    expect((await send('/api/v3/ping', { origin: `http://127.0.0.1:${String(port)}` })).status).toBe(200);
    expect((await send('/api/v3/ping', { origin: `http://localhost:${String(port)}` })).status).toBe(200);
  });

  it('answers 403 origin_not_allowed for null, an empty Origin, another port, scheme or host, and a Vite dev origin', async () => {
    const p = String(port);
    const origins = [
      'null',
      '',
      'http://127.0.0.1',
      `http://127.0.0.1:${String(port + 1)}`,
      `https://127.0.0.1:${p}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      `http://${MARKER}.example`,
      `http://127.0.0.1.${MARKER}.com:${p}`,
      `http://localhost.${MARKER}.com:${p}`,
      `http://[::1]:${p}`,
      `http://0.0.0.0:${p}`,
      `HTTP://LOCALHOST:${p}`,
      `http://LOCALHOST:${p}`,
      `http://127.0.0.1:${p}/`,
      `http://127.0.0.1:${p}, http://${MARKER}.example`,
      'file://',
      `chrome-extension://${MARKER}`,
    ];
    for (const origin of origins) {
      const code: ErrorCode = 'origin_not_allowed';
      expectError(await send('/api/v3/ping', { origin }), 403, code);
    }
  });

  it('refuses a preflight from a foreign origin and answers none from an allowed one', async () => {
    const preflight = {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    };
    expectError(
      await send('/api/v3/mutate', { ...preflight, origin: `http://${MARKER}.example` }),
      403,
      'origin_not_allowed',
    );
    const own = await send('/api/v3/mutate', { ...preflight, origin: `http://localhost:${String(port)}` });
    expectError(own, 405, 'method_not_allowed');
    expectNoCors(own);
  });
});

describe('fetch metadata (SEC-04, T2)', () => {
  it('answers 403 cross_site_request for cross-site on every method', async () => {
    const code: ErrorCode = 'cross_site_request';
    const headers = { 'Sec-Fetch-Site': 'cross-site', ...MUTATION_HEADERS };
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      expectError(await send('/api/v3/ping', { method, headers }), 403, code);
    }
    expect((await send('/api/v3/ping', { method: 'HEAD', headers })).status).toBe(403);
    expectError(await send('/api/v3/ping', { headers: { 'Sec-Fetch-Site': 'Cross-Site' } }), 403, code);
    expectError(await send('/api/v3/ping', { headers: { 'Sec-Fetch-Site': 'CROSS-SITE' } }), 403, code);
  });

  it('answers 403 cross_site_request for same-site on every method but GET', async () => {
    const code: ErrorCode = 'cross_site_request';
    const headers = { 'Sec-Fetch-Site': 'same-site', ...MUTATION_HEADERS };
    expect((await send('/api/v3/ping', { headers })).status).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expectError(await send('/api/v3/mutate', { method, headers }), 403, code);
    }
    expect((await send('/api/v3/ping', { method: 'HEAD', headers })).status).toBe(403);
  });

  it('lets same-origin and none through', async () => {
    for (const value of ['same-origin', 'none']) {
      expect((await send('/api/v3/ping', { headers: { 'Sec-Fetch-Site': value } })).status, value).toBe(200);
      const post = await send('/api/v3/mutate', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': value, ...MUTATION_HEADERS },
      });
      expect(post.status, value).toBe(204);
    }
  });

  it('reports a bad Origin before a cross-site header (the order of 03 5.2 step 3)', async () => {
    const reply = await send('/api/v3/ping', {
      origin: `http://${MARKER}.example`,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expectError(reply, 403, 'origin_not_allowed');
  });
});

describe('URL length (S-NET-6)', () => {
  const pathOfLength = (length: number): string => {
    const prefix = '/api/v3/ping?p=';
    return prefix + 'a'.repeat(length - prefix.length);
  };

  it('allows 8192 characters and answers 414 uri_too_long for 8193 and for 9000', async () => {
    expect(pathOfLength(8192)).toHaveLength(8192);
    expect((await send(pathOfLength(8192))).status).toBe(200);
    const code: ErrorCode = 'uri_too_long';
    expectError(await send(pathOfLength(8193)), 414, code);
    expectError(await send(pathOfLength(9000)), 414, code);
  });

  it('is a plain middleware with its own limit', () => {
    const guard = uriLimit(10);
    expect(run(guard, mockReq({ originalUrl: `/${'a'.repeat(9)}` })).passed).toBe(true);
    const refused = run(guard, mockReq({ originalUrl: `/${'a'.repeat(10)}` }));
    expect(refused.passed).toBe(false);
    expect(refused.seen.status).toBe(414);
    expect(errorCodeOf(refused.seen)).toBe('uri_too_long');
  });
});

describe('methods (SEC-05: OPTIONS and unsupported methods)', () => {
  it('answers OPTIONS with 405 method_not_allowed, an Allow header and no CORS header', async () => {
    const reply = await send('/api/v3/ping', { method: 'OPTIONS' });
    expectError(reply, 405, 'method_not_allowed');
    expect(reply.headers['allow']).toBe('GET, HEAD');
    expectNoCors(reply);
  });

  it('answers a known path with another method through methodNotAllowed', async () => {
    const reply = await send('/api/v3/ping', { method: 'POST', headers: MUTATION_HEADERS });
    expectError(reply, 405, 'method_not_allowed');
    expect(reply.headers['allow']).toBe('GET, HEAD');
  });

  it('lets optionsGuard compute Allow per path and pass every other method on', () => {
    const guard = optionsGuard((req) => (req.path === '/n' ? ['POST'] : ['GET', 'HEAD']));
    const options = run(guard, mockReq({ method: 'OPTIONS', path: '/n' }));
    expect(options.passed).toBe(false);
    expect(options.seen.status).toBe(405);
    expect(options.seen.headers.get('allow')).toBe('POST');
    expect(run(guard, mockReq({ method: 'OPTIONS', path: '/other' })).seen.headers.get('allow')).toBe('GET, HEAD');
    expect(run(guard, mockReq({ method: 'GET', path: '/n' })).passed).toBe(true);
    expect(run(guard, mockReq({ method: 'POST', path: '/n' })).passed).toBe(true);
  });
});

describe('mutation guard (SEC-05: reserved UI-mutation rule)', () => {
  const code: ErrorCode = 'csrf_rejected';

  it('lets a request with JSON and X-MCS-Request: 1 through, on every mutating method', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const reply = await send('/api/v3/mutate', { method, headers: MUTATION_HEADERS });
      expect(reply.status, method).toBe(204);
      expectNoCors(reply);
    }
    const withCharset = await send('/api/v3/mutate', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-MCS-Request': '1' },
    });
    expect(withCharset.status).toBe(204);
  });

  it('answers 403 csrf_rejected without a JSON content type', async () => {
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonx',
      'text/json',
    ]) {
      const reply = await send('/api/v3/mutate', {
        method: 'POST',
        body: 'a=b',
        headers: { 'Content-Type': contentType, 'X-MCS-Request': '1' },
      });
      expectError(reply, 403, code);
    }
    expectError(await send('/api/v3/mutate', { method: 'POST', headers: { 'X-MCS-Request': '1' } }), 403, code);
  });

  it('answers 403 csrf_rejected without the custom header or with another value', async () => {
    expectError(await send('/api/v3/mutate', { method: 'POST', headers: JSON_HEADERS }), 403, code);
    for (const value of ['0', 'true', '', '11', ' ', 'yes']) {
      const headers = { ...JSON_HEADERS, 'X-MCS-Request': value };
      expectError(await send('/api/v3/mutate', { method: 'POST', headers }), 403, code);
    }
  });

  it('closes the connection of a refused write: its body is never read', () => {
    const refused = run(csrfGuard(), mockReq({ method: 'POST', headers: {} }));
    expect(refused.passed).toBe(false);
    expect(refused.seen.status).toBe(403);
    expect(refused.seen.headers.get('connection')).toBe('close');
    const passed = run(
      csrfGuard(),
      mockReq({ method: 'POST', headers: { 'content-type': 'application/json', 'x-mcs-request': '1' } }),
    );
    expect(passed.passed).toBe(true);
    expect(passed.seen.headers.get('connection')).toBeUndefined();
  });

  it('does not apply to GET and HEAD', () => {
    const guard = csrfGuard();
    for (const method of ['GET', 'HEAD'])
      expect(run(guard, mockReq({ method, headers: {} })).passed, method).toBe(true);
    expect(run(guard, mockReq({ method: 'POST', headers: {} })).passed).toBe(false);
  });
});

describe('hook nudge (SEC-05, SEC-10, 03 5.2 step 7)', () => {
  const NUDGE = '/api/v3/ingest/nudge';
  const valid = JSON.stringify({ instanceId: INSTANCE_ID });
  const frame = (headers: string) =>
    `POST ${NUDGE} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n${headers}`;

  it('answers 204 for the one valid body', async () => {
    const reply = await postJson(NUDGE, valid);
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expectNoCors(reply);
    expect(
      (await postJson(NUDGE, valid, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status,
    ).toBe(204);
  });

  it('answers 415 unsupported_media_type when the body is not JSON', async () => {
    const code: ErrorCode = 'unsupported_media_type';
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
      expectError(await postJson(NUDGE, valid, { headers: { 'Content-Type': contentType } }), 415, code);
    }
    expectError(await raw(frame(`Content-Length: ${String(valid.length)}\r\n\r\n${valid}`)), 415, code);
  });

  it('answers 403 origin_not_allowed for any Origin header, even an allowed one', async () => {
    const code: ErrorCode = 'origin_not_allowed';
    const p = String(port);
    for (const origin of [`http://127.0.0.1:${p}`, `http://localhost:${p}`, 'null', `http://${MARKER}.example`]) {
      expectError(await postJson(NUDGE, valid, { origin }), 403, code);
    }
  });

  it('checks the media type before the Origin and the Origin before the body', async () => {
    const origin = `http://127.0.0.1:${String(port)}`;
    expectError(
      await postJson(NUDGE, valid, { origin, headers: { 'Content-Type': 'text/plain' } }),
      415,
      'unsupported_media_type',
    );
    expectError(await postJson(NUDGE, 'x'.repeat(1000), { origin }), 403, 'origin_not_allowed');
  });

  it('answers 413 payload_too_large above 256 bytes and accepts the size limit itself', async () => {
    const code: ErrorCode = 'payload_too_large';
    const shell = Buffer.byteLength(`{"instanceId":"${INSTANCE_ID}","pad":""}`);
    const body = (size: number) => `{"instanceId":"${INSTANCE_ID}","pad":"${'x'.repeat(size - shell)}"}`;
    const at = body(NUDGE_MAX_BODY_BYTES);
    const over = body(NUDGE_MAX_BODY_BYTES + 1);
    expect(Buffer.byteLength(at)).toBe(256);
    expect(Buffer.byteLength(over)).toBe(257);
    expectError(await postJson(NUDGE, at), 400, 'validation_failed');
    const reply = await postJson(NUDGE, over);
    expectError(reply, 413, code);
    expect(reply.headers['connection']).toBe('close');
    expectError(await postJson(NUDGE, 'x'.repeat(5000)), 413, code);
  });

  it('answers 413 for a chunked body that grows past 256 bytes without a Content-Length', async () => {
    const chunk = 'a'.repeat(200);
    const size = chunk.length.toString(16);
    const data = frame(
      `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${size}\r\n${chunk}\r\n${size}\r\n${chunk}\r\n0\r\n\r\n`,
    );
    expectError(await raw(data), 413, 'payload_too_large');
  });

  it('answers 400 body_invalid_json for text that is not JSON, without echoing it', async () => {
    const code: ErrorCode = 'body_invalid_json';
    for (const body of [
      '',
      '{',
      `{"instanceId": ${MARKER}}`,
      `not json ${MARKER}`,
      "{'instanceId':'x'}",
      `${String.fromCodePoint(0xfeff)}{}`,
      '{"instanceId":"x"} trailing',
    ]) {
      expectError(await postJson(NUDGE, body), 400, code);
    }
    const head = frame('Content-Type: application/json\r\nContent-Length: 3\r\n\r\n');
    expectError(await raw(Buffer.concat([Buffer.from(head), Buffer.from([0xff, 0xfe, 0x7b])])), 400, code);
  });

  it('answers 400 validation_failed for another shape, naming the path and the issue code only', async () => {
    const code: ErrorCode = 'validation_failed';
    for (const body of [
      '{}',
      '[]',
      'null',
      '"x"',
      '5',
      '{"instanceId":5}',
      '{"instanceId":null}',
      '{"instanceId":"not-a-uuid"}',
      `{"instanceId":"${INSTANCE_ID.toUpperCase()}"}`,
      `{"instanceId":"${INSTANCE_ID}","extra":1}`,
      `{"instanceId":["${INSTANCE_ID}"]}`,
      `{"__proto__":{"x":1},"instanceId":"${INSTANCE_ID}"}`,
    ]) {
      expectError(await postJson(NUDGE, body), 400, code);
    }
    const reply = await postJson(NUDGE, `{"instanceId":"${MARKER}"}`);
    expectError(reply, 400, code);
    const envelope = ErrorEnvelopeSchema.parse(JSON.parse(reply.body));
    expect(envelope.error.details).toEqual([{ path: 'instanceId', issue: 'invalid_format' }]);
  });

  it('answers 409 instance_mismatch for another instance id', async () => {
    const code: ErrorCode = 'instance_mismatch';
    expectError(await postJson(NUDGE, JSON.stringify({ instanceId: OTHER_INSTANCE_ID })), 409, code);
  });

  it('keeps serving after a client that aborts in the middle of the body', async () => {
    await raw(frame('Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"instanceId"'), true);
    expect((await postJson(NUDGE, valid)).status).toBe(204);
  });

  it('is refused for cross-site and same-site requests by the global guards first', async () => {
    expectError(
      await postJson(NUDGE, valid, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      403,
      'cross_site_request',
    );
    expectError(
      await postJson(NUDGE, valid, { headers: { 'Sec-Fetch-Site': 'same-site' } }),
      403,
      'cross_site_request',
    );
  });

  it('leaves nothing for the route handler to parse: the guard answers every case but the valid one', () => {
    const guard = nudgeGuard({ instanceId: INSTANCE_ID });
    const refused = run(guard, mockReq({ method: 'POST', headers: { 'content-type': 'text/plain' } }));
    expect(refused.passed).toBe(false);
    expect(refused.seen.status).toBe(415);
    expect(errorCodeOf(refused.seen)).toBe('unsupported_media_type');
  });
});

describe('nudge guard on a fake request stream', () => {
  const guard = nudgeGuard({ instanceId: INSTANCE_ID });
  const valid = JSON.stringify({ instanceId: INSTANCE_ID });
  const answer = async (req: never) => {
    const result = await runAsync(guard, req);
    return { ...result, code: errorCodeOf(result.seen) };
  };

  it('publishes the body it consumed for the route adapter, and only for a valid nudge', async () => {
    const accepted = await answer(bodyRequest({}, [valid]));
    expect(accepted.passed).toBe(true);
    expect(accepted.seen.locals['body']).toEqual({ instanceId: INSTANCE_ID });
    for (const body of ['{}', 'not json', JSON.stringify({ instanceId: OTHER_INSTANCE_ID })]) {
      const refused = await answer(bodyRequest({}, [body]));
      expect(refused.passed).toBe(false);
      expect(refused.seen.locals['body']).toBeUndefined();
    }
  });

  it('passes a valid nudge, however the body is cut into chunks', async () => {
    expect((await answer(bodyRequest({}, [valid]))).passed).toBe(true);
    expect((await answer(bodyRequest({}, [valid.slice(0, 5), valid.slice(5, 20), valid.slice(20)]))).passed).toBe(true);
    expect((await answer(bodyRequest({ 'content-length': String(valid.length) }, [valid]))).passed).toBe(true);
  });

  it('refuses a declared length above 256 without reading and closes the connection', async () => {
    const result = await answer(bodyRequest({ 'content-length': '257' }, [valid]));
    expect(result.code).toBe('payload_too_large');
    expect(result.seen.status).toBe(413);
    expect(result.seen.headers.get('connection')).toBe('close');
  });

  it('refuses a body that grows past 256 bytes while it is read', async () => {
    const result = await answer(bodyRequest({}, ['a'.repeat(200), 'b'.repeat(57)]));
    expect(result.code).toBe('payload_too_large');
    const exact = await answer(bodyRequest({}, ['a'.repeat(128), 'b'.repeat(128)]));
    expect(exact.code).toBe('body_invalid_json');
  });

  it('answers each kind of bad body with its own code', async () => {
    expect((await answer(bodyRequest({}, ['{"instanceId":']))).code).toBe('body_invalid_json');
    expect((await answer(bodyRequest({}, [Buffer.from([0xc3, 0x28])]))).code).toBe('body_invalid_json');
    expect((await answer(bodyRequest({}, ['{}']))).code).toBe('validation_failed');
    expect((await answer(bodyRequest({}, [JSON.stringify({ instanceId: OTHER_INSTANCE_ID })]))).code).toBe(
      'instance_mismatch',
    );
  });

  it('puts only the path and the issue code of a validation failure in details', async () => {
    const result = await answer(bodyRequest({}, [`{"instanceId":"${MARKER}","extra":true}`]));
    expect(result.seen.status).toBe(400);
    const { error } = ErrorEnvelopeSchema.parse(result.seen.body);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe(GUARD_ERROR_MESSAGES.validation_failed);
    expect(error.requestId).toMatch(REQUEST_ID_RE);
    expect(error.details).toContainEqual({ path: '', issue: 'unrecognized_keys' });
    expect(error.details).toContainEqual({ path: 'instanceId', issue: 'invalid_format' });
    expect(JSON.stringify(result.seen.body)).not.toContain(MARKER);
  });

  it('answers nothing for a client that went away, and never calls next', async () => {
    const stream = new Readable({ read: () => undefined });
    const request = Object.assign(stream, { method: 'POST', headers: { 'content-type': 'application/json' } }) as never;
    const { res, seen } = mockRes();
    let called = false;
    guard(request, res, () => {
      called = true;
    });
    stream.push('{"instanceId"');
    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(called).toBe(false);
    expect(seen.status).toBe(0);
  });

  it('passes a failure inside the guard to next(error) instead of hanging', async () => {
    const broken = Readable.from([]);
    Object.defineProperty(broken, 'headers', {
      get: () => {
        throw new Error('the request object is broken');
      },
    });
    const result = await runAsync(guard, broken as never);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.seen.status).toBe(0);
  });
});

describe('no CORS, ever (SEC-05, T3)', () => {
  it('sends no Access-Control-* header on any kind of response', async () => {
    const own = `http://localhost:${String(port)}`;
    const replies = [
      await send('/api/v3/ping'),
      await send('/api/v3/ping', { origin: own }),
      await send('/api/v3/ping', { origin: `http://${MARKER}.example` }),
      await send('/api/v3/ping', { host: `${MARKER}.example` }),
      await send('/api/v3/ping', {
        method: 'OPTIONS',
        origin: own,
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      await send('/api/v3/ping', { method: 'POST' }),
      await send('/api/v3/mutate', { method: 'POST' }),
      await postJson('/api/v3/ingest/nudge', JSON.stringify({ instanceId: INSTANCE_ID })),
      await send('/index.html'),
    ];
    for (const reply of replies) expectNoCors(reply);
  });
});
