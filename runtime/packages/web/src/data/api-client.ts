// The one place that calls `fetch` (04-ui.md 5.1, ESLint rule `no-restricted-globals`). Port of the legacy `createApi.get`:
// timeout, readable errors and per-endpoint tracking, extended with response validation against the shared route schemas.
// Retries belong to TanStack Query, not to the client.
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

export interface ApiClient {
  /** `path` is the registry path with its parameters filled in (`buildPath`); the client adds the base URL and the query. */
  get<T>(name: EndpointName, path: string, schema: ResponseSchema<T>, opts?: GetOptions): Promise<T>;
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

  async function get<T>(
    name: EndpointName,
    path: string,
    schema: ResponseSchema<T>,
    opts: GetOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const query = buildQuery(opts.query);
    const url = `${baseUrl}${path}${query === '' ? '' : `?${query}`}`;

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
        ...(serverMessage === '' ? {} : { serverMessage }),
        ...extra,
      });
    }

    const callerAborted = (): boolean => opts.signal?.aborted === true;
    if (callerAborted()) throw fail('aborted', 0, '');

    tracker.begin(name);
    // One controller for both the caller's signal and the timeout (the caller's abort and the timer end the same fetch).
    const ctrl = new AbortController();
    const timeout = { fired: false };
    const onCallerAbort = (): void => {
      ctrl.abort();
    };
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
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
          headers: { Accept: 'application/json' },
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
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return { get, tracker };
}
