// `GET /api/v3/tool-calls` on a real instance (03 19.3, DA-T-API-1, 6 and 9): a strict page, the filters of 5.4 over HTTP, the
// derived status, keyset paging in both sorts while rows are inserted between the requests, `filter_requires_scope` for `q`,
// and the envelope of the errors the route raises.
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

let toolCounter = 0;

function addTool(ctx: InstanceContext, session: Added, over: Record<string, SqlValue> = {}): number {
  toolCounter += 1;
  return put(ctx, 'tool_calls', {
    session_id: session.id,
    agent_id: session.agentId,
    tool_use_id: `toolu_${String(toolCounter).padStart(4, '0')}`,
    name: 'Bash',
    started_at: NOW - MINUTE,
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

const TOOLS = '/api/v3/tool-calls';

function parseTools(reply: Reply): z.output<typeof routes.listToolCalls.response> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.listToolCalls.response.parse(reply.json);
}

describe('GET /api/v3/tool-calls', () => {
  it('answers a valid request with a strict page, the headers of every API answer and the derived status', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addTool(run.ctx, s, {
      name: 'Read',
      started_at: NOW - 3 * MINUTE,
      ended_at: NOW - 2 * MINUTE,
      outcome: 'ok',
      duration_ms: 900,
    });
    addTool(run.ctx, s, { name: 'Bash', started_at: NOW - MINUTE });
    const reply = await get(run, TOOLS);
    const page = parseTools(reply);
    expectApiHeaders(reply);
    expect(page.items.map((item) => `${item.name}:${item.status}`)).toEqual(['Bash:pending', 'Read:succeeded']);
    expect(page.asOfSeq).toBe(run.ctx.db.headSeq());
  });

  it('applies the filters of 5.4 over HTTP', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const sub = addAgent(run.ctx, s, 'agent-x1');
    addTool(run.ctx, s, {
      name: 'Bash',
      summary: 'npm test',
      outcome: 'error',
      ended_at: NOW - 1000,
      started_at: NOW - 5 * MINUTE,
    });
    addTool(run.ctx, s, { name: 'Read', summary: 'README.md', agent_id: sub, started_at: NOW - 4 * MINUTE });
    addTool(run.ctx, s, { name: 'Edit', started_at: NOW - 3 * 60 * MINUTE });
    const names = async (query: string): Promise<string[]> =>
      parseTools(await get(run, `${TOOLS}?${query}`)).items.map((item) => item.name);
    expect(await names('range=all')).toEqual(['Read', 'Bash', 'Edit']);
    expect(await names('')).toEqual(['Read', 'Bash', 'Edit']); // the default window is 24 h
    expect(await names('range=1h')).toEqual(['Read', 'Bash']);
    expect(await names(`session=${s.uid}&agent=agent-x1`)).toEqual(['Read']);
    expect(await names('tool=Bash,Edit&range=all')).toEqual(['Bash', 'Edit']);
    expect(await names('status=failed')).toEqual(['Bash']);
    expect(await names('status=pending')).toEqual(['Read', 'Edit']);
    expect(await names('q=readme&range=24h')).toEqual(['Read']);
  });

  it('refuses `q` outside a session and a window of at most 7 days, and unknown scopes', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addTool(run.ctx, s, { summary: 'needle' });
    const cases: [string, number, string | undefined][] = [
      ['q=needle&range=all', 400, 'filter_requires_scope'],
      ['q=needle', 200, undefined], // the default window is 24 h
      ['q=needle&range=30d', 400, 'filter_requires_scope'],
      ['q=needle&range=7d', 200, undefined],
      [`q=needle&session=${s.uid}`, 200, undefined],
      [`session=${s.uid}&agent=agent-nope`, 404, 'agent_not_found'],
      [`session=${uidOf(8)}&agent=main`, 404, 'session_not_found'],
      ['agent=main', 400, 'validation_failed'],
      ['status=maybe', 400, 'validation_failed'],
      ['q=ab', 200, undefined],
      ['q=a', 400, 'query_too_short'],
      ['q=a&range=all', 400, 'query_too_short'],
      ['q=ab&status=maybe', 400, 'validation_failed'],
    ];
    for (const [query, status, code] of cases) {
      const reply = await get(run, `${TOOLS}?${query}`);
      expect([reply.status, codeOf(reply)], query).toEqual([status, code]);
    }
  });

  it('walks both sorts and directions while rows are inserted between the requests (DA-T-API-6)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const first = Array.from({ length: 9 }, (_, i) =>
      addTool(run.ctx, s, { started_at: NOW - ((i % 4) + 1) * MINUTE, duration_ms: i % 3 === 0 ? null : i * 100 }),
    );
    for (const sort of ['started', 'duration']) {
      for (const dir of ['asc', 'desc']) {
        const served: number[] = [];
        const extras: number[] = [];
        let cursor = '';
        for (let guard = 0; guard < 100; guard += 1) {
          const page = parseTools(
            await get(
              run,
              `${TOOLS}?range=all&limit=3&sort=${sort}&dir=${dir}${cursor === '' ? '' : `&cursor=${cursor}`}`,
            ),
          );
          served.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
          extras.push(
            addTool(run.ctx, s, { started_at: NOW - 500, duration_ms: 5 }),
            addTool(run.ctx, s, { started_at: NOW - 40 * MINUTE }),
          );
        }
        for (const id of extras) run.ctx.db.driver.prepare('DELETE FROM tool_calls WHERE id = :id').run({ id });
        for (const id of first) {
          expect(
            served.filter((value) => value === id),
            `${sort} ${dir} ${String(id)}`,
          ).toHaveLength(1);
        }
        expect(new Set(served).size, `${sort} ${dir}`).toBe(served.length);
      }
    }
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    for (let i = 0; i < 4; i += 1) addTool(run.ctx, s, { started_at: NOW - i * MINUTE });
    const cursor = parseTools(await get(run, `${TOOLS}?range=all&limit=2`)).nextCursor ?? '';
    expect(cursor).not.toBe('');
    const cases: [string, number, string][] = [
      [`${TOOLS}?range=all&limit=2&cursor=${cursor}&sort=duration`, 400, 'cursor_invalid'],
      [`${TOOLS}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${TOOLS}?limit=0`, 400, 'validation_failed'],
      [`${TOOLS}?tool=a&tool=b`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});
