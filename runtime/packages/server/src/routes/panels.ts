// `GET /api/v3/panels/:key` (06 3.4): one panel with the state of each of its sources. `panels.*` of the configuration gates
// the route (404 `panel_disabled`); a source that fails is a status inside the response, never a 5xx; a thrown programming
// error is `internal_error` and goes to the error ring with `where: panel.<key>`. The handler asks the panel service of the
// runtime and shapes nothing: it returns what the samplers produced.
import { PANEL_CONFIG_KEY, panelQueryAllowed, routes } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

/** The `limit` of the attempts panel when the request names none (06 3.4). */
const ATTEMPTS_DEFAULT_LIMIT = 30;

/** The engine's `PanelServiceClosedError`, recognised by its name so that source and build copies of the class both map. */
function isClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'PanelServiceClosedError' || error.constructor.name === 'PanelServiceClosedError')
  );
}

export const panelRoutes: RouteModule = (app, { ctx, runtime }) => {
  registerRoute(app, routes.panel, async ({ params, query }) => {
    const { key } = params;
    // an app without a runtime has no panel service: a failure of this request, not of the mounting
    if (runtime === undefined) throw new ApiError('internal_error');
    if (!panelQueryAllowed(key, query)) {
      throw new ApiError('validation_failed', { details: [{ path: 'limit', issue: 'unrecognized_keys' }] });
    }
    if (ctx.config.monitor.panels[PANEL_CONFIG_KEY[key]] !== true) throw new ApiError('panel_disabled');
    try {
      return await runtime.panels.get(key, key === 'attempts' ? { limit: query.limit ?? ATTEMPTS_DEFAULT_LIMIT } : {});
    } catch (error: unknown) {
      if (isClosed(error)) throw new ApiError('shutting_down', { cause: error });
      ctx.errors.push({
        source: 'panels',
        code: 'INTERNAL',
        where: `panel.${key}`,
        message: error instanceof Error ? error.message : 'the panel failed',
      });
      throw error;
    }
  });
};
