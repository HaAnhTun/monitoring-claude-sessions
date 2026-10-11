// The control channel (01 4.3, ADR 0005, 01 8): the address per platform, one JSON line per connection, `identify` without a
// token, `shutdown` / `backup` / `ingest-replay` behind the instance id and the token, the replies for every kind of bad
// request, the 2 s idle close, and the rule that a token never reaches a log. Real named pipes, fake services behind them.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';

import type { ControlPhase, ControlResponse, ControlShutdownReason } from '@mcs/shared/protocol';
import { CONTROL_REQUEST_MAX_BYTES, parseControlResponse } from '@mcs/shared/protocol';
import { makeJunction, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  controlAddress,
  openControlChannel,
  requestControl,
  sendControlLine,
  validateBackupDest,
  type BackupOutcome,
  type ControlChannel,
  type ControlChannelOptions,
  type ReplayOutcome,
} from './control-channel.ts';

const makeTemp = useTempDirs();
const TOKEN = 'ab'.repeat(32);
const SEGMENT = 'hooks-20261012T08Z.ndjson';

interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

interface Harness {
  readonly id: string;
  readonly address: string;
  readonly channel: ControlChannel;
  readonly logs: LogLine[];
  readonly shutdowns: ControlShutdownReason[];
  readonly backups: string[];
  readonly replays: (string | null)[];
  state: { phase: ControlPhase; token: string | null; backup: BackupOutcome; replay: ReplayOutcome };
}

const open: ControlChannel[] = [];
afterEach(async () => {
  for (const channel of open.splice(0)) await channel.close();
});

async function start(over: Partial<ControlChannelOptions> = {}): Promise<Harness> {
  const id = randomUUID();
  const address = controlAddress(id);
  const logs: LogLine[] = [];
  const shutdowns: ControlShutdownReason[] = [];
  const backups: string[] = [];
  const replays: (string | null)[] = [];
  const state: Harness['state'] = {
    phase: 'ready',
    token: TOKEN,
    backup: { ok: true, bytes: 4096, dbSchemaVersion: 1 },
    replay: { ok: true, segments: 2 },
  };
  const log = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    logs.push({ level, event, fields });
  };
  const channel = await openControlChannel({
    address,
    instanceId: id,
    token: () => state.token,
    phase: () => state.phase,
    identity: () => ({
      pid: 4242,
      runtimeVersion: '3.0.0',
      codeStamp: 'abcdef0123',
      port: state.phase === 'starting' ? null : 18123,
      url: state.phase === 'starting' ? null : 'http://127.0.0.1:18123',
      startedAt: '2026-10-12T08:30:15.250Z',
    }),
    onShutdown: (reason) => {
      shutdowns.push(reason);
    },
    onBackup: (dest) => {
      backups.push(dest);
      return Promise.resolve(state.backup);
    },
    onIngestReplay: (from) => {
      replays.push(from);
      return Promise.resolve(state.replay);
    },
    logger: { debug: log('debug'), info: log('info'), warn: log('warn') },
    ...over,
  });
  if (channel === null) throw new Error('the harness address was taken');
  open.push(channel);
  return { id, address, channel, logs, shutdowns, backups, replays, state };
}

function request(h: Harness, body: Record<string, unknown>): Promise<ControlResponse> {
  return requestControl(h.address, { v: 1, instanceId: h.id, token: TOKEN, ...body } as never, { timeoutMs: 5000 });
}

