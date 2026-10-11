// The limits and the edges of the stream over a real instance and a real HTTP server (03 9.2, 5.2; DA-T-RT-6 and DA-T-RT-9): the
// response head, the guards and the query validation, 16 streams and the 503 of the 17th, and a paused client that is evicted
// while a fast client keeps receiving every frame.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  withWriteTx,
  type InstanceContext,
  type Logger,
  type WriteTx,
} from '@mcs/engine';
import { RUNTIME_VERSION } from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, useTempDirs, waitFor } from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';
import { bindRouteServices } from '../src/route-adapter.ts';
import type { StreamHub } from '../src/stream/hub.ts';
import { createStreamRoutes, type StreamRouteOptions } from '../src/stream/sse.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';

interface Instance {
  readonly ctx: InstanceContext;
  readonly root: string;
  readonly instanceDir: string;
}

const openContexts: InstanceContext[] = [];
const openServers: { server: Server; port: number }[] = [];
const openReaders: StreamReader[] = [];

afterEach(async () => {
  for (const reader of openReaders.splice(0)) reader.close();
  for (const { server, port } of openServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await assertPortClosed(port);
  }
  for (const ctx of openContexts.splice(0)) ctx.db.close();
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** A real workspace and database in a temp folder; with `again` the same folder is opened a second time (a restart). */
async function openInstance(again?: Instance): Promise<Instance> {
  const root = again?.root ?? makeTemp('stream-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  let instanceDir = again?.instanceDir ?? '';
  if (again === undefined) {
    mkdirSync(path.join(skill, 'config'), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
    writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const { ws } = await initWorkspace({
      repo,
      name: 'Demo',
      slug: 'demo',
      clock: new FakeClock(NOW),
      newId: () => ID,
    });
    instanceDir = ws.dir;
  }
  const ctx = await buildInstanceContext({
    instanceDir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock: new FakeClock(NOW),
    logger: silentLogger(),
  });
  openContexts.push(ctx);
  return { ctx, root, instanceDir };
}

/** The full app of the instance (guards, error mapper, every route module) on a free port. */
async function serve(ctx: InstanceContext): Promise<number> {
  const port = await allocatePort();
  const app = createApp({ ctx, port: () => port, nudge: () => undefined, task: null });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  openServers.push({ server, port });
  return port;
}

interface Frame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: unknown;
}

/** A raw event stream client: it keeps every frame it has seen, and can be paused like a stuck browser tab. */
class StreamReader {
  readonly frames: Frame[] = [];
  /** The first 64 KiB of the response body as text (the JSON of a refused request). */
  raw = '';
  readonly res: IncomingMessage;
  private pending = '';
  private readonly closeRequest: () => void;
  closed = false;

  constructor(res: IncomingMessage, closeRequest: () => void) {
    this.res = res;
    this.closeRequest = closeRequest;
    res.setEncoding('utf8');
    res.on('data', (text: string) => {
      if (this.raw.length < 65_536) this.raw += text;
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

  changeSeqs(): number[] {
    return this.of('change').map((frame) => Number(frame.id));
  }

  close(): void {
    this.closed = true;
    this.closeRequest();
  }
}

function parseBlock(block: string): Frame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (name === 'id') id = value;
    else if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { id, event, data: JSON.parse(data.join('\n')) as unknown };
}

interface OpenOptions {
  readonly query?: string;
  readonly lastEventId?: string;
  readonly host?: string;
}

/** Opens `GET /api/v3/stream` and resolves when the response head arrives (any status). */
function openStream(port: number, options: OpenOptions = {}): Promise<StreamReader> {
  const headers: Record<string, string> = {
    Host: options.host ?? `127.0.0.1:${String(port)}`,
    Accept: 'text/event-stream',
  };
  if (options.lastEventId !== undefined) headers['Last-Event-ID'] = options.lastEventId;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v3/stream${options.query === undefined ? '' : `?${options.query}`}`,
        method: 'GET',
        headers,
        agent: false,
      },
      (res) => {
        const reader = new StreamReader(res, () => {
          req.destroy();
        });
        openReaders.push(reader);
        resolve(reader);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

// ---- rows, written the way the engine writes them ----------------------------------------------------------------------

let eventCounter = 0;

function insert(ctx: InstanceContext, table: string, row: Record<string, string | number | null>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Added {
  readonly id: number;
  readonly uid: string;
  readonly agentId: number;
}

/** A session with its main agent and a `session/upsert` change, in one write transaction. */
function addSession(ctx: InstanceContext, n: number): Added {
  return withWriteTx(ctx.db, ctx.scope, (tx) => {
    const id = insert(ctx, 'sessions', {
      session_uid: uidOf(n),
      label: `session ${String(n)}`,
      matched: 1,
      search_text: `session ${String(n)}`,
      models: '[]',
      first_seen_at: NOW - 3_600_000,
      started_at: NOW - 3_600_000,
      last_activity_at: NOW - 60_000,
      state: 'working',
      presence: 'open',
      updated_at: NOW,
    });
    const agentId = insert(ctx, 'agents', {
      session_id: id,
      agent_uid: 'main',
      kind: 'main',
      depth: 0,
      first_seen_at: NOW - 3_600_000,
      started_at: NOW - 3_600_000,
      last_activity_at: NOW - 60_000,
      updated_at: NOW,
    });
    stampSession(ctx, tx, id, uidOf(n));
    return { id, uid: uidOf(n), agentId };
  });
}

function stampSession(ctx: InstanceContext, tx: WriteTx, id: number, uid: string): number {
  const seq = tx.changes.reserve('session', 'upsert', { entityId: id, sessionUid: uid });
  ctx.db.driver.prepare('UPDATE sessions SET updated_seq = :seq WHERE id = :id').run({ seq, id });
  return seq;
}

/** One more `session/upsert` for a session that exists (a view change). Returns its seq. */
function touchSession(ctx: InstanceContext, session: Added): number {
  return withWriteTx(ctx.db, ctx.scope, (tx) => stampSession(ctx, tx, session.id, session.uid));
}

/** `count` events of one session under one `event/append` reservation (they coalesce into one change row). */
function appendEvents(ctx: InstanceContext, session: Added, count: number): number {
  return withWriteTx(ctx.db, ctx.scope, (tx) => {
    const seq = tx.changes.reserve('event', 'append', { entityId: session.id, sessionUid: session.uid });
    for (let i = 0; i < count; i += 1) {
      eventCounter += 1;
      const id = insert(ctx, 'events', {
        session_id: session.id,
        kind: 'tool.call',
        sources: 1,
        ts: NOW - 60_000 + i,
        ts_source: 'hook_received',
        received_at: NOW - 60_000,
        event_uid: `eeeeeeee-0000-4000-8000-${eventCounter.toString(16).padStart(12, '0')}`,
        summary: 'x'.repeat(200),
        change_seq: seq,
      });
      tx.changes.noteId(seq, id);
    }
    return seq;
  });
}

function head(ctx: InstanceContext): number {
  return ctx.db.headSeq();
}

// ---- a minimal app: the stream route alone, with limits a test may shorten ----------------------------------------------

/** The stream route on a bare Express app (no guards): the way to give the hub shorter limits and to look at it. */
async function serveMini(ctx: InstanceContext, options: StreamRouteOptions): Promise<number> {
  const app = express();
  bindRouteServices(app, { errors: ctx.errors, logger: ctx.logger, validateResponses: true });
  createStreamRoutes(options)(app, { ctx, nudge: () => undefined, task: null });
  const port = await allocatePort();
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  openServers.push({ server, port });
  return port;
}

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('response head', () => {
  it('is an event stream with the headers of 03 9.2 and the common headers', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const reader = await openStream(port);
    expect(reader.status).toBe(200);
    const { headers } = reader.res;
    expect(headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers.connection).toBe('keep-alive');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-request-id']).toMatch(/^r-/);
    expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    await waitFor(() => reader.of('hello').length === 1);
  });
});

describe('guards and query validation', () => {
  it('refuses a foreign Host with 403 and the JSON envelope, like every route', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const reader = await openStream(port, { host: 'evil.example' });
    expect(reader.status).toBe(403);
    await waitFor(() => reader.closed || reader.raw.includes('host_not_allowed'));
    expect(JSON.parse(reader.raw)).toMatchObject({ error: { code: 'host_not_allowed' } });
  });

  it('refuses a malformed since or epoch with 400 validation_failed, and a repeated key with param_repeated', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    for (const [query, code] of [
      ['since=abc', 'validation_failed'],
      ['since=-1', 'validation_failed'],
      ['epoch=not-hex', 'validation_failed'],
      ['unknown=1', 'validation_failed'],
      ['since=1&since=2', 'param_repeated'],
    ] as const) {
      const reader = await openStream(port, { query });
      expect(reader.status, query).toBe(400);
      await waitFor(() => reader.raw.includes(code), { what: query });
      expect(JSON.parse(reader.raw), query).toMatchObject({ error: { code } });
    }
  });

  it('answers a POST with 405 and Allow: GET, HEAD', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const reply = await httpRequest(port, '/api/v3/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCS-Request': '1' },
      body: '{}',
    });
    expect(reply.status).toBe(405);
    expect(reply.headers['allow']).toBe('GET, HEAD');
  });
});

describe('stream limit (DA-T-RT-9)', () => {
  it('serves 16 streams, answers the 17th with 503 stream_limit, and frees a place when one closes', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    const readers: StreamReader[] = [];
    for (let i = 0; i < 16; i += 1) readers.push(await openStream(port));
    expect(readers.every((reader) => reader.status === 200)).toBe(true);
    await waitFor(() => readers.every((reader) => reader.of('hello').length === 1));

    const seventeenth = await openStream(port);
    expect(seventeenth.status).toBe(503);
    expect(seventeenth.res.headers['content-type']).toContain('application/json');
    await waitFor(() => seventeenth.raw.includes('stream_limit'));
    expect(JSON.parse(seventeenth.raw)).toMatchObject({ error: { code: 'stream_limit' } });

    // the 16 are all live: a commit reaches each of them
    const seq = touchSession(ctx, session);
    await waitFor(() => readers.every((reader) => reader.changeSeqs().includes(seq)));

    readers[5]?.close();
    const again = await waitFor(async () => {
      const candidate = await openStream(port);
      if (candidate.status === 200) return candidate;
      candidate.close();
      return null;
    });
    expect(again.status).toBe(200);
  });
});

describe('slow clients (DA-T-RT-6)', () => {
  it('evicts a paused client after the stall timeout with less than 64 KiB buffered while a fast client gets every frame', async () => {
    const { ctx } = await openInstance();
    let hub: StreamHub | undefined;
    const responses: ServerResponse[] = [];
    const port = await serveMini(ctx, {
      limits: { stallMs: 400 },
      onHub: (created) => {
        hub = created;
      },
      onResponse: (res) => {
        responses.push(res);
      },
    });
    const session = addSession(ctx, 1);
    const fast = await openStream(port);
    const slow = await openStream(port);
    await waitFor(() => fast.of('hello').length === 1 && slow.of('hello').length === 1 && responses.length === 2);
    slow.res.pause(); // a tab that stopped reading: its socket buffers fill up
    const slowResponse = responses[1];
    if (slowResponse === undefined) throw new Error('no response for the slow client');

    let commits = 0;
    while (!slowResponse.writableNeedDrain && commits < 4000) {
      appendEvents(ctx, session, 50);
      commits += 1;
      await nextTurn(); // let the fast client read
    }
    expect(slowResponse.writableNeedDrain).toBe(true);
    expect(slowResponse.writableLength).toBeLessThan(64 * 1024);
    expect(hub?.size).toBe(2);

    await waitFor(() => slowResponse.destroyed, { timeoutMs: 5000, what: 'the eviction of the paused client' });
    await waitFor(() => hub?.size === 1);

    const last = head(ctx);
    await waitFor(() => fast.changeSeqs().includes(last), { timeoutMs: 10_000, what: 'the fast client to catch up' });
    expect(fast.changeSeqs()).toEqual(Array.from({ length: last - 1 }, (_, i) => i + 2));
    expect(fast.closed).toBe(false);
  });
});
