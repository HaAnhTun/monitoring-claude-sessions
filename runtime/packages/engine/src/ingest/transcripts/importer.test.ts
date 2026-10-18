// The transcript importer over a real database and the single ingest writer (02 5.5, 5.6, 5.9; T-TR-09, 10, 18, T-TK-09 and
// the behaviour around them): head, tail and backfill in that order, the cursors that survive a restart, resume copies,
// identity resets, backpressure, and two instances over overlapping files that must not see each other.
import { appendFileSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  FakeClock,
  CANARY,
  TranscriptBuilder,
  bigTranscript,
  buildClaudeHome,
  useTempDirs,
  type SessionSpec,
} from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../../test/fixtures/hook-sequences.ts';
import { dumpDatabase } from '../../../test/fixtures/spool.ts';
import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { ChangesRepo } from '../../db/repos/changes.ts';
import { SessionsRepo } from '../../db/repos/sessions.ts';
import { onCommitted, withWriteTx, type WriteTx } from '../../db/write.ts';
import { TranscriptFilesRepo, type TranscriptFileRow } from '../../db/repos/transcript-files.ts';
import { UsageRepo } from '../../db/repos/usage.ts';
import { aggregateInstance, aggregateSession } from '../../tokens/aggregate.ts';
import { legacyFileUsage } from '../../tokens/legacy-projection.ts';
import { createIngestWriter, type IngestBatch, type IngestWriterHandle } from '../writer.ts';
import type { SessionRule } from './classify.ts';
import {
  createTranscriptImporter,
  type ImportPhase,
  type ImportSettings,
  type TranscriptImporter,
} from './importer.ts';

const makeTemp = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 3_600_000;
const MIB = 1024 * 1024;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const AGENT = 'a1b2c3d4e5f6a7b8c';
const RUN = 'wf_fixture_run_1';
const WF_AGENT = 'wfagent0000000001';

interface Rig {
  readonly db: InstanceDb;
  readonly writer: IngestWriterHandle;
  readonly clock: FakeClock;
  readonly importer: TranscriptImporter;
  readonly root: string;
  readonly home: string;
  readonly tdir: string;
  readonly batches: IngestBatch[];
  /** The phases of the slices in the order they ran. */
  readonly phases: ImportPhase[];
}

interface RigOptions {
  readonly sessions?: SessionSpec[];
  readonly settings?: Partial<ImportSettings>;
  readonly rules?: SessionRule[];
  readonly pinned?: string[];
  readonly chunkBytes?: number;
  readonly maxLineBytes?: number;
  /** Reuse the folders and the database file of another rig (a restart of the same instance). */
  readonly of?: Rig;
  /** Another instance over the Claude home of this rig (its own workspace and database). */
  readonly homeFrom?: Rig;
  readonly accept?: () => boolean;
  /** The writer's test seam: called inside each writer transaction before COMMIT. */
  readonly beforeCommit?: (tx: WriteTx, batches: readonly IngestBatch[]) => void;
}

const dbs = new Set<InstanceDb>();
const writers = new Set<IngestWriterHandle>();
const importers = new Set<TranscriptImporter>();
afterEach(async () => {
  for (const importer of importers) importer.close();
  importers.clear();
  for (const writer of writers) await writer.close();
  writers.clear();
  for (const db of dbs) db.close();
  dbs.clear();
});

/** Stops an instance the way a server stop does, so that another one can open the same files. */
async function shutdown(r: Rig): Promise<void> {
  r.importer.close();
  importers.delete(r.importer);
  await r.writer.close();
  writers.delete(r.writer);
  r.db.close();
  dbs.delete(r.db);
}

