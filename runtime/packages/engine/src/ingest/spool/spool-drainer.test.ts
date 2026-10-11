// The spool drainer over real files, a real writer and a real database (02 2.7): T-PL-02, 03, 06, 07, 10, 11, 12.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spoolSegmentName, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { SpoolCursorsRepo } from '../../db/repos/spool-cursors.ts';
import {
  FIXTURE_INSTANCE_ID,
  SEQUENCE_START,
  hashOf,
  labSequence,
  uidOf,
} from '../../../test/fixtures/hook-sequences.ts';
import { fixtureEnvelope } from '../../../test/fixtures/hooks.ts';
import {
  appendEnvelopes,
  appendRaw,
  dumpDatabase,
  duplicatesSeen,
  envelopeLine,
  malformedSpoolLines,
  readCounters,
  replaceSegment,
} from '../../../test/fixtures/spool.ts';
import { SpoolSegmentNotFoundError } from '../errors.ts';
import { createIngestWriter, type IngestWriterHandle } from '../writer.ts';
import { createSpoolDrainer, type SpoolDrainer, type SpoolDrainerOptions } from './spool-drainer.ts';

const tempDir = useTempDirs();
const CTX = { instanceId: FIXTURE_INSTANCE_ID };
const SEGMENT_03 = 'hooks-20260102T03Z.ndjson';
const SEGMENT_04 = 'hooks-20260102T04Z.ndjson';

interface Rig {
  readonly db: InstanceDb;
  readonly spool: string;
  readonly clock: FakeClock;
  readonly writer: IngestWriterHandle;
  readonly drainer: SpoolDrainer;
}

const dbs: InstanceDb[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const db of dbs.splice(0)) db.close();
});

function rig(over: Partial<SpoolDrainerOptions> & { now?: number; queueMaxItems?: number; root?: string } = {}): Rig {
  const root = over.root ?? tempDir('drainer').path;
  const spool = join(root, 'data', 'spool');
  const clock = new FakeClock(over.now ?? SEQUENCE_START + 60_000);
  const db = openInstanceDb({
    path: join(root, 'monitor.db'),
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
    sleep: () => Promise.resolve(),
    ...(over.queueMaxItems === undefined ? {} : { queueMaxItems: over.queueMaxItems }),
  });
  const drainer = createSpoolDrainer({
    db,
    scope: CTX,
    instanceId: FIXTURE_INSTANCE_ID,
    spoolDir: spool,
    writer,
    clock,
    pollMs: 10_000,
    ...over,
  });
  closers.push(async () => {
    await drainer.stop();
    await writer.close();
  });
  return { db, spool, clock, writer, drainer };
}

/** `n` distinct notifications (their own uid and hash, one second apart): no two of them are duplicates of each other. */
function notifications(n: number, firstNumber: number, startAt: number): HookEnvelopeV1[] {
  return Array.from({ length: n }, (_, i) =>
    fixtureEnvelope('Notification', {
      eventUid: uidOf(firstNumber + i),
      receivedAt: startAt + i * 1000,
      top: { content_hash: hashOf(firstNumber + i) },
      data: { notification_type: 'idle_prompt', message_preview: 'FIXTURE ' + String(i) },
    }),
  );
}

function count(db: InstanceDb, table: string): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function errorCodes(db: InstanceDb): Record<string, number> {
  const rows = db.driver
    .prepare<{ code: string; n: number }>('SELECT code, count(*) AS n FROM ingest_errors GROUP BY code')
    .all();
  return Object.fromEntries(rows.map((row) => [row.code, row.n]));
}

