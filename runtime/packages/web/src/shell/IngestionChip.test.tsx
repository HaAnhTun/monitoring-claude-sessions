import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { EndpointRecord, IngestionHealthInput } from '../lib/connection-health.ts';
import { describeFreshness, type Freshness } from '../stream/freshness.ts';
import { renderWithProviders } from '../test/render.tsx';
import { IngestionChip } from './IngestionChip.tsx';

// Ingestion is what the server says (`/health`), never inferred from the stream, and it reads "unknown" whenever the client is
// not in sync (UI-I4, ADR 0033). Chip table of 04 5.6.
const NOW = 1_000_000;
const STALE_AFTER = 30_000;

function record(name: string, lastSuccess: number | null): EndpointRecord {
  return { name, lastSuccess, failures: 0, lastError: null };
}

function health(status: IngestionHealthInput['ingestion']['status'], reasons: string[] = []): IngestionHealthInput {
  return { ingestion: { status, reasons } };
}

function freshness(
  input: IngestionHealthInput | undefined,
  o: { syncedAgo?: number; streamOpen?: boolean } = {},
): Freshness {
  const syncedAt = NOW - (o.syncedAgo ?? 0);
  return describeFreshness({
    now: NOW,
    staleAfterMs: STALE_AFTER,
    online: true,
    pollSeconds: 6,
    stream: {
      status: o.streamOpen === false ? 'idle' : 'open',
      inSyncAt: o.streamOpen === false ? null : syncedAt,
      nextRetryAt: null,
      lastError: null,
    },
    core: [record('instance', syncedAt), record('health', syncedAt)],
    health: input,
    healthRecord: input === undefined ? null : record('health', syncedAt),
  });
}

function show(f: Freshness): HTMLElement {
  renderWithProviders(<IngestionChip view={f.ingestion} chip={f.ingestionChip} />);
  return screen.getByRole('link');
}

describe('IngestionChip', () => {
  it('shows OK with a check icon and no detail', () => {
    const chip = show(freshness(health('ok')));
    expect(chip).toHaveTextContent('Ingestion OK');
    expect(chip).toHaveClass('tone-ok');
    expect(chip).toHaveAttribute('data-status', 'ok');
    expect(chip.querySelector('.chip__detail')).toBeNull();
  });

  it('shows degraded with the first reason as visible text and every reason in the title', () => {
    const chip = show(freshness(health('degraded', ['12 hook envelopes rejected in the last hour', 'second reason'])));
    expect(chip).toHaveTextContent('Ingestion degraded');
    expect(chip).toHaveClass('tone-stale');
    expect(chip.querySelector('.chip__detail')).toHaveTextContent('12 hook envelopes rejected in the last hour');
    expect(chip).toHaveAttribute(
      'title',
      'Ingestion degraded: 12 hook envelopes rejected in the last hour; second reason',
    );
  });

  it.each([
    ['stalled', 'Ingestion stalled'],
    ['down', 'Ingestion down'],
  ] as const)('shows %s in the failed tone', (status, text) => {
    const chip = show(freshness(health(status, ['transcript import 90 s behind'])));
    expect(chip).toHaveTextContent(text);
    expect(chip).toHaveClass('tone-failed');
    expect(chip).toHaveAttribute('data-status', status);
  });

  it('shows disabled as "Hooks off: transcripts only" in the idle tone', () => {
    const chip = show(freshness(health('disabled')));
    expect(chip).toHaveTextContent('Hooks off: transcripts only');
    expect(chip).toHaveClass('tone-idle');
  });

  it('shows unknown before any health report arrived', () => {
    const chip = show(freshness(undefined));
    expect(chip).toHaveTextContent('Ingestion unknown');
    expect(chip).toHaveClass('tone-unknown');
    expect(chip.querySelector('.chip__detail')).toBeNull();
  });

  it('never says OK while the client is not in sync: unknown with the last known status and its age', () => {
    const chip = show(freshness(health('ok'), { syncedAgo: 40_000, streamOpen: false }));
    expect(chip).toHaveTextContent('Ingestion unknown');
    expect(chip).not.toHaveTextContent('Ingestion OK');
    expect(chip).toHaveAttribute('data-status', 'unknown');
    expect(chip.querySelector('.chip__detail')).toHaveTextContent('Last known: ok, 40s ago');
  });

  it('always has an icon next to the words', () => {
    const chip = show(freshness(health('degraded', ['r'])));
    expect(chip.querySelector('svg.icon')).toHaveAttribute('aria-hidden', 'true');
  });

  it('links to the health section of the settings page', () => {
    const chip = show(freshness(health('ok')));
    expect(chip).toHaveAttribute('href', '/settings?section=health');
  });
});
