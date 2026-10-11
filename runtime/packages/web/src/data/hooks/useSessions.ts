import { routes, type Page, type SessionSummary } from '@mcs/shared';
import { keepPreviousData, useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk, type ApiQuery } from '../query-keys.ts';
import { listOf, pageQuery, useCursorReset, useDataEnv, type InfiniteList } from './useInstance.ts';

/** Rows per page of the explorer and the most pages kept (1000 rows, ADR 0038). */
export const SESSIONS_PAGE_LIMIT = 100;
export const SESSIONS_MAX_PAGES = 10;
/** Rows of the sidebar list: `instance.limits.pageMax`. */
export const SIDEBAR_LIMIT = 200;

const FIRST_PAGE: string | null = null;

export interface UseSessionsOptions {
  /** Called once when the server rejected the cursor and the list restarted at its first page ("The list changed"). */
  onCursorReset?: () => void;
}

/**
 * `GET /sessions` as a cursor-paged infinite list (04 5.3). `q` is the canonical filter query (`toQuery(toSessionFilter(...))`).
 * A filter change is a new key: the old request is aborted and the old rows stay visible, marked as placeholder data, until
 * the new first page arrives. While the stream is not live every loaded page is refetched at `poll.sessionsMs`.
 */
export function useSessions(q: ApiQuery, options: UseSessionsOptions = {}): InfiniteList<Page<SessionSummary>> {
  const { api, iid, live, poll } = useDataEnv();
  const queryKey = qk.sessions(iid, q);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get('sessions', routes.listSessions.path, routes.listSessions.response, {
        query: pageQuery(q, pageParam, SESSIONS_PAGE_LIMIT),
        signal,
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
    maxPages: SESSIONS_MAX_PAGES,
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
    placeholderData: keepPreviousData,
  });
  useCursorReset(query.error, queryKey, options.onCursorReset);
  return listOf(query, SESSIONS_MAX_PAGES);
}

/**
 * The sidebar list: not infinite, the current window (`window=1`) or, with `showAll`, every session, newest 200 rows.
 */
export function useSidebarSessions(showAll: boolean): UseQueryResult<Page<SessionSummary>> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.sidebarSessions(iid, showAll),
    queryFn: ({ signal }) =>
      api.get('sessions', routes.listSessions.path, routes.listSessions.response, {
        query: { limit: String(SIDEBAR_LIMIT), ...(showAll ? {} : { window: '1' }) },
        signal,
      }),
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}
