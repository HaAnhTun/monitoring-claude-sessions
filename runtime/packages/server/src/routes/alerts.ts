// `listAlerts` and `alertRules` (03 6.1, 10.3): the stored alerts and the configured rules, read only. The handlers call the
// query layer and nothing else (ADR 0029).
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const alertRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.listAlerts, ({ query }) => answering(() => ctx.queries.listAlerts(ctx.scope, query)));
  registerRoute(app, routes.alertRules, () => ctx.queries.alertRules(ctx.scope));
};
