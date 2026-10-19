// The lifecycle of the stream over a real instance and a real HTTP server (03 9.2, 9.5; DA-T-RT-5 and DA-T-RT-8): clients that
// disconnect leave no client, no timer and no listener behind, an abort storm does not leak, a shutdown ends every stream, and
// a restarted server has a new epoch.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type Server } from 'node:http';
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
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.restoreAllMocks(); // the timer spies of `watchHeartbeats`
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

// ---- a minimal app: the stream route alone, so that a test can look at the hub ---------------------------------------------

/** The stream route on a bare Express app (no guards). */
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

/**
 * A heartbeat interval that no other timer of the process can have, and that never fires inside a test. The hub of a test gets it
 * through `limits.heartbeatMs`, so the intervals that carry this delay are the hub's own, however busy the process is.
 */
const OWN_HEARTBEAT_MS = 86_400_123;

interface HeartbeatWatch {
  /** Heartbeat intervals the hub created and nobody cleared yet. */
  live(): number;
  /** Heartbeat intervals the hub created so far, cleared or not. */
  created(): number;
}

/**
 * Counts what this test owns: the heartbeat intervals of its hub. The first version compared `process.getActiveResourcesInfo()`
 * with a baseline, which counts every timer of the worker (sockets, the wait helper, other files of a parallel run) and failed under
 * load although the hub had cleaned up. This one wraps `setInterval` and `clearInterval` (calls pass through) and follows only
 * the intervals with `OWN_HEARTBEAT_MS`.
 */
function watchHeartbeats(): HeartbeatWatch {
  const created = vi.spyOn(globalThis, 'setInterval');
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  const own = (): number[] =>
    created.mock.calls.flatMap(([, delay], index) => (delay === OWN_HEARTBEAT_MS ? [index] : []));
  return {
    created: () => own().length,
    live: () => {
      const gone = new Set<unknown>(cleared.mock.calls.map(([handle]) => handle));
      return own().filter((index) => !gone.has(created.mock.results[index]?.value)).length;
    },
  };
}

describe('disconnect cleanup (DA-T-RT-5)', () => {
  it('removes six aborted clients, clears their timers and stops listening for commits', async () => {
    const { ctx } = await openInstance();
    let hub: StreamHub | undefined;
    const watch = watchHeartbeats();
    const port = await serveMini(ctx, {
      limits: { heartbeatMs: OWN_HEARTBEAT_MS },
      onHub: (created) => {
        hub = created;
      },
    });
    const session = addSession(ctx, 1);
    expect(watch.live()).toBe(0);

    const readers: StreamReader[] = [];
    for (let i = 0; i < 6; i += 1) readers.push(await openStream(port));
    await waitFor(() => readers.every((reader) => reader.of('hello').length === 1));
    expect(hub?.size).toBe(6);
    expect(watch.live()).toBe(6); // one heartbeat interval per client

    for (const reader of readers) reader.close();
    await waitFor(() => hub?.size === 0, { what: 'the hub to forget its clients' });
    await waitFor(() => watch.live() === 0, { what: 'the timers of the clients to be cleared' });

    // nothing listens any more: a commit after the last client left has no one to reach and breaks nothing
    appendEvents(ctx, session, 3);
    expect(hub?.size).toBe(0);
  });

  it('survives an abort storm of 60 streams opened and cut at once', async () => {
    const { ctx } = await openInstance();
    let hub: StreamHub | undefined;
    const watch = watchHeartbeats();
    const port = await serveMini(ctx, {
      limits: { heartbeatMs: OWN_HEARTBEAT_MS },
      onHub: (created) => {
        hub = created;
      },
    });
    const session = addSession(ctx, 1);
    for (let round = 0; round < 3; round += 1) {
      const opened = await Promise.all(Array.from({ length: 12 }, () => openStream(port, { query: 'since=0' })));
      for (const reader of opened) reader.close();
      touchSession(ctx, session); // a commit in the middle of the storm
      const more = await Promise.all(Array.from({ length: 8 }, () => openStream(port)));
      for (const reader of more) reader.close();
    }
    await waitFor(() => hub?.size === 0, { what: 'every aborted client to be removed' });
    expect(watch.created()).toBeGreaterThan(0); // the storm did open streams, so the clean count below means something
    await waitFor(() => watch.live() === 0, { what: 'every timer to be cleared' });
    // the server still serves a fresh client afterwards
    const fresh = await openStream(port);
    expect(fresh.status).toBe(200);
    await waitFor(() => fresh.of('hello').length === 1);
  });

  it('ends every stream when the server drops its connections (shutdown) and clears the timers', async () => {
    const { ctx } = await openInstance();
    let hub: StreamHub | undefined;
    const watch = watchHeartbeats();
    const port = await serveMini(ctx, {
      limits: { heartbeatMs: OWN_HEARTBEAT_MS },
      onHub: (created) => {
        hub = created;
      },
    });
    const readers = [await openStream(port), await openStream(port)];
    await waitFor(() => readers.every((reader) => reader.of('hello').length === 1));
    expect(watch.live()).toBe(2);
    const entry = openServers.find((known) => known.port === port);
    entry?.server.closeAllConnections();
    await waitFor(() => readers.every((reader) => reader.closed), { what: 'the streams to end' });
    await waitFor(() => hub?.size === 0);
    await waitFor(() => watch.live() === 0, { what: 'the timers of the ended streams to be cleared' });
  });
});

