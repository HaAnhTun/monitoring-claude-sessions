// The details behind the two chips (04 4.4 `HealthDetails`): what the client knows about each endpoint, the live stream and the
// server. Read-only; the numbers come from the endpoint tracker, the stream snapshot and the cached `/health` report.
import type { HealthReport } from '@mcs/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore } from 'react';

import { useNow } from '../components/RelativeTime.tsx';
import { InstanceIdContext, useApi } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { fmtAge, fmtClock } from '../lib/format.ts';
// eslint-disable-next-line no-restricted-imports -- the Node builtin pattern `stream` also matches the web folder src/stream (CR-WP-48-1)
import { useStreamSnapshot } from '../stream/StreamProvider.tsx';

type StreamSnapshot = ReturnType<typeof useStreamSnapshot>;

function clock(ms: number): string {
  return fmtClock(new Date(ms).toISOString());
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${String(n)} ${one}` : `${String(n)} ${many}`;
}

function endpointLine(
  r: { name: string; lastSuccess: number | null; failures: number; lastError: { message: string } | null },
  now: number,
): string {
  const success = r.lastSuccess === null ? 'never succeeded' : `ok ${fmtAge((now - r.lastSuccess) / 1000)} ago`;
  if (r.failures === 0) return `${r.name}: ${success}`;
  const last = r.lastError === null ? '' : r.lastError.message;
  return `${r.name}: ${success}; ${plural(r.failures, 'failure', 'failures')} in a row, last: ${last}`;
}

function streamLine(s: StreamSnapshot): string {
  if (s.status === 'open') {
    const since = s.openedAt === null ? '' : ` since ${clock(s.openedAt)}`;
    const last = s.lastSeq === null ? 'no event yet' : `last event #${String(s.lastSeq)}`;
    return `Live updates: connected${since}, ${last}, ${plural(s.counters.invalid, 'invalid message', 'invalid messages')}`;
  }
  const why = s.lastError === null ? s.status : `${s.status}: ${s.lastError}`;
  return `Live updates: not connected (${why})`;
}

function runtimeLine(r: HealthReport['runtime']): string {
  const base = `Server: version ${r.version}, pid ${String(r.pid)}, up ${fmtAge(r.uptimeMs / 1000)}`;
  return r.outdated ? `${base}, restart needed (the code changed)` : base;
}

export function HealthDetails() {
  const { tracker } = useApi();
  const subscribe = useCallback((fn: () => void) => tracker.subscribe(fn), [tracker]);
  const records = useSyncExternalStore(subscribe, () => tracker.snapshot());
  const stream = useStreamSnapshot();
  const iid = useContext(InstanceIdContext);
  // Cache read only: the shell polls `/health`.
  const health = useQuery<HealthReport>({ queryKey: qk.health(iid ?? ''), queryFn: skipToken }).data;
  const now = useNow();

  return (
    <section className="health-details" aria-label="Connection details">
      {records.length === 0 ? (
        <p>No request has been made yet.</p>
      ) : (
        <ul className="health-details__list" aria-label="Endpoints">
          {records.map((r) => (
            <li key={r.name}>{endpointLine(r, now)}</li>
          ))}
        </ul>
      )}
      <p>{streamLine(stream)}</p>
      <p>Last stream reset: {stream.lastResetReason ?? 'none'}</p>
      {health === undefined ? (
        <p>No health report received yet.</p>
      ) : (
        <>
          <p>{runtimeLine(health.runtime)}</p>
          <p>
            Server epoch {health.epoch}, started {clock(Date.parse(health.runtime.startedAt))} (a new epoch means the
            server restarted; configuration changes take effect only on restart)
          </p>
          {health.errors.length === 0 ? (
            <p>No server errors recorded.</p>
          ) : (
            <ul className="health-details__list" aria-label="Server errors">
              {health.errors.map((e) => (
                <li key={`${e.at}|${e.source}|${e.code}|${e.message}`}>
                  {fmtClock(e.at)} {e.source}/{e.code}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
