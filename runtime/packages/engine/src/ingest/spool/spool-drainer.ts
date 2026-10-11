// The spool drainer (02 2.7, ADR 0012; server priority P0): reads the hook segments of `<workspace>/data/spool/`, validates every
// line, normalizes it and hands the batches to the single `IngestWriter`. The cursor of a batch rides with the batch, so it is
// committed in the same transaction as the rows derived from its lines; a crash re-reads at most the batches that were not
// committed, and dedupe D-1 (`event_uid`) makes the re-read a no-op.
//
// Triggers: server start (every segment whose cursor is not sealed), a nudge (coalesced: one pass at a time, a nudge during a
// pass makes it run again), and a poll every `spool.pollMs`. A partial last line (a writer in flight) is never consumed: the
// reader is the `JsonlTailer` of 02 5.3 without the unterminated-tail option. A line that cannot be used is an ingest error
// (a code and a position, never its content), counted and skipped; nothing here throws at a producer.
import { performance } from 'node:perf_hooks';
import { setTimeout as sleepFor } from 'node:timers/promises';

import type { Clock } from '@mcs/shared';
import { HookEnvelopeV1Schema } from '@mcs/shared';
import type { HookEnvelopeV1 } from '@mcs/shared/protocol';

import type { InstanceDb, RepoContext } from '../../db/open.ts';
import { SpoolCursorsRepo, type SpoolCursorRow } from '../../db/repos/spool-cursors.ts';
import type { Logger } from '../../log/logger.ts';
import { unlinkWithRetry } from '../../platform/fsx.ts';
import { JsonlTailer, type RawLine, type TailCounters } from '../tail/jsonl-tailer.ts';
import { ingestError, type IngestErrorCode } from '../errors.ts';
import { envelopeItem, type IngestBatch, type IngestItem, type IngestWriterHandle } from '../writer.ts';
import { applySpoolReplay, planSpoolReplay } from './replay.ts';
import { listSegments, retentionExpired, sealDecision, type SegmentFile } from './segments.ts';

/** An envelope older than this when the server starts counts as received while the runtime was unavailable (02 2.7). */
const DOWNTIME_MARGIN_MS = 5000;

export interface SpoolDrainerOptions {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  /** The envelopes of any other instance are `INSTANCE_MISMATCH` errors. */
  readonly instanceId: string;
  /** `<workspace>/data/spool` */
  readonly spoolDir: string;
  readonly writer: IngestWriterHandle;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** `spool.pollMs` (default 500). */
  readonly pollMs?: number;
  /** `spool.sealGraceMs` (default 120000). */
  readonly sealGraceMs?: number;
  /** `spool.retainHours` (default 24). */
  readonly retainHours?: number;
  /** Read slice per poll in milliseconds (default 25): one slice becomes one batch and one transaction. */
  readonly sliceMs?: number;
  readonly chunkBytes?: number;
  /** Tests: a smaller line cap than `MAX_LINE_BYTES`. */
  readonly maxLineBytes?: number;
}

export interface SpoolStats {
  /** Segment files on disk at the last pass. */
  segments: number;
  bytes: number;
  /** Bytes of complete lines that no batch has taken yet. */
  bytesBehind: number;
  lastNudgeAt: number | null;
  lastDrainAt: number | null;
  /** Entries of the spool folder that are not segments: never read (02 2.7). */
  foreignFiles: number;
}

export interface SpoolDrainer {
  /** The first drain of a server start: every unsealed segment, then `runtime_unavailable` evidence; resolves when committed. */
  start(): Promise<void>;
  /** Stops the poll and lets the pass in progress finish its slice; nothing more is read. */
  stop(): Promise<void>;
  /** `POST /api/v3/ingest/nudge` (02 2.8): schedule a pass now, coalesced; never waits. */
  nudge(): void;
  /** One full pass (and another if a nudge came meanwhile), then waits for the writer to commit it. */
  drainNow(): Promise<void>;
  /** `IngestService.replay` (02 2.7 step 4): plan, reset the cursors from the writer queue, read again. */
  replay(fromSegment: string | null): Promise<{ segmentsReset: number }>;
  /** True when every known segment is read up to its last complete line and nothing is queued for it. */
  isIdle(): boolean;
  stats(): SpoolStats;
}

