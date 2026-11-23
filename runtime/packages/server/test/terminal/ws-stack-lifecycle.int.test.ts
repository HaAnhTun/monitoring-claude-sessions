// Stack variants of the socket tests, lifecycle half (CAW-57, design 08 section 3.5, ids TC-WS-05, 06, 09 and 11): how a session
// ends and what that frees, over the production app and gateway and the REAL terminal service of the engine with a scripted pseudo
// terminal (`startTerminalHarness`). The engine decides here what design 02's suite scripts: that an exit removes the session from
// the list and the event feed and frees its slot, that the kill route ends the process once and tells every viewer, that
// `terminal.maxSessions` and the viewer caps refuse before anything is started, and that a shutdown closes the viewers and ends
// every process. Close codes, reasons and caps come from the shared constants and the limits of the gateway.
//
// A scripted pid names no process, so the liveness watchdog of the service ends a session after about 10 s of real time (see the
// harness): every scenario here is far shorter.
import { request } from 'node:http';

import { FAKE_KILLED_EXIT_CODE, type FakePty } from '@mcs/engine/testing';
import {
  CreateSessionResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TERMINAL_CLOSE_CODES,
  TerminalEventSchemas,
  TerminalServerMessageSchema,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
  type TerminalServerMessage,
  type TerminalSessionsEvent,
  type TerminalState,
} from '@mcs/shared';
import {
  RawWsClient,
  assertPortClosed,
  openTerminalSocket,
  scaled,
  waitFor,
  type OpenedTerminalSocket,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { TERMINAL_CLOSE_REASONS, TERMINAL_SOCKET_LIMITS } from '../../src/terminal/gateway.ts';
import { pageOrigin } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

const feeds: Feed[] = [];

afterEach(async () => {
  for (const feed of feeds.splice(0)) feed.stop();
  await closeTerminalHarnesses();
});

const OP_TEXT = 1;
const OP_BINARY = 2;
const OP_CLOSE = 8;

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

async function createSession(h: TerminalHarness): Promise<{ name: string; pty: FakePty }> {
  const made = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
  expect(made.status, made.body).toBe(200);
  const { name } = CreateSessionResponseSchema.parse(made.json).session;
  const pty = h.backend.last;
  if (pty === undefined) throw new Error('the create route answered a session and nothing was spawned');
  return { name, pty };
}

async function stateOf(h: TerminalHarness): Promise<TerminalState> {
  return TerminalStateSchema.parse((await h.http('GET', routes.terminalState.path)).json);
}

const socketPath = (name: string): string => buildPath(routes.terminalSocket, { name });
const killPath = (name: string): string => buildPath(routes.terminalKillSession, { name });

/** A handshake on the socket route with the cookie of the harness; a refusal resolves too (`status`, `body`). */
function handshake(h: TerminalHarness, name: string): Promise<RawWsClient> {
  return RawWsClient.connect(h.port, { path: socketPath(name), cookie: h.cookie, origin: pageOrigin(h.port) });
}

/** What a viewer received after `live`, in order, up to the close frame of the server. */
async function untilClosed(client: RawWsClient): Promise<{
  readonly order: readonly ('data' | TerminalServerMessage['type'] | 'close')[];
  readonly data: Buffer;
  readonly exit: TerminalServerMessage | undefined;
  readonly close: { code: number; reason: string } | null;
}> {
  const order: ('data' | TerminalServerMessage['type'] | 'close')[] = [];
  const data: Buffer[] = [];
  let exit: TerminalServerMessage | undefined;
  for (;;) {
    const message = await client.next(scaled(5000));
    if (message.opcode === OP_BINARY) {
      order.push('data');
      data.push(message.payload);
    } else if (message.opcode === OP_TEXT) {
      const parsed = TerminalServerMessageSchema.parse(JSON.parse(message.payload.toString('utf8')));
      order.push(parsed.type);
      if (parsed.type === 'exit') exit = parsed;
    } else if (message.opcode === OP_CLOSE) {
      order.push('close');
      break;
    }
  }
  await waitFor(() => client.isClosed(), { what: 'the connection to end after the close frame' });
  return { order, data: Buffer.concat(data), exit, close: client.closeInfo() };
}

/** The session event feed of an instance as a page reads it: the `sessions` frames, newest last. */
interface Feed {
  readonly sessions: TerminalSessionsEvent[];
  ended(): boolean;
  stop(): void;
}

function openFeed(h: TerminalHarness): Promise<Feed> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: routes.terminalEvents.path,
        method: 'GET',
        agent: false,
        headers: { Host: `127.0.0.1:${String(h.port)}`, Accept: 'text/event-stream', Cookie: h.cookie },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          reject(new Error(`the event feed answered ${String(res.statusCode)}`));
          return;
        }
        let ended = false;
        let pending = '';
        const feed: Feed = {
          sessions: [],
          ended: () => ended,
          stop: () => {
            req.destroy();
          },
        };
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          pending += text;
          for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
            const lines = pending.slice(0, end).split('\n');
            pending = pending.slice(end + 2);
            const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
            if (lines.includes('event: sessions') && data !== undefined) {
              feed.sessions.push(TerminalEventSchemas.sessions.parse(JSON.parse(data)));
            }
          }
        });
        const markEnded = (): void => {
          ended = true;
        };
        res.once('close', markEnded);
        res.once('error', markEnded);
        feeds.push(feed);
        resolve(feed);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

