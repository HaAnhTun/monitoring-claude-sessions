// The access flow over real HTTP (CAW-19, design 02 4.1 to 4.6 and 10, ADR 0085): a real instance and app with the guards of the
// app in front, the real access service on a fake clock, the auth routes mounted as the boot code mounts them. The titles carry the
// ids of the security matrix of design 08 section 3.6 (TC-SEC-nn). Every request stays on 127.0.0.1 and a port of the testkit.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createAccessService,
  createLogger,
  defaultSkillDir,
  initWorkspace,
  type AccessService,
  type InstanceContext,
  type Logger,
} from '@mcs/engine';
import { AuthSessionResponseSchema, ErrorEnvelopeSchema, RUNTIME_VERSION, routes, type ErrorCode } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../../src/app.ts';
import { createAccessVerifier } from '../../src/http/access-guard.ts';
import { clearCookieHeader, cookieName, setCookieHeader } from '../../src/http/cookie.ts';
import { createAuthRoutes } from '../../src/routes/auth.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';
import { cookieFromReply, mintAndExchange, pageOrigin, postExchange, writeHeaders } from './helpers/auth.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const START = Date.UTC(2026, 9, 11, 14, 5, 7);
// FIXTURE: invented data for tests
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE = '22222222-2222-4222-8222-222222222222';
const NAME = cookieName(INSTANCE);
const OTHER_NAME = cookieName(OTHER_INSTANCE);
const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

interface Running {
  readonly port: number;
  readonly clock: FakeClock;
  readonly access: AccessService;
  readonly logFile: string;
  readonly logger: Logger;
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

/** A user-instance-like app: the guards of the app, the real access service, the auth routes. `withAuth: false` is a task instance. */
async function startInstance(withAuth = true): Promise<Running> {
  const root = makeTemp('auth-access-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(START);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => INSTANCE });
  const logFile = path.join(root, 'runtime.log');
  const logger = createLogger({ file: logFile, level: 'debug', rotate: false, clock });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger,
  });
  const access = createAccessService({ clock });
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    ...(withAuth
      ? {
          access: createAccessVerifier(access, ctx.instanceId),
          extraModules: [createAuthRoutes({ access, instanceId: ctx.instanceId })],
        }
      : {}),
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { port, clock, access, logFile, logger };
}

function codeOf(reply: HttpReply): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function session(run: Running, headers: Record<string, string> = {}, query = ''): Promise<HttpReply> {
  return httpRequest(run.port, `${routes.authSession.path}${query}`, { headers });
}

async function authenticated(run: Running, headers: Record<string, string> = {}): Promise<boolean> {
  const reply = await session(run, headers);
  expect(reply.status).toBe(200);
  return AuthSessionResponseSchema.parse(JSON.parse(reply.body)).authenticated;
}

/** A well-formed code that was never minted: 43 base64url characters. */
function wrongCode(n: number): string {
  return Buffer.alloc(32, n + 1).toString('base64url');
}

function logout(run: Running, cookie?: string): Promise<HttpReply> {
  return httpRequest(run.port, routes.authLogout.path, {
    method: 'POST',
    headers: writeHeaders(cookie),
    origin: pageOrigin(run.port),
    body: '{}',
  });
}