interface SegState {
  readonly name: string;
  tailer: JsonlTailer | null;
  offset: number;
  size: number;
  lines: number;
  partialBytes: number;
  sealed: boolean;
  errors: number;
  ino: string | null;
  headHash: string | null;
  oldestReceivedAt: number | null;
  newestReceivedAt: number | null;
  tornCounted: boolean;
  /** The cursor row exists in the database (a retention `forget` has something to delete). */
  persisted: boolean;
}

function stateOf(name: string, row: SpoolCursorRow | undefined): SegState {
  return {
    name,
    tailer: null,
    offset: row?.offsetBytes ?? 0,
    size: row?.sizeSeen ?? 0,
    lines: row?.lines ?? 0,
    partialBytes: row?.partialBytes ?? 0,
    sealed: row?.sealed ?? false,
    errors: row?.errors ?? 0,
    ino: row?.ino ?? null,
    headHash: row?.headHash ?? null,
    oldestReceivedAt: row?.oldestReceivedAt ?? null,
    newestReceivedAt: row?.newestReceivedAt ?? null,
    tornCounted: false,
    persisted: row !== undefined,
  };
}

/** The first issues of a zod failure as `path:code`, names only (never a value). */
function issueDetail(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}:${issue.code}`)
    .join(' ');
}

export function createSpoolDrainer(options: SpoolDrainerOptions): SpoolDrainer {
  const { db, scope, writer, clock, spoolDir } = options;
  const pollMs = options.pollMs ?? 500;
  const sealGraceMs = options.sealGraceMs ?? 120_000;
  const retainHours = options.retainHours ?? 24;
  const sliceMs = options.sliceMs ?? 25;
  const cursors = new SpoolCursorsRepo(db);

  const states = new Map<string, SegState>();
  let loaded = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const running: { current: Promise<void> | null } = { current: null };
  let dirty = false;
  /** Read through a call: the flag is set by other calls while a pass awaits, which a narrowing of the line before would hide. */
  const isDirty = (): boolean => dirty;
  let chain: Promise<unknown> = Promise.resolve();
  let startedAt: number | null = null;
  let firstPass = true;
  let downtime: { oldest: number; count: number } | null = null;
  const drainWaiters: (() => void)[] = [];
  const out: SpoolStats = {
    segments: 0,
    bytes: 0,
    bytesBehind: 0,
    lastNudgeAt: null,
    lastDrainAt: null,
    foreignFiles: 0,
  };

  writer.onDrain(() => {
    for (const wake of drainWaiters.splice(0)) wake();
  });

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  /** Hands a batch to the writer; a full queue makes this wait for `onDrain` (02 4.7). False when the drainer was stopped. */
  async function give(batch: IngestBatch): Promise<boolean> {
    while (!stopped) {
      if (writer.submit(batch)) return true;
      await Promise.race([new Promise<void>((resolve) => drainWaiters.push(resolve)), sleepFor(1000)]);
    }
    return false;
  }

  function loadStates(): void {
    if (loaded) return;
    loaded = true;
    for (const row of cursors.list(scope)) states.set(row.segment, stateOf(row.segment, row));
  }

  function errorItem(
    code: IngestErrorCode,
    state: SegState,
    byteOffset: number | null,
    detail: string | null = null,
  ): IngestItem {
    state.errors += 1;
    return {
      kind: 'envelope',
      events: [],
      rows: [
        {
          t: 'error',
          error: ingestError(code, 'spool', { segment: state.name, byteOffset, detail }),
        },
      ],
    };
  }

  /** One spool line: an item with the envelope, or an item with the ingest error that explains why there is none. */
  function itemOfLine(line: RawLine, state: SegState): IngestItem {
    let value: unknown;
    try {
      value = JSON.parse(line.bytes.toString('utf8'));
    } catch {
      return errorItem('SPOOL_LINE_INVALID_JSON', state, line.offset);
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const version: unknown = Reflect.get(value, 'v');
      if (typeof version === 'number' && version > 1) {
        return errorItem('ENVELOPE_VERSION', state, line.offset, `v:${String(version)}`);
      }
    }
    const parsed = HookEnvelopeV1Schema.safeParse(value);
    if (!parsed.success) {
      const onlySession =
        parsed.error.issues.length > 0 && parsed.error.issues.every((i) => i.path[0] === 'session_id');
      return errorItem(
        onlySession ? 'INVALID_SESSION_ID' : 'ENVELOPE_SCHEMA',
        state,
        line.offset,
        issueDetail(parsed.error.issues),
      );
    }
    const envelope: HookEnvelopeV1 = parsed.data;
    if (envelope.instance_id !== options.instanceId) return errorItem('INSTANCE_MISMATCH', state, line.offset);
    const at = envelope.received_at;
    state.oldestReceivedAt = state.oldestReceivedAt === null ? at : Math.min(state.oldestReceivedAt, at);
    state.newestReceivedAt = state.newestReceivedAt === null ? at : Math.max(state.newestReceivedAt, at);
    if (firstPass && startedAt !== null && at < startedAt) {
      downtime = { oldest: Math.min(downtime?.oldest ?? at, at), count: (downtime?.count ?? 0) + 1 };
    }
    return envelopeItem(envelope, { segment: state.name, offset: line.offset });
  }

  function counterItems(counters: TailCounters, state: SegState): IngestItem[] {
    const items: IngestItem[] = [];
    for (let i = 0; i < counters.oversized; i += 1) items.push(errorItem('LINE_TOO_LONG', state, null));
    for (let i = 0; i < counters.utf8Invalid; i += 1) items.push(errorItem('UTF8_INVALID', state, null));
    return items;
  }

  function cursorBatch(state: SegState, items: IngestItem[], now: number, bytes: number): IngestBatch {
    return {
      source: 'spool',
      items,
      bytes,
      cursor: {
        kind: 'spool',
        segment: state.name,
        cursor: {
          segment: state.name,
          offsetBytes: state.offset,
          sizeSeen: state.size,
          ino: state.ino,
          headHash: state.headHash,
          lines: state.lines,
          partialBytes: state.partialBytes,
          sealed: state.sealed,
          errors: state.errors,
          oldestReceivedAt: state.oldestReceivedAt,
          newestReceivedAt: state.newestReceivedAt,
          drainedAt: now,
        },
      },
    };
  }

  async function drainSegment(state: SegState, file: SegmentFile): Promise<void> {
    const path = `${spoolDir}/${state.name}`;
    state.tailer ??= new JsonlTailer(
      {
        path,
        acceptValidUnterminatedTail: false,
        ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
        ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      },
      {
        offset: state.offset,
        lineNo: state.lines + 1,
        size: state.size,
        identity:
          state.headHash === null
            ? null
            : { ino: state.ino, headLen: Math.min(256, state.size), headHash: state.headHash },
      },
    );
    for (;;) {
      if (stopped) return;
      const poll = await state.tailer.poll(performance.now() + sliceMs);
      const now = clock.now();
      if (poll.status === 'missing') return;
      if (poll.status === 'unreadable') {
        const item = errorItem('READ_FAILED', state, null, poll.code);
        await give({ source: 'spool', items: [item], bytes: 200 });
        return;
      }
      const items: IngestItem[] = [];
      if (poll.reset !== null) {
        state.lines = 0;
        state.oldestReceivedAt = null;
        state.newestReceivedAt = null;
        items.push({
          kind: 'envelope',
          events: [],
          rows: [
            {
              t: 'reconciliation',
              kind: 'identity_reset',
              sessionUid: null,
              at: now,
              detail: { segment: state.name, reason: poll.reset, size: file.bytes },
            },
          ],
        });
        items.push(errorItem('IDENTITY_RESET', state, 0, poll.reset));
      }
      for (const line of poll.lines) items.push(itemOfLine(line, state));
      items.push(...counterItems(poll.counters, state));

      const tail = state.tailer.state;
      state.offset = tail.offset;
      state.size = tail.size;
      state.lines = Math.max(0, tail.lineNo - 1);
      state.ino = tail.identity?.ino ?? null;
      state.headHash = tail.identity?.headHash ?? null;
      state.partialBytes = poll.partialBytes;

      if (poll.eof) {
        const verdict = sealDecision({
          segment: state.name,
          now,
          sealGraceMs,
          offset: state.offset,
          size: state.size,
          partialBytes: state.partialBytes,
        });
        if (verdict === 'seal_torn' && !state.tornCounted) {
          state.tornCounted = true;
          items.push(errorItem('SPOOL_TORN_TAIL', state, state.offset));
        }
        if (verdict !== 'keep') state.sealed = true;
      }
      const moved = poll.lines.length > 0 || items.length > 0 || state.sealed || !state.persisted;
      if (moved) {
        const bytes = poll.lines.reduce((sum, line) => sum + line.length, 0) + items.length * 200;
        if (!(await give(cursorBatch(state, items, now, bytes)))) return;
        state.persisted = true;
      }
      if (poll.eof) return;
    }
  }

  async function retire(state: SegState): Promise<void> {
    await unlinkWithRetry(`${spoolDir}/${state.name}`);
    states.delete(state.name);
    if (state.persisted) {
      await give({ source: 'spool', items: [], bytes: 0, cursor: { kind: 'spool_forget', segment: state.name } });
    }
  }

  async function pass(): Promise<void> {
    loadStates();
    const listing = await listSegments(spoolDir);
    out.foreignFiles = listing.foreign.length;
    out.segments = listing.segments.length;
    out.bytes = listing.segments.reduce((sum, file) => sum + file.bytes, 0);
    const now = clock.now();
    for (const file of listing.segments) {
      let state = states.get(file.name);
      if (state === undefined) {
        state = stateOf(file.name, undefined);
        states.set(file.name, state);
      }
      if (state.sealed) continue;
      try {
        await drainSegment(state, file);
      } catch (error) {
        options.logger?.warn('spool_drain_failed', { code: error instanceof Error ? error.name : 'unknown' });
        await give({
          source: 'spool',
          items: [errorItem('READ_FAILED', state, null, error instanceof Error ? error.name : 'unknown')],
          bytes: 200,
        });
      }
    }
    if (firstPass && startedAt !== null) {
      const found = downtime;
      downtime = null;
      if (found !== null && found.oldest < startedAt - DOWNTIME_MARGIN_MS) {
        await give({
          source: 'spool',
          bytes: 100,
          items: [
            {
              kind: 'envelope',
              events: [],
              rows: [
                {
                  t: 'reconciliation',
                  kind: 'runtime_unavailable',
                  sessionUid: null,
                  at: startedAt,
                  detail: { from: found.oldest, to: startedAt, envelopes: found.count },
                },
              ],
            },
          ],
        });
      }
    }
    firstPass = false;
    const onDisk = new Set(listing.segments.map((file) => file.name));
    let behind = 0;
    for (const state of [...states.values()]) {
      if (!state.sealed && onDisk.has(state.name))
        behind += Math.max(0, state.size - state.partialBytes - state.offset);
      if (state.sealed && retentionExpired(state.name, now, retainHours)) await retire(state);
    }
    // bytes that the listing shows but no slice has read yet (a segment that grew during this pass)
    for (const file of listing.segments) {
      const state = states.get(file.name);
      if (state !== undefined && !state.sealed && file.bytes > state.size) behind += file.bytes - state.size;
    }
    out.bytesBehind = behind;
    out.lastDrainAt = clock.now();
  }

  function run(): Promise<void> {
    if (running.current !== null) {
      dirty = true;
      return running.current;
    }
    const current = serial(async () => {
      do {
        dirty = false;
        try {
          await pass();
        } catch (error) {
          options.logger?.warn('spool_pass_failed', { code: error instanceof Error ? error.name : 'unknown' });
        }
      } while (isDirty() && !stopped);
    }).finally(() => {
      if (running.current === current) running.current = null;
    });
    running.current = current;
    return current;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void run().finally(schedule);
    }, pollMs);
    timer.unref();
  }

  return {
    async start() {
      // A stopped pass may have moved a tailer past lines whose batch was never handed to the writer (`give` refused it).
      // The memory is therefore not trusted across a stop: every cursor is read again from the committed rows (02 2.7).
      states.clear();
      loaded = false;
      stopped = false;
      startedAt = clock.now();
      firstPass = true;
      await run();
      await writer.flushNow();
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const wake of drainWaiters.splice(0)) wake();
      await (running.current ?? Promise.resolve());
      await chain;
    },
    nudge() {
      out.lastNudgeAt = clock.now();
      if (stopped) return;
      void run();
    },
    async drainNow() {
      await run();
      await writer.flushNow();
    },
    async replay(fromSegment) {
      return serial(async () => {
        loadStates();
        const plan = await planSpoolReplay(scope, { spoolCursors: cursors }, spoolDir, fromSegment);
        const result = await writer.runExclusive(() => applySpoolReplay(db, scope, plan));
        for (const entry of plan.segments) states.delete(entry.segment);
        loaded = false;
        states.clear();
        return result;
      }).then((result) => {
        void run();
        return result;
      });
    },
    isIdle() {
      if (running.current !== null || writer.stats.queued > 0) return false;
      for (const state of states.values()) {
        if (!state.sealed && state.size - state.partialBytes - state.offset > 0) return false;
      }
      return out.bytesBehind === 0;
    },
    stats: () => ({ ...out }),
  };
}
