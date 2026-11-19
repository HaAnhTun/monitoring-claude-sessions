// The security matrix of the terminal over real HTTP (CAW-32, design 02 section 10, design 08 section 3.6, ADR 0084, 0085): a real
// instance, database, app and access service, with the terminal side built by `createTerminalServer` exactly as the boot code builds
// it, a scriptable fake terminal host and the raw clients of the testkit. The matrix runs for every route of `ACCESS_POLICY` that is
// not open and for the socket: cookie states, `Origin`, `Host`, fetch metadata, the CSRF header, body limits, name and path attacks,
// the exchange and its limiter, cookie attributes, two instances in one jar, the reader routes with the control token, a task
// instance, and that no secret reaches the log file. Ids of design 08: TC-SEC-01 to 06, 08, 11 to 16, 19 to 22, 60 and 61.
// Every name, folder and code in here is invented; a failure message names a status or a route id, never a value.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import path from 'node:path';

import {
  buildInstanceContext,
  createAccessService,
  createLogger,
  defaultSkillDir,
  initWorkspace,
  type AccessService,
  type FolderService,
  type InstanceContext,
} from '@mcs/engine';
import {
  ACCESS_POLICY,
  ErrorEnvelopeSchema,
  RUNTIME_VERSION,
  WRITE_ROUTE_IDS,
  buildPath,
  routes,
  type ErrorCode,
  type RouteId,
} from '@mcs/shared';
import {
  FakeClock,
  RawWsClient,
  allocatePort,
  assertPortClosed,
  httpRequest,
  openTerminalSocket,
  useTempDirs,
  waitFor,
  type TempDir,
} from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp, createHttpServer } from '../../src/app.ts';
import { createAccessVerifier } from '../../src/http/access-guard.ts';
import { clearCookieHeader, cookieName, setCookieHeader } from '../../src/http/cookie.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';
import { createTerminalServer, type TerminalServer } from '../../src/terminal/index.ts';
import { cookieFromReply, mintAndExchange, pageOrigin, postExchange, writeHeaders } from './helpers/auth.ts';
import { FAKE_INSTANCE_ID, FakeTerminalPorts } from './helpers/fake-terminal.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const START = Date.UTC(2026, 9, 11, 14, 5, 7);
// FIXTURE: invented data for tests
const OTHER_INSTANCE = '22222222-2222-4222-8222-222222222222';
const CONTROL_TOKEN = 'ab'.repeat(32);
const SESSION_NAME = 'quartz-session-1';
const SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const FOLDER = 'C:\\work\\demo';
const CANARY_FOLDER = 'C:\\work\\canary-folder-7f3a91';
const DAY_MS = 86_400_000;

interface FakeFolders {
  readonly list: ReturnType<typeof vi.fn>;
  readonly add: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly resumeEligibility: ReturnType<typeof vi.fn>;
}

interface Stack {
  readonly port: number;
  readonly instanceId: string;
  readonly clock: FakeClock;
  readonly access: AccessService;
  readonly ports: FakeTerminalPorts;
  readonly folders: FakeFolders;
  readonly logFile: string;
  readonly spies: {
    readonly get: ReturnType<typeof vi.spyOn>;
    readonly create: ReturnType<typeof vi.spyOn>;
    readonly kill: ReturnType<typeof vi.spyOn>;
    readonly pick: ReturnType<typeof vi.spyOn>;
    readonly resume: ReturnType<typeof vi.spyOn>;
  };
  /** Every code, credential and cookie the test handled: the log must hold none of them. */
  readonly secrets: string[];
}

const running: { stack: Stack; terminal: TerminalServer | null; close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const entry of running.splice(0)) await entry.close();
});

/** Starts one instance. `kind: 'task'` is an app without an access service and without any terminal module (a task instance). */
async function startStack(options: { kind?: 'user' | 'task'; instanceId?: string } = {}): Promise<Stack> {
  const kind = options.kind ?? 'user';
  const instanceId = options.instanceId ?? FAKE_INSTANCE_ID;
  const temp: TempDir = makeTemp('terminal-security-int');
  const root = temp.path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(START);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => instanceId });
  const logFile = path.join(root, 'runtime.log');
  const logger = createLogger({ file: logFile, level: 'debug', rotate: false, clock });
  const ctx: InstanceContext = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger,
  });
  const access = createAccessService({ clock, controlToken: CONTROL_TOKEN });
  const ports = new FakeTerminalPorts();
  ports.addSession({ name: SESSION_NAME, path: FOLDER });
  const folders: FakeFolders = {
    list: vi.fn(() => ({ folders: [], generatedAt: '2026-10-11T14:05:07.000Z' })),
    add: vi.fn(() => Promise.reject(new Error('unused'))),
    remove: vi.fn(() => Promise.reject(new Error('unused'))),
    resumeEligibility: vi.fn(() => Promise.reject(new Error('unused'))),
  };
  const spies = {
    get: vi.spyOn(ports.sessions, 'get'),
    create: vi.spyOn(ports.sessions, 'create'),
    kill: vi.spyOn(ports.sessions, 'kill'),
    pick: vi.spyOn(ports.fakePicker, 'pick'),
    resume: vi.spyOn(ports, 'resume'),
  };
  const port = await allocatePort();
  const terminal =
    kind === 'user'
      ? createTerminalServer({
          ctx,
          ports,
          access,
          folders: folders as unknown as Pick<FolderService, 'list' | 'add' | 'remove' | 'resumeEligibility'>,
          logger,
        })
      : null;
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    ...(terminal === null
      ? {}
      : { access: createAccessVerifier(access, ctx.instanceId), extraModules: terminal.modules }),
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  if (terminal !== null) server.on('upgrade', terminal.upgrades.listener(app));
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const stack: Stack = { port, instanceId, clock, access, ports, folders, logFile, spies, secrets: [] };
  running.push({
    stack,
    terminal,
    close: async () => {
      await terminal?.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      ctx.db.close();
      await logger.close();
      await assertPortClosed(port);
      temp.remove();
    },
  });
  return stack;
}

