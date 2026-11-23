import type { StateAssessment } from '@mcs/shared';

import { useFormat, useT } from '../i18n/context.ts';
import { attentionDisplay } from '../lib/attention-display.ts';
import { lifecycleDisplay } from '../lib/lifecycle-display.ts';
import { hasQuestionMark, isInferred, stateEvidence } from '../lib/state-evidence.ts';
import { useNow } from './RelativeTime.tsx';

export interface StateBadgeProps {
  /** A LifecycleState of the API; any other string is shown as unknown. */
  state: string;
  /**
   * How the engine decided. With `basis = inferred` the badge gets a dashed ring and a tinted fill, and an active turn
   * (`working`, `running`) gets a question mark (ADR 0074 decision 2). Without it the badge is drawn as observed. With the
   * `rule` that decided it, `waiting_input` reads "Needs you" or "Ready for prompt" (ADR 0107); without a rule it keeps its
   * own word.
   */
  assessment?:
    | (Pick<StateAssessment, 'basis' | 'confidence' | 'staleKind' | 'evidence' | 'since'> &
        Partial<Pick<StateAssessment, 'rule' | 'waitReason' | 'turnOutcome'>>)
    | undefined;
  /** The last activity of the session (ISO time); the tooltip of an inferred active state says how long it has been quiet. */
  lastActivityAt?: string | null | undefined;
  /** Replaces the tooltip (the description of the state). */
  evidenceTip?: string | undefined;
  size?: 'sm' | 'md';
}

/**
 * A lifecycle state as a dot and a word. The table is `lifecycleDisplay`, with the two words of `waiting_input` from
 * `attentionDisplay`; the word is always there (never colour-only).
 */
export function StateBadge({ state, assessment, lastActivityAt, evidenceTip, size = 'md' }: StateBadgeProps) {
  const t = useT();
  const format = useFormat();
  const display = lifecycleDisplay(state);
  const override = attentionDisplay(display.state, assessment);
  const inferred = isInferred(assessment);
  const questionMark = hasQuestionMark(display.state, assessment?.basis);
  const clock = useNow(questionMark && lastActivityAt !== null && lastActivityAt !== undefined);

  const label = t(override?.labelKey ?? display.labelKey);
  const description = t(override?.descriptionKey ?? display.descriptionKey);
  let tip = description;
  if (assessment !== undefined && inferred) {
    const evidence = stateEvidence({ ...assessment, state: display.state }, lastActivityAt, clock);
    const parts = { description, basis: t(evidence.basisKey), confidence: t(evidence.confidenceKey) };
    const { quietSeconds } = evidence.args;
    tip =
      evidence.questionMark && quietSeconds !== null
        ? t('badge.inferredTipQuiet', { ...parts, age: format.age(quietSeconds) })
        : t('badge.inferredTip', parts);
  }

  const classes = ['badge', 'badge--state', override?.toneClass ?? display.toneClass];
  if (inferred) classes.push('badge--inferred');
  if (size === 'sm') classes.push('badge--sm');
  return (
    <span
      className={classes.join(' ')}
      title={evidenceTip ?? tip}
      data-state={display.state}
      data-attention={override?.word}
      data-basis={inferred ? 'inferred' : undefined}
    >
      <span className={`state-dot state-dot--${override?.dot ?? display.dot}`} aria-hidden="true" />
      <span className="badge__word">{questionMark ? t('badge.inferredLabel', { label }) : label}</span>
    </span>
  );
}
