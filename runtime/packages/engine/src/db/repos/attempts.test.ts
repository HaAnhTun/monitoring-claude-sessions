import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import {
  AttemptsRepo,
  OPEN_RUN_SQL,
  type AttemptCandidate,
  type AttemptSourceInput,
  type NewAttemptRun,
} from './attempts.ts';
import { SessionsRepo } from './sessions.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const UID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CFG_1 = 'c'.repeat(64);
const CFG_2 = 'd'.repeat(64);

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('attempts-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function source(over: Partial<AttemptSourceInput> = {}): AttemptSourceInput {
  return {
    path: 'C:/logs/chain.log',
    pathKey: 'c:/logs/chain.log',
    generation: 1,
    ino: '99',
    headLen: 64,
    headHash: 'h'.repeat(64),
    readOffset: 0,
    configSha256: CFG_1,
    ...over,
  };
}

function run(sourceId: number, over: Partial<NewAttemptRun> = {}): NewAttemptRun {
  return {
    sourceId,
    generation: 1,
    startOffset: 0,
    part: 'part-1',
    nRaw: '1',
    model: 'model-x',
    effort: 'high',
    startedAt: T0 + 100,
    evidence: 'START line',
    ...over,
  };
}

const END = {
  endOffset: 500,
  endedAt: T0 + 900,
  exitRaw: '0',
  statusRaw: 'done',
  state: 'COMPLETED',
  evidence: 'END line exit 0',
} as const;

function setup(): { db: InstanceDb; repo: AttemptsRepo; sourceId: number } {
  const db = database();
  const repo = new AttemptsRepo(db);
  const sourceId = withWriteTx(db, CTX, (tx) => repo.saveSource(CTX, tx, source()));
  return { db, repo, sourceId };
}

function addSession(db: InstanceDb, uid: string): number {
  return withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: uid, projectId: null, startedAt: T0 }),
  ).id;
}

interface ChangeRow {
  seq: number;
  kind: string;
  op: string;
  session_uid: string | null;
  entity_id: number | null;
  payload: string;
}

function changes(db: InstanceDb): ChangeRow[] {
  return db.driver
    .prepare<ChangeRow>('SELECT seq, kind, op, session_uid, entity_id, payload FROM changes ORDER BY seq')
    .all();
}

/**
 * DA-T-DB-7, DA-I3 (03 4.5): every public method of the repository, called with a foreign context and valid arguments,
 * fails with `scope_mismatch` before any statement. The table is checked against the prototype, so a new method
 * cannot be forgotten.
 */
function expectEveryMethodScoped(
  repo: object,
  calls: Readonly<Record<string, () => unknown>>,
  internal: readonly string[] = [],
): void {
  const proto = Reflect.getPrototypeOf(repo);
  if (proto === null) throw new Error('a repository has a prototype');
  const methods = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && !internal.includes(name))
    .sort();
  expect(Object.keys(calls).sort()).toEqual(methods);
  for (const [name, call] of Object.entries(calls)) {
    expect(call, name).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
  }
}

describe('AttemptsRepo sources', () => {
  it('upserts a source by path key and keeps its id', () => {
    const { db, repo, sourceId } = setup();
    const again = withWriteTx(db, CTX, (tx) =>
      repo.saveSource(CTX, tx, source({ path: 'C:/Logs/Chain.log', generation: 2, readOffset: 321, headLen: 10 })),
    );
    expect(again).toBe(sourceId);
    expect(repo.getSource(CTX, 'c:/logs/chain.log')).toEqual({
      id: sourceId,
      path: 'C:/Logs/Chain.log',
      pathKey: 'c:/logs/chain.log',
      generation: 2,
      ino: '99',
      headLen: 10,
      headHash: 'h'.repeat(64),
      readOffset: 321,
      configSha256: CFG_1,
      updatedAt: T0,
    });
    expect(repo.getSource(CTX, 'c:/other')).toBeUndefined();
  });

  it('writes no change for a source (only run rows are attempt changes)', () => {
    const { db } = setup();
    expect(db.headSeq()).toBe(0);
  });
});