function openDb(dbPath: string, clock: FakeClock): InstanceDb {
  const db = openInstanceDb({
    path: dbPath,
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.add(db);
  return db;
}

function rig(o: RigOptions = {}): Rig {
  const root = o.of?.root ?? makeTemp('importer').path;
  const home = o.homeFrom?.home ?? path.join(root, 'home');
  if (o.of === undefined && o.homeFrom === undefined) {
    buildClaudeHome(home, {
      nowMs: NOW,
      sessions: o.sessions ?? [
        {
          id: S1,
          project: 'p1',
          mtimeAgeMs: HOUR,
          build: (b) => b.user('first prompt').assistant({ messageId: 'm1' }),
        },
      ],
    });
  }
  const clock = o.of?.clock ?? new FakeClock(NOW);
  const db = openDb(path.join(root, 'monitor.db'), clock);
  const real = createIngestWriter({
    db,
    scope: SCOPE,
    retryBaseMs: 1,
    retryMaxMs: 2,
    sleep: () => Promise.resolve(),
    ...(o.beforeCommit === undefined ? {} : { beforeCommit: o.beforeCommit }),
  });
  const batches: IngestBatch[] = [];
  const drains: (() => void)[] = [];
  const writer: IngestWriterHandle = {
    ...real,
    onDrain(cb) {
      drains.push(cb);
      real.onDrain(cb);
    },
    submit(batch) {
      if (o.accept !== undefined && !o.accept()) {
        // what the real queue does when it has room again: tell the producer that was refused
        setImmediate(() => {
          for (const cb of drains) cb();
        });
        return false;
      }
      batches.push(batch);
      return real.submit(batch);
    },
  };
  writers.add(writer);
  const tdir = path.join(home, 'projects', 'p1');
  const importer = createTranscriptImporter({
    db,
    scope: SCOPE,
    writer,
    clock,
    transcriptsDir: tdir,
    settings: o.settings ?? {},
    rules: o.rules ?? [],
    pinned: o.pinned ?? [],
    ...(o.chunkBytes === undefined ? {} : { chunkBytes: o.chunkBytes }),
    ...(o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes }),
  });
  importers.add(importer);
  return { db, writer, clock, importer, root, home, tdir, batches, phases: [] };
}

/** Runs the importer as the scheduler would: highest priority first, until nothing is left, then waits for the writer. */
async function drain(r: Rig, limit = 1_000_000): Promise<void> {
  await r.importer.discover();
  for (let i = 0; i < limit; i += 1) {
    const next = r.importer.work()[0];
    if (next === undefined) break;
    r.phases.push(next.phase);
    await r.importer.runSlice(next, performance.now() + 50);
  }
  await r.writer.flushNow();
}

function file(r: Rig, session = S1): TranscriptFileRow {
  const row = new TranscriptFilesRepo(r.db).findByPathKey(
    SCOPE,
    path.join(r.tdir, `${session}.jsonl`).replaceAll('\\', '/').toLowerCase(),
  );
  if (row === undefined) throw new Error(`no file row for ${session}`);
  return row;
}

/** A file written by a test has the wall clock as its mtime: put it where the fixture clock says it is. */
function touch(target: string, ageMs = HOUR): void {
  const at = new Date(NOW - ageMs);
  utimesSync(target, at, at);
}

function put(r: Rig, session: string, builder: TranscriptBuilder, ageMs = HOUR): string {
  const target = path.join(r.tdir, `${session}.jsonl`);
  builder.write(target);
  touch(target, ageMs);
  return target;
}

type Row = Record<string, string | number | null>;

function rows(db: InstanceDb, sql: string): Row[] {
  return db.driver.prepare<Row>(sql).all();
}

function count(db: InstanceDb, table: string, where = '1 = 1'): number {
  return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get()?.n ?? -1;
}

function sessionRow(r: Rig, uid = S1) {
  const row = new SessionsRepo(r.db).byUid(SCOPE, uid);
  if (row === undefined) throw new Error(`no session ${uid}`);
  return row;
}

describe('the import of one session', () => {
  it('turns a transcript into a session with its rows, usage and the label of its first prompt', async () => {
    const r = rig({
      sessions: [
        {
          id: S1,
          project: 'p1',
          mtimeAgeMs: HOUR,
          build: (b) => {
            b.user('Fix the login bug');
            const call = b.toolUse('Bash', { command: 'echo FIXTURE' });
            b.toolResult(call);
            b.assistant({ messageId: 'msg_final', stop: 'end_turn' });
            b.turnEnd();
          },
        },
      ],
    });
    await drain(r);
    const session = sessionRow(r);
    expect(session).toMatchObject({ label: 'Fix the login bug', labelSource: 'first_prompt', matched: false });
    expect(session.cwd).toContain('FIXTURE-cwd');
    expect(count(r.db, 'events')).toBeGreaterThan(3);
    expect(count(r.db, 'tool_calls')).toBe(1);
    // the three assistant messages of the fixture: the tool call, the answer and the one that ends the turn
    expect(count(r.db, 'usage')).toBe(3);
    const row = file(r);
    expect(row).toMatchObject({ state: 'active', usageState: 'complete', kind: 'session' });
    expect(row.headEnd).toBeGreaterThan(0);
    expect(row.tailOffset).toBe(row.sizeSeen);
    expect(row.partialBytes).toBe(0);
    expect(row.sessionId).toBe(session.id);
    expect(session.transcriptFileId).toBe(row.id);
    expect(row.identityResets).toBe(0);
    expect(r.importer.stats().sliceFailures).toBe(0);
  });

  it('keeps the legacy columns: first timestamp, latest timestamp and the last stop reason', async () => {
    const r = rig({
      sessions: [
        {
          id: S1,
          project: 'p1',
          mtimeAgeMs: HOUR,
          startMs: NOW - 3 * HOUR,
          build: (b) => {
            b.user('first');
            b.assistant({ messageId: 'a', stop: 'tool_use' });
            b.assistant({ messageId: 'b', stop: 'end_turn' });
          },
        },
      ],
    });
    await drain(r);
    const usage = legacyFileUsage(r.db, SCOPE, file(r).id);
    expect(usage).toMatchObject({ first: new Date(NOW - 3 * HOUR).toISOString(), stop: 'end_turn', complete: true });
    expect(usage?.last).toBe(new Date(NOW - 3 * HOUR + 2000).toISOString());
  });

  it('counts the usage of the file the way the builder says it wrote it', async () => {
    const builder = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    builder.user('go');
    builder.assistant({ messageId: 'm_a', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11 } });
    builder.assistant({ messageId: 'm_b', usage: { input_tokens: 1, output_tokens: 2 }, snapshots: 3 });
    const r = rig({ sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }] });
    put(r, S1, builder);
    await drain(r);
    const totals = aggregateSession(r.db, SCOPE, sessionRow(r).id, 'total');
    expect(totals.sum.input).toBe(builder.usageTotals().input);
    expect(totals.sum.output).toBe(builder.usageTotals().output);
    expect(totals.sum.cacheRead).toBe(builder.usageTotals().cacheRead);
    expect(totals.messages).toBe(2);
  });
});

