// The access guard and the verifier (CAW design 02 3 and 4.3 to 4.5, A1, ADR 0084), on a real Express app over the real access
// service with a fake clock: who gets through a `session`, a `reader` and a `ticket` route, in which order the checks run, and
// what a refusal looks like (TC-SEC-02, TC-SEC-06, TC-SEC-08, TC-SEC-12).
import { Agent, request, type IncomingHttpHeaders, type Server } from 'node:http';

import { createAccessService, type AccessService } from '@mcs/engine';
import { ErrorEnvelopeSchema, type ErrorCode } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed } from '@mcs/testkit';
import express, { type Express, type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  accessGuard,
  accessOf,
  createAccessVerifier,
  type AccessGuardOptions,
  type AccessVerifier,
} from './access-guard.ts';
import { cookieName, setCookieHeader } from './cookie.ts';

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const OTHER_INSTANCE = '1c7a1a5f-7d2f-4b57-8e1b-1b6c4a8d0f22';
const CONTROL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_TOKEN = '0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100';
const NAME = cookieName(INSTANCE);
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * One request on a keep-alive connection: a client that asks for `Connection: close` (the testkit helper does) would hide the
 * header that the guard sets on a refused write, so this one leaves the choice to the server.
 */
const agent = new Agent({ keepAlive: true });

function httpRequest(
  port: number,
  path: string,
  opts: { method?: string; origin?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers, Host: `127.0.0.1:${String(port)}` };
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.once('error', reject);
      },
    );
    req.once('timeout', () => {
      req.destroy(new Error('the request timed out'));
    });
    req.once('error', reject);
    req.end(opts.body);
  });
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

interface Harness {
  readonly port: number;
  readonly clock: FakeClock;
  readonly service: AccessService;
  readonly verifier: AccessVerifier;
  /** How many times a handler ran (a refused request never gets there). */
  readonly calls: { count: number };
  /** Signs in and returns the `Cookie` request header and the credential id. */
  signIn(instance?: string): { cookie: string; credential: string; credentialId: string };
}

