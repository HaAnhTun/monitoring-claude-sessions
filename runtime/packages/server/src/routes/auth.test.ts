// The auth routes (CAW-19, design 02 4.1 and 4.4, ADR 0085) over a fake access service: what each handler asks of the service,
// what it answers, the exact cookie strings, and what it logs. The real service, the real clock and the real guards of the app
// are covered by `test/terminal/auth-access.int.test.ts`.
import { createServer, type Server } from 'node:http';

import type { AccessService, ExchangeOutcome, Logger } from '@mcs/engine';
import { ErrorEnvelopeSchema, routes, type ErrorCode } from '@mcs/shared';
import { allocatePort, assertPortClosed, httpRequest } from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createAccessVerifier } from '../http/access-guard.ts';
import { clearCookieHeader, cookieName, setCookieHeader } from '../http/cookie.ts';
import { bindRouteServices, type RouteDeps } from '../route-adapter.ts';
import { createAuthRoutes } from './auth.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const CODE = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8';
const CREDENTIAL = 'cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXU';
const CREDENTIAL_ID = 'session-fixture-1';
const NAME = cookieName(INSTANCE);

interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

interface Fake {
  readonly service: Pick<AccessService, 'exchange' | 'verify' | 'verifyBearer' | 'revoke'>;
  readonly exchanged: string[];
  readonly revoked: string[];
  readonly verified: (string | undefined)[];
  bearerChecks: number;
  outcome: ExchangeOutcome;
}

/** A service that answers what the test scripted and records what it was asked. */
function fakeService(): Fake {
  const fake: Fake = {
    exchanged: [],
    revoked: [],
    verified: [],
    bearerChecks: 0,
    outcome: { ok: true, credential: CREDENTIAL, credentialId: CREDENTIAL_ID, expiresAtMs: 1 },
    service: {
      exchange: (code) => {
        fake.exchanged.push(code);
        return fake.outcome;
      },
      verify: (credential) => {
        fake.verified.push(credential);
        return credential === CREDENTIAL ? { credentialId: CREDENTIAL_ID, expiresAtMs: 1 } : null;
      },
      verifyBearer: () => {
        fake.bearerChecks += 1;
        return true;
      },
      revoke: (id) => {
        fake.revoked.push(id);
      },
    },
  };
  return fake;
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

interface Harness {
  readonly port: number;
  readonly fake: Fake;
  readonly logs: LogLine[];
}

/** The auth routes on an Express app with the bindings of a user instance; no other guard of the app is in front. */
async function start(): Promise<Harness> {
  const fake = fakeService();
  const logs: LogLine[] = [];
  const log =
    (level: string) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      logs.push({ level, event, fields });
    };
  const logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  const app = express();
  let port = 0;
  bindRouteServices(app, {
    errors: { push: () => undefined },
    logger,
    validateResponses: true,
    access: { verifier: createAccessVerifier(fake.service, INSTANCE), port: () => port },
  });
  // the module only reads the logger of the context; the rest of the context is the app's business
  const deps = { ctx: { logger }, nudge: () => undefined, task: null } as unknown as RouteDeps;
  createAuthRoutes({ access: fake.service, instanceId: INSTANCE })(app, deps);
  const server = createServer(app);
  port = await allocatePort();
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  servers.push({ server, port });
  return { port, fake, logs };
}

const origin = (port: number): string => `http://127.0.0.1:${String(port)}`;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };

function codeOf(reply: HttpReply): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function exchange(h: Harness, body: unknown = { code: CODE }): Promise<HttpReply> {
  return httpRequest(h.port, routes.authExchange.path, {
    method: 'POST',
    headers: JSON_HEADERS,
    origin: origin(h.port),
    body: JSON.stringify(body),
  });
}

function logout(h: Harness, cookie: string | undefined, body: unknown = {}): Promise<HttpReply> {
  return httpRequest(h.port, routes.authLogout.path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(cookie === undefined ? {} : { Cookie: cookie }) },
    origin: origin(h.port),
    body: JSON.stringify(body),
  });
}

