// The freshness hook (04 5.6): connection state, staleness and ingestion view, from the stream snapshot, the endpoint tracker of
// the API client, the instance info (`staleAfterMs`, poll periods), the cached health report and `navigator.onLine`. It only
// reads; it never fetches (the shell polls `/health`), so any number of components may use it. Optionally it announces the
// transitions politely, once each.
import type { HealthReport, InstanceInfo } from '@mcs/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { EndpointName } from '../data/endpoints.ts';
import { InstanceIdContext, useApi, usePoll } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import type { EndpointRecord } from '../lib/connection-health.ts';
import { describeFreshness, freshnessAnnouncements, type Freshness } from './freshness.ts';
import { useStreamSnapshot } from './StreamProvider.tsx';

/** The `staleAfterMs` of an instance that is not loaded yet (config `poll.stale_after_ms` default, 03 6.2). */
export const DEFAULT_STALE_AFTER_MS = 15_000;
/** How often the ages and countdowns are recomputed. */
export const FRESHNESS_TICK_MS = 1000;

export interface UseFreshnessOptions {
  /** The active page's primary list endpoint: a failing one counts against the connection (04 5.6 `core`). */
  primary?: EndpointName;
  /** Called once per transition with the words of 04 5.6 ("Connection lost", ...). */
  announce?: (message: string) => void;
  tickMs?: number;
}

function subscribeOnline(fn: () => void): () => void {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

/** `navigator.onLine`, live. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(id);
    };
  }, [tickMs]);
  return now;
}

function blank(name: string): EndpointRecord {
  return { name, lastSuccess: null, failures: 0, lastError: null };
}

export function useFreshness(options: UseFreshnessOptions = {}): Freshness {
  const { tracker } = useApi();
  const subscribeTracker = useCallback((fn: () => void) => tracker.subscribe(fn), [tracker]);
  const records = useSyncExternalStore(subscribeTracker, () => tracker.snapshot());
  const stream = useStreamSnapshot();
  const iid = useContext(InstanceIdContext);
  const poll = usePoll();
  const online = useOnline();
  const now = useNow(options.tickMs ?? FRESHNESS_TICK_MS);
  // Cache reads only (`skipToken`): the shell owns the fetching.
  const instance = useQuery<InstanceInfo>({ queryKey: qk.instance(), queryFn: skipToken }).data;
  const health = useQuery<HealthReport>({ queryKey: qk.health(iid ?? ''), queryFn: skipToken }).data;

  const freshness = useMemo(() => {
    const byName = new Map(records.map((r) => [r.name, r]));
    const instanceRecord = byName.get('instance') ?? blank('instance');
    const healthRecord = byName.get('health') ?? null;
    const names: EndpointName[] =
      instanceRecord.lastSuccess === null
        ? ['instance']
        : ['health', ...(options.primary === undefined ? [] : [options.primary])];
    const core = names.map((name) => byName.get(name) ?? blank(name));
    return describeFreshness({
      now,
      staleAfterMs: instance?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      online,
      pollSeconds: Math.round(poll.sessionsMs / 1000),
      stream: {
        status: stream.status,
        inSyncAt: stream.inSyncAt,
        nextRetryAt: stream.nextRetryAt,
        lastError: stream.lastError,
      },
      core,
      health,
      healthRecord,
    });
  }, [records, now, instance, online, poll.sessionsMs, stream, health, options.primary]);

  const announce = useEffectEvent((message: string) => {
    options.announce?.(message);
  });
  const previous = useRef<Freshness | null>(null);
  useEffect(() => {
    const messages = freshnessAnnouncements(previous.current, freshness, now);
    previous.current = freshness;
    for (const message of messages) announce(message);
  }, [freshness, now]);

  return freshness;
}
