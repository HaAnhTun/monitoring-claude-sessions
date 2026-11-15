// `listSessions`, `getSession` and `sessionSummaries` over a real database (03 5.3, 5.4, 6.3): the typed filters, every sort
// in both directions, keyset paging under concurrent inserts, the frozen window, `cursor_invalid`, missing versus zero
// (DA-T-API-8), `asOfSeq` (DA-T-API-12) and the detail of one session. Rows are written with plain SQL: the query layer
// reads whatever the ingestion wrote, and the tests control every column it reads.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  LIFECYCLE_STATES,
  RUNTIME_VERSION,
  SessionDetailSchema,
  SessionSummarySchema,
  pageSchema,
  type SessionListQuery,
  SessionListQuerySchema,
  TransitionItemSchema,
  TransitionListQuerySchema,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { isDbError } from '../db/errors.ts';
import { openInstanceDb } from '../db/open.ts';
import { CostStatesRepo } from '../db/repos/cost-states.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { createSessionQueries } from './sessions.ts';
import { NO_USAGE, NotFoundError, QueryRefusal, tokenUsageOf, type FileFacts } from './transitions.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const HOUR = 3_600_000;
const ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
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

interface InstanceOptions {
  /** `user` makes the workspace the user instance (CAW design 03 2.1); absent is a task. */
  readonly kind?: 'task' | 'user';
  /** The `projects` keys of `runtime.json`. */
  readonly projects?: Readonly<Record<string, unknown>>;
}

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. */
async function instance(o: InstanceOptions = {}): Promise<{ ctx: InstanceContext; clock: FakeClock }> {
  const root = makeTemp('q-sessions').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    clock,
    newId: () => ID,
    ...(o.kind === undefined ? {} : { kind: o.kind }),
  });
  if (o.projects !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, projects: o.projects }));
  }
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

interface SessionSeed {
  n: number;
  label?: string;
  matched?: boolean;
  pinned?: boolean;
  projectId?: number | null;
  state?: string;
  presence?: string;
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number | null;
  errorCount?: number;
  tokens?: number;
  models?: string[];
  searchText?: string;
}

/** A session row with its main agent row; the defaults are a matched session active a minute ago. */
function addSession(ctx: InstanceContext, seed: SessionSeed): { id: number; uid: string; agentId: number } {
  const startedAt = seed.startedAt ?? NOW - HOUR;
  const lastActivityAt = seed.lastActivityAt ?? NOW - 60_000;
  const uid = uidOf(seed.n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    project_id: seed.projectId ?? null,
    label: seed.label ?? `session ${String(seed.n)}`,
    matched: seed.matched === false ? 0 : 1,
    pinned: seed.pinned === true ? 1 : 0,
    search_text: seed.searchText ?? `session ${String(seed.n)}`,
    models: JSON.stringify(seed.models ?? []),
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    ended_at: seed.endedAt ?? null,
    state: seed.state ?? 'working',
    presence: seed.presence ?? 'open',
    error_count: seed.errorCount ?? 0,
    tok_input: seed.tokens ?? 0,
    usage_messages: seed.tokens === undefined ? 0 : 1,
    updated_at: NOW,
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

const PageOfSessions = pageSchema(SessionSummarySchema);

function parseQuery(params: Record<string, string> = {}): SessionListQuery {
  return SessionListQuerySchema.parse({ includeUnmatched: '1', range: 'all', ...params });
}

/** Every page of a listing, following the cursors; returns the ids in the order served. */
function walk(ctx: InstanceContext, params: Record<string, string>, between?: () => void): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = ctx.queries.listSessions(
      ctx.scope,
      parseQuery({ ...params, ...(cursor === undefined ? {} : { cursor }) }),
    );
    PageOfSessions.parse(page);
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
    between?.();
  }
  throw new Error('the cursors never ended');
}