describe('AttemptsRepo.insertRun (DA-T-DB-20)', () => {
  it('inserts a run once per (source, generation, start offset); the second call answers undefined', () => {
    const { db, repo, sourceId } = setup();
    const first = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId)));
    const second = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId, { part: 'changed' })));
    expect(first).toBeTypeOf('number');
    expect(second).toBeUndefined();
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n).toBe(1);
    expect(repo.openRun(CTX, sourceId, 1, 'part-1')).toMatchObject({
      id: first,
      sourceId,
      generation: 1,
      startOffset: 0,
      part: 'part-1',
      nRaw: '1',
      model: 'model-x',
      effort: 'high',
      startedAt: T0 + 100,
      endOffset: null,
      endedAt: null,
      exitRaw: null,
      statusRaw: null,
      endReason: 'open',
      state: 'RUNNING',
      evidence: 'START line',
      sessionRowId: null,
      matchDeltaMs: null,
    });
  });

  it('allows the same offset in another generation', () => {
    const { db, repo, sourceId } = setup();
    const ids = withWriteTx(db, CTX, (tx) => [
      repo.insertRun(CTX, tx, run(sourceId, { generation: 1 })),
      repo.insertRun(CTX, tx, run(sourceId, { generation: 2 })),
    ]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBeTypeOf('number');
  });

  it('clips a 600 code point part to 512, never inside a surrogate pair, and stores an empty model as NULL', () => {
    const { db, repo, sourceId } = setup();
    const emoji = String.fromCodePoint(0x1f680);
    const id = withWriteTx(db, CTX, (tx) =>
      repo.insertRun(CTX, tx, run(sourceId, { part: emoji.repeat(600), model: '', effort: '', nRaw: 'n'.repeat(100) })),
    );
    const stored = repo.openRun(CTX, sourceId, 1, emoji.repeat(600));
    expect(stored?.id).toBe(id);
    expect(Array.from(stored?.part ?? '')).toHaveLength(512);
    expect(stored?.part).toBe(emoji.repeat(512));
    expect(stored?.model).toBeNull();
    expect(stored?.effort).toBeNull();
    expect(Array.from(stored?.nRaw ?? '')).toHaveLength(64);
  });

  it('keeps the legacy empty part (an attempt without a part group)', () => {
    const { db, repo, sourceId } = setup();
    withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId, { part: '' })));
    expect(repo.openRun(CTX, sourceId, 1, '')?.part).toBe('');
  });
});

describe('AttemptsRepo.endRun and supersedeRun (DA-T-DB-20)', () => {
  it('ends an open run once and answers false afterwards', () => {
    const { db, repo, sourceId } = setup();
    const id = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId))) ?? -1;
    const results = withWriteTx(db, CTX, (tx) => [repo.endRun(CTX, tx, id, END), repo.endRun(CTX, tx, id, END)]);
    expect(results).toEqual([true, false]);
    expect(repo.runsByPart(CTX, 'part-1')[0]).toMatchObject({
      id,
      endReason: 'ended',
      state: 'COMPLETED',
      endedAt: T0 + 900,
      evidence: 'END line exit 0',
    });
    expect(repo.openRun(CTX, sourceId, 1, 'part-1')).toBeUndefined();
  });

  it('supersedes an open run once; a run that is not open can be neither ended nor superseded', () => {
    const { db, repo, sourceId } = setup();
    const [a, b] = withWriteTx(db, CTX, (tx) => [
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 0 })) ?? -1,
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 100 })) ?? -1,
    ]);
    withWriteTx(db, CTX, (tx) => repo.endRun(CTX, tx, b, END));
    const results = withWriteTx(db, CTX, (tx) => [
      repo.supersedeRun(CTX, tx, a, 'next START'),
      repo.supersedeRun(CTX, tx, a, 'again'),
      repo.endRun(CTX, tx, a, END),
      repo.supersedeRun(CTX, tx, b, 'ended already'),
      repo.endRun(CTX, tx, 9999, END),
    ]);
    expect(results).toEqual([true, false, false, false, false]);
    const rows = repo.runsByPart(CTX, 'part-1');
    expect(rows.find((r) => r.id === a)).toMatchObject({
      endReason: 'superseded',
      state: 'UNKNOWN',
      evidence: 'next START',
    });
    expect(rows.find((r) => r.id === b)).toMatchObject({ endReason: 'ended', evidence: 'END line exit 0' });
  });

  it('clips the status, exit and evidence texts to their caps', () => {
    const { db, repo, sourceId } = setup();
    const id = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId))) ?? -1;
    withWriteTx(db, CTX, (tx) =>
      repo.endRun(CTX, tx, id, {
        ...END,
        statusRaw: 's'.repeat(700),
        exitRaw: 'e'.repeat(90),
        evidence: 'v'.repeat(2000),
      }),
    );
    const latest = repo.latestRuns(CTX, 1)[0];
    expect(latest?.statusRaw).toHaveLength(512);
    expect(latest?.exitRaw).toHaveLength(64);
    expect(latest?.evidence).toHaveLength(1024);
  });
});

