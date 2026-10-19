import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { CostStatesRepo, type NewCostState } from './cost-states.ts';
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
    path: join(tempDir('cost-states-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

/** The session, and the transcript files 1 to 4 that the states of the tests name (a state needs an existing file). */
function addSession(db: InstanceDb): number {
  const id = withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 }),
  ).id;
  for (let n = 1; n <= 4; n += 1) {
    db.driver
      .prepare(
        `INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
         VALUES (?, ?, 'session', ?, ?, ?)`,
      )
      .run([`C:/t/${n}.jsonl`, `c:/t/${n}.jsonl`, UID_A, T0, T0]);
  }
  return id;
}

function state(sessionId: number, over: Partial<NewCostState> = {}): NewCostState {
  return {
    fileId: 1,
    sessionId,
    totalCostUsd: 1.5,
    modelUsage: { 'model-a': { inputTokens: 10, outputTokens: 5 } },
    byteOffset: 1000,
    isTrailing: true,
    observedAt: T0 + 10,
    ...over,
  };
}

describe('CostStatesRepo (02 6.6, last write wins by byte offset)', () => {
  it('stores the first state of a file', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    expect(withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId)))).toBe(true);
    expect(repo.byFile(CTX, 1)).toEqual({
      fileId: 1,
      sessionId,
      totalCostUsd: 1.5,
      modelUsage: { 'model-a': { inputTokens: 10, outputTokens: 5 } },
      byteOffset: 1000,
      isTrailing: true,
      observedAt: T0 + 10,
    });
  });

  it('keeps the value at the greater byte offset whatever the order', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    const results = withWriteTx(db, CTX, (tx) => [
      repo.upsert(CTX, tx, state(sessionId, { byteOffset: 2000, totalCostUsd: 3 })),
      repo.upsert(CTX, tx, state(sessionId, { byteOffset: 1000, totalCostUsd: 1 })),
      repo.upsert(CTX, tx, state(sessionId, { byteOffset: 3000, totalCostUsd: 4, isTrailing: false })),
    ]);
    expect(results).toEqual([true, false, true]);
    expect(repo.byFile(CTX, 1)).toMatchObject({ byteOffset: 3000, totalCostUsd: 4, isTrailing: false });
  });

  it('accepts a null total and the same offset again as a no-op rewrite', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { totalCostUsd: null })));
    expect(repo.byFile(CTX, 1)?.totalCostUsd).toBeNull();
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { totalCostUsd: null })));
    expect(repo.listBySession(CTX, sessionId)).toHaveLength(1);
  });

  it('finds the latest trailing cost of a session across its files', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    expect(repo.latestTrailing(CTX, sessionId)).toBeUndefined();
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, state(sessionId, { fileId: 1, totalCostUsd: 2, observedAt: T0 + 5 }));
      repo.upsert(CTX, tx, state(sessionId, { fileId: 2, totalCostUsd: 7, observedAt: T0 + 50 }));
      repo.upsert(CTX, tx, state(sessionId, { fileId: 3, totalCostUsd: 9, observedAt: T0 + 90, isTrailing: false }));
      repo.upsert(CTX, tx, state(sessionId, { fileId: 4, totalCostUsd: null, observedAt: T0 + 99 }));
    });
    expect(repo.latestTrailing(CTX, sessionId)).toEqual({ totalCostUsd: 7, observedAt: T0 + 50 });
  });

  it('deletes the state of a file (identity reset)', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId)));
    const removed = withWriteTx(db, CTX, (tx) => [repo.deleteByFile(CTX, tx, 1), repo.deleteByFile(CTX, tx, 1)]);
    expect(removed).toEqual([true, false]);
    expect(repo.byFile(CTX, 1)).toBeUndefined();
  });

  it('markNotTrailing clears the flag of the file below the offset and keeps the amount, the offset and the time', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, state(sessionId, { fileId: 1, byteOffset: 1000 }));
      repo.upsert(CTX, tx, state(sessionId, { fileId: 2, byteOffset: 1000 }));
    });
    // a row at or below the offset of the record does not follow it
    expect(withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 1, 1000))).toBe(false);
    expect(withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 1, 400))).toBe(false);
    expect(repo.byFile(CTX, 1)?.isTrailing).toBe(true);
    // a row after it does, and only for its own file
    expect(withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 1, 1001))).toBe(true);
    expect(repo.byFile(CTX, 1)).toEqual({ ...state(sessionId), isTrailing: false });
    expect(repo.byFile(CTX, 2)?.isTrailing).toBe(true);
    // idempotent: nothing left to clear
    expect(withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 1, 5000))).toBe(false);
    // a file without a state is a no-op
    expect(withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 3, 5000))).toBe(false);
  });

  it('sessionTrailing is true while the main transcript file of the session holds a trailing state', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    expect(repo.sessionTrailing(CTX, sessionId)).toBe(false);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { fileId: 1 })));
    expect(repo.sessionTrailing(CTX, sessionId)).toBe(true);
    withWriteTx(db, CTX, (tx) => repo.markNotTrailing(CTX, tx, 1, 2000));
    expect(repo.sessionTrailing(CTX, sessionId)).toBe(false);
    // a state that is not trailing, and a session that does not exist
    expect(repo.sessionTrailing(CTX, sessionId + 100)).toBe(false);
  });

  it('sessionTrailing ignores the state of a subagent file', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    db.driver
      .prepare(
        `INSERT INTO transcript_files (path, path_key, kind, session_uid, agent_uid, discovered_at, updated_at)
         VALUES ('C:/t/agent.jsonl', 'c:/t/agent.jsonl', 'subagent', ?, 'a0123456789abcdef', ?, ?)`,
      )
      .run([UID_A, T0, T0]);
    const agentFile = db.driver
      .prepare<{ id: number }>("SELECT id FROM transcript_files WHERE kind = 'subagent'")
      .get()?.id;
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { fileId: agentFile ?? -1 })));
    expect(repo.byFile(CTX, agentFile ?? -1)?.isTrailing).toBe(true);
    expect(repo.sessionTrailing(CTX, sessionId)).toBe(false);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { fileId: 1 })));
    expect(repo.sessionTrailing(CTX, sessionId)).toBe(true);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId)));
    expectEveryMethodScoped(repo, {
      upsert: () => withWriteTx(db, CTX, (tx) => repo.upsert(FOREIGN, tx, state(sessionId, { byteOffset: 9000 }))),
      byFile: () => repo.byFile(FOREIGN, 1),
      listBySession: () => repo.listBySession(FOREIGN, sessionId),
      latestTrailing: () => repo.latestTrailing(FOREIGN, sessionId),
      deleteByFile: () => withWriteTx(db, CTX, (tx) => repo.deleteByFile(FOREIGN, tx, 1)),
      markNotTrailing: () => withWriteTx(db, CTX, (tx) => repo.markNotTrailing(FOREIGN, tx, 1, 9000)),
      sessionTrailing: () => repo.sessionTrailing(FOREIGN, sessionId),
    });
    expect(repo.byFile(CTX, 1)?.byteOffset).toBe(1000);
    expect(repo.byFile(CTX, 1)?.isTrailing).toBe(true);
  });
});

describe('CostStatesRepo soft references (03 3.4)', () => {
  it('refuses a state for a transcript file that does not exist', () => {
    const db = database();
    const repo = new CostStatesRepo(db);
    const sessionId = addSession(db);
    let error: unknown;
    try {
      withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, state(sessionId, { fileId: 12_345 })));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    expect(repo.byFile(CTX, 12_345)).toBeUndefined();
  });
});
