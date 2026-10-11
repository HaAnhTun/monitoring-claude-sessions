// `workItemBoard` and `getWorkItem` (03 5.5, 6.1, 12.1; 02 7.11): the derived board read from `work_items`, with the stored
// kind spelled for the API, the evidence rendered per member, the cap of 500 with `truncated`, the member sessions of one
// item (at most 100) and `work_item_not_found`. Rows are written with plain SQL: the board derivation itself is WP-28's.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  RUNTIME_VERSION,
  SessionSummarySchema,
  WorkItemBoardQuerySchema,
  WorkItemBoardSchema,
  WorkItemSchema,
  type WorkItemBoardQuery,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { isDbError } from '../db/errors.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
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

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. */
async function instance(): Promise<InstanceContext> {
  const root = makeTemp('q-work-items').path;
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
  return ctx;
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
  state?: string;
  lastActivityAt?: number;
  tokens?: number;
  messages?: number;
}

function addSession(ctx: InstanceContext, seed: SessionSeed): { id: number; uid: string } {
  const lastActivityAt = seed.lastActivityAt ?? NOW - MINUTE;
  const startedAt = lastActivityAt - MINUTE;
  const uid = uidOf(seed.n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: seed.label ?? `session ${String(seed.n)}`,
    matched: 1,
    search_text: `session ${String(seed.n)}`,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    state: seed.state ?? 'working',
    presence: 'open',
    tok_input: seed.tokens ?? 0,
    usage_messages: seed.messages ?? (seed.tokens === undefined ? 0 : 1),
    updated_at: NOW,
  });
  return { id, uid };
}

interface ItemSeed {
  key: string;
  kind?: 'declared' | 'attempt' | 'label';
  title?: string;
  state?: string;
  rule?: string;
  boardReason?: string;
  lastActivityAt?: number | null;
  stateSince?: number;
  members?: { id: number; uid: string; state?: string }[];
  evidence?: unknown;
  seq?: number;
}

function addItem(ctx: InstanceContext, seed: ItemSeed): number {
  const members = seed.members ?? [];
  const id = put(ctx, 'work_items', {
    item_key: seed.key,
    kind: seed.kind ?? 'label',
    title: seed.title ?? seed.key,
    state: seed.state ?? 'working',
    rule: seed.rule ?? 'W-LBL',
    board_reason: seed.boardReason ?? '2',
    evidence: JSON.stringify(
      seed.evidence ?? members.map((m) => ({ sessionId: m.uid, state: m.state ?? 'working', ruleId: 'C-1' })),
    ),
    state_since: seed.stateSince ?? NOW - 10 * MINUTE,
    session_count: members.length,
    last_activity_at: seed.lastActivityAt === undefined ? NOW - MINUTE : seed.lastActivityAt,
    created_at: NOW - HOUR,
    updated_seq: seed.seq ?? 0,
    updated_at: NOW,
  });
  for (const member of members) {
    put(ctx, 'work_item_sessions', { work_item_id: id, session_id: member.id, linked_at: NOW - HOUR });
  }
  return id;
}

function board(ctx: InstanceContext, params: Record<string, string> = {}) {
  const q: WorkItemBoardQuery = WorkItemBoardQuerySchema.parse(params);
  return WorkItemBoardSchema.parse(ctx.queries.workItemBoard(ctx.scope, q));
}

function errorOf(run: () => unknown): { name: string; code: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof Error) return { name: error.name, code: String(Reflect.get(error, 'code')) };
    throw error;
  }
}

