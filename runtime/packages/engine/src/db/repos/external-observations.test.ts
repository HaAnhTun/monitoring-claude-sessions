import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ExternalObservationsRepo } from './external-observations.ts';
import { SessionsRepo } from './sessions.ts';
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

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('external-observations-repo').path, 'monitor.db'),
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

describe('ExternalObservationsRepo (02 7.10, last write wins)', () => {
  it('keeps the latest observation per session and source', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    const applied = withWriteTx(db, CTX, (tx) => [
      repo.upsert(CTX, tx, { sessionId, source: 'registry', observedAt: T0 + 10, value: { status: 'busy', pid: 7 } }),
      repo.upsert(CTX, tx, { sessionId, source: 'registry', observedAt: T0 + 20, value: { status: 'idle', pid: 7 } }),
    ]);
    expect(applied).toEqual([true, true]);
    expect(repo.get(CTX, sessionId, 'registry')).toEqual({
      sessionId,
      source: 'registry',
      observedAt: T0 + 20,
      value: { status: 'idle', pid: 7 },
    });
  });

  it('ignores an older observation, whatever the arrival order', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    const applied = withWriteTx(db, CTX, (tx) => [
      repo.upsert(CTX, tx, { sessionId, source: 'pid', observedAt: T0 + 20, value: { alive: false } }),
      repo.upsert(CTX, tx, { sessionId, source: 'pid', observedAt: T0 + 10, value: { alive: true } }),
    ]);
    expect(applied).toEqual([true, false]);
    expect(repo.get(CTX, sessionId, 'pid')?.value).toEqual({ alive: false });
  });

  it('is idempotent for the same observation and breaks a time tie deterministically', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    const same = { sessionId, source: 'job' as const, observedAt: T0 + 5, value: { state: 'running' } };
    const first = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, same));
    const again = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, same));
    expect([first, again]).toEqual([true, false]);
    // the same two tied observations in the opposite order end in the same stored value
    const tied = (source: 'job' | 'pid', state: string) => ({
      sessionId,
      source,
      observedAt: T0 + 5,
      value: { state },
    });
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, tied('pid', 'running'));
      repo.upsert(CTX, tx, tied('pid', 'finished'));
      repo.upsert(CTX, tx, tied('job', 'finished'));
      repo.upsert(CTX, tx, tied('job', 'running'));
    });
    expect(repo.get(CTX, sessionId, 'pid')?.value).toEqual(repo.get(CTX, sessionId, 'job')?.value);
  });

  it('lists the observations of a session and deletes one source', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, { sessionId, source: 'attempt', observedAt: T0 + 1, value: { state: 'COMPLETED' } });
      repo.upsert(CTX, tx, { sessionId, source: 'pid', observedAt: T0 + 2, value: { alive: true } });
    });
    expect(repo.listBySession(CTX, sessionId).map((o) => o.source)).toEqual(['attempt', 'pid']);
    const removed = withWriteTx(db, CTX, (tx) => [
      repo.delete(CTX, tx, sessionId, 'attempt'),
      repo.delete(CTX, tx, sessionId, 'attempt'),
    ]);
    expect(removed).toEqual([true, false]);
    expect(repo.get(CTX, sessionId, 'attempt')).toBeUndefined();
    expect(repo.listBySession(CTX, sessionId).map((o) => o.source)).toEqual(['pid']);
  });

  it('breaks a time tie by the larger serialized value, whatever the arrival order', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    const low = { sessionId, source: 'registry', observedAt: T0 + 10, value: { status: 'busy' } } as const;
    const high = { ...low, value: { status: 'idle' } };
    // low then high: the larger value replaces the smaller one; low again: the stored larger value stays
    expect(
      withWriteTx(db, CTX, (tx) => [repo.upsert(CTX, tx, low), repo.upsert(CTX, tx, high), repo.upsert(CTX, tx, low)]),
    ).toEqual([true, true, false]);
    expect(repo.get(CTX, sessionId, 'registry')?.value).toEqual({ status: 'idle' });
    expect(withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, high))).toBe(false);
  });

  it('refuses an observation of a session that does not exist', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) =>
        repo.upsert(CTX, tx, { sessionId: 4242, source: 'pid', observedAt: T0, value: { alive: true } }),
      );
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new ExternalObservationsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, { sessionId, source: 'pid', observedAt: T0, value: { alive: true } }),
    );
    expectEveryMethodScoped(repo, {
      upsert: () =>
        withWriteTx(db, CTX, (tx) =>
          repo.upsert(FOREIGN, tx, { sessionId, source: 'registry', observedAt: T0, value: { status: 'busy' } }),
        ),
      delete: () => withWriteTx(db, CTX, (tx) => repo.delete(FOREIGN, tx, sessionId, 'pid')),
      get: () => repo.get(FOREIGN, sessionId, 'pid'),
      listBySession: () => repo.listBySession(FOREIGN, sessionId),
    });
    expect(repo.listBySession(CTX, sessionId).map((o) => o.source)).toEqual(['pid']);
  });
});
