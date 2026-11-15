import { TERMINAL_CLOSE_CODES, type TerminalServerMessage } from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeWebSockets,
  FAKE_WS_CLOSING,
  stubFakeWebSocketGlobal,
  type FakeWebSocket,
  type FakeWebSockets,
} from '../test/fake-websocket.ts';
import { MAX_INPUT_FRAME_BYTES, type VisibilityLike } from './protocol.ts';
import {
  createTerminalSocket,
  type SocketSnapshot,
  type TerminalSocket,
  type TerminalSocketOptions,
} from './ws-client.ts';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const URL_OF_SESSION = 'ws://127.0.0.1:7690/api/v3/terminal/sessions/fixture-term-1/socket';

const READY = { type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 3, viewers: 1 } as const;

class FakeVisibility extends EventTarget implements VisibilityLike {
  visibilityState = 'visible';
  setState(next: 'visible' | 'hidden'): void {
    this.visibilityState = next;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** What the client handed to its owner, in the order it happened (the replay order is the contract). */
type Seen = { kind: 'data'; bytes: number[] } | { kind: 'control'; frame: TerminalServerMessage };

interface Harness {
  sockets: FakeWebSockets;
  client: TerminalSocket;
  seen: Seen[];
  statuses: SocketSnapshot[];
  visibility: FakeVisibility;
  win: EventTarget;
}

function setup(over: Partial<TerminalSocketOptions> = {}): Harness {
  const sockets = createFakeWebSockets();
  const seen: Seen[] = [];
  const statuses: SocketSnapshot[] = [];
  const visibility = new FakeVisibility();
  const win = new EventTarget();
  const client = createTerminalSocket({
    url: URL_OF_SESSION,
    factory: sockets.factory,
    visibility,
    windowTarget: win,
    onData: (bytes) => seen.push({ kind: 'data', bytes: [...bytes] }),
    onControl: (frame) => seen.push({ kind: 'control', frame }),
    onStatus: (snapshot) => statuses.push(snapshot),
    ...over,
  });
  return { sockets, client, seen, statuses, visibility, win };
}

/** start and the browser's open event. */
function openSocket(h: Harness): FakeWebSocket {
  h.client.start();
  const socket = h.sockets.last();
  socket.open();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state table: idle and connecting', () => {
  it('start() opens one socket with the subprotocol and asks for ArrayBuffer frames', () => {
    const h = setup();
    expect(h.client.snapshot().status).toBe('idle');
    h.client.start();
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.sockets.urls()).toEqual([URL_OF_SESSION]);
    expect(h.sockets.last().protocols).toEqual(['caw.terminal.v1']);
    expect(h.sockets.last().binaryType).toBe('arraybuffer');
    h.client.stop();
  });

  it('passes protocols given by the caller instead of the default', () => {
    const h = setup({ protocols: ['x.test.v9'] });
    h.client.start();
    expect(h.sockets.last().protocols).toEqual(['x.test.v9']);
    h.client.stop();
  });

  it('start() twice does not open a second socket', () => {
    const h = setup();
    h.client.start();
    h.client.start();
    expect(h.sockets.instances).toHaveLength(1);
    h.client.stop();
  });

  it('uses the global WebSocket by default, with the subprotocol and ArrayBuffer frames', () => {
    const globals = stubFakeWebSocketGlobal();
    const client = createTerminalSocket({
      url: URL_OF_SESSION,
      visibility: null,
      windowTarget: null,
      onData: () => undefined,
      onControl: () => undefined,
    });
    client.start();
    expect(globals.urls()).toEqual([URL_OF_SESSION]);
    expect(globals.last().protocols).toEqual(['caw.terminal.v1']);
    expect(globals.last().binaryType).toBe('arraybuffer');
    client.stop();
  });

  it('ends without a retry loop when the socket cannot even be constructed', () => {
    const h = setup({
      factory: () => {
        throw new SyntaxError('bad url');
      },
    });
    h.client.start();
    expect(h.client.snapshot().status).toBe('ended');
    expect(h.client.snapshot().failed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TC-UI-06: open, binary output and control frames in order', () => {
  it('goes open on the browser open event and reports it', () => {
    const h = setup();
    openSocket(h);
    const snapshot = h.client.snapshot();
    expect(snapshot.status).toBe('open');
    expect(snapshot.everOpened).toBe(true);
    expect(snapshot.refusals).toBe(0);
    expect(h.statuses.map((s) => s.status)).toEqual(['connecting', 'open']);
    h.client.stop();
  });

  it('hands binary frames to onData as exact bytes (including 0x00 and 0xff)', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message(Uint8Array.of(0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a));
    expect(h.seen).toEqual([{ kind: 'data', bytes: [0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a] }]);
    h.client.stop();
  });

  it('delivers ready, the replay, live and the live output in the order the server sent them', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message(READY);
    socket.message(Uint8Array.of(1));
    socket.message(Uint8Array.of(2, 3));
    socket.message({ type: 'live' });
    socket.message(Uint8Array.of(4));
    socket.message({ type: 'size', cols: 100, rows: 40 });
    expect(h.seen).toEqual([
      { kind: 'control', frame: READY },
      { kind: 'data', bytes: [1] },
      { kind: 'data', bytes: [2, 3] },
      { kind: 'control', frame: { type: 'live' } },
      { kind: 'data', bytes: [4] },
      { kind: 'control', frame: { type: 'size', cols: 100, rows: 40 } },
    ]);
    h.client.stop();
  });

  it('counts an invalid text frame and ignores it: it never reaches the terminal or the owner', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message('plain text that a terminal would print');
    socket.message('{"type":"unknown"}');
    socket.message('{"type":"live","extra":1}');
    socket.message(`{"type":"live"${' '.repeat(2000)}}`);
    expect(h.seen).toEqual([]);
    expect(h.client.snapshot().invalidFrames).toBe(4);
    socket.message({ type: 'live' });
    expect(h.seen).toEqual([{ kind: 'control', frame: { type: 'live' } }]);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });

  it('records the exit frame in the snapshot and passes it on', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message({ type: 'exit', code: 3, signal: null });
    expect(h.client.snapshot().exit).toEqual({ code: 3, signal: null });
    expect(h.seen).toEqual([{ kind: 'control', frame: { type: 'exit', code: 3, signal: null } }]);
    h.client.stop();
  });

