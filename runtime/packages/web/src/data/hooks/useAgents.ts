import { routes, type AgentNode, type Page } from '@mcs/shared';
import { useInfiniteQuery } from '@tanstack/react-query';

import { pathFor } from '../endpoints.ts';
import { qk } from '../query-keys.ts';
import { listOf, pageQuery, useDataEnv, type InfiniteList } from './useInstance.ts';

/** The route maximum; "Show all" loads the next page. */
export const AGENTS_PAGE_LIMIT = 500;
export const AGENTS_MAX_PAGES = 10;

const FIRST_PAGE: string | null = null;

/** `GET /sessions/:id/agents`: the agents of one session in depth order, refetched at `poll.sessionsMs` without a stream. */
export function useAgents(sessionId: string): InfiniteList<Page<AgentNode>> {
  const { api, iid, live, poll } = useDataEnv();
  const query = useInfiniteQuery({
    queryKey: qk.agents(iid, sessionId),
    queryFn: ({ pageParam, signal }) =>
      api.get('agents', pathFor('agents', routes.sessionAgents, { sessionId }), routes.sessionAgents.response, {
        query: pageQuery({}, pageParam, AGENTS_PAGE_LIMIT),
        signal,
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
    maxPages: AGENTS_MAX_PAGES,
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
  return listOf(query, AGENTS_MAX_PAGES);
}
