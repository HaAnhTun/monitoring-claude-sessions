// `probeInstance` (01 4.8, registry 2.1) and the control and HTTP clients under it: every state of the classification with
// scripted dependencies, and the two real clients against in-process servers on a real pipe (or socket) and a real port.
import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { RUNTIME_VERSION, controlAddress } from '@mcs/shared';
import type { ControlRequest, ControlResponse } from '@mcs/shared/protocol';
import { allocatePort, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { readSmallFile } from '../platform/fsx.ts';
import { hostPlatform } from '../platform/host.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import {
  controlAddressOf,
  createControlTokenSource,
  createProbe,
  httpGet,
  httpGetWithHeaders,
  isLiveState,
  isLoopbackBase,
  isRunningState,
  probeInstance,
  requestControl,
  type ControlAttempt,
  type HttpAttempt,
  type IdentifyResponse,
  type ProbeDeps,
} from './probe.ts';

const makeTemp = useTempDirs();

const ID = '11111111-2222-4333-8444-555555555555';
const REAL_ID = '77777777-6666-4555-8444-333333333333';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const BACKSLASH = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const CRLF = `${String.fromCharCode(13)}${LF}`;
const PORT = 18000;
const URL_OF = (port: number): string => `http://127.0.0.1:${String(port)}`;

// ---- fixtures ----------------------------------------------------------------------------------------------------------

interface Fixture {
  readonly ws: WorkspaceRef;
  readonly runtimeDir: string;
}

function workspace(o: { instance?: boolean; instanceId?: string } = {}): Fixture {
  const root = makeTemp('probe').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { port: PORT },
    ...(o.instance === false ? {} : { instance: { instanceId: o.instanceId ?? ID } }),
  });
  return { ws: resolveWorkspace(tasksRoot, 'demo'), runtimeDir: path.join(root, 'runtime') };
}

function nodeState(pid: number, port = PORT, instanceId = ID): Record<string, unknown> {
  return {
    pid,
    url: URL_OF(port),
    port,
    started: 1_700_000_000.5,
    version: RUNTIME_VERSION,
    task: 'demo',
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId,
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
  };
}

function legacyState(pid: number, port = PORT): Record<string, unknown> {
  return { pid, url: URL_OF(port), port, started: 1_700_000_000.5, version: '2.9.0', task: 'demo', config: null };
}

