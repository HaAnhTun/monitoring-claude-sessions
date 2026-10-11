// The stream over a real instance and a real HTTP server (03 9.2, 9.3; DA-T-RT-1, 2, 3, 10 and the hydration of the frames):
// persist before publish, replay from `Last-Event-ID` or `since`, every reset reason with `id = head`, and frames that carry
// the current state of the entity. Rows are written the way the engine writes them: through `withWriteTx` and the change recorder.
// @stream-harness-begin
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
import { RUNTIME_VERSION, StreamChangeSchema } from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';

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
// @stream-harness-end

describe('hello and live frames', () => {
  it('opens with retry, then hello, then a change frame for each commit after the head', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const first = addSession(ctx, 1);
    const reader = await openStream(port);
    expect(reader.status).toBe(200);
    await waitFor(() => reader.of('hello').length === 1);
    const hello = reader.of('hello')[0];
    expect(hello?.id).toBeUndefined();
    expect(hello?.data).toMatchObject({
      instanceId: ID,
      epoch: ctx.db.epoch,
      headSeq: 1,
      heartbeatMs: 15_000,
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
    });
    expect(reader.changeSeqs()).toEqual([]); // no cursor: live from the head

    const seq = touchSession(ctx, first);
    await waitFor(() => reader.changeSeqs().length === 1);
    const frame = reader.of('change')[0];
    expect(frame?.id).toBe(String(seq));
    const parsed = StreamChangeSchema.parse(frame?.data);
    expect(parsed).toMatchObject({ seq, kind: 'session', op: 'upsert', sessionId: first.uid, instanceId: ID });
    if (parsed.kind !== 'session' || parsed.op !== 'upsert') throw new Error('not a session frame');
    expect(parsed.data?.id).toBe(first.uid);
    expect(parsed.data?.seq).toBeGreaterThanOrEqual(seq);
  });

  it('every frame carries an entity at least as new as the frame (DA-T-RT-1)', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    const reader = await openStream(port);
    await waitFor(() => reader.of('hello').length === 1);
    for (let i = 0; i < 5; i += 1) touchSession(ctx, session);
    await waitFor(() => reader.changeSeqs().length === 5);
    for (const frame of reader.of('change')) {
      const change = StreamChangeSchema.parse(frame.data);
      if (change.kind !== 'session' || change.op !== 'upsert' || change.data === null)
        throw new Error('unexpected frame');
      expect(change.data.seq).toBeGreaterThanOrEqual(change.seq);
    }
  });
});

describe('persist before publish (DA-T-RT-1)', () => {
  it('a transaction that throws after reserving a change leaves no frame, no gap and the head unchanged', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    const reader = await openStream(port);
    await waitFor(() => reader.of('hello').length === 1);
    const before = head(ctx);

    expect(() =>
      withWriteTx(ctx.db, ctx.scope, (tx) => {
        stampSession(ctx, tx, session.id, session.uid);
        throw new Error('the writer failed after reserving');
      }),
    ).toThrow('the writer failed');
    expect(head(ctx)).toBe(before);

    const seq = touchSession(ctx, session);
    expect(seq).toBe(before + 1); // the rolled back reservation left no gap
    await waitFor(() => reader.changeSeqs().length === 1);
    expect(reader.changeSeqs()).toEqual([before + 1]);
  });
});

