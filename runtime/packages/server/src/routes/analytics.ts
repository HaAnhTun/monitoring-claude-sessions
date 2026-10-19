// The analytics routes (03 6.1, 8): `analyticsUsage`, `analyticsSeries` and `analyticsTools`. A handler calls the query layer
// and nothing else (ADR 0029); `range_invalid` and `range_too_large` come from the engine as refusals.
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const analyticsRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.analyticsUsage, ({ query }) => answering(() => ctx.queries.usage(ctx.scope, query)));
  registerRoute(app, routes.analyticsSeries, ({ query }) => answering(() => ctx.queries.series(ctx.scope, query)));
  registerRoute(app, routes.analyticsTools, ({ query }) => answering(() => ctx.queries.tools(ctx.scope, query)));
};
