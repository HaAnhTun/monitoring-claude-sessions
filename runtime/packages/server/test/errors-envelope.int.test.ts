// The error envelope and the guards on a real instance (03 19.3): DA-T-API-3 (one crafted request per ErrorCode, and the
// meta-test that every code is listed by a route definition and produced), DA-T-API-4 (the Host, Origin, fetch-metadata and
// URL matrix). A real workspace, a real database, the real guards and error mapper and a real HTTP server.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';

import {
  buildInstanceContext,
  createAccessService,
  defaultSkillDir,
  DbError,
  initWorkspace,
  type InstanceContext,
  type Logger,
} from '@mcs/engine';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  RESERVED_ERROR_CODES,
  RUNTIME_VERSION,
  defineRoute,
  routeErrors,
  routes,
  type ErrorCode,
} from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp, createHttpServer } from '../src/app.ts';
import { ApiError, ERROR_MESSAGES } from '../src/errors.ts';
import { createAccessVerifier } from '../src/http/access-guard.ts';
import { registerRoute, type RouteModule } from '../src/route-adapter.ts';
import { createAuthRoutes } from '../src/routes/auth.ts';
import { readLegacyTask } from '../src/routes/meta.ts';
import { createTerminalRoutes } from '../src/routes/terminal.ts';
import { mintAndExchange, pageOrigin, writeHeaders } from './terminal/helpers/auth.ts';
import { FakeTerminalError, FakeTerminalPorts } from './terminal/helpers/fake-terminal.ts';

/** The reply of the HTTP helper of the testkit (its type is not exported). */
type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';

// ---- test-only routes: they raise a catalogue code or a failure on request, so that every code can be crafted -----------------

const failRoute = defineRoute({
  id: 'testFail',
  method: 'GET',
  path: '/api/v3/test/fail/:code',
  params: z.strictObject({ code: ErrorCodeSchema }),
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Raises the error code of the path (tests only).',
  contentType: 'application/json',
});

const dbRoute = defineRoute({
  id: 'testDb',
  method: 'GET',
  path: '/api/v3/test/db/:kind',
  params: z.strictObject({ kind: z.enum(['db_busy', 'db_full', 'db_corrupt']) }),
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Raises a database error (tests only).',
  contentType: 'application/json',
});

const boomRoute = defineRoute({
  id: 'testBoom',
  method: 'GET',
  path: '/api/v3/test/boom',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Fails with an unexpected error (tests only).',
  contentType: 'application/json',
});

const badRoute = defineRoute({
  id: 'testBad',
  method: 'GET',
  path: '/api/v3/test/bad',
  params: null,
  query: null,
  body: null,
  response: z.strictObject({ ok: z.literal(true) }),
  successStatus: 200,
  errors: [],
  summary: 'Answers with a body that does not match its schema (tests only).',
  contentType: 'application/json',
});

function untyped(value: unknown): never {
  return value as never;
}

const testRoutes: RouteModule = (app) => {
  registerRoute(app, failRoute, ({ params }) => {
    throw new ApiError(params.code);
  });
  registerRoute(app, dbRoute, ({ params }) => {
    throw new DbError(params.kind, 'database failure with a SECRET-DETAIL');
  });
  registerRoute(app, boomRoute, () => {
    throw new Error('unexpected failure with a SECRET-DETAIL');
  });
  registerRoute(app, badRoute, () => untyped({ ok: 'SECRET-DETAIL' }));
};

// ---- the instance -------------------------------------------------------------------------------------------------------------

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  phase: 'starting' | 'ready' | 'stopping';
  /** The access service and the terminal host of an instance started with `terminal: true`. */
  readonly access: ReturnType<typeof createAccessService> | undefined;
  readonly ports: FakeTerminalPorts | undefined;
}

