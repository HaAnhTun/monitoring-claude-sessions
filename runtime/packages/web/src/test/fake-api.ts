import { ERROR_HTTP_STATUS, ErrorEnvelopeSchema, routes, type ErrorCode, type RouteId } from '@mcs/shared';

// A `fetch` that serves the routes of the shared registry from test handlers (04-ui.md section 11). Every body a handler
// returns is validated against the response schema of its route, so a fixture cannot drift from the contract: a bad body
// makes the request fail and is recorded in `violations`. Error answers use the shared `ErrorEnvelope`.

export interface FakeRequest {
  /** The path parameters of the matched route, decoded. */
  params: Record<string, string>;
  signal: AbortSignal | null;
  url: string;
}

/** Returns the body (validated), a `Response` (sent as is, for failures and malformed bodies) or a promise of either. */
export type FakeHandler = (query: URLSearchParams, request: FakeRequest) => unknown;
export type FakeHandlers = Partial<Record<RouteId, FakeHandler>>;

export interface FakeCall {
  id: RouteId;
  url: string;
  query: URLSearchParams;
  params: Record<string, string>;
}

export interface FakeApi {
  fetchImpl: typeof fetch;
  readonly calls: FakeCall[];
  /** One line per body that broke its route schema; a test asserts it is empty. */
  readonly violations: string[];
  /** Handlers can be replaced between requests. */
  handlers: FakeHandlers;
  callsTo(id: RouteId): FakeCall[];
}

interface Matcher {
  id: RouteId;
  segments: string[];
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}

const MATCHERS: Matcher[] = (Object.keys(routes) as RouteId[]).map((id) => ({
  id,
  segments: segmentsOf(routes[id].path),
}));

function matchRoute(pathname: string): { id: RouteId; params: Record<string, string> } | null {
  const actual = segmentsOf(pathname);
  let best: { id: RouteId; params: Record<string, string>; literals: number } | null = null;
  for (const matcher of MATCHERS) {
    if (matcher.segments.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (const [index, segment] of matcher.segments.entries()) {
      const value = actual[index] ?? '';
      if (segment.startsWith(':')) {
        try {
          params[segment.slice(1)] = decodeURIComponent(value);
        } catch {
          ok = false;
        }
      } else if (segment === value) literals += 1;
      else ok = false;
    }
    if (ok && (best === null || literals > best.literals)) best = { id: matcher.id, params, literals };
  }
  return best === null ? null : { id: best.id, params: best.params };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** An error answer with the shared envelope and the status of the code (03 5.2). */
export function errorResponse(
  code: ErrorCode,
  message = 'FIXTURE error message',
  options: { requestId?: string; retryAfterSeconds?: number } = {},
): Response {
  const body = ErrorEnvelopeSchema.parse({
    error: { code, message, requestId: options.requestId ?? 'r-0123456789ab' },
  });
  return jsonResponse(body, ERROR_HTTP_STATUS[code], {
    ...(options.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(options.retryAfterSeconds) }),
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (signal === null) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createFakeApi(handlers: FakeHandlers = {}): FakeApi {
  const calls: FakeCall[] = [];
  const violations: string[] = [];

  const fake: FakeApi = {
    handlers,
    calls,
    violations,
    callsTo: (id) => calls.filter((call) => call.id === id),
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url, 'http://fake.invalid');
      const matched = matchRoute(parsed.pathname);
      if (matched === null) return errorResponse('route_not_found', 'No such route');
      const { id, params } = matched;
      const query = new URLSearchParams(parsed.search);
      calls.push({ id, url, query, params });
      const handler = fake.handlers[id];
      if (handler === undefined) return errorResponse('route_not_found', `No fake handler for ${id}`);
      const signal = init?.signal ?? null;
      const result: unknown = await abortable(Promise.resolve(handler(query, { params, signal, url })), signal);
      if (result instanceof Response) return result;
      const schema = routes[id].response;
      if (schema !== null) {
        const checked = schema.safeParse(result);
        if (!checked.success) {
          const paths = checked.error.issues
            .slice(0, 5)
            .map((issue) => issue.path.map((part) => String(part)).join('.'))
            .join(', ');
          const message = `fake api: the fixture for ${id} breaks the contract at ${paths}`;
          violations.push(message);
          throw new Error(message);
        }
      }
      return jsonResponse(result, 200);
    },
  };
  return fake;
}
