// `explainCompletion` (03 6.1, I-08, registry C16): whether an unattended run really finished. The handler turns the one selector
// of the query into a `CompletionTarget`, calls the query layer and nothing else (ADR 0029), and maps the two errors of the
// engine: `target_invalid` is 400 `validation_failed`, `target_not_found` is 404 `completion_target_not_found`. The error carries
// the target (a label may be private); the mapping reads its code only, so nothing of it reaches the envelope or a log.
import type { CompletionTarget } from '@mcs/engine';
import { routes, type CompletionQuery, type ErrorCode } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

/** The selector of the query as a target; the schema guarantees that exactly one is present. */
function targetOf(query: CompletionQuery): CompletionTarget {
  if (query.session !== undefined) return { sessionId: query.session };
  if (query.label !== undefined) return { label: query.label };
  return { attemptPart: query.attemptPart ?? '' };
}

/** The catalogue code behind a `CompletionTargetError`, recognised by its name (the source and the build copy of the class both map). */
function codeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error) || error.name !== 'CompletionTargetError') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  if (code === 'target_invalid') return 'validation_failed';
  if (code === 'target_not_found') return 'completion_target_not_found';
  return undefined;
}

export const completionRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.explainCompletion, ({ query }) => {
    try {
      return ctx.queries.explainCompletion(ctx.scope, targetOf(query));
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code !== undefined) throw new ApiError(code, { cause: error });
      throw error;
    }
  });
};
