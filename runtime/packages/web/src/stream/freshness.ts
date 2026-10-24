// What the user sees of the connection, the freshness of the data and the ingestion health (04 5.6, ADR 0033, ADR 0073 decision 5).
// Three separate signals: the connection is observed by the client, freshness is `now - lastSyncAt > staleAfterMs`, ingestion is
// what the server says in `/health` and is shown as "unknown (last known ...)" whenever the client is not in sync. This file turns
// the pure models of `lib/connection-health.ts` into catalogue keys with their arguments, tones and icons (no English here), the
// one word of the Live control (the worse of the two signals), the "as of" figures and the polite announcements.
import type { IconName } from '../components/icons.ts';
import type { Formatters } from '../i18n/format.ts';
import type { MessageKey, TFunction } from '../i18n/types.ts';
import {
  computeConnection,
  computeIngestionView,
  type ConnectionView,
  type EndpointRecord,
  type IngestionDisplay,
  type IngestionHealthInput,
  type IngestionView,
  type StreamHealthInput,
} from '../lib/connection-health.ts';

export type ChipTone = 'idle' | 'ok' | 'stale' | 'failed' | 'unknown';

/** The texts of the connection and ingestion lines that take no argument. */
export type PlainChipKey =
  | 'live.conn.connecting'
  | 'live.conn.live'
  | 'live.conn.liveWaiting'
  | 'live.conn.pollingFailing'
  | 'live.conn.reconnecting'
  | 'live.conn.lost'
  | 'live.conn.offline'
  | 'live.ingest.ok'
  | 'live.ingest.degraded'
  | 'live.ingest.stalled'
  | 'live.ingest.down'
  | 'live.ingest.disabled'
  | 'live.ingest.unknown';

/** The texts that count seconds (the refresh period, the retry countdown). */
export type CountdownChipKey = 'live.conn.polling' | 'live.conn.reconnectingRetry' | 'live.conn.lostRetry';

/** A catalogue key with its arguments; the types keep the call of `t` checked. */
export type ChipText = { textKey: PlainChipKey; args: null } | { textKey: CountdownChipKey; args: { seconds: number } };

/** A line of the Live popover: a catalogue key with its arguments, a tone and an icon. */
export type ChipView = ChipText & { tone: ChipTone; icon: IconName };

function chip(textKey: PlainChipKey, tone: ChipTone, icon: IconName): ChipView;
function chip(textKey: CountdownChipKey, tone: ChipTone, icon: IconName, seconds: number): ChipView;
function chip(textKey: PlainChipKey | CountdownChipKey, tone: ChipTone, icon: IconName, seconds?: number): ChipView {
  if (seconds !== undefined && isCountdownKey(textKey)) return { textKey, args: { seconds }, tone, icon };
  if (isPlainKey(textKey)) return { textKey, args: null, tone, icon };
  throw new Error(`chip ${textKey} needs ${seconds === undefined ? 'seconds' : 'no seconds'}`);
}

const COUNTDOWN_KEYS: readonly string[] = ['live.conn.polling', 'live.conn.reconnectingRetry', 'live.conn.lostRetry'];

function isCountdownKey(key: string): key is CountdownChipKey {
  return COUNTDOWN_KEYS.includes(key);
}

function isPlainKey(key: string): key is PlainChipKey {
  return !COUNTDOWN_KEYS.includes(key);
}

/** The text of a chip in the language of `t`. */
export function chipText(t: TFunction, view: ChipText): string {
  return view.args === null ? t(view.textKey) : t(view.textKey, view.args);
}