  it('does not deliver a frame of a socket it no longer owns', () => {
    const h = setup();
    const socket = openSocket(h);
    h.client.stop();
    socket.message(Uint8Array.of(9), { force: true });
    socket.message({ type: 'live' }, { force: true });
    expect(h.seen).toEqual([]);
  });
});

describe('TC-UI-06: close codes', () => {
  it.each([
    [TERMINAL_CLOSE_CODES.exited, 'ended'],
    [TERMINAL_CLOSE_CODES.killed, 'ended'],
    [TERMINAL_CLOSE_CODES.normal, 'ended'],
  ] as const)('code %i ends the view and never reconnects', (code, status) => {
    const h = setup();
    const socket = openSocket(h);
    socket.closeFromServer(code);
    expect(h.client.snapshot().status).toBe(status);
    expect(h.client.snapshot().failed).toBe(false);
    expect(h.client.snapshot().lastCloseCode).toBe(code);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.sockets.instances).toHaveLength(1);
  });

  it('4003 shows the locked state and never reconnects', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.closeFromServer(TERMINAL_CLOSE_CODES.signedOut);
    expect(h.client.snapshot().status).toBe('locked');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.sockets.instances).toHaveLength(1);
  });

  it.each([TERMINAL_CLOSE_CODES.protocolError, TERMINAL_CLOSE_CODES.badMessage, TERMINAL_CLOSE_CODES.tooBig, 1007])(
    'code %i is our own bug: the view ends as failed, with Retry, and does not loop',
    (code) => {
      const h = setup();
      const socket = openSocket(h);
      socket.closeFromServer(code);
      expect(h.client.snapshot().status).toBe('ended');
      expect(h.client.snapshot().failed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(h.sockets.instances).toHaveLength(1);
    },
  );

  it.each([
    TERMINAL_CLOSE_CODES.shuttingDown,
    1006,
    TERMINAL_CLOSE_CODES.slowConsumer,
    TERMINAL_CLOSE_CODES.internalError,
    4999,
    1005,
  ])('code %i reconnects with backoff', (code) => {
    const h = setup();
    const socket = openSocket(h);
    socket.closeFromServer(code);
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.client.snapshot().failed).toBe(false);
    h.client.stop();
  });

  it('ends instead of reconnecting when the connection drops after the exit frame (the process is gone)', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message({ type: 'exit', code: 0, signal: null });
    socket.closeFromServer(1006);
    expect(h.client.snapshot().status).toBe('ended');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still shows the locked state when the credential ends after the exit frame', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.message({ type: 'exit', code: 0, signal: null });
    socket.closeFromServer(TERMINAL_CLOSE_CODES.signedOut);
    expect(h.client.snapshot().status).toBe('locked');
  });
});

