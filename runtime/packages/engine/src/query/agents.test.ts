// `sessionAgents`, `listAgents`, `agentNode` and `workflowRun` over a real database (03 5.3, 5.4, 6.1, 12.1): the tree order
// of one session, the cross-session filters and sorts, keyset paging, the label fallback, the workflow join and the
// transcript progress of an agent. Rows are written with plain SQL: the tests control every column the queries read.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  AgentListQuerySchema,
  AgentNodeSchema,
  RUNTIME_VERSION,
  SessionAgentsQuerySchema,
  WorkflowRunItemSchema,
  pageSchema,
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

const AgentPage = pageSchema(AgentNodeSchema);

function sessionAgentIds(ctx: InstanceContext, uid: string, params: Record<string, string> = {}): string[] {
  const page = ctx.queries.sessionAgents(ctx.scope, uid, SessionAgentsQuerySchema.parse(params));
  AgentPage.parse(page);
  return page.items.map((item) => item.id);
}

/** `<last two characters of the session id>:<agent id>` of every listed agent, in the order served. */
function listedIds(ctx: InstanceContext, params: Record<string, string> = {}): string[] {
  const page = ctx.queries.listAgents(
    ctx.scope,
    AgentListQuerySchema.parse({ includeUnmatched: '1', range: 'all', ...params }),
  );
  AgentPage.parse(page);
  return page.items.map((item) => `${item.sessionId.slice(-2)}:${item.id}`);
}

describe('sessionAgents', () => {
  it('throws NotFoundError for an unknown session', async () => {
    const { ctx } = await instance();
    expect(() => ctx.queries.sessionAgents(ctx.scope, uidOf(9), SessionAgentsQuerySchema.parse({}))).toThrow(
      NotFoundError,
    );
  });

  it('lists a session in tree order and hides internal agents unless asked', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const late = addAgent(ctx, s, 'agent-late', { started_at: NOW - 30 * MINUTE });
    addAgent(ctx, s, 'agent-early', { started_at: NOW - 50 * MINUTE });
    addAgent(ctx, s, 'agent-deep', { depth: 2, parent_agent_id: late, started_at: NOW - 55 * MINUTE });
    addAgent(ctx, s, 'agent-internal', { kind: 'internal', started_at: NOW - 40 * MINUTE });
    expect(sessionAgentIds(ctx, s.uid)).toEqual(['main', 'agent-early', 'agent-late', 'agent-deep']);
    expect(sessionAgentIds(ctx, s.uid, { includeInternal: '1' })).toEqual([
      'main',
      'agent-early',
      'agent-internal',
      'agent-late',
      'agent-deep',
    ]);
  });

  it('pages with a keyset and refuses the cursor of another filter', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    for (let i = 1; i <= 6; i += 1) addAgent(ctx, s, `agent-${String(i)}`, { started_at: NOW - (70 - i) * MINUTE });
    const served: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = ctx.queries.sessionAgents(
        ctx.scope,
        s.uid,
        SessionAgentsQuerySchema.parse({ limit: '2', ...(cursor === undefined ? {} : { cursor }) }),
      );
      served.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(served).toEqual(['main', ...Array.from({ length: 6 }, (_, i) => `agent-${String(i + 1)}`)]);
    const first = ctx.queries.sessionAgents(ctx.scope, s.uid, SessionAgentsQuerySchema.parse({ limit: '2' }));
    expect(() =>
      ctx.queries.sessionAgents(
        ctx.scope,
        s.uid,
        SessionAgentsQuerySchema.parse({ limit: '2', state: 'working', cursor: first.nextCursor ?? '' }),
      ),
    ).toThrow(QueryRefusal);
  });

  it('builds the node: parent, spawn tool, label fallback, workflow, usage and transcript progress', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const run = put(ctx, 'workflow_runs', {
      session_id: s.id,
      run_uid: 'wf_abc123',
      workflow_name: 'review',
      state: 'working',
      updated_at: NOW,
    });
    const file = put(ctx, 'transcript_files', {
      path: 'p',
      path_key: 'p',
      kind: 'workflow_agent',
      session_uid: s.uid,
      session_id: s.id,
      discovered_at: NOW,
      updated_at: NOW,
      head_end: 0,
      backfill_offset: 0,
      tail_start: 0,
      tail_offset: 50,
      size_seen: 100,
      usage_state: 'complete',
    });
    addAgent(ctx, s, 'agent-wf', {
      kind: 'workflow_agent',
      label: '',
      agent_type: 'Explore',
      spawn_tool_use_id: 'toolu_01',
      workflow_run_id: run,
      workflow_phase: 'scan',
      transcript_file_id: file,
      request_shape: 'background',
      model: 'm-big',
      state: 'working',
      tool_call_count: 3,
      error_count: 1,
      usage_messages: 2,
      tok_input: 10,
      tok_output: 20,
      tok_cache_read: 0,
      tok_cache_creation: 0,
      tok_cache_read_missing: 2,
      tok_cache_creation_missing: 2,
    });
    addAgent(ctx, s, 'agent-bare', { label: '', started_at: NOW - 10 * MINUTE });
    const nodes = ctx.queries.sessionAgents(ctx.scope, s.uid, SessionAgentsQuerySchema.parse({})).items;
    const wf = nodes.find((node) => node.id === 'agent-wf');
    expect(wf).toMatchObject({
      sessionId: s.uid,
      kind: 'workflow_agent',
      depth: 1,
      parentAgentId: 'main',
      parentToolUseId: 'toolu_01',
      agentType: 'Explore',
      label: 'Explore',
      workflow: { runId: 'wf_abc123', name: 'review', phase: 'scan', state: 'working' },
      requestShape: 'background',
      model: 'm-big',
      toolCallCount: 3,
      errorCount: 1,
      transcript: { state: 'active', sizeBytes: 100, importedBytes: 50 },
    });
    expect(wf?.usage).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: null,
      cacheCreation: null,
      total: 30,
      turns: 2,
      completeness: 'complete',
      scannedPct: 50,
    });
    expect(nodes.find((node) => node.id === 'agent-bare')).toMatchObject({
      label: 'agent-bare',
      workflow: null,
      transcript: null,
      parentAgentId: 'main',
    });
    expect(nodes.find((node) => node.id === 'main')).toMatchObject({ kind: 'main', depth: 0, parentAgentId: null });
  });
});

