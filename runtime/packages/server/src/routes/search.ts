// The transcript content search routes (03 6.1, 7.4): `searchTranscript` (one session) and `searchTranscripts` (the instance).
// The handlers hand the parsed query to the query layer and nothing else (ADR 0029). A search reads private text for the length
// of the request: the query and the matches live in the response only. Nothing here logs them, and no error carries them: the
// refusals below are mapped from codes, never from the message of the engine.
import type { TranscriptErrorCode } from '@mcs/engine';
import { bindHealthGauges } from '@mcs/engine';
import { routes, type ErrorCode } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

const TRANSCRIPT_CODES: readonly TranscriptErrorCode[] = [
  'session_not_found',
  'agent_not_found',
  'transcript_gone',
  'event_not_found',
  'aborted',
];

const REFUSAL_CODES: readonly ErrorCode[] = [
  'cursor_invalid',
  'range_invalid',
  'range_too_large',
  'filter_requires_scope',
];

/** The catalogue code behind a refusal of the engine; they are recognised by name (the source and the build copy of a class both map). */
function codeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'SearchBusyError') return 'search_busy';
  const code: unknown = Reflect.get(error, 'code');
  if (error.name === 'TranscriptError') {
    const known = TRANSCRIPT_CODES.find((candidate) => candidate === code);
    // a cancelled search has no reader any more; it is not a server fault, but the route has no better code for it
    return known === undefined ? undefined : known === 'aborted' ? 'internal_error' : known;
  }
  if (error.name === 'QueryRefusal') return REFUSAL_CODES.find((candidate) => candidate === code);
  return undefined;
}

/** Runs a search and maps its refusals; an unexpected failure passes on to the error mapper. */
async function answering<T>(search: Promise<T>): Promise<T> {
  try {
    return await search;
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === undefined) throw error;
    throw new ApiError(code, { cause: error });
  }
}

/** Contexts whose search gauge is bound: a second app on the same context binds nothing and does not throw. */
const bound = new WeakSet<object>();

export const searchRoutes: RouteModule = (app, { ctx }) => {
  // the health report counts the searches (03 7.5); the counters live in the query layer of the instance
  if (!bound.has(ctx)) {
    bound.add(ctx);
    bindHealthGauges(ctx, { search: () => ctx.queries.searchStats() });
  }
  registerRoute(app, routes.searchTranscript, ({ query, signal }) =>
    answering(ctx.queries.searchSession(ctx.scope, query, signal)),
  );
  registerRoute(app, routes.searchTranscripts, ({ query, signal }) =>
    answering(ctx.queries.searchInstance(ctx.scope, query, signal)),
  );
};