const live: { server: Server; ctx: InstanceContext; port: number }[] = [];
afterEach(async () => {
  for (const { server, ctx, port } of live.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await assertPortClosed(port);
  }
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/**
 * A task-like instance, or with `terminal: true` a user-like one: the real access service and verifier, the auth routes and the
 * terminal routes over a fake host, so that the guards and the routes of the access and terminal work produce their own codes.
 */
async function startInstance(options: { readonly terminal?: boolean } = {}): Promise<Running> {
  const root = makeTemp('errors-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const run: { phase: Running['phase'] } = { phase: 'ready' };
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
    processInfo: { phase: () => run.phase },
  });
  const port = await allocatePort();
  const access = options.terminal === true ? createAccessService({ clock }) : undefined;
  const ports = options.terminal === true ? new FakeTerminalPorts() : undefined;
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    ...(access === undefined ? {} : { access: createAccessVerifier(access, ctx.instanceId) }),
    extraModules: [
      testRoutes,
      ...(access === undefined
        ? []
        : [
            createAuthRoutes({ access, instanceId: ctx.instanceId }),
            createTerminalRoutes({ ports: ports ?? null, epoch: ctx.db.epoch, now: () => ctx.clock.now() }),
          ]),
    ],
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return {
    ctx,
    port,
    access,
    ports,
    get phase() {
      return run.phase;
    },
    set phase(value) {
      run.phase = value;
    },
  };
}

function envelopeOf(reply: HttpReply): z.infer<typeof ErrorEnvelopeSchema>['error'] {
  return ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error;
}

/** The raw bytes of a request on a fresh socket: for what the HTTP client of the testkit would not send (two Host headers). */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.once('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
  });
}

// ---- DA-T-API-3 ---------------------------------------------------------------------------------------------------------------

/** What each crafted request must answer. */
const GUARD_AND_ROUTER_CODES: readonly ErrorCode[] = [
  'host_not_allowed',
  'origin_not_allowed',
  'cross_site_request',
  'uri_too_long',
  'route_not_found',
  'method_not_allowed',
  'validation_failed',
  'param_repeated',
  'body_invalid_json',
  'instance_mismatch',
  'payload_too_large',
  'unsupported_media_type',
  'probe_not_found',
  'internal_error',
  'db_busy',
  'disk_full',
  'shutting_down',
  // the access and terminal chain (CAW-20): the guards and the routes of a user instance, crafted in their own test below
  'access_required',
  'csrf_rejected',
  'access_code_invalid',
  'access_rate_limited',
  'terminal_unavailable',
  'claude_not_found',
  'folder_invalid',
  'terminal_not_found',
  'terminal_limit',
  'picker_busy',
  'resume_unavailable',
];

/** The codes `produces the codes of the access and terminal chain` crafts through a user instance. */
const CHAIN_CODES: readonly ErrorCode[] = [
  'access_required',
  'csrf_rejected',
  'access_code_invalid',
  'access_rate_limited',
  'terminal_unavailable',
  'claude_not_found',
  'folder_invalid',
  'terminal_not_found',
  'terminal_limit',
  'picker_busy',
  'resume_unavailable',
];