describe('the order and the completeness of the import (T-TR-09, T-TR-10)', () => {
  function bigRig(extra: Partial<RigOptions> = {}): { r: Rig; builder: TranscriptBuilder; sid: string } {
    const builder = bigTranscript({ sessionId: S1, targetBytes: 3.5 * MIB });
    const r = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
      settings: { tailWindowBytes: MIB, headMaxBytes: 16 * MIB },
      ...extra,
    });
    put(r, S1, builder);
    return { r, builder, sid: S1 };
  }

  it('reads the head, then the tail, then the backfill, and counts the same as a full scan', async () => {
    const { r, builder } = bigRig();
    await r.importer.discover();
    const seen: string[] = [];
    const states: { phase: string; row: TranscriptFileRow }[] = [];
    for (;;) {
      const next = r.importer.work()[0];
      if (next === undefined) break;
      seen.push(next.phase);
      await r.importer.runSlice(next, performance.now() + 50);
      await r.writer.flushNow();
      states.push({ phase: next.phase, row: file(r) });
    }
    // phases never go back: head* then tail* then backfill*
    const order = seen.filter((phase, i) => i === 0 || phase !== seen[i - 1]);
    expect(order).toEqual(['head', 'tail', 'backfill']);

    const afterHead = states.find((s) => s.phase === 'head' && s.row.headEnd > 0);
    expect(afterHead?.row.headEnd).toBeGreaterThan(0);
    expect(afterHead?.row.tailStart).toBeGreaterThan(afterHead?.row.headEnd ?? 0);
    expect(afterHead?.row.tailOffset).toBe(afterHead?.row.tailStart);
    expect(afterHead?.row.backfillOffset).toBe(afterHead?.row.headEnd);
    expect(afterHead?.row.usageState).toBe('partial');

    const lastTail = [...states].reverse().find((s) => s.phase === 'tail');
    expect(lastTail?.row.tailOffset).toBe(lastTail?.row.sizeSeen);
    // after the tail phase the latest state is there while the history is not: events partial, usage partial
    expect(lastTail?.row.backfillOffset).toBeLessThan(lastTail?.row.tailStart ?? 0);
    expect(lastTail?.row.usageState).toBe('partial');
    expect(legacyFileUsage(r.db, SCOPE, file(r).id)?.complete).toBe(true);

    for (const s of states) {
      const { headEnd, backfillOffset, tailStart, tailOffset, sizeSeen } = s.row;
      expect(0 <= headEnd && headEnd <= backfillOffset && backfillOffset <= tailStart).toBe(true);
      expect(tailStart <= tailOffset && tailOffset <= sizeSeen).toBe(true);
    }

    const done = file(r);
    expect(done.usageState).toBe('complete');
    expect(done.backfillOffset).toBe(done.tailStart);
    const totals = aggregateSession(r.db, SCOPE, sessionRow(r).id, 'total');
    expect(totals.complete).toBe(true);
    expect(totals.sum.input).toBe(builder.usageTotals().input);
    expect(totals.sum.output).toBe(builder.usageTotals().output);
    expect(totals.sum.cacheRead).toBe(builder.usageTotals().cacheRead);
    expect(totals.sum.cacheCreation).toBe(builder.usageTotals().cacheCreation);
  }, 60_000);

  it('reports the usage as partial while the backfill is pending', async () => {
    const { r } = bigRig();
    await r.importer.discover();
    for (;;) {
      const next = r.importer.work()[0];
      if (next === undefined || next.phase === 'backfill') break;
      await r.importer.runSlice(next, performance.now() + 50);
    }
    await r.writer.flushNow();
    const mid = aggregateSession(r.db, SCOPE, sessionRow(r).id, 'total');
    expect(mid.complete).toBe(false);
    expect(legacyFileUsage(r.db, SCOPE, file(r).id)).toMatchObject({ complete: false });
    expect(r.importer.stats().backfillRemainingBytes).toBeGreaterThan(0);
  }, 60_000);

  it('skips a backfill that is above the limit: usage skipped_backfill, shown as unavailable', async () => {
    const { r } = bigRig({ settings: { tailWindowBytes: MIB, backfillMaxBytes: MIB } });
    await drain(r);
    const row = file(r);
    expect(row.usageState).toBe('skipped_backfill');
    expect(row.backfillOffset).toBe(row.tailStart);
    expect(row.tailStart).toBeGreaterThan(row.headEnd);
    expect(legacyFileUsage(r.db, SCOPE, row.id)).toMatchObject({ complete: false, skipped: true, scanned_pct: 0 });
    expect(r.phases).not.toContain('backfill');
    expect(aggregateSession(r.db, SCOPE, sessionRow(r).id, 'total').complete).toBe(false);
  }, 60_000);

  it('has no backfill at all for a file that fits in the tail window', async () => {
    const r = rig({ settings: { tailWindowBytes: 8 * MIB } });
    await drain(r);
    expect(r.phases).not.toContain('backfill');
    expect(file(r)).toMatchObject({ usageState: 'complete' });
  });
});

describe('growth of a live file', () => {
  it('imports appended lines, and consumes a torn last line only when its LF arrives', async () => {
    const builder = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    builder.user('first').assistant({ messageId: 'm1' });
    const r = rig({ sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }] });
    const target = put(r, S1, builder);
    await drain(r);
    const before = count(r.db, 'events');

    const more = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'more' });
    more.user('second').assistant({ messageId: 'm2' });
    const lines = more.lines();
    const torn = (lines[1] ?? '').slice(0, 40);
    appendFileSync(target, `${lines[0] ?? ''}\n${torn}`);
    touch(target);
    await r.importer.statTick();
    await drain(r);
    const afterTorn = count(r.db, 'events');
    expect(afterTorn).toBeGreaterThan(before);
    expect(file(r).partialBytes).toBe(Buffer.byteLength(torn));

    appendFileSync(target, `${(lines[1] ?? '').slice(40)}\n`);
    touch(target);
    await r.importer.statTick();
    await drain(r);
    expect(count(r.db, 'events')).toBeGreaterThan(afterTorn);
    expect(file(r).partialBytes).toBe(0);
    expect(file(r).tailOffset).toBe(file(r).sizeSeen);
    expect(count(r.db, 'usage')).toBe(2);
  });

  it('takes a complete record without a line feed at once and does not read it twice', async () => {
    const r = rig();
    const target = path.join(r.tdir, `${S1}.jsonl`);
    await drain(r);
    const one = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'nolf' });
    one.user('no line feed');
    appendFileSync(target, one.lines().join('\n'));
    touch(target);
    await r.importer.statTick();
    await drain(r);
    const events = count(r.db, 'events');
    appendFileSync(target, '\n');
    touch(target);
    await r.importer.statTick();
    await drain(r);
    expect(count(r.db, 'events')).toBe(events);
  });

  it('announces the session and its agent again after the usage of a slice is committed (CR-LF-7-1)', async () => {
    const builder = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    builder.user('first').assistant({ messageId: 'm1', usage: { input_tokens: 5, output_tokens: 7 } });
    const r = rig({ sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }] });
    const target = put(r, S1, builder);
    await drain(r);

    const more = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'more' });
    more.user('second').assistant({ messageId: 'm2', usage: { input_tokens: 11, output_tokens: 13 } });
    appendFileSync(target, `${more.lines().join('\n')}\n`);
    touch(target);
    await r.importer.statTick();
    await drain(r);

    // the rollup of the new turn is committed, and the LAST announcement of the session and of its main agent comes after the
    // last usage change: a frame hydrated for it carries the committed totals (03 9.3, DA-I6)
    const session = sessionRow(r);
    const log = new ChangesRepo(r.db).since(SCOPE, 0, 10_000);
    const lastSeq = (kind: string, op: string): number =>
      Math.max(
        0,
        ...log.filter((row) => row.kind === kind && row.op === op && row.sessionUid === S1).map((row) => row.seq),
      );
    const lastUsage = lastSeq('usage', 'invalidate');
    expect(lastUsage).toBeGreaterThan(0);
    expect(lastSeq('session', 'upsert')).toBeGreaterThan(lastUsage);
    expect(lastSeq('agent', 'upsert')).toBeGreaterThan(lastUsage);
    // the entities carry the seq of that announcement, so a client that applies a patch only when it is newer takes the frame
    expect(session.updatedSeq).toBe(lastSeq('session', 'upsert'));
    const main = rows(
      r.db,
      `SELECT updated_seq AS seq, tok_output AS output FROM agents WHERE session_id = ${String(session.id)}`,
    );
    expect(main).toEqual([{ seq: lastSeq('agent', 'upsert'), output: 20 }]);
  });
});