function writeState(f: Fixture, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}${LF}`);
  writeFileSync(path.join(f.ws.dir, 'state.json'), bytes);
  return bytes;
}

function identity(over: Partial<IdentifyResponse> = {}): IdentifyResponse {
  return {
    v: 1,
    ok: true,
    op: 'identify',
    instanceId: ID,
    pid: 4242,
    phase: 'ready',
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
    port: PORT,
    url: URL_OF(PORT),
    startedAt: '2026-10-12T08:00:00.000Z',
    ...over,
  };
}

const reply = (response: IdentifyResponse): ControlAttempt => ({ kind: 'reply', response });
const httpReply = (status: number, body: unknown): HttpAttempt => ({
  ok: true,
  reply: { status, body: JSON.stringify(body) },
});

interface Script {
  /** What `identify` answers (default: nobody holds the name). */
  control?: ControlAttempt;
  /** What the HTTP GET answers (default: connection refused). */
  http?: (url: string) => HttpAttempt;
  alive?: readonly number[];
  runtimeProcesses?: readonly { pid: number; instanceId: string | null; instanceDir: string | null }[] | 'throw';
}

interface Calls {
  readonly identify: { address: string; timeoutMs: number }[];
  readonly http: { url: string; timeoutMs: number }[];
  readonly lists: (string | null)[];
}

function scripted(script: Script): { deps: ProbeDeps; calls: Calls } {
  const calls: Calls = { identify: [], http: [], lists: [] };
  const deps: ProbeDeps = {
    pidAlive: (pid) => (script.alive ?? []).includes(pid),
    identify: (address, timeoutMs) => {
      calls.identify.push({ address, timeoutMs });
      return Promise.resolve(script.control ?? { kind: 'absent' });
    },
    httpGet: (url, o) => {
      calls.http.push({ url, timeoutMs: o.timeoutMs });
      return Promise.resolve(script.http === undefined ? { ok: false, reason: 'refused' } : script.http(url));
    },
    listRuntimeProcesses: (runtimeDir) => {
      calls.lists.push(runtimeDir);
      if (script.runtimeProcesses === 'throw') return Promise.reject(new Error('listing failed'));
      return Promise.resolve(script.runtimeProcesses ?? []);
    },
  };
  return { deps, calls };
}

const healthOf = (instanceId: string): ((url: string) => HttpAttempt) => {
  return () => httpReply(200, { instanceId });
};

// ---- the classification ----------------------------------------------------------------------------------------------------

describe('probeInstance: no process answers on the control channel (01 4.8 steps 3-5)', () => {
  it('no state file: stopped, and nothing else is known', async () => {
    const f = workspace();
    const { deps, calls } = scripted({});
    const probe = await createProbe(deps)(f.ws);
    expect(probe).toMatchObject({
      state: 'stopped',
      engine: null,
      pid: null,
      url: null,
      port: null,
      identity: null,
      stateFile: null,
      stateFileBytes: null,
    });
    expect(probe.reason).not.toBe('');
    expect(calls.identify).toEqual([{ address: controlAddressOf(ID), timeoutMs: 2000 }]);
    expect(calls.http).toEqual([]);
  });

  it('a workspace without instance.json (legacy) never asks the control channel', async () => {
    const f = workspace({ instance: false });
    const { deps, calls } = scripted({});
    expect((await createProbe(deps)(f.ws)).state).toBe('stopped');
    expect(calls.identify).toEqual([]);
  });

  it('a state file that cannot be used is the same as none', async () => {
    const f = workspace();
    writeFileSync(path.join(f.ws.dir, 'state.json'), '{ not json');
    const probe = await createProbe(scripted({}).deps)(f.ws);
    expect(probe.state).toBe('stopped');
    expect(probe.stateFile).toBeNull();
    expect(probe.stateFileBytes).toBeNull();
  });

  it('a node state file whose pid is dead is stale, with the bytes the stop must compare against', async () => {
    const f = workspace();
    const bytes = writeState(f, nodeState(777));
    const probe = await createProbe(scripted({ alive: [] }).deps)(f.ws);
    expect(probe).toMatchObject({ state: 'stale', engine: 'node', pid: 777, url: URL_OF(PORT), port: PORT });
    expect(probe.stateFile?.pid).toBe(777);
    expect(Buffer.from(probe.stateFileBytes ?? new Uint8Array()).equals(bytes)).toBe(true);
  });

  it('a node state file whose pid lives, with the control name free, is a foreign pid (a reused pid)', async () => {
    const f = workspace();
    writeState(f, nodeState(777));
    const { deps, calls } = scripted({ alive: [777] });
    const probe = await createProbe(deps)(f.ws);
    expect(probe).toMatchObject({ state: 'foreign-pid', engine: 'node', pid: 777 });
    expect(calls.http).toEqual([]);
    expect(calls.lists).toEqual([]);
  });

  it('a state file that this runtime did not write (seven keys, no engine) whose pid is dead is stale', async () => {
    const f = workspace();
    writeState(f, legacyState(888));
    expect(await createProbe(scripted({ alive: [] }).deps)(f.ws)).toMatchObject({
      state: 'stale',
      engine: null,
      pid: 888,
    });
  });

  it('a foreign state file whose pid answers /api/health with that pid is unmanaged-running', async () => {
    const f = workspace();
    writeState(f, legacyState(888, 18123));
    const { deps, calls } = scripted({ alive: [888], http: () => httpReply(200, { ok: true, pid: 888 }) });
    const probe = await createProbe(deps)(f.ws);
    expect(probe).toMatchObject({
      state: 'unmanaged-running',
      engine: null,
      pid: 888,
      url: URL_OF(18123),
      port: 18123,
    });
    expect(calls.http).toEqual([{ url: `${URL_OF(18123)}/api/health`, timeoutMs: 3000 }]);
  });

  it('a foreign file whose live pid answers with another pid, an error status or nothing is a foreign pid', async () => {
    const f = workspace();
    writeState(f, legacyState(888));
    const cases: HttpAttempt[] = [
      httpReply(200, { ok: true, pid: 999 }),
      httpReply(500, { pid: 888 }),
      { ok: true, reply: { status: 200, body: 'not json' } },
      { ok: false, reason: 'timeout' },
    ];
    for (const answer of cases) {
      const probe = await createProbe(scripted({ alive: [888], http: () => answer }).deps)(f.ws);
      expect(probe).toMatchObject({ state: 'foreign-pid', engine: null });
    }
  });
});

describe('probeInstance: a process answers on the control channel (01 4.8 step 2)', () => {
  it('ready, and /api/v3/health answers 200 with the same instance id: running', async () => {
    const f = workspace();
    const answer = identity({ pid: 4242, port: 18222, url: URL_OF(18222) });
    const { deps, calls } = scripted({ control: reply(answer), http: healthOf(ID) });
    const probe = await createProbe(deps)(f.ws);
    expect(probe).toMatchObject({ state: 'running', engine: 'node', pid: 4242, url: URL_OF(18222), port: 18222 });
    expect(probe.identity).toEqual(answer);
    expect(calls.http).toEqual([{ url: `${URL_OF(18222)}/api/v3/health`, timeoutMs: 2000 }]);
  });

  it('carries the state file along when there is one', async () => {
    const f = workspace();
    writeState(f, nodeState(4242));
    const probe = await createProbe(scripted({ control: reply(identity()), http: healthOf(ID) }).deps)(f.ws);
    expect(probe.state).toBe('running');
    expect(probe.stateFile?.pid).toBe(4242);
    expect(probe.stateFileBytes).not.toBeNull();
  });

  it('ready, but HTTP fails, answers an error status, a wrong body or another instance: unhealthy', async () => {
    const f = workspace();
    const answers: HttpAttempt[] = [
      { ok: false, reason: 'refused' },
      { ok: false, reason: 'timeout' },
      httpReply(500, { instanceId: ID }),
      httpReply(200, { instanceId: OTHER_ID }),
      httpReply(200, { nothing: true }),
      { ok: true, reply: { status: 200, body: '<html>' } },
    ];
    for (const answer of answers) {
      const probe = await createProbe(scripted({ control: reply(identity()), http: () => answer }).deps)(f.ws);
      expect(probe).toMatchObject({ state: 'unhealthy', engine: 'node', pid: 4242 });
      expect(probe.reason).toContain('HTTP');
    }
  });

  it('never connects to an address that is not on loopback (an impostor on the pipe may say anything)', async () => {
    const f = workspace();
    const answer = identity({ url: 'http://203.0.113.9:80', port: 80 });
    const { deps, calls } = scripted({ control: reply(answer), http: healthOf(ID) });
    const probe = await createProbe(deps)(f.ws);
    expect(probe.state).toBe('unhealthy');
    expect(calls.http).toEqual([]);
  });

  it('a runtime that has not bound its port yet (phase ready without a url) is unhealthy, phase starting is starting', async () => {
    const f = workspace();
    const unbound = identity({ phase: 'ready', port: null, url: null });
    expect((await createProbe(scripted({ control: reply(unbound) }).deps)(f.ws)).state).toBe('unhealthy');
    const starting = identity({ phase: 'starting', port: null, url: null });
    const { deps, calls } = scripted({ control: reply(starting) });
    expect(await createProbe(deps)(f.ws)).toMatchObject({ state: 'starting', engine: 'node', pid: 4242, url: null });
    expect(calls.http).toEqual([]);
  });

  it('phase stopping is stopping', async () => {
    const f = workspace();
    const stopping = identity({ phase: 'stopping' });
    const { deps, calls } = scripted({ control: reply(stopping) });
    expect(await createProbe(deps)(f.ws)).toMatchObject({ state: 'stopping', pid: 4242 });
    expect(calls.http).toEqual([]);
  });

  it('another instance id on the pipe of this instance is unhealthy (impossible by construction)', async () => {
    const f = workspace();
    const probe = await createProbe(scripted({ control: reply(identity({ instanceId: OTHER_ID })) }).deps)(f.ws);
    expect(probe.state).toBe('unhealthy');
    expect(probe.reason).toContain('another instance');
  });

  it('a refusal is not an identity', async () => {
    const f = workspace();
    const refusal: ControlAttempt = { kind: 'refusal', error: 'BAD_REQUEST' };
    const probe = await createProbe(scripted({ control: refusal }).deps)(f.ws);
    expect(probe.state).toBe('unhealthy');
    expect(probe.reason).toContain('BAD_REQUEST');
  });
});

describe('probeInstance: a runtime holds the name and says nothing (hung)', () => {
  const silent: ControlAttempt = { kind: 'silent', reason: 'timeout' };

  it('takes the pid from the state file when its instance id matches', async () => {
    const f = workspace();
    writeState(f, nodeState(555));
    const { deps, calls } = scripted({ control: silent, runtimeProcesses: [] });
    const probe = await createProbe(deps)(f.ws, { runtimeDir: f.runtimeDir });
    expect(probe).toMatchObject({ state: 'unhealthy', engine: 'node', pid: 555, url: URL_OF(PORT) });
    expect(calls.lists).toEqual([]);
  });

  it('else asks the process listing for the runtime of this instance (one query)', async () => {
    const f = workspace();
    writeState(f, nodeState(555, PORT, OTHER_ID));
    const { deps, calls } = scripted({
      control: silent,
      runtimeProcesses: [
        { pid: 600, instanceId: OTHER_ID, instanceDir: null },
        { pid: 601, instanceId: ID, instanceDir: f.ws.dir },
      ],
    });
    const probe = await createProbe(deps)(f.ws, { runtimeDir: f.runtimeDir });
    expect(probe).toMatchObject({ state: 'unhealthy', pid: 601 });
    expect(calls.lists).toEqual([null]);
  });

  it('finds a runtime of this instance started from another folder of the same install (ADR 0062: any folder, by id)', async () => {
    const f = workspace();
    const { deps, calls } = scripted({
      control: silent,
      runtimeProcesses: [
        { pid: 610, instanceId: OTHER_ID, instanceDir: null },
        { pid: 611, instanceId: ID, instanceDir: f.ws.dir },
      ],
    });
    const probe = await createProbe(deps)(f.ws, { runtimeDir: path.join(f.runtimeDir, 'newer-version') });
    expect(probe).toMatchObject({ state: 'unhealthy', pid: 611 });
    expect(calls.lists).toEqual([null]);
  });

  it('a legacy-shaped state file does not name our runtime either: the listing decides', async () => {
    const f = workspace();
    writeState(f, legacyState(555));
    const { deps } = scripted({
      control: silent,
      runtimeProcesses: [{ pid: 601, instanceId: ID, instanceDir: null }],
    });
    expect((await createProbe(deps)(f.ws, { runtimeDir: f.runtimeDir })).pid).toBe(601);
  });

  it('no pid is known when nothing matches, when the listing fails, and when no runtime folder was given', async () => {
    const f = workspace();
    const none = await createProbe(scripted({ control: silent, runtimeProcesses: [] }).deps)(f.ws, {
      runtimeDir: f.runtimeDir,
    });
    expect(none).toMatchObject({ state: 'unhealthy', pid: null });
    const failing = await createProbe(scripted({ control: silent, runtimeProcesses: 'throw' }).deps)(f.ws, {
      runtimeDir: f.runtimeDir,
    });
    expect(failing).toMatchObject({ state: 'unhealthy', pid: null });
    const { deps, calls } = scripted({ control: silent });
    expect(await createProbe(deps)(f.ws)).toMatchObject({ state: 'unhealthy', pid: null });
    expect(calls.lists).toEqual([]);
  });

  it('every kind of silence is unhealthy and says why', async () => {
    const f = workspace();
    for (const reason of ['timeout', 'reset', 'closed', 'garbled', 'error:EACCES']) {
      const probe = await createProbe(scripted({ control: { kind: 'silent', reason } }).deps)(f.ws);
      expect(probe.state).toBe('unhealthy');
      expect(probe.reason).toContain(reason);
    }
  });
});

describe('probeInstance: options', () => {
  it('passes the timeouts on, 2000 ms by default', async () => {
    const f = workspace();
    const custom = scripted({ control: reply(identity()), http: healthOf(ID) });
    await createProbe(custom.deps)(f.ws, { controlTimeoutMs: 250, httpTimeoutMs: 750 });
    expect(custom.calls.identify[0]?.timeoutMs).toBe(250);
    expect(custom.calls.http[0]?.timeoutMs).toBe(750);
  });
});

describe('state predicates', () => {
  it('running means a healthy runtime of this install, not a monitor that it did not start', () => {
    expect(isRunningState('running')).toBe(true);
    for (const state of [
      'starting',
      'stopping',
      'unhealthy',
      'stopped',
      'stale',
      'foreign-pid',
      'unmanaged-running',
    ] as const) {
      expect(isRunningState(state)).toBe(false);
    }
  });

  it('live means that a monitor process holds the instance', () => {
    for (const state of ['running', 'starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const) {
      expect(isLiveState(state)).toBe(true);
    }
    for (const state of ['stopped', 'stale', 'foreign-pid'] as const) {
      expect(isLiveState(state)).toBe(false);
    }
  });

  it('isLoopbackBase accepts only http://127.0.0.1:<port>', () => {
    expect(isLoopbackBase('http://127.0.0.1:18000')).toBe(true);
    expect(isLoopbackBase('http://127.0.0.1:65535')).toBe(true);
    for (const bad of [
      'http://localhost:18000',
      'https://127.0.0.1:18000',
      'http://127.0.0.1',
      'http://127.0.0.1:18000/',
      'http://127.0.0.1:18000/x',
      'http://127.0.0.1:999999',
      'http://127.0.0.1.evil.example:80',
      'http://user@127.0.0.1:80',
      '',
    ]) {
      expect(isLoopbackBase(bad), bad).toBe(false);
    }
  });
});

// ---- the control address -----------------------------------------------------------------------------------------------------

describe('controlAddressOf (01 4.3)', () => {
  // the per-platform table is tested once, in packages/shared/src/control-address.test.ts; this is the wrapper's consistency check
  it('is the shared controlAddress for the host it is given, and for this host by default', () => {
    for (const platform of ['win32', 'linux', 'darwin', 'other'] as const) {
      const host = { platform, tmpdir: path.join(path.sep, 'tmp'), uid: 501 };
      expect(controlAddressOf(ID, host), platform).toBe(controlAddress(ID, host));
    }
    expect(controlAddressOf(ID)).toBe(
      controlAddress(ID, {
        platform: hostPlatform,
        tmpdir: os.tmpdir(),
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      }),
    );
    expect(() => controlAddressOf('not-a-uuid')).toThrow(RangeError);
  });
});

// ---- the two real clients ------------------------------------------------------------------------------------------------------

function uniqueAddress(): string {
  const name = `mcs-test-probe-${randomBytes(6).toString('hex')}`;
  return hostPlatform === 'win32'
    ? `${BACKSLASH}${BACKSLASH}.${BACKSLASH}pipe${BACKSLASH}${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

const servers: net.Server[] = [];
const httpServers: HttpServer[] = [];
/** Every connection the test servers accepted: a half-open connection of a silent server would keep `close` waiting. */
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

function listenOn(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** A control server in this process: `behave` gets every connection and its first request line. */
async function controlServer(behave: (socket: net.Socket, line: string) => void): Promise<string> {
  const address = uniqueAddress();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let pending = '';
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const end = pending.indexOf(LF);
      if (end >= 0) behave(socket, pending.slice(0, end));
    });
  });
  servers.push(server);
  await listenOn(server, address);
  return address;
}

