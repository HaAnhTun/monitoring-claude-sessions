// `GET /api/v3/events` and `GET /api/v3/events/:eventId` on a real instance (03 19.3): DA-T-API-1 (strict pages and bodies),
// 6 (history paging under inserts, `around` and the live tail), 9 (`filter_requires_scope`, `scanCapped`) and the envelope of
// every error these routes raise.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  type InstanceContext,
  type Logger,
  type SqlValue,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, RUNTIME_VERSION, routes } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createApp, createHttpServer } from '../../src/app.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly clock: FakeClock;
  readonly instanceDir: string;
}

const live: { server: Server; ctx: InstanceContext; port: number }[] = [];
afterEach(async () => {
  for (const { server, ctx, port } of live.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await assertPortClosed(port);
  }
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

/** A real instance (workspace, database, query layer) behind a real HTTP server; response validation is on (registry N3). */
async function startInstance(): Promise<Running> {
  const root = makeTemp('contract-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    validateResponses: true,
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { ctx, port, clock, instanceDir: ws.dir };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

async function get(run: Running, route: string): Promise<Reply> {
  const reply = await httpRequest(run.port, route);
  return { status: reply.status, headers: reply.headers, json: JSON.parse(reply.body) };
}

/** The `error.code` of an envelope, or `undefined` for a body that is not one. */
function codeOf(reply: Reply): string | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(reply.json);
  return parsed.success ? parsed.data.error.code : undefined;
}

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
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

function addSession(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): Added {
  const startedAt = typeof over['started_at'] === 'number' ? over['started_at'] : NOW - HOUR;
  const lastActivityAt = typeof over['last_activity_at'] === 'number' ? over['last_activity_at'] : NOW - MINUTE;
  const uid = uidOf(n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: `session ${String(n)}`,
    matched: 1,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: NOW,
    ...over,
  });
  const agentId = put(ctx, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: NOW,
  });
  return { id, uid, agentId };
}

function addAgent(ctx: InstanceContext, session: Added, uid: string, over: Record<string, SqlValue> = {}): number {
  return put(ctx, 'agents', {
    session_id: session.id,
    agent_uid: uid,
    parent_agent_id: session.agentId,
    kind: 'subagent',
    depth: 1,
    first_seen_at: NOW - HOUR,
    started_at: NOW - HOUR + MINUTE,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
    ...over,
  });
}

let eventCounter = 0;

function addEvent(ctx: InstanceContext, session: Added, over: Record<string, SqlValue> = {}): number {
  eventCounter += 1;
  return put(ctx, 'events', {
    session_id: session.id,
    kind: 'tool.call',
    sources: 1,
    ts: NOW - MINUTE,
    ts_source: 'hook_received',
    received_at: NOW - MINUTE,
    event_uid: `eeeeeeee-0000-4000-8000-${eventCounter.toString(16).padStart(12, '0')}`,
    ...over,
  });
}

/** The headers every `/api` answer has (DA-T-API-10). */
function expectApiHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['x-mcs-instance']).toBe(ID);
  expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
}

const EVENTS = '/api/v3/events';

function parseEvents(reply: Reply): z.output<typeof routes.listEvents.response> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.listEvents.response.parse(reply.json);
}

