import type { HealthReport } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { EndpointRecord, StreamHealthInput } from '../lib/connection-health.ts';
import { makeHealth } from '../test/fixtures/index.ts';
import {
  connectionChip,
  describeFreshness,
  freshnessAnnouncements,
  ingestionChip,
  staleLine,
  type DescribeFreshnessInput,
  type Freshness,
} from './freshness.ts';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const STALE_AFTER = 15_000;
const POLL_SECONDS = 6;

function record(over: Partial<EndpointRecord> = {}): EndpointRecord {
  return { name: 'health', lastSuccess: NOW - 1_000, failures: 0, lastError: null, ...over };
}

function stream(over: Partial<StreamHealthInput> = {}): StreamHealthInput {
  return { status: 'open', inSyncAt: NOW - 1_000, nextRetryAt: null, lastError: null, ...over };
}

function health(status: HealthReport['ingestion']['status'], reasons: string[] = []): HealthReport {
  const base = makeHealth('ok');
  return { ...base, ingestion: { ...base.ingestion, status, reasons } };
}

function describeIt(over: Partial<DescribeFreshnessInput> = {}): Freshness {
  const core = over.core ?? [record()];
  return describeFreshness({
    now: NOW,
    staleAfterMs: STALE_AFTER,
    online: true,
    pollSeconds: POLL_SECONDS,
    stream: stream(),
    core,
    health: health('ok'),
    healthRecord: core[0] ?? null,
    ...over,
  });
}

describe('combined matrix of 04 5.6', () => {
  it('server up, stream open, hooks delivering: Live, Ingestion OK, no stale marker', () => {
    const f = describeIt();
    expect(f.connectionChip).toMatchObject({ text: 'Live', tone: 'ok', icon: 'wifi' });
    expect(f.ingestionChip).toMatchObject({ text: 'Ingestion OK', tone: 'ok', icon: 'check' });
    expect(f.staleLine).toBeNull();
    expect(f.connection.stale).toBe(false);
  });

  it('stream open, spool errors repeated: Live, Ingestion degraded with the reason, no stale marker', () => {
    const reason = '12 hook envelopes rejected in the last hour';
    const f = describeIt({ health: health('degraded', [reason]) });
    expect(f.connectionChip.text).toBe('Live');
    expect(f.ingestionChip).toMatchObject({ text: 'Ingestion degraded', tone: 'stale', icon: 'alert', detail: reason });
    expect(f.ingestionChip.title).toContain(reason);
    expect(f.staleLine).toBeNull();
  });

  it('stream open, transcript import lagging: Live, Ingestion degraded, no stale marker', () => {
    const f = describeIt({ health: health('degraded', ['transcript import 90 s behind']) });
    expect(f.connectionChip.text).toBe('Live');
    expect(f.ingestionChip.detail).toBe('transcript import 90 s behind');
    expect(f.staleLine).toBeNull();
  });

  it('stream blocked by a proxy, API works: Live updates paused, refreshing every 6s, ingestion from polled health', () => {
    const f = describeIt({ stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 8_000 }) });
    expect(f.connection.state).toBe('polling');
    expect(f.connectionChip).toMatchObject({
      text: 'Live updates paused, refreshing every 6s',
      tone: 'stale',
      icon: 'refresh',
    });
    expect(f.ingestionChip.text).toBe('Ingestion OK');
    expect(f.staleLine).toBeNull();
  });

  it('server killed: Connection lost (retry in 8s), Ingestion unknown with the last known state, stale marker with the age', () => {
    const f = describeIt({
      stream: stream({
        status: 'backoff',
        inSyncAt: NOW - 60_000,
        nextRetryAt: NOW + 8_000,
        lastError: 'stream error',
      }),
      core: [
        record({ lastSuccess: NOW - 40_000, failures: 4, lastError: { message: 'fetch failed', t: NOW - 1_000 } }),
      ],
    });
    expect(f.connection.state).toBe('offline');
    expect(f.connectionChip).toMatchObject({ text: 'Connection lost (retry in 8s)', tone: 'failed', icon: 'wifi-off' });
    expect(f.ingestionChip).toMatchObject({ text: 'Ingestion unknown', tone: 'unknown' });
    expect(f.ingestionChip.detail).toBe('Last known: ok, 40s ago');
    expect(f.connection.stale).toBe(true);
    expect(f.staleLine).toBe('as of 11:59:20 (40s ago)');
  });

  it('laptop offline: Offline, Ingestion unknown, stale marker once the data is old', () => {
    const f = describeIt({
      online: false,
      stream: stream({ status: 'backoff', inSyncAt: NOW - 25_000, nextRetryAt: null }),
      core: [record({ lastSuccess: NOW - 20_000 })],
    });
    expect(f.connectionChip).toMatchObject({ text: 'Offline', tone: 'failed', icon: 'wifi-off' });
    expect(f.ingestionChip.text).toBe('Ingestion unknown');
    expect(f.staleLine).toBe('as of 11:59:40 (20s ago)');
  });
});

