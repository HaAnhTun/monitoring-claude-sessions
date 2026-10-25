import { ACTIVE_STATES, type SessionSummary } from '@mcs/shared';
import { Link } from 'react-router';

import { EvidenceLine } from '../../components/EvidenceLine.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useFormat, useT } from '../../i18n/context.ts';

/** The most sessions the section lists; the link below it opens the rest. */
export const RUNNING_CAP = 8;

const SKELETON_ROWS = 3;
const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_STATES);

export interface RunningSelection {
  /** At most `cap` sessions, the newest activity first. */
  items: SessionSummary[];
  /** How many of the given sessions are active. */
  total: number;
}

function activityOf(session: SessionSummary): number {
  const ms = Date.parse(session.lastActivityAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The sessions in an active state (running, working, waiting for a tool or a subagent), the newest activity first. */
export function selectRunning(sessions: readonly SessionSummary[], cap = RUNNING_CAP): RunningSelection {
  const active = sessions.filter((session) => ACTIVE.has(session.state.state));
  const ordered = [...active].sort((a, b) => activityOf(b) - activityOf(a));
  return { items: ordered.slice(0, cap), total: active.length };
}

export interface RunningSessionsProps {
  /** The sessions that are loaded (the first page of the Sessions list). */
  sessions: readonly SessionSummary[];
  /** No page is left on the server, so the count is exact; otherwise it is a lower bound. */
  complete: boolean;
  /** The first page is still on its way. */
  loading?: boolean;
}

function Row({ session }: { session: SessionSummary }) {
  return (
    <tr data-session-id={session.id}>
      <th scope="row" className="overview-table__session">
        <Link to={`/sessions/${session.id}`} title={session.label}>
          {session.label}
        </Link>
      </th>
      <td className="overview-table__state">
        <StateBadge
          state={session.state.state}
          assessment={session.state}
          lastActivityAt={session.lastActivityAt}
          size="sm"
        />
        <EvidenceLine assessment={session.state} lastActivityAt={session.lastActivityAt} />
      </td>
      <td className="overview-table__time">
        <RelativeTime iso={session.lastActivityAt} />
      </td>
      <td className="overview-table__num">
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="output" />
      </td>
      <td className="overview-table__num">
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="inputNew" />
      </td>
    </tr>
  );
}

/**
 * "Running now" (ADR 0073 decision 9): the sessions in an active state with their last activity, Output and Input (new), each a
 * link to the session. Figures include the subagents, like the Sessions list.
 */
export function RunningSessions({ sessions, complete, loading = false }: RunningSessionsProps) {
  const t = useT();
  const format = useFormat();
  const { items, total } = selectRunning(sessions);
  return (
    <section className="card overview-section" aria-labelledby="overview-running-title">
      <header className="overview-section__head">
        <h2 id="overview-running-title">{t('overview.running.title')}</h2>
        {total > items.length || (!complete && items.length > 0) ? (
          <Link to="/sessions?state=active" className="overview-section__action">
            {t('overview.running.viewAll')}
          </Link>
        ) : null}
      </header>
      {loading ? (
        <div className="overview-section__body">
          <Skeleton variant="list" rows={SKELETON_ROWS} label={t('overview.running.loading')} />
        </div>
      ) : items.length === 0 ? (
        <p className="overview-section__empty">
          <Icon name="sessions" />
          <span>{t('overview.running.empty')}</span>
        </p>
      ) : (
        <>
          <div className="overview-table-wrap">
            <table className="overview-table">
              <caption className="sr-only">{t('overview.running.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('sessions.col.session')}</th>
                  <th scope="col">{t('sessions.col.state')}</th>
                  <th scope="col">{t('sessions.col.lastActivity')}</th>
                  <th scope="col" className="overview-table__num" title={t('sessions.col.output.tip')}>
                    {t('sessions.col.output')}
                  </th>
                  <th scope="col" className="overview-table__num" title={t('sessions.col.input.tip')}>
                    {t('sessions.col.input')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((session) => (
                  <Row key={session.id} session={session} />
                ))}
              </tbody>
            </table>
          </div>
          {total > items.length ? (
            <p className="overview-section__note muted small">
              {t(complete ? 'overview.shown' : 'overview.shownAtLeast', {
                shown: format.number(items.length),
                total: format.number(total),
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
