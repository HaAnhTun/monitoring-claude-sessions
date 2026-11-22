// The ingestion writer over a real database (02 4.6-4.8): persist before publish, idempotent delivery, backpressure, poison
// isolation, out-of-order input. T-PL-02, 04, 05, 06, 07, 08, 09 at the writer level; the spool path is in the drainer tests
// and `test/hook-to-db.int.test.ts`.
import { join } from 'node:path';

import { summarizeToolInput, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { CostStatesRepo } from '../db/repos/cost-states.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../db/repos/spool-cursors.ts';
import { TranscriptFilesRepo, type TranscriptFileKind } from '../db/repos/transcript-files.ts';
import { UsageRepo, type UsageValues } from '../db/repos/usage.ts';
import { onCommitted, withWriteTx } from '../db/write.ts';
import { changeCounts, dumpDatabase, duplicatesSeen, readCounters } from '../../test/fixtures/spool.ts';
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_SESSION_ID,
  PROMPT_ID,
  SEQUENCE_START,
  SUBAGENT_ID,
  TOOL_BASH,
  hashOf,
  labSequence,
  shuffled,
  uidOf,
} from '../../test/fixtures/hook-sequences.ts';
import { fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import { INSTANCE_KEY, createActivityThrottle } from '../db/change-sink.ts';
import { LOG_FIELD_NAMES, type Logger } from '../log/logger.ts';
import { eventRow } from './event-row.ts';
import {
  createIngestWriter,
  envelopeItem,
  usageItems,
  USAGE_ROWS_PER_ITEM,
  type IngestBatch,
  type IngestItem,
  type IngestWriterHandle,
  type IngestWriterOptions,
} from './writer.ts';

const tempDir = useTempDirs();
const CTX = { instanceId: FIXTURE_INSTANCE_ID };
const SEG = 'hooks-20260102T03Z.ndjson';
const NOW = SEQUENCE_START + 10 * 60_000;
const SECOND_SESSION = '77777777-7777-4777-8777-777777777777';

interface Rig {
  readonly db: InstanceDb;
  readonly path: string;
  readonly clock: FakeClock;
  readonly writer: IngestWriterHandle;
}

const dbs: InstanceDb[] = [];
const writers: IngestWriterHandle[] = [];
afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.close();
  for (const db of dbs.splice(0)) db.close();
});

function rig(options: Partial<IngestWriterOptions> = {}): Rig {
  const path = join(tempDir('writer').path, 'monitor.db');
  const clock = new FakeClock(NOW);
  const db = openInstanceDb({
    path,
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const writer = createIngestWriter({
    db,
    scope: CTX,
    retryBaseMs: 1,
    retryMaxMs: 2,
    sleep: () => Promise.resolve(),
    ...options,
  });
  writers.push(writer);
  return { db, path, clock, writer };
}

function batchOf(envelopes: readonly HookEnvelopeV1[], cursor?: NewSpoolCursor): IngestBatch {
  const items: IngestItem[] = envelopes.map((env, index) => envelopeItem(env, { segment: SEG, offset: index * 100 }));
  return {
    source: 'spool',
    items,
    bytes: envelopes.length * 100,
    ...(cursor === undefined ? {} : { cursor: { kind: 'spool', segment: SEG, cursor } }),
  };
}

function cursor(offsetBytes: number, lines: number): NewSpoolCursor {
  return {
    segment: SEG,
    offsetBytes,
    sizeSeen: offsetBytes,
    ino: null,
    headHash: null,
    lines,
    partialBytes: 0,
    sealed: false,
    errors: 0,
    oldestReceivedAt: null,
    newestReceivedAt: null,
    drainedAt: null,
  };
}

async function ingest(r: Rig, envelopes: readonly HookEnvelopeV1[]): Promise<void> {
  expect(r.writer.submit(batchOf(envelopes))).toBe(true);
  await r.writer.flushNow();
}

function count(db: InstanceDb, table: string): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

describe('IngestWriter: the hook path to the rows', () => {
  it('turns the 27 envelopes of the lab sequence into one session with its entities', async () => {
    const r = rig();
    await ingest(r, labSequence());
    const dump = dumpDatabase(r.db);
    expect(dump['sessions']).toHaveLength(1);
    expect(dump['events']).toHaveLength(27);
    // main + the subagent
    expect(dump['agents']?.map((a) => [a['agent_uid'], a['kind']])).toEqual([
      ['a1b2c3d4e5f6a7b8c', 'subagent'],
      ['main', 'main'],
    ]);
    expect(dump['tool_calls']?.map((t) => [t['tool_use_id'], t['name'], t['outcome']])).toEqual([
      ['toolu_seq_agent_002', 'Agent', 'ok'],
      ['toolu_seq_bash_001', 'Bash', 'ok'],
      ['toolu_seq_denied_004', 'Bash', 'denied'],
      ['toolu_seq_failed_005', 'Bash', 'error'],
      ['toolu_seq_read_003', 'Read', 'ok'],
    ]);
    // the call that PostToolBatch lists keeps the batch time and the hook_batch source bit
    const bash = dump['tool_calls']?.find((t) => t['tool_use_id'] === TOOL_BASH);
    expect(bash?.['batch_at']).not.toBeNull();
    expect((Number(bash?.['sources']) & 16) !== 0).toBe(true);
    expect(dump['turns']).toHaveLength(1);
    expect(dump['sessions']?.[0]).toMatchObject({
      session_uid: FIXTURE_SESSION_ID,
      presence: 'ended',
      event_count: 27,
    });
  });

  it('counts the envelopes, the errors and the warnings of the session', async () => {
    const r = rig();
    await ingest(r, labSequence());
    const row = r.db.driver
      .prepare<{ error_count: number; warning_count: number }>('SELECT error_count, warning_count FROM sessions')
      .get();
    // PostToolUseFailure + StopFailure are severity 2; PermissionDenied is severity 1
    expect(row).toEqual({ error_count: 2, warning_count: 1 });
  });

  it('records the probe and creates no session for it', async () => {
    const r = rig();
    const probe = fixtureEnvelope('Notification', {
      top: { kind: 'probe', session_id: '00000000-0000-4000-8000-000000000001' },
      data: { notification_type: 'mcs_probe' },
    });
    await ingest(r, [probe]);
    expect(count(r.db, 'sessions')).toBe(0);
    expect(count(r.db, 'events')).toBe(0);
    expect(dumpDatabase(r.db)['hook_probes']).toEqual([
      { probe_session_id: '00000000-0000-4000-8000-000000000001', received_at: probe.received_at },
    ]);
  });
});

describe('persist before publish (T-PL-05)', () => {
  it('publishes only after COMMIT: every head a listener sees is visible to a second connection', async () => {
    const r = rig();
    const reader = openInstanceDb({
      path: r.path,
      expectedInstanceId: FIXTURE_INSTANCE_ID,
      mode: 'readonly',
      runtimeVersion: '3.0.0',
      clock: r.clock,
    });
    dbs.push(reader);
    const seen: { head: number; events: number; readerHead: number }[] = [];
    onCommitted(r.db, (head) => {
      seen.push({ head, events: count(reader, 'events'), readerHead: reader.headSeq() });
    });
    await ingest(r, labSequence().slice(0, 6));
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) {
      expect(entry.readerHead).toBe(entry.head);
      expect(entry.events).toBe(6);
    }
  });

  it('a throw after the writes publishes nothing, keeps the head and the facts, and the retry commits once', async () => {
    let failures = 1;
    const r = rig({
      beforeCommit: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('injected');
        }
      },
    });
    const published: number[] = [];
    onCommitted(r.db, (head) => published.push(head));
    const headBefore = r.db.headSeq();
    expect(r.writer.submit(batchOf(labSequence().slice(0, 4), cursor(400, 4)))).toBe(true);
    await r.writer.flushNow();
    expect(r.writer.stats.failures).toBe(1);
    expect(r.writer.stats.lastError?.code).toBe('Error');
    // one publication, for the retry, and nothing was left behind by the failed attempt
    expect(published).toHaveLength(1);
    expect(published[0]).toBeGreaterThan(headBefore);
    expect(count(r.db, 'events')).toBe(4);
    expect(count(r.db, 'sessions')).toBe(1);
  });

  it('a failed attempt leaves the database as it was (no head, no rows, no cursor)', async () => {
    const r = rig({
      beforeCommit: () => {
        throw new Error('injected');
      },
      retryBaseMs: 1,
    });
    const published: number[] = [];
    onCommitted(r.db, (head) => published.push(head));
    r.writer.submit(batchOf(labSequence().slice(0, 1), cursor(100, 1)));
    // the writer keeps failing, splits down to the single item, drops it by reference and advances the cursor
    await r.writer.flushNow();
    expect(count(r.db, 'events')).toBe(0);
    expect(count(r.db, 'sessions')).toBe(0);
    // the only commit is the one that records the dropped item (PERSIST_FAILED) and its cursor
    expect(dumpDatabase(r.db)['ingest_errors']).toEqual([{ code: 'PERSIST_FAILED', n: 1 }]);
  });

  it('moves the spool cursor in the same transaction as the rows', async () => {
    let attempts = 0;
    const r = rig({
      beforeCommit: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('injected');
      },
    });
    r.writer.submit(batchOf(labSequence().slice(0, 3), cursor(300, 3)));
    await r.writer.flushNow();
    const rows = new SpoolCursorsRepo(r.db).list(CTX);
    expect(rows.map((row) => [row.segment, row.offsetBytes, row.lines])).toEqual([[SEG, 300, 3]]);
    expect(count(r.db, 'events')).toBe(3);
  });
});

describe('idempotent delivery (T-PL-02, D-1 to D-3)', () => {
  it('delivering the same batch twice gives the same database and counts the duplicates', async () => {
    const once = rig();
    await ingest(once, labSequence());
    const twice = rig();
    await ingest(twice, labSequence());
    const changesBefore = changeCounts(twice.db);
    await ingest(twice, labSequence());
    expect(dumpDatabase(twice.db)).toEqual(dumpDatabase(once.db));
    // nothing that a client shows changed again: no new session, agent, tool call or event change
    const after = changeCounts(twice.db);
    for (const kind of ['session', 'agent', 'tool_call', 'event']) {
      expect(after[kind] ?? 0).toBe(changesBefore[kind] ?? 0);
    }
    expect(readCounters(twice.db).envelopes).toBe(54);
    expect(duplicatesSeen(twice.db)).toBe(27);
  });

  it('a duplicate registration 30 ms later is one row, 3 s later two rows (D-3)', async () => {
    const r = rig();
    const base = { top: { content_hash: 'ab'.repeat(16) } };
    const first = fixtureEnvelope('Notification', {
      ...base,
      eventUid: '00000000-0000-4000-8000-0000000000a1',
      receivedAt: SEQUENCE_START,
    });
    const near = fixtureEnvelope('Notification', {
      ...base,
      eventUid: '00000000-0000-4000-8000-0000000000a2',
      receivedAt: SEQUENCE_START + 30,
    });
    await ingest(r, [first, near]);
    expect(count(r.db, 'events')).toBe(1);
    const far = fixtureEnvelope('Notification', {
      ...base,
      eventUid: '00000000-0000-4000-8000-0000000000a3',
      receivedAt: SEQUENCE_START + 3000,
    });
    await ingest(r, [far]);
    expect(count(r.db, 'events')).toBe(2);
  });

  it('the same tool call from two registrations is one row however far apart (D-2)', async () => {
    const r = rig();
    const pre = (uid: string, at: number, hash: string): HookEnvelopeV1 =>
      fixtureEnvelope('PreToolUse', {
        eventUid: uid,
        receivedAt: at,
        top: { content_hash: hash, tool_use_id: TOOL_BASH, prompt_id: '33333333-3333-4333-8333-333333333333' },
        data: { tool_name: 'Bash' },
      });
    await ingest(r, [
      pre('00000000-0000-4000-8000-0000000000b1', SEQUENCE_START, 'a1'.repeat(16)),
      pre('00000000-0000-4000-8000-0000000000b2', SEQUENCE_START + 3_600_000, 'b2'.repeat(16)),
    ]);
    expect(count(r.db, 'events')).toBe(1);
    expect(count(r.db, 'tool_calls')).toBe(1);
  });
});