describe('TC-UI-06: reconnect delays 0, 1, 2, 4, 8, 15 s', () => {
  /** The server refuses the handshake: the browser reports a close with 1006 and never an open. */
  function refuse(h: Harness): void {
    h.sockets.last().closeFromServer(1006);
  }

  it('waits 0, 1, 2, 4, 8, 15 and then 15 s again while the handshake keeps failing', () => {
    const h = setup();
    h.client.start();
    const delays = [0, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];
    for (const [index, delay] of delays.entries()) {
      refuse(h);
      const snapshot = h.client.snapshot();
      expect(snapshot.status, `after failure ${String(index + 1)}`).toBe('backoff');
      expect(snapshot.nextRetryAt, `after failure ${String(index + 1)}`).toBe(Date.now() + delay);
      expect(snapshot.attempt).toBe(index + 1);
      const before = h.sockets.instances.length;
      if (delay > 0) {
        vi.advanceTimersByTime(delay - 1);
        expect(h.sockets.instances, `${String(delay)} ms is not over yet`).toHaveLength(before);
      }
      vi.advanceTimersByTime(1);
      expect(h.sockets.instances, `after ${String(delay)} ms`).toHaveLength(before + 1);
      expect(h.client.snapshot().status).toBe('connecting');
    }
    h.client.stop();
  });

  it('reconnects at once (after a tick) the first time a working connection drops', () => {
    const h = setup();
    const socket = openSocket(h);
    vi.advanceTimersByTime(10_000);
    socket.closeFromServer(1013);
    expect(h.client.snapshot().nextRetryAt).toBe(Date.now());
    expect(h.sockets.instances).toHaveLength(1);
    vi.advanceTimersByTime(0);
    expect(h.sockets.instances).toHaveLength(2);
    h.client.stop();
  });

  it('starts the delays over after a connection that stayed open', () => {
    const h = setup();
    h.client.start();
    for (const delay of [0, 1000, 2000]) {
      refuse(h);
      vi.advanceTimersByTime(delay);
    }
    const socket = h.sockets.last();
    socket.open();
    vi.advanceTimersByTime(5000);
    socket.closeFromServer(1006);
    expect(h.client.snapshot().nextRetryAt).toBe(Date.now());
    expect(h.client.snapshot().attempt).toBe(1);
    h.client.stop();
  });

  it('keeps backing off when the server accepts and drops at once (no tight loop)', () => {
    const h = setup();
    h.client.start();
    const delays = [0, 1000, 2000, 4000];
    for (const [index, delay] of delays.entries()) {
      const socket = h.sockets.last();
      socket.open();
      socket.closeFromServer(TERMINAL_CLOSE_CODES.slowConsumer);
      expect(h.client.snapshot().nextRetryAt, `drop ${String(index + 1)}`).toBe(Date.now() + delay);
      vi.advanceTimersByTime(delay);
    }
    expect(h.sockets.instances).toHaveLength(delays.length + 1);
    h.client.stop();
  });

  it('keeps attempts and timers of the old connection out of the new one (one timer while waiting)', () => {
    const h = setup();
    h.client.start();
    refuse(h);
    vi.advanceTimersByTime(0);
    refuse(h);
    expect(vi.getTimerCount()).toBe(1);
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TC-UI-06: refusal counting', () => {
  it('counts closes that came before any open, in a row', () => {
    const h = setup();
    h.client.start();
    for (const expected of [1, 2, 3]) {
      h.sockets.last().closeFromServer(1006);
      expect(h.client.snapshot().refusals).toBe(expected);
      expect(h.client.snapshot().everOpened).toBe(false);
      vi.advanceTimersByTime(20_000);
    }
    h.client.stop();
  });

  it('resets the count on open, and a close after an open is not a refusal', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    expect(h.client.snapshot().refusals).toBe(1);
    h.sockets.last().open();
    expect(h.client.snapshot().refusals).toBe(0);
    expect(h.client.snapshot().everOpened).toBe(true);
    h.sockets.last().closeFromServer(1006);
    expect(h.client.snapshot().refusals).toBe(0);
    expect(h.client.snapshot().everOpened).toBe(true);
    h.client.stop();
  });

  it('does not decide anything on its own: it keeps backing off (the oracle belongs to the owner)', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    h.sockets.last().closeFromServer(1006);
    expect(h.client.snapshot().refusals).toBe(2);
    expect(h.client.snapshot().status).toBe('backoff');
    h.client.stop();
  });
});

