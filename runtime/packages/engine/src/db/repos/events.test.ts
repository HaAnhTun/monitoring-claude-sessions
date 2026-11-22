import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { EventsRepo, type EventInsert } from './events.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const FOREIGN: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const T0 = FIXTURE_EPOCH_MS;

const opened: InstanceDb[] = [];
// registered after useTempDirs(): Vitest runs `afterEach` hooks in reverse order, so the files close before they are removed
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly repo: EventsRepo;
  readonly sessionId: number;
  readonly files: readonly number[];
}

/** An instance database with sessions S1 (main agent and one subagent) and S2, and three transcript files of S1. */
function fixture(): Fixture {
  const db = openInstanceDb({
    path: join(tempDir('events').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  const sessionId = seedSession(db, S1);
  seedSession(db, S2);
  db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', 1, 'subagent', 1, ?, ?, ?, ?)",
    )
    .run([sessionId, T0, T0, T0, T0]);
  const files = [1, 2, 3].map((n) => {
    const { lastInsertRowid } = db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?)",
      )
      .run([`f${String(n)}.jsonl`, `f${String(n)}.jsonl`, S1, T0, T0]);
    return lastInsertRowid;
  });
  return { db, repo: new EventsRepo(db), sessionId, files };
}

function seedSession(db: InstanceDb, uid: string): number {
  const { lastInsertRowid: id } = db.driver
    .prepare(
      'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run([uid, T0, T0, T0, T0]);
  db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
    )
    .run([id, T0, T0, T0, T0]);
  return id;
}

