// `listEvents` and `getEvent` (03 6.1): the activity events of the instance. The handlers call the query layer and nothing
// else (ADR 0029); `scanCapped` and `filter_requires_scope` come from the engine (03 3.7 rule 2).
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const eventRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.listEvents, ({ query }) => answering(() => ctx.queries.listEvents(ctx.scope, query)));
  registerRoute(app, routes.getEvent, ({ params }) => answering(() => ctx.queries.getEvent(ctx.scope, params.eventId)));
};