const namesOf = (frame: TerminalSessionsEvent | undefined): string[] | undefined =>
  frame?.sessions.map((session) => session.name);

describe('the exit of the process', () => {
  it('TC-WS-05: the last output comes before the exit frame and the close 4000; the row leaves the state and the feed; the slot is free again', async () => {
    const h = await startTerminalHarness({ terminal: { maxSessions: 1 } });
    const { name, pty } = await createSession(h);
    const feed = await openFeed(h);
    await waitFor(() => namesOf(feed.sessions.at(-1))?.includes(name), { what: 'the session in the event feed' });
    // the one slot is taken
    const refused = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
    expect(codeOf(refused)).toBe('terminal_limit');

    const watchers = [await h.ws(name), await h.ws(name)];
    pty.emitData('working\r\n');
    for (const { client } of watchers) await client.until('working\r\n');
    // the last words and the end of the process in one turn: nothing is flushed in between
    pty.emitData('last words\r\n');
    pty.emitExit(0);

    for (const { client } of watchers) {
      const seen = await untilClosed(client);
      expect(seen.data.toString('utf8')).toBe('working\r\nlast words\r\n');
      // every byte of output, then the exit frame, then the close: never output after the exit
      expect(seen.order.at(-2)).toBe('exit');
      expect(seen.order.at(-1)).toBe('close');
      expect(seen.order.slice(0, -2).every((kind) => kind === 'data')).toBe(true);
      expect(seen.exit).toEqual({ type: 'exit', code: 0, signal: null });
      expect(seen.close).toEqual({ code: TERMINAL_CLOSE_CODES.exited, reason: TERMINAL_CLOSE_REASONS.exited });
    }

    // the row is gone from the state and from the feed (a new, later snapshot without it)
    expect((await stateOf(h)).sessions).toEqual([]);
    await waitFor(() => namesOf(feed.sessions.at(-1))?.length === 0, { what: 'the feed to drop the session' });
    const versions = feed.sessions.map((frame) => frame.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(h.ports.census.count()).toBe(0);

    // nothing can be written to the session that ended: no socket, no kill
    const late = await handshake(h, name);
    expect(late.status).toBe(ERROR_HTTP_STATUS.terminal_not_found);
    expect(codeOf(late)).toBe('terminal_not_found');
    const killed = await h.http('POST', killPath(name));
    expect(killed.status).toBe(ERROR_HTTP_STATUS.terminal_not_found);
    expect(codeOf(killed)).toBe('terminal_not_found');
    expect(pty.written).toEqual([]);
    expect(pty.killCalls).toBe(0);

    // the slot is reusable, and the new session is a new process with its own exit code
    const next = await createSession(h);
    expect(h.backend.spawns).toHaveLength(2);
    expect(next.pty).not.toBe(pty);
    const viewer = await h.ws(next.name);
    viewer.client.sendBinary(Buffer.from('to the new one\r'));
    await waitFor(() => next.pty.writtenText === 'to the new one\r', { what: 'the input to reach the new process' });
    expect(pty.written).toEqual([]);
    next.pty.emitExit(3);
    const second = await untilClosed(viewer.client);
    expect(second.exit).toEqual({ type: 'exit', code: 3, signal: null });
    expect(second.close?.code).toBe(TERMINAL_CLOSE_CODES.exited);
    expect((await stateOf(h)).sessions).toEqual([]);
  });
});

describe('the kill route', () => {
  it('TC-WS-06: kills the process once and closes every viewer with the exit frame and 4001; another session is untouched', async () => {
    const h = await startTerminalHarness();
    const target = await createSession(h);
    const other = await createSession(h);
    const watchers = [await h.ws(target.name), await h.ws(target.name), await h.ws(target.name)];
    const bystander = await h.ws(other.name);
    target.pty.emitData('before the kill\r\n');

    const killed = await h.http('POST', killPath(target.name));
    expect(killed.status, killed.body).toBe(200);
    expect(killed.json).toEqual({ name: target.name });
    expect(target.pty.killCalls).toBe(1);

    for (const { client } of watchers) {
      const seen = await untilClosed(client);
      // the output that was pending still arrives, before the exit
      expect(seen.data.toString('utf8')).toBe('before the kill\r\n');
      expect(seen.order.slice(-2)).toEqual(['exit', 'close']);
      expect(seen.exit).toEqual({ type: 'exit', code: FAKE_KILLED_EXIT_CODE, signal: null });
      expect(seen.close).toEqual({ code: TERMINAL_CLOSE_CODES.killed, reason: TERMINAL_CLOSE_REASONS.killed });
    }
    expect((await stateOf(h)).sessions.map((session) => session.name)).toEqual([other.name]);

    // a second kill finds nothing and kills nothing
    const again = await h.http('POST', killPath(target.name));
    expect(again.status).toBe(ERROR_HTTP_STATUS.terminal_not_found);
    expect(codeOf(again)).toBe('terminal_not_found');
    expect(target.pty.killCalls).toBe(1);

    // the other session and its viewer never noticed
    expect(other.pty.killCalls).toBe(0);
    expect(other.pty.exited).toBe(false);
    expect(bystander.client.closeInfo()).toBeNull();
    other.pty.emitData('still running');
    await bystander.client.until('still running');
  });
});

describe('the caps', () => {
  it('TC-WS-09: terminal.maxSessions refuses the next create with terminal_limit before anything is spawned; a kill and an exit each free a slot', async () => {
    const MAX = 3;
    const h = await startTerminalHarness({ terminal: { maxSessions: MAX } });
    expect((await stateOf(h)).capabilities.maxSessions).toBe(MAX);
    const sessions = [await createSession(h), await createSession(h), await createSession(h)];
    expect(new Set(sessions.map((session) => session.name)).size).toBe(MAX);

    const create = (): ReturnType<TerminalHarness['http']> =>
      h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
    const refused = await create();
    expect(refused.status).toBe(ERROR_HTTP_STATUS.terminal_limit);
    expect(codeOf(refused)).toBe('terminal_limit');
    expect(h.backend.spawns).toHaveLength(MAX);
    expect((await stateOf(h)).sessions).toHaveLength(MAX);

    // a kill frees a slot
    expect((await h.http('POST', killPath(sessions[0]?.name ?? ''))).status).toBe(200);
    expect((await create()).status).toBe(200);
    expect(codeOf(await create())).toBe('terminal_limit');
    // an exit of the process frees a slot too
    sessions[1]?.pty.emitExit(0);
    expect((await create()).status).toBe(200);
    expect(codeOf(await create())).toBe('terminal_limit');
    // five were started in all; none of the refused creates reached the backend
    expect(h.backend.spawns).toHaveLength(MAX + 2);
    expect(h.ports.census.count()).toBe(MAX);
  });

  it('TC-WS-09: the viewer caps of one session and of the instance answer 503 stream_limit before the upgrade, and a close frees a place', async () => {
    const { maxClients, maxPerSession } = TERMINAL_SOCKET_LIMITS;
    const h = await startTerminalHarness();
    const full = Math.floor(maxClients / maxPerSession);
    const sessions: { name: string; pty: FakePty }[] = [];
    for (let i = 0; i <= full; i += 1) sessions.push(await createSession(h));
    const first = sessions[0];
    const spare = sessions[full];
    if (first === undefined || spare === undefined) throw new Error('the sessions were created');

    // one session: its ninth viewer is refused, and the real session never saw it
    const viewers: OpenedTerminalSocket[] = [];
    for (let i = 0; i < maxPerSession; i += 1) viewers.push(await h.ws(first.name));
    const ninth = await handshake(h, first.name);
    expect(ninth.status).toBe(ERROR_HTTP_STATUS.stream_limit);
    expect(codeOf(ninth)).toBe('stream_limit');
    const viewersOf = async (name: string): Promise<number | undefined> =>
      (await stateOf(h)).sessions.find((session) => session.name === name)?.viewers;
    expect(await viewersOf(first.name)).toBe(maxPerSession);
    // a close frees a place of that session
    await viewers[0]?.client.close();
    await waitFor(async () => (await viewersOf(first.name)) === maxPerSession - 1, { what: 'the viewer to leave' });
    viewers[0] = await h.ws(first.name);

    // the instance: fill every other session up to the total, then one more on a session that has no viewer at all
    for (const session of sessions.slice(1, full)) {
      for (let i = 0; i < maxPerSession; i += 1) await h.ws(session.name);
    }
    const overTotal = await handshake(h, spare.name);
    expect(overTotal.status).toBe(ERROR_HTTP_STATUS.stream_limit);
    expect(codeOf(overTotal)).toBe('stream_limit');
    expect(await viewersOf(spare.name)).toBe(0);
    // a kill of a watched session closes its viewers: their places are free for the instance
    expect((await h.http('POST', killPath(first.name))).status).toBe(200);
    await waitFor(() => viewers.every(({ client }) => client.isClosed()), {
      what: 'the viewers of the killed session to be closed',
    });
    const admitted = await h.ws(spare.name);
    expect(admitted.ready.viewers).toBe(1);
    // a refusal is an answer, never a session: nothing was written or killed by any of it
    expect(spare.pty.written).toEqual([]);
    expect(spare.pty.killCalls).toBe(0);
  });
});

describe('shutdown', () => {
  it('TC-WS-11: closes every viewer with 1001 and the feed, kills every session once and leaves no port, timer or socket', async () => {
    const h = await startTerminalHarness();
    const sessions = [await createSession(h), await createSession(h)];
    // sockets of the test's own: the harness does not know them, so only the shutdown of the server can close them
    const open = (name: string): ReturnType<typeof openTerminalSocket> =>
      openTerminalSocket(h.port, name, { cookie: h.cookie, origin: pageOrigin(h.port) });
    const watchers = [
      await open(sessions[0]?.name ?? ''),
      await open(sessions[0]?.name ?? ''),
      await open(sessions[1]?.name ?? ''),
    ];
    const feed = await openFeed(h);
    for (const { pty } of sessions) pty.emitData('running\r\n');
    for (const { client } of watchers) await client.until('running\r\n');

    // `close()` runs the shutdown in the order of the real one and throws when a timer, a socket or a listener is left
    await expect(h.close()).resolves.toBeUndefined();

    for (const { client } of watchers) {
      await waitFor(() => client.isClosed(), { what: 'the shutdown to close the viewer' });
      expect(client.closeInfo()).toEqual({
        code: TERMINAL_CLOSE_CODES.shuttingDown,
        reason: TERMINAL_CLOSE_REASONS.shuttingDown,
      });
      // the viewers were closed before the processes were ended: a shutdown is not reported as an exit of the process
      const types = client.texts().map((text) => TerminalServerMessageSchema.parse(text).type);
      expect(types).not.toContain('exit');
    }
    for (const { pty } of sessions) {
      expect(pty.killCalls).toBe(1);
      expect(pty.exited).toBe(true);
    }
    await waitFor(() => feed.ended(), { what: 'the event feed to end' });
    await assertPortClosed(h.port);
  });
});
