import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from './spool-cursors.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const SEG_1 = 'hooks-20260101T00Z.ndjson';
const SEG_2 = 'hooks-20260101T01Z.ndjson';
const SEG_3 = 'hooks-20260101T02Z.ndjson';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(clock = new FakeClock(T0)): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('spool-cursors-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  open.push(db);
  return db;
}

function cursor(segment: string, over: Partial<NewSpoolCursor> = {}): NewSpoolCursor {
  return {
    segment,
    offsetBytes: 100,
    sizeSeen: 130,
    ino: '12345',
    headHash: 'a'.repeat(64),
    lines: 4,
    partialBytes: 30,
    sealed: false,
    errors: 1,
    oldestReceivedAt: T0 + 1,
    newestReceivedAt: T0 + 9,
    drainedAt: null,
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

describe('SpoolCursorsRepo (02 2.7)', () => {
  it('stores a cursor, keeps its first-seen time on later saves and reads it back', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new SpoolCursorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1));
    });
    clock.advance(500);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1, { offsetBytes: 130, partialBytes: 0, lines: 5, sealed: true }));
    });
    expect(repo.get(CTX, SEG_1)).toEqual({
      segment: SEG_1,
      offsetBytes: 130,
      sizeSeen: 130,
      ino: '12345',
      headHash: 'a'.repeat(64),
      lines: 5,
      partialBytes: 0,
      sealed: true,
      errors: 1,
      oldestReceivedAt: T0 + 1,
      newestReceivedAt: T0 + 9,
      firstSeenAt: T0,
      drainedAt: null,
      updatedAt: T0 + 500,
    });
    expect(repo.get(CTX, SEG_2)).toBeUndefined();
  });

  it('lists every cursor by segment name and only the unsealed ones on request', () => {
    const db = database();
    const repo = new SpoolCursorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_2, { sealed: true }));
      repo.save(CTX, tx, cursor(SEG_1));
      repo.save(CTX, tx, cursor(SEG_3));
    });
    expect(repo.list(CTX).map((c) => c.segment)).toEqual([SEG_1, SEG_2, SEG_3]);
    expect(repo.listUnsealed(CTX).map((c) => c.segment)).toEqual([SEG_1, SEG_3]);
  });

  it('resets the cursors for a replay and creates rows for segments without one', () => {
    const db = database();
    const repo = new SpoolCursorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1, { sealed: true, drainedAt: T0 + 50 }));
    });
    const count = withWriteTx(db, CTX, (tx) => repo.resetMany(CTX, tx, [SEG_1, SEG_2]));
    expect(count).toBe(2);
    expect(repo.get(CTX, SEG_1)).toMatchObject({
      offsetBytes: 0,
      partialBytes: 0,
      lines: 0,
      sealed: false,
      sizeSeen: 130,
      errors: 1,
    });
    expect(repo.get(CTX, SEG_2)).toMatchObject({ offsetBytes: 0, sizeSeen: 0, sealed: false, lines: 0 });
    expect(withWriteTx(db, CTX, (tx) => repo.resetMany(CTX, tx, []))).toBe(0);
  });

  it('deletes a cursor', () => {
    const db = database();
    const repo = new SpoolCursorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1));
    });
    expect(withWriteTx(db, CTX, (tx) => [repo.delete(CTX, tx, SEG_1), repo.delete(CTX, tx, SEG_1)])).toEqual([
      true,
      false,
    ]);
  });

  it('refuses a segment name outside the shape and an offset beyond the size', () => {
    const db = database();
    const repo = new SpoolCursorsRepo(db);
    for (const bad of [cursor('hooks.log'), cursor(SEG_1, { offsetBytes: 500 })]) {
      let code: string | undefined;
      try {
        withWriteTx(db, CTX, (tx) => {
          repo.save(CTX, tx, bad);
        });
      } catch (error) {
        code = isDbError(error) ? error.code : undefined;
      }
      expect(code).toBe('db_constraint');
    }
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new SpoolCursorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1));
    });
    expectEveryMethodScoped(repo, {
      save: () => {
        withWriteTx(db, CTX, (tx) => {
          repo.save(FOREIGN, tx, cursor(SEG_2));
        });
      },
      get: () => repo.get(FOREIGN, SEG_1),
      list: () => repo.list(FOREIGN),
      listUnsealed: () => repo.listUnsealed(FOREIGN),
      resetMany: () => withWriteTx(db, CTX, (tx) => repo.resetMany(FOREIGN, tx, [SEG_1])),
      delete: () => withWriteTx(db, CTX, (tx) => repo.delete(FOREIGN, tx, SEG_1)),
    });
    expect(repo.list(CTX).map((c) => c.segment)).toEqual([SEG_1]);
    expect(repo.get(CTX, SEG_1)?.offsetBytes).toBe(100);
  });
});
