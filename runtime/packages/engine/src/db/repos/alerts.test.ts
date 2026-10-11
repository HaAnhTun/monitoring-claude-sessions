import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { AlertsRepo, type NewAlert } from './alerts.ts';
import { SessionsRepo } from './sessions.ts';

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
    path: join(tempDir('alerts-repo').path, 'monitor.db'),
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

function instanceAlert(over: Partial<NewAlert> = {}): NewAlert {
  return {
    ruleId: 'import_lag',
    ruleKind: 'import_lag',
    scopeKind: 'instance',
    scopeKey: 'instance',
    sessionId: null,
    sessionUid: null,
    severity: 'warning',
    title: 'Transcript import 90 s behind',
    detail: { lagMs: 90000 },
    at: T0 + 10,
    ...over,
  };
}

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

describe('AlertsRepo.insertOpen (03 10.2)', () => {
  it('inserts an open alert and writes one alert/upsert change stamped on the row', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const id = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    const row = repo.byId(CTX, id);
    expect(row).toMatchObject({
      id,
      ruleId: 'import_lag',
      ruleKind: 'import_lag',
      scopeKind: 'instance',
      scopeKey: 'instance',
      sessionId: null,
      severity: 'warning',
      status: 'open',
      title: 'Transcript import 90 s behind',
      detail: { lagMs: 90000 },
      firstFiredAt: T0 + 10,
      lastFiredAt: T0 + 10,
      fireCount: 1,
      resolvedAt: null,
      resolvedReason: null,
    });
    expect(changes(db)).toEqual([
      { seq: row?.updatedSeq, kind: 'alert', op: 'upsert', session_uid: null, entity_id: id },
    ]);
    expect(repo.openFor(CTX, 'import_lag', 'instance')?.id).toBe(id);
    expect(repo.openFor(CTX, 'import_lag', 'other')).toBeUndefined();
  });

  it('names the session of a session scoped alert in the change', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const sessionId = addSession(db);
    const id = withWriteTx(db, CTX, (tx) =>
      repo.insertOpen(
        CTX,
        tx,
        instanceAlert({
          ruleId: 'inactivity',
          ruleKind: 'inactivity',
          scopeKind: 'session',
          scopeKey: UID_A,
          sessionId,
          sessionUid: UID_A,
          title: 'No activity for 47 min',
          detail: { minutes: 47 },
        }),
      ),
    );
    expect(changes(db)).toEqual([expect.objectContaining({ kind: 'alert', session_uid: UID_A, entity_id: id })]);
  });

  it('refuses a second open alert for the same rule and scope', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert({ at: T0 + 20 })));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });
});

describe('AlertsRepo.refire', () => {
  it('counts the firing and records no change while the severity stays', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const id = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    const head = db.headSeq();
    const result = withWriteTx(db, CTX, (tx) =>
      repo.refire(CTX, tx, id, { at: T0 + 30, severity: 'warning', detail: { lagMs: 120000 } }),
    );
    expect(result).toEqual({ severityChanged: false });
    expect(repo.byId(CTX, id)).toMatchObject({ fireCount: 2, lastFiredAt: T0 + 30, detail: { lagMs: 120000 } });
    expect(db.headSeq()).toBe(head);
  });

  it('records one change when the severity changes and stamps updated_seq with it', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const id = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    const result = withWriteTx(db, CTX, (tx) =>
      repo.refire(CTX, tx, id, { at: T0 + 30, severity: 'critical', detail: { lagMs: 900000 } }),
    );
    expect(result).toEqual({ severityChanged: true });
    const rows = changes(db);
    expect(rows).toHaveLength(2);
    expect(repo.byId(CTX, id)).toMatchObject({ severity: 'critical', updatedSeq: rows[1]?.seq });
  });

  it('answers undefined for an alert that is not open', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const id = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    withWriteTx(db, CTX, (tx) => repo.resolve(CTX, tx, id, { at: T0 + 40, reason: 'condition_cleared' }));
    expect(
      withWriteTx(db, CTX, (tx) => repo.refire(CTX, tx, id, { at: T0 + 50, severity: 'warning', detail: {} })),
    ).toBeUndefined();
  });
});

