import { routes, type WorkItemBoard } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/** `GET /work-items`: the whole board (cap 500); the page filters by state and text on the client (04 3.2). */
export function useWorkItems(): UseQueryResult<WorkItemBoard> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.workItems(iid),
    queryFn: ({ signal }) => api.get('workItems', routes.workItemBoard.path, routes.workItemBoard.response, { signal }),
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}
