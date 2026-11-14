// `createApp` (03 5.1, 5.2, 13): the headers of every response, the order of the guards and of route matching (404, 405,
// OPTIONS), the table of mounted routes against the registry, the shutdown gate, the error mapper at the end of the chain,
// the access log that never carries request data, and the limits of the HTTP server. Fake instance context, real sockets.
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

import {
  DbError,
  createAccessService,
  defaultSkillDir,
  resolveConfig,
  type AuditQueries,
  type EngineQueries,
  type InstanceRuntime,
  type ResolvedConfig,
  type RuntimeProcessInfo,
} from '@mcs/engine';
import {
  ErrorEnvelopeSchema,
  RUNTIME_VERSION,
  defineRoute,
  routes,
  type ErrorCode,
  type InstanceFile,
  type RouteDefinition,
} from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest } from '@mcs/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp, createHttpServer, HTML_CSP, type AppDeps } from './app.ts';
import { createAccessVerifier, type AccessVerifier } from './http/access-guard.ts';
import { cookieName } from './http/cookie.ts';
import { mountedRoutes, registerRoute } from './route-adapter.ts';
import type { AppContext, RouteModule } from './route-adapter.ts';

/** What the routes under test call: the meta part of the query layer (03 12.1), nothing else is built. */
type MetaQueriesDouble = Pick<EngineQueries, 'instanceInfo' | 'health' | 'ingestHealth' | 'hookProbe'> & AuditQueries;

/** The one place that widens the double to the layer; a member a route would call beyond the meta part is `undefined` and fails loudly. */
function asQueries(double: MetaQueriesDouble): AppContext['queries'] {
  return double as AppContext['queries'];
}

/** The reply of the HTTP helper of the testkit (its type is not exported). */
type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const ID = '11111111-1111-4111-8111-111111111111';
const PROBE = '00000000-0000-4000-8000-0000000000a1';
const NOW = Date.UTC(2026, 9, 11, 14, 0, 12);

interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

interface Harness {
  readonly port: number;
  readonly logs: LogLine[];
  readonly ring: { source: string; code: string; where: string | null; message: string }[];
  readonly nudges: number[];
  readonly app: ReturnType<typeof createApp>;
  phase: 'starting' | 'ready' | 'stopping';
  instanceInfo: () => unknown;
}

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

const INSTANCE: InstanceFile = {
  schema_version: 1,
  instanceId: ID,
  slug: 'demo',
  createdAt: '2026-10-11T14:00:00Z',
  createdBy: `mcs ${RUNTIME_VERSION}`,
  runtimeVersion: RUNTIME_VERSION,
  dbSchemaVersion: 1,
  engine: 'node',
  hooks: { enabled: false },
  upgradedAt: null,
};

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

/** Listens on a port of the testkit (05 4.5) and registers the server for the `afterEach` above. */
async function listen(server: Server): Promise<number> {
  const port = await allocatePort();
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  servers.push({ server, port });
  return port;
}

async function start(over: Partial<AppDeps> = {}): Promise<Harness> {
  const logs: LogLine[] = [];
  const ring: Harness['ring'] = [];
  const nudges: number[] = [];
  const holder = { phase: 'ready' as Harness['phase'], instanceInfo: (): unknown => ({}) };
  const processInfo: RuntimeProcessInfo = {
    pid: 4242,
    startedAtMs: NOW - 5000,
    runtimeVersion: RUNTIME_VERSION,
    bootCodeStamp: 'abcdef0123',
    previousRunUnclean: false,
    phase: () => holder.phase,
    outdated: () => ({ outdated: false, reason: null }),
    ownershipConflict: () => false,
  };
  const log =
    (level: string) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      logs.push({ level, event, fields });
    };
  const ctx: AppContext = {
    instanceId: ID,
    slug: 'demo',
    clock: new FakeClock(NOW),
    scope: { instanceId: ID },
    // these routes never reach the database; a call on it fails loudly
    db: {} as never,
    queries: asQueries({
      instanceInfo: () => {
        // the stub of the test decides what the query layer answers
        return holder.instanceInfo() as never;
      },
      health: () => ({}) as never,
      ingestHealth: () => ({}) as never,
      hookProbe: () => null,
      sessionAuditRefs: () => Promise.resolve([]),
    }),
    errors: {
      push: (entry) => {
        ring.push({ source: entry.source, code: entry.code, where: entry.where, message: entry.message });
      },
      list: () => [],
    },
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
      close: () => Promise.resolve(),
    },
    process: processInfo,
    config,
    instance: INSTANCE,
  };
  let port = 0;
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => {
      nudges.push(1);
    },
    task: null,
    validateResponses: false,
    ...over,
  });
  port = await listen(createServer(app));
  return {
    port,
    logs,
    ring,
    nudges,
    app,
    get phase() {
      return holder.phase;
    },
    set phase(value) {
      holder.phase = value;
    },
    get instanceInfo() {
      return holder.instanceInfo;
    },
    set instanceInfo(value) {
      holder.instanceInfo = value;
    },
  };
}