describe('draining the spool', () => {
  it('reads every complete line of a segment into the database and moves the cursor to the end (T-PL-01 path)', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence());
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(27);
    expect(count(r.db, 'sessions')).toBe(1);
    const cursor = new SpoolCursorsRepo(r.db).get(CTX, SEGMENT_03);
    const size = r.drainer.stats().bytes;
    expect(cursor).toMatchObject({ offsetBytes: size, sizeSeen: size, lines: 27, partialBytes: 0, sealed: false });
    expect(r.drainer.isIdle()).toBe(true);
  });

  it('never consumes a line that is still being written, and takes it once it is complete', async () => {
    const r = rig();
    const [first, second] = labSequence();
    if (first === undefined || second === undefined) throw new Error('fixture');
    appendRaw(r.spool, SEGMENT_03, `${envelopeLine(first)}\n`);
    appendRaw(r.spool, SEGMENT_03, envelopeLine(second).slice(0, 40));
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(1);
    expect(new SpoolCursorsRepo(r.db).get(CTX, SEGMENT_03)?.partialBytes).toBe(40);
    appendRaw(r.spool, SEGMENT_03, `${envelopeLine(second).slice(40)}\n`);
    await r.drainer.drainNow();
    expect(count(r.db, 'events')).toBe(2);
    expect(errorCodes(r.db)).toEqual({});
  });

  it('a nudge schedules a pass without waiting for the poll', async () => {
    const r = rig({ pollMs: 3_600_000 });
    await r.drainer.start();
    appendEnvelopes(r.spool, labSequence().slice(0, 3));
    r.drainer.nudge();
    r.drainer.nudge();
    await r.drainer.drainNow();
    expect(count(r.db, 'events')).toBe(3);
    expect(r.drainer.stats().lastNudgeAt).not.toBeNull();
  });

  it('survives a restart: the cursor is where the last commit left it and nothing is read twice', async () => {
    const root = tempDir('drainer-restart').path;
    const first = rig({ root });
    appendEnvelopes(first.spool, labSequence().slice(0, 10));
    await first.drainer.start();
    await first.drainer.stop();
    await first.writer.close();
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);

    // the hook appends while the server is down; the new process reads only the new lines
    appendEnvelopes(first.spool, labSequence().slice(10));
    const second = rig({ root });
    await second.drainer.start();
    expect(count(second.db, 'events')).toBe(27);
    const counters = readCounters(second.db);
    expect(counters.envelopes).toBe(27);
    expect(counters.duplicates).toEqual({});
  });
});

describe('malformed input never crashes the drain (T-PL-07)', () => {
  it('counts each malformed case by code between valid lines, and ingests every valid line', async () => {
    const r = rig();
    const valid = labSequence();
    const bad = malformedSpoolLines(valid[0] ?? fixtureEnvelope('SessionStart'));
    mkdirSync(r.spool, { recursive: true });
    let index = 0;
    for (const line of bad) {
      const env = valid[index];
      if (env !== undefined) appendRaw(r.spool, SEGMENT_03, `${envelopeLine(env)}\n`);
      appendRaw(r.spool, SEGMENT_03, `${line.line}\n`);
      index += 1;
    }
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(bad.length);
    const expected: Record<string, number> = {};
    for (const line of bad) expected[line.code] = (expected[line.code] ?? 0) + 1;
    expect(errorCodes(r.db)).toEqual(expected);
    // by reference only: no line text reaches the table
    const details = r.db.driver.prepare<{ detail: string | null }>('SELECT detail FROM ingest_errors').all();
    for (const row of details) expect(row.detail ?? '').not.toContain('not json');
  });

  it('counts a line over the cap and a line that is not UTF-8, and goes on', async () => {
    const r = rig({ maxLineBytes: 2000 });
    const [a, b] = labSequence();
    if (a === undefined || b === undefined) throw new Error('fixture');
    appendRaw(r.spool, SEGMENT_03, `${envelopeLine(a)}\n`);
    appendRaw(r.spool, SEGMENT_03, `${'x'.repeat(5000)}\n`);
    appendRaw(
      r.spool,
      SEGMENT_03,
      Buffer.concat([Buffer.from('{"v":1,"bad":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]),
    );
    appendRaw(r.spool, SEGMENT_03, `${envelopeLine(b)}\n`);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(2);
    const codes = errorCodes(r.db);
    expect(codes['LINE_TOO_LONG']).toBe(1);
    expect(codes['UTF8_INVALID']).toBe(1);
  });
});

describe('foreign files (T-PL-12)', () => {
  it('never reads a file that is not a segment, and counts it in the spool stats', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence().slice(0, 2));
    writeFileSync(join(r.spool, 'notes.txt'), 'private notes');
    writeFileSync(join(r.spool, 'hooks-x.jsonl'), `${envelopeLine(labSequence()[2] ?? fixtureEnvelope('Stop'))}\n`);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(2);
    expect(r.drainer.stats().foreignFiles).toBe(2);
    expect(errorCodes(r.db)).toEqual({});
    expect(new SpoolCursorsRepo(r.db).list(CTX).map((row) => row.segment)).toEqual([SEGMENT_03]);
  });
});

describe('downtime evidence (T-PL-10)', () => {
  it('records one runtime_unavailable when the oldest unconsumed envelope is older than the start', async () => {
    const start = SEQUENCE_START + 10 * 60_000;
    const r = rig({ now: start });
    appendEnvelopes(r.spool, labSequence().slice(0, 4));
    await r.drainer.start();
    const rows = dumpDatabase(r.db)['reconciliations'];
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ scope_key: 'instance', kind: 'runtime_unavailable', at: start });
    expect(JSON.parse(String(rows?.[0]?.['detail']))).toEqual({ from: SEQUENCE_START, to: start, envelopes: 4 });
  });

  it('records nothing when the envelopes are recent, and not again at the next start', async () => {
    const root = tempDir('drainer-downtime').path;
    const recent = rig({ root, now: SEQUENCE_START + 2_000 });
    appendEnvelopes(recent.spool, labSequence().slice(0, 2));
    await recent.drainer.start();
    expect(dumpDatabase(recent.db)['reconciliations']).toEqual([]);
    await recent.drainer.stop();
    await recent.writer.close();
    recent.db.close();
    dbs.splice(dbs.indexOf(recent.db), 1);
    const later = rig({ root, now: SEQUENCE_START + 3_600_000 });
    await later.drainer.start();
    expect(dumpDatabase(later.db)['reconciliations']).toEqual([]);
  });
});

