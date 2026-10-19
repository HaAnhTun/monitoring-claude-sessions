// The search routes on a real instance behind a real HTTP server (03 6.1, 6.4, 7.4, 19.2, 19.5): `GET /api/v3/search/transcript`
// and `GET /api/v3/search/transcripts`. Response validation is on (registry N3), so every body here already matches its strict
// schema; the tests add the values, the refusals, the two slots with `429 search_busy`, the abort of a client and the proof that
// the text of a query reaches no log line, no error entry and no error body (DA-T-PRIV-4).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createEntryIndexService,
  createSearchService,
  defaultSkillDir,
  healthGaugesOf,
  initWorkspace,
  type InstanceContext,
  type Logger,
  type QueryDeps,
  type SqlValue,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, HealthReportSchema, InstanceInfoSchema, RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs, waitFor } from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../../src/app.ts';
import { bindRouteServices, type RouteDeps } from '../../src/route-adapter.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';
import { searchRoutes } from '../../src/routes/search.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';
const SENTINEL = 'SENTINEL-QUERY-TEXT-7391';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly transcripts: string;
  /** Every call the logger of the instance received, as text. */
  readonly logged: string[];
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

function capturingLogger(logged: string[]): Logger {
  const note =
    (level: string) =>
    (...args: unknown[]): void => {
      logged.push(`${level} ${JSON.stringify(args)}`);
    };
  return {
    debug: note('debug'),
    info: note('info'),
    warn: note('warn'),
    error: note('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** What an app is mounted with: the context, or a copy of it whose queries a test replaced. */
type AppCtx = RouteDeps['ctx'];

async function startInstance(patch?: (ctx: InstanceContext) => AppCtx): Promise<Running> {
  const root = makeTemp('contract-search').path;
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
  const logged: string[] = [];
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: capturingLogger(logged),
  });
  const port = await allocatePort();
  const app = createApp({
    ctx: patch === undefined ? ctx : patch(ctx),
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
  const transcripts = path.join(root, 'transcripts');
  mkdirSync(transcripts);
  return { ctx, port, transcripts, logged };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly json: unknown;
}

async function get(run: Pick<Running, 'port'>, route: string): Promise<Reply> {
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

const prompt = (text: string): string =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  });

/** A session with its transcript on disk; `agent` adds a subagent file. */
function addSession(run: Running, n: number, texts: readonly string[], agent?: string): string {
  const uid = uidOf(n);
  put(run.ctx, 'sessions', {
    session_uid: uid,
    label: `session ${String(n)}`,
    matched: 1,
    first_seen_at: NOW - 60 * MINUTE,
    started_at: NOW - 60 * MINUTE,
    last_activity_at: NOW - n * MINUTE,
    updated_at: NOW,
  });
  const file = path.join(run.transcripts, `${uid}.jsonl`);
  writeFileSync(file, texts.map((text) => `${prompt(text)}\n`).join(''));
  put(run.ctx, 'transcript_files', {
    path: file,
    path_key: file,
    kind: 'session',
    session_uid: uid,
    discovered_at: NOW,
    updated_at: NOW,
  });
  if (agent !== undefined) {
    const agentFile = path.join(run.transcripts, uid, 'subagents', `agent-${agent}.jsonl`);
    mkdirSync(path.dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, `${prompt('MARKER inside the agent')}\n`);
    put(run.ctx, 'transcript_files', {
      path: agentFile,
      path_key: agentFile,
      kind: 'subagent',
      session_uid: uid,
      agent_uid: agent,
      discovered_at: NOW,
      updated_at: NOW,
    });
  }
  return uid;
}

const SEARCH = '/api/v3/search/transcript';
const SEARCH_ALL = '/api/v3/search/transcripts';

describe('GET /api/v3/search/transcript', () => {
  it('answers with the matches, the echo of the query and a coverage that says what was searched', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, ['first prompt', 'the MARKER is here', 'last one'], 'agentfixture0001');
    const reply = await get(run, `${SEARCH}?session=${uid}&q=marker`);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json).toMatchObject({
      matches: [{ i: 1, k: 'prompt', name: null, snippet: 'the MARKER is here' }],
      count: 1,
      truncated: false,
      partial: false,
      complete: true,
      searchedEntries: 3,
      query: { q: 'marker', kinds: ['prompt', 'say', 'think', 'tool', 'result'], tool: null, errors: false },
      coverage: { scope: 'session', filesInScope: 1, filesScanned: 1, complete: true, stoppedBy: 'complete' },
    });
    const agent = await get(run, `${SEARCH}?session=${uid}&agent=agentfixture0001&q=marker`);
    expect(agent.json).toMatchObject({
      coverage: { scope: 'agent' },
      matches: [{ snippet: 'MARKER inside the agent' }],
    });
  });

  it('takes the filters and honours the match limit', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, ['MARKER one', 'MARKER two', 'MARKER three']);
    const limited = await get(run, `${SEARCH}?session=${uid}&q=marker&limit=2`);
    expect(limited.json).toMatchObject({ count: 2, truncated: true, partial: true, complete: false });
    expect(limited.json).toMatchObject({ coverage: { stoppedBy: 'match_limit', complete: false } });
    const kinds = await get(run, `${SEARCH}?session=${uid}&q=marker&kinds=say,tool`);
    expect(kinds.json).toMatchObject({ count: 0, query: { kinds: ['say', 'tool'] } });
    const noQuery = await get(run, `${SEARCH}?session=${uid}&errors=1`);
    expect(noQuery.json).toMatchObject({ count: 0, query: { q: '', errors: true } });
  });

  it('refuses a session that is unknown, an agent that is unknown and a transcript that is gone', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, ['MARKER']);
    const unknown = await get(run, `${SEARCH}?session=${uidOf(99)}&q=marker`);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'session_not_found']);
    const agent = await get(run, `${SEARCH}?session=${uid}&agent=nosuchagent&q=marker`);
    expect([agent.status, codeOf(agent)]).toEqual([404, 'agent_not_found']);
    run.ctx.db.driver.prepare("UPDATE transcript_files SET state = 'missing' WHERE session_uid = ?").run([uid]);
    const gone = await get(run, `${SEARCH}?session=${uid}&q=marker`);
    expect([gone.status, codeOf(gone)]).toEqual([410, 'transcript_gone']);
  });

  it('checks the parameters and the bounds of the budget', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, ['MARKER']);
    const status = async (query: string): Promise<[number, string | undefined]> => {
      const reply = await get(run, `${SEARCH}?session=${uid}&${query}`);
      return [reply.status, codeOf(reply)];
    };
    expect(await status('q=marker&budgetMs=99')).toEqual([400, 'validation_failed']);
    expect((await get(run, `${SEARCH}?session=${uid}&q=marker&budgetMs=100`)).status).toBe(200);
    expect((await get(run, `${SEARCH}?session=${uid}&q=marker&budgetMs=10000`)).status).toBe(200);
    expect(await status('q=marker&budgetMs=10001')).toEqual([400, 'validation_failed']);
    expect(await status('q=marker&limit=0')).toEqual([400, 'validation_failed']);
    expect(await status('q=marker&limit=1001')).toEqual([400, 'validation_failed']);
    expect(await status('q=marker&kinds=nonsense')).toEqual([400, 'validation_failed']);
    expect(await status('q=a&q=b')).toEqual([400, 'param_repeated']);
    expect((await get(run, `${SEARCH}?q=marker`)).status).toBe(400);
    const post = await httpRequest(run.port, `${SEARCH}?session=${uid}&q=marker`, { method: 'POST', body: '' });
    expect(post.status).toBe(405);
  });
});

