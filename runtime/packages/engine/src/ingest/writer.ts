// The single ingestion writer (02 4.6, 4.7, I-16; registry 2.4): every producer (the spool drainer, the transcript importer,
// the external pollers, the sweeper) hands it `IngestBatch`es, and it is the only code that turns them into rows.
//
// Persist before publish. One `withWriteTx` per tick: the batches of the tick are applied, their cursors move in the SAME
// transaction as the rows derived from the bytes the cursor passed, and only after COMMIT do the `onCommitted` listeners
// run (the stream hub publishes; this writer's own listener swaps the working facts into its cache). A throw rolls back,
// publishes nothing and leaves the cache as it was; the batch is retried with backoff, then split until the one item that
// cannot be stored is recorded as `PERSIST_FAILED` and dropped while its cursor advances, so the pipeline never wedges.
//
// Delivery is at-least-once and idempotent: a line read twice is a dedupe hit (D-1 to D-4, `dedupe.ts`), and the facts merge
// (02 7.2) is idempotent by construction. No file I/O happens inside a transaction: producers read before they `submit`.
//
// Activity-only announcements (a session or an agent that changed without a change of its lifecycle view, the ingestion health)
// go through the activity throttle of `change-sink.ts` when the owner passes one (`IngestWriterOptions.throttle`, the ingest
// service does): at most one per second and entity, the rest is held back and `flushActivity` announces it from the one-second
// job of the schedule (03 3.6). Without a throttle every committed activity is announced once per transaction and entity.
//
// Deviation from 02 4.6: a transaction takes at most `maxItemsPerTx` items (it does not measure the 8 ms of work, it adapts the
// cap to the last transaction's duration).
import { performance } from 'node:perf_hooks';
import { setTimeout as sleepFor } from 'node:timers/promises';

