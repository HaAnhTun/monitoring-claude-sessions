import { routes, type Overview } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/** `GET /overview`: polled at `poll.overviewMs` while the stream is not live. */
export function useOverview(): UseQueryResult<Overview> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.overview(iid),
    queryFn: ({ signal }) => api.get('overview', routes.overview.path, routes.overview.response, { signal }),
    staleTime: 10_000,
    refetchInterval: live ? false : poll.overviewMs,
  });
}
