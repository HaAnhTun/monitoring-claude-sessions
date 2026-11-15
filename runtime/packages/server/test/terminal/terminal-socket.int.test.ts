// The terminal socket end to end (CAW-25, design 02 5 and 10, ADR 0087): a real HTTP server with the real app, access service,
// cookie, guards, upgrade listener and gateway, a scriptable fake terminal host, and the `RawWsClient` of the testkit as the
// client (an oracle that shares no code with `ws`, and can send what a library refuses). What is proved: the protocol of v1 over
// the real chain (ready, replay, live, input, resize, size, exit, kill), replay without loss or duplication while output keeps
// coming, several viewers, the slow consumer (1013, the others unaffected), oversize, an unmasked frame and the other protocol
// errors, the caps, ping and the dead peer, logout and expiry (4003), shutdown (1001) and that nothing secret reaches the log.
// Ids: TC-WS-01, 03, 04, 05, 06, 07, 08, 09, 11 and TC-SEC-24, 25, 26, 52 of design 08. Every name, folder and byte is invented.
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  ErrorEnvelopeSchema,
  TERMINAL_INPUT_MAX_BYTES,
  TerminalServerMessageSchema,
  type TerminalServerMessage,
} from '@mcs/shared';
import { RawWsClient, httpRequest, openTerminalSocket, waitFor, type WsMessage } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { mintAndExchange, pageOrigin, writeHeaders } from './helpers/auth.ts';
import {
  FakeTerminalPorts,
  startTerminalApp,
  stopTerminalApps,
  type FakeSession,
  type TerminalApp,
} from './helpers/fake-terminal.ts';
import type { TerminalSocketLimits } from '../../src/terminal/gateway.ts';

afterEach(stopTerminalApps);

// FIXTURE: invented data for tests
const NAME = 'quartz-session-1';
const FOLDER = 'C:\\work\\secret-folder';
const CANARY = 'CANARY-SOCKET-3b8e7a1d4c';

interface Rig {
  readonly app: TerminalApp;
  readonly ports: FakeTerminalPorts;
  readonly session: FakeSession;
  readonly cookie: string;
}

async function rig(options: { limits?: Partial<TerminalSocketLimits>; ports?: FakeTerminalPorts } = {}): Promise<Rig> {
  const ports = options.ports ?? new FakeTerminalPorts();
  const session = ports.addSession({ name: NAME, path: FOLDER });
  const app = await startTerminalApp({
    ports,
    socket: options.limits === undefined ? {} : { limits: options.limits },
  });
  return { app, ports, session, cookie: await mintAndExchange(app.port, app.access) };
}

function socketPath(name: string): string {
  return `/api/v3/terminal/sessions/${name}/socket`;
}

async function connect(r: Rig, opts: { cookie?: string; autoPong?: boolean } = {}): Promise<RawWsClient> {
  return RawWsClient.connect(r.app.port, {
    path: socketPath(NAME),
    cookie: opts.cookie ?? r.cookie,
    ...(opts.autoPong === undefined ? {} : { autoPong: opts.autoPong }),
  });
}

function text(message: WsMessage): TerminalServerMessage {
  return TerminalServerMessageSchema.parse(JSON.parse(message.payload.toString('utf8')));
}

/** Reads ready and the replay up to live; the socket stays open. */
async function opened(client: RawWsClient): Promise<{ ready: TerminalServerMessage; replay: Buffer }> {
  const ready = text(await client.next());
  const parts: Buffer[] = [];
  for (;;) {
    const message = await client.next();
    if (message.opcode === 2) parts.push(message.payload);
    else if (message.opcode === 1 && text(message).type === 'live') break;
    else throw new Error('an unexpected message before live');
  }
  return { ready, replay: Buffer.concat(parts) };
}

async function closedWith(client: RawWsClient): Promise<{ code: number; reason: string }> {
  await client.waitClosed();
  const info = client.closeInfo();
  if (info === null) throw new Error('the connection ended without a close frame');
  return info;
}

function bytes(length: number, seed = 0): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 13 + seed) & 0xff;
  return out;
}

