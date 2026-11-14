import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { allocatePort, assertPortClosed } from '../ports.ts';
import { waitFor } from '../wait.ts';
import { RawWsClient, WS_GUID, acceptKeyFor, openTerminalSocket } from './ws-client.ts';

// The server side of these tests is written here, on node:http and node:crypto, so that the client is checked against a second
// implementation of RFC 6455 and not against itself.

interface ClientFrame {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

class ServerConn {
  readonly frames: ClientFrame[] = [];
  #raw: Buffer = Buffer.alloc(0);
  #parse: Buffer = Buffer.alloc(0);
  readonly #watchers = new Set<() => void>();

  readonly socket: Duplex;
  readonly request: IncomingMessage;

  constructor(socket: Duplex, request: IncomingMessage) {
    this.socket = socket;
    this.request = request;
    socket.on('data', (chunk: Buffer) => {
      this.#raw = Buffer.concat([this.#raw, chunk]);
      this.#parse = Buffer.concat([this.#parse, chunk]);
      this.#drain();
      for (const watcher of [...this.#watchers]) watcher();
    });
    socket.on('error', () => undefined);
    // http.Server keeps upgraded sockets half-open: answer the end of the peer with an end, as the ws package does.
    socket.on('end', () => {
      socket.end();
    });
  }

  #drain(): void {
    for (;;) {
      const buf = this.#parse;
      if (buf.length < 2) return;
      const b0 = buf.readUInt8(0);
      const b1 = buf.readUInt8(1);
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (buf.length < offset + maskLength + length) return;
      const payload = Buffer.from(buf.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const key = buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0);
      }
      this.frames.push({ fin: (b0 & 0x80) !== 0, rsv: (b0 >> 4) & 7, opcode: b0 & 0x0f, masked, payload });
      this.#parse = buf.subarray(offset + maskLength + length);
    }
  }

  /** Resolves with the first value `probe` returns once data arrives (also checked at once). */
  when<T>(probe: () => T | undefined): Promise<T> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        const value = probe();
        if (value === undefined) return false;
        this.#watchers.delete(check);
        resolve(value);
        return true;
      };
      if (!check()) this.#watchers.add(check);
    });
  }

  frame(index: number): Promise<ClientFrame> {
    return this.when(() => this.frames[index]);
  }

  raw(minLength: number): Promise<Buffer> {
    return this.when(() => (this.#raw.length >= minLength ? this.#raw : undefined));
  }

  send(opcode: number, payload: Uint8Array = new Uint8Array(0), fin = true): void {
    const body = Buffer.from(payload);
    const head =
      body.length < 126
        ? Buffer.from([(fin ? 0x80 : 0) | opcode, body.length])
        : body.length <= 0xffff
          ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, body.length >> 8, body.length & 0xff])
          : (() => {
              const h = Buffer.alloc(10);
              h.writeUInt8((fin ? 0x80 : 0) | opcode, 0);
              h.writeUInt8(127, 1);
              h.writeBigUInt64BE(BigInt(body.length), 2);
              return h;
            })();
    this.socket.write(Buffer.concat([head, body]));
  }

  text(value: string): void {
    this.send(1, Buffer.from(value));
  }

  json(value: unknown): void {
    this.text(JSON.stringify(value));
  }

  binary(value: string | Uint8Array): void {
    this.send(2, typeof value === 'string' ? Buffer.from(value) : value);
  }

  close(code?: number, reason = ''): void {
    if (code === undefined) {
      this.send(8);
      return;
    }
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.send(8, payload);
  }

  /** Resolves once the peer closed the TCP connection. */
  ended(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) resolve();
      else {
        this.socket.once('close', () => {
          resolve();
        });
      }
    });
  }
}

interface TestServer {
  port: number;
  conns: ServerConn[];
  next(): Promise<ServerConn>;
}

interface ServerOptions {
  /** Replaces the Sec-WebSocket-Accept value. */
  accept?: string;
  /** Answers the upgrade with this raw HTTP response instead of switching protocols. */
  reject?: string;
  /** Subprotocol echoed back (default: the first offered). */
  protocol?: string | null;
  onConnection?: (conn: ServerConn) => void;
}