describe('the health gauge of the open streams (CR-WP-17-3)', () => {
  it('reports sseClients as the number of open streams while they are open and 0 after they closed, with no timer left', async () => {
    const { ctx } = await openInstance();
    const watch = watchHeartbeats();
    const port = await serveMini(ctx, { limits: { heartbeatMs: OWN_HEARTBEAT_MS } });
    const sseClients = (): number => ctx.queries.health(ctx.scope).runtime.sseClients;
    expect(sseClients()).toBe(0); // no hub yet: nobody connected

    const readers: StreamReader[] = [];
    for (let i = 0; i < 3; i += 1) readers.push(await openStream(port));
    await waitFor(() => readers.every((reader) => reader.of('hello').length === 1));
    expect(sseClients()).toBe(3);
    expect(watch.live()).toBe(3);

    readers[0]?.close();
    await waitFor(() => sseClients() === 2, { what: 'one stream to be forgotten' });
    for (const reader of readers) reader.close();
    await waitFor(() => sseClients() === 0, { what: 'every stream to be forgotten' });
    await waitFor(() => watch.live() === 0, { what: 'the timers of the closed streams to be cleared' });
    expect(sseClients()).toBe(0);
  });

  it('shows the count on GET /api/v3/health of the whole app, which mounts the stream route itself', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const health = async (): Promise<number> => {
      const reply = await httpRequest(port, '/api/v3/health');
      return (JSON.parse(reply.body) as { runtime: { sseClients: number } }).runtime.sseClients;
    };
    expect(await health()).toBe(0);
    const readers = [await openStream(port), await openStream(port)];
    await waitFor(() => readers.every((reader) => reader.of('hello').length === 1));
    expect(await health()).toBe(2);
    for (const reader of readers) reader.close();
    await waitFor(async () => (await health()) === 0, { what: 'the health report to show no stream' });
  });
});

describe('epoch per process (DA-T-RT-8)', () => {
  it('a restarted server has a new epoch, and a client that sends the old one gets reset(epoch_changed)', async () => {
    const first = await openInstance();
    const firstPort = await serve(first.ctx);
    addSession(first.ctx, 1);
    const before = await openStream(firstPort);
    await waitFor(() => before.of('hello').length === 1);
    const oldEpoch = (before.of('hello')[0]?.data as { epoch: string }).epoch;
    expect(oldEpoch).toBe(first.ctx.db.epoch);
    const info = await httpRequest(firstPort, '/api/v3/instance');
    expect(JSON.parse(info.body)).toMatchObject({ epoch: oldEpoch, headSeq: 1 });
    before.close();

    // stop the server and close the database, then open the same workspace again
    const entry = openServers.splice(0).find((known) => known.port === firstPort);
    await new Promise<void>((resolve) => {
      entry?.server.closeAllConnections();
      entry?.server.close(() => {
        resolve();
      });
    });
    first.ctx.db.close();
    openContexts.splice(openContexts.indexOf(first.ctx), 1);

    const second = await openInstance(first);
    const secondPort = await serve(second.ctx);
    expect(second.ctx.db.epoch).not.toBe(oldEpoch);
    const after = await openStream(secondPort, { query: `since=1&epoch=${oldEpoch}` });
    await waitFor(() => after.of('reset').length === 1);
    expect(after.of('hello')[0]?.data).toMatchObject({ epoch: second.ctx.db.epoch, headSeq: 1 });
    expect(after.of('reset')[0]).toMatchObject({ id: '1', data: { headSeq: 1, reason: 'epoch_changed' } });
    expect(after.changeSeqs()).toEqual([]);

    // with the new epoch the same cursor is accepted
    const same = await openStream(secondPort, { query: `since=1&epoch=${second.ctx.db.epoch}` });
    await waitFor(() => same.of('hello').length === 1);
    expect(same.of('reset')).toHaveLength(0);
  });
});