// ---- requests --------------------------------------------------------------------------------------------------------------------

interface Call {
  readonly cookie?: string | undefined;
  readonly bearer?: string | undefined;
  /** `null` sends no `Origin`; the default for a write is the page origin and for a GET none. */
  readonly origin?: string | null | undefined;
  readonly host?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly contentHeaders?: boolean;
}

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

function send(
  s: Stack,
  method: 'GET' | 'POST' | 'OPTIONS' | 'DELETE',
  urlPath: string,
  call: Call = {},
): Promise<HttpReply> {
  const write = method === 'POST';
  const headers: Record<string, string> = {
    ...(write && call.contentHeaders !== false ? writeHeaders() : {}),
    ...(call.cookie === undefined ? {} : { Cookie: call.cookie }),
    ...(call.bearer === undefined ? {} : { Authorization: `Bearer ${call.bearer}` }),
    ...call.headers,
  };
  const needsOrigin = write || urlPath.endsWith('/socket');
  const origin =
    call.origin === undefined ? (needsOrigin ? pageOrigin(s.port) : undefined) : (call.origin ?? undefined);
  const body = call.body ?? (write ? '{}' : undefined);
  return httpRequest(s.port, urlPath, {
    method,
    headers,
    ...(origin === undefined ? {} : { origin }),
    ...(call.host === undefined ? {} : { host: call.host }),
    ...(body === undefined ? {} : { body }),
  });
}

/** Raw bytes on a fresh connection: the status line of the first answer and everything received (a reset after it is fine). */
function rawExchange(port: number, text: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    const finish = (): void => {
      const received = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? '0');
      socket.destroy();
      resolve({ status, text: received });
    };
    socket.setTimeout(5000, finish);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('close', finish);
    socket.once('error', finish);
    socket.once('connect', () => {
      socket.write(text);
    });
  });
}

/** A handshake written by hand, so that the `Host` header can differ from the address that is connected to. */
function rawUpgrade(
  port: number,
  hostHeaders: readonly string[],
  cookie: string,
): Promise<{ status: number; text: string }> {
  const lines = [
    `GET ${pathOf('terminalSocket')} HTTP/1.1`,
    ...hostHeaders.map((host) => `Host: ${host}`),
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${Buffer.alloc(16, 5).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: caw.terminal.v1',
    `Origin: ${pageOrigin(port)}`,
    `Cookie: ${cookie}`,
    '',
    '',
  ];
  return rawExchange(port, lines.join('\r\n'));
}

// ---- what a route needs to be called ----------------------------------------------------------------------------------------------

const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  sessionId: SESSION_ID,
  eventId: '1',
  name: SESSION_NAME,
  key: 'demo-folder',
};

function pathOf(id: RouteId, overrides: Record<string, string> = {}): string {
  const route = routes[id];
  const params: Record<string, string> = {};
  for (const name of /:(\w+)/g[Symbol.matchAll](route.path)) {
    const key = name[1];
    if (key !== undefined) params[key] = overrides[key] ?? SAMPLE_PARAMS[key] ?? '1';
  }
  return buildPath(route, params);
}

const methodOf = (id: RouteId): 'GET' | 'POST' => routes[id].method;
const ids = Object.keys(routes) as RouteId[];
const SESSION_ROUTES = ids.filter((id) => ACCESS_POLICY[id] === 'session');
const READER_ROUTES = ids.filter((id) => ACCESS_POLICY[id] === 'reader');
const WRITES = WRITE_ROUTE_IDS.filter((id) => ACCESS_POLICY[id] === 'session' || ACCESS_POLICY[id] === 'ticket');
const WRITES_WITH_SESSION = WRITES.filter((id) => ACCESS_POLICY[id] === 'session');

/** A cookie header for a credential value. */
const cookieOf = (instanceId: string, value: string): string => `${cookieName(instanceId)}=${value}`;

/** A well-formed credential that was never issued: 43 base64url characters. */
const NEVER_ISSUED = Buffer.alloc(32, 9).toString('base64url');

/** The cookie states of a stack: none, wrong, junk, expired and valid. The expired one is issued first and the clock then moves past a day. */
async function cookieStates(s: Stack): Promise<{
  none: undefined;
  wrong: string;
  junk: string;
  expired: string;
  valid: string;
}> {
  const expired = await mintAndExchange(s.port, s.access);
  s.clock.advance(DAY_MS + 1000);
  const valid = await mintAndExchange(s.port, s.access);
  s.secrets.push(expired, valid);
  return {
    none: undefined,
    wrong: cookieOf(s.instanceId, NEVER_ISSUED),
    junk: cookieOf(s.instanceId, 'not a credential'),
    expired,
    valid,
  };
}

