// `GET /api/v3/completion` on a real instance (03 6.1, 6.3, DA-T-API-15, CE-17; registry C16 and C17): the body equals the engine
// query for every fixture target, exactly one selector is required, a malformed id is 400, an unknown label or part is 404, the
// empty attempt part is accepted and a 513-character one is refused, and the body parses with `CompletionEvidenceSchema`.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  type CompletionTarget,
  type InstanceContext,
  type Logger,
  type SqlValue,
} from '@mcs/engine';
import {
  CompletionEvidenceSchema,
  CompletionResponseSchema,
  ErrorEnvelopeSchema,
  RUNTIME_VERSION,
  routeUrl,
  routes,
} from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';
import { readLegacyTask } from '../src/routes/meta.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const ID = '11111111-1111-4111-8111-111111111111';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
}

const live: { server: Server; ctx: InstanceContext; port: number }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  const root = makeTemp('completion-int').path;
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
  return { ctx, port };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
}

async function get(run: Running, url: string): Promise<Reply> {
  const reply = await httpRequest(run.port, url);
  return { status: reply.status, headers: reply.headers, text: reply.body, json: JSON.parse(reply.body) };
}

const completion = (query: Record<string, string>): string => routeUrl(routes.explainCompletion, { query });

function codeOf(reply: Reply): string | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(reply.json);
  return parsed.success ? parsed.data.error.code : undefined;
}

// ---- rows ---------------------------------------------------------------------------------------------------------------------

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Evidence {
  readonly source: string;
  readonly fact: string;
  readonly at: number | null;
  readonly value?: string;
}

interface SessionSeed {
  readonly n: number;
  readonly label?: string;
  readonly startedAt?: number;
  readonly state: string;
  readonly rule: string;
  readonly basis: 'observed' | 'inferred';
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly presence?: 'open' | 'ended' | 'unknown';
  readonly evidence: readonly Evidence[];
}

/** A session with the stored view that the rule `rule` would have written. Not due: `next_check_at` stays empty. */
function addSession(ctx: InstanceContext, seed: SessionSeed): { id: number; uid: string } {
  const startedAt = seed.startedAt ?? NOW - HOUR;
  const uid = uidOf(seed.n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: seed.label ?? `session ${String(seed.n)}`,
    matched: 1,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: NOW - MINUTE,
    state: seed.state,
    presence: seed.presence ?? 'ended',
    state_basis: seed.basis,
    state_confidence: seed.confidence ?? 'high',
    state_rule: seed.rule,
    state_evidence: JSON.stringify(seed.evidence),
    state_since: NOW - 5 * MINUTE,
    evaluated_at: NOW - MINUTE,
    updated_at: NOW,
  });
  put(ctx, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: NOW - MINUTE,
    updated_at: NOW,
  });
  return { id, uid };
}

interface RunSeed {
  readonly part: string;
  readonly offset: number;
  readonly startedAt: number;
  readonly end?: { readonly state: 'COMPLETED' | 'FAILED'; readonly at: number; readonly evidence: string };
  readonly sessionId?: number;
}

function addRuns(ctx: InstanceContext, runs: readonly RunSeed[]): void {
  const sourceId = put(ctx, 'attempt_sources', {
    path: 'logs/chain.log',
    path_key: 'logs/chain.log',
    generation: 1,
    ino: '1',
    head_len: 8,
    head_hash: 'h'.repeat(64),
    read_offset: 0,
    config_sha256: 'c'.repeat(64),
    updated_at: NOW,
  });
  for (const run of runs) {
    put(ctx, 'attempt_runs', {
      source_id: sourceId,
      generation: 1,
      start_offset: run.offset,
      part: run.part,
      started_at: run.startedAt,
      end_offset: run.end === undefined ? null : run.offset + 50,
      ended_at: run.end?.at ?? null,
      end_reason: run.end === undefined ? 'open' : 'ended',
      state: run.end?.state ?? 'RUNNING',
      evidence: run.end?.evidence ?? 'START line',
      session_id: run.sessionId ?? null,
      updated_at: NOW,
    });
  }
}