function codeOf(reply: HttpReply): ErrorCode {
  return ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

describe('headers of every response (03 5.1, ADR 0045)', () => {
  it('carries the security headers on answers, refusals, 404s and 405s alike, and never a CORS header', async () => {
    const h = await start();
    const replies = [
      await httpRequest(h.port, '/api/health'),
      await httpRequest(h.port, '/api/v3/nope'),
      await httpRequest(h.port, '/api/health', { method: 'DELETE' }),
      await httpRequest(h.port, '/api/health', { host: 'evil.example' }),
      await httpRequest(h.port, '/api/health', { origin: 'http://evil.example' }),
      await httpRequest(h.port, `/api/v3/ingest/probes/${PROBE}`),
      await httpRequest(h.port, '/api/v3/ingest/probes/x'),
      await httpRequest(h.port, '/elsewhere'),
    ];
    for (const reply of replies) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(reply.headers[name], name).toBe(value);
      expect(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
      expect(reply.headers['x-powered-by']).toBeUndefined();
      expect(reply.headers['etag']).toBeUndefined();
    }
  });

  it('sets no-store on /api/* answers and refusals, and the instance stamp on every answer', async () => {
    const h = await start();
    for (const path of ['/api/health', '/api/v3/nope', '/api/v3/ingest/probes/x', `/api/v3/ingest/probes/${PROBE}`]) {
      const reply = await httpRequest(h.port, path);
      expect(reply.headers['cache-control'], path).toBe('no-store');
      expect(reply.headers['x-request-id'], path).toMatch(/^r-[0-9a-z]{12}$/);
    }
    const ok = await httpRequest(h.port, '/api/health');
    expect(ok.headers['x-mcs-instance']).toBe(ID);
    expect(ok.headers['x-mcs-runtime']).toBe(`${RUNTIME_VERSION}+abcdef0123`);
  });
});

describe('guards run before routes (03 5.2 steps 1-4)', () => {
  it('refuses a bad Host, a bad Origin, and a long URL for every path, known or not', async () => {
    const h = await start();
    for (const path of ['/api/health', '/api/v3/nope', '/anything']) {
      expect(codeOf(await httpRequest(h.port, path, { host: 'evil.example' })), path).toBe('host_not_allowed');
      expect(codeOf(await httpRequest(h.port, path, { origin: 'null' })), path).toBe('origin_not_allowed');
    }
    expect(codeOf(await httpRequest(h.port, `/api/health?${'a'.repeat(9000)}`))).toBe('uri_too_long');
    const uppercase = await httpRequest(h.port, '/api/health', { host: `LOCALHOST:${String(h.port)}` });
    expect(uppercase.status).toBe(200);
  });

  it('accepts both loopback names with their port and the matching Origins', async () => {
    const h = await start();
    for (const host of [`127.0.0.1:${String(h.port)}`, `localhost:${String(h.port)}`]) {
      expect((await httpRequest(h.port, '/api/health', { host })).status).toBe(200);
      expect((await httpRequest(h.port, '/api/health', { host, origin: `http://${host}` })).status).toBe(200);
    }
  });
});

describe('route matching (03 5.2 step 5)', () => {
  it('answers 404 route_not_found for an unknown path, a legacy path of the old server, and any method', async () => {
    const h = await start();
    for (const path of ['/api/v3/nope', '/api/sessions', '/api/v3', '/api/']) {
      for (const method of ['GET', 'POST']) {
        const reply = await httpRequest(h.port, path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' ? '{}' : '',
        });
        expect(reply.status, `${method} ${path}`).toBe(404);
        expect(codeOf(reply), `${method} ${path}`).toBe('route_not_found');
      }
    }
  });

  it('answers 405 method_not_allowed with Allow for a known path with another method', async () => {
    const h = await start();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const reply = await httpRequest(h.port, '/api/health', { method });
      expect(reply.status, method).toBe(405);
      expect(reply.headers['allow'], method).toBe('GET, HEAD');
      expect(codeOf(reply), method).toBe('method_not_allowed');
    }
    const nudge = await httpRequest(h.port, '/api/v3/ingest/nudge');
    expect(nudge.status).toBe(405);
    expect(nudge.headers['allow']).toBe('POST');
  });

  it('answers OPTIONS with 405 and no CORS headers, for known and unknown paths', async () => {
    const h = await start();
    for (const path of ['/api/health', '/api/v3/ingest/nudge', '/api/v3/nope', '/']) {
      const reply = await httpRequest(h.port, path, {
        method: 'OPTIONS',
        origin: `http://127.0.0.1:${String(h.port)}`,
        headers: { 'Access-Control-Request-Method': 'GET' },
      });
      expect(reply.status, path).toBe(405);
      expect(codeOf(reply), path).toBe('method_not_allowed');
      expect(
        Object.keys(reply.headers).filter((name) => name.startsWith('access-control-')),
        path,
      ).toEqual([]);
    }
  });

  it('mounts the routes of this package, only routes of the registry, with the registry method and path, and 404s the rest of the registry', async () => {
    const h = await start();
    const registry = new Map<string, RouteDefinition>(Object.values(routes).map((route) => [route.id, route]));
    const mounted = mountedRoutes(h.app);
    // monotone: a later work package mounts more registry routes in its own block of app.ts, and this test stays valid
    const mountedIds = new Set(mounted.map((route) => route.id));
    for (const id of ['config', 'health', 'healthIngest', 'ingestNudge', 'ingestProbe', 'instance', 'legacyHealth']) {
      expect(mountedIds.has(id), id).toBe(true);
    }
    for (const route of mounted) {
      const known = registry.get(route.id);
      expect(known?.method, route.id).toBe(route.method);
      expect(known?.path, route.id).toBe(route.path);
      // Express knows the pair: another method answers 405 with the method of the route in Allow
      const concrete = route.path.replace(/:\w+/g, 'x');
      const reply = await httpRequest(h.port, concrete, { method: 'PUT' });
      expect(reply.status, route.id).toBe(405);
      expect(reply.headers['allow'], route.id).toContain(route.method);
    }
    for (const route of registry.values()) {
      if (mountedIds.has(route.id) || route.method !== 'GET') continue;
      const concrete = route.path.replace(/:\w+/g, 'x');
      const reply = await httpRequest(h.port, concrete);
      expect(reply.status, `${route.id} is not mounted yet`).toBe(404);
      expect(codeOf(reply), route.id).toBe('route_not_found');
    }
  });
});