const servers: { readonly server: Server; readonly port: number }[] = [];
afterEach(async () => {
  agent.destroy();
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

/**
 * Routes of every kind under one app: `/session/:method`, `/reader/:method` and `/ticket` are the guard in front of a handler that
 * reports how the request was admitted. The guard is mounted per path so that one app proves the whole matrix.
 */
async function start(over: { portSource?: 'number' | 'function' } = {}): Promise<Harness> {
  const port = await allocatePort();
  const clock = new FakeClock(START);
  const service = createAccessService({ clock, controlToken: CONTROL_TOKEN });
  const verifier = createAccessVerifier(service, INSTANCE);
  const calls = { count: 0 };
  const app: Express = express();
  const source = over.portSource === 'function' ? () => port : port;
  const handler: RequestHandler = (_req, res) => {
    calls.count += 1;
    const access = accessOf(res);
    res.json({
      via: access?.via ?? null,
      credentialId: access?.via === 'cookie' ? access.session.credentialId : null,
    });
  };
  const mount = (path: string, options: Omit<AccessGuardOptions, 'port'>): void => {
    app.all(path, accessGuard(verifier, { ...options, port: source }), handler);
  };
  mount('/session-read', { access: 'session', requireOrigin: false });
  mount('/session-write', { access: 'session', requireOrigin: true });
  mount('/reader-read', { access: 'reader', requireOrigin: false });
  mount('/reader-write', { access: 'reader', requireOrigin: true });
  mount('/ticket', { access: 'ticket', requireOrigin: true });
  mount('/ticket-open', { access: 'ticket', requireOrigin: false });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return {
    port,
    clock,
    service,
    verifier,
    calls,
    signIn: (instance = INSTANCE) => {
      const outcome = service.exchange(service.mint().code);
      if (!outcome.ok) throw new Error('sign-in failed');
      return {
        cookie: `${cookieName(instance)}=${outcome.credential}`,
        credential: outcome.credential,
        credentialId: outcome.credentialId,
      };
    },
  };
}

function originOf(h: Harness, host = '127.0.0.1'): string {
  return `http://${host}:${String(h.port)}`;
}

function expectRefusal(reply: Reply, status: number, code: ErrorCode): void {
  expect(reply.status).toBe(status);
  const envelope = ErrorEnvelopeSchema.parse(JSON.parse(reply.body));
  expect(envelope.error.code).toBe(code);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
}

function expectNoAccess(reply: Reply, h: Harness, method: string): void {
  expectRefusal(reply, 401, 'access_required');
  expect(reply.headers['www-authenticate']).toBe('CAW-Access');
  // the body of a write is never read: the connection is asked to close
  expect(reply.headers['connection']).toBe(method === 'POST' ? 'close' : 'keep-alive');
  expect(h.calls.count).toBe(0);
}

const WRITES = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;

describe('accessGuard: a session route (TC-SEC-02)', () => {
  for (const method of ['GET', 'POST'] as const) {
    describe(method, () => {
      const path = method === 'GET' ? '/session-read' : '/session-write';
      const send = (h: Harness, headers: Record<string, string> = {}, extra: { path?: string } = {}): Promise<Reply> =>
        httpRequest(h.port, extra.path ?? path, {
          method,
          origin: originOf(h),
          headers: method === 'POST' ? { 'Content-Type': 'application/json', ...headers } : headers,
          ...(method === 'POST' ? { body: '{}' } : {}),
        });

      it('is 401 access_required with the challenge when there is no cookie', async () => {
        const h = await start();
        expectNoAccess(await send(h), h, method);
      });

      it('is 401 for a garbage cookie, an unknown credential and an empty value', async () => {
        const h = await start();
        const unknown = 'A'.repeat(43);
        for (const cookie of [`${NAME}=garbage`, `${NAME}=${unknown}`, `${NAME}=`, NAME, 'x=y']) {
          expectNoAccess(await send(h, { Cookie: cookie }), h, method);
        }
      });

      it('is 401 for the credential of another instance, or under the name of another instance', async () => {
        const h = await start();
        const { credential } = h.signIn();
        expectNoAccess(await send(h, { Cookie: `${cookieName(OTHER_INSTANCE)}=${credential}` }), h, method);
        const other = createAccessVerifier(h.service, OTHER_INSTANCE);
        expect(other.verify({ headers: { cookie: `${NAME}=${credential}` } })).toBeNull();
        expect(other.verify({ headers: { cookie: `${cookieName(OTHER_INSTANCE)}=${credential}` } })).not.toBeNull();
      });

      it('is 401 for an expired credential and for a revoked one', async () => {
        const h = await start();
        const expired = h.signIn();
        const revoked = h.signIn();
        h.service.revoke(revoked.credentialId);
        expectNoAccess(await send(h, { Cookie: revoked.cookie }), h, method);
        h.clock.advance(12 * HOUR);
        expectNoAccess(await send(h, { Cookie: expired.cookie }), h, method);
      });

      it('is 200 for a live credential, and says which one admitted the request', async () => {
        const h = await start();
        const { cookie, credentialId } = h.signIn();
        const reply = await send(h, { Cookie: cookie });
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.body)).toEqual({ via: 'cookie', credentialId });
        expect(h.calls.count).toBe(1);
      });

      it('finds its cookie among others, and honours the first of two with the same name', async () => {
        const h = await start();
        const first = h.signIn();
        const second = h.signIn();
        const among = `theme=dark; ${cookieName(OTHER_INSTANCE)}=${second.credential}; ${first.cookie}; lang=en`;
        expect((await send(h, { Cookie: among })).status).toBe(200);
        expect((await send(h, { Cookie: `${first.cookie}; ${second.cookie}` })).status).toBe(200);
        const served = h.calls.count;
        expectRefusal(await send(h, { Cookie: `${NAME}=junk; ${second.cookie}` }), 401, 'access_required');
        expect(h.calls.count).toBe(served);
      });

      it('is not admitted by the credential in a query, another header or another scheme (TC-SEC-08)', async () => {
        const h = await start();
        const { credential } = h.signIn();
        for (const variant of [
          { query: `?access=${credential}`, headers: {} },
          { query: `?${NAME}=${credential}`, headers: {} },
          { query: '', headers: { 'X-Access': credential } },
          { query: '', headers: { 'X-MCS-Access': credential } },
          { query: '', headers: { Authorization: `Bearer ${credential}` } },
          { query: '', headers: { Authorization: `Basic ${Buffer.from(`u:${credential}`).toString('base64')}` } },
        ]) {
          const reply = await send(h, variant.headers, { path: `${path}${variant.query}` });
          expectNoAccess(reply, h, method);
        }
      });

      it('is not admitted by the control token as a Bearer value: that is for reader routes only', async () => {
        const h = await start();
        expectNoAccess(await send(h, { Authorization: `Bearer ${CONTROL_TOKEN}` }), h, method);
      });

      it('never repeats what the client sent', async () => {
        const h = await start();
        const marker = 'leak-marker-9c1d';
        const reply = await send(h, { Cookie: `${NAME}=${marker}`, Authorization: `Bearer ${marker}` });
        expect(reply.status).toBe(401);
        expect(reply.body).not.toContain(marker);
        expect(JSON.stringify(reply.headers)).not.toContain(marker);
      });
    });
  }
});

