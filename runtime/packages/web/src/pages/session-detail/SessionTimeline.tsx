import { toQuery, EVENT_CATEGORIES, type EventCategory } from '@mcs/shared';
import { useCallback, useMemo, useState } from 'react';

import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TIMELINE_PAGE_LIMIT, useTimeline } from '../../data/hooks/useTimeline.ts';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { TimelineRow, useShowInTranscript } from './TimelineRow.tsx';

export interface SessionTimelineProps {
  sessionId: string;
  /** `null`: the events of every agent of the session. */
  agentId: string | null;
  types: EventCategory[];
  /** Absent: the category filter is not offered. */
  onTypesChange?: ((types: EventCategory[]) => void) | undefined;
  /** `session.sources.hooks`; without hooks an empty list is expected and says so. */
  hooksEnabled?: boolean;
}

const SKELETON_ROWS = 8;

const CATEGORY_KEYS = {
  lifecycle: 'activity.category.lifecycle',
  prompt: 'activity.category.prompt',
  tool: 'activity.category.tool',
  agent: 'activity.category.agent',
  notification: 'activity.category.notification',
  compaction: 'activity.category.compaction',
  error: 'activity.category.error',
  ingest: 'activity.category.ingest',
} as const satisfies Readonly<Record<EventCategory, MessageKey>>;

/**
 * The events the monitor recorded for a session (hooks, transcript entries and its own rows), newest first, one line each
 * (review R-18). No category chosen means every category. The source of an event is drawn only when the events differ in it.
 */
export function SessionTimeline({
  sessionId,
  agentId,
  types,
  onTypesChange,
  hooksEnabled = true,
}: SessionTimelineProps) {
  const t = useT();
  const query = useMemo(
    () =>
      toQuery({ ...(types.length === 0 ? {} : { category: types }), ...(agentId === null ? {} : { agent: agentId }) }),
    [types, agentId],
  );
  const showToast = useShowToast();
  const list = useTimeline(sessionId, query, {
    onCursorReset: () => {
      showToast(t('error.handling.listChanged'));
    },
  });
  const showInTranscript = useShowInTranscript();
  const [openRows, setOpenRows] = useState<ReadonlySet<number>>(new Set());
  const toggleRow = useCallback((eventId: number, open: boolean) => {
    setOpenRows((previous) => {
      const next = new Set(previous);
      if (open) next.add(eventId);
      else next.delete(eventId);
      return next;
    });
  }, []);
  const showSources = useMemo(
    () =>
      new Set(list.items.filter((event) => event.type !== 'monitor.gap').map((event) => event.sources.join('+'))).size >
      1,
    [list.items],
  );

  const result = list.query;
  let body;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind="load"
        subjectKey="error.subject.events"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="list" rows={SKELETON_ROWS} label={t('tabs.events.loading')} />
    );
  } else if (list.items.length === 0) {
    let reason = t('tabs.events.empty.noHooks');
    if (types.length > 0) reason = t('tabs.events.empty.filtered');
    else if (hooksEnabled) reason = t('tabs.events.empty.none');
    body = (
      <EmptyState title={t('tabs.events.empty')} icon="activity">
        <p>{reason}</p>
      </EmptyState>
    );
  } else {
    const lastPage = result.data.pages.at(-1);
    body = (
      <>
        <ul className={showSources ? 'event-list event-list--sources' : 'event-list'}>
          {list.items.map((event) => (
            <TimelineRow
              key={event.id}
              event={event}
              open={openRows.has(event.id)}
              onToggle={toggleRow}
              onShowInTranscript={showInTranscript}
              showSources={showSources}
            />
          ))}
        </ul>
        <LoadMore
          hasMore={result.hasNextPage}
          loading={result.isFetchingNextPage}
          onLoad={() => {
            void result.fetchNextPage();
          }}
          shown={list.items.length}
          total={lastPage?.total ?? null}
          totalIsLowerBound={lastPage?.totalIsLowerBound ?? false}
          nounKey="common.noun.events"
          capped={list.capped}
          pageSize={TIMELINE_PAGE_LIMIT}
        />
      </>
    );
  }

  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;
  return (
    <section className="events" aria-label={t('tabs.events.region')}>
      <p className="muted events__intro">{t('tabs.events.intro')}</p>
      {onTypesChange === undefined ? null : (
        <fieldset className="events__filter">
          <legend>{t('tabs.events.categories')}</legend>
          {EVENT_CATEGORIES.map((category) => (
            <label key={category} className="events__category">
              <input
                type="checkbox"
                checked={types.includes(category)}
                onChange={(change) => {
                  const chosen = new Set(types);
                  if (change.target.checked) chosen.add(category);
                  else chosen.delete(category);
                  onTypesChange(EVENT_CATEGORIES.filter((candidate) => chosen.has(candidate)));
                }}
              />
              <span>{t(CATEGORY_KEYS[category])}</span>
            </label>
          ))}
        </fieldset>
      )}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.events"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      <div aria-busy={result.isPlaceholderData}>{body}</div>
    </section>
  );
}
