// `overview` (03 8.1, 10.3, 12.1): the metric catalogue with its fixed `source` and `rule` texts, the recent activity and
// errors of the window and the open alerts. The state tiles are the counts of `listSessions` (DA-T-API-1), and no metric
// is made up: a token or cost row without a value is `null`, never zero (WP-58).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  LIFECYCLE_STATES,
  OVERVIEW_METRIC_KEYS,
  OverviewQuerySchema,
  OverviewSchema,
  RUNTIME_VERSION,
  SessionListQuerySchema,
  UsageQuerySchema,
  type Metric,
  type Overview,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { isDbError } from '../db/errors.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { registerMetricProvider } from './overview.ts';
import { QueryRefusal } from './transitions.ts';

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

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. `runtime` is the content of runtime.json. */
async function instance(runtime?: Record<string, unknown>): Promise<InstanceContext> {
  const root = makeTemp('q-overview').path;
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
  if (runtime !== undefined) {
    writeFileSync(
      path.join(ws.dir, 'runtime.json'),
      `${JSON.stringify({ schema_version: 1, ...runtime })}
`,
    );
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

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface SessionSeed {
  n: number;
  state?: string;
  matched?: boolean;
  pinned?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
}

function addSession(ctx: InstanceContext, seed: SessionSeed): { id: number; uid: string; agentId: number } {
  const startedAt = seed.startedAt ?? NOW - 2 * HOUR;
  const lastActivityAt = seed.lastActivityAt ?? NOW - MINUTE;
  const uid = uidOf(seed.n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: `session ${String(seed.n)}`,
    matched: seed.matched === false ? 0 : 1,
    pinned: seed.pinned === true ? 1 : 0,
    search_text: `session ${String(seed.n)}`,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    state: seed.state ?? 'working',
    presence: 'open',
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

function addAgent(
  ctx: InstanceContext,
  session: { id: number; agentId: number },
  n: number,
  kind: string,
  state: string,
): void {
  put(ctx, 'agents', {
    session_id: session.id,
    parent_agent_id: session.agentId,
    agent_uid: `agent-${String(n)}`,
    kind,
    depth: 1,
    state,
    first_seen_at: NOW - HOUR,
    started_at: NOW - HOUR,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
  });
}

let eventCounter = 0;
function addEvent(ctx: InstanceContext, sessionId: number, over: Record<string, SqlValue> = {}): number {
  eventCounter += 1;
  return put(ctx, 'events', {
    session_id: sessionId,
    kind: 'tool.call',
    sources: 1,
    ts: NOW - MINUTE,
    ts_source: 'hook_received',
    received_at: NOW - MINUTE,
    event_uid: `eeeeeeee-0000-4000-8000-${eventCounter.toString(16).padStart(12, '0')}`,
    ...over,
  });
}

function addAlert(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): number {
  return put(ctx, 'alerts', {
    rule_id: 'hook_failing',
    rule_kind: 'hook_failing',
    scope_kind: 'instance',
    scope_key: `instance-${String(n)}`,
    severity: 'warning',
    status: 'open',
    title: 'Hook handler failing',
    first_fired_at: NOW - HOUR + n * MINUTE,
    last_fired_at: NOW - HOUR + n * MINUTE,
    ...over,
  });
}

function overview(ctx: InstanceContext, params: Record<string, string> = {}): Overview {
  return OverviewSchema.parse(ctx.queries.overview(ctx.scope, OverviewQuerySchema.parse(params)));
}

function metricOf(reply: Overview, key: string): Metric {
  const metric = reply.metrics.find((m) => m.key === key);
  if (metric === undefined) throw new Error(`no metric ${key}`);
  return metric;
}

const valueOf = (reply: Overview, key: string): number | null => metricOf(reply, key).value;

/** The catalogue of 03 8.1 that WP-31 owns: key, label, unit, source, rule, link (the texts are normative). */
const CATALOGUE: readonly [string, string, string, string, string][] = [
  [
    'sessions.active',
    'Active sessions',
    'sessions.state',
    'sessions in window with state running, working, waiting_tool or waiting_agent',
    '/sessions?state=active',
  ],
  [
    'sessions.waiting_input',
    'Waiting for input',
    'sessions.state',
    'state = waiting_input',
    '/sessions?state=waiting_input',
  ],
  ['sessions.turn_ended', 'Turn ended', 'sessions.state', 'state = turn_ended', '/sessions?state=turn_ended'],
  [
    'sessions.completed',
    'Completed',
    'sessions.state',
    'state = completed (only from SessionEnd, daemon job or attempts evidence, D9)',
    '/sessions?state=completed',
  ],
  ['sessions.failed', 'Failed', 'sessions.state', 'state = failed', '/sessions?state=failed'],
  ['sessions.stale', 'Stale', 'sessions.state', 'state = stale', '/sessions?state=stale'],
  ['sessions.unknown', 'Unknown', 'sessions.state', 'state = unknown', '/sessions?state=unknown'],
  [
    'agents.running',
    'Running agents',
    'agents.state',
    'subagents and workflow agents (not main, not internal) of sessions in window in an active state',
    '/sessions?state=active',
  ],
  [
    'events.errors',
    'Errors',
    'events.severity',
    'events with severity error and ts in window',
    '/activity?severity=error',
  ],
  ['alerts.open', 'Open alerts', 'alerts.status', 'status open', '/settings?section=health'],
];

describe('overview: the metric catalogue', () => {
  it('lists the rows of 03 8.1 in table order, with the fixed texts of the count rows', async () => {
    const ctx = await instance();
    const reply = overview(ctx);
    expect(reply.metrics.map((m) => m.key)).toEqual([...OVERVIEW_METRIC_KEYS]);
    for (const [key, label, source, rule, link] of CATALOGUE) {
      expect(metricOf(reply, key)).toEqual({
        key,
        label,
        value: 0,
        unit: 'count',
        source,
        rule,
        completeness: 'complete',
        asOf: new Date(NOW).toISOString(),
        link,
      });
    }
  });

  it('answers the shape of an empty instance', async () => {
    const ctx = await instance();
    const reply = overview(ctx);
    expect(reply.asOfSeq).toBe(ctx.db.headSeq());
    expect(reply.generatedAt).toBe(new Date(NOW).toISOString());
    expect(reply.window).toEqual({
      from: new Date(NOW - ctx.config.monitor.window_hours * HOUR).toISOString(),
      to: new Date(NOW).toISOString(),
      source: 'window_hours',
    });
    expect(reply.recentActivity).toEqual([]);
    expect(reply.recentErrors).toEqual([]);
    expect(reply.alerts).toEqual({ open: 0, critical: 0, items: [] });
  });

  it('inserts the metrics of a registered provider before alerts.open (the WP-58 extension point)', async () => {
    const ctx = await instance();
    const extra: Metric = {
      key: 'tokens.output',
      label: 'Output tokens',
      value: 1,
      unit: 'tokens',
      source: 's',
      rule: 'r',
      completeness: 'partial',
      asOf: new Date(NOW).toISOString(),
      link: '/analytics',
    };
    const seen: { fromMs: number | null; asOfSeq: number }[] = [];
    const unregister = registerMetricProvider((input) => {
      seen.push({ fromMs: input.window.fromMs, asOfSeq: input.asOfSeq });
      return [extra];
    });
    try {
      const keys = overview(ctx).metrics.map((m) => m.key);
      expect(keys.slice(-3)).toEqual(['cost.reported', 'tokens.output', 'alerts.open']);
      expect(seen).toEqual([{ fromMs: NOW - ctx.config.monitor.window_hours * HOUR, asOfSeq: ctx.db.headSeq() }]);
    } finally {
      unregister();
    }
    expect(overview(ctx).metrics.filter((m) => m.key === 'tokens.output')).toHaveLength(1); // the real provider's row
  });
});

describe('overview: sessions and agents', () => {
  /** One session per state, plus the ones that a window or the unmatched rule leaves out. */
  async function populated(): Promise<InstanceContext> {
    const ctx = await instance();
    let n = 0;
    for (const state of LIFECYCLE_STATES) {
      n += 1;
      addSession(ctx, { n, state });
    }
    addSession(ctx, { n: 20, state: 'working' });
    addSession(ctx, { n: 21, state: 'completed', matched: false }); // unmatched: only with includeUnmatched
    addSession(ctx, { n: 22, state: 'failed', matched: false, pinned: true }); // pinned: always in `window=1`
    addSession(ctx, { n: 23, state: 'stale', startedAt: NOW - 30 * HOUR, lastActivityAt: NOW - 20 * HOUR }); // outside the window
    addSession(ctx, { n: 24, state: 'turn_ended', startedAt: NOW - 3 * HOUR, lastActivityAt: NOW - 90 * MINUTE });
    return ctx;
  }

  const STATE_KEYS: readonly [string, string][] = [
    ['sessions.active', 'active'],
    ['sessions.waiting_input', 'waiting_input'],
    ['sessions.turn_ended', 'turn_ended'],
    ['sessions.completed', 'completed'],
    ['sessions.failed', 'failed'],
    ['sessions.stale', 'stale'],
    ['sessions.unknown', 'unknown'],
  ];

  const WINDOWS: readonly Record<string, string>[] = [
    {},
    { window: '1' },
    { includeUnmatched: '1' },
    { range: '1h' },
    { range: '24h', includeUnmatched: '1' },
    { range: 'all' },
    { range: 'all', includeUnmatched: '1' },
    { from: new Date(NOW - 2 * HOUR).toISOString(), to: new Date(NOW - 30 * MINUTE).toISOString() },
  ];

  it.each(WINDOWS)('has state tiles equal to the counts of listSessions (%o)', async (params) => {
    const ctx = await populated();
    const reply = overview(ctx, params);
    for (const [key, state] of STATE_KEYS) {
      const page = ctx.queries.listSessions(
        ctx.scope,
        SessionListQuerySchema.parse({ ...params, state, includeTotal: '1', limit: '1' }),
      );
      expect(page.total, `${key} for ${JSON.stringify(params)}`).not.toBeNull();
      expect(valueOf(reply, key), `${key} for ${JSON.stringify(params)}`).toBe(page.total);
    }
  });

  it('counts the sessions of the default window, without the unmatched ones', async () => {
    const ctx = await populated();
    const reply = overview(ctx);
    // running, working, waiting_tool, waiting_agent and the extra working session
    expect(valueOf(reply, 'sessions.active')).toBe(5);
    expect(valueOf(reply, 'sessions.completed')).toBe(1);
    expect(valueOf(reply, 'sessions.failed')).toBe(2); // the pinned unmatched one counts in window=1 (the default)
    expect(valueOf(reply, 'sessions.stale')).toBe(1); // the one outside the window is left out
    expect(valueOf(reply, 'sessions.turn_ended')).toBe(2);
    expect(valueOf(reply, 'sessions.waiting_input')).toBe(1);
    expect(valueOf(reply, 'sessions.unknown')).toBe(1);
  });

  it('counts the running subagents and workflow agents of the sessions in the window', async () => {
    const ctx = await instance();
    const inside = addSession(ctx, { n: 1 });
    const unmatched = addSession(ctx, { n: 2, matched: false });
    const outside = addSession(ctx, { n: 3, startedAt: NOW - 30 * HOUR, lastActivityAt: NOW - 20 * HOUR });
    addAgent(ctx, inside, 1, 'subagent', 'working');
    addAgent(ctx, inside, 2, 'workflow_agent', 'waiting_tool');
    addAgent(ctx, inside, 3, 'subagent', 'completed'); // not active
    addAgent(ctx, inside, 4, 'internal', 'working'); // internal
    addAgent(ctx, inside, 5, 'teammate', 'running');
    addAgent(ctx, unmatched, 6, 'subagent', 'working'); // unmatched session
    addAgent(ctx, outside, 7, 'subagent', 'working'); // outside the window
    // the main agents never count, whatever their state
    ctx.db.driver.prepare("UPDATE agents SET state = 'working' WHERE agent_uid = 'main'").run();
    expect(valueOf(overview(ctx), 'agents.running')).toBe(3);
    expect(valueOf(overview(ctx, { includeUnmatched: '1' }), 'agents.running')).toBe(4);
  });
});

describe('overview: events and alerts', () => {
  it('counts the error events in the window only', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addEvent(ctx, s.id, { severity: 2 });
    addEvent(ctx, s.id, { severity: 2, ts: NOW - 5 * MINUTE });
    addEvent(ctx, s.id, { severity: 1 }); // a warning is not an error
    addEvent(ctx, s.id, { severity: 0 });
    addEvent(ctx, s.id, { severity: 2, ts: NOW - 9 * HOUR }); // before the window of 8 hours
    expect(valueOf(overview(ctx), 'events.errors')).toBe(2);
    expect(valueOf(overview(ctx, { range: 'all' }), 'events.errors')).toBe(3);
    expect(valueOf(overview(ctx, { range: '1h' }), 'events.errors')).toBe(2);
  });

  it('lists the 15 newest events of the window and the 10 newest problems', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    const ids: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(addEvent(ctx, s.id, { ts: NOW - (i + 1) * MINUTE, severity: i % 2 === 0 ? 1 : 0 }));
    }
    addEvent(ctx, s.id, { ts: NOW - 12 * HOUR, severity: 2 }); // outside the window
    const reply = overview(ctx);
    expect(reply.recentActivity.map((e) => e.id)).toEqual(ids.slice(0, 15));
    // severity >= warning: every other event, newest first
    expect(reply.recentErrors.map((e) => e.id)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((i) => ids[i]));
    expect(reply.recentErrors.every((e) => e.severity !== 'info')).toBe(true);
  });

  it('counts the open alerts, their critical part and lists the five newest', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    for (let n = 1; n <= 7; n += 1) addAlert(ctx, n, n === 2 ? { severity: 'critical' } : {});
    addAlert(ctx, 8, {
      status: 'resolved',
      resolved_at: NOW,
      resolved_reason: 'condition_cleared',
      last_fired_at: NOW - 30 * MINUTE,
      first_fired_at: NOW - 40 * MINUTE,
    });
    addAlert(ctx, 9, {
      rule_id: 'inactivity',
      rule_kind: 'inactivity',
      scope_kind: 'session',
      scope_key: s.uid,
      session_id: s.id,
      title: 'No activity for 47 min',
      first_fired_at: NOW - 10 * MINUTE,
      last_fired_at: NOW - 10 * MINUTE,
    });
    const reply = overview(ctx);
    expect(reply.alerts.open).toBe(8);
    expect(reply.alerts.critical).toBe(1);
    expect(valueOf(reply, 'alerts.open')).toBe(8);
    expect(reply.alerts.items).toHaveLength(5);
    expect(reply.alerts.items[0]).toMatchObject({ rule: 'inactivity', sessionId: s.uid, status: 'open' });
    expect(reply.alerts.items.map((a) => a.status)).toEqual(['open', 'open', 'open', 'open', 'open']);
  });
});

