import type { HealthReport } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { createCatalogues, createT } from '../i18n/translate.ts';
import type { EndpointRecord, StreamHealthInput } from '../lib/connection-health.ts';
import { makeHealth } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import {
  chipText,
  connectionChip,
  describeFreshness,
  freshnessAnnouncements,
  ingestionChip,
  liveSummary,
  staleLine,
  type ChipView,
  type DescribeFreshnessInput,
  type Freshness,
} from './freshness.ts';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const STALE_AFTER = 15_000;
const POLL_SECONDS = 6;

const catalogues = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
const t = createT('en', catalogues);
const format = createFormatters('en');
const words = (chip: ChipView): string => chipText(t, chip);

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

/** The server was killed 40 s ago: the stream is in backoff and the health poll keeps failing. */
function killed(): Freshness {
  return describeIt({
    stream: stream({ status: 'backoff', inSyncAt: NOW - 60_000, nextRetryAt: NOW + 8_000, lastError: 'stream error' }),
    core: [record({ lastSuccess: NOW - 40_000, failures: 4, lastError: { message: 'fetch failed', t: NOW - 1_000 } })],
  });
}

describe('combined matrix of 04 5.6', () => {
  it('server up, stream open, hooks delivering: Live, Ingestion OK, no stale marker', () => {
    const f = describeIt();
    expect(f.connectionChip).toMatchObject({ textKey: 'live.conn.live', tone: 'ok', icon: 'wifi' });
    expect(words(f.connectionChip)).toBe(msg('live.conn.live'));
    expect(f.ingestionChip).toMatchObject({ textKey: 'live.ingest.ok', tone: 'ok', icon: 'check' });
    expect(f.staleLine).toBeNull();
    expect(f.connection.stale).toBe(false);
    expect(f.live).toEqual({ source: 'connection', textKey: 'live.bar.live', tone: 'ok' });
  });

  it('stream open, spool errors repeated: Live, Ingestion degraded with the reason, no stale marker', () => {
    const reason = '12 hook envelopes rejected in the last hour';
    const f = describeIt({ health: health('degraded', [reason]) });
    expect(words(f.connectionChip)).toBe(msg('live.conn.live'));
    expect(f.ingestionChip).toMatchObject({ textKey: 'live.ingest.degraded', tone: 'stale', icon: 'alert' });
    expect(f.ingestion.reasons).toEqual([reason]);
    expect(f.staleLine).toBeNull();
    // The Live control takes the colour and the word of the worse signal.
    expect(f.live).toEqual({ source: 'ingestion', textKey: 'live.bar.ingestionDegraded', tone: 'stale' });
  });

  it('stream open, transcript import lagging: Live, Ingestion degraded, no stale marker', () => {
    const f = describeIt({ health: health('degraded', ['transcript import 90 s behind']) });
    expect(words(f.connectionChip)).toBe(msg('live.conn.live'));
    expect(f.ingestion.reasons[0]).toBe('transcript import 90 s behind');
    expect(f.staleLine).toBeNull();
  });

  it('stream blocked by a proxy, API works: Live updates paused, refreshing every 6s, ingestion from polled health', () => {
    const f = describeIt({ stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 8_000 }) });
    expect(f.connection.state).toBe('polling');
    expect(f.connectionChip).toMatchObject({
      textKey: 'live.conn.polling',
      args: { seconds: 6 },
      tone: 'stale',
      icon: 'refresh',
    });
    expect(words(f.connectionChip)).toBe(msg('live.conn.polling', { seconds: 6 }));
    expect(words(f.ingestionChip)).toBe(msg('live.ingest.ok'));
    expect(f.staleLine).toBeNull();
    expect(f.live).toEqual({ source: 'connection', textKey: 'live.bar.paused', tone: 'stale' });
  });

  it('server killed: Connection lost (retry in 8s), Ingestion unknown with the last known state, stale marker with the age', () => {
    const f = killed();
    expect(f.connection.state).toBe('offline');
    expect(f.connectionChip).toMatchObject({
      textKey: 'live.conn.lostRetry',
      args: { seconds: 8 },
      tone: 'failed',
      icon: 'wifi-off',
    });
    expect(f.ingestionChip).toMatchObject({ textKey: 'live.ingest.unknown', tone: 'unknown' });
    expect(f.ingestion.lastKnown).toEqual({ status: 'ok', ageSeconds: 40 });
    expect(f.connection.stale).toBe(true);
    expect(f.staleLine).toEqual({ lastSyncAt: NOW - 40_000, ageSeconds: 40 });
    expect(f.live).toEqual({ source: 'connection', textKey: 'live.bar.lost', tone: 'failed' });
  });

  it('laptop offline: Offline, Ingestion unknown, stale marker once the data is old', () => {
    const f = describeIt({
      online: false,
      stream: stream({ status: 'backoff', inSyncAt: NOW - 25_000, nextRetryAt: null }),
      core: [record({ lastSuccess: NOW - 20_000 })],
    });
    expect(f.connectionChip).toMatchObject({ textKey: 'live.conn.offline', tone: 'failed', icon: 'wifi-off' });
    expect(f.ingestionChip.textKey).toBe('live.ingest.unknown');
    expect(f.staleLine).toEqual({ lastSyncAt: NOW - 20_000, ageSeconds: 20 });
    expect(f.live).toEqual({ source: 'connection', textKey: 'live.bar.offline', tone: 'failed' });
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
    expect(chip).toMatchObject({ textKey: 'live.conn.connecting', tone: 'idle', icon: 'loader' });
  });

  it('live and stale: Live, waiting for data', () => {
    const chip = view({ stream: stream({ inSyncAt: NOW - 20_000 }), core: [record({ lastSuccess: NOW - 20_000 })] });
    expect(chip).toMatchObject({ textKey: 'live.conn.liveWaiting', tone: 'stale', icon: 'clock' });
  });

  it('polling and stale: Refresh failing', () => {
    const chip = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 2_000 }),
      core: [record({ lastSuccess: NOW - 20_000 })],
    });
    expect(chip).toMatchObject({ textKey: 'live.conn.pollingFailing', tone: 'stale', icon: 'clock' });
  });

  it('reconnecting: Reconnecting (retry in Ns)', () => {
    const chip = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 2_500 }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(chip).toMatchObject({
      textKey: 'live.conn.reconnectingRetry',
      args: { seconds: 3 },
      tone: 'stale',
      icon: 'refresh',
    });
  });

  it('without a retry time the text has no countdown, and the countdown never goes negative', () => {
    const noRetry = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: null }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(noRetry).toMatchObject({ textKey: 'live.conn.reconnecting', args: null });
    const late = view({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW - 500 }),
      core: [record({ lastSuccess: NOW - 5_000, failures: 1 })],
    });
    expect(late).toMatchObject({ textKey: 'live.conn.reconnectingRetry', args: { seconds: 0 } });
  });

  it('connectionChip is a pure function of the view', () => {
    const f = describeIt();
    expect(connectionChip(f.connection, { now: NOW, online: true, pollSeconds: 6 })).toEqual(f.connectionChip);
  });

  it('every text is a catalogue key: the Vietnamese words differ from the English ones', () => {
    const f = killed();
    expect(chipText(createT('vi', catalogues), f.connectionChip)).toBe(
      msg('live.conn.lostRetry', { seconds: 8 }, 'vi'),
    );
    expect(chipText(createT('vi', catalogues), f.connectionChip)).not.toBe(words(f.connectionChip));
  });
});

