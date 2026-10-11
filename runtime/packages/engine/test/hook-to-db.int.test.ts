// The hook path to the database, end to end inside one process (02 4.9): envelope files in the spool, the real drainer, the real
// writer and a real database. T-PL-02 to T-PL-12 and the engine half of T-HK-06b. The handler process itself (real `claude`
// hooks, real stub) is WP-39's block at the end of this file.
//
// T-HK-06b: the refusal codes of the nudge route (bad Host, Origin, cross-site, content type, size, JSON, shape, instance
// mismatch) are asserted against the real route in `packages/server/test/ingest.int.test.ts` (DA-T-API-5); this file proves
// what the route does when it accepts: it only schedules a drain, coalesced, and never waits for it.
import { join } from 'node:path';

import { spoolSegmentName } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../src/db/open.ts';
import { SpoolCursorsRepo } from '../src/db/repos/spool-cursors.ts';
import { onCommitted } from '../src/db/write.ts';
import { SpoolSegmentNotFoundError } from '../src/ingest/errors.ts';
import { applySpoolReplay, planSpoolReplay } from '../src/ingest/spool/replay.ts';
import { createSpoolDrainer, type SpoolDrainer } from '../src/ingest/spool/spool-drainer.ts';
import { createIngestWriter, type IngestWriterHandle, type IngestWriterOptions } from '../src/ingest/writer.ts';
import {
  FIXTURE_INSTANCE_ID,
  SEQUENCE_START,
  hashOf,
  labSequence,
  shuffled,
  uidOf,
} from './fixtures/hook-sequences.ts';
import { fixtureEnvelope } from './fixtures/hooks.ts';
import {
  appendEnvelopes,
  appendRaw,
  dumpDatabase,
  duplicatesSeen,
  envelopeLine,
  malformedSpoolLines,
  readCounters,
} from './fixtures/spool.ts';

const tempDir = useTempDirs();
const CTX = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = SEQUENCE_START + 10 * 60_000;
const LAB_LINES = labSequence().length;

interface Rig {
  readonly root: string;
  readonly path: string;
  readonly spool: string;
  readonly clock: FakeClock;
  readonly db: InstanceDb;
  readonly writer: IngestWriterHandle;
  readonly drainer: SpoolDrainer;
  /** Simulates the end of the process: nothing queued is committed, the database is closed. */
  crash(): Promise<void>;
}

const open: Rig[] = [];
const extraDbs: InstanceDb[] = [];
afterEach(async () => {
  for (const rig of open.splice(0)) await rig.crash();
  for (const db of extraDbs.splice(0)) db.close();
});

