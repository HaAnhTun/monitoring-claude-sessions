import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ChangesRepo } from './changes.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(clock = new FakeClock(T0)): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('changes-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  open.push(db);
  return db;
}

/** One change per transaction, so the clock can place each at its own time. */
function writeChanges(db: InstanceDb, clock: FakeClock, count: number, stepMs: number): void {
  for (let i = 0; i < count; i += 1) {
    withWriteTx(db, CTX, (tx) => {
      tx.changes.reserve('session', 'upsert', { entityId: i + 1, sessionUid: UID_A });
    });
    clock.advance(stepMs);
  }
}

describe('ChangesRepo reads (03 9.1)', () => {
  it('reports the head and the oldest retained seq', () => {
    const db = database();
    const repo = new ChangesRepo(db);
    expect(repo.headSeq(CTX)).toBe(0);
    expect(repo.oldestSeq(CTX)).toBeUndefined();
    withWriteTx(db, CTX, (tx) => {
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    expect(repo.headSeq(CTX)).toBe(1);
    expect(repo.oldestSeq(CTX)).toBe(1);
  });

  it('returns the rows after a seq in order, with the payload as stored text', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    withWriteTx(db, CTX, (tx) => {
      const seq = tx.changes.reserve('event', 'append', { entityId: 1, sessionUid: UID_A });
      tx.changes.noteId(seq, 5);
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    writeChanges(db, clock, 2, 10);
    const all = repo.since(CTX, 0, 10);
    expect(all.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(all[0]).toEqual({
      seq: 1,
      at: T0,
      kind: 'event',
      op: 'append',
      sessionUid: UID_A,
      entityId: 1,
      payload: '{"from":5,"to":5,"count":1}',
    });
    expect(all[1]).toMatchObject({ kind: 'health', op: 'upsert', sessionUid: null, entityId: null, payload: '{}' });
    expect(repo.since(CTX, 2, 10).map((c) => c.seq)).toEqual([3, 4]);
    expect(repo.since(CTX, 2, 1).map((c) => c.seq)).toEqual([3]);
    expect(repo.since(CTX, 4, 10)).toEqual([]);
  });
});

describe('ChangesRepo retention (03 3.8)', () => {
  it('deletes rows older than a cutoff in bounded batches and keeps the head sequence valid', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 6, 100);
    const first = withWriteTx(db, CTX, (tx) => repo.deleteOlderThan(CTX, tx, T0 + 350, 2));
    const second = withWriteTx(db, CTX, (tx) => repo.deleteOlderThan(CTX, tx, T0 + 350, 100));
    expect([first, second]).toEqual([2, 2]);
    expect(repo.since(CTX, 0, 10).map((c) => c.seq)).toEqual([5, 6]);
    expect(repo.oldestSeq(CTX)).toBe(5);
    expect(repo.headSeq(CTX)).toBe(6);
    // deleting the newest rows too must not reuse a seq (AUTOINCREMENT)
    withWriteTx(db, CTX, (tx) => repo.deleteOlderThan(CTX, tx, T0 + 10_000, 100));
    expect(repo.headSeq(CTX)).toBe(6);
    withWriteTx(db, CTX, (tx) => {
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    expect(repo.oldestSeq(CTX)).toBe(7);
  });

  it('trims to a maximum number of rows by seq', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 8, 1);
    const removed = withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(CTX, tx, 3, 100));
    expect(removed).toBe(5);
    expect(repo.since(CTX, 0, 10).map((c) => c.seq)).toEqual([6, 7, 8]);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(CTX, tx, 3, 100))).toBe(0);
  });

  it('bounds one trim batch by the limit', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 8, 1);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(CTX, tx, 2, 2))).toBe(2);
    expect(repo.since(CTX, 0, 10)).toHaveLength(6);
  });

  it('refuses a negative limit instead of reading it as no limit', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 3, 1);
    expect(() => repo.since(CTX, 0, -1)).toThrow(RangeError);
    expect(() => withWriteTx(db, CTX, (tx) => repo.deleteOlderThan(CTX, tx, T0 + 1000, -1))).toThrow(RangeError);
    expect(repo.since(CTX, 0, 10)).toHaveLength(3);
  });

  it('refuses a negative or fractional row cap instead of deleting the log', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 5, 1);
    for (const maxRows of [-1, -1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(CTX, tx, maxRows, 100)),
        String(maxRows),
      ).toThrow(RangeError);
    }
    expect(repo.since(CTX, 0, 10)).toHaveLength(5);
    // zero is a valid cap: it keeps no row
    expect(withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(CTX, tx, 0, 100))).toBe(5);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new ChangesRepo(db);
    writeChanges(db, clock, 3, 1);
    expectEveryMethodScoped(repo, {
      headSeq: () => repo.headSeq(FOREIGN),
      oldestSeq: () => repo.oldestSeq(FOREIGN),
      since: () => repo.since(FOREIGN, 0, 10),
      deleteOlderThan: () => withWriteTx(db, CTX, (tx) => repo.deleteOlderThan(FOREIGN, tx, T0 + 1000, 10)),
      deleteBeyondMaxRows: () => withWriteTx(db, CTX, (tx) => repo.deleteBeyondMaxRows(FOREIGN, tx, 1, 10)),
    });
    expect(repo.since(CTX, 0, 10)).toHaveLength(3);
  });
});