import { AGENT_RE, SUMMARY_MAX_CP, canonicalJsonHash, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import { z } from 'zod';

import {
  createChangeSink,
  INSTANCE_KEY,
  type ActivityThrottle,
  type ChangeSink,
  type ReservedChange,
} from '../db/change-sink.ts';
import { isDbError } from '../db/errors.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AgentsRepo, type NewAgent } from '../db/repos/agents.ts';
import { CostStatesRepo } from '../db/repos/cost-states.ts';
import { EventsRepo } from '../db/repos/events.ts';
import { HookProbesRepo } from '../db/repos/hook-probes.ts';
import { IngestErrorsRepo } from '../db/repos/ingest-errors.ts';
import { IngestHealthRepo } from '../db/repos/ingest-health.ts';
import { ProjectsRepo } from '../db/repos/projects.ts';
import {
  ReconciliationsRepo,
  type ReconciliationDetail,
  type ReconciliationKind,
} from '../db/repos/reconciliations.ts';
import { SessionsRepo, type SessionPatch, type SessionRow, type StoredView } from '../db/repos/sessions.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../db/repos/spool-cursors.ts';
import { ToolCallsRepo, type ToolCallRow as DbToolCall, type ToolCallWrite } from '../db/repos/tool-calls.ts';
import { TranscriptFilesRepo, type FileCursorUpdate } from '../db/repos/transcript-files.ts';
import { TurnsRepo, type TurnEndKind } from '../db/repos/turns.ts';
import { UsageRepo, type UsageValues } from '../db/repos/usage.ts';
import { WorkflowRunsRepo } from '../db/repos/workflow-runs.ts';
import { withWriteTx, onCommitted, type WriteTx } from '../db/write.ts';
import { deriveModel } from '../lifecycle/derive-session.ts';
import {
  DEFAULT_LIFECYCLE_CFG,
  emptySessionFacts,
  parseAgentFacts,
  parseSessionFacts,
  parseWorkflowFacts,
  type EventOrigin,
  type LifecycleCfg,
  type LifecycleView,
  type ToolCallRow as ModelToolCall,
} from '../lifecycle/facts.ts';
import { agentFactsOf, applyEvent, emptyModel, workflowFactsOf, type LifecycleModel } from '../lifecycle/merge.ts';
import type { Logger } from '../log/logger.ts';
import { clipCodePoints } from '../platform/fsx.ts';
import { projectOfSeen, type SeenProject } from '../projects/folder-key.ts';
import { commitFailureLogFields, describeFailure, persistFailedDetail } from './commit-failure.ts';
import {
  CONTENT_WINDOW_MS,
  emptyDuplicateCounts,
  judgeHookRow,
  layerOfSilentInsert,
  type DuplicateCounts,
} from './dedupe.ts';
import { IngestWriterClosedError, type IngestErrorRecord } from './errors.ts';
import type { EventRowWrite, LogicalEvent } from './event-row.ts';
import { normalizeEnvelope, type EnvelopeLocation } from './hooks/normalize-envelope.ts';
import { linkTranscriptFile, type LinkRepos } from './link-file.ts';

// ---- the public contract (02 4.6) ------------------------------------------------------------------------------------

/**
 * One write that is not a logical event: an `events` row, a probe, an ingest error, a reconciliation record or the token usage
 * of one transcript record (`usage`: the writer links the file to its session and agent first, in the same transaction, and
 * announces the sessions and agents whose rollups changed, ADR 0015, 02 5.3).
 */
export type RowWrite =
  | { readonly t: 'event'; readonly row: EventRowWrite }
  | { readonly t: 'usage'; readonly fileId: number; readonly messageKey: string; readonly values: UsageValues }
  | { readonly t: 'probe'; readonly probeSessionId: string; readonly receivedAt: number }
  | { readonly t: 'error'; readonly error: IngestErrorRecord }
  | {
      readonly t: 'reconciliation';
      readonly kind: ReconciliationKind;
      /** null = instance level. */
      readonly sessionUid: string | null;
      readonly at: number;
      readonly detail: ReconciliationDetail;
    };

/**
 * What a `derive` item re-derives (02 4.6, 7.8): the session, and the views of the named subagents (`agent_uid`) and workflow
 * runs (`run_uid`) of that session, which are written even though none of their events arrived. A session that does not exist
 * (retention removed it) is not created again; a name that is not a row of the session is ignored.
 */
export interface DeriveTarget {
  readonly sessionId: string;
  readonly agents?: readonly string[];
  readonly runs?: readonly string[];
}

export interface IngestItem {
  readonly kind: 'envelope' | 'record' | 'external' | 'derive';
  readonly events: readonly LogicalEvent[];
  readonly rows: readonly RowWrite[];
  /** Only for `kind: 'derive'`, which carries no event (the sweeper). */
  readonly derive?: DeriveTarget;
}

export type CursorUpdate =
  | { readonly kind: 'spool'; readonly segment: string; readonly cursor: NewSpoolCursor }
  /** Retention deleted the segment: its cursor goes with it. */
  | { readonly kind: 'spool_forget'; readonly segment: string }
  | { readonly kind: 'transcript'; readonly fileId: number; readonly cursor: FileCursorUpdate };

export interface IngestBatch {
  readonly source: 'spool' | 'transcript' | 'external' | 'sweeper';
  readonly items: readonly IngestItem[];
  readonly cursor?: CursorUpdate;
  /** Bytes the batch holds in memory: the backpressure bound (`ingest.queueMaxBytes`). */
  readonly bytes: number;
}

export interface IngestWriterStats {
  queued: number;
  queuedBytes: number;
  lastCommitAt: number | null;
  failures: number;
  /** The last transaction failure, as a code and a time (never a message: it may carry data). */
  lastError: { code: string; at: number } | null;
  /** True while a full disk or a failing database pauses ingestion (`persisted.status = db_error`, 02 4.6 step 7). */
  paused: boolean;
}

export interface IngestWriter {
  /** false = the queue is full and the batch was NOT taken: keep it, stop reading, resubmit after `onDrain`. */
  submit(batch: IngestBatch): boolean;
  /** Called (every time) when a queue that refused a batch has room again. */
  onDrain(cb: () => void): void;
  /** Resolves when everything submitted before the call is committed (tests, shutdown). */
  flushNow(): Promise<void>;
  readonly stats: Readonly<IngestWriterStats>;
}

/** The writer plus what its owner (the ingest service) needs. */
export interface IngestWriterHandle extends IngestWriter {
  /**
   * Runs `fn` between two transactions of the writer, never inside one (replay, 02 2.7 step 4). `fn` may itself open a
   * `withWriteTx`: no writer transaction is open at that moment.
   */
  runExclusive<T>(fn: () => T): Promise<T>;
  /**
   * Announces the activity-only updates the throttle held back, once their window has passed (03 3.6): the job of the schedule
   * that runs every second calls it. It runs between two transactions, ahead of the batches that are queued (it depends on none
   * of them), stamps `updated_seq` of the rows it announces, and puts the announcements back when its transaction fails (the
   * error is thrown). Nothing to do without a throttle, while nothing is deferred or before the window has passed; resolves
   * after `close`.
   */
  flushActivity(): Promise<void>;
  /** Stops taking work; resolves when the transaction in progress (if any) is finished. Queued batches are dropped (they are re-read). */
  close(): Promise<void>;
}

export interface IngestWriterOptions {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly lifecycle?: LifecycleCfg;
  readonly logger?: Logger;
  /**
   * The activity throttle of this writer (03 3.6): one per writer, shared by every transaction. Without one every commit
   * announces its activity. The state of a throttle is not rolled back with a transaction: a batch that is retried records its
   * updates again, they are deferred and flushed, never lost.
   */
  readonly throttle?: ActivityThrottle;
  /** `ingest.queueMaxItems` (default 5000). */
  readonly queueMaxItems?: number;
  /** `ingest.queueMaxBytes` (default 32 MiB). */
  readonly queueMaxBytes?: number;
  /** Cap of items per transaction (default 500, 02 4.6 step 1). */
  readonly maxItemsPerTx?: number;
  /** Sessions whose facts stay in memory (default 2000). */
  readonly factsCacheSize?: number;
  /** D-3 window (default 2000 ms). */
  readonly contentWindowMs?: number;
  /** First retry delay (default 100 ms), doubled up to `retryMaxMs` (default 5000). */
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Pause after a full disk (default 30 s). */
  readonly dbErrorPauseMs?: number;
  /** Delay seam of the tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: called inside the transaction after the last write, before COMMIT. A throw rolls the transaction back. */
  readonly beforeCommit?: (tx: WriteTx, batches: readonly IngestBatch[]) => void;
}

const DEFAULT_QUEUE_ITEMS = 5000;
const DEFAULT_QUEUE_BYTES = 32 * 1024 * 1024;
const DEFAULT_ITEMS_PER_TX = 500;
const MIN_ITEMS_PER_TX = 20;
const TARGET_TX_MS = 40;
const DEFAULT_CACHE = 2000;
const ERRORS_KEPT = 1000;
const TRIM_EVERY_ERRORS = 100;
const TOOLS_KEPT_IN_MODEL = 1000;
/** Usage rows per item (about 8 ms of work): the adaptive item cap of a transaction then bounds the usage work too. */
export const USAGE_ROWS_PER_ITEM = 50;
/** The limit of `cost_states.model_usage_json`: a longer record keeps its total and loses the per-model split. */
const MODEL_USAGE_JSON_MAX = 8192;

// ---- small helpers ---------------------------------------------------------------------------------------------------

function originOf(kind: IngestItem['kind']): EventOrigin | null {
  switch (kind) {
    case 'envelope':
      return 'hook';
    case 'record':
      return 'transcript';
    case 'external':
      return 'external';
    case 'derive':
      return null;
  }
}

function itemCount(batch: IngestBatch): number {
  return Math.max(batch.items.length, 1);
}

/**
 * The time an event happened, for the first-seen time of a session that this event creates. A job event carries the time of
 * the job file, which may be older than the first record of the session: it opens with the write time (ADR 0069 item 5).
 */
function atOf(event: LogicalEvent, fallback: number): number {
  if (event.k === 'external.job') return fallback;
  if (
    event.k === 'workflow.status' ||
    event.k === 'external.registry' ||
    event.k === 'external.attempt' ||
    event.k === 'external.attempt_cleared'
  ) {
    return event.observedAt;
  }
  if (event.k === 'external.pid') return event.checkedAt;
  return 'stamp' in event ? event.stamp.at : fallback;
}

function storedView(view: LifecycleView): StoredView {
  return {
    state: view.state,
    presence: view.presence,
    waitReason: view.waitReason,
    staleKind: view.staleKind,
    endReason: view.endReason,
    turnOutcome: view.turnOutcome,
    basis: view.basis,
    confidence: view.confidence,
    ruleId: view.ruleId,
    evidence: view.evidence,
    since: view.since,
    evaluatedAt: view.evaluatedAt,
    nextCheckAt: view.nextCheckAt,
  };
}

function maxOf(...values: (number | null | undefined)[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value !== null && value !== undefined && value > best) best = value;
  return best;
}

const CountersSchema = z.object({
  envelopes: z.number().int().nonnegative(),
  probes: z.number().int().nonnegative(),
  persistFailed: z.number().int().nonnegative(),
  duplicates: z.record(z.string(), z.number().int().nonnegative()),
  errors: z.record(z.string(), z.number().int().nonnegative()),
});

type Counters = z.infer<typeof CountersSchema>;

function freshCounters(): Counters {
  return { envelopes: 0, probes: 0, persistFailed: 0, duplicates: {}, errors: {} };
}

/** The durable counters of `ingest_health`; a damaged column starts again from zero (the table rows are the record). */
function parseCounters(text: string): Counters {
  try {
    const parsed = CountersSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : freshCounters();
  } catch {
    return freshCounters();
  }
}

function addTo(target: Record<string, number>, key: string, by: number): void {
  target[key] = (target[key] ?? 0) + by;
}

/** A row without its bookkeeping columns, as text: two equal keys mean a write that changed nothing visible. */
function rowKey(row: object | undefined): string {
  return JSON.stringify(row === undefined ? null : { ...row, updatedAt: 0, updatedSeq: 0 });
}

/** Only the fields that differ from the stored row: a replay changes (and announces) nothing. */
function changedSessionPatch(row: SessionRow, wanted: SessionPatch): SessionPatch {
  const patch: SessionPatch = {};
  if (wanted.startedAt !== undefined && wanted.startedAt !== row.startedAt) patch.startedAt = wanted.startedAt;
  if (wanted.lastActivityAt !== undefined && wanted.lastActivityAt !== row.lastActivityAt) {
    patch.lastActivityAt = wanted.lastActivityAt;
  }
  if (wanted.lastHookAt !== undefined && wanted.lastHookAt !== row.lastHookAt) patch.lastHookAt = wanted.lastHookAt;
  if (wanted.endedAt !== undefined && wanted.endedAt !== row.endedAt) patch.endedAt = wanted.endedAt;
  if (wanted.eventCount !== undefined && wanted.eventCount !== row.eventCount) patch.eventCount = wanted.eventCount;
  if (wanted.errorCount !== undefined && wanted.errorCount !== row.errorCount) patch.errorCount = wanted.errorCount;
  if (wanted.warningCount !== undefined && wanted.warningCount !== row.warningCount) {
    patch.warningCount = wanted.warningCount;
  }
  if (wanted.agentCount !== undefined && wanted.agentCount !== row.agentCount) patch.agentCount = wanted.agentCount;
  if (wanted.cwd !== undefined && wanted.cwd !== row.cwd) patch.cwd = wanted.cwd;
  if (wanted.claudePid !== undefined && wanted.claudePid !== row.claudePid) patch.claudePid = wanted.claudePid;
  if (wanted.projectId !== undefined && wanted.projectId !== row.projectId) patch.projectId = wanted.projectId;
  return patch;
}

// ---- the working copy of one session inside one transaction ----------------------------------------------------------------

interface Working {
  readonly uid: string;
  readonly rowId: number;
  readonly mainAgentId: number;
  /** True when this transaction created the session row. */
  readonly created: boolean;
  startedAt: number;
  model: LifecycleModel;
  readonly agentIds: Map<string, number>;
  readonly agentUids: Map<number, string>;
  readonly runIds: Map<string, number>;
  readonly touchedAgents: Set<string>;
  readonly touchedRuns: Set<string>;
  readonly turnPrompts: Set<string>;
  readonly createdAgents: Set<string>;
  eventsInserted: number;
  errorEvents: number;
  warningEvents: number;
  /** Column patch from `session.seen` and friends; written once at the end. */
  readonly patch: { cwd?: string; entrypoint?: string; ccVersion?: string; gitBranch?: string; lastModel?: string };
  /**
   * The project this transaction learned from a `session.seen` that carried a transcript path (CAW design 03 2.5): the first
   * usable folder wins, a later event only fills a missing root. The row gets it once, at the end of the transaction.
   */
  project?: SeenProject;
  titleAi?: string;
  titleCustom?: string;
  continuedIn?: string;
  copiedFrom?: string;
  /** The total of the cost-state record this transaction stored (the newest record of its file): mirrored into the session. */
  reportedCost?: { readonly usd: number; readonly at: number };
}

interface TxState {
  readonly tx: WriteTx;
  readonly sink: ChangeSink;
  readonly working: Map<string, Working>;
  readonly dups: DuplicateCounts;
  readonly errors: Record<string, number>;
  envelopes: number;
  probes: number;
  persistFailed: number;
  lastEnvelopeAt: number | null;
  drained: boolean;
  errorRows: number;
  /** Sessions and agents (row ids) whose usage rollups changed: announced once each at the end of the transaction. */
  readonly rollupSessions: Set<number>;
  readonly rollupAgents: Set<number>;
  /** Files linked in this transaction. */
  readonly linkedFiles: Set<number>;
  /** The greatest byte offset of an event row of each transcript file stored in this transaction (the cost-state flag). */
  readonly fileTails: Map<number, number>;
  /**
   * The view changes of this transaction that the activity throttle is told about once the transaction has committed: the
   * state of the throttle is not rolled back, so a view change that is rolled back must not drop an announcement that an earlier
   * commit deferred (a poison batch, 03 3.6).
   */
  readonly viewAnnouncements: ViewAnnouncement[];
}

interface ViewAnnouncement {
  readonly entity: 'session' | 'agent';
  readonly key: string;
  readonly at: number;
}

interface Queued {
  readonly batch: IngestBatch;
  /**
   * The cursor of the batch this one was split from: a half carries no cursor of its own (only the last one moves it), but an
   * item of it that is dropped is still recorded with the file or the segment it was read from.
   */
  readonly origin?: CursorUpdate;
}

/** Where a dropped item was read: the transcript file and the offset of its line, or the spool segment; and its session. */
function referenceOf(
  item: IngestItem | undefined,
  origin: CursorUpdate | undefined,
): Pick<IngestErrorRecord, 'fileId' | 'byteOffset' | 'segment' | 'sessionUid'> {
  const row = item?.rows.find((r) => r.t === 'event');
  const eventRow = row?.t === 'event' ? row.row : undefined;
  const event = item?.events.find((e) => 'sessionId' in e);
  const sessionUid = eventRow?.sessionUid ?? item?.derive?.sessionId ?? (event === undefined ? null : event.sessionId);
  const fileId = origin?.kind === 'transcript' ? origin.fileId : null;
  return {
    ...(fileId === null ? {} : { fileId }),
    // the offset of the line, when the row of the item is a line of that file
    ...(fileId !== null && eventRow?.fileId === fileId && eventRow.byteOffset !== null
      ? { byteOffset: eventRow.byteOffset }
      : {}),
    ...(origin?.kind === 'spool' ? { segment: origin.segment } : {}),
    // `ingest_errors.session_uid` takes a session id only (36 characters)
    ...(typeof sessionUid === 'string' && sessionUid.length === 36 ? { sessionUid } : {}),
  };
}

interface Job {
  readonly run: () => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** The queue holds batches and exclusive jobs in submission order: a job never overtakes a batch submitted before it. */
type Entry = { readonly kind: 'batch'; readonly queued: Queued } | { readonly kind: 'job'; readonly job: Job };

export function createIngestWriter(options: IngestWriterOptions): IngestWriterHandle {
  const { db, scope } = options;
  const cfg = options.lifecycle ?? DEFAULT_LIFECYCLE_CFG;
  const queueMaxItems = options.queueMaxItems ?? DEFAULT_QUEUE_ITEMS;
  const queueMaxBytes = options.queueMaxBytes ?? DEFAULT_QUEUE_BYTES;
  const contentWindowMs = options.contentWindowMs ?? CONTENT_WINDOW_MS;
  const retryBaseMs = options.retryBaseMs ?? 100;
  const retryMaxMs = options.retryMaxMs ?? 5000;
  const dbErrorPauseMs = options.dbErrorPauseMs ?? 30_000;
  const cacheSize = options.factsCacheSize ?? DEFAULT_CACHE;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => sleepFor(ms));
  let itemsPerTx = Math.min(options.maxItemsPerTx ?? DEFAULT_ITEMS_PER_TX, DEFAULT_ITEMS_PER_TX * 10);
  const itemsPerTxCap = itemsPerTx;

  const sessions = new SessionsRepo(db);
  const projects = new ProjectsRepo(db);
  const agents = new AgentsRepo(db);
  const events = new EventsRepo(db);
  const toolCalls = new ToolCallsRepo(db);
  const turns = new TurnsRepo(db);
  const workflowRuns = new WorkflowRunsRepo(db);
  const probes = new HookProbesRepo(db);
  const ingestErrors = new IngestErrorsRepo(db);
  const ingestHealth = new IngestHealthRepo(db);
  const reconciliations = new ReconciliationsRepo(db);
  const spoolCursors = new SpoolCursorsRepo(db);
  const transcriptFiles = new TranscriptFilesRepo(db);
  const usage = new UsageRepo(db);
  const costStates = new CostStatesRepo(db);
  const { throttle } = options;
  const linkRepos: LinkRepos = { sessions, agents, runs: workflowRuns, files: transcriptFiles };

  // the facts cache: session uid -> committed model (insertion order = recency)
  const cache = new Map<string, LifecycleModel>();
  let pending: Map<string, Working> | null = null;

  const queue: Entry[] = [];
  const drainListeners: (() => void)[] = [];
  let queuedItems = 0;
  let queuedBytes = 0;
  let refused = false;
  let closed = false;
  /** Reads the flag through a call: a check after an `await` must not be narrowed by an earlier check of the same function. */
  const isClosed = (): boolean => closed;
  let wakeOnClose: () => void = () => undefined;
  /** Resolves when the writer is closed: a sleep (a backoff, a pause) never holds `close()` up. */
  const closing = new Promise<void>((resolve) => {
    wakeOnClose = resolve;
  });
  let looping: Promise<void> | null = null;
  let pausedUntil = 0;
  let errorsSinceTrim = 0;

  const stats: IngestWriterStats = {
    queued: 0,
    queuedBytes: 0,
    lastCommitAt: null,
    failures: 0,
    lastError: null,
    paused: false,
  };

  // the writer's own listener: after COMMIT, the working facts become the committed ones (persist, then swap)
  onCommitted(db, () => {
    if (pending === null) return;
    for (const [uid, working] of pending) {
      cache.delete(uid);
      cache.set(uid, working.model);
    }
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    pending = null;
  });

  // ---- model loading ---------------------------------------------------------------------------------------------

  function modelToolOf(row: DbToolCall, agentUids: ReadonlyMap<number, string>): ModelToolCall {
    const agentUid = agentUids.get(row.agentId);
    return {
      toolUseId: row.toolUseId,
      agentId: agentUid === undefined || agentUid === 'main' ? null : agentUid,
      name: row.name,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      batchAt: row.batchAt,
      outcome: row.outcome,
      inputHash: row.inputHash,
      link: null,
      transcriptUse: (row.sources & 4) !== 0,
      transcriptResult: (row.sources & 8) !== 0,
    };
  }

  /** The facts of a session that left the cache (or a restart), rebuilt from its rows (02 4.6 step 1). */
  function rebuildModel(w: Pick<Working, 'rowId' | 'agentUids' | 'agentIds' | 'runIds'>): LifecycleModel {
    let model = emptyModel();
    const stored = sessions.readView(scope, w.rowId);
    const session = (() => {
      try {
        return stored === undefined ? null : parseSessionFacts(JSON.parse(stored.factsJson));
      } catch {
        return null;
      }
    })();
    model = { ...model, session: session ?? emptySessionFacts() };

    const runs = workflowRuns.listBySession(scope, w.rowId);
    const runUidById = new Map<number, string>();
    const workflowFacts: LifecycleModel['workflows'] = {};
    for (const run of runs) {
      w.runIds.set(run.runUid, run.id);
      runUidById.set(run.id, run.runUid);
      const view = workflowRuns.readView(scope, run.id);
      const facts = (() => {
        try {
          return view === undefined ? null : parseWorkflowFacts(JSON.parse(view.factsJson));
        } catch {
          return null;
        }
      })();
      if (facts !== null) Object.assign(workflowFacts, { [run.runUid]: facts });
    }
    const agentFacts: LifecycleModel['agents'] = {};
    const spawns: Record<string, string> = {};
    const agentRuns: Record<string, string> = {};
    for (const agent of agents.listBySession(scope, w.rowId)) {
      w.agentIds.set(agent.agentUid, agent.id);
      w.agentUids.set(agent.id, agent.agentUid);
      if (agent.kind === 'main') continue;
      const view = agents.readView(scope, agent.id);
      const facts = (() => {
        try {
          return view === undefined ? null : parseAgentFacts(JSON.parse(view.factsJson));
        } catch {
          return null;
        }
      })();
      if (facts !== null) Object.assign(agentFacts, { [agent.agentUid]: facts });
      if (agent.spawnToolUseId !== null) Object.assign(spawns, { [agent.spawnToolUseId]: agent.agentUid });
      const run = agent.workflowRunId === null ? undefined : runUidById.get(agent.workflowRunId);
      if (run !== undefined) Object.assign(agentRuns, { [agent.agentUid]: run });
    }
    const tools: LifecycleModel['tools'] = {};
    for (const row of toolCalls.openForSession(scope, w.rowId, 200)) {
      Object.assign(tools, { [row.toolUseId]: modelToolOf(row, w.agentUids) });
    }
    return { ...model, agents: agentFacts, workflows: workflowFacts, spawns, agentRuns, tools };
  }

  function openWorking(c: TxState, uid: string, at: number): Working {
    const known = c.working.get(uid);
    if (known !== undefined) {
      if (at < known.startedAt) {
        sessions.ensure(scope, c.tx, { sessionUid: uid, projectId: null, startedAt: at });
        known.startedAt = at;
      }
      return known;
    }
    const ensured = sessions.ensure(scope, c.tx, { sessionUid: uid, projectId: null, startedAt: at });
    const row = sessions.byUid(scope, uid);
    const w: Working = {
      uid,
      rowId: ensured.id,
      mainAgentId: ensured.agentId,
      created: ensured.created,
      startedAt: row?.startedAt ?? at,
      model: emptyModel(),
      agentIds: new Map([['main', ensured.agentId]]),
      agentUids: new Map([[ensured.agentId, 'main']]),
      runIds: new Map(),
      touchedAgents: new Set(),
      touchedRuns: new Set(),
      turnPrompts: new Set(),
      createdAgents: new Set(),
      eventsInserted: 0,
      errorEvents: 0,
      warningEvents: 0,
      patch: {},
    };
    const cached = cache.get(uid);
    w.model = ensured.created ? emptyModel() : (cached ?? rebuildModel(w));
    if (cached !== undefined && !ensured.created) {
      // the maps are cheap: fill them even on a cache hit
      for (const agent of agents.listBySession(scope, w.rowId)) {
        w.agentIds.set(agent.agentUid, agent.id);
        w.agentUids.set(agent.id, agent.agentUid);
      }
      for (const run of workflowRuns.listBySession(scope, w.rowId)) w.runIds.set(run.runUid, run.id);
    }
    c.working.set(uid, w);
    return w;
  }

  // ---- entity writes ---------------------------------------------------------------------------------------------------

  /** The first usable project of the transaction stays; a later event of the same session only supplies a root that was missing. */
  function rememberProject(w: Working, seen: SeenProject | null): void {
    if (seen === null) return;
    w.project = w.project === undefined ? seen : { ...w.project, root: w.project.root ?? seen.root };
  }

  function upsertAgent(c: TxState, w: Working, a: Omit<NewAgent, 'sessionId' | 'parentAgentId' | 'depth'>): number {
    const spec: NewAgent = { ...a, sessionId: w.rowId, parentAgentId: w.mainAgentId, depth: 1 };
    const before = agents.byUid(scope, w.rowId, a.agentUid);
    const first = agents.upsert(scope, c.tx, spec, null);
    // announce only what changed: the same event delivered again changes nothing and announces nothing
    if (before === undefined || rowKey(before) !== rowKey(agents.byUid(scope, w.rowId, a.agentUid))) {
      const seq = c.sink.record('agent', `${String(first.id)}:${w.uid}`, first.created ? 'insert' : 'update');
      if (seq !== null) agents.upsert(scope, c.tx, spec, seq);
    }
    w.agentIds.set(a.agentUid, first.id);
    w.agentUids.set(first.id, a.agentUid);
    w.touchedAgents.add(a.agentUid);
    if (first.created) w.createdAgents.add(a.agentUid);
    return first.id;
  }

  /** The row id of an agent of the session; an agent that is not known yet is created with what the event says. */
  function agentRowOf(c: TxState, w: Working, agentUid: string | null, at: number): number {
    if (agentUid === null || agentUid === 'main') return w.mainAgentId;
    const known = w.agentIds.get(agentUid);
    if (known !== undefined) {
      w.touchedAgents.add(agentUid);
      return known;
    }
    const existing = agents.byUid(scope, w.rowId, agentUid);
    if (existing !== undefined) {
      w.agentIds.set(agentUid, existing.id);
      w.agentUids.set(existing.id, agentUid);
      w.touchedAgents.add(agentUid);
      return existing.id;
    }
    if (!AGENT_RE.test(agentUid)) throw new RangeError('an agent id that the agents table cannot hold');
    return upsertAgent(c, w, { agentUid, kind: 'subagent', startedAt: at });
  }

  function runRowOf(
    c: TxState,
    w: Working,
    runUid: string,
    init: { name?: string; toolUseId?: string; startedAt?: number | null; statusFile?: string | null },
  ): number {
    const spec = {
      sessionId: w.rowId,
      runUid,
      workflowName: init.name ?? null,
      launchToolUseId: init.toolUseId ?? null,
      startedAt: init.startedAt ?? null,
    };
    const before = workflowRuns.byUid(scope, w.rowId, runUid);
    const first = workflowRuns.upsert(scope, c.tx, spec, null);
    if (before === undefined || rowKey(before) !== rowKey(workflowRuns.byUid(scope, w.rowId, runUid))) {
      const seq = c.sink.record('workflow_run', `${String(first.id)}:${w.uid}`, first.created ? 'insert' : 'update');
      if (seq !== null) workflowRuns.upsert(scope, c.tx, spec, seq);
    }
    w.runIds.set(runUid, first.id);
    w.touchedRuns.add(runUid);
    return first.id;
  }

  /** Brings the tool call into the model before an event is applied: a call that left the model is read back from the table. */
  function loadTool(w: Working, toolUseId: string): void {
    if (Object.hasOwn(w.model.tools, toolUseId)) return;
    const row = toolCalls.get(scope, toolUseId);
    if (row?.sessionId !== w.rowId) return;
    w.model = { ...w.model, tools: { ...w.model.tools, [toolUseId]: modelToolOf(row, w.agentUids) } };
  }

  function pruneTools(w: Working): void {
    const entries = Object.entries(w.model.tools);
    if (entries.length <= TOOLS_KEPT_IN_MODEL) return;
    const closed = entries
      .filter(([, row]) => row.endedAt !== null || row.batchAt !== null)
      .sort(([, a], [, b]) => (a.endedAt ?? a.batchAt ?? 0) - (b.endedAt ?? b.batchAt ?? 0));
    const drop = new Set(closed.slice(0, entries.length - TOOLS_KEPT_IN_MODEL).map(([id]) => id));
    if (drop.size === 0) return;
    w.model = { ...w.model, tools: Object.fromEntries(entries.filter(([id]) => !drop.has(id))) };
  }

  function writeTool(
    c: TxState,
    w: Working,
    toolUseId: string,
    event: Extract<LogicalEvent, { k: 'tool.start' | 'tool.end' | 'tool.batch' }>,
    origin: EventOrigin,
    nameRow: EventRowWrite | null,
  ): void {
    const modelRow = w.model.tools[toolUseId];
    if (modelRow === undefined) return;
    const hook = origin === 'hook';
    if (event.k === 'tool.batch' && toolCalls.get(scope, toolUseId) === undefined) {
      // a batch that lists a call no other event has written: the model keeps it, and the start that comes later writes it
      return;
    }
    const agentUid = modelRow.agentId;
    const agentId = agentRowOf(c, w, agentUid, event.stamp.at);
    const endedAt = modelRow.endedAt;
    const duration = event.k === 'tool.end' ? event.durationMs : undefined;
    const write: ToolCallWrite = {
      sessionId: w.rowId,
      agentId,
      promptId: event.k === 'tool.end' ? null : event.promptId,
      toolUseId,
      name: modelRow.name ?? nameRow?.toolName ?? 'unknown',
      mcpServer: null,
      // the summary of 02 2.5.2 is 160 code points plus, for a longer input line, the clip marker of 02 2.5.1: the column
      // holds the 160 code points (03 3.1), the marker stays with the row of the timeline, whose column has room for it
      summary:
        event.k === 'tool.start' && event.summary !== undefined ? clipCodePoints(event.summary, SUMMARY_MAX_CP) : null,
      inputHash: modelRow.inputHash,
      inputBytes: null,
      startedAt: modelRow.startedAt,
      endedAt,
      batchAt: modelRow.batchAt,
      outcome: endedAt === null ? null : modelRow.outcome,
      exitCode: event.k === 'tool.end' ? (event.exitCode ?? null) : null,
      durationMs: duration ?? null,
      durationSource: duration === undefined ? null : hook ? 'hook' : 'timestamps',
      sources:
        (event.k === 'tool.start' ? (hook ? 1 : 4) : 0) |
        (event.k === 'tool.end' ? (hook ? 2 : 8) : 0) |
        (modelRow.batchAt === null ? 0 : 16),
      callFileId: null,
      callOffset: null,
      resultFileId: null,
      resultOffset: null,
      subagentId: null,
      workflowRunId: null,
    };
    toolCalls.upsert(scope, c.tx, write);
    if (event.k === 'tool.start' && event.promptId !== null) w.turnPrompts.add(event.promptId);
  }

  /**
   * The cost-state record of a transcript file (02 6.6, CR-WP-28-2): the newest record per file is kept with its amount, and it
   * is trailing while no stored event row of the file lies after it. The flag is a row, not a fact, so that a record that
   * arrives later can clear it (`clearTrailing`) and the result is the same whatever order the records arrive in: a record read
   * again finds the later rows already stored. The amount of the newest record is mirrored into the session (`reportedCost`).
   */
  function writeCostState(c: TxState, w: Working, event: Extract<LogicalEvent, { k: 'cost_state' }>): void {
    const followed =
      db.driver
        .prepare(
          'SELECT 1 FROM events WHERE session_id = :session AND file_id = :fileId AND byte_offset > :offset LIMIT 1',
        )
        .get({ session: w.rowId, fileId: event.fileId, offset: event.byteOffset }) !== undefined;
    // the same record read again keeps the time it was first observed
    const known = costStates.byFile(scope, event.fileId);
    const observedAt = known?.byteOffset === event.byteOffset ? known.observedAt : c.tx.now;
    const written = costStates.upsert(scope, c.tx, {
      fileId: event.fileId,
      sessionId: w.rowId,
      totalCostUsd: event.totalCostUsd,
      modelUsage: JSON.stringify(event.modelUsage).length <= MODEL_USAGE_JSON_MAX ? event.modelUsage : {},
      byteOffset: event.byteOffset,
      isTrailing: !followed,
      observedAt,
    });
    if (written && event.totalCostUsd !== null) w.reportedCost = { usd: event.totalCostUsd, at: observedAt };
  }

  /** The event rows stored in this transaction are records of their files: the cost states they follow are not trailing. */
  function clearTrailing(c: TxState): void {
    for (const [fileId, offset] of c.fileTails) costStates.markNotTrailing(scope, c.tx, fileId, offset);
  }

  const TURN_END_KINDS: Readonly<Record<'stop' | 'stop_failure' | 'end_turn' | 'turn_duration', TurnEndKind>> = {
    stop: 'stop',
    stop_failure: 'stop_failure',
    end_turn: 'end_turn',
    turn_duration: 'turn_duration',
  };

  /** Applies one logical event to the entity rows (sessions, agents, runs, turns, tool calls) and to the working facts. */
  function applyEventToEntities(
    c: TxState,
    event: LogicalEvent,
    origin: EventOrigin,
    nameRow: EventRowWrite | null,
  ): void {
    const w = openWorking(c, event.sessionId, atOf(event, c.tx.now));
    // the facts first: the rows below read the joined state (a call whose end arrived before its start)
    if (event.k === 'tool.start' || event.k === 'tool.end' || event.k === 'agent.link') loadTool(w, event.toolUseId);
    else if (event.k === 'tool.batch') for (const id of event.toolUseIds) loadTool(w, id);
    const before = w.model.session.lastHookAt;
    w.model = applyEvent(w.model, event, origin);

    switch (event.k) {
      case 'session.seen':
        if (before === null || event.stamp.at >= before) {
          if (event.cwd !== undefined) w.patch.cwd = clipCodePoints(event.cwd, 1024);
          if (event.entrypoint !== undefined) w.patch.entrypoint = clipCodePoints(event.entrypoint, 32);
          if (event.version !== undefined) w.patch.ccVersion = clipCodePoints(event.version, 32);
          if (event.gitBranch !== undefined) w.patch.gitBranch = clipCodePoints(event.gitBranch, 255);
        }
        rememberProject(w, projectOfSeen(event.transcriptPath, event.cwd));
        break;
      case 'session.start':
        if (event.model !== undefined) w.patch.lastModel = clipCodePoints(event.model, 128);
        break;
      case 'turn.prompt':
        if (event.promptId !== null) {
          turns.upsert(scope, c.tx, {
            sessionId: w.rowId,
            agentId: event.agentId === null ? null : agentRowOf(c, w, event.agentId, event.stamp.at),
            promptId: event.promptId,
            startedAt: event.stamp.at,
            endedAt: null,
            endKind: null,
            endRank: null,
            endTie: null,
            origin: clipCodePoints(event.origin, 32),
            toolCount: 0,
          });
          w.turnPrompts.add(event.promptId);
        }
        break;
      case 'turn.end':
        if (event.promptId !== null) {
          turns.upsert(scope, c.tx, {
            sessionId: w.rowId,
            agentId: event.agentId === null ? null : agentRowOf(c, w, event.agentId, event.stamp.at),
            promptId: event.promptId,
            startedAt: null,
            endedAt: event.stamp.at,
            endKind: TURN_END_KINDS[event.kind],
            endRank: event.stamp.rank,
            endTie: clipCodePoints(event.stamp.tie, 200),
            origin: null,
            toolCount: 0,
          });
        }
        break;
      case 'tool.start':
        agentRowOf(c, w, event.agentId, event.stamp.at);
        writeTool(c, w, event.toolUseId, event, origin, nameRow);
        break;
      case 'tool.end':
        writeTool(c, w, event.toolUseId, event, origin, nameRow);
        break;
      case 'tool.batch':
        for (const id of event.toolUseIds) writeTool(c, w, id, event, origin, nameRow);
        break;
      case 'agent.start':
        upsertAgent(c, w, {
          agentUid: event.agentId,
          kind: event.agentType === '' ? 'internal' : 'subagent',
          agentType: event.agentType === '' ? null : clipCodePoints(event.agentType, 64),
          startedAt: event.stamp.at,
        });
        break;
      case 'agent.stop':
        upsertAgent(c, w, {
          agentUid: event.agentId,
          kind: event.agentType === '' ? 'internal' : 'subagent',
          agentType: event.agentType === '' ? null : clipCodePoints(event.agentType, 64),
          startedAt: event.stamp.at,
        });
        break;
      case 'agent.link': {
        upsertAgent(c, w, {
          agentUid: event.agentId,
          kind: 'subagent',
          startedAt: event.stamp.at,
          spawnToolUseId: event.toolUseId,
        });
        break;
      }
      case 'agent.final':
        upsertAgent(c, w, { agentUid: event.agentId, kind: 'subagent', startedAt: event.stamp.at });
        break;
      case 'agent.meta': {
        const runUid = event.workflowRunId;
        const runId = runUid === undefined ? null : runRowOf(c, w, runUid, {});
        upsertAgent(c, w, {
          agentUid: event.agentId,
          kind: runUid === undefined ? 'subagent' : 'workflow_agent',
          startedAt: c.tx.now,
          ...(event.agentType === undefined ? {} : { agentType: clipCodePoints(event.agentType, 64) }),
          ...(event.description === undefined ? {} : { description: clipCodePoints(event.description, 160) }),
          ...(event.model === undefined ? {} : { model: clipCodePoints(event.model, 128) }),
          ...(event.requestShape === 'foreground' || event.requestShape === 'background'
            ? { requestShape: event.requestShape }
            : {}),
          ...(event.spawnToolUseId === undefined ? {} : { spawnToolUseId: event.spawnToolUseId }),
          ...(runId === null ? {} : { workflowRunId: runId }),
          ...(event.workflowPhase === undefined ? {} : { workflowPhase: clipCodePoints(event.workflowPhase, 120) }),
        });
        break;
      }
      case 'workflow.launch':
        runRowOf(c, w, event.runId, {
          toolUseId: event.toolUseId,
          startedAt: event.stamp.at,
          ...(event.name === undefined ? {} : { name: event.name }),
        });
        break;
      case 'workflow.status':
        runRowOf(c, w, event.runId, { startedAt: event.observedAt });
        break;
      case 'title':
        if (event.source === 'ai') w.titleAi = clipCodePoints(event.value, 120);
        else if (event.source === 'custom') w.titleCustom = clipCodePoints(event.value, 120);
        break;
      case 'session.continued_in':
        w.continuedIn = event.target;
        break;
      case 'session.copied_from':
        w.copiedFrom = event.source;
        break;
      case 'activity':
        if (event.agentId !== null) agentRowOf(c, w, event.agentId, event.stamp.at);
        break;
      case 'interrupt':
      case 'api_error':
      case 'assistant.ok':
        if (event.agentId !== null) agentRowOf(c, w, event.agentId, event.stamp.at);
        break;
      case 'cost_state':
        writeCostState(c, w, event);
        break;
      case 'session.end':
      case 'permission.request':
      case 'notification':
      case 'agent.notification':
      case 'compaction':
      case 'hook.handler_error':
      case 'external.registry':
      case 'external.job':
      case 'external.attempt':
      case 'external.attempt_cleared':
      case 'external.pid':
      case 'info':
        break;
    }
    pruneTools(w);
  }

  // ---- rows ----------------------------------------------------------------------------------------------------------------

  function recordError(c: TxState, error: IngestErrorRecord): void {
    ingestErrors.insert(scope, c.tx, {
      at: c.tx.now,
      source: error.source,
      code: error.code,
      fileId: error.fileId ?? null,
      segment: error.segment ?? null,
      byteOffset: error.byteOffset ?? null,
      sessionUid: error.sessionUid ?? null,
      detail: error.detail ?? null,
    });
    addTo(c.errors, error.code, 1);
    c.errorRows += 1;
  }

  function applyRow(c: TxState, row: RowWrite): void {
    switch (row.t) {
      case 'event': {
        const r = row.row;
        const w = openWorking(c, r.sessionUid, r.stamp.at);
        if (r.agentUid !== null) agentRowOf(c, w, r.agentUid, r.stamp.at);
        if (r.eventUid !== null) {
          c.envelopes += 1;
          c.lastEnvelopeAt = Math.max(c.lastEnvelopeAt ?? 0, r.receivedAt);
        }
        const verdict = judgeHookRow(events, scope, r, contentWindowMs);
        if (verdict.verdict === 'duplicate') {
          c.dups[verdict.layer] += 1;
          return;
        }
        const result = events.insert(scope, c.tx, r);
        if (result.outcome === 'duplicate') {
          c.dups[layerOfSilentInsert(r)] += 1;
          return;
        }
        if (result.outcome === 'inserted') {
          w.eventsInserted += 1;
          if (r.severity === 2) w.errorEvents += 1;
          else if (r.severity === 1) w.warningEvents += 1;
        }
        // a row of a transcript file is stored (new, or merged into the row a hook made): a cost-state record before it is
        // not the last record of the file any more
        if (r.fileId !== null && r.byteOffset !== null) {
          c.fileTails.set(r.fileId, Math.max(c.fileTails.get(r.fileId) ?? 0, r.byteOffset));
        }
        return;
      }
      case 'probe':
        if (
          probes.insert(scope, c.tx, {
            probeSessionId: row.probeSessionId,
            receivedAt: row.receivedAt,
            committedAt: c.tx.now,
          })
        ) {
          c.probes += 1;
        }
        return;
      case 'error':
        recordError(c, row.error);
        return;
      case 'usage':
        applyUsageRow(c, row);
        return;
      case 'reconciliation': {
        const detailHash = canonicalJsonHash(row.detail);
        if (row.sessionUid === null) {
          const made = reconciliations.insert(scope, c.tx, {
            sessionId: null,
            scopeKey: INSTANCE_KEY,
            kind: row.kind,
            at: row.at,
            detail: row.detail,
            detailHash,
          });
          if (made !== undefined) c.sink.record('reconciliation', INSTANCE_KEY, 'insert');
          return;
        }
        const w = openWorking(c, row.sessionUid, row.at);
        reconciliations.insert(scope, c.tx, {
          sessionId: w.rowId,
          scopeKey: row.sessionUid,
          kind: row.kind,
          at: row.at,
          detail: row.detail,
          detailHash,
        });
        return;
      }
    }
  }

  /** The usage of one record: the file is linked to its rows first (the batch may have just created them), then accounted. */
  function applyUsageRow(c: TxState, row: Extract<RowWrite, { t: 'usage' }>): void {
    if (!c.linkedFiles.has(row.fileId)) {
      const file = transcriptFiles.get(scope, row.fileId);
      if (file === undefined) throw new RangeError('usage of a transcript file that has no row');
      const w = openWorking(c, file.sessionUid, c.tx.now);
      // an agent file whose agent is not known yet: created through the working copy, so it is finalized and announced
      if (file.agentUid !== null) agentRowOf(c, w, file.agentUid, c.tx.now);
      if (linkTranscriptFile(scope, c.tx, linkRepos, file) === null) {
        throw new RangeError('usage of a transcript file without a session');
      }
      c.linkedFiles.add(row.fileId);
    }
    const applied = usage.applyRecord(scope, c.tx, row.fileId, row.messageKey, row.values);
    for (const id of applied.touchedSessionIds) c.rollupSessions.add(id);
    for (const id of applied.touchedAgentIds) c.rollupAgents.add(id);
  }

  /**
   * The sessions and agents whose rollup columns changed in this transaction are announced (`session/upsert`, `agent/upsert`,
   * coalesced with the other announcements of the transaction) and stamped with that seq, so a frame hydrated for the commit
   * carries the committed totals (03 9.3, CR-LF-7-1). The owner of a message key may be another session (a resume copy).
   *
   * This is an activity-only update, so with a throttle it is held back inside the window and `flushActivity` announces it later
   * (03 9.1: usage rollups are throttled like sessions). The frame of that later announcement is hydrated from the committed
   * rollups, so the last `session/upsert` still equals the REST read, up to about two seconds after the commit.
   */
  function announceRollups(c: TxState): void {
    if (c.rollupSessions.size === 0 && c.rollupAgents.size === 0) return;
    for (const [rowId, uid] of sessions.uidsByRowIds(scope, [...c.rollupSessions])) {
      const row = sessions.byUid(scope, uid);
      if (row === undefined) continue;
      const seq = c.sink.record('session', `${String(rowId)}:${uid}`, 'update');
      // the patch repeats a value the row holds: the write only stamps `updated_seq` (and `updated_at`)
      if (seq !== null) sessions.update(scope, c.tx, rowId, { lastActivityAt: row.lastActivityAt }, seq);
    }
    if (c.rollupAgents.size === 0) return;
    const rows = db.driver
      .prepare<{ id: number; lastActivityAt: number; sessionUid: string }>(
        `SELECT a.id AS id, a.last_activity_at AS lastActivityAt, s.session_uid AS sessionUid
           FROM agents a JOIN sessions s ON s.id = a.session_id WHERE a.id IN (SELECT value FROM json_each(?))`,
      )
      .all([JSON.stringify([...c.rollupAgents])]);
    for (const row of rows) {
      const seq = c.sink.record('agent', `${String(row.id)}:${row.sessionUid}`, 'update');
      if (seq !== null) agents.update(scope, c.tx, row.id, { lastActivityAt: row.lastActivityAt }, seq);
    }
  }

  function applyItem(c: TxState, item: IngestItem): void {
    const origin = originOf(item.kind);
    const nameRow = item.rows.find((row) => row.t === 'event');
    const named = nameRow?.t === 'event' ? nameRow.row : null;
    if (origin !== null) {
      for (const event of item.events) applyEventToEntities(c, event, origin, named);
      if (origin === 'hook') c.drained = true;
    } else {
      applyDerive(c, item);
    }
    for (const row of item.rows) applyRow(c, row);
  }

  /**
   * A derive item (02 4.6, 7.8): opens the session so that it is derived again, and marks the named subagents and workflow runs
   * of the session so that their views are written. It applies no event. A session that is gone (retention) is left alone, and
   * a name that is no row of the session is ignored: nothing is created for a derive item.
   */
  function applyDerive(c: TxState, item: IngestItem): void {
    const target = item.derive;
    if (target === undefined) return;
    if (!c.working.has(target.sessionId) && sessions.idByUid(scope, target.sessionId) === undefined) return;
    const w = openWorking(c, target.sessionId, c.tx.now);
    for (const agentUid of target.agents ?? []) {
      if (agentUid !== 'main' && w.agentIds.has(agentUid)) w.touchedAgents.add(agentUid);
    }
    for (const runUid of target.runs ?? []) {
      if (w.runIds.has(runUid)) w.touchedRuns.add(runUid);
    }
  }

  function applyCursor(c: TxState, cursor: CursorUpdate): void {
    switch (cursor.kind) {
      case 'spool':
        spoolCursors.save(scope, c.tx, cursor.cursor);
        return;
      case 'spool_forget':
        spoolCursors.delete(scope, c.tx, cursor.segment);
        return;
      case 'transcript':
        transcriptFiles.updateCursors(scope, c.tx, cursor.fileId, cursor.cursor);
        return;
    }
  }

  // ---- the end of a transaction: views, counters, health -------------------------------------------------------------

  /**
   * Hook coverage of a session (02 8.1): `none` without envelopes; otherwise the transcript calls and prompts that started
   * after the first envelope without a hook counterpart (a call older than 10 s, not within 5 s of the session end). Only the
   * prompts of the main agent count: Claude Code fires no UserPromptSubmit for the prompt a subagent receives, so the first
   * prompt record of a subagent file has no hook by design (CR-WP-35-3).
   */
  function hookCoverageOf(
    w: Working,
    now: number,
  ): { coverage: 'none' | 'full' | 'partial'; missingTools: number; missingTurns: number; since: number | null } {
    const facts = w.model.session;
    if (facts.lastHookAt === null) return { coverage: 'none', missingTools: 0, missingTurns: 0, since: null };
    const first =
      db.driver
        .prepare<{ at: number | null }>(
          'SELECT min(received_at) AS at FROM events WHERE session_id = ? AND (sources & 1) = 1',
        )
        .get([w.rowId])?.at ?? facts.lastHookAt;
    const cutoff = now - 10_000;
    const endAt = facts.end?.stamp.at ?? null;
    const missingTools =
      db.driver
        .prepare<{ n: number }>(
          `SELECT count(*) AS n FROM tool_calls
             WHERE session_id = :session AND (sources & 4) != 0 AND (sources & 1) = 0
               AND started_at > :first AND started_at < :cutoff AND (:endAt IS NULL OR started_at < :endAt - 5000)`,
        )
        .get({ session: w.rowId, first, cutoff, endAt })?.n ?? 0;
    const missingTurns =
      db.driver
        .prepare<{ n: number }>(
          `SELECT count(*) AS n FROM events
             WHERE session_id = :session AND kind = 'prompt.submit' AND (sources & 2) != 0 AND (sources & 1) = 0
               AND (agent_id IS NULL OR agent_id = :mainAgent) AND ts > :first AND ts < :cutoff`,
        )
        .get({ session: w.rowId, mainAgent: w.mainAgentId, first, cutoff })?.n ?? 0;
    return {
      coverage: missingTools === 0 && missingTurns === 0 ? 'full' : 'partial',
      missingTools,
      missingTurns,
      since: first,
    };
  }

  /**
   * `sessions.last_activity_at` (02 7.3; CAW-147, UI review R-36): the newest of the activity of the main agent, the hook
   * events of the session, the activity of every agent of the session (a subagent or a workflow agent that still writes
   * after the last record of its parent) and the newest record or hook event stored for the session (a record that closes
   * a turn is no activity fact, but a timeline that shows it after the "last activity" contradicts itself). So no stored
   * record or hook event of a session is later than its last activity, in whatever order its files arrive.
   *
   * The value is derived from this evidence every time and not accumulated: the time a row was created with is only a
   * stand-in while nothing is known (the first thing seen of a session may carry no time of its own, as the meta file of a
   * subagent, and then that time is the clock of the ingest), and a row that an earlier version stored too early or too
   * late is put right the next time its session is derived. A note of the monitor, the mtime of a file and the time of a
   * poll or of the ingest are bookkeeping and never count.
   */
  function lastActivityOf(w: Working, startedAt: number, stored: number): number {
    const facts = w.model.session;
    let newest = maxOf(facts.lastActivity?.at, facts.lastHookAt, events.newestActivityAt(scope, w.rowId));
    for (const agent of Object.values(w.model.agents)) newest = maxOf(newest, agent.lastActivity?.at);
    return Math.max(startedAt, Number.isFinite(newest) ? newest : stored);
  }

  function finalizeSession(c: TxState, w: Working): void {
    const now = c.tx.now;
    // whether the main transcript file still ends in a cost-state record is a row of its own, read after this transaction wrote
    // the records and the rows that follow them (CR-WP-28-2)
    const views = deriveModel(w.model, now, cfg, { costStateTrailing: costStates.sessionTrailing(scope, w.rowId) });
    const facts = w.model.session;

    // agents first: the session row reads their count
    for (const agentUid of w.touchedAgents) {
      const id = w.agentIds.get(agentUid);
      if (id === undefined) continue;
      const row = agents.byUid(scope, w.rowId, agentUid);
      const facts_ = agentFactsOf(w.model, agentUid);
      const view = Object.hasOwn(views.agents, agentUid) ? views.agents[agentUid] : undefined;
      const result =
        view === undefined ? undefined : agents.writeView(scope, c.tx, id, storedView(view), JSON.stringify(facts_));
      // a change of the view is announced at once and restarts the window of the activity throttle
      if (result?.changed === true)
        c.viewAnnouncements.push({ entity: 'agent', key: `${String(id)}:${w.uid}`, at: now });
      if (row === undefined) continue;
      const wanted = {
        lastActivityAt: Math.max(row.startedAt, maxOf(row.lastActivityAt, facts_.lastActivity?.at)),
        endedAt: facts_.stopped === null ? row.endedAt : Math.max(row.startedAt, facts_.stopped.at),
      };
      if (wanted.lastActivityAt !== row.lastActivityAt || wanted.endedAt !== row.endedAt) {
        const seq = result?.seq ?? c.sink.record('agent', `${String(id)}:${w.uid}`, 'update');
        agents.update(scope, c.tx, id, wanted, seq);
      }
    }
    for (const runUid of w.touchedRuns) {
      const id = w.runIds.get(runUid);
      const view = Object.hasOwn(views.workflows, runUid) ? views.workflows[runUid] : undefined;
      if (id === undefined || view === undefined) continue;
      workflowRuns.writeView(scope, c.tx, id, storedView(view), JSON.stringify(workflowFactsOf(w.model, runUid)));
    }

    const written = sessions.writeView(scope, c.tx, w.rowId, storedView(views.session), JSON.stringify(facts));
    if (written?.changed === true) {
      c.viewAnnouncements.push({ entity: 'session', key: `${String(w.rowId)}:${w.uid}`, at: now });
    }
    // the main agent shows the state of the session
    const mainWritten = agents.writeView(scope, c.tx, w.mainAgentId, storedView(views.session), '{}');
    if (mainWritten?.changed === true) {
      c.viewAnnouncements.push({ entity: 'agent', key: `${String(w.mainAgentId)}:${w.uid}`, at: now });
    }

    const row = sessions.byUid(scope, w.uid);
    if (row !== undefined) {
      const startedAt = Math.min(row.startedAt, w.startedAt);
      const pid = facts.claudePid?.value;
      const lastActivityAt = lastActivityOf(w, startedAt, row.lastActivityAt);
      // the first assignment wins: a session that has a project never asks for another (CAW design 03 2.5)
      const projectId =
        row.projectId === null && w.project !== undefined
          ? projects.ensure(scope, c.tx, {
              projectKey: w.project.key,
              dirName: w.project.dirName,
              rootPath: w.project.root,
              at: lastActivityAt,
            })
          : undefined;
      const wanted: SessionPatch = {
        startedAt,
        lastActivityAt,
        lastHookAt: facts.lastHookAt ?? row.lastHookAt,
        endedAt: facts.end === null ? row.endedAt : Math.max(startedAt, facts.end.stamp.at),
        eventCount: row.eventCount + w.eventsInserted,
        errorCount: row.errorCount + w.errorEvents,
        warningCount: row.warningCount + w.warningEvents,
        agentCount: agents.countBySession(scope, w.rowId),
        ...(w.patch.cwd === undefined ? {} : { cwd: w.patch.cwd }),
        ...(pid === undefined || pid <= 0 ? {} : { claudePid: pid }),
        ...(projectId === undefined ? {} : { projectId }),
      };
      const patch = changedSessionPatch(row, wanted);
      const stored = db.driver
        .prepare<{
          entrypoint: string | null;
          ccVersion: string | null;
          gitBranch: string | null;
          lastModel: string | null;
          titleAi: string | null;
          titleCustom: string | null;
          continuedIn: string | null;
          copiedFrom: string | null;
          hookCoverage: string;
          hookMissingTools: number;
          hookMissingTurns: number;
          reportedCostUsd: number | null;
          reportedCostAt: number | null;
        }>(
          `SELECT entrypoint, cc_version AS ccVersion, git_branch AS gitBranch, last_model AS lastModel, title_ai AS titleAi,
                  title_custom AS titleCustom, continued_in AS continuedIn, copied_from AS copiedFrom,
                  hook_coverage AS hookCoverage, hook_missing_tools AS hookMissingTools, hook_missing_turns AS hookMissingTurns,
                  reported_cost_usd AS reportedCostUsd, reported_cost_at AS reportedCostAt
             FROM sessions WHERE id = ?`,
        )
        .get([w.rowId]);
      const coverage = hookCoverageOf(w, now);
      const wantedExtra: SessionPatch = {
        ...(w.patch.entrypoint === undefined || w.patch.entrypoint === '' ? {} : { entrypoint: w.patch.entrypoint }),
        ...(w.patch.ccVersion === undefined ? {} : { ccVersion: w.patch.ccVersion }),
        ...(w.patch.gitBranch === undefined ? {} : { gitBranch: w.patch.gitBranch }),
        ...(w.patch.lastModel === undefined ? {} : { lastModel: w.patch.lastModel }),
        ...(w.titleAi === undefined ? {} : { titleAi: w.titleAi }),
        ...(w.titleCustom === undefined ? {} : { titleCustom: w.titleCustom }),
        ...(w.continuedIn === undefined ? {} : { continuedIn: w.continuedIn }),
        ...(w.copiedFrom === undefined ? {} : { copiedFrom: w.copiedFrom }),
        // the amount the provider reported last stays when a later record clears the trailing flag (CR-WP-28-2)
        ...(w.reportedCost === undefined
          ? {}
          : { reportedCostUsd: w.reportedCost.usd, reportedCostAt: w.reportedCost.at }),
        hookCoverage: coverage.coverage,
        hookMissingTools: coverage.missingTools,
        hookMissingTurns: coverage.missingTurns,
      };
      if (
        coverage.coverage === 'partial' &&
        stored !== undefined &&
        (stored.hookMissingTools !== coverage.missingTools || stored.hookMissingTurns !== coverage.missingTurns)
      ) {
        const detail = {
          missingTools: coverage.missingTools,
          missingTurns: coverage.missingTurns,
          since: coverage.since ?? 0,
        };
        reconciliations.insert(scope, c.tx, {
          sessionId: w.rowId,
          scopeKey: w.uid,
          kind: 'hook_gap',
          at: now,
          detail,
          detailHash: canonicalJsonHash(detail),
        });
      }
      const extra: SessionPatch = Object.fromEntries(
        Object.entries(wantedExtra).filter(
          ([key, value]) => stored === undefined || Reflect.get(stored, key) !== value,
        ),
      );
      const merged: SessionPatch = { ...patch, ...extra };
      if (Object.keys(merged).length > 0) {
        const seq =
          written?.seq ?? c.sink.record('session', `${String(w.rowId)}:${w.uid}`, w.created ? 'insert' : 'update');
        sessions.update(scope, c.tx, w.rowId, merged, seq);
      } else if (w.created && written?.seq === null) {
        c.sink.record('session', `${String(w.rowId)}:${w.uid}`, 'insert');
      }
    }

    const main = agents.byUid(scope, w.rowId, 'main');
    const sessionNow = sessions.byUid(scope, w.uid);
    if (main !== undefined && sessionNow !== undefined) {
      // the main agent lives as long as its session: the earlier start and the later activity win, whatever the arrival order
      const wanted = {
        startedAt: sessionNow.startedAt,
        lastActivityAt: sessionNow.lastActivityAt,
        endedAt: sessionNow.endedAt,
      };
      if (
        wanted.startedAt !== main.startedAt ||
        wanted.lastActivityAt !== main.lastActivityAt ||
        wanted.endedAt !== main.endedAt
      ) {
        const seq = mainWritten?.seq ?? c.sink.record('agent', `${String(main.id)}:${w.uid}`, 'update');
        agents.update(scope, c.tx, main.id, wanted, seq);
      }
    }

    for (const promptId of w.turnPrompts) {
      const turn = turns.get(scope, w.rowId, promptId);
      if (turn === undefined) continue;
      const count =
        db.driver
          .prepare<{ n: number }>('SELECT count(*) AS n FROM tool_calls WHERE session_id = ? AND prompt_id = ?')
          .get([w.rowId, promptId])?.n ?? 0;
      if (count > turn.toolCount) turns.upsert(scope, c.tx, { ...turn, toolCount: count });
    }

    if (views.reopened && facts.end !== null && facts.lastActivity !== null) {
      const detail = { endedAt: facts.end.stamp.at, activityAt: facts.lastActivity.at };
      reconciliations.insert(scope, c.tx, {
        sessionId: w.rowId,
        scopeKey: w.uid,
        kind: 'activity_after_end',
        at: facts.lastActivity.at,
        detail,
        detailHash: canonicalJsonHash(detail),
      });
    }
  }

  function finalizeHealth(c: TxState, source: IngestBatch['source'][]): void {
    const duplicates = Object.values(c.dups).reduce((a, b) => a + b, 0);
    const touched =
      c.envelopes > 0 ||
      c.probes > 0 ||
      duplicates > 0 ||
      c.errorRows > 0 ||
      c.persistFailed > 0 ||
      source.includes('spool');
    if (!touched) return;
    const current = ingestHealth.get(scope);
    const counters = parseCounters(current?.countersJson ?? '{}');
    counters.envelopes += c.envelopes;
    counters.probes += c.probes;
    counters.persistFailed += c.persistFailed;
    for (const [layer, n] of Object.entries(c.dups)) if (n > 0) addTo(counters.duplicates, layer, n);
    for (const [code, n] of Object.entries(c.errors)) addTo(counters.errors, code, n);
    ingestHealth.save(scope, c.tx, {
      evaluatedAt: c.tx.now,
      status: current?.status ?? 'ok',
      lastEnvelopeAt: Math.max(current?.lastEnvelopeAt ?? 0, c.lastEnvelopeAt ?? 0) || null,
      lastCommitAt: c.tx.now,
      lastDrainAt: source.includes('spool') ? c.tx.now : (current?.lastDrainAt ?? null),
      lastNudgeAt: current?.lastNudgeAt ?? null,
      lastScanAt: current?.lastScanAt ?? null,
      lastSyncAt: current?.lastSyncAt ?? null,
      countersJson: JSON.stringify(counters),
      reportJson: current?.reportJson ?? '{}',
    });
    c.sink.record('ingest_health', INSTANCE_KEY, 'update');
    if (c.errorRows > 0) {
      errorsSinceTrim += c.errorRows;
      if (errorsSinceTrim >= TRIM_EVERY_ERRORS) {
        ingestErrors.trimToNewest(scope, c.tx, ERRORS_KEPT);
        errorsSinceTrim = 0;
      }
    }
  }

  // ---- the throttled announcements (03 3.6) ----------------------------------------------------------------------------------

  /** The change sink of one transaction: it shares the activity throttle of this writer when the writer has one. */
  function sinkOf(tx: WriteTx): ChangeSink {
    return createChangeSink(tx, throttle === undefined ? {} : { throttle });
  }

  /** Stamps `updated_seq` of a row the flush announced, so that a frame hydrated for the change shows the committed totals. */
  function stampAnnounced(tx: WriteTx, change: ReservedChange): void {
    const colon = change.key.indexOf(':');
    const rowId = colon === -1 ? Number.NaN : Number(change.key.slice(0, colon));
    if (!Number.isSafeInteger(rowId)) return;
    if (change.entity === 'session' || change.entity === 'turn') {
      const row = sessions.byUid(scope, change.key.slice(colon + 1));
      // the patch repeats a value the row holds: the write only stamps `updated_seq` (and `updated_at`)
      if (row?.id === rowId) sessions.update(scope, tx, rowId, { lastActivityAt: row.lastActivityAt }, change.seq);
    } else if (change.entity === 'agent') {
      const row = db.driver
        .prepare<{ lastActivityAt: number }>('SELECT last_activity_at AS lastActivityAt FROM agents WHERE id = ?')
        .get([rowId]);
      if (row !== undefined) agents.update(scope, tx, rowId, { lastActivityAt: row.lastActivityAt }, change.seq);
    }
  }

  /** One transaction that announces what the throttle held back. A failure puts the announcements back and is thrown. */
  function flushDeferred(): void {
    let reserved: ReservedChange[] = [];
    try {
      withWriteTx(db, scope, (tx) => {
        if (throttle === undefined) return;
        reserved = throttle.flush(tx);
        for (const change of reserved) stampAnnounced(tx, change);
      });
    } catch (error) {
      // the state of the throttle is not rolled back with the transaction: what the flush took goes back to be flushed again
      throttle?.restore(reserved);
      throw error;
    }
  }

  // ---- one transaction ---------------------------------------------------------------------------------------------------

  function commit(group: readonly Queued[]): void {
    const working = new Map<string, Working>();
    const viewAnnouncements: ViewAnnouncement[] = [];
    pending = working;
    try {
      withWriteTx(db, scope, (tx) => {
        const c: TxState = {
          tx,
          sink: sinkOf(tx),
          working,
          dups: emptyDuplicateCounts(),
          errors: {},
          envelopes: 0,
          probes: 0,
          persistFailed: 0,
          lastEnvelopeAt: null,
          drained: false,
          errorRows: 0,
          rollupSessions: new Set(),
          rollupAgents: new Set(),
          linkedFiles: new Set(),
          fileTails: new Map(),
          viewAnnouncements,
        };
        for (const { batch } of group) for (const item of batch.items) applyItem(c, item);
        for (const { batch } of group) if (batch.cursor !== undefined) applyCursor(c, batch.cursor);
        clearTrailing(c);
        for (const w of working.values()) finalizeSession(c, w);
        announceRollups(c);
        finalizeHealth(
          c,
          group.map(({ batch }) => batch.source),
        );
        options.beforeCommit?.(
          tx,
          group.map(({ batch }) => batch),
        );
      });
      // the state of the throttle is not rolled back with a transaction: it hears of a view change only once it is committed
      for (const { entity, key, at } of viewAnnouncements) throttle?.announced(entity, key, at);
      stats.lastCommitAt = db.clock.now();
    } catch (error) {
      pending = null;
      throw error;
    }
  }

  /**
   * The one item that cannot be stored: recorded by reference, its cursor advances, the pipeline goes on (02 4.6 step 7). The
   * record names what failed (the constraint and the table SQLite named, the kind of the item) and where the item was read
   * (`origin` is the cursor of the batch it was split from), never a value of the item.
   */
  function dropPoison(batch: IngestBatch, error: unknown, origin: CursorUpdate | undefined): void {
    const [item] = batch.items;
    try {
      withWriteTx(db, scope, (tx) => {
        const c: TxState = {
          tx,
          sink: sinkOf(tx),
          working: new Map(),
          dups: emptyDuplicateCounts(),
          errors: {},
          envelopes: 0,
          probes: 0,
          persistFailed: 1,
          lastEnvelopeAt: null,
          drained: false,
          errorRows: 0,
          rollupSessions: new Set(),
          rollupAgents: new Set(),
          linkedFiles: new Set(),
          fileTails: new Map(),
          viewAnnouncements: [],
        };
        recordError(c, {
          code: 'PERSIST_FAILED',
          source: 'writer',
          ...referenceOf(item, batch.cursor ?? origin),
          detail: persistFailedDetail(describeFailure(error), batch.source, item),
        });
        if (batch.cursor !== undefined) applyCursor(c, batch.cursor);
        finalizeHealth(c, [batch.source]);
      });
    } catch (second) {
      // even the record could not be written: keep going, the next tick tries the next batch
      options.logger?.error(
        'ingest_drop_failed',
        commitFailureLogFields(describeFailure(second), { source: batch.source, items: batch.items }),
      );
    }
  }

  /**
   * Counts the failure and logs what failed in names only (`commitFailureLogFields`): the error, the constraint and the table
   * SQLite named, the source of the batches and, when the transaction held one item, the kind of that item.
   */
  function noteFailure(error: unknown, group: readonly Queued[]): { diskFull: boolean } {
    stats.failures += 1;
    const failure = describeFailure(error);
    stats.lastError = { code: failure.code, at: db.clock.now() };
    const diskFull =
      (isDbError(error) && error.code === 'db_full') || (error instanceof Error && error.message.includes('ENOSPC'));
    const sources = [...new Set(group.map(({ batch }) => batch.source))];
    options.logger?.warn(
      'ingest_commit_failed',
      commitFailureLogFields(failure, {
        source: sources.length === 1 && sources[0] !== undefined ? sources[0] : 'mixed',
        items: group.flatMap(({ batch }) => batch.items),
      }),
    );
    return { diskFull };
  }

  /** Commits `group`; on a failure retries with backoff, then splits, down to the single item (02 4.6 step 7). */
  async function process(group: Queued[], attemptsLeft: number): Promise<boolean> {
    let delay = retryBaseMs;
    for (let attempt = 1; ; attempt += 1) {
      if (isClosed()) return false;
      const started = performance.now();
      try {
        commit(group);
        const took = performance.now() - started;
        itemsPerTx =
          took > TARGET_TX_MS
            ? Math.max(MIN_ITEMS_PER_TX, Math.floor(itemsPerTx / 2))
            : Math.min(itemsPerTxCap, itemsPerTx * 2);
        stats.paused = false;
        return true;
      } catch (error) {
        const { diskFull } = noteFailure(error, group);
        if (diskFull) {
          stats.paused = true;
          pausedUntil = Date.now() + dbErrorPauseMs;
          return false;
        }
        if (isClosed()) return false;
        if (attempt < attemptsLeft) {
          await Promise.race([sleep(delay), closing]);
          delay = Math.min(delay * 2, retryMaxMs);
          continue;
        }
        const [only] = group;
        if (group.length === 1 && only !== undefined) {
          const { batch } = only;
          const origin = batch.cursor ?? only.origin;
          if (batch.items.length > 1) {
            const half = Math.ceil(batch.items.length / 2);
            const first: IngestBatch = {
              source: batch.source,
              items: batch.items.slice(0, half),
              bytes: batch.bytes / 2,
            };
            const second: IngestBatch = {
              source: batch.source,
              items: batch.items.slice(half),
              bytes: batch.bytes / 2,
              ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }),
            };
            const from = origin === undefined ? {} : { origin };
            const done = await process([{ batch: first, ...from }], 1);
            return done && (await process([{ batch: second, ...from }], 1));
          }
          dropPoison(batch, error, origin);
          return true;
        }
        for (const part of group) {
          if (!(await process([part], 1))) return false;
        }
        return true;
      }
    }
  }

  // ---- the loop ------------------------------------------------------------------------------------------------------------

  function room(): boolean {
    return queuedItems === 0 || (queuedItems < queueMaxItems && queuedBytes < queueMaxBytes);
  }

  function notifyDrain(): void {
    if (!refused || !room()) return;
    refused = false;
    for (const cb of [...drainListeners]) {
      try {
        cb();
      } catch (error) {
        options.logger?.warn('ingest_drain_listener_failed', { code: error instanceof Error ? error.name : 'unknown' });
      }
    }
  }

  function takeGroup(): Queued[] {
    const group: Queued[] = [];
    let items = 0;
    for (;;) {
      const next = queue[0];
      if (next?.kind !== 'batch') break;
      const n = itemCount(next.queued.batch);
      if (group.length > 0 && items + n > itemsPerTx) break;
      queue.shift();
      queuedItems -= n;
      queuedBytes -= next.queued.batch.bytes;
      items += n;
      group.push(next.queued);
    }
    stats.queued = queuedItems;
    stats.queuedBytes = queuedBytes;
    return group;
  }

  async function loop(): Promise<void> {
    try {
      while (!closed) {
        const head = queue[0];
        if (head === undefined) break;
        if (head.kind === 'job') {
          queue.shift();
          try {
            head.job.run();
            head.job.resolve();
          } catch (error) {
            head.job.reject(error);
          }
          continue;
        }
        const wait = pausedUntil - Date.now();
        if (stats.paused && wait > 0) {
          await Promise.race([sleep(Math.min(wait, dbErrorPauseMs)), closing]);
          continue;
        }
        const group = takeGroup();
        const ok = await process(group, 3);
        if (!ok && !isClosed()) {
          // a full disk: put the batches back at the front and wait
          queue.unshift(...group.map((queued): Entry => ({ kind: 'batch', queued })));
          for (const { batch } of group) {
            queuedItems += itemCount(batch);
            queuedBytes += batch.bytes;
          }
          stats.queued = queuedItems;
          stats.queuedBytes = queuedBytes;
          if (!stats.paused) break;
          continue;
        }
        notifyDrain();
      }
    } finally {
      looping = null;
      notifyDrain();
    }
  }

  function kick(): void {
    // started on a later microtask: a loop that has nothing to wait for must not finish (and clear `looping`) before the
    // assignment below, or the stale promise would hide every later submit
    if (looping === null && !closed) looping = Promise.resolve().then(loop);
  }

  /** A job runs between two transactions, never inside one. `front` puts it ahead of the queued batches. */
  function enqueueJob<T>(fn: () => T, front: boolean): Promise<T> {
    if (closed) return Promise.reject(new IngestWriterClosedError());
    return new Promise<T>((resolve, reject) => {
      let result: { readonly value: T } | undefined;
      const entry: Entry = {
        kind: 'job',
        job: {
          run: () => {
            result = { value: fn() };
          },
          resolve: () => {
            if (result === undefined) reject(new Error('the exclusive job produced no result'));
            else resolve(result.value);
          },
          reject,
        },
      };
      if (front) queue.unshift(entry);
      else queue.push(entry);
      kick();
    });
  }

  const writer: IngestWriterHandle = {
    submit(batch) {
      if (closed) throw new IngestWriterClosedError();
      const n = itemCount(batch);
      if (queuedItems > 0 && (queuedItems + n > queueMaxItems || queuedBytes + batch.bytes > queueMaxBytes)) {
        refused = true;
        return false;
      }
      queue.push({ kind: 'batch', queued: { batch } });
      queuedItems += n;
      queuedBytes += batch.bytes;
      stats.queued = queuedItems;
      stats.queuedBytes = queuedBytes;
      kick();
      return true;
    },
    onDrain(cb) {
      drainListeners.push(cb);
    },
    async flushNow() {
      for (;;) {
        kick();
        const running = looping;
        if (running === null) {
          if (queue.length === 0 || closed) return;
          continue;
        }
        await running;
        if (closed || queue.length === 0) return;
      }
    },
    stats,
    runExclusive<T>(fn: () => T): Promise<T> {
      return enqueueJob(fn, false);
    },
    async flushActivity() {
      if (throttle === undefined || closed) return;
      const due = throttle.nextDueAt();
      if (due === null || due > db.clock.now()) return;
      try {
        // ahead of the batches that are queued: it depends on none of them, and a long backlog must not hold the schedule up
        await enqueueJob(flushDeferred, true);
      } catch (error) {
        if (error instanceof IngestWriterClosedError) return;
        throw error;
      }
    },
    async close() {
      closed = true;
      wakeOnClose();
      const running = looping;
      if (running !== null) await running;
      for (const entry of queue.splice(0)) if (entry.kind === 'job') entry.job.reject(new IngestWriterClosedError());
      queuedItems = 0;
      queuedBytes = 0;
      stats.queued = 0;
      stats.queuedBytes = 0;
    },
  };
  return writer;
}

