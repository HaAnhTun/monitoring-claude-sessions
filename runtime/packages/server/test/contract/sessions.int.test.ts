// The session routes on a real instance: a real workspace, a real database, the real query layer and a real HTTP server
// (03 19.3). DA-T-API-1 (valid request, strict response), 6 (keyset paging under inserts, every sort and direction),
// 12 (asOfSeq consistency under concurrent writes) and 17 (audit references attached by the route, I-19), plus the envelope
// of every error these routes raise. Response validation is on, as it is outside production (N3).
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  withWriteTx,
  type InstanceContext,
  type Logger,
  type SqlValue,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, RUNTIME_VERSION, isoSecondsZ, routes } from '@mcs/shared';
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

const SESSIONS = '/api/v3/sessions';

function parseWith<S extends z.ZodType>(schema: S, reply: Reply): z.output<S> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return schema.parse(reply.json);
}

describe('GET /api/v3/sessions', () => {
  it('answers a valid request with a strict page, the headers of every API answer and the asOfSeq of the head', async () => {
    const run = await startInstance();
    for (let i = 1; i <= 3; i += 1) addSession(run.ctx, i, { last_activity_at: NOW - i * MINUTE });
    const reply = await get(run, `${SESSIONS}?includeUnmatched=1&limit=2&includeTotal=1`);
    const page = parseWith(routes.listSessions.response, reply);
    expectApiHeaders(reply);
    expect(page.items.map((item) => item.id)).toEqual([uidOf(1), uidOf(2)]);
    expect(page.total).toBe(3);
    expect(page.nextCursor).not.toBeNull();
    expect(page.asOfSeq).toBe(run.ctx.db.headSeq());
  });

  it('walks every sort and direction over HTTP while rows are inserted between the requests (DA-T-API-6)', async () => {
    const run = await startInstance();
    const first = Array.from(
      { length: 8 },
      (_, i) =>
        addSession(run.ctx, i + 1, { last_activity_at: NOW - (i + 1) * MINUTE, error_count: i % 3, tok_input: i * 7 })
          .uid,
    );
    let extra = 100;
    for (const sort of ['lastActivity', 'started', 'duration', 'tokens', 'state', 'label', 'errors']) {
      for (const dir of ['asc', 'desc']) {
        const served: string[] = [];
        let cursor = '';
        for (let guard = 0; guard < 100; guard += 1) {
          const reply = await get(
            run,
            `${SESSIONS}?includeUnmatched=1&range=all&limit=3&sort=${sort}&dir=${dir}${cursor === '' ? '' : `&cursor=${cursor}`}`,
          );
          const page = parseWith(routes.listSessions.response, reply);
          served.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
          extra += 1;
          addSession(run.ctx, extra, { last_activity_at: NOW - extra * 1000 }); // a row between two requests
        }
        run.ctx.db.driver.prepare('DELETE FROM sessions WHERE session_uid >= :min').run({ min: uidOf(100) });
        for (const uid of first)
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
    for (let i = 1; i <= 3; i += 1) addSession(run.ctx, i);
    const paged = parseWith(routes.listSessions.response, await get(run, `${SESSIONS}?includeUnmatched=1&limit=1`));
    const cursor = paged.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const cases: [string, number, string][] = [
      [`${SESSIONS}?includeUnmatched=1&limit=1&cursor=${cursor}&state=working`, 400, 'cursor_invalid'],
      [`${SESSIONS}?cursor=AAAA`, 400, 'cursor_invalid'],
      [`${SESSIONS}?range=1h&from=2026-10-11T00:00:00Z`, 400, 'range_invalid'],
      [`${SESSIONS}?from=2000-01-01T00:00:00Z&to=2026-10-11T00:00:00Z`, 400, 'range_too_large'],
      [`${SESSIONS}?limit=0`, 400, 'validation_failed'],
      [`${SESSIONS}?sort=nope`, 400, 'validation_failed'],
      [`${SESSIONS}?state=working&state=stale`, 400, 'param_repeated'],
      [`${SESSIONS}?unknownParam=1`, 400, 'validation_failed'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});

describe('GET /api/v3/sessions/:sessionId', () => {
  it('answers the detail with a strict schema and every entity seq at most the asOfSeq (DA-T-API-12)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    withWriteTx(run.ctx.db, run.ctx.scope, (tx) => {
      const seq = tx.changes.reserve('session', 'upsert', { entityId: s.id, sessionUid: s.uid });
      run.ctx.db.driver.prepare('UPDATE sessions SET updated_seq = :seq WHERE id = :id').run({ seq, id: s.id });
    });
    const reply = await get(run, `${SESSIONS}/${s.uid}`);
    const detail = parseWith(routes.getSession.response, reply);
    expectApiHeaders(reply);
    expect(detail.id).toBe(s.uid);
    expect(detail.seq).toBeGreaterThan(0);
    expect(detail.seq).toBeLessThanOrEqual(detail.asOfSeq);
    expect(detail.asOfSeq).toBe(run.ctx.db.headSeq());
    expect(detail.auditRefs).toEqual([]);
  });

  it('attaches the audit references inside the session window after the snapshot, newest first (DA-T-API-17)', async () => {
    const run = await startInstance();
    const started = NOW - HOUR;
    const s = addSession(run.ctx, 1, { started_at: started, last_activity_at: NOW - MINUTE });
    const at = (ms: number): string => isoSecondsZ(ms);
    const audit = path.join(run.instanceDir, 'audit');
    mkdirSync(audit, { recursive: true });
    writeFileSync(
      path.join(audit, 'changes.md'),
      `# Changes\n\n## ${at(NOW - 30 * MINUTE)} | configure\n- Summary: inside the window\n\n## ${at(NOW - 3 * HOUR)} | init-task\n- Summary: before the session\n\n`,
    );
    writeFileSync(
      path.join(audit, 'decisions.md'),
      `# Decisions\n\n## ${at(NOW - 10 * MINUTE)} | Keep it short\n- Decision: also inside\n\n`,
    );
    const detail = parseWith(routes.getSession.response, await get(run, `${SESSIONS}/${s.uid}`));
    expect(detail.auditRefs.map((ref) => `${ref.file}:${ref.title}`)).toEqual([
      'decisions:Keep it short',
      'changes:configure',
    ]);
    expect(detail.auditRefs[1]?.summary).toBe('inside the window');
  });

  it('answers 200 with no references when the audit trail cannot be read (I-19)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const changes = path.join(run.instanceDir, 'audit', 'changes.md');
    rmSync(changes, { force: true });
    mkdirSync(changes, { recursive: true }); // a directory where the file should be: the read fails
    const reply = await get(run, `${SESSIONS}/${s.uid}`);
    expect(parseWith(routes.getSession.response, reply).auditRefs).toEqual([]);
  });

  it('answers 404 session_not_found for an unknown session and 400 for a malformed id', async () => {
    const run = await startInstance();
    const unknown = await get(run, `${SESSIONS}/${uidOf(9)}`);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'session_not_found']);
    const bad = await get(run, `${SESSIONS}/NOT-AN-ID`);
    expect([bad.status, codeOf(bad)]).toEqual([400, 'validation_failed']);
  });

  it('keeps every snapshot consistent while a writer commits in between: asOfSeq <= head, entity seq <= asOfSeq (DA-T-API-12)', async () => {
    const run = await startInstance();
    const rows: Added[] = [];
    const state = { writing: true };
    const writer = (async (): Promise<void> => {
      for (let i = 1; i <= 40 && state.writing; i += 1) {
        withWriteTx(run.ctx.db, run.ctx.scope, (tx) => {
          const s = addSession(run.ctx, i);
          const seq = tx.changes.reserve('session', 'upsert', { entityId: s.id, sessionUid: s.uid });
          run.ctx.db.driver.prepare('UPDATE sessions SET updated_seq = :seq WHERE id = :id').run({ seq, id: s.id });
          rows.push(s);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    })();
    for (let i = 0; i < 25; i += 1) {
      const reply = await get(run, `${SESSIONS}?includeUnmatched=1&range=all&limit=200`);
      const page = parseWith(routes.listSessions.response, reply);
      const headAfter = run.ctx.db.headSeq();
      expect(page.asOfSeq).toBeLessThanOrEqual(headAfter);
      for (const item of page.items) expect(item.seq).toBeLessThanOrEqual(page.asOfSeq);
      const known = rows[rows.length - 1];
      if (known !== undefined) {
        const detail = parseWith(routes.getSession.response, await get(run, `${SESSIONS}/${known.uid}`));
        expect(detail.seq).toBeLessThanOrEqual(detail.asOfSeq);
      }
    }
    state.writing = false;
    await writer;
  });
});

describe('the session sub-routes', () => {
  it('answers the agents, timeline, tool calls and transitions of a session with strict pages', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const sub = addAgent(run.ctx, s, 'agent-x1');
    addEvent(run.ctx, s, { ts: NOW - 3 * HOUR, summary: 'old' });
    addEvent(run.ctx, s, { agent_id: sub, kind: 'tool.failure', severity: 2, summary: 'boom' });
    addTool(run.ctx, s, { started_at: NOW - 3 * HOUR });
    addTool(run.ctx, s, { agent_id: sub });
    put(run.ctx, 'state_transitions', {
      session_id: s.id,
      to_state: 'working',
      rule: 'S-7c',
      basis: 'observed',
      confidence: 'high',
      at: NOW - MINUTE,
    });
    const base = `${SESSIONS}/${s.uid}`;
    const agents = parseWith(routes.sessionAgents.response, await get(run, `${base}/agents`));
    expect(agents.items.map((item) => item.id)).toEqual(['main', 'agent-x1']);
    // the timeline and the tool calls of one session default to the window `all` (03 5.4)
    const timeline = parseWith(routes.sessionTimeline.response, await get(run, `${base}/timeline`));
    expect(timeline.items.map((item) => item.summary)).toEqual(['boom', 'old']);
    const agentOnly = parseWith(
      routes.sessionTimeline.response,
      await get(run, `${base}/timeline?agent=agent-x1&type=tool.failure`),
    );
    expect(agentOnly.items).toHaveLength(1);
    const calls = parseWith(routes.sessionToolCalls.response, await get(run, `${base}/tool-calls`));
    expect(calls.items).toHaveLength(2);
    expect(
      parseWith(routes.sessionToolCalls.response, await get(run, `${base}/tool-calls?agent=agent-x1`)).items,
    ).toHaveLength(1);
    const transitions = parseWith(routes.sessionTransitions.response, await get(run, `${base}/transitions`));
    expect(transitions.items.map((item) => item.to)).toEqual(['working']);
  });

  it('answers 404 for an unknown session or agent and 400 for a filter that needs a scope', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvent(run.ctx, s, { summary: 'needle' });
    const missing = uidOf(9);
    for (const suffix of ['agents', 'timeline', 'tool-calls', 'transitions']) {
      const reply = await get(run, `${SESSIONS}/${missing}/${suffix}`);
      expect([reply.status, codeOf(reply)], suffix).toEqual([404, 'session_not_found']);
    }
    const agent = await get(run, `${SESSIONS}/${s.uid}/timeline?agent=agent-nope`);
    expect([agent.status, codeOf(agent)]).toEqual([404, 'agent_not_found']);
    const transitionsAgent = await get(run, `${SESSIONS}/${s.uid}/transitions?agent=agent-nope`);
    expect([transitionsAgent.status, codeOf(transitionsAgent)]).toEqual([404, 'agent_not_found']);
    const cursor = await get(run, `${SESSIONS}/${s.uid}/timeline?cursor=AAAA`);
    expect([cursor.status, codeOf(cursor)]).toEqual([400, 'cursor_invalid']);
    // `q` inside a session is allowed over any window
    const search = parseWith(
      routes.sessionTimeline.response,
      await get(run, `${SESSIONS}/${s.uid}/timeline?q=needle&range=all`),
    );
    expect(search.items).toHaveLength(1);
  });
});
