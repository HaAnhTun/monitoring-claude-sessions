// The access flow of the user instance (ADR 0099, design 04 4.5): a small store without React that redeems the one-time access
// code of the login link, and the helpers that read the code from the address bar and take it out again. The code is never
// stored: it lives in the URL fragment (which no server sees), in the one request that sends it, and, for the span of that
// request, in a map key. It reaches no snapshot, query key, mutation, log or web storage.
import { ACCESS_CODE_RE, parseLoginFragment } from '@mcs/shared/protocol';

import { ApiError, describeFailure } from './api-errors.ts';

/** Where the flow is. A snapshot never holds the code. */
export type AccessOutcome =
  | { kind: 'idle' }
  | { kind: 'exchanging' }
  | { kind: 'granted' }
  /** The code was accepted, but the next read of the session is still not authenticated: the browser dropped the cookie. */
  | { kind: 'cookie-not-kept' }
  /** `access_code_invalid`: the code was used, expired or never right. */
  | { kind: 'invalid' }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'failed'; error: ApiError };

export interface AccessFlow {
  /**
   * Sends the code once. A second call with the same code while the first is in flight (StrictMode runs an effect twice)
   * gets the same promise: one request per code value at a time. It never rejects; the outcome says what happened.
   */
  submit(code: string): Promise<AccessOutcome>;
  /** The same object until the outcome changes (the contract of `useSyncExternalStore`). */
  snapshot(): AccessOutcome;
  subscribe(listener: () => void): () => void;
}

export interface AccessFlowDeps {
  /** `POST /auth/exchange {code}`; rejects with the `ApiError` of the answer. */
  exchange(code: string): Promise<void>;
  /** A fresh `GET /auth/session`: whether the browser now holds the cookie. */
  readAuthenticated(): Promise<boolean>;
  /** The session is open: the caller refreshes what it could not read before. */
  onGranted(): void;
}

/** How long a rate limit without a `Retry-After` asks to wait: the cap of the API client. */
const RATE_LIMIT_FALLBACK_MS = 30_000;

const IDLE: AccessOutcome = { kind: 'idle' };
const EXCHANGING: AccessOutcome = { kind: 'exchanging' };
const GRANTED: AccessOutcome = { kind: 'granted' };
const COOKIE_NOT_KEPT: AccessOutcome = { kind: 'cookie-not-kept' };
const INVALID: AccessOutcome = { kind: 'invalid' };

/** An error that is not an `ApiError` becomes one without its message, which could hold anything the code touched. */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(describeFailure('network', 0, '', 0), {
    kind: 'network',
    status: 0,
    code: null,
    endpoint: 'authExchange',
    requestId: null,
    method: 'POST',
  });
}

function failureOutcome(error: unknown): AccessOutcome {
  const apiError = asApiError(error);
  const { kind, status, code, retryAfterMs } = apiError.info;
  if (kind === 'http' && status === 401 && code === 'access_code_invalid') return INVALID;
  if (kind === 'http' && status === 429 && code === 'access_rate_limited') {
    return { kind: 'rate-limited', retryAfterMs: retryAfterMs ?? RATE_LIMIT_FALLBACK_MS };
  }
  return { kind: 'failed', error: apiError };
}

export function createAccessFlow(deps: AccessFlowDeps): AccessFlow {
  let current: AccessOutcome = IDLE;
  const listeners = new Set<() => void>();
  // The only place a code is held, and only until its request settles.
  const inFlight = new Map<string, Promise<AccessOutcome>>();

  function set(next: AccessOutcome): void {
    current = next;
    for (const listener of [...listeners]) listener();
  }

  async function run(code: string): Promise<AccessOutcome> {
    set(EXCHANGING);
    let outcome: AccessOutcome;
    try {
      await deps.exchange(code);
      outcome = (await deps.readAuthenticated()) ? GRANTED : COOKIE_NOT_KEPT;
    } catch (error) {
      outcome = failureOutcome(error);
    }
    set(outcome);
    if (outcome.kind === 'granted') deps.onGranted();
    return outcome;
  }

  return {
    submit(code) {
      const running = inFlight.get(code);
      if (running !== undefined) return running;
      const started = run(code).finally(() => {
        inFlight.delete(code);
      });
      inFlight.set(code, started);
      return started;
    },
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---- reading the code ----------------------------------------------------------------------------------------------------

/** The code of `#code=<code>` (the `hash` of a location), or `null`. The one reader: the shared `parseLoginFragment` (conflict X1). */
export function readAccessCode(hash: string): string | null {
  return parseLoginFragment(hash);
}

/**
 * What the paste field accepts: the whole printed link (`http://127.0.0.1:<port>/#code=<code>`) or the bare code, with the
 * whitespace of a paste around it. `null` for anything else, which sends no request.
 */
export function readAccessInput(text: string): string | null {
  const trimmed = text.trim();
  if (ACCESS_CODE_RE.test(trimmed)) return trimmed;
  try {
    return readAccessCode(new URL(trimmed).hash);
  } catch {
    return null;
  }
}

// ---- the address bar -----------------------------------------------------------------------------------------------------

/** The parts of `window` the redemption touches; a test passes plain objects. */
export interface AccessPage {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'state' | 'replaceState'>;
}

const FRAGMENT_KEY = '#code=';

/**
 * Takes the login fragment out of the address bar with `history.replaceState` (no new entry, the state of the history entry is
 * kept for the router), leaving the path and the query. A page without the fragment is left alone. A malformed `#code=...` goes
 * too: a failed attempt must not stay in the address bar, the history or a bookmark.
 */
export function stripAccessFragment(page: AccessPage = window): void {
  if (!page.location.hash.startsWith(FRAGMENT_KEY)) return;
  page.history.replaceState(page.history.state, '', `${page.location.pathname}${page.location.search}`);
}

/**
 * Redeems the code of the address bar once and removes the fragment after the request has settled, whatever the outcome (the
 * code is spent or dead by then). `null` when there is no well-formed code (a malformed one is only removed): no request.
 * Safe to call twice (StrictMode): both calls share one request and the fragment is read again until it is gone.
 */
export async function redeemFragment(flow: AccessFlow, page: AccessPage = window): Promise<AccessOutcome | null> {
  const code = readAccessCode(page.location.hash);
  if (code === null) {
    stripAccessFragment(page);
    return null;
  }
  try {
    return await flow.submit(code);
  } finally {
    stripAccessFragment(page);
  }
}