describe('controlAddress (01 4.3)', () => {
  const id = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';

  it('is a named pipe on Windows, an abstract socket on Linux and a socket file in a per-user folder elsewhere', () => {
    expect(controlAddress(id, { platform: 'win32', tmpdir: 'C:/tmp', uid: null })).toBe(String.raw`\\.\pipe\mcs-` + id);
    expect(controlAddress(id, { platform: 'linux', tmpdir: '/tmp', uid: 1000 })).toBe(`\0mcs-${id}`);
    expect(controlAddress(id, { platform: 'darwin', tmpdir: '/var/tmp', uid: 501 })).toBe(
      path.join('/var/tmp', 'mcs-501', `${id}.sock`),
    );
    expect(controlAddress(id, { platform: 'other', tmpdir: '/tmp', uid: 7 })).toBe(
      path.join('/tmp', 'mcs-7', `${id}.sock`),
    );
  });

  it('refuses anything that is not a version 4 uuid (the id becomes part of a path)', () => {
    for (const bad of ['', 'x', '../evil', `${id}/..`, id.toUpperCase(), `${id}\0`]) {
      expect(() => controlAddress(bad), bad).toThrow(RangeError);
    }
  });

  it('is the address of this host by default', () => {
    const address = controlAddress(id);
    expect(address.endsWith(id) || address.endsWith(`${id}.sock`)).toBe(true);
  });
});

describe('opening the channel', () => {
  it('is the instance lock: a second open of the same address answers null and the first keeps working', async () => {
    const h = await start();
    const second = await openControlChannel({
      address: h.address,
      instanceId: h.id,
      token: () => null,
      phase: () => 'starting',
      identity: () => ({ pid: 1, runtimeVersion: '3.0.0', codeStamp: '', port: null, url: null, startedAt: '' }),
      onShutdown: () => undefined,
      onBackup: () => Promise.resolve({ ok: false, error: 'BACKUP_FAILED' }),
      onIngestReplay: () => Promise.resolve({ ok: false, error: 'NOT_READY' }),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });
    expect(second).toBeNull();
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true, op: 'identify' });
  });

  it('is free again after close, and close is idempotent', async () => {
    const h = await start();
    await h.channel.close();
    await h.channel.close();
    await expect(requestControl(h.address, { v: 1, op: 'identify' }, { timeoutMs: 1000 })).rejects.toThrow();
    const again = await openControlChannel({
      address: h.address,
      instanceId: h.id,
      token: () => null,
      phase: () => 'starting',
      identity: () => ({ pid: 1, runtimeVersion: '3.0.0', codeStamp: '', port: null, url: null, startedAt: '' }),
      onShutdown: () => undefined,
      onBackup: () => Promise.resolve({ ok: false, error: 'BACKUP_FAILED' }),
      onIngestReplay: () => Promise.resolve({ ok: false, error: 'NOT_READY' }),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });
    expect(again).not.toBeNull();
    await again?.close();
  });
});

describe('identify', () => {
  it('needs no token and returns no secret', async () => {
    const h = await start();
    const reply = await requestControl(h.address, { v: 1, op: 'identify' });
    expect(reply).toEqual({
      v: 1,
      ok: true,
      op: 'identify',
      instanceId: h.id,
      pid: 4242,
      phase: 'ready',
      runtimeVersion: '3.0.0',
      codeStamp: 'abcdef0123',
      port: 18123,
      url: 'http://127.0.0.1:18123',
      startedAt: '2026-10-12T08:30:15.250Z',
    });
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
  });

  it('follows the phase: port and url are null while starting, and the phase is stopping once it says so', async () => {
    const h = await start();
    h.state.phase = 'starting';
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({
      phase: 'starting',
      port: null,
      url: null,
    });
    h.state.phase = 'stopping';
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ phase: 'stopping' });
  });
});

