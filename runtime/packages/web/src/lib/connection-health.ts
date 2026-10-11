// Monitor connection and data freshness, kept separate from session execution state (04 section 5.6). Pure: takes the
// endpoint tracker records and a stream snapshot and returns a description; the chips render it. Ported from legacy
// modules/health.js (`computeHealth` thresholds are reused inside `computeConnection`).
import type { LegacyState } from '@mcs/shared';

import { fmtAge } from './format.ts';

// ---- legacy health (verbatim thresholds) -------------------------------------------------------------------------------

/** What the tracker records about one endpoint (the structural part of `EndpointRecord` of data/endpoint-tracker.ts). */
export interface EndpointRecord {
  name: string;
  /** Epoch milliseconds of the last success, null before the first one. */
  lastSuccess: number | null;
  /** Consecutive failures since the last success. */
  failures: number;
  lastError: { message: string; t: number } | null;
}

export type HealthConnection = 'connecting' | 'ok' | 'reconnecting' | 'lost';

export interface HealthLastError {
  name: string;
  message: string;
  t: number;
}

export interface HealthResult {
  connection: HealthConnection;
  /** No successful poll of some core endpoint for staleAfterMs. */
  stale: boolean;
  /** Age of the OLDEST core success (worst-case freshness); null when none yet. */
  ageMs: number | null;
  lastError: HealthLastError | null;
  failing: string[];
}

/**
 * `coreNames` are the endpoints that define "the monitor is working". `lost` = a failing endpoint that never succeeded
 * failed three times, or one that did succeed has not for staleAfterMs.
 */
export function computeHealth(i: {
  records: readonly EndpointRecord[];
  now: number;
  staleAfterMs: number;
  coreNames: readonly string[];
}): HealthResult {
  const byName = new Map(i.records.map((r) => [r.name, r]));
  const core = i.coreNames.flatMap((n) => byName.get(n) ?? []);
  const touched = core.filter((r) => r.lastSuccess !== null || r.lastError !== null);
  if (touched.length === 0)
    return { connection: 'connecting', stale: false, ageMs: null, lastError: null, failing: [] };

  const successes = core.flatMap((r) => r.lastSuccess ?? []);
  const ageMs = successes.length > 0 ? i.now - Math.min(...successes) : null;
  const failing = core.filter((r) => r.failures > 0);

  let connection: HealthConnection = 'ok';
  if (failing.length > 0) {
    const down = failing.some((r) =>
      r.lastSuccess === null ? r.failures >= 3 : i.now - r.lastSuccess >= i.staleAfterMs,
    );
    connection = down ? 'lost' : 'reconnecting';
  }
  const stale = ageMs !== null && ageMs > i.staleAfterMs;
  let lastError: HealthLastError | null = null;
  for (const r of failing) {
    if (r.lastError !== null && (lastError === null || r.lastError.t > lastError.t)) {
      lastError = { name: r.name, message: r.lastError.message, t: r.lastError.t };
    }
  }
  return { connection, stale, ageMs, lastError, failing: failing.map((r) => r.name) };
}

const LEGACY: readonly LegacyState[] = ['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN'];

function isLegacyState(s: unknown): s is LegacyState {
  return typeof s === 'string' && LEGACY.some((l) => l === s);
}

/** The five-state vocabulary of the page title; accepts a legacy string or a state assessment (`legacyState`). */
export function normalizeState(s: unknown): LegacyState {
  if (typeof s === 'object' && s !== null && 'legacyState' in s) return normalizeState(s.legacyState);
  return isLegacyState(s) ? s : 'UNKNOWN';
}

export type StateCounts = Record<LegacyState, number>;

/** Counts items by their five-state value. */
export function countStates(items: readonly { state: unknown }[]): StateCounts {
  const c: StateCounts = { RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 };
  for (const s of items) c[normalizeState(s.state)] += 1;
  return c;
}

/** Page title: plain words, never emoji-only. `connection` accepts the legacy and the v3 vocabulary. */
export function titleFor(counts: StateCounts, title: string, connection: HealthConnection | ConnectionState): string {
  const parts: string[] = [];
  if (counts.RUNNING > 0) parts.push(`${String(counts.RUNNING)} running`);
  if (counts.FAILED > 0) parts.push(`${String(counts.FAILED)} failed`);
  const prefix = connection === 'lost' || connection === 'offline' ? 'Monitor offline' : parts.join(', ');
  return prefix === '' ? title : `${prefix} - ${title}`;
}