/** A hook row: `event_uid` set, hook columns, `ts_source` `hook_received`. */
function hookRow(n: number, over: Partial<EventInsert> = {}): EventInsert {
  return {
    sessionUid: S1,
    agentUid: 'main',
    kind: 'tool.call',
    entryKind: null,
    severity: 0,
    sources: 1,
    stamp: { at: T0 + n, rank: 40, tie: `h${String(n)}` },
    tsSource: 'hook_received',
    receivedAt: T0 + n,
    eventUid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    naturalKey: null,
    recordUuid: null,
    hookEvent: 'PreToolUse',
    contentHash: null,
    spoolSegment: 'hooks-20260101T00Z.ndjson',
    spoolOffset: n * 10,
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

/** A transcript row: `record_uuid` set, transcript columns, `ts_source` `record`. */
function recordRow(n: number, fileId: number, offset: number, over: Partial<EventInsert> = {}): EventInsert {
  return {
    ...hookRow(n),
    sources: 2,
    stamp: { at: T0 + n, rank: 20, tie: `t${String(n)}` },
    tsSource: 'record',
    eventUid: null,
    recordUuid: `rec-${String(n)}`,
    hookEvent: null,
    spoolSegment: null,
    spoolOffset: null,
    entryKind: 'tool',
    fileId,
    byteOffset: offset,
    byteLength: 120,
    lineNo: Math.floor(offset / 100),
    recordType: 'assistant',
    ...over,
  };
}

interface EventDbRow {
  id: number;
  session_id: number;
  agent_id: number | null;
  kind: string;
  entry_kind: string | null;
  severity: number;
  sources: number;
  ts: number;
  ts_rank: number;
  ts_tie: string;
  ts_source: string;
  received_at: number;
  event_uid: string | null;
  natural_key: string | null;
  record_uuid: string | null;
  hook_event: string | null;
  file_id: number | null;
  byte_offset: number | null;
  byte_length: number | null;
  line_no: number | null;
  summary: string | null;
  detail: string | null;
  flags: string;
  change_seq: number;
}

function events(db: InstanceDb): EventDbRow[] {
  return db.driver.prepare<EventDbRow>('SELECT * FROM events ORDER BY id').all();
}

function count(db: InstanceDb, table: string): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function changes(db: InstanceDb): { seq: number; kind: string; op: string; payload: string }[] {
  return db.driver
    .prepare<{ seq: number; kind: string; op: string; payload: string }>(
      'SELECT seq, kind, op, payload FROM changes ORDER BY seq',
    )
    .all();
}

function dbErrorOf(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

describe('EventsRepo.insert: a new row (03 3.6)', () => {
  it('stores every column of a hook row, resolves the session and the agent, and announces it as event/append', () => {
    const { db, repo, sessionId } = fixture();
    const row = hookRow(1, {
      agentUid: 'agent-a1b2c3',
      kind: 'tool.failure',
      severity: 2,
      naturalKey: 'tool.end:toolu_1',
      hookEvent: 'PostToolUseFailure',
      contentHash: 'c'.repeat(32),
      flags: ['truncated', 'redacted'],
      promptId: 'prompt-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      summary: 'ls -la',
      detail: { exit: 2, interrupted: false, note: null, tool: 'Bash' },
    });
    const result = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, row));
    expect(result).toEqual({ outcome: 'inserted', id: 1, seq: 1 });
    expect(events(db)).toEqual([
      {
        id: 1,
        session_id: sessionId,
        agent_id: 3,
        kind: 'tool.failure',
        entry_kind: null,
        severity: 2,
        sources: 1,
        ts: T0 + 1,
        ts_rank: 40,
        ts_tie: 'h1',
        ts_source: 'hook_received',
        received_at: T0 + 1,
        event_uid: '00000000-0000-4000-8000-000000000001',
        natural_key: 'tool.end:toolu_1',
        record_uuid: null,
        hook_event: 'PostToolUseFailure',
        content_hash: 'c'.repeat(32),
        spool_segment: 'hooks-20260101T00Z.ndjson',
        spool_offset: 10,
        flags: '["truncated","redacted"]',
        prompt_id: 'prompt-1',
        tool_use_id: 'toolu_1',
        tool_name: 'Bash',
        message_id: null,
        file_id: null,
        byte_offset: null,
        byte_length: null,
        line_no: null,
        record_type: null,
        subtype: null,
        text_len: null,
        summary: 'ls -la',
        detail: '{"exit":2,"interrupted":false,"note":null,"tool":"Bash"}',
        change_seq: 1,
      },
    ]);
    expect(changes(db)).toEqual([{ seq: 1, kind: 'event', op: 'append', payload: '{"from":1,"to":1,"count":1}' }]);
  });

  it('stores a transcript row with its file reference and a NULL agent for a session-level row', () => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, fileId, 300, { agentUid: null })));
    const [row] = events(db);
    expect(row).toMatchObject({
      agent_id: null,
      sources: 2,
      ts_source: 'record',
      record_uuid: 'rec-1',
      event_uid: null,
      file_id: fileId,
      byte_offset: 300,
      byte_length: 120,
      line_no: 3,
      entry_kind: 'tool',
    });
  });

  it('one announcement per transaction and session: 30 rows give one event/append that lists the range', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => {
      for (let n = 1; n <= 30; n += 1) repo.insert(CTX, tx, hookRow(n));
      repo.insert(CTX, tx, hookRow(31, { sessionUid: S2 }));
    });
    expect(changes(db)).toEqual([
      { seq: 1, kind: 'event', op: 'append', payload: '{"from":1,"to":30,"count":30}' },
      { seq: 2, kind: 'event', op: 'append', payload: '{"from":31,"to":31,"count":1}' },
    ]);
    expect(events(db).map((row) => row.change_seq)).toEqual([...Array<number>(30).fill(1), 2]);
  });

  it('a later transaction gets its own seq', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1)));
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(2)));
    expect(events(db).map((row) => row.change_seq)).toEqual([1, 2]);
  });
});

