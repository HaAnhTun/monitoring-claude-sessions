// The terminal routes (CAW-20, design 02 2.1 and 8) over a fake terminal host: what each handler asks of the port, what it answers
// (every body is parsed with `routes.<id>.response`), every code of the catalogue that a thrown `TerminalError` becomes, that a
// session name or a folder that the schemas refuse never reaches the port, and that nothing is logged. The guards of the whole app
// and the real access service are covered by `test/terminal/terminal-routes.int.test.ts`.
import { createServer, request as httpRequestRaw, type Server } from 'node:http';

import type { AccessService, Logger } from '@mcs/engine';
import { ErrorEnvelopeSchema, TERMINAL_ERROR_CODES, routes, type ErrorCode } from '@mcs/shared';
import { allocatePort, assertPortClosed, httpRequest, waitFor } from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_SESSION_ID,
  FakeTerminalError,
  FakeTerminalPorts,
  availableCapabilities,
  sessionInfo,
  unavailableCapabilities,
} from '../../test/terminal/helpers/fake-terminal.ts';
import { createAccessVerifier } from '../http/access-guard.ts';
import { cookieName } from '../http/cookie.ts';
import { bindRouteServices, type RouteDeps } from '../route-adapter.ts';
import { createTerminalRoutes } from './terminal.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const CREDENTIAL = 'cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXU';
const COOKIE = `${cookieName(INSTANCE)}=${CREDENTIAL}`;
const EPOCH = 'a1b2c3d4';
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const FOLDER = 'C:\\work\\demo';
const SECRET_FOLDER = 'C:\\secret-folder\\project';
const SECRET_NAME = 'secret-name-1';

const access: Pick<AccessService, 'verify' | 'verifyBearer'> = {
  verify: (credential) => (credential === CREDENTIAL ? { credentialId: 'session-fixture-1', expiresAtMs: 1 } : null),
  verifyBearer: () => false,
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

interface Harness {
  readonly port: number;
  readonly ports: FakeTerminalPorts;
  readonly logs: string[];
}

/** The terminal routes on an Express app with the bindings of a user instance; no other guard of the app is in front. */
async function start(ports: FakeTerminalPorts | null = new FakeTerminalPorts()): Promise<Harness> {
  const logs: string[] = [];
  const log =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      logs.push(JSON.stringify({ level, event, fields }));
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
    access: { verifier: createAccessVerifier(access, INSTANCE), port: () => port },
  });
  const deps = { ctx: { logger }, nudge: () => undefined, task: null } as unknown as RouteDeps;
  createTerminalRoutes({ ports, epoch: EPOCH, now: () => NOW })(app, deps);
  const server = createServer(app);
  port = await allocatePort();
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  servers.push({ server, port });
  return { port, ports: ports ?? new FakeTerminalPorts(), logs };
}

const origin = (port: number): string => `http://127.0.0.1:${String(port)}`;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };

function codeOf(reply: HttpReply): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function get(h: Harness, path: string, cookie: string | null = COOKIE): Promise<HttpReply> {
  return httpRequest(h.port, path, { ...(cookie === null ? {} : { headers: { Cookie: cookie } }) });
}