// ---- connection model (04 5.6) -----------------------------------------------------------------------------------------

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'backoff' | 'stopped';
export type ConnectionState = 'connecting' | 'live' | 'polling' | 'reconnecting' | 'offline';

export interface ConnectionView {
  state: ConnectionState;
  /** now - lastSyncAt > staleAfterMs. */
  stale: boolean;
  /** The freshest of the stream's last in-sync time and the oldest core endpoint success. */
  lastSyncAt: number | null;
  ageMs: number | null;
  /** When the stream reconnects next. */
  retryAt: number | null;
  lastError: { source: string; message: string; t: number } | null;
}

/** The part of the stream snapshot the model reads. */
export interface StreamHealthInput {
  status: StreamStatus;
  inSyncAt: number | null;
  nextRetryAt: number | null;
  lastError: string | null;
}

/**
 * Algorithm of 04 5.6: connecting -> offline (browser) -> apiDown -> state -> staleness.
 * `lastSyncAt` is `max(stream.inSyncAt, min over core endpoints of lastSuccess)`: the data is as fresh as the freshest
 * source (the interface comment of 04 5.6; step 4 of the algorithm text names only one of the two, see CR-WP-45-1).
 */
export function computeConnection(i: {
  now: number;
  staleAfterMs: number;
  online: boolean;
  stream: StreamHealthInput;
  /** `instance` until its first success, then `health` and the active page's primary list endpoint. */
  core: readonly EndpointRecord[];
}): ConnectionView {
  const health = computeHealth({
    records: i.core,
    now: i.now,
    staleAfterMs: i.staleAfterMs,
    coreNames: i.core.map((r) => r.name),
  });
  const streamOpen = i.stream.status === 'open';
  const touched = i.core.some((r) => r.lastSuccess !== null || r.lastError !== null);
  const streamSeen = streamOpen || i.stream.inSyncAt !== null;

  const successes = i.core.flatMap((r) => r.lastSuccess ?? []);
  const oldestCoreSuccess = successes.length > 0 ? Math.min(...successes) : null;
  const syncTimes = [i.stream.inSyncAt, oldestCoreSuccess].flatMap((t) => t ?? []);
  const lastSyncAt = syncTimes.length > 0 ? Math.max(...syncTimes) : null;
  const ageMs = lastSyncAt === null ? null : i.now - lastSyncAt;
  const stale = ageMs !== null && ageMs > i.staleAfterMs;
  const view = (state: ConnectionState): ConnectionView => ({
    state,
    stale,
    lastSyncAt,
    ageMs,
    retryAt: i.stream.nextRetryAt,
    lastError:
      health.lastError === null
        ? null
        : { source: health.lastError.name, message: health.lastError.message, t: health.lastError.t },
  });

  if (!touched && !streamSeen) return view('connecting');
  if (!i.online) return view('offline');
  if (health.connection === 'lost') return view('offline');
  if (streamOpen) return view('live');
  if (health.failing.length === 0) return view('polling');
  return view('reconnecting');
}

// ---- ingestion view (UI-I4) --------------------------------------------------------------------------------------------

export type IngestionDisplay = 'ok' | 'degraded' | 'stalled' | 'down' | 'disabled' | 'unknown';

export interface IngestionView {
  display: IngestionDisplay;
  reasons: string[];
  asOf: number | null;
  /** True only when the connection is live or polling and the health poll is fresh. */
  known: boolean;
}

/** The part of the health report this model reads (`HealthReport.ingestion`). */
export interface IngestionHealthInput {
  ingestion: { status: IngestionDisplay; reasons: readonly string[] };
}

export function computeIngestionView(
  health: IngestionHealthInput | undefined,
  healthRecord: EndpointRecord | null,
  conn: ConnectionView,
  now: number,
  staleAfterMs: number,
): IngestionView {
  if (health === undefined) return { display: 'unknown', reasons: [], asOf: null, known: false };
  const lastSuccess = healthRecord?.lastSuccess ?? null;
  const known =
    (conn.state === 'live' || conn.state === 'polling') && lastSuccess !== null && now - lastSuccess <= staleAfterMs;
  if (known) {
    return { display: health.ingestion.status, reasons: [...health.ingestion.reasons], asOf: lastSuccess, known: true };
  }
  const age = lastSuccess === null ? '' : `, ${fmtAge((now - lastSuccess) / 1000)} ago`;
  return {
    display: 'unknown',
    reasons: [`Last known: ${health.ingestion.status}${age}`],
    asOf: lastSuccess,
    known: false,
  };
}
