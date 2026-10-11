import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { TurnsRepo, type TurnEndKind, type TurnWrite } from './turns.ts';

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
  readonly repo: TurnsRepo;
  readonly s1: number;
  readonly s2: number;
  readonly main1: number;
  readonly main2: number;
}

function fixture(): Fixture {
  const db = openInstanceDb({
    path: join(tempDir('turns').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
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
  return { db, repo: new TurnsRepo(db), s1, s2, main1: main(s1), main2: main(s2) };
}

function turn(f: Fixture, promptId: string, over: Partial<TurnWrite> = {}): TurnWrite {
  return {
    sessionId: f.s1,
    agentId: null,
    promptId,
    startedAt: null,
    endedAt: null,
    endKind: null,
    endRank: null,
    endTie: null,
    origin: null,
    toolCount: 0,
    ...over,
  };
}

function end(at: number, rank: number, tie: string, kind: TurnEndKind): Partial<TurnWrite> {
  return { endedAt: at, endRank: rank, endTie: tie, endKind: kind };
}

interface TurnDbRow {
  id: number;
  session_id: number;
  agent_id: number | null;
  prompt_id: string;
  started_at: number | null;
  ended_at: number | null;
  end_kind: string | null;
  end_rank: number | null;
  end_tie: string | null;
  origin: string | null;
  tool_count: number;
}

function turnRows(db: InstanceDb): TurnDbRow[] {
  return db.driver.prepare<TurnDbRow>('SELECT * FROM turns ORDER BY id').all();
}

function apply(f: Fixture, ...writes: TurnWrite[]): void {
  withWriteTx(f.db, CTX, (tx) => {
    for (const write of writes) f.repo.upsert(CTX, tx, write);
  });
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

describe('TurnsRepo.upsert (03 3.6)', () => {
  it('inserts a turn with every column and writes no change row (turns have no change kind of their own)', () => {
    const f = fixture();
    apply(
      f,
      turn(f, 'p1', {
        agentId: f.main1,
        startedAt: T0 + 100,
        ...end(T0 + 200, 60, 'stop-1', 'stop'),
        origin: 'user',
        toolCount: 3,
      }),
    );
    expect(turnRows(f.db)).toEqual([
      {
        id: 1,
        session_id: f.s1,
        agent_id: f.main1,
        prompt_id: 'p1',
        started_at: T0 + 100,
        ended_at: T0 + 200,
        end_kind: 'stop',
        end_rank: 60,
        end_tie: 'stop-1',
        origin: 'user',
        tool_count: 3,
      },
    ]);
    expect(f.db.headSeq()).toBe(0);
  });

  it('get returns the turn of a session by prompt id', () => {
    const f = fixture();
    apply(f, turn(f, 'p1', { startedAt: T0 + 100, ...end(T0 + 200, 60, 'a', 'stop'), origin: 'user', toolCount: 2 }));
    expect(f.repo.get(CTX, f.s1, 'p1')).toEqual({
      id: 1,
      sessionId: f.s1,
      agentId: null,
      promptId: 'p1',
      startedAt: T0 + 100,
      endedAt: T0 + 200,
      endKind: 'stop',
      endRank: 60,
      endTie: 'a',
      origin: 'user',
      toolCount: 2,
    });
    expect(f.repo.get(CTX, f.s2, 'p1')).toBeUndefined();
    expect(f.repo.get(CTX, f.s1, 'p2')).toBeUndefined();
  });

  it('the same prompt id of two sessions is two turns', () => {
    const f = fixture();
    apply(f, turn(f, 'p1', { startedAt: T0 + 1 }), turn(f, 'p1', { sessionId: f.s2, startedAt: T0 + 2 }));
    expect(turnRows(f.db).map((row) => [row.session_id, row.started_at])).toEqual([
      [f.s1, T0 + 1],
      [f.s2, T0 + 2],
    ]);
  });

  it('started_at is the minimum with NULL meaning not known; origin the first non-null; tool_count the maximum', () => {
    const f = fixture();
    apply(f, turn(f, 'p1', { startedAt: null, origin: null, toolCount: 1 }));
    apply(f, turn(f, 'p1', { startedAt: T0 + 50, origin: 'user', toolCount: 4 }));
    apply(f, turn(f, 'p1', { startedAt: T0 + 70, origin: 'queued', toolCount: 2 }));
    apply(f, turn(f, 'p1', { startedAt: T0 + 40, origin: null, toolCount: 3 }));
    apply(f, turn(f, 'p1', { startedAt: null }));
    expect(turnRows(f.db)).toHaveLength(1);
    expect(turnRows(f.db)[0]).toMatchObject({ started_at: T0 + 40, origin: 'user', tool_count: 4 });
  });

  it('the agent of the first write stays', () => {
    const f = fixture();
    apply(f, turn(f, 'p1', { agentId: null }));
    apply(f, turn(f, 'p1', { agentId: f.main1 }));
    expect(turnRows(f.db)[0]?.agent_id).toBeNull();
  });

  describe('the end fields follow the greater stamp (ended_at, end_rank, end_tie)', () => {
    it('a null end never replaces an end', () => {
      const f = fixture();
      apply(f, turn(f, 'p1', end(T0 + 200, 20, 'a', 'end_turn')));
      apply(f, turn(f, 'p1', { startedAt: T0 + 100 }));
      expect(turnRows(f.db)[0]).toMatchObject({ ended_at: T0 + 200, end_rank: 20, end_tie: 'a', end_kind: 'end_turn' });
    });

    it('an end replaces a missing end', () => {
      const f = fixture();
      apply(f, turn(f, 'p1', { startedAt: T0 + 100 }));
      apply(f, turn(f, 'p1', end(T0 + 200, 20, 'a', 'end_turn')));
      expect(turnRows(f.db)[0]).toMatchObject({ ended_at: T0 + 200, end_rank: 20, end_tie: 'a', end_kind: 'end_turn' });
    });

    it('at the same time the higher rank wins, then the greater tie', () => {
      const f = fixture();
      apply(f, turn(f, 'p1', end(T0 + 200, 20, 'z', 'end_turn')));
      apply(f, turn(f, 'p1', end(T0 + 200, 60, 'a', 'stop')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_rank: 60, end_tie: 'a', end_kind: 'stop' });
      apply(f, turn(f, 'p1', end(T0 + 200, 60, 'b', 'stop_failure')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_rank: 60, end_tie: 'b', end_kind: 'stop_failure' });
      apply(f, turn(f, 'p1', end(T0 + 200, 60, 'a', 'stop')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_tie: 'b', end_kind: 'stop_failure' });
      // an identical stamp changes nothing
      apply(f, turn(f, 'p1', end(T0 + 200, 60, 'b', 'turn_duration')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_tie: 'b', end_kind: 'stop_failure' });
    });

    it('replays the sequence of [exp:X13]: end_turn, prompt, Stop of equal time wins by rank, older interrupt ignored, newer wins', () => {
      const f = fixture();
      apply(f, turn(f, 'p1', end(T0 + 200, 20, 'rec', 'end_turn')));
      expect(turnRows(f.db)[0]).toMatchObject({ started_at: null, ended_at: T0 + 200, end_kind: 'end_turn' });
      apply(f, turn(f, 'p1', { startedAt: T0 + 100, origin: 'user' }));
      expect(turnRows(f.db)[0]).toMatchObject({ started_at: T0 + 100, end_kind: 'end_turn', end_rank: 20 });
      apply(f, turn(f, 'p1', end(T0 + 200, 60, 'hook', 'stop')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_kind: 'stop', end_rank: 60, end_tie: 'hook', ended_at: T0 + 200 });
      apply(f, turn(f, 'p1', end(T0 + 150, 80, 'int-old', 'interrupted')));
      expect(turnRows(f.db)[0]).toMatchObject({ end_kind: 'stop', ended_at: T0 + 200 });
      apply(f, turn(f, 'p1', end(T0 + 250, 80, 'int-new', 'interrupted')));
      expect(turnRows(f.db)[0]).toMatchObject({
        end_kind: 'interrupted',
        ended_at: T0 + 250,
        end_rank: 80,
        end_tie: 'int-new',
      });
    });
  });

  it('refuses a turn that ends before it starts, an unknown end kind and a negative tool count (CHECK)', () => {
    const f = fixture();
    expect(
      dbErrorOf(() => {
        apply(f, turn(f, 'p1', { startedAt: T0 + 300, ...end(T0 + 200, 20, 'a', 'stop') }));
      }),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'check',
    });
    // a deliberately invalid end kind: the type cannot say it, the CHECK constraint must
    const bad = { ...turn(f, 'p2'), endedAt: T0, endRank: 1, endTie: 'a', endKind: 'nope' } as unknown as TurnWrite;
    expect(
      dbErrorOf(() => {
        apply(f, bad);
      }),
    ).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(
      dbErrorOf(() => {
        apply(f, turn(f, 'p3', { toolCount: -1 }));
      }),
    ).toMatchObject({ code: 'db_constraint' });
    expect(turnRows(f.db)).toEqual([]);
  });

  it('refuses an unknown session and an agent of another session (foreign key)', () => {
    const f = fixture();
    expect(
      dbErrorOf(() => {
        apply(f, turn(f, 'p1', { sessionId: 999 }));
      }),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(
      dbErrorOf(() => {
        apply(f, turn(f, 'p1', { agentId: f.main2 }));
      }),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(
      dbErrorOf(() => {
        apply(f, turn(f, 'p1', { agentId: 999 }));
      }),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(turnRows(f.db)).toEqual([]);
  });

  it('every public method asserts the scope first', () => {
    const f = fixture();
    expect(
      dbErrorOf(() => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.upsert(FOREIGN, tx, turn(f, 'p1'));
        });
      }).code,
    ).toBe('scope_mismatch');
    expect(dbErrorOf(() => f.repo.get(FOREIGN, f.s1, 'p1')).code).toBe('scope_mismatch');
    expect(turnRows(f.db)).toEqual([]);
  });

  it('is deleted with its session (cascade) and the repository leaves that to the schema', () => {
    const f = fixture();
    apply(f, turn(f, 'p1', { startedAt: T0 + 1 }));
    f.db.driver.prepare('DELETE FROM sessions WHERE id = ?').run([f.s1]);
    expect(turnRows(f.db)).toEqual([]);
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

describe('TurnsRepo.upsert: 200 seeded permutations give the same row (DA-T-DB-13)', () => {
  const BASE_SEED = 20261013;
  const ORDERS = 200;

  it(`the [exp:X13] writes and more, shuffled and batched (base seed ${String(BASE_SEED)})`, () => {
    const f = fixture();
    const writes: TurnWrite[] = [
      turn(f, 'p1', end(T0 + 200, 20, 'rec', 'end_turn')),
      turn(f, 'p1', { startedAt: T0 + 100, origin: 'user' }),
      turn(f, 'p1', end(T0 + 200, 60, 'hook', 'stop')),
      turn(f, 'p1', end(T0 + 150, 80, 'int-old', 'interrupted')),
      turn(f, 'p1', end(T0 + 250, 80, 'int-new', 'interrupted')),
      turn(f, 'p1', end(T0 + 250, 80, 'int-new', 'interrupted')),
      turn(f, 'p1', { startedAt: T0 + 120, toolCount: 5 }),
      turn(f, 'p1', { toolCount: 2 }),
      turn(f, 'p1', end(T0 + 250, 40, 'dur', 'turn_duration')),
      turn(f, 'p1', end(T0 + 250, 80, 'int-aaa', 'stop_failure')),
    ];
    let expected: unknown;
    for (let order = 0; order < ORDERS; order += 1) {
      const seed = BASE_SEED + order;
      const rand = prng(seed);
      f.db.driver.exec('DELETE FROM turns');
      const sequence = shuffled(writes, rand);
      for (let at = 0; at < sequence.length;) {
        const batch = sequence.slice(at, at + 1 + Math.floor(rand() * 4));
        apply(f, ...batch);
        at += batch.length;
      }
      const rows = f.db.driver
        .prepare(
          'SELECT session_id, agent_id, prompt_id, started_at, ended_at, end_kind, end_rank, end_tie, origin, tool_count FROM turns',
        )
        .all();
      expected ??= rows;
      expect(rows, `seed ${String(seed)}`).toEqual(expected);
    }
    expect(expected).toEqual([
      {
        session_id: f.s1,
        agent_id: null,
        prompt_id: 'p1',
        started_at: T0 + 100,
        ended_at: T0 + 250,
        end_kind: 'interrupted',
        end_rank: 80,
        end_tie: 'int-new',
        origin: 'user',
        tool_count: 5,
      },
    ]);
  });
});
