import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { AgentsRepo, type NewAgent } from './agents.ts';
import { SessionsRepo, type StoredView } from './sessions.ts';
import { WorkflowRunsRepo } from './workflow-runs.ts';

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
    path: join(tempDir('agents-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
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

function sub(session: { id: number; agentId: number }, over: Partial<NewAgent> = {}): NewAgent {
  return {
    sessionId: session.id,
    agentUid: 'a1b2c3d4e5',
    parentAgentId: session.agentId,
    kind: 'subagent',
    depth: 1,
    startedAt: T0 + 10,
    ...over,
  };
}

const RUNNING: StoredView = {
  state: 'running',
  presence: 'open',
  waitReason: null,
  staleKind: null,
  endReason: null,
  turnOutcome: null,
  basis: 'inferred',
  confidence: 'medium',
  ruleId: 'A-3',
  evidence: [{ source: 'transcript', fact: 'file_written', at: T0 + 12 }],
  since: T0 + 12,
  evaluatedAt: T0 + 13,
  nextCheckAt: T0 + 5000,
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

describe('AgentsRepo.upsert (03 3.5 agents)', () => {
  it('inserts a subagent under the main agent and reports the creation', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const result = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, sub(session, { agentType: 'Explore', label: 'scan', model: 'm-1' }), null),
    );
    expect(result.created).toBe(true);
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({
      id: result.id,
      sessionId: session.id,
      kind: 'subagent',
      depth: 1,
      parentAgentId: session.agentId,
      agentType: 'Explore',
      label: 'scan',
      model: 'm-1',
      startedAt: T0 + 10,
      lastActivityAt: T0 + 10,
      state: 'unknown',
    });
  });

  it('merges a second upsert: first non-null metadata wins, the earlier start wins, the id stays', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, sub(session, { agentType: 'Explore', startedAt: T0 + 50 }), null),
    );
    const second = withWriteTx(db, CTX, (tx) =>
      repo.upsert(
        CTX,
        tx,
        sub(session, { agentType: 'Plan', description: 'look around', label: 'later', startedAt: T0 + 20 }),
        null,
      ),
    );
    expect(second).toEqual({ id: first.id, created: false });
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({
      agentType: 'Explore',
      description: 'look around',
      label: 'later',
      startedAt: T0 + 20,
      lastActivityAt: T0 + 50,
    });
    const third = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session, { label: 'ignored' }), null));
    expect(third.created).toBe(false);
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')?.label).toBe('later');
  });

  it('keeps the earliest start and the first known model whatever the arrival order', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const upsert = (over: Partial<NewAgent>): void => {
      withWriteTx(db, CTX, (tx) => {
        repo.upsert(CTX, tx, sub(session, over), null);
      });
    };
    upsert({ startedAt: T0 + 20 });
    upsert({ startedAt: T0 + 90, model: 'm-1' });
    upsert({ startedAt: T0 + 95, model: 'm-2' });
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({
      startedAt: T0 + 20,
      model: 'm-1',
      lastActivityAt: T0 + 95,
    });
  });

  it('advances updated_at with the clock on an upsert and on an update, and keeps first_seen_at', () => {
    const clock = new FakeClock(T0);
    const db = database(clock);
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const created = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')?.updatedAt).toBe(T0);
    clock.advance(500);
    withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session, { label: 'x' }), null));
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')?.updatedAt).toBe(T0 + 500);
    clock.advance(500);
    withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, created.id, { errorCount: 2 }, null));
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')?.updatedAt).toBe(T0 + 1000);
  });

  it('stamps updated_seq only when given a seq', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const seq = withWriteTx(db, CTX, (tx) => {
      const reserved = tx.changes.reserve('agent', 'upsert', { entityId: null, sessionUid: UID_A });
      repo.upsert(CTX, tx, sub(session), reserved);
      return reserved;
    });
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')?.updatedSeq).toBe(seq);
  });

  it('rejects an invalid hierarchy with a constraint error', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session, { parentAgentId: null }), null));
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('lists the agents of a session in creation order and counts them', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    withWriteTx(db, CTX, (tx) => {
      repo.upsert(CTX, tx, sub(session, { agentUid: 'agent-one' }), null);
      repo.upsert(CTX, tx, sub(session, { agentUid: 'agent-two', kind: 'workflow_agent' }), null);
    });
    expect(repo.listBySession(CTX, session.id).map((a) => a.agentUid)).toEqual(['main', 'agent-one', 'agent-two']);
    expect(repo.countBySession(CTX, session.id)).toBe(3);
    expect(repo.byUid(CTX, session.id, 'nope')).toBeUndefined();
  });
});