describe('authSession', () => {
  it('answers {authenticated:false} without a cookie and {authenticated:true} with a live one, and nothing else', async () => {
    const h = await start();
    const none = await httpRequest(h.port, routes.authSession.path);
    expect(none.status).toBe(200);
    expect(JSON.parse(none.body)).toEqual({ authenticated: false });
    const live = await httpRequest(h.port, routes.authSession.path, { headers: { Cookie: `${NAME}=${CREDENTIAL}` } });
    expect(JSON.parse(live.body)).toEqual({ authenticated: true });
    const stale = await httpRequest(h.port, routes.authSession.path, {
      headers: { Cookie: `${NAME}=${'x'.repeat(43)}` },
    });
    expect(JSON.parse(stale.body)).toEqual({ authenticated: false });
  });

  it('reads the cookie of this instance only: the control token and a cookie of another name never authenticate', async () => {
    const h = await start();
    const bearer = await httpRequest(h.port, routes.authSession.path, {
      headers: { Authorization: 'Bearer anything-at-all' },
    });
    expect(JSON.parse(bearer.body)).toEqual({ authenticated: false });
    const other = await httpRequest(h.port, routes.authSession.path, {
      headers: { Cookie: `${cookieName('1c7a1a5f-7d2f-4b57-8e1b-1b6c4a8d0f22')}=${CREDENTIAL}` },
    });
    expect(JSON.parse(other.body)).toEqual({ authenticated: false });
    expect(h.fake.bearerChecks).toBe(0);
  });
});

