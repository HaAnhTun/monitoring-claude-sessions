import { routes, type EventPage } from '@mcs/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { pathFor } from '../endpoints.ts';
import { qk, type ApiQuery } from '../query-keys.ts';
import { listOf, pageQuery, useCursorReset, useDataEnv, type InfiniteList } from './useInstance.ts';

export const TIMELINE_PAGE_LIMIT = 100;
export const TIMELINE_MAX_PAGES = 20;
/** The legacy logs cadence, used while the stream is not live. */
export const TIMELINE_POLL_MS = 3000;

const FIRST_PAGE: string | null = null;

/**
 * `GET /sessions/:id/timeline`: the events of one session, newest first, 100 per page. Without a stream the head is refreshed
 * every 3 s, but only while a single page is loaded: refetching a deep list would refetch every page.
 */
export function useTimeline(
  sessionId: string,
  q: ApiQuery,
  options: { onCursorReset?: () => void } = {},
): InfiniteList<EventPage> {
  const { api, iid, live } = useDataEnv();
  const queryKey = qk.timeline(iid, sessionId, q);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get('timeline', pathFor('timeline', routes.sessionTimeline, { sessionId }), routes.sessionTimeline.response, {
        query: pageQuery(q, pageParam, TIMELINE_PAGE_LIMIT),
        signal,
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
    maxPages: TIMELINE_MAX_PAGES,
    staleTime: 30_000,
    refetchInterval: live ? false : (current) => (current.state.data?.pages.length === 1 ? TIMELINE_POLL_MS : false),
    placeholderData: keepPreviousData,
  });
  useCursorReset(query.error, queryKey, options.onCursorReset);
  return listOf(query, TIMELINE_MAX_PAGES);
}