describe('AlertsRepo.resolve', () => {
  it('resolves an open alert once with a change and lets the rule fire again', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const id = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    const results = withWriteTx(db, CTX, (tx) => [
      repo.resolve(CTX, tx, id, { at: T0 + 40, reason: 'condition_cleared' }),
      repo.resolve(CTX, tx, id, { at: T0 + 41, reason: 'expired' }),
    ]);
    expect(results).toEqual([true, false]);
    expect(repo.byId(CTX, id)).toMatchObject({
      status: 'resolved',
      resolvedAt: T0 + 40,
      resolvedReason: 'condition_cleared',
    });
    expect(repo.openFor(CTX, 'import_lag', 'instance')).toBeUndefined();
    expect(changes(db)).toHaveLength(2);
    const again = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert({ at: T0 + 60 })));
    expect(again).not.toBe(id);
  });

  it('resolves the open alerts of deleted sessions with scope_deleted, one change each', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insertOpen(
        CTX,
        tx,
        instanceAlert({
          ruleId: 'hook_gap',
          ruleKind: 'hook_gap',
          scopeKind: 'session',
          scopeKey: UID_A,
          sessionId,
          sessionUid: UID_A,
        }),
      );
      repo.insertOpen(CTX, tx, instanceAlert());
    });
    const head = db.headSeq();
    const count = withWriteTx(db, CTX, (tx) => repo.resolveForSessions(CTX, tx, [sessionId], T0 + 99));
    expect(count).toBe(1);
    expect(repo.list(CTX, { status: 'open', limit: 10 }).map((a) => a.ruleId)).toEqual(['import_lag']);
    expect(repo.list(CTX, { status: 'resolved', limit: 10 })[0]).toMatchObject({
      resolvedReason: 'scope_deleted',
      resolvedAt: T0 + 99,
    });
    expect(db.headSeq()).toBe(head + 1);
    expect(withWriteTx(db, CTX, (tx) => repo.resolveForSessions(CTX, tx, [], T0))).toBe(0);
  });
});

describe('AlertsRepo reads', () => {
  it('lists newest first, filtered by status, and counts the open ones by severity', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insertOpen(CTX, tx, instanceAlert({ ruleId: 'import_lag', ruleKind: 'import_lag', at: T0 + 1 }));
      repo.insertOpen(
        CTX,
        tx,
        instanceAlert({
          ruleId: 'db_disk',
          ruleKind: 'db_disk',
          severity: 'critical',
          title: 'Free disk space 410 MB',
          at: T0 + 2,
        }),
      );
      repo.insertOpen(
        CTX,
        tx,
        instanceAlert({ ruleId: 'hook_failing', ruleKind: 'hook_failing', title: 'Hook handler failing', at: T0 + 3 }),
      );
    });
    withWriteTx(db, CTX, (tx) => {
      const lag = repo.openFor(CTX, 'import_lag', 'instance');
      if (lag !== undefined) repo.resolve(CTX, tx, lag.id, { at: T0 + 5, reason: 'condition_cleared' });
    });
    expect(repo.list(CTX, { limit: 10 }).map((a) => a.ruleId)).toEqual(['hook_failing', 'db_disk', 'import_lag']);
    expect(repo.list(CTX, { status: 'open', limit: 10 }).map((a) => a.ruleId)).toEqual(['hook_failing', 'db_disk']);
    expect(repo.list(CTX, { status: 'open', limit: 1 })).toHaveLength(1);
    expect(repo.countOpen(CTX)).toEqual({ warning: 1, critical: 1 });
  });
});

