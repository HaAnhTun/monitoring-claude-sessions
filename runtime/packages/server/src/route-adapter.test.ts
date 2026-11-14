// `registerRoute` (03 13 item 2; CAW design 02 3, ADR 0084): path, query and response validation through the route registry, the
// error mapper, the 204 and the stream routes, the abort signal, and the table of mounted routes; then the guards the adapter
// builds from the route definition (csrf on every POST, the access chain, fail closed) and the strict body. A real Express app on
// a real socket.
import { Agent, request as httpRequestRaw, type IncomingHttpHeaders, type Server } from 'node:http';
import net from 'node:net';

import { DbError, createAccessService, type AccessService } from '@mcs/engine';
import { ErrorEnvelopeSchema, defineRoute, intString, textOf } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest } from '@mcs/testkit';
import express, { type Express, type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiError } from './errors.ts';
import { accessOf, createAccessVerifier } from './http/access-guard.ts';
import { cookieName } from './http/cookie.ts';
import {
  bindRouteServices,
  mountedRoutes,
  registerRoute,
  type AccessBinding,
  type RouteServices,
} from './route-adapter.ts';

interface Recorded {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

class TestServices implements RouteServices {
  /** The access binding of the app: `null` is a task instance (no access service). */
  access: AccessBinding | null = null;
  readonly ringEntries: { source: string; code: string; where: string | null; message: string }[] = [];
  readonly logs: Recorded[] = [];
  validateResponses = true;
  readonly errors = {
    push: (entry: { source: string; code: string; where: string | null; message: string }): void => {
      this.ringEntries.push(entry);
    },
  };
  readonly logger = {
    debug: (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      this.logs.push({ level: 'debug', event, fields });
    },
    info: (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      this.logs.push({ level: 'info', event, fields });
    },
    warn: (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      this.logs.push({ level: 'warn', event, fields });
    },
    error: (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      this.logs.push({ level: 'error', event, fields });
    },
  };
}

const servers: { readonly server: Server; readonly port: number }[] = [];
afterEach(async () => {
  const started = servers.splice(0);
  await Promise.all(
    started.map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  for (const { port } of started) await assertPortClosed(port);
});

async function serve(app: Express, bound?: { port: number }): Promise<number> {
  const port = await allocatePort();
  if (bound !== undefined) bound.port = port;
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return port;
}

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const CONTROL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

interface Setup {
  readonly app: Express;
  readonly services: TestServices;
  /** The port of the server once `serve(app, bound)` has listened; the access guard reads it on every request. */
  readonly bound: { port: number };
  readonly clock: FakeClock;
  readonly access: AccessService;
  /** Signs in and returns the `Cookie` header of the new session. */
  readonly signIn: () => string;
}

function setup(over: { validateResponses?: boolean; access?: boolean } = {}): Setup {
  const app = express();
  const services = new TestServices();
  if (over.validateResponses !== undefined) services.validateResponses = over.validateResponses;
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const access = createAccessService({ clock, controlToken: CONTROL_TOKEN });
  const bound = { port: 0 };
  // most tests are a user instance (an access service is wired); `access: false` is a task instance
  if (over.access !== false) {
    services.access = { verifier: createAccessVerifier(access, INSTANCE), port: () => bound.port };
  }
  bindRouteServices(app, services);
  return {
    app,
    services,
    bound,
    clock,
    access,
    signIn: () => {
      const outcome = access.exchange(access.mint().code);
      if (!outcome.ok) throw new Error('sign-in failed');
      return `${cookieName(INSTANCE)}=${outcome.credential}`;
    },
  };
}

const Name = z.string().regex(/^[a-z]{1,8}$/);
const EchoParams = z.strictObject({ name: Name });
const EchoQuery = z.strictObject({ n: intString(1, 50).optional(), tag: z.enum(['a', 'b']).optional() });
const EchoResponse = z.strictObject({ name: Name, n: z.number().nullable(), tag: z.string().nullable() });

const echo = defineRoute({
  id: 'echo',
  method: 'GET',
  path: '/api/v3/test/echo/:name',
  params: EchoParams,
  query: EchoQuery,
  body: null,
  response: EchoResponse,
  successStatus: 200,
  errors: [],
  summary: 'Test route.',
  contentType: 'application/json',
});

const SearchQuery = z.strictObject({ q: textOf(2, 200).optional(), n: intString(1, 50).optional() });
const search = defineRoute({
  id: 'search',
  method: 'GET',
  path: '/api/v3/test/search',
  params: null,
  query: SearchQuery,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: ['query_too_short'],
  summary: 'Test route with a text search.',
  contentType: 'application/json',
});

const plain = defineRoute({
  id: 'plain',
  method: 'GET',
  path: '/api/v3/test/plain',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Test route without parameters.',
  contentType: 'application/json',
});

const nothing = defineRoute({
  id: 'nothing',
  method: 'POST',
  path: '/api/v3/test/nothing',
  params: null,
  query: null,
  body: z.strictObject({}),
  response: null,
  successStatus: 204,
  errors: [],
  summary: 'Test route that answers 204.',
  contentType: null,
  access: 'session', // a write route is never open (defineRoute)
});

const stream = defineRoute({
  id: 'stream',
  method: 'GET',
  path: '/api/v3/test/stream',
  params: null,
  query: null,
  body: null,
  response: null,
  successStatus: 200,
  errors: [],
  summary: 'Test route that writes its own response.',
  contentType: 'application/x-ndjson',
});

/**
 * Answers after the adapter has resumed from `await handler(...)`. A microtask would not do: it is queued by the handler, so it runs
 * before the adapter resumes, `res.headersSent` is already true, and the `handled` flag would never be read. A timer runs after
 * every microtask (setImmediate is no sleep: it waits for nothing but the microtask queue), so only the flag keeps the adapter from
 * answering 500 first. The guard turns a missing flag into a failed assertion on the status instead of a throw inside the callback.
 */
function answerLater(res: { readonly headersSent: boolean }, answer: () => void): void {
  setImmediate(() => {
    if (!res.headersSent) answer();
  });
}

/** A value that the compiler cannot check: a handler that returns the wrong shape on purpose. */
function untyped(value: unknown): never {
  return value as never;
}

function envelopeOf(body: string): z.infer<typeof ErrorEnvelopeSchema> {
  return ErrorEnvelopeSchema.parse(JSON.parse(body));
}

describe('registerRoute: a valid request', () => {
  it('hands the handler parsed params and query, and answers JSON with the schema of the route', async () => {
    const { app } = setup();
    let seen: unknown;
    registerRoute(app, echo, ({ params, query }) => {
      seen = { params, query };
      return { name: params.name, n: query.n ?? null, tag: query.tag ?? null };
    });
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/echo/abc?n=7&tag=b');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(reply.body)).toEqual({ name: 'abc', n: 7, tag: 'b' });
    expect(seen).toEqual({ params: { name: 'abc' }, query: { n: 7, tag: 'b' } });
  });

  it('answers HEAD like GET without a body', async () => {
    const { app } = setup();
    registerRoute(app, plain, () => ({ ok: true }));
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/plain', { method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
  });

  it('accepts a handler that returns a promise', async () => {
    const { app } = setup();
    registerRoute(app, plain, () => Promise.resolve({ ok: true as const }));
    const port = await serve(app);
    expect(JSON.parse((await httpRequest(port, '/api/v3/test/plain')).body)).toEqual({ ok: true });
  });

  it('gives the handler the request id of the response, and an abort signal that is not aborted', async () => {
    const { app } = setup();
    let seen: { requestId: string; aborted: boolean } | undefined;
    registerRoute(app, plain, ({ requestId, signal }) => {
      seen = { requestId, aborted: signal.aborted };
      return { ok: true };
    });
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/plain');
    expect(seen?.requestId).toMatch(/^r-[0-9a-z]{12}$/);
    expect(seen?.aborted).toBe(false);
    expect(reply.headers['x-request-id']).toBe(seen?.requestId);
  });
});

describe('registerRoute: validation (400)', () => {
  it('refuses a path parameter that does not match, with the Zod issue code and never the value', async () => {
    const { app } = setup();
    registerRoute(app, echo, ({ params }) => ({ name: params.name, n: null, tag: null }));
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/echo/NOT-A-NAME-SECRET');
    expect(reply.status).toBe(400);
    const envelope = envelopeOf(reply.body);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.details).toEqual([{ path: 'name', issue: 'invalid_format' }]);
    expect(reply.body).not.toContain('SECRET');
  });

  it('refuses an unknown query key and a bad value, listing paths and issue codes only', async () => {
    const { app } = setup();
    registerRoute(app, echo, ({ params }) => ({ name: params.name, n: null, tag: null }));
    const port = await serve(app);
    const unknownKey = await httpRequest(port, '/api/v3/test/echo/abc?surprise=1');
    expect(unknownKey.status).toBe(400);
    expect(envelopeOf(unknownKey.body).error.code).toBe('validation_failed');
    expect(unknownKey.body).not.toContain('surprise');

    const bad = await httpRequest(port, '/api/v3/test/echo/abc?n=abc&tag=zzz');
    expect(bad.status).toBe(400);
    const details = envelopeOf(bad.body).error.details ?? [];
    expect(details.map((d) => d.path).sort()).toEqual(['n', 'tag']);
    expect(bad.body).not.toContain('zzz');
  });

  it('answers query_too_short for a q below its minimum, with the same details as any other failure', async () => {
    const { app } = setup();
    registerRoute(app, search, () => ({ ok: true }));
    const port = await serve(app);
    for (const short of ['a', '%20a%20', '%20%20%20', '']) {
      const reply = await httpRequest(port, `/api/v3/test/search?q=${short}`);
      expect(reply.status, short).toBe(400);
      const envelope = envelopeOf(reply.body);
      expect(envelope.error.code, short).toBe('query_too_short');
      expect(envelope.error.details, short).toEqual([{ path: 'q', issue: 'too_small' }]);
    }
    expect((await httpRequest(port, '/api/v3/test/search?q=ab')).status).toBe(200);
    expect((await httpRequest(port, '/api/v3/test/search')).status).toBe(200);
  });

  it('keeps validation_failed for a q that is too long or for another bad parameter', async () => {
    const { app } = setup();
    registerRoute(app, search, () => ({ ok: true }));
    const port = await serve(app);
    const tooLong = await httpRequest(port, `/api/v3/test/search?q=${'x'.repeat(201)}`);
    expect(tooLong.status).toBe(400);
    expect(envelopeOf(tooLong.body).error.code).toBe('validation_failed');
    expect(envelopeOf(tooLong.body).error.details).toEqual([{ path: 'q', issue: 'too_big' }]);
    const other = await httpRequest(port, '/api/v3/test/search?n=abc');
    expect(envelopeOf(other.body).error.code).toBe('validation_failed');
    expect((envelopeOf(other.body).error.details ?? []).map((d) => d.path)).toEqual(['n']);
    // a short q next to another failure is still reported as the short q, and both paths stay listed
    const both = await httpRequest(port, '/api/v3/test/search?q=a&n=abc');
    expect(envelopeOf(both.body).error.code).toBe('query_too_short');
    expect((envelopeOf(both.body).error.details ?? []).map((d) => d.path).sort()).toEqual(['n', 'q']);
  });

  it('refuses a repeated key with param_repeated', async () => {
    const { app } = setup();
    registerRoute(app, echo, ({ params }) => ({ name: params.name, n: null, tag: null }));
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/echo/abc?n=1&n=2');
    expect(reply.status).toBe(400);
    expect(envelopeOf(reply.body).error.code).toBe('param_repeated');
    expect(reply.body).not.toContain('"n"');
  });

  it('treats a route without a query schema as one that takes no query at all', async () => {
    const { app } = setup();
    registerRoute(app, plain, () => ({ ok: true }));
    const port = await serve(app);
    expect((await httpRequest(port, '/api/v3/test/plain')).status).toBe(200);
    const reply = await httpRequest(port, '/api/v3/test/plain?x=1');
    expect(reply.status).toBe(400);
    expect(envelopeOf(reply.body).error.code).toBe('validation_failed');
    const repeated = await httpRequest(port, '/api/v3/test/plain?x=1&x=2');
    expect(envelopeOf(repeated.body).error.code).toBe('param_repeated');
  });
});

describe('registerRoute: the response', () => {
  it('answers 204 without a body or a content type', async () => {
    const { app, bound, signIn } = setup();
    registerRoute(app, nothing, () => undefined);
    const port = await serve(app, bound);
    // CAW-18: a write route is behind csrf, the Origin and the session cookie now, so the request carries them
    const reply = await httpRequest(port, '/api/v3/test/nothing', {
      method: 'POST',
      origin: `http://127.0.0.1:${String(port)}`,
      headers: { 'Content-Type': 'application/json', 'X-MCS-Request': '1', Cookie: signIn() },
      body: '{}',
    });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(reply.headers['content-type']).toBeUndefined();
  });

  it('validates the response when asked: an invalid one is a 500 internal_error and one ring entry, without the data', async () => {
    const { app, services } = setup();
    registerRoute(app, echo, ({ params }) =>
      // a handler bug: `n` is a string
      untyped({ name: params.name, n: 'SECRET-PAYLOAD', tag: null }),
    );
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/echo/abc');
    expect(reply.status).toBe(500);
    expect(envelopeOf(reply.body).error.code).toBe('internal_error');
    expect(reply.body).not.toContain('SECRET-PAYLOAD');
    expect(services.ringEntries).toHaveLength(1);
    expect(services.ringEntries[0]).toMatchObject({ source: 'server', code: 'INTERNAL', where: 'echo' });
    expect(JSON.stringify(services.ringEntries)).not.toContain('SECRET-PAYLOAD');
  });

  it('sends the handler result as it is when response validation is off (production)', async () => {
    const { app, services } = setup({ validateResponses: false });
    registerRoute(app, echo, ({ params }) => untyped({ name: params.name, n: 'text', tag: null }));
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/echo/abc');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ name: 'abc', n: 'text', tag: null });
    expect(services.ringEntries).toEqual([]);
  });

  it('leaves a stream route to its handler, and answers 500 when the handler forgot to answer', async () => {
    const { app, services } = setup();
    registerRoute(app, stream, ({ res }) => {
      res.status(200).type('application/x-ndjson').end('{"a":1}\n');
    });
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/stream');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"a":1}\n');

    const forgetful = setup();
    registerRoute(forgetful.app, stream, () => undefined);
    const forgetfulPort = await serve(forgetful.app);
    const second = await httpRequest(forgetfulPort, '/api/v3/test/stream');
    expect(second.status).toBe(500);
    expect(envelopeOf(second.body).error.code).toBe('internal_error');
    expect(forgetful.services.ringEntries).toHaveLength(1);
    expect(services.ringEntries).toEqual([]);
  });
});

