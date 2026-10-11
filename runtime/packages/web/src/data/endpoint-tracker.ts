// Per-endpoint bookkeeping of the API client (04-ui.md 5.1): last success, last error, consecutive failures and requests in
// flight. The health bar and the connection model read it; nothing here talks to the network.
import type { ApiErrorKind } from './api-errors.ts';
import type { EndpointName } from './endpoints.ts';

export interface EndpointRecord {
  name: EndpointName;
  lastSuccess: number | null;
  failures: number;
  inFlight: number;
  lastError: { message: string; status: number; kind: ApiErrorKind; t: number } | null;
}

export interface EndpointTracker {
  /** Stable between changes, so it can back `useSyncExternalStore`. */
  snapshot(): readonly EndpointRecord[];
  get(name: EndpointName): EndpointRecord | null;
  /** Listeners are called once per tick however many records changed (coalesced with `queueMicrotask`). */
  subscribe(fn: () => void): () => void;
}

export type SettleOutcome =
  | { ok: true; at: number }
  | { ok: false; at: number; error: { message: string; status: number; kind: ApiErrorKind } }
  /** The caller cancelled: the request ends without counting as a failure or a success. */
  | { ok: 'aborted' };

/** The write side, used by the API client only. */
export interface EndpointTrackerControl extends EndpointTracker {
  begin(name: EndpointName): void;
  settle(name: EndpointName, outcome: SettleOutcome): void;
}

export function createEndpointTracker(): EndpointTrackerControl {
  const records = new Map<EndpointName, EndpointRecord>();
  const listeners = new Set<() => void>();
  let cached: readonly EndpointRecord[] | null = null;
  let scheduled = false;

  function record(name: EndpointName): EndpointRecord {
    const existing = records.get(name);
    if (existing !== undefined) return existing;
    const created: EndpointRecord = { name, lastSuccess: null, failures: 0, inFlight: 0, lastError: null };
    records.set(name, created);
    return created;
  }

  function changed(): void {
    cached = null;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // a listener bug must not stop the others or the requests
        }
      }
    });
  }

  return {
    snapshot() {
      cached ??= [...records.values()].map((r) => ({
        ...r,
        lastError: r.lastError === null ? null : { ...r.lastError },
      }));
      return cached;
    },
    get(name) {
      const r = records.get(name);
      return r === undefined ? null : { ...r, lastError: r.lastError === null ? null : { ...r.lastError } };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    begin(name) {
      record(name).inFlight += 1;
      changed();
    },
    settle(name, outcome) {
      const r = record(name);
      r.inFlight = Math.max(0, r.inFlight - 1);
      if (outcome.ok === true) {
        r.lastSuccess = outcome.at;
        r.failures = 0;
      } else if (outcome.ok === false) {
        r.failures += 1;
        r.lastError = { ...outcome.error, t: outcome.at };
      }
      changed();
    },
  };
}
