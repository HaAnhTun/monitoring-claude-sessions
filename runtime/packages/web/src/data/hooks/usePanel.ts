import { buildPath, routes, type InstanceInfo, type PanelKey, type PanelResponse } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { ApiError } from '../api-errors.ts';
import { panelEndpoint } from '../endpoints.ts';
import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/**
 * The polling interval of a panel (04 5.2, registry C26): machine, logs and attempts have their own `poll` key; git, ledger
 * and chain log share `poll.overviewMs` because no per-panel key exists (N-09).
 */
export function panelPollMs(key: PanelKey, poll: InstanceInfo['poll']): number {
  switch (key) {
    case 'machine':
      return poll.machineMs;
    case 'logs':
      return poll.logsMs;
    case 'attempts':
      return poll.attemptsMs;
    case 'git':
    case 'ledger':
    case 'chainLog':
      return poll.overviewMs;
  }
}

function isPanelResponse<K extends PanelKey>(response: PanelResponse, key: K): response is PanelResponse<K> {
  return response.key === key;
}

export interface UsePanelOptions {
  /** The body is fetched and polled only while the panel is expanded (and, through TanStack, the page is visible). */
  expanded: boolean;
}

/**
 * `GET /panels/:key` as the `PanelResponse` of that key. Panel data is not pushed by the stream, so polling is the only
 * refresh. A response of another panel is a contract failure. `404 panel_disabled` is not retried: the page removes the panel
 * (`isPanelDisabled`, `lib/panel-status.ts`).
 */
export function usePanel<K extends PanelKey>(key: K, options: UsePanelOptions): UseQueryResult<PanelResponse<K>> {
  const { api, iid, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.panel(iid, key),
    queryFn: async ({ signal }) => {
      const response = await api.get(panelEndpoint(key), buildPath(routes.panel, { key }), routes.panel.response, {
        signal,
      });
      if (!isPanelResponse(response, key)) {
        throw new ApiError(`The monitor sent data this page does not understand (${panelEndpoint(key)})`, {
          kind: 'contract',
          status: 200,
          code: null,
          endpoint: panelEndpoint(key),
          requestId: null,
        });
      }
      return response;
    },
    enabled: options.expanded,
    staleTime: 0,
    refetchInterval: panelPollMs(key, poll),
  });
}