/** A runtime that no route of these tests calls: every member that is a function says so when it is called. */
function unusedRuntime(): InstanceRuntime {
  const unused = (): never => {
    throw new Error('the runtime is not used by this test');
  };
  return {
    start: unused,
    stop: unused,
    ingestUntilIdle: unused,
    ingestReplay: unused,
    nudge: unused,
    health: unused,
    panels: { get: unused, tickAttempts: unused, stats: unused, close: unused },
  };
}

describe('route modules receive the instance runtime (01 4.4 step 8, 4.4a)', () => {
  it('hands the same runtime to every module, built in or added, and nothing when the app has none', async () => {
    const seen: (InstanceRuntime | undefined)[] = [];
    const probe: RouteModule = (_app, deps) => {
      seen.push(deps.runtime);
    };
    const runtime = unusedRuntime();
    await start({ runtime, extraModules: [probe, probe] });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(runtime);
    expect(seen[1]).toBe(runtime);
    await start({ extraModules: [probe] });
    expect(seen).toHaveLength(3);
    expect(seen[2]).toBeUndefined();
  });
});

describe('shutdown gate (registry 7.1 shutting_down)', () => {
  it('answers 503 shutting_down for data routes while the phase is stopping, and still answers the health routes', async () => {
    const h = await start();
    h.phase = 'stopping';
    const refused = await httpRequest(h.port, '/api/v3/instance');
    expect(refused.status).toBe(503);
    expect(codeOf(refused)).toBe('shutting_down');
    expect((await httpRequest(h.port, '/api/health')).status).toBe(200);
    expect((await httpRequest(h.port, '/api/v3/health')).status).toBe(200);
    h.phase = 'ready';
    h.instanceInfo = () => ({});
    expect((await httpRequest(h.port, '/api/v3/instance')).status).toBe(200);
  });
});