describe('ingestion chip, one row each', () => {
  const chipFor = (status: HealthReport['ingestion']['status'], reasons: string[] = []) =>
    describeIt({ health: health(status, reasons) }).ingestionChip;

  it('ok', () => {
    expect(chipFor('ok')).toEqual({ textKey: 'live.ingest.ok', args: null, tone: 'ok', icon: 'check' });
  });
  it('degraded keeps the reasons in the view, not in the chip', () => {
    const f = describeIt({ health: health('degraded', ['first', 'second']) });
    expect(f.ingestionChip).toMatchObject({ textKey: 'live.ingest.degraded', tone: 'stale', icon: 'alert' });
    expect(f.ingestion.reasons).toEqual(['first', 'second']);
  });
  it('stalled', () => {
    expect(chipFor('stalled', ['no data for 10 min'])).toMatchObject({
      textKey: 'live.ingest.stalled',
      tone: 'failed',
    });
  });
  it('down', () => {
    expect(chipFor('down')).toMatchObject({ textKey: 'live.ingest.down', tone: 'failed' });
  });
  it('disabled', () => {
    expect(chipFor('disabled')).toMatchObject({ textKey: 'live.ingest.disabled', tone: 'idle' });
  });
  it('unknown without any health report', () => {
    const f = describeIt({ health: undefined });
    expect(f.ingestionChip).toMatchObject({ textKey: 'live.ingest.unknown', tone: 'unknown' });
    expect(f.ingestion.lastKnown).toBeNull();
  });
  it('ingestionChip is a pure function of the view', () => {
    const f = describeIt();
    expect(ingestionChip(f.ingestion)).toEqual(f.ingestionChip);
  });
});