/** The fixture sessions of 01 T-CLI-08: S-1 completed (CE-1), S-3a failed (CE-4), S-8e ok (CE-6), S-8e inferred (CE-7), S-4a. */
function seedFixtures(ctx: InstanceContext): void {
  addSession(ctx, {
    n: 1,
    label: 'attempt-complete',
    state: 'completed',
    rule: 'S-1',
    basis: 'observed',
    evidence: [
      { source: 'attempts', fact: 'attempt_row', at: NOW - 2 * MINUTE, value: 'chain log: exit=0 status=PASS' },
    ],
  });
  addSession(ctx, {
    n: 2,
    label: 'stop-failure',
    state: 'failed',
    rule: 'S-3a',
    basis: 'observed',
    confidence: 'medium',
    evidence: [
      { source: 'hook', fact: 'session_end', at: NOW - 3 * MINUTE, value: 'other' },
      { source: 'hook', fact: 'stop_failure', at: NOW - 4 * MINUTE, value: 'rate_limit' },
    ],
  });
  addSession(ctx, {
    n: 3,
    label: 'turn-ended',
    state: 'turn_ended',
    rule: 'S-8e',
    basis: 'observed',
    presence: 'open',
    evidence: [{ source: 'hook', fact: 'stop', at: NOW - 6 * MINUTE }],
  });
  addSession(ctx, {
    n: 4,
    label: 'trailing-cost',
    state: 'turn_ended',
    rule: 'S-8e',
    basis: 'inferred',
    confidence: 'medium',
    evidence: [{ source: 'hook', fact: 'stop', at: NOW - 7 * MINUTE }],
  });
  addSession(ctx, {
    n: 5,
    label: 'daemon-job',
    state: 'completed',
    rule: 'S-4a',
    basis: 'observed',
    evidence: [{ source: 'job', fact: 'job_state', at: NOW - 8 * MINUTE, value: 'done' }],
  });
  addSession(ctx, {
    n: 6,
    label: 'retry',
    startedAt: NOW - 3 * HOUR,
    state: 'completed',
    rule: 'S-3b',
    basis: 'observed',
    evidence: [{ source: 'hook', fact: 'session_end', at: NOW - 2 * HOUR, value: 'other' }],
  });
  addSession(ctx, {
    n: 7,
    label: 'retry',
    startedAt: NOW - HOUR,
    state: 'working',
    rule: 'S-7e',
    basis: 'observed',
    presence: 'open',
    evidence: [{ source: 'hook', fact: 'prompt', at: NOW - 10 * MINUTE }],
  });
  addSession(ctx, {
    n: 8,
    label: '100%_done',
    state: 'completed',
    rule: 'S-3b',
    basis: 'observed',
    evidence: [{ source: 'hook', fact: 'session_end', at: NOW - 9 * MINUTE, value: 'other' }],
  });
  addRuns(ctx, [
    {
      part: 'part-a',
      offset: 0,
      startedAt: NOW - 2 * HOUR,
      end: { state: 'FAILED', at: NOW - HOUR, evidence: 'chain log: exit=1 status=FAIL' },
    },
    {
      part: 'part-b',
      offset: 100,
      startedAt: NOW - 2 * HOUR,
      end: { state: 'COMPLETED', at: NOW - HOUR, evidence: 'PASS' },
    },
    { part: 'part-b', offset: 200, startedAt: NOW - HOUR },
    {
      part: '',
      offset: 300,
      startedAt: NOW - 4 * HOUR,
      end: { state: 'COMPLETED', at: NOW - 3 * HOUR, evidence: 'legacy PASS' },
    },
  ]);
}

const SELECT_SESSION = (n: number): string => completion({ session: uidOf(n) });

// ---- DA-T-API-15 ------------------------------------------------------------------------------------------------------------------

