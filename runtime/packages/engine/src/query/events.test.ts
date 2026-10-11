// `listEvents`, `getEvent` and `eventsByIdRange` over a real database (03 5.3, 5.4, 6.3, 3.7 rule 2, 12.1): history paging in
// one total order, `around` and the live tail, the typed filters (also against the shared predicate `matchesEventFilter`
// on 1,000 seeded random filters, DA-T-API-7), `filter_requires_scope` and `scanCapped` (DA-T-API-9), and the mapping of a
// stored row to an `ActivityEvent`. Rows are written with plain SQL: the tests control every column the queries read.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ActivityEventSchema,
  CATEGORY_OF,
  EVENT_KINDS,
  EventListQuerySchema,
  EventPageSchema,
  RUNTIME_VERSION,
  matchesEventFilter,
  toQuery,
  type ActivityEvent,
  type EventKind,
  type EventListQuery,
  type EventMatchFilter,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { Prng } from '../../test/support/prng.ts';
import { NotFoundError, QueryRefusal } from './transitions.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';
const opened: InstanceContext[] = [];
afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.db.close();
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

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. */
async function instance(): Promise<{ ctx: InstanceContext; clock: FakeClock }> {
  const root = makeTemp('q-part').path;
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
  opened.push(ctx);
  return { ctx, clock };
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
  /** `agents.id` of the main agent. */
  readonly agentId: number;
}

/** A session row with its main agent row; matched, last active a minute ago. */
function addSession(
  ctx: InstanceContext,
  n: number,
  over: Record<string, SqlValue> = {},
  mainOver: Record<string, SqlValue> = {},
): Added {
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
    ...mainOver,
  });
  return { id, uid, agentId };
}

/** A non-main agent row of a session (`over` overrides any column). */
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

/** An event row of a session (`over` overrides any column); the defaults are a hook `tool.call` a minute ago. */
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

function query(params: Record<string, string> = {}): EventListQuery {
  return EventListQuerySchema.parse({ ...(params['from'] === undefined ? { range: 'all' } : {}), ...params });
}

function ids(ctx: InstanceContext, params: Record<string, string> = {}): number[] {
  const page = ctx.queries.listEvents(ctx.scope, query(params));
  EventPageSchema.parse(page);
  return page.items.map((item) => item.id);
}

function refusal(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof QueryRefusal) return error.code;
    if (error instanceof NotFoundError) return error.code;
    throw error;
  }
}

describe('history pages', () => {
  it('walks the events newest first in one total order of (ts, ts_rank, id), in both directions', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const made: { id: number; ts: number; rank: number }[] = [];
    for (let i = 0; i < 23; i += 1) {
      const ts = NOW - (i % 5) * MINUTE; // many ties on ts
      const rank = [70, 20, 90][i % 3] ?? 70;
      made.push({ id: addEvent(ctx, s, { ts, ts_rank: rank }), ts, rank });
    }
    const compare = (a: (typeof made)[number], b: (typeof made)[number]): number =>
      a.ts - b.ts || a.rank - b.rank || a.id - b.id;
    const newestFirst = [...made].sort((a, b) => compare(b, a)).map((row) => row.id);
    for (const dir of ['desc', 'asc'] as const) {
      const served: number[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 30; guard += 1) {
        const page = ctx.queries.listEvents(
          ctx.scope,
          query({ dir, limit: '4', ...(cursor === undefined ? {} : { cursor }) }),
        );
        served.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(served, dir).toEqual(dir === 'desc' ? newestFirst : [...newestFirst].reverse());
    }
  });

  it('keeps every row that existed at the first page, exactly once, while events are inserted between pages', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const first = Array.from({ length: 10 }, (_, i) => addEvent(ctx, s, { ts: NOW - (i + 1) * MINUTE }));
    const served: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = ctx.queries.listEvents(
        ctx.scope,
        query({ limit: '3', ...(cursor === undefined ? {} : { cursor }) }),
      );
      served.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      addEvent(ctx, s, { ts: NOW - 1000 }); // newer than everything
      addEvent(ctx, s, { ts: NOW - 20 * MINUTE }); // older than everything
    }
    for (const id of first)
      expect(
        served.filter((value) => value === id),
        String(id),
      ).toHaveLength(1);
    expect(new Set(served).size).toBe(served.length);
    expect(served.filter((id) => first.includes(id))).toEqual(first);
  });

  it('refuses a cursor of another filter, direction or a forged one', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    for (let i = 0; i < 6; i += 1) addEvent(ctx, s, { ts: NOW - i * MINUTE });
    const cursor = ctx.queries.listEvents(ctx.scope, query({ limit: '2' })).nextCursor ?? '';
    expect(cursor).not.toBe('');
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ limit: '2', cursor })))).toBeUndefined();
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ limit: '2', cursor, type: 'tool.call' })))).toBe(
      'cursor_invalid',
    );
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ limit: '2', cursor, dir: 'asc' })))).toBe(
      'cursor_invalid',
    );
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ cursor: 'AAAA' })))).toBe('cursor_invalid');
  });
});