describe('a restart', () => {
  it('continues from the persisted cursors, imports nothing twice and ends where one run ends', async () => {
    const builder = bigTranscript({ sessionId: S1, targetBytes: 2 * MIB });
    const base = (): Rig => {
      const r = rig({
        sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
        settings: { tailWindowBytes: MIB },
      });
      put(r, S1, builder);
      return r;
    };
    const whole = base();
    await drain(whole);
    const expected = dumpDatabase(whole.db);

    const first = base();
    await first.importer.discover();
    for (let i = 0; i < 12; i += 1) {
      const next = first.importer.work()[0];
      if (next === undefined) break;
      await first.importer.runSlice(next, performance.now() + 50);
    }
    await first.writer.flushNow();
    const mid = file(first);
    expect(mid.headEnd).toBeGreaterThan(0);
    await shutdown(first);

    // a second importer over the same database file and the same folders
    const second = rig({ of: first, settings: { tailWindowBytes: MIB } });
    await drain(second);
    const row = file(second);
    expect(row.usageState).toBe('complete');
    expect(row.headEnd).toBe(mid.headEnd);
    expect(row.tailStart).toBe(mid.tailStart);
    const got = dumpDatabase(second.db);
    expect(got['events']?.length).toBeGreaterThan(100);
    expect(got['events']).toEqual(expected['events']);
    expect(count(second.db, 'usage')).toBe(count(whole.db, 'usage'));
    expect(count(second.db, 'usage_files')).toBe(count(whole.db, 'usage_files'));
    expect(aggregateSession(second.db, SCOPE, sessionRow(second).id, 'total').sum).toEqual(
      aggregateSession(whole.db, SCOPE, sessionRow(whole).id, 'total').sum,
    );
  }, 60_000);

  it('does nothing when it is started again over a database that is already complete', async () => {
    const a = rig();
    await drain(a);
    const before = dumpDatabase(a.db);
    const usageBefore = count(a.db, 'usage');
    expect(usageBefore).toBe(1);
    await shutdown(a);
    const b = rig({ of: a });
    await drain(b);
    const after = dumpDatabase(b.db);
    expect(after['events']).toEqual(before['events']);
    expect(after['sessions']).toEqual(before['sessions']);
    expect(count(b.db, 'usage')).toBe(usageBefore);
    expect(b.phases).toEqual([]);
  });
  it('reads the known files again when the first read of them failed', async () => {
    const a = rig();
    await drain(a);
    await shutdown(a);
    const b = rig({ of: a });
    const read = vi.spyOn(TranscriptFilesRepo.prototype, 'listByStates').mockImplementationOnce(() => {
      throw new Error('database is busy');
    });
    try {
      expect(() => b.importer.work()).toThrow('database is busy');
      // the retry sees the file the first run imported, so it is not read as new
      await drain(b);
      expect(b.phases).toEqual([]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  });
});

describe('the label of a session (02 5.2)', () => {
  it('labels by rule, marks the session matched, and relabels when the rules change', async () => {
    const r = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: (b) => void b.user('Fix the login bug please') }],
      rules: [{ match: '^Fix the ([a-z]+) bug', label: 'bug of {1}' }],
    });
    await drain(r);
    expect(sessionRow(r)).toMatchObject({ label: 'bug of login', labelSource: 'rule', matched: true });
    expect(file(r).labelCache).toBe('bug of login');
    r.importer.setRules([{ match: 'please', label: 'polite' }], []);
    await r.importer.discover();
    expect(sessionRow(r)).toMatchObject({ label: 'polite', matched: true });
    r.importer.setRules([], [S1]);
    await r.importer.discover();
    expect(sessionRow(r)).toMatchObject({
      label: 'Fix the login bug please',
      matched: true,
      labelSource: 'first_prompt',
    });
  });

  it('keeps classifying while the head is still short, and stops when it holds 401 lines', async () => {
    const r = rig({ sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }] });
    const target = path.join(r.tdir, `${S1}.jsonl`);
    writeFileSync(target, '{"type":"system"}\n');
    touch(target);
    await drain(r);
    expect(sessionRow(r).label).toBe('(no prompt)');
    expect(file(r).classifiedLines).toBe(1);
    const b = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'late' });
    b.user('A late prompt');
    appendFileSync(target, `${b.lines().join('\n')}\n`);
    touch(target);
    await r.importer.statTick();
    await drain(r);
    expect(sessionRow(r).label).toBe('A late prompt');
    expect(file(r).classifiedLines).toBe(2);
  });
});