describe('the Live control: the worse of the two signals', () => {
  it('connection wins a tie and the ingestion wins only when it is worse', () => {
    // Connection polling (stale tone) and ingestion degraded (stale tone): a tie, the connection speaks.
    const tie = describeIt({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 8_000 }),
      health: health('degraded', ['r']),
    });
    expect(tie.live).toMatchObject({ source: 'connection', textKey: 'live.bar.paused' });
    // Connection polling (stale) and ingestion stalled (failed): the ingestion is worse.
    const worse = describeIt({
      stream: stream({ status: 'backoff', inSyncAt: null, nextRetryAt: NOW + 8_000 }),
      health: health('stalled', ['r']),
    });
    expect(worse.live).toEqual({ source: 'ingestion', textKey: 'live.bar.ingestionStalled', tone: 'failed' });
  });

  it('never claims OK while the client is not in sync', () => {
    for (const f of [killed(), describeIt({ online: false })]) {
      expect(f.ingestion.known).toBe(false);
      expect(f.live.textKey).not.toBe('live.bar.live');
      expect(f.live.tone).not.toBe('ok');
    }
  });

  it('says only "Connecting" while the client connects, although the ingestion is unknown', () => {
    const f = describeIt({
      core: [],
      healthRecord: null,
      stream: stream({ status: 'idle', inSyncAt: null }),
      health: undefined,
    });
    expect(f.live).toEqual({ source: 'connection', textKey: 'live.bar.connecting', tone: 'idle' });
  });

  it('a live connection with no health report is "Ingestion unknown"', () => {
    const f = describeIt({ health: undefined });
    expect(f.live).toEqual({ source: 'ingestion', textKey: 'live.bar.ingestionUnknown', tone: 'unknown' });
  });

  it('hooks switched off is not a problem: the connection speaks', () => {
    expect(describeIt({ health: health('disabled') }).live).toMatchObject({ source: 'connection', tone: 'ok' });
  });

  it('liveSummary is a pure function of the views', () => {
    const f = describeIt({ health: health('down') });
    expect(
      liveSummary(
        f.connection,
        f.ingestion,
        { connection: f.connectionChip.tone, ingestion: f.ingestionChip.tone },
        true,
      ),
    ).toEqual(f.live);
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
    expect(staleLine(f.connection, NOW)).toEqual({ lastSyncAt: NOW - 30_000, ageSeconds: 30 });
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
  const announce = (prev: Freshness | null, next: Freshness, locale: 'en' | 'vi' = 'en') =>
    freshnessAnnouncements(prev, next, NOW, createT(locale, catalogues), createFormatters(locale));

  it('says nothing on the first computation or when nothing moved', () => {
    expect(announce(null, fresh())).toEqual([]);
    expect(announce(fresh(), fresh())).toEqual([]);
  });

  it('Connection lost and Connection restored', () => {
    expect(announce(fresh(), lost())).toContain(msg('freshness.announce.lost'));
    expect(announce(lost(), fresh())).toContain(msg('freshness.announce.restored'));
    expect(announce(lost(), paused())).toContain(msg('freshness.announce.restored'));
  });

  it('Live updates paused when the stream gives way to polling', () => {
    expect(announce(fresh(), paused())).toEqual([msg('freshness.announce.paused')]);
  });

  it('Data is stale and Data up to date', () => {
    expect(announce(fresh(), stale())).toEqual([msg('freshness.announce.stale', { age: format.age(20) })]);
    expect(announce(stale(), fresh())).toEqual([msg('freshness.announce.upToDate')]);
  });

  it('Ingestion degraded with the reason and Ingestion recovered', () => {
    expect(announce(fresh(), degraded())).toEqual([msg('freshness.announce.degraded', { reason: 'spool is full' })]);
    expect(announce(degraded(), fresh())).toEqual([msg('freshness.announce.recovered')]);
    expect(announce(down(), fresh())).toEqual([msg('freshness.announce.recovered')]);
  });

  it('does not announce an ingestion change while the client does not know it (unknown is not recovered)', () => {
    expect(announce(degraded(), lost())).not.toContain(msg('freshness.announce.recovered'));
    expect(announce(lost(), degraded())).not.toContain(msg('freshness.announce.recovered'));
  });

  it('speaks the language that is shown', () => {
    expect(announce(fresh(), lost(), 'vi')).toContain(msg('freshness.announce.lost', undefined, 'vi'));
  });
});
