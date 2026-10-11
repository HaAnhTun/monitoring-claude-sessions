import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { TranscriptFilesRepo, type NewTranscriptFile } from './transcript-files.ts';

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
  readonly repo: TranscriptFilesRepo;
  readonly s1: number;
  readonly s2: number;
  readonly main1: number;
  readonly sub1: number;
}

function fixture(): Fixture {
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: join(tempDir('transcript-files').path, 'monitor.db'),
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
  const s1 = session(S1);
  const s2 = session(S2);
  const main1 = db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
    )
    .run([s1, T0, T0, T0, T0]).lastInsertRowid;
  const sub1 = db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', ?, 'subagent', 1, ?, ?, ?, ?)",
    )
    .run([s1, main1, T0, T0, T0, T0]).lastInsertRowid;
  return { db, clock, repo: new TranscriptFilesRepo(db), s1, s2, main1, sub1 };
}

function file(over: Partial<NewTranscriptFile> = {}): NewTranscriptFile {
  return {
    path: 'C:/Users/fixture/.claude/projects/p/aaaaaaaa-0000-4000-8000-000000000001.jsonl',
    pathKey: 'c:/users/fixture/.claude/projects/p/aaaaaaaa-0000-4000-8000-000000000001.jsonl',
    kind: 'session',
    sessionUid: S1,
    agentUid: null,
    runUid: null,
    sessionId: null,
    agentId: null,
    workflowRunId: null,
    birthMs: null,
    firstSeenMtimeMs: null,
    mtimeSeen: null,
    ...over,
  };
}

function register(f: Fixture, over: Partial<NewTranscriptFile> = {}): { id: number; created: boolean } {
  return withWriteTx(f.db, CTX, (tx) => f.repo.register(CTX, tx, file(over)));
}