describe('listSessions: filters', () => {
  it('answers an empty page for an empty database', async () => {
    const { ctx } = await instance();
    const page = ctx.queries.listSessions(ctx.scope, parseQuery());
    expect(page).toEqual({ items: [], nextCursor: null, asOfSeq: 0, total: null, totalIsLowerBound: false, limit: 50 });
  });

  it('applies each filter alone and in pairs against a table of known answers', async () => {
    const { ctx } = await instance();
    const project = put(ctx, 'projects', {
      project_key: 'demo-app',
      dir_name: 'Demo-App',
      root_path: 'D:\\work\\demo-app',
      first_seen_at: NOW - HOUR,
      last_activity_at: NOW,
    });
    const a = addSession(ctx, {
      n: 1,
      state: 'working',
      projectId: project,
      models: ['m-big'],
      tokens: 100,
      errorCount: 2,
      searchText: 'alpha refactor',
    });
    const b = addSession(ctx, {
      n: 2,
      state: 'completed',
      presence: 'ended',
      models: ['m-small', 'm-big'],
      tokens: 500,
      searchText: 'beta cleanup',
      lastActivityAt: NOW - 2 * 60_000,
    });
    const c = addSession(ctx, {
      n: 3,
      state: 'waiting_input',
      models: [],
      tokens: 5,
      searchText: 'gamma',
      lastActivityAt: NOW - 3 * 60_000,
    });
    const d = addSession(ctx, {
      n: 4,
      state: 'stale',
      presence: 'unknown',
      matched: false,
      searchText: 'delta',
      lastActivityAt: NOW - 4 * 60_000,
    });
    put(ctx, 'work_items', {
      item_key: 'label:alpha',
      kind: 'label',
      title: 'alpha',
      state: 'working',
      rule: 'W-LBL',
      board_reason: 'B-1',
      state_since: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    put(ctx, 'work_item_sessions', { work_item_id: 1, session_id: a.id, linked_at: NOW });
    const uids = (params: Record<string, string>): string[] =>
      ctx.queries.listSessions(ctx.scope, parseQuery(params)).items.map((item) => item.id);

    expect(uids({})).toEqual([a.uid, b.uid, c.uid, d.uid]);
    expect(uids({ state: 'active' })).toEqual([a.uid]);
    expect(uids({ state: 'completed,stale' })).toEqual([b.uid, d.uid]);
    expect(uids({ presence: 'ended' })).toEqual([b.uid]);
    expect(uids({ project: 'demo-app' })).toEqual([a.uid]);
    expect(uids({ project: 'nothing' })).toEqual([]);
    expect(uids({ workItem: '1' })).toEqual([a.uid]);
    expect(uids({ model: 'm-big' })).toEqual([a.uid, b.uid]);
    expect(uids({ model: 'm-small' })).toEqual([b.uid]);
    expect(uids({ hasErrors: '1' })).toEqual([a.uid]);
    expect(uids({ tokensMin: '100', tokensMax: '500' })).toEqual([a.uid, b.uid]);
    expect(uids({ tokensMin: '101' })).toEqual([b.uid]);
    expect(uids({ q: 'ALPHA' })).toEqual([a.uid]);
    expect(uids({ q: 'cleanup' })).toEqual([b.uid]);
    expect(uids({ model: 'm-big', tokensMin: '200' })).toEqual([b.uid]);
    expect(uids({ state: 'active', hasErrors: '1', project: 'demo-app' })).toEqual([a.uid]);
    expect(uids({ state: 'active', presence: 'ended' })).toEqual([]);
    // the project of a summary: the key, and the last segment of the root path as its label
    const summary = ctx.queries.listSessions(ctx.scope, parseQuery({ project: 'demo-app' })).items[0];
    expect(summary?.projectId).toBe('demo-app');
    expect(summary?.projectLabel).toBe('demo-app');
    expect(summary?.workItemIds).toEqual([1]);
  });

  it('hides unmatched sessions unless asked or configured, and always shows pinned ones', async () => {
    const { ctx } = await instance();
    const matched = addSession(ctx, { n: 1 });
    const unmatched = addSession(ctx, { n: 2, matched: false });
    const pinned = addSession(ctx, { n: 3, matched: false, pinned: true });
    const without = ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse({ range: 'all' }));
    expect(without.items.map((item) => item.id).sort()).toEqual([matched.uid, pinned.uid].sort());
    const withFlag = ctx.queries.listSessions(
      ctx.scope,
      SessionListQuerySchema.parse({ range: 'all', includeUnmatched: '1' }),
    );
    expect(withFlag.items.map((item) => item.id)).toContain(unmatched.uid);
  });

  describe('the unmatched sessions in the scope all (CAW design 03 2.6)', () => {
    async function seeded(
      o: InstanceOptions,
    ): Promise<{ ctx: InstanceContext; ids: { matched: string; unmatched: string; pinned: string } }> {
      const { ctx } = await instance(o);
      const matched = addSession(ctx, { n: 1 });
      const unmatched = addSession(ctx, { n: 2, matched: false });
      const pinned = addSession(ctx, { n: 3, matched: false, pinned: true });
      return { ctx, ids: { matched: matched.uid, unmatched: unmatched.uid, pinned: pinned.uid } };
    }
    const listed = (ctx: InstanceContext): string[] =>
      ctx.queries
        .listSessions(ctx.scope, SessionListQuerySchema.parse({ range: 'all' }))
        .items.map((item) => item.id)
        .sort();

    it('lists them without a flag on the user instance, where projects.scope auto means all', async () => {
      const { ctx, ids } = await seeded({ kind: 'user' });
      expect(listed(ctx)).toEqual([ids.matched, ids.unmatched, ids.pinned].sort());
    });

    it('lists them on a task instance whose projects.scope says all', async () => {
      const { ctx, ids } = await seeded({ projects: { scope: 'all' } });
      expect(listed(ctx)).toEqual([ids.matched, ids.unmatched, ids.pinned].sort());
    });

    it('hides them as before on a task instance, with the default scope and with scope repo', async () => {
      for (const o of [{}, { projects: { scope: 'repo' } }, { projects: { scope: 'auto' } }] as const) {
        const { ctx, ids } = await seeded(o);
        expect(listed(ctx), JSON.stringify(o)).toEqual([ids.matched, ids.pinned].sort());
      }
    });

    it('hides them on a user instance that is pinned back to its repository', async () => {
      const { ctx, ids } = await seeded({ kind: 'user', projects: { scope: 'repo' } });
      expect(listed(ctx)).toEqual([ids.matched, ids.pinned].sort());
    });

    it('keeps `matched` and `pinned` as badges of the rows it lists', async () => {
      const { ctx, ids } = await seeded({ kind: 'user' });
      const page = ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse({ range: 'all' }));
      const rowOf = (id: string): { matched: boolean; pinned: boolean } | undefined => {
        const item = page.items.find((candidate) => candidate.id === id);
        return item === undefined ? undefined : { matched: item.matched, pinned: item.pinned };
      };
      expect(rowOf(ids.matched)).toEqual({ matched: true, pinned: false });
      expect(rowOf(ids.unmatched)).toEqual({ matched: false, pinned: false });
      expect(rowOf(ids.pinned)).toEqual({ matched: false, pinned: true });
    });
  });

  it('selects sessions by id with `session`, alone and together with another filter', async () => {
    const { ctx } = await instance();
    const a = addSession(ctx, { n: 1, state: 'working', lastActivityAt: NOW - 1 * 60_000 });
    const b = addSession(ctx, { n: 2, state: 'completed', lastActivityAt: NOW - 2 * 60_000 });
    const c = addSession(ctx, { n: 3, state: 'working', lastActivityAt: NOW - 3 * 60_000 });
    addSession(ctx, { n: 4, lastActivityAt: NOW - 4 * 60_000 });
    const uids = (params: Record<string, string>): string[] =>
      ctx.queries.listSessions(ctx.scope, parseQuery(params)).items.map((item) => item.id);
    expect(uids({ session: a.uid })).toEqual([a.uid]);
    expect(uids({ session: `${c.uid},${a.uid}` })).toEqual([a.uid, c.uid]);
    expect(uids({ session: `${a.uid},${b.uid},${c.uid}`, state: 'active' })).toEqual([a.uid, c.uid]);
    expect(uids({ session: uidOf(99) })).toEqual([]);
    // the total of the filtered set counts only those sessions
    expect(
      ctx.queries.listSessions(ctx.scope, parseQuery({ session: `${a.uid},${b.uid}`, includeTotal: '1' })).total,
    ).toBe(2);
  });

  it('serves the sessions of a terminal sidebar whatever their age: `session` with `range=all`', async () => {
    const { ctx } = await instance();
    const old = addSession(ctx, { n: 1, startedAt: NOW - 90 * HOUR, lastActivityAt: NOW - 80 * HOUR });
    addSession(ctx, { n: 2 });
    const page = ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse({ session: old.uid, range: 'all' }));
    expect(page.items.map((item) => item.id)).toEqual([old.uid]);
  });

  it('pages a `session` selection and keeps the selection in the cursor', async () => {
    const { ctx } = await instance();
    const rows = [1, 2, 3, 4, 5].map((n) => addSession(ctx, { n, lastActivityAt: NOW - n * 60_000 }));
    const wanted = [rows[0], rows[2], rows[4]].map((row) => row?.uid ?? '');
    expect(walk(ctx, { session: wanted.join(','), limit: '2' })).toEqual(wanted);
  });

  it('applies the window of `window=1` with the pinned sessions always included, and overlap for ranges', async () => {
    const { ctx } = await instance();
    const fresh = addSession(ctx, { n: 1, startedAt: NOW - 2 * HOUR, lastActivityAt: NOW - HOUR });
    const old = addSession(ctx, { n: 2, startedAt: NOW - 30 * HOUR, lastActivityAt: NOW - 20 * HOUR });
    const oldPinned = addSession(ctx, {
      n: 3,
      startedAt: NOW - 30 * HOUR,
      lastActivityAt: NOW - 20 * HOUR,
      pinned: true,
    });
    const idsOf = (params: Record<string, string>): string[] =>
      ctx.queries
        .listSessions(ctx.scope, SessionListQuerySchema.parse({ includeUnmatched: '1', ...params }))
        .items.map((item) => item.id)
        .sort();
    // the default is `window=1`: `window_hours` is 8
    expect(idsOf({})).toEqual([fresh.uid, oldPinned.uid].sort());
    expect(idsOf({ window: '1' })).toEqual([fresh.uid, oldPinned.uid].sort());
    // an explicit range is an overlap window: pinned sessions get no special treatment there
    expect(idsOf({ range: '6h' })).toEqual([fresh.uid]);
    expect(idsOf({ range: '24h' })).toEqual([fresh.uid, old.uid, oldPinned.uid].sort());
    expect(idsOf({ range: '30d' })).toEqual([fresh.uid, old.uid, oldPinned.uid].sort());
    expect(idsOf({ range: 'all' })).toEqual([fresh.uid, old.uid, oldPinned.uid].sort());
  });

  it('refuses a range and explicit bounds together, and an inverted or huge span', async () => {
    const { ctx } = await instance();
    const code = (params: Record<string, string>): string | undefined => {
      try {
        ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse(params));
        return undefined;
      } catch (error) {
        return error instanceof QueryRefusal ? error.code : 'other';
      }
    };
    expect(code({ range: '1h', from: '2026-10-11T00:00:00Z' })).toBe('range_invalid');
    expect(code({ from: '2026-10-11T10:00:00Z', to: '2026-10-11T09:00:00Z' })).toBe('range_invalid');
    expect(code({ from: '2000-01-01T00:00:00Z', to: '2026-10-11T09:00:00Z' })).toBe('range_too_large');
  });
});