describe('EventsRepo.insert: idempotency (DA-T-DB-9, DA-I5)', () => {
  it('the same event_uid twice gives one row; the redelivery is a duplicate and writes no change row', () => {
    const { db, repo } = fixture();
    const first = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1)));
    const headBefore = db.headSeq();
    const second = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, { receivedAt: T0 + 999 })));
    expect(first.outcome).toBe('inserted');
    expect(second).toEqual({ outcome: 'duplicate', occurrence: false });
    expect(count(db, 'events')).toBe(1);
    expect(events(db)[0]?.received_at).toBe(T0 + 1);
    expect(db.headSeq()).toBe(headBefore);
    expect(changes(db)).toHaveLength(1);
  });

  it('a duplicate-only transaction publishes no phantom event/append', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1)));
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, hookRow(1));
      repo.insert(CTX, tx, hookRow(1));
    });
    expect(changes(db)).toHaveLength(1);
  });

  it('a transcript record read again at the same place is a duplicate without an occurrence row', () => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, fileId, 300)));
    const again = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, fileId, 300)));
    expect(again).toEqual({ outcome: 'duplicate', occurrence: false });
    expect(count(db, 'events')).toBe(1);
    expect(count(db, 'entry_occurrences')).toBe(0);
  });

  it('a resume copy (same record_uuid in another file) adds no event and records one entry occurrence', () => {
    const { db, repo, files } = fixture();
    const [f1, f3] = [files[0] ?? 0, files[2] ?? 0];
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, f1, 300)));
    const copy = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, f3, 40)));
    expect(copy).toEqual({ outcome: 'duplicate', occurrence: true });
    expect(count(db, 'events')).toBe(1);
    expect(db.driver.prepare('SELECT file_id, byte_offset, record_uuid FROM entry_occurrences').all()).toEqual([
      { file_id: f3, byte_offset: 40, record_uuid: 'rec-1' },
    ]);
    // reading the copy again changes nothing; a second copy at another offset of the same file is another occurrence
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, f3, 40)));
    expect(count(db, 'entry_occurrences')).toBe(1);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, recordRow(1, f3, 900)));
    expect(count(db, 'entry_occurrences')).toBe(2);
    expect(count(db, 'events')).toBe(1);
    expect(changes(db)).toHaveLength(1);
  });

  it('a resume copy of a tool_use record (same record_uuid and same natural key) is a duplicate, not a merge', () => {
    const { db, repo, files } = fixture();
    const [f1, f3] = [files[0] ?? 0, files[2] ?? 0];
    const original = recordRow(1, f1, 300, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1' });
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, original));
    const copy = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, { ...original, fileId: f3, byteOffset: 40, severity: 2, summary: 'copy' }),
    );
    expect(copy).toEqual({ outcome: 'duplicate', occurrence: true });
    expect(events(db)[0]).toMatchObject({ severity: 0, summary: null, file_id: f1, byte_offset: 300, sources: 2 });
    expect(count(db, 'entry_occurrences')).toBe(1);
  });

  it('a redelivered hook with the same event_uid and natural key is a duplicate, not a merge', () => {
    const { db, repo } = fixture();
    const original = hookRow(1, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1' });
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, original));
    const again = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, { ...original, summary: 'changed' }));
    expect(again).toEqual({ outcome: 'duplicate', occurrence: false });
    expect(events(db)[0]?.summary).toBeNull();
  });

  it('a row with none of event_uid, natural_key and record_uuid is refused by the schema (db_constraint check)', () => {
    const { db, repo } = fixture();
    const error = dbErrorOf(() => withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, { eventUid: null }))));
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(count(db, 'events')).toBe(0);
    expect(changes(db)).toEqual([]);
  });
});

