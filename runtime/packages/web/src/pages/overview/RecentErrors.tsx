import type { ActivityEvent } from '@mcs/shared';
import { Link } from 'react-router';

import { Icon } from '../../components/Icon.tsx';
import { useT } from '../../i18n/context.ts';
import { ActivityRow } from '../activity/ActivityRow.tsx';

/** The server sends at most this many (`Overview.recentErrors`). */
export const RECENT_ERRORS_CAP = 10;

export interface RecentErrorsProps {
  /** `overview.recentErrors`, newest first. */
  events: readonly ActivityEvent[];
}

/**
 * "Recent errors" (ADR 0073 decision 9): the newest problem events with the link to their session, drawn as the compact rows of
 * the activity feed. The link on the right opens the Activity page filtered to errors.
 */
export function RecentErrors({ events }: RecentErrorsProps) {
  const t = useT();
  const shown = events.slice(0, RECENT_ERRORS_CAP);
  return (
    <section className="card overview-section" aria-labelledby="overview-errors-title">
      <header className="overview-section__head">
        <h2 id="overview-errors-title">{t('overview.errors.title')}</h2>
        <Link to="/activity?severity=error" className="overview-section__action">
          {t('overview.errors.viewAll')}
        </Link>
      </header>
      {shown.length === 0 ? (
        <p className="overview-section__empty">
          <Icon name="check" />
          <span>{t('overview.errors.empty')}</span>
        </p>
      ) : (
        <ul className="activity-list activity-list--compact" aria-label={t('overview.errors.list')}>
          {shown.map((event) => (
            <ActivityRow key={event.id} event={event} mode="compact" />
          ))}
        </ul>
      )}
    </section>
  );
}
