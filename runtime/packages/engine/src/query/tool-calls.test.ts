// `listToolCalls` and `toolCallsByIds` over a real database (03 5.3, 5.4, 6.1, 12.1): the derived status (03 5.5) and its filter,
// the typed filters, `filter_requires_scope` for `q`, both sorts in one total order, keyset paging under inserts, and the
// mapping of a stored row to a `ToolCallItem`. Rows are written with plain SQL: the tests control every column the query reads.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  RUNTIME_VERSION,
  ToolCallItemSchema,
  ToolCallListQuerySchema,
  pageSchema,
  type ToolCallItem,
  type ToolCallListQuery,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
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

let toolCounter = 0;

interface ToolSeed {
  name?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  batchAt?: number | null;
  outcome?: 'ok' | 'error' | 'denied' | 'interrupted' | null;
  durationMs?: number | null;
  summary?: string | null;
  agentId?: number;
  over?: Record<string, SqlValue>;
}

/** A tool call row of a session; the defaults are a `Bash` call that started a minute ago and has not ended. */
function addTool(ctx: InstanceContext, session: Added, seed: ToolSeed = {}): { id: number; toolUseId: string } {
  toolCounter += 1;
  const toolUseId = `toolu_${String(toolCounter).padStart(4, '0')}`;
  const endedAt =
    seed.endedAt === undefined
      ? seed.outcome === undefined || seed.outcome === null
        ? null
        : NOW - 1000
      : seed.endedAt;
  const id = put(ctx, 'tool_calls', {
    session_id: session.id,
    agent_id: seed.agentId ?? session.agentId,
    tool_use_id: toolUseId,
    name: seed.name ?? 'Bash',
    summary: seed.summary ?? null,
    started_at: seed.startedAt === undefined ? NOW - MINUTE : seed.startedAt,
    ended_at: endedAt,
    batch_at: seed.batchAt ?? null,
    outcome: seed.outcome ?? null,
    duration_ms: seed.durationMs ?? null,
    updated_at: NOW,
    ...(seed.over ?? {}),
  });
  return { id, toolUseId };
}

function query(params: Record<string, string> = {}): ToolCallListQuery {
  return ToolCallListQuerySchema.parse({ ...(params['from'] === undefined ? { range: 'all' } : {}), ...params });
}

function list(ctx: InstanceContext, params: Record<string, string> = {}): ToolCallItem[] {
  const page = ctx.queries.listToolCalls(ctx.scope, query(params));
  ToolPage.parse(page);
  return page.items;
}

const ToolPage = pageSchema(ToolCallItemSchema);

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

describe('status', () => {
  it('derives the status from the outcome, else pending or unknown, and the status filter agrees', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const cases = {
      succeeded: addTool(ctx, s, { outcome: 'ok' }),
      failed: addTool(ctx, s, { outcome: 'error' }),
      denied: addTool(ctx, s, { outcome: 'denied' }),
      interrupted: addTool(ctx, s, { outcome: 'interrupted' }),
      pending: addTool(ctx, s, {}),
      unknown: addTool(ctx, s, { batchAt: NOW - 500 }),
    };
    for (const [status, call] of Object.entries(cases)) {
      const items = list(ctx, { status });
      expect(
        items.map((item) => item.toolUseId),
        status,
      ).toEqual([call.toolUseId]);
      expect(items[0]?.status).toBe(status);
    }
    expect(list(ctx, { status: 'failed,denied' })).toHaveLength(2);
    expect(list(ctx)).toHaveLength(6);
  });
});

