// Stack variants of the socket tests, attach half (CAW-57, design 08 section 3.5, ids TC-WS-01, 02, 03, 04 and 10): the production
// app, upgrade listener and gateway over the REAL terminal service of the engine (names, replay buffer, resize policy, viewers),
// with a scripted pseudo terminal (`startTerminalHarness`). Design 02's own suite proves the same ids over a scripted host
// (`terminal-socket.int.test.ts`); here the engine and the server have to agree: what the service replays is what the gateway
// sends, what a client types is what the pseudo terminal is written, and the size the service applies is the size every viewer
// is told. Sizes, caps and close codes come from the shared constants.
//
// A scripted pid names no process, so the liveness watchdog of the service ends a session after about 10 s of real time (see the
// harness): every scenario here takes well under a second.
import type { FakePty } from '@mcs/engine/testing';
import {
  CreateSessionResponseSchema,
  TERMINAL_CLOSE_CODES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_SIZE_LIMITS,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_TEXT_FRAME_MAX_BYTES,
  TerminalServerMessageSchema,
  TerminalStateSchema,
  buildPath,
  routes,
  type TerminalServerMessage,
  type TerminalSessionInfo,
} from '@mcs/shared';
import { RawWsClient, waitFor, type OpenedTerminalSocket, type WsMessage } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { pageOrigin } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

const OP_CONTINUATION = 0;
const OP_TEXT = 1;
const OP_BINARY = 2;

async function createSession(h: TerminalHarness): Promise<{ name: string; pty: FakePty }> {
  const made = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
  expect(made.status, made.body).toBe(200);
  const { name } = CreateSessionResponseSchema.parse(made.json).session;
  const pty = h.backend.last;
  if (pty === undefined) throw new Error('the create route answered a session and nothing was spawned');
  return { name, pty };
}

async function rowOf(h: TerminalHarness, name: string): Promise<TerminalSessionInfo | undefined> {
  const state = await h.http('GET', routes.terminalState.path);
  return TerminalStateSchema.parse(state.json).sessions.find((session) => session.name === name);
}

/** A text frame of the server, checked against the wire schema (an unknown or malformed frame fails the test). */
function serverMessage(message: WsMessage): TerminalServerMessage {
  expect(message.opcode).toBe(OP_TEXT);
  return TerminalServerMessageSchema.parse(JSON.parse(message.payload.toString('utf8')));
}

/** The `size` frames a client has received so far. */
function sizesSeen(client: RawWsClient): { cols: number; rows: number }[] {
  const sizes: { cols: number; rows: number }[] = [];
  for (const text of client.texts()) {
    const parsed = TerminalServerMessageSchema.safeParse(text);
    if (parsed.success && parsed.data.type === 'size') sizes.push({ cols: parsed.data.cols, rows: parsed.data.rows });
  }
  return sizes;
}

function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

/** Bytes that follow no pattern a text codec would keep: a multiplicative hash of the index, every value of a byte among them. */
function noise(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

describe('the handshake and the first frames over the real service', () => {
  it('TC-WS-01: 101 with the accept key and the subprotocol, then ready, the replay and live; bytes both ways; a resize frame resizes', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    // a check mark: three bytes of UTF-8 in the replay
    const banner = Buffer.from(`banner ${String.fromCodePoint(0x2713)}\r\n`, 'utf8');
    pty.emitData(banner);

    const client = await RawWsClient.connect(h.port, {
      path: buildPath(routes.terminalSocket, { name }),
      cookie: h.cookie,
      origin: pageOrigin(h.port),
    });
    try {
      expect(client.status).toBe(101);
      expect(client.acceptOk).toBe(true);
      expect(client.headers['sec-websocket-protocol']).toBe(TERMINAL_SUBPROTOCOL);
      // no compression was negotiated: a binary frame is the bytes of the terminal and nothing else
      expect(client.headers['sec-websocket-extensions']).toBeUndefined();

      // the order of the wire: ready (it names the replay), the replay as binary, live
      expect(serverMessage(await client.next())).toEqual({
        type: 'ready',
        v: 1,
        cols: TERMINAL_SIZE_LIMITS.defaultCols,
        rows: TERMINAL_SIZE_LIMITS.defaultRows,
        replayBytes: banner.length,
        viewers: 1,
      });
      const replay = await client.next();
      expect(replay.opcode).toBe(OP_BINARY);
      expect(replay.payload.equals(banner)).toBe(true);
      expect(serverMessage(await client.next())).toEqual({ type: 'live' });
      // the real service counts the viewer, and the pseudo terminal was spawned with the size the client was told
      expect((await rowOf(h, name))?.viewers).toBe(1);
      expect(h.backend.spawns[0]).toMatchObject({
        cols: TERMINAL_SIZE_LIMITS.defaultCols,
        rows: TERMINAL_SIZE_LIMITS.defaultRows,
      });

      // output: raw bytes, not text (NUL, 0xFF and an escape sequence survive)
      const output = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x80, 0x0a]);
      pty.emitData(output);
      const live = await client.next();
      expect(live.opcode).toBe(OP_BINARY);
      expect(live.payload.equals(output)).toBe(true);

      // input: raw bytes, unchanged
      const input = Buffer.from([0x6c, 0x73, 0x00, 0xff, 0x0d]);
      client.sendBinary(input);
      await waitFor(() => pty.written.length === 1, { what: 'the input to reach the pseudo terminal' });
      expect(pty.written[0]?.equals(input)).toBe(true);

      // a resize frame reaches the pseudo terminal, the viewer is told the size, and the row of the session carries it
      client.sendText(resizeFrame(100, 40));
      expect(serverMessage(await client.next())).toEqual({ type: 'size', cols: 100, rows: 40 });
      expect(pty.sizes).toEqual([{ cols: 100, rows: 40 }]);
      expect(await rowOf(h, name)).toMatchObject({ cols: 100, rows: 40 });
    } finally {
      await client.close();
    }
    // the view ended, the process did not
    await waitFor(async () => (await rowOf(h, name))?.viewers === 0, { what: 'the viewer to leave the session' });
    expect(pty.exited).toBe(false);
    expect(pty.killCalls).toBe(0);
  });
});