function changes(
  db: InstanceDb,
): { seq: number; kind: string; op: string; session_uid: string | null; entity_id: number | null; payload: string }[] {
  return db.driver
    .prepare<{
      seq: number;
      kind: string;
      op: string;
      session_uid: string | null;
      entity_id: number | null;
      payload: string;
    }>('SELECT seq, kind, op, session_uid, entity_id, payload FROM changes ORDER BY seq')
    .all();
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

describe('TranscriptFilesRepo.register', () => {
  it('inserts a newly discovered file with the initial cursors, an active state and the discovery time', () => {
    const f = fixture();
    f.clock.advance(1500);
    const result = register(f, {
      birthMs: T0 - 5000,
      firstSeenMtimeMs: T0 - 4000,
      mtimeSeen: T0 - 3000,
      sessionId: f.s1,
      agentId: f.main1,
    });
    expect(result).toEqual({ id: 1, created: true });
    expect(f.repo.get(CTX, 1)).toEqual({
      id: 1,
      path: file().path,
      pathKey: file().pathKey,
      kind: 'session',
      sessionUid: S1,
      agentUid: null,
      runUid: null,
      sessionId: f.s1,
      agentId: f.main1,
      workflowRunId: null,
      ino: null,
      headLen: 0,
      headHash: null,
      headEnd: 0,
      backfillOffset: 0,
      tailStart: 0,
      tailOffset: 0,
      partialBytes: 0,
      sizeSeen: 0,
      mtimeSeen: T0 - 3000,
      birthMs: T0 - 5000,
      firstSeenMtimeMs: T0 - 4000,
      lineCount: 0,
      state: 'active',
      usageState: 'partial',
      invalidJson: 0,
      notObject: 0,
      shapeInvalid: 0,
      oversized: 0,
      utf8Invalid: 0,
      bomStripped: 0,
      crlfLines: 0,
      unknownTypes: 0,
      readErrors: 0,
      identityResets: 0,
      classifiedLines: 0,
      labelCache: null,
      firstTsInOrder: null,
      maxTsString: null,
      lastStopLegacy: null,
      behindSince: null,
      discoveredAt: T0 + 1500,
      lastReadAt: null,
      lastGrowthAt: null,
      indexOffset: 0,
      indexHeadHash: null,
      entriesTotal: 0,
      updatedAt: T0 + 1500,
    });
    expect(changes(f.db)).toEqual([]);
  });

  it('registering the same path key again returns the same id, keeps cursors and state and only fills missing links', () => {
    const f = fixture();
    const first = register(f, { sessionId: null, firstSeenMtimeMs: T0 - 4000 });
    withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, first.id, {
        headEnd: 10,
        backfillOffset: 10,
        tailStart: 10,
        tailOffset: 40,
        sizeSeen: 40,
      }),
    );
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.setState(CTX, tx, first.id, 'missing');
    });
    f.clock.advance(1000);
    const again = register(f, {
      path: 'C:/Users/Fixture/.claude/projects/p/other-case.jsonl',
      sessionId: f.s1,
      agentId: f.main1,
      firstSeenMtimeMs: T0,
    });
    expect(again).toEqual({ id: first.id, created: false });
    expect(f.repo.get(CTX, first.id)).toMatchObject({
      path: 'C:/Users/Fixture/.claude/projects/p/other-case.jsonl',
      sessionId: f.s1,
      agentId: f.main1,
      tailOffset: 40,
      sizeSeen: 40,
      state: 'missing',
      firstSeenMtimeMs: T0 - 4000, // the first sight is kept
      discoveredAt: T0,
      updatedAt: T0 + 1000,
    });
    // a link that is already set is not replaced, by another row or by nothing
    register(f, { sessionId: null, agentId: f.sub1 });
    expect(f.repo.get(CTX, first.id)).toMatchObject({ sessionId: f.s1, agentId: f.main1 });
    register(f, { path: 'C:/Users/Fixture/.claude/projects/p/third-spelling.jsonl', sessionId: f.s2, agentId: null });
    expect(f.repo.get(CTX, first.id)).toMatchObject({ sessionId: f.s1, agentId: f.main1 });
  });

  it('registers a subagent file, a workflow file and finds them by path key and by session', () => {
    const f = fixture();
    register(f);
    register(f, {
      path: 'C:/p/s/subagents/agent-a1b2c3.jsonl',
      pathKey: 'c:/p/s/subagents/agent-a1b2c3.jsonl',
      kind: 'subagent',
      agentUid: 'agent-a1b2c3',
      agentId: f.sub1,
    });
    register(f, {
      path: 'C:/p/s/subagents/workflows/wf_1/journal.jsonl',
      pathKey: 'c:/p/s/subagents/workflows/wf_1/journal.jsonl',
      kind: 'workflow_journal',
      runUid: 'wf_1',
    });
    register(f, {
      path: 'C:/p/other.jsonl',
      pathKey: 'c:/p/other.jsonl',
      sessionUid: S2,
    });
    expect(f.repo.findByPathKey(CTX, 'c:/p/s/subagents/agent-a1b2c3.jsonl')).toMatchObject({
      id: 2,
      kind: 'subagent',
      agentUid: 'agent-a1b2c3',
      agentId: f.sub1,
    });
    expect(f.repo.findByPathKey(CTX, 'nope')).toBeUndefined();
    expect(f.repo.listForSession(CTX, S1).map((row) => [row.id, row.kind])).toEqual([
      [1, 'session'],
      [2, 'subagent'],
      [3, 'workflow_journal'],
    ]);
    expect(f.repo.listForSession(CTX, S2).map((row) => row.id)).toEqual([4]);
    expect(f.repo.get(CTX, 99)).toBeUndefined();
  });

  it('lists files by state in id order up to a limit', () => {
    const f = fixture();
    for (const n of [1, 2, 3, 4]) register(f, { path: `p${String(n)}`, pathKey: `p${String(n)}` });
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.setState(CTX, tx, 2, 'missing');
      f.repo.setState(CTX, tx, 3, 'unreadable');
      f.repo.setState(CTX, tx, 4, 'retired');
    });
    expect(f.repo.listByStates(CTX, ['active', 'unreadable'], 10).map((row) => row.id)).toEqual([1, 3]);
    expect(f.repo.listByStates(CTX, ['missing', 'unreadable', 'active'], 2).map((row) => row.id)).toEqual([1, 2]);
    expect(f.repo.listByStates(CTX, [], 10)).toEqual([]);
  });

  it.each([
    ['a path above 1024 characters', { path: 'p'.repeat(1025) }],
    ['an empty path key', { pathKey: '' }],
    ['a session uid that is not 36 characters', { sessionUid: 'short' }],
    ['an agent uid above 64 characters', { agentUid: 'a'.repeat(65) }],
  ] as const)('refuses %s (CHECK)', (_label, over) => {
    const f = fixture();
    expect(dbErrorOf(() => register(f, over))).toMatchObject({ code: 'db_constraint', constraint: 'check' });
  });

  it('refuses a link to a session, an agent or a workflow run that does not exist', () => {
    const f = fixture();
    for (const over of [{ sessionId: 999 }, { agentId: 999 }, { workflowRunId: 999 }]) {
      expect(
        dbErrorOf(() => register(f, over)),
        JSON.stringify(over),
      ).toMatchObject({
        code: 'db_constraint',
        constraint: 'foreignkey',
      });
    }
  });
});