describe('replay (DA-T-RT-2)', () => {
  function fiveChanges(ctx: InstanceContext): void {
    const session = addSession(ctx, 1); // seq 1
    for (let i = 0; i < 4; i += 1) touchSession(ctx, session); // seq 2..5
  }

  it('Last-Event-ID replays the seqs after it, once and in order, then continues live', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    fiveChanges(ctx);
    const reader = await openStream(port, { lastEventId: '2' });
    await waitFor(() => reader.changeSeqs().length === 3);
    expect(reader.changeSeqs()).toEqual([3, 4, 5]);
    expect(reader.of('hello')).toHaveLength(1);
    expect(reader.of('reset')).toHaveLength(0);
    touchSession(ctx, { id: 1, uid: uidOf(1), agentId: 1 });
    await waitFor(() => reader.changeSeqs().length === 4);
    expect(reader.changeSeqs()).toEqual([3, 4, 5, 6]);
  });

  it('since is used when there is no header, and the header wins when both are sent', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    fiveChanges(ctx);
    const bySince = await openStream(port, { query: 'since=3' });
    await waitFor(() => bySince.changeSeqs().length === 2);
    expect(bySince.changeSeqs()).toEqual([4, 5]);
    const both = await openStream(port, { query: 'since=4', lastEventId: '1' });
    await waitFor(() => both.changeSeqs().length === 4);
    expect(both.changeSeqs()).toEqual([2, 3, 4, 5]);
  });

  it('a cursor equal to the head replays nothing', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    fiveChanges(ctx);
    const reader = await openStream(port, { query: `since=5&epoch=${ctx.db.epoch}` });
    await waitFor(() => reader.of('hello').length === 1);
    expect(reader.changeSeqs()).toEqual([]);
    expect(reader.of('reset')).toHaveLength(0);
  });
});

describe('reset reasons (DA-T-RT-3)', () => {
  async function resetOf(reader: StreamReader): Promise<{ id: string | undefined; data: unknown }> {
    await waitFor(() => reader.of('reset').length === 1);
    const frame = reader.of('reset')[0];
    return { id: frame?.id, data: frame?.data };
  }

  it('answers every bad cursor with a reset whose id is the head', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    for (let i = 0; i < 5; i += 1) touchSession(ctx, session); // head 6
    const current = head(ctx);

    expect(await resetOf(await openStream(port, { query: `since=99&epoch=${ctx.db.epoch}` }))).toEqual({
      id: String(current),
      data: { headSeq: current, reason: 'cursor_ahead' },
    });
    expect(await resetOf(await openStream(port, { query: 'since=2&epoch=deadbeef' }))).toEqual({
      id: String(current),
      data: { headSeq: current, reason: 'epoch_changed' },
    });
    expect(await resetOf(await openStream(port, { lastEventId: 'abc' }))).toEqual({
      id: String(current),
      data: { headSeq: current, reason: 'cursor_invalid' },
    });
    expect(await resetOf(await openStream(port, { lastEventId: '-3' }))).toEqual({
      id: String(current),
      data: { headSeq: current, reason: 'cursor_invalid' },
    });
    expect(await resetOf(await openStream(port, { lastEventId: '99999999999999999999999' }))).toEqual({
      id: String(current),
      data: { headSeq: current, reason: 'cursor_invalid' },
    });
  });

  it('a cursor older than the oldest retained row is cursor_too_old, and the row before it is replayable', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    for (let i = 0; i < 9; i += 1) touchSession(ctx, session); // head 10
    ctx.db.driver.prepare('DELETE FROM changes WHERE seq <= 6').run(); // oldest = 7, head stays 10 (sqlite_sequence)
    expect(head(ctx)).toBe(10);
    const old = await openStream(port, { lastEventId: '3' });
    expect(await resetOf(old)).toEqual({ id: '10', data: { headSeq: 10, reason: 'cursor_too_old' } });
    const edge = await openStream(port, { lastEventId: '6' });
    await waitFor(() => edge.changeSeqs().length === 4);
    expect(edge.changeSeqs()).toEqual([7, 8, 9, 10]);
    expect(edge.of('reset')).toHaveLength(0);
  });

  it('a cursor more than 2000 behind is cursor_too_old', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    withWriteTx(ctx.db, ctx.scope, () => {
      const insertRow = ctx.db.driver.prepare(
        "INSERT INTO changes (at, kind, op, session_uid, entity_id, payload) VALUES (:at, 'health', 'upsert', NULL, NULL, '{}')",
      );
      for (let i = 0; i < 2100; i += 1) insertRow.run({ at: NOW });
    });
    expect(head(ctx)).toBe(2100);
    const far = await openStream(port, { lastEventId: '50' });
    expect(await resetOf(far)).toEqual({ id: '2100', data: { headSeq: 2100, reason: 'cursor_too_old' } });
    const near = await openStream(port, { lastEventId: '100' });
    await waitFor(() => near.of('hello').length === 1);
    expect(near.of('reset')).toHaveLength(0); // exactly 2000 behind is replayed
  });

  it('after a reset the client is live from the head', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    const reader = await openStream(port, { query: 'since=77&epoch=deadbeef' });
    await resetOf(reader);
    const seq = touchSession(ctx, session);
    await waitFor(() => reader.changeSeqs().length === 1);
    expect(reader.changeSeqs()).toEqual([seq]);
  });
});

