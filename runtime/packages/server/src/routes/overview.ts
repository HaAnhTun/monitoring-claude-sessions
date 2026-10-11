// `overview` (03 6.1, 8.1): the metric catalogue, the recent activity and errors and the open alerts. The handler calls the
// query layer and nothing else (ADR 0029); `range_invalid` comes from the engine.
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const overviewRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.overview, ({ query }) => answering(() => ctx.queries.overview(ctx.scope, query)));
};
