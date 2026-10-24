// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/translate.ts';
import {
  computeConnection,
  computeHealth,
  computeIngestionView,
  countStates,
  normalizeState,
  titleFor,
  type ConnectionState,
  type EndpointRecord,
  type StreamStatus,
} from './connection-health.ts';

const t = createT('en');

function rec(name: string, o: Partial<EndpointRecord> = {}): EndpointRecord {
  return { name, lastSuccess: null, lastError: null, failures: 0, ...o };
}

const NOW = 100000;
const STALE = 20000;

describe('connection health (legacy computeHealth)', () => {
  it('legacy: computeHealth: connecting, ok, reconnecting, lost, stale', () => {
    const core = ['health', 'sessions'];
    expect(computeHealth({ records: [], now: NOW, staleAfterMs: STALE, coreNames: core }).connection).toBe(
      'connecting',
    );
    let h = computeHealth({
      records: [rec('health', { lastSuccess: 99000 }), rec('sessions', { lastSuccess: 98000 })],
      now: NOW,
      staleAfterMs: STALE,
      coreNames: core,
    });
    expect(h.connection).toBe('ok');
    expect(h.stale).toBe(false);
    expect(h.ageMs).toBe(2000); // worst case of the two
    h = computeHealth({
      records: [
        rec('health', { lastSuccess: 99000 }),
        rec('sessions', { lastSuccess: 95000, failures: 1, lastError: { message: 'x', t: 96000 } }),
      ],
      now: NOW,
      staleAfterMs: STALE,
      coreNames: core,
    });
    expect(h.connection).toBe('reconnecting');
    expect(h.lastError?.name).toBe('sessions');
    h = computeHealth({
      records: [
        rec('health', { lastSuccess: 50000, failures: 4, lastError: { message: 'x', t: 90000 } }),
        rec('sessions', { lastSuccess: 50000 }),
      ],
      now: NOW,
      staleAfterMs: STALE,
      coreNames: core,
    });
    expect(h.connection).toBe('lost');
    expect(h.stale).toBe(true);
    // never succeeded, three failures: lost
    h = computeHealth({
      records: [rec('config', { failures: 3, lastError: { message: 'x', t: 1 } })],
      now: NOW,
      staleAfterMs: STALE,
      coreNames: ['config'],
    });
    expect(h.connection).toBe('lost');
    // ok but throttled tab: stale without failures
    h = computeHealth({
      records: [rec('health', { lastSuccess: 10000 }), rec('sessions', { lastSuccess: 10000 })],
      now: NOW,
      staleAfterMs: STALE,
      coreNames: core,
    });
    expect(h.connection).toBe('ok');
    expect(h.stale).toBe(true);
  });

  it('legacy: page title uses words, not emoji', () => {
    const counts = countStates([{ state: 'RUNNING' }, { state: 'RUNNING' }, { state: 'FAILED' }, { state: 'x' }]);
    expect(titleFor(t, counts, 'Nightly build', 'ok')).toBe('2 running, 1 failed - Nightly build');
    expect(titleFor(t, countStates([]), 'Nightly build', 'ok')).toBe('Nightly build');
    expect(titleFor(t, counts, 'Nightly build', 'lost')).toBe('Monitor offline - Nightly build');
    expect(titleFor(t, counts, 'Nightly build', 'offline')).toBe('Monitor offline - Nightly build');
    expect(titleFor(t, counts, 'Nightly build', 'live')).toBe('2 running, 1 failed - Nightly build');
  });

  it('normalizeState maps anything unknown to UNKNOWN and reads a state assessment', () => {
    expect(normalizeState('RUNNING')).toBe('RUNNING');
    expect(normalizeState('running')).toBe('UNKNOWN');
    expect(normalizeState(undefined)).toBe('UNKNOWN');
    expect(normalizeState({ legacyState: 'IDLE' })).toBe('IDLE');
    expect(normalizeState({ legacyState: 'nope' })).toBe('UNKNOWN');
    expect(countStates([{ state: { legacyState: 'FAILED' } }, { state: null }])).toEqual({
      RUNNING: 0,
      IDLE: 0,
      COMPLETED: 0,
      FAILED: 1,
      UNKNOWN: 1,
    });
  });
});