describe('AlertsRepo state and retention (03 10.2, 3.8)', () => {
  it('saves and reads the evaluation state of a rule and scope', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    expect(repo.getState(CTX, 'inactivity', UID_A)).toBeUndefined();
    withWriteTx(db, CTX, (tx) => {
      repo.saveState(CTX, tx, {
        ruleId: 'inactivity',
        scopeKey: UID_A,
        conditionSince: T0 + 5,
        lastValue: 47,
        lastEvaluatedAt: T0 + 6,
        cooldownUntil: null,
      });
    });
    withWriteTx(db, CTX, (tx) => {
      repo.saveState(CTX, tx, {
        ruleId: 'inactivity',
        scopeKey: UID_A,
        conditionSince: null,
        lastValue: null,
        lastEvaluatedAt: T0 + 7,
        cooldownUntil: T0 + 600_000,
      });
    });
    expect(repo.getState(CTX, 'inactivity', UID_A)).toEqual({
      ruleId: 'inactivity',
      scopeKey: UID_A,
      conditionSince: null,
      lastValue: null,
      lastEvaluatedAt: T0 + 7,
      cooldownUntil: T0 + 600_000,
    });
  });

  it('deletes resolved alerts older than a cutoff and idle states, in bounded batches', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 3; i += 1) {
        const id = repo.insertOpen(CTX, tx, instanceAlert({ scopeKey: `scope-${String(i)}` }));
        repo.resolve(CTX, tx, id, { at: T0 + 10 + i, reason: 'condition_cleared' });
      }
      repo.insertOpen(CTX, tx, instanceAlert({ scopeKey: 'still-open' }));
      repo.saveState(CTX, tx, {
        ruleId: 'r',
        scopeKey: 'idle',
        conditionSince: null,
        lastValue: null,
        lastEvaluatedAt: T0 + 1,
        cooldownUntil: null,
      });
      repo.saveState(CTX, tx, {
        ruleId: 'r',
        scopeKey: 'cooling',
        conditionSince: null,
        lastValue: null,
        lastEvaluatedAt: T0 + 1,
        cooldownUntil: T0 + 99_999,
      });
      repo.saveState(CTX, tx, {
        ruleId: 'r',
        scopeKey: 'holding',
        conditionSince: T0,
        lastValue: 1,
        lastEvaluatedAt: T0 + 1,
        cooldownUntil: null,
      });
    });
    expect(withWriteTx(db, CTX, (tx) => repo.deleteResolvedBefore(CTX, tx, T0 + 12, 1))).toBe(1);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteResolvedBefore(CTX, tx, T0 + 12, 100))).toBe(1);
    expect(repo.list(CTX, { status: 'resolved', limit: 10 })).toHaveLength(1);
    expect(repo.list(CTX, { status: 'open', limit: 10 })).toHaveLength(1);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteIdleStatesBefore(CTX, tx, T0 + 50_000, 100))).toBe(1);
    expect(repo.getState(CTX, 'r', 'idle')).toBeUndefined();
    expect(repo.getState(CTX, 'r', 'cooling')).toBeDefined();
    expect(repo.getState(CTX, 'r', 'holding')).toBeDefined();
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new AlertsRepo(db);
    const sessionId = addSession(db);
    const alertId = withWriteTx(db, CTX, (tx) => repo.insertOpen(CTX, tx, instanceAlert()));
    const state = {
      ruleId: 'r',
      scopeKey: 's',
      conditionSince: null,
      lastValue: null,
      lastEvaluatedAt: 1,
      cooldownUntil: null,
    };
    withWriteTx(db, CTX, (tx) => {
      repo.saveState(CTX, tx, state);
    });
    expectEveryMethodScoped(
      repo,
      {
        openFor: () => repo.openFor(FOREIGN, 'import_lag', 'instance'),
        byId: () => repo.byId(FOREIGN, alertId),
        list: () => repo.list(FOREIGN, { limit: 1 }),
        countOpen: () => repo.countOpen(FOREIGN),
        insertOpen: () =>
          withWriteTx(db, CTX, (tx) => repo.insertOpen(FOREIGN, tx, instanceAlert({ ruleId: 'other_rule' }))),
        refire: () =>
          withWriteTx(db, CTX, (tx) =>
            repo.refire(FOREIGN, tx, alertId, { at: T0 + 20, severity: 'warning', detail: {} }),
          ),
        resolve: () =>
          withWriteTx(db, CTX, (tx) => repo.resolve(FOREIGN, tx, alertId, { at: T0 + 20, reason: 'expired' })),
        resolveForSessions: () =>
          withWriteTx(db, CTX, (tx) => repo.resolveForSessions(FOREIGN, tx, [sessionId], T0 + 20)),
        getState: () => repo.getState(FOREIGN, 'r', 's'),
        saveState: () => {
          withWriteTx(db, CTX, (tx) => {
            repo.saveState(FOREIGN, tx, { ...state, lastEvaluatedAt: 2 });
          });
        },
        deleteResolvedBefore: () =>
          withWriteTx(db, CTX, (tx) => repo.deleteResolvedBefore(FOREIGN, tx, T0 + 1_000_000, 10)),
        deleteIdleStatesBefore: () =>
          withWriteTx(db, CTX, (tx) => repo.deleteIdleStatesBefore(FOREIGN, tx, T0 + 1_000_000, 10)),
      },
      ['openRow', 'resolveOpen'],
    );
    expect(repo.byId(CTX, alertId)?.status).toBe('open');
    expect(repo.getState(CTX, 'r', 's')?.lastEvaluatedAt).toBe(1);
  });
});
