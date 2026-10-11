// The ingest routes (03 6.1, 02 2.8, I-37): the data-free hook nudge and the probe lookup. The nudge guard (WP-08) answers
// every refusal before the handler runs; the handler only schedules a drain, because the spool is the one input channel
// (D8) and the nudge carries no event data.
import { routes } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { nudgeGuard } from '../http/guards.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

export const ingestRoutes: RouteModule = (app, { ctx, nudge }) => {
  // 204 at once: never wait for the drain. A failure to schedule it is the server's own business: the 500 ms spool poll
  // reads the same segment anyway, so the hook handler still gets its 204 and the failure is recorded.
  registerRoute(
    app,
    routes.ingestNudge,
    () => {
      try {
        nudge();
      } catch {
        ctx.errors.push({
          source: 'server',
          code: 'INTERNAL',
          where: routes.ingestNudge.id,
          message: 'the drain could not be scheduled',
        });
        ctx.logger.warn('nudge_failed', { route: routes.ingestNudge.id, code: 'INTERNAL' });
      }
    },
    { before: [nudgeGuard({ instanceId: ctx.instanceId })] },
  );

  // `404 probe_not_found` means "not committed yet": `hooks verify` V7 keeps polling (03 6.3)
  registerRoute(app, routes.ingestProbe, ({ params }) => {
    const probe = ctx.queries.hookProbe(ctx.scope, params.probeSessionId);
    if (probe === null) throw new ApiError('probe_not_found');
    return probe;
  });
};