describe('registerRoute: errors of the handler', () => {
  it('maps an ApiError to its code and status', async () => {
    const { app, services } = setup();
    registerRoute(app, plain, () => {
      throw new ApiError('probe_not_found');
    });
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/plain');
    expect(reply.status).toBe(404);
    expect(envelopeOf(reply.body).error.code).toBe('probe_not_found');
    expect(services.ringEntries).toEqual([]);
  });

  it('maps a rejected promise and the database errors', async () => {
    const { app } = setup();
    let next: () => unknown = () => Promise.reject(new DbError('db_busy', 'busy'));
    registerRoute(app, plain, () => {
      const result = next();
      if (result instanceof Promise) return result.then(() => ({ ok: true as const }));
      return { ok: true as const };
    });
    const port = await serve(app);
    const busy = await httpRequest(port, '/api/v3/test/plain');
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    expect(envelopeOf(busy.body).error.code).toBe('db_busy');
    next = () => Promise.reject(new DbError('db_full', 'full'));
    const full = await httpRequest(port, '/api/v3/test/plain');
    expect(full.status).toBe(503);
    expect(envelopeOf(full.body).error.code).toBe('disk_full');
  });

  it('answers 500 for an unexpected error, records one ring entry and one log line, and never echoes the message', async () => {
    const { app, services } = setup();
    registerRoute(app, plain, () => {
      throw new Error('C:/secret/path and a prompt text');
    });
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/plain');
    expect(reply.status).toBe(500);
    expect(envelopeOf(reply.body).error.code).toBe('internal_error');
    expect(reply.body).not.toContain('secret');
    expect(services.ringEntries).toHaveLength(1);
    expect(services.ringEntries[0]).toMatchObject({ source: 'server', code: 'INTERNAL', where: 'plain' });
    expect(JSON.stringify(services.ringEntries)).not.toContain('secret');
    expect(JSON.stringify(services.logs)).not.toContain('secret');
    const failure = services.logs.find((entry) => entry.level === 'error');
    expect(failure?.fields).toMatchObject({ route: 'plain' });
  });
});