describe('segments, sealing and retention', () => {
  it('splits at the hour boundary, seals a read segment after the grace and deletes it after the retention', async () => {
    const r = rig({ sealGraceMs: 120_000, retainHours: 24, now: SEQUENCE_START + 60_000 });
    const before = fixtureEnvelope('Notification', {
      eventUid: '00000000-0000-4000-8000-0000000000c1',
      receivedAt: Date.UTC(2026, 0, 2, 3, 59, 59, 999),
      top: { content_hash: 'c1'.repeat(16) },
    });
    const after = fixtureEnvelope('Notification', {
      eventUid: '00000000-0000-4000-8000-0000000000c2',
      receivedAt: Date.UTC(2026, 0, 2, 4, 0, 0, 0),
      top: { content_hash: 'c2'.repeat(16) },
    });
    expect(spoolSegmentName(before.received_at)).toBe(SEGMENT_03);
    expect(spoolSegmentName(after.received_at)).toBe(SEGMENT_04);
    appendEnvelopes(r.spool, [before, after]);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(2);
    const cursors = new SpoolCursorsRepo(r.db);
    expect(cursors.list(CTX).map((row) => [row.segment, row.sealed])).toEqual([
      [SEGMENT_03, false],
      [SEGMENT_04, false],
    ]);

    // past the end of hour 03 plus the grace: segment 03 is sealed, 04 is not
    r.clock.set(Date.UTC(2026, 0, 2, 4, 2, 1));
    await r.drainer.drainNow();
    expect(cursors.list(CTX).map((row) => [row.segment, row.sealed])).toEqual([
      [SEGMENT_03, true],
      [SEGMENT_04, false],
    ]);

    // 24 hours after its hour: the sealed file and its cursor are gone
    r.clock.set(Date.UTC(2026, 0, 3, 4, 0, 1));
    await r.drainer.drainNow();
    expect(existsSync(join(r.spool, SEGMENT_03))).toBe(false);
    expect(cursors.list(CTX).map((row) => row.segment)).toEqual([SEGMENT_04]);
    expect(count(r.db, 'events')).toBe(2);
  });

  it('seals a segment with a torn tail once, as SPOOL_TORN_TAIL', async () => {
    const r = rig({ sealGraceMs: 10_000 });
    const [a] = labSequence();
    if (a === undefined) throw new Error('fixture');
    appendRaw(r.spool, SEGMENT_03, `${envelopeLine(a)}\n{"v":1,"kind":`);
    await r.drainer.start();
    r.clock.set(Date.UTC(2026, 0, 2, 4, 0, 11));
    await r.drainer.drainNow();
    r.clock.set(Date.UTC(2026, 0, 2, 4, 5, 0));
    await r.drainer.drainNow();
    expect(errorCodes(r.db)).toEqual({ SPOOL_TORN_TAIL: 1 });
    expect(new SpoolCursorsRepo(r.db).get(CTX, SEGMENT_03)?.sealed).toBe(true);
  });
});

describe('a replaced segment', () => {
  it('re-reads from byte 0 and records an identity_reset reconciliation', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence().slice(0, 5));
    await r.drainer.start();
    replaceSegment(r.spool, SEGMENT_03, `${envelopeLine(labSequence()[6] ?? fixtureEnvelope('Stop'))}\n`);
    await r.drainer.drainNow();
    const kinds = dumpDatabase(r.db)['reconciliations']?.map((row) => row['kind']);
    expect(kinds).toContain('identity_reset');
    expect(errorCodes(r.db)['IDENTITY_RESET']).toBe(1);
  });
});