describe('EventsRepo.insert: the cross-source merge by natural key (DA-T-DB-9)', () => {
  const KEY = 'tool.call:toolu_1';

  it('a transcript tool_use first, then the hook PreToolUse: one row, sources 3, event_uid adopted, record timestamp kept', () => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    const first = withWriteTx(db, CTX, (tx) =>
      repo.insert(
        CTX,
        tx,
        recordRow(1, fileId, 300, { naturalKey: KEY, toolUseId: 'toolu_1', summary: 'from transcript' }),
      ),
    );
    const second = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, hookRow(5, { naturalKey: KEY, toolUseId: 'toolu_1', toolName: 'Bash' })),
    );
    expect(first).toEqual({ outcome: 'inserted', id: 1, seq: 1 });
    expect(second).toEqual({ outcome: 'merged', id: 1 });
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0]).toMatchObject({
      sources: 3,
      kind: 'tool.call',
      ts: T0 + 1,
      ts_source: 'record',
      event_uid: '00000000-0000-4000-8000-000000000005',
      record_uuid: 'rec-1',
      hook_event: 'PreToolUse',
      file_id: fileId,
      byte_offset: 300,
      summary: 'from transcript',
      received_at: T0 + 1,
      change_seq: 1,
    });
    // a merge into an announced row is not announced again
    expect(changes(db)).toHaveLength(1);
  });

  it('the hook first, then the transcript record: the record time replaces the hook time and the file reference is adopted', () => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(5, { naturalKey: KEY, toolUseId: 'toolu_1' })));
    const merged = withWriteTx(db, CTX, (tx) =>
      repo.insert(
        CTX,
        tx,
        recordRow(1, fileId, 300, { naturalKey: KEY, toolUseId: 'toolu_1', summary: 'from transcript' }),
      ),
    );
    expect(merged).toEqual({ outcome: 'merged', id: 1 });
    expect(events(db)[0]).toMatchObject({
      sources: 3,
      ts: T0 + 1,
      ts_source: 'record',
      event_uid: '00000000-0000-4000-8000-000000000005',
      record_uuid: 'rec-1',
      hook_event: 'PreToolUse',
      file_id: fileId,
      byte_offset: 300,
      entry_kind: 'tool',
      received_at: T0 + 5, // the hook row's received_at is kept
      summary: 'from transcript',
    });
  });

  it('two hook rows without a record timestamp keep the earlier time', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(9, { naturalKey: KEY })));
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(4, { naturalKey: KEY })));
    expect(events(db)[0]).toMatchObject({ ts: T0 + 4, ts_source: 'hook_received', sources: 1 });
  });

  it.each([
    ['result then failure', 'tool.result', 'tool.failure'],
    ['failure then result', 'tool.failure', 'tool.result'],
  ] as const)('tool.failure wins over tool.result on merge (%s) and the severity is the maximum', (_label, a, b) => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    const severity = (kind: string): 0 | 2 => (kind === 'tool.failure' ? 2 : 0);
    const key = 'tool.end:toolu_1';
    withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, recordRow(1, fileId, 300, { naturalKey: key, kind: a, severity: severity(a) })),
    );
    withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, hookRow(2, { naturalKey: key, kind: b, severity: severity(b), hookEvent: 'PostToolUse' })),
    );
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0]).toMatchObject({ kind: 'tool.failure', severity: 2, sources: 3 });
  });

  it('a merge inside the transaction of the insert is a merge, and the change payload still counts one id', () => {
    const { db, repo, files } = fixture();
    const fileId = files[0] ?? 0;
    const results = withWriteTx(db, CTX, (tx) => [
      repo.insert(CTX, tx, recordRow(1, fileId, 300, { naturalKey: KEY })),
      repo.insert(CTX, tx, hookRow(2, { naturalKey: KEY })),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['inserted', 'merged']);
    expect(changes(db)).toEqual([{ seq: 1, kind: 'event', op: 'append', payload: '{"from":1,"to":1,"count":1}' }]);
  });

  // registry 5.4: the natural keys of `events`, each from a hook that is delivered twice with different event uids
  const REGISTRY_KEYS: readonly (readonly [EventInsert['kind'], string])[] = [
    ['tool.call', 'tool.call:toolu_1'],
    ['tool.result', 'tool.end:toolu_1'],
    ['prompt.submit', `prompt:${S1}:prompt-1`],
    ['permission.denied', 'permission.denied:toolu_1'],
    ['tool.batch', `tool.batch:${S1}:0123456789abcdef`],
    ['task.created', `task.created:${S1}:task-1`],
    ['task.completed', `task.completed:${S1}:task-1`],
    ['monitor.gap', 'recon:17'],
  ];

  it.each(REGISTRY_KEYS)('the natural key of a %s (%s) merges its deliveries into one row', (kind, key) => {
    const { db, repo } = fixture();
    const first = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, { kind, naturalKey: key })));
    const second = withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(2, { kind, naturalKey: key })));
    expect([first.outcome, second.outcome]).toEqual(['inserted', 'merged']);
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0]).toMatchObject({ natural_key: key, kind, event_uid: hookRow(1).eventUid });
  });

  it('rows with different natural keys never merge; the prompt key carries the session uid', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, hookRow(1, { naturalKey: `prompt:${S1}:p1`, kind: 'prompt.submit' }));
      repo.insert(CTX, tx, hookRow(2, { naturalKey: `prompt:${S2}:p1`, kind: 'prompt.submit', sessionUid: S2 }));
      repo.insert(CTX, tx, hookRow(3, { naturalKey: `prompt:${S1}:p2`, kind: 'prompt.submit' }));
    });
    expect(count(db, 'events')).toBe(3);
  });
});

