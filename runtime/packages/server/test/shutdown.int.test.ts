// Graceful shutdown of a booted server (01 4.5): T-LC-05 (the six steps in order, inside shutdownGraceMs, the -wal truncated,
// state.json, the token, the port and the control name released), the second trigger, the missed deadline, a shutdown that
// arrives while the server is still starting, and the exit code of the real process. Real workspace, database and sockets.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultSkillDir, initWorkspace, openInstanceDb, type RuntimeFactories } from '@mcs/engine';
import { RUNTIME_VERSION } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  spawnTracked,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, type BootInput, type RunningServer } from '../src/boot.ts';
import { controlAddress, requestControl } from '../src/control-channel.ts';
import { SHUTDOWN_STEP_NAMES, createShutdownGate } from '../src/shutdown.ts';

const makeTemp = useTempDirs();
const REAL_BOOT = fileURLToPath(new URL('../dist/boot.js', import.meta.url));
const STAMP = {
  schemaVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  buildStamp: 'f'.repeat(64),
  codeStamp: 'abcdef0123',
};

interface Fixture {
  readonly root: string;
  readonly runtimeDir: string;
  readonly ws: string;
  readonly id: string;
  readonly env: Record<string, string>;
}

async function fixture(o: { runtime?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<Fixture> {
  const root = makeTemp('serve-shutdown').path;
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  writeFileSync(path.join(runtimeDir, '.mcs-build.json'), JSON.stringify(STAMP));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const id = randomUUID();
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    description: 'A synthetic task.',
    newId: () => id,
  });
  if (o.runtime !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, ...o.runtime }));
  }
  return { root, runtimeDir, ws: ws.dir, id, env: { ...hermeticEnv(root), ...o.env } };
}

const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.requestShutdown('stop');
    await server.closed;
  }
  await killAllTracked();
});

function argvOf(f: Fixture, port: number): string[] {
  return ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`];
}

async function start(f: Fixture, over: Partial<BootInput> = {}): Promise<{ server: RunningServer; port: number }> {
  const port = await allocatePort();
  const result = await bootServer({
    argv: argvOf(f, port),
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: () => undefined,
    ...over,
  });
  if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message}`);
  running.push(result.server);
  return { server: result.server, port };
}

const tokenOf = (f: Fixture): string => readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8').trim();
const exists = (f: Fixture, ...segments: string[]): boolean => existsSync(path.join(f.ws, ...segments));