describe('listSessions: paging', () => {
  const SORTS: Record<string, (s: Required<Pick<SessionSeed, 'n'>> & SessionSeed) => string | number> = {
    lastActivity: (s) => s.lastActivityAt ?? 0,
    started: (s) => s.startedAt ?? 0,
    duration: (s) => (s.endedAt ?? s.lastActivityAt ?? 0) - (s.startedAt ?? 0),
    tokens: (s) => s.tokens ?? 0,
    state: (s) => LIFECYCLE_STATES.indexOf(z.enum(LIFECYCLE_STATES).parse(s.state)),
    label: (s) => (s.label ?? '').toLowerCase(),
    errors: (s) => s.errorCount ?? 0,
  };

  function seeds(): SessionSeed[] {
    const states = ['working', 'completed', 'stale', 'running', 'failed', 'working', 'unknown'];
    return Array.from({ length: 9 }, (_, index) => ({
      n: index + 1,
      label: ['Bravo', 'alpha', 'Charlie', 'delta', 'Echo', 'alpha', 'foxtrot', 'Golf', 'hotel'][index] ?? '',
      state: states[index % states.length] ?? 'working',
      startedAt: NOW - (20 - (index % 4)) * 60_000,
      lastActivityAt: NOW - (index % 3) * 60_000 - 10_000,
      endedAt: index % 2 === 0 ? NOW - index * 1000 - 5000 : null,
      tokens: (index % 4) * 10,
      errorCount: index % 3,
    }));
  }

  it('walks every sort in both directions in one total order, ties broken by id', async () => {
    const { ctx } = await instance();
    const all = seeds();
    for (const seed of all) addSession(ctx, seed);
    for (const [sort, keyOf] of Object.entries(SORTS)) {
      for (const dir of ['asc', 'desc'] as const) {
        const expected = [...all]
          .sort((a, b) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            const byKey = ka < kb ? -1 : ka > kb ? 1 : 0;
            return (byKey !== 0 ? byKey : a.n - b.n) * (dir === 'asc' ? 1 : -1);
          })
          .map((seed) => uidOf(seed.n));
        expect(walk(ctx, { sort, dir, limit: '2' }), `${sort} ${dir}`).toEqual(expected);
      }
    }
  });

  it('pages the label sort one row at a time through labels too long for a cursor, each row once (DA-T-API-6)', async () => {
    const { ctx } = await instance();
    // 120-character CJK labels that share their first 100 characters: the sort key of a cursor must be bounded by construction
    const cjk = (tail: number): string =>
      Array.from({ length: 119 }, (_, i) => String.fromCodePoint(0x4e00 + (i < 100 ? i : tail))).join('') + 'z';
    const created = [0, 1, 2, 3, 4].map((n) => addSession(ctx, { n: n + 1, label: cjk(n) }));
    // and control characters, the widest characters of a JSON string
    const control = addSession(ctx, { n: 6, label: String.fromCharCode(1).repeat(150) });
    const expected = [...created, control].map((row) => row.uid);
    for (const dir of ['asc', 'desc'] as const) {
      const served = walk(ctx, { sort: 'label', dir, limit: '1' });
      expect(new Set(served), dir).toEqual(new Set(expected));
      expect(served, dir).toHaveLength(expected.length);
    }
    for (let cursor: string | undefined, guard = 0; guard < 10; guard += 1) {
      const page = ctx.queries.listSessions(
        ctx.scope,
        parseQuery({ sort: 'label', limit: '1', ...(cursor === undefined ? {} : { cursor }) }),
      );
      expect(page.nextCursor === null ? 0 : page.nextCursor.length).toBeLessThanOrEqual(512);
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
  });

  it('keeps every row that existed at the first page, exactly once, while rows are inserted between pages', async () => {
    const { ctx } = await instance();
    const first = Array.from({ length: 9 }, (_, i) =>
      addSession(ctx, { n: i + 1, lastActivityAt: NOW - (i + 1) * 60_000 }),
    );
    let extra = 100;
    const served = walk(ctx, { limit: '3' }, () => {
      // one newer than everything, one older than everything
      addSession(ctx, { n: (extra += 1), lastActivityAt: NOW - 1000 });
      addSession(ctx, { n: (extra += 1), lastActivityAt: NOW - 900_000 });
    });
    for (const row of first)
      expect(
        served.filter((uid) => uid === row.uid),
        row.uid,
      ).toHaveLength(1);
    expect(new Set(served).size).toBe(served.length);
    // rows that existed come in their total order
    const order = served.filter((uid) => first.some((row) => row.uid === uid));
    expect(order).toEqual(first.map((row) => row.uid));
  });

  it('freezes the window of the first page in the cursor', async () => {
    const { ctx, clock } = await instance();
    for (let i = 1; i <= 4; i += 1)
      addSession(ctx, { n: i, lastActivityAt: NOW - 7 * HOUR - i * 60_000, startedAt: NOW - 7.5 * HOUR });
    const first = ctx.queries.listSessions(
      ctx.scope,
      SessionListQuerySchema.parse({ includeUnmatched: '1', limit: '2' }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    clock.advance(3 * HOUR); // everything is now outside `window_hours`
    expect(
      ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse({ includeUnmatched: '1' })).items,
    ).toHaveLength(0);
    const second = ctx.queries.listSessions(
      ctx.scope,
      SessionListQuerySchema.parse({ includeUnmatched: '1', limit: '2', cursor: first.nextCursor ?? '' }),
    );
    expect(second.items).toHaveLength(2);
  });

  it('refuses a cursor of another sort, direction or filter, and a forged one', async () => {
    const { ctx } = await instance();
    for (let i = 1; i <= 5; i += 1) addSession(ctx, { n: i, lastActivityAt: NOW - i * 60_000 });
    const page = ctx.queries.listSessions(ctx.scope, parseQuery({ limit: '2' }));
    const cursor = page.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const refused = (params: Record<string, string>): unknown => {
      try {
        ctx.queries.listSessions(ctx.scope, parseQuery({ cursor, ...params }));
        return undefined;
      } catch (error) {
        return error instanceof QueryRefusal ? error.code : error;
      }
    };
    expect(refused({ limit: '2' })).toBeUndefined();
    expect(refused({ sort: 'started' })).toBe('cursor_invalid');
    expect(refused({ dir: 'asc' })).toBe('cursor_invalid');
    expect(refused({ state: 'working' })).toBe('cursor_invalid');
    expect(refused({ q: 'zz' })).toBe('cursor_invalid');
    expect(refused({ session: uidOf(1) })).toBe('cursor_invalid');
    expect(refused({ cursor: 'AAAA' })).toBe('cursor_invalid');
  });

  it('counts the filtered set with `includeTotal`, capped at 10000 as a lower bound', async () => {
    const { ctx } = await instance();
    for (let i = 1; i <= 7; i += 1) addSession(ctx, { n: i });
    const small = ctx.queries.listSessions(ctx.scope, parseQuery({ includeTotal: '1', limit: '2' }));
    expect(small.total).toBe(7);
    expect(small.totalIsLowerBound).toBe(false);
    // 10,050 rows in one statement
    ctx.db.driver.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1000 UNION ALL SELECT i + 1 FROM n WHERE i < 11050)
      INSERT INTO sessions (session_uid, label, matched, first_seen_at, started_at, last_activity_at, updated_at)
      SELECT printf('dddddddd-0000-4000-8000-%012x', i), 'bulk', 1, ${String(NOW)}, ${String(NOW - 5000)}, ${String(NOW - 1000)}, ${String(NOW)} FROM n`);
    const big = ctx.queries.listSessions(ctx.scope, parseQuery({ includeTotal: '1', limit: '1' }));
    expect(big.total).toBe(10_000);
    expect(big.totalIsLowerBound).toBe(true);
  });
});

describe('summaries: missing versus zero, state, freshness', () => {
  it('reads a session without assistant records as null fields and zero turns (DA-T-API-8)', async () => {
    const { ctx } = await instance();
    addSession(ctx, { n: 1 });
    const summary = ctx.queries.listSessions(ctx.scope, parseQuery()).items[0];
    expect(summary?.usage).toMatchObject({
      input: null,
      output: null,
      cacheCreation: null,
      cacheRead: null,
      total: null,
      turns: 0,
      scannedPct: null,
    });
    expect(summary?.usageInclSubagents.turns).toBe(0);
    expect(summary?.cost).toBeNull();
  });

  it('keeps a measured zero as 0 and a field that every message misses as null with `missing` = turns', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1 });
    // two messages: both have input 0 and output 7, neither has the cache fields
    ctx.db.driver
      .prepare(
        `UPDATE sessions SET usage_messages = 2, tok_input = 0, tok_output = 14, tok_cache_read = 0, tok_cache_creation = 0,
           tok_cache_read_missing = 2, tok_cache_creation_missing = 2 WHERE id = :id`,
      )
      .run({ id: s.id });
    const summary = ctx.queries.listSessions(ctx.scope, parseQuery()).items[0];
    expect(summary?.usageInclSubagents).toMatchObject({
      input: 0,
      output: 14,
      cacheRead: null,
      cacheCreation: null,
      total: 14,
      turns: 2,
      missing: { input: 0, output: 0, cacheRead: 2, cacheCreation: 2 },
    });
  });

  it('reads the own usage from the main agent rollup, apart from the totals of the session row (03 6.3)', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1 });
    // the main agent has 2 messages; the session total (with subagents) has 5
    ctx.db.driver
      .prepare(
        `UPDATE agents SET usage_messages = 2, usage_synthetic = 1, usage_unfinalized = 1, tok_input = 9, tok_output = 11,
           tok_cache_read = 0, tok_cache_creation = 0, tok_cache_read_missing = 2, tok_cache_creation_missing = 2
           WHERE session_id = :id AND agent_uid = 'main'`,
      )
      .run({ id: s.id });
    ctx.db.driver
      .prepare('UPDATE sessions SET usage_messages = 5, tok_input = 40, tok_output = 50 WHERE id = :id')
      .run({ id: s.id });
    const summary = ctx.queries.listSessions(ctx.scope, parseQuery()).items[0];
    expect(summary?.usage).toMatchObject({
      input: 9,
      output: 11,
      cacheRead: null,
      cacheCreation: null,
      total: 20,
      turns: 2,
      synthetic: 1,
      unfinalized: 1,
      missing: { input: 0, output: 0, cacheRead: 2, cacheCreation: 2 },
    });
    expect(summary?.usageInclSubagents).toMatchObject({ input: 40, output: 50, turns: 5 });
    expect(ctx.queries.getSession(ctx.scope, s.uid).usage.turns).toBe(2);
  });

  it('projects the stored view into a state assessment with rendered evidence and the legacy state', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1, state: 'waiting_tool' });
    ctx.db.driver
      .prepare(
        `UPDATE sessions SET state_rule = 'S-7c', state_basis = 'observed', state_confidence = 'high', wait_reason = 'permission',
           state_since = :since, evaluated_at = :at,
           state_evidence = :evidence WHERE id = :id`,
      )
      .run({
        id: s.id,
        since: NOW - 60_000,
        at: NOW - 1000,
        evidence: JSON.stringify([
          { source: 'hook', fact: 'permission_request', at: NOW - 30_000, value: 'Bash' },
          { source: 'nonsense', fact: 'whatever', at: null },
        ]),
      });
    const state = ctx.queries.getSession(ctx.scope, s.uid).state;
    expect(state).toMatchObject({
      state: 'waiting_tool',
      legacyState: 'RUNNING',
      rule: 'S-7c',
      basis: 'observed',
      waitReason: 'permission',
    });
    expect(state.evidence).toEqual([
      {
        kind: 'hook:permission_request',
        at: new Date(NOW - 30_000).toISOString(),
        text: 'waiting for permission (Bash) 30s ago',
      },
    ]);
  });

  it('reports freshness, file progress and the reported cost', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1 });
    ctx.db.driver
      .prepare(
        'UPDATE sessions SET last_hook_at = :h, last_transcript_at = :t, hook_coverage = :c, reported_cost_usd = 1.5, reported_cost_at = :t WHERE id = :id',
      )
      .run({ id: s.id, h: NOW - 5000, t: NOW - 4000, c: 'partial' });
    put(ctx, 'transcript_files', {
      path: 'x',
      path_key: 'x',
      kind: 'session',
      session_uid: s.uid,
      session_id: s.id,
      discovered_at: NOW,
      updated_at: NOW,
      head_end: 0,
      backfill_offset: 0,
      tail_start: 0,
      tail_offset: 600,
      size_seen: 1000,
      usage_state: 'partial',
    });
    const summary = ctx.queries.getSession(ctx.scope, s.uid);
    expect(summary.freshness).toMatchObject({
      transcriptLagBytes: 400,
      hookCoverage: 'partial',
      eventsComplete: true,
      usageComplete: false,
    });
    expect(summary.sources).toEqual({ hooks: true, transcript: true });
    expect(summary.usage.completeness).toBe('partial');
    expect(summary.usage.scannedPct).toBe(60);
    expect(summary.partial).toBe(true);
    expect(summary.reportedCost?.amountUsd).toBe(1.5);
    expect(summary.files).toEqual([
      {
        agentId: 'main',
        kind: 'session',
        state: 'active',
        sizeBytes: 1000,
        importedBytes: 600,
        behindBytes: 400,
        entries: 0,
        usageState: 'partial',
      },
    ]);
  });
});

describe('the reported cost and its trailing flag (CR-WP-28-2, 02 6.6)', () => {
  const LABEL = 'Reported by Claude Code (cumulative, not a bill)';

  it('has none for a session the provider reported no cost for', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1 });
    expect(ctx.queries.getSession(ctx.scope, s.uid).reportedCost).toBeNull();
  });

  it('shows the amount with trailing true, and keeps the amount with trailing false after a later record', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1 });
    const fileId = put(ctx, 'transcript_files', {
      path: 'x',
      path_key: 'x',
      kind: 'session',
      session_uid: s.uid,
      session_id: s.id,
      discovered_at: NOW,
      updated_at: NOW,
    });
    const costs = new CostStatesRepo(ctx.db);
    const reportedAt = NOW - 3000;
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      costs.upsert(ctx.scope, tx, {
        fileId,
        sessionId: s.id,
        totalCostUsd: 2.5,
        modelUsage: {},
        byteOffset: 800,
        isTrailing: true,
        observedAt: reportedAt,
      });
      new SessionsRepo(ctx.db).update(ctx.scope, tx, s.id, { reportedCostUsd: 2.5, reportedCostAt: reportedAt }, null);
    });
    const trailing = {
      amountUsd: 2.5,
      at: new Date(reportedAt).toISOString(),
      trailing: true,
      label: LABEL,
    };
    expect(ctx.queries.getSession(ctx.scope, s.uid).reportedCost).toEqual(trailing);
    expect(ctx.queries.sessionSummaries(ctx.scope, [s.id])[0]?.reportedCost).toEqual(trailing);

    // a record after the cost-state record: the flag goes, the amount and its time stay
    withWriteTx(ctx.db, ctx.scope, (tx) => costs.markNotTrailing(ctx.scope, tx, fileId, 900));
    expect(ctx.queries.getSession(ctx.scope, s.uid).reportedCost).toEqual({ ...trailing, trailing: false });
    expect(ctx.queries.listSessions(ctx.scope, parseQuery()).items[0]?.reportedCost).toEqual({
      ...trailing,
      trailing: false,
    });
  });
});

describe('getSession and sessionSummaries', () => {
  it('throws NotFoundError for an unknown session and returns a valid detail with asOfSeq and no audit refs', async () => {
    const { ctx } = await instance();
    expect(() => ctx.queries.getSession(ctx.scope, uidOf(99))).toThrow(NotFoundError);
    const s = addSession(ctx, { n: 1 });
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      tx.changes.reserve('session', 'upsert', { entityId: s.id, sessionUid: s.uid });
    });
    put(ctx, 'external_observations', {
      session_id: s.id,
      source: 'registry',
      observed_at: NOW - 1000,
      value_json: '{"status":"busy","pid":12}',
    });
    put(ctx, 'reconciliations', {
      session_id: s.id,
      scope_key: s.uid,
      kind: 'hook_gap',
      at: NOW - 500,
      detail: '{"missingTools":2}',
      detail_hash: 'a'.repeat(32),
    });
    const detail = ctx.queries.getSession(ctx.scope, s.uid);
    SessionDetailSchema.extend({ asOfSeq: z.number() }).parse(detail);
    expect(detail.asOfSeq).toBe(ctx.db.headSeq());
    expect(detail.asOfSeq).toBeGreaterThan(0);
    expect(detail.auditRefs).toEqual([]);
    expect(detail.external).toEqual([
      { source: 'registry', observedAt: new Date(NOW - 1000).toISOString(), value: { status: 'busy', pid: 12 } },
    ]);
    expect(detail.reconciliations).toEqual([
      { kind: 'hook_gap', at: new Date(NOW - 500).toISOString(), detail: { missingTools: 2 } },
    ]);
  });

  it('counts the messages of its files that another session owns', async () => {
    const { ctx } = await instance();
    const a = addSession(ctx, { n: 1 });
    const b = addSession(ctx, { n: 2 });
    const fileA = put(ctx, 'transcript_files', {
      path: 'a',
      path_key: 'a',
      kind: 'session',
      session_uid: a.uid,
      session_id: a.id,
      discovered_at: NOW,
      updated_at: NOW,
    });
    const fileB = put(ctx, 'transcript_files', {
      path: 'b',
      path_key: 'b',
      kind: 'session',
      session_uid: b.uid,
      session_id: b.id,
      discovered_at: NOW,
      updated_at: NOW,
    });
    for (const key of ['k1', 'k2']) {
      put(ctx, 'usage', {
        message_key: key,
        session_id: a.id,
        agent_id: a.agentId,
        owner_file_id: fileA,
        model: 'm',
        ts: NOW,
        finalized: 1,
        usage_source: 'top',
        updated_at: NOW,
      });
      put(ctx, 'usage_files', { file_id: fileA, message_key: key });
    }
    put(ctx, 'usage_files', { file_id: fileB, message_key: 'k1' }); // a resume copy of one message
    expect(ctx.queries.getSession(ctx.scope, b.uid).copiedMessages).toBe(1);
    expect(ctx.queries.getSession(ctx.scope, a.uid).copiedMessages).toBe(0);
  });

  it('answers the summaries of the rows that exist in the order asked', async () => {
    const { ctx } = await instance();
    const a = addSession(ctx, { n: 1 });
    const b = addSession(ctx, { n: 2 });
    const result = ctx.queries.sessionSummaries(ctx.scope, [b.id, 9999, a.id, b.id]);
    expect(result.map((item) => item.id)).toEqual([b.uid, a.uid]);
    z.array(SessionSummarySchema).parse(result);
    expect(ctx.queries.sessionSummaries(ctx.scope, [])).toEqual([]);
  });

  it('refuses a context of another instance', async () => {
    const { ctx } = await instance();
    let code: string | undefined;
    try {
      ctx.queries.listSessions(FOREIGN, parseQuery());
    } catch (error) {
      code = isDbError(error) ? error.code : 'other';
    }
    expect(code).toBe('scope_mismatch');
  });
});

describe('a query function never writes', () => {
  it('leaves the database file untouched', async () => {
    const { ctx } = await instance();
    addSession(ctx, { n: 1 });
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(ctx.db.driver.path);
    ctx.queries.listSessions(ctx.scope, parseQuery({ includeTotal: '1' }));
    ctx.queries.getSession(ctx.scope, uidOf(1));
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(ctx.db.driver.path).equals(before)).toBe(true);
  });
});

describe('sessionTransitions', () => {
  function seedTransitions(ctx: InstanceContext): { s: ReturnType<typeof addSession>; sub: number } {
    const s = addSession(ctx, { n: 1 });
    const sub = put(ctx, 'agents', {
      session_id: s.id,
      agent_uid: 'agent-x1',
      parent_agent_id: s.agentId,
      kind: 'subagent',
      depth: 1,
      first_seen_at: NOW,
      started_at: NOW - HOUR,
      last_activity_at: NOW,
      updated_at: NOW,
    });
    const rows: [number | null, string | null, string, number][] = [
      [null, null, 'running', NOW - 50 * 60_000],
      [null, 'running', 'working', NOW - 40 * 60_000],
      [sub, null, 'working', NOW - 40 * 60_000], // same time as the row before: the id breaks the tie
      [null, 'working', 'waiting_input', NOW - 30 * 60_000],
      [sub, 'working', 'completed', NOW - 20 * 60_000],
      [null, 'waiting_input', 'completed', NOW - 10 * 60_000],
    ];
    for (const [agentId, from, to, at] of rows) {
      put(ctx, 'state_transitions', {
        session_id: s.id,
        agent_id: agentId,
        from_state: from,
        to_state: to,
        rule: 'S-7c',
        basis: 'observed',
        confidence: 'high',
        at,
        evidence: '[{"source":"hook","fact":"stop","at":' + String(at) + '}]',
      });
    }
    return { s, sub };
  }

  it('lists the transitions newest first with rendered evidence, an agent filter and a keyset', async () => {
    const { ctx } = await instance();
    const { s } = seedTransitions(ctx);
    const page = ctx.queries.sessionTransitions(ctx.scope, s.uid, TransitionListQuerySchema.parse({}));
    pageSchema(TransitionItemSchema).parse(page);
    expect(page.items.map((item) => `${item.agentId ?? '-'}:${item.from ?? '-'}>${item.to}`)).toEqual([
      '-:waiting_input>completed',
      'agent-x1:working>completed',
      '-:working>waiting_input',
      'agent-x1:->working',
      '-:running>working',
      '-:->running',
    ]);
    expect(page.items[0]?.evidence).toEqual([
      { kind: 'hook:stop', at: new Date(NOW - 10 * 60_000).toISOString(), text: 'turn stopped 10m ago' },
    ]);
    expect(page.items[0]).toMatchObject({ rule: 'S-7c', basis: 'observed', confidence: 'high' });
    const only = ctx.queries.sessionTransitions(
      ctx.scope,
      s.uid,
      TransitionListQuerySchema.parse({ agent: 'agent-x1' }),
    );
    expect(only.items.map((item) => item.to)).toEqual(['completed', 'working']);
    const served: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const next = ctx.queries.sessionTransitions(
        ctx.scope,
        s.uid,
        TransitionListQuerySchema.parse({ limit: '2', ...(cursor === undefined ? {} : { cursor }) }),
      );
      served.push(...next.items.map((item) => item.id));
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }
    expect(served).toEqual(page.items.map((item) => item.id));
  });

  it('refuses an unknown session, an unknown agent and a cursor of another filter', async () => {
    const { ctx } = await instance();
    const { s } = seedTransitions(ctx);
    const parse = (params: Record<string, string>) => TransitionListQuerySchema.parse(params);
    expect(() => ctx.queries.sessionTransitions(ctx.scope, uidOf(9), parse({}))).toThrow(NotFoundError);
    expect(() => ctx.queries.sessionTransitions(ctx.scope, s.uid, parse({ agent: 'agent-nope' }))).toThrow(
      NotFoundError,
    );
    const cursor = ctx.queries.sessionTransitions(ctx.scope, s.uid, parse({ limit: '2' })).nextCursor ?? '';
    expect(() =>
      ctx.queries.sessionTransitions(ctx.scope, s.uid, parse({ limit: '2', agent: 'main', cursor })),
    ).toThrow(QueryRefusal);
    expect(() => ctx.queries.sessionTransitions(ctx.scope, s.uid, parse({ cursor: 'AAAA' }))).toThrow(QueryRefusal);
  });
});

describe('the token usage projection (03 8.2, DA-T-A-2)', () => {
  const file = (over: Partial<FileFacts>): FileFacts => ({
    fileId: 1,
    sessionUid: uidOf(1),
    agentUid: null,
    agentId: null,
    kind: 'session',
    state: 'active',
    usageState: 'complete',
    headEnd: 0,
    backfillOffset: 0,
    tailStart: 0,
    tailOffset: 100,
    sizeSeen: 100,
    partialBytes: 0,
    entriesTotal: 0,
    ...over,
  });
  const some = {
    ...NO_USAGE,
    messages: 3,
    input: 30,
    output: 60,
    missingCacheRead: 3,
    missingCacheCreation: 1,
    cacheCreation: 5,
  };

  it('is complete when every contributing file is complete, null for a field every message misses', () => {
    const usage = tokenUsageOf(some, [file({})]);
    expect(usage).toMatchObject({
      input: 30,
      output: 60,
      cacheRead: null,
      cacheCreation: 5,
      total: 95,
      turns: 3,
      completeness: 'complete',
      scannedPct: 100,
      lowerBound: false,
    });
    expect(usage.missing).toEqual({ input: 0, output: 0, cacheCreation: 1, cacheRead: 3 });
  });

  it('is partial with a partial file, unavailable when every file skipped its backfill, and takes the minimum scanned percent', () => {
    const partial = tokenUsageOf(some, [
      file({}),
      file({ fileId: 2, usageState: 'partial', backfillOffset: 0, tailStart: 50, tailOffset: 100, sizeSeen: 200 }),
    ]);
    expect(partial.completeness).toBe('partial');
    expect(partial.scannedPct).toBe(25); // consumed 0 + 100 - 50 = 50 of 200
    expect(partial.lowerBound).toBe(true);
    const skipped = tokenUsageOf(some, [file({ usageState: 'skipped_backfill' })]);
    expect(skipped.completeness).toBe('unavailable');
  });

  it('ignores journals and retired files, counts an unfinalized message as a lower bound and reads no messages as null', () => {
    const only = tokenUsageOf({ ...some, unfinalized: 1 }, [
      file({ kind: 'workflow_journal', usageState: 'partial' }),
      file({ fileId: 3, state: 'retired', usageState: 'partial' }),
      file({ fileId: 4 }),
    ]);
    expect(only.completeness).toBe('complete');
    expect(only.lowerBound).toBe(true);
    expect(tokenUsageOf(NO_USAGE, [])).toMatchObject({
      input: null,
      total: null,
      turns: 0,
      completeness: 'complete',
      scannedPct: null,
      lowerBound: false,
    });
  });
});

describe('a read-only connection (the CLI DbReader, DA-T-DB-16)', () => {
  it('answers the session queries and leaves the database file untouched', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, { n: 1, tokens: 5 });
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(ctx.db.driver.path);
    const reader = openInstanceDb({
      path: ctx.db.driver.path,
      expectedInstanceId: ID,
      mode: 'readonly',
      runtimeVersion: RUNTIME_VERSION,
    });
    try {
      const queries = createSessionQueries(reader, {
        config: ctx.config,
        now: () => NOW,
        audit: { entriesBetween: () => Promise.resolve([]) },
      });
      const page = queries.listSessions(ctx.scope, parseQuery({ includeTotal: '1' }));
      expect(page.items.map((item) => item.id)).toEqual([s.uid]);
      expect(page.total).toBe(1);
      expect(queries.getSession(ctx.scope, s.uid).id).toBe(s.uid);
    } finally {
      reader.close();
    }
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(ctx.db.driver.path).equals(before)).toBe(true);
  });
});