function post(h: Harness, path: string, body: unknown = {}, cookie: string | null = COOKIE): Promise<HttpReply> {
  return httpRequest(h.port, path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(cookie === null ? {} : { Cookie: cookie }) },
    origin: origin(h.port),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const killPath = (name: string): string => routes.terminalKillSession.path.replace(':name', name);

describe('GET /terminal/state', () => {
  it('lists the capabilities, the sessions, the epoch and the time, and the body fits its schema', async () => {
    const h = await start();
    h.ports.addSession({ name: 'alpha-1' });
    h.ports.addSession({ name: 'beta-1', path: 'C:\\work\\beta' });
    const reply = await get(h, routes.terminalState.path);
    expect(reply.status).toBe(200);
    const body = routes.terminalState.response.parse(JSON.parse(reply.body));
    expect(body.capabilities).toEqual(availableCapabilities());
    expect(body.sessions.map((s) => s.name)).toEqual(['alpha-1', 'beta-1']);
    expect(body.epoch).toBe(EPOCH);
    expect(body.generatedAt).toBe('2026-10-11T14:05:07.000Z');
  });

  it('TC-WS-12: says that nothing can run, and lists no session, when the instance has no host at all', async () => {
    const h = await start(null);
    const reply = await get(h, routes.terminalState.path);
    expect(reply.status).toBe(200);
    const body = routes.terminalState.response.parse(JSON.parse(reply.body));
    expect(body.capabilities).toEqual({
      available: false,
      reason: 'not_configured',
      folderPicker: false,
      resume: false,
      maxSessions: 0,
    });
    expect(body.sessions).toEqual([]);
  });

  it('TC-WS-12: passes the reason of a host that cannot run a terminal and lists no session', async () => {
    const h = await start();
    h.ports.addSession();
    h.ports.capabilitiesValue = unavailableCapabilities('addon_missing');
    const body = routes.terminalState.response.parse(JSON.parse((await get(h, routes.terminalState.path)).body));
    expect(body.capabilities.available).toBe(false);
    expect(body.capabilities.reason).toBe('addon_missing');
    expect(body.sessions).toEqual([]);
  });

  it('refuses a request without the cookie with 401 access_required and never asks the host', async () => {
    const h = await start();
    const reply = await get(h, routes.terminalState.path, null);
    expect(reply.status).toBe(401);
    expect(codeOf(reply)).toBe('access_required');
    expect(h.ports.capabilityReads).toBe(0);
  });
});

describe('POST /terminal/sessions', () => {
  it('starts a session in the folder and answers with the row the host made', async () => {
    const h = await start();
    const reply = await post(h, routes.terminalCreateSession.path, { path: FOLDER });
    expect(reply.status).toBe(200);
    const body = routes.terminalCreateSession.response.parse(JSON.parse(reply.body));
    expect(body.session.name).toBe('demo-1');
    expect(body.session.path).toBe(FOLDER);
    expect(h.ports.sessions.created).toEqual([{ path: FOLDER }]);
  });

  it('answers terminal_unavailable without asking the host to start anything', async () => {
    const none = await start(null);
    const reply = await post(none, routes.terminalCreateSession.path, { path: FOLDER });
    expect(reply.status).toBe(503);
    expect(codeOf(reply)).toBe('terminal_unavailable');
    const off = await start();
    off.ports.capabilitiesValue = unavailableCapabilities();
    expect(codeOf(await post(off, routes.terminalCreateSession.path, { path: FOLDER }))).toBe('terminal_unavailable');
    expect(off.ports.sessions.created).toEqual([]);
  });

  it('never lets a UNC path, a device path, a control character, an empty or a long path reach the host', async () => {
    const h = await start();
    for (const bad of [
      '\\\\host\\share\\x',
      '//host/share/x',
      '\\\\?\\C:\\x',
      '\\\\.\\pipe\\x',
      '\\??\\C:\\x',
      'C:\\x\u0000y',
      'C:\\x\ny',
      '',
      `C:\\${'a'.repeat(1030)}`,
    ]) {
      const reply = await post(h, routes.terminalCreateSession.path, { path: bad });
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(codeOf(reply), JSON.stringify(bad)).toBe('validation_failed');
      expect(reply.body, JSON.stringify(bad)).not.toContain('host');
    }
    expect(h.ports.sessions.created).toEqual([]);
  });

  it('refuses a body that carries more than the folder (a command line, arguments, an environment)', async () => {
    const h = await start();
    for (const body of [
      { path: FOLDER, command: 'cmd.exe' },
      { path: FOLDER, args: ['--dangerous'] },
      { path: FOLDER, env: { A: 'b' } },
      {},
      { path: 42 },
      [],
    ]) {
      const reply = await post(h, routes.terminalCreateSession.path, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(reply)).toBe('validation_failed');
    }
    expect(h.ports.sessions.created).toEqual([]);
  });

  it('turns every code a TerminalError carries into the code of the catalogue (the vocabulary of the catalogue and the engine)', async () => {
    const h = await start();
    const mapped: readonly (readonly [string, ErrorCode])[] = [
      ['folder_invalid', 'folder_invalid'],
      ['claude_not_found', 'claude_not_found'],
      ['terminal_unavailable', 'terminal_unavailable'],
      ['terminal_limit', 'terminal_limit'],
      ['FOLDER_INVALID', 'folder_invalid'],
      ['FOLDER_NOT_FOUND', 'folder_invalid'],
      ['CLAUDE_NOT_FOUND', 'claude_not_found'],
      ['SESSION_LIMIT', 'terminal_limit'],
      ['UNSUPPORTED_OS', 'terminal_unavailable'],
      ['NATIVE_MISSING', 'terminal_unavailable'],
    ];
    for (const [thrown, expected] of mapped) {
      h.ports.sessions.createFailure = new FakeTerminalError(thrown);
      const reply = await post(h, routes.terminalCreateSession.path, { path: FOLDER });
      expect(codeOf(reply), thrown).toBe(expected);
    }
    expect(h.ports.sessions.created).toHaveLength(mapped.length);
  });

  it('answers 500 internal_error, with no detail, for a failure that is not a TerminalError', async () => {
    const h = await start();
    h.ports.sessions.createFailure = new Error(`boom in ${SECRET_FOLDER}`);
    const reply = await post(h, routes.terminalCreateSession.path, { path: FOLDER });
    expect(reply.status).toBe(500);
    expect(codeOf(reply)).toBe('internal_error');
    expect(reply.body).not.toContain('secret');
  });

  it('refuses a request without the cookie before the body is read, and the host is not asked', async () => {
    const h = await start();
    const reply = await post(h, routes.terminalCreateSession.path, { path: FOLDER }, null);
    expect(reply.status).toBe(401);
    expect(codeOf(reply)).toBe('access_required');
    expect(h.ports.sessions.created).toEqual([]);
  });
});

describe('POST /terminal/sessions/:name/kill', () => {
  it('kills a live session and answers with its name', async () => {
    const h = await start();
    h.ports.addSession({ name: 'alpha-1' });
    const reply = await post(h, killPath('alpha-1'));
    expect(reply.status).toBe(200);
    expect(routes.terminalKillSession.response.parse(JSON.parse(reply.body))).toEqual({ name: 'alpha-1' });
    expect(h.ports.sessions.killed).toEqual(['alpha-1']);
    expect(h.ports.sessions.list()).toEqual([]);
  });

  it('answers 404 terminal_not_found for a name nobody holds', async () => {
    const h = await start();
    const reply = await post(h, killPath('ghost-1'));
    expect(reply.status).toBe(404);
    expect(codeOf(reply)).toBe('terminal_not_found');
    expect(reply.body).not.toContain('ghost-1');
  });

  it('never lets a name that breaks the pattern reach the host', async () => {
    const h = await start();
    for (const name of ['..', '%2e%2e', 'a%2Fb', 'a%5Cb', '%00', 'a.b', 'a%20b', 'a'.repeat(65), '%E2%82%AC']) {
      const reply = await post(h, killPath(name));
      expect(reply.status, name).toBe(400);
      expect(codeOf(reply), name).toBe('validation_failed');
    }
    expect(h.ports.sessions.killed).toEqual([]);
  });

  it('turns a TerminalError of the host into its code and keeps every other session', async () => {
    const h = await start();
    h.ports.addSession({ name: 'alpha-1' });
    h.ports.sessions.killFailure = new FakeTerminalError('SESSION_NOT_FOUND');
    const reply = await post(h, killPath('alpha-1'));
    expect(codeOf(reply)).toBe('terminal_not_found');
    expect(h.ports.sessions.list()).toHaveLength(1);
  });

  it('answers terminal_unavailable when the host cannot run a terminal', async () => {
    const h = await start();
    h.ports.capabilitiesValue = unavailableCapabilities();
    expect(codeOf(await post(h, killPath('alpha-1')))).toBe('terminal_unavailable');
    expect(h.ports.sessions.killed).toEqual([]);
  });
});

describe('POST /terminal/pick-folder', () => {
  it('answers with the folder the person chose, or null when the dialog was closed', async () => {
    const h = await start();
    h.ports.fakePicker.mode = FOLDER;
    const chosen = await post(h, routes.terminalPickFolder.path);
    expect(chosen.status).toBe(200);
    expect(routes.terminalPickFolder.response.parse(JSON.parse(chosen.body))).toEqual({ path: FOLDER });
    h.ports.fakePicker.mode = null;
    const closed = await post(h, routes.terminalPickFolder.path);
    expect(routes.terminalPickFolder.response.parse(JSON.parse(closed.body))).toEqual({ path: null });
    expect(h.ports.fakePicker.calls).toBe(2);
  });

  it('answers terminal_unavailable when there is no dialog, or no usable host, and opens none', async () => {
    const h = await start();
    h.ports.hasPicker = false;
    const reply = await post(h, routes.terminalPickFolder.path);
    expect(reply.status).toBe(503);
    expect(codeOf(reply)).toBe('terminal_unavailable');
    const off = await start();
    off.ports.capabilitiesValue = unavailableCapabilities();
    expect(codeOf(await post(off, routes.terminalPickFolder.path))).toBe('terminal_unavailable');
    expect(off.ports.fakePicker.calls).toBe(0);
  });

  it('answers 409 picker_busy when the host says a dialog is open', async () => {
    const h = await start();
    h.ports.fakePicker.failure = new FakeTerminalError('picker_busy');
    const reply = await post(h, routes.terminalPickFolder.path);
    expect(reply.status).toBe(409);
    expect(codeOf(reply)).toBe('picker_busy');
  });

  it('hands the dialog a signal that aborts when the client leaves', async () => {
    const h = await start();
    h.ports.fakePicker.hold = true;
    const body = '{}';
    const req = httpRequestRaw({
      host: '127.0.0.1',
      port: h.port,
      path: routes.terminalPickFolder.path,
      method: 'POST',
      agent: false,
      headers: {
        ...JSON_HEADERS,
        Cookie: COOKIE,
        Host: `127.0.0.1:${String(h.port)}`,
        Origin: origin(h.port),
        'Content-Length': String(Buffer.byteLength(body)),
      },
    });
    req.on('error', () => undefined);
    req.end(body);
    await waitFor(() => h.ports.fakePicker.open, { what: 'the dialog to open' });
    expect(h.ports.fakePicker.aborted).toBe(0);
    req.destroy();
    await waitFor(() => h.ports.fakePicker.aborted === 1, { what: 'the signal to abort' });
  });
});

describe('POST /terminal/resume', () => {
  it('resumes by session id, without a fork unless asked, and answers with the row the host made', async () => {
    const h = await start();
    const reply = await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID });
    expect(reply.status).toBe(200);
    const body = routes.terminalResume.response.parse(JSON.parse(reply.body));
    expect(body.session.link.sessionId).toBe(FAKE_SESSION_ID);
    await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID, fork: true });
    await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID, fork: false });
    expect(h.ports.resumed).toEqual([
      { sessionId: FAKE_SESSION_ID, fork: false },
      { sessionId: FAKE_SESSION_ID, fork: true },
      { sessionId: FAKE_SESSION_ID, fork: false },
    ]);
  });

  it('turns every code a TerminalError carries into its code, with the details the host gave', async () => {
    const h = await start();
    const codes: readonly ErrorCode[] = [
      'session_not_found',
      'resume_unavailable',
      'folder_invalid',
      'claude_not_found',
      'terminal_unavailable',
      'terminal_limit',
    ];
    for (const code of codes) {
      h.ports.resumeFailure = new FakeTerminalError(code, [{ path: 'sessionId', issue: 'live_elsewhere' }]);
      const reply = await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID });
      expect(codeOf(reply), code).toBe(code);
      const error = ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error;
      expect(error.details, code).toEqual([{ path: 'sessionId', issue: 'live_elsewhere' }]);
    }
  });

  it('refuses a body that carries a command line, an extra key, a bad id or a bad flag', async () => {
    const h = await start();
    for (const body of [
      { sessionId: FAKE_SESSION_ID, command: 'cmd.exe' },
      { sessionId: FAKE_SESSION_ID, args: ['x'] },
      { sessionId: '../x' },
      { sessionId: FAKE_SESSION_ID, fork: 'yes' },
      {},
    ]) {
      const reply = await post(h, routes.terminalResume.path, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(reply)).toBe('validation_failed');
    }
    expect(h.ports.resumed).toEqual([]);
  });

  it('answers terminal_unavailable when the host cannot run a terminal', async () => {
    const h = await start(null);
    expect(codeOf(await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID }))).toBe(
      'terminal_unavailable',
    );
  });
});