describe('every route of ACCESS_POLICY that is not open, by cookie state (TC-SEC-02, TC-SEC-03)', () => {
  it('says 401 access_required with WWW-Authenticate and does nothing for no, a wrong, a junk or an expired cookie', async () => {
    const s = await startStack();
    const states = await cookieStates(s);
    for (const id of SESSION_ROUTES) {
      for (const state of ['none', 'wrong', 'junk', 'expired'] as const) {
        const reply = await send(s, methodOf(id), pathOf(id), {
          ...(states[state] === undefined ? {} : { cookie: states[state] }),
        });
        expect(reply.status, `${id} with a ${state} cookie`).toBe(401);
        expect(codeOf(reply), `${id} with a ${state} cookie`).toBe('access_required');
        expect(reply.headers['www-authenticate'], id).toBeDefined();
      }
    }
    expect(s.spies.create).not.toHaveBeenCalled();
    expect(s.spies.kill).not.toHaveBeenCalled();
    expect(s.spies.pick).not.toHaveBeenCalled();
    expect(s.spies.resume).not.toHaveBeenCalled();
    expect(s.folders.add).not.toHaveBeenCalled();
    expect(s.folders.remove).not.toHaveBeenCalled();
    expect(s.ports.sessions.list()).toHaveLength(1);
  });

  it('lets a valid cookie through to the handler of every one of them (nothing but the credential was wrong before)', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    expect((await send(s, 'GET', pathOf('terminalSocket'), { cookie: valid })).status).toBe(426);
    // the logout revokes the credential, so it goes last
    const ordered = [...SESSION_ROUTES.filter((id) => id !== 'authLogout'), 'authLogout' as const];
    for (const id of ordered) {
      if (id === 'terminalSocket' || id === 'terminalEvents') continue; // a stream and an upgrade: proved below
      const reply = await send(s, methodOf(id), pathOf(id), { cookie: valid, body: '{}' });
      expect(reply.status, id).not.toBe(401);
      expect(codeOf(reply), id).not.toBe('access_required');
    }
  });

  it('refuses the socket upgrade without a valid cookie with the JSON envelope: no 101, no viewer, nothing written (TC-SEC-03)', async () => {
    const s = await startStack();
    const states = await cookieStates(s);
    const session = s.ports.sessions.byName.get(SESSION_NAME);
    for (const state of ['none', 'wrong', 'junk', 'expired'] as const) {
      const client = await RawWsClient.connect(s.port, {
        path: pathOf('terminalSocket'),
        ...(states[state] === undefined ? {} : { cookie: states[state] }),
      });
      expect(client.status, state).toBe(401);
      expect(codeOf(client), state).toBe('access_required');
      await client.waitClosed();
    }
    expect(session?.viewers.size).toBe(0);
    expect(session?.written).toEqual([]);
    expect(s.spies.get).not.toHaveBeenCalled();
  });

  it('opens a stream for a valid cookie and refuses the events route without one', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    expect((await send(s, 'GET', pathOf('terminalEvents'))).status).toBe(401);
    const socket = await openTerminalSocket(s.port, SESSION_NAME, { cookie: valid });
    await socket.client.close();
  });

  it('mounts no auth, terminal or folder route on a task instance: 404 route_not_found for every path (TC-SEC-60)', async () => {
    const s = await startStack({ kind: 'task' });
    for (const id of [...SESSION_ROUTES, 'authExchange' as const]) {
      const reply = await send(s, methodOf(id), pathOf(id), {});
      expect(reply.status, id).toBe(404);
      expect(codeOf(reply), id).toBe('route_not_found');
    }
    const upgrade = await RawWsClient.connect(s.port, {
      path: pathOf('terminalSocket'),
      cookie: cookieOf(s.instanceId, NEVER_ISSUED),
    });
    expect(upgrade.status).toBe(404);
    expect(codeOf(upgrade)).toBe('route_not_found');
  });

  it('keeps the folder, terminal and auth paths 404 on a task instance also for a path with a folder or a name in it', async () => {
    const s = await startStack({ kind: 'task' });
    for (const urlPath of [
      '/api/v3/folders/any/remove',
      '/api/v3/terminal/sessions/a/kill',
      '/api/v3/auth/logout',
      '/api/v3/terminal/',
    ]) {
      const reply = await send(s, 'POST', urlPath, {});
      expect(codeOf(reply), urlPath).toBe('route_not_found');
    }
  });
});

describe('the reader routes (design 02 A1)', () => {
  it('say 401 without a credential, and with a wrong cookie or a wrong or malformed Bearer value', async () => {
    const s = await startStack();
    for (const id of READER_ROUTES) {
      const url = pathOf(id);
      expect((await send(s, 'GET', url)).status, `${id} without credential`).toBe(401);
      expect(
        (await send(s, 'GET', url, { cookie: cookieOf(s.instanceId, NEVER_ISSUED) })).status,
        `${id} wrong cookie`,
      ).toBe(401);
      expect((await send(s, 'GET', url, { bearer: 'cd'.repeat(32) })).status, `${id} wrong bearer`).toBe(401);
      expect((await send(s, 'GET', url, { bearer: 'short' })).status, `${id} short bearer`).toBe(401);
      expect(
        (await send(s, 'GET', url, { headers: { Authorization: `Basic ${CONTROL_TOKEN}` } })).status,
        `${id} basic`,
      ).toBe(401);
      expect(
        (await send(s, 'GET', url, { headers: { Authorization: CONTROL_TOKEN } })).status,
        `${id} bare token`,
      ).toBe(401);
    }
  });

  it('answer for the session cookie and for the control token as a Bearer value on GET', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    for (const id of READER_ROUTES) {
      const url = pathOf(id);
      const withCookie = await send(s, 'GET', url, { cookie: valid });
      expect(withCookie.status, `${id} with the cookie`).not.toBe(401);
      const withToken = await send(s, 'GET', url, { bearer: CONTROL_TOKEN });
      expect(withToken.status, `${id} with the token`).not.toBe(401);
      expect(withToken.status, `${id} with the token and with the cookie answer alike`).toBe(withCookie.status);
    }
  });

  it('serve one reader route with 200 for the cookie and for the token, so the pass is not a coincidence of a refusal', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const url = routes.listToolCalls.path;
    expect((await send(s, 'GET', url)).status).toBe(401);
    expect((await send(s, 'GET', url, { cookie: valid })).status).toBe(200);
    expect((await send(s, 'GET', url, { bearer: CONTROL_TOKEN })).status).toBe(200);
  });

  it('never accept the Bearer value on a write, nor on a GET route that needs the session', async () => {
    const s = await startStack();
    for (const id of WRITES_WITH_SESSION) {
      const reply = await send(s, 'POST', pathOf(id), { bearer: CONTROL_TOKEN });
      expect(reply.status, id).toBe(401);
      expect(codeOf(reply), id).toBe('access_required');
    }
    for (const id of SESSION_ROUTES.filter((route) => methodOf(route) === 'GET')) {
      const reply = await send(s, 'GET', pathOf(id), { bearer: CONTROL_TOKEN });
      expect(reply.status, id).toBe(401);
    }
    expect(s.spies.create).not.toHaveBeenCalled();
    expect(s.spies.kill).not.toHaveBeenCalled();
    expect((await send(s, 'POST', pathOf('listToolCalls'), { bearer: CONTROL_TOKEN })).status).toBe(405);
  });

  it('are open on a task instance, as they always were (no access service is bound there)', async () => {
    const s = await startStack({ kind: 'task' });
    for (const id of READER_ROUTES) {
      const reply = await send(s, 'GET', pathOf(id));
      expect(reply.status, id).not.toBe(401);
    }
    expect((await send(s, 'GET', routes.listToolCalls.path)).status).toBe(200);
  });
});

