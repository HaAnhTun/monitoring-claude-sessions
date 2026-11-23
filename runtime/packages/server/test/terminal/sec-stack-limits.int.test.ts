// The security matrix over the real stack, limits half (CAW-57, design 08 section 3.6, ids TC-SEC-27, 51 and 53): what an
// instance does under more than it should take, over the production app, HTTP server and gateway and the REAL terminal service
// (`startTerminalHarness`), with a scripted pseudo terminal.
//   - TC-SEC-27: 64 MiB of input through one socket. The path takes it with bounded memory (nothing is queued without limit
//     between the socket and the process), every byte arrives in order, and the other viewers are served while it lasts.
//   - TC-SEC-51: `terminal.maxSessions` holds against creates that race, a kill frees exactly one slot, and a start that fails
//     does not leak one.
//   - TC-SEC-53: 500 handshakes without a credential leave nothing behind (memory, viewers, places of the viewer cap), and a
//     connection that sends half a request and stops is closed by the server.
// The byte sizes of the wire come from the shared constants and the caps from the limits of the gateway; the memory bounds are
// named below, with the reason why they are on held memory and not on the resident size (`collectGarbage`).
//
// The flood runs with the interval timers of the process frozen (`setInterval` only): a scripted pid names no process, so the
// liveness watchdog of the service would end the flooded session after about 10 s of real time (see the harness), and on a busy
// machine a flood may take that long. Nothing else is faked: sockets, timeouts and the clock of the event loop are real.
import { connect, type Socket } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { FakePty } from '@mcs/engine/testing';
import {
  CreateSessionResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TERMINAL_INPUT_MAX_BYTES,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
} from '@mcs/shared';
import { RawWsClient, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_SOCKET_LIMITS } from '../../src/terminal/gateway.ts';
import { pageOrigin } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(async () => {
  try {
    await closeTerminalHarnesses();
  } finally {
    vi.useRealTimers();
  }
});

const MIB = 1024 * 1024;
/** TC-SEC-27: the size of the flood. */
const FLOOD_BYTES = 64 * MIB;
/** TC-SEC-27: the most memory the process may hold after any part of the flood: an eighth of what holding the flood would cost. */
const FLOOD_HELD_GROWTH_MAX = 8 * MIB;
/** TC-SEC-53: the number of handshakes without a credential (design 08). */
const UNAUTHENTICATED_HANDSHAKES = 500;
/** TC-SEC-53: the most memory 500 handshakes may leave held ("no object kept"): a fifth of the 20 MiB the design allows. */
const HANDSHAKES_HELD_GROWTH_MAX = 4 * MIB;

/**
 * A full garbage collection on demand, without a flag on the command line of the test run.
 *
 * The memory bounds of this file are on what the process still HOLDS after a collection, not on its resident size (the design
 * names the resident size: 20 MiB over the handshakes). The client of these tests lives in the same process as the server, and
 * the resident size follows the garbage of both: over 500 refused handshakes it was measured to move by 25 to 45 MiB with
 * nothing kept, and it does not reliably come back after a collection. What is held after a collection is the number that an
 * unbounded queue or an object kept per connection moves, and it is stricter than the bound of the design.
 */
const collectGarbage: () => void = (() => {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('sec-stack-limits: the garbage collector cannot be called');
  return () => {
    Reflect.apply(gc, undefined, []);
  };
})();

/** The bytes the process holds after a collection: the JavaScript heap and the buffers outside it. */
function heldBytes(): number {
  collectGarbage();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

/** The TCP sockets this process has open (the clients of the test and the server side of each connection). */
function openSockets(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'TCPSocketWrap').length;
}

/** A well-formed credential that no access service issued. */
const NEVER_ISSUED = Buffer.alloc(32, 9).toString('base64url');

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

type Reply = Awaited<ReturnType<TerminalHarness['http']>>;

function create(h: TerminalHarness): Promise<Reply> {
  return h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
}