describe('the access chain', () => {
  it('TC-SEC-02: refuses all five routes without the cookie, with a wrong cookie and with another instance cookie', async () => {
    const h = await start();
    const other = `${cookieName('22222222-2222-4222-8222-222222222222')}=${CREDENTIAL}`;
    const wrong = `${cookieName(INSTANCE)}=${'x'.repeat(43)}`;
    for (const cookie of [null, wrong, other]) {
      expect(codeOf(await get(h, routes.terminalState.path, cookie))).toBe('access_required');
      for (const path of [
        routes.terminalCreateSession.path,
        killPath('alpha-1'),
        routes.terminalPickFolder.path,
        routes.terminalResume.path,
      ]) {
        expect(codeOf(await post(h, path, {}, cookie)), path).toBe('access_required');
      }
    }
    expect(h.ports.sessions.created).toEqual([]);
    expect(h.ports.sessions.killed).toEqual([]);
    expect(h.ports.fakePicker.calls).toBe(0);
    expect(h.ports.resumed).toEqual([]);
  });

  it('refuses a write without the Origin of the page', async () => {
    const h = await start();
    const reply = await httpRequest(h.port, routes.terminalCreateSession.path, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: COOKIE },
      body: JSON.stringify({ path: FOLDER }),
    });
    expect(reply.status).toBe(403);
    expect(codeOf(reply)).toBe('origin_not_allowed');
    expect(h.ports.sessions.created).toEqual([]);
  });
});