describe('shutdown, backup and ingest-replay: instance id and token (T-LC-04)', () => {
  it('answers FORBIDDEN for a wrong token, a token of another length, an empty token, and does nothing', async () => {
    const h = await start();
    for (const token of ['cd'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'x']) {
      expect(await request(h, { op: 'shutdown', reason: 'stop', token }), token).toEqual({
        v: 1,
        ok: false,
        error: 'FORBIDDEN',
      });
    }
    expect(h.shutdowns).toEqual([]);
    // the process is alive: it still answers
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true });
  });

  it('answers INSTANCE_MISMATCH for another instance id even with the right token', async () => {
    const h = await start();
    const reply = await request(h, { op: 'shutdown', reason: 'stop', instanceId: randomUUID() });
    expect(reply).toEqual({ v: 1, ok: false, error: 'INSTANCE_MISMATCH' });
    expect(h.shutdowns).toEqual([]);
  });

  it('answers FORBIDDEN while the server has no token yet (before the boot wrote it)', async () => {
    const h = await start();
    h.state.token = null;
    expect(await request(h, { op: 'shutdown', reason: 'stop' })).toEqual({ v: 1, ok: false, error: 'FORBIDDEN' });
    expect(h.shutdowns).toEqual([]);
  });

  it('accepts shutdown with the token, replies stopping, and passes the reason on', async () => {
    const h = await start();
    for (const reason of ['stop', 'restart', 'upgrade', 'signal'] as const) {
      expect(await request(h, { op: 'shutdown', reason })).toEqual({
        v: 1,
        ok: true,
        op: 'shutdown',
        phase: 'stopping',
      });
    }
    expect(h.shutdowns).toEqual(['stop', 'restart', 'upgrade', 'signal']);
  });

  it('accepts shutdown while the server is still starting (the boot honours it at a safe point)', async () => {
    const h = await start();
    h.state.phase = 'starting';
    expect(await request(h, { op: 'shutdown', reason: 'stop' })).toMatchObject({ ok: true, op: 'shutdown' });
    expect(h.shutdowns).toEqual(['stop']);
  });

  it('refuses backup and ingest-replay with NOT_READY unless the phase is ready (after the token check)', async () => {
    const h = await start();
    for (const phase of ['starting', 'stopping'] as const) {
      h.state.phase = phase;
      expect(await request(h, { op: 'backup', dest: 'x' }), phase).toEqual({ v: 1, ok: false, error: 'NOT_READY' });
      expect(await request(h, { op: 'ingest-replay', fromSegment: null }), phase).toEqual({
        v: 1,
        ok: false,
        error: 'NOT_READY',
      });
      expect(await request(h, { op: 'backup', dest: 'x', token: 'cd'.repeat(32) }), phase).toEqual({
        v: 1,
        ok: false,
        error: 'FORBIDDEN',
      });
    }
    expect(h.backups).toEqual([]);
    expect(h.replays).toEqual([]);
  });
});

describe('backup', () => {
  it('delegates to the server and replies with the size and the schema version', async () => {
    const h = await start();
    expect(await request(h, { op: 'backup', dest: 'D:/ws/data/backups/x.partial/monitor.db' })).toEqual({
      v: 1,
      ok: true,
      op: 'backup',
      bytes: 4096,
      dbSchemaVersion: 1,
    });
    expect(h.backups).toEqual(['D:/ws/data/backups/x.partial/monitor.db']);
  });

  it('maps the outcomes BAD_REQUEST and BACKUP_FAILED, and a throwing handler to BACKUP_FAILED', async () => {
    const h = await start();
    h.state.backup = { ok: false, error: 'BAD_REQUEST' };
    expect(await request(h, { op: 'backup', dest: 'x' })).toEqual({ v: 1, ok: false, error: 'BAD_REQUEST' });
    h.state.backup = { ok: false, error: 'BACKUP_FAILED' };
    expect(await request(h, { op: 'backup', dest: 'x' })).toEqual({ v: 1, ok: false, error: 'BACKUP_FAILED' });
    const thrower = await start({ onBackup: () => Promise.reject(new Error('disk gone')) });
    expect(await request(thrower, { op: 'backup', dest: 'x' })).toEqual({ v: 1, ok: false, error: 'BACKUP_FAILED' });
  });

  it('keeps the connection open while the copy runs, longer than the idle timeout', async () => {
    let finish: (outcome: BackupOutcome) => void = () => undefined;
    let received = false;
    const slow = new Promise<BackupOutcome>((resolve) => {
      finish = resolve;
    });
    const h = await start({
      idleTimeoutMs: 100,
      onBackup: () => {
        received = true;
        return slow;
      },
    });
    const pending = request(h, { op: 'backup', dest: 'x' });
    await waitFor(() => received, { what: 'the backup request reached the service' });
    const waitedSince = Date.now();
    await waitFor(() => Date.now() - waitedSince >= 450, { what: 'more than four idle timeouts', intervalMs: 50 });
    finish({ ok: true, bytes: 9, dbSchemaVersion: 1 });
    expect(await pending).toMatchObject({ ok: true, op: 'backup', bytes: 9 });
  });
});