describe('the error mapper at the end of the chain (03 5.2 step 9)', () => {
  it('answers 500 internal_error for an unexpected failure with a fixed message, one ring entry and one log line', async () => {
    const h = await start();
    h.instanceInfo = () => {
      throw new Error('C:/private/path with a secret prompt');
    };
    const reply = await httpRequest(h.port, '/api/v3/instance');
    expect(reply.status).toBe(500);
    expect(codeOf(reply)).toBe('internal_error');
    expect(reply.body).not.toContain('secret');
    expect(h.ring).toEqual([
      { source: 'server', code: 'INTERNAL', where: 'instance', message: 'unexpected error in the route handler' },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
    expect(JSON.stringify(h.logs)).not.toContain('private');
  });

  it('maps a busy or full database to 503 with Retry-After', async () => {
    const h = await start();
    h.instanceInfo = () => {
      throw new DbError('db_busy', 'busy');
    };
    const busy = await httpRequest(h.port, '/api/v3/instance');
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    h.instanceInfo = () => {
      throw new DbError('db_full', 'full');
    };
    expect(codeOf(await httpRequest(h.port, '/api/v3/instance'))).toBe('disk_full');
    expect(h.ring).toEqual([]);
  });

  it('treats prototype-looking query keys as unknown keys, and a hostile method on a known path as 405', async () => {
    const h = await start();
    for (const query of ['__proto__=x', 'constructor=x', 'constructor[prototype][polluted]=1', 'toString=1']) {
      const reply = await httpRequest(h.port, `/api/health?${query}`);
      expect(reply.status, query).toBe(400);
      expect(codeOf(reply), query).toBe('validation_failed');
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    const trace = await httpRequest(h.port, '/api/health', { method: 'TRACE' });
    expect([404, 405]).toContain(trace.status);
  });

  it('answers 400 validation_failed for a malformed percent escape in a path parameter', async () => {
    const h = await start();
    const reply = await httpRequest(h.port, '/api/v3/ingest/probes/%E0%A4%A');
    expect(reply.status).toBe(400);
    expect(codeOf(reply)).toBe('validation_failed');
    expect(h.ring).toEqual([]);
  });
});

describe('the access log (DA-T-PRIV-4)', () => {
  it('records route id, method, status, duration and request id, and never a query string, a path value or a body', async () => {
    const h = await start();
    const replies = [
      await httpRequest(h.port, `/api/v3/ingest/probes/${PROBE}?q=SECRET-QUERY`),
      await httpRequest(h.port, '/api/v3/ingest/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"instanceId":"SECRET-BODY"}',
      }),
      await httpRequest(h.port, '/api/v3/not-a-route/SECRET-PATH'),
    ];
    const lines = h.logs.filter((line) => line.event === 'http_request');
    expect(lines.length).toBe(3);
    expect(lines.map((line) => line.fields?.['route'])).toEqual(['ingestProbe', 'ingestNudge', 'unmatched']);
    expect(lines.map((line) => line.fields?.['status'])).toEqual([400, 400, 404]);
    for (const line of lines) {
      expect(Object.keys(line.fields ?? {}).sort()).toEqual(['durationMs', 'method', 'requestId', 'route', 'status']);
      expect(typeof line.fields?.['durationMs']).toBe('number');
    }
    // the request id of the line is the one of the X-Request-Id header of the response (CR-WP-17-9), one per request
    const ids = lines.map((line) => line.fields?.['requestId']);
    expect(ids).toEqual(replies.map((reply) => reply.headers['x-request-id']));
    for (const id of ids) expect(id).toMatch(/^r-[0-9a-z]{12}$/);
    expect(new Set(ids).size).toBe(3);
    const text = JSON.stringify(h.logs);
    for (const secret of ['SECRET-QUERY', 'SECRET-BODY', 'SECRET-PATH', PROBE]) expect(text).not.toContain(secret);
  });

  it('logs successes at debug, client errors at info and server errors at error', async () => {
    const h = await start();
    await httpRequest(h.port, '/api/health');
    await httpRequest(h.port, '/api/v3/nope');
    h.instanceInfo = () => {
      throw new Error('boom');
    };
    await httpRequest(h.port, '/api/v3/instance');
    const levels = h.logs
      .filter((line) => line.event === 'http_request')
      .map((line) => [line.fields?.['status'], line.level]);
    expect(levels).toEqual([
      [200, 'debug'],
      [404, 'info'],
      [500, 'error'],
    ]);
  });
});

const CRLF = String.fromCharCode(13, 10);

/** Opens a connection, sends `wire` (an incomplete request) and waits for the server to give up on it. */
function untilServerCloses(
  port: number,
  wire: string,
): Promise<{ readonly elapsedMs: number; readonly reply: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const chunks: Buffer[] = [];
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      resolve({ elapsedMs: performance.now() - startedAt, reply: Buffer.concat(chunks).toString('latin1') });
    });
    socket.write(wire);
  });
}