const servers: { server: Server; port: number; sockets: Set<Duplex> }[] = [];
const clients: RawWsClient[] = [];

async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const port = await allocatePort();
  const conns: ServerConn[] = [];
  const waiting: ((conn: ServerConn) => void)[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (opts.reject !== undefined) {
      socket.end(opts.reject);
      return;
    }
    const key = String(req.headers['sec-websocket-key']);
    const accept =
      opts.accept ?? createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const chosen = opts.protocol === undefined ? offered[0] : (opts.protocol ?? undefined);
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      ...(chosen === undefined ? [] : [`Sec-WebSocket-Protocol: ${chosen}`]),
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
    const conn = new ServerConn(socket, req);
    conns.push(conn);
    const waiter = waiting.shift();
    if (waiter !== undefined) waiter(conn);
    opts.onConnection?.(conn);
  });
  await new Promise<void>((resolve) => {
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  servers.push({ server, port, sockets });
  return {
    port,
    conns,
    next: () => {
      const known = conns[0];
      if (known !== undefined) return Promise.resolve(known);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

async function connect(
  server: TestServer,
  opts: Partial<Parameters<typeof RawWsClient.connect>[1]> = {},
): Promise<RawWsClient> {
  const client = await RawWsClient.connect(server.port, { path: '/ws', ...opts });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const { server, port, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    // The accepted connections may still be closing on a loaded machine: poll instead of asserting once.
    await waitFor(
      async () => {
        await assertPortClosed(port);
        return true;
      },
      { timeoutMs: 15_000, intervalMs: 50, what: 'the test server port to be released' },
    );
  }
});

describe('acceptKeyFor', () => {
  it('matches the vector of RFC 6455 section 1.3', () => {
    expect(WS_GUID).toBe('258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    expect(acceptKeyFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('handshake', () => {
  it('sends the request of RFC 6455 and checks the accept key (acceptOk)', async () => {
    const server = await startServer();
    const client = await connect(server, { key: 'dGhlIHNhbXBsZSBub25jZQ==' });
    const conn = await server.next();
    expect(conn.request.method).toBe('GET');
    expect(conn.request.url).toBe('/ws');
    expect(conn.request.headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(conn.request.headers['sec-websocket-version']).toBe('13');
    expect((conn.request.headers.upgrade ?? '').toLowerCase()).toBe('websocket');
    expect(conn.request.headers.host).toBe(`127.0.0.1:${String(server.port)}`);
    expect(client.status).toBe(101);
    expect(client.acceptOk).toBe(true);
    expect(client.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('generates a fresh 16-byte key when none is given', async () => {
    const server = await startServer();
    await connect(server);
    await connect(server);
    await server.next();
    const keys = server.conns.map((c) => String(c.request.headers['sec-websocket-key']));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(Buffer.from(key, 'base64')).toHaveLength(16);
  });

  it('reports acceptOk false for a wrong Sec-WebSocket-Accept', async () => {
    const server = await startServer({ accept: acceptKeyFor('another key') });
    const client = await connect(server);
    expect(client.status).toBe(101);
    expect(client.acceptOk).toBe(false);
  });

  it('offers the subprotocol caw.terminal.v1 by default and takes a list when given', async () => {
    const server = await startServer();
    const first = await connect(server);
    expect((await server.next()).request.headers['sec-websocket-protocol']).toBe('caw.terminal.v1');
    expect(first.headers['sec-websocket-protocol']).toBe('caw.terminal.v1');
    await connect(server, { protocols: ['other.v9', 'caw.terminal.v1'] });
    expect(server.conns[1]?.request.headers['sec-websocket-protocol']).toBe('other.v9, caw.terminal.v1');
  });

  it('sends no subprotocol header for an empty list', async () => {
    const server = await startServer({ protocol: null });
    await connect(server, { protocols: [] });
    expect((await server.next()).request.headers['sec-websocket-protocol']).toBeUndefined();
  });

  it('sends Origin (default the loopback origin of the port, null omits it), Cookie and extra headers', async () => {
    const server = await startServer();
    await connect(server, { cookie: 'caw_session=value-1', headers: { 'X-Probe': 'yes' } });
    await connect(server, { origin: null });
    await connect(server, { origin: 'http://attacker.invalid' });
    const [a, b, c] = server.conns;
    expect(a?.request.headers.origin).toBe(`http://127.0.0.1:${String(server.port)}`);
    expect(a?.request.headers.cookie).toBe('caw_session=value-1');
    expect(a?.request.headers['x-probe']).toBe('yes');
    expect(b?.request.headers.origin).toBeUndefined();
    expect(b?.request.headers.cookie).toBeUndefined();
    expect(c?.request.headers.origin).toBe('http://attacker.invalid');
  });

  it('resolves with the status, headers and body of a refused upgrade', async () => {
    const body = '{"error":"no"}';
    const server = await startServer({
      reject: `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`,
    });
    const client = await connect(server);
    expect(client.status).toBe(403);
    expect(client.acceptOk).toBe(false);
    expect(client.headers['content-type']).toBe('application/json');
    expect(client.body).toBe(body);
    await expect(client.next(1000)).rejects.toThrow(/closed/);
  });

  it('rejects when nothing listens on the port', async () => {
    const port = await allocatePort();
    await assertPortClosed(port);
    await expect(RawWsClient.connect(port, { path: '/ws' })).rejects.toThrow();
  });
});

describe('frames sent by the client', () => {
  it('masks text, binary, ping and pong frames by default', async () => {
    const server = await startServer({ protocol: null });
    const client = await connect(server);
    const conn = await server.next();
    client.sendText('hello');
    client.sendBinary(Uint8Array.from([1, 2, 3]));
    client.sendPing(Uint8Array.from([9]));
    client.sendPong(Uint8Array.from([8]));
    const frames = await Promise.all([0, 1, 2, 3].map((i) => conn.frame(i)));
    expect(frames.map((f) => f.opcode)).toEqual([1, 2, 9, 10]);
    expect(frames.every((f) => f.masked && f.fin && f.rsv === 0)).toBe(true);
    expect(frames[0]?.payload.toString()).toBe('hello');
    expect([...(frames[1]?.payload ?? [])]).toEqual([1, 2, 3]);
    expect([...(frames[2]?.payload ?? [])]).toEqual([9]);
    expect([...(frames[3]?.payload ?? [])]).toEqual([8]);
  });

  it('uses a different mask key for each frame', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    for (let i = 0; i < 8; i += 1) client.sendText('same');
    await conn.frame(7);
    const raw = await conn.raw(8 * 10);
    const keys = new Set<string>();
    for (let i = 0; i < 8; i += 1) keys.add(raw.subarray(i * 10 + 2, i * 10 + 6).toString('hex'));
    expect(keys.size).toBeGreaterThan(1);
  });

  it('sends an unmasked frame on request (mask: false) and sets reserved bits and fin', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.sendFrame({ opcode: 2, mask: false, payload: Uint8Array.from([5, 6]) });
    client.sendFrame({ opcode: 1, rsv: 4, payload: Buffer.from('r') });
    client.sendFrame({ opcode: 1, rsv: 3, fin: false, payload: Buffer.from('f') });
    const [a, b, c] = await Promise.all([conn.frame(0), conn.frame(1), conn.frame(2)]);
    expect(a).toMatchObject({ opcode: 2, masked: false, fin: true, rsv: 0 });
    expect([...a.payload]).toEqual([5, 6]);
    expect(b).toMatchObject({ opcode: 1, masked: true, rsv: 4 });
    expect(c).toMatchObject({ opcode: 1, masked: true, rsv: 3, fin: false });
  });

  it('sends a fragmented message as frames (continuation, fin on the last)', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.sendFrame({ opcode: 2, fin: false, payload: Buffer.from('ab') });
    client.sendFrame({ opcode: 0, fin: false, payload: Buffer.from('cd') });
    client.sendFrame({ opcode: 0, fin: true, payload: Buffer.from('ef') });
    const last = await conn.frame(2);
    expect(conn.frames.map((f) => [f.opcode, f.fin])).toEqual([
      [2, false],
      [0, false],
      [0, true],
    ]);
    expect(last.payload.toString()).toBe('ef');
  });

  it('encodes the length with 7, 16 and 64 bits', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    const sizes = [125, 126, 65535, 65536, 1024 * 1024 + 1];
    for (const size of sizes) client.sendBinary(new Uint8Array(size).fill(7));
    const frames = await Promise.all(sizes.map((_, i) => conn.frame(i)));
    expect(frames.map((f) => f.payload.length)).toEqual(sizes);
    expect(frames.every((f) => f.payload.every((b) => b === 7))).toBe(true);
  });

  it('can declare a length that is not the one it sends (lengthLie)', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.sendFrame({ opcode: 2, mask: false, payload: Uint8Array.from([1, 2, 3]), lengthLie: 1000 });
    client.sendFrame({ opcode: 2, mask: false, payload: Uint8Array.from([1]), lengthLie: 2 ** 40 });
    const raw = await conn.raw(4 + 3 + 10 + 1);
    expect([...raw.subarray(0, 4)]).toEqual([0x82, 126, 1000 >> 8, 1000 & 0xff]);
    expect([...raw.subarray(4, 7)]).toEqual([1, 2, 3]);
    expect([...raw.subarray(7, 9)]).toEqual([0x82, 127]);
    expect(raw.readBigUInt64BE(9)).toBe(2n ** 40n);
  });

  it('sends close frames with a code and reason, or an empty one', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.sendCloseFrame(1008, 'bad_message');
    const frame = await conn.frame(0);
    expect(frame.opcode).toBe(8);
    expect(frame.payload.readUInt16BE(0)).toBe(1008);
    expect(frame.payload.subarray(2).toString()).toBe('bad_message');
    client.sendCloseFrame();
    expect((await conn.frame(1)).payload).toHaveLength(0);
  });
});

describe('frames received by the client', () => {
  it('keeps text frames (parsed) apart from binary data', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.json({ type: 'ready', v: 1 });
    conn.binary('abc');
    conn.text('not json');
    conn.binary('def');
    conn.json({ type: 'live' });
    const all = await client.until('def');
    expect(all.toString()).toBe('abcdef');
    await client.until('def');
    expect(client.collected().toString()).toBe('abcdef');
    await expect(
      (async () => {
        for (let i = 0; i < 5; i += 1) await client.next(2000);
        return client.texts();
      })(),
    ).resolves.toEqual([{ type: 'ready', v: 1 }, 'not json', { type: 'live' }]);
  });

  it('next() returns messages in order with opcode and payload', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.text('one');
    conn.binary(Uint8Array.from([2]));
    const first = await client.next();
    const second = await client.next();
    expect(first.opcode).toBe(1);
    expect(first.payload.toString()).toBe('one');
    expect(second.opcode).toBe(2);
    expect([...second.payload]).toEqual([2]);
  });

  it('reassembles a fragmented message and passes a ping that arrives between the fragments', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.send(2, Buffer.from('ab'), false);
    conn.send(9, Buffer.from('p'));
    conn.send(0, Buffer.from('cd'), false);
    conn.send(0, Buffer.from('ef'), true);
    const ping = await client.next();
    expect(ping.opcode).toBe(9);
    const message = await client.next();
    expect(message.opcode).toBe(2);
    expect(message.payload.toString()).toBe('abcdef');
    expect(client.collected().toString()).toBe('abcdef');
  });

  it('reassembles a fragmented text message before parsing it', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.send(1, Buffer.from('{"type":'), false);
    conn.send(0, Buffer.from('"size","cols":80}'), true);
    await client.next();
    expect(client.texts()).toEqual([{ type: 'size', cols: 80 }]);
  });

  it('handles frames that arrive split in small pieces and several frames in one chunk', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    const big = Buffer.alloc(70000, 0x61);
    const head = Buffer.from([0x82, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
    conn.socket.write(head.subarray(0, 3));
    conn.socket.write(Buffer.concat([head.subarray(3), big.subarray(0, 10)]));
    conn.socket.write(big.subarray(10));
    conn.binary('x');
    const all = await client.until('x');
    expect(all).toHaveLength(70001);
  });

  it('until() accepts a string, a regular expression and bytes, and does not consume text frames', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.binary('prompt> ');
    conn.json({ type: 'live' });
    await client.until('prompt');
    await client.until(/prompt>\s$/);
    await client.until(Uint8Array.from([0x3e, 0x20]));
    expect((await client.next()).opcode).toBe(2);
    expect((await client.next()).opcode).toBe(1);
  });

  it('until() finds a needle that spans two frames', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.binary('READ');
    conn.binary('Y marker');
    await client.until('READY');
  });

  it('until() rejects on its timeout, and when the socket closes first', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    await expect(client.until('never', { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    const pending = client.until('never', { timeoutMs: 10_000 });
    conn.socket.destroy();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('next() rejects on its timeout and after the socket closed', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    await expect(client.next(50)).rejects.toThrow(/timed out/);
    conn.socket.destroy();
    await client.waitClosed();
    await expect(client.next()).rejects.toThrow(/closed/);
  });

  it('keeps the messages that arrived before the socket closed readable', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.text('last');
    conn.socket.end();
    await client.waitClosed();
    expect((await client.next()).payload.toString()).toBe('last');
    await expect(client.next()).rejects.toThrow(/closed/);
  });

  it('sees data the server sent in the same chunk as the handshake response', async () => {
    const server = await startServer({
      onConnection: (conn) => {
        conn.binary('early');
      },
    });
    const client = await connect(server);
    await client.until('early');
  });
});

describe('ping and pong', () => {
  it('answers a ping with a masked pong that echoes the payload (autoPong default)', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.send(9, Buffer.from('beat'));
    const pong = await conn.frame(0);
    expect(pong.opcode).toBe(10);
    expect(pong.masked).toBe(true);
    expect(pong.payload.toString()).toBe('beat');
    expect((await client.next()).opcode).toBe(9);
  });

  it('does not answer when autoPong is false, and still reports the ping', async () => {
    const server = await startServer();
    const client = await connect(server, { autoPong: false });
    const conn = await server.next();
    conn.send(9, Buffer.from('beat'));
    const ping = await client.next();
    expect(ping.opcode).toBe(9);
    expect(ping.payload.toString()).toBe('beat');
    client.sendText('after');
    const frame = await conn.frame(0);
    expect(frame.opcode).toBe(1);
    expect(conn.frames).toHaveLength(1);
    client.sendPong(ping.payload);
    expect((await conn.frame(1)).opcode).toBe(10);
  });

  it('receives a pong the server sends', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.send(10, Buffer.from('x'));
    expect((await client.next()).opcode).toBe(10);
  });
});

