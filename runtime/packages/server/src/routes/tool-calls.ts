// `listToolCalls` (03 6.1): tool calls across sessions. The handler calls the query layer and nothing else (ADR 0029).
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const toolCallRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.listToolCalls, ({ query }) => answering(() => ctx.queries.listToolCalls(ctx.scope, query)));
};
