import { join } from 'node:path';

import { WORK_ITEM_SOURCES } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { SessionsRepo } from './sessions.ts';
import { WorkItemsRepo, type NewWorkItem } from './work-items.ts';

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
    path: join(tempDir('work-items-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  open.push(db);
  return db;
}

function addSession(db: InstanceDb, uid: string): number {
  return withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: uid, projectId: null, startedAt: T0 }),
  ).id;
}

function item(over: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    itemKey: 'attempt:part-1',
    kind: 'attempt',
    title: 'part-1',
    state: 'working',
    rule: 'W-ATT',
    boardReason: 'B-3',
    evidence: [{ sessionId: UID_A, state: 'working', ruleId: 'S-7c' }],
    stateSince: T0 + 5,
    lastActivityAt: T0 + 6,
    ...over,
  };
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

describe('WorkItemsRepo.upsert (02 7.11)', () => {
  it('creates an item once and updates it in place by item key', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const first = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    const second = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, item({ state: 'completed', rule: 'W-ATT', boardReason: 'B-1', stateSince: T0 + 50 }), null),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(repo.byKey(CTX, 'attempt:part-1')).toMatchObject({
      id: first.id,
      kind: 'attempt',
      title: 'part-1',
      state: 'completed',
      boardReason: 'B-1',
      stateSince: T0 + 50,
      lastActivityAt: T0 + 6,
      createdAt: T0,
      evidence: [{ sessionId: UID_A, state: 'working', ruleId: 'S-7c' }],
    });
    expect(repo.byId(CTX, first.id)?.itemKey).toBe('attempt:part-1');
    expect(repo.byKey(CTX, 'label:none')).toBeUndefined();
  });

  it('keeps created_at and advances updated_at with the clock on an update in place', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new WorkItemsRepo(db);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    clock.advance(900);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item({ state: 'completed' }), null));
    expect(repo.byKey(CTX, 'attempt:part-1')).toMatchObject({ createdAt: T0, updatedAt: T0 + 900, state: 'completed' });
  });

  it('stamps updated_seq only when given a seq', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    expect(repo.byId(CTX, id)?.updatedSeq).toBe(0);
    const seq = withWriteTx(db, CTX, (tx) => {
      const reserved = tx.changes.reserve('work_item', 'upsert', { entityId: id, sessionUid: null });
      repo.upsert(CTX, tx, item({ state: 'failed' }), reserved);
      return reserved;
    });
    expect(repo.byId(CTX, id)?.updatedSeq).toBe(seq);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item({ state: 'stale' }), null));
    expect(repo.byId(CTX, id)).toMatchObject({ state: 'stale', updatedSeq: seq });
  });

  it('uses the stored spelling of the source (C52): attempt in the table, attempts only in the API', () => {
    expect(WORK_ITEM_SOURCES).toContain('attempts');
    const db = database();
    const repo = new WorkItemsRepo(db);
    for (const kind of ['declared', 'attempt', 'label'] as const) {
      const { id } = withWriteTx(db, CTX, (tx) =>
        repo.upsert(
          CTX,
          tx,
          item({ itemKey: `${kind}:x`, kind, rule: kind === 'declared' ? 'W-DECL' : 'W-LBL' }),
          null,
        ),
      );
      expect(repo.byId(CTX, id)?.kind).toBe(kind);
    }
    let code: string | undefined;
    try {
      db.driver
        .prepare(
          `INSERT INTO work_items (item_key, kind, title, state, rule, board_reason, state_since, created_at, updated_at)
           VALUES ('attempts:x', 'attempts', 't', 'working', 'W-ATT', 'B-3', 1, 1, 1)`,
        )
        .run();
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('lists the items most recently active first', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, item({ itemKey: 'label:a', kind: 'label', rule: 'W-LBL', lastActivityAt: T0 + 1 }), null);
      repo.upsert(CTX, tx, item({ itemKey: 'label:b', kind: 'label', rule: 'W-LBL', lastActivityAt: T0 + 9 }), null);
    });
    expect(repo.list(CTX).map((i) => i.itemKey)).toEqual(['label:b', 'label:a']);
  });
});

describe('WorkItemsRepo session links', () => {
  it('replaces the linked sessions of an item and keeps session_count in step', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const a = addSession(db, UID_A);
    const b = addSession(db, UID_B);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    expect(withWriteTx(db, CTX, (tx) => repo.setSessions(CTX, tx, id, [a, b], T0 + 7))).toEqual({
      added: 2,
      removed: 0,
    });
    expect(repo.sessionsOf(CTX, id)).toEqual([a, b]);
    expect(repo.byId(CTX, id)?.sessionCount).toBe(2);
    expect(withWriteTx(db, CTX, (tx) => repo.setSessions(CTX, tx, id, [b], T0 + 8))).toEqual({
      added: 0,
      removed: 1,
    });
    expect(repo.sessionsOf(CTX, id)).toEqual([b]);
    expect(repo.byId(CTX, id)?.sessionCount).toBe(1);
    expect(repo.itemOfSession(CTX, b)).toBe(id);
    expect(repo.itemOfSession(CTX, a)).toBeUndefined();
  });

  it('moves a session from one item to another (a session belongs to at most one item)', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const a = addSession(db, UID_A);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, item({ itemKey: 'label:one', kind: 'label', rule: 'W-LBL' }), null),
    );
    const second = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, item({ itemKey: 'label:two', kind: 'label', rule: 'W-LBL' }), null),
    );
    withWriteTx(db, CTX, (tx) => repo.setSessions(CTX, tx, first.id, [a], T0));
    withWriteTx(db, CTX, (tx) => repo.setSessions(CTX, tx, second.id, [a], T0 + 1));
    expect(repo.itemOfSession(CTX, a)).toBe(second.id);
    expect(repo.byId(CTX, first.id)?.sessionCount).toBe(0);
    expect(repo.byId(CTX, second.id)?.sessionCount).toBe(1);
  });

  it('deletes an item together with its links', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const a = addSession(db, UID_A);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    withWriteTx(db, CTX, (tx) => repo.setSessions(CTX, tx, id, [a], T0));
    expect(withWriteTx(db, CTX, (tx) => [repo.delete(CTX, tx, id), repo.delete(CTX, tx, id)])).toEqual([true, false]);
    expect(repo.itemOfSession(CTX, a)).toBeUndefined();
    expect(repo.byId(CTX, id)).toBeUndefined();
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new WorkItemsRepo(db);
    const sessionId = addSession(db, UID_A);
    const created = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, item(), null));
    expectEveryMethodScoped(repo, {
      upsert: () => withWriteTx(db, CTX, (tx) => repo.upsert(FOREIGN, tx, item({ itemKey: 'attempt:other' }), null)),
      byKey: () => repo.byKey(FOREIGN, 'attempt:part-1'),
      byId: () => repo.byId(FOREIGN, created.id),
      list: () => repo.list(FOREIGN),
      setSessions: () => withWriteTx(db, CTX, (tx) => repo.setSessions(FOREIGN, tx, created.id, [sessionId], T0)),
      sessionsOf: () => repo.sessionsOf(FOREIGN, created.id),
      itemOfSession: () => repo.itemOfSession(FOREIGN, sessionId),
      delete: () => withWriteTx(db, CTX, (tx) => repo.delete(FOREIGN, tx, created.id)),
    });
    expect(repo.list(CTX)).toHaveLength(1);
    expect(repo.sessionsOf(CTX, created.id)).toEqual([]);
  });
});
