import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { HookProbesRepo } from './hook-probes.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const PROBE_1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const PROBE_2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('hook-probes-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

describe('HookProbesRepo (02 3.7)', () => {
  it('stores a probe once (insert or ignore) and reads it back', () => {
    const db = database();
    const repo = new HookProbesRepo(db);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, { probeSessionId: PROBE_1, receivedAt: T0 + 1, committedAt: T0 + 2 }),
    );
    const again = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, { probeSessionId: PROBE_1, receivedAt: T0 + 100, committedAt: T0 + 200 }),
    );
    expect([first, again]).toEqual([true, false]);
    expect(repo.get(CTX, PROBE_1)).toEqual({ probeSessionId: PROBE_1, receivedAt: T0 + 1, committedAt: T0 + 2 });
    expect(repo.get(CTX, PROBE_2)).toBeUndefined();
  });

  it('never creates a session or an event', () => {
    const db = database();
    const repo = new HookProbesRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, { probeSessionId: PROBE_1, receivedAt: T0, committedAt: T0 }));
    for (const table of ['sessions', 'events', 'changes']) {
      expect(db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    }
  });

  it('deletes probes committed before a cutoff in bounded batches', () => {
    const db = database();
    const repo = new HookProbesRepo(db);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 4; i += 1) {
        const probeSessionId = `aaaaaaaa-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
        repo.insert(CTX, tx, { probeSessionId, receivedAt: T0, committedAt: T0 + i });
      }
    });
    expect(withWriteTx(db, CTX, (tx) => repo.deleteCommittedBefore(CTX, tx, T0 + 3, 2))).toBe(2);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteCommittedBefore(CTX, tx, T0 + 3, 2))).toBe(1);
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM hook_probes').get()?.n).toBe(1);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new HookProbesRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, { probeSessionId: PROBE_1, receivedAt: 1, committedAt: 1 }));
    expectEveryMethodScoped(repo, {
      insert: () =>
        withWriteTx(db, CTX, (tx) =>
          repo.insert(FOREIGN, tx, { probeSessionId: PROBE_2, receivedAt: 1, committedAt: 1 }),
        ),
      get: () => repo.get(FOREIGN, PROBE_1),
      deleteCommittedBefore: () => withWriteTx(db, CTX, (tx) => repo.deleteCommittedBefore(FOREIGN, tx, T0, 10)),
    });
    expect(repo.get(CTX, PROBE_1)).toBeDefined();
    expect(repo.get(CTX, PROBE_2)).toBeUndefined();
  });
});
