// Completion evidence (02 7.13, brief 8.9, registry C16 and C17): did an unattended run really finish? `explainCompletion` names
// the run by a session id, an exact label or an attempt part, finds the session (or the attempt row) that decides, and says
// whether the outcome is terminal. A terminal outcome rests on observed evidence only (D9): an inferred `completed` or
// `failed`, a quiet session and a dead process are never "finished".
//
// The function is pure. It reads nothing but the lookup it is given, and the time is a parameter. The lookup (the query
// layer, or a table test) owns every read; a candidate hands over the inputs of a re-derivation as a function, so a session
// whose stored view is out of date is re-derived only when its answer is needed.
import type { CompletionEvidence, CompletionOutcome } from '@mcs/shared';
import { COMPLETION_LABEL_MAX, COMPLETION_PART_MAX, withinCodePoints } from '@mcs/shared';
import { SID_RE } from '@mcs/shared/protocol';

import type { AttemptRowRef } from '../db/repos/attempts.ts';
import { deriveModel, type ModelInputs } from './derive-session.ts';
import type { LifecycleCfg, LifecycleEvidence, LifecycleView } from './facts.ts';
import type { LifecycleModel } from './merge.ts';
import { isJobSuperseded, toApiEvidence } from './rules.ts';

export type { AttemptRowRef };

export type CompletionTarget = { sessionId: string } | { label: string } | { attemptPart: string };

/** What `explainCompletion` is given for a re-derivation: the facts and rows of the session, and the inputs besides them. */
export interface CompletionDerivation {
  readonly model: LifecycleModel;
  /** The row-level inputs of the derivation (the trailing cost-state flag). */
  readonly inputs: ModelInputs;
  readonly cfg: LifecycleCfg;
}

export interface CompletionCandidate {
  readonly sessionId: string;
  readonly label: string;
  readonly startedAt: number | null;
  readonly lastActivityAt: number | null;
  /** The stored view of the session. */
  readonly view: LifecycleView;
  /** The inputs of a re-derivation, or `null` when the facts of the session cannot be read. Called at most once per answer. */
  readonly derivation: () => CompletionDerivation | null;
}

export interface CompletionLookup {
  sessionById(sessionId: string): CompletionCandidate | null;
  /** Exact, case-sensitive label equality: a `%` or `_` in the label is an ordinary character. */
  sessionsByLabel(label: string): CompletionCandidate[];
  /** Every run of the part, in every generation. */
  attemptRowsByPart(part: string): AttemptRowRef[];
}

export type CompletionTargetCode = 'target_invalid' | 'target_not_found';

/** The target is malformed (`target_invalid`, 400 / USAGE) or matches nothing (`target_not_found`, 404 / NOT_FOUND). */
export class CompletionTargetError extends Error {
  readonly code: CompletionTargetCode;
  readonly target: CompletionTarget;

  /** The message is the code: the target (a label may be private) is carried as data and never put into text. */
  constructor(code: CompletionTargetCode, target: CompletionTarget) {
    super(code);
    this.name = 'CompletionTargetError';
    this.code = code;
    this.target = target;
  }
}

/** The evidence text of an attempt row is clipped to this many code points before it is rendered (02 7.13 step 4b). */
const ROW_EVIDENCE_MAX_CP = 160;
const MAX_EVIDENCE_ITEMS = 8;

function clipCodePoints(text: string, n: number): string {
  if (text.length <= n) return text;
  const points = Array.from(text);
  return points.length <= n ? text : points.slice(0, n).join('');
}

const SELECTOR_KEYS = ['sessionId', 'label', 'attemptPart'] as const;

/** A target names exactly one selector, and its value is text. */
function isWellFormed(target: CompletionTarget): boolean {
  const present: unknown[] = [];
  for (const key of SELECTOR_KEYS) {
    if (key in target) present.push(Reflect.get(target, key));
  }
  return present.length === 1 && typeof present[0] === 'string';
}

/**
 * Step 1 of the algorithm: a session id must match the session id pattern, a label has 1..200 code points and an attempt
 * part 0..512 (the empty part is legal: attempts without a `part` group, registry C17). Throws `target_invalid`. The query
 * layer calls it before it opens a read, so a refused target never reaches the database.
 */
export function validateCompletionTarget(target: CompletionTarget): void {
  let valid = false;
  if (isWellFormed(target)) {
    if ('sessionId' in target) valid = SID_RE.test(target.sessionId);
    else if ('label' in target) valid = target.label !== '' && withinCodePoints(target.label, COMPLETION_LABEL_MAX);
    else valid = withinCodePoints(target.attemptPart, COMPLETION_PART_MAX);
  }
  if (!valid) throw new CompletionTargetError('target_invalid', target);
}

