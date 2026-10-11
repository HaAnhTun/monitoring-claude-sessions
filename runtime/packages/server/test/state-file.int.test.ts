// `state.json` of a running server (01 1.7, 4.4 step 10, 4.6): T-LC-07, the watchdog that puts the file back when it is
// deleted, damaged or names a dead process, leaves it alone while it names a live one (and says so), and the rule at boot
// for a file that is already there (a live legacy viewer is not overwritten, a reused pid is). Real processes as impostors.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultSkillDir, initWorkspace } from '@mcs/engine';
import { RUNTIME_VERSION, StateFileSchema } from '@mcs/shared';
import {
  allocatePort,
  hermeticEnv,
  killAllTracked,
  spawnImpostor,
  useTempDirs,
  waitFor,
  type TrackedProcess,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, type RunningServer } from '../src/boot.ts';

const makeTemp = useTempDirs();
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
  readonly stateFile: string;
}

async function fixture(): Promise<Fixture> {
  const root = makeTemp('serve-state').path;
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
  // the watchdog looks every second (the lowest the configuration allows)
  writeFileSync(
    path.join(ws.dir, 'runtime.json'),
    JSON.stringify({ schema_version: 1, process: { stateWatchdogMs: 1000 } }),
  );
  return { root, runtimeDir, ws: ws.dir, id, env: hermeticEnv(root), stateFile: path.join(ws.dir, 'state.json') };
}

const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.requestShutdown('stop');
    await server.closed;
  }
  await killAllTracked();
});