describe('EventsRepo: references and scope', () => {
  const REFERENCE_CASES: readonly (readonly [string, Partial<EventInsert>])[] = [
    ['an unknown session', { sessionUid: 'cccccccc-0000-4000-8000-000000000003' }],
    ['an unknown agent', { agentUid: 'agent-zzzzzz' }],
    ['an unknown transcript file', { fileId: 999, byteOffset: 0, byteLength: 10 }],
  ];

  it.each(REFERENCE_CASES)('%s is a db_constraint (foreignkey) error and writes nothing', (_label, over) => {
    const { db, repo } = fixture();
    const error = dbErrorOf(() => withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, over))));
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'foreignkey' });
    expect(count(db, 'events')).toBe(0);
    expect(changes(db)).toEqual([]);
  });

  it('every public method asserts the scope before it touches a statement', () => {
    const { db, repo } = fixture();
    const content = { sessionUid: S1, hookEvent: 'Stop', contentHash: 'c'.repeat(32), receivedAt: T0, windowMs: 2000 };
    const calls: (() => unknown)[] = [
      () => withWriteTx(db, CTX, (tx) => repo.insert(FOREIGN, tx, hookRow(1))),
      () => repo.findByNaturalKey(FOREIGN, 'tool.call:x'),
      () => repo.findByContent(FOREIGN, content),
      () => repo.newestActivityAt(FOREIGN, 1),
      () => withWriteTx(db, CTX, (tx) => repo.deleteTranscriptOnly(FOREIGN, tx, 1)),
      () => withWriteTx(db, CTX, (tx) => repo.detachTranscript(FOREIGN, tx, 1)),
      () => withWriteTx(db, CTX, (tx) => repo.deleteOccurrences(FOREIGN, tx, 1)),
    ];
    for (const call of calls) expect(dbErrorOf(call).code).toBe('scope_mismatch');
    expect(count(db, 'events')).toBe(0);
  });
});

describe('EventsRepo.insert: bounded text columns (DA-T-PRIV-3)', () => {
  const LONG_CASES: readonly (readonly [string, Partial<EventInsert>])[] = [
    ['summary of 241 characters', { summary: 'x'.repeat(241) }],
    ['detail above 16 KiB', { detail: { text: 'x'.repeat(16_400) } }],
    ['flags above 1 KiB', { flags: ['f'.repeat(1100)] }],
    ['natural key of 301 characters', { naturalKey: 'k'.repeat(301) }],
  ];

  it.each(LONG_CASES)('refuses a %s with a CHECK violation and rolls the transaction back', (_label, over) => {
    const { db, repo } = fixture();
    const error = dbErrorOf(() => withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, over))));
    expect(error).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(count(db, 'events')).toBe(0);
    expect(changes(db)).toEqual([]);
  });

  it('accepts the values at the limits', () => {
    const { db, repo } = fixture();
    const result = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, hookRow(1, { summary: 'y'.repeat(240), detail: { text: 'z'.repeat(16_000) } })),
    );
    expect(result.outcome).toBe('inserted');
  });
});

describe('EventsRepo reads', () => {
  it('findByNaturalKey returns the id and the sources, or null', () => {
    const { db, repo } = fixture();
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(1, { naturalKey: 'tool.call:toolu_1' })));
    expect(repo.findByNaturalKey(CTX, 'tool.call:toolu_1')).toEqual({ id: 1, sources: 1 });
    expect(repo.findByNaturalKey(CTX, 'tool.call:toolu_2')).toBeNull();
  });

  it('findByContent finds a hook row of the same session, event and hash within the window only (D-3)', () => {
    const { db, repo } = fixture();
    const hash = 'a'.repeat(32);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, hookRow(1, { hookEvent: 'Notification', contentHash: hash, receivedAt: T0 + 10_000 }));
      repo.insert(CTX, tx, hookRow(2, { hookEvent: 'Notification', contentHash: hash, receivedAt: T0 + 50_000 }));
      repo.insert(CTX, tx, hookRow(3, { hookEvent: 'Stop', contentHash: hash, receivedAt: T0 + 10_000 }));
    });
    const query = { sessionUid: S1, hookEvent: 'Notification', contentHash: hash, windowMs: 2000 };
    expect(repo.findByContent(CTX, { ...query, receivedAt: T0 + 11_999 })).toEqual({ id: 1, sources: 1 });
    expect(repo.findByContent(CTX, { ...query, receivedAt: T0 + 12_000 })).toEqual({ id: 1, sources: 1 });
    expect(repo.findByContent(CTX, { ...query, receivedAt: T0 + 12_001 })).toBeNull();
    expect(repo.findByContent(CTX, { ...query, receivedAt: T0 + 8_000 })).toEqual({ id: 1, sources: 1 });
    expect(repo.findByContent(CTX, { ...query, receivedAt: T0 + 7_999 })).toBeNull();
    expect(repo.findByContent(CTX, { ...query, sessionUid: S2, receivedAt: T0 + 10_000 })).toBeNull();
    expect(repo.findByContent(CTX, { ...query, hookEvent: 'Stop', receivedAt: T0 + 50_000 })).toBeNull();
    expect(
      repo.findByContent(CTX, { ...query, sessionUid: 'cccccccc-0000-4000-8000-000000000003', receivedAt: T0 }),
    ).toBeNull();
  });

  it('the content window query stays on the partial index (03 3.7)', () => {
    const { db } = fixture();
    const plan = db.driver
      .prepare<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id, sources FROM events WHERE session_id = 1 AND hook_event = 'x' AND content_hash = 'y' AND received_at BETWEEN 1 AND 2 ORDER BY received_at LIMIT 1",
      )
      .all()
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('idx_events_content');
  });
});