describe('listAgents', () => {
  async function seeded(): Promise<{ ctx: InstanceContext; a: Added; b: Added }> {
    const { ctx } = await instance();
    const project = put(ctx, 'projects', {
      project_key: 'proj-a',
      dir_name: 'proj-a',
      first_seen_at: NOW,
      last_activity_at: NOW,
    });
    const a = addSession(ctx, 1, { project_id: project });
    const b = addSession(ctx, 2, { matched: 0 });
    addAgent(ctx, a, 'agent-a1', {
      label: 'Planner',
      agent_type: 'Plan',
      state: 'working',
      last_activity_at: NOW - 3 * MINUTE,
      error_count: 2,
    });
    addAgent(ctx, a, 'agent-a2', {
      label: 'Coder',
      kind: 'teammate',
      state: 'completed',
      last_activity_at: NOW - 5 * MINUTE,
    });
    addAgent(ctx, a, 'agent-a3', { kind: 'internal', label: 'hidden', last_activity_at: NOW - 6 * MINUTE });
    addAgent(ctx, b, 'agent-b1', { label: 'Other', state: 'working', last_activity_at: NOW - 4 * MINUTE });
    return { ctx, a, b };
  }

  it('applies each filter against known answers', async () => {
    const { ctx, a } = await seeded();
    // newest activity first (a tie: the later row id first); unmatched sessions are included by the helper, internal agents are not
    expect(listedIds(ctx)).toEqual(['02:main', '01:main', '01:agent-a1', '02:agent-b1', '01:agent-a2']);
    expect(listedIds(ctx, { session: a.uid })).toEqual(['01:main', '01:agent-a1', '01:agent-a2']);
    expect(listedIds(ctx, { session: a.uid, includeInternal: '1' })).toContain('01:agent-a3');
    expect(listedIds(ctx, { session: a.uid, kind: 'teammate' })).toEqual(['01:agent-a2']);
    expect(listedIds(ctx, { session: a.uid, kind: 'internal' })).toEqual(['01:agent-a3']);
    expect(listedIds(ctx, { state: 'active' }).sort()).toEqual(['01:agent-a1', '02:agent-b1']);
    expect(listedIds(ctx, { state: 'completed' })).toEqual(['01:agent-a2']);
    expect(listedIds(ctx, { q: 'PLAN' })).toEqual(['01:agent-a1']);
    expect(listedIds(ctx, { q: 'coder' })).toEqual(['01:agent-a2']);
    expect(listedIds(ctx, { hasErrors: '1' })).toEqual(['01:agent-a1']);
    expect(listedIds(ctx, { project: 'proj-a', kind: 'subagent,teammate' })).toEqual(['01:agent-a1', '01:agent-a2']);
  });

  it('hides agents of unmatched sessions unless asked', async () => {
    const { ctx } = await seeded();
    const page = ctx.queries.listAgents(ctx.scope, AgentListQuerySchema.parse({ range: 'all' }));
    expect(page.items.some((item) => item.id === 'agent-b1')).toBe(false);
    expect(listedIds(ctx)).toContain('02:agent-b1');
  });

  it('walks both sorts and directions without a gap or a repeat', async () => {
    const { ctx } = await seeded();
    const everything = listedIds(ctx, { includeInternal: '1', limit: '200' });
    for (const sort of ['lastActivity', 'started'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const served: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = ctx.queries.listAgents(
            ctx.scope,
            AgentListQuerySchema.parse({
              includeUnmatched: '1',
              includeInternal: '1',
              range: 'all',
              sort,
              dir,
              limit: '2',
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          served.push(...page.items.map((item) => `${item.sessionId.slice(-2)}:${item.id}`));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect([...served].sort(), `${sort} ${dir}`).toEqual([...everything].sort());
        expect(new Set(served).size, `${sort} ${dir}`).toBe(served.length);
      }
    }
  });

  it('answers a node by row id and null for a row that is gone', async () => {
    const { ctx, a } = await seeded();
    expect(ctx.queries.agentNode(ctx.scope, a.agentId)).toMatchObject({ id: 'main', sessionId: a.uid });
    expect(ctx.queries.agentNode(ctx.scope, 99_999)).toBeNull();
  });
});

describe('workflowRun', () => {
  it('projects a run row into a run item and answers null for a row that is gone', async () => {
    const { ctx } = await instance();
    const s = addSession(ctx, 1);
    const run = put(ctx, 'workflow_runs', {
      session_id: s.id,
      run_uid: 'wf_run1',
      workflow_name: 'build',
      agent_count: 4,
      started_count: 3,
      result_count: 2,
      failed_count: 1,
      started_at: NOW - 5 * MINUTE,
      state: 'stale',
      stale_kind: 'silent',
      state_rule: 'W-3',
      state_evidence: '[{"source":"workflow_file","fact":"quiet","at":null}]',
      updated_seq: 7,
      updated_at: NOW,
    });
    const item = ctx.queries.workflowRun(ctx.scope, run);
    WorkflowRunItemSchema.parse(item);
    expect(item).toMatchObject({
      runId: 'wf_run1',
      seq: 7,
      sessionId: s.uid,
      name: 'build',
      agentCount: 4,
      started: 3,
      results: 2,
      failed: 1,
      endedAt: null,
    });
    expect(item?.state).toMatchObject({
      state: 'stale',
      staleKind: 'silent',
      rule: 'W-3',
      legacyState: 'UNKNOWN',
      presence: 'unknown',
    });
    expect(item?.state.evidence).toEqual([{ kind: 'workflow_file:quiet', at: null, text: 'quiet' }]);
    expect(ctx.queries.workflowRun(ctx.scope, 12_345)).toBeNull();
  });
});