/** The ordering of 02 7.11 (the board): the newest start first, then the latest activity, then the id; no time sorts last. */
function newestFirst(a: CompletionCandidate, b: CompletionCandidate): number {
  const byStart = descendingNullLast(a.startedAt, b.startedAt);
  if (byStart !== 0) return byStart;
  const byActivity = descendingNullLast(a.lastActivityAt, b.lastActivityAt);
  if (byActivity !== 0) return byActivity;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

function descendingNullLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * The view that answers at `now` (step 5). A stored view is used as it is, unless its time has come
 * (`nextCheckAt <= now`: the sweeper has not looked yet, so a delay never shows an out-of-date state), or it rests on a
 * daemon job that later activity has passed (`isJobSuperseded`, ADR 0069: a done job older than the activity after it is
 * not completion evidence). Then the session is derived again from its facts. Facts that cannot be read leave the stored view.
 */
function viewAt(candidate: CompletionCandidate, now: number): LifecycleView {
  const stored = candidate.view;
  const due = stored.nextCheckAt !== null && stored.nextCheckAt <= now;
  const restsOnJob = stored.ruleId === 'S-4a' || stored.ruleId === 'S-4b';
  if (!due && !restsOnJob) return stored;
  const derivation = candidate.derivation();
  if (derivation === null) return stored;
  const { model, inputs, cfg } = derivation;
  if (!due && !isJobSuperseded(model.session, cfg)) return stored;
  return deriveModel(model, now, cfg, inputs).session;
}

function outcomeOf(view: Pick<LifecycleView, 'state' | 'basis'>): CompletionOutcome {
  if (view.basis !== 'observed') return 'not_terminal'; // D9: an inferred state is never terminal
  if (view.state === 'completed') return 'completed';
  if (view.state === 'failed') return 'failed';
  return 'not_terminal';
}

function ofSession(
  candidate: CompletionCandidate,
  resolvedBy: CompletionEvidence['resolvedBy'],
  candidates: number,
  now: number,
): CompletionEvidence {
  const view = viewAt(candidate, now);
  return {
    outcome: outcomeOf(view),
    state: view.state,
    basis: view.basis,
    confidence: view.confidence,
    evidence: view.evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => toApiEvidence(item, now)),
    sessionId: candidate.sessionId,
    ruleId: view.ruleId,
    resolvedBy,
    candidates,
  };
}

/** The row, as the evidence item `attempts:attempt_row`; `at` is when the row ended, or when it started if it has not. */
function rowEvidence(row: AttemptRowRef, at: number | null, now: number): CompletionEvidence['evidence'] {
  const item: LifecycleEvidence = {
    source: 'attempts',
    fact: 'attempt_row',
    at,
    value: clipCodePoints(row.evidence, ROW_EVIDENCE_MAX_CP),
  };
  return [toApiEvidence(item, now)];
}

/** The row with the latest start (`(startedAt, id)`, the legacy "latest START wins" of 06 3.10.7). */
function latestStart(rows: readonly AttemptRowRef[]): AttemptRowRef | undefined {
  let latest: AttemptRowRef | undefined;
  for (const row of rows) {
    if (
      latest === undefined ||
      row.startedAt > latest.startedAt ||
      (row.startedAt === latest.startedAt && row.id > latest.id)
    ) {
      latest = row;
    }
  }
  return latest;
}

function ofAttemptRow(
  lookup: CompletionLookup,
  rows: readonly AttemptRowRef[],
  row: AttemptRowRef,
  now: number,
): CompletionEvidence {
  const candidates = rows.length;
  if (row.endReason === 'ended') {
    // a. the session that matched the row decides: its attempt fact is this row or a later one
    const matched = row.sessionId === null ? null : lookup.sessionById(row.sessionId);
    if (matched !== null) return ofSession(matched, 'attempt_part', candidates, now);
    // b. the row alone
    const state = row.state === 'COMPLETED' ? 'completed' : row.state === 'FAILED' ? 'failed' : 'unknown';
    return {
      outcome: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'not_terminal',
      state,
      basis: 'observed',
      confidence: row.state === 'UNKNOWN' ? 'low' : 'high',
      evidence: rowEvidence(row, row.endedAt, now),
      sessionId: null,
      ruleId: 'C-ATT-ENDED',
      resolvedBy: 'attempt_part',
      candidates,
    };
  }
  if (row.endReason === 'open') {
    return {
      outcome: 'not_terminal',
      state: 'running',
      basis: 'observed',
      confidence: 'medium',
      evidence: rowEvidence(row, row.startedAt, now),
      sessionId: row.sessionId,
      ruleId: 'C-ATT-OPEN',
      resolvedBy: 'attempt_part',
      candidates,
    };
  }
  return {
    outcome: 'not_terminal',
    state: 'unknown',
    basis: 'observed',
    confidence: 'low',
    evidence: rowEvidence(row, row.startedAt, now),
    sessionId: row.sessionId,
    ruleId: 'C-ATT-SUPERSEDED',
    resolvedBy: 'attempt_part',
    candidates,
  };
}

/**
 * Whether the run named by `target` finished, and why that is known. Throws `CompletionTargetError`: `target_invalid` for a
 * malformed target, `target_not_found` when nothing matches. There is no `null` result.
 */
export function explainCompletion(lookup: CompletionLookup, target: CompletionTarget, now: number): CompletionEvidence {
  validateCompletionTarget(target);
  if ('sessionId' in target) {
    const candidate = lookup.sessionById(target.sessionId);
    if (candidate === null) throw new CompletionTargetError('target_not_found', target);
    return ofSession(candidate, 'session_id', 1, now);
  }
  if ('label' in target) {
    const candidates = lookup.sessionsByLabel(target.label);
    const newest = [...candidates].sort(newestFirst)[0];
    if (newest === undefined) throw new CompletionTargetError('target_not_found', target);
    return ofSession(newest, 'label', candidates.length, now);
  }
  const rows = lookup.attemptRowsByPart(target.attemptPart);
  const latest = latestStart(rows);
  if (latest === undefined) throw new CompletionTargetError('target_not_found', target);
  return ofAttemptRow(lookup, rows, latest, now);
}
