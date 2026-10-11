// What the user sees of the connection, the freshness of the data and the ingestion health (04 5.6, ADR 0033). Three separate
// signals: the connection is observed by the client, freshness is `now - lastSyncAt > staleAfterMs`, ingestion is what the
// server says in `/health` and is shown as "unknown (last known ...)" whenever the client is not in sync. This file turns the
// pure models of `lib/connection-health.ts` into chip texts, tones and icons, the "as of" line and the polite announcements.
import type { IconName } from '../components/icons.ts';
import {
  computeConnection,
  computeIngestionView,
  type ConnectionView,
  type EndpointRecord,
  type IngestionHealthInput,
  type IngestionView,
  type StreamHealthInput,
} from '../lib/connection-health.ts';
import { fmtAge, fmtClock } from '../lib/format.ts';

export type ChipTone = 'idle' | 'ok' | 'stale' | 'failed' | 'unknown';

export interface ChipView {
  text: string;
  tone: ChipTone;
  icon: IconName;
  /** Extra visible text (the first ingestion reason on wide screens); `null` when there is none. */
  detail: string | null;
  /** The full text for the `title` attribute. */
  title: string;
}

function chip(text: string, tone: ChipTone, icon: IconName, detail: string | null = null, title?: string): ChipView {
  return { text, tone, icon, detail, title: title ?? (detail === null ? text : `${text}: ${detail}`) };
}

function secondsUntil(at: number | null, now: number): number | null {
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function retryText(view: ConnectionView, now: number): string {
  const seconds = secondsUntil(view.retryAt, now);
  return seconds === null ? '' : ` (retry in ${String(seconds)}s)`;
}

/** The connection chip table of 04 5.6. `pollSeconds` is the refresh period shown while the stream is paused. */
export function connectionChip(
  view: ConnectionView,
  o: { now: number; online: boolean; pollSeconds: number },
): ChipView {
  switch (view.state) {
    case 'connecting':
      return chip('Connecting...', 'idle', 'loader');
    case 'live':
      return view.stale ? chip('Live, waiting for data', 'stale', 'clock') : chip('Live', 'ok', 'wifi');
    case 'polling':
      return view.stale
        ? chip('Refresh failing', 'stale', 'clock')
        : chip(`Live updates paused, refreshing every ${String(o.pollSeconds)}s`, 'stale', 'refresh');
    case 'reconnecting':
      return chip(`Reconnecting${retryText(view, o.now)}`, 'stale', 'refresh');
    case 'offline':
      return o.online
        ? chip(`Connection lost${retryText(view, o.now)}`, 'failed', 'wifi-off')
        : chip('Offline', 'failed', 'wifi-off');
  }
}

/** The ingestion chip table of 04 5.6. */
export function ingestionChip(view: IngestionView): ChipView {
  const first = view.reasons[0] ?? null;
  const all = view.reasons.join('; ');
  const titled = (text: string): string => (all === '' ? text : `${text}: ${all}`);
  switch (view.display) {
    case 'ok':
      return chip('Ingestion OK', 'ok', 'check');
    case 'degraded':
      return chip('Ingestion degraded', 'stale', 'alert', first, titled('Ingestion degraded'));
    case 'stalled':
      return chip('Ingestion stalled', 'failed', 'alert', first, titled('Ingestion stalled'));
    case 'down':
      return chip('Ingestion down', 'failed', 'alert', first, titled('Ingestion down'));
    case 'disabled':
      return chip('Hooks off: transcripts only', 'idle', 'info');
    case 'unknown':
      return chip('Ingestion unknown', 'unknown', 'help', first, titled('Ingestion unknown'));
  }
}

/** "as of HH:MM:SS (40s ago)" on every data block while the data is stale; `null` otherwise (ADR 0033). */
export function staleLine(view: ConnectionView, now: number): string | null {
  if (!view.stale || view.lastSyncAt === null) return null;
  const clock = fmtClock(new Date(view.lastSyncAt).toISOString());
  return `as of ${clock} (${fmtAge((now - view.lastSyncAt) / 1000)} ago)`;
}

export interface DescribeFreshnessInput {
  now: number;
  /** `instance.staleAfterMs`. */
  staleAfterMs: number;
  /** `navigator.onLine`. */
  online: boolean;
  /** The period of the polling fallback, shown in the "paused" chip. */
  pollSeconds: number;
  stream: StreamHealthInput;
  /** `instance` until its first success, then `health` and the active page's primary list endpoint. */
  core: readonly EndpointRecord[];
  health: IngestionHealthInput | undefined;
  /** The tracker record of the `health` endpoint. */
  healthRecord: EndpointRecord | null;
}

export interface Freshness {
  connection: ConnectionView;
  ingestion: IngestionView;
  connectionChip: ChipView;
  ingestionChip: ChipView;
  staleLine: string | null;
}

export function describeFreshness(i: DescribeFreshnessInput): Freshness {
  const connection = computeConnection({
    now: i.now,
    staleAfterMs: i.staleAfterMs,
    online: i.online,
    stream: i.stream,
    core: i.core,
  });
  const ingestion = computeIngestionView(i.health, i.healthRecord, connection, i.now, i.staleAfterMs);
  return {
    connection,
    ingestion,
    connectionChip: connectionChip(connection, { now: i.now, online: i.online, pollSeconds: i.pollSeconds }),
    ingestionChip: ingestionChip(ingestion),
    staleLine: staleLine(connection, i.now),
  };
}

const INGESTION_PROBLEMS: readonly IngestionView['display'][] = ['degraded', 'stalled', 'down'];

/**
 * The polite announcements of one transition, in the words of 04 5.6: "Connection lost", "Connection restored", "Live updates
 * paused", "Data is stale: no update for Ns", "Data up to date", "Ingestion degraded: <reason>", "Ingestion recovered".
 * Nothing on the first computation. While the connection itself changed, the stale transition is left out (it is implied).
 */
export function freshnessAnnouncements(prev: Freshness | null, next: Freshness, now: number): string[] {
  if (prev === null) return [];
  const out: string[] = [];
  const before = prev.connection;
  const after = next.connection;
  let connectionMoved = false;
  if (before.state !== 'offline' && after.state === 'offline') {
    out.push('Connection lost');
    connectionMoved = true;
  } else if (before.state === 'offline' && after.state !== 'offline' && after.state !== 'connecting') {
    out.push('Connection restored');
    connectionMoved = true;
  }
  if (before.state === 'live' && after.state === 'polling') out.push('Live updates paused');
  if (!connectionMoved && !before.stale && after.stale && after.lastSyncAt !== null) {
    out.push(`Data is stale: no update for ${fmtAge((now - after.lastSyncAt) / 1000)}`);
  } else if (!connectionMoved && before.stale && !after.stale) {
    out.push('Data up to date');
  }
  const was = prev.ingestion.display;
  const is = next.ingestion.display;
  if (is === 'degraded' && was !== 'degraded') {
    const reason = next.ingestion.reasons[0];
    out.push(reason === undefined ? 'Ingestion degraded' : `Ingestion degraded: ${reason}`);
  } else if (is === 'ok' && INGESTION_PROBLEMS.includes(was)) {
    out.push('Ingestion recovered');
  }
  return out;
}