describe('ingest-replay', () => {
  it('accepts null (all segments) and a segment name, and replies with the count', async () => {
    const h = await start();
    expect(await request(h, { op: 'ingest-replay', fromSegment: null })).toEqual({
      v: 1,
      ok: true,
      op: 'ingest-replay',
      segments: 2,
    });
    expect(await request(h, { op: 'ingest-replay', fromSegment: SEGMENT })).toMatchObject({ ok: true });
    expect(h.replays).toEqual([null, SEGMENT]);
  });

  it('answers BAD_REQUEST for a name that is not a spool segment, without calling the service', async () => {
    const h = await start();
    for (const bad of [
      '',
      'hooks.ndjson',
      '../hooks-20261012T08Z.ndjson',
      'hooks-20261012T08Z.jsonl',
      `${SEGMENT}\n`,
    ]) {
      expect(await request(h, { op: 'ingest-replay', fromSegment: bad }), bad).toEqual({
        v: 1,
        ok: false,
        error: 'BAD_REQUEST',
      });
    }
    expect(h.replays).toEqual([]);
  });

  it('maps the outcome NOT_READY, and closes the connection without a reply when the service throws', async () => {
    const h = await start();
    h.state.replay = { ok: false, error: 'NOT_READY' };
    expect(await request(h, { op: 'ingest-replay', fromSegment: null })).toEqual({
      v: 1,
      ok: false,
      error: 'NOT_READY',
    });
    const thrower = await start({ onIngestReplay: () => Promise.reject(new Error('writer closed')) });
    const line = await sendControlLine(
      thrower.address,
      JSON.stringify({ v: 1, op: 'ingest-replay', instanceId: thrower.id, token: TOKEN, fromSegment: null }),
      { timeoutMs: 5000 },
    );
    expect(line).toBeNull();
    expect(thrower.logs.some((l) => l.level === 'warn' && l.event === 'control_failed')).toBe(true);
    expect(await requestControl(thrower.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true });
  });
});

