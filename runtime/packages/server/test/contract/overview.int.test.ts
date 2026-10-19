// `GET /api/v3/overview` on a real instance (03 8.1, 19.3, DA-T-API-1): a strict body with the fixed catalogue, state tiles that
// equal the totals of `GET /sessions`, the counts of the window, the newest events and problems, the open alerts and the
// envelope of the errors the route raises.
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
import { ErrorEnvelopeSchema, OVERVIEW_METRIC_KEYS, RUNTIME_VERSION, routes } from '@mcs/shared';
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
async function startInstance(runtime?: Record<string, unknown>): Promise<Running> {
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

const OVERVIEW = '/api/v3/overview';

function parseOverview(reply: Reply): ReturnType<typeof routes.overview.response.parse> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.overview.response.parse(reply.json);
}

function tile(overview: ReturnType<typeof parseOverview>, key: string): number | null {
  const metric = overview.metrics.find((m) => m.key === key);
  if (metric === undefined) throw new Error(`no metric ${key}`);
  return metric.value;
}

describe('GET /api/v3/overview', () => {
  it('answers a strict body with the catalogue, its fixed texts and the headers of every API answer', async () => {
    const run = await startInstance();
    const reply = await get(run, OVERVIEW);
    const overview = parseOverview(reply);
    expectApiHeaders(reply);
    expect(overview.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(overview.metrics.map((m) => m.key)).toEqual([
      'sessions.active',
      'sessions.waiting_input',
      'sessions.turn_ended',
      'sessions.completed',
      'sessions.failed',
      'sessions.stale',
      'sessions.unknown',
      'agents.running',
      'events.errors',
      'tokens.input',
      'tokens.input_new',
      'tokens.output',
      'tokens.cache_creation',
      'tokens.cache_read',
      'cost.estimate',
      'cost.reported',
      'alerts.open',
    ]);
    expect(overview.metrics.map((m) => m.key)).toEqual([...OVERVIEW_METRIC_KEYS]);
    for (const metric of overview.metrics) {
      expect(metric.source, metric.key).not.toBe('');
      expect(metric.rule, metric.key).not.toBe('');
      expect(metric.link, metric.key).toMatch(/^\//);
      // an empty instance has counts of 0 and no token or cost figure: a missing value is null, never 0
      if (metric.key.startsWith('tokens.') || metric.key.startsWith('cost.'))
        expect(metric.value, metric.key).toBeNull();
      else expect(metric.completeness, metric.key).toBe('complete');
    }
    expect(overview.window.source).toBe('window_hours');
  });

  it('has state tiles equal to the totals of GET /sessions over HTTP (DA-T-API-1)', async () => {
    const run = await startInstance();
    const states = [
      'working',
      'working',
      'waiting_tool',
      'waiting_input',
      'turn_ended',
      'completed',
      'failed',
      'failed',
    ];
    states.forEach((state, i) => addSession(run.ctx, i + 1, { state }));
    addSession(run.ctx, 20, { state: 'stale', matched: 0 });
    addSession(run.ctx, 21, { state: 'unknown', started_at: NOW - 40 * HOUR, last_activity_at: NOW - 30 * HOUR });
    for (const query of ['', '?includeUnmatched=1', '?range=all', '?range=all&includeUnmatched=1', '?range=1h']) {
      const overview = parseOverview(await get(run, `${OVERVIEW}${query}`));
      const joiner = query === '' ? '?' : '&';
      for (const [key, state] of [
        ['sessions.active', 'active'],
        ['sessions.waiting_input', 'waiting_input'],
        ['sessions.turn_ended', 'turn_ended'],
        ['sessions.completed', 'completed'],
        ['sessions.failed', 'failed'],
        ['sessions.stale', 'stale'],
        ['sessions.unknown', 'unknown'],
      ] as const) {
        const listed = routes.listSessions.response.parse(
          (await get(run, `/api/v3/sessions${query}${joiner}state=${state}&includeTotal=1&limit=1`)).json,
        );
        expect(tile(overview, key), `${key} ${query}`).toBe(listed.total);
      }
    }
    expect(tile(parseOverview(await get(run, OVERVIEW)), 'sessions.active')).toBe(3);
  });

  it('counts the errors, lists the newest activity and problems and the open alerts', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1, { state: 'working' });
    const quiet = addEvent(run.ctx, s, { ts: NOW - 3 * MINUTE });
    const warning = addEvent(run.ctx, s, { ts: NOW - 2 * MINUTE, severity: 1 });
    const failure = addEvent(run.ctx, s, { ts: NOW - MINUTE, severity: 2 });
    addEvent(run.ctx, s, { ts: NOW - 20 * HOUR, severity: 2 }); // outside the default window
    addAlert(run.ctx, 1);
    addAlert(run.ctx, 2, { severity: 'critical' });
    addAlert(run.ctx, 3, {
      status: 'resolved',
      resolved_at: NOW,
      resolved_reason: 'condition_cleared',
    });
    const overview = parseOverview(await get(run, OVERVIEW));
    expect(tile(overview, 'events.errors')).toBe(1);
    expect(overview.recentActivity.map((e) => e.id)).toEqual([failure, warning, quiet]);
    expect(overview.recentErrors.map((e) => e.id)).toEqual([failure, warning]);
    expect(overview.alerts.open).toBe(2);
    expect(overview.alerts.critical).toBe(1);
    expect(tile(overview, 'alerts.open')).toBe(2);
    expect(overview.alerts.items.map((a) => a.severity)).toEqual(['critical', 'warning']);
  });

  it('adds the token and cost rows between events.errors and alerts.open, equal to GET /analytics/usage of the same window', async () => {
    const run = await startInstance({
      pricing: {
        currency: 'USD',
        models: [
          {
            match: 'model-*',
            effectiveFrom: '2026-01-01',
            inputPerMTok: 1,
            outputPerMTok: 2,
            cacheReadPerMTok: 0.5,
            cacheWrite5mPerMTok: 1.5,
            cacheWrite1hPerMTok: 3,
          },
        ],
      },
    });
    const s = addSession(run.ctx, 1, { state: 'working' });
    const message = (key: string, ts: number, values: Record<string, number | null>): void => {
      put(run.ctx, 'usage', {
        message_key: key,
        session_id: s.id,
        agent_id: s.agentId,
        owner_file_id: 1,
        model: 'model-x',
        ts,
        input_tokens: values['input'] ?? 0,
        output_tokens: values['output'] ?? 0,
        cache_read_tokens: values['cacheRead'] ?? 0,
        cache_creation_tokens: values['cacheCreation'] ?? 0,
        cache_creation_5m_tokens: values['cacheCreation'] ?? 0,
        cache_creation_1h_tokens: 0,
        finalized: 1,
        usage_source: 'top',
        synthetic: 0,
        updated_at: NOW,
      });
    };
    message('msg_1', NOW - 10 * MINUTE, {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 2_000_000,
      cacheCreation: 1_000_000,
    });
    message('msg_2', NOW - 2 * HOUR, { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 });
    message('msg_3', NOW - 20 * HOUR, { input: 7, output: 7, cacheRead: 7, cacheCreation: 7 }); // outside the default window of 8 hours
    put(run.ctx, 'cost_states', {
      file_id: 1,
      session_id: s.id,
      total_cost_usd: 12.5,
      byte_offset: 1,
      observed_at: NOW - HOUR,
    });

    const reply = await get(run, OVERVIEW);
    const overview = parseOverview(reply);
    const keys = overview.metrics.map((m) => m.key);
    expect(keys.slice(keys.indexOf('events.errors'))).toEqual([
      'events.errors',
      'tokens.input',
      'tokens.input_new',
      'tokens.output',
      'tokens.cache_creation',
      'tokens.cache_read',
      'cost.estimate',
      'cost.reported',
      'alerts.open',
    ]);
    expect(tile(overview, 'tokens.input')).toBe(1_000_010);
    expect(tile(overview, 'tokens.input_new')).toBe(1_000_010 + 1_000_040);
    expect(tile(overview, 'tokens.output')).toBe(500_020);
    expect(tile(overview, 'tokens.cache_creation')).toBe(1_000_040);
    expect(tile(overview, 'tokens.cache_read')).toBe(2_000_030);
    const estimate = overview.metrics.find((m) => m.key === 'cost.estimate');
    // 1 x 1 + 0.5 x 2 + 2 x 0.5 + 1 x 1.5 (millions of tokens), plus the few tokens of the second message
    expect(estimate?.value).toBeCloseTo(1 + 1 + 1 + 1.5, 3);
    expect(estimate).toMatchObject({ unit: 'currency', currency: 'USD', completeness: 'complete' });
    expect(overview.metrics.find((m) => m.key === 'cost.reported')).toMatchObject({
      value: 12.5,
      unit: 'currency',
      currency: 'USD',
      completeness: 'complete',
    });

    // the rows equal the usage report of the same window
    const usage = routes.analyticsUsage.response.parse(
      (await get(run, `/api/v3/analytics/usage?window=1&groupBy=none`)).json,
    );
    expect(tile(overview, 'tokens.input')).toBe(usage.totals.usage.input);
    expect(tile(overview, 'tokens.output')).toBe(usage.totals.usage.output);
    expect(tile(overview, 'tokens.cache_read')).toBe(usage.totals.usage.cacheRead);
    expect(tile(overview, 'tokens.cache_creation')).toBe(usage.totals.usage.cacheCreation);
    const wide = parseOverview(await get(run, `${OVERVIEW}?range=7d`));
    expect(tile(wide, 'tokens.input')).toBe(1_000_017);
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const cases: [string, number, string][] = [
      [`${OVERVIEW}?range=1h&window=1`, 400, 'range_invalid'],
      [`${OVERVIEW}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${OVERVIEW}?from=2026-10-11T10:00:00Z&to=2026-10-11T09:00:00Z`, 400, 'range_invalid'],
      [`${OVERVIEW}?range=2h`, 400, 'validation_failed'],
      [`${OVERVIEW}?limit=5`, 400, 'validation_failed'],
      [`${OVERVIEW}?range=1h&range=6h`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});