describe('createHttpServer (05 5.3 S-NET-6, ADR 0045)', () => {
  it('creates a server with the limits of the ADR that is not listening yet', () => {
    const server = createHttpServer(() => undefined, 45_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(45_000);
    expect(server.keepAliveTimeout).toBe(5000);
    expect(server.maxHeadersCount).toBe(64);
    expect(server.maxConnections).toBe(128);
    expect(server.listening).toBe(false);
  });

  it('keeps the headers timeout inside the request timeout (Node refuses a server where it is longer)', () => {
    const server = createHttpServer(() => undefined, 1000);
    expect(server.requestTimeout).toBe(1000);
    expect(server.headersTimeout).toBe(1000);
  });

  it('answers 408 to a connection that stops in the middle of the headers within about a second of the limit, not after 30 s', async () => {
    // Node looks at the two timeouts only every `connectionsCheckingInterval`, an option of the constructor (default 30 s)
    const port = await listen(createHttpServer(() => undefined, 30_000, { headersTimeoutMs: 300 }));
    const outcome = await untilServerCloses(
      port,
      `GET /api/health HTTP/1.1${CRLF}Host: 127.0.0.1:${String(port)}${CRLF}`,
    );
    expect(outcome.reply.startsWith('HTTP/1.1 408')).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(outcome.elapsedMs).toBeLessThan(4000);
  });

  it('answers 408 to a request whose body never arrives, after the request timeout and one check interval at most', async () => {
    const port = await listen(createHttpServer(() => undefined, 1000));
    const head =
      `POST /api/v3/ingest/nudge HTTP/1.1${CRLF}Host: 127.0.0.1:${String(port)}${CRLF}` +
      `Content-Type: application/json${CRLF}Content-Length: 40${CRLF}${CRLF}`;
    const outcome = await untilServerCloses(port, head);
    expect(outcome.reply.startsWith('HTTP/1.1 408')).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(outcome.elapsedMs).toBeLessThan(4000);
  });
});

describe('HTML_CSP (04 12.2, ADR 0039)', () => {
  it('is the policy of the design, character for character', () => {
    expect(HTML_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  });
});

// ---- who may call a route: AppDeps.access (CAW-18, design 02 3, ADR 0084) ------------------------------------------------------------

const sessionRead = defineRoute({
  id: 'testSessionRead',
  method: 'GET',
  path: '/api/v3/test/session-read',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Test route behind the session cookie.',
  contentType: 'application/json',
  access: 'session',
});

const readerRead = defineRoute({
  id: 'testReaderRead',
  method: 'GET',
  path: '/api/v3/test/reader-read',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Test route behind the session cookie or the control token.',
  contentType: 'application/json',
  access: 'reader',
});

const sessionWrite = defineRoute({
  id: 'testSessionWrite',
  method: 'POST',
  path: '/api/v3/test/session-write',
  params: null,
  query: null,
  body: z.strictObject({}),
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Test write route behind the session cookie.',
  contentType: 'application/json',
  access: 'session',
});

/** The routes of the three kinds, mounted the way a route module mounts them. */
const accessModule: RouteModule = (app) => {
  registerRoute(app, sessionRead, () => ({ ok: true }));
  registerRoute(app, readerRead, () => ({ ok: true }));
  registerRoute(app, sessionWrite, () => ({ ok: true }));
};

// FIXTURE: invented data for tests
const CONTROL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function userInstanceAccess(): { verifier: AccessVerifier; signIn: () => string } {
  const service = createAccessService({ clock: new FakeClock(NOW), controlToken: CONTROL_TOKEN });
  return {
    verifier: createAccessVerifier(service, ID),
    signIn: () => {
      const outcome = service.exchange(service.mint().code);
      if (!outcome.ok) throw new Error('sign-in failed');
      return `${cookieName(ID)}=${outcome.credential}`;
    },
  };
}

describe('AppDeps.access: the access service of a user instance', () => {
  it('guards the routes of every kind once a verifier is given, behind the guards of the app', async () => {
    const { verifier, signIn } = userInstanceAccess();
    const h = await start({ access: verifier, extraModules: [accessModule] });
    const cookie = signIn();
    const origin = `http://127.0.0.1:${String(h.port)}`;
    const json = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };

    expect(codeOf(await httpRequest(h.port, sessionRead.path))).toBe('access_required');
    expect((await httpRequest(h.port, sessionRead.path, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(codeOf(await httpRequest(h.port, readerRead.path))).toBe('access_required');
    expect((await httpRequest(h.port, readerRead.path, { headers: { Cookie: cookie } })).status).toBe(200);
    const bearer = { Authorization: `Bearer ${CONTROL_TOKEN}` };
    expect((await httpRequest(h.port, readerRead.path, { headers: bearer })).status).toBe(200);
    expect(codeOf(await httpRequest(h.port, sessionRead.path, { headers: bearer }))).toBe('access_required');

    const write = (headers: Record<string, string>, extra: { origin?: string } = {}) =>
      httpRequest(h.port, sessionWrite.path, { method: 'POST', body: '{}', headers, ...extra });
    expect(codeOf(await write({ Cookie: cookie }, { origin }))).toBe('csrf_rejected');
    expect(codeOf(await write({ ...json, Cookie: cookie }))).toBe('origin_not_allowed');
    expect(codeOf(await write({ ...json }, { origin }))).toBe('access_required');
    expect(codeOf(await write({ ...json, ...bearer }, { origin }))).toBe('access_required');
    expect((await write({ ...json, Cookie: cookie }, { origin })).status).toBe(200);
  });

  it('keeps the global guards in front: a foreign Host never reaches the access check', async () => {
    const { verifier, signIn } = userInstanceAccess();
    const h = await start({ access: verifier, extraModules: [accessModule] });
    const reply = await httpRequest(h.port, sessionRead.path, { host: 'evil.invalid', headers: { Cookie: signIn() } });
    expect(codeOf(reply)).toBe('host_not_allowed');
  });

  it('refuses to start an app that mounts a session route without an access service (fail closed)', async () => {
    await expect(start({ extraModules: [accessModule] })).rejects.toThrow(/testSessionRead/);
    await expect(start({ access: null, extraModules: [accessModule] })).rejects.toThrow(/testSessionRead/);
  });

  it('serves a reader route open on an app with no access service, as a task instance does', async () => {
    const reader: RouteModule = (app) => {
      registerRoute(app, readerRead, () => ({ ok: true }));
    };
    const h = await start({ extraModules: [reader] });
    expect((await httpRequest(h.port, readerRead.path)).status).toBe(200);
  });

  it('leaves the routes of the registry that are open as they were: no credential, no change', async () => {
    const { verifier } = userInstanceAccess();
    const h = await start({ access: verifier });
    expect((await httpRequest(h.port, routes.health.path)).status).toBe(200);
  });
});