describe('subagents, workflows and the small files', () => {
  const sessions = (): SessionSpec[] => [
    {
      id: S1,
      project: 'p1',
      mtimeAgeMs: HOUR,
      build: (b) => void b.user('lead prompt').assistant({ messageId: 'lead_1' }),
      subagents: [
        {
          agentId: AGENT,
          meta: { agentType: 'general-purpose', description: 'FIXTURE agent task', model: 'claude-sonnet-5-5' },
          build: (b) => void b.user('agent prompt').assistant({ messageId: 'agent_1' }),
        },
        {
          agentId: WF_AGENT,
          meta: { agentType: 'workflow', workflowPhase: 'build' },
          build: (b) => void b.user('wf prompt').assistant({ messageId: 'wf_1' }),
        },
      ],
      workflow: { runId: RUN, finished: true, agents: [WF_AGENT] },
    },
  ];

  it('imports the agent files with their metadata, and attributes usage to the agent that wrote it', async () => {
    const r = rig({ sessions: sessions() });
    writeFileSync(path.join(r.tdir, S1, 'custom-title.json'), JSON.stringify({ customTitle: 'My title' }));
    await drain(r);
    const agents = new Map(
      rows(r.db, 'SELECT id, agent_uid, kind, agent_type, description, workflow_phase, model FROM agents').map((a) => [
        String(a['agent_uid']),
        a,
      ]),
    );
    expect(agents.get(AGENT)).toMatchObject({
      kind: 'subagent',
      agent_type: 'general-purpose',
      description: 'FIXTURE agent task',
      model: 'claude-sonnet-5-5',
    });
    expect(agents.get(WF_AGENT)).toMatchObject({
      kind: 'workflow_agent',
      agent_type: 'workflow',
      workflow_phase: 'build',
    });
    expect(agents.get('main')).toMatchObject({ kind: 'main' });
    const kinds = rows(r.db, 'SELECT kind, state FROM transcript_files ORDER BY kind');
    expect(kinds.map((f) => f['kind'])).toEqual([
      'session',
      'subagent',
      'workflow_agent',
      'workflow_journal',
      'workflow_status',
    ]);
    expect(kinds.every((f) => f['state'] === 'active')).toBe(true);
    const owner = new Map(
      rows(r.db, 'SELECT message_key, agent_id FROM usage').map((u) => [String(u['message_key']), u['agent_id']]),
    );
    expect(owner.get('agent_1')).toBe(agents.get(AGENT)?.['id']);
    expect(owner.get('wf_1')).toBe(agents.get(WF_AGENT)?.['id']);
    expect(owner.get('lead_1')).toBe(agents.get('main')?.['id']);
    expect(rows(r.db, 'SELECT title_custom FROM sessions')[0]).toMatchObject({ title_custom: 'My title' });
    expect(rows(r.db, 'SELECT run_uid, status_file FROM workflow_runs')).toHaveLength(1);
    expect(rows(r.db, 'SELECT run_uid FROM workflow_runs')[0]).toMatchObject({ run_uid: RUN });
    expect(r.importer.stats().sliceFailures).toBe(0);
    expect(r.importer.stats()).not.toHaveProperty('usageFailed');
  });

  it('links every file to its session, agent and run', async () => {
    const r = rig({ sessions: sessions() });
    await drain(r);
    const rows = new TranscriptFilesRepo(r.db).listForSession(SCOPE, S1);
    expect(rows).toHaveLength(5);
    for (const row of rows.filter((f) => f.kind !== 'workflow_status')) expect(row.sessionId).not.toBeNull();
    expect(rows.find((f) => f.kind === 'subagent')?.agentId).not.toBeNull();
    expect(rows.find((f) => f.kind === 'workflow_agent')?.workflowRunId).not.toBeNull();
  });
});

describe('resume copies (T-TR-18)', () => {
  function sessionOfFile(r: Rig, fileId: number): string | null {
    return new TranscriptFilesRepo(r.db).get(SCOPE, fileId)?.sessionUid ?? null;
  }

  it('records the occurrences, reports the copy once, and drops the activity of copied records', async () => {
    const original = new TranscriptBuilder({
      sessionId: S1,
      cwd: 'FIXTURE/x',
      startMs: NOW - 4 * HOUR,
      uuidSeed: 'resume',
    });
    original.user('original prompt').assistant({ messageId: 'orig_1' });
    original.toolResult(original.toolUse('Bash', { command: 'echo FIXTURE' }));
    const copy = new TranscriptBuilder({
      sessionId: S2,
      cwd: 'FIXTURE/x',
      startMs: NOW - 4 * HOUR,
      uuidSeed: 'resume',
    });
    copy.user('original prompt').assistant({ messageId: 'orig_1' });
    copy.toolResult(copy.toolUse('Bash', { command: 'echo FIXTURE' }));
    copy.user('a new prompt').assistant({ messageId: 'new_1' });

    const r = rig({ sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }] });
    put(r, S1, original);
    await drain(r);
    expect(count(r.db, 'entry_occurrences')).toBe(0);

    put(r, S2, copy, HOUR / 2);
    r.batches.length = 0;
    await drain(r);

    // each copied record that has an events row left an occurrence behind instead of a second row
    expect(count(r.db, 'entry_occurrences')).toBe(4);
    const copyRows = count(r.db, 'events', `file_id IN (SELECT id FROM transcript_files WHERE session_uid = '${S2}')`);
    expect(copyRows).toBe(2);
    const dump = dumpDatabase(r.db);
    const reconciliations = (dump['reconciliations'] ?? []).filter((x) => x['kind'] === 'copied_records');
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]).toMatchObject({ scope_key: S2 });
    expect(JSON.parse(String(reconciliations[0]?.['detail']))).toMatchObject({ source: S1, count: 4 });
    expect(sessionRow(r, S2)).toBeDefined();
    expect(
      r.db.driver
        .prepare<{ copied_from: string | null }>('SELECT copied_from FROM sessions WHERE session_uid = ?')
        .get([S2])?.copied_from,
    ).toBe(S1);

    // the copy was read again, but no activity was handed over for its copied records: only the two new ones have any
    const activity = r.batches
      .filter((b) => b.cursor?.kind === 'transcript' && sessionOfFile(r, b.cursor.fileId) === S2)
      .flatMap((b) => b.items)
      .flatMap((item) => item.events)
      .filter((e) => e.k === 'activity');
    expect(activity).toHaveLength(2);

    // the instance counts a message once, however many files hold it
    expect(aggregateInstance(r.db, SCOPE, {}).messages).toBe(original.usageByMessage().size + 1);
    expect(count(r.db, 'usage_files')).toBe(original.usageByMessage().size * 2 + 1);

    // reading the copy again changes nothing: the report is made once per change
    await r.importer.discover();
    await r.writer.flushNow();
    expect(count(r.db, 'reconciliations', "kind = 'copied_records'")).toBe(1);
  });
});