async function createSession(h: TerminalHarness): Promise<{ name: string; pty: FakePty }> {
  const made = await create(h);
  expect(made.status, made.body).toBe(200);
  const { name } = CreateSessionResponseSchema.parse(made.json).session;
  const pty = h.backend.last;
  if (pty === undefined) throw new Error('the create route answered a session and nothing was spawned');
  return { name, pty };
}

const socketPath = (name: string): string => buildPath(routes.terminalSocket, { name });
const killPath = (name: string): string => buildPath(routes.terminalKillSession, { name });

async function viewersOf(h: TerminalHarness, name: string): Promise<number | undefined> {
  const state = await h.http('GET', routes.terminalState.path);
  return TerminalStateSchema.parse(state.json).sessions.find((session) => session.name === name)?.viewers;
}

describe('an input flood', () => {
  it('TC-SEC-27: 64 MiB of input reach the process in order with bounded memory, and the other viewers are served meanwhile', async () => {
    // see the file header: only the interval timers are frozen, for the watchdog of the scripted pid
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await startTerminalHarness();
    const flooded = await createSession(h);
    const quiet = await createSession(h);
    const sender = await h.ws(flooded.name);
    const watcher = await h.ws(flooded.name);
    const bystander = await h.ws(quiet.name);

    // frames of the largest size the path takes, a window of them in flight at a time
    const frameBytes = TERMINAL_INPUT_MAX_BYTES;
    const windowFrames = 16;
    const windows = FLOOD_BYTES / (frameBytes * windowFrames);
    expect(Number.isInteger(windows)).toBe(true);
    const frame = Buffer.alloc(frameBytes, 0x61);
    let sent = 0;
    let received = 0;

    /** One window: the frames go out at once, the process prints, and everything is waited for before the next one. */
    const runWindow = async (index: number): Promise<void> => {
      for (let i = 0; i < windowFrames; i += 1) {
        // the number of the frame at both ends: a frame that is lost, doubled, cut or out of order is seen
        frame.writeUInt32BE(sent, 0);
        frame.writeUInt32BE(sent, frameBytes - 4);
        sender.client.sendBinary(frame);
        sent += 1;
      }
      flooded.pty.emitData(`tick-${String(index)};`);
      quiet.pty.emitData(`tock-${String(index)};`);
      await waitFor(() => flooded.pty.written.length >= windowFrames, {
        what: `window ${String(index)} of the flood to reach the process`,
        timeoutMs: 30_000,
        intervalMs: 5,
      });
      expect(flooded.pty.written.length).toBe(windowFrames);
      for (const chunk of flooded.pty.written) {
        expect(chunk.length).toBe(frameBytes);
        expect(chunk.readUInt32BE(0)).toBe(received);
        expect(chunk.readUInt32BE(frameBytes - 4)).toBe(received);
        received += 1;
      }
      // the scripted terminal keeps what it is written; a real one consumes it
      flooded.pty.written.length = 0;
      // served during the flood, not after it: the viewers of both sessions have the output of this window
      await watcher.client.until(`tick-${String(index)};`);
      await bystander.client.until(`tock-${String(index)};`);
    };

    // one window to warm the path up (buffers, compiled code), then the measured flood
    await runWindow(0);
    const baseline = heldBytes();
    let peak = baseline;
    for (let index = 1; index <= windows; index += 1) {
      await runWindow(index);
      peak = Math.max(peak, heldBytes());
    }

    expect(received).toBe(sent);
    expect((received - windowFrames) * frameBytes).toBe(FLOOD_BYTES);
    // after no window does the path hold more than before the flood: nothing queues up between the socket and the process
    expect(peak - baseline).toBeLessThan(FLOOD_HELD_GROWTH_MAX);
    // the flood closed nobody, and reached only its own session
    for (const { client } of [sender, watcher, bystander]) expect(client.closeInfo()).toBeNull();
    expect(quiet.pty.written).toEqual([]);
    expect(flooded.pty.killCalls).toBe(0);
    // the sender is still a whole viewer: one more keystroke arrives
    sender.client.sendBinary(Buffer.from('\r'));
    await waitFor(() => flooded.pty.writtenText === '\r', { what: 'a keystroke after the flood' });
  }, 120_000);
});

