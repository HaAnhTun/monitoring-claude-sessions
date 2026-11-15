import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ATTEMPT_CANDIDATES_SQL, SessionsRepo, type StoredView } from './sessions.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const UID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(clock = new FakeClock(T0)): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('sessions-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  open.push(db);
  return db;
}

const WORKING: StoredView = {
  state: 'working',
  presence: 'open',
  waitReason: null,
  staleKind: null,
  endReason: null,
  turnOutcome: null,
  basis: 'observed',
  confidence: 'high',
  ruleId: 'S-7c',
  evidence: [{ source: 'hook', fact: 'prompt', at: T0 + 1 }],
  since: T0 + 1,
  evaluatedAt: T0 + 5,
  nextCheckAt: T0 + 60_000,
};

interface ChangeRow {
  seq: number;
  kind: string;
  op: string;
  session_uid: string | null;
  entity_id: number | null;
}

function changes(db: InstanceDb): ChangeRow[] {
  return db.driver.prepare<ChangeRow>('SELECT seq, kind, op, session_uid, entity_id FROM changes ORDER BY seq').all();
}

function countOf(db: InstanceDb, table: string): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function addSession(db: InstanceDb, uid = UID_A, startedAt = T0): { id: number; agentId: number } {
  const repo = new SessionsRepo(db);
  const ensured = withWriteTx(db, CTX, (tx) => repo.ensure(CTX, tx, { sessionUid: uid, projectId: null, startedAt }));
  return { id: ensured.id, agentId: ensured.agentId };
}

describe('SessionsRepo.ensure (03 3.6)', () => {
  it('creates the session and its main agent and reports the creation', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 + 100 }),
    );
    expect(first.created).toBe(true);
    expect(repo.byUid(CTX, UID_A)).toMatchObject({
      id: first.id,
      sessionUid: UID_A,
      startedAt: T0 + 100,
      lastActivityAt: T0 + 100,
      firstSeenAt: T0,
      state: 'unknown',
    });
    const agents = db.driver
      .prepare<{ id: number; agent_uid: string; kind: string; depth: number; parent_agent_id: number | null }>(
        'SELECT id, agent_uid, kind, depth, parent_agent_id FROM agents WHERE session_id = ?',
      )
      .all([first.id]);
    expect(agents).toEqual([{ id: first.agentId, agent_uid: 'main', kind: 'main', depth: 0, parent_agent_id: null }]);
  });

  it('is idempotent: same ids, the earlier start wins, a known project is kept', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const projectId = db.driver
      .prepare("INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('p', 'P', ?, ?)")
      .run([T0, T0]).lastInsertRowid;
    const first = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 + 100 }),
    );
    const second = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { sessionUid: UID_A, projectId, startedAt: T0 + 40 }),
    );
    const third = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 + 900 }),
    );
    expect(second).toEqual({ id: first.id, agentId: first.agentId, created: false });
    expect(third.id).toBe(first.id);
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ startedAt: T0 + 40, projectId });
    expect(countOf(db, 'agents')).toBe(1);
  });

  it('looks sessions up by uid', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    expect(repo.idByUid(CTX, UID_A)).toBe(id);
    expect(repo.idByUid(CTX, UID_B)).toBeUndefined();
    expect(repo.byUid(CTX, UID_B)).toBeUndefined();
  });
});

describe('SessionsRepo.update', () => {
  it('writes only the named columns and stamps updated_seq only when given a seq', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const result = withWriteTx(db, CTX, (tx) => {
      const seq = tx.changes.reserve('session', 'upsert', { entityId: id, sessionUid: UID_A });
      const touched = repo.update(
        CTX,
        tx,
        id,
        {
          label: 'build',
          labelSource: 'rule',
          matched: true,
          claudePid: 4242,
          lastActivityAt: T0 + 500,
          toolCallCount: 3,
        },
        seq,
      );
      return { touched, seq };
    });
    expect(result.touched).toBe(true);
    expect(repo.byUid(CTX, UID_A)).toMatchObject({
      label: 'build',
      labelSource: 'rule',
      matched: true,
      pinned: false,
      claudePid: 4242,
      lastActivityAt: T0 + 500,
      toolCallCount: 3,
      updatedSeq: result.seq,
    });
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { claudePid: null, label: 'x' }, null));
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ claudePid: null, label: 'x', updatedSeq: result.seq });
  });

  it('reads a row that was never evaluated as evaluatedAt 0 with no next check', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    expect(repo.readView(CTX, id)?.view).toMatchObject({ evaluatedAt: 0, nextCheckAt: null });
    expect(repo.readView(CTX, id + 1)).toBeUndefined();
  });

  it('advances updated_at with the clock on an update', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    expect(repo.byUid(CTX, UID_A)?.updatedAt).toBe(T0);
    clock.advance(700);
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { label: 'later' }, null));
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ label: 'later', updatedAt: T0 + 700, firstSeenAt: T0 });
  });

  it('does nothing for an empty patch or a missing session', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const out = withWriteTx(db, CTX, (tx) => [
      repo.update(CTX, tx, id, {}, null),
      repo.update(CTX, tx, 9999, { label: 'a' }, null),
    ]);
    expect(out).toEqual([false, false]);
  });

  it('surfaces a value the schema refuses as a constraint error', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { lastActivityAt: T0 - 1 }, null));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });
});

