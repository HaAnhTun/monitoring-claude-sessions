import { routes, type ToolFrequencyReport, type UsageReport, type UsageSeries } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { ApiClient } from '../api-client.ts';
import { qk, type ApiQuery } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

export interface AnalyticsData {
  usage: UsageReport;
  series: UsageSeries;
  tools: ToolFrequencyReport;
}

export type AnalyticsKind = keyof AnalyticsData;

function fetchAnalytics<K extends AnalyticsKind>(
  api: ApiClient,
  kind: K,
  query: ApiQuery,
  signal: AbortSignal,
): Promise<AnalyticsData[K]>;
function fetchAnalytics(api: ApiClient, kind: AnalyticsKind, query: ApiQuery, signal: AbortSignal): Promise<unknown> {
  switch (kind) {
    case 'usage':
      return api.get('analyticsUsage', routes.analyticsUsage.path, routes.analyticsUsage.response, { query, signal });
    case 'series':
      return api.get('analyticsSeries', routes.analyticsSeries.path, routes.analyticsSeries.response, {
        query,
        signal,
      });
    case 'tools':
      return api.get('analyticsTools', routes.analyticsTools.path, routes.analyticsTools.response, { query, signal });
  }
}

/**
 * `GET /analytics/usage|series|tools`. `q` is the canonical query (`toQuery` of the filter in `data/endpoints.ts`). Analytics
 * are never polled; a stream `usage` change invalidates them after 10 s.
 */
export function useAnalytics<K extends AnalyticsKind>(kind: K, q: ApiQuery): UseQueryResult<AnalyticsData[K]> {
  const { api, iid } = useDataEnv();
  return useQuery({
    queryKey: qk.analytics(iid, kind, q),
    queryFn: ({ signal }) => fetchAnalytics(api, kind, q, signal),
    staleTime: 60_000,
  });
}
