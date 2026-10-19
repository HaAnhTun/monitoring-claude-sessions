import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ReconciliationsRepo, type NewReconciliation } from './reconciliations.ts';
import { SessionsRepo } from './sessions.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const HASH_1 = '0123456789abcdef0123456789abcdef';
const HASH_2 = 'fedcba9876543210fedcba9876543210';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('reconciliations-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function addSession(db: InstanceDb): number {
  return withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 }),
  ).id;
}

function sessionLevel(sessionId: number, over: Partial<NewReconciliation> = {}): NewReconciliation {
  return {
    sessionId,
    scopeKey: UID_A,
    kind: 'hook_gap',
    at: T0 + 10,
    detail: { missingTools: 2 },
    detailHash: HASH_1,
    ...over,
  };
}

interface EventRow {
  id: number;
  session_id: number;
  kind: string;
  sources: number;
  severity: number;
  natural_key: string | null;
  ts: number;
  ts_source: string;
  detail: string | null;
  change_seq: number;
}

function events(db: InstanceDb): EventRow[] {
  return db.driver
    .prepare<EventRow>(
      'SELECT id, session_id, kind, sources, severity, natural_key, ts, ts_source, detail, change_seq FROM events ORDER BY id',
    )
    .all();
}

describe('ReconciliationsRepo.insert (03 3.6)', () => {
  it('stores a session level row and its monitor timeline event with one event/append change', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    const result = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId)));
    expect(result).toBeDefined();
    expect(result?.eventId).not.toBeNull();
    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result?.eventId,
      session_id: sessionId,
      kind: 'monitor.gap',
      sources: 4,
      severity: 1,
      natural_key: `recon:${String(result?.id)}`,
      ts: T0 + 10,
      ts_source: 'derived',
      detail: '{"missingTools":2}',
    });
    const changes = db.driver
      .prepare<{ seq: number; kind: string; op: string; session_uid: string | null; payload: string }>(
        'SELECT seq, kind, op, session_uid, payload FROM changes',
      )
      .all();
    expect(changes).toEqual([
      {
        seq: rows[0]?.change_seq,
        kind: 'event',
        op: 'append',
        session_uid: UID_A,
        payload: JSON.stringify({ from: result?.eventId, to: result?.eventId, count: 1 }),
      },
    ]);
    const counted = db.driver
      .prepare<{ event_count: number }>('SELECT event_count FROM sessions WHERE id = ?')
      .get([sessionId]);
    expect(counted?.event_count).toBe(1);
  });

  it('maps the kind to monitor.gap or monitor.reconcile', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    const kinds = [
      'activity_after_end',
      'hook_gap',
      'runtime_unavailable',
      'identity_reset',
      'copied_records',
      'handler_failing',
    ] as const;
    withWriteTx(db, CTX, (tx) => {
      kinds.forEach((kind, index) => {
        repo.insert(CTX, tx, sessionLevel(sessionId, { kind, detailHash: String(index).padStart(32, '0') }));
      });
    });
    expect(events(db).map((e) => e.kind)).toEqual([
      'monitor.reconcile',
      'monitor.gap',
      'monitor.gap',
      'monitor.reconcile',
      'monitor.reconcile',
      'monitor.reconcile',
    ]);
  });

  it('answers undefined for a duplicate and writes nothing the second time', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId)));
    const head = db.headSeq();
    const again = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId, { at: T0 + 999 })));
    expect(again).toBeUndefined();
    expect(events(db)).toHaveLength(1);
    expect(db.headSeq()).toBe(head);
    const other = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId, { detailHash: HASH_2 })));
    expect(other).toBeDefined();
    expect(events(db)).toHaveLength(2);
  });

  it('stores an instance level row without a timeline event', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const result = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, {
        sessionId: null,
        scopeKey: 'instance',
        kind: 'runtime_unavailable',
        at: T0 + 5,
        detail: { downMs: 360000, hookEvents: 14 },
        detailHash: HASH_1,
      }),
    );
    expect(result).toMatchObject({ eventId: null });
    expect(events(db)).toEqual([]);
    expect(db.headSeq()).toBe(0);
    expect(repo.newerThan(CTX, 'runtime_unavailable', T0, 10)).toEqual([
      {
        id: result?.id,
        sessionId: null,
        scopeKey: 'instance',
        kind: 'runtime_unavailable',
        at: T0 + 5,
        detail: { downMs: 360000, hookEvents: 14 },
      },
    ]);
  });
});

describe('ReconciliationsRepo reads and retention', () => {
  it('lists the rows of a session newest first and the rows newer than a time per kind', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, sessionLevel(sessionId, { at: T0 + 1, detailHash: HASH_1 }));
      repo.insert(CTX, tx, sessionLevel(sessionId, { at: T0 + 9, detailHash: HASH_2 }));
    });
    expect(repo.listBySession(CTX, sessionId, 10).map((r) => r.at)).toEqual([T0 + 9, T0 + 1]);
    expect(repo.listBySession(CTX, sessionId, 1)).toHaveLength(1);
    expect(repo.newerThan(CTX, 'hook_gap', T0 + 1, 10).map((r) => r.at)).toEqual([T0 + 9]);
    expect(repo.newerThan(CTX, 'identity_reset', 0, 10)).toEqual([]);
  });

  it('deletes instance level rows older than a cutoff in bounded batches and keeps session rows', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 5; i += 1) {
        repo.insert(CTX, tx, {
          sessionId: null,
          scopeKey: 'instance',
          kind: 'handler_failing',
          at: T0 + i,
          detail: { n: i },
          detailHash: String(i).padStart(32, '0'),
        });
      }
      repo.insert(CTX, tx, sessionLevel(sessionId, { at: T0 }));
    });
    const first = withWriteTx(db, CTX, (tx) => repo.deleteInstanceLevelBefore(CTX, tx, T0 + 4, 2));
    const second = withWriteTx(db, CTX, (tx) => repo.deleteInstanceLevelBefore(CTX, tx, T0 + 4, 100));
    expect([first, second]).toEqual([2, 2]);
    expect(repo.newerThan(CTX, 'handler_failing', 0, 10).map((r) => r.at)).toEqual([T0 + 4]);
    expect(repo.listBySession(CTX, sessionId, 10)).toHaveLength(1);
  });

  it('refuses a session level scope key that is not the uid of the session, and writes nothing', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    const wrong = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(() =>
      withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId, { scopeKey: wrong }))),
    ).toThrow(RangeError);
    expect(repo.listBySession(CTX, sessionId, 10)).toEqual([]);
    expect(events(db)).toEqual([]);
    expect(db.headSeq()).toBe(0);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new ReconciliationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, sessionLevel(sessionId)));
    expectEveryMethodScoped(repo, {
      insert: () =>
        withWriteTx(db, CTX, (tx) => repo.insert(FOREIGN, tx, sessionLevel(sessionId, { detailHash: HASH_2 }))),
      listBySession: () => repo.listBySession(FOREIGN, sessionId, 10),
      newerThan: () => repo.newerThan(FOREIGN, 'hook_gap', 0, 10),
      deleteInstanceLevelBefore: () =>
        withWriteTx(db, CTX, (tx) => repo.deleteInstanceLevelBefore(FOREIGN, tx, T0 + 1_000_000, 10)),
    });
    expect(repo.listBySession(CTX, sessionId, 10)).toHaveLength(1);
  });
});