describe('SessionsRepo.update: the project of a session (CAW design 03 2.5)', () => {
  function addProject(db: InstanceDb, key: string): number {
    return db.driver
      .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, ?, ?)')
      .run([key, key, T0, T0]).lastInsertRowid;
  }

  it('assigns the project, announced by the seq the caller reserved, and leaves it alone when the patch has none', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const projectId = addProject(db, 'd--work-app');
    expect(repo.byUid(CTX, UID_A)?.projectId).toBeNull();
    const seq = withWriteTx(db, CTX, (tx) => {
      const reserved = tx.changes.reserve('session', 'upsert', { entityId: id, sessionUid: UID_A });
      repo.update(CTX, tx, id, { projectId }, reserved);
      return reserved;
    });
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ projectId, updatedSeq: seq });
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { label: 'later' }, null));
    expect(repo.byUid(CTX, UID_A)?.projectId).toBe(projectId);
  });

  it('clears the project with null and refuses a project that does not exist', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const projectId = addProject(db, 'p');
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { projectId }, null));
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { projectId: null }, null));
    expect(repo.byUid(CTX, UID_A)?.projectId).toBeNull();
    let error: unknown;
    try {
      withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { projectId: 9999 }, null));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'db_constraint' });
  });
});

describe('SessionsRepo soft references (03 3.4)', () => {
  it('refuses an update that names a transcript file that does not exist', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    let error: unknown;
    try {
      withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { transcriptFileId: 9999, label: 'x' }, null));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ transcriptFileId: null, label: '' });
    const fileId = addTranscriptFile(db, { sessionUid: UID_A, firstTs: null, mtime: null });
    expect(withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { transcriptFileId: fileId }, null))).toBe(true);
    // clearing the reference is not a reference
    expect(withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { transcriptFileId: null }, null))).toBe(true);
  });
});

describe('SessionsRepo.writeView (DA-T-DB-19)', () => {
  it('records a change and one transition on the first state change', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const result = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, WORKING, '{"a":1}'));
    expect(result).toMatchObject({ changed: true, transitioned: true });
    expect(changes(db)).toEqual([
      { seq: result?.seq, kind: 'session', op: 'upsert', session_uid: UID_A, entity_id: id },
    ]);
    expect(repo.byUid(CTX, UID_A)).toMatchObject({ state: 'working', updatedSeq: result?.seq });
    const transitions = db.driver
      .prepare<{
        session_id: number;
        agent_id: number | null;
        from_state: string | null;
        to_state: string;
        rule: string;
        basis: string;
        at: number;
      }>('SELECT session_id, agent_id, from_state, to_state, rule, basis, at FROM state_transitions')
      .all();
    expect(transitions).toEqual([
      {
        session_id: id,
        agent_id: null,
        from_state: 'unknown',
        to_state: 'working',
        rule: 'S-7c',
        basis: 'observed',
        at: T0 + 5,
      },
    ]);
  });

  it('records nothing for an unchanged view, even when time and evidence moved', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, WORKING, '{}'));
    const headBefore = db.headSeq();
    const again = withWriteTx(db, CTX, (tx) =>
      repo.writeView(
        CTX,
        tx,
        id,
        {
          ...WORKING,
          evidence: [{ source: 'clock', fact: 'quiet', at: T0 + 99 }],
          evaluatedAt: T0 + 99,
          nextCheckAt: T0 + 1_000_000,
          since: T0 + 50,
        },
        '{"b":2}',
      ),
    );
    expect(again).toMatchObject({ changed: false, transitioned: false, seq: null });
    expect(db.headSeq()).toBe(headBefore);
    expect(changes(db)).toHaveLength(1);
    expect(countOf(db, 'state_transitions')).toBe(1);
    // a facts-only update still stores the facts and the time columns
    expect(repo.readView(CTX, id)).toMatchObject({
      factsJson: '{"b":2}',
      view: { evaluatedAt: T0 + 99, nextCheckAt: T0 + 1_000_000 },
    });
  });

  it('records a change but no transition when only a non-state field of the view changes', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, WORKING, '{}'));
    const waiting: StoredView = { ...WORKING, waitReason: 'user', confidence: 'medium', ruleId: 'S-9a' };
    const result = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, waiting, '{}'));
    expect(result).toMatchObject({ changed: true, transitioned: false });
    expect(changes(db)).toHaveLength(2);
    expect(countOf(db, 'state_transitions')).toBe(1);
  });

  it('detects a change in each field of the viewChanged list (02 7.8)', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    const variants: Partial<StoredView>[] = [
      { state: 'turn_ended' },
      { presence: 'ended' },
      { waitReason: 'permission' },
      { staleKind: 'silent' },
      { endReason: 'logout' },
      { turnOutcome: 'ok' },
      { basis: 'inferred' },
      { confidence: 'low' },
      { ruleId: 'S-1' },
    ];
    for (const variant of variants) {
      withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, WORKING, '{}'));
      const result = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, { ...WORKING, ...variant }, '{}'));
      expect(result?.changed, JSON.stringify(variant)).toBe(true);
    }
  });

  it('stores the evidence list and answers undefined for a missing session', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, WORKING, '{}'));
    expect(repo.readView(CTX, id)?.view).toEqual(WORKING);
    expect(withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, 9999, WORKING, '{}'))).toBeUndefined();
    expect(repo.readView(CTX, 9999)).toBeUndefined();
  });

  it('rolls the transition and the change back together with the transaction', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    expect(() =>
      withWriteTx(db, CTX, (tx) => {
        repo.writeView(CTX, tx, id, WORKING, '{}');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(changes(db)).toEqual([]);
    expect(countOf(db, 'state_transitions')).toBe(0);
    expect(repo.byUid(CTX, UID_A)?.state).toBe('unknown');
  });
});

