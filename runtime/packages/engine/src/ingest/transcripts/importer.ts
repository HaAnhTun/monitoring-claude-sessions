// The transcript importer (02 5.1-5.9, ADR 0015, 0016): turns the transcripts below the project folder into batches for the
// single ingest writer, one slice at a time. It owns no timer and no loop (`ImportScheduler` does); it knows which files are
// tracked, what work each has and how to do one bounded slice of it.
//
// A file is imported in three ranges that are persisted as four cursors (02 5.5):
//   head (P2)      the first 401 lines: classification, first timestamp, cwd and the like;
//   tail (P1)      from `tail_start` (the last `tailWindowBytes`) to the end, and on as the file grows;
//   backfill (P3)  `[head_end, tail_start)`, the history behind the tail.
// The cursor of a batch rides with the batch, so it commits in the same transaction as the rows derived from the bytes it
// passed; a crash re-reads at most the batches that were not committed, and every write is idempotent (02 4.4, 6.2).
//
// Token usage rides in the batch of its slice (`usage` rows, CR-WP-34-1, ADR 0015): the writer links the file and applies the
// usage in the transaction that moves the cursor, so a hard kill between two commits loses no usage. What is NOT in the
// writer's transaction: the session label, the early link of a file to its rows and the identity reset of a file. They are
// written in the importer's own short `withWriteTx`, after the batch that created the session was handed over, and each is
// idempotent (last write).
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToLoop, setTimeout as sleepFor } from 'node:timers/promises';
import { stat as nodeStat } from 'node:fs/promises';

import type { Clock } from '@mcs/shared';
import { redact, routeKey } from '@mcs/shared/protocol';

import type { InstanceDb, RepoContext } from '../../db/open.ts';
import { AgentsRepo } from '../../db/repos/agents.ts';
import { EventsRepo } from '../../db/repos/events.ts';
import { SessionsRepo } from '../../db/repos/sessions.ts';
import {
  TranscriptFilesRepo,
  type CursorCounters,
  type FileCursorUpdate,
  type NewTranscriptFile,
  type TranscriptFileKind,
  type TranscriptFileRow,
  type TranscriptFileState,
  type UsageState,
} from '../../db/repos/transcript-files.ts';
import { UsageRepo } from '../../db/repos/usage.ts';
import { WorkflowRunsRepo } from '../../db/repos/workflow-runs.ts';
import { withWriteTx } from '../../db/write.ts';
import type { Logger } from '../../log/logger.ts';
import { clipCodePoints } from '../../platform/fsx.ts';
import { usageOfRecord, type RecordUsage } from '../../tokens/accumulate.ts';
import { ingestError } from '../errors.ts';
import type { LogicalEvent } from '../event-row.ts';
import { checkIdentity, lineStartAtOrAfter, readIdentity, readLines, type FileIdentity } from '../tail/jsonl-tailer.ts';
import { classifyFsError, errorCodeOf, IDENTITY_HEAD_BYTES } from '../tail/file-identity.ts';
import type { RawLine } from '../tail/line-splitter.ts';
import { linkTranscriptFile, type LinkRepos } from '../link-file.ts';
import { usageItems, type IngestBatch, type IngestItem, type IngestWriter } from '../writer.ts';
import {
  CLASSIFY_LINE_LIMIT,
  classify,
  compileSessionRules,
  type CompiledRule,
  type HeadRecord,
  type SessionRule,
} from './classify.ts';
import {
  discoverSession as discoverOneSession,
  discoverTranscripts,
  nodeDiscoveryFs,
  readAgentMeta,
  readCustomTitle,
  readWorkflowStatus,
  type DiscoveredFile,
  type DiscoveredSession,
  type DiscoveryFs,
} from './discovery.ts';
import {
  createNormalizerState,
  normalizeRecords,
  type NormalizerState,
  type TrackedFile,
  type TranscriptRecord,
} from './normalize-record.ts';

// ---- settings and public types -----------------------------------------------------------------------------------------------

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;

/** The `import.*` keys that the importer reads, resolved (no nulls): defaults are those of 02 1.2. */
export interface ImportSettings {
  readonly lookbackHours: number;
  readonly headMaxBytes: number;
  readonly tailWindowBytes: number;
  readonly backfillMaxBytes: number;
  readonly untrackAfterHours: number;
  readonly sliceMs: number;
}

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
  lookbackHours: 8,
  headMaxBytes: 16 * MIB,
  tailWindowBytes: 8 * MIB,
  backfillMaxBytes: 512 * MIB,
  untrackAfterHours: 48,
  sliceMs: 20,
};

export type ImportPhase = 'head' | 'tail' | 'backfill';

/** One unit of runnable work: P1 tail, P2 head, P3 backfill (02 5.4). */
export interface ImportWork {
  readonly fileId: number;
  readonly phase: ImportPhase;
  readonly priority: 1 | 2 | 3;
}

export interface SliceOutcome {
  /** The slice read, moved a cursor or changed a state; false means the call found nothing to do. */
  readonly progressed: boolean;
  /** Bytes of the file that the slice passed. */
  readonly bytes: number;
}

export interface DiscoverySummary {
  readonly sessions: number;
  readonly newFiles: number;
  readonly symlinksSkipped: number;
  readonly missingDir: boolean;
}

/** The aggregate of 02 5.9 (`ingest_health.transcripts`) that this module can fill. */
export interface TranscriptStats {
  filesTracked: number;
  filesMissing: number;
  filesUnreadable: number;
  bytesBehind: number;
  backfillRemainingBytes: number;
  /** `now - min(behind_since)` over the files that are behind, 0 when none is. */
  maxLagMs: number;
  lastScanAt: number | null;
  /** End of the last stat cycle in which every tracked file had nothing behind it. */
  lastSyncAt: number | null;
  /** Slices that threw (logged by code, never rethrown): the work comes back at the next cycle. */
  sliceFailures: number;
}

export interface TranscriptImporterOptions {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly writer: Pick<IngestWriter, 'submit' | 'onDrain' | 'flushNow'>;
  readonly clock: Clock;
  /** The project folder; null while it is not known (discovery retries, 02 5.1.1). */
  readonly transcriptsDir?: string | null;
  readonly settings?: Partial<ImportSettings>;
  /** `session_rules` of the configuration. */
  readonly rules?: readonly SessionRule[];
  /** `session_ids`: pinned sessions are tracked and matched whatever their age. */
  readonly pinned?: readonly string[];
  readonly logger?: Logger;
  /** Bytes per read and per slice (default 256 KiB: a slice never hands more than that to the parser). */
  readonly chunkBytes?: number;
  /** Tests: a smaller line cap than `MAX_LINE_BYTES`. */
  readonly maxLineBytes?: number;
  readonly fs?: DiscoveryFs;
}