describe('Origin (TC-SEC-12, TC-SEC-15)', () => {
  const BAD_ORIGINS = (port: number): (string | null)[] => [
    null,
    '',
    'null',
    'http://evil.example',
    'http://evil.example:' + String(port),
    'https://127.0.0.1:' + String(port),
    'http://127.0.0.1',
    'http://127.0.0.1:' + String(port + 1),
    'http://localhost:' + String(port + 1),
    `http://127.0.0.1:${String(port)}.evil.example`,
    `http://127.0.0.1.evil.example:${String(port)}`,
    `http://127.0.0.1:${String(port)}@evil.example`,
    `http://evil.example@127.0.0.1:${String(port)}`,
    `http://127.0.0.1:${String(port)}/`,
  ];

  it('refuses every write with a foreign, null, empty, missing or lookalike origin, valid cookie or not, and calls nothing', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    for (const id of WRITES) {
      for (const origin of BAD_ORIGINS(s.port)) {
        for (const cookie of [valid, undefined]) {
          const reply = await send(s, 'POST', pathOf(id), { origin, ...(cookie === undefined ? {} : { cookie }) });
          expect(reply.status, `${id} ${String(origin)}`).toBe(403);
          expect(codeOf(reply), `${id} ${String(origin)}`).toBe('origin_not_allowed');
        }
      }
    }
    expect(s.spies.create).not.toHaveBeenCalled();
    expect(s.spies.kill).not.toHaveBeenCalled();
    expect(s.spies.pick).not.toHaveBeenCalled();
    expect(s.spies.resume).not.toHaveBeenCalled();
    expect(s.folders.add).not.toHaveBeenCalled();
    expect(s.ports.sessions.list()).toHaveLength(1);
  });

  it('accepts both loopback spellings of the page origin on a write', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const body = JSON.stringify({ path: FOLDER });
    const own = await send(s, 'POST', pathOf('terminalCreateSession'), { cookie: valid, body });
    expect(own.status).toBe(200);
    const named = await send(s, 'POST', pathOf('terminalCreateSession'), {
      cookie: valid,
      body,
      origin: `http://localhost:${String(s.port)}`,
      host: `localhost:${String(s.port)}`,
    });
    expect(named.status).toBe(200);
  });

  it('refuses the socket for a missing, null, foreign or other-port origin: 403, no 101', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    for (const origin of BAD_ORIGINS(s.port)) {
      const client = await RawWsClient.connect(s.port, { path: pathOf('terminalSocket'), cookie: valid, origin });
      expect(client.status, String(origin)).toBe(403);
      expect(codeOf(client), String(origin)).toBe('origin_not_allowed');
    }
    expect(s.spies.get).not.toHaveBeenCalled();
  });

  it('a page on another localhost port with a valid cookie cannot create, kill or open a socket (TC-SEC-15)', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const forged = `http://localhost:${String(s.port + 1)}`;
    const create = await send(s, 'POST', pathOf('terminalCreateSession'), {
      cookie: valid,
      origin: forged,
      body: JSON.stringify({ path: FOLDER }),
    });
    const kill = await send(s, 'POST', pathOf('terminalKillSession'), { cookie: valid, origin: forged });
    const socket = await RawWsClient.connect(s.port, {
      path: pathOf('terminalSocket'),
      cookie: valid,
      origin: forged,
    });
    expect([create.status, kill.status, socket.status]).toEqual([403, 403, 403]);
    expect(s.ports.sessions.list()).toHaveLength(1);
  });
});

