// Analytics on a real instance (03 8.2-8.4, 19.6): token usage by model, session, project, work item and agent, the time series,
// the tool frequency and the cost estimate of configured prices. The data is written straight into the tables the readers
// use (the instance values of `usage`, `tool_calls`, `cost_states`), so each expectation follows from the rows above it.
//   DA-T-A-1  the worked example of 02 6.4: per session, model and instance totals are exact
//   DA-T-A-2  completeness, scannedPct (minimum over files), lowerBound and per-field null on stored files
//   DA-T-A-3  hour and day buckets at the offsets -480, 0 and +420: the buckets add up to the totals, empty ones are absent,
//             more than 2000 buckets are refused
//   DA-T-A-4  cost: no prices, no cost; the longest glob; effectiveFrom by message day; an unpriced model is listed; the
//             assumed cache write tier; synthetic messages are never priced; the reported cost is never added
//   DA-T-A-5  tool counts per derived status equal the tool-call list, pending is never failed, the median is over finished calls
//   DA-T-A-7  two instances with the same message keys: each total is its own scope
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  AnalyticsToolsQuerySchema,
  RUNTIME_VERSION,
  SeriesQuerySchema,
  SessionUsageQuerySchema,
  ToolCallListQuerySchema,
  UsageQuerySchema,
  type ToolFrequencyReport,
  type UsageReport,
  type UsageRow,
  type UsageSeries,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_BUCKETS } from '../src/analytics/series.ts';
import { MEDIAN_ROW_LIMIT } from '../src/analytics/tools.ts';
import { defaultSkillDir } from '../src/config/defaults.ts';
import type { SqlValue } from '../src/db/driver.ts';
import type { Logger } from '../src/log/logger.ts';
import { NotFoundError, QueryRefusal } from '../src/query/transitions.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
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

/** A real instance in a temp folder; `runtime` is the content of its runtime.json (the prices of the cost tests). */
async function instance(runtime?: Record<string, unknown>, id = ID): Promise<InstanceContext> {
  const root = makeTemp('analytics-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => id });
  if (runtime !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), `${JSON.stringify({ schema_version: 1, ...runtime })}\n`);
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
  return ctx;
}

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

// ---- seeding ----------------------------------------------------------------------------------------------------------------

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Sess {
  readonly id: number;
  readonly uid: string;
  readonly main: number;
  readonly n: number;
}

function addSession(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): Sess {
  const startedAt = typeof over['started_at'] === 'number' ? over['started_at'] : NOW - 2 * HOUR;
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
  const main = put(ctx, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: NOW,
  });
  return { id, uid, main, n };
}

function addAgent(ctx: InstanceContext, s: Sess, uid: string, label = ''): number {
  return put(ctx, 'agents', {
    session_id: s.id,
    parent_agent_id: s.main,
    agent_uid: uid,
    kind: 'subagent',
    depth: 1,
    label,
    first_seen_at: NOW - HOUR,
    started_at: NOW - HOUR,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
  });
}

let fileCounter = 0;
function addFile(ctx: InstanceContext, s: Sess, over: Record<string, SqlValue> = {}): number {
  fileCounter += 1;
  return put(ctx, 'transcript_files', {
    path: `f${String(fileCounter)}.jsonl`,
    path_key: `f${String(fileCounter)}.jsonl`,
    kind: 'session',
    session_uid: s.uid,
    session_id: s.id,
    discovered_at: NOW,
    updated_at: NOW,
    usage_state: 'complete',
    // a fully scanned file: head_end <= backfill_offset <= tail_start <= tail_offset <= size_seen
    size_seen: 1000,
    backfill_offset: 1000,
    tail_start: 1000,
    tail_offset: 1000,
    ...over,
  });
}

let messageCounter = 0;
interface Msg {
  readonly session: Sess;
  readonly agent?: number;
  readonly model?: string;
  readonly ts?: number;
  readonly input?: number | null;
  readonly output?: number | null;
  readonly cacheRead?: number | null;
  readonly cacheCreation?: number | null;
  /** The 5m / 1h split of the cache writes; `null` = no split. */
  readonly split?: readonly [number, number] | null;
  readonly finalized?: boolean;
  readonly synthetic?: boolean;
  readonly key?: string;
}

/** One instance value of a message key; a field left out is 0, `null` is a missing field. */
function addMessage(ctx: InstanceContext, m: Msg): void {
  messageCounter += 1;
  const field = (value: number | null | undefined): number | null => (value === undefined ? 0 : value);
  put(ctx, 'usage', {
    message_key: m.key ?? `msg_${String(messageCounter)}`,
    session_id: m.session.id,
    agent_id: m.agent ?? m.session.main,
    owner_file_id: 1,
    model: m.model ?? 'model-x',
    ts: m.ts ?? NOW - 10 * MINUTE,
    input_tokens: field(m.input),
    output_tokens: field(m.output),
    cache_read_tokens: field(m.cacheRead),
    cache_creation_tokens: field(m.cacheCreation),
    cache_creation_5m_tokens: m.split === undefined || m.split === null ? null : m.split[0],
    cache_creation_1h_tokens: m.split === undefined || m.split === null ? null : m.split[1],
    finalized: m.finalized === false ? 0 : 1,
    usage_source: 'top',
    synthetic: m.synthetic === true ? 1 : 0,
    updated_at: NOW,
  });
}

// ---- the worked example of 02 6.4 -----------------------------------------------------------------------------------------------

interface Example {
  readonly ctx: InstanceContext;
  readonly s1: Sess;
  readonly s2: Sess;
  readonly a1: number;
  readonly files: { readonly f1: number; readonly f2: number; readonly f3: number };
}