describe('registerRoute: guards before the handler, abort and the table', () => {
  it('runs the guards of `before` first, with the route id already known, and lets one of them end the request', async () => {
    const { app } = setup();
    const order: string[] = [];
    let routeId: unknown;
    const first: RequestHandler = (_req, res, next) => {
      order.push('first');
      routeId = res.locals['routeId'];
      next();
    };
    const refuse: RequestHandler = (_req, res) => {
      order.push('refuse');
      res.status(418).json({ refused: true });
    };
    registerRoute(
      app,
      plain,
      () => {
        order.push('handler');
        return { ok: true };
      },
      { before: [first, refuse] },
    );
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/plain');
    expect(reply.status).toBe(418);
    expect(order).toEqual(['first', 'refuse']);
    expect(routeId).toBe('plain');
  });

  it('aborts the signal when the client goes away before the answer', async () => {
    const { app } = setup();
    let aborted: (value: boolean) => void = () => undefined;
    const done = new Promise<boolean>((resolve) => {
      aborted = resolve;
    });
    let started: () => void = () => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    registerRoute(app, plain, ({ signal }) => {
      started();
      return new Promise<{ ok: true }>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted(true);
          resolve({ ok: true });
        });
      });
    });
    const port = await serve(app);
    const pending = httpRequest(port, '/api/v3/test/plain', { timeoutMs: 100 }).catch(() => 'closed');
    await handlerStarted;
    await pending; // the client gave up after 100 ms
    expect(await done).toBe(true);
  });

  it('lists the mounted routes and refuses a duplicate id or a duplicate method and path', () => {
    const { app } = setup();
    registerRoute(app, plain, () => ({ ok: true }));
    registerRoute(app, nothing, () => undefined);
    expect(mountedRoutes(app).map((route) => route.id)).toEqual(['plain', 'nothing']);
    expect(() => {
      registerRoute(app, plain, () => ({ ok: true }));
    }).toThrow(/plain/);
    const clone = defineRoute({ ...plain, id: 'plainClone' });
    expect(() => {
      registerRoute(app, clone, () => ({ ok: true }));
    }).toThrow(/GET \/api\/v3\/test\/plain/);
  });

  it('works on an app that no one gave services to: responses are validated unless NODE_ENV is production', async () => {
    const app = express();
    registerRoute(app, plain, () => untyped({ ok: true }));
    const port = await serve(app);
    expect((await httpRequest(port, '/api/v3/test/plain')).status).toBe(200);
  });
});

