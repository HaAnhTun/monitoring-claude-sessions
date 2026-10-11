import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { SessionsRepo } from './sessions.ts';
import { WorkflowRunsRepo, type NewWorkflowRun, type WorkflowView } from './workflow-runs.ts';

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
    path: join(tempDir('workflow-runs-repo').path, 'monitor.db'),
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

function run(sessionId: number, over: Partial<NewWorkflowRun> = {}): NewWorkflowRun {
  return { sessionId, runUid: 'wf_0123456789ab', ...over };
}

const VIEW: WorkflowView = {
  state: 'working',
  staleKind: null,
  basis: 'observed',
  confidence: 'high',
  ruleId: 'W-2',
  evidence: [{ source: 'workflow_file', fact: 'workflow_status', at: T0 + 3 }],
  since: T0 + 3,
  evaluatedAt: T0 + 4,
  nextCheckAt: T0 + 2000,
};

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

describe('WorkflowRunsRepo.upsert (03 3.5 workflow_runs)', () => {
  it('inserts a run once and reports the creation', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, run(sessionId, { workflowName: 'review', startedCount: 1, startedAt: T0 + 5 }), null),
    );
    const second = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId), null));
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(repo.byUid(CTX, sessionId, 'wf_0123456789ab')).toMatchObject({
      id: first.id,
      workflowName: 'review',
      startedCount: 1,
      resultCount: 0,
      failedCount: 0,
      startedAt: T0 + 5,
    });
  });

  it('merges: counters only grow, the first known metadata stays, a late end time is adopted', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) =>
      repo.upsert(
        CTX,
        tx,
        run(sessionId, { workflowName: 'review', startedCount: 3, resultCount: 2, failedCount: 1, startedAt: T0 + 5 }),
        null,
      ),
    );
    withWriteTx(db, CTX, (tx) =>
      repo.upsert(
        CTX,
        tx,
        run(sessionId, {
          workflowName: 'other',
          launchToolUseId: 'toolu_1',
          startedCount: 1,
          resultCount: 5,
          failedCount: 0,
          startedAt: T0 + 1,
          endedAt: T0 + 90,
          durationMs: 85,
          agentCount: 6,
        }),
        null,
      ),
    );
    expect(repo.byUid(CTX, sessionId, 'wf_0123456789ab')).toMatchObject({
      workflowName: 'review',
      launchToolUseId: 'toolu_1',
      startedCount: 3,
      resultCount: 5,
      failedCount: 1,
      startedAt: T0 + 1,
      endedAt: T0 + 90,
      durationMs: 85,
      agentCount: 6,
    });
  });

  it('adopts a later end and an earlier start, and keeps them against the opposite order', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const upsert = (over: Partial<NewWorkflowRun>): void => {
      withWriteTx(db, CTX, (tx) => {
        repo.upsert(CTX, tx, run(sessionId, over), null);
      });
    };
    upsert({ startedAt: T0 + 5, endedAt: T0 + 100 });
    upsert({ startedAt: T0 + 9, endedAt: T0 + 50 });
    expect(repo.byUid(CTX, sessionId, 'wf_0123456789ab')).toMatchObject({ startedAt: T0 + 5, endedAt: T0 + 100 });
    upsert({ startedAt: T0 + 2, endedAt: T0 + 200 });
    expect(repo.byUid(CTX, sessionId, 'wf_0123456789ab')).toMatchObject({ startedAt: T0 + 2, endedAt: T0 + 200 });
  });

  it('stamps updated_seq when given a seq and lists the runs of a session', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const seq = withWriteTx(db, CTX, (tx) => {
      const reserved = tx.changes.reserve('workflow', 'upsert', { entityId: 1, sessionUid: UID_A });
      repo.upsert(CTX, tx, run(sessionId), reserved);
      repo.upsert(CTX, tx, run(sessionId, { runUid: 'wf_second' }), null);
      return reserved;
    });
    const runs = repo.listBySession(CTX, sessionId);
    expect(runs.map((r) => r.runUid)).toEqual(['wf_0123456789ab', 'wf_second']);
    expect(runs[0]?.updatedSeq).toBe(seq);
    expect(runs[1]?.updatedSeq).toBe(0);
  });

  it('rejects a run uid outside the wf_ shape', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId, { runUid: 'nope' }), null));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });
});