describe('backpressure (T-PL-06)', () => {
  it('refuses a batch when the queue is full and takes it after onDrain; memory stays bounded', async () => {
    const r = rig({ queueMaxItems: 10, queueMaxBytes: 10_000 });
    const sequence = labSequence();
    let next = 0;
    let maxQueued = 0;
    let maxBytes = 0;
    let refusals = 0;
    const pump = (): void => {
      while (next < sequence.length) {
        const env = sequence[next];
        if (env === undefined) return;
        const ok = r.writer.submit(batchOf([env]));
        maxQueued = Math.max(maxQueued, r.writer.stats.queued);
        maxBytes = Math.max(maxBytes, r.writer.stats.queuedBytes);
        if (!ok) {
          refusals += 1;
          return;
        }
        next += 1;
      }
    };
    r.writer.onDrain(pump);
    pump();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (next >= sequence.length) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    await r.writer.flushNow();
    expect(refusals).toBeGreaterThan(0);
    expect(maxQueued).toBeLessThanOrEqual(10);
    expect(maxBytes).toBeLessThanOrEqual(10_000);
    expect(count(r.db, 'events')).toBe(27);
  });

  it('accepts one batch larger than the whole queue when the queue is empty (no deadlock)', async () => {
    const r = rig({ queueMaxItems: 3 });
    expect(r.writer.submit(batchOf(labSequence().slice(0, 8)))).toBe(true);
    await r.writer.flushNow();
    expect(count(r.db, 'events')).toBe(8);
  });
});

describe('malformed input (T-PL-07) and poison items (T-PL-08)', () => {
  it('stores ingest errors by reference and counts them by code, between valid lines', async () => {
    const r = rig();
    const [a, b] = labSequence().slice(0, 2);
    if (a === undefined || b === undefined) throw new Error('fixture');
    const errors: IngestItem[] = [
      {
        kind: 'envelope',
        events: [],
        rows: [
          { t: 'error', error: { code: 'SPOOL_LINE_INVALID_JSON', source: 'spool', segment: SEG, byteOffset: 7 } },
        ],
      },
      {
        kind: 'envelope',
        events: [],
        rows: [{ t: 'error', error: { code: 'ENVELOPE_SCHEMA', source: 'spool', segment: SEG, detail: 'session_id' } }],
      },
      {
        kind: 'envelope',
        events: [],
        rows: [{ t: 'error', error: { code: 'ENVELOPE_SCHEMA', source: 'spool', segment: SEG } }],
      },
    ];
    r.writer.submit({ source: 'spool', items: [envelopeItem(a), ...errors, envelopeItem(b)], bytes: 500 });
    await r.writer.flushNow();
    expect(count(r.db, 'events')).toBe(2);
    expect(dumpDatabase(r.db)['ingest_errors']).toEqual([
      { code: 'ENVELOPE_SCHEMA', n: 2 },
      { code: 'SPOOL_LINE_INVALID_JSON', n: 1 },
    ]);
    expect(readCounters(r.db)).toMatchObject({
      envelopes: 2,
      errors: { ENVELOPE_SCHEMA: 2, SPOOL_LINE_INVALID_JSON: 1 },
    });
  });

  it('isolates an item that cannot be stored: the others commit, PERSIST_FAILED once, the cursor advances', async () => {
    const r = rig();
    const sequence = labSequence();
    const items: IngestItem[] = sequence.slice(0, 5).map((env) => envelopeItem(env));
    const target = items[2];
    if (target === undefined || target.rows[0]?.t !== 'event') throw new Error('fixture');
    // a row that refers to a transcript file that does not exist violates a constraint
    const poisoned: IngestItem = {
      ...target,
      rows: [{ t: 'event', row: eventRow({ ...target.rows[0].row, fileId: 999_999 }) }],
    };
    items[2] = poisoned;
    r.writer.submit({
      source: 'spool',
      items,
      bytes: 500,
      cursor: { kind: 'spool', segment: SEG, cursor: cursor(500, 5) },
    });
    await r.writer.flushNow();
    expect(count(r.db, 'events')).toBe(4);
    expect(dumpDatabase(r.db)['ingest_errors']).toEqual([{ code: 'PERSIST_FAILED', n: 1 }]);
    expect(new SpoolCursorsRepo(r.db).get(CTX, SEG)?.offsetBytes).toBe(500);
    expect(r.writer.stats.failures).toBeGreaterThan(0);
  });

  it('stores a tool call whose summary carries the clip marker: the row keeps its first 160 code points (CAW-146)', async () => {
    const r = rig();
    // what the handler sends for an input line of 394 code points: 160 of them and the marker of 02 2.5.1
    const summary = summarizeToolInput({ command: `echo ${'fixture-word '.repeat(30)}`.trimEnd() });
    expect(Array.from(summary).length).toBeGreaterThan(160);
    await ingest(r, [
      fixtureEnvelope('PreToolUse', {
        top: { tool_use_id: TOOL_BASH, prompt_id: PROMPT_ID },
        data: { tool_name: 'Bash', tool_summary: summary, tool_input_hash: 'a'.repeat(32) },
      }),
    ]);
    expect(r.db.driver.prepare<{ summary: string | null }>('SELECT summary FROM tool_calls').all()).toEqual([
      { summary: Array.from(summary).slice(0, 160).join('') },
    ]);
    expect(count(r.db, 'events')).toBe(1);
    expect(dumpDatabase(r.db)['ingest_errors']).toEqual([]);
    expect(r.writer.stats.failures).toBe(0);
  });

  it('says which table, constraint and item failed, and keeps the reference of the line (CAW-146)', async () => {
    const logged: { event: string; fields: unknown }[] = [];
    const log = (event: string, fields?: unknown): void => {
      logged.push({ event, fields });
    };
    const r = rig({
      logger: {
        debug: log,
        info: log,
        warn: log,
        error: log,
        stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
        close: () => Promise.resolve(),
      },
    });
    const fileId = registerFile(r.db, 'main', FIXTURE_SESSION_ID);
    const record = (offset: number, summary: string): IngestItem => {
      const stamp = { at: NOW - 5000 + offset, rank: 20, tie: `t:${String(offset)}` };
      const row = eventRow({
        sessionUid: FIXTURE_SESSION_ID,
        agentUid: 'main',
        kind: 'tool.call',
        entryKind: 'tool',
        sources: 2,
        stamp,
        tsSource: 'record',
        receivedAt: NOW,
        recordUuid: `f${String(fileId)}:${String(offset)}`,
        fileId,
        byteOffset: offset,
        byteLength: 100,
        lineNo: 1 + offset / 100,
        recordType: 'assistant',
      });
      return {
        kind: 'record',
        events: [{ k: 'activity', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp, via: 'assistant' }],
        // the summary goes around the builder, which would have cut it to the column
        rows: [{ t: 'event', row: { ...row, summary } }],
      };
    };
    r.writer.submit({
      source: 'transcript',
      items: [
        seenItem(FIXTURE_SESSION_ID, fileId),
        record(100, 'ok'),
        record(200, 'x'.repeat(300)),
        record(300, 'ok'),
        record(400, 'ok'),
      ],
      bytes: 1000,
      cursor: { kind: 'transcript', fileId, cursor: { tailOffset: 500, sizeSeen: 500 } },
    });
    await r.writer.flushNow();
    expect(count(r.db, 'events')).toBe(3);
    expect(tailOffsetOf(r.db, fileId)).toBe(500);
    // the last failure is the one of the single item that is then dropped
    expect(logged.filter((line) => line.event === 'ingest_commit_failed').at(-1)?.fields).toEqual({
      code: 'db_constraint',
      status: 'SQLITE_CONSTRAINT_CHECK',
      phase: 'events/summary_IS_NULL_OR_length_summary_240',
      kind: 'transcript/record/activity',
      count: 1,
    });
    // the first is the whole batch
    expect(logged.find((line) => line.event === 'ingest_commit_failed')?.fields).toMatchObject({
      code: 'db_constraint',
      kind: 'transcript',
      count: 5,
    });
    expect(
      r.db.driver
        .prepare('SELECT code, source, file_id, byte_offset, session_uid, segment, detail FROM ingest_errors')
        .all(),
    ).toEqual([
      {
        code: 'PERSIST_FAILED',
        source: 'writer',
        file_id: fileId,
        byte_offset: 200,
        session_uid: FIXTURE_SESSION_ID,
        segment: null,
        detail:
          'item could not be stored (db_constraint check; events; summary IS NULL OR length(summary) <= 240; transcript record: activity)',
      },
    ]);
  });

  it('keeps the segment of a dropped spool item after the batch was split (CAW-146)', async () => {
    const r = rig();
    const items: IngestItem[] = labSequence()
      .slice(0, 5)
      .map((env) => envelopeItem(env));
    const target = items[1];
    if (target === undefined || target.rows[0]?.t !== 'event') throw new Error('fixture');
    // the second of five items: the split puts it into a half that carries no cursor
    items[1] = { ...target, rows: [{ t: 'event', row: eventRow({ ...target.rows[0].row, fileId: 999_999 }) }] };
    r.writer.submit({
      source: 'spool',
      items,
      bytes: 500,
      cursor: { kind: 'spool', segment: SEG, cursor: cursor(500, 5) },
    });
    await r.writer.flushNow();
    expect(
      r.db.driver.prepare('SELECT code, file_id, byte_offset, session_uid, segment, detail FROM ingest_errors').all(),
    ).toEqual([
      {
        code: 'PERSIST_FAILED',
        file_id: null,
        byte_offset: null,
        session_uid: FIXTURE_SESSION_ID,
        segment: SEG,
        detail: expect.stringMatching(
          /^item could not be stored \(db_constraint foreignkey; the transcript file does not exist; spool envelope: /,
        ) as unknown,
      },
    ]);
  });
});

// ---- what a failed commit says, for every kind of constraint, and that it says no value (CAW-146) ---------------------------

describe('the names of a failed commit (CAW-146)', () => {
  /** A value the failing statement is given: it must never reach the log line or the record. */
  const SECRET = 'secret-value-0123456789';
  const SAFE_STRING = /^[\w.:/@-]{0,128}$/;
  const PROJECT = 'INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, ?, ?)';

  interface Line {
    readonly event: string;
    readonly fields: Record<string, unknown>;
  }

  function capturing(lines: Line[]): Logger {
    const log = (event: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ event, fields });
    };
    return {
      debug: log,
      info: log,
      warn: log,
      error: log,
      stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
      close: () => Promise.resolve(),
    };
  }

  // [kind, the statement that fails inside the transaction, status, phase, the middle of the detail]
  const cases: readonly (readonly [string, (db: InstanceDb) => void, string, string, string])[] = [
    [
      'unique',
      (db) => {
        db.driver.prepare(PROJECT).run([SECRET, SECRET, 1, 1]);
        db.driver.prepare(PROJECT).run([SECRET, SECRET, 1, 1]);
      },
      'SQLITE_CONSTRAINT_UNIQUE',
      'projects/projects.project_key',
      'db_constraint unique; projects; projects.project_key',
    ],
    [
      'check',
      (db) => {
        db.driver.prepare(PROJECT).run([SECRET.toUpperCase(), SECRET, 1, 1]);
      },
      'SQLITE_CONSTRAINT_CHECK',
      'projects/length_project_key_BETWEEN_1_AND_255_AND_project_key_lower_project_key',
      'db_constraint check; projects; length(project_key) BETWEEN 1 AND 255 AND project_key = lower(project_key)',
    ],
    [
      'notnull',
      (db) => {
        db.driver.prepare(PROJECT).run([SECRET, null, 1, 1]);
      },
      'SQLITE_CONSTRAINT_NOTNULL',
      'projects/projects.dir_name',
      'db_constraint notnull; projects; projects.dir_name',
    ],
    [
      'datatype',
      (db) => {
        db.driver.prepare(PROJECT).run([SECRET, SECRET, SECRET, 1]);
      },
      'SQLITE_CONSTRAINT_DATATYPE',
      'projects/projects.first_seen_at',
      'db_constraint datatype; projects; projects.first_seen_at',
    ],
    [
      'foreignkey',
      (db) => {
        db.driver
          .prepare(
            `INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at,
               last_activity_at, updated_at) VALUES (424242, ?, 1, 'subagent', 1, 1, 1, 1, 1)`,
          )
          .run([SECRET]);
      },
      'SQLITE_CONSTRAINT_FOREIGNKEY',
      'agents',
      'db_constraint foreignkey; agents',
    ],
  ];

  for (const [kind, fail, status, phase, middle] of cases) {
    it(`names the table and the ${kind} constraint, and no value of the statement`, async () => {
      const lines: Line[] = [];
      let db: InstanceDb | null = null;
      const r = rig({
        logger: capturing(lines),
        beforeCommit: () => {
          if (db !== null) fail(db);
        },
      });
      db = r.db;
      const [first] = labSequence();
      if (first === undefined) throw new Error('fixture');
      const kinds = [...new Set(envelopeItem(first).events.map((event) => event.k))].join(':') || 'none';
      await ingest(r, [first]);

      const failures = lines.filter((line) => line.event === 'ingest_commit_failed');
      // three attempts of the one item, then it is dropped
      expect(failures).toHaveLength(3);
      expect(r.writer.stats.failures).toBe(3);
      for (const line of failures) {
        expect(line.fields).toEqual({
          code: 'db_constraint',
          status,
          phase,
          kind: `spool/envelope/${kinds}`,
          count: 1,
        });
        for (const [name, value] of Object.entries(line.fields)) {
          expect(LOG_FIELD_NAMES, name).toContain(name);
          if (typeof value === 'string') expect(value, name).toMatch(SAFE_STRING);
        }
      }
      const records = r.db.driver.prepare<{ code: string; detail: string }>('SELECT * FROM ingest_errors').all();
      expect(records).toHaveLength(1);
      const detail = records[0]?.detail ?? '';
      expect(detail.startsWith(`item could not be stored (${middle}; spool envelope`)).toBe(true);
      expect(Array.from(detail).length).toBeLessThanOrEqual(200);
      // nothing of the statement's value in what leaves the writer
      const said = JSON.stringify([lines, records, r.writer.stats]).toLowerCase();
      expect(said).not.toContain(SECRET);
      expect(count(r.db, 'events')).toBe(0);
      expect(count(r.db, 'projects')).toBe(0);
    });
  }

  it('says only the class of an error that is not from the database, never its message', async () => {
    const lines: Line[] = [];
    const r = rig({
      logger: capturing(lines),
      beforeCommit: () => {
        throw new TypeError(`cannot read ${SECRET}`);
      },
    });
    const [first] = labSequence();
    if (first === undefined) throw new Error('fixture');
    await ingest(r, [first]);
    const records = r.db.driver.prepare<{ detail: string }>('SELECT * FROM ingest_errors').all();
    expect(records.map((row) => row.detail)).toEqual([
      expect.stringMatching(/^item could not be stored \(TypeError; spool envelope/) as unknown,
    ]);
    expect(lines.at(-1)?.fields).toMatchObject({ code: 'TypeError', count: 1 });
    expect(lines.at(-1)?.fields).not.toHaveProperty('phase');
    expect(JSON.stringify([lines, records, r.writer.stats])).not.toContain(SECRET);
  });

  it('cuts a detail to the 200 code points of the column, whatever the item holds', async () => {
    const r = rig({
      beforeCommit: () => {
        r.db.driver.prepare(PROJECT).run([SECRET.toUpperCase(), SECRET, 1, 1]);
      },
    });
    const stamp = { at: NOW - 1000, rank: 20, tie: 't:long' };
    // more kinds of events than a detail has room for
    const item: IngestItem = {
      kind: 'record',
      events: [
        { k: 'session.seen', sessionId: FIXTURE_SESSION_ID, stamp, transcriptPath: '/transcripts/long.jsonl' },
        { k: 'activity', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp, via: 'assistant' },
        { k: 'assistant.ok', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp },
        { k: 'interrupt', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp, via: 'aborted_mid_stream' },
        { k: 'api_error', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp },
        { k: 'external.pid', sessionId: FIXTURE_SESSION_ID, pid: 4242, alive: true, checkedAt: NOW },
        { k: 'external.job', sessionId: FIXTURE_SESSION_ID, jobId: 'job', state: 'running', observedAt: NOW },
      ],
      rows: [],
    };
    r.writer.submit({ source: 'transcript', items: [item], bytes: 100 });
    await r.writer.flushNow();
    const details = r.db.driver
      .prepare<{ detail: string }>('SELECT detail FROM ingest_errors')
      .all()
      .map((row) => row.detail);
    expect(details).toHaveLength(1);
    expect(Array.from(details[0] ?? '')).toHaveLength(200);
    expect(details[0]).toContain('db_constraint check; projects; length(project_key) BETWEEN 1 AND 255');
  });
});