describe('GET /api/v3/search/transcripts', () => {
  it('searches the instance, session by session, and says what it searched', async () => {
    const run = await startInstance();
    const first = addSession(run, 1, ['plain', 'a MARKER in the first'], 'agentfixture0001');
    const second = addSession(run, 2, ['and a MARKER in the second']);
    const reply = await get(run, `${SEARCH_ALL}?q=marker`);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      query: { q: 'marker', kinds: ['prompt', 'say', 'think', 'tool', 'result'] },
      truncated: false,
      continuation: null,
      coverage: { scope: 'instance', filesInScope: 3, filesScanned: 3, complete: true, stoppedBy: 'complete' },
    });
    const matches = (
      reply.json as { matches: { sessionId: string; sessionLabel: string; agentId: string; i: number }[] }
    ).matches;
    expect(matches.map((m) => [m.sessionId, m.sessionLabel, m.agentId, m.i])).toEqual([
      [first, 'session 1', 'main', 1],
      [first, 'session 1', 'agentfixture0001', 0],
      [second, 'session 2', 'main', 0],
    ]);
    expect((reply.json as { coverage: { note: string } }).coverage.note).toContain('Searched 3 of 3 transcript files');
  });

  it('pages with a continuation handle and refuses one that does not belong to the request', async () => {
    const run = await startInstance();
    addSession(run, 1, ['MARKER 1a', 'MARKER 1b']);
    addSession(run, 2, ['MARKER 2a', 'MARKER 2b']);
    const first = await get(run, `${SEARCH_ALL}?q=marker&limit=3`);
    const page1 = first.json as { matches: { snippet: string }[]; continuation: string | null; truncated: boolean };
    expect(page1.matches).toHaveLength(3);
    expect(page1.truncated).toBe(true);
    expect(page1.continuation).toMatch(/^c-[A-Za-z0-9_-]+$/);
    const second = await get(run, `${SEARCH_ALL}?q=marker&limit=3&continue=${page1.continuation ?? ''}`);
    const page2 = second.json as {
      matches: { snippet: string }[];
      continuation: string | null;
      coverage: { complete: boolean };
    };
    expect([...page1.matches, ...page2.matches].map((m) => m.snippet)).toEqual([
      'MARKER 1a',
      'MARKER 1b',
      'MARKER 2a',
      'MARKER 2b',
    ]);
    expect(page2.continuation).toBeNull();
    expect(page2.coverage.complete).toBe(true);

    for (const query of [
      `q=marker&continue=c-forged-handle`,
      `q=other&continue=${page1.continuation ?? ''}`,
      `q=marker&kinds=say&continue=${page1.continuation ?? ''}`,
    ]) {
      const refused = await get(run, `${SEARCH_ALL}?${query}`);
      expect([refused.status, codeOf(refused)], query).toEqual([400, 'cursor_invalid']);
    }
    expect((await get(run, `${SEARCH_ALL}?q=marker&continue=not-a-handle`)).status).toBe(400);
  });

  it('refuses a query of one character and checks the other parameters', async () => {
    const run = await startInstance();
    addSession(run, 1, ['MARKER']);
    const short = await get(run, `${SEARCH_ALL}?q=a`);
    expect([short.status, codeOf(short)]).toEqual([400, 'query_too_short']);
    const missing = await get(run, SEARCH_ALL);
    expect(missing.status).toBe(400);
    expect(codeOf(missing)).toBe('validation_failed');
    expect(codeOf(await get(run, `${SEARCH_ALL}?q=marker&budgetMs=50`))).toBe('validation_failed');
    expect(codeOf(await get(run, `${SEARCH_ALL}?q=marker&limit=501`))).toBe('validation_failed');
    expect(codeOf(await get(run, `${SEARCH_ALL}?q=marker&range=1h&from=2026-01-01T00:00:00Z`))).toBe('range_invalid');
    expect((await get(run, `${SEARCH_ALL}?q=marker&range=all&session=${uidOf(99)}`)).json).toMatchObject({
      matches: [],
      coverage: { filesInScope: 0, complete: true },
    });
  });
});

