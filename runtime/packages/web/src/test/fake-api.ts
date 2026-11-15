import { ERROR_HTTP_STATUS, ErrorEnvelopeSchema, routes, type ErrorCode, type RouteId } from '@mcs/shared';

// A `fetch` that serves the routes of the shared registry from test handlers (04-ui.md section 11). Every body a handler
// returns is validated against the response schema of its route, so a fixture cannot drift from the contract: a bad body
// makes the request fail and is recorded in `violations`. Error answers use the shared `ErrorEnvelope`. A write behaves like
// the server (ADR 0099): the route is matched by method as well as path, a POST without `X-MCS-Request: 1` is a
// `csrf_rejected`, and a JSON body that breaks the route's body schema is a `validation_failed` (and a violation).

export interface FakeRequest {
  method: string;
  /** The parsed JSON body of a write (already checked against the route's body schema); `undefined` for a read. */
  body: unknown;
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
  method: string;
  /** The parsed JSON body of a write; `undefined` for a read. */
  body: unknown;
  /** The request headers by lower-case name. */
  headers: Record<string, string>;
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

const METHOD_OF_ROUTE = (id: RouteId): string => routes[id].method;

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

type Matched = { id: RouteId; params: Record<string, string> } | { wrongMethod: true } | null;

function matchRoute(method: string, pathname: string): Matched {
  const actual = segmentsOf(pathname);
  let best: { id: RouteId; params: Record<string, string>; literals: number } | null = null;
  let otherMethod = false;
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
    if (!ok) continue;
    if (METHOD_OF_ROUTE(matcher.id) !== method) {
      otherMethod = true;
      continue;
    }
    if (best === null || literals > best.literals) best = { id: matcher.id, params, literals };
  }
  if (best !== null) return { id: best.id, params: best.params };
  return otherMethod ? { wrongMethod: true } : null;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new Headers(init?.headers).entries()) out[name.toLowerCase()] = value;
  return out;
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

/** What the server does with a write before the handler runs: the header, the JSON and the body schema (ADR 0099). */
function readWrite(
  id: RouteId,
  headers: Record<string, string>,
  rawBody: RequestInit['body'],
  violations: string[],
): { body: unknown; refusal?: Response } {
  if (headers['x-mcs-request'] !== '1')
    return { body: undefined, refusal: errorResponse('csrf_rejected', 'Missing the request header') };
  let body: unknown;
  try {
    body = typeof rawBody === 'string' && rawBody !== '' ? (JSON.parse(rawBody) as unknown) : undefined;
  } catch {
    return { body: undefined, refusal: errorResponse('body_invalid_json', 'The body is not JSON') };
  }
  const bodySchema = routes[id].body;
  if (bodySchema === null) return { body };
  const checked = bodySchema.safeParse(body);
  if (checked.success) return { body };
  const paths = checked.error.issues
    .slice(0, 5)
    .map((issue) => issue.path.map((part) => String(part)).join('.'))
    .join(', ');
  violations.push(`fake api: the request body for ${id} breaks the contract at ${paths}`);
  return { body, refusal: errorResponse('validation_failed', 'The body is not valid') };
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
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const matched = matchRoute(method, parsed.pathname);
      if (matched === null) return errorResponse('route_not_found', 'No such route');
      if ('wrongMethod' in matched) return errorResponse('method_not_allowed', 'No such route for this method');
      const { id, params } = matched;
      const query = new URLSearchParams(parsed.search);
      const headers = headersOf(init);
      const written = method === 'GET' ? null : readWrite(id, headers, init?.body, violations);
      const body = written?.body;
      calls.push({ id, method, body, headers, url, query, params });
      if (written?.refusal !== undefined) return written.refusal;
      const handler = fake.handlers[id];
      if (handler === undefined) return errorResponse('route_not_found', `No fake handler for ${id}`);
      const signal = init?.signal ?? null;
      const result: unknown = await abortable(
        Promise.resolve(handler(query, { method, body, params, signal, url })),
        signal,
      );
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
