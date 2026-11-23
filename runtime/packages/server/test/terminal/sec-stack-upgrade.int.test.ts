// The security matrix over the real stack, upgrade half (CAW-57, design 08 section 3.6, ids TC-SEC-03 and 07, with the restart
// part of TC-SEC-01): the WebSocket handshake is its own code path (Node hands an upgrade to a listener, not to the request
// handler), so it is proved again here over the REAL terminal service, access service and gateway (`startTerminalHarness`), with a
// scripted pseudo terminal. A refused handshake is the JSON envelope and nothing else: no 101, no viewer on the real session, not
// a byte to the process, the connection closed by the server. A cookie and a code of an instance that was restarted are worth
// nothing to the instance that runs now, and a credential that ends takes its sockets with it (4003).
import { connect } from 'node:net';

import { ACCESS_LIMITS } from '@mcs/engine';
import type { FakePty } from '@mcs/engine/testing';
import {
  CreateSessionResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TERMINAL_CLOSE_CODES,
  TERMINAL_SUBPROTOCOL,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
} from '@mcs/shared';
import { RawWsClient, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { TERMINAL_CLOSE_REASONS } from '../../src/terminal/gateway.ts';
import { cookieFromReply, mintAndExchange, pageOrigin, postExchange } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

/** A well-formed credential that no access service issued. */
const NEVER_ISSUED = Buffer.alloc(32, 9).toString('base64url');
const OP_BINARY = 2;

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

async function createSession(h: TerminalHarness): Promise<{ name: string; pty: FakePty }> {
  const made = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
  expect(made.status, made.body).toBe(200);
  const { name } = CreateSessionResponseSchema.parse(made.json).session;
  const pty = h.backend.last;
  if (pty === undefined) throw new Error('the create route answered a session and nothing was spawned');
  return { name, pty };
}

const socketPath = (name: string): string => buildPath(routes.terminalSocket, { name });

async function viewersOf(h: TerminalHarness, name: string, cookie: string = h.cookie): Promise<number | undefined> {
  const state = await h.http('GET', routes.terminalState.path, { cookie });
  return TerminalStateSchema.parse(state.json).sessions.find((session) => session.name === name)?.viewers;
}

/** One masked client frame (RFC 6455 5.2) with a payload under 126 bytes. */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] = (body[i] ?? 0) ^ (key[i % 4] ?? 0);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), key, body]);
}

interface RawAnswer {
  readonly status: number;
  /** Everything the server sent, as text. */
  readonly text: string;
  /** True when the server closed the connection by itself (the client never did). */
  readonly closedByServer: boolean;
}

/** How long a refused handshake may take to be answered and closed by the server. */
const RAW_BUDGET_MS = 8000;

/**
 * A handshake written by hand on a plain connection, with `early` bytes in the same write (what a client sends after its request
 * without waiting for the answer). The client never closes a refused connection: the promise resolves when the server does. An
 * accepted handshake (a complete 101 answer) resolves at once, because that socket stays open.
 */