describe('two instances over overlapping files (T-TK-09)', () => {
  it('counts only the files each instance tracks', async () => {
    const sessions: SessionSpec[] = [
      { id: S1, project: 'p1', mtimeAgeMs: HOUR, build: (b) => void b.user('one').assistant({ messageId: 'one_1' }) },
      {
        id: S2,
        project: 'p1',
        mtimeAgeMs: 30 * HOUR,
        build: (b) => void b.user('two').assistant({ messageId: 'two_1' }),
      },
    ];
    const a = rig({ sessions });
    // instance B has its own workspace and database over the same Claude home, and pins the old session
    const b = rig({ homeFrom: a, pinned: [S2] });
    await drain(a);
    await drain(b);
    await drain(a);

    expect(count(a.db, 'sessions')).toBe(1);
    expect(count(b.db, 'sessions')).toBe(2);
    expect(count(a.db, 'transcript_files')).toBe(1);
    expect(count(b.db, 'transcript_files')).toBe(2);
    const totalA = aggregateInstance(a.db, SCOPE, {});
    const totalB = aggregateInstance(b.db, SCOPE, {});
    expect(totalA.messages).toBe(1);
    expect(totalB.messages).toBe(2);
    expect(
      a.db.driver.prepare<{ n: number }>("SELECT count(*) AS n FROM usage WHERE message_key = 'two_1'").get()?.n,
    ).toBe(0);
    // the file both instances track is counted in full by each of them
    expect(aggregateSession(a.db, SCOPE, sessionRow(a, S1).id, 'total').sum).toEqual(
      aggregateSession(b.db, SCOPE, sessionRow(b, S1).id, 'total').sum,
    );
    expect(dumpDatabase(a.db)['sessions']?.map((x) => x['session_uid'])).toEqual([S1]);
  });
});

describe('identity of a file (T-TR-07 at the importer level)', () => {
  it('starts again when the file was replaced, without counting its usage twice', async () => {
    const r = rig({
      sessions: [
        {
          id: S1,
          project: 'p1',
          mtimeAgeMs: HOUR,
          build: (b) => void b.user('before').assistant({ messageId: 'old_1' }).assistant({ messageId: 'old_2' }),
        },
      ],
    });
    await drain(r);
    expect(count(r.db, 'usage')).toBe(2);
    const target = path.join(r.tdir, `${S1}.jsonl`);
    const next = new TranscriptBuilder({
      sessionId: S1,
      cwd: 'FIXTURE/elsewhere',
      startMs: NOW - HOUR,
      uuidSeed: 'replaced',
    });
    next.user('after').assistant({ messageId: 'new_1' });
    rmSync(target);
    put(r, S1, next);
    await r.importer.statTick();
    await drain(r);
    const row = file(r);
    expect(row.identityResets).toBe(1);
    expect(count(r.db, 'usage')).toBe(1);
    expect(r.db.driver.prepare<{ message_key: string }>('SELECT message_key FROM usage').get()?.message_key).toBe(
      'new_1',
    );
    expect(count(r.db, 'reconciliations', "kind = 'identity_reset'")).toBe(1);
    expect(aggregateSession(r.db, SCOPE, sessionRow(r).id, 'total').messages).toBe(1);
  });

  it('starts again when the file was truncated', async () => {
    const r = rig();
    await drain(r);
    truncateSync(path.join(r.tdir, `${S1}.jsonl`), 10);
    touch(path.join(r.tdir, `${S1}.jsonl`));
    await r.importer.statTick();
    await drain(r);
    expect(file(r).identityResets).toBe(1);
    expect(file(r).tailOffset).toBeLessThanOrEqual(file(r).sizeSeen);
  });

  it('marks a missing file and goes on when it comes back', async () => {
    const r = rig();
    await drain(r);
    const target = path.join(r.tdir, `${S1}.jsonl`);
    rmSync(target);
    await r.importer.statTick();
    expect(file(r).state).toBe('missing');
    expect(r.importer.work()).toEqual([]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
    touch(target);
    await r.importer.statTick();
    expect(file(r).state).toBe('active');
  });
});

describe('malformed input never stops the import', () => {
  it('counts invalid lines, non-objects, bad shapes and oversized lines, and imports the rest', async () => {
    const b = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    b.user('valid before');
    b.invalidLine();
    b.raw({ type: 'user', message: { role: 'user', content: 'valid between' } });
    const r = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
      maxLineBytes: 4096,
    });
    const target = put(r, S1, b);
    appendFileSync(
      target,
      `[1,2]\n{"noType": true}\n"text"\n${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(10_000) } })}\n`,
    );
    appendFileSync(
      target,
      `${JSON.stringify({ type: 'user', timestamp: new Date(NOW - HOUR).toISOString(), message: { content: 'valid after' } })}\n`,
    );
    touch(target);
    await drain(r);
    const row = file(r);
    expect(row).toMatchObject({ invalidJson: 1, notObject: 2, shapeInvalid: 1, oversized: 1 });
    expect(count(r.db, 'events', "kind = 'prompt.submit'")).toBeGreaterThanOrEqual(2);
    expect(r.importer.stats().sliceFailures).toBe(0);
  });
});