async function start(f: Fixture): Promise<RunningServer> {
  const port = await allocatePort();
  const result = await bootServer({
    argv: ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`],
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: () => undefined,
  });
  if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message}`);
  running.push(result.server);
  return result.server;
}

/** The legacy shape of `state.json` (seven keys), naming `pid`: what a live legacy viewer or an impostor leaves. */
function legacyState(pid: number): string {
  return JSON.stringify({
    pid,
    url: 'http://127.0.0.1:18000',
    port: 18000,
    started: 1_760_000_000.5,
    version: 'legacy-1',
    task: 'demo',
    config: null,
  });
}

function runtimeLog(f: Fixture): { event: string; level: string; [key: string]: unknown }[] {
  return readFileSync(path.join(f.ws, 'logs', 'runtime.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { event: string; level: string });
}

/** A process that is gone: its pid was alive a moment ago and is not now. */
async function deadPid(): Promise<number> {
  const gone = spawnImpostor([]);
  gone.kill();
  await gone.exited;
  return gone.pid;
}

describe('the file a server writes (01 1.7)', () => {
  it('is whole when the server says ready, valid for the shared schema, and not rewritten while nothing changes', async () => {
    const f = await fixture();
    const server = await start(f);
    const first = readFileSync(f.stateFile);
    const state = StateFileSchema.parse(JSON.parse(first.toString('utf8')));
    expect(state).toMatchObject({ pid: process.pid, port: server.port, engine: 'node', instanceId: f.id });
    const mtime = statSync(f.stateFile).mtimeMs;
    // three watchdog ticks later (1 s each) the file is the same bytes and was not written again
    const watchedSince = Date.now();
    await waitFor(() => Date.now() - watchedSince >= 3300, {
      what: 'three watchdog ticks',
      intervalMs: 100,
      timeoutMs: 8000,
    });
    expect(Buffer.compare(readFileSync(f.stateFile), first)).toBe(0);
    expect(statSync(f.stateFile).mtimeMs).toBe(mtime);
    expect(runtimeLog(f).some((line) => line.event === 'state_file_restored')).toBe(false);
    expect(server.ctx.process.ownershipConflict()).toBe(false);
  }, 30_000);
});

describe('T-LC-07: the watchdog puts the file back (01 4.6)', () => {
  it('restores a deleted file within stateWatchdogMs + 1 s, byte for byte', async () => {
    const f = await fixture();
    await start(f);
    const original = readFileSync(f.stateFile);
    rmSync(f.stateFile);
    const deletedAt = Date.now();
    const restored = await waitFor(() => (existsSync(f.stateFile) ? readFileSync(f.stateFile) : null), {
      timeoutMs: 6000,
      what: 'state.json to be restored',
    });
    expect(Date.now() - deletedAt).toBeLessThan(1000 + 1000 + 500);
    expect(Buffer.compare(restored, original)).toBe(0);
    expect(runtimeLog(f).find((line) => line.event === 'state_file_restored')).toMatchObject({
      level: 'warn',
      status: 'absent',
    });
  }, 30_000);

  it('restores a file that is not a state file any more (empty, garbage, a half-written one)', async () => {
    const f = await fixture();
    await start(f);
    const original = readFileSync(f.stateFile);
    for (const damage of ['', 'not json at all', '{"pid": 1', '[]']) {
      writeFileSync(f.stateFile, damage);
      await waitFor(() => Buffer.compare(readFileSync(f.stateFile), original) === 0, {
        timeoutMs: 6000,
        what: `state.json to be restored after ${JSON.stringify(damage)}`,
      });
    }
  }, 60_000);

  it('restores a file that names a process that is gone', async () => {
    const f = await fixture();
    await start(f);
    const original = readFileSync(f.stateFile);
    writeFileSync(f.stateFile, legacyState(await deadPid()));
    await waitFor(() => Buffer.compare(readFileSync(f.stateFile), original) === 0, {
      timeoutMs: 6000,
      what: 'state.json to be restored over the dead pid',
    });
  }, 30_000);

  it('leaves a file alone that names a live process, says ownership_conflict, and restores ours when that process ends', async () => {
    const f = await fixture();
    const server = await start(f);
    const original = readFileSync(f.stateFile);
    const impostor: TrackedProcess = spawnImpostor([]);
    const theirs = legacyState(impostor.pid);
    writeFileSync(f.stateFile, theirs);

    await waitFor(() => server.ctx.process.ownershipConflict(), { timeoutMs: 6000, what: 'the conflict flag' });
    expect(readFileSync(f.stateFile, 'utf8')).toBe(theirs);
    expect(runtimeLog(f).filter((line) => line.event === 'ownership_conflict')).toHaveLength(1);
    // still theirs after more ticks, and the conflict is logged once, not on every look
    const sawConflictAt = Date.now();
    await waitFor(() => Date.now() - sawConflictAt >= 2300, {
      what: 'two more ticks',
      intervalMs: 100,
      timeoutMs: 8000,
    });
    expect(readFileSync(f.stateFile, 'utf8')).toBe(theirs);
    expect(runtimeLog(f).filter((line) => line.event === 'ownership_conflict')).toHaveLength(1);

    impostor.kill();
    await impostor.exited;
    await waitFor(() => Buffer.compare(readFileSync(f.stateFile), original) === 0, {
      timeoutMs: 6000,
      what: 'our state.json to come back',
    });
    expect(server.ctx.process.ownershipConflict()).toBe(false);
  }, 60_000);
});

describe('a state.json that is already there at boot (01 4.4 step 10)', () => {
  it('names a live legacy viewer: it is not overwritten, the conflict is logged and the server still serves', async () => {
    const f = await fixture();
    const viewer = spawnImpostor(['viewer.py', 'serve', '--task', 'demo']);
    const theirs = legacyState(viewer.pid);
    writeFileSync(f.stateFile, theirs);
    const server = await start(f);
    expect(readFileSync(f.stateFile, 'utf8')).toBe(theirs);
    expect(runtimeLog(f).filter((line) => line.event === 'ownership_conflict')).not.toHaveLength(0);
    expect(server.ctx.process.previousRunUnclean).toBe(false);
    expect(server.port).not.toBeNull();
    await waitFor(() => server.ctx.process.ownershipConflict(), {
      timeoutMs: 6000,
      what: 'the conflict flag in health',
    });
  }, 60_000);

  it('names a live process that is not a legacy viewer (a reused pid): the file is taken over', async () => {
    const f = await fixture();
    const stranger = spawnImpostor(['something-else.js']);
    writeFileSync(f.stateFile, legacyState(stranger.pid));
    const server = await start(f);
    const state = StateFileSchema.parse(JSON.parse(readFileSync(f.stateFile, 'utf8')));
    expect(state.pid).toBe(process.pid);
    expect(server.ctx.process.previousRunUnclean).toBe(true);
    expect(runtimeLog(f).some((line) => line.event === 'ownership_conflict')).toBe(false);
  }, 60_000);

  it('names a process that is gone: the file is taken over and the previous run counts as unclean', async () => {
    const f = await fixture();
    writeFileSync(f.stateFile, legacyState(await deadPid()));
    const server = await start(f);
    expect(StateFileSchema.parse(JSON.parse(readFileSync(f.stateFile, 'utf8'))).pid).toBe(process.pid);
    expect(server.ctx.process.previousRunUnclean).toBe(true);
  }, 60_000);

  it('is not a state file at all: it is taken over', async () => {
    const f = await fixture();
    writeFileSync(f.stateFile, 'garbage');
    const server = await start(f);
    expect(StateFileSchema.safeParse(JSON.parse(readFileSync(f.stateFile, 'utf8'))).success).toBe(true);
    expect(server.ctx.process.previousRunUnclean).toBe(true);
  }, 60_000);
});
