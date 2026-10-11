import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  INSTANCE_KEY,
  createActivityThrottle,
  createChangeSink,
  type ChangeEntity,
  type ChangeSinkOp,
  type ReservedChange,
} from './change-sink.ts';
import { openInstanceDb, type InstanceDb } from './open.ts';
import { EventsRepo, type EventInsert } from './repos/events.ts';
import { onCommitted, withWriteTx } from './write.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const opened: InstanceDb[] = [];
// registered after useTempDirs(): Vitest runs `afterEach` hooks in reverse order, so the files close before they are removed
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(clock = new FakeClock(FIXTURE_EPOCH_MS)): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('change-sink').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  opened.push(db);
  return db;
}

function seedSession(db: InstanceDb, uid: string): number {
  const at = FIXTURE_EPOCH_MS;
  const { lastInsertRowid: id } = db.driver
    .prepare(
      'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run([uid, at, at, at, at]);
  db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
    )
    .run([id, at, at, at, at]);
  return id;
}

interface ChangeRow {
  seq: number;
  at: number;
  kind: string;
  op: string;
  session_uid: string | null;
  entity_id: number | null;
  payload: string;
}

function changeRows(db: InstanceDb): ChangeRow[] {
  return db.driver
    .prepare<ChangeRow>('SELECT seq, at, kind, op, session_uid, entity_id, payload FROM changes ORDER BY seq')
    .all();
}

function pairs(db: InstanceDb): string[] {
  return changeRows(db).map((row) => `${row.kind}/${row.op}`);
}

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected an error');
}

function eventRow(sessionUid: string, n: number, over: Partial<EventInsert> = {}): EventInsert {
  return {
    sessionUid,
    agentUid: 'main',
    kind: 'tool.call',
    entryKind: null,
    severity: 0,
    sources: 1,
    stamp: { at: FIXTURE_EPOCH_MS + n, rank: 10, tie: '' },
    tsSource: 'hook_received',
    receivedAt: FIXTURE_EPOCH_MS + n,
    eventUid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    naturalKey: null,
    recordUuid: null,
    hookEvent: 'PreToolUse',
    contentHash: null,
    spoolSegment: null,
    spoolOffset: null,
    flags: [],
    promptId: null,
    toolUseId: null,
    toolName: null,
    messageId: null,
    fileId: null,
    byteOffset: null,
    byteLength: null,
    lineNo: null,
    recordType: null,
    subtype: null,
    textLen: null,
    summary: null,
    detail: null,
    ...over,
  };
}