// ---- the token and cost rows (WP-58) ---------------------------------------------------------------------------------------

let messageCounter = 0;

interface UsageSeed {
  readonly session: { id: number; agentId: number };
  readonly model?: string;
  readonly ts?: number;
  readonly input?: number | null;
  readonly output?: number | null;
  readonly cacheRead?: number | null;
  readonly cacheCreation?: number | null;
  readonly split?: readonly [number, number] | null;
  readonly finalized?: boolean;
  readonly synthetic?: boolean;
}

/** One `usage` row (the instance value of a message key); a field left out is 0, `null` is a missing field. */
function addUsage(ctx: InstanceContext, seed: UsageSeed): void {
  messageCounter += 1;
  const field = (value: number | null | undefined): number | null => (value === undefined ? 0 : value);
  put(ctx, 'usage', {
    message_key: `msg_${String(messageCounter)}`,
    session_id: seed.session.id,
    agent_id: seed.session.agentId,
    owner_file_id: 1,
    model: seed.model ?? 'model-x',
    ts: seed.ts ?? NOW - 10 * MINUTE,
    input_tokens: field(seed.input),
    output_tokens: field(seed.output),
    cache_read_tokens: field(seed.cacheRead),
    cache_creation_tokens: field(seed.cacheCreation),
    cache_creation_5m_tokens: seed.split === undefined || seed.split === null ? null : seed.split[0],
    cache_creation_1h_tokens: seed.split === undefined || seed.split === null ? null : seed.split[1],
    finalized: seed.finalized === false ? 0 : 1,
    usage_source: 'top',
    synthetic: seed.synthetic === true ? 1 : 0,
    updated_at: NOW,
  });
}

