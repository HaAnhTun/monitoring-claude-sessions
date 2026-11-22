// FIXTURE: a canned terminal socket for the visual QA tool (CAW-49, design 05 section 7.1 and design 04 section 12.4).
// `page.routeWebSocket` answers `GET /api/v3/terminal/sessions/:name/socket` in the browser, so no server and no process is
// involved. It speaks protocol v1 as the real gateway does: `ready` with the size of the "process", the replay as binary frames,
// `live`, a `size` frame for every `resize` of the page, `exit` and the close codes 4000 (exited) and 4001 (killed). The "process"
// is a screen of `terminal-sample.ts` that is drawn again for every size the page asks for, as a full-screen program does.
//
// Every screen ends with a request for the cursor position. xterm answers it once it has parsed everything before it, so the
// fixture knows when a screen is in the terminal (`settle`), whatever renderer draws it. Typed input is echoed, which is enough
// for a spec that checks that keys reach the socket. Session names, sizes and typed text of a run stay in memory only.
import type { Page, WebSocketRoute } from '@playwright/test';

import {
  clampTerminalSize,
  routes,
  TERMINAL_CLOSE_CODES,
  TERMINAL_SIZE_LIMITS,
  TerminalClientMessageSchema,
  TerminalNameSchema,
  type TerminalServerMessage,
} from '@mcs/shared';

import {
  CLEAR_SCREEN,
  CURSOR_REPORT_REQUEST,
  sampleText,
  splitCursorReports,
  type SampleName,
  type SampleSize,
} from './terminal-sample.ts';

/** One socket the page opened, and what went over it. */
export interface TerminalConnection {
  readonly name: string;
  readonly sample: SampleName;
  /** The size the last screen was drawn for. */
  drawnFor: SampleSize;
  /** Screens sent, and cursor reports that came back: equal means the terminal has parsed the last screen. */
  draws: number;
  reports: number;
  /** Every size the page asked for, in order (clamped as the server clamps it). */
  readonly resizes: SampleSize[];
  /** What the page typed, one entry per frame, one character per byte; cursor reports are not in it. */
  readonly inputs: string[];
  /** False once either side closed the socket. */
  open: boolean;
}

export interface TerminalFixture {
  /** The screen a session shows, by session name; a name without an entry shows `session`. Set it before the page loads. */
  readonly samples: Map<string, SampleName>;
  /** Every connection, in the order the page opened them. */
  readonly connections: TerminalConnection[];
  /** Names whose process ended (`end`, `kill`): a new socket to one of them is closed as exited at once. */
  readonly ended: Set<string>;
  /** The newest connection of a session that is still open. */
  latest(name: string): TerminalConnection | null;
  /** The process exits with `exitCode`: the `exit` frame, then close code 4000. */
  end(name: string, exitCode: number): void;
  /** The session is stopped: the `exit` frame without a code, then close code 4001. */
  kill(name: string): void;
  /** The connection is lost (close code 1001): the page reconnects and gets the replay again. */
  drop(name: string): void;
  /**
   * Waits until the terminal on the page has parsed the screen drawn for the size it has now, and until that screen is painted.
   * Returns the size. Throws after `timeoutMs` with what is missing.
   */
  settle(page: Page, name: string, timeoutMs?: number): Promise<SampleSize>;
}

const [SOCKET_PREFIX = '', SOCKET_SUFFIX = ''] = routes.terminalSocket.path.split(':name');

/** The session name in the address of a terminal socket, or `null` for any other address. */
export function terminalNameOf(url: URL): string | null {
  const path = url.pathname;
  if (!path.startsWith(SOCKET_PREFIX) || !path.endsWith(SOCKET_SUFFIX)) return null;
  let name: string;
  try {
    name = decodeURIComponent(path.slice(SOCKET_PREFIX.length, path.length - SOCKET_SUFFIX.length));
  } catch {
    return null;
  }
  return TerminalNameSchema.safeParse(name).success ? name : null;
}

const frame = (message: TerminalServerMessage): string => JSON.stringify(message);

const CR = 13;
const LF = 10;

/** Typed bytes as a terminal in cooked mode shows them: a carriage return also moves to the next line. */
function echoOf(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const byte = char.charCodeAt(0);
    bytes.push(byte);
    if (byte === CR) bytes.push(LF);
  }
  return Buffer.from(bytes);
}

const FRAME_SCRIPT = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';

/**
 * Routes the terminal sockets of `page` to the canned program. Call it before the page loads. The route lives as long as the
 * page; nothing has to be closed.
 */