// ---- the guards that the adapter builds from the route definition (CAW-18, design 02 3, ADR 0084) ---------------------------

interface Sent {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface SendOptions {
  readonly method?: string;
  readonly origin?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The whole body, sent with a Content-Length. */
  readonly body?: string | Buffer;
  /** The pieces of a body sent without a Content-Length (chunked). */
  readonly chunks?: readonly (string | Buffer)[];
  /** A Content-Length that the request does not keep: `body` is what is written and the request is left open. */
  readonly declared?: number;
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** One request on a keep-alive client: the testkit helper asks for `Connection: close`, which would hide the server's choice. */
function send(port: number, path: string, o: SendOptions = {}): Promise<Sent> {
  const agent = new Agent({ keepAlive: true });
  const headers: Record<string, string> = { ...o.headers, Host: `127.0.0.1:${String(port)}` };
  if (o.origin !== undefined) headers['Origin'] = o.origin;
  if (o.declared !== undefined) headers['Content-Length'] = String(o.declared);
  else if (o.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers, agent, timeout: 10_000 },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.once('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(parts).toString('utf8'),
          });
          agent.destroy();
          req.destroy();
        });
        res.once('error', reject);
      },
    );
    req.once('timeout', () => {
      req.destroy(new Error('the request timed out'));
    });
    req.once('error', reject);
    if (o.chunks !== undefined) {
      for (const chunk of o.chunks) req.write(chunk);
      req.end();
    } else if (o.declared !== undefined) {
      if (o.body !== undefined) req.write(o.body);
    } else {
      req.end(o.body);
    }
  });
}

const Item = z.strictObject({ value: z.number().int().min(0).max(1000) });

const create = defineRoute({
  id: 'create',
  method: 'POST',
  path: '/api/v3/test/items',
  params: null,
  query: null,
  body: Item,
  response: z.strictObject({ value: z.number() }),
  successStatus: 200,
  errors: [],
  summary: 'Test write route.',
  contentType: 'application/json',
  access: 'session',
});

const small = defineRoute({
  id: 'small',
  method: 'POST',
  path: '/api/v3/test/small',
  params: null,
  query: null,
  body: Item,
  response: z.strictObject({ value: z.number() }),
  successStatus: 200,
  errors: [],
  summary: 'Test write route with a body limit of 16 bytes.',
  contentType: 'application/json',
  access: 'session',
  maxBodyBytes: 16,
});

const redeem = defineRoute({
  id: 'redeem',
  method: 'POST',
  path: '/api/v3/test/redeem',
  params: null,
  query: null,
  body: z.strictObject({ code: z.string() }),
  response: z.strictObject({ code: z.string(), via: z.string().nullable() }),
  successStatus: 200,
  errors: [],
  summary: 'Test ticket route.',
  contentType: 'application/json',
  access: 'ticket',
});

const reading = defineRoute({
  id: 'reading',
  method: 'GET',
  path: '/api/v3/test/reading',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ via: z.string().nullable() }),
  successStatus: 200,
  errors: [],
  summary: 'Test reader route.',
  contentType: 'application/json',
  access: 'reader',
});

const secret = defineRoute({
  id: 'secret',
  method: 'GET',
  path: '/api/v3/test/secret',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ via: z.string().nullable() }),
  successStatus: 200,
  errors: [],
  summary: 'Test session read route.',
  contentType: 'application/json',
  access: 'session',
});

const socketLike = defineRoute({
  id: 'socketLike',
  method: 'GET',
  path: '/api/v3/test/socket-like',
  params: null,
  query: null,
  body: null,
  response: null,
  successStatus: 101,
  errors: [],
  summary: 'Test route that completes an upgrade itself.',
  contentType: 'websocket',
  access: 'session',
});

/** The one write route that may stay open (defineRoute): the shape of the hook nudge, with its own guard. */
const nudgeLike = defineRoute({
  id: 'ingestNudge',
  method: 'POST',
  path: '/api/v3/test/nudge-like',
  params: null,
  query: null,
  body: z.strictObject({ instanceId: z.string() }),
  response: null,
  successStatus: 204,
  errors: [],
  summary: 'Test route shaped like the hook nudge.',
  contentType: null,
  maxBodyBytes: 256,
});

const originOf = (port: number): string => `http://127.0.0.1:${String(port)}`;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' } as const;

interface WriteHarness {
  readonly h: Setup;
  readonly port: number;
  readonly cookie: string;
  /** The bodies that reached the handler. */
  readonly handled: { bodies: unknown[] };
  /** A valid write of `body`: JSON headers, the Origin and the cookie. */
  readonly post: (body: string | Buffer, extra?: SendOptions) => Promise<Sent>;
}

