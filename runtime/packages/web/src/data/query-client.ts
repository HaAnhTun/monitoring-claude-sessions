// The TanStack Query client and its retry policy (04-ui.md 5.2). The failure types of the API client decide what is retried:
// a contract failure or a cancelled request never, a 4xx answer never (429 once), everything else up to three times.
import { QueryClient } from '@tanstack/react-query';

import { nextDelay } from '../lib/backoff.ts';
import { ApiError } from './api-errors.ts';

declare module '@tanstack/react-query' {
  interface Register {
    /** Every query function of the data layer fails with an `ApiError` (the client wraps whatever fetch throws). */
    defaultError: ApiError;
  }
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.info.status === 429;
}

function neverRetried(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const { kind, status } = error.info;
  return kind === 'contract' || kind === 'aborted' || (kind === 'http' && status < 500 && status !== 429);
}

/** `failureCount` is the number of failed attempts so far (0 on the first failure). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (neverRetried(error)) return false;
  return failureCount < (isRateLimited(error) ? 1 : 3);
}

/** 2 s, 4 s, 8 s (cap 30 s); a 429 waits for its `Retry-After`, or 2 s. */
export function retryDelay(failureCount: number, error: unknown): number {
  if (error instanceof ApiError && error.info.status === 429) return error.info.retryAfterMs ?? 2000;
  return nextDelay(1000, failureCount + 1);
}

export interface QueryClientOptions {
  /** `false` turns retries off (tests). */
  retry?: false;
}

export function createQueryClient(o: QueryClientOptions = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        throwOnError: false,
        retry: o.retry ?? shouldRetry,
        retryDelay,
        structuralSharing: true,
      },
    },
  });
}
