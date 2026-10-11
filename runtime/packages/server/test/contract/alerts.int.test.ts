// `GET /api/v3/alerts` and `GET /api/v3/alerts/rules` on a real instance (03 10.3, 19.3, DA-T-API-1 and 6): a strict page, the
// filters of 5.4 over HTTP, keyset paging while rows are inserted between the requests, the rules with their configured
// settings and the envelope of the errors the route raises.
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

function addAlert(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): number {
  return put(ctx, 'alerts', {
    rule_id: 'hook_failing',
    rule_kind: 'hook_failing',
    scope_kind: 'instance',
    scope_key: `instance-${String(n)}`,
    severity: 'warning',
    status: 'open',
    title: 'Hook handler failing',
    detail: JSON.stringify({ count: n }),
    first_fired_at: NOW - HOUR + n * MINUTE,
    last_fired_at: NOW - HOUR + n * MINUTE,
    fire_count: 1,
    ...over,
  });
}

const RESOLVED: Record<string, SqlValue> = {
  status: 'resolved',
  resolved_at: NOW,
  resolved_reason: 'condition_cleared',
};

const ALERTS = '/api/v3/alerts';

function parseAlerts(reply: Reply): ReturnType<typeof routes.listAlerts.response.parse> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.listAlerts.response.parse(reply.json);
}

describe('GET /api/v3/alerts', () => {
  it('answers a strict page of the open alerts, newest firing first, with the headers of every API answer', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const old = addAlert(run.ctx, 1);
    const fresh = addAlert(run.ctx, 2, {
      rule_id: 'inactivity',
      rule_kind: 'inactivity',
      scope_kind: 'session',
      scope_key: s.uid,
      session_id: s.id,
      severity: 'critical',
      title: 'No activity for 47 min',
      fire_count: 3,
    });
    addAlert(run.ctx, 3, RESOLVED);
    const reply = await get(run, ALERTS);
    const page = parseAlerts(reply);
    expectApiHeaders(reply);
    expect(page.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(page.items.map((a) => a.id)).toEqual([fresh, old]);
    expect(page.items[0]).toMatchObject({
      rule: 'inactivity',
      ruleId: 'inactivity',
      severity: 'critical',
      status: 'open',
      title: 'No activity for 47 min',
      scope: { kind: 'session', key: s.uid },
      sessionId: s.uid,
      fireCount: 3,
      resolvedAt: null,
    });
    expect(page.items[1]).toMatchObject({ sessionId: null, detail: { count: 1 } });
  });

  it('applies the filters of 5.4 over HTTP', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const a = addAlert(run.ctx, 1);
    const b = addAlert(run.ctx, 2, { severity: 'critical' });
    const c = addAlert(run.ctx, 3, {
      rule_id: 'hook_gap',
      rule_kind: 'hook_gap',
      scope_kind: 'session',
      scope_key: s.uid,
      session_id: s.id,
    });
    const d = addAlert(run.ctx, 4, RESOLVED);
    const ids = async (query: string): Promise<number[]> =>
      parseAlerts(await get(run, `${ALERTS}${query === '' ? '' : `?${query}`}`))
        .items.map((item) => item.id)
        .sort((x, y) => x - y);
    expect(await ids('')).toEqual([a, b, c]);
    expect(await ids('status=resolved')).toEqual([d]);
    expect(await ids('status=open,resolved')).toEqual([a, b, c, d]);
    expect(await ids('severity=critical')).toEqual([b]);
    expect(await ids('rule=hook_gap')).toEqual([c]);
    expect(await ids('rule=hook_gap,hook_failing&severity=warning')).toEqual([a, c]);
    expect(await ids(`session=${s.uid}`)).toEqual([c]);
    expect(await ids(`session=${uidOf(99)}`)).toEqual([]);
  });

  it('walks the pages while alerts are inserted between the requests (DA-T-API-6)', async () => {
    const run = await startInstance();
    const first = Array.from({ length: 7 }, (_, i) => addAlert(run.ctx, i + 1));
    const served: number[] = [];
    let cursor = '';
    let extra = 100;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = parseAlerts(await get(run, `${ALERTS}?limit=2${cursor === '' ? '' : `&cursor=${cursor}`}`));
      served.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      extra += 1;
      // a newer alert appears while the client holds a cursor: it must not shift the rest of the walk
      addAlert(run.ctx, extra, { first_fired_at: NOW, last_fired_at: NOW });
    }
    expect(served.filter((id) => first.includes(id)).sort((x, y) => x - y)).toEqual(first);
    expect(new Set(served).size).toBe(served.length);
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    addAlert(run.ctx, 1);
    addAlert(run.ctx, 2);
    const cursor = parseAlerts(await get(run, `${ALERTS}?limit=1`)).nextCursor ?? '';
    expect(cursor).not.toBe('');
    const cases: [string, number, string][] = [
      [`${ALERTS}?limit=1&cursor=${cursor}&severity=critical`, 400, 'cursor_invalid'],
      [`${ALERTS}?cursor=garbage`, 400, 'cursor_invalid'],
      [`${ALERTS}?status=closed`, 400, 'validation_failed'],
      [`${ALERTS}?severity=fatal`, 400, 'validation_failed'],
      [`${ALERTS}?rule=nothing`, 400, 'validation_failed'],
      [`${ALERTS}?limit=999`, 400, 'validation_failed'],
      [`${ALERTS}?status=open&status=resolved`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});

describe('GET /api/v3/alerts/rules', () => {
  it('answers the eight rules with their configured settings and the number of open alerts', async () => {
    const run = await startInstance();
    addAlert(run.ctx, 1);
    addAlert(run.ctx, 2);
    addAlert(run.ctx, 3, RESOLVED);
    const reply = await get(run, `${ALERTS}/rules`);
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    expectApiHeaders(reply);
    const view = routes.alertRules.response.parse(reply.json);
    expect(view.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(view.enabled).toBe(run.ctx.config.runtime.alerts.enabled);
    expect(view.sweepSeconds).toBe(run.ctx.config.runtime.alerts.sweepSeconds);
    expect(view.rules.map((r) => r.ruleId)).toEqual([
      'inactivity',
      'ingest_errors',
      'runtime_unavailable',
      'token_threshold',
      'import_lag',
      'db_disk',
      'hook_gap',
      'hook_failing',
    ]);
    const byId = new Map(view.rules.map((r) => [r.ruleId, r]));
    expect(byId.get('inactivity')).toMatchObject({
      rule: 'inactivity',
      enabled: true,
      scopeKind: 'session',
      settings: { minutes: 30, cooldownMinutes: 10 },
      openCount: 0,
    });
    expect(byId.get('ingest_errors')).toMatchObject({
      scopeKind: 'code',
      settings: { count: 10, windowMinutes: 10, criticalCount: 50, cooldownMinutes: 10 },
    });
    expect(byId.get('token_threshold')).toMatchObject({
      enabled: false,
      settings: { tokens: null, field: 'total' },
    });
    expect(byId.get('db_disk')).toMatchObject({ settings: { minFreeMb: 500, maxDbMb: 2048, cooldownMinutes: 30 } });
    expect(byId.get('hook_failing')).toMatchObject({ scopeKind: 'instance', openCount: 2 });
    // `enabled` is the switch of the rule, never a setting
    for (const rule of view.rules) expect(Object.keys(rule.settings)).not.toContain('enabled');
  });
});