describe('computeConnection', () => {
  const base = { now: NOW, staleAfterMs: STALE, online: true };
  const stream = (
    status: StreamStatus,
    over: Partial<{ inSyncAt: number | null; nextRetryAt: number | null }> = {},
  ) => ({
    status,
    inSyncAt: null,
    nextRetryAt: null,
    lastError: null,
    ...over,
  });
  const apiOk = [rec('health', { lastSuccess: 99000 }), rec('sessions', { lastSuccess: 98000 })];
  const apiFailing = [
    rec('health', { lastSuccess: 99000 }),
    rec('sessions', { lastSuccess: 95000, failures: 1, lastError: { message: 'slow', t: 96000 } }),
  ];
  const apiDown = [
    rec('health', { lastSuccess: 50000, failures: 4, lastError: { message: 'refused', t: 90000 } }),
    rec('sessions', { lastSuccess: 50000 }),
  ];

  it('is connecting until an endpoint was touched or the stream opened', () => {
    const v = computeConnection({ ...base, stream: stream('idle'), core: [] });
    expect(v.state).toBe('connecting');
    expect(v.stale).toBe(false);
    expect(v.lastSyncAt).toBeNull();
    expect(v.ageMs).toBeNull();
    expect(v.retryAt).toBeNull();
    expect(v.lastError).toBeNull();
    expect(computeConnection({ ...base, stream: stream('connecting'), core: [rec('instance')] }).state).toBe(
      'connecting',
    );
    expect(computeConnection({ ...base, online: false, stream: stream('idle'), core: [] }).state).toBe('connecting');
  });

  it('matrix: stream open or closed x api ok, failing or down x online', () => {
    const expectations: [string, StreamStatus, EndpointRecord[], boolean, ConnectionState][] = [
      ['open, api ok', 'open', apiOk, true, 'live'],
      ['open, api failing', 'open', apiFailing, true, 'live'],
      ['open, api down', 'open', apiDown, true, 'offline'],
      ['backoff, api ok', 'backoff', apiOk, true, 'polling'],
      ['backoff, api failing', 'backoff', apiFailing, true, 'reconnecting'],
      ['backoff, api down', 'backoff', apiDown, true, 'offline'],
      ['connecting, api ok', 'connecting', apiOk, true, 'polling'],
      ['stopped, api ok', 'stopped', apiOk, true, 'polling'],
      ['idle, api failing', 'idle', apiFailing, true, 'reconnecting'],
      ['open, api ok, browser offline', 'open', apiOk, false, 'offline'],
      ['backoff, api ok, browser offline', 'backoff', apiOk, false, 'offline'],
      ['backoff, api down, browser offline', 'backoff', apiDown, false, 'offline'],
    ];
    for (const [name, status, core, online, expected] of expectations) {
      const v = computeConnection({ ...base, online, stream: stream(status, { inSyncAt: 99500 }), core });
      expect(v.state, name).toBe(expected);
    }
  });

  it('live and in sync is fresh; the last sync time is the stream sync time', () => {
    const v = computeConnection({ ...base, stream: stream('open', { inSyncAt: 99000 }), core: apiOk });
    expect(v.state).toBe('live');
    expect(v.stale).toBe(false);
    expect(v.lastSyncAt).toBe(99000);
    expect(v.ageMs).toBe(1000);
  });

  it('a stream that is open but not in sync becomes stale once the core data is old', () => {
    const oldCore = [rec('health', { lastSuccess: 70000 }), rec('sessions', { lastSuccess: 60000 })];
    const v = computeConnection({ ...base, stream: stream('open', { inSyncAt: null }), core: oldCore });
    expect(v.state).toBe('live');
    expect(v.lastSyncAt).toBe(60000);
    expect(v.stale).toBe(true);
  });

  it('polling with fresh polls is not stale; the age is the oldest core success', () => {
    const v = computeConnection({ ...base, stream: stream('backoff'), core: apiOk });
    expect(v.state).toBe('polling');
    expect(v.lastSyncAt).toBe(98000);
    expect(v.ageMs).toBe(2000);
    expect(v.stale).toBe(false);
  });

  it('polling with a throttled tab is stale without any failure', () => {
    const old = [rec('health', { lastSuccess: 10000 }), rec('sessions', { lastSuccess: 10000 })];
    const v = computeConnection({ ...base, stream: stream('stopped'), core: old });
    expect(v.state).toBe('polling');
    expect(v.stale).toBe(true);
  });

  it('server killed: offline, stale, last error from the failing endpoint', () => {
    const v = computeConnection({
      ...base,
      stream: stream('backoff', { inSyncAt: 55000, nextRetryAt: 108000 }),
      core: apiDown,
    });
    expect(v.state).toBe('offline');
    expect(v.stale).toBe(true);
    expect(v.lastSyncAt).toBe(55000);
    expect(v.retryAt).toBe(108000);
    expect(v.lastError).toEqual({ source: 'health', message: 'refused', t: 90000 });
  });

  it('the newest error of several failing endpoints wins', () => {
    const core = [
      rec('health', { lastSuccess: 99000, failures: 1, lastError: { message: 'older', t: 96000 } }),
      rec('sessions', { lastSuccess: 99000, failures: 1, lastError: { message: 'newer', t: 98000 } }),
    ];
    const v = computeConnection({ ...base, stream: stream('backoff'), core });
    expect(v.lastError).toEqual({ source: 'sessions', message: 'newer', t: 98000 });
  });

  it('never succeeded with three failures is offline', () => {
    const core = [rec('instance', { failures: 3, lastError: { message: 'x', t: 1 } })];
    const v = computeConnection({ ...base, stream: stream('idle'), core });
    expect(v.state).toBe('offline');
    expect(v.lastSyncAt).toBeNull();
    expect(v.stale).toBe(false);
  });
});

