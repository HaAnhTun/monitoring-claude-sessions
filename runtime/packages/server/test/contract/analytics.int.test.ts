// The analytics routes on a real instance behind a real HTTP server (03 6.1, 8, 19.3, 19.6): `GET /api/v3/analytics/usage`,
// `/analytics/series`, `/analytics/tools` and `GET /api/v3/sessions/:sessionId/usage`. Response validation is on (registry
// N3), so every body here already matches its strict schema; the tests add the values, the filters, the cost labelling, the
// absence of any text of a transcript and the envelope of every refusal.
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
const M = 1_000_000;
const ID = '11111111-1111-4111-8111-111111111111';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
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

/** A real instance behind a real HTTP server; `runtime` is the content of runtime.json (the prices). */
async function startInstance(runtime?: Record<string, unknown>): Promise<Running> {
  const root = makeTemp('contract-analytics').path;
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
  return { ctx, port };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly json: unknown;
}

async function get(run: Running, route: string): Promise<Reply> {
  const reply = await httpRequest(run.port, route);
  return { status: reply.status, headers: reply.headers, body: reply.body, json: JSON.parse(reply.body) };
}

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

function addSession(ctx: InstanceContext, n: number): Added {
  const uid = uidOf(n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: `session ${String(n)}`,
    matched: 1,
    first_seen_at: NOW - 2 * HOUR,
    started_at: NOW - 2 * HOUR,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
  });
  const agentId = put(ctx, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: NOW - 2 * HOUR,
    started_at: NOW - 2 * HOUR,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
  });
  put(ctx, 'transcript_files', {
    path: `f${String(n)}.jsonl`,
    path_key: `f${String(n)}.jsonl`,
    kind: 'session',
    session_uid: uid,
    session_id: id,
    discovered_at: NOW,
    updated_at: NOW,
    usage_state: 'complete',
    size_seen: 100,
    backfill_offset: 100,
    tail_start: 100,
    tail_offset: 100,
  });
  return { id, uid, agentId };
}

let messageCounter = 0;
function addMessage(
  ctx: InstanceContext,
  s: Added,
  over: {
    model?: string;
    ts?: number;
    input?: number | null;
    output?: number | null;
    cacheRead?: number;
    cacheCreation?: number;
    finalized?: boolean;
  },
): void {
  messageCounter += 1;
  put(ctx, 'usage', {
    message_key: `msg_${String(messageCounter)}`,
    session_id: s.id,
    agent_id: s.agentId,
    owner_file_id: 1,
    model: over.model ?? 'model-x',
    ts: over.ts ?? NOW - 10 * MINUTE,
    input_tokens: over.input === undefined ? 0 : over.input,
    output_tokens: over.output === undefined ? 0 : over.output,
    cache_read_tokens: over.cacheRead ?? 0,
    cache_creation_tokens: over.cacheCreation ?? 0,
    cache_creation_5m_tokens: over.cacheCreation ?? null,
    cache_creation_1h_tokens: over.cacheCreation === undefined ? null : 0,
    finalized: over.finalized === false ? 0 : 1,
    usage_source: 'top',
    synthetic: 0,
    updated_at: NOW,
  });
}

let callCounter = 0;
function addCall(ctx: InstanceContext, s: Added, name: string, outcome: string | null, duration: number | null): void {
  callCounter += 1;
  put(ctx, 'tool_calls', {
    session_id: s.id,
    agent_id: s.agentId,
    tool_use_id: `toolu_${String(callCounter)}`,
    name,
    started_at: NOW - 10 * MINUTE,
    ended_at: outcome === null ? null : NOW - 9 * MINUTE,
    outcome,
    duration_ms: duration,
    updated_at: NOW,
  });
}

function expectApiHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['x-mcs-instance']).toBe(ID);
  expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
}

const PRICES = {
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
};

const USAGE = '/api/v3/analytics/usage';
const SERIES = '/api/v3/analytics/series';
const TOOLS = '/api/v3/analytics/tools';

