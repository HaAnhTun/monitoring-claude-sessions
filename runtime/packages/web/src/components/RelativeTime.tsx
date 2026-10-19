import { useEffect, useState } from 'react';

import { useFormat, useT } from '../i18n/context.ts';

export type RelativeTimeMode = 'relative' | 'clock' | 'both';

export interface RelativeTimeProps {
  iso: string | null;
  mode?: RelativeTimeMode;
}

// One interval for the whole page: every mounted RelativeTime listens to it, so a table of 1000 rows still costs one timer.
const CLOCK_TICK_MS = 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    for (const notify of [...listeners]) notify();
  }, CLOCK_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in epoch milliseconds, refreshed every second from the shared clock; frozen while `enabled` is false. */
export function useNow(enabled = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeClock(() => {
      setNow(Date.now());
    });
  }, [enabled]);
  return now;
}

/**
 * A timestamp as text: its age, its wall-clock time or both, in the language of the page (`useFormat`). The
 * `title` always has the full ISO time and the age.
 */
export function RelativeTime({ iso, mode = 'relative' }: RelativeTimeProps) {
  const t = useT();
  const format = useFormat();
  const now = useNow(mode !== 'clock' && iso !== null);
  if (iso === null || iso === '') {
    return (
      <span className="muted" title={t('common.notAvailable')}>
        -
      </span>
    );
  }
  const relative = format.relative(iso, now);
  const clock = format.clock(iso);
  let label: string;
  if (mode === 'clock') label = clock;
  else if (mode === 'both') label = relative === '' ? clock : `${clock} (${relative})`;
  else label = relative;
  return (
    <time dateTime={iso} title={relative === '' ? iso : `${iso} (${relative})`}>
      {label === '' ? iso : label}
    </time>
  );
}