describe('connection chip, one row of the table each', () => {
  const view = (over: Partial<DescribeFreshnessInput> = {}) => describeIt(over).connectionChip;

  it('connecting', () => {
    const chip = view({
      core: [],
      healthRecord: null,
      stream: stream({ status: 'idle', inSyncAt: null }),
      health: undefined,
    });
    expect(chip).toMatchObject({ text: 'Connecting...', tone: 'idle', icon: 'loader' });
  });

  it('live and stale: Live, waiting for data', () => {
    const chip = view({ stream: stream({ inSyncAt: NOW - 20_000 }), core: [record({ lastSuccess: NOW - 20_000 })] });
    expect(chip).toMatchObject({ text: 'Live, waiting for data', tone: 'stale', icon: 'clock' });
  });

  it('polling and stale: Refresh failing', () => {
    const chip = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 2_000 }),
      core: [record({ lastSuccess: NOW - 20_000 })],
    });
    expect(chip).toMatchObject({ text: 'Refresh failing', tone: 'stale', icon: 'clock' });
  });

  it('reconnecting: Reconnecting (retry in Ns)', () => {
    const chip = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 2_500 }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(chip).toMatchObject({ text: 'Reconnecting (retry in 3s)', tone: 'stale', icon: 'refresh' });
  });

  it('without a retry time the text has no countdown, and the countdown never goes negative', () => {
    const noRetry = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: null }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(noRetry.text).toBe('Reconnecting');
    const late = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW - 500 }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(late.text).toBe('Reconnecting (retry in 0s)');
  });

  it('connectionChip is a pure function of the view', () => {
    const f = describeIt();
    expect(connectionChip(f.connection, { now: NOW, online: true, pollSeconds: 6 })).toEqual(f.connectionChip);
  });
});

describe('ingestion chip, one row each', () => {
  const chipFor = (status: HealthReport['ingestion']['status'], reasons: string[] = []) =>
    describeIt({ health: health(status, reasons) }).ingestionChip;

  it('ok', () => {
    expect(chipFor('ok')).toMatchObject({ text: 'Ingestion OK', tone: 'ok', icon: 'check', detail: null });
  });
  it('degraded shows the first reason', () => {
    expect(chipFor('degraded', ['first', 'second'])).toMatchObject({
      text: 'Ingestion degraded',
      tone: 'stale',
      icon: 'alert',
      detail: 'first',
    });
  });
  it('stalled', () => {
    expect(chipFor('stalled', ['no data for 10 min'])).toMatchObject({ text: 'Ingestion stalled', tone: 'failed' });
  });
  it('down', () => {
    expect(chipFor('down')).toMatchObject({ text: 'Ingestion down', tone: 'failed' });
  });
  it('disabled', () => {
    expect(chipFor('disabled')).toMatchObject({ text: 'Hooks off: transcripts only', tone: 'idle' });
  });
  it('unknown without any health report', () => {
    const f = describeIt({ health: undefined });
    expect(f.ingestionChip).toMatchObject({ text: 'Ingestion unknown', tone: 'unknown', detail: null });
  });
  it('ingestionChip is a pure function of the view', () => {
    const f = describeIt();
    expect(ingestionChip(f.ingestion)).toEqual(f.ingestionChip);
  });
});