describe('around and the live tail', () => {
  it('serves the page whose middle is the event, with cursors toward older and newer events', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const made = Array.from({ length: 21 }, (_, i) => addEvent(ctx, s, { ts: NOW - (30 - i) * MINUTE })); // oldest first
    const newestFirst = [...made].reverse();
    const pivot = made[10] ?? 0;
    const page = ctx.queries.listEvents(ctx.scope, query({ around: String(pivot), limit: '7' }));
    EventPageSchema.parse(page);
    expect(page.items.map((item) => item.id)).toEqual(
      newestFirst.slice(newestFirst.indexOf(pivot) - 3, newestFirst.indexOf(pivot) + 4),
    );
    expect(page.nextCursor).not.toBeNull();
    expect(page.newerCursor).not.toBeNull();
    // older: the desc cursor continues below the page
    const older = ctx.queries.listEvents(ctx.scope, query({ limit: '7', cursor: page.nextCursor ?? '' }));
    expect(older.items.map((item) => item.id)[0]).toBe(newestFirst[newestFirst.indexOf(pivot) + 4]);
    // newer: the asc cursor continues above the page
    const newer = ctx.queries.listEvents(ctx.scope, query({ limit: '7', dir: 'asc', cursor: page.newerCursor ?? '' }));
    expect(newer.items.map((item) => item.id)[0]).toBe(newestFirst[newestFirst.indexOf(pivot) - 4]);
  });

  it('puts the spare room on the other side when the event is near an end, and fails when it does not match', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const made = Array.from({ length: 12 }, (_, i) =>
      addEvent(ctx, s, { ts: NOW - (20 - i) * MINUTE, kind: i === 0 ? 'prompt.submit' : 'tool.call' }),
    );
    const newest = made[made.length - 1] ?? 0;
    const page = ctx.queries.listEvents(ctx.scope, query({ around: String(newest), limit: '5' }));
    expect(page.items[0]?.id).toBe(newest);
    expect(page.items).toHaveLength(5);
    expect(page.newerCursor).toBeNull();
    expect(
      refusal(() => ctx.queries.listEvents(ctx.scope, query({ around: String(newest), type: 'prompt.submit' }))),
    ).toBe('event_not_found');
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ around: '99999' })))).toBe('event_not_found');
  });

  it('serves the live tail ascending by id, at most 500 rows', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const made = Array.from({ length: 8 }, (_, i) => addEvent(ctx, s, { ts: NOW - (10 - i) * MINUTE }));
    const tail = ctx.queries.listEvents(ctx.scope, query({ afterId: String(made[2] ?? 0), limit: '500' }));
    expect(tail.items.map((item) => item.id)).toEqual(made.slice(3));
    expect(tail.nextCursor).toBeNull();
    const none = ctx.queries.listEvents(ctx.scope, query({ afterId: String(made[7] ?? 0) }));
    expect(none.items).toEqual([]);
  });
});

