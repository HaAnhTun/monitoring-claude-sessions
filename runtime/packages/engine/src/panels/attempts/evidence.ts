// Lifecycle evidence of the attempts (06 3.10.7, ADR 0059, ADR 0069): which sessions get an `external.attempt` or an
// `external.attempt_cleared` event after an attempts tick, and how the events reach the shared writer.
//
// Two halves, with the COMMIT of the attempts transaction between them (persist before publish, N-01):
//   - `planEvidence` runs INSIDE the transaction and only reads: for every session whose runs changed it names the run that
//     is the evidence (the ended run with the greatest START, `AttemptsRepo.evidenceRun`), or the retraction of the evidence;
//   - `publishEvidence` runs AFTER the COMMIT: it stamps the events and hands them to `writer.submit` as ONE batch.
//
// The stamp. `observedAt` of the events is a publication stamp, not the chain-log END time: the facts of design 02 are
// last-writer-wins registers on that stamp, so a stamp from the END time would let a retraction beat evidence that was
// published again, and would let an earlier START that ended later beat the latest START. The stamp is `max(clock.now(), last
// + 1)`: strictly increasing within a process, across a small backward step of the clock, and across a restart (the first
// stamp of a process is above the update time of the attempts source, which the last publishing tick wrote).
//
// A writer that refuses a batch (full queue) gets it again, before any later batch, from `onDrain` and from the next tick.
// A crash between the COMMIT and the writer's own COMMIT loses that tick's events (accepted, 06 3.10.7 step 5): the rows and
// the offset are stored, so they are not derived again; the next change of that session's evidence row, or `db rebuild`,
// repairs it.
import type { Clock } from '@mcs/shared';

import type { AttemptEnd, AttemptRunRow } from '../../db/repos/attempts.ts';
import { IngestWriterClosedError } from '../../ingest/errors.ts';
import type { LogicalEvent } from '../../ingest/event-row.ts';
import type { IngestBatch, IngestWriter } from '../../ingest/writer.ts';
import type { Logger } from '../../log/logger.ts';
import type { AttemptsStore } from './repo.ts';

type EvidenceEventState = AttemptEnd['state'];

/** One `external.attempt` event, before the stamp. */
export interface PlannedAttempt {
  /** The provider id (`sessions.session_uid`). */
  readonly sessionUid: string;
  readonly sessionRowId: number;
  /** The run that is the evidence. */
  readonly runId: number;
  readonly state: EvidenceEventState;
  readonly evidence: string;
  /** `ended_at` of the run: the evidence time shown in the session view. */
  readonly endedAt: number;
}

export interface EvidencePlan {
  readonly attempts: readonly PlannedAttempt[];
  /** Provider ids whose evidence is withdrawn (`external.attempt_cleared`). */
  readonly clears: readonly string[];
  /** What the process remembers as published, once the plan is committed: session row id to run id, `null` = forget. */
  readonly published: ReadonlyMap<number, number | null>;
}

export const EMPTY_PLAN: EvidencePlan = { attempts: [], clears: [], published: new Map() };

export interface PlanInput {
  /** Session row ids whose runs were ended or matched in this tick. */
  readonly touched: Iterable<number>;
  /** Session row ids that had an ended, matched run before a rebuild of the source deleted it (`AttemptsRepo.resetSource`). */
  readonly cleared: readonly number[];
  /** Provider ids that the matching of this tick already knows. */
  readonly uids: ReadonlyMap<number, string>;
  /** What this process published before: session row id to the run it published. */
  readonly published: ReadonlyMap<number, number>;
}

/**
 * Reads only. A session with an evidence run that is not the one already published gets an `external.attempt`; a session of
 * a rebuild that has no evidence run any more gets an `external.attempt_cleared`; a session whose evidence run is the one
 * published before gets nothing (no churn on idle ticks). A session that no longer exists yields no event.
 */