describe('listToolCalls', () => {
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
    const sub = addAgent(ctx, a, 'agent-x1');
    const t1 = addTool(ctx, a, { name: 'Bash', summary: 'npm test', startedAt: NOW - 5 * MINUTE, outcome: 'ok' });
    const t2 = addTool(ctx, a, { name: 'Read', summary: 'README.md', startedAt: NOW - 4 * MINUTE, agentId: sub });
    const t3 = addTool(ctx, b, { name: 'Bash', summary: 'git status', startedAt: NOW - 3 * MINUTE, outcome: 'error' });
    const t4 = addTool(ctx, b, { name: 'mcp__srv__lookup', startedAt: NOW - 3 * 60 * MINUTE });
    const toolIds = (params: Record<string, string>): string[] => list(ctx, params).map((item) => item.toolUseId);
    expect(toolIds({})).toEqual([t3, t2, t1, t4].map((t) => t.toolUseId));
    expect(toolIds({ session: a.uid })).toEqual([t2, t1].map((t) => t.toolUseId));
    expect(toolIds({ session: a.uid, agent: 'agent-x1' })).toEqual([t2.toolUseId]);
    expect(toolIds({ session: a.uid, agent: 'main' })).toEqual([t1.toolUseId]);
    expect(toolIds({ tool: 'Bash' })).toEqual([t3, t1].map((t) => t.toolUseId));
    expect(toolIds({ tool: 'Read,mcp__srv__lookup' })).toEqual([t2, t4].map((t) => t.toolUseId));
    expect(toolIds({ project: 'proj-a' })).toEqual([t2, t1].map((t) => t.toolUseId));
    expect(toolIds({ q: 'GIT', range: '24h' })).toEqual([t3.toolUseId]);
    expect(toolIds({ q: 'read', range: '24h' })).toEqual([t2.toolUseId]); // the name is searched too
    expect(toolIds({ range: '1h' })).toEqual([t3, t2, t1].map((t) => t.toolUseId));
    expect(toolIds({ status: 'succeeded,failed' })).toEqual([t3, t1].map((t) => t.toolUseId));
    expect(toolIds({ session: uidOf(77) })).toEqual([]);
    expect(list(ctx, { session: a.uid })[0]).toMatchObject({ sessionId: a.uid, agentId: 'agent-x1', name: 'Read' });
  });

  it('refuses an unknown agent, and the expensive `q` outside a session or a window of at most 7 days', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    addTool(ctx, s, { summary: 'needle' });
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ session: s.uid, agent: 'agent-nope' })))).toBe(
      'agent_not_found',
    );
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ session: uidOf(5), agent: 'main' })))).toBe(
      'session_not_found',
    );
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ q: 'needle' })))).toBe('filter_requires_scope');
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ q: 'needle', range: '30d' })))).toBe(
      'filter_requires_scope',
    );
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ q: 'needle', range: '7d' })))).toBeUndefined();
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ q: 'needle', session: s.uid })))).toBeUndefined();
    expect(
      refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ session: uidOf(5) }), { pathSession: true })),
    ).toBe('session_not_found');
    // a tool filter is answered by an index and needs no scope
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ tool: 'Bash' })))).toBeUndefined();
  });

  it('walks both sorts in both directions in one total order, ties broken by id', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const made = Array.from({ length: 13 }, (_, i) =>
      addTool(ctx, s, { startedAt: NOW - (i % 4) * MINUTE, durationMs: i % 3 === 0 ? null : (i % 5) * 100 }),
    );
    const startOf = (i: number): number => NOW - (i % 4) * MINUTE;
    const durationOf = (i: number): number => (i % 3 === 0 ? -1 : (i % 5) * 100);
    const keys = { started: startOf, duration: durationOf } as const;
    for (const sort of ['started', 'duration'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const expected = made
          .map((call, index) => ({ id: call.id, key: keys[sort](index) }))
          .sort((a, b) => (a.key - b.key || a.id - b.id) * (dir === 'asc' ? 1 : -1))
          .map((row) => row.id);
        const served: number[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = ctx.queries.listToolCalls(
            ctx.scope,
            query({ sort, dir, limit: '3', ...(cursor === undefined ? {} : { cursor }) }),
          );
          served.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(served, `${sort} ${dir}`).toEqual(expected);
      }
    }
  });

  it('keeps every row that existed at the first page, exactly once, while rows are inserted between pages', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const first = Array.from({ length: 9 }, (_, i) => addTool(ctx, s, { startedAt: NOW - (i + 1) * MINUTE }).id);
    const served: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = ctx.queries.listToolCalls(
        ctx.scope,
        query({ limit: '3', ...(cursor === undefined ? {} : { cursor }) }),
      );
      served.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      addTool(ctx, s, { startedAt: NOW - 1000 });
      addTool(ctx, s, { startedAt: NOW - 20 * MINUTE });
    }
    for (const id of first) expect(served.filter((value) => value === id)).toHaveLength(1);
    expect(served.filter((id) => first.includes(id))).toEqual(first);
  });

  it('refuses a cursor of another sort or filter, and a forged one', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    for (let i = 0; i < 5; i += 1) addTool(ctx, s, { startedAt: NOW - i * MINUTE });
    const cursor = ctx.queries.listToolCalls(ctx.scope, query({ limit: '2' })).nextCursor ?? '';
    expect(cursor).not.toBe('');
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ limit: '2', cursor })))).toBeUndefined();
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ limit: '2', cursor, sort: 'duration' })))).toBe(
      'cursor_invalid',
    );
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ limit: '2', cursor, tool: 'Bash' })))).toBe(
      'cursor_invalid',
    );
    expect(refusal(() => ctx.queries.listToolCalls(ctx.scope, query({ cursor: 'AAAA' })))).toBe('cursor_invalid');
  });
});