describe('close', () => {
  it('records the code and reason of a close frame and echoes the close', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    expect(client.closeInfo()).toBeNull();
    conn.close(4000, 'exited');
    await client.waitClosed();
    expect(client.closeInfo()).toEqual({ code: 4000, reason: 'exited' });
    const echo = await conn.frame(0);
    expect(echo.opcode).toBe(8);
    expect(echo.payload.readUInt16BE(0)).toBe(4000);
    await conn.ended();
  });

  it('reads an empty close frame as code 1005', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.close();
    await client.waitClosed();
    expect(client.closeInfo()).toEqual({ code: 1005, reason: '' });
  });

  it('close(code) sends the frame and resolves when the server closed the connection', async () => {
    const server = await startServer({
      onConnection: (conn) => {
        void conn.frame(0).then((frame) => {
          conn.send(8, frame.payload);
          conn.socket.end();
        });
      },
    });
    const client = await connect(server);
    await client.close(1000);
    expect(client.closeInfo()).toEqual({ code: 1000, reason: '' });
    expect(client.isClosed()).toBe(true);
    await client.close();
  });

  it('close() resolves after a grace period when the server never answers', async () => {
    const server = await startServer();
    const client = await connect(server);
    await server.next();
    await client.close(1000, { graceMs: 50 });
    expect(client.isClosed()).toBe(true);
  });

  it('closeInfo stays null when the connection drops without a close frame', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    conn.socket.destroy();
    await client.waitClosed();
    expect(client.closeInfo()).toBeNull();
    expect(client.isClosed()).toBe(true);
  });

  it('destroy() closes the socket at once', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.destroy();
    await conn.ended();
    expect(client.isClosed()).toBe(true);
  });
});