function runtimeLog(f: Fixture): { event: string; level: string; [key: string]: unknown }[] {
  return readFileSync(path.join(f.ws, 'logs', 'runtime.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { event: string; level: string });
}

/** An ingest service that does nothing, whose `stop` is whatever the test says. */
function ingestWith(stop: () => Promise<void>): ReturnType<RuntimeFactories['createIngestService']> {
  return {
    writer: {
      submit: () => false,
      onDrain: () => undefined,
      flushNow: () => Promise.resolve(),
      stats: { queued: 0, queuedBytes: 0, lastCommitAt: null, failures: 0 },
    },
    start: () => Promise.resolve(),
    stop,
    untilIdle: () => Promise.resolve(),
    nudge: () => undefined,
    replay: () => Promise.resolve({ segmentsReset: 0 }),
    stats: () => ({
      queued: 0,
      queuedBytes: 0,
      lastCommitAt: null,
      failures: 0,
      spoolBytesBehind: 0,
      transcriptBytesBehind: 0,
      backfillRemainingBytes: 0,
      filesTracked: 0,
    }),
  };
}

describe('T-LC-05: graceful shutdown by the control channel (01 4.5)', () => {
  it('runs steps 1-6 in order within shutdownGraceMs, truncates the WAL and leaves no file, port or name behind', async () => {
    const f = await fixture();
    const { server, port } = await start(f);
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    expect(existsSync(`${dbFile}-wal`), 'the database is in WAL mode while the server runs').toBe(true);
    const graceMs = server.ctx.config.runtime.server.shutdownGraceMs;

    const startedAt = Date.now();
    const reply = await requestControl(controlAddress(f.id), {
      v: 1,
      op: 'shutdown',
      instanceId: f.id,
      token: tokenOf(f),
      reason: 'stop',
    });
    expect(reply).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    const outcome = await server.closed;
    expect(Date.now() - startedAt).toBeLessThan(graceMs);
    expect(outcome).toMatchObject({
      exitCode: 0,
      deadlineExceededAtStep: null,
      pendingComponent: null,
      failedSteps: [],
    });

    const lines = runtimeLog(f);
    const events = lines.map((line) => line.event);
    const stepAt = events.flatMap((event, index) => (event === 'shutdown_step' ? [index] : []));
    expect(stepAt).toHaveLength(6);
    expect(events.indexOf('shutdown_begin')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('shutdown_begin')).toBeLessThan(stepAt[0] ?? -1);
    expect(events.indexOf('shutdown_done')).toBeGreaterThan(stepAt[5] ?? Number.POSITIVE_INFINITY);
    const steps = lines.filter((line) => line.event === 'shutdown_step');
    expect(steps.map((line) => line['count'])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.map((line) => line['phase'])).toEqual([...SHUTDOWN_STEP_NAMES]);
    expect(events.filter((event) => event === 'shutdown_begin')).toHaveLength(1);
    // the only warnings of a clean run are the stub services of this walking skeleton, logged when the runtime was created
    expect(
      lines.filter(
        (line) => (line.level === 'warn' || line.level === 'error') && line.event !== 'runtime_stub_service',
      ),
    ).toEqual([]);

    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    expect(existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0).toBe(0);
    await expect(requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 })).rejects.toThrow();
    await assertPortClosed(port);
    // the database is closed and whole: a maintenance open (which refuses a locked or damaged file) works
    openInstanceDb({
      path: dbFile,
      expectedInstanceId: f.id,
      mode: 'maintenance',
      runtimeVersion: RUNTIME_VERSION,
    }).close();
  });

  it('answers identify with phase stopping while it stops, and stops accepting HTTP before it stops the runtime', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture();
    const { server, port } = await start(f, { factories: { createIngestService: () => ingestWith(() => blocked) } });
    expect((await httpRequest(port, '/api/health')).status).toBe(200);

    server.requestShutdown('stop');
    const answer = await waitFor(
      async () => {
        const reply = await requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 2000 });
        return reply.ok && reply.op === 'identify' && reply.phase === 'stopping' ? reply : null;
      },
      { what: 'identify to say stopping' },
    );
    expect(answer).toMatchObject({ instanceId: f.id, pid: process.pid, phase: 'stopping' });
    expect(server.ctx.process.phase()).toBe('stopping');
    // step 2 is done before step 3 (the runtime) is waiting for the blocked ingest service
    await expect(httpRequest(port, '/api/health', { timeoutMs: 1500 })).rejects.toThrow();
    await waitFor(() => runtimeLog(f).filter((line) => line.event === 'shutdown_step').length >= 2, {
      what: 'the log lines of steps 1 and 2',
    });
    expect(
      runtimeLog(f)
        .filter((line) => line.event === 'shutdown_step')
        .map((line) => line['count']),
    ).toEqual([1, 2]);

    release();
    expect((await server.closed).exitCode).toBe(0);
  });

  it('ignores a second trigger: one shutdown, one set of steps, and the second request still gets its reply', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture();
    const { server } = await start(f, { factories: { createIngestService: () => ingestWith(() => blocked) } });
    const token = tokenOf(f);
    const ask = (reason: 'stop' | 'signal') =>
      requestControl(controlAddress(f.id), { v: 1, op: 'shutdown', instanceId: f.id, token, reason });
    expect(await ask('stop')).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    expect(await ask('signal')).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    server.requestShutdown('restart');
    release();
    await server.closed;
    const lines = runtimeLog(f);
    expect(lines.filter((line) => line.event === 'shutdown_begin')).toHaveLength(1);
    expect(lines.find((line) => line.event === 'shutdown_begin')?.['code']).toBe('stop');
    expect(lines.filter((line) => line.event === 'shutdown_step')).toHaveLength(6);
  });

  it('ends with exit 0 and a log line when a component outlives the deadline, and drops the handles it did not close', async () => {
    const f = await fixture({ runtime: { server: { shutdownGraceMs: 150 } } });
    const { server, port } = await start(f, {
      factories: { createIngestService: () => ingestWith(() => new Promise<void>(() => undefined)) },
    });
    const startedAt = Date.now();
    server.requestShutdown('stop');
    const outcome = await server.closed;
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.deadlineExceededAtStep ?? outcome.pendingComponent).not.toBeNull();
    const lines = runtimeLog(f);
    expect(
      lines.some((line) => line.event === 'shutdown_deadline_exceeded' || line.event === 'shutdown_component_pending'),
    ).toBe(true);
    expect(lines.find((line) => line.event === 'shutdown_done')).toMatchObject({ status: 'deadline' });
    await expect(requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 })).rejects.toThrow();
    await assertPortClosed(port);
  });
});