describe('hydration of the frames (03 9.3, DA-T-RT-10)', () => {
  it('a session deleted before hydration is data null and leaves no seq gap', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const gone = addSession(ctx, 1); // seq 1
    const kept = addSession(ctx, 2); // seq 2
    withWriteTx(ctx.db, ctx.scope, () => {
      ctx.db.driver.prepare('DELETE FROM sessions WHERE id = :id').run({ id: gone.id });
    });
    const reader = await openStream(port, { lastEventId: '0' });
    await waitFor(() => reader.changeSeqs().length === 2);
    expect(reader.changeSeqs()).toEqual([1, 2]);
    expect(reader.of('change')[0]?.data).toMatchObject({ seq: 1, kind: 'session', op: 'upsert', data: null });
    expect(reader.of('change')[1]?.data).toMatchObject({ seq: 2, data: { id: kept.uid } });
  });

  it('event/append carries the 50 first events of a burst of 1000 and says truncated', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    const reader = await openStream(port);
    await waitFor(() => reader.of('hello').length === 1);
    const seq = appendEvents(ctx, session, 1000);
    await waitFor(() => reader.changeSeqs().length === 1);
    const change = StreamChangeSchema.parse(reader.of('change')[0]?.data);
    expect(change).toMatchObject({ seq, kind: 'event', op: 'append', sessionId: session.uid });
    if (change.kind !== 'event') throw new Error('not an event frame');
    expect(change.data.count).toBe(1000);
    expect(change.data.truncated).toBe(true);
    expect(change.data.items).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(change))).toBeLessThanOrEqual(64 * 1024);
  });

  it('event/append of a small burst carries every event and is not truncated', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    appendEvents(ctx, session, 3);
    const reader = await openStream(port, { lastEventId: '1' });
    await waitFor(() => reader.changeSeqs().length === 1);
    const change = StreamChangeSchema.parse(reader.of('change')[0]?.data);
    if (change.kind !== 'event') throw new Error('not an event frame');
    expect(change.data).toMatchObject({ count: 3, truncated: false });
    expect(change.data.items.map((item) => item.id)).toEqual(
      [...change.data.items.map((item) => item.id)].sort((a, b) => a - b),
    );
    expect(change.data.items).toHaveLength(3);
  });

  it('usage and transcript changes are built from the change row alone', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    const session = addSession(ctx, 1);
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      tx.changes.reserve('usage', 'invalidate', { entityId: session.id, sessionUid: session.uid });
      const seq = tx.changes.reserve('transcript', 'append', { entityId: 5, sessionUid: session.uid });
      tx.changes.noteTranscript(seq, { sizeBytes: 900, tailOffset: 850, agentUid: null });
    });
    const reader = await openStream(port, { lastEventId: '1' });
    await waitFor(() => reader.changeSeqs().length === 2);
    const [usage, transcript] = reader.of('change');
    expect(usage?.data).toMatchObject({ kind: 'usage', op: 'invalidate', data: { sessionId: session.uid } });
    expect(transcript?.data).toMatchObject({
      kind: 'transcript',
      op: 'append',
      data: { agentId: 'main', sizeBytes: 900 },
    });
  });

  it('a health change carries the health report of the moment', async () => {
    const { ctx } = await openInstance();
    const port = await serve(ctx);
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    const reader = await openStream(port, { lastEventId: '0' });
    await waitFor(() => reader.changeSeqs().length === 1);
    const change = StreamChangeSchema.parse(reader.of('change')[0]?.data);
    expect(change).toMatchObject({ kind: 'health', op: 'upsert', sessionId: null });
    if (change.kind !== 'health') throw new Error('not a health frame');
    expect(change.data.instanceId).toBe(ID);
    expect(change.data.epoch).toBe(ctx.db.epoch);
  });
});