export interface TranscriptImporter {
  setTranscriptsDir(dir: string | null): void;
  /** Replaces the rules and the pinned ids: every session file is classified again. */
  setRules(rules: readonly SessionRule[], pinned: readonly string[]): void;
  /** Looks at the project folder once: tracks new files, refreshes small files, untracks idle ones. */
  discover(): Promise<DiscoverySummary>;
  /** One session folder at once (a hint from a hook payload), whatever the age policy says. */
  discoverSession(sessionId: string): Promise<boolean>;
  /** Async stat of the tracked files, 32 at a time: refreshes the sizes that mark work, notices missing files. */
  statTick(): Promise<void>;
  /** The runnable work, highest priority first, files in the order they were first seen. */
  work(): ImportWork[];
  /** Does one bounded slice of `work`. Calls are serialized. `deadline` is a `performance.now()` value. */
  runSlice(work: ImportWork, deadline: number): Promise<SliceOutcome>;
  stats(): TranscriptStats;
  /** No work, nothing behind, no slice in progress. */
  isIdle(): boolean;
  /** Stops handing batches over: a slice that waits for the writer returns, nothing more is read. */
  close(): void;
}

// ---- internals ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const STAT_PARALLEL = 32;
const MAX_TRACKED_ROWS = 1_000_000;
const TITLE_KIND = 'custom' as const;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface SeenFields {
  cwd?: string | undefined;
  entrypoint?: string | undefined;
  version?: string | undefined;
  gitBranch?: string | undefined;
  firstAtMs?: number | undefined;
}

/** What the importer remembers about one tracked file. The first block mirrors the persisted row. */
interface FileState {
  readonly id: number;
  readonly spec: NewTranscriptFile;
  readonly path: string;
  readonly kind: TranscriptFileKind;
  readonly sessionUid: string;
  readonly agentUid: string | null;
  readonly runUid: string | null;
  state: TranscriptFileState;
  headEnd: number;
  backfillOffset: number;
  tailStart: number;
  tailOffset: number;
  partialBytes: number;
  sizeSeen: number;
  mtimeSeen: number | null;
  lineCount: number;
  usageState: UsageState;
  identity: FileIdentity | null;
  firstTs: string | null;
  maxTs: string;
  lastStop: string;
  classifiedLines: number;
  labelCache: string | null;
  behindSince: number | null;
  lastGrowthAt: number | null;
  discoveredAt: number;
  // not persisted
  observedSize: number;
  observedMtimeMs: number | null;
  checkedSize: number;
  checkedMtimeMs: number | null;
  headPos: number;
  headPartial: number;
  headLineNo: number;
  headSkipping: boolean;
  headSeen: SeenFields;
  tailLineNo: number | null;
  tailSkipping: boolean;
  backfillSkipping: boolean;
  caughtOnce: boolean;
  lastAssistant: string | null;
  normalizer: NormalizerState;
  linked: boolean;
  needsClassify: boolean;
  copyReported: Map<string, number>;
  smallKey: string | null;
  busy: boolean;
  identityDirty: boolean;
  metaSent: boolean;
}

interface Counters {
  invalidJson: number;
  notObject: number;
  shapeInvalid: number;
  unknownTypes: number;
  normalizeFailed: number;
}

interface Parsed {
  readonly uuid: string | null;
  readonly events: LogicalEvent[];
  readonly rows: IngestItem['rows'];
  readonly offset: number;
}

interface ReadOutcome {
  /** Lines the slice took, the byte after them and the number of the line there. */
  readonly parsed: Parsed[];
  readonly usage: RecordUsage[];
  readonly counters: Counters;
  readonly lineCount: number;
  readonly nextOffset: number;
  readonly nextLineNo: number;
  readonly skipping: boolean;
  readonly partialBytes: number;
  /** The range was read to its end (not stopped by a deadline). */
  readonly eof: boolean;
  readonly tail: { oversized: number; utf8Invalid: number; bomStripped: number; crlfLines: number };
  readonly bytes: number;
  /** The first line beyond the head limit was found in this slice (head only): where the head ends. */
  readonly cutAt: number | null;
}

function maxString(a: string, b: string): string {
  return b > a ? b : a;
}

function nonZero(counters: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counters).filter(([, n]) => n > 0));
}