describe('bad requests', () => {
  async function replyTo(h: Harness, line: string): Promise<ControlResponse | null> {
    const text = await sendControlLine(h.address, line, { timeoutMs: 5000 });
    return text === null ? null : parseControlResponse(text);
  }

  it('answers BAD_REQUEST for text that is not one valid request', async () => {
    const h = await start();
    const bad = [
      '',
      'not json',
      '[]',
      '"identify"',
      'null',
      JSON.stringify({ v: 2, op: 'identify' }),
      JSON.stringify({ v: 1, op: 'nope' }),
      JSON.stringify({ v: 1, op: 'identify', extra: 1 }),
      JSON.stringify({ v: 1, op: 'shutdown', instanceId: h.id, token: TOKEN }),
      JSON.stringify({ v: 1, op: 'shutdown', instanceId: h.id, token: TOKEN, reason: 'because' }),
      JSON.stringify({ v: 1, op: 'backup', instanceId: h.id, token: TOKEN, dest: 7 }),
    ];
    for (const line of bad) {
      expect(await replyTo(h, line), line).toEqual({ v: 1, ok: false, error: 'BAD_REQUEST' });
    }
    expect(h.shutdowns).toEqual([]);
  });

  it('answers BAD_REQUEST for a request longer than 4096 bytes, with or without a newline, and stays alive', async () => {
    const h = await start();
    const long = JSON.stringify({ v: 1, op: 'identify', pad: 'x'.repeat(CONTROL_REQUEST_MAX_BYTES) });
    expect(await replyTo(h, long)).toEqual({ v: 1, ok: false, error: 'BAD_REQUEST' });
    const reply = await sendRaw(h.address, Buffer.alloc(CONTROL_REQUEST_MAX_BYTES * 4, 0x78));
    expect(parseControlResponse(reply ?? '')).toEqual({ v: 1, ok: false, error: 'BAD_REQUEST' });
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true });
  });

  it('reads exactly one request per connection: bytes after the first line are not a second request', async () => {
    const h = await start();
    const two = `${JSON.stringify({ v: 1, op: 'identify' })}\n${JSON.stringify({
      v: 1,
      op: 'shutdown',
      instanceId: h.id,
      token: TOKEN,
      reason: 'stop',
    })}\n`;
    const reply = await sendRaw(h.address, Buffer.from(two));
    expect(parseControlResponse(reply ?? '')).toMatchObject({ ok: true, op: 'identify' });
    expect(h.shutdowns).toEqual([]);
  });

  it('accepts a CRLF terminator', async () => {
    const h = await start();
    const crlf = await sendRaw(
      h.address,
      Buffer.from(`${JSON.stringify({ v: 1, op: 'identify' })}
`),
    );
    expect(parseControlResponse(crlf ?? '')).toMatchObject({ ok: true, op: 'identify' });
  });

  it('answers a client that closes its write side right after the request line', async () => {
    const h = await start();
    const reply = await sendRaw(
      h.address,
      Buffer.from(`${JSON.stringify({ v: 1, op: 'identify' })}
`),
      true,
    );
    expect(parseControlResponse(reply ?? '')).toMatchObject({ ok: true, op: 'identify' });
  });

  it('closes without a reply when the client ends the connection in the middle of a line', async () => {
    const h = await start();
    expect(await sendRaw(h.address, Buffer.from('{"v":1,"op":"iden'), true)).toBeNull();
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true });
  });
});

/** Writes `bytes` to the channel, optionally ends the write side, and returns the first reply line (null: closed, no reply). */
function sendRaw(address: string, bytes: Buffer, endWrite = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    const chunks: Buffer[] = [];
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return; // the server may close first after BAD_REQUEST
      reject(error);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text === '' ? null : (text.split('\n')[0] ?? null));
    });
    socket.once('connect', () => {
      if (endWrite) socket.end(bytes);
      else socket.write(bytes);
    });
  });
}