describe('the session cap under pressure', () => {
  it('TC-SEC-51: creates that race never overshoot terminal.maxSessions; a kill frees exactly one slot and a failed start leaks none', async () => {
    const MAX = 4;
    const h = await startTerminalHarness({ terminal: { maxSessions: MAX } });
    const race = async (count: number): Promise<{ ok: Reply[]; refused: Reply[] }> => {
      const replies = await Promise.all(Array.from({ length: count }, () => create(h)));
      return {
        ok: replies.filter((reply) => reply.status === 200),
        refused: replies.filter((reply) => reply.status !== 200),
      };
    };

    const first = await race(3 * MAX);
    expect(first.ok).toHaveLength(MAX);
    expect(first.refused).toHaveLength(2 * MAX);
    for (const reply of first.refused) {
      expect(reply.status).toBe(ERROR_HTTP_STATUS.terminal_limit);
      expect(codeOf(reply)).toBe('terminal_limit');
    }
    const names = first.ok.map((reply) => CreateSessionResponseSchema.parse(reply.json).session.name);
    expect(new Set(names).size).toBe(MAX);
    // a refused create started nothing
    expect(h.backend.spawns).toHaveLength(MAX);
    expect(h.ports.census.count()).toBe(MAX);

    // a kill frees one slot, not more: of three creates that race for it one wins
    expect((await h.http('POST', killPath(names[0] ?? ''))).status).toBe(200);
    const second = await race(3);
    expect(second.ok).toHaveLength(1);
    expect(second.refused.map(codeOf)).toEqual(['terminal_limit', 'terminal_limit']);
    expect(h.backend.spawns).toHaveLength(MAX + 1);

    // a start that fails gives its slot back
    expect((await h.http('POST', killPath(names[1] ?? ''))).status).toBe(200);
    h.backend.spawnError = new Error('FIXTURE: the scripted backend refuses to spawn');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await create(h);
      expect(failed.status).toBe(ERROR_HTTP_STATUS.terminal_unavailable);
      expect(codeOf(failed)).toBe('terminal_unavailable');
      // the text of a spawn error may hold a path: it never reaches the answer
      expect(failed.body).not.toContain('FIXTURE');
    }
    h.backend.spawnError = null;
    expect(h.ports.census.count()).toBe(MAX - 1);
    expect((await create(h)).status).toBe(200);
    expect(codeOf(await create(h))).toBe('terminal_limit');
    // a folder that is refused takes no slot either
    expect((await h.http('POST', killPath(names[2] ?? ''))).status).toBe(200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invalid = await h.http('POST', routes.terminalCreateSession.path, { body: { path: `${h.work}-missing` } });
      expect(codeOf(invalid)).toBe('folder_invalid');
    }
    expect((await create(h)).status).toBe(200);
    expect(h.ports.census.count()).toBe(MAX);
    expect(TerminalStateSchema.parse((await h.http('GET', routes.terminalState.path)).json).sessions).toHaveLength(MAX);
  });
});