describe('a poison item of a producer without a cursor (CAW-146)', () => {
  const POISON_PID = 666;
  const observation = (pid: number): IngestItem => ({
    kind: 'external',
    events: [
      {
        k: 'external.registry',
        sessionId: FIXTURE_SESSION_ID,
        status: 'busy',
        pid,
        pidAlive: true,
        observedAt: NOW,
      },
    ],
    rows: [],
  });
  const poisoned = (batches: readonly IngestBatch[]): boolean =>
    batches.some((b) =>
      b.items.some((item) => item.events.some((e) => e.k === 'external.registry' && e.pid === POISON_PID)),
    );

  it('is recorded once per submission, the items beside it commit, and the writer keeps nothing to try again', async () => {
    let commits = 0;
    const r = rig({
      beforeCommit: (_tx, batches) => {
        commits += 1;
        if (poisoned(batches)) throw new Error('injected failure before COMMIT');
      },
    });
    await ingest(r, labSequence().slice(0, 1));
    const sessionsBefore = count(r.db, 'sessions');
    const failed = (): number => readCounters(r.db).persistFailed;

    // one poll of a producer without a cursor: a storable item and one that can never be stored
    expect(
      r.writer.submit({ source: 'external', items: [observation(4242), observation(POISON_PID)], bytes: 200 }),
    ).toBe(true);
    await r.writer.flushNow();
    expect(failed()).toBe(1);
    expect(r.writer.stats.queued).toBe(0);
    expect(count(r.db, 'sessions')).toBe(sessionsBefore);
    expect(
      r.db.driver.prepare('SELECT code, source, file_id, segment, session_uid, detail FROM ingest_errors').all(),
    ).toEqual([
      {
        code: 'PERSIST_FAILED',
        source: 'writer',
        file_id: null,
        segment: null,
        session_uid: FIXTURE_SESSION_ID,
        detail: 'item could not be stored (Error; external external: external.registry)',
      },
    ]);
    // the batch of two: three attempts, then each half once; nothing is left that would be tried again
    const failuresAfterFirst = r.writer.stats.failures;
    expect(failuresAfterFirst).toBe(4);
    const commitsAfterFirst = commits;
    await r.writer.flushNow();
    expect(commits).toBe(commitsAfterFirst);
    expect(r.writer.stats.failures).toBe(failuresAfterFirst);

    // work that comes later is not held up by the dropped item
    r.writer.submit({ source: 'external', items: [observation(4243)], bytes: 100 });
    await r.writer.flushNow();
    expect(failed()).toBe(1);
    expect(r.writer.stats.failures).toBe(failuresAfterFirst);

    // the producer hands the same observation over again (its next report): one more record, not a loop
    r.writer.submit({ source: 'external', items: [observation(POISON_PID)], bytes: 100 });
    await r.writer.flushNow();
    expect(failed()).toBe(2);
    expect(r.writer.stats.failures).toBe(failuresAfterFirst + 3);
    expect(r.writer.stats.queued).toBe(0);
  });
});

describe('out-of-order input (T-PL-09)', () => {
  it('any order of arrival gives the same facts and views (25 seeded shuffles, one batch each)', async () => {
    const reference = rig();
    await ingest(reference, labSequence());
    const expected = dumpDatabase(reference.db);
    for (let seed = 1; seed <= 25; seed += 1) {
      const r = rig();
      await ingest(r, shuffled(labSequence(), seed));
      expect(dumpDatabase(r.db), `seed ${String(seed)}`).toEqual(expected);
    }
  });

  it('arriving one transaction at a time, in shuffled order, gives the same result too', async () => {
    const reference = rig();
    await ingest(reference, labSequence());
    const expected = dumpDatabase(reference.db);
    for (const seed of [3, 11, 17]) {
      const r = rig();
      for (const env of shuffled(labSequence(), seed)) await ingest(r, [env]);
      expect(dumpDatabase(r.db), `seed ${String(seed)}`).toEqual(expected);
    }
  });
});

describe('external evidence and the first-seen time (ADR 0069 item 5)', () => {
  it('an external.job event older than the first record of the session does not lower sessions.started_at', async () => {
    const r = rig();
    await ingest(r, labSequence());
    const startedAt = (): number | undefined =>
      r.db.driver
        .prepare<{ at: number }>('SELECT started_at AS at FROM sessions WHERE session_uid = :uid')
        .get({ uid: FIXTURE_SESSION_ID })?.at;
    const before = startedAt();
    expect(before).toBeLessThanOrEqual(SEQUENCE_START + 60_000);
    const jobAt = SEQUENCE_START - 6 * 86_400_000;
    const batch: IngestBatch = {
      source: 'external',
      items: [
        {
          kind: 'external',
          events: [
            { k: 'external.job', sessionId: FIXTURE_SESSION_ID, jobId: 'job-1', state: 'done', observedAt: jobAt },
          ],
          rows: [],
        },
      ],
      bytes: 100,
    };
    expect(r.writer.submit(batch)).toBe(true);
    await r.writer.flushNow();
    expect(startedAt()).toBe(before);
  });
});

describe('the facts cache', () => {
  it('rebuilds the facts of a session that left the cache from its rows (cache of one session, two interleaved)', async () => {
    const other = (): HookEnvelopeV1[] =>
      labSequence({ sessionId: SECOND_SESSION, firstNumber: 100, startAt: SEQUENCE_START + 500 }).map((env) => ({
        ...env,
        agent_id: env.agent_id === null ? null : 'b1b2b3b4b5b6b7b8b',
      }));
    const mixed: HookEnvelopeV1[] = [];
    const a = labSequence();
    const b = other();
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x !== undefined) mixed.push(x);
      if (y !== undefined) mixed.push(y);
    }
    const small = rig({ factsCacheSize: 1 });
    const large = rig({ factsCacheSize: 100 });
    for (const env of mixed) {
      await ingest(small, [env]);
      await ingest(large, [env]);
    }
    expect(dumpDatabase(small.db)).toEqual(dumpDatabase(large.db));
    expect(dumpDatabase(small.db)['sessions']).toHaveLength(2);
  });
});