describe('TC-WS-01 handshake and the two directions', () => {
  it('opens with the cookie, reads ready then the replay then live, sends input as raw bytes and a resize as text', async () => {
    const r = await rig();
    r.session.replay = Buffer.from('screen-before');
    const { client, ready, replay } = await openTerminalSocket(r.app.port, NAME, { cookie: r.cookie });
    try {
      expect(ready).toMatchObject({ type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 13, viewers: 1 });
      expect(replay.toString('latin1')).toBe('screen-before');
      client.sendBinary(Buffer.from([0x00, 0xff, 0x03, 0x1b]));
      client.sendText(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
      await waitFor(() => r.session.written.length === 1 && r.session.resizes.length === 1, {
        what: 'input and resize',
      });
      expect(Buffer.from(r.session.written[0] ?? new Uint8Array(0)).equals(Buffer.from([0x00, 0xff, 0x03, 0x1b]))).toBe(
        true,
      );
      expect(r.session.resizes[0]).toEqual({ cols: 90, rows: 25 });
      r.session.emit(Buffer.from('typed-back'));
      await client.until('typed-back');
    } finally {
      await client.close();
    }
  });

  it('a replay of 1 MiB arrives in chunks of at most 64 KiB, byte for byte', async () => {
    const r = await rig();
    r.session.replay = bytes(1_048_576, 5);
    const client = await connect(r);
    const { ready, replay } = await opened(client);
    expect(ready).toMatchObject({ replayBytes: 1_048_576 });
    expect(replay.equals(bytes(1_048_576, 5))).toBe(true);
    await client.close();
  });
});

describe('TC-WS-03 replay then live without a byte lost or doubled', () => {
  it('output that keeps coming while viewers attach is delivered exactly once to each, in order', async () => {
    const r = await rig({ limits: { maxPerSession: 16 } });
    let counter = 0;
    const emitNext = (): void => {
      const chunk = Buffer.alloc(8);
      chunk.writeUInt32BE(counter, 0);
      chunk.writeUInt32BE(~counter >>> 0, 4);
      counter += 1;
      r.session.emit(chunk);
    };
    const connecting: Promise<RawWsClient>[] = [];
    for (let round = 0; round < 50; round += 1) {
      emitNext();
      if (round % 4 === 0) connecting.push(connect(r));
      await nextTurn();
    }
    const viewers = await Promise.all(connecting);
    await Promise.all(viewers.map((client) => opened(client)));
    for (let round = 0; round < 25; round += 1) {
      emitNext();
      await nextTurn();
    }
    const total = counter * 8;
    for (const client of viewers) await waitFor(() => client.collected().length >= total, { what: 'every byte' });
    for (const client of viewers) {
      const data = client.collected();
      expect(data.length).toBe(total);
      for (let at = 0; at < data.length; at += 8) {
        const index = at / 8;
        expect(data.readUInt32BE(at)).toBe(index);
        expect(data.readUInt32BE(at + 4)).toBe(~index >>> 0);
      }
    }
    await Promise.all(viewers.map((client) => client.close()));
  });
});

describe('TC-WS-04 several viewers', () => {
  it('see the same bytes, and every viewer gets the size frame of a resize (last wins)', async () => {
    const r = await rig();
    const a = await connect(r);
    const b = await connect(r);
    expect((await opened(a)).ready).toMatchObject({ viewers: 1 });
    expect((await opened(b)).ready).toMatchObject({ viewers: 2 });
    r.session.emit(Buffer.from('for-both'));
    await Promise.all([a.until('for-both'), b.until('for-both')]);
    a.sendText(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    await waitFor(() => r.session.resizes.length === 1, { what: 'the first resize' });
    b.sendText(JSON.stringify({ type: 'resize', cols: 600, rows: 300 }));
    await waitFor(() => r.session.resizes.length === 2, { what: 'the second resize' });
    expect(r.session.resizes).toEqual([
      { cols: 20, rows: 5 },
      { cols: 500, rows: 200 },
    ]);
    await waitFor(() => [a, b].every((client) => client.texts().length === 4), { what: 'the size frames' });
    for (const client of [a, b]) {
      expect(client.texts().slice(2)).toEqual([
        { type: 'size', cols: 20, rows: 5 },
        { type: 'size', cols: 500, rows: 200 },
      ]);
    }
    await Promise.all([a.close(), b.close()]);
  });
});

describe('TC-WS-05 exit and TC-WS-06 kill', () => {
  it('the last chunk arrives before the exit frame and the close 4000', async () => {
    const r = await rig();
    const client = await connect(r);
    await opened(client);
    const last = bytes(150_000, 2);
    r.session.emit(last);
    r.session.end({ code: 0, signal: null, killed: false });
    const kinds: string[] = [];
    for (;;) {
      const message = await client.next();
      if (message.opcode === 2) kinds.push('data');
      else if (message.opcode === 1) kinds.push(text(message).type);
      else if (message.opcode === 8) break;
    }
    expect(kinds.at(-1)).toBe('exit');
    expect(kinds.slice(0, -1).every((kind) => kind === 'data')).toBe(true);
    expect(client.collected().equals(last)).toBe(true);
    expect(await closedWith(client)).toEqual({ code: 4000, reason: 'exited' });
  });

  it('the kill route closes every viewer with 4001 and calls the host once', async () => {
    const r = await rig();
    const a = await connect(r);
    const b = await connect(r);
    await opened(a);
    await opened(b);
    const reply = await httpRequest(r.app.port, `/api/v3/terminal/sessions/${NAME}/kill`, {
      method: 'POST',
      origin: pageOrigin(r.app.port),
      headers: writeHeaders(r.cookie),
      body: '{}',
    });
    expect(reply.status).toBe(200);
    expect(await closedWith(a)).toEqual({ code: 4001, reason: 'killed' });
    expect(await closedWith(b)).toEqual({ code: 4001, reason: 'killed' });
    expect(r.ports.sessions.killed).toEqual([NAME]);
    expect(a.texts().at(-1)).toMatchObject({ type: 'exit', signal: 'SIGKILL' });
  });

  it('after the exit the name is gone: a new socket is terminal_not_found', async () => {
    const r = await rig();
    const client = await connect(r);
    await opened(client);
    r.ports.removeSession(NAME);
    r.session.end({ code: 0, signal: null, killed: false });
    await closedWith(client);
    const again = await connect(r);
    expect(again.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(again.body)).error.code).toBe('terminal_not_found');
  });
});

describe('TC-WS-07 slow consumer', () => {
  it('a viewer that stops reading is closed with 1013 and detached; the others receive every byte', async () => {
    const r = await rig({ limits: { highWaterBytes: 262_144, closeGraceMs: 8000 } });
    const slow = await connect(r);
    const fast = await connect(r);
    await opened(slow);
    await opened(fast);
    slow.pauseReading();
    const chunk = bytes(65_536, 8);
    let sent = 0;
    await waitFor(
      () => {
        r.session.emit(chunk);
        sent += chunk.length;
        return r.session.viewers.size === 1;
      },
      { timeoutMs: 30_000, intervalMs: 2, what: 'the slow viewer to be dropped' },
    );
    slow.resumeReading();
    expect(await closedWith(slow)).toEqual({ code: 1013, reason: 'slow_consumer' });
    await waitFor(() => fast.collected().length >= sent, { timeoutMs: 30_000, what: 'the fast viewer to catch up' });
    expect(fast.collected().length).toBe(sent);
    expect(fast.isClosed()).toBe(false);
    // the process was never paused: it can still be written to, and the fast viewer still gets output
    r.session.emit(Buffer.from('after-the-slow-one'));
    await fast.until('after-the-slow-one');
    await fast.close();
  });

  it('a viewer that was dropped can reconnect and gets the replay again', async () => {
    const r = await rig({ limits: { highWaterBytes: 65_536 } });
    const client = await connect(r);
    await opened(client);
    r.session.emit(bytes(70_000, 3));
    expect((await closedWith(client)).code).toBe(1013);
    const again = await connect(r);
    const { ready, replay } = await opened(again);
    expect(ready).toMatchObject({ replayBytes: 70_000 });
    expect(replay.equals(bytes(70_000, 3))).toBe(true);
    await again.close();
  });
});

describe('TC-SEC-24, 25, 26 oversize, unmasked frames and bad messages', () => {
  it('input over the shared limit closes with 1009 and reaches nothing', async () => {
    const r = await rig();
    const client = await connect(r);
    await opened(client);
    client.sendBinary(bytes(TERMINAL_INPUT_MAX_BYTES + 1));
    expect((await closedWith(client)).code).toBe(1009);
    expect(r.session.written).toHaveLength(0);
  });

  it('an unmasked client frame closes with 1002 and reaches nothing', async () => {
    const r = await rig();
    const client = await connect(r);
    await opened(client);
    client.sendFrame({ opcode: 2, mask: false, payload: Buffer.from(CANARY) });
    expect((await closedWith(client)).code).toBe(1002);
    expect(r.session.written).toHaveLength(0);
  });

  it('a frame that declares more than the limit is refused at its header, before the bytes arrive (1009)', async () => {
    const r = await rig();
    const client = await connect(r);
    await opened(client);
    client.sendFrame({ opcode: 2, payload: Buffer.from('abc'), lengthLie: 10_000_000 });
    expect((await closedWith(client)).code).toBe(1009);
    expect(r.session.written).toHaveLength(0);
  });

  it('a text frame over 256 bytes closes with 1009 and a malformed or unknown one with 1008', async () => {
    const r = await rig();
    const long = await connect(r);
    await opened(long);
    long.sendText(`{"type":"resize","cols":80,"rows":24}${' '.repeat(300)}`);
    expect(await closedWith(long)).toEqual({ code: 1009, reason: 'too_big' });
    for (const bad of ['hello', '{"type":"input","data":"x"}', '{"type":"resize","cols":80.5,"rows":24}']) {
      const client = await connect(r);
      await opened(client);
      client.sendText(bad);
      expect(await closedWith(client)).toEqual({ code: 1008, reason: 'bad_message' });
    }
    expect(r.session.resizes).toHaveLength(0);
  });
});

describe('TC-WS-09 and TC-SEC-52 caps', () => {
  it('the socket over the total cap is 503 stream_limit before the upgrade, and a close frees the slot', async () => {
    const r = await rig({ limits: { maxClients: 2, maxPerSession: 8 } });
    const a = await connect(r);
    const b = await connect(r);
    await Promise.all([opened(a), opened(b)]);
    const refused = await connect(r);
    expect(refused.status).toBe(503);
    expect(refused.headers['sec-websocket-accept']).toBeUndefined();
    expect(ErrorEnvelopeSchema.parse(JSON.parse(refused.body)).error.code).toBe('stream_limit');
    expect(r.session.viewers.size).toBe(2);
    await a.close();
    await waitFor(() => r.app.gateway?.size === 1, { what: 'a slot to free' });
    const accepted = await connect(r);
    expect(accepted.status).toBe(101);
    await Promise.all([accepted.close(), b.close()]);
  });

  it('the 9th viewer of one session is refused while another session still has room', async () => {
    const ports = new FakeTerminalPorts();
    ports.addSession({ name: 'second-1' });
    const r = await rig({ ports });
    const viewers: RawWsClient[] = [];
    for (let i = 0; i < 8; i += 1) viewers.push(await connect(r));
    await Promise.all(viewers.map((client) => opened(client)));
    const ninth = await connect(r);
    expect(ninth.status).toBe(503);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(ninth.body)).error.code).toBe('stream_limit');
    const other = await RawWsClient.connect(r.app.port, { path: socketPath('second-1'), cookie: r.cookie });
    expect(other.status).toBe(101);
    await Promise.all([other.close(), ...viewers.map((client) => client.close())]);
  });
});