export function planEvidence(
  source: Pick<AttemptsStore, 'evidenceRun' | 'uidsByRowIds'>,
  input: PlanInput,
): EvidencePlan {
  const cleared = new Set(input.cleared);
  const sessions = new Set<number>([...input.touched, ...cleared]);
  if (sessions.size === 0) return EMPTY_PLAN;
  const unknown = [...sessions].filter((id) => !input.uids.has(id));
  const mapped = unknown.length === 0 ? new Map<number, string>() : source.uidsByRowIds(unknown);
  const attempts: PlannedAttempt[] = [];
  const clears: string[] = [];
  const published = new Map<number, number | null>();
  for (const id of [...sessions].sort((a, b) => a - b)) {
    const uid = input.uids.get(id) ?? mapped.get(id);
    if (uid === undefined) continue;
    const run: AttemptRunRow | undefined = source.evidenceRun(id);
    const endedAt = run?.endedAt ?? null;
    const isCleared = cleared.has(id);
    if (run === undefined || endedAt === null || run.state === 'RUNNING') {
      if (isCleared) {
        clears.push(uid);
        published.set(id, null);
      }
      continue;
    }
    // a rebuild deleted the runs the process remembers: the run ids may be reused, so the memory is not trusted for them
    if (!isCleared && input.published.get(id) === run.id) continue;
    attempts.push({
      sessionUid: uid,
      sessionRowId: id,
      runId: run.id,
      state: run.state,
      evidence: run.evidence,
      endedAt,
    });
    published.set(id, run.id);
  }
  return { attempts, clears, published };
}

// ---- publication ------------------------------------------------------------------------------------------------------------

/** The part of the writer that publication uses. */
export type EvidenceWriter = Pick<IngestWriter, 'submit' | 'onDrain'>;

/** Batches that the writer refused are kept; beyond this many they are merged (the later stamp of a session wins anyway). */
const MAX_KEPT_BATCHES = 8;

/** What a process remembers between attempts ticks. One per panel service. */
export interface EvidenceState {
  /** The last stamp handed out; `null` until the first publication. */
  lastPublishAt: number | null;
  /** Refused batches, oldest first. */
  pending: IngestBatch[];
  /** Session row id to the run published for it. */
  published: Map<number, number>;
  /** `onDrain` was registered with this writer. */
  hooked: boolean;
  /** The writer is gone (closed): nothing more is kept. */
  closed: boolean;
}

export function createEvidenceState(): EvidenceState {
  return { lastPublishAt: null, pending: [], published: new Map(), hooked: false, closed: false };
}

/** True once the state was closed (service shutdown) or the writer refused for good. */
export function isEvidenceClosed(state: EvidenceState): boolean {
  return state.closed;
}

/** Drops the batches that were not accepted (service shutdown). */
export function closeEvidenceState(state: EvidenceState): void {
  state.closed = true;
  state.pending = [];
}

export interface PublishDeps {
  readonly clock: Clock;
  readonly writer: EvidenceWriter;
  readonly state: EvidenceState;
  readonly logger?: Pick<Logger, 'debug' | 'warn'>;
}

function eventCount(batch: IngestBatch): number {
  return batch.items.reduce((sum, item) => sum + item.events.length, 0);
}

/** The next stamp: above the last one, and not before the clock. */
function nextStamp(deps: PublishDeps, floorMs: number): number {
  const now = deps.clock.now();
  const state = deps.state;
  // `updated_at` of the source is the commit time of the last publishing tick; its stamp was at least one above it
  state.lastPublishAt ??= Math.max(now, floorMs + 1);
  state.lastPublishAt = Math.max(now, state.lastPublishAt + 1);
  return state.lastPublishAt;
}

/** The events of a plan with the stamp: retractions first, then the evidence, each in order of the provider id. */
export function stampEvents(plan: EvidencePlan, observedAt: number): LogicalEvent[] {
  const byUid = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const clears: LogicalEvent[] = [...plan.clears]
    .sort(byUid)
    .map((sessionId) => ({ k: 'external.attempt_cleared', sessionId, observedAt }));
  const attempts: LogicalEvent[] = [...plan.attempts]
    .sort((a, b) => byUid(a.sessionUid, b.sessionUid))
    .map((a) => ({
      k: 'external.attempt',
      sessionId: a.sessionUid,
      state: a.state,
      evidence: a.evidence,
      rowKey: `attempt:${String(a.runId)}`,
      endedAt: a.endedAt,
      observedAt,
    }));
  return [...clears, ...attempts];
}