describe('reading control', () => {
  it('pauseReading holds the data back until resumeReading', async () => {
    const server = await startServer();
    const client = await connect(server);
    const conn = await server.next();
    client.pauseReading();
    await new Promise<void>((resolve) => {
      conn.socket.write(Buffer.from([0x82, 4, 1, 2, 3, 4]), () => {
        resolve();
      });
    });
    expect(client.collected()).toHaveLength(0);
    client.resumeReading();
    expect([...(await client.until(Uint8Array.from([4])))]).toEqual([1, 2, 3, 4]);
  });
});

describe('openTerminalSocket', () => {
  function terminalServer(name: string, frames: (conn: ServerConn) => void): Promise<TestServer> {
    return startServer({
      onConnection: (conn) => {
        expect(conn.request.url).toBe(`/api/v3/terminal/sessions/${name}/socket`);
        frames(conn);
      },
    });
  }

  it('reads ready, the replay and live, and leaves the socket open for live output', async () => {
    const server = await terminalServer('work-1', (conn) => {
      conn.json({ type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 7, viewers: 2 });
      conn.binary('replay1');
      conn.json({ type: 'live' });
      conn.binary('-live');
    });
    const opened = await openTerminalSocket(server.port, 'work-1', { cookie: 'caw_x=1' });
    clients.push(opened.client);
    expect(opened.ready).toEqual({ type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 7, viewers: 2 });
    expect(opened.replay.toString()).toBe('replay1');
    const conn = await server.next();
    expect(conn.request.headers.cookie).toBe('caw_x=1');
    expect(conn.request.headers['sec-websocket-protocol']).toBe('caw.terminal.v1');
    await opened.client.until('-live');
  });

  it('joins a replay sent in several frames, and accepts an empty replay', async () => {
    const server = await terminalServer('work-2', (conn) => {
      conn.json({ type: 'ready', v: 1, cols: 80, rows: 24, replayBytes: 4, viewers: 1 });
      conn.binary('ab');
      conn.binary('cd');
      conn.json({ type: 'live' });
    });
    const opened = await openTerminalSocket(server.port, 'work-2', { cookie: 'c=1', origin: 'http://127.0.0.1:1' });
    clients.push(opened.client);
    expect(opened.replay.toString()).toBe('abcd');
    expect((await server.next()).request.headers.origin).toBe('http://127.0.0.1:1');
  });

  it('encodes the session name in the path', async () => {
    const server = await startServer({
      onConnection: (conn) => {
        conn.json({ type: 'ready', v: 1, cols: 1, rows: 1, replayBytes: 0, viewers: 1 });
        conn.json({ type: 'live' });
      },
    });
    const opened = await openTerminalSocket(server.port, 'a b/c', { cookie: 'c=1' });
    clients.push(opened.client);
    expect((await server.next()).request.url).toBe('/api/v3/terminal/sessions/a%20b%2Fc/socket');
  });

  it('throws with the status when the upgrade is refused, without the body', async () => {
    const server = await startServer({
      reject: 'HTTP/1.1 404 Not Found\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret',
    });
    const failure = await openTerminalSocket(server.port, 'gone', { cookie: 'c=1' }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/404/);
    expect(failure?.message).not.toMatch(/secret/);
  });

  it('throws when the first message is not ready', async () => {
    const server = await terminalServer('work-3', (conn) => {
      conn.binary('bytes first');
    });
    await expect(openTerminalSocket(server.port, 'work-3', { cookie: 'c=1' })).rejects.toThrow(/ready/);
  });

  it('throws when the socket closes before live', async () => {
    const server = await terminalServer('work-4', (conn) => {
      conn.json({ type: 'ready', v: 1, cols: 80, rows: 24, replayBytes: 0, viewers: 1 });
      conn.close(4001, 'killed');
    });
    await expect(openTerminalSocket(server.port, 'work-4', { cookie: 'c=1' })).rejects.toThrow(/live/);
  });
});
