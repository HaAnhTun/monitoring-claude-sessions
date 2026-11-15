// The one place that calls `fetch` (04-ui.md 5.1, ESLint rule `no-restricted-globals`). Port of the legacy `createApi.get`:
// timeout, readable errors and per-endpoint tracking, extended with response validation against the shared route schemas, and
// `post` for the writes of the terminal area (ADR 0099). Retries belong to TanStack Query, not to the client; a write is never
// retried by anyone.
import { ErrorEnvelopeSchema, queryString, toQuery } from '@mcs/shared';

import { ApiError, describeFailure, type ApiErrorKind } from './api-errors.ts';
import { createEndpointTracker, type EndpointTracker } from './endpoint-tracker.ts';
import type { EndpointName } from './endpoints.ts';

export type { EndpointRecord, EndpointTracker } from './endpoint-tracker.ts';

/**
 * Structural schema type: the response schemas of the shared route registry satisfy it, so `@mcs/web` never imports `zod`
 * itself (05 rule).
 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[] }[] } };
}

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export interface GetOptions {
  query?: Readonly<Record<string, QueryValue>>;
  signal?: AbortSignal;
  /** Overrides the client default for this call. */
  timeoutMs?: number;
}

export interface PostOptions {
  signal?: AbortSignal;
  /** Overrides the client default for this call (a folder dialog waits for a person: 600 s). */
  timeoutMs?: number;
}

export interface ApiClient {
  /** `path` is the registry path with its parameters filled in (`buildPath`); the client adds the base URL and the query. */
  get<T>(name: EndpointName, path: string, schema: ResponseSchema<T>, opts?: GetOptions): Promise<T>;
  /**
   * POSTs a JSON body (`Content-Type: application/json` and `X-MCS-Request: 1`, ADR 0045 and 0099) and validates the answer
   * like `get`. Never retried. A body over 4096 UTF-8 bytes, or one with no JSON form, is a programming error: it throws a
   * `TypeError` before any request (the server refuses over 4 KiB). Failures are `ApiError`s whose `info.method` is `'POST'`.
   */
  post<T>(name: EndpointName, path: string, body: unknown, schema: ResponseSchema<T>, opts?: PostOptions): Promise<T>;
  readonly tracker: EndpointTracker;
}

export interface ApiClientOptions {
  /** Prepended to every path; `''` (same origin) by default. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Default 8000. */
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const RETRY_AFTER_CAP_MS = 30_000;
/** The body limit of the server for a write (ADR 0084: 4 KiB). */
const MAX_BODY_BYTES = 4096;

interface RequestSpec {
  method: 'GET' | 'POST';
  name: EndpointName;
  /** The URL path with the query already appended. */
  target: string;
  /** The serialized JSON body of a POST. */
  body?: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

/** `JSON.stringify` as it really behaves: `undefined` for a value with no JSON form (its declared type says `string`). */
function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** The JSON text of a write body, or a `TypeError` that never repeats the body (it can hold a folder path or a code). */
function serializeBody(body: unknown): string {
  const text = jsonText(body);
  if (text === undefined) throw new TypeError('A request body must have a JSON form');
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new TypeError(`A request body is at most ${String(MAX_BODY_BYTES)} bytes`);
  }
  return text;
}

/** `null`, `undefined`, `''`, `false` and empty lists are left out; `true` is `1`; lists are comma-joined; keys are sorted. */
function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const present: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === '') continue;
    present[key] = value;
  }
  return queryString(toQuery(present));
}

