import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ToolCallsRepo, type ToolCallWrite, type ToolOutcome } from './tool-calls.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const FOREIGN: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const T0 = FIXTURE_EPOCH_MS;

const opened: InstanceDb[] = [];
// registered after useTempDirs(): Vitest runs `afterEach` hooks in reverse order, so the files close before they are removed
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly repo: ToolCallsRepo;
  /** `sessions.id` of S1 and S2, `agents.id` of their main agents, of a subagent of S1, the transcript file ids */
  readonly s1: number;
  readonly s2: number;
  readonly main1: number;
  readonly main2: number;
  readonly sub1: number;
  readonly file1: number;
  readonly file2: number;
}

function fixture(): Fixture {
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: join(tempDir('tool-calls').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  opened.push(db);
  const session = (uid: string): number =>
    db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([uid, T0, T0, T0, T0]).lastInsertRowid;
  const main = (sessionId: number): number =>
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, T0, T0, T0, T0]).lastInsertRowid;
  const s1 = session(S1);
  const s2 = session(S2);
  const main1 = main(s1);
  const main2 = main(s2);
  const sub1 = db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', ?, 'subagent', 1, ?, ?, ?, ?)",
    )
    .run([s1, main1, T0, T0, T0, T0]).lastInsertRowid;
  const file = (n: number): number =>
    db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?)",
      )
      .run([`f${String(n)}.jsonl`, `f${String(n)}.jsonl`, S1, T0, T0]).lastInsertRowid;
  return { db, clock, repo: new ToolCallsRepo(db), s1, s2, main1, main2, sub1, file1: file(1), file2: file(2) };
}

/** A tool call write with every optional column NULL; each source sets only what it knows. */
function call(f: Fixture, id: string, over: Partial<ToolCallWrite> = {}): ToolCallWrite {
  return {
    sessionId: f.s1,
    agentId: f.main1,
    promptId: null,
    toolUseId: id,
    name: 'Bash',
    mcpServer: null,
    summary: null,
    inputHash: null,
    inputBytes: null,
    startedAt: null,
    endedAt: null,
    batchAt: null,
    outcome: null,
    exitCode: null,
    durationMs: null,
    durationSource: null,
    sources: 0,
    callFileId: null,
    callOffset: null,
    resultFileId: null,
    resultOffset: null,
    subagentId: null,
    workflowRunId: null,
    ...over,
  };
}

interface ToolCallDbRow {
  id: number;
  session_id: number;
  agent_id: number;
  prompt_id: string | null;
  tool_use_id: string;
  name: string;
  mcp_server: string | null;
  summary: string | null;
  input_hash: string | null;
  input_bytes: number | null;
  started_at: number | null;
  ended_at: number | null;
  batch_at: number | null;
  outcome: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  duration_source: string | null;
  sources: number;
  call_file_id: number | null;
  call_offset: number | null;
  result_file_id: number | null;
  result_offset: number | null;
  subagent_id: number | null;
  workflow_run_id: number | null;
  updated_seq: number;
  updated_at: number;
}

function rows(db: InstanceDb): ToolCallDbRow[] {
  return db.driver.prepare<ToolCallDbRow>('SELECT * FROM tool_calls ORDER BY id').all();
}

function rowOf(db: InstanceDb, toolUseId: string): ToolCallDbRow | undefined {
  return db.driver.prepare<ToolCallDbRow>('SELECT * FROM tool_calls WHERE tool_use_id = ?').get([toolUseId]);
}

function changes(
  db: InstanceDb,
): { seq: number; kind: string; op: string; session_uid: string | null; payload: string }[] {
  return db.driver
    .prepare<{ seq: number; kind: string; op: string; session_uid: string | null; payload: string }>(
      'SELECT seq, kind, op, session_uid, payload FROM changes ORDER BY seq',
    )
    .all();
}

