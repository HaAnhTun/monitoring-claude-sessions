// The session event feed over real HTTP (CAW-20, design 02 6, amendment A5): a real instance and app, the real access service, the
// cookie of a page that exchanged a code, `FakeTerminalPorts` as the host. What is proved: the 401 without a cookie, the response
// head and the opening frames (TC-WS-05), a snapshot after every change with bursts coalesced, the heartbeat, the cap of eight
// streams with the 503 `stream_limit` answered before any byte, the subscription that lives only while a client is connected, the
// close on logout of that credential only, an instance without a usable host, and a log without a name or a folder.
import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';

import {
  ErrorEnvelopeSchema,
  TerminalEventSchemas,
  routes,
  type ErrorCode,
  type TerminalSessionsEvent,
} from '@mcs/shared';
import { httpRequest, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { mintAndExchange, pageOrigin, writeHeaders } from './helpers/auth.ts';
import {
  FakeTerminalPorts,
  startTerminalApp,
  stopTerminalApps,
  unavailableCapabilities,
  type TerminalApp,
} from './helpers/fake-terminal.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

// FIXTURE: invented data for tests
const SECRET_FOLDER = 'C:\\secret-folder\\project';
const SECRET_NAME = 'secret-name-1';

interface Frame {
  readonly event: string;
  readonly data: unknown;
}

/** A raw event stream client: it keeps every frame and every byte it has seen. */
class FeedReader {
  readonly frames: Frame[] = [];
  /** The text of the whole response body so far. */
  raw = '';
  closed = false;
  private pending = '';
  readonly res: IncomingMessage;
  private readonly stop: () => void;

  constructor(res: IncomingMessage, stop: () => void) {
    this.res = res;
    this.stop = stop;
    res.setEncoding('utf8');
    res.on('data', (text: string) => {
      this.raw += text;
      this.pending += text;
      let end = this.pending.indexOf('\n\n');
      while (end >= 0) {
        const block = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 2);
        const frame = parseBlock(block);
        if (frame !== undefined) this.frames.push(frame);
        end = this.pending.indexOf('\n\n');
      }
    });
    res.on('close', () => {
      this.closed = true;
    });
    res.on('error', () => {
      this.closed = true;
    });
  }

  get status(): number {
    return this.res.statusCode ?? 0;
  }

  of(event: string): Frame[] {
    return this.frames.filter((frame) => frame.event === event);
  }

  /** The sessions frames, parsed with the schema of the feed. */
  sessions(): TerminalSessionsEvent[] {
    return this.of('sessions').map((frame) => TerminalEventSchemas.sessions.parse(frame.data));
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}

function parseBlock(block: string): Frame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  if (event === undefined || data.length === 0) return undefined;
  return { event, data: JSON.parse(data.join('\n')) as unknown };
}

const readers: FeedReader[] = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) reader.close();
  await stopTerminalApps();
});