describe('Host (TC-SEC-11, TC-SEC-19)', () => {
  it('refuses a foreign, portless, wrong-port, rebinding or malformed Host with 403 host_not_allowed, valid cookie or not', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const hosts = [
      'evil.example',
      `evil.example:${String(s.port)}`,
      '127.0.0.1',
      `127.0.0.1:${String(s.port + 1)}`,
      `localhost:${String(s.port + 1)}`,
      `127.0.0.1.evil.example:${String(s.port)}`,
      `[::1]:${String(s.port)}`,
      `127.0.0.1.:${String(s.port)}`,
      `0.0.0.0:${String(s.port)}`,
    ];
    for (const host of hosts) {
      for (const id of ['terminalState', 'listFolders', 'listToolCalls'] as const) {
        const reply = await send(s, 'GET', pathOf(id), { host, cookie: valid });
        expect(reply.status, `${id} ${host}`).toBe(403);
        expect(codeOf(reply), `${id} ${host}`).toBe('host_not_allowed');
      }
      const write = await send(s, 'POST', pathOf('terminalCreateSession'), {
        host,
        cookie: valid,
        body: JSON.stringify({ path: FOLDER }),
      });
      expect(write.status, `write ${host}`).toBe(403);
      const socket = await rawUpgrade(s.port, [host], valid);
      expect(socket.status, `socket ${host}`).toBe(403);
      expect(socket.text, `socket ${host}`).toContain('host_not_allowed');
    }
    expect(s.spies.create).not.toHaveBeenCalled();
  });

  it('refuses the upgrade for a foreign Host with the JSON envelope and no 101', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const refused = await rawUpgrade(s.port, ['evil.example'], valid);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('host_not_allowed');
    expect(refused.text).not.toContain('101 Switching');
    expect(s.spies.get).not.toHaveBeenCalled();
  });

  it('refuses a duplicated Host header and an HTTP/1.1 request without one', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const base = `GET ${pathOf('terminalState')} HTTP/1.1\r\n`;
    const tail = `Cookie: ${valid}\r\nConnection: close\r\n\r\n`;
    const duplicate = await rawExchange(
      s.port,
      `${base}Host: 127.0.0.1:${String(s.port)}\r\nHost: evil.example\r\n${tail}`,
    );
    expect([400, 403]).toContain(duplicate.status);
    const missing = await rawExchange(s.port, `${base}${tail}`);
    expect([400, 403]).toContain(missing.status);
    const upgradeDuplicate = await rawUpgrade(s.port, [`127.0.0.1:${String(s.port)}`, 'evil.example'], valid);
    expect([400, 403]).toContain(upgradeDuplicate.status);
    expect(upgradeDuplicate.text).not.toContain('101 Switching');
    expect(s.spies.get).not.toHaveBeenCalled();
  });
});

describe('fetch metadata (TC-SEC-13)', () => {
  it('refuses cross-site on any method and same-site on a write, valid cookie and origin or not', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const body = JSON.stringify({ path: FOLDER });
    for (const value of ['cross-site', 'Cross-Site']) {
      const get = await send(s, 'GET', pathOf('terminalState'), {
        cookie: valid,
        headers: { 'Sec-Fetch-Site': value },
      });
      expect([get.status, codeOf(get)]).toEqual([403, 'cross_site_request']);
      const post = await send(s, 'POST', pathOf('terminalCreateSession'), {
        cookie: valid,
        body,
        headers: { 'Sec-Fetch-Site': value },
      });
      expect([post.status, codeOf(post)]).toEqual([403, 'cross_site_request']);
      const socket = await RawWsClient.connect(s.port, {
        path: pathOf('terminalSocket'),
        cookie: valid,
        headers: { 'Sec-Fetch-Site': value },
      });
      expect([socket.status, codeOf(socket)]).toEqual([403, 'cross_site_request']);
    }
    const sameSiteWrite = await send(s, 'POST', pathOf('terminalCreateSession'), {
      cookie: valid,
      body,
      headers: { 'Sec-Fetch-Site': 'same-site' },
    });
    expect([sameSiteWrite.status, codeOf(sameSiteWrite)]).toEqual([403, 'cross_site_request']);
    expect(s.spies.create).not.toHaveBeenCalled();
    const sameOrigin = await send(s, 'POST', pathOf('terminalCreateSession'), {
      cookie: valid,
      body,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(sameOrigin.status).toBe(200);
  });
});

describe('the CSRF header and the content type of a write (TC-SEC-14)', () => {
  it('refuses text/plain, urlencoded, multipart and a missing X-MCS-Request on every write that has a session', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const variants: Record<string, string>[] = [
      { 'Content-Type': 'text/plain', 'X-MCS-Request': '1' },
      { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MCS-Request': '1' },
      { 'Content-Type': 'multipart/form-data; boundary=x', 'X-MCS-Request': '1' },
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', 'X-MCS-Request': '0' },
      { 'X-MCS-Request': '1' },
    ];
    for (const id of WRITES_WITH_SESSION) {
      for (const headers of variants) {
        const reply = await send(s, 'POST', pathOf(id), {
          cookie: valid,
          contentHeaders: false,
          headers,
          body: '{}',
        });
        expect([reply.status, codeOf(reply)], `${id} ${JSON.stringify(headers)}`).toEqual([403, 'csrf_rejected']);
      }
    }
    expect(s.spies.create).not.toHaveBeenCalled();
    expect(s.spies.kill).not.toHaveBeenCalled();
    expect(s.spies.pick).not.toHaveBeenCalled();
    expect(s.spies.resume).not.toHaveBeenCalled();
  });

  it('refuses the same for the exchange, which has no cookie to check', async () => {
    const s = await startStack();
    const code = s.access.mint().code;
    s.secrets.push(code);
    const reply = await send(s, 'POST', routes.authExchange.path, {
      contentHeaders: false,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code }),
    });
    expect([reply.status, codeOf(reply)]).toEqual([403, 'csrf_rejected']);
    expect(reply.headers['set-cookie']).toBeUndefined();
    // the code was not consumed by the refused request
    expect((await postExchange(s.port, code)).status).toBe(200);
  });
});