/**
 * The item of one validated envelope: its logical events and its `events` row, or the probe record of a probe (a probe never
 * becomes a session or an event, 02 3.7). `where` is the spool line the envelope was read from.
 */
export function envelopeItem(
  envelope: HookEnvelopeV1,
  where: EnvelopeLocation = { segment: null, offset: null },
): IngestItem {
  if (envelope.kind === 'probe') {
    const probeSessionId = envelope.session_id;
    return {
      kind: 'envelope',
      events: [],
      rows: probeSessionId === null ? [] : [{ t: 'probe', probeSessionId, receivedAt: envelope.received_at }],
    };
  }
  const normalized = normalizeEnvelope(envelope, where);
  return {
    kind: 'envelope',
    events: normalized.events,
    rows: normalized.row === null ? [] : [{ t: 'event', row: normalized.row }],
  };
}

/**
 * The items that carry the usage of a slice: `USAGE_ROWS_PER_ITEM` rows each, no events. A producer appends them AFTER the
 * record items of the same batch, so the session and agent rows exist when the writer applies them.
 */
export function usageItems(fileId: number, list: readonly { messageKey: string; values: UsageValues }[]): IngestItem[] {
  const items: IngestItem[] = [];
  for (let from = 0; from < list.length; from += USAGE_ROWS_PER_ITEM) {
    items.push({
      kind: 'record',
      events: [],
      rows: list
        .slice(from, from + USAGE_ROWS_PER_ITEM)
        .map((u): RowWrite => ({ t: 'usage', fileId, messageKey: u.messageKey, values: u.values })),
    });
  }
  return items;
}
