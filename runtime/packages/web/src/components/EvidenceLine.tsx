import type { StateAssessment } from '@mcs/shared';

import { ServerText } from '../i18n/ServerText.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import { hasQuestionMark, stateEvidence } from '../lib/state-evidence.ts';
import { useNow } from './RelativeTime.tsx';

export interface EvidenceLineProps {
  assessment: Pick<StateAssessment, 'state' | 'basis' | 'confidence' | 'staleKind' | 'evidence' | 'since'>;
  /** The last activity of the session (ISO time). */
  lastActivityAt?: string | null | undefined;
  /** The clock in epoch milliseconds; the shared one-second clock when omitted. */
  nowMs?: number | undefined;
}

/**
 * The one muted line under a state badge (ADR 0074 decision 3): "inferred, quiet 18m" composed from the user's clock for an
 * inferred active turn, the first evidence item of the engine (English server text) for another inferred state or an open
 * tool, and nothing for an observed state. The title holds the plain-word basis and confidence.
 */
export function EvidenceLine({ assessment, lastActivityAt, nowMs }: EvidenceLineProps) {
  const t = useT();
  const format = useFormat();
  const ticking = nowMs === undefined && hasQuestionMark(assessment.state, assessment.basis);
  const clock = useNow(ticking);
  const evidence = stateEvidence(assessment, lastActivityAt, nowMs ?? clock);
  if (evidence.lineKind === 'none') return null;

  const tip = t('evidence.basisTip', { basis: t(evidence.basisKey), confidence: t(evidence.confidenceKey) });
  if (evidence.lineKind === 'server' && evidence.args.text !== null) {
    return (
      <span className="evidence-line" title={`${evidence.args.text}\n${tip}`} data-evidence="server">
        <ServerText>{evidence.args.text}</ServerText>
      </span>
    );
  }
  const { quietSeconds } = evidence.args;
  const text =
    evidence.lineKey === 'evidence.inferredQuiet' && quietSeconds !== null
      ? t('evidence.inferredQuiet', { age: format.age(quietSeconds) })
      : t('evidence.inferred');
  return (
    <span className="evidence-line" title={tip} data-evidence={evidence.lineKind}>
      {text}
    </span>
  );
}
