// The socket gateway (CAW-25, design 02 5.3 to 5.5, protocol v1) on a real loopback server, without Express and without the
// guards: a bare `upgrade` listener hands the socket to `gateway.accept` with a scriptable `FakeSession`, and the client is the
// raw `RawWsClient` of the testkit (an oracle that does not share code with `ws`). What is proved: the handshake and the order
// ready, replay, live; input fidelity; strict resize; every close code (1001, 1002, 1008, 1009, 1011, 1013, 4000, 4001, 4003);
// no byte lost or doubled while viewers attach; the last output before the exit frame; the slow consumer; the dead peer; the
// caps; shutdown; and that no name, folder, byte or credential is logged. The guards and the real app are the int suites.
// Ids: TC-WS-01, 03, 04, 05, 06, 07, 08, 09 (caps) and 11 of design 08; TC-SEC-24, 25, 26. Everything here is invented data.
import { createServer, type Server } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { AccessSession } from '@mcs/engine';
import { TerminalServerMessageSchema, TERMINAL_INPUT_MAX_BYTES, TERMINAL_TEXT_FRAME_MAX_BYTES } from '@mcs/shared';
import { RawWsClient, allocatePort, assertPortClosed, waitFor, type WsMessage } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeSession, sessionInfo } from '../../test/terminal/helpers/fake-terminal.ts';
import { ApiError } from '../errors.ts';
import { TERMINAL_SOCKET_LIMITS, createTerminalGateway, type TerminalSocketLimits } from './gateway.ts';
import type { TerminalAttachment, TerminalGateway } from './ports.ts';

// FIXTURE: invented data for tests
const SESSION_NAME = 'fixture-session-7';
const FOLDER = 'C:\\fixture\\secret-folder';
const CANARY = 'CANARY-INPUT-9f3a1c7e5b2d';

class FakeAccess {
  readonly listeners = new Set<(credentialId: string) => void>();
  verifies = 0;

  onRevoked(listener: (credentialId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  verify(): AccessSession | null {
    this.verifies += 1;
    return null;
  }

  revoke(credentialId: string): void {
    for (const listener of [...this.listeners]) listener(credentialId);
  }
}

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly fields: unknown;
}

class CapturingLogger {
  readonly lines: Logged[] = [];
  readonly debug = (event: string, fields?: unknown): void => {
    this.lines.push({ level: 'debug', event, fields });
  };
  readonly info = (event: string, fields?: unknown): void => {
    this.lines.push({ level: 'info', event, fields });
  };
  readonly warn = (event: string, fields?: unknown): void => {
    this.lines.push({ level: 'warn', event, fields });
  };
  readonly error = (event: string, fields?: unknown): void => {
    this.lines.push({ level: 'error', event, fields });
  };

  has(event: string): boolean {
    return this.lines.some((line) => line.event === event);
  }