/** Opens the feed and resolves when the response head arrives (any status). */
function openFeed(app: TerminalApp, cookie: string | null): Promise<FeedReader> {
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${String(app.port)}`,
    Accept: 'text/event-stream',
    ...(cookie === null ? {} : { Cookie: cookie }),
  };
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: app.port, path: routes.terminalEvents.path, method: 'GET', headers, agent: false },
      (res) => {
        const reader = new FeedReader(res, () => {
          req.destroy();
        });
        readers.push(reader);
        resolve(reader);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

async function signedIn(options: Parameters<typeof startTerminalApp>[0] = {}): Promise<{
  readonly app: TerminalApp;
  readonly ports: FakeTerminalPorts;
  readonly cookie: string;
}> {
  const app = await startTerminalApp(options);
  const cookie = await mintAndExchange(app.port, app.access);
  return { app, ports: app.ports ?? new FakeTerminalPorts(), cookie };
}

function codeOf(body: string): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function logout(app: TerminalApp, cookie: string): Promise<HttpReply> {
  return httpRequest(app.port, routes.authLogout.path, {
    method: 'POST',
    headers: writeHeaders(cookie),
    origin: pageOrigin(app.port),
    body: '{}',
  });
}

describe('who may open the feed (TC-SEC-02)', () => {
  it('answers 401 access_required with the JSON envelope, and no byte of a stream, without a cookie or with a garbage one', async () => {
    const { app } = await signedIn();
    for (const cookie of [null, 'caw_11111111=not-a-credential', 'caw_22222222=not-a-credential']) {
      const reader = await openFeed(app, cookie);
      expect(reader.status).toBe(401);
      expect(reader.res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(reader.res.headers['www-authenticate']).toBe('CAW-Access');
      await waitFor(() => reader.closed || reader.raw.includes('access_required'), { what: 'the envelope' });
      expect(codeOf(reader.raw)).toBe('access_required');
      expect(reader.frames).toEqual([]);
    }
    expect(app.events().size).toBe(0);
  });
});

describe('the opening of a stream (TC-WS-05)', () => {
  it('sends the head, the retry hint, the hello and the full list, and each frame fits its schema', async () => {
    const { app, ports, cookie } = await signedIn();
    ports.addSession({ name: 'alpha-1' });
    ports.addSession({ name: 'beta-1', path: 'C:\\work\\beta' });
    const reader = await openFeed(app, cookie);
    expect(reader.status).toBe(200);
    expect(reader.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(reader.res.headers['cache-control']).toBe('no-store');
    expect(reader.res.headers['x-accel-buffering']).toBe('no');
    await waitFor(() => reader.of('sessions').length >= 1, { what: 'the first list' });
    expect(reader.raw.startsWith('retry: 3000\n\n')).toBe(true);
    expect(reader.frames.map((frame) => frame.event)).toEqual(['hello', 'sessions']);
    const hello = TerminalEventSchemas.hello.parse(reader.of('hello')[0]?.data);
    expect(hello.instanceId).toBe(app.ctx.instanceId);
    expect(hello.epoch).toBe(app.ctx.db.epoch);
    expect(hello.heartbeatMs).toBe(15_000);
    expect(hello.serverTime).toBe(new Date(app.clock.now()).toISOString());
    const first = reader.sessions()[0];
    expect(first?.sessions.map((s) => s.name)).toEqual(['alpha-1', 'beta-1']);
    expect(first?.version).toBeGreaterThanOrEqual(1);
  });

  it('an empty host still sends the empty list', async () => {
    const { app, cookie } = await signedIn();
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length >= 1, { what: 'the first list' });
    expect(reader.sessions()[0]?.sessions).toEqual([]);
  });
});

describe('a snapshot after every change (TC-WS-05)', () => {
  it('a session that appears, one that exits and a link that changes each give a new full list with a higher version', async () => {
    const { app, ports, cookie } = await signedIn();
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length === 1, { what: 'the first list' });
    const session = ports.addSession({ name: 'alpha-1' });
    await waitFor(() => reader.of('sessions').length === 2, { what: 'the list with the new session' });
    expect(reader.sessions()[1]?.sessions.map((s) => s.name)).toEqual(['alpha-1']);
    session.info = { ...session.info, link: { ...session.info.link, status: 'linked' } };
    ports.touch();
    await waitFor(() => reader.of('sessions').length === 3, { what: 'the list with the changed link' });
    expect(reader.sessions()[2]?.sessions[0]?.link.status).toBe('linked');
    ports.removeSession('alpha-1');
    await waitFor(() => reader.of('sessions').length === 4, { what: 'the list without the session' });
    expect(reader.sessions()[3]?.sessions).toEqual([]);
    const versions = reader.sessions().map((frame) => frame.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('a burst of changes in one tick is one frame with the newest list', async () => {
    const { app, ports, cookie } = await signedIn();
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length === 1, { what: 'the first list' });
    for (let i = 1; i <= 5; i += 1) ports.addSession({ name: `burst-${String(i)}` });
    await waitFor(() => reader.of('sessions').length >= 2, { what: 'the list after the burst' });
    expect(reader.sessions()[1]?.sessions).toHaveLength(5);
    expect(reader.of('sessions')).toHaveLength(2);
  });

  it('two browsers both see a session that a third one started', async () => {
    const { app, ports, cookie } = await signedIn();
    const other = await mintAndExchange(app.port, app.access);
    const first = await openFeed(app, cookie);
    const second = await openFeed(app, other);
    await waitFor(() => first.of('sessions').length === 1 && second.of('sessions').length === 1, {
      what: 'both first lists',
    });
    ports.addSession({ name: 'shared-1' });
    await waitFor(() => first.of('sessions').length === 2 && second.of('sessions').length === 2, {
      what: 'both new lists',
    });
    expect(first.sessions()[1]).toEqual(second.sessions()[1]);
  });
});

describe('the heartbeat', () => {
  it('sends heartbeat frames with the server time, at the interval the hello announced', async () => {
    const { app, cookie } = await signedIn({ eventLimits: { heartbeatMs: 40 } });
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('heartbeat').length >= 2, { what: 'two heartbeats' });
    expect(TerminalEventSchemas.hello.parse(reader.of('hello')[0]?.data).heartbeatMs).toBe(40);
    for (const frame of reader.of('heartbeat')) {
      expect(TerminalEventSchemas.heartbeat.parse(frame.data).serverTime).toBe(new Date(app.clock.now()).toISOString());
    }
  });
});

describe('the cap of streams (TC-WS-09)', () => {
  it('the ninth stream is 503 stream_limit with the envelope and no stream byte; a place frees up when one closes', async () => {
    const { app, cookie } = await signedIn();
    const open: FeedReader[] = [];
    for (let i = 0; i < 8; i += 1) {
      const reader = await openFeed(app, cookie);
      expect(reader.status).toBe(200);
      open.push(reader);
    }
    await waitFor(() => open.every((reader) => reader.of('sessions').length === 1), { what: 'every first list' });
    const ninth = await openFeed(app, cookie);
    expect(ninth.status).toBe(503);
    expect(ninth.res.headers['content-type']).toBe('application/json; charset=utf-8');
    await waitFor(() => ninth.closed || ninth.raw.includes('stream_limit'), { what: 'the envelope' });
    expect(codeOf(ninth.raw)).toBe('stream_limit');
    expect(ninth.raw).not.toContain('retry:');
    expect(ninth.frames).toEqual([]);
    expect(app.events().size).toBe(8);

    open[0]?.close();
    await waitFor(() => app.events().size === 7, { what: 'a place to free up' });
    const again = await openFeed(app, cookie);
    expect(again.status).toBe(200);
    await waitFor(() => again.of('sessions').length === 1, { what: 'the list of the new stream' });
  });
});

describe('the subscription lives only while a client is connected', () => {
  it('subscribes to the host with the first stream, once for many, and lets go with the last', async () => {
    const { app, ports, cookie } = await signedIn();
    expect(ports.listenerCount).toBe(0);
    const first = await openFeed(app, cookie);
    const second = await openFeed(app, cookie);
    await waitFor(() => app.events().size === 2, { what: 'both streams' });
    expect(ports.listenerCount).toBe(1);
    first.close();
    await waitFor(() => app.events().size === 1, { what: 'one stream left' });
    expect(ports.listenerCount).toBe(1);
    second.close();
    await waitFor(() => app.events().size === 0, { what: 'no stream left' });
    expect(ports.listenerCount).toBe(0);
  });

  it('a stream opened after the last one left starts from the current list', async () => {
    const { app, ports, cookie } = await signedIn();
    (await openFeed(app, cookie)).close();
    await waitFor(() => app.events().size === 0, { what: 'no stream left' });
    ports.addSession({ name: 'late-1' });
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length === 1, { what: 'the first list' });
    expect(reader.sessions()[0]?.sessions.map((s) => s.name)).toEqual(['late-1']);
  });
});

describe('closing on revocation (TC-SEC-08)', () => {
  it('logout closes the streams of that credential and leaves the streams of another one open', async () => {
    const { app, ports, cookie } = await signedIn();
    const other = await mintAndExchange(app.port, app.access);
    const mine = await openFeed(app, cookie);
    const mine2 = await openFeed(app, cookie);
    const theirs = await openFeed(app, other);
    await waitFor(() => [mine, mine2, theirs].every((reader) => reader.of('sessions').length === 1), {
      what: 'every first list',
    });
    expect((await logout(app, cookie)).status).toBe(200);
    await waitFor(() => mine.closed && mine2.closed, { what: 'the streams of the credential to close' });
    expect(theirs.closed).toBe(false);
    expect(app.events().size).toBe(1);
    ports.addSession({ name: 'after-1' });
    await waitFor(() => theirs.of('sessions').length === 2, { what: 'the other stream to go on' });
    expect(mine.of('sessions')).toHaveLength(1);
    // the old cookie opens nothing any more
    const refused = await openFeed(app, cookie);
    expect(refused.status).toBe(401);
  });
});

describe('an instance whose terminal cannot run (TC-WS-12)', () => {
  it('serves the empty list while the host is unavailable, and never subscribes to a missing host', async () => {
    const ports = new FakeTerminalPorts();
    ports.addSession({ name: 'hidden-1' });
    ports.capabilitiesValue = unavailableCapabilities('claude_not_found');
    const { app, cookie } = await signedIn({ ports });
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length === 1, { what: 'the first list' });
    expect(reader.sessions()[0]?.sessions).toEqual([]);

    const none = await signedIn({ ports: null });
    const bare = await openFeed(none.app, none.cookie);
    await waitFor(() => bare.of('sessions').length === 1, { what: 'the first list of the bare instance' });
    expect(bare.sessions()[0]?.sessions).toEqual([]);
    expect(bare.of('hello')).toHaveLength(1);
  });
});

describe('the log file (rule 7)', () => {
  it('never holds a session name, a folder, an access code or a credential', async () => {
    const { app, ports, cookie } = await signedIn();
    const reader = await openFeed(app, cookie);
    await waitFor(() => reader.of('sessions').length === 1, { what: 'the first list' });
    ports.addSession({ name: SECRET_NAME, path: SECRET_FOLDER });
    await waitFor(() => reader.of('sessions').length === 2, { what: 'the list with the session' });
    expect((await logout(app, cookie)).status).toBe(200);
    await waitFor(() => reader.closed, { what: 'the stream to close' });
    await app.ctx.logger.close();
    const log = readFileSync(app.logFile, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    const credential = cookie.slice(cookie.indexOf('=') + 1);
    for (const secret of ['secret', credential]) expect(log, secret).not.toContain(secret);
  });
});