describe('TC-WS-08 ping and the dead peer', () => {
  it('a client that never pongs is terminated; one that answers stays', async () => {
    const r = await rig({ limits: { pingIntervalMs: 40 } });
    const dead = await connect(r, { autoPong: false });
    const alive = await connect(r);
    await Promise.all([opened(dead), opened(alive)]);
    await dead.waitClosed();
    let pings = 0;
    while (pings < 3) {
      if ((await alive.next()).opcode === 9) pings += 1;
    }
    expect(alive.isClosed()).toBe(false);
    await waitFor(() => r.session.viewers.size === 1, { what: 'the dead viewer to detach' });
    await alive.close();
  });
});

describe('logout and expiry close the socket with 4003', () => {
  it('logout closes the sockets of that credential and not those of another', async () => {
    const r = await rig();
    const otherCookie = await mintAndExchange(r.app.port, r.app.access);
    const mine = await connect(r);
    const theirs = await connect(r, { cookie: otherCookie });
    await Promise.all([opened(mine), opened(theirs)]);
    const reply = await httpRequest(r.app.port, '/api/v3/auth/logout', {
      method: 'POST',
      origin: pageOrigin(r.app.port),
      headers: writeHeaders(r.cookie),
      body: '{}',
    });
    expect(reply.status).toBe(200);
    expect(await closedWith(mine)).toEqual({ code: 4003, reason: 'signed_out' });
    expect(theirs.isClosed()).toBe(false);
    // the closed credential opens nothing new
    const again = await connect(r);
    expect(again.status).toBe(401);
    await theirs.close();
  });

  it('a credential that expires closes its socket at the next tick, without any request', async () => {
    const r = await rig({ limits: { pingIntervalMs: 40 } });
    const client = await connect(r);
    await opened(client);
    // 24 h and a second: past the absolute lifetime of a credential
    r.app.clock.advance(24 * 3_600_000 + 1000);
    expect(await closedWith(client)).toEqual({ code: 4003, reason: 'signed_out' });
    await waitFor(() => r.session.viewers.size === 0, { what: 'the viewer to detach' });
  });
});

