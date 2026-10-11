import { describe, expect, it } from 'vitest';

import { createChangeRecorder, MAX_CHANGE_IDS, type ChangeKind, type ChangeOp } from './changes.ts';
import { openSqlite, type SqlDriver } from './driver.ts';
import { DbError } from './errors.ts';
import { applyPendingMigrations, loadMigrationFiles } from './migrations.ts';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NONE = { entityId: null, sessionUid: null } as const;

interface ChangeRow {
  seq: number;
  at: number;
  kind: string;
  op: string;
  session_uid: string | null;
  entity_id: number | null;
  payload: string;
}

function database(): SqlDriver {
  const db = openSqlite(':memory:', { readonly: false, fileMustExist: false, timeoutMs: 1000 });
  applyPendingMigrations(db, loadMigrationFiles(), {
    runtimeVersion: '3.0.0',
    expectedInstanceId: INSTANCE_ID,
    now: () => 1_000,
  });
  return db;
}

function rows(db: SqlDriver): ChangeRow[] {
  return db
    .prepare<ChangeRow>('SELECT seq, at, kind, op, session_uid, entity_id, payload FROM changes ORDER BY seq')
    .all();
}

function failure(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

describe('ChangeRecorder.reserve (03 9.1)', () => {
  it('inserts one change row and returns its seq; seqs are contiguous from 1', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 5_000);
    const first = recorder.reserve('session', 'upsert', { entityId: 7, sessionUid: SESSION_A });
    const second = recorder.reserve('health', 'upsert', NONE);
    const third = recorder.reserve('session', 'delete', { entityId: null, sessionUid: SESSION_B });
    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(rows(db)).toEqual([
      { seq: 1, at: 5_000, kind: 'session', op: 'upsert', session_uid: SESSION_A, entity_id: 7, payload: '{}' },
      { seq: 2, at: 5_000, kind: 'health', op: 'upsert', session_uid: null, entity_id: null, payload: '{}' },
      { seq: 3, at: 5_000, kind: 'session', op: 'delete', session_uid: SESSION_B, entity_id: null, payload: '{}' },
    ]);
  });

  describe('coalescing: at most one row per (kind, op, key) per transaction', () => {
    // [label, kind, op, reservation A, same key as A, another key]
    const cases: readonly (readonly [
      string,
      ChangeKind,
      ChangeOp,
      { entityId: number | null; sessionUid: string | null },
      { entityId: number | null; sessionUid: string | null },
      { entityId: number | null; sessionUid: string | null },
    ])[] = [
      [
        'session',
        'session',
        'upsert',
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 2, sessionUid: SESSION_B },
      ],
      [
        'session delete',
        'session',
        'delete',
        { entityId: null, sessionUid: SESSION_A },
        { entityId: null, sessionUid: SESSION_A },
        { entityId: null, sessionUid: SESSION_B },
      ],
      [
        'agent',
        'agent',
        'upsert',
        { entityId: 5, sessionUid: SESSION_A },
        { entityId: 5, sessionUid: SESSION_A },
        { entityId: 6, sessionUid: SESSION_A },
      ],
      [
        'workflow',
        'workflow',
        'upsert',
        { entityId: 3, sessionUid: SESSION_A },
        { entityId: 3, sessionUid: SESSION_A },
        { entityId: 4, sessionUid: SESSION_A },
      ],
      [
        'tool call',
        'tool_call',
        'upsert',
        { entityId: null, sessionUid: SESSION_A },
        { entityId: null, sessionUid: SESSION_A },
        { entityId: null, sessionUid: SESSION_B },
      ],
      [
        'event',
        'event',
        'append',
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 2, sessionUid: SESSION_B },
      ],
      [
        'transcript',
        'transcript',
        'append',
        { entityId: 9, sessionUid: SESSION_A },
        { entityId: 9, sessionUid: SESSION_A },
        { entityId: 10, sessionUid: SESSION_A },
      ],
      [
        'work item',
        'work_item',
        'upsert',
        { entityId: 2, sessionUid: null },
        { entityId: 2, sessionUid: null },
        { entityId: 3, sessionUid: null },
      ],
      [
        'usage',
        'usage',
        'invalidate',
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 1, sessionUid: SESSION_A },
        { entityId: 2, sessionUid: SESSION_B },
      ],
      [
        'alert',
        'alert',
        'upsert',
        { entityId: 4, sessionUid: null },
        { entityId: 4, sessionUid: null },
        { entityId: 5, sessionUid: null },
      ],
    ];

    it.each(cases)('%s: the same key shares a row, another key gets its own', (_label, kind, op, a, same, other) => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const first = recorder.reserve(kind, op, a);
      expect(recorder.reserve(kind, op, same)).toBe(first);
      expect(recorder.reserve(kind, op, other)).not.toBe(first);
      expect(rows(db)).toHaveLength(2);
    });

    it.each([
      ['health', 'health'],
      ['attempt', 'attempt'],
    ] as const)('%s is one row per transaction for the whole instance', (_label, kind) => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const first = recorder.reserve(kind, 'upsert', NONE);
      expect(recorder.reserve(kind, 'upsert', NONE)).toBe(first);
      expect(rows(db)).toHaveLength(1);
    });

    it('keeps different kinds and different ops of the same entity apart', () => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const ref = { entityId: 1, sessionUid: SESSION_A };
      const seqs = [
        recorder.reserve('session', 'upsert', ref),
        recorder.reserve('session', 'delete', ref),
        recorder.reserve('event', 'append', ref),
        recorder.reserve('usage', 'invalidate', ref),
      ];
      expect(new Set(seqs).size).toBe(4);
    });

    it('DA-T-RT-7: one session touched 1,000 times and 1,000 events appended write exactly two change rows', () => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const ref = { entityId: 1, sessionUid: SESSION_A };
      for (let id = 1; id <= 1000; id += 1) {
        recorder.reserve('session', 'upsert', ref);
        recorder.noteId(recorder.reserve('event', 'append', ref), id);
      }
      recorder.flush();
      const all = rows(db);
      expect(all).toHaveLength(2);
      expect(all.map((row) => `${row.kind}/${row.op}`)).toEqual(['session/upsert', 'event/append']);
      expect(JSON.parse(all[1]?.payload ?? '')).toEqual({ from: 1, to: 1000, count: 1000 });
    });
  });

  it('refuses a kind/op pair the table does not allow, and writes no row', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const error = failure(() => recorder.reserve('attempt', 'delete', NONE));
    expect(error.code).toBe('db_constraint');
    expect(error.constraint).toBe('check');
    expect(rows(db)).toEqual([]);
  });

  it('accepts all twelve kind/op pairs of the registry', () => {
    const pairs: readonly (readonly [ChangeKind, ChangeOp])[] = [
      ['session', 'upsert'],
      ['session', 'delete'],
      ['agent', 'upsert'],
      ['workflow', 'upsert'],
      ['tool_call', 'upsert'],
      ['event', 'append'],
      ['transcript', 'append'],
      ['work_item', 'upsert'],
      ['usage', 'invalidate'],
      ['alert', 'upsert'],
      ['health', 'upsert'],
      ['attempt', 'upsert'],
    ];
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    for (const [kind, op] of pairs) recorder.reserve(kind, op, NONE);
    expect(rows(db).map((row) => `${row.kind}/${row.op}`)).toEqual(pairs.map(([kind, op]) => `${kind}/${op}`));
  });

  it('stamps the head: the seq it returns is the new head of sqlite_sequence', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('health', 'upsert', NONE);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get()).toEqual({ seq });
  });
});