/** The instance values the example ends with: A, B, Z, the synthetic one and N in F1, C and D in F2, E in F3 (A's copy adds nothing). */
async function workedExample(runtime?: Record<string, unknown>): Promise<Example> {
  const ctx = await instance(runtime);
  const s1 = addSession(ctx, 1);
  const s2 = addSession(ctx, 2);
  const a1 = addAgent(ctx, s1, 'agent-a1b2c3', 'reviewer');
  const f1 = addFile(ctx, s1);
  const f2 = addFile(ctx, s1, { kind: 'subagent', agent_uid: 'agent-a1b2c3', agent_id: a1 });
  const f3 = addFile(ctx, s2);
  const at = (n: number): number => NOW - 30 * MINUTE + n * MINUTE;
  addMessage(ctx, {
    session: s1,
    key: 'msg_A',
    ts: at(0),
    input: 10,
    output: 200,
    cacheRead: 5000,
    cacheCreation: 1000,
    split: [0, 1000],
  });
  addMessage(ctx, {
    session: s1,
    key: 'msg_B',
    ts: at(1),
    input: 4,
    output: 50,
    cacheRead: 6000,
    cacheCreation: 0,
    split: [0, 0],
  });
  addMessage(ctx, {
    session: s1,
    key: 'msg_Z',
    ts: at(2),
    input: 2,
    output: 300,
    cacheRead: 959_572,
    cacheCreation: 4000,
    split: [0, 4000],
  });
  addMessage(ctx, {
    session: s1,
    key: 'syn',
    ts: at(3),
    model: '<synthetic>',
    synthetic: true,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  });
  addMessage(ctx, {
    session: s1,
    key: 'msg_N',
    ts: at(4),
    input: null,
    output: null,
    cacheRead: null,
    cacheCreation: null,
  });
  addMessage(ctx, {
    session: s1,
    key: 'msg_C',
    agent: a1,
    model: 'model-y',
    ts: at(5),
    input: 3,
    output: 412,
    cacheRead: 1000,
    cacheCreation: 200,
    split: [200, 0],
  });
  addMessage(ctx, {
    session: s1,
    key: 'msg_D',
    agent: a1,
    model: 'model-y',
    ts: at(6),
    input: 5,
    output: 8,
    cacheRead: 800,
    cacheCreation: 0,
    split: [0, 0],
    finalized: false,
  });
  addMessage(ctx, {
    session: s2,
    key: 'msg_E',
    ts: at(7),
    input: 6,
    output: 70,
    cacheRead: 7000,
    cacheCreation: 500,
    split: [0, 500],
  });
  return { ctx, s1, s2, a1, files: { f1, f2, f3 } };
}