describe('stale line', () => {
  it('is null until the data is older than staleAfterMs and never before the first sync', () => {
    expect(describeIt().staleLine).toBeNull();
    const none = describeIt({ core: [], healthRecord: null, stream: stream({ status: 'idle', inSyncAt: null }) });
    expect(none.staleLine).toBeNull();
    expect(
      describeIt({ stream: stream({ inSyncAt: NOW - 15_000 }), core: [record({ lastSuccess: NOW - 15_000 })] })
        .staleLine,
    ).toBeNull();
    expect(
      describeIt({ stream: stream({ inSyncAt: NOW - 15_001 }), core: [record({ lastSuccess: NOW - 15_001 })] })
        .staleLine,
    ).not.toBeNull();
  });

  it('staleLine is a pure function of the view', () => {
    const f = describeIt({ stream: stream({ inSyncAt: NOW - 30_000 }), core: [record({ lastSuccess: NOW - 30_000 })] });
    expect(staleLine(f.connection, NOW)).toBe('as of 11:59:30 (30s ago)');
  });
});

describe('announcements (polite, once per transition)', () => {
  const fresh = () => describeIt();
  const lost = () =>
    describeIt({
      stream: stream({ status: 'backoff', inSyncAt: NOW - 60_000, nextRetryAt: NOW + 8_000 }),
      core: [record({ lastSuccess: NOW - 40_000, failures: 4 })],
    });
  const paused = () => describeIt({ stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 8_000 }) });
  const stale = () =>
    describeIt({ stream: stream({ inSyncAt: NOW - 20_000 }), core: [record({ lastSuccess: NOW - 20_000 })] });
  const degraded = () => describeIt({ health: health('degraded', ['spool is full']) });
  const down = () => describeIt({ health: health('down') });

  it('says nothing on the first computation or when nothing moved', () => {
    expect(freshnessAnnouncements(null, fresh(), NOW)).toEqual([]);
    expect(freshnessAnnouncements(fresh(), fresh(), NOW)).toEqual([]);
  });

  it('Connection lost and Connection restored', () => {
    expect(freshnessAnnouncements(fresh(), lost(), NOW)).toContain('Connection lost');
    expect(freshnessAnnouncements(lost(), fresh(), NOW)).toContain('Connection restored');
    expect(freshnessAnnouncements(lost(), paused(), NOW)).toContain('Connection restored');
  });

  it('Live updates paused when the stream gives way to polling', () => {
    expect(freshnessAnnouncements(fresh(), paused(), NOW)).toEqual(['Live updates paused']);
  });

  it('Data is stale and Data up to date', () => {
    expect(freshnessAnnouncements(fresh(), stale(), NOW)).toEqual(['Data is stale: no update for 20s']);
    expect(freshnessAnnouncements(stale(), fresh(), NOW)).toEqual(['Data up to date']);
  });

  it('Ingestion degraded with the reason and Ingestion recovered', () => {
    expect(freshnessAnnouncements(fresh(), degraded(), NOW)).toEqual(['Ingestion degraded: spool is full']);
    expect(freshnessAnnouncements(degraded(), fresh(), NOW)).toEqual(['Ingestion recovered']);
    expect(freshnessAnnouncements(down(), fresh(), NOW)).toEqual(['Ingestion recovered']);
  });

  it('does not announce an ingestion change while the client does not know it (unknown is not recovered)', () => {
    expect(freshnessAnnouncements(degraded(), lost(), NOW)).not.toContain('Ingestion recovered');
    expect(freshnessAnnouncements(lost(), degraded(), NOW)).not.toContain('Ingestion recovered');
  });
});