describe('the facts cache after a failed transaction', () => {
  it('keeps the committed facts: a dropped SessionEnd leaves no trace in what later batches write', async () => {
    const sequence = labSequence();
    const ending = sequence.at(-1);
    if (ending?.event !== 'SessionEnd') throw new Error('fixture');
    const first = sequence.slice(0, 6);
    const later = sequence.slice(6, 12);

    const reference = rig();
    await ingest(reference, first);
    await ingest(reference, later);

    const r = rig({
      beforeCommit: (_tx, batches) => {
        const hit = batches.some((batch) =>
          batch.items.some((item) =>
            item.rows.some((row) => row.t === 'event' && row.row.eventUid === ending.event_uid),
          ),
        );
        if (hit) throw new Error('injected');
      },
    });
    await ingest(r, first);
    await ingest(r, [ending]); // fails every attempt, is split down to the one item and dropped by reference
    await ingest(r, later);

    const mine = dumpDatabase(r.db);
    const theirs = dumpDatabase(reference.db);
    expect(mine['ingest_errors']).toEqual([{ code: 'PERSIST_FAILED', n: 1 }]);
    for (const table of ['sessions', 'agents', 'tool_calls', 'turns', 'events']) {
      expect(mine[table], table).toEqual(theirs[table]);
    }
  });
});

describe('exclusive jobs and shutdown', () => {
  it('runs a job after the batches submitted before it and never inside a writer transaction', async () => {
    const r = rig();
    const order: string[] = [];
    onCommitted(r.db, () => order.push('commit'));
    r.writer.submit(batchOf(labSequence().slice(0, 3)));
    const result = r.writer.runExclusive(() => {
      order.push('job');
      // a transaction of the job's own is legal exactly because no writer transaction is open
      return withWriteTx(r.db, CTX, () => 'opened');
    });
    r.writer.submit(batchOf(labSequence().slice(3, 5)));
    await expect(result).resolves.toBe('opened');
    await r.writer.flushNow();
    expect(order).toEqual(['commit', 'job', 'commit', 'commit']);
    expect(count(r.db, 'events')).toBe(5);
  });

  it('refuses work after close and drops what was queued', async () => {
    const r = rig();
    await r.writer.close();
    expect(() => r.writer.submit(batchOf(labSequence().slice(0, 1)))).toThrow();
    await expect(r.writer.runExclusive(() => 1)).rejects.toThrow();
  });
});

describe('hook coverage (02 8.1)', () => {
  const transcriptCall = (id: string, at: number): IngestItem => ({
    kind: 'record',
    events: [
      {
        k: 'tool.start',
        sessionId: FIXTURE_SESSION_ID,
        agentId: null,
        promptId: null,
        toolUseId: id,
        name: 'Bash',
        stamp: { at, rank: 20, tie: id },
      },
    ],
    rows: [],
  });

  function sessionCoverage(db: InstanceDb): unknown {
    return db.driver.prepare('SELECT hook_coverage, hook_missing_tools, hook_missing_turns FROM sessions').get();
  }

  it('is none without envelopes and full once hooks cover everything the transcript shows', async () => {
    const r = rig();
    r.writer.submit({ source: 'transcript', items: [transcriptCall('toolu_tx_0', SEQUENCE_START)], bytes: 10 });
    await r.writer.flushNow();
    expect(sessionCoverage(r.db)).toEqual({ hook_coverage: 'none', hook_missing_tools: 0, hook_missing_turns: 0 });
    await ingest(r, labSequence().slice(0, 1));
    expect(sessionCoverage(r.db)).toEqual({ hook_coverage: 'full', hook_missing_tools: 0, hook_missing_turns: 0 });
  });

  it('counts a transcript call without a hook after the first envelope as partial, once, with a hook_gap record', async () => {
    const r = rig();
    await ingest(r, labSequence().slice(0, 1));
    r.writer.submit({
      source: 'transcript',
      items: [transcriptCall('toolu_tx_1', SEQUENCE_START + 20_000)],
      bytes: 10,
    });
    await r.writer.flushNow();
    expect(sessionCoverage(r.db)).toEqual({ hook_coverage: 'partial', hook_missing_tools: 1, hook_missing_turns: 0 });
    expect(dumpDatabase(r.db)['reconciliations']).toHaveLength(1);
    expect(dumpDatabase(r.db)['reconciliations']?.[0]).toMatchObject({ kind: 'hook_gap' });
    // the same call arrives again: still one gap record
    r.writer.submit({
      source: 'transcript',
      items: [transcriptCall('toolu_tx_1', SEQUENCE_START + 20_000)],
      bytes: 10,
    });
    await r.writer.flushNow();
    expect(dumpDatabase(r.db)['reconciliations']).toHaveLength(1);
  });

  it('a call that a hook saw too is covered, and a call younger than 10 s is not counted yet', async () => {
    const r = rig();
    const pre = fixtureEnvelope('PreToolUse', {
      eventUid: '00000000-0000-4000-8000-0000000000e1',
      receivedAt: SEQUENCE_START + 20_000,
      top: { tool_use_id: 'toolu_tx_2', content_hash: 'e1'.repeat(16) },
      data: { tool_name: 'Bash' },
    });
    await ingest(r, [...labSequence().slice(0, 1), pre]);
    r.writer.submit({
      source: 'transcript',
      items: [transcriptCall('toolu_tx_2', SEQUENCE_START + 20_000), transcriptCall('toolu_tx_3', NOW - 2_000)],
      bytes: 10,
    });
    await r.writer.flushNow();
    expect(sessionCoverage(r.db)).toEqual({ hook_coverage: 'full', hook_missing_tools: 0, hook_missing_turns: 0 });
  });
});

describe('instance level records', () => {
  it('stores a reconciliation once however often it is delivered', async () => {
    const r = rig();
    const item: IngestItem = {
      kind: 'envelope',
      events: [],
      rows: [
        {
          t: 'reconciliation',
          kind: 'runtime_unavailable',
          sessionUid: null,
          at: NOW,
          detail: { from: NOW - 600_000, to: NOW, envelopes: 3 },
        },
      ],
    };
    r.writer.submit({ source: 'spool', items: [item], bytes: 10 });
    r.writer.submit({ source: 'spool', items: [item], bytes: 10 });
    await r.writer.flushNow();
    expect(dumpDatabase(r.db)['reconciliations']).toHaveLength(1);
    expect(INSTANCE_KEY).toBe('instance');
  });
});

// ---- token usage in the cursor transaction (WP-98, ADR 0015, 02 5.3) ----------------------------------------------------------

const AGENT_UID = 'a0123456789abcdef';

function registerFile(db: InstanceDb, name: string, sessionUid: string, kind: TranscriptFileKind = 'session'): number {
  return withWriteTx(db, CTX, (tx) =>
    new TranscriptFilesRepo(db).register(CTX, tx, {
      path: `/transcripts/${name}.jsonl`,
      pathKey: `/transcripts/${name}.jsonl`,
      kind,
      sessionUid,
      agentUid: kind === 'subagent' ? AGENT_UID : null,
      runUid: null,
      sessionId: null,
      agentId: null,
      workflowRunId: null,
      birthMs: null,
      firstSeenMtimeMs: null,
      mtimeSeen: null,
    }),
  ).id;
}

function usageValues(input: number, output: number): UsageValues {
  return {
    model: 'model-x',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    thinkingTokens: null,
    webSearchRequests: null,
    webFetchRequests: null,
    legacyIn: input,
    legacyOut: output,
    legacyCr: 0,
    legacyCc: 0,
    finalized: true,
    usageSource: 'top',
    synthetic: false,
    ts: NOW,
    invalidValues: 0,
  };
}

function seenItem(sessionUid: string, fileId: number): IngestItem {
  return {
    kind: 'record',
    events: [
      {
        k: 'session.seen',
        sessionId: sessionUid,
        stamp: { at: NOW - 1000, rank: 0, tie: `t:${String(fileId)}:seen` },
        transcriptPath: `/transcripts/${String(fileId)}.jsonl`,
      },
    ],
    rows: [],
  };
}

function usageBatch(
  fileId: number,
  list: readonly { messageKey: string; values: UsageValues }[],
  head: readonly IngestItem[] = [],
  tailOffset = 100,
): IngestBatch {
  return {
    source: 'transcript',
    items: [...head, ...usageItems(fileId, list)],
    bytes: 1000,
    cursor: { kind: 'transcript', fileId, cursor: { tailOffset, sizeSeen: tailOffset } },
  };
}

function sessionTokens(db: InstanceDb, uid: string): { tok_input: number; tok_output: number } | undefined {
  return db.driver
    .prepare<{ tok_input: number; tok_output: number }>(
      'SELECT tok_input, tok_output FROM sessions WHERE session_uid = ?',
    )
    .get([uid]);
}

function tailOffsetOf(db: InstanceDb, fileId: number): number {
  return new TranscriptFilesRepo(db).get(CTX, fileId)?.tailOffset ?? -1;
}

function maxSeq(db: InstanceDb): number {
  return db.driver.prepare<{ n: number | null }>('SELECT max(seq) AS n FROM changes').get()?.n ?? 0;
}

function announcedSince(db: InstanceDb, seq: number): { kind: string; entity_id: number; n: number }[] {
  return db.driver
    .prepare<{ kind: string; entity_id: number; n: number }>(
      `SELECT kind, entity_id, count(*) AS n FROM changes WHERE seq > ? AND kind IN ('session', 'agent')
        GROUP BY kind, entity_id ORDER BY kind, entity_id`,
    )
    .all([seq]);
}