describe('DA-T-API-3: one crafted request per error code', () => {
  const produced = new Set<ErrorCode>();

  function check(reply: HttpReply, code: ErrorCode, label: string): void {
    expect(reply.status, label).toBe(ERROR_HTTP_STATUS[code]);
    const error = envelopeOf(reply);
    expect(error.code, label).toBe(code);
    expect(error.message, label).toBe(ERROR_MESSAGES[code]);
    expect(error.requestId, label).toBe(reply.headers['x-request-id']);
    expect(reply.headers['content-type'], label).toBe('application/json; charset=utf-8');
    expect(reply.headers['cache-control'], label).toBe('no-store');
    expect(reply.body, label).not.toContain('SECRET');
    produced.add(code);
  }

  it('produces every code of the guards, the router, the parsers and the mapper through the real chain', async () => {
    const run = await startInstance();
    const p = run.port;
    const json = { 'Content-Type': 'application/json' };
    const nudge = '/api/v3/ingest/nudge';
    const validBody = JSON.stringify({ instanceId: ID });
    check(await httpRequest(p, '/api/v3/health', { host: 'evil.example' }), 'host_not_allowed', 'host');
    check(await httpRequest(p, '/api/v3/health', { origin: 'http://evil.example' }), 'origin_not_allowed', 'origin');
    check(
      await httpRequest(p, '/api/v3/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      'cross_site_request',
      'site',
    );
    check(await httpRequest(p, `/api/v3/health?${'a'.repeat(9000)}`), 'uri_too_long', 'uri');
    check(await httpRequest(p, '/api/v3/nope'), 'route_not_found', 'route');
    check(await httpRequest(p, '/api/v3/health', { method: 'DELETE' }), 'method_not_allowed', 'method');
    check(await httpRequest(p, '/api/v3/health?x=1'), 'validation_failed', 'query');
    check(await httpRequest(p, '/api/v3/health?x=1&x=2'), 'param_repeated', 'repeated');
    check(await httpRequest(p, nudge, { method: 'POST', headers: json, body: '{ nope' }), 'body_invalid_json', 'json');
    check(await httpRequest(p, nudge, { method: 'POST', headers: json, body: '{}' }), 'validation_failed', 'shape');
    check(
      await httpRequest(p, nudge, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ instanceId: '22222222-2222-4222-8222-222222222222' }),
      }),
      'instance_mismatch',
      'mismatch',
    );
    check(
      await httpRequest(p, nudge, { method: 'POST', headers: json, body: `${validBody}${' '.repeat(300)}` }),
      'payload_too_large',
      'size',
    );
    check(
      await httpRequest(p, nudge, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: validBody }),
      'unsupported_media_type',
      'type',
    );
    check(
      await httpRequest(p, '/api/v3/ingest/probes/00000000-0000-4000-8000-0000000000a1'),
      'probe_not_found',
      'probe',
    );
    check(await httpRequest(p, '/api/v3/test/boom'), 'internal_error', 'boom');
    check(await httpRequest(p, '/api/v3/test/bad'), 'internal_error', 'bad response');
    check(await httpRequest(p, '/api/v3/test/db/db_corrupt'), 'internal_error', 'db corrupt');
    check(await httpRequest(p, '/api/v3/test/db/db_busy'), 'db_busy', 'db busy');
    check(await httpRequest(p, '/api/v3/test/db/db_full'), 'disk_full', 'db full');
    run.phase = 'stopping';
    check(await httpRequest(p, '/api/v3/instance'), 'shutting_down', 'stopping');
    run.phase = 'ready';
    // the codes of the access and terminal chain are crafted by the test below, through a user instance
    expect([...produced].sort()).toEqual(GUARD_AND_ROUTER_CODES.filter((code) => !CHAIN_CODES.includes(code)).sort());
  });

  it('produces the codes of the access and terminal chain through the real guards and routes of a user instance', async () => {
    const run = await startInstance({ terminal: true });
    const { access, ports } = run;
    if (access === undefined || ports === undefined) throw new Error('the user instance was not started');
    const p = run.port;
    const cookie = await mintAndExchange(p, access);
    const write = (path: string, body: unknown, withCookie = true): Promise<HttpReply> =>
      httpRequest(p, path, {
        method: 'POST',
        headers: writeHeaders(withCookie ? cookie : undefined),
        origin: pageOrigin(p),
        body: JSON.stringify(body),
      });
    const sessionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const folder = { path: 'C:\\work\\demo' };
    const createWith = (thrown: string): Promise<HttpReply> => {
      ports.sessions.createFailure = new FakeTerminalError(thrown);
      return write(routes.terminalCreateSession.path, folder);
    };
    const crafted: [ErrorCode, HttpReply][] = [];
    crafted.push(['access_required', await httpRequest(p, routes.terminalState.path)]);
    crafted.push([
      'csrf_rejected',
      await httpRequest(p, routes.terminalPickFolder.path, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: cookie },
        origin: pageOrigin(p),
        body: '{}',
      }),
    ]);
    crafted.push(['terminal_unavailable', await createWith('UNSUPPORTED_OS')]);
    crafted.push(['claude_not_found', await createWith('CLAUDE_NOT_FOUND')]);
    crafted.push(['folder_invalid', await createWith('FOLDER_INVALID')]);
    crafted.push(['terminal_limit', await createWith('SESSION_LIMIT')]);
    crafted.push(['terminal_not_found', await write(routes.terminalKillSession.path.replace(':name', 'ghost-1'), {})]);
    ports.resumeFailure = new FakeTerminalError('resume_unavailable');
    crafted.push(['resume_unavailable', await write(routes.terminalResume.path, { sessionId })]);
    ports.fakePicker.failure = new FakeTerminalError('picker_busy');
    crafted.push(['picker_busy', await write(routes.terminalPickFolder.path, {})]);
    // the access limiter: a wrong code is 401, the ninth wrong one in a window is 429
    const wrongCode = (n: number): string => Buffer.alloc(32, n + 1).toString('base64url');
    crafted.push(['access_code_invalid', await write(routes.authExchange.path, { code: wrongCode(0) }, false)]);
    for (let i = 1; i < 8; i += 1) await write(routes.authExchange.path, { code: wrongCode(i) }, false);
    crafted.push(['access_rate_limited', await write(routes.authExchange.path, { code: wrongCode(9) }, false)]);
    for (const [code, reply] of crafted) {
      expect(reply.status, code).toBe(ERROR_HTTP_STATUS[code]);
      const error = envelopeOf(reply);
      expect(error.code, code).toBe(code);
      expect(error.message, code).toBe(ERROR_MESSAGES[code]);
      expect(error.requestId, code).toBe(reply.headers['x-request-id']);
      expect(reply.headers['cache-control'], code).toBe('no-store');
      expect(reply.body, code).not.toContain('SECRET');
    }
    expect(crafted.map(([code]) => code).sort()).toEqual([...CHAIN_CODES].sort());
    // every code of the chain belongs to the group this suite says it produces through the real chain
    for (const code of CHAIN_CODES) expect(GUARD_AND_ROUTER_CODES, code).toContain(code);
  });

  it('records the unexpected failures in the server error ring with the route id and no request data', async () => {
    const run = await startInstance();
    await httpRequest(run.port, '/api/v3/test/boom');
    await httpRequest(run.port, '/api/v3/test/bad');
    await httpRequest(run.port, '/api/v3/test/db/db_corrupt');
    await httpRequest(run.port, '/api/v3/test/db/db_busy');
    const entries = run.ctx.errors.list();
    expect(entries.map((e) => [e.source, e.code, e.where]).sort()).toEqual(
      [
        ['server', 'INTERNAL', 'testBoom'],
        ['server', 'INTERNAL', 'testBad'],
        ['server', 'INTERNAL', 'testDb'],
      ].sort(),
    );
    expect(JSON.stringify(entries)).not.toContain('SECRET');
  });

  it('adds Retry-After to the busy codes and the Allow header to a 405', async () => {
    const run = await startInstance();
    expect((await httpRequest(run.port, '/api/v3/test/db/db_busy')).headers['retry-after']).toBe('1');
    expect((await httpRequest(run.port, '/api/v3/test/fail/search_busy')).headers['retry-after']).toBe('2');
    expect((await httpRequest(run.port, '/api/v3/test/fail/export_busy')).headers['retry-after']).toBe('2');
    expect((await httpRequest(run.port, '/api/v3/health', { method: 'PUT' })).headers['allow']).toBe('GET, HEAD');
  });

  it('produces the codes that no route raises today through the mapper, with the status of the catalogue', async () => {
    const run = await startInstance();
    const reserved = new Set<ErrorCode>(RESERVED_ERROR_CODES);
    const mapperCodes = ERROR_CODES.filter((code) => !GUARD_AND_ROUTER_CODES.includes(code) && !reserved.has(code));
    expect(mapperCodes.length).toBeGreaterThan(10);
    for (const code of mapperCodes) {
      const reply = await httpRequest(run.port, `/api/v3/test/fail/${code}`);
      expect(reply.status, code).toBe(ERROR_HTTP_STATUS[code]);
      expect(envelopeOf(reply).code, code).toBe(code);
      expect(envelopeOf(reply).message, code).toBe(ERROR_MESSAGES[code]);
      expect(envelopeOf(reply).requestId, code).toBe(reply.headers['x-request-id']);
    }
  });

  it('meta-test: every code except the reserved one is listed by a route definition and produced by a request', async () => {
    const run = await startInstance();
    // the codes of the guard and router group were produced above (their own test); the others are produced here
    const reserved = new Set<ErrorCode>(RESERVED_ERROR_CODES);
    expect([...reserved]).toEqual(['alert_not_found']);
    const listed = new Set<ErrorCode>(Object.values(routes).flatMap((route) => routeErrors(route)));
    // `completion_target_not_found` is listed by the `explainCompletion` row, which WP-29 adds to the registry; until then it
    // is the one code without a route definition, and this exemption disappears by itself when the row exists
    const staged = new Set<ErrorCode>('explainCompletion' in routes ? [] : (['completion_target_not_found'] as const));
    for (const code of ERROR_CODES) {
      if (reserved.has(code) || staged.has(code)) continue;
      expect(listed.has(code), `${code} is listed by a route definition`).toBe(true);
    }
    const crafted = new Set<ErrorCode>();
    for (const code of ERROR_CODES) {
      if (reserved.has(code)) continue;
      const reply = await httpRequest(run.port, `/api/v3/test/fail/${code}`);
      if (envelopeOf(reply).code === code) crafted.add(code);
    }
    expect([...crafted].sort()).toEqual(ERROR_CODES.filter((code) => !reserved.has(code)).sort());
  });
});