describe('backpressure', () => {
  it('waits for the writer when its queue refuses a batch, and loses and duplicates nothing', async () => {
    const builder = bigTranscript({ sessionId: S1, targetBytes: MIB });
    let refuse = 40;
    const r = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
      settings: { tailWindowBytes: 4 * MIB },
      chunkBytes: 32 * 1024,
      accept: () => {
        if (refuse > 0) {
          refuse -= 1;
          // the real writer announces room through onDrain; a short timer inside the importer also wakes it
          return false;
        }
        return true;
      },
    });
    put(r, S1, builder);
    const reference = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
      settings: { tailWindowBytes: 4 * MIB },
      chunkBytes: 32 * 1024,
    });
    put(reference, S1, builder);
    await drain(reference);
    await drain(r);
    expect(refuse).toBe(0);
    expect(count(r.db, 'events')).toBe(count(reference.db, 'events'));
    expect(file(r).tailOffset).toBe(file(reference).tailOffset);
  }, 60_000);
});

describe('what the importer does not do', () => {
  it('never opens a session it is not told about (age policy) and tracks it once pinned', async () => {
    const sessions: SessionSpec[] = [
      { id: S1, project: 'p1', mtimeAgeMs: HOUR, build: (b) => void b.user('recent') },
      { id: S2, project: 'p1', mtimeAgeMs: 30 * HOUR, build: (b) => void b.user('old') },
    ];
    const r = rig({ sessions });
    await drain(r);
    expect(count(r.db, 'sessions')).toBe(1);
    r.importer.setRules([], [S2]);
    await drain(r);
    expect(count(r.db, 'sessions')).toBe(2);
    expect(sessionRow(r, S2)).toMatchObject({ matched: true });
  });

  it('answers a hint for one session at once', async () => {
    const sessions: SessionSpec[] = [
      { id: S2, project: 'p1', mtimeAgeMs: 30 * HOUR, build: (b) => void b.user('old') },
    ];
    const r = rig({ sessions });
    await drain(r);
    expect(count(r.db, 'sessions')).toBe(0);
    expect(await r.importer.discoverSession(S2)).toBe(true);
    expect(await r.importer.discoverSession(S3)).toBe(false);
    await drain(r);
    expect(count(r.db, 'sessions')).toBe(1);
  });
});

describe('slices, line numbers, tracking and the statistics', () => {
  function big(extra: Partial<RigOptions> = {}): Rig {
    const r = rig({
      sessions: [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }],
      settings: { tailWindowBytes: MIB },
      ...extra,
    });
    put(r, S1, bigTranscript({ sessionId: S1, targetBytes: 3 * MIB }));
    return r;
  }

  it('hands the parser at most one chunk per slice, so a slice cannot hold the event loop (02 5.4)', async () => {
    const r = big({ chunkBytes: 64 * 1024 });
    await r.importer.discover();
    let guard = 0;
    while (r.importer.work()[0]?.phase === 'head' && guard < 100) {
      guard += 1;
      const next = r.importer.work()[0];
      if (next !== undefined) await r.importer.runSlice(next, performance.now() + 50);
    }
    await r.writer.flushNow();
    let largest = 0;
    for (let i = 0; i < 20; i += 1) {
      const next = r.importer.work()[0];
      if (next?.phase !== 'tail') break;
      const before = file(r).tailOffset;
      await r.importer.runSlice(next, performance.now() + 50);
      await r.writer.flushNow();
      largest = Math.max(largest, file(r).tailOffset - before);
    }
    expect(largest).toBeGreaterThan(0);
    // the slice stops after the line that reaches the chunk size: at most one line over (the fixture lines are about 1.5 KB)
    expect(largest).toBeLessThanOrEqual(64 * 1024 + 4096);
  });

  it('knows the line numbers of the head and stores none for ranges whose lines were not counted', async () => {
    const r = big();
    await drain(r);
    const row = file(r);
    const rowsOf = (where: string): Row[] =>
      rows(r.db, `SELECT line_no, byte_offset FROM events WHERE file_id = ${String(row.id)} AND ${where}`);
    const head = rowsOf(`byte_offset < ${String(row.headEnd)}`);
    expect(head.length).toBeGreaterThan(100);
    expect(head.every((e) => typeof e['line_no'] === 'number' && e['line_no'] >= 1 && e['line_no'] <= 401)).toBe(true);
    const later = rowsOf(`byte_offset >= ${String(row.headEnd)}`);
    expect(later.length).toBeGreaterThan(100);
    expect(later.every((e) => e['line_no'] === null)).toBe(true);
  });

  it('counts the bytes that are behind, and has nothing behind once it caught up', async () => {
    const r = rig();
    await drain(r);
    await r.importer.statTick();
    expect(r.importer.stats()).toMatchObject({
      filesTracked: 1,
      bytesBehind: 0,
      backfillRemainingBytes: 0,
      maxLagMs: 0,
    });
    expect(r.importer.stats().lastSyncAt).not.toBeNull();
    const target = path.join(r.tdir, `${S1}.jsonl`);
    const more = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'behind' });
    more.user('behind');
    const text = `${more.lines().join('\n')}\n`;
    appendFileSync(target, text);
    touch(target);
    await r.importer.statTick();
    expect(r.importer.stats().bytesBehind).toBe(Buffer.byteLength(text));
    expect(r.importer.isIdle()).toBe(false);
    await drain(r);
    expect(r.importer.stats().bytesBehind).toBe(0);
    expect(r.importer.isIdle()).toBe(true);
  });

  it('untracks a file that did not grow for 48 hours once its session is over, and tracks it again when it moves', async () => {
    const r = rig();
    await drain(r);
    r.db.driver.prepare("UPDATE sessions SET state = 'completed'").run();
    r.clock.advance(49 * HOUR);
    await r.importer.discover();
    expect(file(r).state).toBe('untracked');
    expect(r.importer.stats().filesTracked).toBe(0);
    expect(r.importer.work()).toEqual([]);

    const target = path.join(r.tdir, `${S1}.jsonl`);
    const more = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: r.clock.now(), uuidSeed: 'again' });
    more.user('back again');
    appendFileSync(target, `${more.lines().join('\n')}\n`);
    utimesSync(target, new Date(r.clock.now() - 1000), new Date(r.clock.now() - 1000));
    await drain(r);
    expect(file(r).state).toBe('active');
    expect(count(r.db, 'events', "kind = 'prompt.submit'")).toBe(2);
  });

  it('does not untrack a file whose session is still running', async () => {
    const r = rig();
    await drain(r);
    r.clock.advance(49 * HOUR);
    await r.importer.discover();
    expect(file(r).state).toBe('active');
  });

  it('tracks an old session that has hook events', async () => {
    const r = rig({
      sessions: [{ id: S2, project: 'p1', mtimeAgeMs: 30 * HOUR, build: (b) => void b.user('old but hooked') }],
    });
    await drain(r);
    expect(count(r.db, 'sessions')).toBe(0);
    withWriteTx(r.db, SCOPE, (tx) => {
      new SessionsRepo(r.db).ensure(SCOPE, tx, { sessionUid: S2, projectId: null, startedAt: NOW - 30 * HOUR });
    });
    r.db.driver.prepare('UPDATE sessions SET last_hook_at = ? WHERE session_uid = ?').run([NOW - HOUR, S2]);
    await drain(r);
    expect(count(r.db, 'transcript_files')).toBe(1);
    expect(sessionRow(r, S2)).toMatchObject({ label: 'old but hooked' });
    // the row that the hooks made already is linked at once and the file points back at it
    expect(file(r, S2).sessionId).toBe(sessionRow(r, S2).id);
  });

  it('never reads a .key file: nothing of it reaches the database or the list of tracked files', async () => {
    const r = rig();
    for (const dir of [r.tdir, path.join(r.tdir, S1, 'subagents')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'decoy.key'), CANARY.key);
      writeFileSync(path.join(dir, `${S1}.key`), CANARY.key);
    }
    await drain(r);
    const paths = rows(r.db, 'SELECT path FROM transcript_files').map((f) => String(f['path']));
    expect(paths.some((x) => x.endsWith('.key'))).toBe(false);
    const everything =
      JSON.stringify(dumpDatabase(r.db)) + JSON.stringify(rows(r.db, 'SELECT * FROM transcript_files'));
    expect(everything).not.toContain(CANARY.key);
  });
});