describe('accessGuard: a reader route (A1)', () => {
  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  it('admits a live cookie on GET', async () => {
    const h = await start();
    const { cookie, credentialId } = h.signIn();
    const reply = await httpRequest(h.port, '/reader-read', { headers: { Cookie: cookie } });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ via: 'cookie', credentialId });
  });

  it('admits the control token as a Bearer value on GET and HEAD', async () => {
    const h = await start();
    const get = await httpRequest(h.port, '/reader-read', { headers: bearer(CONTROL_TOKEN) });
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual({ via: 'bearer', credentialId: null });
    const head = await httpRequest(h.port, '/reader-read', { method: 'HEAD', headers: bearer(CONTROL_TOKEN) });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(h.calls.count).toBe(2);
  });

  it('accepts the scheme in any case', async () => {
    const h = await start();
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const reply = await httpRequest(h.port, '/reader-read', {
        headers: { Authorization: `${scheme} ${CONTROL_TOKEN}` },
      });
      expect(reply.status, scheme).toBe(200);
    }
  });

  it('never admits the control token on a write, whatever the method', async () => {
    const h = await start();
    for (const method of WRITES) {
      const reply = await httpRequest(h.port, '/reader-write', {
        method,
        origin: originOf(h),
        headers: { 'Content-Type': 'application/json', ...bearer(CONTROL_TOKEN) },
        body: '{}',
      });
      expectRefusal(reply, 401, 'access_required');
      expect(reply.headers['connection'], method).toBe('close');
    }
    expect(h.calls.count).toBe(0);
  });

  it('still admits a cookie on a write of a reader route', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    const reply = await httpRequest(h.port, '/reader-write', {
      method: 'POST',
      origin: originOf(h),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(reply.status).toBe(200);
  });

  it('is 401 without a credential, with another token, with a malformed header and with the wrong scheme', async () => {
    const h = await start();
    const refused: Record<string, string>[] = [
      {},
      bearer(OTHER_TOKEN),
      bearer(CONTROL_TOKEN.slice(0, 63)),
      bearer(`${CONTROL_TOKEN}0`),
      { Authorization: 'Bearer' },
      { Authorization: CONTROL_TOKEN },
      { Authorization: `Basic ${CONTROL_TOKEN}` },
      { Authorization: `Bearer ${CONTROL_TOKEN} ${OTHER_TOKEN}` },
      { Cookie: `${NAME}=${CONTROL_TOKEN.slice(0, 43)}` },
    ];
    for (const headers of refused) {
      const reply = await httpRequest(h.port, '/reader-read', { headers });
      expectRefusal(reply, 401, 'access_required');
      expect(reply.headers['www-authenticate']).toBe('CAW-Access');
    }
    expect(h.calls.count).toBe(0);
  });

  it('lets a live cookie win over a wrong token, and a right token win over a bad cookie', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    const withCookie = await httpRequest(h.port, '/reader-read', {
      headers: { Cookie: cookie, ...bearer(OTHER_TOKEN) },
    });
    expect(JSON.parse(withCookie.body)).toMatchObject({ via: 'cookie' });
    const withToken = await httpRequest(h.port, '/reader-read', {
      headers: { Cookie: `${NAME}=garbage`, ...bearer(CONTROL_TOKEN) },
    });
    expect(JSON.parse(withToken.body)).toMatchObject({ via: 'bearer' });
  });

  it('does not use the control token of a service that has none', async () => {
    const h = await start();
    const bare = createAccessVerifier(createAccessService({ clock: h.clock }), INSTANCE);
    expect(bare.verifyBearer({ headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).toBe(false);
    expect(h.verifier.verifyBearer({ headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).toBe(true);
  });
});

describe('accessGuard: the Origin of a write or a socket (TC-SEC-12)', () => {
  const post = (h: Harness, headers: Record<string, string>, origin?: string): Promise<Reply> =>
    httpRequest(h.port, '/session-write', {
      method: 'POST',
      ...(origin === undefined ? {} : { origin }),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });

  it('is 403 origin_not_allowed when the Origin header is missing, even with a live cookie', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    const reply = await post(h, { Cookie: cookie });
    expectRefusal(reply, 403, 'origin_not_allowed');
    expect(reply.headers['connection']).toBe('close');
    expect(h.calls.count).toBe(0);
  });

  it('is 403 for null, an empty value, a foreign origin, another port, another scheme and look-alikes', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    const own = originOf(h);
    for (const origin of [
      'null',
      '',
      'http://evil.invalid',
      `http://evil.invalid:${String(h.port)}`,
      `http://127.0.0.1:${String(h.port + 1)}`,
      `http://localhost:${String(h.port + 1)}`,
      `https://127.0.0.1:${String(h.port)}`,
      `${own}/`,
      `${own}.evil.invalid`,
      `http://127.0.0.1.evil.invalid:${String(h.port)}`,
      `http://user@127.0.0.1:${String(h.port)}`,
      `http://127.0.0.1:${String(h.port)}@evil.invalid`,
      own.toUpperCase(),
    ]) {
      expectRefusal(await post(h, { Cookie: cookie }, origin), 403, 'origin_not_allowed');
    }
    expect(h.calls.count).toBe(0);
  });

  it('admits exactly the two allowed origins', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    for (const host of ['127.0.0.1', 'localhost']) {
      expect((await post(h, { Cookie: cookie }, originOf(h, host))).status, host).toBe(200);
    }
  });

  it('checks the Origin before the cookie: a bad Origin without a cookie is 403, not 401', async () => {
    const h = await start();
    expectRefusal(await post(h, {}, 'http://evil.invalid'), 403, 'origin_not_allowed');
    expectRefusal(await post(h, {}), 403, 'origin_not_allowed');
    expectRefusal(await post(h, {}, originOf(h)), 401, 'access_required');
  });

  it('asks for an Origin on a GET only where the route says so (the socket does)', async () => {
    const h = await start();
    const { cookie } = h.signIn();
    expect((await httpRequest(h.port, '/session-read', { headers: { Cookie: cookie } })).status).toBe(200);
    const socketLike = await httpRequest(h.port, '/session-write', { headers: { Cookie: cookie } });
    expectRefusal(socketLike, 403, 'origin_not_allowed');
    // a GET refusal leaves the connection alone: nothing was unread
    expect(socketLike.headers['connection']).not.toBe('close');
  });

  it('reads the port when a request arrives, so a server that scans for a free port still checks the right one', async () => {
    const h = await start({ portSource: 'function' });
    const { cookie } = h.signIn();
    expect((await post(h, { Cookie: cookie }, originOf(h))).status).toBe(200);
    expectRefusal(
      await post(h, { Cookie: cookie }, `http://127.0.0.1:${String(h.port + 1)}`),
      403,
      'origin_not_allowed',
    );
  });
});