describe('SessionsRepo.dueForCheck', () => {
  it('returns the rows whose next_check_at has passed, earliest first, up to the limit', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A);
    const b = addSession(db, UID_B);
    withWriteTx(db, CTX, (tx) => {
      repo.writeView(CTX, tx, a.id, { ...WORKING, nextCheckAt: T0 + 300 }, '{}');
      repo.writeView(CTX, tx, b.id, { ...WORKING, nextCheckAt: T0 + 100 }, '{}');
    });
    expect(repo.dueForCheck(CTX, T0 + 50, 10)).toEqual([]);
    expect(repo.dueForCheck(CTX, T0 + 300, 10)).toEqual([
      { id: b.id, sessionUid: UID_B },
      { id: a.id, sessionUid: UID_A },
    ]);
    expect(repo.dueForCheck(CTX, T0 + 300, 1)).toEqual([{ id: b.id, sessionUid: UID_B }]);
  });

  it('refuses a negative limit instead of reading it as no limit', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    addSession(db);
    expect(() => repo.dueForCheck(CTX, T0 + 1_000_000, -1)).toThrow(RangeError);
  });
});

describe('SessionsRepo.uidsByRowIds (N-10)', () => {
  it('maps row ids to provider ids and ignores unknown ids', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A);
    const b = addSession(db, UID_B);
    const map = repo.uidsByRowIds(CTX, [a.id, b.id, 9999, a.id]);
    expect(map).toEqual(
      new Map([
        [a.id, UID_A],
        [b.id, UID_B],
      ]),
    );
    expect(repo.uidsByRowIds(CTX, []).size).toBe(0);
  });
});

function addTranscriptFile(
  db: InstanceDb,
  p: { sessionUid: string; firstTs: string | null; mtime: number | null },
): number {
  return db.driver
    .prepare(
      `INSERT INTO transcript_files (path, path_key, kind, session_uid, first_ts_in_order, mtime_seen, discovered_at, updated_at)
       VALUES (?, ?, 'session', ?, ?, ?, ?, ?)`,
    )
    .run([`C:/t/${p.sessionUid}.jsonl`, `c:/t/${p.sessionUid}.jsonl`, p.sessionUid, p.firstTs, p.mtime, T0, T0])
    .lastInsertRowid;
}

