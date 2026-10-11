import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { MetaRepo } from './meta.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('meta-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(FIXTURE_EPOCH_MS),
  });
  open.push(db);
  return db;
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

describe('MetaRepo (03 3.3)', () => {
  it('reads the rows the migration wrote and an absent key as undefined', () => {
    const repo = new MetaRepo(database());
    expect(repo.get(CTX, 'instance_id')).toBe(INSTANCE_ID);
    expect(repo.get(CTX, 'privacy_profile')).toBe('metadata-v1');
    expect(repo.get(CTX, 'no_such_key')).toBeUndefined();
  });

  it('sets, overwrites and deletes a key inside a write transaction', () => {
    const db = database();
    const repo = new MetaRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.set(CTX, tx, 'last_alive_at', '100');
    });
    withWriteTx(db, CTX, (tx) => {
      repo.set(CTX, tx, 'last_alive_at', '200');
    });
    expect(repo.get(CTX, 'last_alive_at')).toBe('200');
    expect(repo.all(CTX).get('last_alive_at')).toBe('200');
    const removed = withWriteTx(db, CTX, (tx) => [
      repo.delete(CTX, tx, 'last_alive_at'),
      repo.delete(CTX, tx, 'last_alive_at'),
    ]);
    expect(removed).toEqual([true, false]);
    expect(repo.get(CTX, 'last_alive_at')).toBeUndefined();
  });

  it('never rewrites the identity row (DA-I3)', () => {
    const db = database();
    const repo = new MetaRepo(db);
    expect(() => {
      withWriteTx(db, CTX, (tx) => {
        repo.set(CTX, tx, 'instance_id', '33333333-3333-4333-8333-333333333333');
      });
    }).toThrow(RangeError);
    expect(repo.get(CTX, 'instance_id')).toBe(INSTANCE_ID);
    expect(() => {
      withWriteTx(db, CTX, (tx) => {
        repo.delete(CTX, tx, 'instance_id');
      });
    }).toThrow(RangeError);
  });

  it('refuses a foreign context on every public method before any statement runs (DA-T-DB-7)', () => {
    const db = database();
    const repo = new MetaRepo(db);
    expectEveryMethodScoped(repo, {
      get: () => repo.get(FOREIGN, 'instance_id'),
      all: () => repo.all(FOREIGN),
      set: () => {
        withWriteTx(db, CTX, (tx) => {
          repo.set(FOREIGN, tx, 'last_alive_at', '1');
        });
      },
      delete: () => withWriteTx(db, CTX, (tx) => repo.delete(FOREIGN, tx, 'privacy_profile')),
    });
    expect(repo.get(CTX, 'privacy_profile')).toBe('metadata-v1');
  });
});