function counters(db: InstanceDb, sessionId: number): { stored: [number, number]; counted: [number, number] } {
  const stored = db.driver
    .prepare<{ open: number; total: number }>(
      'SELECT open_tool_count AS open, tool_call_count AS total FROM sessions WHERE id = ?',
    )
    .get([sessionId]);
  const counted = db.driver
    .prepare<{ open: number; total: number }>(
      `SELECT (SELECT count(*) FROM tool_calls WHERE session_id = :id AND ended_at IS NULL AND batch_at IS NULL) AS open,
              (SELECT count(*) FROM tool_calls WHERE session_id = :id) AS total`,
    )
    .get({ id: sessionId });
  return { stored: [stored?.open ?? -1, stored?.total ?? -1], counted: [counted?.open ?? -2, counted?.total ?? -2] };
}

function dbErrorOf(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

function apply(f: Fixture, write: ToolCallWrite): ReturnType<ToolCallsRepo['upsert']> {
  return withWriteTx(f.db, CTX, (tx) => f.repo.upsert(CTX, tx, write));
}

describe('ToolCallsRepo.upsert: a new call (03 3.6)', () => {
  it('stores every column, stamps updated_seq with the reserved seq and announces tool_call/upsert with the id', () => {
    const f = fixture();
    const result = apply(
      f,
      call(f, 'toolu_1', {
        agentId: f.sub1,
        promptId: 'prompt-1',
        name: 'mcp__srv__lookup',
        mcpServer: 'srv',
        summary: 'lookup x',
        inputHash: 'h'.repeat(40),
        inputBytes: 120,
        startedAt: T0 + 100,
        endedAt: T0 + 200,
        batchAt: T0 + 210,
        outcome: 'error',
        exitCode: 2,
        durationMs: 95,
        durationSource: 'hook',
        sources: 27,
        callFileId: f.file1,
        callOffset: 10,
        resultFileId: f.file2,
        resultOffset: 20,
        subagentId: f.sub1,
      }),
    );
    expect(result).toEqual({ id: 1, outcome: 'inserted', seq: 1, countersChanged: true });
    expect(rows(f.db)).toEqual([
      {
        id: 1,
        session_id: f.s1,
        agent_id: f.sub1,
        prompt_id: 'prompt-1',
        tool_use_id: 'toolu_1',
        name: 'mcp__srv__lookup',
        mcp_server: 'srv',
        summary: 'lookup x',
        input_hash: 'h'.repeat(40),
        input_bytes: 120,
        started_at: T0 + 100,
        ended_at: T0 + 200,
        batch_at: T0 + 210,
        outcome: 'error',
        exit_code: 2,
        duration_ms: 95,
        duration_source: 'hook',
        sources: 27,
        call_file_id: f.file1,
        call_offset: 10,
        result_file_id: f.file2,
        result_offset: 20,
        subagent_id: f.sub1,
        workflow_run_id: null,
        updated_seq: 1,
        updated_at: T0,
      },
    ]);
    expect(changes(f.db)).toEqual([
      { seq: 1, kind: 'tool_call', op: 'upsert', session_uid: S1, payload: '{"ids":[1],"truncated":false}' },
    ]);
  });

  it('one announcement per transaction and session lists up to 50 ids and says truncated beyond that', () => {
    const f = fixture();
    withWriteTx(f.db, CTX, (tx) => {
      for (let n = 1; n <= 60; n += 1)
        f.repo.upsert(CTX, tx, call(f, `toolu_${String(n)}`, { startedAt: T0 + n, sources: 1 }));
      f.repo.upsert(CTX, tx, call(f, 'toolu_other', { sessionId: f.s2, agentId: f.main2, sources: 1 }));
    });
    const [first, second] = changes(f.db);
    expect(first?.session_uid).toBe(S1);
    const payload = JSON.parse(first?.payload ?? '{}') as { ids: number[]; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(second).toMatchObject({ session_uid: S2, payload: '{"ids":[61],"truncated":false}' });
    expect(changes(f.db)).toHaveLength(2);
    expect(rows(f.db).every((row) => row.updated_seq === (row.session_id === f.s1 ? 1 : 2))).toBe(true);
  });
});

describe('ToolCallsRepo.upsert: merge rules (DA-T-DB-12, 02 4.1)', () => {
  const OUTCOMES: readonly ToolOutcome[] = ['ok', 'interrupted', 'denied', 'error'];
  const RANK: Readonly<Record<ToolOutcome, number>> = { ok: 1, interrupted: 2, denied: 3, error: 4 };

  const pairs: (readonly [ToolOutcome, ToolOutcome])[] = OUTCOMES.flatMap((a) => OUTCOMES.map((b) => [a, b] as const));

  it.each(pairs)(
    'outcome %s then %s: the higher precedence error > denied > interrupted > ok wins in both orders',
    (a, b) => {
      const f = fixture();
      apply(f, call(f, 'toolu_1', { outcome: a, endedAt: T0 + 100, sources: 8 }));
      apply(f, call(f, 'toolu_1', { outcome: b, endedAt: T0 + 90, sources: 2 }));
      const winner = RANK[a] >= RANK[b] ? a : b;
      expect(rowOf(f.db, 'toolu_1')).toMatchObject({ outcome: winner, ended_at: T0 + 100, sources: 10 });
      // the other order
      apply(f, call(f, 'toolu_2', { outcome: b, endedAt: T0 + 90, sources: 2 }));
      apply(f, call(f, 'toolu_2', { outcome: a, endedAt: T0 + 100, sources: 8 }));
      expect(rowOf(f.db, 'toolu_2')).toMatchObject({ outcome: winner, ended_at: T0 + 100, sources: 10 });
    },
  );

  it('a call without an outcome never overrides one, and an outcome fills a missing one', () => {
    const f = fixture();
    apply(f, call(f, 'toolu_1', { startedAt: T0 + 1, sources: 1 }));
    apply(f, call(f, 'toolu_1', { outcome: 'denied', endedAt: T0 + 5, sources: 2 }));
    apply(f, call(f, 'toolu_1', { startedAt: T0 + 2, sources: 1 }));
    expect(rowOf(f.db, 'toolu_1')).toMatchObject({
      outcome: 'denied',
      started_at: T0 + 1,
      ended_at: T0 + 5,
      sources: 3,
    });
  });

  it('started_at is the minimum and ended_at and batch_at the maximum, with NULL meaning not known', () => {
    const f = fixture();
    const steps: Partial<ToolCallWrite>[] = [
      { startedAt: T0 + 50 },
      { startedAt: T0 + 40, endedAt: T0 + 60, outcome: 'ok' },
      { startedAt: null, endedAt: T0 + 70, batchAt: T0 + 80 },
      { startedAt: T0 + 45, endedAt: T0 + 65, batchAt: T0 + 75 },
      { startedAt: null, endedAt: null, batchAt: null },
    ];
    for (const step of steps) apply(f, call(f, 'toolu_1', { sources: 1, ...step }));
    expect(rowOf(f.db, 'toolu_1')).toMatchObject({ started_at: T0 + 40, ended_at: T0 + 70, batch_at: T0 + 80 });
  });

  it('the other columns keep the first non-null value; the name of the first write stays', () => {
    const f = fixture();
    apply(f, call(f, 'toolu_1', { name: 'Bash', summary: null, promptId: null, sources: 1 }));
    apply(
      f,
      call(f, 'toolu_1', { name: 'Other', summary: 'first', promptId: 'p1', exitCode: 3, inputBytes: 7, sources: 2 }),
    );
    apply(f, call(f, 'toolu_1', { summary: 'second', promptId: 'p2', exitCode: 4, inputBytes: 8, sources: 4 }));
    expect(rowOf(f.db, 'toolu_1')).toMatchObject({
      name: 'Bash',
      summary: 'first',
      prompt_id: 'p1',
      exit_code: 3,
      input_bytes: 7,
      sources: 7,
    });
  });

  it('a hook duration is preferred over a timestamp duration, in both orders, and the first duration is otherwise kept', () => {
    const f = fixture();
    apply(f, call(f, 'toolu_a', { durationMs: 95, durationSource: 'timestamps', sources: 8 }));
    apply(f, call(f, 'toolu_a', { durationMs: 80, durationSource: 'hook', sources: 2 }));
    apply(f, call(f, 'toolu_a', { durationMs: 70, durationSource: 'timestamps', sources: 8 }));
    expect(rowOf(f.db, 'toolu_a')).toMatchObject({ duration_ms: 80, duration_source: 'hook' });
    apply(f, call(f, 'toolu_b', { durationMs: 80, durationSource: 'hook', sources: 2 }));
    apply(f, call(f, 'toolu_b', { durationMs: 95, durationSource: 'timestamps', sources: 8 }));
    expect(rowOf(f.db, 'toolu_b')).toMatchObject({ duration_ms: 80, duration_source: 'hook' });
    apply(f, call(f, 'toolu_c', { durationMs: 95, durationSource: 'timestamps', sources: 8 }));
    apply(f, call(f, 'toolu_c', { durationMs: 99, durationSource: 'timestamps', sources: 8 }));
    expect(rowOf(f.db, 'toolu_c')).toMatchObject({ duration_ms: 95, duration_source: 'timestamps' });
  });

  it('replays the sequence of [exp:X13]: result, PreToolUse, PostToolUseFailure, PostToolBatch, a late ok that does not regress', () => {
    const f = fixture();
    const id = 'toolu_x13';
    // transcript result (ok, source bit 8)
    apply(
      f,
      call(f, id, { outcome: 'ok', endedAt: T0 + 500, durationMs: 100, durationSource: 'timestamps', sources: 8 }),
    );
    expect(rowOf(f.db, id)).toMatchObject({ outcome: 'ok', started_at: null, sources: 8 });
    // hook PreToolUse sets started_at (bits 9)
    apply(f, call(f, id, { startedAt: T0 + 400, promptId: 'p1', sources: 1 }));
    expect(rowOf(f.db, id)).toMatchObject({ started_at: T0 + 400, sources: 9, outcome: 'ok' });
    // hook failure with a duration wins (error, hook duration, bits 11)
    apply(
      f,
      call(f, id, {
        outcome: 'error',
        endedAt: T0 + 505,
        durationMs: 77,
        durationSource: 'hook',
        exitCode: 1,
        sources: 2,
      }),
    );
    expect(rowOf(f.db, id)).toMatchObject({
      outcome: 'error',
      ended_at: T0 + 505,
      duration_ms: 77,
      duration_source: 'hook',
      exit_code: 1,
      sources: 11,
    });
    // PostToolBatch sets batch_at (bits 27)
    apply(f, call(f, id, { batchAt: T0 + 510, sources: 16 }));
    expect(rowOf(f.db, id)).toMatchObject({ batch_at: T0 + 510, sources: 27 });
    // a late ok does not regress
    const late = apply(
      f,
      call(f, id, { outcome: 'ok', endedAt: T0 + 500, durationMs: 100, durationSource: 'timestamps', sources: 8 }),
    );
    expect(late.outcome).toBe('unchanged');
    expect(rowOf(f.db, id)).toMatchObject({
      outcome: 'error',
      ended_at: T0 + 505,
      duration_ms: 77,
      duration_source: 'hook',
      sources: 27,
      started_at: T0 + 400,
      batch_at: T0 + 510,
    });
  });
});

describe('ToolCallsRepo.upsert: change announcement and idempotency', () => {
  it('re-applying the same write changes nothing: no row is rewritten, no seq is reserved, no change row is written', () => {
    const f = fixture();
    const write = call(f, 'toolu_1', { startedAt: T0 + 1, summary: 's', sources: 1 });
    apply(f, write);
    f.clock.advance(5000);
    const before = rows(f.db);
    const headBefore = f.db.headSeq();
    const again = apply(f, write);
    expect(again).toEqual({ id: 1, outcome: 'unchanged', seq: null, countersChanged: false });
    expect(rows(f.db)).toEqual(before);
    expect(f.db.headSeq()).toBe(headBefore);
  });

  it('a merge that changes a column reserves a new seq, restamps updated_seq and updated_at, and lists the id once', () => {
    const f = fixture();
    apply(f, call(f, 'toolu_1', { startedAt: T0 + 1, sources: 1 }));
    f.clock.advance(3000);
    const merged = apply(f, call(f, 'toolu_1', { outcome: 'ok', endedAt: T0 + 9, sources: 2 }));
    expect(merged).toEqual({ id: 1, outcome: 'merged', seq: 2, countersChanged: true });
    expect(rowOf(f.db, 'toolu_1')).toMatchObject({ updated_seq: 2, updated_at: T0 + 3000 });
    expect(changes(f.db).map((c) => c.payload)).toEqual([
      '{"ids":[1],"truncated":false}',
      '{"ids":[1],"truncated":false}',
    ]);
  });

  it('a transaction whose writes are all no-ops writes no change row (no phantom frame)', () => {
    const f = fixture();
    const write = call(f, 'toolu_1', { startedAt: T0 + 1, sources: 1 });
    apply(f, write);
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.upsert(CTX, tx, write);
      f.repo.upsert(CTX, tx, write);
    });
    expect(changes(f.db)).toHaveLength(1);
  });

  it('a failing statement rolls the whole transaction back: nothing stored, nothing announced', () => {
    const f = fixture();
    const error = dbErrorOf(() => {
      withWriteTx(f.db, CTX, (tx) => {
        f.repo.upsert(CTX, tx, call(f, 'toolu_1', { startedAt: T0 + 1, sources: 1 }));
        // CHECK: an outcome needs an end time
        f.repo.upsert(CTX, tx, call(f, 'toolu_2', { outcome: 'ok', endedAt: null, sources: 8 }));
      });
    });
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(rows(f.db)).toEqual([]);
    expect(changes(f.db)).toEqual([]);
    expect(counters(f.db, f.s1)).toEqual({ stored: [0, 0], counted: [0, 0] });
  });
});