describe('authExchange', () => {
  it('redeems the code once at the service, sets the cookie byte for byte and answers {authenticated:true}', async () => {
    const h = await start();
    const reply = await exchange(h);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ authenticated: true });
    expect(reply.headers['set-cookie']).toBe(`${NAME}=${CREDENTIAL}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    expect(reply.headers['set-cookie']).toBe(setCookieHeader(CREDENTIAL, INSTANCE));
    expect(h.fake.exchanged).toEqual([CODE]);
    // the credential is the cookie value and the body never carries it
    expect(reply.body).not.toContain(CREDENTIAL);
  });

  it('answers 401 access_code_invalid with the challenge header and no cookie for a code the service refuses', async () => {
    const h = await start();
    h.fake.outcome = { ok: false, reason: 'invalid' };
    const reply = await exchange(h);
    expect(reply.status).toBe(401);
    expect(codeOf(reply)).toBe('access_code_invalid');
    expect(reply.headers['www-authenticate']).toBe('CAW-Access');
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers['retry-after']).toBeUndefined();
  });

  it('answers 429 access_rate_limited with Retry-After in whole seconds, rounded up, and no cookie', async () => {
    const h = await start();
    h.fake.outcome = { ok: false, reason: 'rate_limited', retryAfterMs: 12_300 };
    const reply = await exchange(h);
    expect(reply.status).toBe(429);
    expect(codeOf(reply)).toBe('access_rate_limited');
    expect(reply.headers['retry-after']).toBe('13');
    expect(reply.headers['set-cookie']).toBeUndefined();
    h.fake.outcome = { ok: false, reason: 'rate_limited', retryAfterMs: 1 };
    expect((await exchange(h)).headers['retry-after']).toBe('1');
  });

  it('lets the service decide while it is limited: a valid code is redeemed, the route adds no lock of its own (TC-SEC-04)', async () => {
    const h = await start();
    h.fake.outcome = { ok: false, reason: 'rate_limited', retryAfterMs: 5000 };
    expect((await exchange(h)).status).toBe(429);
    h.fake.outcome = { ok: true, credential: CREDENTIAL, credentialId: CREDENTIAL_ID, expiresAtMs: 1 };
    const redeemed = await exchange(h);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers['set-cookie']).toBe(setCookieHeader(CREDENTIAL, INSTANCE));
    expect(h.fake.exchanged).toEqual([CODE, CODE]);
  });

  it('never reaches the service for a refused request: no Origin, a foreign Origin, no csrf header, a bad body', async () => {
    const h = await start();
    const post = (headers: Record<string, string>, body: string, originHeader?: string) =>
      httpRequest(h.port, routes.authExchange.path, {
        method: 'POST',
        headers,
        body,
        ...(originHeader === undefined ? {} : { origin: originHeader }),
      });
    const good = JSON.stringify({ code: CODE });
    expect(codeOf(await post(JSON_HEADERS, good))).toBe('origin_not_allowed');
    expect(codeOf(await post(JSON_HEADERS, good, 'http://evil.invalid'))).toBe('origin_not_allowed');
    expect(codeOf(await post({ 'Content-Type': 'application/json' }, good, origin(h.port)))).toBe('csrf_rejected');
    expect(codeOf(await post(JSON_HEADERS, '{', origin(h.port)))).toBe('body_invalid_json');
    expect(codeOf(await post(JSON_HEADERS, '{}', origin(h.port)))).toBe('validation_failed');
    expect(codeOf(await post(JSON_HEADERS, JSON.stringify({ code: 'short' }), origin(h.port)))).toBe(
      'validation_failed',
    );
    expect(codeOf(await post(JSON_HEADERS, JSON.stringify({ code: CODE, extra: 1 }), origin(h.port)))).toBe(
      'validation_failed',
    );
    expect(h.fake.exchanged).toEqual([]);
  });

  it('logs ticket_exchanged and access_rate_limited with counts only, and nothing for a refused code', async () => {
    const h = await start();
    h.fake.outcome = { ok: false, reason: 'invalid' };
    await exchange(h);
    expect(h.logs).toEqual([]);
    h.fake.outcome = { ok: false, reason: 'rate_limited', retryAfterMs: 5000 };
    await exchange(h);
    h.fake.outcome = { ok: true, credential: CREDENTIAL, credentialId: CREDENTIAL_ID, expiresAtMs: 1 };
    await exchange(h);
    const events = h.logs.filter((line) => line.event !== 'http_request');
    expect(events.map((line) => line.event)).toEqual(['access_rate_limited', 'ticket_exchanged']);
    for (const line of events) {
      expect(Object.keys(line.fields ?? {})).toEqual(['count']);
      expect(line.fields?.['count']).toBe(1);
    }
    const dump = JSON.stringify(h.logs);
    for (const secret of [CODE, CREDENTIAL, CREDENTIAL_ID]) expect(dump).not.toContain(secret);
  });
});

describe('authLogout', () => {
  it('revokes the credential of the cookie, clears the cookie and answers {authenticated:false}', async () => {
    const h = await start();
    const reply = await logout(h, `${NAME}=${CREDENTIAL}`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ authenticated: false });
    expect(reply.headers['set-cookie']).toBe(`${NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(reply.headers['set-cookie']).toBe(clearCookieHeader(INSTANCE));
    expect(h.fake.revoked).toEqual([CREDENTIAL_ID]);
  });

  it('answers 401 access_required and revokes nothing without a live cookie', async () => {
    const h = await start();
    for (const cookie of [undefined, `${NAME}=${'y'.repeat(43)}`, `${NAME}=junk`]) {
      const reply = await logout(h, cookie);
      expect(reply.status).toBe(401);
      expect(codeOf(reply)).toBe('access_required');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
    expect(h.fake.revoked).toEqual([]);
  });

  it('wants the page Origin, the csrf header and an empty object', async () => {
    const h = await start();
    const cookie = `${NAME}=${CREDENTIAL}`;
    const noOrigin = await httpRequest(h.port, routes.authLogout.path, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: '{}',
    });
    expect(codeOf(noOrigin)).toBe('origin_not_allowed');
    const noCsrf = await httpRequest(h.port, routes.authLogout.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      origin: origin(h.port),
      body: '{}',
    });
    expect(codeOf(noCsrf)).toBe('csrf_rejected');
    expect(codeOf(await logout(h, cookie, { everything: true }))).toBe('validation_failed');
    expect(h.fake.revoked).toEqual([]);
  });
});