function rawHandshake(
  port: number,
  path: string,
  o: { readonly cookie?: string; readonly origin?: string; readonly early?: Buffer },
): Promise<RawAnswer> {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${Buffer.alloc(16, 5).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${TERMINAL_SUBPROTOCOL}`,
    `Origin: ${o.origin ?? pageOrigin(port)}`,
    ...(o.cookie === undefined ? [] : [`Cookie: ${o.cookie}`]),
    '',
    '',
  ];
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (closedByServer: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      const text = Buffer.concat(chunks).toString('latin1');
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0'), text, closedByServer });
    };
    // a server that neither answers nor closes: the wait ends, and the caller sees that the server did not close
    socket.setTimeout(RAW_BUDGET_MS, () => {
      finish(false);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const head = Buffer.concat(chunks).toString('latin1');
      if (head.startsWith('HTTP/1.1 101 ') && head.includes('\r\n\r\n')) finish(false);
    });
    socket.once('close', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(true);
    });
    socket.once('connect', () => {
      socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), o.early ?? Buffer.alloc(0)]));
    });
  });
}

/** The cookie states that must not open a socket, for an instance whose `h.cookie` is still live. */
async function refusedCookies(h: TerminalHarness): Promise<Readonly<Record<string, string | undefined>>> {
  const name = h.cookie.slice(0, h.cookie.indexOf('='));
  const value = h.cookie.slice(h.cookie.indexOf('=') + 1);
  const revoked = await mintAndExchange(h.port, h.access);
  expect((await h.http('POST', routes.authLogout.path, { cookie: revoked })).status).toBe(200);
  return {
    'no cookie': undefined,
    'a junk cookie': `${name}=not a credential`,
    'a credential that was never issued': `${name}=${NEVER_ISSUED}`,
    'a signed-out cookie': revoked,
    'the live credential under another cookie name': `caw_00000000=${value}`,
    'the spent access code as the cookie value': `${name}=${h.code}`,
  };
}

describe('a handshake without a live cookie', () => {
  it('TC-SEC-03: is the JSON envelope with 401 and the challenge: no 101, no viewer on the real session, nothing written, the server closes', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    pty.emitData('output nobody without a cookie may read\r\n');
    const states = await refusedCookies(h);

    for (const [state, cookie] of Object.entries(states)) {
      const client = await RawWsClient.connect(h.port, {
        path: socketPath(name),
        ...(cookie === undefined ? {} : { cookie }),
        origin: pageOrigin(h.port),
      });
      expect(client.status, state).toBe(ERROR_HTTP_STATUS.access_required);
      expect(codeOf(client), state).toBe('access_required');
      expect(client.acceptOk, state).toBe(false);
      expect(client.headers['www-authenticate'], state).toBeDefined();
      expect(client.headers['content-type'], state).toMatch(/^application\/json/);
      expect(client.headers['cache-control'], state).toBe('no-store');
      // nothing of a WebSocket answer, nothing for another origin, no cookie
      for (const header of ['upgrade', 'sec-websocket-accept', 'sec-websocket-protocol', 'set-cookie']) {
        expect(client.headers[header], `${state}: ${header}`).toBeUndefined();
      }
      expect(Object.keys(client.headers).filter((header) => header.startsWith('access-control-'))).toEqual([]);
      // the envelope says why and repeats nothing of the terminal
      expect(client.body, state).not.toContain('output nobody');
      await client.waitClosed();
    }
    // the session exists only for who is signed in: an unknown name is the same 401, so a name cannot be probed
    const unknown = await RawWsClient.connect(h.port, {
      path: socketPath('no-such-session'),
      origin: pageOrigin(h.port),
    });
    expect(unknown.status).toBe(ERROR_HTTP_STATUS.access_required);
    const hostile = await RawWsClient.connect(h.port, {
      path: routes.terminalSocket.path.replace(':name', '..%2F..%2Fx'),
      origin: pageOrigin(h.port),
    });
    expect(hostile.status).toBe(ERROR_HTTP_STATUS.access_required);

    // the real service never saw any of it
    expect(await viewersOf(h, name)).toBe(0);
    expect(pty.written).toEqual([]);
    expect(pty.sizes).toEqual([]);
    expect(pty.killCalls).toBe(0);
    expect(h.backend.spawns).toHaveLength(1);
    // and the socket still opens for the cookie, with the output intact
    const admitted = await h.ws(name);
    expect(admitted.replay.toString('utf8')).toBe('output nobody without a cookie may read\r\n');
  });

  it('TC-SEC-03: bytes sent right behind a refused handshake never reach the process; behind an accepted one they do', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    // what a client would send as its first input frame, without waiting for the 101
    const early = maskedFrame(OP_BINARY, Buffer.from('early input\r'));

    const noCookie = await rawHandshake(h.port, socketPath(name), { early });
    expect(noCookie.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(noCookie.closedByServer).toBe(true);
    expect(noCookie.text).not.toContain('101 Switching Protocols');
    const junk = await rawHandshake(h.port, socketPath(name), { cookie: 'caw_00000000=x', early });
    expect(junk.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(junk.closedByServer).toBe(true);
    // a live cookie from another page: refused before the cookie is even read
    const foreign = await rawHandshake(h.port, socketPath(name), {
      cookie: h.cookie,
      origin: 'http://127.0.0.1:1',
      early,
    });
    expect(foreign.status).toBe(ERROR_HTTP_STATUS.origin_not_allowed);
    expect(foreign.closedByServer).toBe(true);
    expect(pty.written).toEqual([]);
    expect(await viewersOf(h, name)).toBe(0);

    // the control: the same bytes behind a handshake that is admitted are the first input of the session
    const admitted = await rawHandshake(h.port, socketPath(name), { cookie: h.cookie, early });
    expect(admitted.status).toBe(101);
    expect(admitted.closedByServer).toBe(false);
    await waitFor(() => pty.written.length === 1, { what: 'the early frame of the admitted socket' });
    expect(pty.writtenText).toBe('early input\r');
  });
});

describe('a restart', () => {
  it('TC-SEC-07: the cookie of the instance before a restart is 401 on the routes and on the upgrade, and an unspent code of it redeems nothing', async () => {
    const before = await startTerminalHarness();
    const old = await createSession(before);
    const oldCookie = before.cookie;
    const unspentCode = before.access.mint().code;
    // the cookie and the socket work before the restart
    expect((await before.http('GET', routes.terminalState.path)).status).toBe(200);
    const oldSocket = await before.ws(old.name);
    expect(oldSocket.ready.viewers).toBe(1);
    await before.close();

    // the same instance (same id, so the same cookie name) as a new process: nothing of the old access service is left
    const after = await startTerminalHarness();
    expect(after.cookie.slice(0, after.cookie.indexOf('='))).toBe(oldCookie.slice(0, oldCookie.indexOf('=')));
    const fresh = await createSession(after);
    // the new process numbers its sessions from the start: the old name names a live session again
    expect(fresh.name).toBe(old.name);

    const state = await after.http('GET', routes.terminalState.path, { cookie: oldCookie });
    expect(state.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(codeOf(state)).toBe('access_required');
    const session = await after.http('GET', routes.authSession.path, { cookie: oldCookie });
    expect(session.json).toEqual({ authenticated: false });
    const kill = await after.http('POST', buildPath(routes.terminalKillSession, { name: fresh.name }), {
      cookie: oldCookie,
    });
    expect(kill.status).toBe(ERROR_HTTP_STATUS.access_required);
    const upgrade = await RawWsClient.connect(after.port, {
      path: socketPath(fresh.name),
      cookie: oldCookie,
      origin: pageOrigin(after.port),
    });
    expect(upgrade.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(codeOf(upgrade)).toBe('access_required');
    expect(await viewersOf(after, fresh.name)).toBe(0);
    expect(fresh.pty.killCalls).toBe(0);
    expect(fresh.pty.written).toEqual([]);

    // TC-SEC-01: a code is never valid after a restart, and a refusal sets no cookie
    const redeemed = await postExchange(after.port, unspentCode);
    expect(redeemed.status).toBe(ERROR_HTTP_STATUS.access_code_invalid);
    expect(codeOf(redeemed)).toBe('access_code_invalid');
    expect(cookieFromReply(redeemed)).toBeNull();
    // the instance that runs now is unharmed: its own cookie and its own codes work
    expect((await after.http('GET', routes.terminalState.path)).status).toBe(200);
    expect((await postExchange(after.port, after.access.mint().code)).status).toBe(200);
    const own = await after.ws(fresh.name);
    expect(own.ready.viewers).toBe(1);
  });
});

describe('a credential that ends', () => {
  it('TC-SEC-03: a logout closes the sockets of that credential with 4003 and refuses its next handshake; the session and other credentials go on', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    const other = await mintAndExchange(h.port, h.access);
    const mine = [await h.ws(name), await h.ws(name)];
    const theirs = await h.ws(name, { cookie: other });

    const out = await h.http('POST', routes.authLogout.path);
    expect(out.status, out.body).toBe(200);
    for (const { client } of mine) {
      await waitFor(() => client.isClosed(), { what: 'the logout to close the socket of its credential' });
      expect(client.closeInfo()).toEqual({
        code: TERMINAL_CLOSE_CODES.signedOut,
        reason: TERMINAL_CLOSE_REASONS.signedOut,
      });
    }
    const again = await RawWsClient.connect(h.port, {
      path: socketPath(name),
      cookie: h.cookie,
      origin: pageOrigin(h.port),
    });
    expect(again.status).toBe(ERROR_HTTP_STATUS.access_required);

    // signing out is not a kill: the process runs, the other credential still watches and types
    expect(pty.exited).toBe(false);
    expect(pty.killCalls).toBe(0);
    expect(theirs.client.closeInfo()).toBeNull();
    pty.emitData('still here');
    await theirs.client.until('still here');
    theirs.client.sendBinary(Buffer.from('typed by the other\r'));
    await waitFor(() => pty.writtenText === 'typed by the other\r', { what: 'the input of the other credential' });
    await waitFor(async () => (await viewersOf(h, name, other)) === 1, { what: 'the signed-out viewers to leave' });
  });

  it('TC-SEC-03: a credential that expires loses its socket at the next tick of the gateway, without any request', async () => {
    const h = await startTerminalHarness({ limits: { socket: { pingIntervalMs: 40 } } });
    const { name, pty } = await createSession(h);
    const old = await h.ws(name);
    // a credential that was used later lives longer: half the idle limit passes, then another page signs in and watches
    const half = ACCESS_LIMITS.credentialIdleMs / 2;
    h.clock.advance(half);
    const younger = await mintAndExchange(h.port, h.access);
    const young = await h.ws(name, { cookie: younger });

    // the first credential has now been idle for the whole limit (an open socket is not a use), the second for half of it
    h.clock.advance(half + 1000);
    await waitFor(() => old.client.isClosed(), { what: 'the expiry to close the socket of the idle credential' });
    expect(old.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.signedOut);
    expect((await h.http('GET', routes.terminalState.path)).status).toBe(ERROR_HTTP_STATUS.access_required);
    // the younger credential and the process are untouched
    expect(young.client.closeInfo()).toBeNull();
    pty.emitData('after the expiry');
    await young.client.until('after the expiry');
    expect(pty.killCalls).toBe(0);
    expect(await viewersOf(h, name, younger)).toBe(1);
  });
});