describe('accessGuard: the ticket route', () => {
  const post = (h: Harness, path: string, origin?: string, headers: Record<string, string> = {}): Promise<Reply> =>
    httpRequest(h.port, path, {
      method: 'POST',
      ...(origin === undefined ? {} : { origin }),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });

  it('needs no cookie, only an exact Origin, and marks the request as a ticket exchange', async () => {
    const h = await start();
    const reply = await post(h, '/ticket', originOf(h));
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ via: 'ticket', credentialId: null });
  });

  it('is 403 without an Origin or with a foreign one', async () => {
    const h = await start();
    expectRefusal(await post(h, '/ticket'), 403, 'origin_not_allowed');
    expectRefusal(await post(h, '/ticket', 'http://evil.invalid'), 403, 'origin_not_allowed');
    expect(h.calls.count).toBe(0);
  });

  it('does not look at the cookie or the Authorization header, and admits a bad one', async () => {
    const h = await start();
    const reply = await post(h, '/ticket', originOf(h), { Cookie: `${NAME}=garbage`, Authorization: 'Bearer nope' });
    expect(reply.status).toBe(200);
  });

  it('passes without an Origin where the route does not require one', async () => {
    const h = await start();
    expect((await post(h, '/ticket-open')).status).toBe(200);
  });
});