function batchOf(events: LogicalEvent[]): IngestBatch {
  return { source: 'external', items: [{ kind: 'external', events, rows: [] }], bytes: 0 };
}

/** Several kept batches as one: for each session only the event with the greatest stamp, which is all the registers keep. */
function merged(batches: readonly IngestBatch[]): IngestBatch {
  const latest = new Map<string, LogicalEvent & { observedAt: number }>();
  for (const batch of batches) {
    for (const item of batch.items) {
      for (const event of item.events) {
        if (event.k !== 'external.attempt' && event.k !== 'external.attempt_cleared') continue;
        const known = latest.get(event.sessionId);
        if (known === undefined || event.observedAt >= known.observedAt) latest.set(event.sessionId, event);
      }
    }
  }
  const events = [...latest.values()].sort((a, b) => (a.observedAt === b.observedAt ? 0 : a.observedAt - b.observedAt));
  return batchOf(events);
}

/** Hands the kept batches to the writer, oldest first, until it refuses one. Returns the number of events it took. */
export function drainPending(deps: PublishDeps): number {
  const { state, writer } = deps;
  let taken = 0;
  while (state.pending.length > 0 && !state.closed) {
    const batch = state.pending[0];
    if (batch === undefined) break;
    let accepted: boolean;
    try {
      accepted = writer.submit(batch);
    } catch (error) {
      if (!(error instanceof IngestWriterClosedError)) throw error;
      deps.logger?.warn('attempts_evidence_dropped', { code: 'WRITER_CLOSED', count: eventCount(batch) });
      closeEvidenceState(state);
      return taken;
    }
    if (!accepted) break;
    state.pending.shift();
    taken += eventCount(batch);
  }
  return taken;
}

function hook(deps: PublishDeps): void {
  const { state } = deps;
  if (state.hooked) return;
  state.hooked = true;
  deps.writer.onDrain(() => {
    try {
      drainPending(deps);
    } catch {
      // the next tick tries again; a listener must not throw into the writer
    }
  });
}

/**
 * After the COMMIT of the attempts transaction: remembers what the plan published, stamps its events and submits them as one
 * batch of the source `external`. A batch that comes behind kept batches waits behind them. Returns the number of events the
 * writer accepted in this call (kept batches that went through included). `floorMs` is `updated_at` of the attempts source as
 * read before the transaction (0 for a new source).
 */
export function publishEvidence(deps: PublishDeps, plan: EvidencePlan, floorMs: number): number {
  const { state } = deps;
  if (state.closed) return 0;
  for (const [id, runId] of plan.published) {
    if (runId === null) state.published.delete(id);
    else state.published.set(id, runId);
  }
  const events = plan.attempts.length + plan.clears.length === 0 ? [] : stampEvents(plan, nextStamp(deps, floorMs));
  const taken = drainPending(deps);
  if (events.length === 0 || isEvidenceClosed(state)) return taken;
  const batch = batchOf(events);
  if (state.pending.length > 0) {
    state.pending.push(batch);
  } else {
    try {
      if (deps.writer.submit(batch)) return taken + events.length;
    } catch (error) {
      if (!(error instanceof IngestWriterClosedError)) throw error;
      deps.logger?.warn('attempts_evidence_dropped', { code: 'WRITER_CLOSED', count: events.length });
      closeEvidenceState(state);
      return taken;
    }
    state.pending.push(batch);
  }
  hook(deps);
  if (state.pending.length > MAX_KEPT_BATCHES) state.pending = [merged(state.pending)];
  deps.logger?.debug('attempts_evidence_kept', { count: events.length });
  return taken;
}