describe('a shutdown that arrives while the server is still starting (01 4.3)', () => {
  it('is honoured at a safe point: exit 0, no state.json, no token, the database closed and the name released', async () => {
    const f = await fixture({ env: { MCS_TEST: '1', MCS_TEST_BOOT_HANG: '1' } });
    const gate = createShutdownGate();
    const port = await allocatePort();
    const booting = bootServer({
      argv: argvOf(f, port),
      env: f.env,
      runtimeDir: f.runtimeDir,
      gate,
      stderr: () => undefined,
    });
    const starting = await waitFor(
      async () => {
        const reply = await requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1000 });
        return reply.ok && reply.op === 'identify' && reply.phase === 'starting' ? reply : null;
      },
      { timeoutMs: 20_000, what: 'identify to answer while the boot hangs' },
    );
    expect(starting).toMatchObject({ port: null, url: null });
    expect(exists(f, 'state.json')).toBe(false);

    gate.request('signal');
    const result = await booting;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    running.push(result.server);
    expect((await result.server.closed).exitCode).toBe(0);
    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    await expect(requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 })).rejects.toThrow();
    openInstanceDb({
      path: path.join(f.ws, 'data', 'monitor.db'),
      expectedInstanceId: f.id,
      mode: 'maintenance',
      runtimeVersion: RUNTIME_VERSION,
    }).close();
    await assertPortClosed(port);
  }, 60_000);

  it('does not hang without the test hook: the variable alone is ignored', async () => {
    const f = await fixture({ env: { MCS_TEST: '', MCS_TEST_BOOT_HANG: '1' } });
    const { server } = await start(f);
    expect(server.ctx.process.phase()).toBe('ready');
  });
});

describe('the real process (dist, started like `mcs start` starts it)', () => {
  it('exits 0 after a control shutdown and leaves no file, port or name behind', async () => {
    expect(existsSync(REAL_BOOT), 'build the runtime first (npm run build): the child runs dist/boot.js').toBe(true);
    const f = await fixture();
    const dist = path.join(f.runtimeDir, 'packages', 'server', 'dist');
    mkdirSync(dist, { recursive: true });
    const shim = path.join(dist, 'main.js');
    writeFileSync(
      shim,
      [
        `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
        `process.exit(await serveMain({ argv: process.argv.slice(2), env: process.env, runtimeDir: ${JSON.stringify(f.runtimeDir)} }));`,
        '',
      ].join('\n'),
    );
    const port = await allocatePort();
    const child = spawnTracked(process.execPath, [shim, ...argvOf(f, port)], { env: f.env });
    await waitFor(
      async () => {
        const reply = await requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1000 });
        return reply.ok && reply.op === 'identify' && reply.phase === 'ready' ? reply : null;
      },
      { timeoutMs: 30_000, what: 'the child server to be ready' },
    );
    expect((await httpRequest(port, '/api/health')).status).toBe(200);

    const reply = await requestControl(controlAddress(f.id), {
      v: 1,
      op: 'shutdown',
      instanceId: f.id,
      token: tokenOf(f),
      reason: 'stop',
    });
    expect(reply).toMatchObject({ ok: true, op: 'shutdown' });
    expect(await child.exited).toBe(0);
    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    await expect(requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 })).rejects.toThrow();
    await assertPortClosed(port);
    const steps = runtimeLog(f).filter((line) => line.event === 'shutdown_step');
    expect(steps.map((line) => line['count'])).toEqual([1, 2, 3, 4, 5, 6]);
  }, 90_000);
});