describe('ToolCallsRepo.upsert: the counters of the session (03 3.6, idx_tool_calls_open)', () => {
  it('open_tool_count and tool_call_count equal the count queries after every write', () => {
    const f = fixture();
    const steps: ToolCallWrite[] = [
      call(f, 't1', { startedAt: T0 + 1, sources: 1 }),
      call(f, 't2', { startedAt: T0 + 2, sources: 1 }),
      call(f, 't3', { startedAt: T0 + 3, sources: 1 }),
      call(f, 't1', { outcome: 'ok', endedAt: T0 + 10, sources: 2 }), // closed by its end
      call(f, 't2', { batchAt: T0 + 11, sources: 16 }), // closed by a batch (a denied call)
      call(f, 't4', { sessionId: f.s2, agentId: f.main2, startedAt: T0 + 4, sources: 1 }), // another session
      call(f, 't5', { outcome: 'ok', endedAt: T0 + 12, sources: 8 }), // seen only through its result
    ];
    for (const step of steps) {
      apply(f, step);
      for (const sessionId of [f.s1, f.s2]) {
        const c = counters(f.db, sessionId);
        expect(c.stored).toEqual(c.counted);
      }
    }
    expect(counters(f.db, f.s1).stored).toEqual([1, 4]);
    expect(counters(f.db, f.s2).stored).toEqual([1, 1]);
  });

  it('reports whether the counters of the session changed', () => {
    const f = fixture();
    expect(apply(f, call(f, 't1', { startedAt: T0 + 1, sources: 1 })).countersChanged).toBe(true);
    // a merge that touches a column but not the counters
    expect(apply(f, call(f, 't1', { summary: 'x', sources: 4 })).countersChanged).toBe(false);
    expect(apply(f, call(f, 't1', { outcome: 'ok', endedAt: T0 + 3, sources: 8 })).countersChanged).toBe(true);
  });
});

