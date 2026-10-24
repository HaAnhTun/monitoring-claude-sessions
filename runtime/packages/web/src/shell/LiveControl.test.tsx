import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import type { EndpointRecord, IngestionHealthInput } from '../lib/connection-health.ts';
import { describeFreshness, type Freshness } from '../stream/freshness.ts';
import { FIXTURE_INSTANCE_ID, makeHealth, makeInstance } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { LiveControl } from './LiveControl.tsx';

// ADR 0073 decision 5, review D2: one control, a dot and a word, the colour of the worse of connection and ingestion; the popover
// behind it keeps the two signals apart. The words and tones come from `describeFreshness` (freshness.test.ts); this file proves
// what the control shows of them.
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

interface Situation {
  streamOpen?: boolean;
  syncedAgo?: number;
  failures?: number;
  online?: boolean;
  nextRetryIn?: number | null;
  touched?: boolean;
  ingestion?: IngestionHealthInput['ingestion']['status'];
  reasons?: string[];
}

function freshness(o: Situation): Freshness {
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
    health:
      o.ingestion === undefined && o.touched === false
        ? undefined
        : {
            ...makeHealth('ok'),
            ingestion: { ...makeHealth('ok').ingestion, status: o.ingestion ?? 'ok', reasons: o.reasons ?? [] },
          },
    healthRecord: touched ? record('health', syncedAt) : null,
  });
}

function show(f: Freshness) {
  const queryClient = createQueryClient({ retry: false });
  queryClient.setQueryData(qk.health(FIXTURE_INSTANCE_ID), makeHealth('ok'));
  const rendered = renderWithProviders(<LiveControl freshness={f} />, {
    instance: makeInstance(),
    queryClient,
  });
  const control = rendered.container.querySelector<HTMLElement>('.live-control');
  if (control === null) throw new Error('no Live control');
  return { ...rendered, control, user: userEvent.setup() };
}

function trigger(): HTMLElement {
  const [first] = within(document.body).getAllByRole('button');
  if (first === undefined) throw new Error('no button');
  return first;
}