describe('TranscriptFilesRepo.updateCursors (03 3.6, 9.1; 02 5.3, 5.5, 5.9)', () => {
  it('moves the cursors, the counters and the freshness fields, and leaves every other column as it was', () => {
    const f = fixture();
    const { id } = register(f, { agentUid: null });
    f.clock.advance(2000);
    withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, id, {
        headEnd: 100,
        backfillOffset: 100,
        tailStart: 300,
        tailOffset: 500,
        partialBytes: 7,
        sizeSeen: 520,
        mtimeSeen: T0 + 1900,
        lineCount: 42,
        identity: { ino: '1234', headLen: 90, headHash: 'h'.repeat(64) },
        usageState: 'complete',
        classifiedLines: 40,
        labelCache: 'the label',
        firstTsInOrder: '2026-01-01T00:00:00.000Z',
        maxTsString: '2026-01-01T00:10:00.000Z',
        lastStopLegacy: 'end_turn',
        behindSince: T0 + 1800,
        lastReadAt: T0 + 2000,
        lastGrowthAt: T0 + 1900,
        counters: {
          invalidJson: 2,
          notObject: 1,
          shapeInvalid: 3,
          oversized: 1,
          utf8Invalid: 4,
          bomStripped: 1,
          crlfLines: 5,
          unknownTypes: 6,
          readErrors: 1,
        },
      }),
    );
    expect(f.repo.get(CTX, id)).toMatchObject({
      path: file().path,
      kind: 'session',
      headEnd: 100,
      backfillOffset: 100,
      tailStart: 300,
      tailOffset: 500,
      partialBytes: 7,
      sizeSeen: 520,
      mtimeSeen: T0 + 1900,
      lineCount: 42,
      ino: '1234',
      headLen: 90,
      headHash: 'h'.repeat(64),
      usageState: 'complete',
      classifiedLines: 40,
      labelCache: 'the label',
      firstTsInOrder: '2026-01-01T00:00:00.000Z',
      maxTsString: '2026-01-01T00:10:00.000Z',
      lastStopLegacy: 'end_turn',
      behindSince: T0 + 1800,
      lastReadAt: T0 + 2000,
      lastGrowthAt: T0 + 1900,
      invalidJson: 2,
      notObject: 1,
      shapeInvalid: 3,
      oversized: 1,
      utf8Invalid: 4,
      bomStripped: 1,
      crlfLines: 5,
      unknownTypes: 6,
      readErrors: 1,
      state: 'active',
      identityResets: 0,
      updatedAt: T0 + 2000,
    });
    // counters are added to, a second update adds again
    withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, { counters: { invalidJson: 3 } }));
    expect(f.repo.get(CTX, id)).toMatchObject({ invalidJson: 5, notObject: 1, tailOffset: 500 });
  });

  it('can clear the nullable fields, and an empty update only touches updated_at', () => {
    const f = fixture();
    const { id } = register(f);
    withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, id, {
        behindSince: T0 + 5,
        labelCache: 'x',
        mtimeSeen: T0,
        identity: { ino: '9', headLen: 3, headHash: 'a'.repeat(64) },
      }),
    );
    f.clock.advance(10);
    withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, id, {
        behindSince: null,
        labelCache: null,
        mtimeSeen: null,
        identity: { ino: null, headLen: 0, headHash: null },
      }),
    );
    expect(f.repo.get(CTX, id)).toMatchObject({
      behindSince: null,
      labelCache: null,
      mtimeSeen: null,
      ino: null,
      headLen: 0,
      headHash: null,
    });
    f.clock.advance(10);
    withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, {}));
    expect(f.repo.get(CTX, id)?.updatedAt).toBe(T0 + 20);
  });

  it('keeps the cursor invariant 0 <= head_end <= backfill <= tail_start <= tail_offset <= size_seen: a violation is refused and changes nothing', () => {
    const f = fixture();
    const { id } = register(f);
    withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, id, {
        headEnd: 10,
        backfillOffset: 10,
        tailStart: 10,
        tailOffset: 20,
        sizeSeen: 30,
      }),
    );
    const before = f.repo.get(CTX, id);
    const violations = [
      { headEnd: 11 }, // above backfill_offset
      { backfillOffset: 9 }, // below head_end
      { tailStart: 21 }, // above tail_offset
      { tailOffset: 31 }, // above size_seen while active
      { sizeSeen: 19 }, // below tail_offset while active
      { tailOffset: -1 },
    ];
    for (const update of violations) {
      expect(
        dbErrorOf(() => withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, update))),
        JSON.stringify(update),
      ).toMatchObject({
        code: 'db_constraint',
        constraint: 'check',
      });
    }
    expect(f.repo.get(CTX, id)).toEqual(before);
    expect(changes(f.db)).toHaveLength(1);
    // a missing file may be smaller than its cursors: the check only holds for an active file
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.setState(CTX, tx, id, 'missing');
      f.repo.updateCursors(CTX, tx, id, { sizeSeen: 0 });
    });
    expect(f.repo.get(CTX, id)).toMatchObject({ state: 'missing', sizeSeen: 0, tailOffset: 20 });
  });

  it('announces transcript/append only when size_seen grew, with size, tail and agent in the payload', () => {
    const f = fixture();
    const main = register(f, { sessionId: f.s1 });
    const sub = register(f, {
      path: 'sub',
      pathKey: 'sub',
      kind: 'subagent',
      agentUid: 'agent-a1b2c3',
      sessionId: f.s1,
      agentId: f.sub1,
    });
    const first = withWriteTx(f.db, CTX, (tx) =>
      f.repo.updateCursors(CTX, tx, main.id, {
        headEnd: 10,
        backfillOffset: 10,
        tailStart: 10,
        tailOffset: 80,
        sizeSeen: 100,
      }),
    );
    expect(first).toEqual({ sizeGrew: true, seq: 1 });
    // size unchanged, only a cursor moves: no announcement
    const second = withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, main.id, { tailOffset: 90 }));
    expect(second).toEqual({ sizeGrew: false, seq: null });
    // a smaller size (truncation of a missing file is handled by resetIdentity) is not growth either
    const third = withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, sub.id, { sizeSeen: 0 }));
    expect(third).toEqual({ sizeGrew: false, seq: null });
    // two updates of one file in one transaction: one change row, the last values win
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.updateCursors(CTX, tx, main.id, { sizeSeen: 150, tailOffset: 120 });
      f.repo.updateCursors(CTX, tx, main.id, { sizeSeen: 200, tailOffset: 190 });
      f.repo.updateCursors(CTX, tx, sub.id, { sizeSeen: 50, tailOffset: 50 });
    });
    expect(changes(f.db)).toEqual([
      {
        seq: 1,
        kind: 'transcript',
        op: 'append',
        session_uid: S1,
        entity_id: main.id,
        payload: '{"size":100,"tail":80,"agent":null}',
      },
      {
        seq: 2,
        kind: 'transcript',
        op: 'append',
        session_uid: S1,
        entity_id: main.id,
        payload: '{"size":200,"tail":190,"agent":null}',
      },
      {
        seq: 3,
        kind: 'transcript',
        op: 'append',
        session_uid: S1,
        entity_id: sub.id,
        payload: '{"size":50,"tail":50,"agent":"agent-a1b2c3"}',
      },
    ]);
  });

  it('a rolled-back update leaves the file and the change log untouched', () => {
    const f = fixture();
    const { id } = register(f);
    const before = f.repo.get(CTX, id);
    expect(() =>
      withWriteTx(f.db, CTX, (tx) => {
        f.repo.updateCursors(CTX, tx, id, { sizeSeen: 500, tailOffset: 400, counters: { invalidJson: 9 } });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(f.repo.get(CTX, id)).toEqual(before);
    expect(changes(f.db)).toEqual([]);
  });

  it('refuses a file that does not exist, a negative counter delta and an over-long label', () => {
    const f = fixture();
    const { id } = register(f);
    expect(
      dbErrorOf(() => withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, 99, { sizeSeen: 1 }))),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(
      dbErrorOf(() =>
        withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, { counters: { invalidJson: -1 } })),
      ),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'check',
    });
    expect(
      dbErrorOf(() =>
        withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, { labelCache: 'l'.repeat(201) })),
      ),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'check',
    });
    expect(
      dbErrorOf(() => withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(CTX, tx, id, { partialBytes: 1.5 }))),
    ).toBeInstanceOf(DbError);
  });
});