describe('input fidelity', () => {
  it('TC-WS-02: every byte value, control bytes, escape sequences, broken UTF-8 and split frames reach the pseudo terminal exactly', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    const { client } = await h.ws(name);

    const everyByte = Buffer.from(Array.from({ length: 256 }, (_unused, value) => value));
    const euro = Buffer.from(String.fromCodePoint(0x20ac), 'utf8');
    const messages: Buffer[] = [
      everyByte,
      Buffer.from([0x03]),
      Buffer.from([0x00]),
      Buffer.from([0xff, 0xfe, 0x80, 0xc3]),
      Buffer.from('\u001b[200~pasted \u001b[31mtext\u001b[0m\r\n\u001b[201~', 'utf8'),
      Buffer.from('\u001b[A\u001b[B\u001bOP\u001b[1;5C', 'utf8'),
      // one character of three bytes, split over two messages: neither half is valid UTF-8 alone
      euro.subarray(0, 1),
      euro.subarray(1),
      Buffer.from('\r'),
    ];
    for (const message of messages) client.sendBinary(message);

    // one message in three frames (binary, continuation, final continuation): the terminal gets it as one write
    const fragmented = noise(3000, 7);
    client.sendFrame({ opcode: OP_BINARY, fin: false, payload: fragmented.subarray(0, 1) });
    client.sendFrame({ opcode: OP_CONTINUATION, fin: false, payload: fragmented.subarray(1, 1700) });
    client.sendFrame({ opcode: OP_CONTINUATION, fin: true, payload: fragmented.subarray(1700) });
    // an empty message is nothing to write, and it does not end the view
    client.sendBinary(new Uint8Array(0));
    // the largest message the path takes, to the byte
    const largest = noise(TERMINAL_INPUT_MAX_BYTES, 11);
    client.sendBinary(largest);

    const expected = [...messages, fragmented, largest];
    await waitFor(() => pty.written.length >= expected.length, { what: 'every message to reach the pseudo terminal' });
    expect(pty.written.length).toBe(expected.length);
    expected.forEach((message, index) => {
      expect(pty.written[index]?.equals(message), `message ${String(index)}`).toBe(true);
    });
    // nothing was reordered, added or dropped between the messages
    expect(Buffer.concat(pty.written).equals(Buffer.concat(expected))).toBe(true);
    expect(client.closeInfo()).toBeNull();
    expect(pty.sizes).toEqual([]);
  });
});

