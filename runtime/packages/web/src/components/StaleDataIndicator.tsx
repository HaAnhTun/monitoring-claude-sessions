import { useLayoutEffect, useRef } from 'react';

import { fmtAge, fmtClock } from '../lib/format.ts';
// eslint-disable-next-line no-restricted-imports -- the Node builtin pattern `stream` also matches the web folder src/stream (CR-WP-48-1)
import { useFreshness } from '../stream/useFreshness.ts';
import { Icon } from './Icon.tsx';
import { useNow } from './RelativeTime.tsx';

export interface StaleDataIndicatorProps {
  /** When the data shown was last updated (epoch ms); `null`: use the time the connection was last in sync. */
  asOf: number | null;
  /** The page's own refresh failed (the rows shown are the last good ones). */
  fetchFailing?: boolean;
  /** What the line talks about: "sessions". */
  scope: string;
}

// Several indicators may sit in one scope; the scope stays marked until the last one is gone.
const marks = new WeakMap<Element, number>();

function mark(scope: Element): void {
  marks.set(scope, (marks.get(scope) ?? 0) + 1);
  scope.setAttribute('data-stale', 'true');
}

function unmark(scope: Element): void {
  const left = (marks.get(scope) ?? 1) - 1;
  if (left > 0) {
    marks.set(scope, left);
    return;
  }
  marks.delete(scope);
  scope.removeAttribute('data-stale');
}

/**
 * UI-I5: a stale view is never blank. The data stays, this line says how old it is and why ("<scope> as of 12:00:00 (45s ago):
 * refresh failing"), and the closest `[data-stale-scope]` gets `data-stale="true"` for the dashed outline (ADR 0033; text colours
 * are never reduced). Nothing renders while the data is fresh. The line is plain text: the shell's one live region announces
 * the transitions, so this is not a live region itself.
 */
export function StaleDataIndicator({ asOf, fetchFailing = false, scope }: StaleDataIndicatorProps) {
  const { connection } = useFreshness();
  const now = useNow();
  const lineRef = useRef<HTMLParagraphElement>(null);
  const shown = fetchFailing || connection.stale;

  useLayoutEffect(() => {
    if (!shown) return undefined;
    const target = lineRef.current?.closest('[data-stale-scope]') ?? null;
    if (target === null) return undefined;
    mark(target);
    return () => {
      unmark(target);
    };
  }, [shown]);

  if (!shown) return null;
  const since = asOf ?? connection.lastSyncAt;
  const age = since === null ? '' : fmtAge((now - since) / 1000);
  let reason: string;
  if (fetchFailing || connection.state === 'polling') reason = 'refresh failing';
  else if (connection.state === 'reconnecting' || connection.state === 'offline') reason = 'live updates disconnected';
  else reason = `no update for ${age}`;
  const text =
    since === null
      ? `${scope}: ${reason}`
      : `${scope} as of ${fmtClock(new Date(since).toISOString())} (${age} ago): ${reason}`;
  return (
    <p ref={lineRef} className="stale-indicator tone-stale">
      <Icon name="clock" />
      <span>{text}</span>
    </p>
  );
}
