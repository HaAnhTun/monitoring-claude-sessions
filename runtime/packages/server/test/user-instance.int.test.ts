// The user instance on the server boot (06 1.7, 1.8, 3.2; CAW-24): a real workspace of kind `user` in a temporary MCS_HOME, a real
// database, a real control channel and real sockets, booted in this process. The terminal census and the access minter are
// fakes handed in through `factories` (no node-pty): they prove what the server does with them. Covers `identify`, `terminals`,
// `access`, the refused `shutdown`, `force`, the `signal` path, the location refusal (exit 17), the instance information, and a
// task instance (no terminals, no access).
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  EMPTY_USER_SERVICES,
  defaultSkillDir,
  initWorkspace,
  userRootOf,
  type AccessMint,
  type RuntimeFactories,
  type TerminalCensus,
  type TerminalCensusEntry,
} from '@mcs/engine';
import { InstanceInfoSchema, RUNTIME_VERSION } from '@mcs/shared';
import type { ControlRequest } from '@mcs/shared/protocol';
import { allocatePort, assertPortClosed, hermeticEnv, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, type BootInput, type BootResult, type RunningServer } from '../src/boot.ts';
import { controlAddress, requestControl } from '../src/control-channel.ts';

const makeTemp = useTempDirs();
const STAMP = {
  schemaVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  buildStamp: 'f'.repeat(64),
  codeStamp: 'abcdef0123',
  node: 'v24.0.0',
  builtAt: '2026-10-12T08:00:00.000Z',
};

// FIXTURE: invented data for tests
const SESSIONS: readonly TerminalCensusEntry[] = [
  { name: 'api-1', startedAt: '2026-11-14T10:00:00.000Z' },
  { name: 'web-1', startedAt: '2026-11-14T10:05:00.000Z' },
];
const ACCESS_CODE = `Zq8-invented_code-${'k'.repeat(24)}`;
const MINT: AccessMint = { code: ACCESS_CODE, expiresAtMs: Date.UTC(2026, 10, 14, 10, 2, 0), ttlSeconds: 120 };

interface Fixture {
  readonly root: string;
  readonly runtimeDir: string;
  readonly ws: string;
  readonly id: string;
  readonly env: Record<string, string>;
}

/** A skill folder with defaults and a build stamp; the workspace is made by `userFixture` or `taskFixture`. */
function skeleton(): { root: string; runtimeDir: string; env: Record<string, string> } {
  const root = makeTemp('user-instance').path;
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  writeFileSync(path.join(runtimeDir, '.mcs-build.json'), JSON.stringify(STAMP));
  return { root, runtimeDir, env: hermeticEnv(root) };
}

/** The user instance of a temporary MCS_HOME: the workspace `user` under the user root, as `ensureUserInstance` makes it. */
async function userFixture(extraEnv: Record<string, string> = {}, runtime?: Record<string, unknown>): Promise<Fixture> {
  const base = skeleton();
  const env = { ...base.env, ...extraEnv };
  const userRoot = userRootOf(env);
  mkdirSync(userRoot, { recursive: true });
  const id = randomUUID();
  const { ws } = await initWorkspace({
    repo: userRoot,
    root: userRoot,
    name: 'Claude Agent Workspace',
    slug: 'user',
    kind: 'user',
    newId: () => id,
  });
  if (runtime !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, ...runtime }));
  }
  return { root: base.root, runtimeDir: base.runtimeDir, ws: ws.dir, id, env };
}

/** An ordinary task workspace in a repository, or (`kind: 'user'`) the hand-edited one that must not boot. */
async function taskFixture(kind?: 'user'): Promise<Fixture> {
  const base = skeleton();
  const repo = path.join(base.root, 'repo');
  mkdirSync(repo);
  const id = randomUUID();
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    description: 'A synthetic task.',
    newId: () => id,
    ...(kind === undefined ? {} : { kind }),
  });
  return { root: base.root, runtimeDir: base.runtimeDir, ws: ws.dir, id, env: base.env };
}

interface FakeCensus extends TerminalCensus {
  /** How many times the server asked the census to stop accepting sessions. */
  drains(): number;
  /** The sessions that are live now; the test changes them. */
  setLive(sessions: readonly TerminalCensusEntry[]): void;
}

