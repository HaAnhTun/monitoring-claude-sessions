// Matching chain-log runs to sessions (06 3.10.6, ADR 0059): the exact rules, applied to the candidates that
// `SessionsRepo.attemptCandidates` prefilters by label and activity.
//
// A session is a candidate of a run when its label equals `label_prefix + part`, its first record in file order (not the
// minimum timestamp, not the session start) is known, a rule matched it or `include_unmatched` is on, and it was active within
// the window. Its delta is `firstRecordAt - run.startedAt`; a delta from -15 s to +600 s (both included) is accepted and the
// SMALLEST delta wins (a negative one is smaller than a positive one, like the legacy comparison); a tie goes to the later last
// activity, then to the smaller provider id.
import type { AttemptCandidate } from '../../db/repos/attempts.ts';
import type { AttemptsStore } from './repo.ts';

/** A first record up to this long before the START line still belongs to the run (clock jitter between the two writers). */
export const MATCH_MIN_DELTA_MS = -15_000;
/** A first record up to this long after the START line belongs to the run. */
export const MATCH_MAX_DELTA_MS = 600_000;

/** The part of a run that matching reads. */
export interface MatchRun {
  readonly id: number;
  readonly part: string;
  /** Epoch ms of the START line. */
  readonly startedAt: number;
}

export interface MatchOptions {
  /** `attempts.label_prefix`. */
  readonly labelPrefix: string;
  /** `include_unmatched`: also sessions that no session rule matched and nobody pinned. */
  readonly includeUnmatched: boolean;
  /** `panelOptions.attemptsWindowHours` in milliseconds. */
  readonly windowMs: number;
  /** `ctx.clock.now()` of the tick. */
  readonly now: number;
}

export interface Assignment {
  readonly runId: number;
  readonly sessionRowId: number;
  /** The provider id (`sessions.session_uid`) of the session, for the evidence event. */
  readonly sessionUid: string;
  readonly deltaMs: number;
}

interface Scored {
  readonly candidate: AttemptCandidate;
  readonly deltaMs: number;
}

/** True when `a` is preferred to `b`: smaller delta, then later last activity, then smaller provider id. */
function beats(a: Scored, b: Scored): boolean {
  if (a.deltaMs !== b.deltaMs) return a.deltaMs < b.deltaMs;
  if (a.candidate.lastActivityAtMs !== b.candidate.lastActivityAtMs) {
    return a.candidate.lastActivityAtMs > b.candidate.lastActivityAtMs;
  }
  return a.candidate.sessionId < b.candidate.sessionId;
}

/** The session of `run` among `candidates`, or `null` when none qualifies. */
export function chooseCandidate(
  run: MatchRun,
  candidates: readonly AttemptCandidate[],
  options: MatchOptions,
): Scored | null {
  const label = options.labelPrefix + run.part;
  let best: Scored | null = null;
  for (const candidate of candidates) {
    if (candidate.label !== label) continue;
    if (candidate.firstRecordAtMs === null || candidate.firstRecordAtMs <= 0) continue;
    if (!candidate.matched && !options.includeUnmatched) continue;
    if (options.now - candidate.lastActivityAtMs > options.windowMs) continue;
    const deltaMs = candidate.firstRecordAtMs - run.startedAt;
    if (deltaMs < MATCH_MIN_DELTA_MS || deltaMs > MATCH_MAX_DELTA_MS) continue;
    const scored: Scored = { candidate, deltaMs };
    if (best === null || beats(scored, best)) best = scored;
  }
  return best;
}

/**
 * The matches of `runs`: one query for the candidates of every label involved, then `chooseCandidate` per run. A session may
 * match several runs (legacy). Reads only; the caller stores the result with `AttemptsRepo.setMatch`.
 */
export function matchRuns(
  source: Pick<AttemptsStore, 'attemptCandidates'>,
  runs: readonly MatchRun[],
  options: MatchOptions,
): Assignment[] {
  if (runs.length === 0) return [];
  const labels = [...new Set(runs.map((run) => options.labelPrefix + run.part))];
  const byLabel = new Map<string, AttemptCandidate[]>();
  for (const candidate of source.attemptCandidates(labels, options.now - options.windowMs)) {
    const list = byLabel.get(candidate.label);
    if (list === undefined) byLabel.set(candidate.label, [candidate]);
    else list.push(candidate);
  }
  const assignments: Assignment[] = [];
  for (const run of runs) {
    const best = chooseCandidate(run, byLabel.get(options.labelPrefix + run.part) ?? [], options);
    if (best === null) continue;
    assignments.push({
      runId: run.id,
      sessionRowId: best.candidate.sessionRowId,
      sessionUid: best.candidate.sessionId,
      deltaMs: best.deltaMs,
    });
  }
  return assignments;
}