function addTranscriptFile(
  ctx: InstanceContext,
  session: { id: number },
  n: number,
  over: Record<string, SqlValue> = {},
): void {
  put(ctx, 'transcript_files', {
    path: `f${String(n)}.jsonl`,
    path_key: `f${String(n)}.jsonl`,
    kind: 'session',
    session_uid: uidOf(n),
    session_id: session.id,
    discovered_at: NOW,
    updated_at: NOW,
    usage_state: 'complete',
    ...over,
  });
}

const TOKEN_KEYS = ['tokens.input', 'tokens.input_new', 'tokens.output', 'tokens.cache_creation', 'tokens.cache_read'];

/** A synthetic price list: neutral numbers, not a real price. */
const PRICING = {
  pricing: {
    currency: 'EUR',
    models: [
      {
        match: 'model-*',
        effectiveFrom: '2026-01-01',
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.5,
        cacheWrite5mPerMTok: 2,
        cacheWrite1hPerMTok: 4,
      },
    ],
  },
};

describe('overview: the token and cost rows', () => {
  it('has every metric of the catalogue with a source, a rule and a link (DA-T-A-6)', async () => {
    const ctx = await instance(PRICING);
    const reply = overview(ctx);
    expect(reply.metrics.map((m) => m.key)).toEqual([...OVERVIEW_METRIC_KEYS]);
    for (const metric of reply.metrics) {
      expect(metric.source, metric.key).not.toBe('');
      expect(metric.rule, metric.key).not.toBe('');
      expect(metric.label, metric.key).not.toBe('');
      expect(metric.link, metric.key).toMatch(/^\//);
    }
  });

  it('keeps the fixed texts of 03 8.1 for the token and cost rows', async () => {
    const reply = overview(await instance());
    expect(metricOf(reply, 'tokens.input')).toMatchObject({
      label: 'Input tokens (uncached)',
      unit: 'tokens',
      source: 'usage.input_tokens',
      rule: 'sum over message keys with ts in window',
      link: '/analytics',
    });
    expect(metricOf(reply, 'tokens.input_new')).toMatchObject({
      label: 'New input tokens',
      source: 'usage.input_tokens + cache_creation_tokens',
      rule: 'sum; tokens sent to the model that were not read from cache',
    });
    expect(metricOf(reply, 'tokens.output').rule).toBe('sum; lower bound when some messages never got a final record');
    expect(metricOf(reply, 'tokens.cache_creation')).toMatchObject({ label: 'Cache writes', rule: 'sum' });
    expect(metricOf(reply, 'tokens.cache_read')).toMatchObject({
      label: 'Cache reads',
      rule: 'sum (shown separately, never merged into input)',
    });
    expect(metricOf(reply, 'cost.estimate')).toMatchObject({ label: 'Estimated cost', unit: 'currency' });
    expect(metricOf(reply, 'cost.reported')).toMatchObject({ unit: 'currency', currency: 'USD' });
  });

  it('answers null, never 0, for a window without a message and without prices', async () => {
    const reply = overview(await instance());
    for (const key of [...TOKEN_KEYS, 'cost.estimate', 'cost.reported']) {
      expect(valueOf(reply, key), key).toBeNull();
    }
    expect(metricOf(reply, 'cost.estimate').completeness).toBe('unavailable');
    expect(metricOf(reply, 'cost.reported').completeness).toBe('unavailable');
  });

  it('sums the messages with ts in the window and equals usage() for the same window (DA-T-A-6)', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addTranscriptFile(ctx, s, 1);
    addUsage(ctx, { session: s, input: 10, output: 20, cacheRead: 1000, cacheCreation: 300 });
    addUsage(ctx, { session: s, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, ts: NOW - 2 * HOUR });
    addUsage(ctx, { session: s, input: 500, output: 500, cacheRead: 500, cacheCreation: 500, ts: NOW - 20 * HOUR }); // before the window
    const reply = overview(ctx);
    expect(valueOf(reply, 'tokens.input')).toBe(11);
    expect(valueOf(reply, 'tokens.input_new')).toBe(11 + 304);
    expect(valueOf(reply, 'tokens.output')).toBe(22);
    expect(valueOf(reply, 'tokens.cache_creation')).toBe(304);
    expect(valueOf(reply, 'tokens.cache_read')).toBe(1003);
    for (const key of TOKEN_KEYS) expect(metricOf(reply, key).completeness, key).toBe('complete');

    // the defaults differ (the overview reads the window of the monitor, analytics 7 days): the same window is named
    for (const params of [{ window: '1' }, { range: '1h' }, { range: '24h' }, { range: 'all' }]) {
      const rows = overview(ctx, params);
      const usage = ctx.queries.usage(ctx.scope, UsageQuerySchema.parse({ ...params, groupBy: 'none' })).totals.usage;
      expect(valueOf(rows, 'tokens.input'), JSON.stringify(params)).toBe(usage.input);
      expect(valueOf(rows, 'tokens.output'), JSON.stringify(params)).toBe(usage.output);
      expect(valueOf(rows, 'tokens.cache_read'), JSON.stringify(params)).toBe(usage.cacheRead);
      expect(valueOf(rows, 'tokens.cache_creation'), JSON.stringify(params)).toBe(usage.cacheCreation);
    }
    expect(valueOf(overview(ctx, { range: '1h' }), 'tokens.input')).toBe(10);
    expect(valueOf(overview(ctx, { range: 'all' }), 'tokens.input')).toBe(511);
  });

  it('answers null for a field that every counted message misses, and sums the others', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addUsage(ctx, { session: s, input: 7, output: null, cacheRead: null, cacheCreation: 3 });
    addUsage(ctx, { session: s, input: 8, output: null, cacheRead: null, cacheCreation: null });
    const reply = overview(ctx);
    expect(valueOf(reply, 'tokens.input')).toBe(15);
    expect(valueOf(reply, 'tokens.output')).toBeNull();
    expect(valueOf(reply, 'tokens.cache_read')).toBeNull();
    expect(valueOf(reply, 'tokens.cache_creation')).toBe(3);
    expect(valueOf(reply, 'tokens.input_new')).toBe(18);
  });

  it('answers null for new input only when both of its parts are missing', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addUsage(ctx, { session: s, input: null, output: 4, cacheRead: 0, cacheCreation: null });
    const reply = overview(ctx);
    expect(valueOf(reply, 'tokens.input')).toBeNull();
    expect(valueOf(reply, 'tokens.input_new')).toBeNull();
    expect(valueOf(reply, 'tokens.output')).toBe(4);
    expect(valueOf(reply, 'tokens.cache_read')).toBe(0); // a measured zero
  });

  it('takes the completeness from the files, and makes the output a lower bound while a message is unfinalized', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addTranscriptFile(ctx, s, 1);
    addUsage(ctx, { session: s, input: 1, output: 8, finalized: false });
    const open = overview(ctx);
    expect(metricOf(open, 'tokens.output').completeness).toBe('partial');
    expect(metricOf(open, 'tokens.input').completeness).toBe('complete');

    const t = addSession(ctx, { n: 2 });
    addTranscriptFile(ctx, t, 2, { usage_state: 'partial' });
    const partial = overview(ctx);
    for (const key of TOKEN_KEYS) expect(metricOf(partial, key).completeness, key).toBe('partial');

    // every contributing file skipped its backfill: nothing of the window was read
    ctx.db.driver.prepare("UPDATE transcript_files SET usage_state = 'skipped_backfill'").run();
    for (const key of TOKEN_KEYS) expect(metricOf(overview(ctx), key).completeness, key).toBe('unavailable');
  });

  it('keeps a synthetic message in the count with its zeros', async () => {
    const ctx = await instance();
    const s = addSession(ctx, { n: 1 });
    addUsage(ctx, { session: s, model: '<synthetic>', synthetic: true });
    expect(valueOf(overview(ctx), 'tokens.input')).toBe(0); // a measured zero of a counted message
  });

  describe('with configured prices', () => {
    it('estimates the cost from the prices only, labelled with the currency', async () => {
      const ctx = await instance(PRICING);
      const s = addSession(ctx, { n: 1 });
      addUsage(ctx, {
        session: s,
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 2_000_000,
        cacheCreation: 1_000_000,
        split: [1_000_000, 0],
      });
      const metric = metricOf(overview(ctx), 'cost.estimate');
      // 1 + 5 + 2 x 0.5 + 1 x 2
      expect(metric.value).toBeCloseTo(9, 9);
      expect(metric).toMatchObject({ unit: 'currency', currency: 'EUR', completeness: 'complete' });
    });

    it('is partial when a model has no price, and leaves its tokens out of the amount', async () => {
      const ctx = await instance(PRICING);
      const s = addSession(ctx, { n: 1 });
      addUsage(ctx, { session: s, model: 'model-x', input: 1_000_000 });
      addUsage(ctx, { session: s, model: 'other-model', input: 9_000_000 });
      const metric = metricOf(overview(ctx), 'cost.estimate');
      expect(metric.value).toBeCloseTo(1, 9);
      expect(metric.completeness).toBe('partial');
    });

    it('never prices a synthetic message, so nothing counted means no figure', async () => {
      const ctx = await instance(PRICING);
      const s = addSession(ctx, { n: 1 });
      addUsage(ctx, { session: s, model: 'model-x', input: 5_000_000, synthetic: true });
      expect(valueOf(overview(ctx), 'cost.estimate')).toBeNull();
    });
  });

  describe('the cost the provider reports', () => {
    function addCost(
      ctx: InstanceContext,
      session: { id: number },
      fileId: number,
      usd: number | null,
      observedAt: number,
    ): void {
      put(ctx, 'cost_states', {
        file_id: fileId,
        session_id: session.id,
        total_cost_usd: usd,
        byte_offset: 10,
        observed_at: observedAt,
      });
    }

    it('sums the latest value per session over the sessions in the window, and is partial when some have none', async () => {
      const ctx = await instance();
      const a = addSession(ctx, { n: 1 });
      const b = addSession(ctx, { n: 2 });
      addSession(ctx, { n: 3 }); // no report
      const outside = addSession(ctx, { n: 4, startedAt: NOW - 30 * HOUR, lastActivityAt: NOW - 20 * HOUR });
      addCost(ctx, a, 1, 1.5, NOW - 2 * HOUR);
      addCost(ctx, a, 2, 2.5, NOW - HOUR); // the later value of the same session replaces the earlier one
      addCost(ctx, b, 3, 0.25, NOW - HOUR);
      addCost(ctx, outside, 4, 100, NOW); // outside the window
      const metric = metricOf(overview(ctx), 'cost.reported');
      expect(metric.value).toBeCloseTo(2.75, 9);
      expect(metric).toMatchObject({ unit: 'currency', currency: 'USD', completeness: 'partial' });
    });

    it('is complete when every session in the window has one, and ignores a state without an amount', async () => {
      const ctx = await instance();
      const a = addSession(ctx, { n: 1 });
      addCost(ctx, a, 1, 4, NOW - HOUR);
      expect(metricOf(overview(ctx), 'cost.reported')).toMatchObject({ completeness: 'complete' });
      const b = addSession(ctx, { n: 2 });
      addCost(ctx, b, 2, null, NOW - HOUR);
      expect(metricOf(overview(ctx), 'cost.reported')).toMatchObject({ completeness: 'partial' });
      expect(valueOf(overview(ctx), 'cost.reported')).toBe(4);
    });

    it('is never added to the estimate', async () => {
      const ctx = await instance(PRICING);
      const s = addSession(ctx, { n: 1 });
      addUsage(ctx, { session: s, model: 'model-x', input: 1_000_000 });
      addCost(ctx, s, 1, 50, NOW - HOUR);
      const reply = overview(ctx);
      expect(valueOf(reply, 'cost.estimate')).toBeCloseTo(1, 9);
      expect(valueOf(reply, 'cost.reported')).toBe(50);
    });
  });
});