export async function routeTerminalSocket(page: Page): Promise<TerminalFixture> {
  const routesByConnection = new Map<TerminalConnection, WebSocketRoute>();

  const fixture: TerminalFixture = {
    samples: new Map(),
    connections: [],
    ended: new Set(),
    latest(name) {
      for (let at = fixture.connections.length - 1; at >= 0; at -= 1) {
        const connection = fixture.connections[at];
        if (connection?.name === name && connection.open) return connection;
      }
      return null;
    },
    end(name, exitCode) {
      fixture.ended.add(name);
      finish(name, { type: 'exit', code: exitCode, signal: null }, TERMINAL_CLOSE_CODES.exited, 'exited');
    },
    kill(name) {
      fixture.ended.add(name);
      finish(name, { type: 'exit', code: null, signal: null }, TERMINAL_CLOSE_CODES.killed, 'killed');
    },
    drop(name) {
      finish(name, null, TERMINAL_CLOSE_CODES.shuttingDown, 'shutting_down');
    },
    async settle(target, name, timeoutMs = 20_000) {
      const host = target.locator('[data-terminal][data-cols][data-rows]').first();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let missing: string;
        const connection = fixture.latest(name);
        const cols = Number(await host.getAttribute('data-cols').catch(() => null));
        const rows = Number(await host.getAttribute('data-rows').catch(() => null));
        if (connection === null) missing = `no open socket for ${name}`;
        else if (!(cols > 0 && rows > 0)) missing = 'the page shows no terminal';
        else if (connection.drawnFor.cols !== cols || connection.drawnFor.rows !== rows) {
          missing = `the terminal is ${String(cols)}x${String(rows)}, the screen was drawn for ${String(connection.drawnFor.cols)}x${String(connection.drawnFor.rows)}`;
        } else if (connection.reports < connection.draws) {
          missing = `${String(connection.draws - connection.reports)} screen(s) not parsed yet`;
        } else {
          const { draws } = connection;
          await target.evaluate(FRAME_SCRIPT);
          // a fit that ran meanwhile asked for another screen: wait for that one
          if (connection.open && connection.draws === draws) return { cols, rows };
          missing = 'the terminal was resized while it was painted';
        }
        if (Date.now() > deadline) throw new Error(`terminal ${name} did not settle: ${missing}`);
        // paced by the frames of the page: the next look is after the page had a chance to draw, with no fixed wait
        await target.evaluate(FRAME_SCRIPT);
      }
    },
  };

  /** Sends a screen for `size` and asks for the cursor position after it. */
  function draw(ws: WebSocketRoute, connection: TerminalConnection, size: SampleSize, clear: boolean): number {
    const text = `${clear ? CLEAR_SCREEN : ''}${sampleText(connection.sample, size)}${CURSOR_REPORT_REQUEST}`;
    const bytes = Buffer.from(text, 'utf8');
    connection.drawnFor = size;
    connection.draws += 1;
    ws.send(bytes);
    return bytes.length;
  }

  /** The first screen of a connection: `ready` says how long the replay is before the replay itself goes out. */
  function replay(ws: WebSocketRoute, connection: TerminalConnection, size: SampleSize): void {
    const text = `${sampleText(connection.sample, size)}${CURSOR_REPORT_REQUEST}`;
    const replayBytes = Buffer.byteLength(text, 'utf8');
    ws.send(frame({ type: 'ready', v: 1, cols: size.cols, rows: size.rows, replayBytes, viewers: 1 }));
    const sent = draw(ws, connection, size, false);
    if (sent !== replayBytes) throw new Error('the replay is not as long as the ready frame said');
    ws.send(frame({ type: 'live' }));
  }

  function finish(
    name: string,
    last: Extract<TerminalServerMessage, { type: 'exit' }> | null,
    code: number,
    reason: string,
  ): void {
    for (const [connection, ws] of routesByConnection) {
      if (connection.name !== name || !connection.open) continue;
      connection.open = false;
      if (last !== null) ws.send(frame(last));
      void ws.close({ code, reason });
    }
  }

  function accept(ws: WebSocketRoute): void {
    const name = terminalNameOf(new URL(ws.url()));
    if (name === null) {
      void ws.close({ code: TERMINAL_CLOSE_CODES.badMessage, reason: 'bad_message' });
      return;
    }
    if (fixture.ended.has(name)) {
      ws.send(frame({ type: 'exit', code: null, signal: null }));
      void ws.close({ code: TERMINAL_CLOSE_CODES.exited, reason: 'exited' });
      return;
    }
    const size: SampleSize = { cols: TERMINAL_SIZE_LIMITS.defaultCols, rows: TERMINAL_SIZE_LIMITS.defaultRows };
    const connection: TerminalConnection = {
      name,
      sample: fixture.samples.get(name) ?? 'session',
      drawnFor: size,
      draws: 0,
      reports: 0,
      resizes: [],
      inputs: [],
      open: true,
    };
    fixture.connections.push(connection);
    routesByConnection.set(connection, ws);

    replay(ws, connection, size);

    ws.onMessage((message) => {
      if (!connection.open) return;
      if (typeof message === 'string') {
        let value: unknown;
        try {
          value = JSON.parse(message);
        } catch {
          value = null;
        }
        const parsed = TerminalClientMessageSchema.safeParse(value);
        if (!parsed.success) {
          connection.open = false;
          void ws.close({ code: TERMINAL_CLOSE_CODES.badMessage, reason: 'bad_message' });
          return;
        }
        const next = clampTerminalSize(parsed.data.cols, parsed.data.rows);
        connection.resizes.push(next);
        ws.send(frame({ type: 'size', cols: next.cols, rows: next.rows }));
        draw(ws, connection, next, true);
        return;
      }
      const { reports, rest } = splitCursorReports(message.toString('latin1'));
      connection.reports += reports;
      if (rest === '') return;
      connection.inputs.push(rest);
      ws.send(echoOf(rest));
    });
    ws.onClose(() => {
      connection.open = false;
    });
  }

  await page.routeWebSocket((url) => terminalNameOf(url) !== null, accept);
  return fixture;
}
