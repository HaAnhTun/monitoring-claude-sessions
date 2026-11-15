// The terminal REST routes over real HTTP (CAW-20, design 02 2.1, 8 and 10): a real instance and app with every guard of the app in
// front, the real access service and the auth routes, the terminal host replaced by `FakeTerminalPorts`. Every response is parsed
// with `routes.<id>.response`; every code a route can raise comes from a crafted request or from a thrown `TerminalError`; what the
// schemas refuse (a UNC folder, a traversal in a name) never reaches the port. The titles carry the ids of design 08 (TC-SEC, TC-WS).
import { readFileSync } from 'node:fs';
import { request as nodeRequest } from 'node:http';

import { ErrorEnvelopeSchema, routes, type ErrorCode } from '@mcs/shared';
import { httpRequest, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { mintAndExchange, pageOrigin, writeHeaders } from './helpers/auth.ts';
import {
  FAKE_SESSION_ID,
  FakeTerminalError,
  FakeTerminalPorts,
  startTerminalApp,
  stopTerminalApps,
  unavailableCapabilities,
  type TerminalApp,
} from './helpers/fake-terminal.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

// FIXTURE: invented data for tests
const FOLDER = 'C:\\work\\demo';
const SECRET_FOLDER = 'C:\\secret-folder\\project';
const SECRET_NAME = 'secret-name-1';

afterEach(stopTerminalApps);

interface Signed {
  readonly app: TerminalApp;
  readonly ports: FakeTerminalPorts;
  readonly cookie: string;
}

/** An app with a host, and the cookie of a page that exchanged an access code. */
async function signedIn(ports: FakeTerminalPorts | null = new FakeTerminalPorts()): Promise<Signed> {
  const app = await startTerminalApp({ ports });
  const cookie = await mintAndExchange(app.port, app.access);
  return { app, ports: ports ?? new FakeTerminalPorts(), cookie };
}

function codeOf(reply: HttpReply): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function get(s: Signed, path: string, cookie: string | null = s.cookie): Promise<HttpReply> {
  return httpRequest(s.app.port, path, { ...(cookie === null ? {} : { headers: { Cookie: cookie } }) });
}

function post(s: Signed, path: string, body: unknown = {}, cookie: string | null = s.cookie): Promise<HttpReply> {
  return httpRequest(s.app.port, path, {
    method: 'POST',
    headers: writeHeaders(cookie ?? undefined),
    origin: pageOrigin(s.app.port),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const killPath = (name: string): string => routes.terminalKillSession.path.replace(':name', name);

describe('the five routes with a signed-in page', () => {
  it('state, create, state, kill, state: each response fits its schema and the list follows', async () => {
    const s = await signedIn();
    const first = await get(s, routes.terminalState.path);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8');
    const empty = routes.terminalState.response.parse(JSON.parse(first.body));
    expect(empty.capabilities.available).toBe(true);
    expect(empty.sessions).toEqual([]);
    expect(empty.epoch).toBe(s.app.ctx.db.epoch);

    const created = await post(s, routes.terminalCreateSession.path, { path: FOLDER });
    expect(created.status).toBe(200);
    const { session } = routes.terminalCreateSession.response.parse(JSON.parse(created.body));
    expect(session.path).toBe(FOLDER);
    expect(s.ports.sessions.created).toEqual([{ path: FOLDER }]);

    const listed = routes.terminalState.response.parse(JSON.parse((await get(s, routes.terminalState.path)).body));
    expect(listed.sessions.map((row) => row.name)).toEqual([session.name]);

    const killed = await post(s, killPath(session.name));
    expect(killed.status).toBe(200);
    expect(routes.terminalKillSession.response.parse(JSON.parse(killed.body))).toEqual({ name: session.name });

    const after = routes.terminalState.response.parse(JSON.parse((await get(s, routes.terminalState.path)).body));
    expect(after.sessions).toEqual([]);
  });

  it('the folder dialog answers the chosen folder or null, and resume answers the row the host made', async () => {
    const s = await signedIn();
    s.ports.fakePicker.mode = FOLDER;
    const chosen = await post(s, routes.terminalPickFolder.path);
    expect(routes.terminalPickFolder.response.parse(JSON.parse(chosen.body))).toEqual({ path: FOLDER });
    s.ports.fakePicker.mode = null;
    const closed = await post(s, routes.terminalPickFolder.path);
    expect(routes.terminalPickFolder.response.parse(JSON.parse(closed.body))).toEqual({ path: null });

    const resumed = await post(s, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID, fork: true });
    expect(resumed.status).toBe(200);
    const { session } = routes.terminalResume.response.parse(JSON.parse(resumed.body));
    expect(session.link.sessionId).toBe(FAKE_SESSION_ID);
    expect(s.ports.resumed).toEqual([{ sessionId: FAKE_SESSION_ID, fork: true }]);
  });

  it('answers 405 with Allow to the wrong method on each path', async () => {
    const s = await signedIn();
    const cases: readonly (readonly [string, string, string])[] = [
      ['DELETE', routes.terminalCreateSession.path, 'POST'],
      ['GET', routes.terminalCreateSession.path, 'POST'],
      ['GET', killPath('demo-1'), 'POST'],
      ['GET', routes.terminalPickFolder.path, 'POST'],
      ['GET', routes.terminalResume.path, 'POST'],
      ['POST', routes.terminalState.path, 'GET, HEAD'],
    ];
    for (const [method, path, allow] of cases) {
      const reply = await httpRequest(s.app.port, path, {
        method,
        headers: writeHeaders(s.cookie),
        origin: pageOrigin(s.app.port),
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(reply.status, `${method} ${path}`).toBe(405);
      expect(codeOf(reply), `${method} ${path}`).toBe('method_not_allowed');
      expect(reply.headers['allow'], `${method} ${path}`).toBe(allow);
    }
    expect(s.ports.sessions.created).toEqual([]);
    expect(s.ports.sessions.killed).toEqual([]);
  });
});

describe('the codes of a thrown TerminalError reach the client through the whole chain', () => {
  it('create: folder_invalid 400, claude_not_found 503, terminal_unavailable 503, terminal_limit 429', async () => {
    const s = await signedIn();
    const cases: readonly (readonly [string, ErrorCode, number])[] = [
      ['folder_invalid', 'folder_invalid', 400],
      ['FOLDER_NOT_FOUND', 'folder_invalid', 400],
      ['claude_not_found', 'claude_not_found', 503],
      ['CLAUDE_NOT_FOUND', 'claude_not_found', 503],
      ['terminal_unavailable', 'terminal_unavailable', 503],
      ['NATIVE_LOAD_FAILED', 'terminal_unavailable', 503],
      ['terminal_limit', 'terminal_limit', 429],
      ['SESSION_LIMIT', 'terminal_limit', 429],
    ];
    for (const [thrown, code, status] of cases) {
      s.ports.sessions.createFailure = new FakeTerminalError(thrown);
      const reply = await post(s, routes.terminalCreateSession.path, { path: FOLDER });
      expect(reply.status, thrown).toBe(status);
      expect(codeOf(reply), thrown).toBe(code);
      expect(reply.headers['cache-control'], thrown).toBe('no-store');
    }
  });

  it('kill: terminal_not_found 404 for an unknown name and for a host that says so', async () => {
    const s = await signedIn();
    const unknown = await post(s, killPath('ghost-1'));
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('terminal_not_found');
    s.ports.addSession({ name: 'alpha-1' });
    s.ports.sessions.killFailure = new FakeTerminalError('SESSION_ENDED');
    expect(codeOf(await post(s, killPath('alpha-1')))).toBe('terminal_not_found');
  });

  it('resume: session_not_found, resume_unavailable with its details, folder_invalid, claude_not_found, terminal_limit', async () => {
    const s = await signedIn();
    const codes: readonly ErrorCode[] = [
      'session_not_found',
      'resume_unavailable',
      'folder_invalid',
      'claude_not_found',
      'terminal_unavailable',
      'terminal_limit',
    ];
    for (const code of codes) {
      s.ports.resumeFailure = new FakeTerminalError(code, [{ path: 'sessionId', issue: 'live_elsewhere' }]);
      const reply = await post(s, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID });
      expect(codeOf(reply), code).toBe(code);
      const error = ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error;
      expect(error.details, code).toEqual([{ path: 'sessionId', issue: 'live_elsewhere' }]);
      expect(reply.body, code).not.toContain(FAKE_SESSION_ID);
    }
  });

  it('pick-folder: picker_busy 409 for a second dialog while one is open, and the first one is not disturbed', async () => {
    const s = await signedIn();
    s.ports.fakePicker.hold = true;
    const body = '{}';
    const first = nodeRequest({
      host: '127.0.0.1',
      port: s.app.port,
      path: routes.terminalPickFolder.path,
      method: 'POST',
      agent: false,
      headers: {
        ...writeHeaders(s.cookie),
        Host: `127.0.0.1:${String(s.app.port)}`,
        Origin: pageOrigin(s.app.port),
        'Content-Length': String(Buffer.byteLength(body)),
      },
    });
    const answered = new Promise<string>((resolve, reject) => {
      first.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      first.once('error', reject);
    });
    first.end(body);
    await waitFor(() => s.ports.fakePicker.open, { what: 'the first dialog to open' });
    const second = await post(s, routes.terminalPickFolder.path);
    expect(second.status).toBe(409);
    expect(codeOf(second)).toBe('picker_busy');
    expect(s.ports.fakePicker.open).toBe(true);
    s.ports.fakePicker.settle(FOLDER);
    expect(JSON.parse(await answered)).toEqual({ path: FOLDER });
  });

  it('pick-folder: the dialog is told to close when the client leaves', async () => {
    const s = await signedIn();
    s.ports.fakePicker.hold = true;
    const body = '{}';
    const req = nodeRequest({
      host: '127.0.0.1',
      port: s.app.port,
      path: routes.terminalPickFolder.path,
      method: 'POST',
      agent: false,
      headers: {
        ...writeHeaders(s.cookie),
        Host: `127.0.0.1:${String(s.app.port)}`,
        Origin: pageOrigin(s.app.port),
        'Content-Length': String(Buffer.byteLength(body)),
      },
    });
    req.on('error', () => undefined);
    req.end(body);
    await waitFor(() => s.ports.fakePicker.open, { what: 'the dialog to open' });
    req.destroy();
    await waitFor(() => s.ports.fakePicker.aborted === 1, { what: 'the signal of the dialog to abort' });
    // a new dialog can open afterwards
    s.ports.fakePicker.hold = false;
    s.ports.fakePicker.mode = FOLDER;
    expect(JSON.parse((await post(s, routes.terminalPickFolder.path)).body)).toEqual({ path: FOLDER });
  });

  it('answers 500 internal_error with no detail for a failure that is not a TerminalError, and the instance goes on', async () => {
    const s = await signedIn();
    s.ports.sessions.createFailure = new Error(`boom in ${SECRET_FOLDER}`);
    const reply = await post(s, routes.terminalCreateSession.path, { path: FOLDER });
    expect(reply.status).toBe(500);
    expect(codeOf(reply)).toBe('internal_error');
    expect(reply.body).not.toContain('secret');
    expect((await get(s, routes.terminalState.path)).status).toBe(200);
  });
});

describe('what never reaches the port', () => {
  it('TC-SEC-21: a folder that is a UNC or device path, has a control character or is too long', async () => {
    const s = await signedIn();
    for (const bad of [
      '\\\\attacker\\share\\x',
      '//attacker/share/x',
      '\\\\?\\C:\\x',
      '\\\\.\\pipe\\x',
      'C:\\x\u0000y',
      `C:\\${'a'.repeat(1030)}`,
      '',
    ]) {
      const reply = await post(s, routes.terminalCreateSession.path, { path: bad });
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(codeOf(reply), JSON.stringify(bad)).toBe('validation_failed');
      expect(reply.body, JSON.stringify(bad)).not.toContain('attacker');
    }
    expect(s.ports.sessions.created).toEqual([]);
  });

  it('TC-SEC-20: a session name with a traversal, a separator, a NUL, a dot, a space, 65 characters or non-ASCII letters', async () => {
    const s = await signedIn();
    for (const name of [
      '..',
      '%2e%2e',
      '%2E%2E%2Fx',
      'a%2Fb',
      'a%5Cb',
      '%00',
      'a.b',
      'a%20b',
      'a'.repeat(65),
      '%E2%82%AC',
      '%FF',
    ]) {
      const reply = await post(s, killPath(name));
      expect(reply.status, name).toBe(400);
      expect(codeOf(reply), name).toBe('validation_failed');
    }
    expect(s.ports.sessions.killed).toEqual([]);
  });

  it('TC-SEC-23: a body that carries a command line, arguments or an environment, on create and on resume', async () => {
    const s = await signedIn();
    for (const body of [
      { path: FOLDER, command: 'cmd.exe /c calc' },
      { path: FOLDER, args: ['--dangerously-skip-permissions'] },
      { path: FOLDER, env: { NODE_OPTIONS: '--require x' } },
    ]) {
      expect(codeOf(await post(s, routes.terminalCreateSession.path, body))).toBe('validation_failed');
    }
    for (const body of [
      { sessionId: FAKE_SESSION_ID, command: 'cmd.exe' },
      { sessionId: FAKE_SESSION_ID, args: ['x'] },
      { sessionId: 'not-a-uuid' },
    ]) {
      expect(codeOf(await post(s, routes.terminalResume.path, body))).toBe('validation_failed');
    }
    expect(s.ports.sessions.created).toEqual([]);
    expect(s.ports.resumed).toEqual([]);
  });
});

describe('the guards in front of the routes (TC-SEC-02, TC-SEC-12, TC-SEC-14)', () => {
  it('TC-SEC-02: no cookie, a garbage cookie and a cookie of another instance are 401 access_required with the challenge', async () => {
    const s = await signedIn();
    const garbage = 'caw_11111111=not-a-credential';
    const other = s.cookie.replace('caw_11111111=', 'caw_22222222=');
    for (const cookie of [null, garbage, other]) {
      const state = await get(s, routes.terminalState.path, cookie);
      expect(state.status).toBe(401);
      expect(codeOf(state)).toBe('access_required');
      expect(state.headers['www-authenticate']).toBe('CAW-Access');
      for (const path of [
        routes.terminalCreateSession.path,
        killPath('alpha-1'),
        routes.terminalPickFolder.path,
        routes.terminalResume.path,
      ]) {
        const reply = await post(s, path, { path: FOLDER, sessionId: FAKE_SESSION_ID }, cookie);
        expect(reply.status, path).toBe(401);
        expect(codeOf(reply), path).toBe('access_required');
      }
    }
    expect(s.ports.sessions.created).toEqual([]);
    expect(s.ports.sessions.killed).toEqual([]);
    expect(s.ports.fakePicker.calls).toBe(0);
    expect(s.ports.resumed).toEqual([]);
  });

  it('TC-SEC-02: an expired credential is refused', async () => {
    const s = await signedIn();
    expect((await get(s, routes.terminalState.path)).status).toBe(200);
    s.app.clock.advance(25 * 60 * 60 * 1000);
    const reply = await get(s, routes.terminalState.path);
    expect(reply.status).toBe(401);
    expect(codeOf(reply)).toBe('access_required');
  });

  it('TC-SEC-12, TC-SEC-15: a write without the Origin of the page, or with a foreign one or another localhost port, is 403 origin_not_allowed', async () => {
    const s = await signedIn();
    for (const origin of [undefined, 'http://evil.example', 'null', 'http://127.0.0.1:1']) {
      const reply = await httpRequest(s.app.port, routes.terminalCreateSession.path, {
        method: 'POST',
        headers: writeHeaders(s.cookie),
        ...(origin === undefined ? {} : { origin }),
        body: JSON.stringify({ path: FOLDER }),
      });
      expect(reply.status, String(origin)).toBe(403);
      expect(codeOf(reply), String(origin)).toBe('origin_not_allowed');
    }
    expect(s.ports.sessions.created).toEqual([]);
  });

  it('TC-SEC-14: a write that is not JSON, or lacks X-MCS-Request, is 403 csrf_rejected or 415', async () => {
    const s = await signedIn();
    const body = JSON.stringify({ path: FOLDER });
    const plain = await httpRequest(s.app.port, routes.terminalCreateSession.path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-MCS-Request': '1', Cookie: s.cookie },
      origin: pageOrigin(s.app.port),
      body,
    });
    const noHeader = await httpRequest(s.app.port, routes.terminalCreateSession.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      origin: pageOrigin(s.app.port),
      body,
    });
    const form = await httpRequest(s.app.port, routes.terminalCreateSession.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MCS-Request': '1', Cookie: s.cookie },
      origin: pageOrigin(s.app.port),
      body: 'path=C%3A%5Cwork',
    });
    for (const reply of [plain, noHeader, form]) {
      expect([403, 415]).toContain(reply.status);
      expect(['csrf_rejected', 'unsupported_media_type']).toContain(codeOf(reply));
    }
    expect(s.ports.sessions.created).toEqual([]);
  });

  it('TC-SEC-22: a body over 4096 bytes is 413 payload_too_large and bad JSON is 400 body_invalid_json; the port is not asked', async () => {
    const s = await signedIn();
    const big = await post(s, routes.terminalCreateSession.path, JSON.stringify({ path: `C:\\${'a'.repeat(4100)}` }));
    expect(big.status).toBe(413);
    expect(codeOf(big)).toBe('payload_too_large');
    const bad = await post(s, routes.terminalCreateSession.path, '{ nope');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('body_invalid_json');
    expect(s.ports.sessions.created).toEqual([]);
  });
});

describe('an instance whose terminal cannot run (TC-WS-12)', () => {
  it('the state says why with an empty list, every other route answers terminal_unavailable, the instance stays healthy', async () => {
    const ports = new FakeTerminalPorts();
    ports.capabilitiesValue = unavailableCapabilities('addon_missing');
    const s = await signedIn(ports);
    const state = routes.terminalState.response.parse(JSON.parse((await get(s, routes.terminalState.path)).body));
    expect(state.capabilities).toEqual(unavailableCapabilities('addon_missing'));
    expect(state.sessions).toEqual([]);
    for (const [path, body] of [
      [routes.terminalCreateSession.path, { path: FOLDER }],
      [killPath('alpha-1'), {}],
      [routes.terminalPickFolder.path, {}],
      [routes.terminalResume.path, { sessionId: FAKE_SESSION_ID }],
    ] as const) {
      const reply = await post(s, path, body);
      expect(reply.status, path).toBe(503);
      expect(codeOf(reply), path).toBe('terminal_unavailable');
    }
    expect(ports.sessions.created).toEqual([]);
    expect(ports.sessions.killed).toEqual([]);
    expect(ports.fakePicker.calls).toBe(0);
    expect(ports.resumed).toEqual([]);
    expect((await httpRequest(s.app.port, '/api/v3/health')).status).toBe(200);
  });

  it('an instance with no host at all says not_configured', async () => {
    const s = await signedIn(null);
    const state = routes.terminalState.response.parse(JSON.parse((await get(s, routes.terminalState.path)).body));
    expect(state.capabilities.available).toBe(false);
    expect(state.capabilities.reason).toBe('not_configured');
    expect(codeOf(await post(s, routes.terminalCreateSession.path, { path: FOLDER }))).toBe('terminal_unavailable');
  });
});

describe('the log file (rule 7)', () => {
  it('never holds a folder, a session name, a session id, an access code or a credential', async () => {
    const s = await signedIn();
    const code = s.app.access.mint().code;
    const redeemed = await httpRequest(s.app.port, routes.authExchange.path, {
      method: 'POST',
      headers: writeHeaders(),
      origin: pageOrigin(s.app.port),
      body: JSON.stringify({ code }),
    });
    expect(redeemed.status).toBe(200);
    s.ports.addSession({ name: SECRET_NAME, path: SECRET_FOLDER });
    await post(s, routes.terminalCreateSession.path, { path: SECRET_FOLDER });
    s.ports.sessions.createFailure = new Error(`boom in ${SECRET_FOLDER} for ${SECRET_NAME}`);
    await post(s, routes.terminalCreateSession.path, { path: SECRET_FOLDER });
    await post(s, killPath(SECRET_NAME));
    await post(s, killPath('ghost-1'));
    s.ports.fakePicker.mode = SECRET_FOLDER;
    await post(s, routes.terminalPickFolder.path);
    s.ports.resumeFailure = new FakeTerminalError('SPAWN_FAILED');
    await post(s, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID });
    await get(s, routes.terminalState.path);
    await s.app.ctx.logger.close();
    const log = readFileSync(s.app.logFile, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    const credential = s.cookie.slice(s.cookie.indexOf('=') + 1);
    for (const secret of ['secret', FAKE_SESSION_ID, code, credential, 'ghost-1']) {
      expect(log, secret).not.toContain(secret);
    }
  });
});