describe('the exchange of an access code (TC-SEC-01, TC-SEC-05)', () => {
  it('TC-SEC-01: a minted code is 43 base64url characters; the page learns it is signed out until it exchanges it', async () => {
    const run = await startInstance();
    const { code, ttlSeconds } = run.access.mint();
    expect(code).toMatch(CODE_SHAPE);
    expect(ttlSeconds).toBe(120);
    expect(await authenticated(run)).toBe(false);
  });

  it('TC-SEC-05: the exchange answers {authenticated:true} and sets the cookie byte for byte, with a value that is not the code', async () => {
    const run = await startInstance();
    const { code } = run.access.mint();
    const reply = await postExchange(run.port, code);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ authenticated: true });
    const setCookie = reply.headers['set-cookie'] ?? '';
    const credential = /^caw_11111111=([A-Za-z0-9_-]{43});/.exec(setCookie)?.[1] ?? '';
    expect(credential).not.toBe('');
    expect(credential).not.toBe(code);
    expect(setCookie).toBe(`caw_11111111=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    expect(setCookie).toBe(setCookieHeader(credential, INSTANCE));
    expect(setCookie).not.toMatch(/Domain|Secure|Expires/i);
    expect(reply.body).not.toContain(credential);
    expect(await authenticated(run, { Cookie: `${NAME}=${credential}` })).toBe(true);
  });

  it('TC-SEC-01: a code is single use: the second exchange of the same code is 401 access_code_invalid without a cookie', async () => {
    const run = await startInstance();
    const { code } = run.access.mint();
    expect((await postExchange(run.port, code)).status).toBe(200);
    const again = await postExchange(run.port, code);
    expect(again.status).toBe(401);
    expect(codeOf(again)).toBe('access_code_invalid');
    expect(again.headers['www-authenticate']).toBe('CAW-Access');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('TC-SEC-01: a code lives 120 s: valid after 119.999 s, refused at 120 s (FakeClock)', async () => {
    const run = await startInstance();
    const late = run.access.mint().code;
    run.clock.advance(119_999);
    expect((await postExchange(run.port, late)).status).toBe(200);
    const expired = run.access.mint().code;
    run.clock.advance(120_000);
    const reply = await postExchange(run.port, expired);
    expect(reply.status).toBe(401);
    expect(codeOf(reply)).toBe('access_code_invalid');
  });

  it('TC-SEC-04: a wrong code is 401 access_code_invalid and never a 500, with no cookie', async () => {
    const run = await startInstance();
    for (const code of [wrongCode(1), 'x'.repeat(32), 'A'.repeat(128)]) {
      const reply = await postExchange(run.port, code);
      expect(reply.status).toBe(401);
      expect(codeOf(reply)).toBe('access_code_invalid');
      expect(cookieFromReply(reply)).toBeNull();
    }
    // a code that cannot be one is refused by the schema before the service sees it
    for (const code of ['', 'short', 'x'.repeat(129), 'a b'.repeat(20)]) {
      const reply = await postExchange(run.port, code);
      expect(reply.status).toBe(400);
      expect(codeOf(reply)).toBe('validation_failed');
    }
  });

  it('TC-SEC-04: eight wrong codes, then 429 with Retry-After; a valid code still redeems while limited; recovery after the window', async () => {
    const run = await startInstance();
    for (let i = 0; i < 8; i += 1) expect((await postExchange(run.port, wrongCode(i))).status).toBe(401);
    const limited = await postExchange(run.port, wrongCode(9));
    expect(limited.status).toBe(429);
    expect(codeOf(limited)).toBe('access_rate_limited');
    expect(limited.headers['retry-after']).toBe('60');
    expect(cookieFromReply(limited)).toBeNull();
    run.clock.advance(30_000);
    const later = await postExchange(run.port, wrongCode(10));
    expect(later.status).toBe(429);
    expect(later.headers['retry-after']).toBe('30');
    // the owner is never locked out: the valid code redeems while wrong codes are limited
    const redeemed = await postExchange(run.port, run.access.mint().code);
    expect(redeemed.status).toBe(200);
    expect(cookieFromReply(redeemed)).not.toBeNull();
    // after the window the wrong codes are judged again
    run.clock.advance(30_000);
    const recovered = await postExchange(run.port, wrongCode(11));
    expect(recovered.status).toBe(401);
    expect(codeOf(recovered)).toBe('access_code_invalid');
  });
});

describe('the cookie and the instance (TC-SEC-06)', () => {
  it('TC-SEC-06: the cookie is named by the instance and the server reads only its own name', async () => {
    const run = await startInstance();
    const cookie = await mintAndExchange(run.port, run.access);
    expect(cookie.startsWith(`${NAME}=`)).toBe(true);
    const credential = cookie.slice(NAME.length + 1);
    expect(await authenticated(run, { Cookie: cookie })).toBe(true);
    // the same value under the name of another instance is nobody's cookie here
    expect(await authenticated(run, { Cookie: `${OTHER_NAME}=${credential}` })).toBe(false);
    // two instances in one jar: the browser sends both, this server reads its own
    expect(await authenticated(run, { Cookie: `${OTHER_NAME}=${wrongCode(3)}; ${cookie}` })).toBe(true);
    expect(await authenticated(run, { Cookie: `${cookie}; ${OTHER_NAME}=${wrongCode(3)}` })).toBe(true);
    expect(await authenticated(run, { Cookie: `${OTHER_NAME}=${wrongCode(3)}` })).toBe(false);
  });

  it('TC-SEC-06: two servers in one cookie jar: the cookie of one never opens the other', async () => {
    const first = await startInstance();
    const second = await startInstance();
    const cookie = await mintAndExchange(first.port, first.access);
    expect(await authenticated(first, { Cookie: cookie })).toBe(true);
    expect(await authenticated(second, { Cookie: cookie })).toBe(false);
  });

  it('TC-SEC-08: the code in a query string, an Authorization header or a cookie never authenticates, and stays redeemable', async () => {
    const run = await startInstance();
    const { code } = run.access.mint();
    // the route takes no query at all: a code in the address is refused, not read
    const reply = await session(run, {}, `?code=${code}`);
    expect(reply.status).toBe(400);
    expect(codeOf(reply)).toBe('validation_failed');
    expect(reply.body).not.toContain(code);
    expect(await authenticated(run, { Authorization: `Bearer ${code}` })).toBe(false);
    expect(await authenticated(run, { Cookie: `${NAME}=${code}` })).toBe(false);
    expect(await authenticated(run, { Cookie: `code=${code}` })).toBe(false);
    expect((await postExchange(run.port, code)).status).toBe(200);
  });
});

describe('logout (TC-SEC-02)', () => {
  it('TC-SEC-02: without a cookie, with an unknown one or with junk: 401 access_required with the challenge, nothing cleared', async () => {
    const run = await startInstance();
    for (const cookie of [undefined, `${NAME}=${wrongCode(4)}`, `${NAME}=junk`, `${OTHER_NAME}=${wrongCode(4)}`]) {
      const reply = await logout(run, cookie);
      expect(reply.status).toBe(401);
      expect(codeOf(reply)).toBe('access_required');
      expect(reply.headers['www-authenticate']).toBe('CAW-Access');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });

  it('revokes the credential, clears the cookie, closes what listens and refuses the old cookie afterwards', async () => {
    const run = await startInstance();
    const revoked: string[] = [];
    run.access.onRevoked((id) => {
      revoked.push(id);
    });
    const cookie = await mintAndExchange(run.port, run.access);
    const reply = await logout(run, cookie);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ authenticated: false });
    expect(reply.headers['set-cookie']).toBe(clearCookieHeader(INSTANCE));
    expect(reply.headers['set-cookie']).toBe(`${NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(revoked).toHaveLength(1);
    expect(await authenticated(run, { Cookie: cookie })).toBe(false);
    expect(codeOf(await logout(run, cookie))).toBe('access_required');
  });

  it('keeps the other signed-in browsers signed in', async () => {
    const run = await startInstance();
    const mine = await mintAndExchange(run.port, run.access);
    const theirs = await mintAndExchange(run.port, run.access);
    expect((await logout(run, mine)).status).toBe(200);
    expect(await authenticated(run, { Cookie: theirs })).toBe(true);
  });

  it('a session ends after 12 h without use, and 24 h after the sign-in however often it is used', async () => {
    const run = await startInstance();
    const idle = await mintAndExchange(run.port, run.access);
    run.clock.advance(43_199_999);
    expect(await authenticated(run, { Cookie: idle })).toBe(true);
    run.clock.advance(43_200_000);
    expect(await authenticated(run, { Cookie: idle })).toBe(false);
    const used = await mintAndExchange(run.port, run.access);
    for (let hour = 0; hour < 23; hour += 1) {
      run.clock.advance(3_600_000);
      expect(await authenticated(run, { Cookie: used })).toBe(true);
    }
    run.clock.advance(3_600_000);
    expect(await authenticated(run, { Cookie: used })).toBe(false);
  });
});

