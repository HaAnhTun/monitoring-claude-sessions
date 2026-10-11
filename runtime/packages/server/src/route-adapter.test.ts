// `registerRoute` (03 13 item 2): path, query and response validation through the route registry, the error mapper, the 204
// and the stream routes, the abort signal, and the table of mounted routes. A real Express app on a real socket.
import type { Server } from 'node:http';

import { DbError } from '@mcs/engine';
import { ErrorEnvelopeSchema, defineRoute, intString } from '@mcs/shared';
import { allocatePort, assertPortClosed, httpRequest } from '@mcs/testkit';
import express, { type Express, type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiError } from './errors.ts';
import { bindRouteServices, mountedRoutes, registerRoute, type RouteServices } from './route-adapter.ts';

interface Recorded {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

class TestServices implements RouteServices {
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

async function serve(app: Express): Promise<number> {
  const port = await allocatePort();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return port;
}

function setup(over: Partial<Pick<TestServices, 'validateResponses'>> = {}): { app: Express; services: TestServices } {
  const app = express();
  const services = new TestServices();
  if (over.validateResponses !== undefined) services.validateResponses = over.validateResponses;
  bindRouteServices(app, services);
  return { app, services };
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
    const { app } = setup();
    registerRoute(app, nothing, () => undefined);
    const port = await serve(app);
    const reply = await httpRequest(port, '/api/v3/test/nothing', { method: 'POST', body: '{}' });
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