function rig(
  over: {
    root?: string;
    now?: number;
    writer?: Partial<IngestWriterOptions>;
    pollMs?: number;
    sliceMs?: number;
    chunkBytes?: number;
    /** Called with the number of batches the writer has refused so far, after each refusal. */
    refusals?: (n: number) => void;
  } = {},
): Rig {
  const root = over.root ?? tempDir('hook-to-db').path;
  const path = join(root, 'monitor.db');
  const spool = join(root, 'data', 'spool');
  const clock = new FakeClock(over.now ?? NOW);
  const db = openInstanceDb({
    path,
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  const writer = createIngestWriter({
    db,
    scope: CTX,
    retryBaseMs: 1,
    retryMaxMs: 2,
    sleep: () => Promise.resolve(),
    ...over.writer,
  });
  let refused = 0;
  const watched: IngestWriterHandle = {
    ...writer,
    submit(batch) {
      const ok = writer.submit(batch);
      if (!ok) {
        refused += 1;
        over.refusals?.(refused);
      }
      return ok;
    },
  };
  const drainer = createSpoolDrainer({
    db,
    scope: CTX,
    instanceId: FIXTURE_INSTANCE_ID,
    spoolDir: spool,
    writer: watched,
    clock,
    pollMs: over.pollMs ?? 60_000,
    ...(over.sliceMs === undefined ? {} : { sliceMs: over.sliceMs }),
    ...(over.chunkBytes === undefined ? {} : { chunkBytes: over.chunkBytes }),
  });
  let crashed = false;
  const made: Rig = {
    root,
    path,
    spool,
    clock,
    db,
    writer,
    drainer,
    async crash() {
      if (crashed) return;
      crashed = true;
      await drainer.stop();
      await writer.close();
      db.close();
    },
  };
  open.push(made);
  return made;
}

function count(db: InstanceDb, table: string): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function notifications(n: number, firstNumber: number, startAt: number, stepMs = 1000) {
  return Array.from({ length: n }, (_, i) =>
    fixtureEnvelope('Notification', {
      eventUid: uidOf(firstNumber + i),
      receivedAt: startAt + i * stepMs,
      top: { content_hash: hashOf(firstNumber + i) },
      data: { notification_type: 'idle_prompt', message_preview: 'FIXTURE ' + String(i) },
    }),
  );
}

describe('T-PL-01 path: spool to rows', () => {
  it('the 27 events of the lab sequence end as one session with its tool calls, agent and turn', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence());
    await r.drainer.start();
    const dump = dumpDatabase(r.db);
    expect(dump['events']).toHaveLength(LAB_LINES);
    expect(dump['tool_calls']).toHaveLength(5);
    expect(dump['agents']).toHaveLength(2);
    expect(dump['turns']).toHaveLength(1);
    expect(r.db.driver.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()?.integrity_check).toBe(
      'ok',
    );
  });
});

describe('T-PL-02 idempotent drain', () => {
  it('draining the same segment twice, with a crash before COMMIT in between, gives one identical database', async () => {
    const reference = rig();
    appendEnvelopes(reference.spool, labSequence());
    await reference.drainer.start();
    const expected = dumpDatabase(reference.db);

    // first process: the transaction body runs, then the process dies before COMMIT
    const root = tempDir('hook-to-db-crash').path;
    let sawBody = 0;
    const first = rig({
      root,
      writer: {
        sleep: () => new Promise<void>(() => undefined),
        beforeCommit: () => {
          sawBody += 1;
          throw new Error('crash before COMMIT');
        },
      },
    });
    appendEnvelopes(first.spool, labSequence());
    void first.drainer.start();
    await waitFor(() => sawBody > 0, { what: 'the transaction body to run' });
    await first.crash();
    expect(sawBody).toBe(1);

    // second process: the cursor is where the last COMMIT left it (nowhere), so the whole segment is read again
    const second = rig({ root });
    await second.drainer.start();
    expect(dumpDatabase(second.db)).toEqual(expected);
    expect(duplicatesSeen(second.db)).toBe(0);

    // draining it once more (a replay) changes nothing and counts every line as a duplicate
    await second.drainer.replay(null);
    await second.drainer.drainNow();
    expect(dumpDatabase(second.db)).toEqual(expected);
    expect(duplicatesSeen(second.db)).toBe(LAB_LINES);
  });
});

describe('T-PL-03 replay over 3 segments', () => {
  it('adds no row', async () => {
    const r = rig();
    const hours = [0, 1, 2].map((h) => notifications(4, 100 + h * 10, Date.UTC(2026, 0, 2, 3 + h, 5, 0)));
    for (const envelopes of hours) appendEnvelopes(r.spool, envelopes);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(12);
    const before = dumpDatabase(r.db);
    await expect(r.drainer.replay(null)).resolves.toEqual({ segmentsReset: 3 });
    await r.drainer.drainNow();
    expect(dumpDatabase(r.db)).toEqual(before);
    expect(count(r.db, 'events')).toBe(12);
    expect(duplicatesSeen(r.db)).toBe(12);
  });
});