describe('SessionsRepo.withoutProject (CAW design 03 2.5)', () => {
  it('lists the sessions without a project that have a main file, by row id after a cursor', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    const b = addSession(db, UID_B, T0);
    const none = addSession(db, 'cccccccc-0000-4000-8000-000000000003', T0);
    addTranscriptFile(db, { sessionUid: UID_A, firstTs: null, mtime: null });
    addTranscriptFile(db, { sessionUid: UID_B, firstTs: null, mtime: null });
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, a.id, { cwd: '/work/a', lastActivityAt: T0 + 9 }, null));
    const all = repo.withoutProject(CTX, 0, 10);
    expect(all).toEqual([
      { id: a.id, sessionUid: UID_A, cwd: '/work/a', lastActivityAt: T0 + 9, transcriptPath: `C:/t/${UID_A}.jsonl` },
      { id: b.id, sessionUid: UID_B, cwd: null, lastActivityAt: T0, transcriptPath: `C:/t/${UID_B}.jsonl` },
    ]);
    expect(all.map((row) => row.id)).not.toContain(none.id);
    expect(repo.withoutProject(CTX, 0, 1).map((row) => row.id)).toEqual([a.id]);
    expect(repo.withoutProject(CTX, a.id, 10).map((row) => row.id)).toEqual([b.id]);
    expect(repo.withoutProject(CTX, b.id, 10)).toEqual([]);
  });

  it('leaves out a session that has a project, and prefers the file the session points at', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    addTranscriptFile(db, { sessionUid: UID_A, firstTs: null, mtime: null });
    const projectId = db.driver
      .prepare("INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('p', 'p', ?, ?)")
      .run([T0, T0]).lastInsertRowid;
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, a.id, { projectId }, null));
    expect(repo.withoutProject(CTX, 0, 10)).toEqual([]);
    const b = addSession(db, UID_B, T0);
    addTranscriptFile(db, { sessionUid: UID_B, firstTs: null, mtime: null });
    const second = db.driver
      .prepare(
        `INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
         VALUES ('C:/t/second.jsonl', 'c:/t/second.jsonl', 'session', ?, ?, ?)`,
      )
      .run([UID_B, T0, T0]).lastInsertRowid;
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, b.id, { transcriptFileId: second }, null));
    expect(repo.withoutProject(CTX, 0, 10).map((row) => row.transcriptPath)).toEqual(['C:/t/second.jsonl']);
  });
});