describe('handshakes without a credential', () => {
  it('TC-SEC-53: 500 unauthenticated handshakes leave no memory, viewer or taken place behind', async () => {
    const h = await startTerminalHarness();
    const { name, pty } = await createSession(h);
    const cookieName = h.cookie.slice(0, h.cookie.indexOf('='));
    const cookies = [undefined, `${cookieName}=not a credential`, `${cookieName}=${NEVER_ISSUED}`];
    const attempt = async (index: number): Promise<void> => {
      const cookie = cookies[index % cookies.length];
      const client = await RawWsClient.connect(h.port, {
        path: socketPath(name),
        origin: pageOrigin(h.port),
        ...(cookie === undefined ? {} : { cookie }),
      });
      expect(client.status).toBe(ERROR_HTTP_STATUS.access_required);
      await client.waitClosed();
    };
    const storm = async (count: number): Promise<void> => {
      const batch = 25;
      for (let done = 0; done < count; done += batch) {
        await Promise.all(Array.from({ length: Math.min(batch, count - done) }, (_unused, i) => attempt(done + i)));
      }
    };

    // A first storm of the same size brings the process to its working size: the client of this test lives in the same process
    // as the server, and the short-lived objects of 500 handshakes make the heap grow once whether anything is kept or not.
    await storm(UNAUTHENTICATED_HANDSHAKES);
    const socketsBefore = openSockets();
    const heldBefore = heldBytes();
    await storm(UNAUTHENTICATED_HANDSHAKES);

    // no object is kept per handshake: what is held after a collection did not grow (see `heldBytes` for why not the resident size)
    expect(heldBytes() - heldBefore).toBeLessThan(HANDSHAKES_HELD_GROWTH_MAX);
    // every socket of the storm is closed, on both ends
    await waitFor(() => openSockets() <= socketsBefore, { what: 'the sockets of the handshakes to be closed' });

    // nothing reached the real session
    expect(await viewersOf(h, name)).toBe(0);
    expect(pty.written).toEqual([]);
    expect(pty.killCalls).toBe(0);
    expect(h.backend.spawns).toHaveLength(1);
    // no refused handshake holds a place of the viewer cap: all of them are still free, and the next one is refused
    for (let i = 0; i < TERMINAL_SOCKET_LIMITS.maxPerSession; i += 1) {
      expect((await h.ws(name)).ready.viewers).toBe(i + 1);
    }
    const over = await RawWsClient.connect(h.port, {
      path: socketPath(name),
      cookie: h.cookie,
      origin: pageOrigin(h.port),
    });
    expect(codeOf(over)).toBe('stream_limit');
    // `close()` (afterEach) proves the rest: it throws when a socket, a timer or a listener is left
  }, 60_000);

  it('TC-SEC-53: a connection that sends half a handshake and stops is closed by the server, and takes nothing with it', async () => {
    const timing = { headersTimeoutMs: 300, checkIntervalMs: 100 };
    const h = await startTerminalHarness({ timing });
    const { name, pty } = await createSession(h);
    const HELD = 20;
    const half = [
      `GET ${socketPath(name)} HTTP/1.1`,
      `Host: 127.0.0.1:${String(h.port)}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Cookie: ${h.cookie}`,
      'Sec-WebSocket-Key: ',
    ].join('\r\n');

    const sockets: Socket[] = [];
    const closedByServer: Promise<void>[] = [];
    try {
      for (let i = 0; i < HELD; i += 1) {
        const socket = connect({ port: h.port, host: '127.0.0.1' });
        sockets.push(socket);
        socket.on('error', () => undefined);
        socket.resume();
        closedByServer.push(
          new Promise((resolve) => {
            socket.once('close', () => {
              resolve();
            });
          }),
        );
        await new Promise<void>((resolve) => {
          socket.once('connect', () => {
            socket.write(half, () => {
              resolve();
            });
          });
        });
      }
      // while they hang the instance answers, and half a handshake is not a viewer
      expect((await h.http('GET', routes.terminalState.path)).status).toBe(200);
      expect(await viewersOf(h, name)).toBe(0);

      // the client never closes: the server gives up on each of them
      let closed = 0;
      for (const done of closedByServer) void done.then(() => (closed += 1));
      await waitFor(() => closed === HELD, {
        what: 'the server to close every half-open handshake',
        timeoutMs: 20 * (timing.headersTimeoutMs + timing.checkIntervalMs),
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
    expect(await viewersOf(h, name)).toBe(0);
    expect(pty.written).toEqual([]);
    // the instance is whole: a real handshake still opens
    expect((await h.ws(name)).ready.viewers).toBe(1);
  });
});