describe('TC-WS-11 shutdown', () => {
  it('closeAll closes every socket with 1001 inside the grace period and leaves the server able to close', async () => {
    const r = await rig();
    const a = await connect(r);
    const b = await connect(r);
    await Promise.all([opened(a), opened(b)]);
    const gateway = r.app.gateway;
    if (gateway === null) throw new Error('the gateway is missing');
    await gateway.closeAll(1001, 'shutting_down');
    expect(await closedWith(a)).toEqual({ code: 1001, reason: 'shutting_down' });
    expect(await closedWith(b)).toEqual({ code: 1001, reason: 'shutting_down' });
    expect(gateway.size).toBe(0);
    expect(r.session.viewers.size).toBe(0);
    await waitFor(
      () =>
        new Promise<boolean>((resolve) => {
          r.app.server.getConnections((_error, count) => {
            resolve(count === 0);
          });
        }),
      { what: 'the server to hold no connection' },
    );
  });

  it('a socket opened after closeAll is refused (the server is stopping)', async () => {
    const r = await rig();
    await r.app.gateway?.closeAll(1001, 'shutting_down');
    const refused = await connect(r);
    expect(refused.status).toBe(503);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(refused.body)).error.code).toBe('shutting_down');
  });
});

describe('the log never holds a name, a folder, input, output or a credential', () => {
  it('a full session leaves counts and close codes only', async () => {
    const r = await rig();
    r.session.replay = Buffer.from(`${CANARY}-replay`);
    const client = await connect(r);
    await opened(client);
    client.sendBinary(Buffer.from(`${CANARY}-input`));
    r.session.emit(Buffer.from(`${CANARY}-output`));
    await client.until(`${CANARY}-output`);
    client.sendText('not json');
    await closedWith(client);
    await waitFor(() => readFileSync(r.app.logFile, 'utf8').includes('terminal_socket_close'), {
      what: 'the close line',
    });
    const log = readFileSync(r.app.logFile, 'utf8');
    expect(log).toContain('terminal_socket_open');
    for (const secret of [NAME, FOLDER, 'secret-folder', CANARY, r.cookie, r.cookie.split('=')[1] ?? 'x']) {
      expect(log).not.toContain(secret);
    }
  });
});
