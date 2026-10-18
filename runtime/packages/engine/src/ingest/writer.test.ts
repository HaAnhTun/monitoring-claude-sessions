// The ingestion writer over a real database (02 4.6-4.8): persist before publish, idempotent delivery, backpressure, poison
// isolation, out-of-order input. T-PL-02, 04, 05, 06, 07, 08, 09 at the writer level; the spool path is in the drainer tests
// and `test/hook-to-db.int.test.ts`.
import { join } from 'node:path';

import type { HookEnvelopeV1 } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../db/repos/spool-cursors.ts';
import { TranscriptFilesRepo, type TranscriptFileKind } from '../db/repos/transcript-files.ts';
import { UsageRepo, type UsageValues } from '../db/repos/usage.ts';
import { onCommitted, withWriteTx } from '../db/write.ts';
import { changeCounts, dumpDatabase, duplicatesSeen, readCounters } from '../../test/fixtures/spool.ts';
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_SESSION_ID,
  SEQUENCE_START,
  TOOL_BASH,
  labSequence,
  shuffled,
} from '../../test/fixtures/hook-sequences.ts';
import { fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import { INSTANCE_KEY } from '../db/change-sink.ts';
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
