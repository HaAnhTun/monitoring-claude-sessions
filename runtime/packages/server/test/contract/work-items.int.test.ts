// `GET /api/v3/work-items` and `GET /api/v3/work-items/:workItemId` on a real instance (03 6.1, 19.3, DA-T-API-1): a strict board
// with the cap of 500, its filters, one item with its member sessions and the 404 of an unknown item.
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

/** The headers every `/api` answer has (DA-T-API-10). */
function expectApiHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['x-mcs-instance']).toBe(ID);
  expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
}

interface ItemSeed {
  readonly members?: readonly Added[];
  readonly over?: Record<string, SqlValue>;
}

function addItem(ctx: InstanceContext, key: string, seed: ItemSeed = {}): number {
  const members = seed.members ?? [];
  const id = put(ctx, 'work_items', {
    item_key: key,
    kind: 'label',
    title: key,
    state: 'working',
    rule: 'W-LBL',
    board_reason: '2',
    evidence: JSON.stringify(members.slice(0, 20).map((m) => ({ sessionId: m.uid, state: 'working', ruleId: 'C-1' }))),
    state_since: NOW - 10 * MINUTE,
    session_count: members.length,
    last_activity_at: NOW - MINUTE,
    created_at: NOW - HOUR,
    updated_at: NOW,
    ...seed.over,
  });
  for (const member of members) {
    put(ctx, 'work_item_sessions', { work_item_id: id, session_id: member.id, linked_at: NOW - HOUR });
  }
  return id;
}

const BOARD = '/api/v3/work-items';

function parseBoard(reply: Reply): ReturnType<typeof routes.workItemBoard.response.parse> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.workItemBoard.response.parse(reply.json);
}

describe('GET /api/v3/work-items', () => {
  it('answers a strict board and the headers of every API answer', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1, { label: 'part one', state: 'working', tok_input: 7, usage_messages: 1 });
    const id = addItem(run.ctx, 'label:part one', { members: [s] });
    const reply = await get(run, BOARD);
    const board = parseBoard(reply);
    expectApiHeaders(reply);
    expect(board.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(board.truncated).toBe(false);
    expect(board.derivation).toContain('W-DECL');
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ id, key: 'label:part one', source: 'label', sessionIds: [s.uid] });
    expect(board.items[0]?.evidence.map((e) => e.text)).toEqual(['part one: working (C-1)']);
    expect(board.items[0]?.usage).toMatchObject({ input: 7, total: 7, turns: 1 });
  });

  it('filters by state and by a text', async () => {
    const run = await startInstance();
    addItem(run.ctx, 'label:alpha', { over: { title: 'Alpha release' } });
    addItem(run.ctx, 'label:beta', { over: { state: 'failed' } });
    addItem(run.ctx, 'label:gamma', { over: { state: 'waiting' } });
    const keys = async (query: string): Promise<string[]> =>
      parseBoard(await get(run, `${BOARD}?${query}`))
        .items.map((item) => item.key)
        .sort();
    expect(await keys('state=failed')).toEqual(['label:beta']);
    expect(await keys('state=failed,waiting')).toEqual(['label:beta', 'label:gamma']);
    expect(await keys('q=alpha')).toEqual(['label:alpha']);
    expect(await keys('q=label&state=working')).toEqual(['label:alpha']);
  });

  it('serves at most 500 items and says that the board is cut (DA-T-API-1)', async () => {
    const run = await startInstance();
    run.ctx.db.driver.transaction(() => {
      for (let n = 0; n < 501; n += 1) addItem(run.ctx, `label:item-${String(n)}`);
    });
    const board = parseBoard(await get(run, BOARD));
    expect(board.items).toHaveLength(500);
    expect(board.truncated).toBe(true);
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const cases: [string, number][] = [
      [`${BOARD}?state=sleeping`, 400],
      [`${BOARD}?q=a`, 400],
      [`${BOARD}?state=working&state=failed`, 400],
      [`${BOARD}?limit=5`, 400],
    ];
    for (const [url, status] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply) === undefined], url).toEqual([status, false]);
    }
    expect(codeOf(await get(run, `${BOARD}?state=sleeping`))).toBe('validation_failed');
    expect(codeOf(await get(run, `${BOARD}?state=working&state=failed`))).toBe('param_repeated');
  });
});

describe('GET /api/v3/work-items/:workItemId', () => {
  it('answers the item with its member sessions, most recently active first', async () => {
    const run = await startInstance();
    const old = addSession(run.ctx, 1, { last_activity_at: NOW - 3 * HOUR, started_at: NOW - 4 * HOUR });
    const fresh = addSession(run.ctx, 2);
    const other = addSession(run.ctx, 3);
    const id = addItem(run.ctx, 'label:shared', { members: [old, fresh] });
    addItem(run.ctx, 'label:other', { members: [other] });
    const reply = await get(run, `${BOARD}/${String(id)}`);
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    expectApiHeaders(reply);
    const detail = routes.getWorkItem.response.parse(reply.json);
    expect(detail.id).toBe(id);
    expect(detail.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(detail.sessions.map((s) => s.id)).toEqual([fresh.uid, old.uid]);
    expect(detail.sessions.every((s) => s.workItemIds.includes(id))).toBe(true);
  });

  it('answers 404 work_item_not_found for an unknown item and 400 for a malformed id', async () => {
    const run = await startInstance();
    const missing = await get(run, `${BOARD}/4242`);
    expect([missing.status, codeOf(missing)]).toEqual([404, 'work_item_not_found']);
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const reply = await get(run, `${BOARD}/${bad}`);
      expect([reply.status, codeOf(reply)], bad).toEqual([400, 'validation_failed']);
    }
  });
});
