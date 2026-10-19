// The thin adapter of the attempts modules over `AttemptsRepo` and `SessionsRepo` (06 3.10.2): it binds the repository scope
// once, so that `ingest.ts`, `match.ts` and `evidence.ts` read like the algorithm, and it maps stored runs to the rows of the
// attempts panel (06 3.10.8). It holds no SQL: every statement is in `engine/src/db/**` (03 4.5).
import { isoMsZ, type AttemptsPanel, type TokenUsage } from '@mcs/shared';

import type { LegacyConfig } from '../../config/defaults.ts';
import type { InstanceDb, RepoContext } from '../../db/open.ts';
import {
  AttemptsRepo,
  type AttemptCandidate,
  type AttemptEnd,
  type AttemptRunRow,
  type AttemptSourceInput,
  type AttemptSourceRow,
  type NewAttemptRun,
} from '../../db/repos/attempts.ts';
import { SessionsRepo } from '../../db/repos/sessions.ts';
import type { WriteTx } from '../../db/write.ts';
import type { EngineQueries } from '../../query/index.ts';

/** `AttemptsRepo` and the two reads of `SessionsRepo` that the attempts modules need, with the scope bound. */
export interface AttemptsStore {
  getSource(pathKey: string): AttemptSourceRow | undefined;
  saveSource(tx: WriteTx, source: AttemptSourceInput): number;
  resetSource(tx: WriteTx, sourceId: number, configSha256: string): number[];
  openRun(sourceId: number, generation: number, part: string): AttemptRunRow | undefined;
  insertRun(tx: WriteTx, run: NewAttemptRun): number | undefined;
  endRun(tx: WriteTx, id: number, end: AttemptEnd): boolean;
  supersedeRun(tx: WriteTx, id: number, evidence: string): boolean;
  setMatch(tx: WriteTx, id: number, sessionRowId: number, matchDeltaMs: number): boolean;
  runsToMatch(startedSinceMs: number, limit: number): AttemptRunRow[];
  latestRuns(limit: number): AttemptRunRow[];
  evidenceRun(sessionRowId: number): AttemptRunRow | undefined;
  /** `SessionsRepo.attemptCandidates` (06 3.10.6): the prefilter only, the exact rules are `match.ts`. */
  attemptCandidates(labels: readonly string[], activeSinceMs: number): AttemptCandidate[];
  /** `SessionsRepo.uidsByRowIds` (06 3.10.2): session row id to provider id, unknown ids left out. */
  uidsByRowIds(rowIds: readonly number[]): Map<number, string>;
}

export function createAttemptsStore(db: InstanceDb, scope: RepoContext): AttemptsStore {
  const attempts = new AttemptsRepo(db);
  const sessions = new SessionsRepo(db);
  return {
    getSource: (pathKey) => attempts.getSource(scope, pathKey),
    saveSource: (tx, source) => attempts.saveSource(scope, tx, source),
    resetSource: (tx, sourceId, configSha256) => attempts.resetSource(scope, tx, sourceId, configSha256),
    openRun: (sourceId, generation, part) => attempts.openRun(scope, sourceId, generation, part),
    insertRun: (tx, run) => attempts.insertRun(scope, tx, run),
    endRun: (tx, id, end) => attempts.endRun(scope, tx, id, end),
    supersedeRun: (tx, id, evidence) => attempts.supersedeRun(scope, tx, id, evidence),
    setMatch: (tx, id, sessionRowId, matchDeltaMs) => attempts.setMatch(scope, tx, id, sessionRowId, matchDeltaMs),
    runsToMatch: (startedSinceMs, limit) => attempts.runsToMatch(scope, startedSinceMs, limit),
    latestRuns: (limit) => attempts.latestRuns(scope, limit),
    evidenceRun: (sessionRowId) => attempts.evidenceRun(scope, sessionRowId),
    attemptCandidates: (labels, activeSinceMs) => sessions.attemptCandidates(scope, labels, activeSinceMs),
    uidsByRowIds: (rowIds) => sessions.uidsByRowIds(scope, rowIds),
  };
}

// ---- the panel read (06 3.10.8) -------------------------------------------------------------------------------------------

/** What the panel read needs of the instance context. */
export interface AttemptsPanelContext {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly config: { readonly monitor: Pick<LegacyConfig, 'attempts' | 'chain_log'> };
  readonly queries: Pick<EngineQueries, 'sessionSummaries'>;
}

type PanelRow = AttemptsPanel['rows'][number];

const DIGITS_RE = /^\d+$/;
const SIGNED_DIGITS_RE = /^-?\d+$/;

/** A run of digits as a number, `null` when the text is not one or does not fit a whole JavaScript number. */
function wholeNumber(text: string | null, pattern: RegExp): number | null {
  if (text === null || !pattern.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function rowOf(run: AttemptRunRow, sessionId: string | null, usage: TokenUsage | null): PanelRow {
  return {
    part: run.part,
    n: wholeNumber(run.nRaw, DIGITS_RE),
    model: run.model,
    effort: run.effort,
    startedAt: isoMsZ(run.startedAt),
    endedAt: run.endedAt === null ? null : isoMsZ(run.endedAt),
    exit: wholeNumber(run.exitRaw, SIGNED_DIGITS_RE),
    status: run.statusRaw,
    state: run.state,
    sessionId,
    usage,
    attemptId: run.id,
    nRaw: run.nRaw,
    exitRaw: run.exitRaw,
    endReason: run.endReason,
    evidence: run.evidence,
    matchDeltaS: run.matchDeltaMs === null ? null : run.matchDeltaMs / 1000,
  };
}

/**
 * The newest `limit` runs in start order, every generation included (history), as the rows of the attempts panel. `sessionId` is
 * the provider id of the matched session (`null` when unmatched or when the session no longer exists); `usage` is that
 * session's aggregate including its subagents. `sourceState` is what the last tick said about the chain log; without it the
 * state is `not_configured` when `attempts` or `chain_log` is not set and `ok` otherwise.
 */
export function readAttemptsPanel(
  ctx: AttemptsPanelContext,
  limit: number,
  sourceState?: AttemptsPanel['sourceState'],
): AttemptsPanel {
  const configured = ctx.config.monitor.attempts !== null && ctx.config.monitor.chain_log !== null;
  const state = sourceState ?? (configured ? 'ok' : 'not_configured');
  const store = createAttemptsStore(ctx.db, ctx.scope);
  const runs = store.latestRuns(limit);
  const rowIds = [...new Set(runs.flatMap((run) => (run.sessionRowId === null ? [] : [run.sessionRowId])))];
  const uids = store.uidsByRowIds(rowIds);
  const usageByUid = new Map<string, TokenUsage>();
  if (uids.size > 0) {
    for (const summary of ctx.queries.sessionSummaries(ctx.scope, [...uids.keys()])) {
      usageByUid.set(summary.id, summary.usageInclSubagents);
    }
  }
  return {
    rows: runs.map((run) => {
      const sessionId = run.sessionRowId === null ? null : (uids.get(run.sessionRowId) ?? null);
      return rowOf(run, sessionId, sessionId === null ? null : (usageByUid.get(sessionId) ?? null));
    }),
    sourceState: state,
  };
}