describe('the two slots (DA-T-S-6)', () => {
  /** An instance whose searches wait at the gate until the test opens it; the signals of the requests are recorded. */
  async function gatedInstance(): Promise<{
    run: Running;
    entered: () => number;
    open: () => void;
    signals: AbortSignal[];
    stats: () => ReturnType<ReturnType<typeof createSearchService>['stats']>;
  }> {
    let entered = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const signals: AbortSignal[] = [];
    let service: ReturnType<typeof createSearchService> | undefined;
    const run = await startInstance((ctx) => {
      const real = createEntryIndexService(ctx.db);
      const deps: QueryDeps = {
        config: ctx.config,
        now: () => ctx.clock.now(),
        audit: { entriesBetween: () => Promise.resolve([]) },
      };
      const built = createSearchService(ctx.db, {
        deps,
        index: {
          ensureIndexed: async (c, fileId, opts) => {
            entered += 1;
            await gate;
            return real.ensureIndexed(c, fileId, opts);
          },
        },
      });
      service = built;
      return {
        ...ctx,
        queries: {
          ...ctx.queries,
          searchSession: (c, q, signal) => {
            signals.push(signal);
            return built.searchSession(c, q, signal);
          },
          searchInstance: (c, q, signal) => {
            signals.push(signal);
            return built.searchInstance(c, q, signal);
          },
          searchStats: () => built.stats(),
        },
      };
    });
    return {
      run,
      entered: () => entered,
      open,
      signals,
      stats: () => {
        if (service === undefined) throw new Error('no service');
        return service.stats();
      },
    };
  }

  it('answers the third concurrent search with 429 search_busy and Retry-After 2, and takes it again later', async () => {
    const g = await gatedInstance();
    const uid = addSession(g.run, 1, ['MARKER one']);
    const slow1 = httpRequest(g.run.port, `${SEARCH_ALL}?q=marker`);
    const slow2 = httpRequest(g.run.port, `${SEARCH}?session=${uid}&q=marker`);
    await waitFor(() => g.entered() === 2, { what: 'both searches to hold a slot' });
    const busy = await get(g.run, `${SEARCH_ALL}?q=marker`);
    expect([busy.status, codeOf(busy)]).toEqual([429, 'search_busy']);
    expect(busy.headers['retry-after']).toBe('2');
    const busyToo = await get(g.run, `${SEARCH}?session=${uid}&q=marker`);
    expect([busyToo.status, busyToo.headers['retry-after']]).toEqual([429, '2']);
    g.open();
    expect((await slow1).status).toBe(200);
    expect((await slow2).status).toBe(200);
    expect((await get(g.run, `${SEARCH_ALL}?q=marker`)).status).toBe(200);
    expect(g.stats().total).toBe(3);
  });

  it('stops a search whose client went away and gives its slot back', async () => {
    const g = await gatedInstance();
    addSession(g.run, 1, ['MARKER one']);
    const hold = (route: string): ClientRequest => {
      const req = request({
        host: '127.0.0.1',
        port: g.run.port,
        path: route,
        agent: false,
        headers: { Host: `127.0.0.1:${String(g.run.port)}` },
      });
      req.on('error', () => undefined);
      req.end();
      return req;
    };
    const first = hold(`${SEARCH_ALL}?q=marker`);
    const second = hold(`${SEARCH_ALL}?q=marker`);
    await waitFor(() => g.entered() === 2, { what: 'both searches to hold a slot' });
    first.destroy();
    second.destroy();
    await waitFor(() => g.signals.length === 2 && g.signals.every((signal) => signal.aborted), {
      what: 'the server to see both clients go',
    });
    g.open();
    await waitFor(() => g.stats().byStoppedBy.cancelled === 2, { what: 'both searches to end as cancelled' });
    const after = await get(g.run, `${SEARCH_ALL}?q=marker`);
    expect(after.status).toBe(200);
    expect(g.stats()).toMatchObject({ total: 3, byStoppedBy: { cancelled: 2, complete: 1 } });
  });
});

