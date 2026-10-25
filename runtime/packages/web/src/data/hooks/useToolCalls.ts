import { routes, type Page, type ToolCallItem } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { pathFor } from '../endpoints.ts';
import { qk, type ApiQuery } from '../query-keys.ts';
import { pageQuery, useDataEnv } from './useInstance.ts';

/** The route maximum. One page is all the Errors tab asks for: a session with more failed calls shows the rest without a tool. */
export const TOOL_CALLS_LIMIT = 200;

/**
 * `GET /sessions/:id/tool-calls`: the first page of the tool calls of one session that match `q` (a filter such as
 * `{ status: 'failed' }`). A failure is never an error of the page that asks: its caller draws what it has without the calls.
 */
export function useToolCalls(sessionId: string, q: ApiQuery): UseQueryResult<Page<ToolCallItem>> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.toolCalls(iid, sessionId, q),
    queryFn: ({ signal }) =>
      api.get(
        'toolCalls',
        pathFor('toolCalls', routes.sessionToolCalls, { sessionId }),
        routes.sessionToolCalls.response,
        { query: pageQuery(q, null, TOOL_CALLS_LIMIT), signal },
      ),
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}