describe('workItemBoard', () => {
  it('answers an empty board with the derivation text and the change-log head', async () => {
    const ctx = await instance();
    const reply = board(ctx);
    expect(reply.items).toEqual([]);
    expect(reply.truncated).toBe(false);
    expect(reply.asOfSeq).toBe(ctx.db.headSeq());
    expect(reply.derivation).toContain('W-DECL');
    expect(reply.derivation).toContain('W-ATT');
    expect(reply.derivation).toContain('W-LBL');
  });

  it('maps a stored item to the API item (kind attempt is spelled attempts, C52)', async () => {
    const ctx = await instance();
    const a = addSession(ctx, {
      n: 1,
      label: 'part one',
      state: 'working',
      tokens: 10,
      lastActivityAt: NOW - 2 * MINUTE,
    });
    const b = addSession(ctx, {
      n: 2,
      label: 'part two',
      state: 'completed',
      tokens: 5,
      lastActivityAt: NOW - 5 * MINUTE,
    });
    addItem(ctx, {
      key: 'attempt:part-1',
      kind: 'attempt',
      title: 'Part 1',
      state: 'working',
      rule: 'W-ATT',
      boardReason: '2',
      stateSince: NOW - 20 * MINUTE,
      lastActivityAt: NOW - 2 * MINUTE,
      seq: 7,
      members: [
        { ...a, state: 'working' },
        { ...b, state: 'completed' },
      ],
    });
    const [item] = board(ctx).items;
    expect(item).toBeDefined();
    expect(WorkItemSchema.parse(item)).toMatchObject({
      key: 'attempt:part-1',
      seq: 7,
      title: 'Part 1',
      source: 'attempts',
      rule: 'W-ATT',
      state: 'working',
      boardReason: '2',
      since: new Date(NOW - 20 * MINUTE).toISOString(),
      sessionIds: [a.uid, b.uid],
      sessionCount: 2,
      lastActivityAt: new Date(NOW - 2 * MINUTE).toISOString(),
    });
    expect(item?.evidence.map((e) => e.text)).toEqual(['part one: working (C-1)', 'part two: completed (C-1)']);
    expect(item?.evidence.every((e) => e.kind === 'board:member')).toBe(true);
    // the usage of an item is the sum of the usage of its sessions, never invented
    expect(item?.usage).toMatchObject({ input: 15, output: 0, total: 15, turns: 2 });
  });

  it('spells declared and label sources and keeps a deleted member by its id', async () => {
    const ctx = await instance();
    addItem(ctx, {
      key: 'declared-1',
      kind: 'declared',
      rule: 'W-DECL',
      evidence: [{ sessionId: uidOf(99), state: 'stale', ruleId: 'S-9' }],
    });
    addItem(ctx, { key: 'label:x', kind: 'label' });
    const sources = board(ctx).items.map((item) => item.source);
    expect(sources.sort()).toEqual(['declared', 'label']);
    const declared = board(ctx).items.find((item) => item.key === 'declared-1');
    expect(declared?.evidence.map((e) => e.text)).toEqual([`${uidOf(99)}: stale (S-9)`]);
  });

  it('has no usage for an item without sessions and none invented for sessions without messages', async () => {
    const ctx = await instance();
    addItem(ctx, { key: 'label:empty' });
    const s = addSession(ctx, { n: 1 });
    addItem(ctx, { key: 'label:quiet', members: [s] });
    const byKey = new Map(board(ctx).items.map((item) => [item.key, item]));
    expect(byKey.get('label:empty')?.usage).toBeNull();
    expect(byKey.get('label:quiet')?.usage).toMatchObject({ input: null, output: null, total: null, turns: 0 });
  });

  it('reads a damaged evidence column as no evidence', async () => {
    const ctx = await instance();
    addItem(ctx, { key: 'label:damaged', evidence: { not: 'a list' } });
    expect(board(ctx).items[0]?.evidence).toEqual([]);
  });

  it('orders by the latest activity, items without activity last, ties by the newer id', async () => {
    const ctx = await instance();
    addItem(ctx, { key: 'label:old', lastActivityAt: NOW - HOUR });
    addItem(ctx, { key: 'label:none', lastActivityAt: null });
    addItem(ctx, { key: 'label:new-a', lastActivityAt: NOW - MINUTE });
    addItem(ctx, { key: 'label:new-b', lastActivityAt: NOW - MINUTE });
    expect(board(ctx).items.map((item) => item.key)).toEqual(['label:new-b', 'label:new-a', 'label:old', 'label:none']);
  });

  it('filters by state (a list) and by a text in the title or the key', async () => {
    const ctx = await instance();
    addItem(ctx, { key: 'label:alpha', title: 'Alpha release', state: 'working' });
    addItem(ctx, { key: 'label:beta', title: 'Beta', state: 'failed' });
    addItem(ctx, { key: 'declared-gamma', kind: 'declared', title: 'Gamma', state: 'waiting' });
    const keys = (params: Record<string, string>): string[] =>
      board(ctx, params)
        .items.map((item) => item.key)
        .sort();
    expect(keys({ state: 'working' })).toEqual(['label:alpha']);
    expect(keys({ state: 'failed,waiting' })).toEqual(['declared-gamma', 'label:beta']);
    expect(keys({ q: 'ALPHA' })).toEqual(['label:alpha']);
    expect(keys({ q: 'label:' })).toEqual(['label:alpha', 'label:beta']);
    expect(keys({ q: 'no such text' })).toEqual([]);
    // `%` and `_` are plain characters in a text filter
    expect(keys({ q: '%%' })).toEqual([]);
  });

  it('caps the board at 500 items and says so', async () => {
    const ctx = await instance();
    ctx.db.driver.transaction(() => {
      for (let n = 0; n < 500; n += 1) addItem(ctx, { key: `label:item-${String(n)}` });
    });
    expect(board(ctx)).toMatchObject({ truncated: false });
    expect(board(ctx).items).toHaveLength(500);
    addItem(ctx, { key: 'label:one-more' });
    const reply = board(ctx);
    expect(reply.items).toHaveLength(500);
    expect(reply.truncated).toBe(true);
  });

  it('lists at most 50 session ids and keeps the real count', async () => {
    const ctx = await instance();
    const members = Array.from({ length: 55 }, (_, n) => addSession(ctx, { n: n + 1 }));
    addItem(ctx, { key: 'label:big', members });
    const [item] = board(ctx).items;
    expect(item?.sessionIds).toHaveLength(50);
    expect(item?.sessionIds[0]).toBe(members[0]?.uid);
    expect(item?.sessionCount).toBe(55);
  });

  it('refuses a caller of another instance and never writes', async () => {
    const ctx = await instance();
    addItem(ctx, { key: 'label:a' });
    const code = (): string | undefined => {
      try {
        ctx.queries.workItemBoard(FOREIGN, WorkItemBoardQuerySchema.parse({}));
        return undefined;
      } catch (error) {
        return isDbError(error) ? error.code : 'other';
      }
    };
    expect(code()).toBe('scope_mismatch');
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(ctx.db.driver.path);
    board(ctx);
    ctx.queries.getWorkItem(ctx.scope, 1);
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(ctx.db.driver.path).equals(before)).toBe(true);
  });
});