describe('usage rows ride in the cursor transaction (WP-98)', () => {
  it('a failed commit leaves neither the usage nor the cursor; the retry writes both; a second delivery changes nothing', async () => {
    let throwOnce = true;
    let seenInside = -1;
    let db: InstanceDb | null = null;
    const r = rig({
      beforeCommit: (_tx, batches) => {
        if (throwOnce && batches.some((b) => b.cursor?.kind === 'transcript')) {
          throwOnce = false;
          seenInside = db === null ? -1 : count(db, 'usage');
          throw new Error('injected failure before COMMIT');
        }
      },
    });
    db = r.db;
    const fileId = registerFile(r.db, 'main', FIXTURE_SESSION_ID);
    const list = [
      { messageKey: 'msg_1', values: usageValues(10, 5) },
      { messageKey: 'msg_2', values: usageValues(20, 7) },
    ];
    const committed: number[] = [];
    onCommitted(r.db, () => committed.push(count(r.db, 'usage')));
    r.writer.submit(usageBatch(fileId, list, [seenItem(FIXTURE_SESSION_ID, fileId)]));
    await r.writer.flushNow();
    expect(throwOnce).toBe(false);
    // the failing transaction held the usage, and the rollback took it away with the cursor
    expect(seenInside).toBe(2);
    expect(r.writer.stats.failures).toBe(1);
    // the first commit carries both usage rows and the cursor together
    expect(committed[0]).toBe(2);
    expect(tailOffsetOf(r.db, fileId)).toBe(100);
    expect(sessionTokens(r.db, FIXTURE_SESSION_ID)).toEqual({ tok_input: 30, tok_output: 12 });
    const before = dumpDatabase(r.db);
    r.writer.submit(usageBatch(fileId, list, [seenItem(FIXTURE_SESSION_ID, fileId)]));
    await r.writer.flushNow();
    const after = dumpDatabase(r.db);
    expect(after['usage']).toEqual(before['usage']);
    expect(after['usage_files']).toEqual(before['usage_files']);
    expect(sessionTokens(r.db, FIXTURE_SESSION_ID)).toEqual({ tok_input: 30, tok_output: 12 });
    expect(new UsageRepo(r.db).verifyRollups(CTX)).toEqual([]);
  });

  it('a rolled back transaction leaves no usage and no cursor behind', async () => {
    const r = rig({
      beforeCommit: () => {
        throw new Error('always fails');
      },
    });
    const fileId = registerFile(r.db, 'main', FIXTURE_SESSION_ID);
    r.writer.submit(
      usageBatch(fileId, [{ messageKey: 'msg_1', values: usageValues(1, 1) }], [seenItem(FIXTURE_SESSION_ID, fileId)]),
    );
    await r.writer.flushNow();
    // the poison path records the failure, but the rows of the failed attempts are gone
    expect(count(r.db, 'usage')).toBe(0);
    expect(count(r.db, 'usage_files')).toBe(0);
  });

  it('applies the usage of the very batch that creates the session: the writer links the file in the transaction', async () => {
    const r = rig();
    const fileId = registerFile(r.db, 'fresh', FIXTURE_SESSION_ID);
    expect(new TranscriptFilesRepo(r.db).get(CTX, fileId)?.sessionId).toBeNull();
    r.writer.submit(
      usageBatch(fileId, [{ messageKey: 'msg_1', values: usageValues(3, 4) }], [seenItem(FIXTURE_SESSION_ID, fileId)]),
    );
    await r.writer.flushNow();
    const file = new TranscriptFilesRepo(r.db).get(CTX, fileId);
    expect(file?.sessionId).not.toBeNull();
    const session = r.db.driver
      .prepare<{ id: number; transcript_file_id: number | null }>(
        'SELECT id, transcript_file_id FROM sessions WHERE session_uid = ?',
      )
      .get([FIXTURE_SESSION_ID]);
    expect(session?.id).toBe(file?.sessionId);
    expect(session?.transcript_file_id).toBe(fileId);
    expect(sessionTokens(r.db, FIXTURE_SESSION_ID)).toEqual({ tok_input: 3, tok_output: 4 });
  });

  it('puts the usage of a subagent file on the agent and on its session rollup', async () => {
    const r = rig();
    const fileId = registerFile(r.db, 'agent', FIXTURE_SESSION_ID, 'subagent');
    const meta: IngestItem = {
      kind: 'record',
      events: [{ k: 'agent.meta', sessionId: FIXTURE_SESSION_ID, agentId: AGENT_UID }],
      rows: [],
    };
    r.writer.submit(usageBatch(fileId, [{ messageKey: 'msg_a', values: usageValues(8, 2) }], [meta]));
    await r.writer.flushNow();
    const agent = r.db.driver
      .prepare<{ id: number; tok_input: number; transcript_file_id: number | null }>(
        'SELECT id, tok_input, transcript_file_id FROM agents WHERE agent_uid = ?',
      )
      .get([AGENT_UID]);
    expect(agent?.tok_input).toBe(8);
    expect(agent?.transcript_file_id).toBe(fileId);
    expect(new TranscriptFilesRepo(r.db).get(CTX, fileId)?.agentId).toBe(agent?.id);
    expect(sessionTokens(r.db, FIXTURE_SESSION_ID)).toEqual({ tok_input: 8, tok_output: 2 });
    expect(new UsageRepo(r.db).verifyRollups(CTX)).toEqual([]);
  });

  it('isolates a usage row of an unknown file: PERSIST_FAILED once, the other items commit, the cursor advances', async () => {
    const r = rig();
    const fileId = registerFile(r.db, 'main', FIXTURE_SESSION_ID);
    const batch: IngestBatch = {
      source: 'transcript',
      items: [
        seenItem(FIXTURE_SESSION_ID, fileId),
        ...usageItems(fileId, [{ messageKey: 'msg_ok', values: usageValues(1, 1) }]),
        ...usageItems(9999, [{ messageKey: 'msg_lost', values: usageValues(5, 5) }]),
      ],
      bytes: 1000,
      cursor: { kind: 'transcript', fileId, cursor: { tailOffset: 300, sizeSeen: 300 } },
    };
    r.writer.submit(batch);
    await r.writer.flushNow();
    expect(readCounters(r.db).persistFailed).toBe(1);
    expect(readCounters(r.db).errors).toMatchObject({ PERSIST_FAILED: 1 });
    expect(new UsageRepo(r.db).get(CTX, 'msg_ok')).toBeDefined();
    expect(new UsageRepo(r.db).get(CTX, 'msg_lost')).toBeUndefined();
    expect(tailOffsetOf(r.db, fileId)).toBe(300);
  });

  it('announces each session and agent whose rollup changed once per transaction, the owner of a resumed copy too', async () => {
    const r = rig();
    const original = registerFile(r.db, 'original', FIXTURE_SESSION_ID);
    const copy = registerFile(r.db, 'copy', SECOND_SESSION);
    r.writer.submit(
      usageBatch(
        original,
        [
          { messageKey: 'msg_shared', values: usageValues(10, 1) },
          { messageKey: 'msg_own', values: usageValues(4, 1) },
        ],
        [seenItem(FIXTURE_SESSION_ID, original)],
      ),
    );
    await r.writer.flushNow();
    const first = announcedSince(r.db, 0);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((row) => row.n === 1)).toBe(true);
    const originalRow = r.db.driver
      .prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = ?')
      .get([FIXTURE_SESSION_ID])?.id;
    expect(first.filter((row) => row.kind === 'session').map((row) => row.entity_id)).toEqual([originalRow]);

    // the copy holds the same message with more output: the value grows and the key may change owner; the session that
    // loses or gains the contribution is announced in the transaction of the copy, whichever session the batch is about
    const mark = maxSeq(r.db);
    r.writer.submit(
      usageBatch(copy, [{ messageKey: 'msg_shared', values: usageValues(10, 9) }], [seenItem(SECOND_SESSION, copy)]),
    );
    await r.writer.flushNow();
    const second = announcedSince(r.db, mark);
    expect(second.every((row) => row.n === 1)).toBe(true);
    expect(second.filter((row) => row.kind === 'session').map((row) => row.entity_id)).toContain(originalRow);
    const a = sessionTokens(r.db, FIXTURE_SESSION_ID);
    const b = sessionTokens(r.db, SECOND_SESSION);
    expect((a?.tok_input ?? 0) + (b?.tok_input ?? 0)).toBe(14);
    expect((a?.tok_output ?? 0) + (b?.tok_output ?? 0)).toBe(10);
    // the frame of the commit carries the totals: the announced rows are stamped with the seq of this transaction
    const stamped = r.db.driver.prepare<{ updated_seq: number }>('SELECT updated_seq FROM sessions').all();
    expect(stamped.every((row) => row.updated_seq > mark)).toBe(true);
    expect(new UsageRepo(r.db).verifyRollups(CTX)).toEqual([]);
  });

  it('splits 300 usage rows into items of at most 50, so the item cap of a transaction still bounds the work', async () => {
    const list = Array.from({ length: 300 }, (_, i) => ({ messageKey: `msg_${String(i)}`, values: usageValues(1, 1) }));
    const items = usageItems(7, list);
    expect(USAGE_ROWS_PER_ITEM).toBe(50);
    expect(items).toHaveLength(6);
    expect(items.every((item) => item.rows.length <= 50 && item.events.length === 0)).toBe(true);
    const r = rig();
    const fileId = registerFile(r.db, 'big', FIXTURE_SESSION_ID);
    // the queue counts the usage items: a batch with 300 usage rows weighs 7 items, not 1
    r.writer.submit(usageBatch(fileId, list, [seenItem(FIXTURE_SESSION_ID, fileId)]));
    expect(r.writer.stats.queued).toBe(7);
    await r.writer.flushNow();
    expect(sessionTokens(r.db, FIXTURE_SESSION_ID)).toEqual({ tok_input: 300, tok_output: 300 });
  });
});

// ---- hook coverage of a subagent file (CR-WP-35-3, WP-99) ----------------------------------------------------------------------

describe('hook coverage counts the prompts of the main agent only (CR-WP-35-3, T-HE-01 with a subagent)', () => {
  /** A prompt record of the transcript with no hook counterpart, written by `agentUid` (null / 'main' = the main agent). */
  function transcriptPrompt(agentUid: string | null, key: string, at: number): IngestItem {
    return {
      kind: 'record',
      events: [],
      rows: [
        {
          t: 'event',
          row: eventRow({
            sessionUid: FIXTURE_SESSION_ID,
            agentUid,
            kind: 'prompt.submit',
            entryKind: 'prompt',
            sources: 2,
            stamp: { at, rank: 10, tie: key },
            tsSource: 'record',
            receivedAt: at,
            recordUuid: key,
          }),
        },
      ],
    };
  }

  const coverageOf = (db: InstanceDb): unknown =>
    db.driver.prepare('SELECT hook_coverage, hook_missing_tools, hook_missing_turns FROM sessions').get();
  const gaps = (db: InstanceDb): number => dumpDatabase(db)['reconciliations']?.length ?? 0;

  async function transcript(r: Rig, ...items: IngestItem[]): Promise<void> {
    r.writer.submit({ source: 'transcript', items, bytes: 10 });
    await r.writer.flushNow();
  }

  it('stays full when the only prompt without a hook is the first prompt of a subagent', async () => {
    const r = rig();
    await ingest(r, labSequence().slice(0, 1));
    await transcript(r, transcriptPrompt(AGENT_UID, 'u-sub-1', SEQUENCE_START + 20_000));
    expect(coverageOf(r.db)).toEqual({ hook_coverage: 'full', hook_missing_tools: 0, hook_missing_turns: 0 });
    expect(gaps(r.db)).toBe(0);
  });

  it('is partial when the main agent has a prompt without a hook, as a null agent and as the main agent', async () => {
    const asNull = rig();
    await ingest(asNull, labSequence().slice(0, 1));
    await transcript(asNull, transcriptPrompt(null, 'u-main-1', SEQUENCE_START + 20_000));
    expect(coverageOf(asNull.db)).toEqual({ hook_coverage: 'partial', hook_missing_tools: 0, hook_missing_turns: 1 });
    expect(gaps(asNull.db)).toBe(1);

    const asMain = rig();
    await ingest(asMain, labSequence().slice(0, 1));
    await transcript(asMain, transcriptPrompt('main', 'u-main-1', SEQUENCE_START + 20_000));
    expect(coverageOf(asMain.db)).toEqual({ hook_coverage: 'partial', hook_missing_tools: 0, hook_missing_turns: 1 });
  });

  it('counts the main prompt once however many subagent prompts have no hook either', async () => {
    const r = rig();
    await ingest(r, labSequence().slice(0, 1));
    await transcript(
      r,
      transcriptPrompt(AGENT_UID, 'u-sub-1', SEQUENCE_START + 20_000),
      transcriptPrompt('main', 'u-main-1', SEQUENCE_START + 21_000),
      transcriptPrompt(AGENT_UID, 'u-sub-2', SEQUENCE_START + 22_000),
    );
    expect(coverageOf(r.db)).toEqual({ hook_coverage: 'partial', hook_missing_tools: 0, hook_missing_turns: 1 });
  });
});

// ---- derive items name the agents and runs (CR-WP-35-2, WP-99) ---------------------------------------------------------------