/** The parameters as a query string carries them: every value is text. */
function asText(params: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

function usageOf(ctx: InstanceContext, params: Record<string, string | number> = {}): UsageReport {
  return ctx.queries.usage(ctx.scope, UsageQuerySchema.parse({ groupBy: 'none', ...asText(params) }));
}

function four(row: UsageRow): (number | null)[] {
  return [row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheCreation];
}

function rowOf(report: UsageReport, key: string): UsageRow {
  const row = report.rows.find((r) => r.key === key);
  if (row === undefined) throw new Error(`no row ${key} in ${JSON.stringify(report.rows.map((r) => r.key))}`);
  return row;
}

describe('DA-T-A-1: the worked example of 02 6.4', () => {
  it('has exact totals per session (S1 24 / 970 / 972,372 / 5,200) and for the instance (30 / 1,040 / 979,372 / 5,700)', async () => {
    const { ctx, s1, s2 } = await workedExample();
    const s1Total = usageOf(ctx, { session: s1.uid, range: 'all' }).totals;
    expect(four(s1Total)).toEqual([24, 970, 972_372, 5200]);
    expect(s1Total.usage).toMatchObject({ total: 24 + 970 + 972_372 + 5200, turns: 7, synthetic: 1, unfinalized: 1 });
    expect(s1Total.usage.missing).toEqual({ input: 1, output: 1, cacheCreation: 1, cacheRead: 1 });
    expect(s1Total.usage.lowerBound).toBe(true); // msg_D never got its final record
    expect(s1Total.sessions).toBe(1);

    expect(four(usageOf(ctx, { session: s2.uid, range: 'all' }).totals)).toEqual([6, 70, 7000, 500]);

    const instanceTotal = usageOf(ctx, { range: 'all' }).totals;
    expect(four(instanceTotal)).toEqual([30, 1040, 979_372, 5700]);
    expect(instanceTotal.usage).toMatchObject({ turns: 8, synthetic: 1 });
    expect(instanceTotal.sessions).toBe(2);
    // the default window (7 days) holds every message of the example too
    expect(four(usageOf(ctx).totals)).toEqual([30, 1040, 979_372, 5700]);
  });

  it('has exact totals per model, the synthetic message left out, and the sum of the rows equals the instance', async () => {
    const { ctx } = await workedExample();
    const report = usageOf(ctx, { groupBy: 'model', range: 'all' });
    expect(report.rows.map((r) => r.key)).toEqual(['model-x', 'model-y']); // largest first
    expect(four(rowOf(report, 'model-x'))).toEqual([22, 620, 977_572, 5500]);
    expect(rowOf(report, 'model-x').usage.turns).toBe(5);
    expect(four(rowOf(report, 'model-y'))).toEqual([8, 420, 1800, 200]);
    expect(rowOf(report, 'model-y').usage.lowerBound).toBe(true);
    expect(rowOf(report, 'model-x').usage.lowerBound).toBe(false);
    for (let i = 0; i < 4; i += 1) {
      const sum = report.rows.reduce((n, row) => n + (four(row)[i] ?? 0), 0);
      expect(sum).toBe(four(report.totals)[i]);
    }
    expect(report.rows.some((r) => r.key === '<synthetic>')).toBe(false);
    expect(report.rowsTruncated).toBe(false);
  });

  it('answers sessionUsage by agent (main 16 / 550 / 970,572 / 5,000, reviewer 8 / 420 / 1,800 / 200) and by model', async () => {
    const { ctx, s1 } = await workedExample();
    const byAgent = ctx.queries.sessionUsage(ctx.scope, s1.uid, SessionUsageQuerySchema.parse({}));
    expect(byAgent.groupBy).toBe('agent');
    expect(four(rowOf(byAgent, 'main'))).toEqual([16, 550, 970_572, 5000]);
    expect(rowOf(byAgent, 'main').label).toBe('main');
    expect(four(rowOf(byAgent, 'agent-a1b2c3'))).toEqual([8, 420, 1800, 200]);
    expect(rowOf(byAgent, 'agent-a1b2c3').label).toBe('reviewer');
    expect(four(byAgent.totals)).toEqual([24, 970, 972_372, 5200]);
    expect(byAgent.window).toEqual({ from: null, to: new Date(NOW).toISOString() });
    expect(byAgent.asOfSeq).toBe(ctx.db.headSeq());

    const byModel = ctx.queries.sessionUsage(ctx.scope, s1.uid, SessionUsageQuerySchema.parse({ groupBy: 'model' }));
    expect(four(rowOf(byModel, 'model-x'))).toEqual([16, 550, 970_572, 5000]);
    expect(four(rowOf(byModel, 'model-y'))).toEqual([8, 420, 1800, 200]);
  });

  it('answers sessionUsage for a session without a message with null fields, and an unknown session with session_not_found', async () => {
    const { ctx } = await workedExample();
    const empty = addSession(ctx, 9);
    const report = ctx.queries.sessionUsage(ctx.scope, empty.uid, SessionUsageQuerySchema.parse({}));
    expect(report.rows).toEqual([]);
    expect(report.totals.usage).toMatchObject({ input: null, output: null, total: null, turns: 0 });
    expect(() => ctx.queries.sessionUsage(ctx.scope, uidOf(404), SessionUsageQuerySchema.parse({}))).toThrow(
      NotFoundError,
    );
    try {
      ctx.queries.sessionUsage(ctx.scope, uidOf(404), SessionUsageQuerySchema.parse({}));
    } catch (error) {
      expect(error).toMatchObject({ code: 'session_not_found' });
    }
  });

  it('groups by session, agent, project and work item, and the rows name what they are', async () => {
    const { ctx, s1, s2, a1 } = await workedExample();
    const p1 = put(ctx, 'projects', {
      project_key: 'proj-one',
      dir_name: 'proj-one',
      root_path: '/work/proj-one',
      first_seen_at: NOW,
      last_activity_at: NOW,
    });
    ctx.db.driver.prepare('UPDATE sessions SET project_id = ? WHERE id IN (?, ?)').run([p1, s1.id, s2.id]);
    const item = put(ctx, 'work_items', {
      item_key: 'label:demo-item',
      kind: 'label',
      title: 'Demo item',
      state: 'working',
      rule: 'W-LBL',
      board_reason: 'working',
      state_since: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    put(ctx, 'work_item_sessions', { work_item_id: item, session_id: s2.id, linked_at: NOW });

    const bySession = usageOf(ctx, { groupBy: 'session' });
    expect(bySession.rows.map((r) => r.key)).toEqual([s1.uid, s2.uid]);
    expect(rowOf(bySession, s1.uid).label).toBe('session 1');
    expect(four(rowOf(bySession, s1.uid))).toEqual([24, 970, 972_372, 5200]);
    expect(rowOf(bySession, s2.uid).sessions).toBe(1);

    const byAgent = usageOf(ctx, { groupBy: 'agent' });
    expect(byAgent.rows.map((r) => r.key)).toEqual([`${s1.uid}/main`, `${s2.uid}/main`, `${s1.uid}/agent-a1b2c3`]);
    expect(four(rowOf(byAgent, `${s1.uid}/agent-a1b2c3`))).toEqual([8, 420, 1800, 200]);
    expect(a1).toBeGreaterThan(0);
    const onlyS1 = usageOf(ctx, { groupBy: 'agent', session: s1.uid });
    expect(onlyS1.rows.map((r) => r.key)).toEqual(['main', 'agent-a1b2c3']); // inside one session an agent id is enough

    const byProject = usageOf(ctx, { groupBy: 'project' });
    expect(byProject.rows).toHaveLength(1);
    expect(rowOf(byProject, 'proj-one')).toMatchObject({ label: 'proj-one', sessions: 2 });
    expect(four(rowOf(byProject, 'proj-one'))).toEqual([30, 1040, 979_372, 5700]);

    const byItem = usageOf(ctx, { groupBy: 'workItem' });
    expect(byItem.rows.map((r) => [r.key, r.label])).toEqual([[String(item), 'Demo item']]);
    expect(byItem.rows.map(four)).toEqual([[6, 70, 7000, 500]]); // S1 has no work item: in the totals only
    expect(four(byItem.totals)).toEqual([30, 1040, 979_372, 5700]);
    expect(four(usageOf(ctx, { workItem: item }).totals)).toEqual([6, 70, 7000, 500]);
    expect(four(usageOf(ctx, { project: 'proj-one' }).totals)).toEqual([30, 1040, 979_372, 5700]);
    expect(four(usageOf(ctx, { project: 'other-project' }).totals)).toEqual([null, null, null, null]);
    expect(four(usageOf(ctx, { model: 'model-y' }).totals)).toEqual([8, 420, 1800, 200]);
    expect(four(usageOf(ctx, { session: `${s2.uid},${s1.uid}`, model: 'model-x' }).totals)).toEqual([
      22, 620, 977_572, 5500,
    ]);
  });

  it('orders the rows by size, cuts them at limit and says so', async () => {
    const { ctx } = await workedExample();
    const report = usageOf(ctx, { groupBy: 'session', limit: 1 });
    expect(report.rows).toHaveLength(1);
    expect(report.rowsTruncated).toBe(true);
    expect(report.rows[0]?.sessions).toBe(1);
    expect(four(report.totals)).toEqual([30, 1040, 979_372, 5700]);
    expect(usageOf(ctx, { groupBy: 'none' }).rows).toEqual([]);
  });

  it('sends no text of a transcript: only labels, ids and numbers', async () => {
    const { ctx } = await workedExample();
    const text = JSON.stringify([usageOf(ctx, { groupBy: 'agent' }), usageOf(ctx, { groupBy: 'session' })]);
    expect(text).not.toMatch(/prompt|content|transcript\/|\.jsonl/);
  });
});

describe('DA-T-A-2: completeness, scannedPct, lowerBound and null fields on stored files', () => {
  it('takes scannedPct as the minimum over the contributing files and completeness from their usage state', async () => {
    const { ctx, files } = await workedExample();
    const complete = usageOf(ctx).totals.usage;
    expect(complete).toMatchObject({ completeness: 'complete', scannedPct: 100 });
    const set = (id: number, sql: string): void => {
      ctx.db.driver.prepare(`UPDATE transcript_files SET ${sql} WHERE id = ${String(id)}`).run();
    };
    set(
      files.f2,
      "usage_state = 'partial', size_seen = 1000, head_end = 0, backfill_offset = 300, tail_start = 1000, tail_offset = 1000",
    );
    set(
      files.f3,
      "usage_state = 'partial', size_seen = 1000, head_end = 0, backfill_offset = 650, tail_start = 1000, tail_offset = 1000",
    );
    const partial = usageOf(ctx).totals.usage;
    expect(partial).toMatchObject({ completeness: 'partial', scannedPct: 30, lowerBound: true });
    // a session report reads only the files of that session
    expect(usageOf(ctx, { session: uidOf(2) }).totals.usage).toMatchObject({ completeness: 'partial', scannedPct: 65 });
    expect(usageOf(ctx, { session: uidOf(1) }).totals.usage).toMatchObject({ completeness: 'partial', scannedPct: 30 });
  });

  it('is unavailable when every contributing file skipped its backfill, and ignores retired and journal files', async () => {
    const { ctx, s1 } = await workedExample();
    ctx.db.driver.prepare("UPDATE transcript_files SET usage_state = 'skipped_backfill'").run();
    expect(usageOf(ctx).totals.usage.completeness).toBe('unavailable');
    ctx.db.driver.prepare("UPDATE transcript_files SET usage_state = 'complete'").run();
    addFile(ctx, s1, { state: 'retired', usage_state: 'partial' });
    addFile(ctx, s1, { kind: 'workflow_journal', usage_state: 'partial' });
    expect(usageOf(ctx).totals.usage.completeness).toBe('complete');
  });

  it('counts the files of the sessions that overlap the window only', async () => {
    const { ctx } = await workedExample();
    const old = addSession(ctx, 7, { started_at: NOW - 40 * DAY, last_activity_at: NOW - 39 * DAY });
    addFile(ctx, old, { usage_state: 'partial' });
    addMessage(ctx, { session: old, ts: NOW - 39 * DAY, input: 1 });
    expect(usageOf(ctx, { range: '24h' }).totals.usage.completeness).toBe('complete');
    expect(usageOf(ctx, { range: 'all' }).totals.usage.completeness).toBe('partial');
  });

  it('reports a field as null when every counted message misses it and as a number when only some do', async () => {
    const ctx = await instance();
    const s = addSession(ctx, 1);
    addFile(ctx, s);
    addMessage(ctx, { session: s, input: 3, output: null, cacheRead: null, cacheCreation: 5 });
    addMessage(ctx, { session: s, input: null, output: null, cacheRead: null, cacheCreation: 6 });
    const usage = usageOf(ctx).totals.usage;
    expect([usage.input, usage.output, usage.cacheRead, usage.cacheCreation]).toEqual([3, null, null, 11]);
    expect(usage.total).toBe(14);
    expect(usage.missing).toEqual({ input: 1, output: 2, cacheCreation: 0, cacheRead: 2 });
  });

  it('answers a window without a message with null fields and no rows (never zero)', async () => {
    const { ctx } = await workedExample();
    const report = usageOf(ctx, { groupBy: 'model', range: '1h' });
    expect(report.rows.length).toBeGreaterThan(0); // the messages are 30 minutes old: inside the hour
    const none = usageOf(ctx, {
      groupBy: 'model',
      from: new Date(NOW - 10 * DAY).toISOString(),
      to: new Date(NOW - 9 * DAY).toISOString(),
    });
    expect(none.rows).toEqual([]);
    expect(none.totals.usage).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheCreation: null,
      total: null,
      turns: 0,
    });
    expect(none.totals.sessions).toBe(0);
    expect(none.cost).toBeNull();
  });
});

// ---- series -----------------------------------------------------------------------------------------------------------------

function seriesOf(ctx: InstanceContext, params: Record<string, string | number>): UsageSeries {
  return ctx.queries.series(ctx.scope, SeriesQuerySchema.parse(asText(params)));
}

function sumPoints(
  series: UsageSeries,
): Record<'input' | 'output' | 'cacheCreation' | 'cacheRead' | 'messages', number> {
  const out = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 };
  for (const p of series.points) {
    out.input += p.input;
    out.output += p.output;
    out.cacheCreation += p.cacheCreation;
    out.cacheRead += p.cacheRead;
    out.messages += p.messages;
  }
  return out;
}