describe('ToolCallsRepo: references, reads and scope', () => {
  it('refuses a session, an agent, a file or a subagent that does not exist, or an agent of another session', () => {
    const f = fixture();
    const cases: Partial<ToolCallWrite>[] = [
      { sessionId: 999 },
      { agentId: 999 },
      { agentId: f.main2 }, // an agent of S2 in a call of S1
      { callFileId: 999, callOffset: 0 },
      { resultFileId: 999, resultOffset: 0 },
      { subagentId: 999 },
      { subagentId: f.main2 },
      { workflowRunId: 999 },
    ];
    for (const over of cases) {
      const error = dbErrorOf(() => apply(f, call(f, 'toolu_1', over)));
      expect(error, JSON.stringify(over)).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    }
    expect(rows(f.db)).toEqual([]);
    expect(changes(f.db)).toEqual([]);
  });

  it('get returns the row by tool_use_id and openForSession lists the calls with neither an end nor a batch', () => {
    const f = fixture();
    apply(f, call(f, 't1', { startedAt: T0 + 1, sources: 1 }));
    apply(f, call(f, 't2', { startedAt: T0 + 2, sources: 1 }));
    apply(f, call(f, 't3', { startedAt: T0 + 3, sources: 1 }));
    apply(f, call(f, 't2', { outcome: 'ok', endedAt: T0 + 5, sources: 2 }));
    expect(f.repo.get(CTX, 't2')).toMatchObject({ toolUseId: 't2', outcome: 'ok', endedAt: T0 + 5, sessionId: f.s1 });
    expect(f.repo.get(CTX, 'nope')).toBeUndefined();
    expect(f.repo.openForSession(CTX, f.s1, 10).map((c) => c.toolUseId)).toEqual(['t1', 't3']);
    expect(f.repo.openForSession(CTX, f.s1, 1).map((c) => c.toolUseId)).toEqual(['t1']);
    expect(f.repo.openForSession(CTX, f.s2, 10)).toEqual([]);
    const plan = f.db.driver
      .prepare<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT id FROM tool_calls WHERE session_id = 1 AND ended_at IS NULL AND batch_at IS NULL ORDER BY started_at LIMIT 10',
      )
      .all()
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('idx_tool_calls_open');
  });

  it('every public method asserts the scope first', () => {
    const f = fixture();
    const calls: (() => unknown)[] = [
      () => withWriteTx(f.db, CTX, (tx) => f.repo.upsert(FOREIGN, tx, call(f, 't1', { sources: 1 }))),
      () => f.repo.get(FOREIGN, 't1'),
      () => f.repo.openForSession(FOREIGN, f.s1, 10),
    ];
    for (const run of calls) expect(dbErrorOf(run).code).toBe('scope_mismatch');
    expect(rows(f.db)).toEqual([]);
  });

  it('refuses a summary of 161 characters (DA-T-PRIV-3)', () => {
    const f = fixture();
    const error = dbErrorOf(() => apply(f, call(f, 't1', { summary: 'x'.repeat(161), sources: 1 })));
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(apply(f, call(f, 't1', { summary: 'x'.repeat(160), sources: 1 })).outcome).toBe('inserted');
  });
});