describe('what never reaches the access service (TC-SEC-11, 12, 14, 22)', () => {
  it('a foreign Host, a missing or foreign Origin, a form post, an oversize or malformed body leave the code redeemable', async () => {
    const run = await startInstance();
    const { code } = run.access.mint();
    const body = JSON.stringify({ code });
    const send = (extra: { host?: string; origin?: string; headers?: Record<string, string>; body?: string }) =>
      httpRequest(run.port, routes.authExchange.path, {
        method: 'POST',
        headers: extra.headers ?? writeHeaders(),
        ...(extra.origin === undefined ? {} : { origin: extra.origin }),
        ...(extra.host === undefined ? {} : { host: extra.host }),
        body: extra.body ?? body,
      });
    const origin = pageOrigin(run.port);
    expect(codeOf(await send({ origin, host: 'evil.example' }))).toBe('host_not_allowed');
    expect(codeOf(await send({ origin, host: `127.0.0.1:${String(run.port + 1)}` }))).toBe('host_not_allowed');
    expect(codeOf(await send({}))).toBe('origin_not_allowed');
    expect(codeOf(await send({ origin: 'http://evil.example' }))).toBe('origin_not_allowed');
    expect(codeOf(await send({ origin: 'null' }))).toBe('origin_not_allowed');
    expect(codeOf(await send({ origin: `http://127.0.0.1:${String(run.port + 1)}` }))).toBe('origin_not_allowed');
    expect(codeOf(await send({ origin, headers: { 'Content-Type': 'application/json' } }))).toBe('csrf_rejected');
    expect(codeOf(await send({ origin, headers: { 'Content-Type': 'text/plain', 'X-MCS-Request': '1' } }))).toBe(
      'csrf_rejected',
    );
    expect(
      codeOf(
        await send({
          origin,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MCS-Request': '1' },
          body: `code=${code}`,
        }),
      ),
    ).toBe('csrf_rejected');
    const oversize = JSON.stringify({ code, pad: 'x'.repeat(4097) });
    expect(codeOf(await send({ origin, body: oversize }))).toBe('payload_too_large');
    expect(codeOf(await send({ origin, body: '{"code":' }))).toBe('body_invalid_json');
    expect(codeOf(await send({ origin, body: JSON.stringify({ code, extra: true }) }))).toBe('validation_failed');
    expect(codeOf(await send({ origin, body: JSON.stringify({ code: [code] }) }))).toBe('validation_failed');
    expect(codeOf(await send({ origin, body: '[]' }))).toBe('validation_failed');
    // none of them used the code, and none counted as a wrong code
    const redeemed = await send({ origin });
    expect(redeemed.status).toBe(200);
  });

  it('answers only the methods of the route: GET on the exchange and POST on the session are 405', async () => {
    const run = await startInstance();
    const get = await httpRequest(run.port, routes.authExchange.path);
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    const post = await httpRequest(run.port, routes.authSession.path, {
      method: 'POST',
      headers: writeHeaders(),
      origin: pageOrigin(run.port),
      body: '{}',
    });
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
  });
});