describe('OPTIONS and methods (TC-SEC-16)', () => {
  it('answers OPTIONS with 405 on every route that is not open, and sets no Access-Control header on any answer', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const seen: HttpReply[] = [];
    for (const id of [...SESSION_ROUTES, ...READER_ROUTES, 'authExchange' as const, 'authSession' as const]) {
      const options = await send(s, 'OPTIONS', pathOf(id), { cookie: valid });
      expect([options.status, codeOf(options)], id).toEqual([405, 'method_not_allowed']);
      seen.push(options);
      // the event stream of a valid cookie never ends: its own suite proves it
      if (id === 'terminalEvents') continue;
      const origin = methodOf(id) === 'POST' ? 'http://evil.example' : undefined;
      seen.push(await send(s, methodOf(id), pathOf(id), { cookie: valid, origin }));
    }
    seen.push(await send(s, 'GET', pathOf('terminalState')));
    const refused = await RawWsClient.connect(s.port, { path: pathOf('terminalSocket') });
    seen.push({ status: refused.status, headers: refused.headers, body: refused.body });
    // the logout above revoked `valid`
    const fresh = await mintAndExchange(s.port, s.access);
    const ok = await openTerminalSocket(s.port, SESSION_NAME, { cookie: fresh });
    expect(Object.keys(ok.client.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    await ok.client.close();
    for (const reply of seen) {
      expect(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('answers a method the route does not have with 405: DELETE on the kill route, GET on the exchange', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    expect(
      (await send(s, 'DELETE', pathOf('terminalKillSession'), { cookie: valid, origin: pageOrigin(s.port) })).status,
    ).toBe(405);
    expect((await send(s, 'GET', routes.authExchange.path)).status).toBe(405);
    expect(s.spies.kill).not.toHaveBeenCalled();
  });
});

describe('bodies (TC-SEC-22)', () => {
  it('refuses 4097 bytes with 413, invalid JSON with 400, unknown keys, __proto__ and arrays with 400, and calls nothing', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const create = pathOf('terminalCreateSession');
    const big = JSON.stringify({ path: FOLDER, pad: 'x'.repeat(4097) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(4096);
    const cases: [string, string, number, ErrorCode][] = [
      ['over the limit', big, 413, 'payload_too_large'],
      ['invalid JSON', '{"path": ', 400, 'body_invalid_json'],
      ['a lone brace', '{', 400, 'body_invalid_json'],
      ['an unknown key', JSON.stringify({ path: FOLDER, command: 'cmd.exe' }), 400, 'validation_failed'],
      [
        '__proto__',
        `{"path": "${FOLDER.replace(/\\/g, '\\\\')}", "__proto__": {"admin": true}}`,
        400,
        'validation_failed',
      ],
      ['an array', JSON.stringify([{ path: FOLDER }]), 400, 'validation_failed'],
      ['a string', JSON.stringify('x'), 400, 'validation_failed'],
      ['null', 'null', 400, 'validation_failed'],
      ['an empty body', '', 400, 'body_invalid_json'],
      ['a missing path', '{}', 400, 'validation_failed'],
      ['a number as path', JSON.stringify({ path: 5 }), 400, 'validation_failed'],
    ];
    for (const [label, body, status, code] of cases) {
      const reply = await send(s, 'POST', create, { cookie: valid, body });
      expect([reply.status, codeOf(reply)], label).toEqual([status, code]);
    }
    expect(s.spies.create).not.toHaveBeenCalled();
  });

  it('refuses a body over 4096 bytes sent chunked, without a Content-Length', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const payload = JSON.stringify({ path: FOLDER, pad: 'y'.repeat(4200) });
    const head =
      `POST ${pathOf('terminalCreateSession')} HTTP/1.1\r\nHost: 127.0.0.1:${String(s.port)}\r\nOrigin: ${pageOrigin(s.port)}\r\n` +
      `Cookie: ${valid}\r\nContent-Type: application/json\r\nX-MCS-Request: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`;
    const chunked = `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
    const reply = await rawExchange(s.port, head + chunked);
    expect(reply.status).toBe(413);
    expect(s.spies.create).not.toHaveBeenCalled();
  });

  it('keeps the limit on the exchange and the folder routes too', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const over = JSON.stringify({ code: 'a'.repeat(4100) });
    expect((await send(s, 'POST', routes.authExchange.path, { body: over })).status).toBe(413);
    const folder = await send(s, 'POST', routes.addFolder.path, {
      cookie: valid,
      body: JSON.stringify({ path: 'p'.repeat(5000) }),
    });
    expect(folder.status).toBe(413);
    expect(s.folders.add).not.toHaveBeenCalled();
  });
});

describe('names and paths (TC-SEC-20, TC-SEC-21)', () => {
  const BAD_NAMES = ['..', '%2e%2e', 'a%2Fb', 'a%5Cb', '%00', 'a.b', 'a%20b', 'a'.repeat(65), '%E2%80%AE', '%0a'];

  it('never lets a hostile session name reach the host: kill and socket answer 400 or 404 and the port is not called', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    for (const name of BAD_NAMES) {
      const url = `/api/v3/terminal/sessions/${name}/kill`;
      const kill = await send(s, 'POST', url, { cookie: valid });
      expect([400, 404], `kill ${name}`).toContain(kill.status);
      const socket = await RawWsClient.connect(s.port, {
        path: `/api/v3/terminal/sessions/${name}/socket`,
        cookie: valid,
      });
      expect([400, 404], `socket ${name}`).toContain(socket.status);
    }
    expect(s.spies.kill).not.toHaveBeenCalled();
    expect(s.spies.get).not.toHaveBeenCalled();
    expect(s.ports.sessions.list()).toHaveLength(1);
  });

  it('answers 400 validation_failed for a name the pattern refuses, 404 for a well-formed name nobody holds', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const bad = await send(s, 'POST', '/api/v3/terminal/sessions/a%2Fb/kill', { cookie: valid });
    expect([bad.status, codeOf(bad)]).toEqual([400, 'validation_failed']);
    const unknown = await send(s, 'POST', pathOf('terminalKillSession', { name: 'nobody-1' }), { cookie: valid });
    expect(unknown.status).toBe(404);
  });

  it('refuses a UNC or device folder, a control character, an empty or a 1025-character path before the host is asked', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const paths = [
      '\\\\attacker\\share',
      '//attacker/share',
      '\\\\?\\C:\\work',
      '\\\\.\\pipe\\x',
      'C:\\work\\a\u0000b',
      'C:\\work\\a\nb',
      'C:\\work\\a\u001bb',
      '',
      'C'.repeat(1025),
    ];
    for (const folder of paths) {
      const reply = await send(s, 'POST', pathOf('terminalCreateSession'), {
        cookie: valid,
        body: JSON.stringify({ path: folder }),
      });
      expect([reply.status, codeOf(reply)], JSON.stringify(folder).slice(0, 40)).toEqual([400, 'validation_failed']);
    }
    expect(s.spies.create).not.toHaveBeenCalled();
    const folderAdd = await send(s, 'POST', pathOf('addFolder'), {
      cookie: valid,
      body: JSON.stringify({ path: '' }),
    });
    expect(folderAdd.status).toBe(400);
    expect(s.folders.add).not.toHaveBeenCalled();
  });

  it('takes only a session id and a flag for a resume, and refuses a command line or an environment (TC-SEC-23)', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const resume = pathOf('terminalResume');
    const bodies = [
      { sessionId: SESSION_ID, args: ['--dangerously-skip-permissions'] },
      { sessionId: SESSION_ID, env: { A: 'b' } },
      { sessionId: SESSION_ID, path: FOLDER },
      { sessionId: '', fork: false },
      { sessionId: SESSION_ID, fork: 'yes' },
      {},
    ];
    for (const body of bodies) {
      const reply = await send(s, 'POST', resume, { cookie: valid, body: JSON.stringify(body) });
      expect([reply.status, codeOf(reply)], JSON.stringify(body)).toEqual([400, 'validation_failed']);
    }
    expect(s.spies.resume).not.toHaveBeenCalled();
  });
});

describe('the access code and the exchange (TC-SEC-01, 04, 05, 08)', () => {
  it('redeems a code once: the code is 43 characters, a second use is refused, no cookie is set for a refusal', async () => {
    const s = await startStack();
    const mint = s.access.mint();
    s.secrets.push(mint.code);
    expect(mint.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = await postExchange(s.port, mint.code);
    expect(first.status).toBe(200);
    const cookie = cookieFromReply(first);
    expect(cookie).not.toBeNull();
    s.secrets.push(cookie ?? '');
    const second = await postExchange(s.port, mint.code);
    expect([second.status, codeOf(second)]).toEqual([401, 'access_code_invalid']);
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('sets the cookie byte for byte: name by instance, Path=/, HttpOnly, SameSite=Strict, Max-Age=86400, no Domain, no Secure', async () => {
    const s = await startStack();
    const mint = s.access.mint();
    s.secrets.push(mint.code);
    const reply = await postExchange(s.port, mint.code);
    const header = reply.headers['set-cookie'] ?? '';
    const value = /^caw_[0-9a-f]{8}=([A-Za-z0-9_-]{43});/.exec(header)?.[1] ?? '';
    s.secrets.push(value);
    expect(header).toBe(setCookieHeader(value, s.instanceId));
    expect(header).toBe(`caw_11111111=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    expect(header).not.toMatch(/Domain|Secure|Expires/i);
    expect(value).not.toBe(mint.code);
    expect(reply.headers['cache-control']).toContain('no-store');
  });

  it('refuses a code after 120 seconds, a wrong code, a malformed or oversize one, with 401 access_code_invalid or 400, never 500', async () => {
    const s = await startStack();
    const mint = s.access.mint();
    s.secrets.push(mint.code);
    s.clock.advance(120_000);
    expect(codeOf(await postExchange(s.port, mint.code))).toBe('access_code_invalid');
    for (const code of ['', 'short', NEVER_ISSUED, 'z'.repeat(129), 'a b'.repeat(20)]) {
      const reply = await postExchange(s.port, code);
      expect(reply.status, code.slice(0, 8)).toBeLessThan(500);
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers 429 access_rate_limited with Retry-After after eight wrong codes in a minute, and recovers after the window', async () => {
    const s = await startStack();
    for (let n = 0; n < 8; n += 1) {
      expect(codeOf(await postExchange(s.port, Buffer.alloc(32, n + 1).toString('base64url')))).toBe(
        'access_code_invalid',
      );
    }
    const limited = await postExchange(s.port, Buffer.alloc(32, 99).toString('base64url'));
    expect([limited.status, codeOf(limited)]).toEqual([429, 'access_rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    s.clock.advance(61_000);
    expect(codeOf(await postExchange(s.port, Buffer.alloc(32, 98).toString('base64url')))).toBe('access_code_invalid');
  });

  it('TC-SEC-04: a valid code still redeems while the limiter is tripped, and only wrong codes are counted', async () => {
    const s = await startStack();
    for (let n = 0; n < 9; n += 1) await postExchange(s.port, Buffer.alloc(32, n + 1).toString('base64url'));
    const limited = await postExchange(s.port, Buffer.alloc(32, 77).toString('base64url'));
    expect(limited.status).toBe(429);
    const mint = s.access.mint();
    s.secrets.push(mint.code);
    const redeemed = await postExchange(s.port, mint.code);
    expect(redeemed.status).toBe(200);
    const cookie = cookieFromReply(redeemed);
    expect(cookie).not.toBeNull();
    s.secrets.push(cookie ?? '');
    expect((await send(s, 'GET', pathOf('terminalState'), { cookie: cookie ?? '' })).status).toBe(200);
  });

  it('never takes the code from a query string, a header, a cookie or another route as a credential (TC-SEC-08)', async () => {
    const s = await startStack();
    const code = s.access.mint().code;
    s.secrets.push(code);
    const state = pathOf('terminalState');
    const attempts: Call[] = [
      { headers: { 'X-Access-Code': code } },
      { headers: { Authorization: `Bearer ${code}` } },
      { headers: { Authorization: `Code ${code}` } },
      { cookie: cookieOf(s.instanceId, code) },
      { cookie: `${cookieName(s.instanceId)}=${code}; other=1` },
    ];
    for (const attempt of attempts) expect((await send(s, 'GET', state, attempt)).status).toBe(401);
    expect((await send(s, 'GET', `${state}?code=${code}`)).status).toBe(401);
    expect((await send(s, 'GET', `${routes.authSession.path}?code=${code}`)).status).toBe(400);
    // none of that consumed the code
    expect((await postExchange(s.port, code)).status).toBe(200);
  });

  it('answers authSession for the cookie of this instance only, and never reads the code or the control token', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const probe = async (call: Call): Promise<unknown> =>
      JSON.parse((await send(s, 'GET', routes.authSession.path, call)).body);
    expect(await probe({ cookie: valid })).toEqual({ authenticated: true });
    expect(await probe({})).toEqual({ authenticated: false });
    expect(await probe({ bearer: CONTROL_TOKEN })).toEqual({ authenticated: false });
  });
});

describe('two instances in one cookie jar (TC-SEC-06)', () => {
  it('reads only its own cookie name: the cookie of one instance alone is a 401 on the other', async () => {
    const a = await startStack({ instanceId: FAKE_INSTANCE_ID });
    const b = await startStack({ instanceId: OTHER_INSTANCE });
    const cookieA = await mintAndExchange(a.port, a.access);
    const cookieB = await mintAndExchange(b.port, b.access);
    a.secrets.push(cookieA);
    b.secrets.push(cookieB);
    expect(cookieA.split('=')[0]).not.toBe(cookieB.split('=')[0]);
    const jar = `${cookieA}; ${cookieB}`;
    expect((await send(a, 'GET', pathOf('terminalState'), { cookie: jar })).status).toBe(200);
    expect((await send(b, 'GET', pathOf('terminalState'), { cookie: jar })).status).toBe(200);
    expect((await send(b, 'GET', pathOf('terminalState'), { cookie: cookieA })).status).toBe(401);
    expect((await send(a, 'GET', pathOf('terminalState'), { cookie: cookieB })).status).toBe(401);
    const forged = `${cookieName(OTHER_INSTANCE)}=${cookieA.split('=')[1] ?? ''}`;
    expect((await send(b, 'GET', pathOf('terminalState'), { cookie: forged })).status).toBe(401);
    const socket = await RawWsClient.connect(b.port, { path: pathOf('terminalSocket'), cookie: cookieA });
    expect(socket.status).toBe(401);
  });

  it('logout of one instance clears its own cookie name and revokes only its own credential', async () => {
    const a = await startStack({ instanceId: FAKE_INSTANCE_ID });
    const b = await startStack({ instanceId: OTHER_INSTANCE });
    const cookieA = await mintAndExchange(a.port, a.access);
    const cookieB = await mintAndExchange(b.port, b.access);
    const out = await send(a, 'POST', pathOf('authLogout'), { cookie: `${cookieA}; ${cookieB}` });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']).toBe(clearCookieHeader(FAKE_INSTANCE_ID));
    expect((await send(a, 'GET', pathOf('terminalState'), { cookie: cookieA })).status).toBe(401);
    expect((await send(b, 'GET', pathOf('terminalState'), { cookie: cookieB })).status).toBe(200);
  });
});

describe('logout (TC-SEC-02)', () => {
  it('revokes the credential: the same cookie is refused afterwards, and an open socket ends with 4003', async () => {
    const s = await startStack();
    const cookie = await mintAndExchange(s.port, s.access);
    s.secrets.push(cookie);
    const socket = await openTerminalSocket(s.port, SESSION_NAME, { cookie });
    const out = await send(s, 'POST', pathOf('authLogout'), { cookie });
    expect([out.status, JSON.parse(out.body)]).toEqual([200, { authenticated: false }]);
    await socket.client.waitClosed();
    expect(socket.client.closeInfo()?.code).toBe(4003);
    expect((await send(s, 'GET', pathOf('terminalState'), { cookie })).status).toBe(401);
    expect((await send(s, 'POST', pathOf('authLogout'), { cookie })).status).toBe(401);
  });
});

describe('the log file', () => {
  it('holds no code, credential, cookie, session name, folder or token after a run of all of the above', async () => {
    const s = await startStack();
    const { valid } = await cookieStates(s);
    const cookie = valid;
    s.secrets.push(CONTROL_TOKEN, SESSION_NAME, FOLDER, CANARY_FOLDER);
    await send(s, 'POST', pathOf('terminalCreateSession'), { cookie, body: JSON.stringify({ path: CANARY_FOLDER }) });
    await send(s, 'POST', '/api/v3/terminal/sessions/a%2Fb/kill', { cookie });
    await send(s, 'POST', pathOf('terminalCreateSession'), {
      cookie,
      body: JSON.stringify({ path: '\\\\attacker\\share' }),
    });
    await send(s, 'GET', pathOf('listToolCalls'), { bearer: CONTROL_TOKEN });
    const socket = await openTerminalSocket(s.port, SESSION_NAME, { cookie });
    await socket.client.close();
    for (let n = 0; n < 9; n += 1) await postExchange(s.port, Buffer.alloc(32, n + 1).toString('base64url'));
    await send(s, 'POST', pathOf('authLogout'), { cookie });
    await waitFor(() => readFileSync(s.logFile, 'utf8').includes('access_rate_limited'), {
      what: 'the log to hold the limiter event',
    });
    const log = readFileSync(s.logFile, 'utf8');
    for (const secret of s.secrets) {
      if (secret === '') continue;
      const value = secret.includes('=') ? (secret.split('=')[1] ?? secret) : secret;
      expect(log.includes(value), 'a secret of the run is in the log').toBe(false);
    }
    expect(log.includes('attacker')).toBe(false);
    expect(log).toContain('ticket_exchanged');
  });
});
