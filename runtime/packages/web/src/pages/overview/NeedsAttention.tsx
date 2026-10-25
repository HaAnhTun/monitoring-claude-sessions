import type { SessionSummary } from '@mcs/shared';
import { Link } from 'react-router';

import { EvidenceLine } from '../../components/EvidenceLine.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { matchesAttention, sortByAttention } from '../../lib/sessions-attention.ts';

/** The most sessions the section lists (ADR 0073 decision 9). */
export const ATTENTION_CAP = 5;

const SKELETON_ROWS = 3;

export interface AttentionSelection {
  /** At most `cap` sessions, the most urgent first. */
  items: SessionSummary[];
  /** How many of the given sessions need attention. */
  total: number;
}

/**
 * The sessions to read first: those with an error, those that wait for input and those that are only inferred to be working
 * (quiet), ordered as the Sessions page orders "Attention first" (errors, waiting for input, quiet, then the newest activity).
 */
export function selectNeedsAttention(sessions: readonly SessionSummary[], cap = ATTENTION_CAP): AttentionSelection {
  const matching = sessions.filter(
    (session) =>
      matchesAttention(session, 'errors') || matchesAttention(session, 'waiting') || matchesAttention(session, 'quiet'),
  );
  return { items: sortByAttention(matching).slice(0, cap), total: matching.length };
}

export interface NeedsAttentionProps {
  /** The sessions that are loaded (the first page of the Sessions list). */
  sessions: readonly SessionSummary[];
  /** No page is left on the server, so `total` is exact; otherwise it is a lower bound. */
  complete: boolean;
  /** The first page is still on its way. */
  loading?: boolean;
}

function Item({ session }: { session: SessionSummary }) {
  const t = useT();
  const path = `/sessions/${session.id}`;
  return (
    <li className="attention-item" data-session-id={session.id}>
      <div className="attention-item__main">
        <Link to={path} className="attention-item__title" title={session.label}>
          {session.label}
        </Link>
        <span className="attention-item__state">
          <StateBadge
            state={session.state.state}
            assessment={session.state}
            lastActivityAt={session.lastActivityAt}
            size="sm"
          />
          <EvidenceLine assessment={session.state} lastActivityAt={session.lastActivityAt} />
        </span>
      </div>
      <div className="attention-item__side">
        {session.errorCount > 0 ? (
          <Link to={`${path}?tab=errors`} className="attention-item__errors" title={t('overview.attention.errorsTip')}>
            {t('overview.attention.errors', { count: session.errorCount })}
          </Link>
        ) : null}
        <RelativeTime iso={session.lastActivityAt} />
      </div>
    </li>
  );
}

/**
 * "Needs attention" (ADR 0073 decision 9): at most five sessions with an error, waiting for input or quiet (inferred), each with
 * its state, the evidence line that says how the state was decided, and a link to the session.
 */
export function NeedsAttention({ sessions, complete, loading = false }: NeedsAttentionProps) {
  const t = useT();
  const format = useFormat();
  const { items, total } = selectNeedsAttention(sessions);
  const more = total > items.length || !complete;
  return (
    <section className="card overview-section" aria-labelledby="overview-attention-title">
      <header className="overview-section__head">
        <h2 id="overview-attention-title">{t('overview.attention.title')}</h2>
        {more && items.length > 0 ? (
          <Link to="/sessions?sort=attention" className="overview-section__action">
            {t('overview.attention.viewAll')}
          </Link>
        ) : null}
      </header>
      {loading ? (
        <div className="overview-section__body">
          <Skeleton variant="list" rows={SKELETON_ROWS} label={t('overview.attention.loading')} />
        </div>
      ) : items.length === 0 ? (
        <p className="overview-section__empty">
          <Icon name="check" />
          <span>{t('overview.attention.empty')}</span>
        </p>
      ) : (
        <>
          <ul className="attention-list" aria-label={t('overview.attention.list')}>
            {items.map((session) => (
              <Item key={session.id} session={session} />
            ))}
          </ul>
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