describe('a derive item names the agents and workflow runs whose views are written (CR-WP-35-2)', () => {
  const RUN_UID = 'wf_0123456789ab';
  const STARTED = NOW - 5_000;
  const STALE_AFTER = 31 * 60_000;

  interface ViewRow {
    id: number;
    state: string;
    stale_kind: string | null;
    next_check_at: number | null;
  }

  const startAgent = (): IngestItem => ({
    kind: 'record',
    events: [
      {
        k: 'agent.start',
        sessionId: FIXTURE_SESSION_ID,
        agentId: AGENT_UID,
        agentType: 'general-purpose',
        stamp: { at: STARTED, rank: 44, tie: 'agent-start' },
      },
    ],
    rows: [],
  });
  const launchRun = (): IngestItem => ({
    kind: 'record',
    events: [
      {
        k: 'workflow.launch',
        sessionId: FIXTURE_SESSION_ID,
        runId: RUN_UID,
        toolUseId: 'toolu_wf_1',
        name: 'FIXTURE flow',
        stamp: { at: STARTED, rank: 30, tie: 'wf-launch' },
      },
    ],
    rows: [],
  });
  function derive(
    sessionId: string,
    names: { agents?: readonly string[]; runs?: readonly string[] } = {},
  ): IngestBatch {
    return {
      source: 'sweeper',
      items: [
        {
          kind: 'derive',
          events: [],
          rows: [],
          derive: {
            sessionId,
            ...(names.agents === undefined ? {} : { agents: names.agents }),
            ...(names.runs === undefined ? {} : { runs: names.runs }),
          },
        },
      ],
      bytes: 100,
    };
  }
  async function send(r: Rig, batch: IngestBatch): Promise<void> {
    expect(r.writer.submit(batch)).toBe(true);
    await r.writer.flushNow();
  }
  const agentOf = (db: InstanceDb): ViewRow | undefined =>
    db.driver
      .prepare<ViewRow>('SELECT id, state, stale_kind, next_check_at FROM agents WHERE agent_uid = ?')
      .get([AGENT_UID]);
  const runOf = (db: InstanceDb): ViewRow | undefined =>
    db.driver
      .prepare<ViewRow>('SELECT id, state, stale_kind, next_check_at FROM workflow_runs WHERE run_uid = ?')
      .get([RUN_UID]);
  const upserts = (db: InstanceDb, kind: 'agent' | 'workflow', id: number, since: number): number =>
    db.driver
      .prepare<{ n: number }>('SELECT count(*) AS n FROM changes WHERE kind = ? AND entity_id = ? AND seq > ?')
      .get([kind, id, since])?.n ?? -1;

  it('writes the view of a named subagent that stopped writing, and announces agent/upsert once', async () => {
    const r = rig();
    await send(r, { source: 'transcript', items: [startAgent()], bytes: 10 });
    expect(agentOf(r.db)).toMatchObject({ state: 'working' });
    const id = agentOf(r.db)?.id ?? -1;

    r.clock.advance(STALE_AFTER);
    // the session alone is re-derived: the view of the subagent is not written (the old behaviour)
    await send(r, derive(FIXTURE_SESSION_ID));
    expect(agentOf(r.db)).toMatchObject({ state: 'working' });

    const mark = maxSeq(r.db);
    await send(r, derive(FIXTURE_SESSION_ID, { agents: [AGENT_UID] }));
    expect(agentOf(r.db)).toMatchObject({ state: 'stale', stale_kind: 'silent' });
    expect(upserts(r.db, 'agent', id, mark)).toBe(1);
    // the new check time is after now (or none), so the row is not selected again and again
    const next = agentOf(r.db)?.next_check_at ?? null;
    expect(next === null || next > r.clock.now()).toBe(true);

    // the same item again changes nothing and announces nothing
    const settled = maxSeq(r.db);
    await send(r, derive(FIXTURE_SESSION_ID, { agents: [AGENT_UID] }));
    expect(upserts(r.db, 'agent', id, settled)).toBe(0);
  });

  it('writes the view of a named workflow run and announces workflow/upsert once', async () => {
    const r = rig();
    await send(r, { source: 'transcript', items: [launchRun()], bytes: 10 });
    expect(runOf(r.db)).toMatchObject({ state: 'running' });
    const id = runOf(r.db)?.id ?? -1;

    r.clock.advance(STALE_AFTER);
    await send(r, derive(FIXTURE_SESSION_ID));
    expect(runOf(r.db)).toMatchObject({ state: 'running' });

    const mark = maxSeq(r.db);
    await send(r, derive(FIXTURE_SESSION_ID, { runs: [RUN_UID] }));
    expect(runOf(r.db)).toMatchObject({ state: 'stale', stale_kind: 'silent' });
    expect(upserts(r.db, 'workflow', id, mark)).toBe(1);
  });

  it('ignores a name that is not a row of the session: no agent and no run is created', async () => {
    const r = rig();
    await send(r, { source: 'transcript', items: [startAgent()], bytes: 10 });
    const agentsBefore = count(r.db, 'agents');
    await send(r, derive(FIXTURE_SESSION_ID, { agents: ['a9999999999999999', 'main'], runs: ['wf_ffffffffffff'] }));
    expect(count(r.db, 'agents')).toBe(agentsBefore);
    expect(count(r.db, 'workflow_runs')).toBe(0);
    expect(r.writer.stats.failures).toBe(0);
  });

  it('does not bring back a session that retention deleted: nothing is created and nothing fails', async () => {
    const r = rig();
    await send(r, derive(FIXTURE_SESSION_ID, { agents: [AGENT_UID] }));
    expect(count(r.db, 'sessions')).toBe(0);
    expect(count(r.db, 'agents')).toBe(0);
    expect(r.writer.stats.failures).toBe(0);
    expect(r.writer.stats.lastCommitAt).not.toBeNull();
  });

  it('a derive item carries no event: the item that names a session is not a fake external job', () => {
    const [item] = derive(FIXTURE_SESSION_ID).items;
    expect(item?.events).toEqual([]);
    expect(item?.derive?.sessionId).toBe(FIXTURE_SESSION_ID);
  });
});

// ---- the provider cost state (CR-WP-28-2, WP-99) ----------------------------------------------------------------------------

function sessionRowId(db: InstanceDb): number {
  return (
    db.driver.prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = ?').get([FIXTURE_SESSION_ID])?.id ??
    -1
  );
}

describe('the cost state of a transcript file and the trailing flag (CR-WP-28-2)', () => {
  interface CostRow {
    file_id: number;
    total_cost_usd: number | null;
    byte_offset: number;
    is_trailing: number;
    observed_at: number;
  }
  const costRows = (db: InstanceDb): CostRow[] =>
    db.driver
      .prepare<CostRow>(
        'SELECT file_id, total_cost_usd, byte_offset, is_trailing, observed_at FROM cost_states ORDER BY file_id',
      )
      .all();
  const mirrored = (
    db: InstanceDb,
  ): { reported_cost_usd: number | null; reported_cost_at: number | null } | undefined =>
    db.driver
      .prepare<{ reported_cost_usd: number | null; reported_cost_at: number | null }>(
        'SELECT reported_cost_usd, reported_cost_at FROM sessions WHERE session_uid = ?',
      )
      .get([FIXTURE_SESSION_ID]);

  const costItem = (fileId: number, byteOffset: number, total: number | null = 1.25): IngestItem => ({
    kind: 'record',
    events: [
      {
        k: 'cost_state',
        sessionId: FIXTURE_SESSION_ID,
        fileId,
        byteOffset,
        totalCostUsd: total,
        modelUsage: { 'model-x': { inputTokens: 10, outputTokens: 5 } },
      },
    ],
    rows: [],
  });
  /** A stored event row of the file at `byteOffset`: a record the cost-state record is followed by. */
  const rowAt = (fileId: number, byteOffset: number, key: string): IngestItem => ({
    kind: 'record',
    events: [],
    rows: [
      {
        t: 'event',
        row: eventRow({
          sessionUid: FIXTURE_SESSION_ID,
          kind: 'prompt.submit',
          entryKind: 'prompt',
          sources: 2,
          stamp: { at: NOW - 60_000 + byteOffset, rank: 10, tie: key },
          tsSource: 'record',
          receivedAt: NOW - 60_000,
          recordUuid: key,
          fileId,
          byteOffset,
          byteLength: 40,
          lineNo: byteOffset,
        }),
      },
    ],
  });
  async function send(r: Rig, ...items: IngestItem[]): Promise<void> {
    expect(r.writer.submit({ source: 'transcript', items, bytes: 10 * items.length })).toBe(true);
    await r.writer.flushNow();
  }
  /** The session with its main transcript file; returns the file id. */
  async function started(r: Rig, name = 'main'): Promise<number> {
    const fileId = registerFile(r.db, name, FIXTURE_SESSION_ID);
    await send(r, seenItem(FIXTURE_SESSION_ID, fileId));
    return fileId;
  }

  it('writes the record as trailing and mirrors the amount into the session', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500));
    expect(costRows(r.db)).toEqual([
      { file_id: fileId, total_cost_usd: 1.25, byte_offset: 500, is_trailing: 1, observed_at: NOW },
    ]);
    expect(mirrored(r.db)).toEqual({ reported_cost_usd: 1.25, reported_cost_at: NOW });
    expect(new CostStatesRepo(r.db).sessionTrailing(CTX, sessionRowId(r.db))).toBe(true);
  });

  it('adds no fact: the stored facts keep the deprecated keys at their defaults', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500));
    const facts = r.db.driver
      .prepare<{ facts_json: string }>('SELECT facts_json FROM sessions WHERE session_uid = ?')
      .get([FIXTURE_SESSION_ID]);
    expect(JSON.parse(facts?.facts_json ?? '{}')).toMatchObject({ costStateTrailing: null, hookHandlerErrors: 0 });
  });

  it('an event row of the same file after the offset clears the flag and keeps the amount', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500));
    await send(r, rowAt(fileId, 900, 'u-after-1'));
    expect(costRows(r.db).map((row) => [row.byte_offset, row.is_trailing, row.total_cost_usd])).toEqual([
      [500, 0, 1.25],
    ]);
    expect(mirrored(r.db)).toEqual({ reported_cost_usd: 1.25, reported_cost_at: NOW });
    expect(new CostStatesRepo(r.db).sessionTrailing(CTX, sessionRowId(r.db))).toBe(false);
  });

  it('a row before the offset, a row of another file and a duplicate row leave the flag set', async () => {
    const r = rig();
    const fileId = await started(r);
    const other = registerFile(r.db, 'other', FIXTURE_SESSION_ID, 'subagent');
    await send(r, costItem(fileId, 500));
    await send(r, rowAt(fileId, 200, 'u-before'));
    await send(r, rowAt(other, 900, 'u-other-file'));
    expect(costRows(r.db).map((row) => row.is_trailing)).toEqual([1]);
    // a record that is already stored changes nothing (a resume copy keeps its record uuid)
    await send(r, rowAt(fileId, 900, 'u-before'));
    expect(costRows(r.db).map((row) => row.is_trailing)).toEqual([1]);
  });

  it('gives not trailing when the later row arrives first, in another batch or earlier in the same batch', async () => {
    const apart = rig();
    const fileA = await started(apart);
    await send(apart, rowAt(fileA, 900, 'u-after-1'));
    await send(apart, costItem(fileA, 500));
    expect(costRows(apart.db).map((row) => [row.byte_offset, row.is_trailing])).toEqual([[500, 0]]);
    expect(mirrored(apart.db)?.reported_cost_usd).toBe(1.25);

    const together = rig();
    const fileB = await started(together);
    await send(together, rowAt(fileB, 900, 'u-after-1'), costItem(fileB, 500));
    expect(costRows(together.db).map((row) => [row.byte_offset, row.is_trailing])).toEqual([[500, 0]]);
  });

  it('reading the same records again keeps the flag at 0 and the observation time where it was', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500));
    await send(r, rowAt(fileId, 900, 'u-after-1'));
    const before = costRows(r.db);
    r.clock.advance(60_000);
    await send(r, costItem(fileId, 500), rowAt(fileId, 900, 'u-after-1'));
    expect(costRows(r.db)).toEqual(before);
    expect(mirrored(r.db)).toEqual({ reported_cost_usd: 1.25, reported_cost_at: NOW });
  });

  it('a record at a greater offset replaces the amount; one at a smaller offset does not', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500, 1.25));
    await send(r, costItem(fileId, 800, 2.5));
    expect(costRows(r.db).map((row) => [row.byte_offset, row.total_cost_usd, row.is_trailing])).toEqual([
      [800, 2.5, 1],
    ]);
    expect(mirrored(r.db)?.reported_cost_usd).toBe(2.5);
    await send(r, costItem(fileId, 300, 9));
    expect(costRows(r.db).map((row) => [row.byte_offset, row.total_cost_usd])).toEqual([[800, 2.5]]);
    expect(mirrored(r.db)?.reported_cost_usd).toBe(2.5);
  });

  it('a record without a total keeps the amount that was mirrored', async () => {
    const r = rig();
    const fileId = await started(r);
    await send(r, costItem(fileId, 500, 1.25));
    await send(r, costItem(fileId, 800, null));
    expect(mirrored(r.db)?.reported_cost_usd).toBe(1.25);
    expect(costRows(r.db).map((row) => [row.byte_offset, row.total_cost_usd])).toEqual([[800, null]]);
  });

  it('a rolled back transaction leaves no cost state; the retry writes it once', async () => {
    let failOnce = true;
    let insideRows = -1;
    let db: InstanceDb | null = null;
    const r = rig({
      beforeCommit: () => {
        if (failOnce) {
          failOnce = false;
          insideRows = db === null ? -1 : count(db, 'cost_states');
          throw new Error('injected failure before COMMIT');
        }
      },
    });
    db = r.db;
    const fileId = registerFile(r.db, 'main', FIXTURE_SESSION_ID);
    await send(r, seenItem(FIXTURE_SESSION_ID, fileId), costItem(fileId, 500));
    expect(insideRows).toBe(1);
    expect(r.writer.stats.failures).toBe(1);
    expect(costRows(r.db)).toHaveLength(1);
    expect(mirrored(r.db)?.reported_cost_usd).toBe(1.25);
  });

  describe('presence ended (inferred) follows the flag (S-8e, CHALLENGES C2)', () => {
    /** A finished turn of the transcript, five minutes old: prompt, answer, end_turn. */
    const finishedTurn = (): IngestItem => {
      const at = (dt: number, rank: number, tie: string): { at: number; rank: number; tie: string } => ({
        at: NOW - 300_000 + dt,
        rank,
        tie,
      });
      return {
        kind: 'record',
        events: [
          {
            k: 'turn.prompt',
            sessionId: FIXTURE_SESSION_ID,
            agentId: null,
            promptId: 'p-cost-1',
            stamp: at(0, 10, 'prompt'),
            origin: 'user',
          },
          { k: 'activity', sessionId: FIXTURE_SESSION_ID, agentId: null, stamp: at(0, 10, 'prompt'), via: 'user' },
          {
            k: 'activity',
            sessionId: FIXTURE_SESSION_ID,
            agentId: null,
            stamp: at(1000, 20, 'answer'),
            via: 'assistant',
          },
          {
            k: 'turn.end',
            sessionId: FIXTURE_SESSION_ID,
            agentId: null,
            promptId: 'p-cost-1',
            stamp: at(1000, 20, 'end'),
            kind: 'end_turn',
          },
        ],
        rows: [],
      };
    };
    const presenceOf = (db: InstanceDb): unknown =>
      db.driver
        .prepare('SELECT state, presence, state_basis, state_rule FROM sessions WHERE session_uid = ?')
        .get([FIXTURE_SESSION_ID]);

    it('is open without a cost-state record, ended and inferred while the record is the last, open again after a later record', async () => {
      const r = rig();
      const fileId = await started(r);
      await send(r, finishedTurn());
      expect(presenceOf(r.db)).toEqual({
        state: 'turn_ended',
        presence: 'open',
        state_basis: 'observed',
        state_rule: 'S-8e',
      });
      await send(r, costItem(fileId, 500));
      expect(presenceOf(r.db)).toEqual({
        state: 'turn_ended',
        presence: 'ended',
        state_basis: 'inferred',
        state_rule: 'S-8e',
      });
      await send(r, rowAt(fileId, 900, 'u-after-1'));
      expect(presenceOf(r.db)).toEqual({
        state: 'turn_ended',
        presence: 'open',
        state_basis: 'observed',
        state_rule: 'S-8e',
      });
    });

    it('the cost state of a subagent file does not end the session', async () => {
      const r = rig();
      await started(r);
      const agentFile = registerFile(r.db, 'agent', FIXTURE_SESSION_ID, 'subagent');
      await send(r, finishedTurn(), costItem(agentFile, 500));
      expect(presenceOf(r.db)).toMatchObject({ presence: 'open' });
    });
  });
});

