import { toQuery } from '@mcs/shared';
import { useCallback, useMemo, useState } from 'react';

import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TIMELINE_PAGE_LIMIT, useTimeline } from '../../data/hooks/useTimeline.ts';
import { TimelineRow, useShowInTranscript } from './TimelineRow.tsx';

export interface SessionErrorsProps {
  sessionId: string;
  /** `null` or omitted: every agent of the session. */
  agentId?: string | null;
}

const SKELETON_ROWS = 4;

/** The warnings and errors the monitor recorded for the session, each with a link to its place in the transcript. */
export function SessionErrors({ sessionId, agentId = null }: SessionErrorsProps) {
  const query = useMemo(
    () => toQuery({ severity: ['warning', 'error'], ...(agentId === null ? {} : { agent: agentId }) }),
    [agentId],
  );
  const list = useTimeline(sessionId, query);
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
        subject="errors"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="list" rows={SKELETON_ROWS} label="Loading errors" />
    );
  } else if (list.items.length === 0) {
    body = <EmptyState title="No errors or warnings recorded for this session." icon="completed" />;
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
    <section className="timeline" aria-label="Errors and warnings">
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subject="errors"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      {body}
    </section>
  );
}