describe('GET /api/v3/completion: the fixture targets (DA-T-API-15)', () => {
  const targets: readonly {
    readonly name: string;
    readonly query: Record<string, string>;
    readonly target: CompletionTarget;
    readonly expected: Record<string, unknown>;
  }[] = [
    {
      name: 'CE-1 attempts row COMPLETED (S-1)',
      query: { session: uidOf(1) },
      target: { sessionId: uidOf(1) },
      expected: {
        outcome: 'completed',
        state: 'completed',
        ruleId: 'S-1',
        sessionId: uidOf(1),
        resolvedBy: 'session_id',
        candidates: 1,
      },
    },
    {
      name: 'CE-4 StopFailure then SessionEnd (S-3a)',
      query: { session: uidOf(2) },
      target: { sessionId: uidOf(2) },
      expected: { outcome: 'failed', state: 'failed', ruleId: 'S-3a', sessionId: uidOf(2), basis: 'observed' },
    },
    {
      name: 'CE-6 Stop without SessionEnd (S-8e)',
      query: { session: uidOf(3) },
      target: { sessionId: uidOf(3) },
      expected: { outcome: 'not_terminal', state: 'turn_ended', ruleId: 'S-8e', basis: 'observed' },
    },
    {
      name: 'CE-7 trailing cost state, an inferred end (S-8e)',
      query: { session: uidOf(4) },
      target: { sessionId: uidOf(4) },
      expected: { outcome: 'not_terminal', state: 'turn_ended', ruleId: 'S-8e', basis: 'inferred' },
    },
    {
      name: 'CE-5 daemon job done (S-4a)',
      query: { session: uidOf(5) },
      target: { sessionId: uidOf(5) },
      expected: { outcome: 'completed', state: 'completed', ruleId: 'S-4a' },
    },
    {
      name: 'CE-10 a label shared by two sessions: the newer one decides',
      query: { label: 'retry' },
      target: { label: 'retry' },
      expected: {
        outcome: 'not_terminal',
        state: 'working',
        ruleId: 'S-7e',
        sessionId: uidOf(7),
        resolvedBy: 'label',
        candidates: 2,
      },
    },
    {
      name: 'a label with wildcard characters is an equal label',
      query: { label: '100%_done' },
      target: { label: '100%_done' },
      expected: { outcome: 'completed', sessionId: uidOf(8), candidates: 1 },
    },
    {
      name: 'CE-12 attempt part, ended FAIL, no session',
      query: { attemptPart: 'part-a' },
      target: { attemptPart: 'part-a' },
      expected: {
        outcome: 'failed',
        state: 'failed',
        ruleId: 'C-ATT-ENDED',
        sessionId: null,
        resolvedBy: 'attempt_part',
        candidates: 1,
      },
    },
    {
      name: 'CE-11 attempt part, latest row open over an older passed row',
      query: { attemptPart: 'part-b' },
      target: { attemptPart: 'part-b' },
      expected: { outcome: 'not_terminal', state: 'running', ruleId: 'C-ATT-OPEN', candidates: 2 },
    },
    {
      name: 'the empty attempt part (C17)',
      query: { attemptPart: '' },
      target: { attemptPart: '' },
      expected: { outcome: 'completed', ruleId: 'C-ATT-ENDED', candidates: 1 },
    },
  ];

  it.each(targets)(
    '$name: the body equals the engine query and parses with the schema',
    async ({ query, target, expected }) => {
      const run = await startInstance();
      seedFixtures(run.ctx);
      const reply = await get(run, completion(query));
      expect(reply.status, reply.text).toBe(200);
      expect(reply.headers['content-type']).toContain('application/json');
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.json).toEqual(run.ctx.queries.explainCompletion(run.ctx.scope, target));
      const { asOfSeq, ...evidence } = CompletionResponseSchema.parse(reply.json);
      expect(asOfSeq).toBe(run.ctx.db.headSeq());
      expect(CompletionEvidenceSchema.parse(evidence)).toMatchObject(expected);
    },
  );

  it('CE-17 renders the words of the evidence at the time of the answer', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    const body = CompletionResponseSchema.parse((await get(run, SELECT_SESSION(1))).json);
    expect(body.evidence).toEqual([
      {
        kind: 'attempts:attempt_row',
        at: new Date(NOW - 2 * MINUTE).toISOString(),
        text: 'chain log: exit=0 status=PASS',
      },
    ]);
    const failed = CompletionResponseSchema.parse((await get(run, SELECT_SESSION(2))).json);
    expect(failed.evidence.map((item) => item.text)).toEqual([
      'session ended (other) 3m ago',
      'turn failed: rate_limit 4m ago',
    ]);
  });

  it('answers sessionId null for an ended attempt row that no session matched (CE-12)', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    const body = CompletionResponseSchema.parse((await get(run, completion({ attemptPart: 'part-a' }))).json);
    expect(body.sessionId).toBeNull();
    expect(body.evidence).toEqual([
      { kind: 'attempts:attempt_row', at: new Date(NOW - HOUR).toISOString(), text: 'chain log: exit=1 status=FAIL' },
    ]);
  });

  it('is deterministic: asking twice gives the same body', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    const first = await get(run, SELECT_SESSION(3));
    const second = await get(run, SELECT_SESSION(3));
    expect(second.json).toEqual(first.json);
  });
});

// ---- 400: the shape of the request ---------------------------------------------------------------------------------------------