describe('EventsRepo.newestActivityAt (CAW-147)', () => {
  it('is null for a session without a row', () => {
    const { repo, sessionId } = fixture();
    expect(repo.newestActivityAt(CTX, sessionId)).toBeNull();
  });

  it('is the newest time over the hook and the transcript rows of every agent of the session, whatever the order of arrival', () => {
    const { db, repo, sessionId, files } = fixture();
    const file = files[0] ?? 0;
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, recordRow(900, file, 0, { agentUid: 'agent-a1b2c3' }));
      repo.insert(CTX, tx, hookRow(700));
      repo.insert(CTX, tx, recordRow(100, file, 100, { agentUid: null }));
      // another session never counts
      repo.insert(CTX, tx, hookRow(5000, { sessionUid: S2 }));
    });
    expect(repo.newestActivityAt(CTX, sessionId)).toBe(T0 + 900);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(950)));
    expect(repo.newestActivityAt(CTX, sessionId)).toBe(T0 + 950);
  });

  it('skips a note of the monitor, also the newest row of the session', () => {
    const { db, repo, sessionId } = fixture();
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, hookRow(10)));
    db.driver
      .prepare(
        "INSERT INTO events (session_id, kind, severity, sources, ts, ts_source, received_at, natural_key) VALUES (?, 'monitor.gap', 1, 4, ?, 'derived', ?, 'recon:1')",
      )
      .run([sessionId, T0 + 99_000, T0 + 99_000]);
    expect(repo.newestActivityAt(CTX, sessionId)).toBe(T0 + 10);
  });

  it('reads the newest row through the index of the session timeline', () => {
    const { db } = fixture();
    const plan = db.driver
      .prepare<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT ts FROM events WHERE session_id = 1 AND (sources & 3) != 0 ORDER BY ts DESC, id DESC LIMIT 1',
      )
      .all()
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('idx_events_session_ts');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});

describe('EventsRepo.deleteTranscriptOnly, detachTranscript, deleteOccurrences (02 5.3 identity reset)', () => {
  function populated(): Fixture & { f1: number; f2: number } {
    const base = fixture();
    const [f1, f2] = [base.files[0] ?? 0, base.files[1] ?? 0];
    withWriteTx(base.db, CTX, (tx) => {
      // a transcript-only row of f1
      base.repo.insert(CTX, tx, recordRow(1, f1, 100));
      // a merged row: hook + transcript of f1
      base.repo.insert(CTX, tx, hookRow(2, { naturalKey: 'tool.call:toolu_2', toolUseId: 'toolu_2' }));
      base.repo.insert(CTX, tx, recordRow(3, f1, 200, { naturalKey: 'tool.call:toolu_2', toolUseId: 'toolu_2' }));
      // a hook-only row and a transcript-only row of another file
      base.repo.insert(CTX, tx, hookRow(4));
      base.repo.insert(CTX, tx, recordRow(5, f2, 100));
      // a resume copy of rec-5 in f1
      base.repo.insert(CTX, tx, recordRow(5, f1, 700));
    });
    return { ...base, f1, f2 };
  }

  it('deleteTranscriptOnly removes the transcript-only rows of the file and nothing else', () => {
    const { db, repo, f1 } = populated();
    const deleted = withWriteTx(db, CTX, (tx) => repo.deleteTranscriptOnly(CTX, tx, f1));
    expect(deleted).toBe(1);
    expect(
      events(db).map((row) => [row.record_uuid, row.event_uid !== null, row.sources, row.file_id !== null]),
    ).toEqual([
      ['rec-3', true, 3, true],
      [null, true, 1, false],
      ['rec-5', false, 2, true],
    ]);
  });

  it('detachTranscript turns a merged row back into a hook-only row and a later re-read merges it again', () => {
    const { db, repo, f1 } = populated();
    const detached = withWriteTx(db, CTX, (tx) => repo.detachTranscript(CTX, tx, f1));
    expect(detached).toBe(1);
    const merged = events(db).find((row) => row.natural_key === 'tool.call:toolu_2');
    expect(merged).toMatchObject({
      sources: 1,
      record_uuid: null,
      file_id: null,
      byte_offset: null,
      byte_length: null,
      line_no: null,
    });
    expect(merged?.event_uid).not.toBeNull();
    // the re-read of the same record merges into the hook row again (same natural key)
    const result = withWriteTx(db, CTX, (tx) =>
      repo.insert(CTX, tx, recordRow(3, f1, 200, { naturalKey: 'tool.call:toolu_2', toolUseId: 'toolu_2' })),
    );
    expect(result.outcome).toBe('merged');
    expect(events(db).find((row) => row.natural_key === 'tool.call:toolu_2')).toMatchObject({
      sources: 3,
      record_uuid: 'rec-3',
      file_id: f1,
      byte_offset: 200,
    });
  });

  it('deleteOccurrences removes the occurrence rows of the file only', () => {
    const { db, repo, f1, f2 } = populated();
    expect(db.driver.prepare('SELECT file_id FROM entry_occurrences').all()).toEqual([{ file_id: f1 }]);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteOccurrences(CTX, tx, f2))).toBe(0);
    expect(withWriteTx(db, CTX, (tx) => repo.deleteOccurrences(CTX, tx, f1))).toBe(1);
    expect(count(db, 'entry_occurrences')).toBe(0);
  });
});