describe('filters', () => {
  it('applies each filter against known answers', async () => {
    const { ctx } = await instance();
    const project = put(ctx, 'projects', {
      project_key: 'proj-a',
      dir_name: 'proj-a',
      first_seen_at: NOW,
      last_activity_at: NOW,
    });
    const a = addSession(ctx, 1, { project_id: project });
    const b = addSession(ctx, 2);
    const sub = addAgent(ctx, a, 'agent-x1', { label: 'Planner' });
    put(ctx, 'work_items', {
      item_key: 'label:a',
      kind: 'label',
      title: 'a',
      state: 'working',
      rule: 'W-LBL',
      board_reason: 'B-1',
      state_since: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    put(ctx, 'work_item_sessions', { work_item_id: 1, session_id: a.id, linked_at: NOW });
    put(ctx, 'tool_calls', {
      session_id: a.id,
      agent_id: a.agentId,
      tool_use_id: 'toolu_1',
      name: 'Bash',
      started_at: NOW - 5 * MINUTE,
      updated_at: NOW,
    });
    put(ctx, 'tool_calls', {
      session_id: b.id,
      agent_id: b.agentId,
      tool_use_id: 'toolu_2',
      name: 'Read',
      started_at: NOW - 4 * MINUTE,
      updated_at: NOW,
    });
    const e1 = addEvent(ctx, a, {
      kind: 'tool.call',
      ts: NOW - 5 * MINUTE,
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      summary: 'run the tests',
      agent_id: a.agentId,
    });
    const e2 = addEvent(ctx, a, {
      kind: 'tool.failure',
      severity: 2,
      ts: NOW - 4 * MINUTE,
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      summary: 'exit 1',
      agent_id: sub,
    });
    const e3 = addEvent(ctx, b, { kind: 'prompt.submit', ts: NOW - 3 * MINUTE, summary: 'Hello World' });
    const e4 = addEvent(ctx, b, {
      kind: 'tool.call',
      ts: NOW - 2 * MINUTE,
      tool_use_id: 'toolu_2',
      tool_name: 'Read',
      summary: 'read the file',
      severity: 1,
    });
    const e5 = addEvent(ctx, b, { kind: 'turn.stop', ts: NOW - 40 * 60 * MINUTE });
    expect(ids(ctx, { range: '24h' })).toEqual([e4, e3, e2, e1]);
    expect(ids(ctx)).toEqual([e4, e3, e2, e1, e5]);
    expect(ids(ctx, { session: a.uid })).toEqual([e2, e1]);
    expect(ids(ctx, { session: `${a.uid},${b.uid}`, range: '24h' })).toEqual([e4, e3, e2, e1]);
    expect(ids(ctx, { session: a.uid, agent: 'agent-x1' })).toEqual([e2]);
    expect(ids(ctx, { session: a.uid, agent: 'main' })).toEqual([e1]);
    expect(ids(ctx, { type: 'tool.call,turn.stop' })).toEqual([e4, e1, e5]);
    expect(ids(ctx, { category: 'tool', range: '24h' })).toEqual([e4, e2, e1]);
    expect(ids(ctx, { category: 'tool', type: 'tool.failure', range: '24h' })).toEqual([e2]);
    expect(ids(ctx, { category: 'prompt', type: 'tool.failure' })).toEqual([]);
    expect(ids(ctx, { severity: 'error' })).toEqual([e2]);
    expect(ids(ctx, { severity: 'warning,error' })).toEqual([e4, e2]);
    expect(ids(ctx, { severity: 'info' })).toEqual([e3, e1, e5]);
    expect(ids(ctx, { project: 'proj-a' })).toEqual([e2, e1]);
    expect(ids(ctx, { workItem: '1' })).toEqual([e2, e1]);
    expect(ids(ctx, { tool: 'Bash', range: '24h' })).toEqual([e2, e1]);
    expect(ids(ctx, { tool: 'Read,Bash', range: '24h' })).toEqual([e4, e2, e1]);
    expect(ids(ctx, { q: 'HELLO', range: '24h' })).toEqual([e3]);
    expect(ids(ctx, { q: 'bash', range: '24h' })).toEqual([e2, e1]); // the tool name is searched too
    expect(ids(ctx, { q: 'the', range: '24h' })).toEqual([e4, e1]);
    expect(ids(ctx, { q: '100%', range: '24h' })).toEqual([]); // `%` is a literal
    expect(
      ids(ctx, { from: new Date(NOW - 4.5 * MINUTE).toISOString(), to: new Date(NOW - 2.5 * MINUTE).toISOString() }),
    ).toEqual([e3, e2]);
    expect(ids(ctx, { session: uidOf(99) })).toEqual([]);
  });

  it('answers 404 codes for an unknown agent and for an unknown session behind an agent', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ session: s.uid, agent: 'agent-nope' })))).toBe(
      'agent_not_found',
    );
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ session: uidOf(77), agent: 'main' })))).toBe(
      'session_not_found',
    );
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ session: uidOf(77) }), { pathSession: true }))).toBe(
      'session_not_found',
    );
  });

  it('keeps the expensive filters inside a session or a window of at most 7 days (DA-T-API-9)', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    addEvent(ctx, s, { summary: 'needle', tool_name: 'Bash' });
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ q: 'needle', range: '30d' })))).toBe(
      'filter_requires_scope',
    );
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ q: 'needle' })))).toBe('filter_requires_scope'); // all time
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ tool: 'Bash', range: 'all' })))).toBe(
      'filter_requires_scope',
    );
    expect(
      refusal(() =>
        ctx.queries.listEvents(
          ctx.scope,
          query({ q: 'needle', from: '2026-10-01T00:00:00Z', to: '2026-10-09T00:00:01Z' }),
        ),
      ),
    ).toBe('filter_requires_scope'); // 8 days
    expect(refusal(() => ctx.queries.listEvents(ctx.scope, query({ q: 'needle', range: '7d' })))).toBeUndefined();
    expect(
      refusal(() => ctx.queries.listEvents(ctx.scope, query({ q: 'needle', range: 'all', session: s.uid }))),
    ).toBeUndefined();
    expect(
      refusal(() => ctx.queries.listEvents(ctx.scope, query({ q: 'needle', range: 'all' }), { pathSession: true })),
    ).toBeDefined();
  });

  it('scans at most the newest 50,000 rows of the window for `q` and says so with `scanCapped` (DA-T-API-9)', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    ctx.db.driver.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000)
      INSERT INTO events (session_id, kind, sources, ts, ts_source, received_at, event_uid, summary)
      SELECT ${String(s.id)}, 'tool.call', 1, ${String(NOW - 100)} - (i % 5000) * 100, 'hook_received', ${String(NOW)},
             printf('ffffffff-0000-4000-8000-%012x', i), 'filler ' || i FROM n`);
    const miss = ctx.queries.listEvents(ctx.scope, query({ q: 'no-such-text', range: '7d' }));
    expect(miss.items).toEqual([]);
    expect(miss.scanCapped).toBe(true);
    const few = ctx.queries.listEvents(ctx.scope, query({ q: 'filler 5999', range: '7d' }));
    expect(few.items.length).toBeGreaterThan(0);
    expect(ctx.queries.listEvents(ctx.scope, query({ range: '7d' })).scanCapped).toBe(false);
    expect(ctx.queries.listEvents(ctx.scope, query({ q: 'xx', range: '7d', session: s.uid })).scanCapped).toBe(true);
  });

  it('agrees with the shared predicate `matchesEventFilter` on 1,000 seeded random filters (DA-T-API-7)', async () => {
    const { ctx } = await instance();
    const rng = new Prng(20_261_011);
    const projects = ['proj-a', 'proj-b'].map((key) =>
      put(ctx, 'projects', { project_key: key, dir_name: key, first_seen_at: NOW, last_activity_at: NOW }),
    );
    const sessions = [
      addSession(ctx, 1, { project_id: projects[0] ?? null }),
      addSession(ctx, 2, { project_id: projects[1] ?? null }),
      addSession(ctx, 3),
    ];
    const subs = new Map<string, number>();
    for (const session of sessions.slice(0, 2)) subs.set(session.uid, addAgent(ctx, session, 'agent-x1'));
    put(ctx, 'work_items', {
      item_key: 'label:a',
      kind: 'label',
      title: 'a',
      state: 'working',
      rule: 'W-LBL',
      board_reason: 'B-1',
      state_since: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    put(ctx, 'work_item_sessions', { work_item_id: 1, session_id: sessions[0]?.id ?? 0, linked_at: NOW });
    const kinds: EventKind[] = [
      'prompt.submit',
      'tool.call',
      'tool.result',
      'tool.failure',
      'assistant.message',
      'agent.start',
      'turn.stop',
      'api.error',
    ];
    const words = ['alpha run', 'Beta check', 'gamma ray', 'café time', 'plain'];
    for (let i = 0; i < 90; i += 1) {
      const session = rng.pick(sessions);
      const kind = rng.pick(kinds);
      const toolName = kind.startsWith('tool.') ? rng.pick(['Bash', 'Read', 'Edit']) : null;
      const toolUseId = toolName === null ? null : `toolu_${String(i)}`;
      const ts = NOW - rng.range(1, 20 * 60) * MINUTE;
      if (toolName !== null && toolUseId !== null) {
        put(ctx, 'tool_calls', {
          session_id: session.id,
          agent_id: session.agentId,
          tool_use_id: toolUseId,
          name: toolName,
          started_at: ts,
          updated_at: NOW,
        });
      }
      const sub = subs.get(session.uid);
      const agentRow = sub !== undefined && rng.chance(0.4) ? sub : rng.chance(0.6) ? session.agentId : null;
      addEvent(ctx, session, {
        kind,
        severity: kind === 'tool.failure' || kind === 'api.error' ? 2 : rng.chance(0.1) ? 1 : 0,
        ts,
        agent_id: agentRow,
        tool_use_id: toolUseId,
        tool_name: toolName,
        summary: rng.pick(words),
      });
    }
    const all: ActivityEvent[] = ctx.queries.listEvents(ctx.scope, query({ limit: '200', range: '24h' })).items;
    expect(all).toHaveLength(90);
    const projectOf = new Map([
      [sessions[0]?.uid ?? '', 'proj-a'],
      [sessions[1]?.uid ?? '', 'proj-b'],
    ]);
    const workItemsOf = new Map([[sessions[0]?.uid ?? '', [1]]]);
    const subset = <T>(items: readonly T[]): T[] => {
      const chosen = items.filter(() => rng.chance(0.4));
      return chosen.length === 0 ? [rng.pick(items)] : chosen;
    };
    for (let round = 0; round < 1000; round += 1) {
      const filter: Record<string, unknown> = {};
      if (rng.chance(0.4)) filter['type'] = subset(EVENT_KINDS.filter((kind) => kinds.includes(kind)));
      if (rng.chance(0.3)) filter['category'] = subset([...new Set(kinds.map((kind) => CATEGORY_OF[kind]))]);
      if (rng.chance(0.3)) filter['severity'] = subset(['info', 'warning', 'error']);
      if (rng.chance(0.4)) filter['session'] = subset(sessions.map((s) => s.uid));
      const single = Array.isArray(filter['session']) && filter['session'].length === 1;
      if (single && rng.chance(0.5)) filter['agent'] = rng.pick(['main', 'agent-x1']);
      if (rng.chance(0.2)) filter['project'] = subset(['proj-a', 'proj-b']);
      if (rng.chance(0.15)) filter['workItem'] = 1;
      if (rng.chance(0.3)) filter['tool'] = subset(['Bash', 'Read', 'Edit']);
      if (rng.chance(0.3)) filter['q'] = rng.pick(['alpha', 'BETA', 'ray', 'café', 'plain', 'bash', 'zzz']);
      const timeMode = rng.next();
      if (timeMode < 0.3) filter['range'] = rng.pick(['1h', '6h', '24h']);
      else if (timeMode < 0.6) {
        const from = NOW - rng.range(60, 20 * 60) * MINUTE;
        filter['from'] = new Date(from).toISOString();
        filter['to'] = new Date(from + rng.range(30, 600) * MINUTE).toISOString();
      } else filter['range'] = '24h';
      const parsed = EventListQuerySchema.parse(toQuery({ ...filter, limit: 200 }));
      if (single && filter['agent'] !== undefined && filter['agent'] === 'agent-x1') {
        const only = sessions.find((s) => s.uid === (Array.isArray(filter['session']) ? filter['session'][0] : ''));
        if (only !== undefined && !subs.has(only.uid)) continue; // no such agent in that session: a 404, not a match
      }
      const served = ctx.queries
        .listEvents(ctx.scope, parsed)
        .items.map((item) => item.id)
        .sort((a, b) => a - b);
      const predicate: EventMatchFilter = parsed;
      const expected = all
        .filter((event) =>
          matchesEventFilter(predicate, event, {
            nowMs: NOW,
            projectIdOf: (uid) => projectOf.get(uid) ?? null,
            workItemIdsOf: (uid) => workItemsOf.get(uid) ?? [],
          }),
        )
        .map((event) => event.id)
        .sort((a, b) => a - b);
      expect(served, JSON.stringify(filter)).toEqual(expected);
    }
  });
});

describe('the row of an event', () => {
  it('maps a stored row to an ActivityEvent: key, sources, severity, tool status, duration, details and transcript reference', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1, { label: 'my task' });
    const sub = addAgent(ctx, s, 'agent-x1', { label: '', agent_type: 'Explore' });
    put(ctx, 'tool_calls', {
      session_id: s.id,
      agent_id: s.agentId,
      tool_use_id: 'toolu_1',
      name: 'Bash',
      started_at: NOW - 3000,
      ended_at: NOW - 1000,
      outcome: 'error',
      duration_ms: 2000,
      updated_at: NOW,
    });
    const file = put(ctx, 'transcript_files', {
      path: 'p',
      path_key: 'p',
      kind: 'subagent',
      session_uid: s.uid,
      session_id: s.id,
      discovered_at: NOW,
      updated_at: NOW,
    });
    const id = addEvent(ctx, s, {
      kind: 'tool.failure',
      severity: 2,
      sources: 3,
      agent_id: sub,
      entry_kind: 'result',
      hook_event: 'PostToolUseFailure',
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      summary: 'exit 1',
      detail: '{"exit_code":1,"nested":{"a":1},"ok":false}',
      file_id: file,
      byte_offset: 120,
      event_uid: null,
      natural_key: 'tool.end:toolu_1',
      change_seq: 5,
    });
    const event = ctx.queries.getEvent(ctx.scope, id);
    ActivityEventSchema.extend({ asOfSeq: z.number() }).parse(event);
    expect(event).toMatchObject({
      id,
      seq: 5,
      key: 'tool.end:toolu_1',
      sessionId: s.uid,
      sessionLabel: 'my task',
      agentId: 'agent-x1',
      agentLabel: 'Explore',
      at: new Date(NOW - MINUTE).toISOString(),
      atSource: 'hook_received',
      sources: ['hook', 'transcript'],
      source: 'hook',
      type: 'tool.failure',
      category: 'tool',
      severity: 'error',
      hookEvent: 'PostToolUseFailure',
      entryKind: 'result',
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      toolStatus: 'failed',
      durationMs: 2000,
      summary: 'exit 1',
      details: { exit_code: 1, ok: false },
      transcriptRef: { agentId: 'agent-x1', offset: 120 },
      asOfSeq: ctx.db.headSeq(),
    });
  });

  it('builds the key from the event uid or the record uuid, an empty summary and a pending status', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    put(ctx, 'tool_calls', {
      session_id: s.id,
      agent_id: s.agentId,
      tool_use_id: 'toolu_9',
      name: 'Read',
      started_at: NOW - 1000,
      updated_at: NOW,
    });
    const hook = addEvent(ctx, s, { tool_use_id: 'toolu_9', event_uid: 'abcdefab-0000-4000-8000-000000000001' });
    const record = addEvent(ctx, s, { event_uid: null, record_uuid: 'rec-1', sources: 2, ts_source: 'record' });
    expect(ctx.queries.getEvent(ctx.scope, hook)).toMatchObject({
      key: 'h:abcdefab-0000-4000-8000-000000000001',
      summary: '',
      toolStatus: 'pending',
      details: {},
      transcriptRef: null,
    });
    expect(ctx.queries.getEvent(ctx.scope, record)).toMatchObject({
      key: 't:rec-1',
      sources: ['transcript'],
      source: 'transcript',
    });
  });

  it('throws event_not_found for an unknown id and answers the events of a session in an id range', async () => {
    const { ctx } = await instance();
    const a = addSession(ctx, 1);
    const b = addSession(ctx, 2);
    const made = [addEvent(ctx, a), addEvent(ctx, b), addEvent(ctx, a), addEvent(ctx, a)];
    expect(refusal(() => ctx.queries.getEvent(ctx.scope, 99_999))).toBe('event_not_found');
    const range = ctx.queries.eventsByIdRange(ctx.scope, a.id, made[0] ?? 0, made[3] ?? 0, 50);
    expect(range.map((item) => item.id)).toEqual([made[0], made[2], made[3]]);
    expect(ctx.queries.eventsByIdRange(ctx.scope, a.id, made[0] ?? 0, made[3] ?? 0, 2)).toHaveLength(2);
  });
});