describe('agent kinds (C56)', () => {
  it('stores each of the five kinds and refuses any other spelling', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const kinds = ['subagent', 'workflow_agent', 'teammate', 'internal'] as const;
    withWriteTx(db, CTX, (tx) => {
      for (const kind of kinds) repo.upsert(CTX, tx, sub(session, { agentUid: `agent-${kind}`, kind }), null);
    });
    expect(repo.listBySession(CTX, session.id).map((a) => a.kind)).toEqual(['main', ...kinds]);
    let code: string | undefined;
    try {
      db.driver
        .prepare(
          `INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at)
           VALUES (?, 'agent-bad', ?, 'sidechain', 1, 1, 1, 1, 1)`,
        )
        .run([session.id, session.agentId]);
    } catch (error) {
      code = isDbError(error) ? error.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });
});

describe('AgentsRepo.update', () => {
  it('writes only the named columns', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    const done = withWriteTx(db, CTX, (tx) =>
      repo.update(CTX, tx, id, { lastActivityAt: T0 + 90, endedAt: T0 + 95, toolCallCount: 4, errorCount: 1 }, null),
    );
    expect(done).toBe(true);
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({
      lastActivityAt: T0 + 90,
      endedAt: T0 + 95,
      toolCallCount: 4,
      errorCount: 1,
    });
    expect(withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, {}, null))).toBe(false);
    expect(withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, 9999, { errorCount: 1 }, null))).toBe(false);
  });
});

describe('AgentsRepo.writeView (DA-T-DB-19)', () => {
  it('writes an agent level transition and one agent/upsert change on a state change', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    const result = withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, RUNNING, '{"f":1}'));
    expect(result).toMatchObject({ changed: true, transitioned: true });
    const changes = db.driver
      .prepare<{ kind: string; op: string; session_uid: string | null; entity_id: number | null }>(
        'SELECT kind, op, session_uid, entity_id FROM changes',
      )
      .all();
    expect(changes).toEqual([{ kind: 'agent', op: 'upsert', session_uid: UID_A, entity_id: id }]);
    const transition = db.driver
      .prepare<{ session_id: number; agent_id: number | null; from_state: string | null; to_state: string }>(
        'SELECT session_id, agent_id, from_state, to_state FROM state_transitions',
      )
      .all();
    expect(transition).toEqual([{ session_id: session.id, agent_id: id, from_state: 'unknown', to_state: 'running' }]);
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({ state: 'running', updatedSeq: result?.seq });
    expect(repo.readView(CTX, id)).toEqual({ view: RUNNING, factsJson: '{"f":1}' });
  });

  it('records nothing for an unchanged view', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, RUNNING, '{}'));
    const head = db.headSeq();
    const again = withWriteTx(db, CTX, (tx) =>
      repo.writeView(CTX, tx, id, { ...RUNNING, evaluatedAt: T0 + 999, nextCheckAt: null }, '{"x":2}'),
    );
    expect(again).toMatchObject({ changed: false, transitioned: false, seq: null });
    expect(db.headSeq()).toBe(head);
    expect(repo.readView(CTX, id)).toMatchObject({ factsJson: '{"x":2}', view: { nextCheckAt: null } });
  });

  it('returns the rows due for a check', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    withWriteTx(db, CTX, (tx) => repo.writeView(CTX, tx, id, { ...RUNNING, nextCheckAt: T0 + 100 }, '{}'));
    expect(repo.dueForCheck(CTX, T0 + 99, 5)).toEqual([]);
    expect(repo.dueForCheck(CTX, T0 + 100, 5)).toEqual([{ id, sessionId: session.id, agentUid: 'a1b2c3d4e5' }]);
  });
});

describe('AgentsRepo scope (DA-T-DB-7)', () => {
  it('refuses a foreign context on every public method', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const agent = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    // an unchanged view: a changed one would reach TransitionsRepo, whose own check would mask a missing one here
    const stored = repo.readView(CTX, agent.id);
    if (stored === undefined) throw new Error('the row exists');
    expectEveryMethodScoped(repo, {
      upsert: () =>
        withWriteTx(db, CTX, (tx) => repo.upsert(FOREIGN, tx, sub(session, { agentUid: 'f0f0f0f0f0' }), null)),
      byUid: () => repo.byUid(FOREIGN, session.id, 'a1b2c3d4e5'),
      listBySession: () => repo.listBySession(FOREIGN, session.id),
      countBySession: () => repo.countBySession(FOREIGN, session.id),
      update: () => withWriteTx(db, CTX, (tx) => repo.update(FOREIGN, tx, agent.id, { errorCount: 1 }, null)),
      writeView: () =>
        withWriteTx(db, CTX, (tx) => repo.writeView(FOREIGN, tx, agent.id, stored.view, stored.factsJson)),
      readView: () => repo.readView(FOREIGN, agent.id),
      dueForCheck: () => repo.dueForCheck(FOREIGN, T0 + 10_000, 10),
    });
    expect(repo.countBySession(CTX, session.id)).toBe(2);
    expect(repo.readView(CTX, agent.id)?.view.state).not.toBe('running');
  });
});

