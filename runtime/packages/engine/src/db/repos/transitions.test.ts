import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { SessionsRepo } from './sessions.ts';
import { TransitionsRepo, rowLimit, type NewTransition } from './transitions.ts';
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
    path: join(tempDir('transitions-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function addSession(db: InstanceDb): { id: number; agentId: number } {
  const ensured = withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: UID_A, projectId: null, startedAt: T0 }),
  );
  return { id: ensured.id, agentId: ensured.agentId };
}

function transition(sessionId: number, over: Partial<NewTransition> = {}): NewTransition {
  return {
    sessionId,
    agentId: null,
    fromState: 'unknown',
    toState: 'working',
    rule: 'S-7c',
    basis: 'observed',
    confidence: 'high',
    evidence: [{ source: 'hook', fact: 'prompt', at: T0 }],
    at: T0 + 1,
    ...over,
  };
}

describe('TransitionsRepo (03 3.5 state_transitions)', () => {
  it('inserts a transition and lists the newest first', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    const { id: sessionId } = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, transition(sessionId, { at: T0 + 1 }));
      repo.insert(CTX, tx, transition(sessionId, { fromState: 'working', toState: 'turn_ended', at: T0 + 9 }));
    });
    const rows = repo.listBySession(CTX, sessionId, 10);
    expect(rows.map((r) => [r.fromState, r.toState, r.at])).toEqual([
      ['working', 'turn_ended', T0 + 9],
      ['unknown', 'working', T0 + 1],
    ]);
    expect(rows[1]).toMatchObject({
      sessionId,
      agentId: null,
      rule: 'S-7c',
      basis: 'observed',
      confidence: 'high',
      evidence: [{ source: 'hook', fact: 'prompt', at: T0 }],
    });
    expect(repo.listBySession(CTX, sessionId, 1)).toHaveLength(1);
    expect(repo.countBySession(CTX, sessionId)).toBe(2);
  });

  it('keeps an agent level transition apart from the session level ones by agent_id', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    const { id: sessionId, agentId } = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, transition(sessionId, { agentId }));
    });
    expect(repo.listBySession(CTX, sessionId, 5)[0]?.agentId).toBe(agentId);
  });

  it('accepts a first transition without a previous state', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    const { id: sessionId } = addSession(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, transition(sessionId, { fromState: null })));
    expect(repo.listBySession(CTX, sessionId, 5)[0]?.fromState).toBeNull();
  });

  it('rejects a transition of a session that does not exist', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, transition(4242)));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('accepts a non-negative integer as a row limit and refuses the rest, because SQLite reads -1 as no limit', () => {
    expect([0, 1, 500].map((n) => rowLimit(n))).toEqual([0, 1, 500]);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rowLimit(bad)).toThrow(RangeError);
    }
    const db = database();
    const session = addSession(db);
    const repo = new TransitionsRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, transition(session.id)));
    expect(() => repo.listBySession(CTX, session.id, -1)).toThrow(RangeError);
    expect(repo.listBySession(CTX, session.id, 0)).toEqual([]);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    const session = addSession(db);
    expectEveryMethodScoped(repo, {
      insert: () => withWriteTx(db, CTX, (tx) => repo.insert(FOREIGN, tx, transition(session.id))),
      listBySession: () => repo.listBySession(FOREIGN, session.id, 1),
      countBySession: () => repo.countBySession(FOREIGN, session.id),
    });
    expect(repo.countBySession(CTX, session.id)).toBe(0);
  });
});

describe('TransitionsRepo soft references (03 3.4)', () => {
  it('refuses an agent level transition for an agent that does not exist or belongs to another session', () => {
    const db = database();
    const repo = new TransitionsRepo(db);
    const session = addSession(db);
    const other = withWriteTx(db, CTX, (tx) =>
      new SessionsRepo(db).ensure(CTX, tx, {
        sessionUid: 'bbbbbbbb-0000-4000-8000-000000000002',
        projectId: null,
        startedAt: T0,
      }),
    );
    for (const agentId of [99_999, other.agentId]) {
      let error: unknown;
      try {
        withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, transition(session.id, { agentId })));
      } catch (caught) {
        error = caught;
      }
      expect(error, String(agentId)).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    }
    expect(repo.countBySession(CTX, session.id)).toBe(0);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, transition(session.id, { agentId: session.agentId })));
    expect(repo.countBySession(CTX, session.id)).toBe(1);
  });
});