describe('AttemptsRepo exports (98 2.6)', () => {
  it('exports AttemptCandidate, the row of SessionsRepo.attemptCandidates, with the attempts repository', () => {
    expectTypeOf<AttemptCandidate>().toEqualTypeOf<ReturnType<SessionsRepo['attemptCandidates']>[number]>();
  });
});

describe('AttemptsRepo soft references (03 3.4, 3.5 attempt_runs)', () => {
  function failure(call: () => unknown): unknown {
    try {
      call();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('refuses a run of a source that does not exist', () => {
    const { db, repo } = setup();
    const error = failure(() => withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(31_337))));
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    expect(repo.latestRuns(CTX, 5)).toEqual([]);
    expect(changes(db)).toEqual([]);
  });

  it('refuses a match to a session row that does not exist, even for a run that cannot match', () => {
    const { db, repo, sourceId } = setup();
    const id = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId))) ?? -1;
    const before = changes(db).length;
    for (const runId of [id, 9999]) {
      const error = failure(() => withWriteTx(db, CTX, (tx) => repo.setMatch(CTX, tx, runId, 55_555, 1)));
      expect(error, String(runId)).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    }
    expect(repo.latestRuns(CTX, 1)[0]).toMatchObject({ sessionRowId: null, matchDeltaMs: null });
    expect(changes(db)).toHaveLength(before);
  });
});

describe('AttemptsRepo.setMatch (DA-T-DB-20)', () => {
  it('matches an unmatched run once and never re-matches it', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    const b = addSession(db, UID_B);
    const id = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId))) ?? -1;
    const results = withWriteTx(db, CTX, (tx) => [
      repo.setMatch(CTX, tx, id, a, 1500),
      repo.setMatch(CTX, tx, id, b, 10),
      repo.setMatch(CTX, tx, 9999, a, 1),
    ]);
    expect(results).toEqual([true, false, false]);
    expect(repo.latestRuns(CTX, 1)[0]).toMatchObject({ sessionRowId: a, matchDeltaMs: 1500 });
  });

  it('keeps a matched run out of runsToMatch and orders the rest by start', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    withWriteTx(db, CTX, (tx) => {
      const early = repo.insertRun(CTX, tx, run(sourceId, { startOffset: 0, startedAt: T0 + 10 })) ?? -1;
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 100, startedAt: T0 + 30 }));
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 200, startedAt: T0 + 20 }));
      repo.setMatch(CTX, tx, early, a, 5);
    });
    expect(repo.runsToMatch(CTX, T0, 10).map((r) => r.startedAt - T0)).toEqual([20, 30]);
    expect(repo.runsToMatch(CTX, T0 + 25, 10).map((r) => r.startedAt - T0)).toEqual([30]);
    expect(repo.runsToMatch(CTX, T0, 1)).toHaveLength(1);
  });
});