/** mulberry32: a tiny seeded generator, so that a failing order reproduces from the printed seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe('ToolCallsRepo.upsert: order independence over 200 seeded orders (DA-T-DB-12, adversarial)', () => {
  const BASE_SEED = 20261012;
  const ORDERS = 200;

  /** The five deliveries of one call and a second call that is only seen through a transcript result. */
  function deliveries(f: Fixture): ToolCallWrite[] {
    const id = 'toolu_main';
    return [
      // transcript tool_use
      call(f, id, {
        startedAt: T0 + 100,
        summary: 'tool use',
        sources: 4,
        callFileId: f.file1,
        callOffset: 10,
        subagentId: f.sub1,
      }),
      // hook PreToolUse
      call(f, id, { startedAt: T0 + 105, promptId: 'p1', sources: 1 }),
      // transcript tool_result (ok) with a timestamp duration
      call(f, id, {
        outcome: 'ok',
        endedAt: T0 + 200,
        durationMs: 95,
        durationSource: 'timestamps',
        sources: 8,
        resultFileId: f.file1,
        resultOffset: 99,
      }),
      // hook PostToolUseFailure with a hook duration
      call(f, id, {
        outcome: 'error',
        endedAt: T0 + 203,
        durationMs: 80,
        durationSource: 'hook',
        exitCode: 1,
        sources: 2,
      }),
      // hook PostToolBatch
      call(f, id, { batchAt: T0 + 210, sources: 16 }),
      // an interrupted call seen from two sources
      call(f, 'toolu_int', { startedAt: T0 + 300, sources: 1 }),
      call(f, 'toolu_int', { outcome: 'interrupted', endedAt: T0 + 305, sources: 8 }),
      // a denied call closed by a batch only
      call(f, 'toolu_den', { startedAt: T0 + 400, sources: 1 }),
      call(f, 'toolu_den', { batchAt: T0 + 405, sources: 16 }),
      // a redelivery
      call(f, id, { startedAt: T0 + 105, promptId: 'p1', sources: 1 }),
    ];
  }

  it(`merges to one result in ${String(ORDERS)} shuffled orders and batchings, the counters always right (base seed ${String(BASE_SEED)})`, () => {
    const f = fixture();
    const all = deliveries(f);
    let expected: unknown;
    for (let order = 0; order < ORDERS; order += 1) {
      const seed = BASE_SEED + order;
      const rand = prng(seed);
      f.db.driver.exec(
        'DELETE FROM tool_calls; DELETE FROM changes; UPDATE sessions SET open_tool_count = 0, tool_call_count = 0',
      );
      const sequence = shuffled(all, rand);
      for (let at = 0; at < sequence.length;) {
        const batch = sequence.slice(at, at + 1 + Math.floor(rand() * 4));
        withWriteTx(f.db, CTX, (tx) => {
          for (const write of batch) f.repo.upsert(CTX, tx, write);
        });
        const c = counters(f.db, f.s1);
        expect(c.stored, `seed ${String(seed)}`).toEqual(c.counted);
        at += batch.length;
      }
      const result = f.db.driver
        .prepare(
          `SELECT tool_use_id, name, prompt_id, summary, started_at, ended_at, batch_at, outcome, exit_code, duration_ms,
                  duration_source, sources, call_file_id, call_offset, result_file_id, result_offset, subagent_id
             FROM tool_calls ORDER BY tool_use_id`,
        )
        .all();
      expected ??= result;
      expect(result, `seed ${String(seed)}`).toEqual(expected);
    }
    expect(expected).toEqual([
      {
        tool_use_id: 'toolu_den',
        name: 'Bash',
        prompt_id: null,
        summary: null,
        started_at: T0 + 400,
        ended_at: null,
        batch_at: T0 + 405,
        outcome: null,
        exit_code: null,
        duration_ms: null,
        duration_source: null,
        sources: 17,
        call_file_id: null,
        call_offset: null,
        result_file_id: null,
        result_offset: null,
        subagent_id: null,
      },
      {
        tool_use_id: 'toolu_int',
        name: 'Bash',
        prompt_id: null,
        summary: null,
        started_at: T0 + 300,
        ended_at: T0 + 305,
        batch_at: null,
        outcome: 'interrupted',
        exit_code: null,
        duration_ms: null,
        duration_source: null,
        sources: 9,
        call_file_id: null,
        call_offset: null,
        result_file_id: null,
        result_offset: null,
        subagent_id: null,
      },
      {
        tool_use_id: 'toolu_main',
        name: 'Bash',
        prompt_id: 'p1',
        summary: 'tool use',
        started_at: T0 + 100,
        ended_at: T0 + 203,
        batch_at: T0 + 210,
        outcome: 'error',
        exit_code: 1,
        duration_ms: 80,
        duration_source: 'hook',
        sources: 31,
        call_file_id: f.file1,
        call_offset: 10,
        result_file_id: f.file1,
        result_offset: 99,
        subagent_id: f.sub1,
      },
    ]);
  });
});
