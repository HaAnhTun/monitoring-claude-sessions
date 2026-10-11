import { toQuery, EVENT_CATEGORIES, type EventCategory } from '@mcs/shared';
import { useCallback, useMemo, useState } from 'react';

import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TIMELINE_PAGE_LIMIT, useTimeline } from '../../data/hooks/useTimeline.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { TimelineRow, useShowInTranscript } from './TimelineRow.tsx';

export interface SessionTimelineProps {
  sessionId: string;
  /** `null`: the events of every agent of the session. */
  agentId: string | null;
  types: EventCategory[];
  /** Absent: the category filter is not offered. */
  onTypesChange?: ((types: EventCategory[]) => void) | undefined;
  /** `session.sources.hooks`; without hooks an empty timeline is expected and says so. */
  hooksEnabled?: boolean;
}

const SKELETON_ROWS = 6;

/** The events the monitor recorded for a session (hooks, transcript entries and its own rows), newest first. */
export function SessionTimeline({
  sessionId,
  agentId,
  types,
  onTypesChange,
  hooksEnabled = true,
}: SessionTimelineProps) {
  const query = useMemo(
    () =>
      toQuery({ ...(types.length === 0 ? {} : { category: types }), ...(agentId === null ? {} : { agent: agentId }) }),
    [types, agentId],
  );
  const showToast = useShowToast();
  const list = useTimeline(sessionId, query, {
    onCursorReset: () => {
      showToast('The list changed; reloaded from the top');
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

  const result = list.query;
  let body;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind="load"
        subject="events"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="list" rows={SKELETON_ROWS} label="Loading events" />
    );
  } else if (list.items.length === 0) {
    body = (
      <EmptyState title="No events" icon="activity">
        <p>
          {types.length > 0
            ? 'No monitor events match the chosen categories.'
            : hooksEnabled
              ? 'No monitor events recorded for this session yet.'
              : 'No monitor events for this session. Hooks may be off; the Transcript tab shows the conversation.'}
        </p>
      </EmptyState>
    );
  } else {
    const lastPage = result.data.pages.at(-1);
    body = (
      <>
        <ul className="timeline-list">
          {list.items.map((event) => (
            <TimelineRow
              key={event.id}
              event={event}
              open={openRows.has(event.id)}
              onToggle={toggleRow}
              onShowInTranscript={showInTranscript}
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
          noun="events"
          capped={list.capped}
          pageSize={TIMELINE_PAGE_LIMIT}
        />
      </>
    );
  }

  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;
  return (
    <section className="timeline" aria-label="Timeline">
      <p className="muted">
        Events recorded by the monitor (hooks and lifecycle). For the conversation itself see Transcript.
      </p>
      {onTypesChange === undefined ? null : (
        <fieldset className="timeline__filter">
          <legend>Event categories</legend>
          {EVENT_CATEGORIES.map((category) => (
            <label key={category} className="timeline__category">
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
              <span>{category}</span>
            </label>
          ))}
        </fieldset>
      )}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subject="events"
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