function addFile(db: InstanceDb, name: string): number {
  return db.driver
    .prepare(
      `INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
       VALUES (?, ?, 'session', ?, ?, ?)`,
    )
    .run([`C:/t/${name}.jsonl`, `c:/t/${name}.jsonl`, UID_A, T0, T0]).lastInsertRowid;
}

function addWorkflowRun(db: InstanceDb, sessionId: number, runUid: string): number {
  return withWriteTx(db, CTX, (tx) => new WorkflowRunsRepo(db).upsert(CTX, tx, { sessionId, runUid }, null)).id;
}

function foreignKeyFailure(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return isDbError(error) && error.code === 'db_constraint' && error.constraint === 'foreignkey';
  }
  return false;
}

describe('AgentsRepo soft references (03 3.4, DA-T-DB-7)', () => {
  it('refuses an upsert whose parent, workflow run or transcript file does not exist in the session', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const other = withWriteTx(db, CTX, (tx) =>
      new SessionsRepo(db).ensure(CTX, tx, {
        sessionUid: 'bbbbbbbb-0000-4000-8000-000000000002',
        projectId: null,
        startedAt: T0,
      }),
    );
    const cases: Partial<NewAgent>[] = [
      { parentAgentId: 9999 },
      { parentAgentId: other.agentId }, // the main agent of another session
      { workflowRunId: 9999 },
      { workflowRunId: addWorkflowRun(db, other.id, 'wf_other') }, // a run of another session
      { transcriptFileId: 9999 },
    ];
    for (const over of cases) {
      expect(
        foreignKeyFailure(() => withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session, over), null))),
        JSON.stringify(over),
      ).toBe(true);
    }
    expect(repo.countBySession(CTX, session.id)).toBe(1);
  });

  it('accepts an upsert whose references exist', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const run = addWorkflowRun(db, session.id, 'wf_one');
    const file = addFile(db, 'one');
    withWriteTx(db, CTX, (tx) =>
      repo.upsert(CTX, tx, sub(session, { workflowRunId: run, transcriptFileId: file }), null),
    );
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({
      parentAgentId: session.agentId,
      workflowRunId: run,
      transcriptFileId: file,
    });
  });

  it('refuses an update that names a workflow run or a transcript file that does not exist', () => {
    const db = database();
    const repo = new AgentsRepo(db);
    const session = addSession(db);
    const { id } = withWriteTx(db, CTX, (tx) => repo.upsert(CTX, tx, sub(session), null));
    const otherRun = addWorkflowRun(
      db,
      withWriteTx(db, CTX, (tx) =>
        new SessionsRepo(db).ensure(CTX, tx, {
          sessionUid: 'bbbbbbbb-0000-4000-8000-000000000002',
          projectId: null,
          startedAt: T0,
        }),
      ).id,
      'wf_other',
    );
    for (const patch of [{ workflowRunId: 9999 }, { workflowRunId: otherRun }, { transcriptFileId: 9999 }]) {
      expect(
        foreignKeyFailure(() => withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, patch, null))),
        JSON.stringify(patch),
      ).toBe(true);
    }
    expect(repo.byUid(CTX, session.id, 'a1b2c3d4e5')).toMatchObject({ workflowRunId: null, transcriptFileId: null });
    const run = addWorkflowRun(db, session.id, 'wf_one');
    const file = addFile(db, 'one');
    expect(
      withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { workflowRunId: run, transcriptFileId: file }, null)),
    ).toBe(true);
    // clearing a reference is not a reference
    expect(
      withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, id, { workflowRunId: null, transcriptFileId: null }, null)),
    ).toBe(true);
    // an agent that does not exist is still a plain `false`
    expect(withWriteTx(db, CTX, (tx) => repo.update(CTX, tx, 9999, { workflowRunId: run }, null))).toBe(false);
  });
});
