// The transcript routes (03 6.1, 7.3): `transcriptWindow` and `transcriptLocate`. The handlers hand the parsed path and query to the
// query layer of the instance context and nothing else (ADR 0029); the text of the entries is read from the transcript file for the
// request and never kept (ADR 0016). A refusal of the transcript service becomes the catalogue code of the same name.
import type { TranscriptErrorCode } from '@mcs/engine';
import { routes } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

const TRANSCRIPT_CODES: readonly TranscriptErrorCode[] = [
  'session_not_found',
  'agent_not_found',
  'transcript_gone',
  'event_not_found',
  'aborted',
];

function transcriptCode(error: unknown): TranscriptErrorCode | undefined {
  // recognised by name, like the `NotFoundError` of the engine: the source and the build copy of the class both map
  if (!(error instanceof Error) || error.name !== 'TranscriptError') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return TRANSCRIPT_CODES.find((known) => known === code);
}

/** Runs a read of the transcript service and maps its refusals; an unexpected failure passes on to the error mapper. */
async function answer<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    const code = transcriptCode(error);
    if (code === undefined) throw error;
    // a cancelled request has no reader any more: the answer is never seen, and it is not a server fault
    throw new ApiError(code === 'aborted' ? 'internal_error' : code, { cause: error });
  }
}

export const transcriptRoutes: RouteModule = (app, { ctx }) => {
  registerRoute(app, routes.transcriptWindow, ({ params, query, signal }) =>
    answer(ctx.queries.window(ctx.scope, { ...query, sessionId: params.sessionId }, signal)),
  );
  registerRoute(app, routes.transcriptLocate, ({ params, query, signal }) =>
    answer(ctx.queries.locate(ctx.scope, { ...query, sessionId: params.sessionId }, signal)),
  );
};