  get text(): string {
    return JSON.stringify(this.lines);
  }
}

interface Rig {
  readonly port: number;
  readonly gateway: TerminalGateway;
  readonly access: FakeAccess;
  readonly logger: CapturingLogger;
  readonly sessions: Map<string, FakeSession>;
  readonly server: Server;
  /** Opens a socket for the session `name`; the default credential is `cred-1`. */
  open(
    name?: string,
    opts?: { credential?: string; autoPong?: boolean; headers?: Record<string, string> },
  ): Promise<RawWsClient>;
}

const rigs: Rig[] = [];
const clients: RawWsClient[] = [];

async function rig(limits: Partial<TerminalSocketLimits> = {}): Promise<Rig> {
  const port = await allocatePort();
  const access = new FakeAccess();
  const logger = new CapturingLogger();
  const gateway = createTerminalGateway({ access, logger, limits });
  const sessions = new Map<string, FakeSession>();
  sessions.set(SESSION_NAME, new FakeSession(sessionInfo({ name: SESSION_NAME, path: FOLDER })));
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const name = (req.url ?? '').replace(/^\/s\//, '');
    const session = sessions.get(name);
    const credentialId = req.headers['x-test-credential'];
    try {
      if (session === undefined) throw new ApiError('terminal_not_found');
      gateway.admit(name);
      gateway.accept({
        req,
        socket,
        head,
        name,
        session,
        credentialId: typeof credentialId === 'string' ? credentialId : 'cred-1',
      });
    } catch (error: unknown) {
      socket.end(
        `HTTP/1.1 ${error instanceof ApiError && error.code === 'stream_limit' ? '503' : '404'} X\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const made: Rig = {
    port,
    gateway,
    access,
    logger,
    sessions,
    server,
    open: async (name = SESSION_NAME, opts = {}) => {
      const client = await RawWsClient.connect(port, {
        path: `/s/${name}`,
        headers: { 'x-test-credential': opts.credential ?? 'cred-1', ...opts.headers },
        ...(opts.autoPong === undefined ? {} : { autoPong: opts.autoPong }),
      });
      clients.push(client);
      return client;
    },
  };
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const { port, server, gateway } of rigs.splice(0)) {
    await gateway.closeAll(1001, 'shutting_down');
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await assertPortClosed(port);
  }
});

function sessionOf(r: Rig, name = SESSION_NAME): FakeSession {
  const session = r.sessions.get(name);
  if (session === undefined) throw new Error('no such fixture session');
  return session;
}

function json(message: WsMessage): unknown {
  return JSON.parse(message.payload.toString('utf8'));
}

/** Reads `ready`, the replay up to `live`, and returns what came; the socket stays open for live output. */
async function opened(client: RawWsClient): Promise<{ ready: unknown; replay: Buffer; frames: number }> {
  const ready = json(await client.next());
  const parts: Buffer[] = [];
  for (;;) {
    const message = await client.next();
    if (message.opcode === 2) parts.push(message.payload);
    else if (message.opcode === 1 && (json(message) as { type?: string }).type === 'live') break;
    else throw new Error(`unexpected message of opcode ${String(message.opcode)} before live`);
  }
  return { ready, replay: Buffer.concat(parts), frames: parts.length };
}

/** Waits for the close frame and the end of the connection. */
async function closedWith(client: RawWsClient): Promise<{ code: number; reason: string }> {
  await client.waitClosed();
  const info = client.closeInfo();
  if (info === null) throw new Error('the connection ended without a close frame');
  return info;
}

function bytes(length: number, seed = 0): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

describe('limits', () => {
  it('the defaults are the numbers of design 02 5.3 and the shared input limit', () => {
    expect(TERMINAL_SOCKET_LIMITS).toEqual({
      maxClients: 32,
      maxPerSession: 8,
      maxMessageBytes: TERMINAL_INPUT_MAX_BYTES,
      maxControlBytes: 256,
      outputFrameBytes: 65_536,
      replayChunkBytes: 65_536,
      highWaterBytes: 4_194_304,
      pingIntervalMs: 30_000,
      closeGraceMs: 1000,
    });
    expect(TERMINAL_TEXT_FRAME_MAX_BYTES).toBe(256);
  });
});

describe('TC-WS-01 handshake, ready, replay, live', () => {
  it('sends ready first (validated by the schema), then the replay, then live, then live output', async () => {
    const r = await rig();
    const session = sessionOf(r);
    session.replay = Buffer.from('replayed-screen');
    session.cols = 100;
    session.rows = 40;
    const client = await r.open();
    expect(client.status).toBe(101);
    expect(client.acceptOk).toBe(true);
    expect(client.headers['sec-websocket-protocol']).toBe('caw.terminal.v1');
    const { ready, replay } = await opened(client);
    expect(TerminalServerMessageSchema.parse(ready)).toEqual({
      type: 'ready',
      v: 1,
      cols: 100,
      rows: 40,
      replayBytes: 'replayed-screen'.length,
      viewers: 1,
    });
    expect(replay.toString('latin1')).toBe('replayed-screen');
    client.clearCollected();
    session.emit(Buffer.from('then-live'));
    await client.until('then-live');
    expect(client.collected().toString('latin1')).toBe('then-live');
  });

  it('an empty replay sends no binary frame between ready and live', async () => {
    const r = await rig();
    const client = await r.open();
    const { replay, frames } = await opened(client);
    expect(replay.length).toBe(0);
    expect(frames).toBe(0);
  });

  it('splits a replay into chunks of at most 64 KiB with every byte in order', async () => {
    const r = await rig();
    const session = sessionOf(r);
    session.replay = bytes(150_000, 3);
    const client = await r.open();
    const { ready, replay, frames } = await opened(client);
    expect((ready as { replayBytes: number }).replayBytes).toBe(150_000);
    expect(frames).toBe(3);
    expect(replay.equals(bytes(150_000, 3))).toBe(true);
  });

  it('clamps a size the session reports to the limits, and counts the viewers', async () => {
    const r = await rig();
    const session = sessionOf(r);
    session.cols = 5;
    session.rows = 999;
    const first = await r.open();
    expect((await opened(first)).ready).toMatchObject({ cols: 20, rows: 200, viewers: 1 });
    const second = await r.open();
    expect((await opened(second)).ready).toMatchObject({ viewers: 2 });
  });

  it('selects caw.terminal.v1 among other offered protocols and never offers compression', async () => {
    const r = await rig();
    const client = await RawWsClient.connect(r.port, {
      path: `/s/${SESSION_NAME}`,
      protocols: ['chat', 'caw.terminal.v1'],
      headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' },
    });
    clients.push(client);
    expect(client.status).toBe(101);
    expect(client.headers['sec-websocket-protocol']).toBe('caw.terminal.v1');
    expect(client.headers['sec-websocket-extensions']).toBeUndefined();
  });

  it('never selects a name that differs in case (the route refuses such a handshake before it gets here)', async () => {
    const r = await rig();
    const client = await RawWsClient.connect(r.port, { path: `/s/${SESSION_NAME}`, protocols: ['CAW.TERMINAL.V1'] });
    clients.push(client);
    // without the route in front, the gateway still does not claim the subprotocol for another name
    expect(client.headers['sec-websocket-protocol']).toBeUndefined();
  });
});

describe('TC-WS-03 attach is atomic: no byte lost or doubled', () => {
  it('twenty viewers attach while a numbered stream is emitted: each receives a contiguous run from 0', async () => {
    const r = await rig({ maxPerSession: 20 });
    const session = sessionOf(r);
    const pending: Promise<RawWsClient>[] = [];
    let counter = 0;
    const emitNext = (): void => {
      const chunk = Buffer.alloc(4);
      chunk.writeUInt32BE(counter, 0);
      counter += 1;
      session.emit(chunk);
    };
    for (let round = 0; round < 60; round += 1) {
      emitNext();
      if (round % 3 === 0 && pending.length < 20) pending.push(r.open());
      await nextTurn();
    }
    const opening = await Promise.all(pending);
    const reads = opening.map((client) => opened(client));
    // output keeps coming while the viewers read their replay
    for (let round = 0; round < 20; round += 1) {
      emitNext();
      await nextTurn();
    }
    await Promise.all(reads);
    emitNext();
    const total = counter * 4;
    for (const client of opening) {
      await waitFor(() => client.collected().length >= total - 0, { what: 'the stream to arrive' });
    }
    expect(opening).toHaveLength(20);
    for (const client of opening) {
      const data = client.collected();
      // the replay is everything before the attach: the whole prefix of the stream, then the live rest, with nothing between
      const seen: number[] = [];
      for (let at = 0; at + 4 <= data.length; at += 4) seen.push(data.readUInt32BE(at));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe(0);
      seen.forEach((value, index) => {
        expect(value).toBe(index);
      });
      expect(data.length % 4).toBe(0);
    }
  });
});

describe('TC-WS-02 input fidelity and TC-SEC-24 frames', () => {
  it('binary frames reach the session byte for byte, 0x00, 0xFF, 0x03 and escape sequences included', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    const input = Buffer.from([0x00, 0xff, 0x03, 0x1b, 0x5b, 0x41, 0x7f, 0x80]);
    client.sendBinary(input);
    client.sendBinary(Buffer.from(`${CANARY}\r`));
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 2, { what: 'two writes' });
    expect(Buffer.from(session.written[0] ?? new Uint8Array(0)).equals(input)).toBe(true);
    expect(Buffer.from(session.written[1] ?? new Uint8Array(0)).toString('latin1')).toBe(`${CANARY}\r`);
  });

  it('a message split over several frames is one write', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendFrame({ opcode: 2, fin: false, payload: Buffer.from('ab') });
    client.sendFrame({ opcode: 0, fin: false, payload: Buffer.from('cd') });
    client.sendFrame({ opcode: 0, fin: true, payload: Buffer.from('ef') });
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 1, { what: 'one write' });
    expect(Buffer.from(session.written[0] ?? new Uint8Array(0)).toString('latin1')).toBe('abcdef');
  });

  it('an empty binary frame is not a write', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendBinary(new Uint8Array(0));
    client.sendBinary(Buffer.from('x'));
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 1, { what: 'one write' });
    expect(Buffer.from(session.written[0] ?? new Uint8Array(0)).toString('latin1')).toBe('x');
  });

  it('never echoes input back', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendBinary(Buffer.from('typed'));
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 1, { what: 'the write' });
    session.emit(Buffer.from('marker'));
    await client.until('marker');
    expect(client.collected().toString('latin1')).toBe('marker');
  });

  it('TC-SEC-24 an unmasked frame closes with 1002', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendFrame({ opcode: 2, mask: false, payload: Buffer.from('x') });
    expect((await closedWith(client)).code).toBe(1002);
    expect(sessionOf(r).written).toHaveLength(0);
  });

  it('TC-SEC-24 a reserved bit closes with 1002', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendFrame({ opcode: 2, rsv: 4, payload: Buffer.from('x') });
    expect((await closedWith(client)).code).toBe(1002);
  });

  it('TC-SEC-24 binary input over the shared limit closes with 1009', async () => {
    const r = await rig({ maxMessageBytes: 1024 });
    const client = await r.open();
    await opened(client);
    client.sendBinary(bytes(1025));
    expect((await closedWith(client)).code).toBe(1009);
    expect(sessionOf(r).written).toHaveLength(0);
  });

  it('TC-SEC-24 a message at the limit is accepted', async () => {
    const r = await rig({ maxMessageBytes: 1024 });
    const client = await r.open();
    await opened(client);
    client.sendBinary(bytes(1024));
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 1, { what: 'the write' });
    expect(session.written[0]?.length).toBe(1024);
  });

  it('TC-SEC-24 a message fragmented beyond the cap closes with 1009', async () => {
    const r = await rig({ maxMessageBytes: 1024 });
    const client = await r.open();
    await opened(client);
    client.sendFrame({ opcode: 2, fin: false, payload: bytes(600) });
    client.sendFrame({ opcode: 0, fin: true, payload: bytes(600) });
    expect((await closedWith(client)).code).toBe(1009);
  });

  it('the default input limit is the shared one: a message of TERMINAL_INPUT_MAX_BYTES passes, one byte more closes', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendBinary(bytes(TERMINAL_INPUT_MAX_BYTES));
    const session = sessionOf(r);
    await waitFor(() => session.written.length === 1, { what: 'the write' });
    client.sendBinary(bytes(TERMINAL_INPUT_MAX_BYTES + 1));
    expect((await closedWith(client)).code).toBe(1009);
    expect(session.written).toHaveLength(1);
  });
});

describe('TC-WS-04 resize and TC-SEC-25, TC-SEC-26 text frames', () => {
  it('a resize is clamped and reaches the session, and every viewer gets a size frame (last wins)', async () => {
    const r = await rig();
    const a = await r.open();
    const b = await r.open();
    await opened(a);
    await opened(b);
    a.sendText(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    const session = sessionOf(r);
    await waitFor(() => session.resizes.length === 1, { what: 'the resize' });
    expect(session.resizes[0]).toEqual({ cols: 20, rows: 5 });
    b.sendText(JSON.stringify({ type: 'resize', cols: 1000, rows: 1000 }));
    await waitFor(() => session.resizes.length === 2, { what: 'the second resize' });
    expect(session.resizes[1]).toEqual({ cols: 500, rows: 200 });
    await waitFor(() => a.texts().length === 4 && b.texts().length === 4, { what: 'the size frames' });
    for (const client of [a, b]) {
      const sizes = client.texts().filter((text) => (text as { type?: string }).type === 'size');
      expect(sizes.map((size) => TerminalServerMessageSchema.parse(size))).toEqual([
        { type: 'size', cols: 20, rows: 5 },
        { type: 'size', cols: 500, rows: 200 },
      ]);
    }
  });

  it('output that was pending when the size changed is sent before the size frame', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    const session = sessionOf(r);
    session.emit(Buffer.from('old-size-output'));
    session.resize(100, 30);
    const first = await client.next();
    const second = await client.next();
    expect(first.opcode).toBe(2);
    expect(first.payload.toString('latin1')).toBe('old-size-output');
    expect(second.opcode).toBe(1);
    expect(json(second)).toEqual({ type: 'size', cols: 100, rows: 30 });
  });

  const malformed: readonly [string, string][] = [
    ['not JSON', 'resize please'],
    ['an empty text', ''],
    ['an unknown type', JSON.stringify({ type: 'ping', cols: 80, rows: 24 })],
    ['an extra key', JSON.stringify({ type: 'resize', cols: 80, rows: 24, extra: 1 })],
    ['a float', JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 })],
    ['a negative size', JSON.stringify({ type: 'resize', cols: -1, rows: 24 })],
    ['zero', JSON.stringify({ type: 'resize', cols: 0, rows: 24 })],
    ['a size over 1000', JSON.stringify({ type: 'resize', cols: 1001, rows: 24 })],
    ['a string size', JSON.stringify({ type: 'resize', cols: '80', rows: 24 })],
    ['a missing field', JSON.stringify({ type: 'resize', cols: 80 })],
    ['a null', 'null'],
    ['an array', '[]'],
    ['a __proto__ key', '{"type":"resize","cols":80,"rows":24,"__proto__":{"x":1}}'],
    ['a byte order mark', `\ufeff${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`],
  ];
  it.each(malformed)('TC-SEC-25/26 %s closes with 1008 bad_message and reaches nothing', async (_title, text) => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendText(text);
    const close = await closedWith(client);
    expect(close).toEqual({ code: 1008, reason: 'bad_message' });
    expect(sessionOf(r).resizes).toHaveLength(0);
    expect(sessionOf(r).written).toHaveLength(0);
  });

  it('a text frame over 256 bytes closes with 1009, whatever it holds', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendText(`{"type":"resize","cols":80,"rows":24}${' '.repeat(TERMINAL_TEXT_FRAME_MAX_BYTES)}`);
    expect(await closedWith(client)).toEqual({ code: 1009, reason: 'too_big' });
    expect(sessionOf(r).resizes).toHaveLength(0);
  });

  it('a text frame of exactly 256 bytes is read', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    const body = '{"type":"resize","cols":80,"rows":24}';
    client.sendText(`${body}${' '.repeat(TERMINAL_TEXT_FRAME_MAX_BYTES - body.length)}`);
    const session = sessionOf(r);
    await waitFor(() => session.resizes.length === 1, { what: 'the resize' });
    expect(client.isClosed()).toBe(false);
  });

  it('text that is not UTF-8 closes (ws answers 1007) and reaches nothing', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.sendFrame({ opcode: 1, payload: Buffer.from([0xff, 0xfe, 0xfd]) });
    expect((await closedWith(client)).code).toBe(1007);
    expect(sessionOf(r).resizes).toHaveLength(0);
  });
});

describe('TC-WS-05, 06 exit and kill', () => {
  it('the last output comes before the exit frame, then the close 4000', async () => {
    const r = await rig();
    const session = sessionOf(r);
    const client = await r.open();
    await opened(client);
    const tail = bytes(200_000, 9);
    session.emit(tail);
    session.end({ code: 0, signal: null, killed: false });
    const order: string[] = [];
    let received = 0;
    for (;;) {
      const message = await client.next();
      if (message.opcode === 2) {
        received += message.payload.length;
        order.push('data');
      } else if (message.opcode === 1) {
        order.push(`text:${(json(message) as { type: string }).type}`);
        expect(TerminalServerMessageSchema.parse(json(message))).toEqual({ type: 'exit', code: 0, signal: null });
      } else if (message.opcode === 8) {
        break;
      }
    }
    expect(received).toBe(200_000);
    expect(order.at(-1)).toBe('text:exit');
    expect(order.slice(0, -1).every((item) => item === 'data')).toBe(true);
    expect(await closedWith(client)).toEqual({ code: 4000, reason: 'exited' });
    expect(client.collected().equals(tail)).toBe(true);
  });

  it('a killed process is 4001 and carries the signal', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    sessionOf(r).end({ code: null, signal: 'SIGKILL', killed: true });
    expect(await closedWith(client)).toEqual({ code: 4001, reason: 'killed' });
    expect(client.texts()).toContainEqual({ type: 'exit', code: null, signal: 'SIGKILL' });
  });

  it('an exit code or a signal the schema would refuse goes out as null', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    sessionOf(r).end({
      code: Number.NaN,
      signal: 'a signal with spaces and a very long name beyond limits',
      killed: false,
    });
    await closedWith(client);
    expect(client.texts()).toContainEqual({ type: 'exit', code: null, signal: null });
  });

  it('the exit reaches every viewer and detaches them all', async () => {
    const r = await rig();
    const a = await r.open();
    const b = await r.open();
    await opened(a);
    await opened(b);
    const session = sessionOf(r);
    session.end({ code: 3, signal: null, killed: false });
    expect((await closedWith(a)).code).toBe(4000);
    expect((await closedWith(b)).code).toBe(4000);
    expect(session.viewers.size).toBe(0);
    await waitFor(() => r.gateway.size === 0, { what: 'the gateway to free both' });
  });

  it('input after the exit is dropped', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    const session = sessionOf(r);
    session.end({ code: 0, signal: null, killed: false });
    client.sendBinary(Buffer.from('late'));
    await closedWith(client);
    expect(session.written).toHaveLength(0);
  });
});

describe('TC-WS-07 slow consumer', () => {
  it('a viewer that stops reading is closed 1013 and detached, the others receive every byte', async () => {
    const r = await rig({ highWaterBytes: 131_072, closeGraceMs: 8000 });
    const session = sessionOf(r);
    const slow = await r.open();
    const fast = await r.open();
    await opened(slow);
    await opened(fast);
    slow.pauseReading();
    let sent = 0;
    const chunk = bytes(65_536, 1);
    await waitFor(
      () => {
        session.emit(chunk);
        sent += chunk.length;
        return r.logger.has('terminal_socket_slow_consumer');
      },
      { timeoutMs: 20_000, intervalMs: 2, what: 'the slow consumer to be found' },
    );
    expect(session.viewers.size).toBe(1);
    // every byte emitted so far reached the fast viewer
    await waitFor(() => fast.collected().length >= sent, { timeoutMs: 20_000, what: 'the fast viewer to catch up' });
    expect(fast.collected().length).toBe(sent);
    expect(fast.isClosed()).toBe(false);
    slow.resumeReading();
    expect((await closedWith(slow)).code).toBe(1013);
    expect(slow.closeInfo()?.reason).toBe('slow_consumer');
  });

  it('a large replay that the client has not read yet is not a slow consumer: the first live frame is sent', async () => {
    const r = await rig({ highWaterBytes: 65_536 });
    const session = sessionOf(r);
    session.replay = bytes(2_097_152, 6);
    const client = await r.open();
    client.pauseReading();
    session.emit(Buffer.from('after-the-replay'));
    // two turns of the loop: the batcher's tick has run and the frame was sent (or the viewer was dropped)
    await nextTurn();
    await nextTurn();
    expect(r.logger.has('terminal_socket_slow_consumer')).toBe(false);
    expect(session.viewers.size).toBe(1);
    client.resumeReading();
    await client.until('after-the-replay');
    expect(client.isClosed()).toBe(false);
  });

  it('more data waiting than the high-water mark closes with 1013 at once and sends none of it', async () => {
    const r = await rig({ highWaterBytes: 1_048_576 });
    const session = sessionOf(r);
    const client = await r.open();
    await opened(client);
    session.emit(bytes(1_048_577, 4));
    expect((await closedWith(client)).code).toBe(1013);
    expect(session.viewers.size).toBe(0);
    expect(client.collected().length).toBe(0);
  });
});

describe('TC-WS-08 liveness', () => {
  it('a client that never pongs is terminated within two intervals', async () => {
    const r = await rig({ pingIntervalMs: 40 });
    const client = await r.open(SESSION_NAME, { autoPong: false });
    await opened(client);
    await client.waitClosed();
    expect(r.logger.has('terminal_socket_dead_peer')).toBe(true);
    await waitFor(() => r.gateway.size === 0, { what: 'the gateway to free the socket' });
    expect(sessionOf(r).viewers.size).toBe(0);
  });

  it('a client that answers pings stays open across several intervals', async () => {
    const r = await rig({ pingIntervalMs: 30 });
    const client = await r.open();
    await opened(client);
    let pings = 0;
    while (pings < 4) {
      const message = await client.next();
      if (message.opcode === 9) pings += 1;
    }
    expect(client.isClosed()).toBe(false);
    expect(r.gateway.size).toBe(1);
  });

  it('every tick asks the access service to sweep expired credentials, and only while a socket is open', async () => {
    const r = await rig({ pingIntervalMs: 30 });
    expect(r.access.verifies).toBe(0);
    const client = await r.open();
    await opened(client);
    await waitFor(() => r.access.verifies >= 2, { what: 'two sweeps' });
    await client.close();
    await waitFor(() => r.gateway.size === 0, { what: 'the gateway to free the socket' });
    const after = r.access.verifies;
    expect(r.access.listeners.size).toBe(0);
    // the interval is gone with the last socket
    await nextTurn();
    expect(r.access.verifies).toBe(after);
  });
});

describe('revocation: logout, expiry and the cap of credentials', () => {
  it('a revoked credential closes its sockets with 4003 signed_out and leaves the others', async () => {
    const r = await rig();
    const mine = await r.open(SESSION_NAME, { credential: 'cred-a' });
    const theirs = await r.open(SESSION_NAME, { credential: 'cred-b' });
    await opened(mine);
    await opened(theirs);
    r.access.revoke('cred-a');
    expect(await closedWith(mine)).toEqual({ code: 4003, reason: 'signed_out' });
    expect(theirs.isClosed()).toBe(false);
    expect(r.gateway.size).toBe(1);
  });

  it('closeByCredential counts what it closed', async () => {
    const r = await rig();
    const a = await r.open(SESSION_NAME, { credential: 'cred-a' });
    const b = await r.open(SESSION_NAME, { credential: 'cred-a' });
    const c = await r.open(SESSION_NAME, { credential: 'cred-c' });
    await Promise.all([opened(a), opened(b), opened(c)]);
    expect(r.gateway.closeByCredential('cred-a', 4003, 'signed_out')).toBe(2);
    expect(r.gateway.closeByCredential('cred-unknown', 4003, 'signed_out')).toBe(0);
    expect((await closedWith(a)).code).toBe(4003);
    expect((await closedWith(b)).code).toBe(4003);
    expect(c.isClosed()).toBe(false);
  });

  it('listens for revocations only while a socket is open', async () => {
    const r = await rig();
    expect(r.access.listeners.size).toBe(0);
    const client = await r.open();
    await opened(client);
    expect(r.access.listeners.size).toBe(1);
    await client.close();
    await waitFor(() => r.access.listeners.size === 0, { what: 'the listener to leave' });
  });
});

describe('TC-WS-09 caps and TC-WS-11 shutdown', () => {
  it('admit refuses above the total and the per-session caps with stream_limit, and frees on close', async () => {
    const r = await rig({ maxClients: 3, maxPerSession: 2 });
    r.sessions.set('other-1', new FakeSession(sessionInfo({ name: 'other-1' })));
    const a = await r.open();
    const b = await r.open();
    expect(() => {
      r.gateway.admit(SESSION_NAME);
    }).toThrow(ApiError);
    try {
      r.gateway.admit(SESSION_NAME);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'stream_limit' });
    }
    // another session still has room until the total cap
    const c = await r.open('other-1');
    expect(() => {
      r.gateway.admit('other-1');
    }).toThrow(ApiError);
    await Promise.all([opened(a), opened(b), opened(c)]);
    await a.close();
    await waitFor(() => r.gateway.size === 2, { what: 'a slot to free' });
    expect(() => {
      r.gateway.admit(SESSION_NAME);
    }).not.toThrow();
  });

  it('closeAll closes every socket with 1001 and resolves when they are gone', async () => {
    const r = await rig();
    const a = await r.open();
    const b = await r.open();
    await opened(a);
    await opened(b);
    await r.gateway.closeAll(1001, 'shutting_down');
    expect(await closedWith(a)).toEqual({ code: 1001, reason: 'shutting_down' });
    expect(await closedWith(b)).toEqual({ code: 1001, reason: 'shutting_down' });
    expect(r.gateway.size).toBe(0);
    expect(sessionOf(r).viewers.size).toBe(0);
    expect(r.access.listeners.size).toBe(0);
  });

  it('closeAll terminates a socket whose peer does not answer the close within the grace period', async () => {
    const r = await rig({ closeGraceMs: 60 });
    const client = await r.open();
    await opened(client);
    client.pauseReading();
    await r.gateway.closeAll(1001, 'shutting_down');
    expect(r.gateway.size).toBe(0);
    client.destroy();
  });

  it('closeAll with no socket resolves at once, and the gateway then refuses new ones', async () => {
    const r = await rig();
    await r.gateway.closeAll(1001, 'shutting_down');
    expect(() => {
      r.gateway.admit(SESSION_NAME);
    }).toThrow(ApiError);
    try {
      r.gateway.admit(SESSION_NAME);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'shutting_down' });
    }
  });

  it('a client that leaves cleanly (1000) frees its slot and detaches', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    await client.close(1000);
    await waitFor(() => r.gateway.size === 0, { what: 'the slot to free' });
    expect(sessionOf(r).viewers.size).toBe(0);
  });

  it('a client that drops the connection frees its slot too', async () => {
    const r = await rig();
    const client = await r.open();
    await opened(client);
    client.destroy();
    await waitFor(() => r.gateway.size === 0, { what: 'the slot to free' });
    expect(sessionOf(r).viewers.size).toBe(0);
  });
});

describe('failures of the session', () => {
  it('a session that throws on attach closes the socket with 1011', async () => {
    const r = await rig();
    const bad = new FakeSession(sessionInfo({ name: 'bad-1' }));
    bad.attach = (): TerminalAttachment => {
      throw new Error('the engine failed');
    };
    r.sessions.set('bad-1', bad);
    const client = await r.open('bad-1');
    expect(await closedWith(client)).toEqual({ code: 1011, reason: 'internal_error' });
    await waitFor(() => r.gateway.size === 0, { what: 'the slot to free' });
  });

  it('a session that throws on write closes with 1011 and the process is not told twice', async () => {
    const r = await rig();
    const session = sessionOf(r);
    let calls = 0;
    session.write = (): void => {
      calls += 1;
      throw new Error('the pty is gone');
    };
    const client = await r.open();
    await opened(client);
    client.sendBinary(Buffer.from('a'));
    client.sendBinary(Buffer.from('b'));
    expect((await closedWith(client)).code).toBe(1011);
    expect(calls).toBe(1);
  });

  it('a session that throws on resize closes with 1011', async () => {
    const r = await rig();
    const session = sessionOf(r);
    session.resize = (): void => {
      throw new Error('the pty is gone');
    };
    const client = await r.open();
    await opened(client);
    client.sendText(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    expect((await closedWith(client)).code).toBe(1011);
  });
});

describe('logging: counts and codes only', () => {
  it('writes the open, the close code and the counts, and never a name, a folder, input, output or a credential', async () => {
    const r = await rig();
    const session = sessionOf(r);
    session.replay = Buffer.from(`${CANARY}-replay`);
    const client = await r.open(SESSION_NAME, { credential: 'credential-canary-1' });
    await opened(client);
    client.sendBinary(Buffer.from(`${CANARY}-input`));
    session.emit(Buffer.from(`${CANARY}-output`));
    await client.until(`${CANARY}-output`);
    client.sendText('not json');
    await closedWith(client);
    await waitFor(() => r.logger.has('terminal_socket_close'), { what: 'the close line' });
    const text = r.logger.text;
    expect(r.logger.has('terminal_socket_open')).toBe(true);
    expect(r.logger.lines.find((line) => line.event === 'terminal_socket_close')?.fields).toEqual({
      code: 1008,
      count: 0,
    });
    for (const secret of [SESSION_NAME, FOLDER, 'secret-folder', CANARY, 'credential-canary-1', 'cred-1']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a protocol error is logged by its ws code only', async () => {
    const r = await rig({ maxMessageBytes: 64 });
    const client = await r.open();
    await opened(client);
    client.sendBinary(bytes(65));
    await closedWith(client);
    const line = r.logger.lines.find((entry) => entry.event === 'terminal_socket_error');
    expect(line?.fields).toEqual({ count: 1, code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
  });
});