describe('WorkflowRunsRepo.writeView (DA-T-DB-19)', () => {
  it('records one workflow/upsert change on a state change and none for an unchanged view', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId), null));
    const first = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, VIEW, '{"w":1}'));
    expect(first).toMatchObject({ changed: true });
    const changes = db.driver
      .prepare<{ kind: string; op: string; session_uid: string | null; entity_id: number | null }>(
        'SELECT kind, op, session_uid, entity_id FROM changes',
      )
      .all();
    expect(changes).toEqual([{ kind: 'workflow', op: 'upsert', session_uid: UID_A, entity_id: id }]);
    const head = db.headSeq();
    const again = withWriteTx(db, CTX, (tx) =>
      repo.writeView(CTX, tx, id, { ...VIEW, evaluatedAt: T0 + 50, nextCheckAt: T0 + 3000 }, '{"w":2}'),
    );
    expect(again).toEqual({ changed: false, seq: null });
    expect(db.headSeq()).toBe(head);
    expect(repo.readView(CTX, id)).toMatchObject({ factsJson: '{"w":2}', view: { nextCheckAt: T0 + 3000 } });
    expect(repo.byUid(CTX, sessionId, 'wf_0123456789ab')).toMatchObject({ state: 'working', updatedSeq: first?.seq });
  });

  it('detects a change in the state, stale kind, basis, confidence or rule', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId), null));
    const variants: Partial<WorkflowView>[] = [
      { state: 'completed' }, // the state alone
      { staleKind: 'silent' },
      { basis: 'inferred' },
      { confidence: 'low' },
      { ruleId: 'W-9' },
    ];
    for (const variant of variants) {
      withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, VIEW, '{}'));
      const result = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, { ...VIEW, ...variant }, '{}'));
      expect(result?.changed, JSON.stringify(variant)).toBe(true);
    }
  });

  it('answers undefined for a missing run and lists the runs due for a check', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId), null));
    expect(withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, 4242, VIEW, '{}'))).toBeUndefined();
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, { ...VIEW, nextCheckAt: T0 + 70 }, '{}'));
    expect(repo.dueForCheck(CTX, T0 + 69, 5)).toEqual([]);
    expect(repo.dueForCheck(CTX, T0 + 70, 5)).toEqual([{ id, sessionId, runUid: 'wf_0123456789ab' }]);
  });
});

describe('WorkflowRunsRepo scope (DA-T-DB-7)', () => {
  it('refuses a foreign context on every public method', () => {
    const db = database();
    const repo = new WorkflowRunsRepo(db);
    const sessionId = addSession(db);
    const created = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, run(sessionId), null));
    expectEveryMethodScoped(repo, {
      upsert: () =>
        withWriteTx(db, CTX, (tx) => repo.upsert(FOREIGN, tx, run(sessionId, { runUid: 'wf_ffffffffffff' }), null)),
      byUid: () => repo.byUid(FOREIGN, sessionId, 'wf_0123456789ab'),
      listBySession: () => repo.listBySession(FOREIGN, sessionId),
      writeView: () => withWriteTx(db, CTX, (tx) => repo.writeView(FOREIGN, tx, created.id, VIEW, '{}')),
      readView: () => repo.readView(FOREIGN, created.id),
      dueForCheck: () => repo.dueForCheck(FOREIGN, T0 + 1_000_000, 10),
    });
    expect(repo.listBySession(CTX, sessionId)).toHaveLength(1);
  });
});