describe('atomic attach', () => {
  const WATCHERS = 20;
  /** Watcher k starts its handshake once this many chunks were emitted: before any output, several in one turn, and spread out. */
  const START_AT = [0, 0, 1, 3, 3, 3, 7, 12, 20, 20, 33, 54, 54, 88, 143, 143, 143, 231, 374, 400];
  /** Chunks emitted after the last watcher is live: every watcher sees them as live output. */
  const TAIL = 50;
  /** A bound of the scenario, below the replay buffer (1 MiB of 13-byte chunks): beyond it the handshakes hang. */
  const MAX_CHUNKS = 60_000;

  const chunk = (index: number): string => `chunk-${String(index).padStart(5, '0')}\r\n`;

  /** The chunk numbers of a byte stream; a line that is not a whole chunk fails. */
  function numbersOf(data: Buffer): number[] {
    const lines = data.toString('latin1').split('\r\n');
    expect(lines.pop(), 'the stream ends after a whole chunk').toBe('');
    return lines.map((line) => {
      const match = /^chunk-(\d{5})$/.exec(line);
      if (match === null) throw new Error('a line of the stream is not a whole chunk');
      return Number(match[1]);
    });
  }

  it('TC-WS-03: 20 watchers attach while numbered chunks are emitted; each receives one contiguous run without a gap or a duplicate', async () => {
    expect(START_AT).toHaveLength(WATCHERS);
    // the cap of one session is raised for this scenario only (the caps themselves are TC-WS-09)
    const h = await startTerminalHarness({ limits: { socket: { maxPerSession: WATCHERS } } });
    const { name, pty } = await createSession(h);
    const turn = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    let emitted = 0;
    const emit = (): void => {
      pty.emitData(chunk(emitted));
      emitted += 1;
    };
    const opening: Promise<OpenedTerminalSocket>[] = [];
    let settled = 0;
    while (settled < WATCHERS) {
      while (opening.length < WATCHERS && (START_AT[opening.length] ?? 0) <= emitted) {
        const socket = h.ws(name);
        opening.push(socket);
        const count = (): void => {
          settled += 1;
        };
        socket.then(count, count);
      }
      if (emitted >= MAX_CHUNKS) throw new Error('the watchers did not attach while the chunks were emitted');
      emit();
      // one turn of the event loop: handshakes and attaches happen between two chunks, at whatever point they are ready
      await turn();
    }
    const watchers = await Promise.all(opening);
    for (let i = 0; i < TAIL; i += 1) {
      emit();
      await turn();
    }
    const total = emitted;
    const last = chunk(total - 1);
    await Promise.all(watchers.map(({ client }) => client.until(last)));

    const replaySizes = new Set<number>();
    for (const [index, { client, ready, replay }] of watchers.entries()) {
      const label = `watcher ${String(index)}`;
      // replay then live: together exactly the chunks from the first one to the last one emitted, each once and in order
      const numbers = numbersOf(client.collected());
      const first = numbers[0] ?? -1;
      expect(first, label).toBe(0);
      expect(numbers, label).toEqual(Array.from({ length: total - first }, (_unused, offset) => first + offset));
      // the replay is a whole number of chunks (the snapshot is taken between two chunks) and `ready` names its size
      expect(ready.replayBytes, label).toBe(replay.length);
      const replayed = numbersOf(replay);
      expect(replayed, label).toEqual(numbers.slice(0, replayed.length));
      // the tail was emitted after every attach: no watcher got all of it from its replay
      expect(replayed.length, label).toBeLessThanOrEqual(total - TAIL);
      replaySizes.add(replay.length);
    }
    // the attaches really fell at different points of the stream, one of them in the middle of it
    expect(replaySizes.size).toBeGreaterThanOrEqual(3);
    // each handshake saw one viewer more: no two attaches ran inside each other
    expect(watchers.map(({ ready }) => ready.viewers).sort((a, b) => a - b)).toEqual(
      Array.from({ length: WATCHERS }, (_unused, index) => index + 1),
    );
    expect((await rowOf(h, name))?.viewers).toBe(WATCHERS);
    for (const { client } of watchers) expect(client.closeInfo()).toBeNull();
  });
});