describe('TranscriptFilesRepo.resetIdentity, setState, setIndexState', () => {
  it('resetIdentity restarts the import from the initial plan and keeps the entry index', () => {
    const f = fixture();
    const { id } = register(f);
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.updateCursors(CTX, tx, id, {
        headEnd: 10,
        backfillOffset: 10,
        tailStart: 20,
        tailOffset: 90,
        sizeSeen: 100,
        partialBytes: 4,
        lineCount: 9,
        identity: { ino: '1', headLen: 50, headHash: 'a'.repeat(64) },
        usageState: 'complete',
        classifiedLines: 9,
        labelCache: 'old',
        firstTsInOrder: '2026-01-01T00:00:00.000Z',
        maxTsString: '2026-01-01T00:00:09.000Z',
        lastStopLegacy: 'end_turn',
        behindSince: T0,
        counters: {
          invalidJson: 1,
          notObject: 2,
          shapeInvalid: 3,
          oversized: 4,
          utf8Invalid: 5,
          bomStripped: 6,
          crlfLines: 7,
          unknownTypes: 8,
          readErrors: 9,
        },
      });
      f.repo.setIndexState(CTX, tx, id, { indexOffset: 90, entriesTotal: 12, indexHeadHash: 'b'.repeat(64) });
    });
    f.clock.advance(100);
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.resetIdentity(CTX, tx, id, { ino: '2', headLen: 30, headHash: 'c'.repeat(64) });
    });
    expect(f.repo.get(CTX, id)).toMatchObject({
      ino: '2',
      headLen: 30,
      headHash: 'c'.repeat(64),
      headEnd: 0,
      backfillOffset: 0,
      tailStart: 0,
      tailOffset: 0,
      partialBytes: 0,
      lineCount: 0,
      usageState: 'partial',
      classifiedLines: 0,
      labelCache: null,
      firstTsInOrder: null,
      maxTsString: null,
      lastStopLegacy: null,
      behindSince: null,
      invalidJson: 0,
      notObject: 0,
      shapeInvalid: 0,
      oversized: 0,
      utf8Invalid: 0,
      bomStripped: 0,
      crlfLines: 0,
      unknownTypes: 0,
      readErrors: 9, // I/O errors are not about the content
      identityResets: 1,
      sizeSeen: 100,
      indexOffset: 90,
      entriesTotal: 12,
      indexHeadHash: 'b'.repeat(64),
      updatedAt: T0 + 100,
    });
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.resetIdentity(CTX, tx, id, { ino: '3', headLen: 0, headHash: null });
    });
    expect(f.repo.get(CTX, id)).toMatchObject({ identityResets: 2, ino: '3', headHash: null });
  });

  it('setIndexState stores the entry index position of the transcript service', () => {
    const f = fixture();
    const { id } = register(f);
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.setIndexState(CTX, tx, id, { indexOffset: 4096, entriesTotal: 300, indexHeadHash: 'd'.repeat(64) });
    });
    expect(f.repo.get(CTX, id)).toMatchObject({ indexOffset: 4096, entriesTotal: 300, indexHeadHash: 'd'.repeat(64) });
    withWriteTx(f.db, CTX, (tx) => {
      f.repo.setIndexState(CTX, tx, id, { indexOffset: 0, entriesTotal: 0, indexHeadHash: null });
    });
    expect(f.repo.get(CTX, id)).toMatchObject({ indexOffset: 0, entriesTotal: 0, indexHeadHash: null });
    expect(
      dbErrorOf(() => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.setIndexState(CTX, tx, id, { indexOffset: -1, entriesTotal: 0, indexHeadHash: null });
        });
      }),
    ).toMatchObject({
      code: 'db_constraint',
    });
  });

  it('setState stores each state; an unknown file is refused', () => {
    const f = fixture();
    const { id } = register(f);
    for (const state of ['missing', 'unreadable', 'untracked', 'retired', 'active'] as const) {
      withWriteTx(f.db, CTX, (tx) => {
        f.repo.setState(CTX, tx, id, state);
      });
      expect(f.repo.get(CTX, id)?.state).toBe(state);
    }
    expect(
      dbErrorOf(() => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.setState(CTX, tx, 99, 'missing');
        });
      }),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
  });

  it('every public method asserts the scope first', () => {
    const f = fixture();
    const { id } = register(f);
    const identity = { ino: null, headLen: 0, headHash: null };
    const calls: (() => unknown)[] = [
      () => withWriteTx(f.db, CTX, (tx) => f.repo.register(FOREIGN, tx, file({ pathKey: 'x', path: 'x' }))),
      () => f.repo.get(FOREIGN, id),
      () => f.repo.findByPathKey(FOREIGN, 'x'),
      () => f.repo.listForSession(FOREIGN, S1),
      () => f.repo.listByStates(FOREIGN, ['active'], 1),
      () => withWriteTx(f.db, CTX, (tx) => f.repo.updateCursors(FOREIGN, tx, id, {})),
      () => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.resetIdentity(FOREIGN, tx, id, identity);
        });
      },
      () => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.setState(FOREIGN, tx, id, 'missing');
        });
      },
      () => {
        withWriteTx(f.db, CTX, (tx) => {
          f.repo.setIndexState(FOREIGN, tx, id, { indexOffset: 0, entriesTotal: 0, indexHeadHash: null });
        });
      },
    ];
    for (const run of calls) expect(dbErrorOf(run).code).toBe('scope_mismatch');
    expect(f.repo.get(CTX, id)).toMatchObject({ state: 'active', headEnd: 0 });
  });
});