describe('GET /api/v3/analytics/usage', () => {
  it('answers a strict report with the totals, the rows by model, the source and the headers of every API answer', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    const b = addSession(run.ctx, 2);
    addMessage(run.ctx, a, { model: 'model-x', input: 10, output: 20, cacheRead: 30, cacheCreation: 40 });
    addMessage(run.ctx, a, { model: 'model-y', input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    addMessage(run.ctx, b, { model: 'model-x', input: 100, output: 200, cacheRead: 300, cacheCreation: 400 });
    const reply = await get(run, `${USAGE}?groupBy=model`);
    expect(reply.status, reply.body).toBe(200);
    expectApiHeaders(reply);
    const report = routes.analyticsUsage.response.parse(reply.json);
    expect(report.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(report.groupBy).toBe('model');
    expect(report.totals.usage).toMatchObject({
      input: 111,
      output: 222,
      cacheRead: 333,
      cacheCreation: 444,
      total: 1110,
      turns: 3,
    });
    expect(report.totals.sessions).toBe(2);
    expect(report.rows.map((r) => [r.key, r.usage.input])).toEqual([
      ['model-x', 110],
      ['model-y', 1],
    ]);
    expect(report.source).toMatch(/^Token usage from transcript assistant records/);
    expect(report.window.to).toBe(new Date(NOW).toISOString());
    expect(report.window.from).toBe(new Date(NOW - 7 * 24 * HOUR).toISOString());
    expect(report.cost).toBeNull();
    expect(report.reportedCost).toBeNull();
  });

  it('answers every grouping and a filter of each kind', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    const b = addSession(run.ctx, 2);
    addMessage(run.ctx, a, { input: 1 });
    addMessage(run.ctx, b, { input: 2, model: 'model-y' });
    for (const groupBy of ['model', 'session', 'project', 'workItem', 'agent', 'none']) {
      const reply = await get(run, `${USAGE}?groupBy=${groupBy}`);
      expect(reply.status, `${groupBy} ${reply.body}`).toBe(200);
      routes.analyticsUsage.response.parse(reply.json);
    }
    const bySession = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?groupBy=session&limit=1`)).json);
    expect(bySession.rows.map((r) => r.key)).toEqual([b.uid]);
    expect(bySession.rowsTruncated).toBe(true);
    const only = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?session=${a.uid}`)).json);
    expect(only.totals.usage.input).toBe(1);
    const model = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?model=model-y`)).json);
    expect(model.totals.usage.input).toBe(2);
    const none = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?session=${uidOf(404)}`)).json);
    expect(none.totals.usage).toMatchObject({ input: null, total: null, turns: 0 });
  });

  it('shows null fields, never zero, for a window without a message', async () => {
    const run = await startInstance();
    const report = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?range=1h`)).json);
    expect(report.totals.usage).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheCreation: null,
      total: null,
      turns: 0,
    });
    expect(report.rows).toEqual([]);
  });

  it('labels the cost as an estimate of configured prices, only on request, and never adds the reported cost', async () => {
    const run = await startInstance(PRICES);
    const a = addSession(run.ctx, 1);
    addMessage(run.ctx, a, { model: 'model-x', input: M, output: M });
    addMessage(run.ctx, a, { model: 'unpriced', input: M });
    put(run.ctx, 'cost_states', {
      file_id: 1,
      session_id: a.id,
      total_cost_usd: 42,
      byte_offset: 1,
      observed_at: NOW - HOUR,
    });
    const without = routes.analyticsUsage.response.parse((await get(run, `${USAGE}?groupBy=model`)).json);
    expect(without.cost).toBeNull();
    const withCost = routes.analyticsUsage.response.parse(
      (await get(run, `${USAGE}?groupBy=model&includeCost=1`)).json,
    );
    expect(withCost.cost).toMatchObject({
      currency: 'USD',
      basis: 'estimate',
      source: 'configured_prices',
      pricedModels: ['model-x'],
      unpricedModels: ['unpriced'],
      note: 'Estimate from prices configured in runtime.json; not a bill.',
    });
    expect(withCost.cost?.amount).toBeCloseTo(3, 6);
    expect(withCost.cost?.pricedTokensPct).toBeCloseTo(66.666, 2);
    expect(withCost.rows.find((r) => r.key === 'model-x')?.cost?.basis).toBe('estimate');
    expect(withCost.reportedCost).toMatchObject({ amountUsd: 42, sessionsWithReport: 1, sessionsInScope: 1 });
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const cases: [string, number, string][] = [
      [`${USAGE}?range=1h&window=1`, 400, 'range_invalid'],
      [`${USAGE}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${USAGE}?from=2026-10-11T10:00:00Z&to=2026-10-11T09:00:00Z`, 400, 'range_invalid'],
      [`${USAGE}?from=2000-01-01T00:00:00Z&to=2026-10-11T09:00:00Z`, 400, 'range_too_large'],
      [`${USAGE}?groupBy=planet`, 400, 'validation_failed'],
      [`${USAGE}?limit=501`, 400, 'validation_failed'],
      [`${USAGE}?limit=0`, 400, 'validation_failed'],
      [`${USAGE}?agent=main`, 400, 'validation_failed'],
      [`${USAGE}?range=1h&range=6h`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});

describe('GET /api/v3/analytics/series', () => {
  it('answers strict points that add up to the totals, empty buckets absent, at each offset', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    const day = Date.UTC(2026, 9, 9);
    for (const [i, ts] of [day + 2 * HOUR, day + 2 * HOUR + MINUTE, day + 30 * HOUR, NOW - 5 * MINUTE].entries()) {
      addMessage(run.ctx, a, { ts, input: i + 1, output: 10 * (i + 1) });
    }
    for (const offset of [-480, 0, 420]) {
      for (const bucket of ['hour', 'day']) {
        const reply = await get(run, `${SERIES}?bucket=${bucket}&tzOffsetMinutes=${String(offset)}&range=7d`);
        expect(reply.status, reply.body).toBe(200);
        expectApiHeaders(reply);
        const series = routes.analyticsSeries.response.parse(reply.json);
        expect(series.bucket).toBe(bucket);
        expect(series.tzOffsetMinutes).toBe(offset);
        expect(
          series.points.reduce((n, p) => n + p.input, 0),
          `${bucket} ${String(offset)}`,
        ).toBe(10);
        expect(series.points.reduce((n, p) => n + p.messages, 0)).toBe(4);
        expect(series.points.every((p) => p.messages > 0)).toBe(true);
        expect(series.series).toBeNull();
      }
    }
    const byModel = routes.analyticsSeries.response.parse((await get(run, `${SERIES}?groupBy=model`)).json);
    expect(byModel.series?.map((s) => s.key)).toEqual(['model-x']);
  });

  it('refuses more than 2000 buckets with range_too_large and a bad request with the right code', async () => {
    const run = await startInstance();
    const cases: [string, number, string][] = [
      [`${SERIES}?bucket=hour&from=2026-01-01T00:00:00Z&to=2026-10-11T00:00:00Z`, 400, 'range_too_large'],
      [`${SERIES}?bucket=day&from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`, 400, 'range_too_large'],
      [`${SERIES}?bucket=week`, 400, 'validation_failed'],
      [`${SERIES}?tzOffsetMinutes=841`, 400, 'validation_failed'],
      [`${SERIES}?tzOffsetMinutes=-841`, 400, 'validation_failed'],
      [`${SERIES}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${SERIES}?range=1h&window=1`, 400, 'validation_failed'], // the series route has no window flag
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
    // the bounds of the offset are accepted
    expect((await get(run, `${SERIES}?tzOffsetMinutes=840`)).status).toBe(200);
    expect((await get(run, `${SERIES}?tzOffsetMinutes=-840`)).status).toBe(200);
  });
});

describe('GET /api/v3/analytics/tools', () => {
  it('answers strict rows with the counts per status, the failure share and the durations', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    addCall(run.ctx, a, 'Bash', 'ok', 100);
    addCall(run.ctx, a, 'Bash', 'ok', 300);
    addCall(run.ctx, a, 'Bash', 'error', 900);
    addCall(run.ctx, a, 'Bash', null, null);
    addCall(run.ctx, a, 'Read', null, null);
    const reply = await get(run, TOOLS);
    expect(reply.status, reply.body).toBe(200);
    expectApiHeaders(reply);
    const report = routes.analyticsTools.response.parse(reply.json);
    expect(report.sampled).toBe(false);
    expect(report.items[0]).toEqual({
      toolName: 'Bash',
      mcpServer: null,
      calls: 4,
      succeeded: 2,
      failed: 1,
      denied: 0,
      interrupted: 0,
      pending: 1,
      unknown: 0,
      failurePct: 33.3,
      medianDurationMs: 300,
      maxDurationMs: 900,
    });
    expect(report.items[1]).toMatchObject({
      toolName: 'Read',
      calls: 1,
      pending: 1,
      failed: 0,
      failurePct: null,
      medianDurationMs: null,
    });
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    const cases: [string, number, string][] = [
      [`${TOOLS}?agent=main`, 400, 'validation_failed'], // an agent needs exactly one session
      [`${TOOLS}?session=${a.uid}&agent=nobody`, 404, 'agent_not_found'],
      [`${TOOLS}?groupBy=planet`, 400, 'validation_failed'],
      [`${TOOLS}?limit=201`, 400, 'validation_failed'],
      [`${TOOLS}?range=1h&window=1`, 400, 'validation_failed'], // the tools route has no window flag
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});

describe('GET /api/v3/sessions/:sessionId/usage', () => {
  it('answers the usage of one session by agent and by model', async () => {
    const run = await startInstance(PRICES);
    const a = addSession(run.ctx, 1);
    const sub = put(run.ctx, 'agents', {
      session_id: a.id,
      parent_agent_id: a.agentId,
      agent_uid: 'agent-sub',
      kind: 'subagent',
      depth: 1,
      label: 'helper',
      first_seen_at: NOW - HOUR,
      started_at: NOW - HOUR,
      last_activity_at: NOW,
      updated_at: NOW,
    });
    addMessage(run.ctx, a, { model: 'model-x', input: M });
    put(run.ctx, 'usage', {
      message_key: 'msg_sub',
      session_id: a.id,
      agent_id: sub,
      owner_file_id: 1,
      model: 'model-y',
      ts: NOW - MINUTE,
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      finalized: 1,
      usage_source: 'top',
      synthetic: 0,
      updated_at: NOW,
    });
    const reply = await get(run, `/api/v3/sessions/${a.uid}/usage`);
    expect(reply.status, reply.body).toBe(200);
    expectApiHeaders(reply);
    const byAgent = routes.sessionUsage.response.parse(reply.json);
    expect(byAgent.groupBy).toBe('agent');
    expect(byAgent.rows.map((r) => [r.key, r.label, r.usage.input])).toEqual([
      ['main', 'main', M],
      ['agent-sub', 'helper', 5],
    ]);
    expect(byAgent.totals.usage.input).toBe(M + 5);
    expect(byAgent.cost).toBeNull(); // not asked for
    const byModel = routes.sessionUsage.response.parse(
      (await get(run, `/api/v3/sessions/${a.uid}/usage?groupBy=model&includeCost=1`)).json,
    );
    expect(byModel.rows.map((r) => r.key)).toEqual(['model-x', 'model-y']);
    expect(byModel.cost).toMatchObject({ basis: 'estimate', unpricedModels: [] });
    expect(byModel.cost?.amount).toBeCloseTo(1 + 0.000005 + 0.000012, 6);
  });

  it('answers 404 session_not_found for an unknown session and 400 for a bad query', async () => {
    const run = await startInstance();
    addSession(run.ctx, 1);
    const unknown = await get(run, `/api/v3/sessions/${uidOf(404)}/usage`);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'session_not_found']);
    expectApiHeaders(unknown);
    for (const url of [
      `/api/v3/sessions/${uidOf(1)}/usage?groupBy=project`,
      `/api/v3/sessions/${uidOf(1)}/usage?range=1h`,
    ]) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([400, 'validation_failed']);
    }
    const bad = await get(run, '/api/v3/sessions/not-a-session/usage');
    expect(bad.status).toBe(400);
  });
});

describe('what no analytics answer contains', () => {
  it('has no text of a transcript, a prompt or a path in any answer', async () => {
    const run = await startInstance(PRICES);
    const a = addSession(run.ctx, 1);
    addMessage(run.ctx, a, { input: 5, output: 5 });
    addCall(run.ctx, a, 'Bash', 'ok', 10);
    const bodies = await Promise.all(
      [
        `${USAGE}?groupBy=session&includeCost=1`,
        `${USAGE}?groupBy=agent`,
        SERIES,
        TOOLS,
        `/api/v3/sessions/${a.uid}/usage`,
      ].map((url) => get(run, url)),
    );
    for (const reply of bodies) {
      expect(reply.status, reply.body).toBe(200);
      expect(reply.body).not.toMatch(/\.jsonl|prompt|"summary"|"content"/);
    }
  });
});