function secondsUntil(at: number | null, now: number): number | null {
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The connection chip table of 04 5.6. `pollSeconds` is the refresh period shown while the stream is paused. */
export function connectionChip(
  view: ConnectionView,
  o: { now: number; online: boolean; pollSeconds: number },
): ChipView {
  const retry = secondsUntil(view.retryAt, o.now);
  switch (view.state) {
    case 'connecting':
      return chip('live.conn.connecting', 'idle', 'loader');
    case 'live':
      return view.stale ? chip('live.conn.liveWaiting', 'stale', 'clock') : chip('live.conn.live', 'ok', 'wifi');
    case 'polling':
      return view.stale
        ? chip('live.conn.pollingFailing', 'stale', 'clock')
        : chip('live.conn.polling', 'stale', 'refresh', o.pollSeconds);
    case 'reconnecting':
      return retry === null
        ? chip('live.conn.reconnecting', 'stale', 'refresh')
        : chip('live.conn.reconnectingRetry', 'stale', 'refresh', retry);
    case 'offline':
      if (!o.online) return chip('live.conn.offline', 'failed', 'wifi-off');
      return retry === null
        ? chip('live.conn.lost', 'failed', 'wifi-off')
        : chip('live.conn.lostRetry', 'failed', 'wifi-off', retry);
  }
}

/** The ingestion chip table of 04 5.6. The server's reasons and the last known status stay in the view, not in the chip. */
export function ingestionChip(view: IngestionView): ChipView {
  switch (view.display) {
    case 'ok':
      return chip('live.ingest.ok', 'ok', 'check');
    case 'degraded':
      return chip('live.ingest.degraded', 'stale', 'alert');
    case 'stalled':
      return chip('live.ingest.stalled', 'failed', 'alert');
    case 'down':
      return chip('live.ingest.down', 'failed', 'alert');
    case 'disabled':
      return chip('live.ingest.disabled', 'idle', 'info');
    case 'unknown':
      return chip('live.ingest.unknown', 'unknown', 'help');
  }
}

/** The word of an ingestion status ("ok", "degraded", ...), for the "last known" line. */
export const INGESTION_STATUS_KEYS = {
  ok: 'live.ingest.status.ok',
  degraded: 'live.ingest.status.degraded',
  stalled: 'live.ingest.status.stalled',
  down: 'live.ingest.status.down',
  disabled: 'live.ingest.status.disabled',
  unknown: 'live.ingest.status.unknown',
} as const satisfies Record<IngestionDisplay, MessageKey>;

/** The words of the Live control; none takes an argument. */
export type LiveBarKey =
  | 'live.bar.connecting'
  | 'live.bar.live'
  | 'live.bar.waiting'
  | 'live.bar.paused'
  | 'live.bar.refreshFailing'
  | 'live.bar.reconnecting'
  | 'live.bar.lost'
  | 'live.bar.offline'
  | 'live.bar.ingestionDegraded'
  | 'live.bar.ingestionStalled'
  | 'live.bar.ingestionDown'
  | 'live.bar.ingestionUnknown';

/** The one word and colour of the Live control: the worse of the two signals (the connection wins a tie). */
export interface LiveSummary {
  source: 'connection' | 'ingestion';
  textKey: LiveBarKey;
  tone: ChipTone;
}

const SEVERITY: Readonly<Record<ChipTone, number>> = { ok: 0, idle: 1, unknown: 2, stale: 3, failed: 4 };

function connectionBarKey(view: ConnectionView, online: boolean): LiveBarKey {
  switch (view.state) {
    case 'connecting':
      return 'live.bar.connecting';
    case 'live':
      return view.stale ? 'live.bar.waiting' : 'live.bar.live';
    case 'polling':
      return view.stale ? 'live.bar.refreshFailing' : 'live.bar.paused';
    case 'reconnecting':
      return 'live.bar.reconnecting';
    case 'offline':
      return online ? 'live.bar.lost' : 'live.bar.offline';
  }
}

function ingestionBarKey(display: IngestionDisplay): LiveBarKey | null {
  switch (display) {
    case 'degraded':
      return 'live.bar.ingestionDegraded';
    case 'stalled':
      return 'live.bar.ingestionStalled';
    case 'down':
      return 'live.bar.ingestionDown';
    case 'unknown':
      return 'live.bar.ingestionUnknown';
    case 'ok':
    case 'disabled':
      return null;
  }
}

/**
 * Colour = the worse of connection and ingestion; the word names the signal that has the colour. "OK" is never claimed while the
 * client is not in sync: the ingestion is then "unknown" (UI-I4) and the connection is at least as bad, so the connection speaks.
 */
export function liveSummary(
  connection: ConnectionView,
  ingestion: IngestionView,
  tones: { connection: ChipTone; ingestion: ChipTone },
  online: boolean,
): LiveSummary {
  const fromConnection: LiveSummary = {
    source: 'connection',
    textKey: connectionBarKey(connection, online),
    tone: tones.connection,
  };
  // While the client connects, the ingestion is "unknown" only because nothing has arrived yet: the connection says it all.
  if (connection.state === 'connecting') return fromConnection;
  const ingestionKey = ingestionBarKey(ingestion.display);
  if (ingestionKey === null || SEVERITY[tones.ingestion] <= SEVERITY[tones.connection]) return fromConnection;
  return { source: 'ingestion', textKey: ingestionKey, tone: tones.ingestion };
}

/** The "as of" figures of a stale view (ADR 0033): when the data was last in sync and how old it is. */
export interface StaleFigures {
  lastSyncAt: number;
  ageSeconds: number;
}

/** `null` while the data is fresh or was never in sync. */
export function staleLine(view: ConnectionView, now: number): StaleFigures | null {
  if (!view.stale || view.lastSyncAt === null) return null;
  return { lastSyncAt: view.lastSyncAt, ageSeconds: (now - view.lastSyncAt) / 1000 };
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
  /** The colour and the word of the Live control. */
  live: LiveSummary;
  staleLine: StaleFigures | null;
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
  const connectionView = connectionChip(connection, { now: i.now, online: i.online, pollSeconds: i.pollSeconds });
  const ingestionView = ingestionChip(ingestion);
  return {
    connection,
    ingestion,
    connectionChip: connectionView,
    ingestionChip: ingestionView,
    live: liveSummary(
      connection,
      ingestion,
      { connection: connectionView.tone, ingestion: ingestionView.tone },
      i.online,
    ),
    staleLine: staleLine(connection, i.now),
  };
}

const INGESTION_PROBLEMS: readonly IngestionView['display'][] = ['degraded', 'stalled', 'down'];

/**
 * The polite announcements of one transition, in the words of 04 5.6: "Connection lost", "Connection restored", "Live updates
 * paused", "Data is stale: no update for Ns", "Data up to date", "Ingestion degraded: <reason>", "Ingestion recovered", in the
 * language of `t`. Nothing on the first computation. While the connection itself changed, the stale transition is left out (it is
 * implied).
 */
export function freshnessAnnouncements(
  prev: Freshness | null,
  next: Freshness,
  now: number,
  t: TFunction,
  format: Formatters,
): string[] {
  if (prev === null) return [];
  const out: string[] = [];
  const before = prev.connection;
  const after = next.connection;
  let connectionMoved = false;
  if (before.state !== 'offline' && after.state === 'offline') {
    out.push(t('freshness.announce.lost'));
    connectionMoved = true;
  } else if (before.state === 'offline' && after.state !== 'offline' && after.state !== 'connecting') {
    out.push(t('freshness.announce.restored'));
    connectionMoved = true;
  }
  if (before.state === 'live' && after.state === 'polling') out.push(t('freshness.announce.paused'));
  if (!connectionMoved && !before.stale && after.stale && after.lastSyncAt !== null) {
    out.push(t('freshness.announce.stale', { age: format.age((now - after.lastSyncAt) / 1000) }));
  } else if (!connectionMoved && before.stale && !after.stale) {
    out.push(t('freshness.announce.upToDate'));
  }
  const was = prev.ingestion.display;
  const is = next.ingestion.display;
  if (is === 'degraded' && was !== 'degraded') {
    const reason = next.ingestion.reasons[0];
    out.push(
      reason === undefined ? t('freshness.announce.degradedPlain') : t('freshness.announce.degraded', { reason }),
    );
  } else if (is === 'ok' && INGESTION_PROBLEMS.includes(was)) {
    out.push(t('freshness.announce.recovered'));
  }
  return out;
}