function contractPaths(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  return issues.slice(0, 10).map((issue) => issue.path.map((part) => String(part)).join('.'));
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(RETRY_AFTER_CAP_MS, Math.round(seconds * 1000));
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createApiClient(o: ApiClientOptions = {}): ApiClient {
  const baseUrl = o.baseUrl ?? '';
  const defaultTimeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = o.now ?? (() => Date.now());
  const doFetch: typeof fetch = o.fetchImpl ?? ((input, init) => fetch(input, init));
  const tracker = createEndpointTracker();

  async function request<T>(spec: RequestSpec, schema: ResponseSchema<T>): Promise<T> {
    const { name, method, timeoutMs } = spec;
    const url = `${baseUrl}${spec.target}`;

    function fail(
      kind: ApiErrorKind,
      status: number,
      serverMessage: string,
      extra: Partial<ApiError['info']> = {},
    ): ApiError {
      const message = describeFailure(kind, status, serverMessage, timeoutMs);
      return new ApiError(kind === 'contract' ? `${message} (${name})` : message, {
        kind,
        status,
        code: null,
        endpoint: name,
        requestId: null,
        ...(method === 'POST' ? { method } : {}),
        ...(serverMessage === '' ? {} : { serverMessage }),
        ...extra,
      });
    }

    const callerAborted = (): boolean => spec.signal?.aborted === true;
    if (callerAborted()) throw fail('aborted', 0, '');

    tracker.begin(name);
    // One controller for both the caller's signal and the timeout (the caller's abort and the timer end the same fetch).
    const ctrl = new AbortController();
    const timeout = { fired: false };
    const onCallerAbort = (): void => {
      ctrl.abort();
    };
    spec.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timeout.fired = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      let response: Response;
      let text: string;
      try {
        response = await doFetch(url, {
          signal: ctrl.signal,
          ...(method === 'POST'
            ? {
                method,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-MCS-Request': '1' },
                body: spec.body ?? '',
              }
            : { headers: { Accept: 'application/json' } }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
        text = await response.text();
      } catch {
        if (callerAborted()) throw fail('aborted', 0, '');
        throw timeout.fired ? fail('timeout', 0, '', { timeoutMs }) : fail('network', 0, '');
      }

      const body = parseJson(text);
      if (!response.ok) {
        const envelope = body.ok ? ErrorEnvelopeSchema.safeParse(body.value) : null;
        const parsed = envelope?.success === true ? envelope.data.error : null;
        const retry = retryAfterMs(response);
        const requestId = parsed?.requestId ?? response.headers.get('X-Request-Id');
        throw fail('http', response.status, parsed?.message ?? '', {
          code: parsed?.code ?? null,
          requestId,
          ...(retry === undefined ? {} : { retryAfterMs: retry }),
        });
      }
      if (!body.ok) throw fail('parse', response.status, '');

      const checked = schema.safeParse(body.value);
      if (!checked.success) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console -- dev-only contract diagnostics (04-ui.md 5.1 step 6): issue paths, never values
          console.warn(`API contract failure at ${name}: issue paths`, contractPaths(checked.error.issues));
        }
        throw fail('contract', response.status, '');
      }
      tracker.settle(name, { ok: true, at: now() });
      return checked.data;
    } catch (error) {
      const err = error instanceof ApiError ? error : fail('network', 0, error instanceof Error ? error.message : '');
      if (err.info.kind === 'aborted') {
        tracker.settle(name, { ok: 'aborted' });
      } else {
        tracker.settle(name, {
          ok: false,
          at: now(),
          error: { message: err.message, status: err.info.status, kind: err.info.kind },
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  function get<T>(name: EndpointName, path: string, schema: ResponseSchema<T>, opts: GetOptions = {}): Promise<T> {
    const query = buildQuery(opts.query);
    return request(
      {
        method: 'GET',
        name,
        target: `${path}${query === '' ? '' : `?${query}`}`,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? defaultTimeout,
      },
      schema,
    );
  }

  async function post<T>(
    name: EndpointName,
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
    opts: PostOptions = {},
  ): Promise<T> {
    // A programming error, not a failure of the request: it rejects before anything is tracked or sent.
    const text = serializeBody(body);
    return request(
      {
        method: 'POST',
        name,
        target: path,
        body: text,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? defaultTimeout,
      },
      schema,
    );
  }

  return { get, post, tracker };
}