describe('AttemptsRepo reads', () => {
  it('latestRuns returns the newest N in start order and evidenceRun the newest ended run of a session', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 4; i += 1) {
        const id =
          repo.insertRun(
            CTX,
            tx,
            run(sourceId, { startOffset: i * 100, startedAt: T0 + i * 10, part: `p${String(i)}` }),
          ) ?? -1;
        repo.setMatch(CTX, tx, id, a, i);
        if (i !== 3)
          repo.endRun(CTX, tx, id, {
            ...END,
            endOffset: i * 100 + 50,
            endedAt: T0 + i * 10 + 5,
            evidence: `e${String(i)}`,
          });
      }
    });
    expect(repo.latestRuns(CTX, 3).map((r) => r.part)).toEqual(['p1', 'p2', 'p3']);
    expect(repo.evidenceRun(CTX, a)).toMatchObject({ part: 'p2', evidence: 'e2' });
    expect(repo.evidenceRun(CTX, 4242)).toBeUndefined();
  });

  it('runsByPart spans every generation, names the session by provider id and clips the lookup part', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    const longPart = 'p'.repeat(600);
    withWriteTx(db, CTX, (tx) => {
      const first = repo.insertRun(CTX, tx, run(sourceId, { generation: 1, startedAt: T0 + 5 })) ?? -1;
      repo.setMatch(CTX, tx, first, a, 3);
      repo.insertRun(CTX, tx, run(sourceId, { generation: 2, startedAt: T0 + 6 }));
      repo.insertRun(CTX, tx, run(sourceId, { generation: 1, startOffset: 900, part: longPart, startedAt: T0 + 7 }));
    });
    const rows = repo.runsByPart(CTX, 'part-1');
    expect(rows.map((r) => [r.startedAt - T0, r.sessionId, r.endReason, r.state])).toEqual([
      [5, UID_A, 'open', 'RUNNING'],
      [6, null, 'open', 'RUNNING'],
    ]);
    expect(rows[0]).toEqual({
      id: rows[0]?.id,
      part: 'part-1',
      startedAt: T0 + 5,
      endedAt: null,
      endReason: 'open',
      state: 'RUNNING',
      evidence: 'START line',
      sessionId: UID_A,
    });
    expect(repo.runsByPart(CTX, longPart)).toHaveLength(1);
    expect(repo.runsByPart(CTX, 'nothing')).toEqual([]);
  });
});

describe('AttemptsRepo.resetSource (DA-T-DB-20)', () => {
  it('deletes the runs of the source, resets generation and offset and returns the sessions of ended matched runs', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    const b = addSession(db, UID_B);
    withWriteTx(db, CTX, (tx) => repo.saveSource(CTX, tx, source({ generation: 3, readOffset: 777 })));
    withWriteTx(db, CTX, (tx) => {
      const endedMatched = repo.insertRun(CTX, tx, run(sourceId, { generation: 3, startOffset: 0 })) ?? -1;
      repo.setMatch(CTX, tx, endedMatched, a, 1);
      repo.endRun(CTX, tx, endedMatched, END);
      const endedMatchedAgain = repo.insertRun(CTX, tx, run(sourceId, { generation: 3, startOffset: 700 })) ?? -1;
      repo.setMatch(CTX, tx, endedMatchedAgain, a, 2);
      repo.endRun(CTX, tx, endedMatchedAgain, { ...END, endOffset: 900 });
      const openMatched = repo.insertRun(CTX, tx, run(sourceId, { generation: 3, startOffset: 1000 })) ?? -1;
      repo.setMatch(CTX, tx, openMatched, b, 3);
      repo.insertRun(CTX, tx, run(sourceId, { generation: 3, startOffset: 1100 }));
    });
    const rows = withWriteTx(db, CTX, (tx) => repo.resetSource(CTX, tx, sourceId, CFG_2));
    expect(rows).toEqual([a]);
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n).toBe(0);
    expect(repo.getSource(CTX, 'c:/logs/chain.log')).toMatchObject({
      generation: 1,
      readOffset: 0,
      configSha256: CFG_2,
    });
  });

  it('returns nothing and leaves other sources alone when there is nothing to reset', () => {
    const { db, repo, sourceId } = setup();
    const otherId = withWriteTx(db, CTX, (tx) =>
      repo.saveSource(CTX, tx, source({ path: 'C:/logs/other.log', pathKey: 'c:/logs/other.log' })),
    );
    withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(otherId)));
    expect(withWriteTx(db, CTX, (tx) => repo.resetSource(CTX, tx, sourceId, CFG_2))).toEqual([]);
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n).toBe(1);
  });
});