// ---- the activity throttle (CR-WP-35-1, WP-99) --------------------------------------------------------------------------------

describe('the per-writer activity throttle (CR-WP-35-1, 03 3.6)', () => {
  /** `n` PreToolUse envelopes: each is one commit that changes counters but not the lifecycle view of the session. */
  function burst(n: number, from = 0): HookEnvelopeV1[] {
    return Array.from({ length: n }, (_, i) =>
      fixtureEnvelope('PreToolUse', {
        eventUid: uidOf(5000 + from + i),
        receivedAt: SEQUENCE_START + 3_000 + from + i,
        top: {
          tool_use_id: `toolu_burst_${String(from + i)}`,
          prompt_id: PROMPT_ID,
          content_hash: hashOf(5000 + from + i),
        },
        data: { tool_name: 'Bash', tool_summary: 'echo FIXTURE', tool_input_hash: 'f'.repeat(32) },
      }),
    );
  }
  const announced = (db: InstanceDb, kind: 'session' | 'agent' | 'health', since: number): number =>
    db.driver
      .prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE kind = ? AND op = 'upsert' AND seq > ?")
      .get([kind, since])?.n ?? -1;
  const settle = (r: Rig): Promise<void> => ingest(r, labSequence().slice(0, 3));

  it('a burst of 50 commits inside one second announces nothing more; flushActivity announces the session and the health once', async () => {
    const r = rig({ throttle: createActivityThrottle() });
    await settle(r);
    const mark = maxSeq(r.db);
    for (const envelope of burst(50)) await ingest(r, [envelope]);
    expect(count(r.db, 'events')).toBe(53);
    expect(announced(r.db, 'session', mark)).toBe(0);
    expect(announced(r.db, 'health', mark)).toBe(0);
    // a flush inside the window announces nothing either
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(0);

    r.clock.advance(1000);
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(1);
    expect(announced(r.db, 'health', mark)).toBe(1);
    // the announced row carries the seq of its announcement, so a frame hydrated for it shows the committed totals
    const change = r.db.driver
      .prepare<{ seq: number }>("SELECT max(seq) AS seq FROM changes WHERE kind = 'session' AND op = 'upsert'")
      .get();
    const row = r.db.driver
      .prepare<{ updated_seq: number; event_count: number }>('SELECT updated_seq, event_count FROM sessions')
      .get();
    expect(row).toEqual({ updated_seq: change?.seq, event_count: 53 });

    // nothing is left to announce
    const flushed = maxSeq(r.db);
    await r.writer.flushActivity();
    expect(maxSeq(r.db)).toBe(flushed);
  });

  it('without a throttle every commit announces the session and the health', async () => {
    const r = rig();
    await settle(r);
    const mark = maxSeq(r.db);
    for (const envelope of burst(50)) await ingest(r, [envelope]);
    expect(announced(r.db, 'session', mark)).toBe(50);
    expect(announced(r.db, 'health', mark)).toBe(50);
    // and a flush has nothing to do
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(50);
  });

  it('a change of the lifecycle view is never deferred and restarts the window', async () => {
    const throttle = createActivityThrottle();
    const r = rig({ throttle });
    await settle(r);
    for (const envelope of burst(5)) await ingest(r, [envelope]);
    const mark = maxSeq(r.db);
    const stop = fixtureEnvelope('Stop', {
      eventUid: uidOf(6000),
      receivedAt: SEQUENCE_START + 9_000,
      top: { prompt_id: PROMPT_ID, content_hash: hashOf(6000) },
      data: { stop_hook_active: false, last_message_len: 20, background_task_count: 0 },
    });
    await ingest(r, [stop]);
    expect(announced(r.db, 'session', mark)).toBe(1);
    expect(r.db.driver.prepare('SELECT state FROM sessions').get()).toEqual({ state: 'turn_ended' });
    // activity right after it is deferred again: the window restarted with the view change
    for (const envelope of burst(3, 100)) await ingest(r, [envelope]);
    expect(announced(r.db, 'session', mark)).toBe(1);
    expect(throttle.nextDueAt()).toBe(NOW + 1000);
  });

  it('a flush whose transaction fails puts the announcements back; the next flush announces them', async () => {
    const r = rig({ throttle: createActivityThrottle() });
    await settle(r);
    const mark = maxSeq(r.db);
    for (const envelope of burst(3)) await ingest(r, [envelope]);
    r.clock.advance(1000);
    // the stamp of updated_seq fails after the flush reserved its changes: the transaction rolls back
    r.db.driver.exec(
      "CREATE TRIGGER fail_stamp BEFORE UPDATE OF updated_seq ON sessions BEGIN SELECT RAISE(ABORT, 'FIXTURE stamp failure'); END",
    );
    await expect(r.writer.flushActivity()).rejects.toThrow();
    expect(announced(r.db, 'session', mark)).toBe(0);
    expect(announced(r.db, 'health', mark)).toBe(0);
    r.db.driver.exec('DROP TRIGGER fail_stamp');
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(1);
    expect(announced(r.db, 'health', mark)).toBe(1);
  });

  it('a rolled back commit does not lose the deferred announcement: its retry is deferred and flushed', async () => {
    let failNext = false;
    const r = rig({
      throttle: createActivityThrottle(),
      beforeCommit: () => {
        if (failNext) {
          failNext = false;
          throw new Error('injected failure before COMMIT');
        }
      },
    });
    await settle(r);
    // the window of the creation has passed: this commit would be announced at once
    r.clock.advance(1500);
    const mark = maxSeq(r.db);
    failNext = true;
    const [envelope] = burst(1);
    if (envelope === undefined) throw new Error('fixture');
    await ingest(r, [envelope]);
    expect(r.writer.stats.failures).toBe(1);
    // the first attempt reserved and restarted the window, the rollback removed the reservation, the retry was deferred
    expect(announced(r.db, 'session', mark)).toBe(0);
    r.clock.advance(1000);
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(1);
    expect(announced(r.db, 'health', mark)).toBe(1);
  });

  it('a poison item with a view change does not drop the announcement that earlier activity deferred', async () => {
    const poisonUid = uidOf(6000);
    let poison = false;
    const r = rig({
      throttle: createActivityThrottle(),
      beforeCommit: (_tx, batches) => {
        const hit = batches.some((b) =>
          b.items.some((item) => item.rows.some((row) => row.t === 'event' && row.row.eventUid === poisonUid)),
        );
        if (poison && hit) throw new Error('injected failure before COMMIT');
      },
    });
    await settle(r);
    r.clock.advance(1500);
    await ingest(r, burst(1, 0)); // the window has passed: announced at once, the window restarts
    await ingest(r, burst(1, 1)); // inside the window: deferred
    const mark = maxSeq(r.db);

    // the Stop envelope changes the view of the session, and its transaction never commits: the item is dropped as poison
    poison = true;
    const stop = fixtureEnvelope('Stop', {
      eventUid: poisonUid,
      receivedAt: SEQUENCE_START + 9_000,
      top: { prompt_id: PROMPT_ID, content_hash: hashOf(6000) },
      data: { stop_hook_active: false, last_message_len: 20, background_task_count: 0 },
    });
    await ingest(r, [stop]);
    expect(r.writer.stats.failures).toBeGreaterThan(0);
    expect(r.db.driver.prepare('SELECT state FROM sessions').get()).not.toEqual({ state: 'turn_ended' });

    // the rolled back view change neither announced anything nor told the throttle: the deferred activity is still due
    r.clock.advance(1000);
    await r.writer.flushActivity();
    expect(announced(r.db, 'session', mark)).toBe(1);
  });

  it('opens no transaction when nothing is deferred, and resolves after close', async () => {
    const r = rig({ throttle: createActivityThrottle() });
    let commits = 0;
    onCommitted(r.db, () => {
      commits += 1;
    });
    await r.writer.flushActivity();
    expect(commits).toBe(0);
    await settle(r);
    const afterSettle = commits;
    r.clock.advance(5000);
    await r.writer.flushActivity();
    expect(commits).toBe(afterSettle);
    await r.writer.close();
    await expect(r.writer.flushActivity()).resolves.toBeUndefined();
  });

  it('flushes the deferred announcement of an agent too and stamps the row of the agent', async () => {
    const r = rig({ throttle: createActivityThrottle() });
    await ingest(r, labSequence().slice(0, 7));
    const subagentTool = (n: number): HookEnvelopeV1 =>
      fixtureEnvelope('PreToolUse', {
        eventUid: uidOf(7000 + n),
        receivedAt: SEQUENCE_START + 8_000 + n,
        top: {
          tool_use_id: `toolu_agent_burst_${String(n)}`,
          prompt_id: PROMPT_ID,
          agent_id: SUBAGENT_ID,
          content_hash: hashOf(7000 + n),
        },
        data: { tool_name: 'Read', tool_summary: 'read FIXTURE', tool_input_hash: 'c'.repeat(32) },
      });
    // the first call changes the rule of the agent (an open tool): announced at once; the next ones only move its activity
    await ingest(r, [subagentTool(0)]);
    const mark = maxSeq(r.db);
    for (const n of [1, 2, 3]) await ingest(r, [subagentTool(n)]);
    expect(announced(r.db, 'agent', mark)).toBe(0);
    r.clock.advance(1000);
    await r.writer.flushActivity();
    expect(announced(r.db, 'agent', mark)).toBeGreaterThanOrEqual(1);
    const stamped = r.db.driver
      .prepare<{ updated_seq: number }>('SELECT updated_seq FROM agents WHERE agent_uid = ?')
      .get([SUBAGENT_ID]);
    expect(stamped?.updated_seq ?? 0).toBeGreaterThan(mark);
  });

  it('a flush that is queued when the writer closes resolves instead of failing', async () => {
    const r = rig({ throttle: createActivityThrottle() });
    await settle(r);
    for (const envelope of burst(3)) await ingest(r, [envelope]);
    r.clock.advance(1000);
    const flushing = r.writer.flushActivity();
    await r.writer.close();
    await expect(flushing).resolves.toBeUndefined();
  });
  it('the throttle changes neither the stats of the writer nor the counters of the health row', async () => {
    const plain = rig();
    const throttled = rig({ throttle: createActivityThrottle() });
    for (const r of [plain, throttled]) {
      await settle(r);
      for (const envelope of burst(20)) await ingest(r, [envelope]);
    }
    expect(throttled.writer.stats).toEqual(plain.writer.stats);
    expect(readCounters(throttled.db)).toEqual(readCounters(plain.db));
    const health = (db: InstanceDb): unknown =>
      db.driver.prepare('SELECT status, last_envelope_at, last_commit_at, counters_json FROM ingest_health').get();
    expect(health(throttled.db)).toEqual(health(plain.db));
    expect(dumpDatabase(throttled.db)['events']).toEqual(dumpDatabase(plain.db)['events']);
  });
});

