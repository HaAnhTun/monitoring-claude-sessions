// The security matrix over the real stack, cookie-jar half (CAW-57, design 08 section 3.6, ids TC-SEC-06 and 61): two user
// instances on one machine. A browser keeps cookies by host and not by port, so the pages of `127.0.0.1:<a>` and
// `127.0.0.1:<b>` share ONE jar and every request carries the cookies of both instances. Each of the two harnesses here is a
// whole instance of its own (its own id and so its own cookie name, its own access service, terminal service, home and port), and
// the tests send what that jar would send. What must hold: an instance reads only its own cookie name, the credential, the code
// and the sessions of one are worth nothing to the other, and signing out of one leaves the other signed in.
// The real-process variant (two started instances) is `sec-cross-instance.pty.test.ts`.
import type { FakePty } from '@mcs/engine/testing';
import {
  CreateSessionResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TERMINAL_CLOSE_CODES,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
} from '@mcs/shared';
import { RawWsClient, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { cookieName } from '../../src/http/cookie.ts';
import { cookieFromReply, pageOrigin, postExchange } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

// FIXTURE: invented instance ids; they differ in the first eight characters, which name the cookie
const INSTANCE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const INSTANCE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

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

const valueOf = (cookie: string): string => cookie.slice(cookie.indexOf('=') + 1);
const socketPath = (name: string): string => buildPath(routes.terminalSocket, { name });
const killPath = (name: string): string => buildPath(routes.terminalKillSession, { name });

async function signedIn(h: TerminalHarness, jar: string | null): Promise<boolean> {
  const reply = await h.http('GET', routes.authSession.path, { cookie: jar });
  expect(reply.status).toBe(200);
  const state = await h.http('GET', routes.terminalState.path, { cookie: jar });
  const authenticated = Reflect.get(Object(reply.json), 'authenticated') === true;
  // the two answers of an instance agree: the session route says what the terminal routes do
  expect(state.status).toBe(authenticated ? 200 : ERROR_HTTP_STATUS.access_required);
  return authenticated;
}

async function startTwo(): Promise<{ a: TerminalHarness; b: TerminalHarness }> {
  const a = await startTerminalHarness({ instanceId: INSTANCE_A });
  const b = await startTerminalHarness({ instanceId: INSTANCE_B });
  expect(a.port).not.toBe(b.port);
  expect(a.cookie.startsWith(`${cookieName(INSTANCE_A)}=`)).toBe(true);
  expect(b.cookie.startsWith(`${cookieName(INSTANCE_B)}=`)).toBe(true);
  expect(cookieName(INSTANCE_A)).not.toBe(cookieName(INSTANCE_B));
  return { a, b };
}

describe('two instances in one cookie jar', () => {
  it('TC-SEC-06: each instance reads only its own cookie name, in any order of the jar, and the cookie of the other alone is 401', async () => {
    const { a, b } = await startTwo();
    // the jar of the browser: both cookies travel to both ports
    for (const jar of [`${a.cookie}; ${b.cookie}`, `${b.cookie}; ${a.cookie}`]) {
      expect(await signedIn(a, jar)).toBe(true);
      expect(await signedIn(b, jar)).toBe(true);
    }
    // one cookie alone signs in to its own instance only
    expect(await signedIn(a, a.cookie)).toBe(true);
    expect(await signedIn(b, a.cookie)).toBe(false);
    expect(await signedIn(b, b.cookie)).toBe(true);
    expect(await signedIn(a, b.cookie)).toBe(false);

    // a credential is the instance's own: under the name of the other instance it is still nothing there
    const aValueUnderB = `${cookieName(INSTANCE_B)}=${valueOf(a.cookie)}`;
    const bValueUnderA = `${cookieName(INSTANCE_A)}=${valueOf(b.cookie)}`;
    expect(await signedIn(b, aValueUnderB)).toBe(false);
    expect(await signedIn(a, bValueUnderA)).toBe(false);
    // and a wrong value under the own name is not rescued by the right value under the other name
    expect(await signedIn(a, `${bValueUnderA}; ${cookieName(INSTANCE_B)}=${valueOf(a.cookie)}`)).toBe(false);
    // junk under the other name does not disturb the own cookie
    expect(await signedIn(a, `${cookieName(INSTANCE_B)}=junk; ${a.cookie}`)).toBe(true);

    // the refusal is the full one: 401 with the challenge on a write, and the socket is not opened
    const session = await createSession(a);
    const kill = await a.http('POST', killPath(session.name), { cookie: b.cookie });
    expect(kill.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(codeOf(kill)).toBe('access_required');
    expect(kill.headers['www-authenticate']).toBeDefined();
    const upgrade = await RawWsClient.connect(a.port, {
      path: socketPath(session.name),
      cookie: b.cookie,
      origin: pageOrigin(a.port),
    });
    expect(upgrade.status).toBe(ERROR_HTTP_STATUS.access_required);
    expect(session.pty.killCalls).toBe(0);
    // with the whole jar the socket of A opens, on A
    const opened = await a.ws(session.name, { cookie: `${b.cookie}; ${a.cookie}` });
    expect(opened.ready.viewers).toBe(1);
  });

  it('TC-SEC-61: the two instances share no session, no code and no sign-out', async () => {
    const { a, b } = await startTwo();
    const jar = `${a.cookie}; ${b.cookie}`;
    const onA = await createSession(a);
    const onB = await createSession(b);
    // both instances number their sessions alike: the same name is two different processes
    expect(onB.name).toBe(onA.name);
    expect(onB.pty).not.toBe(onA.pty);

    // input and a kill reach the session of the instance that was asked, never its namesake
    const viewA = await a.ws(onA.name, { cookie: jar });
    const viewB = await b.ws(onB.name, { cookie: jar });
    viewA.client.sendBinary(Buffer.from('for A\r'));
    await waitFor(() => onA.pty.writtenText === 'for A\r', { what: 'the input to reach the session of A' });
    expect(onB.pty.written).toEqual([]);
    onB.pty.emitData('printed by B');
    await viewB.client.until('printed by B');
    expect(viewA.client.collected().length).toBe(0);
    expect((await b.http('POST', killPath(onB.name), { cookie: jar })).status).toBe(200);
    expect(onB.pty.killCalls).toBe(1);
    expect(onA.pty.killCalls).toBe(0);
    expect(onA.pty.exited).toBe(false);
    const listed = async (h: TerminalHarness): Promise<string[]> =>
      TerminalStateSchema.parse((await h.http('GET', routes.terminalState.path, { cookie: jar })).json).sessions.map(
        (session) => session.name,
      );
    expect(await listed(a)).toEqual([onA.name]);
    expect(await listed(b)).toEqual([]);
    // the socket of A never heard of the kill on B
    expect(viewA.client.closeInfo()).toBeNull();

    // a code of A redeems nothing on B, and B's refusal does not spend it: A still takes it, once
    const code = a.access.mint().code;
    const onWrongInstance = await postExchange(b.port, code);
    expect(onWrongInstance.status).toBe(ERROR_HTTP_STATUS.access_code_invalid);
    expect(cookieFromReply(onWrongInstance)).toBeNull();
    const redeemed = await postExchange(a.port, code);
    expect(redeemed.status).toBe(200);
    // the new cookie carries A's name only, whatever the jar held
    expect(cookieFromReply(redeemed)?.startsWith(`${cookieName(INSTANCE_A)}=`)).toBe(true);
    expect(redeemed.headers['set-cookie']).not.toContain(cookieName(INSTANCE_B));
    expect((await postExchange(a.port, code)).status).toBe(ERROR_HTTP_STATUS.access_code_invalid);

    // signing out of A with the whole jar: A clears its own name, closes its own socket, and B stays signed in
    const out = await a.http('POST', routes.authLogout.path, { cookie: jar });
    expect(out.status, out.body).toBe(200);
    expect(out.headers['set-cookie']).toContain(`${cookieName(INSTANCE_A)}=;`);
    expect(out.headers['set-cookie']).not.toContain(cookieName(INSTANCE_B));
    await waitFor(() => viewA.client.isClosed(), { what: 'the sign-out of A to close the socket of A' });
    expect(viewA.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.signedOut);
    expect(await signedIn(a, jar)).toBe(false);
    expect(await signedIn(b, jar)).toBe(true);
    // the session of A outlives the sign-out; nobody on B can reach it
    expect(onA.pty.exited).toBe(false);
    expect(codeOf(await b.http('POST', killPath(onA.name), { cookie: jar }))).toBe('terminal_not_found');
    expect(onA.pty.killCalls).toBe(0);
  });
});