describe('headers and logs (TC-SEC-16, TC-SEC-18, TC-SEC-41)', () => {
  it('TC-SEC-16 and TC-SEC-18: no Access-Control header and no-store on every answer of the three routes', async () => {
    const run = await startInstance();
    const replies: HttpReply[] = [await session(run)];
    replies.push(await postExchange(run.port, wrongCode(5)));
    replies.push(await postExchange(run.port, run.access.mint().code));
    replies.push(await logout(run));
    for (let i = 0; i < 8; i += 1) await postExchange(run.port, wrongCode(20 + i));
    replies.push(await postExchange(run.port, wrongCode(30)));
    replies.push(await postExchange(run.port, wrongCode(31), { origin: 'http://evil.example' }));
    expect(replies.map((reply) => reply.status)).toEqual([200, 401, 200, 401, 429, 403]);
    for (const reply of replies) {
      expect(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('TC-SEC-41: a full flow logs counts and route ids only: no code, no credential, no cookie, no wrong code', async () => {
    const run = await startInstance();
    const code = run.access.mint().code;
    const wrong = Array.from({ length: 9 }, (_unused, i) => wrongCode(40 + i));
    for (const candidate of wrong) await postExchange(run.port, candidate);
    const reply = await postExchange(run.port, code);
    const cookie = cookieFromReply(reply) ?? '';
    const credential = cookie.slice(NAME.length + 1);
    expect(credential).toMatch(CODE_SHAPE);
    await session(run, { Cookie: cookie });
    await logout(run, cookie);
    await run.logger.close();
    const log = readFileSync(run.logFile, 'utf8');
    for (const secret of [code, credential, cookie, ...wrong]) expect(log).not.toContain(secret);
    expect(log.toLowerCase()).not.toContain('set-cookie');
    const events = log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { event: string; route?: string; count?: number });
    expect(events.filter((line) => line.event === 'ticket_exchanged')).toEqual([
      expect.objectContaining({ event: 'ticket_exchanged', count: 1 }),
    ]);
    expect(events.filter((line) => line.event === 'access_rate_limited')).toHaveLength(1);
    const routeIds = new Set(events.flatMap((line) => (line.route === undefined ? [] : [line.route])));
    expect([...routeIds].every((id) => /^[A-Za-z]+$/.test(id))).toBe(true);
    expect(routeIds.has('authExchange')).toBe(true);
  });
});

describe('a task instance has no auth routes', () => {
  it('answers the JSON 404 for every auth path and mounts nothing', async () => {
    const run = await startInstance(false);
    expect(codeOf(await session(run))).toBe('route_not_found');
    expect(codeOf(await postExchange(run.port, wrongCode(6)))).toBe('route_not_found');
    expect(codeOf(await logout(run))).toBe('route_not_found');
  });
});