describe('T-PL-04 duplicate registration', () => {
  it('30 ms apart is one row, 3 s apart is two, the same tool call at any distance is one', async () => {
    const r = rig();
    const base = SEQUENCE_START;
    const same = (n: number, at: number) =>
      fixtureEnvelope('Notification', {
        eventUid: uidOf(900 + n),
        receivedAt: at,
        top: { content_hash: 'ee'.repeat(16) },
      });
    const tool = (n: number, at: number) =>
      fixtureEnvelope('PreToolUse', {
        eventUid: uidOf(950 + n),
        receivedAt: at,
        top: {
          content_hash: hashOf(950 + n),
          tool_use_id: 'toolu_dup_1',
          prompt_id: '33333333-3333-4333-8333-333333333333',
        },
        data: { tool_name: 'Bash' },
      });
    appendEnvelopes(r.spool, [
      same(1, base),
      same(2, base + 30),
      same(3, base + 3000),
      tool(1, base),
      tool(2, base + 3_000_000),
    ]);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(3);
    expect(count(r.db, 'tool_calls')).toBe(1);
    expect(duplicatesSeen(r.db)).toBe(2);
  });
});

describe('T-PL-05 persist before publish', () => {
  it('every head a listener sees is already visible to a second connection', async () => {
    const r = rig();
    const reader = openInstanceDb({
      path: r.path,
      expectedInstanceId: FIXTURE_INSTANCE_ID,
      mode: 'readonly',
      runtimeVersion: '3.0.0',
      clock: r.clock,
    });
    extraDbs.push(reader);
    const seen: { head: number; readerHead: number; cursor: number }[] = [];
    onCommitted(r.db, (head) => {
      seen.push({
        head,
        readerHead: reader.headSeq(),
        cursor: new SpoolCursorsRepo(reader).list(CTX).reduce((sum, row) => sum + row.offsetBytes, 0),
      });
    });
    appendEnvelopes(r.spool, labSequence());
    await r.drainer.start();
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry.readerHead).toBe(entry.head);
    // the cursor advanced in the transaction that was published, not later
    expect(seen[seen.length - 1]?.cursor).toBe(r.drainer.stats().bytes);
  });
});

describe('T-PL-06 backpressure', () => {
  it('300 lines through a queue of 5 items while the writer is retrying: the producer is refused, waits, and every line arrives', async () => {
    // the first transaction fails and the writer backs off; the drainer keeps reading until the queue is full
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = false;
    let refusals = 0;
    const r = rig({
      writer: {
        queueMaxItems: 5,
        sleep: () => gate,
        beforeCommit: () => {
          if (failed) return;
          failed = true;
          throw new Error('injected');
        },
      },
      sliceMs: 0,
      chunkBytes: 4096,
      refusals: (n) => {
        refusals = n;
        release();
      },
    });
    let max = 0;
    appendEnvelopes(r.spool, notifications(300, 3000, SEQUENCE_START, 100));
    const timer = setInterval(() => {
      max = Math.max(max, r.writer.stats.queued);
    }, 1);
    await r.drainer.start();
    clearInterval(timer);
    expect(count(r.db, 'events')).toBe(300);
    expect(refusals).toBeGreaterThan(0);
    // one line per batch: the queue stayed within its cap
    expect(max).toBeLessThanOrEqual(5);
    expect(r.writer.stats.queued).toBe(0);
  }, 60_000);
});

describe('T-PL-07 malformed input', () => {
  it('counts every malformed case between valid lines, ingests the valid ones and never throws', async () => {
    const r = rig();
    const valid = notifications(12, 4000, SEQUENCE_START);
    const bad = malformedSpoolLines(valid[0] ?? fixtureEnvelope('Notification'));
    appendRaw(r.spool, spoolSegmentName(SEQUENCE_START), '');
    let n = 0;
    for (const line of bad) {
      const env = valid[n];
      if (env !== undefined) appendRaw(r.spool, spoolSegmentName(SEQUENCE_START), `${envelopeLine(env)}\n`);
      appendRaw(r.spool, spoolSegmentName(SEQUENCE_START), `${line.line}\n`);
      n += 1;
    }
    appendRaw(r.spool, spoolSegmentName(SEQUENCE_START), '{"v":1,"kind":"hook","instance_id":');
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(bad.length);
    const expected: Record<string, number> = {};
    for (const line of bad) expected[line.code] = (expected[line.code] ?? 0) + 1;
    expect(readCounters(r.db).errors).toEqual(expected);
    // the torn last line is not an error yet: a writer may still be appending it
    expect(new SpoolCursorsRepo(r.db).list(CTX)[0]?.partialBytes).toBeGreaterThan(0);
  });
});