describe('getWorkItem', () => {
  const DetailSchema = WorkItemSchema.extend({
    sessions: z.array(SessionSummarySchema).max(100),
    asOfSeq: z.number().int().min(0),
  });

  it('returns the item with its member sessions, the most recently active first', async () => {
    const ctx = await instance();
    const old = addSession(ctx, { n: 1, lastActivityAt: NOW - 3 * HOUR });
    const fresh = addSession(ctx, { n: 2, lastActivityAt: NOW - MINUTE });
    const mid = addSession(ctx, { n: 3, lastActivityAt: NOW - HOUR });
    const other = addSession(ctx, { n: 4 });
    const id = addItem(ctx, { key: 'label:shared', members: [old, fresh, mid] });
    addItem(ctx, { key: 'label:other', members: [other] });
    const detail = DetailSchema.parse(ctx.queries.getWorkItem(ctx.scope, id));
    expect(detail.key).toBe('label:shared');
    expect(detail.asOfSeq).toBe(ctx.db.headSeq());
    expect(detail.sessions.map((s) => s.id)).toEqual([fresh.uid, mid.uid, old.uid]);
    expect(detail.sessionIds.sort()).toEqual([old.uid, fresh.uid, mid.uid].sort());
  });

  it('returns at most 100 member sessions and keeps the full count', async () => {
    const ctx = await instance();
    const members = Array.from({ length: 101 }, (_, n) =>
      addSession(ctx, { n: n + 1, lastActivityAt: NOW - (n + 1) * MINUTE }),
    );
    // the stored evidence column is capped at 8 KiB, so a crowd of this size carries none
    const id = addItem(ctx, { key: 'label:crowd', members, evidence: [] });
    const detail = DetailSchema.parse(ctx.queries.getWorkItem(ctx.scope, id));
    expect(detail.sessions).toHaveLength(100);
    expect(detail.sessionCount).toBe(101);
    expect(detail.sessions[0]?.id).toBe(members[0]?.uid);
  });

  it('throws a NotFoundError with work_item_not_found for an unknown id', async () => {
    const ctx = await instance();
    expect(errorOf(() => ctx.queries.getWorkItem(ctx.scope, 12345))).toEqual({
      name: 'NotFoundError',
      code: 'work_item_not_found',
    });
  });
});