describe('retryNow, visibility and online', () => {
  it('retryNow skips the wait of a backoff and keeps the attempt count', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    h.sockets.last().closeFromServer(1006);
    expect(h.client.snapshot().nextRetryAt).toBe(Date.now() + 1000);
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(3);
    expect(h.client.snapshot().status).toBe('connecting');
    expect(vi.getTimerCount()).toBe(0);
    h.client.stop();
  });

  it('retryNow does nothing while connecting, open, ended, locked or stopped', () => {
    const h = setup();
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(0);
    h.client.start();
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(1);
    h.sockets.last().open();
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(1);
    h.sockets.last().closeFromServer(4000);
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(1);
    h.client.stop();
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(1);
  });

  it('retryNow after a failed ending (our bug) starts a fresh connection, which is the Retry button', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.closeFromServer(TERMINAL_CLOSE_CODES.badMessage);
    expect(h.client.snapshot().failed).toBe(true);
    h.client.retryNow();
    expect(h.sockets.instances).toHaveLength(2);
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.client.snapshot().failed).toBe(false);
    expect(h.client.snapshot().attempt).toBe(0);
    h.client.stop();
  });

  it('reconnects at once when the tab becomes visible during a backoff, not when it becomes hidden', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    h.sockets.last().closeFromServer(1006);
    h.visibility.setState('hidden');
    expect(h.sockets.instances).toHaveLength(2);
    h.visibility.setState('visible');
    expect(h.sockets.instances).toHaveLength(3);
    h.client.stop();
  });

  it('reconnects at once on the online event during a backoff', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    h.sockets.last().closeFromServer(1006);
    h.win.dispatchEvent(new Event('online'));
    expect(h.sockets.instances).toHaveLength(3);
    h.client.stop();
  });

  it('ignores visibility and online while open or connecting', () => {
    const h = setup();
    openSocket(h);
    h.visibility.setState('hidden');
    h.visibility.setState('visible');
    h.win.dispatchEvent(new Event('online'));
    expect(h.sockets.instances).toHaveLength(1);
    h.client.stop();
  });

  it('does not reconnect on visibility or online after stop()', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    h.client.stop();
    h.visibility.setState('hidden');
    h.visibility.setState('visible');
    h.win.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60_000);
    expect(h.sockets.instances).toHaveLength(1);
  });
});

describe('stop', () => {
  it('closes the socket with 1000, clears the timers and reports stopped', () => {
    const h = setup();
    const socket = openSocket(h);
    h.client.stop();
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(1000);
    expect(h.client.snapshot().status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is idempotent: a second stop() changes nothing and closes nothing again', () => {
    const h = setup();
    const socket = openSocket(h);
    h.client.stop();
    const published = h.statuses.length;
    h.client.stop();
    expect(socket.closeCalls).toHaveLength(1);
    expect(h.statuses).toHaveLength(published);
  });

  it('may be called before start() and while waiting to reconnect', () => {
    const h = setup();
    h.client.stop();
    expect(h.client.snapshot().status).toBe('stopped');
    const second = setup();
    second.client.start();
    second.sockets.last().closeFromServer(1006);
    second.client.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(second.sockets.instances).toHaveLength(1);
  });

  it('ignores the close event of a socket it already stopped', () => {
    const h = setup();
    const socket = openSocket(h);
    h.client.stop();
    socket.closeFromServer(1006, '', { force: true });
    expect(h.client.snapshot().status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
    expect(h.client.snapshot().lastCloseCode).toBeNull();
  });

  it('survives StrictMode: start, stop, start opens a new socket and only the new one is heard', () => {
    const h = setup();
    h.client.start();
    const first = h.sockets.last();
    h.client.stop();
    h.client.start();
    const second = h.sockets.last();
    expect(second).not.toBe(first);
    expect(first.closeCalls).toHaveLength(1);
    first.open();
    first.message(Uint8Array.of(1), { force: true });
    second.open();
    second.message(Uint8Array.of(2));
    expect(h.seen).toEqual([{ kind: 'data', bytes: [2] }]);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });

  it('can start again after an end (a new view of the same name)', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.closeFromServer(4000);
    h.client.start();
    expect(h.sockets.instances).toHaveLength(2);
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.client.snapshot().exit).toBeNull();
    h.client.stop();
  });
});