describe('computeIngestionView', () => {
  const health = (status: 'ok' | 'degraded' | 'stalled' | 'down' | 'disabled' | 'unknown', reasons: string[] = []) => ({
    ingestion: { status, reasons },
  });
  const liveView = (state: ConnectionState) => ({
    state,
    stale: false,
    lastSyncAt: NOW,
    ageMs: 0,
    retryAt: null,
    lastError: null,
  });

  it('is unknown and not known when health never arrived', () => {
    expect(computeIngestionView(undefined, null, liveView('live'), NOW, STALE)).toEqual({
      display: 'unknown',
      reasons: [],
      lastKnown: null,
      asOf: null,
      known: false,
    });
  });

  it('shows the reported status when the connection is live or polling and the health poll is fresh', () => {
    const record = rec('health', { lastSuccess: NOW - 1000 });
    const v = computeIngestionView(
      health('degraded', ['12 hook envelopes rejected in the last hour']),
      record,
      liveView('live'),
      NOW,
      STALE,
    );
    expect(v).toEqual({
      display: 'degraded',
      reasons: ['12 hook envelopes rejected in the last hour'],
      lastKnown: null,
      asOf: NOW - 1000,
      known: true,
    });
    expect(computeIngestionView(health('ok'), record, liveView('polling'), NOW, STALE).display).toBe('ok');
    expect(computeIngestionView(health('disabled'), record, liveView('live'), NOW, STALE).display).toBe('disabled');
  });

  it('falls back to unknown with the last known status and its age when the connection is lost', () => {
    const record = rec('health', { lastSuccess: NOW - 40000 });
    const v = computeIngestionView(health('ok'), record, liveView('offline'), NOW, STALE);
    expect(v.display).toBe('unknown');
    expect(v.known).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.lastKnown).toEqual({ status: 'ok', ageSeconds: 40 });
    expect(v.asOf).toBe(NOW - 40000);
  });

  it('a stale health poll is unknown even while the connection is live', () => {
    const record = rec('health', { lastSuccess: NOW - 30000 });
    const v = computeIngestionView(health('stalled'), record, liveView('live'), NOW, STALE);
    expect(v.display).toBe('unknown');
    expect(v.reasons).toEqual([]);
    expect(v.lastKnown).toEqual({ status: 'stalled', ageSeconds: 30 });
  });

  it('without a health record or success the status text has no age', () => {
    const v = computeIngestionView(health('down'), null, liveView('live'), NOW, STALE);
    expect(v).toEqual({
      display: 'unknown',
      reasons: [],
      lastKnown: { status: 'down', ageSeconds: null },
      asOf: null,
      known: false,
    });
    const never = computeIngestionView(health('down'), rec('health'), liveView('live'), NOW, STALE);
    expect(never.known).toBe(false);
  });
});