describe('attempt/upsert change (DA-T-RT-13, C40, N-10)', () => {
  it('one transaction that inserts 3 runs and ends 1 writes exactly one change naming the 4 rows and stamping them', () => {
    const { db, repo, sourceId } = setup();
    const existing = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId, { startOffset: 0 }))) ?? -1;
    const before = changes(db);
    expect(before).toHaveLength(1);
    const inserted = withWriteTx(db, CTX, (tx) => {
      const ids = [100, 200, 300].map((startOffset) => repo.insertRun(CTX, tx, run(sourceId, { startOffset })) ?? -1);
      repo.endRun(CTX, tx, existing, END);
      return ids;
    });
    const after = changes(db).slice(before.length);
    expect(after).toHaveLength(1);
    const change = after[0];
    expect(change).toMatchObject({ kind: 'attempt', op: 'upsert', session_uid: null, entity_id: null });
    const payload: unknown = JSON.parse(change?.payload ?? 'null');
    expect(payload).toEqual({ ids: [...inserted, existing], truncated: false });
    const stamped = db.driver
      .prepare<{ id: number; updated_seq: number }>('SELECT id, updated_seq FROM attempt_runs ORDER BY id')
      .all();
    const touched = stamped.filter((r) => r.updated_seq === change?.seq).map((r) => r.id);
    expect(touched.sort((x, y) => x - y)).toEqual([...inserted, existing].sort((x, y) => x - y));
  });

  it('a no-op (duplicate insert, run not open, already matched) reserves no change', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    const id = withWriteTx(db, CTX, (tx) => {
      const created = repo.insertRun(CTX, tx, run(sourceId)) ?? -1;
      repo.endRun(CTX, tx, created, END);
      repo.setMatch(CTX, tx, created, a, 1);
      return created;
    });
    const head = db.headSeq();
    withWriteTx(db, CTX, (tx) => {
      repo.insertRun(CTX, tx, run(sourceId));
      repo.endRun(CTX, tx, id, END);
      repo.supersedeRun(CTX, tx, id, 'x');
      repo.setMatch(CTX, tx, id, a, 2);
    });
    expect(db.headSeq()).toBe(head);
  });

  it('a configuration reset writes a change with truncated true', () => {
    const { db, repo, sourceId } = setup();
    withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId)));
    withWriteTx(db, CTX, (tx) => repo.resetSource(CTX, tx, sourceId, CFG_2));
    const last = changes(db).at(-1);
    expect(last).toMatchObject({ kind: 'attempt', op: 'upsert' });
    expect(JSON.parse(last?.payload ?? 'null')).toEqual({ ids: [], truncated: true });
  });

  it('KNOWN LIMIT (CR-WP-11-2): a reset and a new run in one transaction name only the new run, truncated false', () => {
    const { db, repo, sourceId } = setup();
    withWriteTx(db, CTX, (tx) => {
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 0 }));
      repo.insertRun(CTX, tx, run(sourceId, { startOffset: 10 }));
    });
    const reinserted = withWriteTx(db, CTX, (tx) => {
      repo.resetSource(CTX, tx, sourceId, CFG_2);
      return repo.insertRun(CTX, tx, run(sourceId, { startOffset: 0 }));
    });
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n).toBe(1);
    const last = changes(db).at(-1);
    // two rows were deleted, yet the payload does not say so: the recorder cannot force `truncated` (CR-WP-11-2)
    expect(JSON.parse(last?.payload ?? 'null')).toEqual({ ids: [reinserted], truncated: false });
  });

  it('detaching sessions keeps the rows, clears the match and writes one truncated change', () => {
    const { db, repo, sourceId } = setup();
    const a = addSession(db, UID_A);
    const id = withWriteTx(db, CTX, (tx) => {
      const created = repo.insertRun(CTX, tx, run(sourceId)) ?? -1;
      repo.setMatch(CTX, tx, created, a, 7);
      return created;
    });
    const head = db.headSeq();
    expect(withWriteTx(db, CTX, (tx) => repo.detachSessions(CTX, tx, [a]))).toBe(1);
    expect(repo.runsByPart(CTX, 'part-1')).toEqual([expect.objectContaining({ id, sessionId: null })]);
    expect(repo.latestRuns(CTX, 1)[0]).toMatchObject({ id, sessionRowId: null, matchDeltaMs: null });
    expect(db.headSeq()).toBe(head + 1);
    expect(JSON.parse(changes(db).at(-1)?.payload ?? 'null')).toEqual({ ids: [], truncated: true });
    // nothing left to detach: no change
    expect(withWriteTx(db, CTX, (tx) => repo.detachSessions(CTX, tx, [a]))).toBe(0);
    expect(withWriteTx(db, CTX, (tx) => repo.detachSessions(CTX, tx, []))).toBe(0);
    expect(db.headSeq()).toBe(head + 1);
  });

  it('rolls the rows and the change back together', () => {
    const { db, repo, sourceId } = setup();
    expect(() =>
      withWriteTx(db, CTX, (tx) => {
        repo.insertRun(CTX, tx, run(sourceId));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(db.headSeq()).toBe(0);
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n).toBe(0);
  });
});