describe('TC-UI-06: input gating', () => {
  it('sends nothing and says so while there is no open socket', () => {
    const h = setup();
    expect(h.client.sendInput('x')).toBe(false);
    h.client.start();
    expect(h.client.sendInput('x')).toBe(false);
    expect(h.client.sendBinary(Uint8Array.of(1))).toBe(false);
    expect(h.client.sendResize(80, 24)).toBe(false);
    h.sockets.last().closeFromServer(1006);
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.client.sendInput('x')).toBe(false);
    h.client.stop();
    expect(h.client.sendInput('x')).toBe(false);
    expect(h.sockets.instances.flatMap((socket) => socket.sent)).toEqual([]);
  });

  it('sends the typed text as binary frames once open', () => {
    const h = setup();
    const socket = openSocket(h);
    expect(h.client.sendInput('ls\r')).toBe(true);
    expect(socket.sentBinary).toEqual([new TextEncoder().encode('ls\r')]);
    expect(socket.sentText).toEqual([]);
    h.client.stop();
  });

  it('sends 0x03 for Ctrl+C unchanged', () => {
    const h = setup();
    const socket = openSocket(h);
    h.client.sendInput('\x03');
    expect(socket.sentBinary).toEqual([Uint8Array.of(0x03)]);
    h.client.stop();
  });

  it('returns true and sends nothing for an empty string', () => {
    const h = setup();
    const socket = openSocket(h);
    expect(h.client.sendInput('')).toBe(true);
    expect(socket.sent).toEqual([]);
    h.client.stop();
  });

  it('splits a large paste into frames of at most 16 KiB, in order, at code point boundaries', () => {
    const h = setup();
    const socket = openSocket(h);
    const text = `${'x'.repeat(MAX_INPUT_FRAME_BYTES - 1)}\u20ac${'\u{1f600}'.repeat(10_000)}`;
    expect(h.client.sendInput(text)).toBe(true);
    const frames = socket.sentBinary;
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(MAX_INPUT_FRAME_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    expect(frames.map((frame) => decoder.decode(frame)).join('')).toBe(text);
    h.client.stop();
  });

  it('splits raw binary input (mouse reports) at the same limit', () => {
    const h = setup();
    const socket = openSocket(h);
    expect(h.client.sendBinary(new Uint8Array(MAX_INPUT_FRAME_BYTES + 5))).toBe(true);
    expect(socket.sentBinary.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES, 5]);
    expect(h.client.sendBinary(new Uint8Array(0))).toBe(true);
    expect(socket.sentBinary).toHaveLength(2);
    h.client.stop();
  });

  it('refuses to send while the browser is closing the socket, even if the close event did not arrive yet', () => {
    const h = setup();
    const socket = openSocket(h);
    socket.readyState = FAKE_WS_CLOSING;
    expect(h.client.sendInput('x')).toBe(false);
    expect(h.client.sendResize(80, 24)).toBe(false);
    expect(socket.sent).toEqual([]);
    h.client.stop();
  });

  it('sends a resize as the one text frame, clamped', () => {
    const h = setup();
    const socket = openSocket(h);
    expect(h.client.sendResize(132, 43)).toBe(true);
    expect(h.client.sendResize(1, 9999)).toBe(true);
    expect(socket.sentText.map((text): unknown => JSON.parse(text))).toEqual([
      { type: 'resize', cols: 132, rows: 43 },
      { type: 'resize', cols: 20, rows: 200 },
    ]);
    expect(socket.sentBinary).toEqual([]);
    h.client.stop();
  });

  it('stays silent: no console output while input and output pass through', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const h = setup();
    const socket = openSocket(h);
    h.client.sendInput('secret typed text');
    socket.message(Uint8Array.of(115, 101, 99));
    socket.message('invalid frame with secret text');
    socket.closeFromServer(1006);
    h.client.stop();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('snapshot and subscribe', () => {
  it('keeps one snapshot object until something changes, then builds a new one', () => {
    const h = setup();
    const idle = h.client.snapshot();
    expect(h.client.snapshot()).toBe(idle);
    h.client.start();
    const connecting = h.client.snapshot();
    expect(connecting).not.toBe(idle);
    expect(h.client.snapshot()).toBe(connecting);
    h.client.stop();
  });

  it('notifies subscribers on each status change and stops after unsubscribe', () => {
    const h = setup();
    const calls: string[] = [];
    const unsubscribe = h.client.subscribe(() => calls.push(h.client.snapshot().status));
    h.client.start();
    h.sockets.last().open();
    unsubscribe();
    h.sockets.last().closeFromServer(4000);
    expect(calls).toEqual(['connecting', 'open']);
    expect(h.client.snapshot().status).toBe('ended');
  });

  it('carries the reconnect counter and the last close code', () => {
    const h = setup();
    h.client.start();
    h.sockets.last().closeFromServer(1006);
    vi.advanceTimersByTime(0);
    h.sockets.last().open();
    h.sockets.last().closeFromServer(1013);
    expect(h.client.snapshot().reconnects).toBe(1);
    expect(h.client.snapshot().lastCloseCode).toBe(1013);
    expect(h.client.snapshot().lastCloseAt).toBe(Date.now());
    h.client.stop();
  });
});
