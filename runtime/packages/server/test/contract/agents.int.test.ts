// `GET /api/v3/agents` on a real instance (03 19.3, DA-T-API-1 and 6): a strict page, the filters of 5.4 over HTTP, keyset
// paging in both sorts while rows are inserted between the requests, and the envelope of the errors the route raises.
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
import type { z } from 'zod';

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

/** The headers every `/api` answer has (DA-T-API-10). */
function expectApiHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['x-mcs-instance']).toBe(ID);
  expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
}

const AGENTS = '/api/v3/agents';

function parseAgents(reply: Reply): z.output<typeof routes.listAgents.response> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.listAgents.response.parse(reply.json);
}

describe('GET /api/v3/agents', () => {
  it('answers a valid request with a strict page and the headers of every API answer', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addAgent(run.ctx, s, 'agent-x1', { label: 'Planner', agent_type: 'Plan', state: 'working' });
    const reply = await get(run, `${AGENTS}?includeUnmatched=1&range=all`);
    const page = parseAgents(reply);
    expectApiHeaders(reply);
    expect(page.items.map((item) => item.id).sort()).toEqual(['agent-x1', 'main']);
    expect(page.asOfSeq).toBe(run.ctx.db.headSeq());
  });

  it('applies the filters of 5.4 over HTTP', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const t = addSession(run.ctx, 2, { matched: 0 });
    addAgent(run.ctx, s, 'agent-x1', { label: 'Planner', agent_type: 'Plan', state: 'working', error_count: 1 });
    addAgent(run.ctx, s, 'agent-x2', { label: 'Coder', kind: 'teammate', state: 'completed' });
    addAgent(run.ctx, s, 'agent-int', { label: 'hidden', kind: 'internal' });
    addAgent(run.ctx, t, 'agent-y1', { label: 'Other' });
    const ids = async (query: string): Promise<string[]> =>
      parseAgents(await get(run, `${AGENTS}?range=all&${query}`))
        .items.map((item) => item.id)
        .sort();
    expect(await ids('session=' + s.uid)).toEqual(['agent-x1', 'agent-x2', 'main']);
    expect(await ids('includeUnmatched=1&session=' + t.uid)).toEqual(['agent-y1', 'main']);
    expect(await ids('session=' + t.uid)).toEqual([]); // unmatched
    expect(await ids(`session=${s.uid}&includeInternal=1`)).toEqual(['agent-int', 'agent-x1', 'agent-x2', 'main']);
    expect(await ids(`session=${s.uid}&kind=teammate`)).toEqual(['agent-x2']);
    expect(await ids(`session=${s.uid}&state=active`)).toEqual(['agent-x1']);
    expect(await ids(`session=${s.uid}&q=coder`)).toEqual(['agent-x2']);
    expect(await ids(`session=${s.uid}&hasErrors=1`)).toEqual(['agent-x1']);
  });

  it('walks both sorts and directions while rows are inserted between the requests (DA-T-API-6)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const first = Array.from({ length: 7 }, (_, i) => `agent-${String(i + 1)}`);
    first.forEach((uid, i) =>
      addAgent(run.ctx, s, uid, {
        last_activity_at: NOW - (i + 1) * MINUTE,
        started_at: NOW - HOUR + (i % 3) * MINUTE,
      }),
    );
    let extra = 0;
    for (const sort of ['lastActivity', 'started']) {
      for (const dir of ['asc', 'desc']) {
        const served: string[] = [];
        const extras: string[] = [];
        let cursor = '';
        for (let guard = 0; guard < 100; guard += 1) {
          const page = parseAgents(
            await get(
              run,
              `${AGENTS}?range=all&session=${s.uid}&limit=2&sort=${sort}&dir=${dir}${cursor === '' ? '' : `&cursor=${cursor}`}`,
            ),
          );
          served.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
          extra += 1;
          extras.push(`agent-extra${String(extra)}`);
          addAgent(run.ctx, s, `agent-extra${String(extra)}`, {
            last_activity_at: NOW - 100 * MINUTE - extra,
            started_at: NOW - 2 * HOUR,
          });
        }
        for (const uid of extras) run.ctx.db.driver.prepare('DELETE FROM agents WHERE agent_uid = :uid').run({ uid });
        for (const uid of [...first, 'main'])
          expect(
            served.filter((value) => value === uid),
            `${sort} ${dir} ${uid}`,
          ).toHaveLength(1);
        expect(new Set(served).size, `${sort} ${dir}`).toBe(served.length);
      }
    }
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    for (let i = 1; i <= 3; i += 1) addAgent(run.ctx, s, `agent-${String(i)}`);
    const cursor = parseAgents(await get(run, `${AGENTS}?range=all&limit=1`)).nextCursor ?? '';
    expect(cursor).not.toBe('');
    const cases: [string, number, string][] = [
      [`${AGENTS}?range=all&limit=1&cursor=${cursor}&kind=subagent`, 400, 'cursor_invalid'],
      [`${AGENTS}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${AGENTS}?kind=robot`, 400, 'validation_failed'],
      [`${AGENTS}?limit=999`, 400, 'validation_failed'],
      [`${AGENTS}?state=working&state=stale`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});