/** A user instance with one write route mounted (default: `create`). */
async function writable(
  over: { before?: readonly RequestHandler[]; route?: typeof create | typeof small } = {},
): Promise<WriteHarness> {
  const h = setup();
  const handled: { bodies: unknown[] } = { bodies: [] };
  const route = over.route ?? create;
  registerRoute(
    h.app,
    route,
    ({ body }) => {
      handled.bodies.push(body);
      return { value: body.value };
    },
    over.before === undefined ? {} : { before: over.before },
  );
  const port = await serve(h.app, h.bound);
  const cookie = h.signIn();
  return {
    h,
    port,
    cookie,
    handled,
    post: (body, { headers, ...rest } = {}) =>
      send(port, route.path, {
        method: 'POST',
        origin: originOf(port),
        body,
        ...rest,
        headers: { ...JSON_HEADERS, Cookie: cookie, ...headers },
      }),
  };
}

describe('registerRoute: csrf on every POST unless the route says otherwise (TC-SEC-14)', () => {
  it('refuses a write without the JSON content type or the X-MCS-Request header, with the connection closed', async () => {
    const { port, cookie, handled } = await writable();
    const headers = (extra: Record<string, string>): Record<string, string> => ({ Cookie: cookie, ...extra });
    for (const variant of [
      headers({ 'X-MCS-Request': '1' }),
      headers({ 'Content-Type': 'text/plain', 'X-MCS-Request': '1' }),
      headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'X-MCS-Request': '1' }),
      headers({ 'Content-Type': 'multipart/form-data; boundary=x', 'X-MCS-Request': '1' }),
      headers({ 'Content-Type': 'application/json' }),
      headers({ 'Content-Type': 'application/json', 'X-MCS-Request': '0' }),
      headers({ 'Content-Type': 'application/json', 'X-MCS-Request': 'true' }),
    ]) {
      const reply = await send(port, create.path, {
        method: 'POST',
        origin: originOf(port),
        headers: variant,
        body: '{"value":1}',
      });
      expect(reply.status, JSON.stringify(variant)).toBe(403);
      expect(envelopeOf(reply.body).error.code).toBe('csrf_rejected');
      expect(reply.headers['connection']).toBe('close');
    }
    expect(handled.bodies).toEqual([]);
  });

  it('lets a write through with both, a charset on the content type included', async () => {
    const { post, handled } = await writable();
    expect((await post('{"value":7}')).status).toBe(200);
    const withCharset = await post('{"value":8}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect(withCharset.status).toBe(200);
    expect(handled.bodies).toEqual([{ value: 7 }, { value: 8 }]);
  });

  it('checks csrf before the cookie: no header and no cookie is 403, the header without a cookie is 401', async () => {
    const { port } = await writable();
    const noHeaderNoCookie = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: { 'Content-Type': 'application/json' },
      body: '{"value":1}',
    });
    expect(envelopeOf(noHeaderNoCookie.body).error.code).toBe('csrf_rejected');
    const headerNoCookie = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: JSON_HEADERS,
      body: '{"value":1}',
    });
    expect(headerNoCookie.status).toBe(401);
    expect(envelopeOf(headerNoCookie.body).error.code).toBe('access_required');
  });

  it('is skipped for a route that registers with csrf: false, which brings its own guard', async () => {
    const h = setup({ access: false });
    let nudges = 0;
    const guard: RequestHandler = (req, res, next) => {
      if (req.headers['content-type'] !== 'application/json') {
        res.status(415).json({ refused: true });
        return;
      }
      res.locals['body'] = { instanceId: 'x' };
      next();
    };
    registerRoute(
      h.app,
      nudgeLike,
      () => {
        nudges += 1;
      },
      { before: [guard], csrf: false, bodyConsumed: true },
    );
    const port = await serve(h.app, h.bound);
    const reply = await send(port, nudgeLike.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"instanceId":"x"}',
    });
    expect(reply.status).toBe(204);
    expect(nudges).toBe(1);
    const refused = await send(port, nudgeLike.path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(refused.status).toBe(415);
    expect(nudges).toBe(1);
  });

  it('does not apply to GET', async () => {
    const h = setup();
    registerRoute(h.app, secret, () => ({ via: 'seen' }));
    const port = await serve(h.app, h.bound);
    const reply = await send(port, secret.path, { headers: { Cookie: h.signIn() } });
    expect(reply.status).toBe(200);
  });
});

