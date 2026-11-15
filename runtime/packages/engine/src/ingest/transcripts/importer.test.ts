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
  makeJunction,
  useTempDirs,
  type SessionSpec,
} from '@mcs/testkit';
import { routeKey } from '@mcs/shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../../test/fixtures/hook-sequences.ts';
import { dumpDatabase } from '../../../test/fixtures/spool.ts';
import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { ChangesRepo } from '../../db/repos/changes.ts';
import { SessionsRepo } from '../../db/repos/sessions.ts';
import { onCommitted, withWriteTx, type WriteTx } from '../../db/write.ts';
import { TranscriptFilesRepo, type TranscriptFileRow } from '../../db/repos/transcript-files.ts';
import { UsageRepo } from '../../db/repos/usage.ts';
import type { Logger } from '../../log/logger.ts';
import { aggregateInstance, aggregateSession } from '../../tokens/aggregate.ts';
import { legacyFileUsage } from '../../tokens/legacy-projection.ts';
import { createIngestWriter, type IngestBatch, type IngestWriterHandle } from '../writer.ts';
import type { SessionRule } from './classify.ts';
import { nodeDiscoveryFs, type DiscoveryFs } from './discovery.ts';
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
  /** `all`: the importer reads every folder below `<home>/projects` (CAW design 03 2.2); the default is the one folder `p1`. */
  readonly projectScope?: 'all';
  readonly fullSweepIntervalMs?: number;
  readonly coldStatIntervalMs?: number;
  /** The file system the importer looks through (a recorder, a fake). */
  readonly fs?: DiscoveryFs;
  readonly logger?: Logger;
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
    transcriptsDir: o.projectScope === 'all' ? null : tdir,
    ...(o.projectScope === undefined
      ? {}
      : { projectScope: o.projectScope, projectsRoot: path.join(home, 'projects') }),
    ...(o.fullSweepIntervalMs === undefined ? {} : { fullSweepIntervalMs: o.fullSweepIntervalMs }),
    ...(o.coldStatIntervalMs === undefined ? {} : { coldStatIntervalMs: o.coldStatIntervalMs }),
    ...(o.fs === undefined ? {} : { fs: o.fs }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
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
    // the importer keys files by routeKey: lower-cased on Windows only (POSIX names are case-sensitive)
    routeKey(path.join(r.tdir, `${session}.jsonl`)),
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

// ---- scope all: every project folder below the Claude home (CAW design 03 2.2 to 2.4) -------------------------------------------

describe('scope all', () => {
  const ALPHA = 'D--work-alpha';
  const BETA = 'D--work-beta';
  const GAMMA = 'D--work-gamma';
  const ALPHA_CWD = 'D:/work/alpha';
  const BETA_CWD = 'D:/work/beta';
  const GAMMA_CWD = 'D:/work/gamma';
  const S4 = '44444444-4444-4444-8444-444444444444';
  const S5 = '55555555-5555-4555-8555-555555555555';
  const MIN = 60_000;

  const session = (id: string, project: string, cwd: string, mtimeAgeMs: number, prompt = 'a prompt'): SessionSpec => ({
    id,
    project,
    cwd,
    mtimeAgeMs,
    build: (b) => void b.user(prompt).assistant({ messageId: `msg_${id.slice(0, 4)}` }),
  });

  /** Three projects: a recent session in alpha and beta, and in gamma one that is older than the look-back window. */
  function threeProjects(o: RigOptions = {}): Rig {
    return rig({
      projectScope: 'all',
      sessions: [
        session(S1, ALPHA, ALPHA_CWD, HOUR),
        session(S2, BETA, BETA_CWD, 2 * HOUR),
        session(S3, GAMMA, GAMMA_CWD, 30 * HOUR),
      ],
      ...o,
    });
  }

  const projectDir = (r: Rig, name: string): string => path.join(r.home, 'projects', name);

  /** A directory modification time that two looks read as the same number (a plain millisecond value). */
  function pinDir(dir: string, ms: number): void {
    utimesSync(dir, new Date(ms), new Date(ms));
  }

  function addSession(r: Rig, project: string, id: string, cwd: string, ageMs = HOUR): string {
    const target = path.join(projectDir(r, project), `${id}.jsonl`);
    new TranscriptBuilder({ sessionId: id, cwd, startMs: NOW - ageMs - MIN })
      .user('a new prompt')
      .assistant({ messageId: `msg_${id.slice(0, 4)}` })
      .write(target);
    touch(target, ageMs);
    return target;
  }

  const tracked = (r: Rig, id: string): number => count(r.db, 'transcript_files', `session_uid = '${id}'`);

  /** A file system that notes the folders it was asked to list and every path it was asked about. */
  function recorder(): { fs: DiscoveryFs; listed: string[]; touched: string[] } {
    const listed: string[] = [];
    const touched: string[] = [];
    const fs: DiscoveryFs = {
      readdir: (dir) => {
        listed.push(dir);
        touched.push(dir);
        return nodeDiscoveryFs.readdir(dir);
      },
      lstat: (file) => {
        touched.push(file);
        return nodeDiscoveryFs.lstat(file);
      },
      readText: (file, max) => nodeDiscoveryFs.readText(file, max),
      readHead: (file, max) => nodeDiscoveryFs.readHead(file, max),
    };
    return { fs, listed, touched };
  }

  it('tracks the sessions inside the window of every project and not the older one, and reports what it looked at', async () => {
    const r = threeProjects();
    const summary = await r.importer.discover();
    expect(summary).toMatchObject({
      sessions: 2,
      newFiles: 2,
      missingDir: false,
      folders: 3,
      truncatedFolders: 0,
      symlinksSkipped: 0,
    });
    expect([tracked(r, S1), tracked(r, S2), tracked(r, S3)]).toEqual([1, 1, 0]);
  });

  it('imports the sessions of every project, with their own working directories and labels', async () => {
    const r = threeProjects();
    await drain(r);
    expect(sessionRow(r, S1)).toMatchObject({ label: 'a prompt', labelSource: 'first_prompt' });
    expect(sessionRow(r, S1).cwd).toBe(ALPHA_CWD);
    expect(sessionRow(r, S2).cwd).toBe(BETA_CWD);
  });

  it('looks into the folders newest first', async () => {
    const r = rig({
      projectScope: 'all',
      sessions: [
        session(S1, ALPHA, ALPHA_CWD, HOUR),
        session(S2, BETA, BETA_CWD, HOUR),
        session(S3, GAMMA, GAMMA_CWD, HOUR),
      ],
    });
    pinDir(projectDir(r, ALPHA), NOW - 3 * HOUR);
    pinDir(projectDir(r, BETA), NOW - MIN);
    pinDir(projectDir(r, GAMMA), NOW - HOUR);
    await r.importer.discover();
    const order = rows(r.db, 'SELECT session_uid FROM transcript_files ORDER BY id').map((row) => row['session_uid']);
    expect(order).toEqual([S2, S3, S1]);
  });

  it('on a quiet tick looks only into the folders that hold an active file, and the root', async () => {
    const spy = recorder();
    const r = threeProjects({ fs: spy.fs });
    await r.importer.discover();
    spy.listed.length = 0;
    await r.importer.discover();
    expect(spy.listed).toContain(path.join(r.home, 'projects'));
    expect(spy.listed).toContain(projectDir(r, ALPHA));
    expect(spy.listed).toContain(projectDir(r, BETA));
    // gamma holds only a session older than the window: nothing in it is tracked, so it is not hot
    expect(spy.listed).not.toContain(projectDir(r, GAMMA));
  });

  it('finds a new session file in a quiet folder within one tick, because the folder changed', async () => {
    const r = threeProjects();
    pinDir(projectDir(r, GAMMA), NOW - 40 * HOUR);
    await r.importer.discover();
    addSession(r, GAMMA, S4, GAMMA_CWD);
    pinDir(projectDir(r, GAMMA), NOW - HOUR);
    expect(await r.importer.discover()).toMatchObject({ newFiles: 1 });
    expect(tracked(r, S4)).toBe(1);
  });

  it('finds a project folder that did not exist before within one tick', async () => {
    const r = threeProjects();
    await r.importer.discover();
    mkdirSync(projectDir(r, 'D--work-delta'));
    addSession(r, 'D--work-delta', S5, 'D:/work/delta');
    const summary = await r.importer.discover();
    expect(summary.newFiles).toBe(1);
    expect(tracked(r, S5)).toBe(1);
  });

  it('finds an old file that grew only by the full sweep, which comes once per interval', async () => {
    const r = threeProjects({ fullSweepIntervalMs: 60_000 });
    const gamma = projectDir(r, GAMMA);
    pinDir(gamma, NOW - 40 * HOUR);
    await r.importer.discover();
    expect(tracked(r, S3)).toBe(0);
    // the session wakes up: its file is written, the modification time of its folder does not move
    const file3 = path.join(gamma, `${S3}.jsonl`);
    appendFileSync(file3, '{"type":"user"}\n');
    touch(file3, MIN);
    pinDir(gamma, NOW - 40 * HOUR);
    await r.importer.discover();
    expect(tracked(r, S3)).toBe(0);
    r.clock.advance(59_999);
    await r.importer.discover();
    expect(tracked(r, S3)).toBe(0);
    r.clock.advance(1);
    await r.importer.discover();
    expect(tracked(r, S3)).toBe(1);
  });

  it('says that the projects folder is missing, and finds it when it appears', async () => {
    const r = threeProjects();
    rmSync(path.join(r.home, 'projects'), { recursive: true });
    expect(await r.importer.discover()).toMatchObject({ sessions: 0, missingDir: true, folders: 0 });
    mkdirSync(projectDir(r, ALPHA), { recursive: true });
    addSession(r, ALPHA, S4, ALPHA_CWD);
    expect(await r.importer.discover()).toMatchObject({ missingDir: false, newFiles: 1 });
  });

  it('never enters a project folder that is a link, and counts it', async () => {
    const r = threeProjects();
    const outside = path.join(r.root, 'outside');
    mkdirSync(outside);
    new TranscriptBuilder({ sessionId: S4, cwd: 'D:/work/out', startMs: NOW - HOUR })
      .user('outside')
      .write(path.join(outside, `${S4}.jsonl`));
    touch(path.join(outside, `${S4}.jsonl`));
    makeJunction(projectDir(r, 'D--work-linked'), outside);
    const summary = await r.importer.discover();
    expect(summary.symlinksSkipped).toBe(1);
    expect(tracked(r, S4)).toBe(0);
  });

  describe('a hint from the registry', () => {
    it('finds a session of any age in the folder of its working directory without looking into another project', async () => {
      const spy = recorder();
      const r = threeProjects({ fs: spy.fs });
      expect(await r.importer.discoverSession(S3, GAMMA_CWD)).toBe(true);
      expect(tracked(r, S3)).toBe(1);
      const elsewhere = spy.touched.filter(
        (p) => p.startsWith(projectDir(r, ALPHA)) || p.startsWith(projectDir(r, BETA)),
      );
      expect(elsewhere).toEqual([]);
    });

    it('finds it in another folder when the working directory is no help, or is not given', async () => {
      const r = threeProjects();
      expect(await r.importer.discoverSession(S3, ALPHA_CWD)).toBe(true);
      const again = threeProjects();
      expect(await again.importer.discoverSession(S3)).toBe(true);
      expect(await again.importer.discoverSession(S4)).toBe(false);
      expect(await again.importer.discoverSession('not-a-session-id', ALPHA_CWD)).toBe(false);
    });

    it('makes the folder of an unknown session a folder to look into on the next tick, hot or not', async () => {
      const spy = recorder();
      const r = threeProjects({ fs: spy.fs });
      await r.importer.discover();
      spy.listed.length = 0;
      expect(await r.importer.discoverSession(S4, GAMMA_CWD)).toBe(false);
      await r.importer.discover();
      expect(spy.listed).toContain(projectDir(r, GAMMA));
      spy.listed.length = 0;
      await r.importer.discover();
      expect(spy.listed).not.toContain(projectDir(r, GAMMA));
    });

    it('ignores the working directory in scope repo: the one folder is the only place', async () => {
      const r = rig({ sessions: [session(S1, 'p1', ALPHA_CWD, HOUR), session(S2, BETA, BETA_CWD, 30 * HOUR)] });
      expect(await r.importer.discoverSession(S2, BETA_CWD)).toBe(false);
      expect(await r.importer.discoverSession(S1, BETA_CWD)).toBe(true);
    });
  });

  describe('which old sessions are known', () => {
    it('keeps following a session it tracks after its file got older than the window, and takes up its new subagent file', async () => {
      const r = threeProjects();
      await r.importer.discover();
      r.clock.advance(20 * HOUR);
      const agentFile = path.join(projectDir(r, ALPHA), S1, 'subagents', 'agent-late0000000001.jsonl');
      mkdirSync(path.dirname(agentFile), { recursive: true });
      new TranscriptBuilder({ sessionId: S1, cwd: ALPHA_CWD, startMs: NOW, agentId: 'late0000000001' })
        .user('late')
        .write(agentFile);
      touch(agentFile, -20 * HOUR + MIN);
      await r.importer.discover();
      expect(tracked(r, S1)).toBe(2);
    });

    it('does not follow an old session it never tracked', async () => {
      const r = threeProjects();
      await r.importer.discover();
      const agentFile = path.join(projectDir(r, GAMMA), S3, 'subagents', 'agent-late0000000002.jsonl');
      mkdirSync(path.dirname(agentFile), { recursive: true });
      new TranscriptBuilder({ sessionId: S3, cwd: GAMMA_CWD, startMs: NOW, agentId: 'late0000000002' })
        .user('late')
        .write(agentFile);
      touch(agentFile, MIN);
      r.clock.advance(60_000);
      await r.importer.discover();
      r.clock.advance(60_000);
      await r.importer.discover();
      expect(tracked(r, S3)).toBe(0);
    });

    it('tracks an old session that has hook events, in either scope', async () => {
      for (const scope of ['all', undefined] as const) {
        const r = rig({
          ...(scope === undefined ? {} : { projectScope: scope }),
          sessions: [session(S3, scope === undefined ? 'p1' : GAMMA, GAMMA_CWD, 30 * HOUR)],
        });
        r.db.driver
          .prepare(
            'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at, last_hook_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run([S3, NOW, NOW, NOW, NOW, NOW]);
        await r.importer.discover();
        expect(tracked(r, S3)).toBe(1);
      }
    });
  });

  describe('the files that have not grown for five minutes', () => {
    /** A session that is imported, whose file then grows by one line, and the importer is asked what is left to read. */
    async function growAfterImport(r: Rig, ageMs: number): Promise<{ grow: () => void; behind: () => number }> {
      await drain(r);
      const target = String(
        rows(r.db, `SELECT path FROM transcript_files WHERE session_uid = '${S1}' AND kind = 'session'`)[0]?.['path'],
      );
      return {
        grow: () => {
          appendFileSync(target, '{"type":"user"}\n');
          touch(target, ageMs);
        },
        behind: () => r.importer.work().length,
      };
    }

    it('are looked at every cold interval in scope all, and a file that is still warm at every tick', async () => {
      const cold = threeProjects({ coldStatIntervalMs: 10_000 });
      const idle = await growAfterImport(cold, HOUR);
      await cold.importer.statTick();
      idle.grow();
      await cold.importer.statTick();
      expect(idle.behind()).toBe(0);
      cold.clock.advance(9_999);
      await cold.importer.statTick();
      expect(idle.behind()).toBe(0);
      cold.clock.advance(1);
      await cold.importer.statTick();
      expect(idle.behind()).toBeGreaterThan(0);

      const warm = threeProjects({ coldStatIntervalMs: 10_000, sessions: [session(S1, ALPHA, ALPHA_CWD, MIN)] });
      const recent = await growAfterImport(warm, MIN);
      await warm.importer.statTick();
      recent.grow();
      await warm.importer.statTick();
      expect(recent.behind()).toBeGreaterThan(0);
    });

    it('are looked at every tick in scope repo, as they always were', async () => {
      const r = rig({ sessions: [session(S1, 'p1', ALPHA_CWD, HOUR)] });
      const idle = await growAfterImport(r, HOUR);
      await r.importer.statTick();
      idle.grow();
      await r.importer.statTick();
      expect(idle.behind()).toBeGreaterThan(0);
    });
  });

  describe('a session id that lives under two folders', () => {
    it('is never reported as copied from itself', async () => {
      const original = (): TranscriptBuilder =>
        new TranscriptBuilder({ sessionId: S1, cwd: ALPHA_CWD, startMs: NOW - 4 * HOUR, uuidSeed: 'twin' })
          .user('the same prompt')
          .assistant({ messageId: 'twin_1' });
      const r = rig({ projectScope: 'all', sessions: [session(S2, ALPHA, ALPHA_CWD, HOUR)] });
      const place = (project: string): void => {
        const target = path.join(projectDir(r, project), `${S1}.jsonl`);
        mkdirSync(path.dirname(target), { recursive: true });
        original().write(target);
        touch(target, HOUR);
      };
      // the session is imported where it began, and later it is resumed from another folder: the same records, a second file
      place(ALPHA);
      await drain(r);
      place(BETA);
      r.batches.length = 0;
      await drain(r);
      await r.importer.discover();
      await r.writer.flushNow();
      expect(tracked(r, S1)).toBe(2);
      expect(count(r.db, 'reconciliations', `kind = 'copied_records' AND scope_key = '${S1}'`)).toBe(0);
      const selfCopies = r.batches
        .flatMap((b) => b.items)
        .flatMap((item) => item.events)
        .filter((e) => e.k === 'session.copied_from' && e.source === e.sessionId);
      expect(selfCopies).toEqual([]);
      expect(
        r.db.driver
          .prepare<{ copied_from: string | null }>('SELECT copied_from FROM sessions WHERE session_uid = ?')
          .get([S1])?.copied_from,
      ).toBeNull();
    });
  });

  describe('a folder with more entries than the budget', () => {
    it('is counted and logged once, without its name', async () => {
      const ids = Array.from({ length: 50_010 }, (_, i) => `${String(i).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`);
      const root = path.join(path.resolve('/fixture-claude-home'), 'projects');
      const folder = path.join(root, 'D--work-huge');
      const fake: DiscoveryFs = {
        readdir: (dir) => {
          if (dir === root) return Promise.resolve(['D--work-huge']);
          return dir === folder ? Promise.resolve(ids.map((id) => `${id}.jsonl`)) : Promise.reject(new Error('ENOENT'));
        },
        lstat: (file) =>
          Promise.resolve(
            file === folder
              ? { kind: 'dir', size: 0, mtimeMs: NOW, birthMs: null }
              : { kind: 'file', size: 1, mtimeMs: NOW - 100 * HOUR, birthMs: null },
          ),
        readText: () => Promise.resolve(null),
        readHead: () => Promise.resolve(null),
      };
      const warnings: [string, unknown][] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (event, fields) => void warnings.push([event, fields]),
        error: () => undefined,
        stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
        close: () => Promise.resolve(),
      };
      const r = rig({ projectScope: 'all', fs: fake, logger, fullSweepIntervalMs: 5000 });
      // the importer under test reads the fake root, not the one of the rig
      r.importer.setProjectsRoot(root);
      const first = await r.importer.discover();
      expect(first).toMatchObject({ folders: 1, truncatedFolders: 1 });
      r.clock.advance(5000);
      const second = await r.importer.discover();
      expect(second.truncatedFolders).toBe(1);
      const truncated = warnings.filter(([event]) => event === 'discovery_truncated');
      expect(truncated).toHaveLength(1);
      expect(JSON.stringify(truncated)).not.toContain('huge');
    });
  });
});
