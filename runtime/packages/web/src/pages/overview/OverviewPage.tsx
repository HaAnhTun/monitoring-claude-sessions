import { toQuery } from '@mcs/shared';
import { useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { AttentionStrip } from '../../components/AttentionStrip.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StaleDataIndicator } from '../../components/StaleDataIndicator.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { toEventFilter, toSessionFilter } from '../../data/endpoints.ts';
import { ApiContext, InstanceIdContext, useInstance } from '../../data/hooks/useInstance.ts';
import { useOverview } from '../../data/hooks/useOverview.ts';
import { useSessions } from '../../data/hooks/useSessions.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { attentionPatch, type AttentionTile } from '../../lib/sessions-attention.ts';
import { activitySpec, formatUrlState, parseUrlState, sessionsSpec } from '../../lib/url-state.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { ActivityFeed } from '../activity/ActivityFeed.tsx';
import { IngestionSummary } from './IngestionSummary.tsx';
import { MetricGrid } from './MetricGrid.tsx';
import { NeedsAttention } from './NeedsAttention.tsx';
import { RecentErrors } from './RecentErrors.tsx';
import { RunningSessions } from './RunningSessions.tsx';

const DEFAULT_WINDOW_HOURS = 24;
/** How many events the compact feed shows (ADR 0073 decision 9). */
const ACTIVITY_LIMIT = 15;
const TILE_SKELETONS = 4;

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

function OverviewUnavailable() {
  const t = useT();
  const title = t('route.overview.title');
  const headingRef = usePageChrome(title);
  return (
    <section className="page overview">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
    </section>
  );
}

function Overview() {
  const t = useT();
  const format = useFormat();
  const showToast = useShowToast();
  const title = t('route.overview.title');
  const headingRef = usePageChrome(title);
  const windowHours = useInstance().data?.windowHours ?? DEFAULT_WINDOW_HOURS;

  // The same list, the same query and so the same cache entry as the first page of /sessions without a filter: the counts below
  // are those of the list a tile opens, and the click finds the rows already loaded.
  const spec = useMemo(() => sessionsSpec(windowHours), [windowHours]);
  const defaults = useMemo(() => parseUrlState(spec, new URLSearchParams()).value, [spec]);
  const query = useMemo(() => toQuery({ ...toSessionFilter(defaults), includeTotal: true }), [defaults]);
  const sessions = useSessions(query, {
    onCursorReset: () => {
      showToast(t('error.handling.listChanged'));
    },
  });
  const overview = useOverview();
  const activityFilter = useMemo(() => toEventFilter(parseUrlState(activitySpec, new URLSearchParams()).value), []);

  const hrefFor = useCallback(
    (tile: AttentionTile): string => {
      const search = formatUrlState(spec, { ...defaults, ...attentionPatch(tile) })
        .toString()
        .replaceAll('%2C', ',');
      return search === '' ? '/sessions' : `/sessions?${search}`;
    },
    [spec, defaults],
  );

  const list = sessions.query;
  const rows = sessions.items;
  const complete = list.data !== undefined && !list.hasNextPage;
  const sessionsLoading = list.data === undefined && !list.isError;
  const sessionsFailed = list.data === undefined && list.isError;
  const noSessions = complete && rows.length === 0;
  const refreshFailing =
    (list.isError && list.data !== undefined && !list.isFetchNextPageError) ||
    (overview.isError && overview.data !== undefined);
  const range = overview.data?.window;

  let figures: ReactNode;
  if (overview.data !== undefined) {
    figures =
      overview.data.metrics.length === 0 ? (
        <p className="muted overview__note">{t('overview.figures.empty')}</p>
      ) : (
        <MetricGrid metrics={overview.data.metrics} />
      );
  } else if (overview.isError) {
    figures = (
      <ErrorState
        kind={kindOf(overview.error)}
        subjectKey="error.subject.overview"
        error={overview.error}
        onRetry={() => {
          void overview.refetch();
        }}
      />
    );
  } else {
    figures = <Skeleton variant="tiles" rows={TILE_SKELETONS} label={t('overview.figures.loading')} />;
  }

  let main: ReactNode;
  if (noSessions) {
    main = (
      <EmptyState
        title={t('overview.empty.title')}
        icon="overview"
        headingLevel={2}
        secondary={
          <>
            <Link to="/sessions?range=all" className="btn">
              {t('overview.empty.showAll')}
            </Link>
            <Link to="/settings?section=health" className="btn btn-quiet">
              {t('overview.empty.health')}
            </Link>
          </>
        }
      >
        <p>{t('overview.empty.body')}</p>
      </EmptyState>
    );
  } else {
    main = (
      <>
        <AttentionStrip overview={overview.data} loadedRows={rows} complete={complete} hrefFor={hrefFor} />
        {sessionsFailed ? (
          <ErrorState
            kind={kindOf(list.error)}
            subjectKey="error.subject.sessions"
            error={list.error}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : (
          <>
            <NeedsAttention sessions={rows} complete={complete} loading={sessionsLoading} />
            <RunningSessions sessions={rows} complete={complete} loading={sessionsLoading} />
          </>
        )}
        {figures}
        {overview.data === undefined ? null : <RecentErrors events={overview.data.recentErrors} />}
        <section className="card overview-section" aria-labelledby="overview-activity-title">
          <header className="overview-section__head">
            <h2 id="overview-activity-title">{t('overview.activity.title')}</h2>
            <Link to="/activity" className="overview-section__action">
              {t('overview.activity.viewAll')}
            </Link>
          </header>
          <div className="overview-section__body">
            <ActivityFeed filter={activityFilter} mode="compact" limit={ACTIVITY_LIMIT} />
          </div>
        </section>
      </>
    );
  }

  return (
    <section className="page overview">
      <header className="overview__header">
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {range === undefined ? null : (
          <p className="muted">
            {range.from === null
              ? t('overview.description.all')
              : t('overview.description.since', { from: format.dateTime(range.from) })}
          </p>
        )}
      </header>
      <div className="overview__layout">
        <div className="overview__main" data-stale-scope aria-busy={list.isPlaceholderData}>
          <StaleDataIndicator
            asOf={overview.dataUpdatedAt === 0 ? null : overview.dataUpdatedAt}
            fetchFailing={refreshFailing}
            scope={t('overview.scope')}
          />
          {main}
        </div>
        <aside className="overview__side" aria-label={t('overview.side.label')}>
          <IngestionSummary alerts={overview.data?.alerts} />
          {/* WP-65 mounts the workspace panels here. */}
          <div className="overview__panels" data-slot="workspace-panels" />
        </aside>
      </div>
    </section>
  );
}

/**
 * `/`: the landing page for many sessions (ADR 0073 decision 9). The attention strip, the sessions that need attention, the
 * sessions running now, the figures of the monitor with their source and rule, the newest errors and events, and the ingestion
 * summary. A part that fails to load says so and leaves the others usable. Until the app providers are mounted it shows only its
 * heading, so the route never crashes the shell.
 */
export function OverviewPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <OverviewUnavailable /> : <Overview />;
}
