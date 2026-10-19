// What the UI says about how the engine knows a state (ADR 0074 decisions 2 and 3): the question mark of an inferred active state,
// the one-line evidence under or next to the badge, and the plain words for `basis` and `confidence`. Pure: the clock is an argument,
// and every sentence is a catalogue key, so the components format the age and translate.
import type { LifecycleState, StateAssessment } from '@mcs/shared';

import type { MessageKey } from '../i18n/types.ts';

/** The fields of an assessment that this module reads. */
export type EvidenceAssessment = Pick<
  StateAssessment,
  'state' | 'basis' | 'confidence' | 'staleKind' | 'evidence' | 'since'
>;

export type BasisKey =
  | 'evidence.basis.observed'
  | 'evidence.basis.inferred'
  | 'evidence.basis.inferredSilence'
  | 'evidence.basis.inferredTranscript';

export type ConfidenceKey = 'evidence.confidence.high' | 'evidence.confidence.medium' | 'evidence.confidence.low';

/**
 * - `none`: no line (an observed state, or nothing to say).
 * - `quiet`: the UI composes "inferred, quiet 18m" from the clock (`lineKey` with `args.quietSeconds`).
 * - `inferred`: the state is inferred and there is no evidence item to show: just the word (`lineKey`).
 * - `server`: the first evidence item of the assessment, shown as server text (`args.text`, English, never translated).
 */
export type EvidenceLineKind = 'none' | 'quiet' | 'inferred' | 'server';

export interface StateEvidence {
  /** Only for the two active-turn states (`working`, `running`) with `basis = inferred`. */
  questionMark: boolean;
  lineKind: EvidenceLineKind;
  /** The UI phrase of a `quiet` or `inferred` line; null for `none` and `server`. */
  lineKey: Extract<MessageKey, 'evidence.inferred' | 'evidence.inferredQuiet'> | null;
  args: {
    /** Seconds since the last activity (never negative); null when neither `lastActivityAt` nor `since` can be read. */
    quietSeconds: number | null;
    /** The server text of a `server` line; null otherwise. */
    text: string | null;
  };
  basisKey: BasisKey;
  confidenceKey: ConfidenceKey;
}

const ACTIVE_TURN_STATES: readonly string[] = ['working', 'running'] satisfies LifecycleState[];

/** The question mark of ADR 0074 decision 2: an active turn that the engine only inferred. */
export function hasQuestionMark(state: string | null | undefined, basis: string | null | undefined): boolean {
  return basis === 'inferred' && state !== null && state !== undefined && ACTIVE_TURN_STATES.includes(state);
}

export function isInferred(assessment: Pick<StateAssessment, 'basis'> | null | undefined): boolean {
  return assessment?.basis === 'inferred';
}

function secondsSince(time: string | null | undefined, nowMs: number): number | null {
  if (time === null || time === undefined || time === '') return null;
  const ms = Date.parse(time);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

function basisKeyOf(assessment: EvidenceAssessment): BasisKey {
  if (assessment.basis !== 'inferred') return 'evidence.basis.observed';
  const silent =
    ACTIVE_TURN_STATES.includes(assessment.state) ||
    assessment.state === 'stale' ||
    assessment.staleKind === 'silent' ||
    assessment.staleKind === 'abandoned';
  if (silent) return 'evidence.basis.inferredSilence';
  if (assessment.evidence.some((item) => item.kind.startsWith('transcript')))
    return 'evidence.basis.inferredTranscript';
  return 'evidence.basis.inferred';
}

const CONFIDENCE_KEYS: Readonly<Record<StateAssessment['confidence'], ConfidenceKey>> = {
  high: 'evidence.confidence.high',
  medium: 'evidence.confidence.medium',
  low: 'evidence.confidence.low',
};

/**
 * The evidence of one state. `lastActivityAt` is the session's last activity (an ISO time); when it is missing the time `since`
 * the state began stands in. `nowMs` is the user's clock, so the age moves with it and never reads from the server's time.
 */
export function stateEvidence(
  assessment: EvidenceAssessment,
  lastActivityAt: string | null | undefined,
  nowMs: number,
): StateEvidence {
  const questionMark = hasQuestionMark(assessment.state, assessment.basis);
  const basisKey = basisKeyOf(assessment);
  const confidenceKey = CONFIDENCE_KEYS[assessment.confidence];
  const none = { quietSeconds: null, text: null } as const;

  if (questionMark) {
    const quietSeconds = secondsSince(lastActivityAt, nowMs) ?? secondsSince(assessment.since, nowMs);
    return {
      questionMark,
      lineKind: 'quiet',
      lineKey: quietSeconds === null ? 'evidence.inferred' : 'evidence.inferredQuiet',
      args: { quietSeconds, text: null },
      basisKey,
      confidenceKey,
    };
  }

  // A line is shown when the state is inferred or a tool is open (ADR 0074 decision 3).
  if (isInferred(assessment) || assessment.state === 'waiting_tool') {
    const first = assessment.evidence.find((item) => item.text.trim() !== '');
    if (first !== undefined) {
      return {
        questionMark,
        lineKind: 'server',
        lineKey: null,
        args: { quietSeconds: null, text: first.text.trim() },
        basisKey,
        confidenceKey,
      };
    }
    if (isInferred(assessment)) {
      return { questionMark, lineKind: 'inferred', lineKey: 'evidence.inferred', args: none, basisKey, confidenceKey };
    }
  }
  return { questionMark, lineKind: 'none', lineKey: null, args: none, basisKey, confidenceKey };
}