export function createTranscriptImporter(options: TranscriptImporterOptions): TranscriptImporter {
  const { db, scope, writer, clock } = options;
  const settings: ImportSettings = { ...DEFAULT_IMPORT_SETTINGS, ...options.settings };
  const fsx = options.fs ?? nodeDiscoveryFs;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const sessions = new SessionsRepo(db);
  const agents = new AgentsRepo(db);
  const runs = new WorkflowRunsRepo(db);
  const events = new EventsRepo(db);
  const usage = new UsageRepo(db);
  const files = new TranscriptFilesRepo(db);
  const linkRepos: LinkRepos = { sessions, agents, runs, files };

  const states = new Map<number, FileState>();
  const byKey = new Map<string, FileState>();
  const drainWaiters: (() => void)[] = [];
  const titleKeys = new Map<string, string>();
  const stats: TranscriptStats = {
    filesTracked: 0,
    filesMissing: 0,
    filesUnreadable: 0,
    bytesBehind: 0,
    backfillRemainingBytes: 0,
    maxLagMs: 0,
    lastScanAt: null,
    lastSyncAt: null,
    sliceFailures: 0,
  };
  let tdir: string | null = options.transcriptsDir ?? null;
  let rules: CompiledRule[] = compileSessionRules(options.rules ?? []);
  let pinned = new Set(options.pinned ?? []);
  let loaded = false;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let discovering = 0;

  writer.onDrain(() => {
    for (const wake of drainWaiters.splice(0)) wake();
  });

  // ---- handing batches to the writer ---------------------------------------------------------------------------------------

  /** Hands a batch over; a full queue makes this wait for `onDrain` (02 4.7). False when the importer was closed. */
  async function give(batch: IngestBatch): Promise<boolean> {
    while (!closed) {
      if (writer.submit(batch)) return true;
      await Promise.race([
        new Promise<void>((resolve) => drainWaiters.push(resolve)),
        sleepFor(1000, undefined, { ref: false }),
      ]);
    }
    return false;
  }

  function eventItem(eventList: LogicalEvent[], rows: IngestItem['rows'] = []): IngestItem {
    return { kind: 'record', events: eventList, rows };
  }

  // ---- state of the files --------------------------------------------------------------------------------------------------

  function fromRow(row: TranscriptFileRow): FileState {
    const spec: NewTranscriptFile = {
      path: row.path,
      pathKey: row.pathKey,
      kind: row.kind,
      sessionUid: row.sessionUid,
      agentUid: row.agentUid,
      runUid: row.runUid,
      sessionId: row.sessionId,
      agentId: row.agentId,
      workflowRunId: row.workflowRunId,
      birthMs: row.birthMs,
      firstSeenMtimeMs: row.firstSeenMtimeMs,
      mtimeSeen: row.mtimeSeen,
    };
    const identity: FileIdentity | null =
      row.headHash === null ? null : { ino: row.ino, headLen: row.headLen, headHash: row.headHash };
    return {
      id: row.id,
      spec,
      path: row.path,
      kind: row.kind,
      sessionUid: row.sessionUid,
      agentUid: row.agentUid,
      runUid: row.runUid,
      state: row.state,
      headEnd: row.headEnd,
      backfillOffset: row.backfillOffset,
      tailStart: row.tailStart,
      tailOffset: row.tailOffset,
      partialBytes: row.partialBytes,
      sizeSeen: row.sizeSeen,
      mtimeSeen: row.mtimeSeen,
      lineCount: row.lineCount,
      usageState: row.usageState,
      identity,
      firstTs: row.firstTsInOrder,
      maxTs: row.maxTsString ?? '',
      lastStop: row.lastStopLegacy ?? '',
      classifiedLines: row.classifiedLines,
      labelCache: row.labelCache,
      behindSince: row.behindSince,
      lastGrowthAt: row.lastGrowthAt,
      discoveredAt: row.discoveredAt,
      observedSize: row.sizeSeen,
      observedMtimeMs: row.mtimeSeen,
      checkedSize: row.sizeSeen,
      checkedMtimeMs: row.mtimeSeen,
      headPos: 0,
      headPartial: 0,
      headLineNo: 1,
      headSkipping: false,
      headSeen: {},
      tailLineNo: null,
      tailSkipping: false,
      backfillSkipping: false,
      caughtOnce: row.usageState !== 'partial',
      lastAssistant: null,
      normalizer: createNormalizerState(),
      linked: false,
      needsClassify: row.kind === 'session' && row.classifiedLines < CLASSIFY_LINE_LIMIT,
      copyReported: new Map(),
      smallKey: null,
      busy: false,
      identityDirty: false,
      metaSent: false,
    };
  }

  function loadKnown(): void {
    if (loaded) return;
    for (const row of files.listByStates(scope, ['active', 'missing', 'unreadable', 'untracked'], MAX_TRACKED_ROWS)) {
      const state = fromRow(row);
      // a restart reads the head again unless the cursors say it is done (head_end > 0)
      if (row.kind === 'session') state.needsClassify = true;
      states.set(state.id, state);
      byKey.set(row.pathKey, state);
    }
    // only after the whole read worked: a failed first read is tried again by the next call instead of leaving an empty set
    loaded = true;
  }

  function headDone(file: FileState): boolean {
    return file.headEnd > 0;
  }

  function trackedFileOf(file: FileState): TrackedFile {
    return { fileId: file.id, kind: file.kind, sessionId: file.sessionUid, agentId: file.agentUid, runId: file.runUid };
  }

  function active(file: FileState): boolean {
    return file.state === 'active';
  }

  function changedSinceCheck(file: FileState): boolean {
    return file.observedSize !== file.checkedSize || file.observedMtimeMs !== file.checkedMtimeMs;
  }

  function markState(file: FileState, next: TranscriptFileState): void {
    if (file.state === next) return;
    withWriteTx(db, scope, (tx) => {
      files.setState(scope, tx, file.id, next);
    });
    file.state = next;
  }

  // ---- work ---------------------------------------------------------------------------------------------------------------

  function workOf(file: FileState): ImportWork[] {
    if (!active(file) || file.kind === 'workflow_status' || file.busy) return [];
    if (!headDone(file)) {
      return file.observedSize > file.headPos + file.headPartial || changedSinceCheck(file)
        ? [{ fileId: file.id, phase: 'head', priority: 2 }]
        : [];
    }
    const out: ImportWork[] = [];
    if (file.observedSize > file.tailOffset + file.partialBytes || changedSinceCheck(file)) {
      out.push({ fileId: file.id, phase: 'tail', priority: 1 });
    }
    if (file.usageState === 'partial' && file.backfillOffset < file.tailStart) {
      out.push({ fileId: file.id, phase: 'backfill', priority: 3 });
    }
    return out;
  }

  // ---- links and labels (the importer's own short transactions) ----------------------------------------------------------------

  function tryLink(file: FileState): boolean {
    if (file.linked) return true;
    if (sessions.idByUid(scope, file.sessionUid) === undefined) return false;
    // an agent file links once its agent row exists (the writer creates it from the batch, or the link below does)
    const link = withWriteTx(db, scope, (tx) => linkTranscriptFile(scope, tx, linkRepos, file));
    if (link?.complete !== true) return false;
    file.linked = true;
    return true;
  }

  async function ensureLinked(file: FileState): Promise<boolean> {
    if (tryLink(file)) return true;
    await writer.flushNow();
    return tryLink(file);
  }

  /** Reads the first 401 lines from disk again (a short read: nothing is held between slices) and parses them. */
  async function readHead(file: FileState): Promise<{ head: HeadRecord[]; linesSeen: number }> {
    const head: HeadRecord[] = [];
    let pos = 0;
    let lineNo = 1;
    let skipping = false;
    let linesSeen = 0;
    for (;;) {
      let size: number;
      try {
        size = (await nodeStat(file.path)).size;
      } catch {
        break;
      }
      const res = await readLines(file.path, pos, size, performance.now() + settings.sliceMs, {
        chunkBytes,
        sliceBytes: chunkBytes,
        acceptValidUnterminatedTail: true,
        firstLineNo: lineNo,
        resumeSkip: skipping,
        ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      });
      for (const line of res.lines) {
        if (line.lineNo > CLASSIFY_LINE_LIMIT) break;
        try {
          const record: unknown = JSON.parse(line.bytes.toString('utf8'));
          head.push({ lineNo: line.lineNo, record });
        } catch {
          // an invalid line holds its place and nothing else
        }
      }
      linesSeen = res.nextLineNo - 1;
      pos = res.nextOffset;
      lineNo = res.nextLineNo;
      skipping = res.skipping;
      if (res.nextLineNo > CLASSIFY_LINE_LIMIT || res.eof || pos >= settings.headMaxBytes) break;
      await yieldToLoop();
    }
    return { head, linesSeen };
  }

  async function classifyFile(file: FileState): Promise<void> {
    if (file.kind !== 'session' || !(await ensureLinked(file))) return;
    const { head, linesSeen } = await readHead(file);
    const result = classify(head, rules, { pinned: pinned.has(file.sessionUid), linesSeen });
    const label = clipCodePoints(redact(result.label), 200);
    withWriteTx(db, scope, (tx) => {
      const row = sessions.byUid(scope, file.sessionUid);
      if (row === undefined) return;
      const changed = row.label !== label || row.matched !== result.matched || row.labelSource !== result.labelSource;
      const seq = changed
        ? tx.changes.reserve('session', 'upsert', { entityId: row.id, sessionUid: row.sessionUid })
        : null;
      sessions.update(
        scope,
        tx,
        row.id,
        { label, labelSource: result.labelSource, matched: result.matched, ruleIndex: result.ruleIndex },
        seq,
      );
      files.updateCursors(scope, tx, file.id, { classifiedLines: result.classifiedLines, labelCache: label });
    });
    file.classifiedLines = result.classifiedLines;
    file.labelCache = label;
  }

  /** Records of a resume copy: uuids that another file already holds. Their `activity` events are old evidence (02 5.6). */
  function copiedUuids(file: FileState, uuids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (uuids.length === 0) return out;
    const rows = db.driver
      .prepare<{ uuid: string; source: string }>(
        `SELECT e.record_uuid AS uuid, s.session_uid AS source FROM events e JOIN sessions s ON s.id = e.session_id
          WHERE e.record_uuid IN (SELECT value FROM json_each(?)) AND e.file_id IS NOT ?`,
      )
      .all([JSON.stringify(uuids), file.id]);
    for (const row of rows) out.set(row.uuid, row.source);
    return out;
  }

  /** After a batch with copies: `session.copied_from` and the `copied_records` reconciliation, once per change (02 5.6). */
  async function reportCopies(file: FileState): Promise<void> {
    await writer.flushNow();
    const rows = db.driver
      .prepare<{ source: string; n: number }>(
        `SELECT s.session_uid AS source, count(*) AS n FROM entry_occurrences o
           JOIN events e ON e.record_uuid = o.record_uuid JOIN sessions s ON s.id = e.session_id
          WHERE o.file_id = ? GROUP BY s.session_uid ORDER BY s.session_uid`,
      )
      .all([file.id]);
    const items: IngestItem[] = [];
    for (const { source, n } of rows) {
      if (file.copyReported.get(source) === n) continue;
      file.copyReported.set(source, n);
      items.push(
        eventItem(
          [{ k: 'session.copied_from', sessionId: file.sessionUid, source, count: n }],
          [
            {
              t: 'reconciliation',
              kind: 'copied_records',
              sessionUid: file.sessionUid,
              at: clock.now(),
              detail: { source, count: n },
            },
          ],
        ),
      );
    }
    if (items.length > 0) await give({ source: 'transcript', items, bytes: 200 * items.length });
  }

  // ---- reading and normalizing one slice ------------------------------------------------------------------------------------

  function noteRecord(file: FileState, phase: ImportPhase, rec: TranscriptRecord): void {
    const ts = rec.timestamp;
    if (ts !== undefined && ts !== '') {
      if (phase === 'head' && file.firstTs === null) file.firstTs = ts;
      file.maxTs = maxString(file.maxTs, ts);
    }
    if (phase === 'head') {
      const seen = file.headSeen;
      seen.cwd ??= str(rec['cwd']);
      seen.entrypoint ??= str(rec['entrypoint']);
      seen.version ??= str(rec['version']);
      seen.gitBranch ??= str(rec['gitBranch']);
      if (seen.firstAtMs === undefined && ts !== undefined) {
        const at = Date.parse(ts);
        if (Number.isFinite(at)) seen.firstAtMs = at;
      }
    }
    if (phase !== 'backfill' && rec.type === 'assistant' && rec.message !== undefined) {
      const id = str(rec.message.id) ?? rec.uuid ?? null;
      if (id !== file.lastAssistant) {
        file.lastAssistant = id;
        file.lastStop = '';
      }
      const stop = rec.message.stop_reason;
      if (typeof stop === 'string' && stop !== '') file.lastStop = stop;
    }
  }

  function normalizeLines(
    file: FileState,
    phase: ImportPhase,
    lines: readonly RawLine[],
    lineNoKnown: boolean,
    budgetMs: number,
  ): { parsed: Parsed[]; usage: RecordUsage[]; counters: Counters; taken: number } {
    const usageList: RecordUsage[] = [];
    const uuids = new Map<number, string>();
    const stopAt = performance.now() + budgetMs;
    let first = true;
    const batch = normalizeRecords(
      lineNoKnown ? lines : lines.map((line) => ({ ...line, lineNo: 0 })),
      trackedFileOf(file),
      file.normalizer,
      {
        nowMs: clock.now(),
        // at least one line per call, then the budget
        shouldStop: () => {
          if (first) {
            first = false;
            return false;
          }
          return performance.now() >= stopAt;
        },
        onRecord: (rec, line) => {
          noteRecord(file, phase, rec);
          if (rec.uuid !== undefined) uuids.set(line.offset, rec.uuid);
          if (rec.type === 'assistant') {
            const u = usageOfRecord(rec, { fileId: file.id, byteOffset: line.offset });
            if (u !== null) usageList.push(u);
          }
        },
      },
    );
    const parsed: Parsed[] = batch.items.map((item) => ({
      uuid: uuids.get(item.offset) ?? null,
      events: item.events,
      rows: item.rows.map((row) => ({ t: 'event' as const, row: row.lineNo === 0 ? { ...row, lineNo: null } : row })),
      offset: item.offset,
    }));
    const { invalidJson, notObject, shapeInvalid, unknownTypes, normalizeFailed } = batch.counters;
    return {
      parsed,
      usage: usageList,
      counters: { invalidJson, notObject, shapeInvalid, unknownTypes, normalizeFailed },
      taken: batch.taken,
    };
  }

  async function readRange(
    file: FileState,
    phase: ImportPhase,
    from: number,
    to: number,
    deadline: number,
    firstLineNo: number,
    resumeSkip: boolean,
    acceptTail: boolean,
  ): Promise<ReadOutcome> {
    const res = await readLines(file.path, from, to, deadline, {
      chunkBytes,
      sliceBytes: chunkBytes,
      acceptValidUnterminatedTail: acceptTail,
      firstLineNo,
      resumeSkip,
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    });
    let lines = res.lines;
    let cut: RawLine | null = null;
    if (phase === 'head') {
      const over = lines.findIndex((line) => line.lineNo > CLASSIFY_LINE_LIMIT);
      if (over >= 0) {
        cut = lines[over] ?? null;
        lines = lines.slice(0, over);
      }
    }
    const lineNoKnown = phase === 'head' || (phase === 'tail' && file.tailLineNo !== null);
    const done = normalizeLines(file, phase, lines, lineNoKnown, settings.sliceMs);
    // where the next slice starts: the line after the last one taken (a deadline), the line past the head limit, or the end
    const stopped = done.taken < lines.length ? (lines[done.taken] ?? null) : cut;
    const nextOffset = stopped === null ? res.nextOffset : stopped.offset;
    return {
      parsed: done.parsed,
      usage: done.usage,
      counters: done.counters,
      lineCount: done.taken,
      nextOffset,
      nextLineNo: stopped === null ? res.nextLineNo : stopped.lineNo,
      skipping: stopped === null ? res.skipping : false,
      partialBytes: stopped === null ? res.partialBytes : 0,
      eof: stopped === null ? res.eof : false,
      tail: {
        oversized: res.counters.oversized,
        utf8Invalid: res.counters.utf8Invalid,
        bomStripped: res.counters.bomStripped,
        crlfLines: res.counters.crlfLines,
      },
      bytes: Math.max(0, nextOffset - from),
      cutAt: cut === null ? null : cut.offset,
    };
  }

  function cursorCounters(out: ReadOutcome): CursorCounters {
    return nonZero({
      invalidJson: out.counters.invalidJson,
      notObject: out.counters.notObject,
      shapeInvalid: out.counters.shapeInvalid,
      unknownTypes: out.counters.unknownTypes,
      oversized: out.tail.oversized,
      utf8Invalid: out.tail.utf8Invalid,
      bomStripped: out.tail.bomStripped,
      crlfLines: out.tail.crlfLines,
    });
  }

  /** Drops the `activity` events of records that another file holds already (resume copies). Returns how many records are copies. */
  function dropCopiedActivity(file: FileState, out: ReadOutcome): number {
    const uuids = out.parsed.flatMap((p) => (p.uuid === null ? [] : [p.uuid]));
    const copied = copiedUuids(file, uuids);
    if (copied.size === 0) return 0;
    let n = 0;
    for (const p of out.parsed) {
      if (p.uuid !== null && copied.has(p.uuid)) {
        n += 1;
        const kept = p.events.filter((event) => event.k !== 'activity');
        p.events.length = 0;
        p.events.push(...kept);
      }
    }
    return n;
  }

  function itemsOf(out: ReadOutcome): IngestItem[] {
    return out.parsed.map((p) => ({ kind: 'record' as const, events: p.events, rows: p.rows }));
  }

  /** The usage of the slice, AFTER its record items: the writer applies it once the session and agent rows exist. */
  function withUsage(file: FileState, items: IngestItem[], out: ReadOutcome): IngestItem[] {
    items.push(...usageItems(file.id, out.usage));
    return items;
  }

  function bytesOf(out: ReadOutcome, extra: number): number {
    return out.bytes + 512 + extra;
  }

  // ---- the identity of a file ---------------------------------------------------------------------------------------------------

  async function resetFile(file: FileState, reason: 'truncated' | 'replaced'): Promise<void> {
    let identity: FileIdentity;
    try {
      identity = await readIdentity(file.path);
    } catch {
      return;
    }
    withWriteTx(db, scope, (tx) => {
      events.deleteTranscriptOnly(scope, tx, file.id);
      events.detachTranscript(scope, tx, file.id);
      events.deleteOccurrences(scope, tx, file.id);
      for (let more = true; more;) more = usage.removeFile(scope, tx, file.id, { maxKeys: 500 }).more;
      files.resetIdentity(scope, tx, file.id, identity);
    });
    file.identity = identity;
    file.headEnd = file.backfillOffset = file.tailStart = file.tailOffset = file.partialBytes = file.lineCount = 0;
    file.usageState = 'partial';
    file.firstTs = null;
    file.maxTs = '';
    file.lastStop = '';
    file.lastAssistant = null;
    file.classifiedLines = 0;
    file.labelCache = null;
    file.behindSince = null;
    file.caughtOnce = false;
    file.headPos = file.headPartial = 0;
    file.headLineNo = 1;
    file.headSkipping = file.tailSkipping = file.backfillSkipping = false;
    file.headSeen = {};
    file.tailLineNo = null;
    file.normalizer = createNormalizerState();
    file.needsClassify = file.kind === 'session';
    file.metaSent = false;
    file.copyReported.clear();
    file.checkedSize = file.observedSize;
    file.checkedMtimeMs = file.observedMtimeMs;
    await give({
      source: 'transcript',
      bytes: 600,
      items: [
        {
          kind: 'record',
          events: [],
          rows: [
            {
              t: 'reconciliation',
              kind: 'identity_reset',
              sessionUid: file.sessionUid,
              at: clock.now(),
              detail: { reason, fileId: file.id },
            },
            {
              t: 'error',
              error: ingestError('IDENTITY_RESET', 'transcript', { fileId: file.id, byteOffset: 0, detail: reason }),
            },
          ],
        },
      ],
    });
  }

  /** Looks at the file before a slice: gone, unreadable, replaced, or fine. */
  async function prepare(file: FileState): Promise<'ok' | 'reset' | 'gone'> {
    const lowest = Math.max(file.headEnd, file.backfillOffset, file.tailOffset);
    const check = await checkIdentity(file.path, file.identity, file.checkedSize, lowest, file.checkedMtimeMs);
    if (check.kind === 'missing') {
      markState(file, 'missing');
      return 'gone';
    }
    if (check.kind === 'unreadable') {
      if (file.state !== 'unreadable') {
        markState(file, 'unreadable');
        await give({
          source: 'transcript',
          bytes: 400,
          items: [
            {
              kind: 'record',
              events: [],
              rows: [
                {
                  t: 'error',
                  error: ingestError('READ_FAILED', 'transcript', { fileId: file.id, detail: check.code }),
                },
              ],
            },
          ],
          cursor: { kind: 'transcript', fileId: file.id, cursor: { counters: { readErrors: 1 } } },
        });
      }
      return 'gone';
    }
    if (check.kind === 'reset') {
      markState(file, 'active');
      file.observedSize = Number(check.stat.size);
      file.observedMtimeMs = Number(check.stat.mtimeMs);
      await resetFile(file, check.reason);
      return 'reset';
    }
    if (file.state !== 'active') markState(file, 'active');
    file.observedSize = Number(check.stat.size);
    file.observedMtimeMs = Number(check.stat.mtimeMs);
    file.checkedSize = file.observedSize;
    file.checkedMtimeMs = file.observedMtimeMs;
    if (
      file.identity === null ||
      (file.identity.headLen < IDENTITY_HEAD_BYTES && file.observedSize > file.identity.headLen)
    ) {
      try {
        file.identity = await readIdentity(file.path, check.stat);
        file.identityDirty = true;
      } catch {
        return 'gone';
      }
    }
    return 'ok';
  }

  // ---- one slice ----------------------------------------------------------------------------------------------------------------

  function identityUpdate(file: FileState): Pick<FileCursorUpdate, 'identity'> {
    if (file.identity === null || !file.identityDirty) return {};
    return { identity: { ino: file.identity.ino, headLen: file.identity.headLen, headHash: file.identity.headHash } };
  }

  /** Re-evaluates the usage state: complete once the backfill is done and the tail has caught up once (never back). */
  function usageStateOf(file: FileState): UsageState {
    if (file.usageState === 'skipped_backfill') return 'skipped_backfill';
    const backfillDone = file.backfillOffset >= file.tailStart;
    const caught = file.observedSize <= file.tailOffset + file.partialBytes;
    if (backfillDone && (caught || file.caughtOnce)) {
      file.caughtOnce = true;
      return 'complete';
    }
    return 'partial';
  }

  function behindOf(file: FileState, now: number): number | null {
    const behind = file.observedSize - file.tailOffset - file.partialBytes > 0;
    return behind ? (file.behindSince ?? now) : null;
  }

  async function afterSlice(file: FileState, copies: number): Promise<void> {
    await ensureLinked(file);
    if (copies > 0) await reportCopies(file);
    if (file.needsClassify && file.kind === 'session') {
      file.needsClassify = false;
      await classifyFile(file);
    }
  }

  /** `session.seen` of a main transcript: what the head said about the session (cwd, entrypoint, version, branch). */
  function seenItem(file: FileState): IngestItem[] {
    if (file.kind !== 'session') return [];
    const seen = file.headSeen;
    const at = seen.firstAtMs ?? file.observedMtimeMs ?? clock.now();
    return [
      eventItem([
        {
          k: 'session.seen',
          sessionId: file.sessionUid,
          stamp: { at, rank: 0, tie: `t:${String(file.id)}:seen` },
          transcriptPath: file.path,
          ...(seen.cwd === undefined ? {} : { cwd: seen.cwd }),
          ...(seen.entrypoint === undefined ? {} : { entrypoint: seen.entrypoint }),
          ...(seen.version === undefined ? {} : { version: seen.version }),
          ...(seen.gitBranch === undefined ? {} : { gitBranch: seen.gitBranch }),
        },
      ]),
    ];
  }

  /** `agent.meta` of an agent file, ahead of its first records: it fixes the kind (subagent or workflow agent) of the row. */
  async function metaItem(file: FileState): Promise<IngestItem[]> {
    if (file.agentUid === null || file.metaSent) return [];
    const meta = await readAgentMeta(file.path, fsx);
    return [
      eventItem([
        {
          k: 'agent.meta',
          sessionId: file.sessionUid,
          agentId: file.agentUid,
          ...(meta?.agentType === undefined ? {} : { agentType: meta.agentType }),
          ...(meta?.description === undefined ? {} : { description: meta.description }),
          ...(meta?.model === undefined ? {} : { model: meta.model }),
          ...(meta?.requestShape === undefined ? {} : { requestShape: meta.requestShape }),
          ...(meta?.spawnToolUseId === undefined ? {} : { spawnToolUseId: meta.spawnToolUseId }),
          ...(file.runUid === null ? {} : { workflowRunId: file.runUid }),
          ...(meta?.workflowPhase === undefined ? {} : { workflowPhase: meta.workflowPhase }),
        },
      ]),
    ];
  }

  async function headSlice(file: FileState, deadline: number): Promise<SliceOutcome> {
    const size = file.observedSize;
    const out = await readRange(file, 'head', file.headPos, size, deadline, file.headLineNo, file.headSkipping, true);
    const now = clock.now();
    const items = itemsOf(out);
    const meta = await metaItem(file);
    items.unshift(...meta);
    const limitReached = out.nextLineNo > CLASSIFY_LINE_LIMIT || out.nextOffset >= settings.headMaxBytes;
    const done = (limitReached || out.eof) && out.nextOffset > 0;
    const counters = cursorCounters(out);
    const update: FileCursorUpdate = {
      sizeSeen: Math.max(file.sizeSeen, size),
      mtimeSeen: file.observedMtimeMs,
      lineCount: file.lineCount + out.lineCount,
      lastReadAt: now,
      counters,
      maxTsString: file.maxTs,
      ...identityUpdate(file),
    };
    if (done) {
      const headEnd = out.nextOffset;
      const tailStart =
        size - headEnd > settings.tailWindowBytes
          ? Math.max(headEnd, await lineStartAtOrAfter(file.path, size - settings.tailWindowBytes))
          : headEnd;
      const skipped = tailStart > headEnd && size > settings.backfillMaxBytes;
      file.headEnd = headEnd;
      file.tailStart = tailStart;
      file.tailOffset = tailStart;
      file.backfillOffset = skipped ? tailStart : headEnd;
      file.partialBytes = limitReached ? 0 : out.partialBytes;
      file.usageState = skipped ? 'skipped_backfill' : 'partial';
      file.tailLineNo = tailStart === headEnd ? out.nextLineNo : null;
      // an oversized line that is still being written continues into the first range that starts here
      file.tailSkipping = tailStart === headEnd && out.skipping;
      file.backfillSkipping = out.skipping && !skipped;
      file.usageState = usageStateOf(file);
      items.push(...seenItem(file));
      Object.assign(update, {
        headEnd,
        backfillOffset: file.backfillOffset,
        tailStart,
        tailOffset: tailStart,
        partialBytes: file.partialBytes,
        usageState: file.usageState,
        firstTsInOrder: file.firstTs,
        lastStopLegacy: file.lastStop === '' ? null : file.lastStop,
        behindSince: behindOf(file, now),
        lastGrowthAt: file.observedMtimeMs ?? now,
      } satisfies FileCursorUpdate);
    } else if (out.lineCount === 0 && Object.keys(counters).length === 0 && !file.identityDirty) {
      file.headPartial = out.partialBytes;
      file.checkedSize = size;
      return { progressed: false, bytes: 0 };
    }
    const copies = dropCopiedActivity(file, out);
    const batch: IngestBatch = {
      source: 'transcript',
      items: withUsage(file, items, out),
      bytes: bytesOf(out, 0),
      cursor: { kind: 'transcript', fileId: file.id, cursor: update },
    };
    if (!(await give(batch))) return { progressed: false, bytes: 0 };
    if (!done) {
      file.headPos = out.nextOffset;
      file.headLineNo = out.nextLineNo;
      file.headSkipping = out.skipping;
      file.headPartial = out.partialBytes;
    }
    file.sizeSeen = Math.max(file.sizeSeen, size);
    file.mtimeSeen = file.observedMtimeMs;
    file.lineCount += out.lineCount;
    file.identityDirty = false;
    if (meta.length > 0) file.metaSent = true;
    if (done) {
      file.needsClassify = file.kind === 'session';
      file.behindSince = update.behindSince ?? null;
      file.lastGrowthAt = file.observedMtimeMs ?? now;
    }
    await afterSlice(file, copies);
    return { progressed: true, bytes: out.bytes };
  }

  async function tailSlice(file: FileState, deadline: number): Promise<SliceOutcome> {
    const size = file.observedSize;
    const from = file.tailOffset;
    const out = await readRange(file, 'tail', from, size, deadline, file.tailLineNo ?? 1, file.tailSkipping, true);
    const now = clock.now();
    const grew = size > file.sizeSeen;
    const moved = out.nextOffset !== from || out.parsed.length > 0 || out.lineCount > 0;
    file.tailOffset = out.nextOffset;
    file.partialBytes = out.eof ? out.partialBytes : 0;
    file.tailSkipping = out.skipping;
    file.tailLineNo = file.tailLineNo === null ? null : out.nextLineNo;
    const sizeSeen = Math.max(file.sizeSeen, size);
    const state = usageStateOf(file);
    const update: FileCursorUpdate = {
      tailOffset: file.tailOffset,
      partialBytes: file.partialBytes,
      sizeSeen,
      mtimeSeen: file.observedMtimeMs,
      lineCount: file.lineCount + out.lineCount,
      lastReadAt: now,
      behindSince: behindOf(file, now),
      maxTsString: file.maxTs,
      lastStopLegacy: file.lastStop === '' ? null : file.lastStop,
      counters: cursorCounters(out),
      ...identityUpdate(file),
      ...(state === file.usageState ? {} : { usageState: state }),
      ...(grew ? { lastGrowthAt: file.observedMtimeMs ?? now } : {}),
    };
    const copies = dropCopiedActivity(file, out);
    if (!moved && !grew && Object.keys(update.counters ?? {}).length === 0 && !file.identityDirty) {
      file.checkedSize = size;
      return { progressed: false, bytes: 0 };
    }
    const items = withUsage(file, itemsOf(out), out);
    if (
      !(await give({
        source: 'transcript',
        items,
        bytes: bytesOf(out, 0),
        cursor: { kind: 'transcript', fileId: file.id, cursor: update },
      }))
    ) {
      return { progressed: false, bytes: 0 };
    }
    file.sizeSeen = sizeSeen;
    file.mtimeSeen = file.observedMtimeMs;
    file.lineCount += out.lineCount;
    file.behindSince = update.behindSince ?? null;
    file.usageState = state;
    if (grew) file.lastGrowthAt = file.observedMtimeMs ?? now;
    file.identityDirty = false;
    if (out.lineCount > 0 && file.classifiedLines < CLASSIFY_LINE_LIMIT) file.needsClassify = file.kind === 'session';
    await afterSlice(file, copies);
    return { progressed: true, bytes: out.bytes };
  }

  async function backfillSlice(file: FileState, deadline: number): Promise<SliceOutcome> {
    const from = file.backfillOffset;
    const out = await readRange(file, 'backfill', from, file.tailStart, deadline, 1, file.backfillSkipping, false);
    const now = clock.now();
    const stalled = out.nextOffset <= from && out.lineCount === 0 && !out.skipping;
    // a range that cannot be read at all is given up (counted) so that the work does not come back forever
    const next = stalled ? file.tailStart : out.nextOffset;
    file.backfillOffset = next;
    file.backfillSkipping = out.skipping;
    const state = usageStateOf(file);
    const update: FileCursorUpdate = {
      backfillOffset: next,
      lineCount: file.lineCount + out.lineCount,
      lastReadAt: now,
      maxTsString: file.maxTs,
      counters: { ...cursorCounters(out), ...(stalled ? { readErrors: 1 } : {}) },
      ...(state === file.usageState ? {} : { usageState: state }),
    };
    const copies = dropCopiedActivity(file, out);
    if (
      !(await give({
        source: 'transcript',
        items: withUsage(file, itemsOf(out), out),
        bytes: bytesOf(out, 0),
        cursor: { kind: 'transcript', fileId: file.id, cursor: update },
      }))
    ) {
      return { progressed: false, bytes: 0 };
    }
    file.lineCount += out.lineCount;
    file.usageState = state;
    await afterSlice(file, copies);
    return { progressed: true, bytes: out.bytes };
  }

  async function slice(work: ImportWork, deadline: number): Promise<SliceOutcome> {
    const file = states.get(work.fileId);
    if (file === undefined || closed || file.state === 'untracked' || file.state === 'retired') {
      return { progressed: false, bytes: 0 };
    }
    file.busy = true;
    try {
      const prepared = await prepare(file);
      if (prepared === 'gone') return { progressed: true, bytes: 0 };
      if (prepared === 'reset') return { progressed: true, bytes: 0 };
      switch (work.phase) {
        case 'head':
          return await headSlice(file, deadline);
        case 'tail':
          return await tailSlice(file, deadline);
        case 'backfill':
          return await backfillSlice(file, deadline);
      }
    } catch (error) {
      options.logger?.warn('transcript_slice_failed', {
        code: error instanceof Error ? error.name : 'unknown',
        phase: work.phase,
      });
      stats.sliceFailures += 1;
      return { progressed: false, bytes: 0 };
    } finally {
      file.busy = false;
    }
  }

  // ---- discovery -----------------------------------------------------------------------------------------------------------------

  function isKnown(sessionId: string): boolean {
    for (const file of states.values()) {
      if (file.sessionUid === sessionId && file.state !== 'untracked') return true;
    }
    const row = sessions.byUid(scope, sessionId);
    return row !== undefined && row.lastHookAt !== null;
  }

  function registerFile(d: DiscoveredFile): FileState {
    const key = routeKey(d.path);
    const sessionRowId = sessions.idByUid(scope, d.sessionId) ?? null;
    const agentRowId =
      sessionRowId !== null && d.agentId !== null ? (agents.byUid(scope, sessionRowId, d.agentId)?.id ?? null) : null;
    const runRowId =
      sessionRowId !== null && d.runId !== null ? (runs.byUid(scope, sessionRowId, d.runId)?.id ?? null) : null;
    const spec: NewTranscriptFile = {
      path: d.path,
      pathKey: key,
      kind: d.kind,
      sessionUid: d.sessionId,
      agentUid: d.agentId,
      runUid: d.runId,
      sessionId: sessionRowId,
      agentId: agentRowId,
      workflowRunId: runRowId,
      birthMs: d.birthMs,
      firstSeenMtimeMs: Math.floor(d.mtimeMs),
      mtimeSeen: Math.floor(d.mtimeMs),
    };
    const { id } = withWriteTx(db, scope, (tx) => files.register(scope, tx, spec));
    const row = files.get(scope, id);
    if (row === undefined) throw new Error('a registered transcript file has no row');
    const state = fromRow(row);
    state.observedSize = d.size;
    state.observedMtimeMs = Math.floor(d.mtimeMs);
    // a new file is brand new: nothing about it is known yet
    state.checkedSize = state.sizeSeen;
    state.checkedMtimeMs = state.mtimeSeen;
    states.set(id, state);
    byKey.set(key, state);
    return state;
  }

  async function refreshSmallFiles(session: DiscoveredSession, found: DiscoveredFile[]): Promise<void> {
    const items: IngestItem[] = [];
    if (session.customTitlePath !== null) {
      const st = await fsx.lstat(session.customTitlePath);
      const key = st === null ? null : `${String(st.size)}:${String(Math.floor(st.mtimeMs))}`;
      if (key !== null && titleKeys.get(session.sessionId) !== key) {
        titleKeys.set(session.sessionId, key);
        const title = await readCustomTitle(session.customTitlePath, fsx);
        if (title !== null) {
          items.push(
            eventItem([{ k: 'title', sessionId: session.sessionId, source: TITLE_KIND, value: title, order: 0 }]),
          );
        }
      }
    }
    for (const d of found) {
      if (d.kind !== 'workflow_status') continue;
      const state = byKey.get(routeKey(d.path));
      const key = `${String(d.size)}:${String(Math.floor(d.mtimeMs))}`;
      if (state === undefined || state.smallKey === key) continue;
      state.smallKey = key;
      const doc = await readWorkflowStatus(d.path, fsx);
      if (doc === null || d.runId === null) continue;
      items.push(
        eventItem([
          {
            k: 'workflow.status',
            sessionId: d.sessionId,
            runId: d.runId,
            observedAt: Math.floor(d.mtimeMs),
            fileStatus: doc.status ?? null,
            ...(doc.agentCount === undefined ? {} : { agentCount: doc.agentCount }),
            started: 0,
            results: 0,
            failed: 0,
          },
        ]),
      );
      const size = d.size;
      state.sizeSeen = size;
      state.headEnd = state.backfillOffset = state.tailStart = state.tailOffset = size;
      await give({
        source: 'transcript',
        items: [],
        bytes: 100,
        cursor: {
          kind: 'transcript',
          fileId: state.id,
          cursor: {
            headEnd: size,
            backfillOffset: size,
            tailStart: size,
            tailOffset: size,
            sizeSeen: size,
            mtimeSeen: Math.floor(d.mtimeMs),
            usageState: 'complete',
            lastReadAt: clock.now(),
          },
        },
      });
    }
    if (items.length > 0) await give({ source: 'transcript', items, bytes: 200 * items.length });
    for (const d of found) {
      const state = d.kind === 'workflow_status' ? byKey.get(routeKey(d.path)) : undefined;
      if (state !== undefined) await ensureLinked(state);
    }
  }

  async function trackSessions(found: readonly DiscoveredSession[]): Promise<number> {
    const fresh: DiscoveredFile[] = [];
    for (const session of found) {
      for (const d of session.files) {
        const known = byKey.get(routeKey(d.path));
        if (known === undefined) {
          fresh.push(d);
          continue;
        }
        if (known.busy) continue;
        known.observedSize = d.size;
        known.observedMtimeMs = Math.floor(d.mtimeMs);
        if (known.state === 'untracked' && d.mtimeMs >= clock.now() - settings.lookbackHours * HOUR_MS) {
          markState(known, 'active');
        }
      }
    }
    // the oldest first: an original is imported before the resume copy made from it (02 6.2 rule 7)
    fresh.sort((a, b) => (a.birthMs ?? a.mtimeMs) - (b.birthMs ?? b.mtimeMs) || a.path.localeCompare(b.path));
    for (const d of fresh) registerFile(d);
    for (const session of found) {
      await refreshSmallFiles(session, session.files);
    }
    return fresh.length;
  }

  function untrackIdle(now: number): void {
    for (const file of states.values()) {
      if (file.busy || !active(file) || file.kind === 'workflow_status') continue;
      const lastChange = file.lastGrowthAt ?? file.mtimeSeen ?? file.discoveredAt;
      if (now - lastChange <= settings.untrackAfterHours * HOUR_MS) continue;
      if (headDone(file) && file.observedSize > file.tailOffset + file.partialBytes) continue;
      const view = sessions.byUid(scope, file.sessionUid)?.state;
      if (view === 'completed' || view === 'failed' || view === 'stale') markState(file, 'untracked');
    }
  }

  async function discover(): Promise<DiscoverySummary> {
    loadKnown();
    if (tdir === null || closed) return { sessions: 0, newFiles: 0, symlinksSkipped: 0, missingDir: tdir === null };
    discovering += 1;
    try {
      const now = clock.now();
      const result = await discoverTranscripts(
        tdir,
        { nowMs: now, lookbackMs: settings.lookbackHours * HOUR_MS, pinned, isKnown },
        fsx,
      );
      const newFiles = await trackSessions(result.sessions);
      untrackIdle(now);
      for (const file of [...states.values()]) {
        if (file.needsClassify && file.kind === 'session' && !file.busy && headDone(file) && active(file)) {
          file.needsClassify = false;
          await classifyFile(file);
        }
      }
      stats.lastScanAt = clock.now();
      return {
        sessions: result.sessions.length,
        newFiles,
        symlinksSkipped: result.counters.symlinksSkipped,
        missingDir: result.missing,
      };
    } finally {
      discovering -= 1;
    }
  }

  async function discoverSession(sessionId: string): Promise<boolean> {
    loadKnown();
    if (tdir === null || closed) return false;
    discovering += 1;
    try {
      const found = await discoverOneSession(tdir, sessionId, fsx);
      if (found === null) return false;
      await trackSessions([found]);
      return true;
    } finally {
      discovering -= 1;
    }
  }

  // ---- the stat cycle ---------------------------------------------------------------------------------------------------------------

  async function statOne(file: FileState): Promise<void> {
    try {
      const st = await nodeStat(file.path);
      if (!st.isFile()) return;
      file.observedSize = st.size;
      file.observedMtimeMs = Math.floor(st.mtimeMs);
      if (file.state === 'missing' || file.state === 'unreadable') {
        if (!file.busy) markState(file, 'active');
      }
    } catch (error) {
      if (file.busy) return;
      const code = errorCodeOf(error);
      markState(file, classifyFsError(code) === 'missing' ? 'missing' : 'unreadable');
    }
  }

  async function statTick(): Promise<void> {
    loadKnown();
    const list = [...states.values()].filter(
      (file) => file.state !== 'untracked' && file.state !== 'retired' && file.kind !== 'workflow_status',
    );
    for (let i = 0; i < list.length; i += STAT_PARALLEL) {
      await Promise.all(list.slice(i, i + STAT_PARALLEL).map(statOne));
    }
    stats.lastScanAt = clock.now();
    refreshStats();
    if (stats.bytesBehind === 0 && discovering === 0) stats.lastSyncAt = clock.now();
  }

  function refreshStats(): void {
    const now = clock.now();
    let tracked = 0;
    let missing = 0;
    let unreadable = 0;
    let behind = 0;
    let backfill = 0;
    let oldest: number | null = null;
    for (const file of states.values()) {
      if (file.kind === 'workflow_status') continue;
      if (file.state === 'missing') missing += 1;
      else if (file.state === 'unreadable') unreadable += 1;
      if (file.state === 'untracked' || file.state === 'retired') continue;
      tracked += 1;
      if (file.state !== 'active') continue;
      const own = headDone(file)
        ? Math.max(0, file.observedSize - file.tailOffset - file.partialBytes)
        : Math.max(0, file.observedSize - file.headPos - file.headPartial);
      behind += own;
      if (own > 0) oldest = Math.min(oldest ?? Number.POSITIVE_INFINITY, file.behindSince ?? now);
      if (headDone(file) && file.usageState === 'partial')
        backfill += Math.max(0, file.tailStart - file.backfillOffset);
    }
    stats.filesTracked = tracked;
    stats.filesMissing = missing;
    stats.filesUnreadable = unreadable;
    stats.bytesBehind = behind;
    stats.backfillRemainingBytes = backfill;
    stats.maxLagMs = oldest === null ? 0 : Math.max(0, now - oldest);
  }

  // ---- the public object ---------------------------------------------------------------------------------------------------------------

  function workList(): ImportWork[] {
    loadKnown();
    const out: ImportWork[] = [];
    for (const file of states.values()) out.push(...workOf(file));
    return out.sort((a, b) => a.priority - b.priority || a.fileId - b.fileId);
  }

  return {
    setTranscriptsDir(dir) {
      tdir = dir;
    },
    setRules(next, nextPinned) {
      rules = compileSessionRules(next);
      pinned = new Set(nextPinned);
      for (const file of states.values()) if (file.kind === 'session') file.needsClassify = true;
    },
    discover,
    discoverSession,
    statTick,
    work: workList,
    runSlice(work, deadline) {
      const next = chain.then(() => slice(work, deadline));
      chain = next.catch(() => undefined);
      return next;
    },
    stats() {
      refreshStats();
      return { ...stats };
    },
    isIdle() {
      return discovering === 0 && workList().length === 0 && ![...states.values()].some((f) => f.busy);
    },
    close() {
      closed = true;
      for (const wake of drainWaiters.splice(0)) wake();
    },
  };
}
