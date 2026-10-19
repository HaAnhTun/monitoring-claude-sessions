import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { IngestHealthRepo, type NewIngestHealth } from './ingest-health.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('ingest-health-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function report(over: Partial<NewIngestHealth> = {}): NewIngestHealth {
  return {
    evaluatedAt: T0 + 10,
    status: 'ok',
    lastEnvelopeAt: T0 + 1,
    lastCommitAt: T0 + 2,
    lastDrainAt: null,
    lastNudgeAt: null,
    lastScanAt: T0 + 3,
    lastSyncAt: T0 + 4,
    countersJson: '{"duplicates":0}',
    reportJson: '{"status":"ok"}',
    ...over,
  };
}

describe('IngestHealthRepo (02 8.2: one row)', () => {
  it('has no row until the first save', () => {
    const repo = new IngestHealthRepo(database());
    expect(repo.get(CTX)).toBeUndefined();
  });

  it('saves the single row and reports the previous status', () => {
    const db = database();
    const repo = new IngestHealthRepo(db);
    const first = withWriteTx(db, CTX, (tx) => repo.save(CTX, tx, report()));
    expect(first).toEqual({ previousStatus: null });
    expect(repo.get(CTX)).toEqual({
      evaluatedAt: T0 + 10,
      status: 'ok',
      lastEnvelopeAt: T0 + 1,
      lastCommitAt: T0 + 2,
      lastDrainAt: null,
      lastNudgeAt: null,
      lastScanAt: T0 + 3,
      lastSyncAt: T0 + 4,
      countersJson: '{"duplicates":0}',
      reportJson: '{"status":"ok"}',
      updatedAt: T0,
    });
    const second = withWriteTx(db, CTX, (tx) =>
      repo.save(CTX, tx, report({ status: 'degraded', evaluatedAt: T0 + 20, reportJson: '{"status":"degraded"}' })),
    );
    expect(second).toEqual({ previousStatus: 'ok' });
    expect(repo.get(CTX)).toMatchObject({
      status: 'degraded',
      evaluatedAt: T0 + 20,
      reportJson: '{"status":"degraded"}',
    });
    expect(db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM ingest_health').get()?.n).toBe(1);
  });

  it('does not touch the change log (the caller reserves health/upsert on a status change)', () => {
    const db = database();
    const repo = new IngestHealthRepo(db);
    withWriteTx(db, CTX, (tx) => repo.save(CTX, tx, report()));
    expect(db.headSeq()).toBe(0);
  });

  it('refuses invalid JSON text with a constraint error', () => {
    const db = database();
    const repo = new IngestHealthRepo(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.save(CTX, tx, report({ countersJson: 'not json' })));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new IngestHealthRepo(db);
    expectEveryMethodScoped(repo, {
      get: () => repo.get(FOREIGN),
      save: () => withWriteTx(db, CTX, (tx) => repo.save(FOREIGN, tx, report())),
    });
    expect(repo.get(CTX)).toBeUndefined();
  });
});
