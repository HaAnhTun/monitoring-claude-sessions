// `overview` (03 8.1, 10.3, 12.1): the metric catalogue with its fixed `source` and `rule` texts, the recent activity and
// errors of the window and the open alerts. The state tiles are the counts of `listSessions` (DA-T-API-1), and no metric
// is made up: a row whose source does not exist yet (tokens, cost: WP-58) is absent, not zero.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  LIFECYCLE_STATES,
  OverviewQuerySchema,
  OverviewSchema,
  RUNTIME_VERSION,
  SessionListQuerySchema,
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

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. */
async function instance(): Promise<InstanceContext> {
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
  it('lists exactly the rows whose source exists, with the fixed texts of 03 8.1', async () => {
    const ctx = await instance();
    const reply = overview(ctx);
    expect(reply.metrics.map((m) => m.key)).toEqual(CATALOGUE.map(([key]) => key));
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

  it('has no token or cost row: those belong to WP-58 and are absent, not zero', async () => {
    const ctx = await instance();
    const keys = overview(ctx).metrics.map((m) => m.key);
    expect(keys.filter((key) => key.startsWith('tokens.') || key.startsWith('cost.'))).toEqual([]);
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
      expect(keys.slice(-3)).toEqual(['events.errors', 'tokens.output', 'alerts.open']);
      expect(seen).toEqual([{ fromMs: NOW - ctx.config.monitor.window_hours * HOUR, asOfSeq: ctx.db.headSeq() }]);
    } finally {
      unregister();
    }
    expect(overview(ctx).metrics.some((m) => m.key === 'tokens.output')).toBe(false);
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