describe('AttemptsRepo scope and constraints (DA-T-DB-7)', () => {
  it('refuses a foreign context on every public method', () => {
    const { db, repo, sourceId } = setup();
    const sessionId = addSession(db, UID_A);
    const runId = withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId)));
    if (runId === undefined) throw new Error('the run is inserted');
    expectEveryMethodScoped(
      repo,
      {
        getSource: () => repo.getSource(FOREIGN, 'c:/logs/chain.log'),
        saveSource: () => withWriteTx(db, CTX, (tx) => repo.saveSource(FOREIGN, tx, source({ readOffset: 77 }))),
        resetSource: () => withWriteTx(db, CTX, (tx) => repo.resetSource(FOREIGN, tx, sourceId, CFG_2)),
        openRun: () => repo.openRun(FOREIGN, sourceId, 1, 'part-1'),
        insertRun: () => withWriteTx(db, CTX, (tx) => repo.insertRun(FOREIGN, tx, run(sourceId, { startOffset: 10 }))),
        endRun: () => withWriteTx(db, CTX, (tx) => repo.endRun(FOREIGN, tx, runId, END)),
        supersedeRun: () => withWriteTx(db, CTX, (tx) => repo.supersedeRun(FOREIGN, tx, runId, 'newer run')),
        setMatch: () => withWriteTx(db, CTX, (tx) => repo.setMatch(FOREIGN, tx, runId, sessionId, 1)),
        detachSessions: () => withWriteTx(db, CTX, (tx) => repo.detachSessions(FOREIGN, tx, [sessionId])),
        runsToMatch: () => repo.runsToMatch(FOREIGN, 0, 10),
        latestRuns: () => repo.latestRuns(FOREIGN, 10),
        evidenceRun: () => repo.evidenceRun(FOREIGN, sessionId),
        runsByPart: () => repo.runsByPart(FOREIGN, 'part-1'),
      },
      ['isOpen', 'reserve'],
    );
    expect(repo.openRun(CTX, sourceId, 1, 'part-1')?.id).toBe(runId);
    expect(repo.getSource(CTX, 'c:/logs/chain.log')?.configSha256).toBe(CFG_1);
  });

  it('answers the newest open run of a part first', () => {
    const { db, repo, sourceId } = setup();
    const ids = withWriteTx(db, CTX, (tx) =>
      [0, 50, 20].map((startOffset) => repo.insertRun(CTX, tx, run(sourceId, { startOffset })) ?? -1),
    );
    expect(repo.openRun(CTX, sourceId, 1, 'part-1')).toMatchObject({ id: ids[1], startOffset: 50 });
    expect(repo.openRun(CTX, sourceId, 2, 'part-1')).toBeUndefined();
  });

  it('looks for the open run of a part in the partial index, not in every run of the source (03 3.7)', () => {
    const { db } = setup();
    const plan = db.driver
      .prepare<{ detail: string }>('EXPLAIN QUERY PLAN ' + OPEN_RUN_SQL)
      .all({ sourceId: 1, generation: 1, part: 'part-1' })
      .map((row) => row.detail);
    expect(plan.some((detail) => detail.includes('idx_attempt_runs_open'))).toBe(true);
    expect(plan.filter((detail) => detail.includes('autoindex') || detail.startsWith('SCAN'))).toEqual([]);
  });

  it('refuses a negative limit instead of reading it as no limit', () => {
    const { db, repo, sourceId } = setup();
    withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId)));
    expect(() => repo.latestRuns(CTX, -1)).toThrow(RangeError);
    expect(() => repo.runsToMatch(CTX, 0, -1)).toThrow(RangeError);
    expect(repo.latestRuns(CTX, 5)).toHaveLength(1);
  });

  it('surfaces an empty evidence text as a constraint error', () => {
    const { db, repo, sourceId } = setup();
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.insertRun(CTX, tx, run(sourceId, { evidence: '' })));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });
});