describe('usage rides in the batch of its slice (WP-98, ADR 0015)', () => {
  const ONE_FILE: SessionSpec[] = [{ id: S1, project: 'p1', mtimeAgeMs: HOUR, build: () => undefined }];

  function twoTurns(): TranscriptBuilder {
    const b = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    b.user('first').assistant({ messageId: 'm1', usage: { input_tokens: 5, output_tokens: 7 } });
    b.user('second').assistant({ messageId: 'm2', usage: { input_tokens: 11, output_tokens: 13 } });
    return b;
  }

  function tokens(db: InstanceDb): Row[] {
    return rows(db, 'SELECT session_uid, tok_input, tok_output FROM sessions ORDER BY session_uid');
  }

  it('hands the usage rows to the writer with the cursor, after the record items, and writes no usage outside the writer', async () => {
    let inWriter = false;
    const r = rig({
      sessions: ONE_FILE,
      beforeCommit: () => {
        inWriter = true;
      },
    });
    let last = 0;
    let outside = 0;
    onCommitted(r.db, () => {
      const n = count(r.db, 'usage_files');
      if (!inWriter && n !== last) outside += 1;
      last = n;
      inWriter = false;
    });
    put(r, S1, twoTurns());
    await drain(r);
    const carrying = r.batches.filter((b) => b.items.some((item) => item.rows.some((row) => row.t === 'usage')));
    expect(carrying.length).toBeGreaterThan(0);
    for (const batch of carrying) {
      expect(batch.cursor?.kind).toBe('transcript');
      const firstUsage = batch.items.findIndex((item) => item.rows.some((row) => row.t === 'usage'));
      // the usage items close the batch: no record item follows them, and they carry no events
      expect(batch.items.slice(firstUsage).every((item) => item.events.length === 0)).toBe(true);
      expect(batch.items.slice(firstUsage).every((item) => item.rows.every((row) => row.t === 'usage'))).toBe(true);
    }
    expect(count(r.db, 'usage_files')).toBe(2);
    expect(outside).toBe(0);
    expect(r.importer.stats()).not.toHaveProperty('usageFailed');
  });

  it('a hard kill right after the commit of a slice loses no usage: the restart ends with the totals of an undisturbed run', async () => {
    const whole = rig({ sessions: ONE_FILE });
    put(whole, S1, twoTurns());
    await drain(whole);
    const expected = tokens(whole.db);
    expect(expected).toEqual([{ session_uid: S1, tok_input: 16, tok_output: 20 }]);

    let armed = false;
    let killed = false;
    const first = rig({
      sessions: ONE_FILE,
      beforeCommit: (_tx, batches) => {
        if (batches.some((b) => b.cursor?.kind === 'transcript' && (b.cursor.cursor.headEnd ?? 0) > 0)) armed = true;
      },
    });
    // the process dies at the instant the writer committed the head slice: nothing after that commit runs
    onCommitted(first.db, () => {
      if (armed && !killed) {
        killed = true;
        first.db.close();
      }
    });
    put(first, S1, twoTurns());
    await first.importer.discover();
    // read through a call: the listener sets the flag behind the back of the narrowing
    const isKilled = (): boolean => killed;
    for (let i = 0; i < 20 && !isKilled(); i += 1) {
      const next = first.importer.work()[0];
      if (next === undefined) break;
      await first.importer.runSlice(next, performance.now() + 50);
      await first.writer.flushNow();
    }
    expect(isKilled()).toBe(true);
    first.importer.close();
    importers.delete(first.importer);
    await first.writer.close();
    writers.delete(first.writer);
    dbs.delete(first.db);

    const second = rig({ of: first });
    await drain(second);
    expect(tokens(second.db)).toEqual(expected);
    expect(new UsageRepo(second.db).verifyRollups(SCOPE)).toEqual([]);
  });
});
