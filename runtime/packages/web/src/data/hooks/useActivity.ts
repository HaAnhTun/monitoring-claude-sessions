import { routes, type EventPage } from '@mcs/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { qk, type ApiQuery } from '../query-keys.ts';
import { listOf, pageQuery, useCursorReset, useDataEnv, type InfiniteList } from './useInstance.ts';

export const ACTIVITY_PAGE_LIMIT = 100;
export const ACTIVITY_MAX_PAGES = 10;
/** The legacy logs cadence, used while the stream is not live. */
export const ACTIVITY_POLL_MS = 3000;

const FIRST_PAGE: string | null = null;

/**
 * `GET /events`: the activity feed, newest first, 100 per page. `q` is the canonical filter query
 * (`toQuery(toEventFilter(...))`). Without a stream the head is refreshed every 3 s while a single page is loaded.
 */
export function useActivity(q: ApiQuery, options: { onCursorReset?: () => void } = {}): InfiniteList<EventPage> {
  const { api, iid, live } = useDataEnv();
  const queryKey = qk.activity(iid, q);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get('activity', routes.listEvents.path, routes.listEvents.response, {
        query: pageQuery(q, pageParam, ACTIVITY_PAGE_LIMIT),
        signal,
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
    maxPages: ACTIVITY_MAX_PAGES,
    staleTime: 30_000,
    refetchInterval: live ? false : (current) => (current.state.data?.pages.length === 1 ? ACTIVITY_POLL_MS : false),
    placeholderData: keepPreviousData,
  });
  useCursorReset(query.error, queryKey, options.onCursorReset);
  return listOf(query, ACTIVITY_MAX_PAGES);
}