describe('several viewers of one session', () => {
  it('TC-WS-04: every viewer sees the same bytes and the same size; the last resize wins and an out-of-range size is clamped before the terminal', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    const viewers = [await h.ws(name), await h.ws(name), await h.ws(name)];
    const [a, b, c] = viewers.map(({ client }) => client);
    if (a === undefined || b === undefined || c === undefined) throw new Error('three viewers were opened');
    expect(viewers.map(({ ready }) => ready.viewers)).toEqual([1, 2, 3]);

    const output = Buffer.concat([
      Buffer.from(`shared ${String.fromCodePoint(0xe9, 0x4e16)} `),
      noise(5000, 3),
      Buffer.from('<end>'),
    ]);
    pty.emitData(output.subarray(0, 100));
    pty.emitData(output.subarray(100));
    for (const client of [a, b, c]) {
      await client.until('<end>');
      expect(client.collected().equals(output)).toBe(true);
    }

    const everyoneSees = (cols: number, rows: number): Promise<unknown> =>
      waitFor(
        () =>
          [a, b, c].every((client) => {
            const told = sizesSeen(client).at(-1);
            return told?.cols === cols && told.rows === rows;
          }),
        { what: `every viewer to be told ${String(cols)}x${String(rows)}` },
      );

    // one viewer resizes: all three are told, the sender included
    a.sendText(resizeFrame(90, 31));
    await everyoneSees(90, 31);
    // another viewer resizes later: its size replaces the first (the last one wins, not the smallest and not the first)
    b.sendText(resizeFrame(132, 43));
    await everyoneSees(132, 43);
    // a burst from one viewer: the terminal ends at the last size of the burst
    for (const cols of [60, 61, 62, 63]) c.sendText(resizeFrame(cols, 20));
    c.sendText(resizeFrame(77, 22));
    await everyoneSees(77, 22);
    expect(pty.sizes.at(-1)).toEqual({ cols: 77, rows: 22 });

    // sizes the wire allows and no terminal takes: clamped before the pseudo terminal, and the viewers are told the clamped size
    a.sendText(resizeFrame(1000, 1));
    await everyoneSees(TERMINAL_SIZE_LIMITS.maxCols, TERMINAL_SIZE_LIMITS.minRows);
    b.sendText(resizeFrame(1, 1000));
    await everyoneSees(TERMINAL_SIZE_LIMITS.minCols, TERMINAL_SIZE_LIMITS.maxRows);
    for (const size of pty.sizes) {
      expect(size.cols).toBeGreaterThanOrEqual(TERMINAL_SIZE_LIMITS.minCols);
      expect(size.cols).toBeLessThanOrEqual(TERMINAL_SIZE_LIMITS.maxCols);
      expect(size.rows).toBeGreaterThanOrEqual(TERMINAL_SIZE_LIMITS.minRows);
      expect(size.rows).toBeLessThanOrEqual(TERMINAL_SIZE_LIMITS.maxRows);
    }
    expect(pty.sizes.at(-1)).toEqual({ cols: TERMINAL_SIZE_LIMITS.minCols, rows: TERMINAL_SIZE_LIMITS.maxRows });

    // a viewer that comes now starts at the size the terminal has, and the row of the session agrees
    const late = await h.ws(name);
    expect(late.ready).toMatchObject({
      cols: TERMINAL_SIZE_LIMITS.minCols,
      rows: TERMINAL_SIZE_LIMITS.maxRows,
      viewers: 4,
    });
    expect(late.replay.equals(output)).toBe(true);
    expect(await rowOf(h, name)).toMatchObject({
      cols: TERMINAL_SIZE_LIMITS.minCols,
      rows: TERMINAL_SIZE_LIMITS.maxRows,
      viewers: 4,
    });
    // a resize is not input
    expect(pty.written).toEqual([]);
  });
});

describe('reconnect', () => {
  it('TC-WS-10: after a close by the server a new socket starts with ready and gets the replay again, with what was printed meanwhile', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    pty.emitData('first screen\r\n');

    const first = await h.ws(name);
    expect(first.replay.toString('utf8')).toBe('first screen\r\n');
    // the server ends the view: a text frame that is not a protocol message
    first.client.sendText('not a protocol message');
    await waitFor(() => first.client.isClosed(), { what: 'the server to close the socket after a bad message' });
    expect(first.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.badMessage);
    await waitFor(async () => (await rowOf(h, name))?.viewers === 0, {
      what: 'the closed viewer to leave the session',
    });

    // the process goes on while nobody watches
    pty.emitData('printed while away\r\n');
    const second = await h.ws(name);
    expect(second.ready).toMatchObject({ type: 'ready', viewers: 1 });
    expect(second.replay.toString('utf8')).toBe('first screen\r\nprinted while away\r\n');
    expect(second.ready.replayBytes).toBe(second.replay.length);
    pty.emitData('and live again');
    await second.client.until('and live again');
    // the new view is a whole one: its input reaches the terminal
    second.client.sendBinary(Buffer.from('typed after the reconnect\r'));
    await waitFor(() => pty.writtenText === 'typed after the reconnect\r', { what: 'the input of the new socket' });

    // another close by the server (a text frame over the limit), another reconnect: the replay is complete every time
    second.client.sendText(' '.repeat(TERMINAL_TEXT_FRAME_MAX_BYTES + 1));
    await waitFor(() => second.client.isClosed(), { what: 'the server to close the socket after an oversize frame' });
    expect(second.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.tooBig);
    const third = await h.ws(name);
    expect(third.replay.toString('utf8')).toBe('first screen\r\nprinted while away\r\nand live again');
    expect(third.ready.viewers).toBe(1);

    // none of this touched the process
    expect(pty.exited).toBe(false);
    expect(pty.killCalls).toBe(0);
    expect(h.backend.spawns).toHaveLength(1);
  });
});