describe('T-PL-08 poison item', () => {
  it('one item that cannot be stored is isolated: PERSIST_FAILED once, every other line committed, the cursor at the end', async () => {
    const poison = uidOf(5002);
    const r = rig({
      writer: {
        beforeCommit: (_tx, batches) => {
          const hit = batches.some((batch) =>
            batch.items.some((item) => item.rows.some((row) => row.t === 'event' && row.row.eventUid === poison)),
          );
          if (hit) throw new Error('constraint violated');
        },
      },
    });
    appendEnvelopes(r.spool, notifications(9, 5000, SEQUENCE_START));
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(8);
    expect(readCounters(r.db).errors).toEqual({ PERSIST_FAILED: 1 });
    const cursor = new SpoolCursorsRepo(r.db).list(CTX)[0];
    expect(cursor?.offsetBytes).toBe(r.drainer.stats().bytes);
  });
});

describe('T-PL-09 out of order', () => {
  it('200 seeded shuffles of the lab sequence end in identical facts and views', async () => {
    const reference = rig();
    appendEnvelopes(reference.spool, labSequence());
    await reference.drainer.start();
    const expected = dumpDatabase(reference.db);
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = rig();
      appendEnvelopes(r.spool, shuffled(labSequence(), seed));
      await r.drainer.start();
      const dump = dumpDatabase(r.db);
      // the cursor rows hold byte offsets, which depend on the arrival order of the lines
      expect({ ...dump, spool_cursors: [] }, `seed ${String(seed)}`).toEqual({ ...expected, spool_cursors: [] });
      await r.crash();
    }
  }, 120_000);
});

describe('T-PL-10 downtime evidence', () => {
  it('envelopes 10 minutes older than the start produce one runtime_unavailable reconciliation, and a restart adds none', async () => {
    const root = tempDir('hook-to-db-downtime').path;
    const first = rig({ root, now: SEQUENCE_START + 10 * 60_000 });
    appendEnvelopes(first.spool, labSequence().slice(0, 5));
    await first.drainer.start();
    expect(dumpDatabase(first.db)['reconciliations']).toHaveLength(1);
    await first.crash();
    const second = rig({ root, now: SEQUENCE_START + 20 * 60_000 });
    await second.drainer.start();
    expect(dumpDatabase(second.db)['reconciliations']).toHaveLength(1);
  });
});

