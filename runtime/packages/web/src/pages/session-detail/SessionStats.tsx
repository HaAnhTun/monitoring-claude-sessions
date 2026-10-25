import type { SessionDetail } from '@mcs/shared';
import { Link } from 'react-router';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { timeToMs, type Formatters } from '../../i18n/format.ts';

/** The errors of the session split by where they happened (ADR 0074 decision 6). */
export interface SessionErrorSplit {
  /** Errors of the agent whose transcript is open. */
  thisAgent: number;
  /** Errors of the subagents of the session. */
  subagents: number;
}

export interface SessionStatsProps {
  session: SessionDetail;
  /** The split of the session error count; null when the agents are not loaded or the split does not apply. */
  errors: SessionErrorSplit | null;
  /** The address of the Errors tab. */
  errorsHref: string;
}

/** The time of a moment: the clock alone when it is today, with the date otherwise. */
function momentOf(format: Formatters, iso: string): string {
  const ms = timeToMs(iso);
  const today = Number.isFinite(ms) && new Date(ms).toDateString() === new Date().toDateString();
  return today ? format.clock(iso, { seconds: false }) : format.dateTime(iso, { seconds: false });
}

/**
 * The four tiles under the title of a session (ADR 0073 decision 8): Active span, Last activity, Tokens (Output and Input (new),
 * ADR 0074 decision 5) and Errors with the split between this agent and the subagents (ADR 0074 decision 6). A token figure the
 * monitor does not have is "not available", never 0.
 */
export function SessionStats({ session, errors, errorsHref }: SessionStatsProps) {
  const t = useT();
  const format = useFormat();
  const split = errors !== null && errors.subagents > 0 ? errors : null;
  const hasIssues = session.errorCount > 0 || session.warningCount > 0;
  return (
    <div className="session-stats" role="group" aria-label={t('detail.stats.label')}>
      <dl className="session-stats__grid">
        <div className="session-stat">
          <dt title={t('detail.stats.activeSpan.tip')}>{t('detail.stats.activeSpan')}</dt>
          <dd className="session-stat__value">{format.duration(session.durationMs / 1000)}</dd>
          <dd className="session-stat__sub">
            {t('detail.stats.started', { time: momentOf(format, session.startedAt) })}
          </dd>
        </div>
        <div className="session-stat">
          <dt>{t('detail.stats.lastActivity')}</dt>
          <dd className="session-stat__value">
            <RelativeTime iso={session.lastActivityAt} />
          </dd>
          <dd className="session-stat__sub">
            {t('detail.stats.lastActivityAt', { time: momentOf(format, session.lastActivityAt) })}
          </dd>
        </div>
        <div className="session-stat session-stat--tokens">
          <dt>{t('detail.stats.tokens')}</dt>
          <dd className="session-stat__figures">
            <TokenFigures
              usage={session.usageInclSubagents}
              variant="tiles"
              figures={['output', 'inputNew']}
              includesSubagents
            />
          </dd>
        </div>
        <div className="session-stat">
          <dt>{t('detail.stats.errors')}</dt>
          <dd className="session-stat__value">
            <span data-tone={session.errorCount > 0 ? 'failed' : undefined}>{format.number(session.errorCount)}</span>
            {hasIssues ? (
              <Link className="session-stat__link" to={errorsHref}>
                {t('transcript.errors.viewAll')}
              </Link>
            ) : null}
          </dd>
          {session.warningCount > 0 || split !== null ? (
            <dd className="session-stat__sub">
              {session.warningCount > 0 ? (
                <span>{t('detail.stats.warnings', { count: session.warningCount })}</span>
              ) : null}
              {split === null ? null : (
                <span>
                  {t('transcript.errors.breakdown', { thisAgent: split.thisAgent, subagents: split.subagents })}
                </span>
              )}
            </dd>
          ) : null}
        </div>
      </dl>
    </div>
  );
}