describe('DA-T-A-3: the time series', () => {
  /** Messages around midnight and on both sides of a day edge for every offset, over three days. */
  async function spread(): Promise<{ ctx: InstanceContext; s: Sess }> {
    const ctx = await instance();
    const s = addSession(ctx, 1, { started_at: NOW - 6 * DAY });
    addFile(ctx, s);
    const day0 = Date.UTC(2026, 9, 9);
    const times = [
      day0 + 15 * HOUR + 59 * MINUTE + 59_999, // 15:59:59.999Z: just before 16:00Z, midnight at UTC+8
      day0 + 16 * HOUR, // 16:00Z
      day0 + 17 * HOUR, // 17:00Z: midnight at UTC-7... of the next local day at +07:00
      day0 + 23 * HOUR + 59 * MINUTE,
      day0 + DAY, // 00:00Z of the 10th
      day0 + DAY + 8 * HOUR, // 08:00Z: midnight at UTC-8
      day0 + 2 * DAY + 5 * MINUTE,
      NOW - 5 * MINUTE,
    ];
    times.forEach((ts, i) => {
      addMessage(ctx, {
        session: s,
        ts,
        input: i + 1,
        output: 10 * (i + 1),
        cacheRead: 100,
        cacheCreation: 1,
        finalized: i !== 3,
      });
    });
    return { ctx, s };
  }

  it.each([
    ['hour', -480],
    ['hour', 0],
    ['hour', 420],
    ['day', -480],
    ['day', 0],
    ['day', 420],
  ] as const)(
    'adds %s buckets at offset %i up to the totals and leaves the empty ones out',
    async (bucket, tzOffsetMinutes) => {
      const { ctx } = await spread();
      const params = { bucket, tzOffsetMinutes, range: '7d' };
      const series = seriesOf(ctx, params);
      const totals = usageOf(ctx, { range: '7d' }).totals.usage;
      const sums = sumPoints(series);
      expect(sums.input).toBe(totals.input);
      expect(sums.output).toBe(totals.output);
      expect(sums.cacheRead).toBe(totals.cacheRead);
      expect(sums.cacheCreation).toBe(totals.cacheCreation);
      expect(sums.messages).toBe(totals.turns);

      const size = bucket === 'hour' ? HOUR : DAY;
      const starts = series.points.map((p) => Date.parse(p.start));
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(new Set(starts).size).toBe(starts.length);
      for (const start of starts) expect((start + tzOffsetMinutes * MINUTE) % size).toBe(0); // on a boundary of the local clock
      expect(series.points.every((p) => p.messages > 0)).toBe(true); // empty buckets are absent
      expect(series.points.length).toBeLessThanOrEqual(8);
      expect(series.bucket).toBe(bucket);
      expect(series.tzOffsetMinutes).toBe(tzOffsetMinutes);
      expect(series.series).toBeNull();
    },
  );

  it('puts a message on the right side of the local midnight (the day edge moves with the offset)', async () => {
    const { ctx } = await spread();
    // UTC+8 (offset 480 is east; -480 as the browser reports it is west): at -480 minutes the local day starts at 08:00Z
    const west = seriesOf(ctx, { bucket: 'day', tzOffsetMinutes: -480, range: '7d' });
    const first = west.points[0];
    expect(first?.start).toBe(new Date(Date.UTC(2026, 9, 9, 8)).toISOString());
    const east = seriesOf(ctx, { bucket: 'day', tzOffsetMinutes: 420, range: '7d' });
    expect(east.points[0]?.start).toBe(new Date(Date.UTC(2026, 9, 8, 17)).toISOString());
    const utc = seriesOf(ctx, { bucket: 'day', tzOffsetMinutes: 0, range: '7d' });
    expect(utc.points.map((p) => p.start)).toEqual([
      new Date(Date.UTC(2026, 9, 9)).toISOString(),
      new Date(Date.UTC(2026, 9, 10)).toISOString(),
      new Date(Date.UTC(2026, 9, 11)).toISOString(),
    ]);
    expect(utc.points.map((p) => p.messages)).toEqual([4, 2, 2]);
  });

  it('marks a bucket partial when it holds an unfinalized message, and only that bucket', async () => {
    const { ctx } = await spread();
    const utc = seriesOf(ctx, { bucket: 'hour', tzOffsetMinutes: 0, range: '7d' });
    const partial = utc.points.filter((p) => p.completeness === 'partial');
    expect(partial.map((p) => p.start)).toEqual([new Date(Date.UTC(2026, 9, 9, 23)).toISOString()]);
  });

  it('splits by model into series that add up to the points of the models', async () => {
    const ctx = await instance();
    const s = addSession(ctx, 1);
    addMessage(ctx, { session: s, model: 'model-x', ts: NOW - 3 * HOUR, input: 1 });
    addMessage(ctx, { session: s, model: 'model-y', ts: NOW - 3 * HOUR, input: 2 });
    addMessage(ctx, { session: s, model: 'model-y', ts: NOW - HOUR, input: 4 });
    addMessage(ctx, { session: s, model: '<synthetic>', synthetic: true, ts: NOW - HOUR, input: 0 });
    const series = seriesOf(ctx, { bucket: 'hour', groupBy: 'model', range: '24h' });
    expect(series.series?.map((m) => m.key)).toEqual(['model-x', 'model-y']);
    expect(series.series?.[1]?.points.map((p) => p.input)).toEqual([2, 4]);
    expect(series.series?.[0]?.points.map((p) => p.input)).toEqual([1]);
    expect(series.points.map((p) => p.input)).toEqual([3, 4]); // the points hold every message
    expect(series.points[1]?.messages).toBe(2); // the synthetic one counts in the points, not in a model
  });

  it('answers a range without a message with no points, and "all" starts at the first message', async () => {
    const ctx = await instance();
    const s = addSession(ctx, 1);
    expect(seriesOf(ctx, { range: 'all', bucket: 'hour' }).points).toEqual([]);
    expect(seriesOf(ctx, { range: 'all', bucket: 'hour', groupBy: 'model' }).series).toEqual([]);
    addMessage(ctx, { session: s, ts: NOW - 30 * DAY, input: 5 });
    expect(seriesOf(ctx, { range: 'all', bucket: 'day' }).points).toHaveLength(1);
    expect(seriesOf(ctx, { range: 'all', bucket: 'hour' }).points).toHaveLength(1); // 30 days of hours: 721 buckets
    addMessage(ctx, { session: s, ts: NOW - 100 * DAY, input: 5 });
    expect(() => seriesOf(ctx, { range: 'all', bucket: 'hour' })).toThrow(QueryRefusal); // 100 days of hours: 2400 buckets
    expect(seriesOf(ctx, { range: 'all', bucket: 'day' }).points).toHaveLength(2);
  });

  it('refuses more than 2000 buckets with range_too_large and accepts exactly 2000', async () => {
    const ctx = await instance();
    const code = (params: Record<string, string | number>): string | undefined => {
      try {
        seriesOf(ctx, params);
        return undefined;
      } catch (error) {
        return error instanceof QueryRefusal ? error.code : 'other';
      }
    };
    const to = Date.UTC(2026, 9, 11, 14);
    const hours = (n: number): Record<string, string> => ({
      bucket: 'hour',
      from: new Date(to - n * HOUR).toISOString(),
      to: new Date(to).toISOString(),
    });
    expect(MAX_BUCKETS).toBe(2000);
    expect(code(hours(2000))).toBeUndefined();
    expect(code(hours(2001))).toBe('range_too_large');
    expect(code({ bucket: 'hour', range: '30d' })).toBeUndefined(); // 721 hours
    expect(code({ bucket: 'day', range: 'all' })).toBeUndefined();
    expect(code({ bucket: 'day', from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).toBe('range_too_large');
    // a whole-hour offset keeps the 2000 buckets, a half-hour one splits the first and the last hour (2001)
    expect(code({ ...hours(2000), tzOffsetMinutes: 840 })).toBeUndefined();
    expect(code({ ...hours(2000), tzOffsetMinutes: -840 })).toBeUndefined();
    expect(code({ ...hours(2000), tzOffsetMinutes: 30 })).toBe('range_too_large');
  });
});

// ---- cost ---------------------------------------------------------------------------------------------------------------------

/** Synthetic prices: unit 1 for `model-a*`, unit 3 for `model-ab*` (the longer glob), `model-x` priced from a later day. */
const PRICES = {
  pricing: {
    currency: 'USD',
    models: [
      {
        match: 'model-a*',
        effectiveFrom: '2026-01-01',
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.5,
        cacheWrite5mPerMTok: 1.5,
        cacheWrite1hPerMTok: 3,
      },
      {
        match: 'model-ab*',
        effectiveFrom: '2026-01-01',
        inputPerMTok: 10,
        outputPerMTok: 20,
        cacheReadPerMTok: 5,
        cacheWrite5mPerMTok: 15,
        cacheWrite1hPerMTok: 30,
      },
      {
        match: 'model-x',
        effectiveFrom: '2026-10-10',
        inputPerMTok: 100,
        outputPerMTok: 200,
        cacheReadPerMTok: 50,
        cacheWrite5mPerMTok: 150,
        cacheWrite1hPerMTok: 300,
      },
      {
        match: 'model-x',
        effectiveFrom: '2026-12-01',
        inputPerMTok: 999,
        outputPerMTok: 999,
        cacheReadPerMTok: 999,
        cacheWrite5mPerMTok: 999,
        cacheWrite1hPerMTok: 999,
      },
    ],
  },
};
const M = 1_000_000;

describe('DA-T-A-4: the cost estimate', () => {
  it('has no cost at all without configured prices, even when asked for', async () => {
    const { ctx } = await workedExample();
    const report = usageOf(ctx, { includeCost: '1', groupBy: 'model' });
    expect(report.cost).toBeNull();
    expect(report.totals.cost).toBeNull();
    expect(report.rows.every((r) => r.cost === null)).toBe(true);
  });

  it('has no cost unless includeCost is asked for, even with prices', async () => {
    const { ctx } = await workedExample(PRICES);
    const report = usageOf(ctx, { groupBy: 'model' });
    expect(report.cost).toBeNull();
    expect(report.rows.every((r) => r.cost === null)).toBe(true);
  });

  it('prices by the longest glob, by the day of the message and lists what it could not price', async () => {
    const ctx = await instance(PRICES);
    const s = addSession(ctx, 1);
    addFile(ctx, s);
    const day = (d: number): number => Date.UTC(2026, 9, d, 12);
    addMessage(ctx, { session: s, model: 'model-a1', ts: day(9), input: M, output: M }); // model-a*: 1 + 2
    addMessage(ctx, { session: s, model: 'model-ab2', ts: day(9), input: M }); // model-ab* wins over model-a*: 10
    addMessage(ctx, { session: s, model: 'model-x', ts: day(9), input: M }); // before its first effectiveFrom: unpriced
    addMessage(ctx, { session: s, model: 'model-x', ts: day(10), input: M }); // 100
    addMessage(ctx, { session: s, model: 'other', ts: day(10), input: 3 * M }); // no entry: unpriced, left out
    addMessage(ctx, { session: s, model: '<synthetic>', synthetic: true, ts: day(10), input: 500 * M }); // never priced
    const report = usageOf(ctx, { includeCost: '1', range: '7d', groupBy: 'model' });
    expect(report.cost).toMatchObject({
      currency: 'USD',
      basis: 'estimate',
      source: 'configured_prices',
      note: 'Estimate from prices configured in runtime.json; not a bill.',
    });
    expect(report.cost?.amount).toBeCloseTo(3 + 10 + 100, 6);
    expect(report.cost?.pricedModels).toEqual(['model-a1', 'model-ab2', 'model-x']);
    expect(report.cost?.unpricedModels).toEqual(['model-x', 'other']);
    // priced: a1 2 M tokens, ab2 1 M, x 1 M = 4 M of 8 M counted (the synthetic message is not counted)
    expect(report.cost?.pricedTokensPct).toBeCloseTo((100 * 4) / 8, 6);
    const x = rowOf(report, 'model-x').cost;
    expect(x).toMatchObject({ basis: 'estimate', currency: 'USD', unpricedModels: ['model-x'] });
    expect(x?.amount).toBeCloseTo(100, 6);
    expect(rowOf(report, 'other').cost).toMatchObject({ amount: 0, pricedTokensPct: 0, unpricedModels: ['other'] });
    expect(report.totals.cost?.amount).toBeCloseTo(113, 6);
  });

  it('prices cache writes at the 5m tier when the split is missing and says so', async () => {
    const ctx = await instance(PRICES);
    const s = addSession(ctx, 1);
    addMessage(ctx, {
      session: s,
      model: 'model-a1',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: M,
      split: [M / 2, M / 4],
    });
    // a quarter of the write has no tier: it is priced at the 5m tier
    const partialSplit = usageOf(ctx, { includeCost: '1' });
    expect(partialSplit.cost?.assumedCacheWriteTier).toBe(true);
    expect(partialSplit.cost?.amount).toBeCloseTo(0.75 * 1.5 + 0.25 * 3, 6);

    const ctx2 = await instance(PRICES);
    const t = addSession(ctx2, 1);
    addMessage(ctx2, {
      session: t,
      model: 'model-a1',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: M,
      split: [M, 0],
    });
    const known = usageOf(ctx2, { includeCost: '1' });
    expect(known.cost?.assumedCacheWriteTier).toBe(false);
    expect(known.cost?.amount).toBeCloseTo(1.5, 6);

    const ctx3 = await instance(PRICES);
    const u = addSession(ctx3, 1);
    addMessage(ctx3, {
      session: u,
      model: 'model-a1',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: M,
      split: null,
    });
    const missing = usageOf(ctx3, { includeCost: '1' });
    expect(missing.cost?.assumedCacheWriteTier).toBe(true);
    expect(missing.cost?.amount).toBeCloseTo(1.5, 6);
  });

  it('breaks a tie of two globs of equal length by file order', async () => {
    const ctx = await instance({
      pricing: {
        currency: 'USD',
        models: [
          {
            match: 'abc*',
            effectiveFrom: '2026-01-01',
            inputPerMTok: 7,
            outputPerMTok: 0,
            cacheReadPerMTok: 0,
            cacheWrite5mPerMTok: 0,
            cacheWrite1hPerMTok: 0,
          },
          {
            match: '*xyz',
            effectiveFrom: '2026-01-01',
            inputPerMTok: 8,
            outputPerMTok: 0,
            cacheReadPerMTok: 0,
            cacheWrite5mPerMTok: 0,
            cacheWrite1hPerMTok: 0,
          },
        ],
      },
    });
    const s = addSession(ctx, 1);
    addMessage(ctx, { session: s, model: 'abc-xyz', input: M });
    expect(usageOf(ctx, { includeCost: '1' }).cost?.amount).toBeCloseTo(7, 6);
  });

  it('ignores a price that takes effect in the future', async () => {
    const ctx = await instance({
      pricing: {
        currency: 'USD',
        models: [
          {
            match: 'model-x',
            effectiveFrom: '2099-01-01',
            inputPerMTok: 9,
            outputPerMTok: 9,
            cacheReadPerMTok: 9,
            cacheWrite5mPerMTok: 9,
            cacheWrite1hPerMTok: 9,
          },
        ],
      },
    });
    const s = addSession(ctx, 1);
    addMessage(ctx, { session: s, input: M });
    const report = usageOf(ctx, { includeCost: '1' });
    expect(report.cost).toMatchObject({ amount: 0, pricedTokensPct: 0, unpricedModels: ['model-x'], pricedModels: [] });
  });

  it('prices every group of a report: the rows of a session grouping add up to the total', async () => {
    const ctx = await instance(PRICES);
    const s1 = addSession(ctx, 1);
    const s2 = addSession(ctx, 2);
    const sub = addAgent(ctx, s1, 'agent-sub');
    addMessage(ctx, { session: s1, model: 'model-a1', input: M });
    addMessage(ctx, { session: s1, agent: sub, model: 'model-a1', output: M });
    addMessage(ctx, { session: s2, model: 'model-ab1', input: M });
    for (const groupBy of ['session', 'agent', 'model']) {
      const report = usageOf(ctx, { includeCost: '1', groupBy });
      const sum = report.rows.reduce((n, r) => n + (r.cost?.amount ?? 0), 0);
      expect(sum, groupBy).toBeCloseTo(1 + 2 + 10, 6);
      expect(report.totals.cost?.amount, groupBy).toBeCloseTo(13, 6);
    }
    expect(rowOf(usageOf(ctx, { includeCost: '1', groupBy: 'session' }), s2.uid).cost?.amount).toBeCloseTo(10, 6);
    const bySession = ctx.queries.sessionUsage(ctx.scope, s1.uid, SessionUsageQuerySchema.parse({ includeCost: '1' }));
    expect(bySession.cost?.amount).toBeCloseTo(3, 6);
    expect(rowOf(bySession, 'agent-sub').cost?.amount).toBeCloseTo(2, 6);
  });

  it('shows the reported cost beside the estimate and never adds them', async () => {
    const ctx = await instance(PRICES);
    const s1 = addSession(ctx, 1);
    const s2 = addSession(ctx, 2);
    addSession(ctx, 3);
    addMessage(ctx, { session: s1, model: 'model-a1', input: M });
    put(ctx, 'cost_states', {
      file_id: 1,
      session_id: s1.id,
      total_cost_usd: 5,
      byte_offset: 1,
      observed_at: NOW - 2 * HOUR,
    });
    put(ctx, 'cost_states', {
      file_id: 2,
      session_id: s1.id,
      total_cost_usd: 7.5,
      byte_offset: 2,
      observed_at: NOW - HOUR,
    });
    put(ctx, 'cost_states', {
      file_id: 3,
      session_id: s2.id,
      total_cost_usd: 2,
      byte_offset: 1,
      observed_at: NOW - HOUR,
    });
    const report = usageOf(ctx, { includeCost: '1' });
    expect(report.cost?.amount).toBeCloseTo(1, 6);
    expect(report.reportedCost).toMatchObject({ amountUsd: 9.5, sessionsWithReport: 2, sessionsInScope: 3 });
    expect(report.reportedCost?.label).toMatch(/not a bill/);
    const one = usageOf(ctx, { session: s1.uid });
    expect(one.reportedCost).toMatchObject({ amountUsd: 7.5, sessionsWithReport: 1, sessionsInScope: 1 });
    expect(ctx.queries.sessionUsage(ctx.scope, s2.uid, SessionUsageQuerySchema.parse({})).reportedCost?.amountUsd).toBe(
      2,
    );
    expect(usageOf(await instance()).reportedCost).toBeNull();
  });
});

// ---- tools ---------------------------------------------------------------------------------------------------------------------

function toolsOf(ctx: InstanceContext, params: Record<string, string | number> = {}): ToolFrequencyReport {
  return ctx.queries.tools(ctx.scope, AnalyticsToolsQuerySchema.parse(asText(params)));
}

let toolCounter = 0;
interface Call {
  readonly session: Sess;
  readonly agent?: number;
  readonly name: string;
  readonly server?: string | null;
  readonly outcome?: 'ok' | 'error' | 'denied' | 'interrupted' | null;
  /** Ended without an outcome (derived status `unknown`). */
  readonly ended?: boolean;
  readonly duration?: number | null;
  readonly startedAt?: number | null;
}

function addCall(ctx: InstanceContext, c: Call): void {
  toolCounter += 1;
  const finished = c.outcome !== undefined && c.outcome !== null;
  put(ctx, 'tool_calls', {
    session_id: c.session.id,
    agent_id: c.agent ?? c.session.main,
    tool_use_id: `toolu_${String(toolCounter)}`,
    name: c.name,
    mcp_server: c.server ?? null,
    started_at: c.startedAt === undefined ? NOW - 10 * MINUTE : c.startedAt,
    ended_at: finished || c.ended === true ? NOW - 9 * MINUTE : null,
    outcome: c.outcome ?? null,
    duration_ms: c.duration ?? null,
    updated_at: NOW,
  });
}

describe('DA-T-A-5: tool frequency', () => {
  async function calls(): Promise<{ ctx: InstanceContext; s: Sess; t: Sess }> {
    const ctx = await instance();
    const s = addSession(ctx, 1);
    const t = addSession(ctx, 2);
    for (const duration of [100, 300, 200]) addCall(ctx, { session: s, name: 'Bash', outcome: 'ok', duration });
    addCall(ctx, { session: s, name: 'Bash', outcome: 'error', duration: 5000 });
    addCall(ctx, { session: s, name: 'Bash', outcome: 'denied' });
    addCall(ctx, { session: s, name: 'Bash', outcome: 'interrupted', duration: 50 });
    addCall(ctx, { session: s, name: 'Bash' }); // pending
    addCall(ctx, { session: s, name: 'Bash' }); // pending
    addCall(ctx, { session: s, name: 'Bash', ended: true, duration: 10 }); // ended without an outcome: unknown
    addCall(ctx, { session: t, name: 'Read', outcome: 'ok', duration: 7 });
    addCall(ctx, { session: t, name: 'Read' }); // pending only
    addCall(ctx, { session: t, name: 'mcp__demo__fetch', server: 'demo', outcome: 'error', duration: 40 });
    addCall(ctx, { session: t, name: 'mcp__demo__list', server: 'demo', outcome: 'ok', duration: 60 });
    addCall(ctx, { session: t, name: 'mcp__other__ping', server: 'other', outcome: 'ok', duration: 1 });
    addCall(ctx, { session: t, name: 'Old', outcome: 'ok', duration: 1, startedAt: NOW - 20 * DAY }); // outside 7 days
    return { ctx, s, t };
  }

  it('counts the calls per derived status, and the counts equal the tool-call list', async () => {
    const { ctx } = await calls();
    const report = toolsOf(ctx);
    const bash = report.items.find((i) => i.toolName === 'Bash');
    expect(bash).toMatchObject({
      calls: 9,
      succeeded: 3,
      failed: 1,
      denied: 1,
      interrupted: 1,
      pending: 2,
      unknown: 1,
      mcpServer: null,
    });
    for (const [name, status] of [
      ['Bash', 'succeeded'],
      ['Bash', 'failed'],
      ['Bash', 'denied'],
      ['Bash', 'interrupted'],
      ['Bash', 'pending'],
      ['Bash', 'unknown'],
      ['Read', 'pending'],
    ] as const) {
      const listed = ctx.queries.listToolCalls(
        ctx.scope,
        ToolCallListQuerySchema.parse({ tool: name, status, range: '7d' }),
      );
      const row = report.items.find((i) => i.toolName === name);
      expect(row?.[status], `${name} ${status}`).toBe(listed.items.length);
    }
    expect(report.window.to).toBe(new Date(NOW).toISOString());
    expect(report.items.some((i) => i.toolName === 'Old')).toBe(false);
    expect(report.sampled).toBe(false);
  });

  it('never counts a pending call as a failure and leaves the percentage out when nothing finished', async () => {
    const { ctx } = await calls();
    const items = toolsOf(ctx).items;
    const bash = items.find((i) => i.toolName === 'Bash');
    // 9 calls, 2 pending: 1 failed of 7 finished = 14.3 %
    expect(bash?.failurePct).toBe(14.3);
    expect(items.find((i) => i.toolName === 'Read')?.failurePct).toBe(0); // 1 ok, 1 pending
    const pendingOnly = await instance();
    const s = addSession(pendingOnly, 1);
    addCall(pendingOnly, { session: s, name: 'Wait' });
    expect(toolsOf(pendingOnly).items[0]).toMatchObject({
      toolName: 'Wait',
      calls: 1,
      pending: 1,
      failed: 0,
      failurePct: null,
      medianDurationMs: null,
      maxDurationMs: null,
    });
  });

  it('takes the median and the maximum over the finished calls with a duration', async () => {
    const { ctx } = await calls();
    const bash = toolsOf(ctx).items.find((i) => i.toolName === 'Bash');
    // durations of the finished calls: 100, 300, 200, 5000, 50, 10 -> sorted 10 50 100 200 300 5000 -> (100 + 200) / 2
    expect(bash?.medianDurationMs).toBe(150);
    expect(bash?.maxDurationMs).toBe(5000);
  });

  it('groups by MCP server, filters by tool, session, agent and project, and cuts at limit', async () => {
    const { ctx, s, t } = await calls();
    const servers = toolsOf(ctx, { groupBy: 'mcpServer' });
    expect(servers.items.map((i) => [i.toolName, i.mcpServer, i.calls])).toEqual([
      ['demo', 'demo', 2],
      ['other', 'other', 1],
    ]);
    expect(servers.items[0]).toMatchObject({ failed: 1, succeeded: 1, medianDurationMs: 50 });
    expect(toolsOf(ctx, { tool: 'Read' }).items.map((i) => i.toolName)).toEqual(['Read']);
    expect(toolsOf(ctx, { session: s.uid }).items.map((i) => i.toolName)).toEqual(['Bash']);
    expect(toolsOf(ctx, { session: t.uid }).items.map((i) => i.toolName)).toEqual([
      'Read',
      'mcp__demo__fetch',
      'mcp__demo__list',
      'mcp__other__ping',
    ]);
    expect(toolsOf(ctx, { limit: 1 }).items).toHaveLength(1);
    expect(toolsOf(ctx, { session: s.uid, agent: 'main' }).items[0]?.calls).toBe(9);
    expect(() => toolsOf(ctx, { session: s.uid, agent: 'agent-nope' })).toThrow(NotFoundError);
    const p = put(ctx, 'projects', {
      project_key: 'proj',
      dir_name: 'proj',
      first_seen_at: NOW,
      last_activity_at: NOW,
    });
    ctx.db.driver.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run([p, t.id]);
    expect(toolsOf(ctx, { project: 'proj' }).items.map((i) => i.toolName)).not.toContain('Bash');
    expect(toolsOf(ctx, { range: 'all' }).items.map((i) => i.toolName)).toContain('Old');
    expect(toolsOf(ctx, { session: uidOf(99) }).items).toEqual([]);
  });

  it('orders by calls, then name', async () => {
    const { ctx } = await calls();
    const names = toolsOf(ctx).items.map((i) => i.toolName);
    expect(names[0]).toBe('Bash');
    expect(names.slice(1)).toEqual([...names.slice(1)].sort());
  });

  it('says it sampled the durations above 100,000 rows and still counts every call', async () => {
    const ctx = await instance();
    const s = addSession(ctx, 1);
    const total = MEDIAN_ROW_LIMIT + 1;
    ctx.db.driver
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(total)})
         INSERT INTO tool_calls (session_id, agent_id, tool_use_id, name, started_at, ended_at, outcome, duration_ms, updated_at)
         SELECT ${String(s.id)}, ${String(s.main)}, 'tool-' || i, 'Bulk', ${String(NOW - MINUTE)}, ${String(NOW - MINUTE)}, 'ok', i % 1000, ${String(NOW)} FROM n`,
      )
      .run();
    const report = toolsOf(ctx);
    expect(report.sampled).toBe(true);
    expect(report.items[0]).toMatchObject({ toolName: 'Bulk', calls: total, succeeded: total });
    expect(report.items[0]?.medianDurationMs).not.toBeNull();
    // exactly at the limit is not sampled
    ctx.db.driver.prepare("DELETE FROM tool_calls WHERE tool_use_id = 'tool-1'").run();
    expect(toolsOf(ctx).sampled).toBe(false);
  });
});

// ---- isolation --------------------------------------------------------------------------------------------------------------------

describe('DA-T-A-7: usage isolation between instances', () => {
  it('has, for two instances over overlapping files, a total that equals its own scope only', async () => {
    const a = await instance(undefined, ID);
    const b = await instance(undefined, OTHER_ID);
    // the same transcript file is seen by both instances: the same message keys, with different values in each store
    for (const [ctx, scale] of [
      [a, 1],
      [b, 10],
    ] as const) {
      const s = addSession(ctx, 1);
      addFile(ctx, s, { path: 'shared.jsonl', path_key: 'shared.jsonl' });
      addMessage(ctx, {
        session: s,
        key: 'msg_shared',
        input: 1 * scale,
        output: 2 * scale,
        cacheRead: 3 * scale,
        cacheCreation: 4 * scale,
      });
    }
    addMessage(b, { session: { id: 1, uid: uidOf(1), main: 1, n: 1 }, key: 'msg_only_b', input: 100 });
    expect(four(usageOf(a, { range: 'all' }).totals)).toEqual([1, 2, 3, 4]);
    expect(four(usageOf(b, { range: 'all' }).totals)).toEqual([110, 20, 30, 40]);
    expect(usageOf(a).totals.usage.turns).toBe(1);
    expect(usageOf(b).totals.usage.turns).toBe(2);
    expect(usageOf(a, { groupBy: 'session' }).rows.map(four)).toEqual([[1, 2, 3, 4]]);
    // a caller of another instance is refused before anything is read
    expect(() => a.queries.usage({ instanceId: OTHER_ID }, UsageQuerySchema.parse({}))).toThrow();
    expect(() => b.queries.series({ instanceId: ID }, SeriesQuerySchema.parse({}))).toThrow();
    expect(() => b.queries.tools({ instanceId: ID }, AnalyticsToolsQuerySchema.parse({}))).toThrow();
    expect(() =>
      a.queries.sessionUsage({ instanceId: OTHER_ID }, uidOf(1), SessionUsageQuerySchema.parse({})),
    ).toThrow();
  });
});