async function httpServer(handler: (url: string, host: string | undefined) => { status: number; body: string }) {
  const port = await allocatePort();
  const server = createHttpServer((req, res) => {
    const { status, body } = handler(req.url ?? '', req.headers.host);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  httpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, resolve);
  });
  return port;
}

const IDENTIFY: ControlRequest = { v: 1, op: 'identify' };

describe('requestControl (the client of 01 4.3)', () => {
  it('sends one request line and returns the parsed reply', async () => {
    const seen: string[] = [];
    const address = await controlServer((socket, line) => {
      seen.push(line);
      socket.end(`${JSON.stringify(identity())}${LF}`);
    });
    const attempt = await requestControl(address, IDENTIFY, { timeoutMs: 2000 });
    expect(attempt).toEqual({ kind: 'reply', response: identity() });
    expect(seen).toEqual([JSON.stringify(IDENTIFY)]);
  });

  it('reads a reply that arrives in pieces', async () => {
    const text = `${JSON.stringify(identity())}${LF}`;
    const split = await controlServer((socket) => {
      socket.write(text.slice(0, 20));
      setImmediate(() => {
        socket.end(text.slice(20));
      });
    });
    expect(await requestControl(split, IDENTIFY, { timeoutMs: 2000 })).toEqual({
      kind: 'reply',
      response: identity(),
    });
  });

  it('a refusal comes back as a refusal with its code, not as a reply', async () => {
    const refusing = await controlServer((socket) => {
      const response: ControlResponse = { v: 1, ok: false, error: 'FORBIDDEN' };
      socket.end(`${JSON.stringify(response)}${LF}`);
    });
    expect(await requestControl(refusing, IDENTIFY, { timeoutMs: 2000 })).toEqual({
      kind: 'refusal',
      error: 'FORBIDDEN',
    });
  });

  it('carries a reply other than identify too (the shutdown acknowledgement)', async () => {
    const address = await controlServer((socket) => {
      const response: ControlResponse = { v: 1, ok: true, op: 'shutdown', phase: 'stopping' };
      socket.end(`${JSON.stringify(response)}${LF}`);
    });
    const request: ControlRequest = { v: 1, op: 'shutdown', instanceId: ID, token: 'x'.repeat(64), reason: 'stop' };
    expect(await requestControl(address, request, { timeoutMs: 2000 })).toEqual({
      kind: 'reply',
      response: { v: 1, ok: true, op: 'shutdown', phase: 'stopping' },
    });
  });

  it('nobody on the name: absent', async () => {
    expect(await requestControl(uniqueAddress(), IDENTIFY, { timeoutMs: 2000 })).toEqual({ kind: 'absent' });
  });

  it('a server that accepts and never answers: silent after the timeout', async () => {
    const address = await controlServer(() => undefined);
    const started = performance.now();
    const attempt = await requestControl(address, IDENTIFY, { timeoutMs: 300 });
    expect(attempt).toEqual({ kind: 'silent', reason: 'timeout' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('a server that closes without a reply, or answers noise: silent', async () => {
    const closing = await controlServer((socket) => {
      socket.destroy();
    });
    expect((await requestControl(closing, IDENTIFY, { timeoutMs: 2000 })).kind).toBe('silent');
    const noisy = await controlServer((socket) => {
      socket.end(`hello${LF}`);
    });
    expect(await requestControl(noisy, IDENTIFY, { timeoutMs: 2000 })).toEqual({ kind: 'silent', reason: 'garbled' });
  });
});

describe('httpGet', () => {
  it('returns the status and the body, with Host 127.0.0.1:<port>', async () => {
    let host: string | undefined;
    const port = await httpServer((url, h) => {
      host = h;
      return { status: 200, body: JSON.stringify({ url }) };
    });
    const attempt = await httpGet(`${URL_OF(port)}/api/v3/health`, { timeoutMs: 2000 });
    expect(attempt).toEqual({ ok: true, reply: { status: 200, body: JSON.stringify({ url: '/api/v3/health' }) } });
    expect(host).toBe(`127.0.0.1:${String(port)}`);
  });

  it('returns an error status as a reply, not as a failure', async () => {
    const port = await httpServer(() => ({ status: 503, body: '{}' }));
    expect(await httpGet(`${URL_OF(port)}/x`, { timeoutMs: 2000 })).toEqual({
      ok: true,
      reply: { status: 503, body: '{}' },
    });
  });

  it('a closed port is refused', async () => {
    const free = await allocatePort();
    expect(await httpGet(`${URL_OF(free)}/x`, { timeoutMs: 2000 })).toEqual({ ok: false, reason: 'refused' });
  });

  it('a server that never answers times out', async () => {
    const hung = await allocatePort();
    const server = createHttpServer(() => undefined);
    httpServers.push(server);
    await new Promise<void>((resolve) => {
      server.listen({ port: hung, host: '127.0.0.1' }, resolve);
    });
    expect(await httpGet(`${URL_OF(hung)}/x`, { timeoutMs: 300 })).toEqual({ ok: false, reason: 'timeout' });
  });

  it('an oversized body is cut and reported', async () => {
    const big = await httpServer(() => ({ status: 200, body: 'x'.repeat(5000) }));
    expect(await httpGet(`${URL_OF(big)}/x`, { timeoutMs: 2000, maxBytes: 1000 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('refuses a base that is not loopback without connecting', async () => {
    await expect(httpGet('http://203.0.113.9:80/x', { timeoutMs: 100 })).rejects.toThrow(RangeError);
  });
});

// FIXTURE: invented data for tests
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_TOKEN = '0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100';

describe('httpGet and httpGetWithHeaders: the control token as a Bearer header (A1)', () => {
  async function capturing(): Promise<{ port: number; seen: (string | undefined)[] }> {
    const seen: (string | undefined)[] = [];
    const port = await allocatePort();
    const server = createHttpServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    httpServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1' }, resolve);
    });
    return { port, seen };
  }

  it('sends Authorization: Bearer <token> when it is given one, and no Authorization header otherwise', async () => {
    const { port, seen } = await capturing();
    await httpGetWithHeaders(`${URL_OF(port)}/api/v3/export`, { timeoutMs: 2000, bearer: TOKEN });
    await httpGetWithHeaders(`${URL_OF(port)}/api/v3/export`, { timeoutMs: 2000 });
    await httpGet(`${URL_OF(port)}/api/v3/health`, { timeoutMs: 2000, bearer: OTHER_TOKEN });
    await httpGet(`${URL_OF(port)}/api/v3/health`, { timeoutMs: 2000 });
    expect(seen).toEqual([`Bearer ${TOKEN}`, undefined, `Bearer ${OTHER_TOKEN}`, undefined]);
  });

  it('refuses a value that is not a control token before it connects, so that nothing can ride along in the header', async () => {
    const { port, seen } = await capturing();
    for (const bearer of [
      '',
      'x',
      TOKEN.slice(1),
      `${TOKEN}0`,
      TOKEN.toUpperCase(),
      `${TOKEN.slice(0, 62)}${CRLF}`,
      `${TOKEN.slice(0, 40)}${CRLF}X-Injected: 1${TOKEN.slice(0, 20)}`,
    ]) {
      await expect(httpGetWithHeaders(`${URL_OF(port)}/x`, { timeoutMs: 2000, bearer }), bearer).rejects.toThrow(
        RangeError,
      );
    }
    expect(seen).toEqual([]);
  });

  it('never sends it anywhere but 127.0.0.1', async () => {
    await expect(httpGetWithHeaders('http://203.0.113.9:80/x', { timeoutMs: 100, bearer: TOKEN })).rejects.toThrow(
      RangeError,
    );
    await expect(httpGetWithHeaders('http://localhost:80/x', { timeoutMs: 100, bearer: TOKEN })).rejects.toThrow(
      RangeError,
    );
  });

  it('keeps the token out of the error it raises for a bad value', async () => {
    const bad = `${TOKEN}0`;
    try {
      await httpGetWithHeaders(`${URL_OF(18001)}/x`, { timeoutMs: 100, bearer: bad });
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(TOKEN);
    }
    expect.assertions(1);
  });
});

describe('createControlTokenSource (A1)', () => {
  function tokenFile(content: string | Buffer): string {
    const dir = path.join(makeTemp('token').path, 'run');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'control.token');
    writeFileSync(file, content);
    return file;
  }

  it('reads the token of run/control.token (64 hex digits and a line feed)', async () => {
    const source = createControlTokenSource(tokenFile(`${TOKEN}${LF}`));
    expect(await source()).toBe(TOKEN);
  });

  it('reads the file once while its size and times stay the same, and again when it is replaced', async () => {
    const file = tokenFile(`${TOKEN}${LF}`);
    let reads = 0;
    const source = createControlTokenSource(file, {
      read: (target, maxBytes) => {
        reads += 1;
        return readSmallFile(target, maxBytes);
      },
    });
    expect(await source()).toBe(TOKEN);
    expect(await source()).toBe(TOKEN);
    expect(await source()).toBe(TOKEN);
    expect(reads).toBe(1);
    // a new boot writes a new token: same size, another time
    writeFileSync(file, `${OTHER_TOKEN}${LF}`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(await source()).toBe(OTHER_TOKEN);
    expect(await source()).toBe(OTHER_TOKEN);
    expect(reads).toBe(2);
  });

  it('answers null for a missing file, and the token once the file is there', async () => {
    const file = tokenFile(`${TOKEN}${LF}`);
    const missing = path.join(path.dirname(file), 'absent.token');
    const source = createControlTokenSource(missing);
    expect(await source()).toBeNull();
    writeFileSync(missing, `${TOKEN}${LF}`);
    expect(await source()).toBe(TOKEN);
  });

  it('answers null once the file is gone, and does not keep the old token', async () => {
    const file = tokenFile(`${TOKEN}${LF}`);
    const source = createControlTokenSource(file);
    expect(await source()).toBe(TOKEN);
    unlinkSync(file);
    expect(await source()).toBeNull();
  });

  it('answers null for content that is not a control token', async () => {
    for (const content of [
      '',
      LF,
      'x',
      TOKEN.slice(1),
      `${TOKEN}0`,
      TOKEN.toUpperCase(),
      `${TOKEN} ${OTHER_TOKEN}`,
      `token=${TOKEN}`,
      Buffer.from([0xff, 0xfe, 0x00]),
      'a'.repeat(5000),
    ]) {
      const source = createControlTokenSource(tokenFile(content));
      expect(await source(), String(content).slice(0, 20)).toBeNull();
    }
  });

  it('never rejects: a read that fails is a null', async () => {
    const source = createControlTokenSource(tokenFile(`${TOKEN}${LF}`), {
      read: () => Promise.reject(new Error('the file is locked')),
    });
    expect(await source()).toBeNull();
  });
});

describe('probeInstance over the real clients', () => {
  it('finds a running instance on a real pipe and a real port, and a stopped one after they close', async () => {
    const f = workspace({ instanceId: REAL_ID });
    const port = await allocatePort();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.end(
          `${JSON.stringify(identity({ instanceId: REAL_ID, port, url: URL_OF(port), pid: process.pid }))}${LF}`,
        );
      });
    });
    servers.push(server);
    await listenOn(server, controlAddressOf(REAL_ID));
    const web = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ instanceId: REAL_ID }));
    });
    httpServers.push(web);
    await new Promise<void>((resolve) => {
      web.listen({ port, host: '127.0.0.1' }, resolve);
    });

    const probe = await probeInstance(f.ws, { runtimeDir: f.runtimeDir });
    expect(probe).toMatchObject({ state: 'running', pid: process.pid, port, url: URL_OF(port) });

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    servers.splice(servers.indexOf(server), 1);
    expect((await probeInstance(f.ws, { runtimeDir: f.runtimeDir })).state).toBe('stopped');
  });
});