describe('LiveControl: one dot and one word', () => {
  const cases: { name: string; given: Situation; word: string; tone: string; source: string }[] = [
    {
      name: 'connecting',
      given: { touched: false },
      word: msg('live.bar.connecting'),
      tone: 'idle',
      source: 'connection',
    },
    { name: 'live', given: { streamOpen: true }, word: msg('live.bar.live'), tone: 'ok', source: 'connection' },
    {
      name: 'live and not in sync',
      given: { streamOpen: true, syncedAgo: 31_000 },
      word: msg('live.bar.waiting'),
      tone: 'stale',
      source: 'connection',
    },
    { name: 'polling', given: {}, word: msg('live.bar.paused'), tone: 'stale', source: 'connection' },
    {
      name: 'polling and stale',
      given: { syncedAgo: 31_000 },
      word: msg('live.bar.refreshFailing'),
      tone: 'stale',
      source: 'connection',
    },
    {
      name: 'reconnecting',
      given: { failures: 1, nextRetryIn: 8_000 },
      word: msg('live.bar.reconnecting'),
      tone: 'stale',
      source: 'connection',
    },
    {
      name: 'connection lost',
      given: { failures: 3, syncedAgo: 40_000, nextRetryIn: 8_000 },
      word: msg('live.bar.lost'),
      tone: 'failed',
      source: 'connection',
    },
    {
      name: 'browser offline',
      given: { online: false },
      word: msg('live.bar.offline'),
      tone: 'failed',
      source: 'connection',
    },
    {
      name: 'live, ingestion degraded',
      given: { streamOpen: true, ingestion: 'degraded', reasons: ['r'] },
      word: msg('live.bar.ingestionDegraded'),
      tone: 'stale',
      source: 'ingestion',
    },
    {
      name: 'live, ingestion stalled',
      given: { streamOpen: true, ingestion: 'stalled', reasons: ['r'] },
      word: msg('live.bar.ingestionStalled'),
      tone: 'failed',
      source: 'ingestion',
    },
    {
      name: 'live, ingestion down',
      given: { streamOpen: true, ingestion: 'down' },
      word: msg('live.bar.ingestionDown'),
      tone: 'failed',
      source: 'ingestion',
    },
    {
      name: 'live, hooks off',
      given: { streamOpen: true, ingestion: 'disabled' },
      word: msg('live.bar.live'),
      tone: 'ok',
      source: 'connection',
    },
  ];

  it.each(cases)('$name: "$word" in the $tone tone', ({ given, word, tone, source }) => {
    const { control } = show(freshness(given));
    expect(control).toHaveAttribute('data-live-state', tone);
    expect(control).toHaveAttribute('data-live-source', source);
    expect(trigger()).toHaveTextContent(word);
    expect(trigger().textContent).toBe(word);
    expect(control.querySelectorAll('.live-dot')).toHaveLength(1);
    expect(control.querySelector('.live-dot')).toHaveAttribute('data-tone', tone);
    expect(control.querySelector('.live-dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('exposes the raw states for the page tests and the shots', () => {
    const { control } = show(freshness({ streamOpen: true, ingestion: 'degraded', reasons: ['r'] }));
    expect(control).toHaveAttribute('data-connection', 'live');
    expect(control).toHaveAttribute('data-ingestion', 'degraded');
  });

  it('is a single button: the word is never a second control', () => {
    show(freshness({ streamOpen: true }));
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never says OK or Live while the client is not in sync', () => {
    for (const given of [
      { failures: 3, syncedAgo: 40_000, nextRetryIn: 8_000 },
      { online: false },
      { touched: false },
    ]) {
      const { control, unmount } = show(freshness(given));
      expect(control.getAttribute('data-live-state')).not.toBe('ok');
      expect(trigger()).not.toHaveTextContent(msg('live.bar.live'));
      unmount();
    }
  });

  it('speaks Vietnamese when the page does', () => {
    const f = freshness({ failures: 3, syncedAgo: 40_000, nextRetryIn: 8_000 });
    renderWithProviders(<LiveControl freshness={f} />, { locale: 'vi', instance: makeInstance() });
    expect(trigger()).toHaveTextContent(msg('live.bar.lost', undefined, 'vi'));
  });
});

describe('LiveControl: the popover', () => {
  it('is closed until it is pressed: aria-expanded, aria-haspopup and no panel', () => {
    show(freshness({ streamOpen: true }));
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a dialog named for what it holds, with the four sections', async () => {
    const { user } = show(freshness({ streamOpen: true }));
    await user.click(trigger());
    const panel = screen.getByRole('dialog', { name: msg('live.popover.label') });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getAllByRole('heading', { level: 3 })).toHaveLength(4);
  });

  it('keeps the signals apart: the popover says the connection and the ingestion separately', async () => {
    const { user } = show(freshness({ streamOpen: true, ingestion: 'degraded', reasons: ['spool is full'] }));
    await user.click(trigger());
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText(msg('live.conn.live'))).toBeInTheDocument();
    expect(within(panel).getByText(msg('live.ingest.degraded'))).toBeInTheDocument();
    expect(within(panel).getByText('spool is full')).toBeInTheDocument();
  });

  it('Escape closes it and gives the focus back to the control', async () => {
    const { user } = show(freshness({ streamOpen: true }));
    await user.click(trigger());
    await user.tab();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('is reachable by keyboard: the next Tab after the control enters the panel and reaches the settings link', async () => {
    const { user } = show(freshness({ streamOpen: true }));
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('link', { name: msg('live.popover.settings') })).toHaveFocus();
  });

  it('closes when the focus leaves it and on a click outside', async () => {
    const { user } = show(freshness({ streamOpen: true }));
    await user.click(trigger());
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('following the link to the settings closes the panel', async () => {
    const { user } = show(freshness({ streamOpen: true }));
    await user.click(trigger());
    await user.click(screen.getByRole('link', { name: msg('live.popover.settings') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('follows a connection that drops while it is open: the word and the section change in place', async () => {
    const { user, rerender, container } = show(freshness({ streamOpen: true }));
    await user.click(trigger());
    expect(within(screen.getByRole('dialog')).getByText(msg('live.conn.live'))).toBeInTheDocument();
    const dropped = freshness({ failures: 3, syncedAgo: 40_000, nextRetryIn: 8_000 });
    rerender(<LiveControl freshness={dropped} />);
    expect(container.querySelector('.live-control')).toHaveAttribute('data-live-state', 'failed');
    expect(trigger()).toHaveTextContent(msg('live.bar.lost'));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText(msg('live.conn.lostRetry', { seconds: 8 }))).toBeInTheDocument();
    expect(within(panel).getByText(msg('live.ingest.unknown'))).toBeInTheDocument();
    expect(within(panel).queryByText(msg('live.ingest.ok'))).toBeNull();
  });
});
