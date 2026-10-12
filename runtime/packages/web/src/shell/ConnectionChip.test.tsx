import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { EndpointRecord } from '../lib/connection-health.ts';
import { describeFreshness, type Freshness } from '../stream/freshness.ts';
import { makeHealth } from '../test/fixtures/index.ts';
import { ConnectionChip } from './ConnectionChip.tsx';

// The table of 04 5.6 "What the user sees": one row per connection state and stale flag. The words and tones are produced by
// `describeFreshness` (freshness.test.ts); this file proves the chip shows them with an icon and a word (UI-I8).
const NOW = 1_000_000;
const STALE_AFTER = 30_000;

function record(name: string, lastSuccess: number | null, failures = 0): EndpointRecord {
  return {
    name,
    lastSuccess,
    failures,
    lastError: failures === 0 ? null : { message: 'FIXTURE failure', t: NOW - 1000 },
  };
}

function freshness(o: {
  streamOpen?: boolean;
  syncedAgo?: number;
  failures?: number;
  online?: boolean;
  nextRetryIn?: number | null;
  touched?: boolean;
}): Freshness {
  const touched = o.touched ?? true;
  const syncedAt = NOW - (o.syncedAgo ?? 0);
  return describeFreshness({
    now: NOW,
    staleAfterMs: STALE_AFTER,
    online: o.online ?? true,
    pollSeconds: 6,
    stream: {
      status: o.streamOpen === true ? 'open' : o.nextRetryIn === undefined ? 'idle' : 'backoff',
      inSyncAt: o.streamOpen === true ? syncedAt : null,
      nextRetryAt: o.nextRetryIn === undefined || o.nextRetryIn === null ? null : NOW + o.nextRetryIn,
      lastError: null,
    },
    core: touched ? [record('instance', syncedAt), record('health', syncedAt, o.failures ?? 0)] : [],
    health: makeHealth('ok'),
    healthRecord: touched ? record('health', syncedAt) : null,
  });
}

function show(f: Freshness): HTMLElement {
  render(<ConnectionChip view={f.connection} chip={f.connectionChip} />);
  const chip = screen.getByText(f.connectionChip.text).closest<HTMLElement>('.chip');
  if (chip === null) throw new Error('no chip');
  return chip;
}

describe('ConnectionChip', () => {
  const cases: {
    name: string;
    given: Parameters<typeof freshness>[0];
    state: string;
    text: string;
    tone: string;
    icon: string;
  }[] = [
    {
      name: 'connecting',
      given: { touched: false },
      state: 'connecting',
      text: 'Connecting...',
      tone: 'idle',
      icon: 'loader',
    },
    { name: 'live', given: { streamOpen: true }, state: 'live', text: 'Live', tone: 'ok', icon: 'wifi' },
    {
      name: 'live and not in sync',
      given: { streamOpen: true, syncedAgo: 31_000 },
      state: 'live',
      text: 'Live, waiting for data',
      tone: 'stale',
      icon: 'clock',
    },
    {
      name: 'polling',
      given: {},
      state: 'polling',
      text: 'Live updates paused, refreshing every 6s',
      tone: 'stale',
      icon: 'refresh',
    },
    {
      name: 'polling and stale',
      given: { syncedAgo: 31_000 },
      state: 'polling',
      text: 'Refresh failing',
      tone: 'stale',
      icon: 'clock',
    },
    {
      name: 'reconnecting',
      given: { failures: 1, nextRetryIn: 8_000 },
      state: 'reconnecting',
      text: 'Reconnecting (retry in 8s)',
      tone: 'stale',
      icon: 'refresh',
    },
    {
      name: 'offline (server down)',
      given: { failures: 3, syncedAgo: 40_000, nextRetryIn: 8_000 },
      state: 'offline',
      text: 'Connection lost (retry in 8s)',
      tone: 'failed',
      icon: 'wifi-off',
    },
    {
      name: 'offline (browser)',
      given: { online: false },
      state: 'offline',
      text: 'Offline',
      tone: 'failed',
      icon: 'wifi-off',
    },
  ];

  it.each(cases)('shows $name: $text', ({ given, state, text, tone }) => {
    const chip = show(freshness(given));
    expect(chip).toHaveTextContent(text);
    expect(chip).toHaveAttribute('data-status', state);
    expect(chip).toHaveClass(`tone-${tone}`);
    expect(chip).toHaveAttribute('title', text);
  });

  it.each(cases)('$name has an icon next to the words (never colour only)', ({ given }) => {
    const chip = show(freshness(given));
    const icon = chip.querySelector('svg.icon');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses the loader icon only while connecting', () => {
    const connecting = show(freshness({ touched: false }));
    expect(connecting.querySelector('svg')).toHaveClass('lucide-loader-circle');
  });

  it('is plain text, not a button or a link (the refresh button lives next to it)', () => {
    const chip = show(freshness({ streamOpen: true }));
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
