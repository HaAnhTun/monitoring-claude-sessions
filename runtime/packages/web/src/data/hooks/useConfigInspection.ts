import { routes, type ConfigInspection } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/** `GET /config`: read at server start, so it never goes stale; a new server epoch invalidates it with the instance. */
export function useConfigInspection(): UseQueryResult<ConfigInspection> {
  const { api, iid } = useDataEnv();
  return useQuery({
    queryKey: qk.config(iid),
    queryFn: ({ signal }) => api.get('config', routes.config.path, routes.config.response, { signal }),
    staleTime: Infinity,
  });
}