describe('T-PL-11 replay command semantics', () => {
  it('a dry run changes nothing, an unknown segment is SPOOL_SEGMENT_NOT_FOUND, the stopped path resets in one transaction', async () => {
    const r = rig();
    appendEnvelopes(r.spool, notifications(3, 6000, Date.UTC(2026, 0, 2, 3, 5, 0)));
    appendEnvelopes(r.spool, notifications(3, 6100, Date.UTC(2026, 0, 2, 4, 5, 0)));
    await r.drainer.start();
    await r.drainer.stop();
    const cursors = new SpoolCursorsRepo(r.db);
    const before = dumpDatabase(r.db);
    const headBefore = r.db.headSeq();

    const plan = await planSpoolReplay(CTX, { spoolCursors: cursors }, r.spool, null);
    expect(plan.segments).toHaveLength(2);
    expect(r.db.headSeq()).toBe(headBefore);
    expect(dumpDatabase(r.db)).toEqual(before);
    await expect(planSpoolReplay(CTX, { spoolCursors: cursors }, r.spool, 'hooks-20200101T00Z.ndjson')).rejects.toThrow(
      SpoolSegmentNotFoundError,
    );

    const published: number[] = [];
    onCommitted(r.db, (head) => published.push(head));
    expect(applySpoolReplay(r.db, CTX, plan)).toEqual({ segmentsReset: 2 });
    expect(published).toHaveLength(1);
    expect(cursors.list(CTX).map((row) => row.offsetBytes)).toEqual([0, 0]);
  });

  it('a running instance queues the replay behind a drain: they never share a transaction', async () => {
    const r = rig();
    appendEnvelopes(r.spool, notifications(40, 7000, SEQUENCE_START, 100));
    await r.drainer.start();
    appendEnvelopes(r.spool, notifications(40, 7100, SEQUENCE_START + 10_000, 100));
    const commits: string[] = [];
    onCommitted(r.db, () => commits.push('commit'));
    const [, replay] = await Promise.all([r.drainer.drainNow(), r.drainer.replay(null)]);
    await r.drainer.drainNow();
    expect(replay).toEqual({ segmentsReset: 1 });
    expect(count(r.db, 'events')).toBe(80);
    // the replay's reset is a transaction of its own
    expect(commits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('T-PL-12 foreign files', () => {
  it('a notes.txt and a hooks-x.jsonl in the spool are never read, and are counted', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence().slice(0, 2));
    appendRaw(r.spool, 'notes.txt', 'private');
    appendRaw(r.spool, 'hooks-x.jsonl', `${envelopeLine(labSequence()[3] ?? fixtureEnvelope('Stop'))}\n`);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(2);
    expect(r.drainer.stats().foreignFiles).toBe(2);
    expect(count(r.db, 'ingest_errors')).toBe(0);
  });
});

describe('adversarial: kill between append and drain, duplicate nudge plus replay, rotation', () => {
  it('lines appended while no server runs are ingested at the next start, exactly once', async () => {
    const root = tempDir('hook-to-db-kill').path;
    const first = rig({ root });
    appendEnvelopes(first.spool, labSequence().slice(0, 10));
    await first.drainer.start();
    await first.crash();
    appendEnvelopes(first.spool, labSequence().slice(10));
    const second = rig({ root });
    await second.drainer.start();
    expect(count(second.db, 'events')).toBe(LAB_LINES);
    expect(duplicatesSeen(second.db)).toBe(0);
  });

  it('T-HK-06b (engine half): a nudge only schedules a drain; two nudges and a replay add no row', async () => {
    const r = rig();
    await r.drainer.start();
    appendEnvelopes(r.spool, labSequence());
    r.drainer.nudge();
    r.drainer.nudge();
    await r.drainer.drainNow();
    expect(count(r.db, 'events')).toBe(LAB_LINES);
    const before = dumpDatabase(r.db);
    r.drainer.nudge();
    await r.drainer.replay(null);
    r.drainer.nudge();
    await r.drainer.drainNow();
    expect({ ...dumpDatabase(r.db), spool_cursors: [] }).toEqual({ ...before, spool_cursors: [] });
  });

  it('rotation at the hour boundary: the last millisecond of an hour and the first of the next land in two segments', async () => {
    const r = rig();
    const edge = Date.UTC(2026, 0, 2, 4, 0, 0, 0);
    appendEnvelopes(r.spool, [...notifications(1, 8000, edge - 1), ...notifications(1, 8001, edge)]);
    await r.drainer.start();
    expect(new SpoolCursorsRepo(r.db).list(CTX).map((row) => [row.segment, row.lines])).toEqual([
      ['hooks-20260102T03Z.ndjson', 1],
      ['hooks-20260102T04Z.ndjson', 1],
    ]);
    expect(count(r.db, 'events')).toBe(2);
  });
});

// @wp-begin WP-39
// @wp-end WP-39