describe('SessionsRepo.attemptCandidates (03 3.6, DA-T-DB-20)', () => {
  it('returns first-record and last-activity times from the main transcript file', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    const fileId = addTranscriptFile(db, { sessionUid: UID_A, firstTs: '2026-01-01T00:00:05.000Z', mtime: T0 + 7000 });
    withWriteTx(db, CTX, (tx) =>
      repo.update(
        CTX,
        tx,
        a.id,
        { label: 'part-1', transcriptFileId: fileId, matched: true, lastActivityAt: T0 + 6000 },
        null,
      ),
    );
    expect(repo.attemptCandidates(CTX, ['part-1', 'other'], T0)).toEqual([
      {
        sessionRowId: a.id,
        sessionId: UID_A,
        label: 'part-1',
        matched: true,
        firstRecordAtMs: Date.parse('2026-01-01T00:00:05.000Z'),
        lastActivityAtMs: T0 + 7000,
      },
    ]);
  });

  it('falls back to last_activity_at, maps an unparsable first timestamp to null and treats pinned as matched', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    const fileId = addTranscriptFile(db, { sessionUid: UID_A, firstTs: 'not a date', mtime: null });
    withWriteTx(db, CTX, (tx) =>
      repo.update(
        CTX,
        tx,
        a.id,
        { label: 'p', transcriptFileId: fileId, pinned: true, lastActivityAt: T0 + 123 },
        null,
      ),
    );
    const b = addSession(db, UID_B, T0);
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, b.id, { label: 'p' }, null));
    const rows = repo.attemptCandidates(CTX, ['p'], T0);
    expect(rows.find((r) => r.sessionId === UID_A)).toMatchObject({
      matched: true,
      firstRecordAtMs: null,
      lastActivityAtMs: T0 + 123,
    });
    expect(rows.find((r) => r.sessionId === UID_B)).toMatchObject({
      matched: false,
      firstRecordAtMs: null,
      lastActivityAtMs: T0,
    });
  });

  it('prefilters by activity with one hour of slack and by exact label', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, a.id, { label: 'x' }, null));
    expect(repo.attemptCandidates(CTX, ['x'], T0 + 3_600_000)).toHaveLength(1);
    expect(repo.attemptCandidates(CTX, ['x'], T0 + 3_600_001)).toHaveLength(0);
    expect(repo.attemptCandidates(CTX, ['X'], T0)).toHaveLength(0);
    expect(repo.attemptCandidates(CTX, [], T0)).toEqual([]);
  });

  it('answers in session row order whatever the order of the labels', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    // the index answers the newest activity first: b before a, while the row order is a before b
    const a = addSession(db, UID_A, T0 - 1000);
    const b = addSession(db, UID_B, T0);
    withWriteTx(db, CTX, (tx) => {
      repo.update(CTX, tx, a.id, { label: 'second' }, null);
      repo.update(CTX, tx, b.id, { label: 'first' }, null);
    });
    expect(repo.attemptCandidates(CTX, ['first', 'second'], T0).map((r) => r.sessionRowId)).toEqual([a.id, b.id]);
  });

  it('keeps the statement on idx_sessions_activity (03 3.7: no scan of every session)', () => {
    const db = database();
    const plan = db.driver
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${ATTEMPT_CANDIDATES_SQL}`)
      .all({ since: T0, labelsJson: '["a"]' })
      .map((row) => row.detail);
    expect(plan.some((detail) => detail.includes('idx_sessions_activity'))).toBe(true);
    expect(plan.filter((detail) => detail.startsWith('SCAN s'))).toEqual([]);
  });

  it('chunks more than 500 labels without losing a match', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, a.id, { label: 'label-1200' }, null));
    const labels = Array.from({ length: 1300 }, (_, i) => `label-${String(i)}`);
    expect(repo.attemptCandidates(CTX, labels, T0).map((r) => r.sessionId)).toEqual([UID_A]);
  });
});

describe('SessionsRepo.completionCandidates (I-08)', () => {
  it('finds by provider id and by exact label and rebuilds the stored view', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    const b = addSession(db, UID_B, T0 + 10);
    withWriteTx(db, CTX, (tx) => {
      repo.update(CTX, tx, a.id, { label: 'Same' }, null);
      repo.update(CTX, tx, b.id, { label: 'Same', lastActivityAt: T0 + 20 }, null);
      repo.writeView(CTX, tx, a.id, WORKING, '{}');
    });
    expect(repo.completionCandidates(CTX, { sessionId: UID_A })).toEqual([
      { sessionId: UID_A, label: 'Same', startedAt: T0, lastActivityAt: T0, view: WORKING },
    ]);
    expect(
      repo
        .completionCandidates(CTX, { label: 'Same' })
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual([UID_A, UID_B]);
    expect(repo.completionCandidates(CTX, { label: 'same' })).toEqual([]);
    expect(repo.completionCandidates(CTX, { sessionId: 'cccccccc-0000-4000-8000-000000000003' })).toEqual([]);
  });

  it('survives a damaged evidence column by returning an empty evidence list', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const a = addSession(db, UID_A, T0);
    db.driver.prepare('UPDATE sessions SET state_evidence = ? WHERE id = ?').run(['[{"nope":1}]', a.id]);
    expect(repo.completionCandidates(CTX, { sessionId: UID_A })[0]?.view.evidence).toEqual([]);
  });
});

describe('SessionsRepo scope (DA-T-DB-7)', () => {
  it('refuses a foreign context on every public method', () => {
    const db = database();
    const repo = new SessionsRepo(db);
    const { id } = addSession(db);
    // an unchanged view: a changed one would reach TransitionsRepo, whose own check would mask a missing one here
    const stored = repo.readView(CTX, id);
    if (stored === undefined) throw new Error('the row exists');
    expectEveryMethodScoped(repo, {
      ensure: () =>
        withWriteTx(db, CTX, (tx) => repo.ensure(FOREIGN, tx, { sessionUid: UID_B, projectId: null, startedAt: T0 })),
      idByUid: () => repo.idByUid(FOREIGN, UID_A),
      byUid: () => repo.byUid(FOREIGN, UID_A),
      update: () => withWriteTx(db, CTX, (tx) => repo.update(FOREIGN, tx, id, { label: 'a' }, null)),
      writeView: () => withWriteTx(db, CTX, (tx) => repo.writeView(FOREIGN, tx, id, stored.view, stored.factsJson)),
      readView: () => repo.readView(FOREIGN, id),
      dueForCheck: () => repo.dueForCheck(FOREIGN, T0 + 1_000_000, 10),
      uidsByRowIds: () => repo.uidsByRowIds(FOREIGN, [id]),
      attemptCandidates: () => repo.attemptCandidates(FOREIGN, ['a'], T0),
      completionCandidates: () => repo.completionCandidates(FOREIGN, { sessionId: UID_A }),
      withoutProject: () => repo.withoutProject(FOREIGN, 0, 10),
    });
    expect(repo.byUid(CTX, UID_A)?.label).not.toBe('a');
    expect(repo.idByUid(CTX, UID_B)).toBeUndefined();
  });
});
