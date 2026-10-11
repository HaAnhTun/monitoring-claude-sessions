import { routes, type HealthReport } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/**
 * `GET /health`: always fresh and always polled at `poll.healthMs`, with or without a stream (health is not proven by the
 * stream). Drives the ingestion chip.
 */
export function useHealth(): UseQueryResult<HealthReport> {
  const { api, iid, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.health(iid),
    queryFn: ({ signal }) => api.get('health', routes.health.path, routes.health.response, { signal }),
    staleTime: 0,
    refetchInterval: poll.healthMs,
  });
}