describe('registerRoute: the access chain (TC-SEC-02, design 02 3, A1)', () => {
  it('is 401 access_required for a session route without a cookie, with the connection closed on a write', async () => {
    const { port, handled } = await writable();
    const reply = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: JSON_HEADERS,
      body: '{"value":1}',
    });
    expect(reply.status).toBe(401);
    expect(envelopeOf(reply.body).error.code).toBe('access_required');
    expect(reply.headers['www-authenticate']).toBe('CAW-Access');
    expect(reply.headers['connection']).toBe('close');
    expect(handled.bodies).toEqual([]);
  });

  it('wants the Origin on a write: none, a foreign one and another port are 403 origin_not_allowed', async () => {
    const { port, cookie, handled } = await writable();
    for (const origin of [undefined, 'null', 'http://evil.invalid', `http://127.0.0.1:${String(port + 1)}`]) {
      const reply = await send(port, create.path, {
        method: 'POST',
        ...(origin === undefined ? {} : { origin }),
        headers: { ...JSON_HEADERS, Cookie: cookie },
        body: '{"value":1}',
      });
      expect(reply.status, String(origin)).toBe(403);
      expect(envelopeOf(reply.body).error.code).toBe('origin_not_allowed');
    }
    expect(handled.bodies).toEqual([]);
  });

  it('wants the Origin on a websocket route although it is a GET, and lets the handler finish the upgrade (handled)', async () => {
    const h = setup();
    let ran = 0;
    registerRoute(h.app, socketLike, ({ res }) => {
      ran += 1;
      res.locals['handled'] = true;
      // the socket route finishes the upgrade itself, after the handler returned and the adapter went on
      answerLater(res, () => {
        res.status(200).end('upgraded');
      });
    });
    const port = await serve(h.app, h.bound);
    const cookie = h.signIn();
    const noOrigin = await send(port, socketLike.path, { headers: { Cookie: cookie } });
    expect(noOrigin.status).toBe(403);
    expect(ran).toBe(0);
    const ok = await send(port, socketLike.path, { origin: originOf(port), headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('upgraded');
    expect(h.services.ringEntries).toEqual([]);
  });

  it('serves a reader route open when no access service is wired (a task instance)', async () => {
    const h = setup({ access: false });
    let admitted: unknown = 'unset';
    registerRoute(h.app, reading, ({ res }) => {
      admitted = accessOf(res);
      return { via: null };
    });
    const port = await serve(h.app, h.bound);
    const reply = await send(port, reading.path);
    expect(reply.status).toBe(200);
    expect(admitted).toBeUndefined();
    // a header that nobody asked for changes nothing
    expect((await send(port, reading.path, { headers: { Authorization: 'Bearer anything' } })).status).toBe(200);
  });

  it('guards a reader route once an access service is wired: 401 alone, 200 with the cookie, 200 with the control token on GET', async () => {
    const h = setup();
    registerRoute(h.app, reading, ({ res }) => ({ via: accessOf(res)?.via ?? null }));
    const port = await serve(h.app, h.bound);
    const alone = await send(port, reading.path);
    expect(alone.status).toBe(401);
    expect(envelopeOf(alone.body).error.code).toBe('access_required');
    const cookie = await send(port, reading.path, { headers: { Cookie: h.signIn() } });
    expect(JSON.parse(cookie.body)).toEqual({ via: 'cookie' });
    const bearer = await send(port, reading.path, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(JSON.parse(bearer.body)).toEqual({ via: 'bearer' });
    expect((await send(port, reading.path, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('never takes the control token as a session on a session route', async () => {
    const h = setup();
    registerRoute(h.app, secret, () => ({ via: 'seen' }));
    const port = await serve(h.app, h.bound);
    const reply = await send(port, secret.path, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(reply.status).toBe(401);
  });

  it('needs no cookie for a ticket route, but csrf and the Origin; the handler sees the access context', async () => {
    const h = setup();
    registerRoute(h.app, redeem, ({ body, res }) => ({ code: body.code, via: accessOf(res)?.via ?? null }));
    const port = await serve(h.app, h.bound);
    const ok = await send(port, redeem.path, {
      method: 'POST',
      origin: originOf(port),
      headers: JSON_HEADERS,
      body: '{"code":"abc"}',
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ code: 'abc', via: 'ticket' });
    const noOrigin = await send(port, redeem.path, { method: 'POST', headers: JSON_HEADERS, body: '{"code":"abc"}' });
    expect(noOrigin.status).toBe(403);
    const noCsrf = await send(port, redeem.path, {
      method: 'POST',
      origin: originOf(port),
      headers: { 'Content-Type': 'application/json' },
      body: '{"code":"abc"}',
    });
    expect(noCsrf.status).toBe(403);
    expect(envelopeOf(noCsrf.body).error.code).toBe('csrf_rejected');
  });

  it('runs the guards in order: csrf, access, the guards of `before`, then the body, then the handler', async () => {
    const order: string[] = [];
    const before: RequestHandler = (_req, _res, next) => {
      order.push('before');
      next();
    };
    const { port, cookie, handled } = await writable({ before: [before] });
    const base = { method: 'POST', origin: originOf(port) };
    // no csrf header: stops at the first guard
    await send(port, create.path, { ...base, headers: { 'Content-Type': 'application/json' }, body: '{"value":1}' });
    // csrf but no cookie: stops at the access guard
    await send(port, create.path, { ...base, headers: JSON_HEADERS, body: '{"value":1}' });
    expect(order).toEqual([]);
    // everything but a valid body: the guard of `before` ran, the handler did not
    await send(port, create.path, { ...base, headers: { ...JSON_HEADERS, Cookie: cookie }, body: 'not json' });
    expect(order).toEqual(['before']);
    expect(handled.bodies).toEqual([]);
    await send(port, create.path, { ...base, headers: { ...JSON_HEADERS, Cookie: cookie }, body: '{"value":1}' });
    expect(order).toEqual(['before', 'before']);
    expect(handled.bodies).toEqual([{ value: 1 }]);
  });

  it('never reads or parses the body of a request that is not admitted: bad JSON without a cookie is 401, not 400', async () => {
    const { port } = await writable();
    const reply = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: JSON_HEADERS,
      body: '{ not json',
    });
    expect(reply.status).toBe(401);
    const big = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: JSON_HEADERS,
      declared: 1_000_000,
      body: '{',
    });
    expect(big.status).toBe(401);
    expect(big.headers['connection']).toBe('close');
  });
});

describe('registerRoute: fail closed (design 02 3, A1)', () => {
  it('throws when a session or ticket route is mounted on an app with no access service, naming the route', () => {
    const h = setup({ access: false });
    expect(() => {
      registerRoute(h.app, create, ({ body }) => ({ value: body.value }));
    }).toThrow(/create/);
    expect(() => {
      registerRoute(h.app, secret, () => ({ via: null }));
    }).toThrow(/secret/);
    expect(() => {
      registerRoute(h.app, redeem, ({ body }) => ({ code: body.code, via: null }));
    }).toThrow(/redeem/);
    expect(() => {
      registerRoute(h.app, socketLike, () => undefined);
    }).toThrow(/socketLike/);
    // a refused mount leaves no half route behind
    expect(mountedRoutes(h.app)).toEqual([]);
  });

  it('throws on an app that was never given services at all', () => {
    const app = express();
    expect(() => {
      registerRoute(app, secret, () => ({ via: null }));
    }).toThrow(/secret/);
    expect(mountedRoutes(app)).toEqual([]);
  });

  it('mounts reader and open routes without an access service, and every kind with one', () => {
    const open = setup({ access: false });
    registerRoute(open.app, reading, () => ({ via: null }));
    registerRoute(open.app, plain, () => ({ ok: true }));
    expect(mountedRoutes(open.app).map((route) => route.id)).toEqual(['reading', 'plain']);
    const user = setup();
    registerRoute(user.app, create, ({ body }) => ({ value: body.value }));
    registerRoute(user.app, secret, () => ({ via: null }));
    registerRoute(user.app, redeem, ({ body }) => ({ code: body.code, via: null }));
    registerRoute(user.app, reading, () => ({ via: null }));
    expect(mountedRoutes(user.app)).toHaveLength(4);
  });

  it('does not let a session route through when the access service is taken away after the mount', async () => {
    const h = setup();
    registerRoute(h.app, secret, () => ({ via: 'seen' }));
    const port = await serve(h.app, h.bound);
    const cookie = h.signIn();
    expect((await send(port, secret.path, { headers: { Cookie: cookie } })).status).toBe(200);
    h.services.access = null;
    const reply = await send(port, secret.path, { headers: { Cookie: cookie } });
    expect(reply.status).toBe(401);
    expect(envelopeOf(reply.body).error.code).toBe('access_required');
  });

  it('does not let a ticket route through when the access service is taken away after the mount', async () => {
    const h = setup();
    let ran = 0;
    registerRoute(h.app, redeem, ({ body }) => {
      ran += 1;
      return { code: body.code, via: null };
    });
    const port = await serve(h.app, h.bound);
    const post = (): ReturnType<typeof send> =>
      send(port, redeem.path, {
        method: 'POST',
        origin: originOf(port),
        headers: JSON_HEADERS,
        body: '{"code":"abc"}',
      });
    expect((await post()).status).toBe(200);
    expect(ran).toBe(1);
    h.services.access = null;
    const reply = await post();
    expect(reply.status).toBe(401);
    expect(envelopeOf(reply.body).error.code).toBe('access_required');
    expect(ran).toBe(1);
  });

  it('asks the access service that is bound now, not the one the route first met', async () => {
    const h = setup();
    registerRoute(h.app, secret, () => ({ via: 'seen' }));
    const port = await serve(h.app, h.bound);
    const oldCookie = h.signIn();
    expect((await send(port, secret.path, { headers: { Cookie: oldCookie } })).status).toBe(200);
    // another access service takes the place of the first one: its sessions are the only ones that count
    const next = createAccessService({ clock: h.clock, controlToken: CONTROL_TOKEN });
    h.services.access = { verifier: createAccessVerifier(next, INSTANCE), port: () => h.bound.port };
    const exchanged = next.exchange(next.mint().code);
    if (!exchanged.ok) throw new Error('sign-in failed');
    const newCookie = `${cookieName(INSTANCE)}=${exchanged.credential}`;
    expect((await send(port, secret.path, { headers: { Cookie: oldCookie } })).status).toBe(401);
    expect((await send(port, secret.path, { headers: { Cookie: newCookie } })).status).toBe(200);
  });
});

describe('registerRoute: the body of a write (TC-SEC-22)', () => {
  it('hands the handler the parsed body of the route schema', async () => {
    const { post, handled } = await writable();
    const reply = await post('{"value":42}');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ value: 42 });
    expect(handled.bodies).toEqual([{ value: 42 }]);
  });

  it('gives a GET route no body', async () => {
    const h = setup({ access: false });
    let seen: unknown = 'unset';
    registerRoute(h.app, plain, ({ body }) => {
      seen = body;
      return { ok: true };
    });
    const port = await serve(h.app, h.bound);
    await httpRequest(port, plain.path);
    expect(seen).toBeUndefined();
  });

  it('is 400 body_invalid_json for an empty body, text that is not JSON, a byte order mark, bad UTF-8 and trailing text', async () => {
    const { post, handled } = await writable();
    const marker = 'leak-marker-5d2e';
    for (const body of [
      '',
      '{',
      `not json ${marker}`,
      "{'value':1}",
      `${String.fromCodePoint(0xfeff)}{"value":1}`,
      '{"value":1} trailing',
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
    ]) {
      const reply = await post(body);
      expect(reply.status, String(body)).toBe(400);
      expect(envelopeOf(reply.body).error.code).toBe('body_invalid_json');
      expect(reply.body).not.toContain(marker);
    }
    expect(handled.bodies).toEqual([]);
  });

  it('is 400 validation_failed for another shape, with paths and issue codes and never the value', async () => {
    const { post, handled } = await writable();
    const marker = 'leak-marker-8a4b';
    for (const body of [
      '[]',
      'null',
      '"x"',
      '5',
      '{}',
      `{"value":"${marker}"}`,
      '{"value":1.5}',
      '{"value":-1}',
      '{"value":1001}',
    ]) {
      const reply = await post(body);
      expect(reply.status, body).toBe(400);
      expect(envelopeOf(reply.body).error.code).toBe('validation_failed');
      expect(reply.body).not.toContain(marker);
    }
    const extra = await post('{"value":1,"extra":true}');
    expect(envelopeOf(extra.body).error.details).toEqual([{ path: '', issue: 'unrecognized_keys' }]);
    const wrong = await post(`{"value":"${marker}"}`);
    expect(envelopeOf(wrong.body).error.details).toEqual([{ path: 'value', issue: 'invalid_type' }]);
    expect(handled.bodies).toEqual([]);
  });

  it('refuses __proto__ and constructor keys like any other unknown key', async () => {
    const { post, handled } = await writable();
    for (const body of [
      '{"value":1,"__proto__":{"admin":true}}',
      '{"__proto__":{"value":1}}',
      '{"value":1,"constructor":{}}',
    ]) {
      const reply = await post(body);
      expect(reply.status, body).toBe(400);
      expect(envelopeOf(reply.body).error.code).toBe('validation_failed');
    }
    expect(handled.bodies).toEqual([]);
    expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false);
  });

  it('allows exactly 4096 bytes by default and answers 413 with the connection closed for 4097', async () => {
    const { post, handled } = await writable();
    const padded = (size: number): string => `{"value":1}${' '.repeat(size - '{"value":1}'.length)}`;
    expect(Buffer.byteLength(padded(4096))).toBe(4096);
    expect((await post(padded(4096))).status).toBe(200);
    const refused = await post(padded(4097));
    expect(refused.status).toBe(413);
    expect(envelopeOf(refused.body).error.code).toBe('payload_too_large');
    expect(refused.headers['connection']).toBe('close');
    expect(handled.bodies).toEqual([{ value: 1 }]);
  });

  it('takes the limit of the route: 16 bytes for a route that says so', async () => {
    const { post, handled } = await writable({ route: small });
    const sized = (size: number): string => `{"value":1}${' '.repeat(size - '{"value":1}'.length)}`;
    expect((await post(sized(15))).status).toBe(200);
    expect((await post(sized(16))).status).toBe(200);
    const refused = await post(sized(17));
    expect(refused.status).toBe(413);
    expect(handled.bodies).toHaveLength(2);
  });

  it('refuses a declared length over the limit without waiting for the body, even when the body is short (a lying client)', async () => {
    const { port, cookie, handled } = await writable();
    const reply = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: { ...JSON_HEADERS, Cookie: cookie },
      declared: 5000,
      body: '{"value":1}',
    });
    expect(reply.status).toBe(413);
    expect(reply.headers['connection']).toBe('close');
    expect(handled.bodies).toEqual([]);
  });

  it('counts the bytes of a body that has no Content-Length and stops at the limit', async () => {
    const { port, cookie, handled } = await writable({ route: small });
    const post = (chunks: readonly string[]): Promise<Sent> =>
      send(port, small.path, {
        method: 'POST',
        origin: originOf(port),
        headers: { ...JSON_HEADERS, Cookie: cookie },
        chunks,
      });
    expect((await post(['{"value"', ':1}'])).status).toBe(200);
    const refused = await post(['{"value":', '1', ' '.repeat(20), '}']);
    expect(refused.status).toBe(413);
    expect(refused.headers['connection']).toBe('close');
    expect(handled.bodies).toEqual([{ value: 1 }]);
  });

  it('answers nothing for a client that goes away in the middle of the body, and keeps serving', async () => {
    const { port, cookie, handled, h } = await writable();
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          [
            `POST ${create.path} HTTP/1.1`,
            `Host: 127.0.0.1:${String(port)}`,
            `Origin: ${originOf(port)}`,
            'Content-Type: application/json',
            'X-MCS-Request: 1',
            `Cookie: ${cookie}`,
            'Content-Length: 100',
            '',
            '{"value"',
          ].join('\r\n'),
          () => {
            socket.destroy();
          },
        );
      });
      socket.once('close', () => {
        resolve();
      });
    });
    const next = await send(port, create.path, {
      method: 'POST',
      origin: originOf(port),
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: '{"value":3}',
    });
    expect(next.status).toBe(200);
    expect(handled.bodies).toEqual([{ value: 3 }]);
    expect(h.services.ringEntries).toEqual([]);
    expect(h.services.logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('takes the body that a guard of `before` consumed (bodyConsumed) instead of reading it again, and fails when none was published', async () => {
    const h = setup({ access: false });
    let got: unknown = 'unset';
    const publishing: RequestHandler = async (req, res, next) => {
      // a guard that reads the whole body itself, like the nudge guard
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.locals['body'] = parsed;
      next();
    };
    const forgetful: RequestHandler = (_req, _res, next) => {
      next();
    };
    registerRoute(
      h.app,
      nudgeLike,
      ({ body }) => {
        got = body;
      },
      { before: [publishing], csrf: false, bodyConsumed: true },
    );
    const second = setup({ access: false });
    registerRoute(second.app, nudgeLike, () => undefined, { before: [forgetful], csrf: false, bodyConsumed: true });
    const port = await serve(h.app, h.bound);
    const reply = await send(port, nudgeLike.path, { method: 'POST', body: '{"instanceId":"x"}' });
    expect(reply.status).toBe(204);
    expect(got).toEqual({ instanceId: 'x' });
    const secondPort = await serve(second.app, second.bound);
    const failed = await send(secondPort, nudgeLike.path, { method: 'POST', body: '{"instanceId":"x"}' });
    expect(failed.status).toBe(500);
    expect(envelopeOf(failed.body).error.code).toBe('internal_error');
    expect(second.services.ringEntries).toHaveLength(1);
    expect(second.services.ringEntries[0]).toMatchObject({ where: 'ingestNudge' });
  });

  it('does not read a body for a POST route that has no body schema', async () => {
    const h = setup();
    const bare = defineRoute({
      id: 'bare',
      method: 'POST',
      path: '/api/v3/test/bare',
      params: null,
      query: null,
      body: null,
      response: z.strictObject({ ok: z.literal(true) }),
      successStatus: 200,
      errors: [],
      summary: 'Test write route without a body.',
      contentType: 'application/json',
      access: 'session',
    });
    let seen: unknown = 'unset';
    registerRoute(h.app, bare, ({ body }) => {
      seen = body;
      return { ok: true };
    });
    const port = await serve(h.app, h.bound);
    const reply = await send(port, bare.path, {
      method: 'POST',
      origin: originOf(port),
      headers: { ...JSON_HEADERS, Cookie: h.signIn() },
      body: '{"anything":true}',
    });
    expect(reply.status).toBe(200);
    expect(seen).toBeUndefined();
  });
});

describe('registerRoute: a handler that answers later (handled)', () => {
  it('is not an error when the handler sets res.locals.handled, and still is when it does not', async () => {
    const answering = setup({ access: false });
    registerRoute(answering.app, stream, ({ res }) => {
      res.locals['handled'] = true;
      answerLater(res, () => {
        res.status(200).type('application/x-ndjson').end('{"late":true}\n');
      });
    });
    const port = await serve(answering.app, answering.bound);
    const late = await send(port, stream.path);
    expect(late.status).toBe(200);
    expect(late.body).toBe('{"late":true}\n');
    expect(answering.services.ringEntries).toEqual([]);

    const forgetful = setup({ access: false });
    registerRoute(forgetful.app, stream, () => undefined);
    const forgetfulPort = await serve(forgetful.app, forgetful.bound);
    expect((await send(forgetfulPort, stream.path)).status).toBe(500);
    expect(forgetful.services.ringEntries).toHaveLength(1);
  });
});