describe('the project of a session (CAW design 03 2.5)', () => {
  const PROJECTS = '/home/me/.claude/projects';
  const BS = String.fromCharCode(92);
  const WORK = ['D:', 'Work', 'App'].join(BS);
  const fileIn = (dirName: string, uid: string = FIXTURE_SESSION_ID): string => `${PROJECTS}/${dirName}/${uid}.jsonl`;

  /** A hook of a session whose transcript lies in `dirName` and whose working directory is `cwd`. */
  function hookIn(
    dirName: string,
    cwd: string | null,
    over: { uid?: string; at?: number; eventUid?: string } = {},
  ): HookEnvelopeV1 {
    return fixtureEnvelope('UserPromptSubmit', {
      ...(over.eventUid === undefined ? {} : { eventUid: over.eventUid }),
      receivedAt: over.at ?? SEQUENCE_START,
      top: { session_id: over.uid ?? FIXTURE_SESSION_ID, transcript_path: fileIn(dirName, over.uid), cwd },
    });
  }

  /** The `session.seen` the importer sends for a main transcript file. */
  function transcriptSeen(sessionUid: string, path: string, cwd: string | undefined, at = SEQUENCE_START): IngestBatch {
    return {
      source: 'transcript',
      bytes: 100,
      items: [
        {
          kind: 'record',
          rows: [],
          events: [
            {
              k: 'session.seen',
              sessionId: sessionUid,
              stamp: { at, rank: 0, tie: `t:1:seen:${sessionUid}` },
              transcriptPath: path,
              ...(cwd === undefined ? {} : { cwd }),
            },
          ],
        },
      ],
    };
  }

  interface ProjectRow {
    project_key: string;
    dir_name: string;
    root_path: string | null;
  }

  const projectRows = (db: InstanceDb): ProjectRow[] =>
    db.driver.prepare<ProjectRow>('SELECT project_key, dir_name, root_path FROM projects ORDER BY id').all();

  const projectKeyOf = (db: InstanceDb, uid: string = FIXTURE_SESSION_ID): string | null | undefined =>
    db.driver
      .prepare<{ project_key: string | null }>(
        `SELECT p.project_key AS project_key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.session_uid = ?`,
      )
      .get([uid])?.project_key;

  const sessionChangesSince = (db: InstanceDb, since: number): number =>
    db.driver
      .prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE seq > ? AND kind = 'session'")
      .get([since])?.n ?? -1;

  it('is assigned from the hook: key lower-cased, the folder name as written, the working directory as the root', async () => {
    const r = rig();
    await ingest(r, [hookIn('D--Work-App', WORK)]);
    expect(projectKeyOf(r.db)).toBe('d--work-app');
    expect(projectRows(r.db)).toEqual([{ project_key: 'd--work-app', dir_name: 'D--Work-App', root_path: WORK }]);
  });

  it('is announced with the session that gets it, once: a second source for the same project announces nothing', async () => {
    const r = rig();
    await ingest(r, [hookIn('odd folder', WORK)]);
    expect(projectKeyOf(r.db)).toBeNull();
    const mark = maxSeq(r.db);
    const seen = transcriptSeen(FIXTURE_SESSION_ID, fileIn('D--Work-App'), WORK, SEQUENCE_START + 5);
    expect(r.writer.submit(seen)).toBe(true);
    await r.writer.flushNow();
    expect(projectKeyOf(r.db)).toBe('d--work-app');
    expect(sessionChangesSince(r.db, mark)).toBe(1);
    const stamped = r.db.driver
      .prepare<{ updated_seq: number }>('SELECT updated_seq FROM sessions WHERE session_uid = ?')
      .get([FIXTURE_SESSION_ID]);
    expect(stamped?.updated_seq).toBeGreaterThan(mark);
    // the same facts delivered again change and announce nothing
    const again = maxSeq(r.db);
    expect(r.writer.submit(seen)).toBe(true);
    await r.writer.flushNow();
    expect(sessionChangesSince(r.db, again)).toBe(0);
    expect(projectRows(r.db)).toHaveLength(1);
  });

  it('keeps the first project of a session: a later event from another folder changes nothing', async () => {
    const r = rig();
    await ingest(r, [hookIn('first-folder', '/work/first')]);
    await ingest(r, [hookIn('second-folder', '/work/second', { at: SEQUENCE_START + 10, eventUid: uidOf(9102) })]);
    expect(projectKeyOf(r.db)).toBe('first-folder');
    expect(projectRows(r.db).map((row) => row.project_key)).toEqual(['first-folder']);
  });

  it('gives no project for a folder name that is not a project name, and no project row', async () => {
    const r = rig();
    await ingest(r, [hookIn('odd folder', '/work/odd')]);
    await ingest(r, [hookIn('a.b', '/work/odd', { uid: SECOND_SESSION, eventUid: uidOf(9103) })]);
    expect(projectKeyOf(r.db)).toBeNull();
    expect(projectKeyOf(r.db, SECOND_SESSION)).toBeNull();
    expect(projectRows(r.db)).toEqual([]);
  });

  it('assigns the project later, when a later event has a usable path', async () => {
    const r = rig();
    await ingest(r, [hookIn('odd folder', '/work/odd')]);
    expect(projectKeyOf(r.db)).toBeNull();
    await ingest(r, [hookIn('fine-folder', '/work/fine', { at: SEQUENCE_START + 10, eventUid: uidOf(9104) })]);
    expect(projectKeyOf(r.db)).toBe('fine-folder');
  });

  it('agrees between the hook and the transcript: one project, whichever arrives first', async () => {
    for (const order of ['hook first', 'transcript first'] as const) {
      const r = rig();
      const transcript = transcriptSeen(FIXTURE_SESSION_ID, fileIn('D--Work-App'), WORK);
      if (order === 'hook first') {
        await ingest(r, [hookIn('D--Work-App', WORK)]);
        expect(r.writer.submit(transcript)).toBe(true);
      } else {
        expect(r.writer.submit(transcript)).toBe(true);
        await ingest(r, [hookIn('D--Work-App', WORK)]);
      }
      await r.writer.flushNow();
      expect(projectRows(r.db), order).toEqual([
        { project_key: 'd--work-app', dir_name: 'D--Work-App', root_path: WORK },
      ]);
      expect(projectKeyOf(r.db), order).toBe('d--work-app');
    }
  });

  it('treats the two spellings of a drive letter as one project and keeps the first folder name', async () => {
    const r = rig();
    await ingest(r, [hookIn('D--Work-App', WORK)]);
    expect(r.writer.submit(transcriptSeen(SECOND_SESSION, fileIn('d--Work-App', SECOND_SESSION), WORK))).toBe(true);
    await r.writer.flushNow();
    expect(projectRows(r.db)).toHaveLength(1);
    expect(projectRows(r.db)[0]?.dir_name).toBe('D--Work-App');
    expect(projectKeyOf(r.db, SECOND_SESSION)).toBe(projectKeyOf(r.db));
  });

  it('reads the path of a Windows hook as well as a POSIX one', async () => {
    const r = rig();
    const windowsPath = ['C:', 'Users', 'me', '.claude', 'projects', 'C--work-app', `${FIXTURE_SESSION_ID}.jsonl`].join(
      BS,
    );
    await ingest(r, [
      fixtureEnvelope('UserPromptSubmit', {
        top: { transcript_path: windowsPath, cwd: ['C:', 'work', 'app'].join(BS) },
      }),
    ]);
    expect(projectKeyOf(r.db)).toBe('c--work-app');
  });

  it('fills the root of a known project from a later session, and never replaces one it has', async () => {
    const r = rig();
    await ingest(r, [hookIn('shared-folder', null)]);
    expect(projectRows(r.db)[0]?.root_path).toBeNull();
    await ingest(r, [hookIn('shared-folder', '/work/shared', { uid: SECOND_SESSION, eventUid: uidOf(9105) })]);
    expect(projectRows(r.db)).toHaveLength(1);
    expect(projectRows(r.db)[0]?.root_path).toBe('/work/shared');
    const third = '88888888-8888-4888-8888-888888888888';
    await ingest(r, [hookIn('shared-folder', '/work/elsewhere', { uid: third, eventUid: uidOf(9106) })]);
    expect(projectRows(r.db)[0]?.root_path).toBe('/work/shared');
    expect(projectKeyOf(r.db, third)).toBe('shared-folder');
  });

  it('has no project for a session that only a record without a folder announced', async () => {
    const r = rig();
    expect(r.writer.submit(transcriptSeen(FIXTURE_SESSION_ID, 'no-folder.jsonl', undefined))).toBe(true);
    await r.writer.flushNow();
    expect(projectKeyOf(r.db)).toBeNull();
    expect(projectRows(r.db)).toEqual([]);
  });
});