/** mulberry32: a tiny seeded generator, so that a failing order reproduces from the printed seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe('EventsRepo.insert: order independence over 200 seeded orders (DA-T-DB-9, adversarial)', () => {
  const BASE_SEED = 20261011;
  const ORDERS = 200;

  /** Every delivery of the scenario; the merged result must not depend on the order, the batching, redeliveries or copies. */
  function deliveries(f1: number, f3: number): EventInsert[] {
    return [
      // a tool call: the transcript tool_use (f1), the hook PreToolUse, a resume copy of the record in f3, a hook redelivery
      recordRow(1, f1, 100, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1', summary: 'use 1' }),
      hookRow(2, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1' }),
      recordRow(1, f3, 40, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1', summary: 'use 1' }),
      hookRow(2, { naturalKey: 'tool.call:toolu_1', toolUseId: 'toolu_1' }),
      // its end: a transcript error result and a hook PostToolUse that says ok (the failure wins)
      recordRow(3, f1, 200, {
        naturalKey: 'tool.end:toolu_1',
        kind: 'tool.failure',
        severity: 2,
        entryKind: 'result',
        toolUseId: 'toolu_1',
      }),
      hookRow(4, {
        naturalKey: 'tool.end:toolu_1',
        kind: 'tool.result',
        hookEvent: 'PostToolUse',
        toolUseId: 'toolu_1',
      }),
      // a prompt from both sources, a transcript-only record (also read twice and copied) and a hook-only event
      hookRow(6, {
        naturalKey: `prompt:${S1}:p1`,
        kind: 'prompt.submit',
        hookEvent: 'UserPromptSubmit',
        promptId: 'p1',
      }),
      recordRow(7, f1, 300, {
        naturalKey: `prompt:${S1}:p1`,
        kind: 'prompt.submit',
        entryKind: 'prompt',
        promptId: 'p1',
      }),
      recordRow(8, f1, 400, { kind: 'assistant.message', entryKind: 'say' }),
      recordRow(8, f1, 400, { kind: 'assistant.message', entryKind: 'say' }),
      recordRow(8, f3, 60, { kind: 'assistant.message', entryKind: 'say' }),
      hookRow(9, { kind: 'turn.stop', hookEvent: 'Stop' }),
    ];
  }

  interface Snapshot {
    rows: unknown[];
    locations: unknown[];
  }

  function snapshot(db: InstanceDb): Snapshot {
    return {
      // Not compared: ts_rank and ts_tie keep the value of the first writer (03 3.6 statement, CR-WP-10-3), and the file
      // and offset of a record that exists in two files are those of the copy that was read first (first occurrence wins);
      // `locations` holds all of its places, which do not depend on the order.
      rows: db.driver
        .prepare(
          `SELECT natural_key, event_uid, record_uuid, kind, entry_kind, severity, sources, ts, ts_source, hook_event,
                  summary, prompt_id, tool_use_id
             FROM events ORDER BY coalesce(natural_key, record_uuid, event_uid)`,
        )
        .all(),
      locations: db.driver
        .prepare(
          `SELECT record_uuid, file_id, byte_offset FROM (
             SELECT record_uuid, file_id, byte_offset FROM events WHERE record_uuid IS NOT NULL
             UNION ALL SELECT record_uuid, file_id, byte_offset FROM entry_occurrences)
           ORDER BY record_uuid, file_id, byte_offset`,
        )
        .all(),
    };
  }

  it(`merges to one result in ${String(ORDERS)} shuffled orders and batchings (base seed ${String(BASE_SEED)})`, () => {
    const { db, repo, files } = fixture();
    const [f1, f3] = [files[0] ?? 0, files[2] ?? 0];
    const all = deliveries(f1, f3);
    let expected: Snapshot | undefined;
    for (let order = 0; order < ORDERS; order += 1) {
      const seed = BASE_SEED + order;
      const rand = prng(seed);
      db.driver.exec('DELETE FROM events; DELETE FROM entry_occurrences; DELETE FROM changes');
      const sequence = shuffled(all, rand);
      for (let at = 0; at < sequence.length;) {
        const batch = sequence.slice(at, at + 1 + Math.floor(rand() * 5));
        withWriteTx(db, CTX, (tx) => {
          for (const row of batch) repo.insert(CTX, tx, row);
        });
        at += batch.length;
      }
      const result = snapshot(db);
      expected ??= result;
      expect(result, `seed ${String(seed)}`).toEqual(expected);
      // every row is announced exactly once, whatever the batching
      const announced = db.driver
        .prepare<{ payload: string }>("SELECT payload FROM changes WHERE kind = 'event'")
        .all()
        .reduce((sum, row) => sum + (JSON.parse(row.payload) as { count: number }).count, 0);
      expect(announced, `seed ${String(seed)}`).toBe(result.rows.length);
    }
    // and the merged content is the specified one
    expect(expected?.rows).toEqual([
      {
        natural_key: null,
        event_uid: '00000000-0000-4000-8000-000000000009',
        record_uuid: null,
        kind: 'turn.stop',
        entry_kind: null,
        severity: 0,
        sources: 1,
        ts: T0 + 9,
        ts_source: 'hook_received',
        hook_event: 'Stop',
        summary: null,
        prompt_id: null,
        tool_use_id: null,
      },
      {
        natural_key: `prompt:${S1}:p1`,
        event_uid: '00000000-0000-4000-8000-000000000006',
        record_uuid: 'rec-7',
        kind: 'prompt.submit',
        entry_kind: 'prompt',
        severity: 0,
        sources: 3,
        ts: T0 + 7,
        ts_source: 'record',
        hook_event: 'UserPromptSubmit',
        summary: null,
        prompt_id: 'p1',
        tool_use_id: null,
      },
      {
        natural_key: null,
        event_uid: null,
        record_uuid: 'rec-8',
        kind: 'assistant.message',
        entry_kind: 'say',
        severity: 0,
        sources: 2,
        ts: T0 + 8,
        ts_source: 'record',
        hook_event: null,
        summary: null,
        prompt_id: null,
        tool_use_id: null,
      },
      {
        natural_key: 'tool.call:toolu_1',
        event_uid: '00000000-0000-4000-8000-000000000002',
        record_uuid: 'rec-1',
        kind: 'tool.call',
        entry_kind: 'tool',
        severity: 0,
        sources: 3,
        ts: T0 + 1,
        ts_source: 'record',
        hook_event: 'PreToolUse',
        summary: 'use 1',
        prompt_id: null,
        tool_use_id: 'toolu_1',
      },
      {
        natural_key: 'tool.end:toolu_1',
        event_uid: '00000000-0000-4000-8000-000000000004',
        record_uuid: 'rec-3',
        kind: 'tool.failure',
        entry_kind: 'result',
        severity: 2,
        sources: 3,
        ts: T0 + 3,
        ts_source: 'record',
        hook_event: 'PostToolUse',
        summary: null,
        prompt_id: null,
        tool_use_id: 'toolu_1',
      },
    ]);
    expect(expected?.locations).toEqual([
      { record_uuid: 'rec-1', file_id: f1, byte_offset: 100 },
      { record_uuid: 'rec-1', file_id: f3, byte_offset: 40 },
      { record_uuid: 'rec-3', file_id: f1, byte_offset: 200 },
      { record_uuid: 'rec-7', file_id: f1, byte_offset: 300 },
      { record_uuid: 'rec-8', file_id: f1, byte_offset: 400 },
      { record_uuid: 'rec-8', file_id: f3, byte_offset: 60 },
    ]);
  });
});
