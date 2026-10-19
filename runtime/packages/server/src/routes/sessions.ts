// The session routes (03 6.1): `listSessions`, `getSession`, `sessionAgents`, `sessionTimeline`, `sessionToolCalls` and
// `sessionTransitions`. A handler calls the query layer of the instance context and nothing else (ADR 0029): the engine
// reads inside one synchronous step and answers with `asOfSeq`. `getSession` then awaits `sessionAuditRefs` and attaches
// the references (I-19): an unreadable audit trail gives `[]` and still a 200.
import type { ErrorCode } from '@mcs/shared';
import { routes } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

/** The 400 codes the engine's `QueryRefusal` carries: they are catalogue codes, recognised by the class name (source and build copies). */
function refusalCodeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error) || error.name !== 'QueryRefusal') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  switch (code) {
    case 'cursor_invalid':
    case 'range_invalid':
    case 'range_too_large':
    case 'filter_requires_scope':
      return code;
    default:
      return undefined;
  }
}

/**
 * Runs a query function and turns a refusal of the engine (`cursor_invalid`, `range_invalid`, ...) into the `ApiError`
 * of the same code. A `NotFoundError` passes through: the error mapper knows it. The other route modules import this.
 */
export function answering<T>(run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    const code = refusalCodeOf(error);
    if (code !== undefined) throw new ApiError(code, { cause: error });
    throw error;
  }
}

export const sessionRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.listSessions, ({ query }) => answering(() => ctx.queries.listSessions(ctx.scope, query)));

  registerRoute(app, routes.getSession, async ({ params }) => {
    const detail = answering(() => ctx.queries.getSession(ctx.scope, params.sessionId));
    const auditRefs = await ctx.queries.sessionAuditRefs(detail);
    return { ...detail, auditRefs };
  });

  registerRoute(app, routes.sessionAgents, ({ params, query }) =>
    answering(() => ctx.queries.sessionAgents(ctx.scope, params.sessionId, query)),
  );

  // the timeline and the tool calls of a session are the events and tool-calls queries with the session fixed (03 6.3)
  registerRoute(app, routes.sessionTimeline, ({ params, query }) =>
    answering(() =>
      ctx.queries.listEvents(ctx.scope, { ...query, session: [params.sessionId] }, { pathSession: true }),
    ),
  );

  registerRoute(app, routes.sessionToolCalls, ({ params, query }) =>
    answering(() =>
      ctx.queries.listToolCalls(ctx.scope, { ...query, session: [params.sessionId] }, { pathSession: true }),
    ),
  );

  registerRoute(app, routes.sessionTransitions, ({ params, query }) =>
    answering(() => ctx.queries.sessionTransitions(ctx.scope, params.sessionId, query)),
  );
};

// @wp-begin WP-58
/** `sessionUsage` (03 6.1): the token usage of one session by agent or model; an unknown session is `session_not_found`. */
export const sessionUsageRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.sessionUsage, ({ params, query }) =>
    answering(() => ctx.queries.sessionUsage(ctx.scope, params.sessionId, query)),
  );
};
// @wp-end WP-58
