// `workItemBoard` and `getWorkItem` (03 6.1): the derived board of tasks and one item with its sessions. The handlers call
// the query layer and nothing else (ADR 0029); the engine's `NotFoundError` becomes `work_item_not_found` (404).
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const workItemRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.workItemBoard, ({ query }) => answering(() => ctx.queries.workItemBoard(ctx.scope, query)));
  registerRoute(app, routes.getWorkItem, ({ params }) =>
    answering(() => ctx.queries.getWorkItem(ctx.scope, params.workItemId)),
  );
};