describe('ChangeRecorder rollback (DA-I8, DA-T-RT-1)', () => {
  it('leaves no row and no gap when the transaction rolls back', () => {
    const db = database();
    db.transaction(() => {
      const recorder = createChangeRecorder(db, 1);
      recorder.reserve('health', 'upsert', NONE);
      recorder.reserve('attempt', 'upsert', NONE);
      recorder.flush();
    });
    expect(() =>
      db.transaction(() => {
        const recorder = createChangeRecorder(db, 2);
        recorder.reserve('session', 'upsert', { entityId: 1, sessionUid: SESSION_A });
        recorder.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_A });
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(rows(db).map((row) => row.seq)).toEqual([1, 2]);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get()).toEqual({ seq: 2 });
    db.transaction(() => {
      expect(createChangeRecorder(db, 3).reserve('health', 'upsert', NONE)).toBe(3);
    });
  });
});

describe('ChangeRecorder.noteId and flush: payloads (03 9.1 table)', () => {
  it('event/append: from, to and the number of distinct ids', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_A });
    for (const id of [40, 12, 40, 33, 12]) recorder.noteId(seq, id);
    recorder.flush();
    expect(JSON.parse(rows(db)[0]?.payload ?? '')).toEqual({ from: 12, to: 40, count: 3 });
  });

  it('event/append without a noted id: an empty range', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    recorder.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_A });
    recorder.flush();
    expect(JSON.parse(rows(db)[0]?.payload ?? '')).toEqual({ from: 0, to: 0, count: 0 });
  });

  it.each(['tool_call', 'attempt'] as const)(
    '%s/upsert: the distinct ids in first-seen order, not truncated',
    (kind) => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const seq = recorder.reserve(
        kind,
        'upsert',
        kind === 'attempt' ? NONE : { entityId: null, sessionUid: SESSION_A },
      );
      for (const id of [5, 3, 5, 9]) recorder.noteId(seq, id);
      recorder.flush();
      expect(JSON.parse(rows(db)[0]?.payload ?? '')).toEqual({ ids: [5, 3, 9], truncated: false });
    },
  );

  it.each(['tool_call', 'attempt'] as const)(
    '%s/upsert: more than 50 ids keep the first 50 and say truncated',
    (kind) => {
      const db = database();
      const recorder = createChangeRecorder(db, 1);
      const seq = recorder.reserve(
        kind,
        'upsert',
        kind === 'attempt' ? NONE : { entityId: null, sessionUid: SESSION_A },
      );
      for (let id = 1; id <= MAX_CHANGE_IDS + 7; id += 1) recorder.noteId(seq, id);
      recorder.flush();
      const payload = JSON.parse(rows(db)[0]?.payload ?? '') as { ids: number[]; truncated: boolean };
      expect(payload.ids).toEqual(Array.from({ length: MAX_CHANGE_IDS }, (_, index) => index + 1));
      expect(payload.truncated).toBe(true);
    },
  );

  it('exactly 50 ids are not truncated', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('tool_call', 'upsert', { entityId: null, sessionUid: SESSION_A });
    for (let id = 1; id <= MAX_CHANGE_IDS; id += 1) recorder.noteId(seq, id);
    recorder.flush();
    expect(JSON.parse(rows(db)[0]?.payload ?? '')).toMatchObject({ truncated: false });
  });

  it('an attempt change without ids (a reset or a detach) says truncated so clients refetch', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    recorder.reserve('attempt', 'upsert', NONE);
    recorder.flush();
    expect(JSON.parse(rows(db)[0]?.payload ?? '')).toEqual({ ids: [], truncated: true });
  });

  it('transcript/append: size, tail and agent of the last note', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('transcript', 'append', { entityId: 9, sessionUid: SESSION_A });
    recorder.noteTranscript(seq, { sizeBytes: 100, tailOffset: 90, agentUid: null });
    recorder.noteTranscript(seq, { sizeBytes: 250, tailOffset: 240, agentUid: 'abc123def456aa0' });
    recorder.flush();
    expect(JSON.parse(rows(db)[0]?.payload ?? '')).toEqual({ size: 250, tail: 240, agent: 'abc123def456aa0' });
  });

  it('every other kind keeps the empty payload', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    recorder.reserve('session', 'upsert', { entityId: 1, sessionUid: SESSION_A });
    recorder.reserve('agent', 'upsert', { entityId: 1, sessionUid: SESSION_A });
    recorder.reserve('usage', 'invalidate', { entityId: 1, sessionUid: SESSION_A });
    recorder.reserve('health', 'upsert', NONE);
    recorder.flush();
    expect(rows(db).map((row) => row.payload)).toEqual(['{}', '{}', '{}', '{}']);
  });

  it('keeps every payload within the 2048-byte CHECK, ids of 15 digits included', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('tool_call', 'upsert', { entityId: null, sessionUid: SESSION_A });
    for (let id = 0; id < 80; id += 1) recorder.noteId(seq, 900_000_000_000_000 + id);
    recorder.flush();
    const payload = rows(db)[0]?.payload ?? '';
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(2048);
  });

  it('refuses noteId on a seq this recorder did not reserve and on a kind that carries no ids', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    expect(() => {
      recorder.noteId(42, 1);
    }).toThrow(RangeError);
    const session = recorder.reserve('session', 'upsert', { entityId: 1, sessionUid: SESSION_A });
    expect(() => {
      recorder.noteId(session, 1);
    }).toThrow(/does not carry ids/);
  });

  it('refuses noteTranscript on anything but a transcript/append reservation', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_A });
    expect(() => {
      recorder.noteTranscript(seq, { sizeBytes: 1, tailOffset: 1, agentUid: null });
    }).toThrow(RangeError);
  });

  it('refuses any new reservation or note after flush, and flush itself is idempotent', () => {
    const db = database();
    const recorder = createChangeRecorder(db, 1);
    const seq = recorder.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_A });
    recorder.noteId(seq, 1);
    recorder.flush();
    recorder.flush();
    expect(() => recorder.reserve('health', 'upsert', NONE)).toThrow(/already flushed/);
    expect(() => {
      recorder.noteId(seq, 2);
    }).toThrow(/already flushed/);
    expect(rows(db)).toHaveLength(1);
  });
});