describe('GET /api/v3/completion: 400 validation_failed', () => {
  it('needs exactly one of session, label and attemptPart', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    const none = await get(run, '/api/v3/completion');
    expect(none.status).toBe(400);
    expect(codeOf(none)).toBe('validation_failed');
    for (const query of [
      { session: uidOf(1), label: 'retry' },
      { label: 'retry', attemptPart: 'part-a' },
      { session: uidOf(1), attemptPart: '' },
      { session: uidOf(1), label: 'retry', attemptPart: 'part-a' },
    ]) {
      const reply = await get(run, completion(query));
      expect(reply.status, JSON.stringify(query)).toBe(400);
      expect(codeOf(reply), JSON.stringify(query)).toBe('validation_failed');
    }
  });

  it('refuses a malformed session id, an empty one and an unknown parameter', async () => {
    const run = await startInstance();
    for (const url of [
      completion({ session: 'not-a-session' }),
      completion({ session: uidOf(1).toUpperCase() }),
      '/api/v3/completion?session=',
      '/api/v3/completion?label=',
      `${completion({ label: 'retry' })}&extra=1`,
    ]) {
      const reply = await get(run, url);
      expect(reply.status, url).toBe(400);
      expect(codeOf(reply), url).toBe('validation_failed');
    }
  });

  it('refuses a repeated parameter', async () => {
    const run = await startInstance();
    const reply = await get(run, `/api/v3/completion?label=a&label=b`);
    expect(reply.status).toBe(400);
    expect(codeOf(reply)).toBe('param_repeated');
  });

  it('bounds the label to 200 and the part to 512 characters (C17)', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    expect((await get(run, completion({ label: 'a'.repeat(200) }))).status).toBe(404);
    const longLabel = await get(run, completion({ label: 'a'.repeat(201) }));
    expect(longLabel.status).toBe(400);
    expect(codeOf(longLabel)).toBe('validation_failed');
    expect((await get(run, completion({ attemptPart: 'p'.repeat(512) }))).status).toBe(404);
    const longPart = await get(run, completion({ attemptPart: 'p'.repeat(513) }));
    expect(longPart.status).toBe(400);
    expect(codeOf(longPart)).toBe('validation_failed');
  });

  it('refuses a very long label before the database is touched', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    const prepare = vi.spyOn(run.ctx.db.driver, 'prepare');
    const transaction = vi.spyOn(run.ctx.db.driver, 'transaction');
    // 7,000 characters still fit the URL limit of the server (8,192): the schema refuses it
    const refused = await get(run, completion({ label: 'x'.repeat(7000) }));
    expect(refused.status).toBe(400);
    expect(codeOf(refused)).toBe('validation_failed');
    // 9,000 characters are refused by the URL guard earlier still
    const tooLong = await get(run, completion({ label: 'x'.repeat(9000) }));
    expect(tooLong.status).toBe(414);
    expect(codeOf(tooLong)).toBe('uri_too_long');
    expect(prepare).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('is a GET route: a PUT is not allowed', async () => {
    const run = await startInstance();
    const reply = await httpRequest(run.port, SELECT_SESSION(1), { method: 'PUT' });
    expect(reply.status).toBe(405);
  });
});

// ---- 404: no such target --------------------------------------------------------------------------------------------------------

describe('GET /api/v3/completion: 404 completion_target_not_found', () => {
  it('answers an unknown session, label and part, with a message that holds none of them', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    for (const [query, secret] of [
      [{ session: uidOf(99) }, uidOf(99)],
      [{ label: 'a secret label nobody has' }, 'secret label'],
      [{ attemptPart: 'secret-part-nobody-ran' }, 'secret-part'],
    ] as const) {
      const reply = await get(run, completion(query));
      expect(reply.status, JSON.stringify(query)).toBe(404);
      expect(codeOf(reply), JSON.stringify(query)).toBe('completion_target_not_found');
      expect(reply.text).not.toContain(secret);
    }
  });

  it('matches a label exactly: wildcards, case and a prefix do not match', async () => {
    const run = await startInstance();
    seedFixtures(run.ctx);
    for (const label of ['100%', '%', '_', '100_done', '100%_DONE', 'Retry', 'retr', 'RETRY']) {
      const reply = await get(run, completion({ label }));
      expect(reply.status, label).toBe(404);
      expect(codeOf(reply), label).toBe('completion_target_not_found');
    }
  });

  it('accepts a present but empty attempt part: 404 while nobody ran an empty part, never 400', async () => {
    const run = await startInstance();
    const reply = await get(run, '/api/v3/completion?attemptPart=');
    expect(reply.status).toBe(404);
    expect(codeOf(reply)).toBe('completion_target_not_found');
  });

  it('does not resolve a session id that only another instance holds', async () => {
    const holder = await startInstance();
    const other = await startInstance();
    seedFixtures(holder.ctx);
    expect((await get(holder, SELECT_SESSION(1))).status).toBe(200);
    const reply = await get(other, SELECT_SESSION(1));
    expect(reply.status).toBe(404);
    expect(codeOf(reply)).toBe('completion_target_not_found');
  });
});