describe('GET /api/v3/events', () => {
  it('answers a valid request with a strict page and the headers of every API answer', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const sub = addAgent(run.ctx, s, 'agent-x1');
    const a = addEvent(run.ctx, s, { ts: NOW - 3 * MINUTE, summary: 'first', detail: '{"k":"v"}' });
    const b = addEvent(run.ctx, s, {
      ts: NOW - 2 * MINUTE,
      agent_id: sub,
      kind: 'tool.failure',
      severity: 2,
      summary: 'second',
    });
    const reply = await get(run, EVENTS);
    const page = parseEvents(reply);
    expectApiHeaders(reply);
    expect(page.items.map((item) => item.id)).toEqual([b, a]);
    expect(page.items[1]?.details).toEqual({ k: 'v' });
    expect(page).toMatchObject({ nextCursor: null, newerCursor: null, scanCapped: false, total: null });
    expect(page.asOfSeq).toBe(run.ctx.db.headSeq());
  });

  it('walks the history newest first and oldest first while events are inserted between the requests (DA-T-API-6)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const first = Array.from({ length: 11 }, (_, i) =>
      addEvent(run.ctx, s, { ts: NOW - ((i % 4) + 1) * MINUTE, ts_rank: 70 - (i % 2) * 10 }),
    );
    for (const dir of ['desc', 'asc']) {
      const served: number[] = [];
      const extras: number[] = [];
      let cursor = '';
      for (let guard = 0; guard < 100; guard += 1) {
        const page = parseEvents(
          await get(run, `${EVENTS}?range=all&limit=3&dir=${dir}${cursor === '' ? '' : `&cursor=${cursor}`}`),
        );
        served.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        extras.push(addEvent(run.ctx, s, { ts: NOW - 1000 }), addEvent(run.ctx, s, { ts: NOW - 30 * MINUTE }));
      }
      for (const id of extras) run.ctx.db.driver.prepare('DELETE FROM events WHERE id = :id').run({ id });
      for (const id of first) {
        expect(
          served.filter((value) => value === id),
          `${dir} ${String(id)}`,
        ).toHaveLength(1);
      }
      expect(new Set(served).size, dir).toBe(served.length);
    }
  });

  it('serves `around` with both cursors and the live tail `afterId`', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const made = Array.from({ length: 15 }, (_, i) => addEvent(run.ctx, s, { ts: NOW - (20 - i) * MINUTE }));
    const pivot = made[7] ?? 0;
    const around = parseEvents(await get(run, `${EVENTS}?range=all&around=${String(pivot)}&limit=5`));
    expect(around.items.map((item) => item.id)).toEqual([made[9], made[8], made[7], made[6], made[5]]);
    expect(around.nextCursor).not.toBeNull();
    expect(around.newerCursor).not.toBeNull();
    const older = parseEvents(await get(run, `${EVENTS}?range=all&limit=5&cursor=${around.nextCursor ?? ''}`));
    expect(older.items[0]?.id).toBe(made[4]);
    const newer = parseEvents(await get(run, `${EVENTS}?range=all&limit=5&dir=asc&cursor=${around.newerCursor ?? ''}`));
    expect(newer.items[0]?.id).toBe(made[10]);
    const tail = parseEvents(await get(run, `${EVENTS}?range=all&afterId=${String(made[12] ?? 0)}&limit=500`));
    expect(tail.items.map((item) => item.id)).toEqual([made[13], made[14]]);
  });

  it('follows newerCursor with dir=asc to the next page, without a gap or a repeat, and refuses it without dir=asc', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const made = Array.from({ length: 15 }, (_, i) => addEvent(run.ctx, s, { ts: NOW - (20 - i) * MINUTE }));
    const around = parseEvents(await get(run, `${EVENTS}?range=all&around=${String(made[4] ?? 0)}&limit=5`));
    // the page runs newest first: made[6] .. made[2]; the newer side holds made[7] and up
    expect(around.items.map((item) => item.id)).toEqual([made[6], made[5], made[4], made[3], made[2]]);
    let cursor = around.newerCursor;
    const followed: number[] = [];
    for (let guard = 0; cursor !== null && guard < 10; guard += 1) {
      const page = parseEvents(await get(run, `${EVENTS}?range=all&limit=3&dir=asc&cursor=${cursor}`));
      followed.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    // oldest first from the event after the page, to the head of the log
    expect(followed).toEqual(made.slice(7));
    expect(new Set([...followed, ...around.items.map((item) => item.id)]).size).toBe(followed.length + 5);
    // the cursor is bound to the direction it was made for: without dir=asc it is not accepted
    const wrongDirection = await get(run, `${EVENTS}?range=all&limit=3&cursor=${around.newerCursor ?? ''}`);
    expect([wrongDirection.status, codeOf(wrongDirection)]).toEqual([400, 'cursor_invalid']);
  });

  it('keeps `q` and `tool` inside a session or a window of at most 7 days and reports the capped scan (DA-T-API-9)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvent(run.ctx, s, { summary: 'needle', tool_name: 'Bash' });
    for (const query of [
      'q=needle&range=all',
      'q=needle&range=30d',
      'tool=Bash&range=all',
      'q=needle&from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:01Z',
    ]) {
      const reply = await get(run, `${EVENTS}?${query}`);
      expect([reply.status, codeOf(reply)], query).toEqual([400, 'filter_requires_scope']);
    }
    // the default window of the events list is 24 h: narrow enough for `q`
    expect(parseEvents(await get(run, `${EVENTS}?q=needle`)).items).toHaveLength(1);
    expect(parseEvents(await get(run, `${EVENTS}?q=needle&range=7d`)).items).toHaveLength(1);
    expect(parseEvents(await get(run, `${EVENTS}?q=needle&range=all&session=${s.uid}`)).items).toHaveLength(1);
    run.ctx.db.driver.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 52000)
      INSERT INTO events (session_id, kind, sources, ts, ts_source, received_at, event_uid, summary)
      SELECT ${String(s.id)}, 'tool.call', 1, ${String(NOW - 100)} - (i % 5000) * 100, 'hook_received', ${String(NOW)},
             printf('ffffffff-0000-4000-8000-%012x', i), 'filler' FROM n`);
    const capped = parseEvents(await get(run, `${EVENTS}?q=nomatch&range=7d`));
    expect(capped.items).toEqual([]);
    expect(capped.scanCapped).toBe(true);
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    for (let i = 0; i < 4; i += 1) addEvent(run.ctx, s, { ts: NOW - i * MINUTE });
    const cursor = parseEvents(await get(run, `${EVENTS}?range=all&limit=2`)).nextCursor ?? '';
    expect(cursor).not.toBe('');
    const cases: [string, number, string][] = [
      [`${EVENTS}?range=all&limit=2&cursor=${cursor}&type=tool.call`, 400, 'cursor_invalid'],
      [`${EVENTS}?range=all&around=999999`, 404, 'event_not_found'],
      [`${EVENTS}?range=all&session=${s.uid}&agent=agent-nope`, 404, 'agent_not_found'],
      [`${EVENTS}?range=all&agent=main`, 400, 'validation_failed'],
      [`${EVENTS}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${EVENTS}?around=1&afterId=1`, 400, 'validation_failed'],
      [`${EVENTS}?range=all&around=1&cursor=${cursor}`, 400, 'validation_failed'],
      [`${EVENTS}?limit=201`, 400, 'validation_failed'],
      [`${EVENTS}?type=nope.kind`, 400, 'validation_failed'],
      [`${EVENTS}?q=a`, 400, 'query_too_short'],
      [`${EVENTS}?q=a&session=${s.uid}&range=all`, 400, 'query_too_short'],
      [`${EVENTS}?q=ab&limit=201`, 400, 'validation_failed'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
    expect((await get(run, `${EVENTS}?q=ab`)).status).toBe(200);
  });
});

describe('GET /api/v3/events/:eventId', () => {
  it('answers one event with a strict body and the asOfSeq of the head', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const id = addEvent(run.ctx, s, { summary: 'hello', change_seq: 0 });
    const reply = await get(run, `${EVENTS}/${String(id)}`);
    expect(reply.status).toBe(200);
    const body = routes.getEvent.response.parse(reply.json);
    expectApiHeaders(reply);
    expect(body).toMatchObject({ id, summary: 'hello', sessionId: s.uid, asOfSeq: run.ctx.db.headSeq() });
  });

  it('answers 404 event_not_found for an unknown event and 400 for a malformed id', async () => {
    const run = await startInstance();
    const missing = await get(run, `${EVENTS}/424242`);
    expect([missing.status, codeOf(missing)]).toEqual([404, 'event_not_found']);
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const reply = await get(run, `${EVENTS}/${bad}`);
      expect([reply.status, codeOf(reply)], bad).toEqual([400, 'validation_failed']);
    }
  });
});
