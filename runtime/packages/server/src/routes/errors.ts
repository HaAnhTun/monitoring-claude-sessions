// `errors` (03 6.1, 6.3): the stored ingest errors of the query layer plus the entries of the server error ring (source
// `server`, code `INTERNAL`), newest first. The ring belongs to this process, so the route adds it (`mergeServerErrors`);
// the offline reader of the CLI has only the stored rows.
import { mergeServerErrors } from '@mcs/engine';
import { routes } from '@mcs/shared';

import { registerRoute, type RouteModule } from '../route-adapter.ts';
import { answering } from './sessions.ts';

export const errorRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.errors, ({ query }) =>
    answering(() => {
      const stored = ctx.queries.errors(ctx.scope, query);
      return { asOfSeq: stored.asOfSeq, items: mergeServerErrors(ctx.errors.list(), stored.items, query) };
    }),
  );
};