describe('the row of a tool call', () => {
  it('maps every column: sources, sub-agent, workflow run, transcript reference, duration', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const sub = addAgent(ctx, s, 'agent-x1');
    const run = put(ctx, 'workflow_runs', { session_id: s.id, run_uid: 'wf_r1', state: 'working', updated_at: NOW });
    const file = put(ctx, 'transcript_files', {
      path: 'p',
      path_key: 'p',
      kind: 'session',
      session_uid: s.uid,
      session_id: s.id,
      discovered_at: NOW,
      updated_at: NOW,
    });
    const call = addTool(ctx, s, {
      name: 'Agent',
      outcome: 'ok',
      durationMs: 1500,
      summary: 'explore',
      startedAt: NOW - 10_000,
      endedAt: NOW - 8500,
      over: {
        mcp_server: 'srv',
        prompt_id: 'p-1',
        input_bytes: 42,
        duration_source: 'hook',
        exit_code: 0,
        sources: 1 | 2 | 8,
        subagent_id: sub,
        workflow_run_id: run,
        call_file_id: file,
        call_offset: 77,
        updated_seq: 9,
      },
    });
    const [item] = list(ctx);
    ToolCallItemSchema.parse(item);
    expect(item).toMatchObject({
      id: call.id,
      seq: 9,
      toolUseId: call.toolUseId,
      sessionId: s.uid,
      agentId: 'main',
      promptId: 'p-1',
      name: 'Agent',
      mcpServer: 'srv',
      status: 'succeeded',
      outcome: 'ok',
      summary: 'explore',
      inputBytes: 42,
      startedAt: new Date(NOW - 10_000).toISOString(),
      endedAt: new Date(NOW - 8500).toISOString(),
      batchAt: null,
      durationMs: 1500,
      durationSource: 'hook',
      exitCode: 0,
      sources: ['hook_pre', 'hook_post', 'transcript_result'],
      subagentId: 'agent-x1',
      workflowRunId: 'wf_r1',
      transcriptRef: { agentId: 'main', offset: 77 },
    });
  });

  it('answers the calls that exist by id, ascending, and nothing for an empty list', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const a = addTool(ctx, s);
    const b = addTool(ctx, s);
    expect(ctx.queries.toolCallsByIds(ctx.scope, [b.id, 9999, a.id]).map((item) => item.id)).toEqual([a.id, b.id]);
    expect(ctx.queries.toolCallsByIds(ctx.scope, [])).toEqual([]);
  });

  it('lists a call without a start time by its end time and sorts it last when it has neither', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const onlyEnd = addTool(ctx, s, { startedAt: null, outcome: 'ok', endedAt: NOW - 2 * MINUTE });
    const neither = addTool(ctx, s, { startedAt: null, batchAt: NOW - 100 });
    const normal = addTool(ctx, s, { startedAt: NOW - MINUTE });
    expect(list(ctx).map((item) => item.id)).toEqual([normal.id, onlyEnd.id, neither.id]);
    // a call with neither time is outside every bounded window
    expect(list(ctx, { range: '1h' }).map((item) => item.id)).toEqual([normal.id, onlyEnd.id]);
  });
});