describe('createChangeSink: the entity mapping of 03 9.1 (DA-T-RT-11, C59)', () => {
  // [entity, key, op, expected kind/op]. The keys are the grammar documented in change-sink.ts.
  const MAPPING: readonly (readonly [ChangeEntity, string, ChangeSinkOp, string])[] = [
    ['session', SESSION_A, 'insert', 'session/upsert'],
    ['session', SESSION_A, 'update', 'session/upsert'],
    ['session', SESSION_A, 'delete', 'session/delete'],
    ['turn', SESSION_A, 'insert', 'session/upsert'],
    ['turn', SESSION_A, 'update', 'session/upsert'],
    ['agent', `7:${SESSION_A}`, 'insert', 'agent/upsert'],
    ['agent', `7:${SESSION_A}`, 'update', 'agent/upsert'],
    ['agent', `7:${SESSION_A}`, 'delete', 'agent/upsert'],
    ['workflow_run', `9:${SESSION_A}`, 'insert', 'workflow/upsert'],
    ['workflow_run', `9:${SESSION_A}`, 'update', 'workflow/upsert'],
    ['tool_call', SESSION_A, 'insert', 'tool_call/upsert'],
    ['tool_call', SESSION_A, 'update', 'tool_call/upsert'],
    ['event', SESSION_A, 'insert', 'event/append'],
    ['event', SESSION_A, 'update', 'event/append'],
    ['usage', SESSION_A, 'update', 'usage/invalidate'],
    ['usage', SESSION_A, 'insert', 'usage/invalidate'],
    ['ingest_health', INSTANCE_KEY, 'update', 'health/upsert'],
    ['reconciliation', SESSION_A, 'insert', 'event/append'],
    ['reconciliation', INSTANCE_KEY, 'insert', 'health/upsert'],
  ];

  it.each(MAPPING)('%s %s %s -> %s', (entity, key, op, expected) => {
    const db = openDb();
    withWriteTx(db, CTX, (tx) => {
      const seq = createChangeSink(tx).record(entity, key, op);
      expect(seq).toBe(1);
    });
    expect(pairs(db)).toEqual([expected]);
  });

  it('carries the session uid and the row id of the key into the change row', () => {
    const db = openDb();
    withWriteTx(db, CTX, (tx) => {
      const sink = createChangeSink(tx);
      sink.record('session', `41:${SESSION_A}`, 'update');
      sink.record('agent', `7:${SESSION_B}`, 'update');
      sink.record('tool_call', SESSION_A, 'update');
      sink.record('ingest_health', INSTANCE_KEY, 'update');
    });
    expect(changeRows(db).map((row) => [row.kind, row.session_uid, row.entity_id])).toEqual([
      ['session', SESSION_A, 41],
      ['agent', SESSION_B, 7],
      ['tool_call', SESSION_A, null],
      ['health', null, null],
    ]);
  });

  it('coalesces repeated records of one entity inside a transaction and keeps different entities apart', () => {
    const db = openDb();
    withWriteTx(db, CTX, (tx) => {
      const sink = createChangeSink(tx);
      const first = sink.record('session', SESSION_A, 'update');
      const again = sink.record('turn', SESSION_A, 'update'); // a turn is a session change
      const other = sink.record('session', SESSION_B, 'update');
      const agent1 = sink.record('agent', `7:${SESSION_A}`, 'update');
      const agent2 = sink.record('agent', `8:${SESSION_A}`, 'update');
      expect(again).toBe(first);
      expect(other).not.toBe(first);
      expect(agent1).not.toBe(agent2);
    });
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert', 'agent/upsert', 'agent/upsert']);
  });

  it('joins a reservation made by a repository for the same entity (one row, one seq)', () => {
    const db = openDb();
    withWriteTx(db, CTX, (tx) => {
      const direct = tx.changes.reserve('session', 'upsert', { entityId: 41, sessionUid: SESSION_A });
      expect(createChangeSink(tx).record('session', SESSION_A, 'update')).toBe(direct);
      expect(createChangeSink(tx).record('session', `41:${SESSION_A}`, 'update')).toBe(direct);
    });
    expect(changeRows(db)).toHaveLength(1);
  });

  it.each([
    ['session', 'not-a-uid'],
    ['session', ''],
    ['session', `x:${SESSION_A}`],
    ['session', `-1:${SESSION_A}`],
    ['session', SESSION_A.toUpperCase()],
    ['agent', SESSION_A], // an agent change needs the row id
    ['workflow_run', SESSION_A],
    ['ingest_health', SESSION_A], // instance level
    ['tool_call', INSTANCE_KEY], // session level
  ] as const)('refuses the key %s %j with a RangeError and reserves nothing', (entity, key) => {
    const db = openDb();
    withWriteTx(db, CTX, (tx) => {
      expect(failure(() => createChangeSink(tx).record(entity, key, 'update'))).toBeInstanceOf(RangeError);
    });
    expect(changeRows(db)).toEqual([]);
  });

  it('flush() and discard() are no-ops: publication is the job of onCommitted, a ROLLBACK removes the rows', () => {
    const db = openDb();
    const heads: number[] = [];
    onCommitted(db, (head) => heads.push(head));
    withWriteTx(db, CTX, (tx) => {
      const sink = createChangeSink(tx);
      sink.record('session', SESSION_A, 'update');
      sink.flush();
      sink.discard();
      sink.record('session', SESSION_B, 'update');
    });
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert']);
    expect(heads).toEqual([2]);
  });

  it('persist before publish: a throw after record() leaves no row, no gap and no publication', () => {
    const db = openDb();
    const heads: number[] = [];
    onCommitted(db, (head) => heads.push(head));
    const boom = new Error('boom');
    expect(
      failure(() =>
        withWriteTx(db, CTX, (tx) => {
          createChangeSink(tx).record('session', SESSION_A, 'update');
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(changeRows(db)).toEqual([]);
    expect(db.headSeq()).toBe(0);
    expect(heads).toEqual([]);
    withWriteTx(db, CTX, (tx) => createChangeSink(tx).record('session', SESSION_A, 'update'));
    expect(changeRows(db).map((row) => row.seq)).toEqual([1]);
  });
});

describe('coalescing (DA-T-RT-7)', () => {
  it('one transaction touching one session 1,000 times and appending 1,000 events writes exactly 2 change rows', () => {
    const db = openDb();
    seedSession(db, SESSION_A);
    const events = new EventsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      const sink = createChangeSink(tx);
      for (let n = 1; n <= 1000; n += 1) {
        sink.record('session', SESSION_A, 'update');
        const result = events.insert(CTX, tx, eventRow(SESSION_A, n));
        expect(result.outcome).toBe('inserted');
        sink.record('event', SESSION_A, 'insert');
      }
    });
    const rows = changeRows(db);
    expect(rows.map((row) => `${row.kind}/${row.op}`)).toEqual(['session/upsert', 'event/append']);
    const append = rows[1];
    const payload: unknown = JSON.parse(append?.payload ?? '{}');
    expect(payload).toEqual({ from: 1, to: 1000, count: 1000 });
  });
});

describe('createActivityThrottle: activity-only updates at most once per second (DA-T-RT-11, 03 3.6)', () => {
  it('announces the first update at once and defers the others of the same second', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const seqs: (number | null)[] = [];
    for (let i = 0; i < 10; i += 1) {
      withWriteTx(db, CTX, (tx) => {
        seqs.push(createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update'));
      });
      clock.advance(50);
    }
    expect(seqs).toEqual([1, null, null, null, null, null, null, null, null, null]);
    expect(pairs(db)).toEqual(['session/upsert']);
    expect(throttle.nextDueAt()).toBe(FIXTURE_EPOCH_MS + 1000);
  });

  it('flush(tx) reserves the deferred change once the second has passed, and not before', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', `41:${SESSION_A}`, 'update'));
    clock.advance(400);
    withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', `41:${SESSION_A}`, 'update'));
    clock.advance(500); // 900 ms after the announcement
    expect(withWriteTx(db, CTX, (tx) => throttle.flush(tx))).toEqual([]);
    expect(changeRows(db)).toHaveLength(1);
    clock.advance(100); // exactly 1000 ms
    const flushed = withWriteTx(db, CTX, (tx) => throttle.flush(tx));
    expect(flushed.map(({ entity, key }) => [entity, key])).toEqual([['session', `41:${SESSION_A}`]]);
    expect(flushed[0]?.seq).toBe(2);
    const rows = changeRows(db);
    expect(rows.map((row) => [row.kind, row.op, row.session_uid, row.entity_id, row.at])).toEqual([
      ['session', 'upsert', SESSION_A, 41, FIXTURE_EPOCH_MS],
      ['session', 'upsert', SESSION_A, 41, FIXTURE_EPOCH_MS + 1000],
    ]);
    expect(throttle.nextDueAt()).toBeNull();
    // nothing is left to flush
    expect(withWriteTx(db, CTX, (tx) => throttle.flush(tx))).toEqual([]);
  });

  it('a turn and a session update share one window; agents and sessions have their own', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const record = (entity: ChangeEntity, key: string): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record(entity, key, 'update'));
    expect(record('session', SESSION_A)).not.toBeNull();
    expect(record('turn', SESSION_A)).toBeNull();
    expect(record('session', SESSION_B)).not.toBeNull();
    expect(record('agent', `7:${SESSION_A}`)).not.toBeNull();
    expect(record('agent', `7:${SESSION_A}`)).toBeNull();
    expect(record('agent', `8:${SESSION_A}`)).not.toBeNull();
    expect(record('ingest_health', INSTANCE_KEY)).not.toBeNull();
    expect(record('ingest_health', INSTANCE_KEY)).toBeNull();
  });

  it('view changes are immediate: they are not deferred and restart the window of the entity', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update'));
    clock.advance(100);
    // writeView of WP-11 reserves session/upsert itself, without the throttle, and says so
    withWriteTx(db, CTX, (tx) => {
      const seq = tx.changes.reserve('session', 'upsert', { entityId: 41, sessionUid: SESSION_A });
      throttle.announced('session', `41:${SESSION_A}`, tx.now);
      expect(seq).toBe(2);
    });
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert']);
    clock.advance(900); // 1000 ms after the first, 900 ms after the view change
    expect(
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update')),
    ).toBeNull();
    clock.advance(100);
    expect(withWriteTx(db, CTX, (tx) => throttle.flush(tx)).map((c) => c.key)).toEqual([SESSION_A]);
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert', 'session/upsert']);
  });

  it('an insert and a delete are immediate and are never held back by the window', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const record = (op: ChangeSinkOp): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, op));
    expect(record('update')).not.toBeNull();
    expect(record('insert')).not.toBeNull();
    expect(record('delete')).not.toBeNull();
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert', 'session/delete']);
  });

  it('a deferred change is superseded by an immediate announcement of the same entity', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const record = (op: ChangeSinkOp): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, op));
    record('update');
    record('update'); // deferred
    expect(throttle.nextDueAt()).not.toBeNull();
    record('insert'); // immediate: the pending one is no longer needed
    expect(throttle.nextDueAt()).toBeNull();
  });

  it('survives a rolled-back transaction: the deferred update is still announced by the next flush', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    expect(
      failure(() =>
        withWriteTx(db, CTX, (tx) => {
          createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update');
          throw new Error('rolled back');
        }),
      ).message,
    ).toBe('rolled back');
    expect(changeRows(db)).toEqual([]);
    clock.advance(10);
    // the retry of the batch records again; the throttle remembers the rolled-back admission and defers
    expect(
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update')),
    ).toBeNull();
    clock.advance(1000);
    expect(withWriteTx(db, CTX, (tx) => throttle.flush(tx))).toHaveLength(1);
    expect(pairs(db)).toEqual(['session/upsert']);
  });

  it('restore() puts the changes of a failed flush back: the next flush announces them', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const record = (): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', `41:${SESSION_A}`, 'update'));
    record();
    record(); // deferred
    clock.advance(1000);
    let reserved: ReservedChange[] = [];
    expect(
      failure(() =>
        withWriteTx(db, CTX, (tx) => {
          reserved = throttle.flush(tx);
          throw new Error('busy');
        }),
      ).message,
    ).toBe('busy');
    expect(reserved).toHaveLength(1);
    expect(changeRows(db)).toHaveLength(1); // the flush was rolled back with its transaction
    expect(throttle.nextDueAt()).toBeNull(); // and the throttle believes it announced the change
    throttle.restore(reserved);
    expect(throttle.nextDueAt()).not.toBeNull();
    expect(withWriteTx(db, CTX, (tx) => throttle.flush(tx)).map((c) => c.key)).toEqual([`41:${SESSION_A}`]);
    expect(pairs(db)).toEqual(['session/upsert', 'session/upsert']);
  });

  it('treats a clock that moved backwards as an elapsed window instead of stalling', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS + 10_000);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    const record = (): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update'));
    expect(record()).not.toBeNull();
    clock.set(FIXTURE_EPOCH_MS);
    expect(record()).not.toBeNull();
  });

  it('honours a custom interval and rejects an invalid one', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle({ intervalMs: 250 });
    const record = (): number | null =>
      withWriteTx(db, CTX, (tx) => createChangeSink(tx, { throttle }).record('session', SESSION_A, 'update'));
    expect(record()).not.toBeNull();
    clock.advance(249);
    expect(record()).toBeNull();
    clock.advance(1);
    expect(record()).not.toBeNull();
    expect(() => createActivityThrottle({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => createActivityThrottle({ intervalMs: Number.NaN })).toThrow(RangeError);
  });

  it('keeps its memory bounded when many entities are touched once each', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = openDb(clock);
    const throttle = createActivityThrottle();
    for (let batch = 0; batch < 3; batch += 1) {
      withWriteTx(db, CTX, (tx) => {
        const sink = createChangeSink(tx, { throttle });
        for (let i = 1; i <= 4000; i += 1) sink.record('agent', `${String(batch * 4000 + i)}:${SESSION_A}`, 'update');
      });
      clock.advance(1500);
    }
    expect(throttle.trackedCount()).toBeLessThanOrEqual(8192);
  });
});