describe('backpressure through the drainer (T-PL-06)', () => {
  it('ingests everything through a writer queue of 10 items', async () => {
    const r = rig({ queueMaxItems: 10, sliceMs: 1 });
    const many = notifications(150, 2000, SEQUENCE_START);
    appendEnvelopes(r.spool, many);
    await r.drainer.start();
    expect(count(r.db, 'events')).toBe(many.length);
    expect(r.writer.stats.queued).toBe(0);
  });
});

describe('replay (T-PL-03, T-PL-11)', () => {
  it('re-reads the segments from the start and adds no row, counting the duplicates', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence());
    await r.drainer.start();
    const before = dumpDatabase(r.db);
    const result = await r.drainer.replay(null);
    await r.drainer.drainNow();
    expect(result).toEqual({ segmentsReset: 1 });
    expect(dumpDatabase(r.db)).toEqual(before);
    expect(duplicatesSeen(r.db)).toBe(27);
  });

  it('an unknown segment is SPOOL_SEGMENT_NOT_FOUND and changes nothing', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence().slice(0, 2));
    await r.drainer.start();
    const before = dumpDatabase(r.db);
    await expect(r.drainer.replay('hooks-20250101T00Z.ndjson')).rejects.toThrow(SpoolSegmentNotFoundError);
    expect(dumpDatabase(r.db)).toEqual(before);
  });

  it('replays only the segments from `from` and leaves earlier cursors alone', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence().slice(0, 3));
    appendEnvelopes(r.spool, [
      fixtureEnvelope('Notification', {
        eventUid: '00000000-0000-4000-8000-0000000000d1',
        receivedAt: Date.UTC(2026, 0, 2, 4, 0, 5),
        top: { content_hash: 'd1'.repeat(16) },
      }),
    ]);
    await r.drainer.start();
    const result = await r.drainer.replay(SEGMENT_04);
    expect(result).toEqual({ segmentsReset: 1 });
    await r.drainer.drainNow();
    expect(count(r.db, 'events')).toBe(4);
  });

  it('a replay and a drain submitted together never run in one transaction', async () => {
    const r = rig();
    appendEnvelopes(r.spool, labSequence());
    await r.drainer.start();
    appendEnvelopes(r.spool, notifications(10, 500, SEQUENCE_START + 90_000));
    // the replay waits for the pass in progress and runs between two writer transactions
    const both = await Promise.all([r.drainer.drainNow(), r.drainer.replay(null)]);
    await r.drainer.drainNow();
    expect(both[1]).toEqual({ segmentsReset: 1 });
    expect(count(r.db, 'events')).toBe(37);
  });
});

describe('stop', () => {
  it('a drainer stopped in the middle of a drain and started again ingests every line exactly once', async () => {
    const lines = notifications(60, 3000, SEQUENCE_START);
    const reference = rig({ sliceMs: 1 });
    appendEnvelopes(reference.spool, lines);
    await reference.drainer.start();
    const expected = dumpDatabase(reference.db);
    const expectedCursor = new SpoolCursorsRepo(reference.db).get(CTX, SEGMENT_03);

    const r = rig({ sliceMs: 1 });
    appendEnvelopes(r.spool, lines);
    const submit = r.writer.submit.bind(r.writer);
    let refused = 0;
    const spy = vi.spyOn(r.writer, 'submit').mockImplementation((batch) => {
      if (refused === 0) {
        refused += 1;
        void r.drainer.stop();
        return false;
      }
      return submit(batch);
    });
    await r.drainer.drainNow();
    await r.drainer.stop();
    expect(refused).toBe(1);
    expect(count(r.db, 'events')).toBe(0);
    spy.mockRestore();

    await r.drainer.start();
    await r.drainer.drainNow();
    expect(count(r.db, 'events')).toBe(lines.length);
    expect(dumpDatabase(r.db)).toEqual(expected);
    expect(new SpoolCursorsRepo(r.db).get(CTX, SEGMENT_03)).toMatchObject({
      offsetBytes: expectedCursor?.offsetBytes,
      lines: expectedCursor?.lines,
    });
  });

  it('stops polling: after stop no timer is left and a line appended later stays in the spool', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = rig({ pollMs: 20 });
      await r.drainer.start();
      await r.drainer.stop();
      expect(vi.getTimerCount()).toBe(0);
      appendRaw(
        r.spool,
        SEGMENT_03,
        envelopeLine(labSequence()[0] ?? fixtureEnvelope('Stop')) + String.fromCharCode(10),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(count(r.db, 'events')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
