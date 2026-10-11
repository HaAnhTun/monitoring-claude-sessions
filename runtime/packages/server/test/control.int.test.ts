// The control channel of a booted server (01 4.3, 8.2, 8.3; ADR 0005): T-LC-04 (identify, wrong token, wrong instance),
// the control `backup` destination rules of T-SEC-03, `ingest-replay`, the token hygiene of T-SEC-05, the test hook of
// T-LC-06 that makes the channel silent, and T-SEC-01 (POSIX only). Real workspace, real database, real named pipe.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultSkillDir, initWorkspace, openSqlite } from '@mcs/engine';
import { RUNTIME_VERSION } from '@mcs/shared';
import type { ControlRequest } from '@mcs/shared/protocol';
import { allocatePort, hermeticEnv, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, type BootInput, type RunningServer } from '../src/boot.ts';
import { controlAddress, openControlChannel, requestControl } from '../src/control-channel.ts';

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
}

async function fixture(extraEnv: Record<string, string> = {}): Promise<Fixture> {
  const root = makeTemp('serve-control').path;
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
  return { root, runtimeDir, ws: ws.dir, id, env: { ...hermeticEnv(root), ...extraEnv } };
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
  readonly stderr: string[];
  readonly port: number;
}

async function start(f: Fixture, over: Partial<BootInput> = {}): Promise<Started> {
  const port = await allocatePort();
  const stderr: string[] = [];
  const result = await bootServer({
    argv: ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`],
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: (text) => stderr.push(text),
    ...over,
  });
  if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message}`);
  running.push(result.server);
  return { server: result.server, stderr, port };
}

const tokenOf = (f: Fixture): string => readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8').trim();
const control = (f: Fixture, request: ControlRequest, timeoutMs = 10_000) =>
  requestControl(controlAddress(f.id), request, { timeoutMs });

function runtimeLogText(f: Fixture): string {
  const file = path.join(f.ws, 'logs', 'runtime.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('T-LC-04: identify, wrong token, wrong instance (01 4.3, 8.2)', () => {
  it('answers identify without a token, with the live phase, pid, versions, port and url', async () => {
    const f = await fixture();
    const { port } = await start(f);
    expect(await control(f, { v: 1, op: 'identify' })).toMatchObject({
      ok: true,
      op: 'identify',
      instanceId: f.id,
      pid: process.pid,
      phase: 'ready',
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      port,
      url: `http://127.0.0.1:${String(port)}`,
    });
  });

  it('answers FORBIDDEN to a shutdown with a wrong token, of any length, and the process stays alive', async () => {
    const f = await fixture();
    const { server, port } = await start(f);
    for (const token of ['0'.repeat(64), 'f'.repeat(64), tokenOf(f).slice(0, 63), `${tokenOf(f)}0`, 'x']) {
      expect(await control(f, { v: 1, op: 'shutdown', instanceId: f.id, token, reason: 'stop' }), token).toEqual({
        v: 1,
        ok: false,
        error: 'FORBIDDEN',
      });
    }
    expect(await control(f, { v: 1, op: 'identify' })).toMatchObject({ ok: true, phase: 'ready' });
    expect((await httpRequest(port, '/api/v3/health')).status).toBe(200);
    expect(server.ctx.process.phase()).toBe('ready');
    expect(existsSync(path.join(f.ws, 'state.json'))).toBe(true);
  });

  it('answers INSTANCE_MISMATCH for another instance id, and the process stays alive', async () => {
    const f = await fixture();
    const { server } = await start(f);
    const reply = await control(f, {
      v: 1,
      op: 'shutdown',
      instanceId: randomUUID(),
      token: tokenOf(f),
      reason: 'stop',
    });
    expect(reply).toEqual({ v: 1, ok: false, error: 'INSTANCE_MISMATCH' });
    expect(server.ctx.process.phase()).toBe('ready');
  });

  it('stops the server on a shutdown with the right token: the reply says stopping and the process ends cleanly', async () => {
    const f = await fixture();
    const { server } = await start(f);
    const reply = await control(f, { v: 1, op: 'shutdown', instanceId: f.id, token: tokenOf(f), reason: 'stop' });
    expect(reply).toEqual({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' });
    const outcome = await server.closed;
    expect(outcome.exitCode).toBe(0);
    await expect(control(f, { v: 1, op: 'identify' }, 1500)).rejects.toThrow();
  });
});

describe('control backup (01 4.3, T-SEC-03)', () => {
  function folderFor(f: Fixture, name: string): string {
    const folder = path.join(f.ws, 'data', 'backups', name);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  it('copies the database to <ws>/data/backups/<id>.partial/monitor.db and replies with the size and the schema version', async () => {
    const f = await fixture();
    await start(f);
    const dest = path.join(folderFor(f, '20261012T083000Z-manual.partial'), 'monitor.db');
    const reply = await control(f, { v: 1, op: 'backup', instanceId: f.id, token: tokenOf(f), dest });
    expect(reply).toMatchObject({ v: 1, ok: true, op: 'backup', dbSchemaVersion: 1 });
    expect(reply.ok && reply.op === 'backup' ? reply.bytes : -1).toBe(statSync(dest).size);
    const copy = openSqlite(dest, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual({ value: f.id });
    copy.close();
  });

  it('answers BAD_REQUEST and writes nothing for a destination outside data/backups, a folder that is not .partial, an existing file, a relative path or traversal', async () => {
    const f = await fixture();
    await start(f);
    const token = tokenOf(f);
    const outside = path.join(f.root, 'elsewhere.partial');
    mkdirSync(outside);
    const plain = folderFor(f, 'not-partial');
    const taken = path.join(folderFor(f, 'taken.partial'), 'monitor.db');
    writeFileSync(taken, 'already here');
    const good = folderFor(f, 'good.partial');
    const bad = [
      path.join(outside, 'monitor.db'),
      path.join(plain, 'monitor.db'),
      taken,
      path.join('data', 'backups', 'good.partial', 'monitor.db'),
      `${good}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}elsewhere.partial${path.sep}monitor.db`,
      path.join(good, 'other.db'),
      path.join(f.ws, 'monitor.db'),
    ];
    for (const dest of bad) {
      expect(await control(f, { v: 1, op: 'backup', instanceId: f.id, token, dest }), dest).toEqual({
        v: 1,
        ok: false,
        error: 'BAD_REQUEST',
      });
    }
    expect(readFileSync(taken, 'utf8')).toBe('already here');
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(good)).toEqual([]);
    expect(readdirSync(plain)).toEqual([]);
  });

  it('is FORBIDDEN without the token even for a destination that would be fine', async () => {
    const f = await fixture();
    await start(f);
    const dest = path.join(folderFor(f, 'x.partial'), 'monitor.db');
    expect(await control(f, { v: 1, op: 'backup', instanceId: f.id, token: '1'.repeat(64), dest })).toEqual({
      v: 1,
      ok: false,
      error: 'FORBIDDEN',
    });
    expect(existsSync(dest)).toBe(false);
  });
});

describe('control ingest-replay (01 4.3)', () => {
  it('answers BAD_REQUEST for a name that is not a spool segment and the segment count otherwise', async () => {
    const f = await fixture();
    await start(f);
    const token = tokenOf(f);
    expect(await control(f, { v: 1, op: 'ingest-replay', instanceId: f.id, token, fromSegment: '../x' })).toEqual({
      v: 1,
      ok: false,
      error: 'BAD_REQUEST',
    });
    // the runtime of this walking skeleton has no ingest service yet: nothing to reset, and no error
    expect(await control(f, { v: 1, op: 'ingest-replay', instanceId: f.id, token, fromSegment: null })).toEqual({
      v: 1,
      ok: true,
      op: 'ingest-replay',
      segments: 0,
    });
    expect(
      await control(f, {
        v: 1,
        op: 'ingest-replay',
        instanceId: f.id,
        token,
        fromSegment: 'hooks-20261012T08Z.ndjson',
      }),
    ).toMatchObject({ ok: true, segments: 0 });
  });
});

describe('T-SEC-05: the token is never printed, logged or stored anywhere else', () => {
  it('is in run/control.token only: not in a reply, a log line, state.json or the boot output', async () => {
    const f = await fixture();
    const { stderr, port } = await start(f);
    const token = tokenOf(f);
    const replies = [
      await control(f, { v: 1, op: 'identify' }),
      await control(f, { v: 1, op: 'shutdown', instanceId: f.id, token: '2'.repeat(64), reason: 'stop' }),
      await control(f, { v: 1, op: 'ingest-replay', instanceId: f.id, token, fromSegment: null }),
    ];
    expect(JSON.stringify(replies)).not.toContain(token);
    expect(runtimeLogText(f)).not.toContain(token);
    expect(readFileSync(path.join(f.ws, 'state.json'), 'utf8')).not.toContain(token);
    expect(stderr.join('')).not.toContain(token);
    expect((await httpRequest(port, '/api/v3/config')).body).not.toContain(token);
    expect((await httpRequest(port, '/api/v3/health')).body).not.toContain(token);
  });

  it('is a new token for every boot, 32 random bytes as 64 lower-case hex characters and one LF', async () => {
    const f = await fixture();
    const first = await start(f);
    const text = readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8');
    expect(text).toMatch(/^[0-9a-f]{64}\n$/);
    first.server.requestShutdown('stop');
    await first.server.closed;
    expect(existsSync(path.join(f.ws, 'run', 'control.token'))).toBe(false);
    await start(f);
    expect(readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8')).not.toBe(text);
  });
});

describe('the test hook that silences the channel (T-LC-06, 01 2.10)', () => {
  it('with MCS_TEST=1 and MCS_TEST_IGNORE_CONTROL=1 the channel holds its name and answers nothing; HTTP still works', async () => {
    const f = await fixture({ MCS_TEST: '1', MCS_TEST_IGNORE_CONTROL: '1' });
    const { server, port } = await start(f);
    await expect(control(f, { v: 1, op: 'identify' }, 700)).rejects.toThrow(/timed out|no reply/);
    expect((await httpRequest(port, '/api/v3/health')).status).toBe(200);
    // the name is still held: a second runtime of this instance cannot take it
    const taken = await openControlChannel({
      address: controlAddress(f.id),
      instanceId: f.id,
      token: () => null,
      phase: () => 'starting',
      identity: () => ({ pid: 1, runtimeVersion: '3.0.0', codeStamp: '', port: null, url: null, startedAt: '' }),
      onShutdown: () => undefined,
      onBackup: () => Promise.resolve({ ok: false, error: 'BACKUP_FAILED' }),
      onIngestReplay: () => Promise.resolve({ ok: false, error: 'NOT_READY' }),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });
    expect(taken).toBeNull();
    // the server can still be stopped from inside (a signal)
    server.requestShutdown('signal');
    expect((await server.closed).exitCode).toBe(0);
  });

  it('is off without MCS_TEST=1: the variable alone changes nothing', async () => {
    const f = await fixture({ MCS_TEST_IGNORE_CONTROL: '1' });
    await start(f);
    expect(await control(f, { v: 1, op: 'identify' })).toMatchObject({ ok: true, phase: 'ready' });
  });
});

describe('T-SEC-01 (POSIX only): the socket of the control channel is not reachable by other users', () => {
  // Skipped on win32 with this recorded reason: the check is about file modes of a socket folder and of a Unix socket, which
  // a Windows named pipe does not have. The pipe's own protection (owner, Administrators and SYSTEM full control, Everyone
  // read only) is the DACL measured by the E3 probe (ADR 0005 evidence), and T-LC-04 proves that a request needs the token.
  it.skipIf(process.platform === 'win32')(
    'creates <tmp>/mcs-<uid>/ with mode 0700 and a socket nobody else can write to',
    async () => {
      const root = makeTemp('serve-sec01').path;
      const id = randomUUID();
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      // the "other POSIX" address of 01 4.3; on Linux the abstract socket has no folder, so the mode check is made on this form
      const address = controlAddress(id, { platform: 'other', tmpdir: root, uid });
      const channel = await openControlChannel({
        address,
        instanceId: id,
        token: () => 'a'.repeat(64),
        phase: () => 'ready',
        identity: () => ({
          pid: process.pid,
          runtimeVersion: '3.0.0',
          codeStamp: '',
          port: null,
          url: null,
          startedAt: '',
        }),
        onShutdown: () => undefined,
        onBackup: () => Promise.resolve({ ok: false, error: 'BACKUP_FAILED' }),
        onIngestReplay: () => Promise.resolve({ ok: false, error: 'NOT_READY' }),
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      });
      expect(channel).not.toBeNull();
      const folder = path.dirname(address);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(address).mode & 0o022).toBe(0);
      expect(await requestControl(address, { v: 1, op: 'identify' })).toMatchObject({ ok: true, instanceId: id });
      await channel?.close();
      expect(existsSync(address)).toBe(false);
    },
  );
});
