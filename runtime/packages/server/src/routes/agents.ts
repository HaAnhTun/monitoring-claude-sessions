// `listAgents` (03 6.1): agents across sessions. The handler calls the query layer and nothing else (ADR 0029).
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const agentRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.listAgents, ({ query }) => answering(() => ctx.queries.listAgents(ctx.scope, query)));
};