describe('what the log may say (rule 7)', () => {
  it('writes no folder path and no session name, on success or on failure', async () => {
    const h = await start();
    h.ports.addSession({ name: SECRET_NAME, path: SECRET_FOLDER });
    await get(h, routes.terminalState.path);
    await post(h, routes.terminalCreateSession.path, { path: SECRET_FOLDER });
    h.ports.sessions.createFailure = new Error(`boom in ${SECRET_FOLDER} for ${SECRET_NAME}`);
    await post(h, routes.terminalCreateSession.path, { path: SECRET_FOLDER });
    await post(h, killPath(SECRET_NAME));
    await post(h, killPath('ghost-1'));
    h.ports.fakePicker.mode = SECRET_FOLDER;
    await post(h, routes.terminalPickFolder.path);
    h.ports.resumeFailure = new FakeTerminalError('SPAWN_FAILED');
    await post(h, routes.terminalResume.path, { sessionId: FAKE_SESSION_ID });
    const text = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0); // the unexpected failures are logged by the adapter, with the route id
    expect(text).not.toContain('secret');
    expect(text).not.toContain(FAKE_SESSION_ID);
  });
});

describe('the vocabulary', () => {
  it('has a route that can raise every code of TERMINAL_ERROR_CODES', () => {
    const raised = new Set<string>([
      ...routes.terminalCreateSession.errors,
      ...routes.terminalKillSession.errors,
      ...routes.terminalPickFolder.errors,
      ...routes.terminalResume.errors,
    ]);
    for (const code of TERMINAL_ERROR_CODES) expect(raised.has(code), code).toBe(true);
  });
});

describe('a session row', () => {
  it('is what the host lists, with the viewers it counts', async () => {
    const h = await start();
    const session = h.ports.addSession({ name: 'alpha-1' });
    session.attach({ onData: () => undefined, onSize: () => undefined, onExit: () => undefined });
    const body = routes.terminalState.response.parse(JSON.parse((await get(h, routes.terminalState.path)).body));
    expect(body.sessions[0]).toEqual({ ...sessionInfo({ name: 'alpha-1' }), viewers: 1 });
  });
});