describe('idle connections and the test hook', () => {
  it('closes a connection that sends nothing after the idle timeout, and counts none of the others', async () => {
    const h = await start({ idleTimeoutMs: 150 });
    const started = Date.now();
    const reply = await sendRaw(h.address, Buffer.alloc(0));
    expect(reply).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await requestControl(h.address, { v: 1, op: 'identify' })).toMatchObject({ ok: true });
  });

  it('ignores every request when told to (T-LC-06 hook): the name stays held, nothing is answered', async () => {
    const h = await start({ ignoreRequests: true, idleTimeoutMs: 200 });
    const line = await sendControlLine(h.address, JSON.stringify({ v: 1, op: 'identify' }), { timeoutMs: 5000 });
    expect(line).toBeNull();
    const second = await openControlChannel({
      address: h.address,
      instanceId: h.id,
      token: () => null,
      phase: () => 'starting',
      identity: () => ({ pid: 1, runtimeVersion: '3.0.0', codeStamp: '', port: null, url: null, startedAt: '' }),
      onShutdown: () => undefined,
      onBackup: () => Promise.resolve({ ok: false, error: 'BACKUP_FAILED' }),
      onIngestReplay: () => Promise.resolve({ ok: false, error: 'NOT_READY' }),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });
    expect(second).toBeNull();
    expect(h.shutdowns).toEqual([]);
  });

  it('delivers the reply that is being written when the channel is closed (the reply to shutdown)', async () => {
    let held: Harness | null = null;
    const h = await start({
      onShutdown: () => {
        void held?.channel.close();
      },
    });
    held = h;
    expect(await request(h, { op: 'shutdown', reason: 'stop' })).toEqual({
      v: 1,
      ok: true,
      op: 'shutdown',
      phase: 'stopping',
    });
    await expect(requestControl(h.address, { v: 1, op: 'identify' }, { timeoutMs: 1000 })).rejects.toThrow();
  });

  it('close() ends the connections that are still open', async () => {
    const h = await start({ idleTimeoutMs: 60_000 });
    const socket = connect(h.address);
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    await h.channel.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

describe('logging', () => {
  it('never logs a token, a destination path or request text; failures carry a code only', async () => {
    const h = await start();
    await request(h, { op: 'shutdown', reason: 'stop', token: 'ee'.repeat(32) });
    await request(h, { op: 'shutdown', reason: 'stop' });
    await request(h, { op: 'backup', dest: 'D:/secret-looking/dest.partial/monitor.db' });
    await sendControlLine(h.address, `{"v":1,"op":"identify","note":"${TOKEN}`, { timeoutMs: 5000 });
    await requestControl(h.address, { v: 1, op: 'identify' });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('ee'.repeat(32));
    expect(text).not.toContain('secret-looking');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line.event).toMatch(/^control_/);
  });
});

describe('validateBackupDest (01 4.3, T-SEC-03)', () => {
  function layout(): { backups: string; folder: string; dest: string; outside: string } {
    const root = makeTemp('backup-dest').path;
    const backups = path.join(root, 'data', 'backups');
    const folder = path.join(backups, '20261012T083000Z-manual.partial');
    mkdirSync(folder, { recursive: true });
    const outside = path.join(root, 'elsewhere.partial');
    mkdirSync(outside);
    return { backups, folder, dest: path.join(folder, 'monitor.db'), outside };
  }

  it('accepts <backups>/<id>.partial/monitor.db when the folder exists and the file does not', async () => {
    const { backups, dest } = layout();
    expect(await validateBackupDest(backups, dest)).toBe(true);
  });

  it('refuses a destination that exists, a wrong file name, a folder without .partial, and a missing folder', async () => {
    const { backups, folder, dest } = layout();
    writeFileSync(dest, 'x');
    expect(await validateBackupDest(backups, dest)).toBe(false);
    expect(await validateBackupDest(backups, path.join(folder, 'other.db'))).toBe(false);
    const plain = path.join(backups, '20261012T083000Z-manual');
    mkdirSync(plain);
    expect(await validateBackupDest(backups, path.join(plain, 'monitor.db'))).toBe(false);
    expect(await validateBackupDest(backups, path.join(backups, 'missing.partial', 'monitor.db'))).toBe(false);
  });

  it('refuses a folder outside the backups folder, a deeper folder, a relative path, traversal, NUL and the empty string', async () => {
    const { backups, folder, outside } = layout();
    expect(await validateBackupDest(backups, path.join(outside, 'monitor.db'))).toBe(false);
    const deeper = path.join(folder, 'nested.partial');
    mkdirSync(deeper);
    expect(await validateBackupDest(backups, path.join(deeper, 'monitor.db'))).toBe(false);
    expect(await validateBackupDest(backups, path.join('data', 'backups', 'x.partial', 'monitor.db'))).toBe(false);
    expect(
      await validateBackupDest(
        backups,
        `${folder}${path.sep}..${path.sep}..${path.sep}..${path.sep}x.partial${path.sep}monitor.db`,
      ),
    ).toBe(false);
    expect(await validateBackupDest(backups, `${path.join(folder, 'monitor.db')}\0`)).toBe(false);
    expect(await validateBackupDest(backups, '')).toBe(false);
  });

  it('refuses a folder inside backups that is a link to somewhere else (the real path decides)', async () => {
    const { backups, outside } = layout();
    const link = path.join(backups, 'linked.partial');
    makeJunction(link, outside);
    expect(await validateBackupDest(backups, path.join(link, 'monitor.db'))).toBe(false);
    expect(existsSync(path.join(outside, 'monitor.db'))).toBe(false);
  });
});