describe('overview: the window and the refusals', () => {
  it('reports the source of the window', async () => {
    const ctx = await instance();
    expect(overview(ctx, { range: '6h' }).window).toEqual({
      from: new Date(NOW - 6 * HOUR).toISOString(),
      to: new Date(NOW).toISOString(),
      source: 'range',
    });
    expect(overview(ctx, { range: 'all' }).window).toMatchObject({ from: null, source: 'range' });
    const from = new Date(NOW - 3 * HOUR).toISOString();
    const to = new Date(NOW - HOUR).toISOString();
    expect(overview(ctx, { from, to }).window).toEqual({ from, to, source: 'custom' });
  });

  it('refuses a window that contradicts itself with range_invalid', async () => {
    const ctx = await instance();
    const code = (params: Record<string, string>): string | undefined => {
      try {
        ctx.queries.overview(ctx.scope, OverviewQuerySchema.parse(params));
        return undefined;
      } catch (error) {
        return error instanceof QueryRefusal ? error.code : 'other';
      }
    };
    expect(code({ range: '1h', window: '1' })).toBe('range_invalid');
    expect(code({ from: new Date(NOW).toISOString(), to: new Date(NOW - HOUR).toISOString() })).toBe('range_invalid');
  });

  it('refuses a caller of another instance and never writes', async () => {
    const ctx = await instance();
    addSession(ctx, { n: 1 });
    let code: string | undefined;
    try {
      ctx.queries.overview(FOREIGN, OverviewQuerySchema.parse({}));
    } catch (error) {
      code = isDbError(error) ? error.code : 'other';
    }
    expect(code).toBe('scope_mismatch');
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(ctx.db.driver.path);
    overview(ctx);
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(ctx.db.driver.path).equals(before)).toBe(true);
  });
});