describe('createAccessVerifier', () => {
  it('reads the cookie of its own instance and nothing else', () => {
    const clock = new FakeClock(START);
    const service = createAccessService({ clock, controlToken: CONTROL_TOKEN });
    const outcome = service.exchange(service.mint().code);
    if (!outcome.ok) throw new Error('sign-in failed');
    const mine = createAccessVerifier(service, INSTANCE);
    const theirs = createAccessVerifier(service, OTHER_INSTANCE);
    const header = setCookieHeader(outcome.credential, INSTANCE).split('; ')[0] ?? '';
    expect(mine.verify({ headers: { cookie: header } })).toEqual({
      credentialId: outcome.credentialId,
      expiresAtMs: START + 12 * HOUR,
    });
    expect(theirs.verify({ headers: { cookie: header } })).toBeNull();
    expect(mine.verify({ headers: {} })).toBeNull();
    expect(mine.verify({ headers: { cookie: `${NAME}=${'A'.repeat(43)}` } })).toBeNull();
  });

  it('does not ask the service when there is no cookie of its name', () => {
    let asked = 0;
    const verifier = createAccessVerifier(
      {
        verify: () => {
          asked += 1;
          return null;
        },
        verifyBearer: () => false,
      },
      INSTANCE,
    );
    verifier.verify({ headers: {} });
    verifier.verify({ headers: { cookie: `${cookieName(OTHER_INSTANCE)}=${'A'.repeat(43)}` } });
    verifier.verify({ headers: { cookie: `${NAME}=junk` } });
    expect(asked).toBe(0);
    verifier.verify({ headers: { cookie: `${NAME}=${'A'.repeat(43)}` } });
    expect(asked).toBe(1);
  });

  it('hands the Authorization header to the service as it is', () => {
    const seen: (string | undefined)[] = [];
    const verifier = createAccessVerifier(
      {
        verify: () => null,
        verifyBearer: (header) => {
          seen.push(header);
          return header === 'Bearer yes';
        },
      },
      INSTANCE,
    );
    expect(verifier.verifyBearer({ headers: { authorization: 'Bearer yes' } })).toBe(true);
    expect(verifier.verifyBearer({ headers: {} })).toBe(false);
    expect(seen).toEqual(['Bearer yes', undefined]);
  });

  it('refuses an instance id that is not a uuid', () => {
    const service = createAccessService({ clock: new FakeClock(START) });
    expect(() => createAccessVerifier(service, 'not-an-id')).toThrow(RangeError);
  });
});

describe('accessOf', () => {
  it('is undefined for a response that no guard admitted', () => {
    expect(accessOf({ locals: {} } as never)).toBeUndefined();
    expect(accessOf({ locals: { access: 'cookie' } } as never)).toBeUndefined();
  });
});