describe('what a search leaves behind', () => {
  it('puts no text of the query into a log line, an error entry or an error body (DA-T-PRIV-4)', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, [`the ${SENTINEL} is in the transcript`]);
    const replies = [
      await get(run, `${SEARCH}?session=${uid}&q=${SENTINEL}`),
      await get(run, `${SEARCH_ALL}?q=${SENTINEL}`),
      await get(run, `${SEARCH}?session=${uidOf(99)}&q=${SENTINEL}`),
      await get(run, `${SEARCH_ALL}?q=${SENTINEL}&continue=c-${SENTINEL}`),
      await get(run, `${SEARCH_ALL}?q=${SENTINEL}&kinds=${SENTINEL}`),
      await get(run, `${SEARCH}?session=${uid}&q=${SENTINEL}&agent=${SENTINEL}`),
    ];
    // the answer of a search carries the query and its matches: it is the one place they may be
    expect(replies[0]?.body).toContain(SENTINEL);
    expect(replies[1]?.body).toContain(SENTINEL);
    for (const refused of replies.slice(2)) {
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.body, refused.body).not.toContain(SENTINEL);
    }
    expect(run.logged.length).toBeGreaterThan(0);
    expect(run.logged.join('\n')).not.toContain(SENTINEL);
    expect(JSON.stringify(run.ctx.errors.list())).not.toContain(SENTINEL);
  });

  it('does not let a failure of the search carry the query into the log or the error ring', async () => {
    const run = await startInstance((ctx) => ({
      ...ctx,
      queries: {
        ...ctx.queries,
        searchInstance: (_c, q) => Promise.reject(new Error(`the search for ${q.q} failed in ${SENTINEL}`)),
      },
    }));
    const reply = await get(run, `${SEARCH_ALL}?q=${SENTINEL}`);
    expect([reply.status, codeOf(reply)]).toEqual([500, 'internal_error']);
    expect(reply.body).not.toContain(SENTINEL);
    expect(run.logged.join('\n')).not.toContain(SENTINEL);
    expect(run.ctx.errors.list().length).toBeGreaterThan(0);
    expect(JSON.stringify(run.ctx.errors.list())).not.toContain(SENTINEL);
  });

  it('counts the searches in the health report, and the instance offers the instance search and the trend chart', async () => {
    const run = await startInstance();
    const uid = addSession(run, 1, ['MARKER one', 'MARKER two']);
    expect((await get(run, `${SEARCH}?session=${uid}&q=marker`)).status).toBe(200);
    expect((await get(run, `${SEARCH_ALL}?q=marker`)).status).toBe(200);
    expect((await get(run, `${SEARCH_ALL}?q=marker&limit=1`)).status).toBe(200);
    expect((await get(run, `${SEARCH}?session=${uidOf(99)}&q=marker`)).status).toBe(404);

    const health = HealthReportSchema.parse((await get(run, '/api/v3/health')).json);
    expect(health.runtime.search).toEqual({
      total: 3,
      byStoppedBy: { complete: 2, match_limit: 1, time_budget: 0, cancelled: 0 },
    });
    const info = InstanceInfoSchema.parse((await get(run, '/api/v3/instance')).json);
    expect(info.features).toMatchObject({ transcriptSearch: 'instance', usageTrend: true });
    expect(info.limits.searchBudgetMsMax).toBe(10_000);
  });

  it('binds the search gauge once: a second app on the same context mounts without a failure', async () => {
    const run = await startInstance();
    const mounted: RouteDeps = { ctx: run.ctx, nudge: () => undefined, task: null };
    for (let i = 0; i < 2; i += 1) {
      const app = express();
      bindRouteServices(app, { errors: run.ctx.errors, logger: run.ctx.logger, validateResponses: true });
      expect(() => {
        searchRoutes(app, mounted);
      }).not.toThrow();
    }
    const before = healthGaugesOf(run.ctx).search.total;
    const uid = addSession(run, 1, ['MARKER']);
    await get(run, `${SEARCH}?session=${uid}&q=marker`);
    expect(healthGaugesOf(run.ctx).search.total).toBe(before + 1);
  });
});