// ---- DA-T-API-4 ---------------------------------------------------------------------------------------------------------------

describe('DA-T-API-4: Host, Origin, fetch metadata and URL', () => {
  it('answers 200 only for the two loopback hosts with the bound port', async () => {
    const run = await startInstance();
    const p = run.port;
    for (const host of [`localhost:${String(p)}`, `127.0.0.1:${String(p)}`, `LOCALHOST:${String(p)}`]) {
      expect((await httpRequest(p, '/api/v3/health', { host })).status, host).toBe(200);
    }
    for (const host of [
      'evil.example',
      '127.0.0.1.evil.com',
      '0.0.0.0',
      `0.0.0.0:${String(p)}`,
      `[::1]:${String(p)}`,
      `127.0.0.1:${String(p === 65535 ? p - 1 : p + 1)}`,
      '127.0.0.1',
      `localhost.:${String(p)}`,
      `evil.example:${String(p)}`,
      `127.0.0.1:${String(p)}.evil.com`,
    ]) {
      const reply = await httpRequest(p, '/api/v3/health', { host });
      expect(reply.status, `Host: "${host}"`).toBe(403);
      expect(envelopeOf(reply).code, `Host: "${host}"`).toBe('host_not_allowed');
      expect(reply.headers['x-mcs-instance'], `Host: "${host}"`).toBeUndefined();
    }
  });

  it('refuses two Host headers, an empty one and a missing one (the HTTP client of Node fills an empty Host in: raw sockets)', async () => {
    const run = await startInstance();
    const doubled = await rawRequest(
      run.port,
      `GET /api/v3/health HTTP/1.1\r\nHost: 127.0.0.1:${String(run.port)}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    );
    expect(doubled.startsWith('HTTP/1.1 4')).toBe(true);
    expect(doubled).not.toContain('"instanceId"');
    const empty = await rawRequest(run.port, 'GET /api/v3/health HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
    expect(empty).toContain('403');
    expect(empty).toContain('host_not_allowed');
    const missing = await rawRequest(run.port, 'GET /api/v3/health HTTP/1.0\r\nConnection: close\r\n\r\n');
    expect(missing).toContain('403');
    expect(missing).toContain('host_not_allowed');
  });

  it('accepts exactly the two origins of the loopback names and refuses every other Origin', async () => {
    const run = await startInstance();
    const p = run.port;
    for (const origin of [`http://127.0.0.1:${String(p)}`, `http://localhost:${String(p)}`]) {
      expect((await httpRequest(p, '/api/v3/health', { origin })).status, origin).toBe(200);
    }
    for (const origin of [
      'http://evil.example',
      'null',
      '',
      'http://localhost:5173', // a Vite dev origin: the dev proxy rewrites it, the allow-list has no such entry (I-31)
      `http://127.0.0.1:${String(p + 1)}`,
      `https://127.0.0.1:${String(p)}`,
      `HTTP://127.0.0.1:${String(p)}`,
      `http://127.0.0.1:${String(p)}/`,
      `http://[::1]:${String(p)}`,
      `http://localhost:${String(p)}.evil.com`,
    ]) {
      const reply = await httpRequest(p, '/api/v3/health', { origin });
      expect(reply.status, `Origin: "${origin}"`).toBe(403);
      expect(envelopeOf(reply).code, `Origin: "${origin}"`).toBe('origin_not_allowed');
    }
  });

  it('refuses Sec-Fetch-Site cross-site on every method and same-site on every method but GET', async () => {
    const run = await startInstance();
    const p = run.port;
    expect(
      envelopeOf(await httpRequest(p, '/api/v3/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).code,
    ).toBe('cross_site_request');
    expect(
      envelopeOf(
        await httpRequest(p, '/api/v3/health', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      ).code,
    ).toBe('cross_site_request');
    expect(
      envelopeOf(
        await httpRequest(p, '/api/v3/health', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'same-site' } }),
      ).code,
    ).toBe('cross_site_request');
    for (const site of ['same-site', 'same-origin', 'none']) {
      expect((await httpRequest(p, '/api/v3/health', { headers: { 'Sec-Fetch-Site': site } })).status, site).toBe(200);
    }
  });

  it('refuses a URL above 8192 characters with 414 and accepts one of exactly 8192', async () => {
    const run = await startInstance();
    const prefix = '/api/v3/health?k=';
    const exactly = prefix + 'a'.repeat(8192 - prefix.length);
    expect(exactly).toHaveLength(8192);
    const atLimit = await httpRequest(run.port, exactly);
    expect(atLimit.status).toBe(400); // past the URL guard, refused by the query rule of the route
    expect(envelopeOf(atLimit).code).toBe('validation_failed');
    const over = await httpRequest(run.port, `${exactly}a`);
    expect(over.status).toBe(414);
    expect(envelopeOf(over).code).toBe('uri_too_long');
  });

  it('refuses a repeated key, answers OPTIONS with 405 and no CORS headers, and any POST but the nudge with 404 or 405', async () => {
    const run = await startInstance();
    const p = run.port;
    expect(envelopeOf(await httpRequest(p, '/api/v3/health?a=1&a=2')).code).toBe('param_repeated');
    const preflight = await httpRequest(p, '/api/v3/health', {
      method: 'OPTIONS',
      origin: `http://127.0.0.1:${String(p)}`,
      headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-mcs-request' },
    });
    expect(preflight.status).toBe(405);
    expect(Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    for (const route of [
      '/api/health',
      '/api/v3/health',
      '/api/v3/instance',
      '/api/v3/sessions',
      '/api/v3/export',
      '/',
    ]) {
      const reply = await httpRequest(p, route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MCS-Request': '1' },
        body: '{}',
      });
      expect([404, 405], route).toContain(reply.status);
    }
  });

  it('never sends an Access-Control header, whatever the request', async () => {
    const run = await startInstance();
    const replies = [
      await httpRequest(run.port, '/api/health', { origin: `http://127.0.0.1:${String(run.port)}` }),
      await httpRequest(run.port, '/api/health', { origin: 'http://evil.example' }),
      await httpRequest(run.port, '/api/health', { host: 'evil.example' }),
      await httpRequest(run.port, '/api/v3/nope'),
    ];
    for (const reply of replies) {
      expect(Object.keys(reply.headers).filter((name) => name.toLowerCase().startsWith('access-control-'))).toEqual([]);
    }
  });
});