function fakeCensus(initial: readonly TerminalCensusEntry[]): FakeCensus {
  let live = initial;
  let drained = 0;
  return {
    count: () => live.length,
    sessions: (limit) => live.slice(0, limit),
    beginDrain: () => {
      drained += 1;
    },
    drains: () => drained,
    setLive: (sessions) => {
      live = sessions;
    },
  };
}

function userServices(
  census: TerminalCensus,
  minted: { count: number } = { count: 0 },
): RuntimeFactories['createUserServices'] {
  return () => ({
    census,
    access: {
      mint: () => {
        minted.count += 1;
        return MINT;
      },
    },
    components: [],
  });
}

const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.requestShutdown('stop');
    await server.closed;
  }
});

interface Started {
  readonly server: RunningServer;
  readonly port: number;
}

async function tryBoot(f: Fixture, over: Partial<BootInput> = {}): Promise<{ result: BootResult; port: number }> {
  const port = await allocatePort();
  const result = await bootServer({
    argv: ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`],
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: () => undefined,
    ...over,
  });
  if (result.ok) running.push(result.server);
  return { result, port };
}

async function start(f: Fixture, over: Partial<BootInput> = {}): Promise<Started> {
  const { result, port } = await tryBoot(f, over);
  if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message}`);
  return { server: result.server, port };
}

const tokenOf = (f: Fixture): string => readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8').trim();
const control = (f: Fixture, request: ControlRequest) =>
  requestControl(controlAddress(f.id), request, { timeoutMs: 10_000 });
const terminals = (f: Fixture) => control(f, { v: 1, op: 'terminals', instanceId: f.id, token: tokenOf(f) });
const access = (f: Fixture) => control(f, { v: 1, op: 'access', instanceId: f.id, token: tokenOf(f) });
const shutdown = (f: Fixture, reason: 'stop' | 'signal', force = false) =>
  control(f, {
    v: 1,
    op: 'shutdown',
    instanceId: f.id,
    token: tokenOf(f),
    reason,
    ...(force ? { force: true as const } : {}),
  });
const identify = (f: Fixture) => control(f, { v: 1, op: 'identify' });

function logText(f: Fixture): string {
  const file = path.join(f.ws, 'logs', 'runtime.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('a user instance boots (06 1.7)', () => {
  it('identify: the same answer as a task, in the phase ready, with the bound port and no terminal data', async () => {
    const f = await userFixture();
    const { port } = await start(f, { factories: { createUserServices: userServices(fakeCensus(SESSIONS)) } });
    const reply = await identify(f);
    expect(reply).toMatchObject({
      ok: true,
      op: 'identify',
      instanceId: f.id,
      pid: process.pid,
      phase: 'ready',
      runtimeVersion: RUNTIME_VERSION,
      port,
      url: `http://127.0.0.1:${String(port)}`,
    });
    const text = JSON.stringify(reply);
    for (const session of SESSIONS) expect(text).not.toContain(session.name);
    expect(text).not.toContain(tokenOf(f));
  });

  it('serves the instance information with kind user and the configured app name', async () => {
    const f = await userFixture({}, { app: { name: 'Team Workspace' } });
    const { port } = await start(f, { factories: { createUserServices: userServices(fakeCensus([])) } });
    const response = await httpRequest(port, '/api/v3/instance');
    expect(response.status).toBe(200);
    const info = InstanceInfoSchema.parse(JSON.parse(response.body));
    expect(info.kind).toBe('user');
    expect(info.app).toEqual({ name: 'Team Workspace' });
    expect(info.instanceId).toBe(f.id);
    for (const command of Object.values(info.commands)) expect(command).toContain(' --user');
  });

  it('refuses a workspace of kind user outside the user folder with exit 17 and starts nothing', async () => {
    const f = await taskFixture('user');
    const { result } = await tryBoot(f);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(17);
    expect(result.message).not.toContain(f.ws);
    expect(existsSync(path.join(f.ws, 'run', 'control.token'))).toBe(false);
    expect(existsSync(path.join(f.ws, 'state.json'))).toBe(false);
  });
});

describe('the control op terminals', () => {
  it('reports the live count, the limit of the configuration and the sessions, oldest first', async () => {
    const f = await userFixture({}, { terminal: { maxSessions: 5 } });
    await start(f, { factories: { createUserServices: userServices(fakeCensus(SESSIONS)) } });
    expect(await terminals(f)).toEqual({ v: 1, ok: true, op: 'terminals', live: 2, max: 5, sessions: [...SESSIONS] });
  });

  it('reads the census when the request arrives, so sessions that start later are counted', async () => {
    const f = await userFixture();
    const census = fakeCensus([]);
    await start(f, { factories: { createUserServices: userServices(census) } });
    expect(await terminals(f)).toMatchObject({ ok: true, live: 0, sessions: [] });
    census.setLive(SESSIONS);
    expect(await terminals(f)).toMatchObject({ ok: true, live: 2 });
  });

  it('refuses a wrong token and a wrong instance id, and says nothing about the sessions', async () => {
    const f = await userFixture();
    await start(f, { factories: { createUserServices: userServices(fakeCensus(SESSIONS)) } });
    const wrongToken = await control(f, { v: 1, op: 'terminals', instanceId: f.id, token: 'a'.repeat(64) });
    expect(wrongToken).toEqual({ v: 1, ok: false, error: 'FORBIDDEN' });
    const wrongId = await control(f, { v: 1, op: 'terminals', instanceId: randomUUID(), token: tokenOf(f) });
    expect(wrongId).toMatchObject({ ok: false });
    expect(JSON.stringify([wrongToken, wrongId])).not.toContain('api-1');
  });

  it('logs no session name', async () => {
    const f = await userFixture();
    const { server } = await start(f, { factories: { createUserServices: userServices(fakeCensus(SESSIONS)) } });
    await terminals(f);
    await shutdown(f, 'stop', true);
    await server.closed;
    const text = logText(f);
    expect(text).not.toBe('');
    for (const session of SESSIONS) expect(text).not.toContain(session.name);
  });
});

describe('the control op access', () => {
  it('mints a code through the minter and answers with its expiry and lifetime', async () => {
    const f = await userFixture();
    const minted = { count: 0 };
    await start(f, { factories: { createUserServices: userServices(fakeCensus([]), minted) } });
    expect(await access(f)).toEqual({
      v: 1,
      ok: true,
      op: 'access',
      code: ACCESS_CODE,
      expiresAt: '2026-11-14T10:02:00.000Z',
      ttlSeconds: 120,
    });
    expect(minted.count).toBe(1);
  });

  it('needs the token: a wrong one mints nothing', async () => {
    const f = await userFixture();
    const minted = { count: 0 };
    await start(f, { factories: { createUserServices: userServices(fakeCensus([]), minted) } });
    expect(await control(f, { v: 1, op: 'access', instanceId: f.id, token: 'b'.repeat(64) })).toEqual({
      v: 1,
      ok: false,
      error: 'FORBIDDEN',
    });
    expect(minted.count).toBe(0);
  });

  it('answers UNSUPPORTED while the user services have no minter', async () => {
    const f = await userFixture();
    await start(f, { factories: { createUserServices: () => ({ ...EMPTY_USER_SERVICES, access: null }) } });
    expect(await access(f)).toEqual({ v: 1, ok: false, error: 'UNSUPPORTED' });
  });

  it('never writes the code to the log, to state.json or to the identify reply', async () => {
    const f = await userFixture();
    const { server } = await start(f, { factories: { createUserServices: userServices(fakeCensus([])) } });
    await access(f);
    expect(readFileSync(path.join(f.ws, 'state.json'), 'utf8')).not.toContain(ACCESS_CODE);
    expect(JSON.stringify(await identify(f))).not.toContain(ACCESS_CODE);
    await shutdown(f, 'stop');
    await server.closed;
    expect(logText(f)).not.toBe('');
    expect(logText(f)).not.toContain(ACCESS_CODE);
  });
});

describe('the control op shutdown while terminals are live (06 3.2)', () => {
  it('refuses a stop without force with TERMINALS_LIVE: the instance keeps running and nothing is drained', async () => {
    const f = await userFixture();
    const census = fakeCensus(SESSIONS);
    const { port } = await start(f, { factories: { createUserServices: userServices(census) } });
    expect(await shutdown(f, 'stop')).toEqual({ v: 1, ok: false, error: 'TERMINALS_LIVE' });
    expect(await identify(f)).toMatchObject({ ok: true, phase: 'ready', port });
    expect(census.drains()).toBe(0);
    expect((await httpRequest(port, '/api/v3/instance')).status).toBe(200);
  });

  it('accepts a stop without force once no session is left', async () => {
    const f = await userFixture();
    const census = fakeCensus(SESSIONS);
    const { server } = await start(f, { factories: { createUserServices: userServices(census) } });
    expect(await shutdown(f, 'stop')).toMatchObject({ ok: false, error: 'TERMINALS_LIVE' });
    census.setLive([]);
    expect(await shutdown(f, 'stop')).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    expect((await server.closed).exitCode).toBe(0);
    expect(census.drains()).toBe(1);
  });

  it('stops with force although terminals are live, after draining the census once', async () => {
    const f = await userFixture();
    const census = fakeCensus(SESSIONS);
    const { server, port } = await start(f, { factories: { createUserServices: userServices(census) } });
    expect(await shutdown(f, 'stop', true)).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    expect((await server.closed).exitCode).toBe(0);
    expect(census.drains()).toBe(1);
    await assertPortClosed(port);
    expect(existsSync(path.join(f.ws, 'state.json'))).toBe(false);
  });

  it('never refuses the reason signal (logoff, Ctrl+C), live terminals or not', async () => {
    const f = await userFixture();
    const census = fakeCensus(SESSIONS);
    const { server } = await start(f, { factories: { createUserServices: userServices(census) } });
    expect(await shutdown(f, 'signal')).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    expect((await server.closed).exitCode).toBe(0);
    expect(census.drains()).toBe(1);
  });
});

describe('MCS_TEST_FAKE_TERMINALS (06 1.7): scripted sessions on a real boot', () => {
  it('adds fake-1..fake-n to the census of the user instance, and the guard refuses a stop for them', async () => {
    const f = await userFixture({ MCS_TEST_FAKE_TERMINALS: '2' });
    const { port } = await start(f);
    expect(await terminals(f)).toMatchObject({
      ok: true,
      op: 'terminals',
      live: 2,
      sessions: [{ name: 'fake-1' }, { name: 'fake-2' }],
    });
    expect(await shutdown(f, 'stop')).toEqual({ v: 1, ok: false, error: 'TERMINALS_LIVE' });
    expect(await identify(f)).toMatchObject({ ok: true, phase: 'ready', port });
  });

  it('adds them to the real sessions of the services, never replacing them', async () => {
    const f = await userFixture({ MCS_TEST_FAKE_TERMINALS: '1' });
    await start(f, { factories: { createUserServices: userServices(fakeCensus(SESSIONS)) } });
    const reply = await terminals(f);
    expect(reply).toMatchObject({ ok: true, live: 3 });
    if (!reply.ok || reply.op !== 'terminals') throw new Error('terminals expected');
    expect(reply.sessions.map((s) => s.name)).toEqual(['fake-1', 'api-1', 'web-1']);
  });

  it('does nothing outside test mode', async () => {
    const f = await userFixture({ MCS_TEST_FAKE_TERMINALS: '2', MCS_TEST: '' });
    await start(f);
    expect(await terminals(f)).toMatchObject({ ok: true, live: 0, sessions: [] });
  });
});

describe('a task instance has no terminals and no access (06 1.7)', () => {
  it('answers terminals with an empty census and access with UNSUPPORTED, and its info says task', async () => {
    const f = await taskFixture();
    const { port } = await start(f);
    expect(await terminals(f)).toMatchObject({ v: 1, ok: true, op: 'terminals', live: 0, sessions: [] });
    expect(await access(f)).toEqual({ v: 1, ok: false, error: 'UNSUPPORTED' });
    const info = InstanceInfoSchema.parse(JSON.parse((await httpRequest(port, '/api/v3/instance')).body));
    expect(info.kind).toBe('task');
    expect(info.app).toBeNull();
    for (const command of Object.values(info.commands)) expect(command).toContain('--task demo');
  });

  it('is never guarded: a stop without force goes through, even with the fake terminals set', async () => {
    const f = await taskFixture();
    const env = { ...f.env, MCS_TEST_FAKE_TERMINALS: '3' };
    const { server } = await start({ ...f, env });
    expect(await terminals(f)).toMatchObject({ ok: true, live: 0 });
    expect(await shutdown(f, 'stop')).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    expect((await server.closed).exitCode).toBe(0);
  });
});
