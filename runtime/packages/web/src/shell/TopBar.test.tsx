import { routes } from '@mcs/shared';
import { act, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamProvider } from '../stream/StreamProvider.tsx';
import { createPrefs } from '../lib/prefs.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { createPrefsStore, PrefsStoreContext } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider } from '../state/shortcuts-registry.tsx';
import { createFakeApi, errorResponse } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso, makeHealth, makeInstance } from '../test/fixtures/index.ts';
import { renderWithProviders } from '../test/render.tsx';
import { TopBar } from './TopBar.tsx';

// 04 11.2 TopBar matrix: chip text for the connection states, the ingestion chip is never "OK" while the client is not in sync
// (UI-I4), the retry countdown on a fake clock, the details toggle, the preference controls, the polite announcements.
const INSTANCE = makeInstance({ staleAfterMs: 30_000, title: 'FIXTURE monitor', slug: 'fixture-task' });
const START = new Date('2026-10-12T12:00:00Z');

type HealthMode = 'ok' | 'degraded' | 'fail';

let sources: FakeEventSources;
let healthMode: HealthMode;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sources = createFakeEventSources();
  healthMode = 'ok';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // TanStack Query's online manager is global: leave it online whatever a test did to the browser state.
  window.dispatchEvent(new Event('online'));
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function wrapper(stream: boolean) {
  const store = createPrefsStore(createPrefs(null));
  return (children: ReactNode): ReactNode => (
    <AnnouncerProvider>
      <ShortcutRegistryProvider>
        <PrefsStoreContext value={store}>
          {stream ? (
            <StreamProvider esFactory={sources.factory} windowTarget={new EventTarget()}>
              {children}
            </StreamProvider>
          ) : (
            children
          )}
        </PrefsStoreContext>
      </ShortcutRegistryProvider>
    </AnnouncerProvider>
  );
}

function healthBody() {
  if (healthMode === 'fail') return errorResponse('internal_error', 'FIXTURE health failure');
  return healthMode === 'degraded'
    ? makeHealth('degraded', {
        ingestion: {
          ...makeHealth('degraded').ingestion,
          status: 'degraded',
          reasons: ['12 hook envelopes rejected in the last hour'],
        },
      })
    : makeHealth('ok');
}

/** Renders the bar, lets the instance and the first health poll succeed, as the shell does at boot. */
async function setup(options: { stream?: boolean } = {}) {
  const api = createFakeApi({ instance: () => INSTANCE, health: healthBody });
  const rendered = renderWithProviders(<TopBar />, {
    instance: INSTANCE,
    api,
    wrap: wrapper(options.stream === true),
  });
  await act(async () => {
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
  });
  await flush(10);
  return { ...rendered, api };
}

function streamOpen(): void {
  act(() => {
    sources.last().open();
    sources.last().emit('hello', {
      instanceId: FIXTURE_INSTANCE_ID,
      epoch: FIXTURE_EPOCH,
      headSeq: INSTANCE.headSeq,
      heartbeatMs: 15_000,
      serverTime: iso(0),
      runtimeVersion: INSTANCE.runtimeVersion,
      codeStamp: INSTANCE.codeStamp,
    });
    sources.last().emit('heartbeat', { headSeq: INSTANCE.headSeq, epoch: FIXTURE_EPOCH, serverTime: iso(0) });
  });
}

/** Clicks without `user-event`: its async wrapper waits on timers that are fake here. */
async function press(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await flush(10);
}

function connectionChip(): HTMLElement {
  const chip = screen.getByRole('banner').querySelector<HTMLElement>('[data-chip="connection"]');
  if (chip === null) throw new Error('no connection chip');
  return chip;
}

function ingestionChip(): HTMLElement {
  const chip = screen.getByRole('banner').querySelector<HTMLElement>('[data-chip="ingestion"]');
  if (chip === null) throw new Error('no ingestion chip');
  return chip;
}

function liveRegion(): HTMLElement {
  const region = document.getElementById('live-region');
  if (region === null) throw new Error('no live region');
  return region;
}

describe('TopBar: identity and landmarks', () => {
  it('is the banner landmark with the instance title and task, and no heading (the page owns the h1)', async () => {
    await setup();
    const banner = screen.getByRole('banner');
    expect(banner).toHaveTextContent('FIXTURE monitor');
    expect(banner).toHaveTextContent('fixture-task');
    expect(within(banner).queryByRole('heading')).toBeNull();
  });

  it('shows the fallback title and a connecting chip before the instance is known', async () => {
    const api = createFakeApi({ instance: () => new Promise(() => undefined) });
    renderWithProviders(<TopBar />, { instance: INSTANCE, instanceId: null, api, wrap: wrapper(false) });
    await flush(10);
    expect(screen.getByRole('banner')).toHaveTextContent('Claude session monitor');
    expect(connectionChip()).toHaveTextContent('Connecting...');
    expect(ingestionChip()).toHaveTextContent('Ingestion unknown');
    expect(screen.queryByRole('button', { name: /^Theme:/ })).toBeNull();
  });

  it('has the preference controls once the instance is known', async () => {
    await setup();
    expect(screen.getByRole('button', { name: 'Theme: auto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Density: comfortable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shortcuts' })).toBeInTheDocument();
  });
});

describe('TopBar: connection and ingestion are separate chips (UI-I4)', () => {
  it('polling without a stream: paused chip, health from the poll', async () => {
    await setup();
    expect(connectionChip()).toHaveTextContent('Live updates paused, refreshing every 6s');
    expect(connectionChip()).toHaveAttribute('data-status', 'polling');
    expect(ingestionChip()).toHaveTextContent('Ingestion OK');
  });

  it('stream open and hooks delivering: Live and Ingestion OK, no stale marker', async () => {
    await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    expect(connectionChip()).toHaveTextContent('Live');
    expect(connectionChip()).toHaveAttribute('data-status', 'live');
    expect(ingestionChip()).toHaveTextContent('Ingestion OK');
    expect(screen.queryByText(/updated .* ago/)).toHaveTextContent(/^updated \ds ago$/);
  });

  it('stream open but ingestion degraded: Live next to Ingestion degraded with the first reason', async () => {
    healthMode = 'degraded';
    await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    expect(connectionChip()).toHaveTextContent('Live');
    expect(ingestionChip()).toHaveTextContent('Ingestion degraded');
    expect(ingestionChip()).toHaveTextContent('12 hook envelopes rejected in the last hour');
  });

  it('browser offline: Offline, and the ingestion chip is not OK', async () => {
    await setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await flush(1_000);
    expect(connectionChip()).toHaveTextContent('Offline');
    expect(ingestionChip()).toHaveTextContent('Ingestion unknown');
    expect(ingestionChip()).not.toHaveTextContent('Ingestion OK');
  });

  it('server gone: the ingestion chip turns to unknown with the last known status as soon as the client is not in sync', async () => {
    await setup();
    expect(ingestionChip()).toHaveTextContent('Ingestion OK');
    healthMode = 'fail';
    await flush(12_000);
    expect(connectionChip()).toHaveAttribute('data-status', 'reconnecting');
    expect(ingestionChip()).toHaveTextContent('Ingestion unknown');
    expect(ingestionChip()).not.toHaveTextContent('Ingestion OK');
    expect(ingestionChip()).toHaveTextContent(/Last known: ok, \d+s ago/);
  });

  it('server killed for longer than staleAfterMs: connection lost, ingestion unknown, the age of the data shown', async () => {
    await setup();
    healthMode = 'fail';
    await flush(41_000);
    expect(connectionChip()).toHaveAttribute('data-status', 'offline');
    expect(connectionChip()).toHaveTextContent('Connection lost');
    expect(ingestionChip()).toHaveTextContent('Ingestion unknown');
    expect(ingestionChip()).not.toHaveTextContent('Ingestion OK');
    expect(screen.getByText(/^updated 4\ds ago$/)).toBeInTheDocument();
  });

  it('recovers: back to polling and Ingestion OK when the server answers again', async () => {
    await setup();
    healthMode = 'fail';
    await flush(41_000);
    healthMode = 'ok';
    await flush(6_000);
    expect(connectionChip()).toHaveAttribute('data-status', 'polling');
    expect(ingestionChip()).toHaveTextContent('Ingestion OK');
  });
});

describe('TopBar: retry countdown', () => {
  async function reconnecting() {
    const rendered = await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    // The second drop is the one that waits 4 s, so the countdown has room to tick twice.
    act(() => {
      sources.last().fail();
    });
    await flush(2_100);
    act(() => {
      sources.last().fail();
    });
    healthMode = 'fail';
    await act(async () => {
      await rendered.apiClient.get('health', routes.health.path, routes.health.response).catch(() => undefined);
    });
    return rendered;
  }

  function secondsLeft(): number {
    const match = /retry in (\d+)s/.exec(connectionChip().textContent);
    if (match === null) throw new Error(`no countdown in "${connectionChip().textContent}"`);
    return Number(match[1]);
  }

  it('counts down every second on the fake clock', async () => {
    await reconnecting();
    expect(connectionChip()).toHaveAttribute('data-status', 'reconnecting');
    const before = secondsLeft();
    expect(before).toBeGreaterThanOrEqual(3);
    await flush(1_000);
    expect(secondsLeft()).toBe(before - 1);
    await flush(1_000);
    expect(secondsLeft()).toBe(before - 2);
  });

  it('"Retry now" asks the stream to reconnect at once and polls the server again', async () => {
    const { api } = await reconnecting();
    const sourcesBefore = sources.instances.length;
    const healthCallsBefore = api.callsTo('health').length;
    await press(screen.getByRole('button', { name: 'Retry now' }));
    expect(sources.instances.length).toBe(sourcesBefore + 1);
    expect(api.callsTo('health').length).toBeGreaterThan(healthCallsBefore);
  });

  it('is labelled "Refresh" while everything works', async () => {
    const { api } = await setup();
    const before = api.callsTo('health').length;
    await press(screen.getByRole('button', { name: 'Refresh' }));
    expect(api.callsTo('health').length).toBeGreaterThan(before);
  });
});

describe('TopBar: details', () => {
  it('toggles the health details with aria-expanded and aria-controls', async () => {
    await setup();
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/^instance: ok /)).toBeNull();
    await press(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByText(/^instance: ok /));
    await press(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/^instance: ok /)).toBeNull();
  });
});

describe('TopBar: announcements and preference controls', () => {
  it('announces a lost and a restored connection once, politely', async () => {
    await setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await flush(1_100);
    expect(liveRegion()).toHaveTextContent('Connection lost');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flush(1_100);
    expect(liveRegion()).toHaveTextContent('Connection restored');
  });

  it('cycles the theme and announces it', async () => {
    await setup();
    await press(screen.getByRole('button', { name: 'Theme: auto' }));
    expect(screen.getByRole('button', { name: 'Theme: light' })).toBeInTheDocument();
    await flush(100);
    expect(liveRegion()).toHaveTextContent('Theme: light');
  });

  it('toggles the density and announces it', async () => {
    await setup();
    await press(screen.getByRole('button', { name: 'Density: comfortable' }));
    expect(screen.getByRole('button', { name: 'Density: compact' })).toBeInTheDocument();
    await flush(100);
    expect(liveRegion()).toHaveTextContent('Density: compact');
  });
});

describe('TopBar: cleanup', () => {
  it('releases its timers on unmount (UI-I14)', async () => {
    const rendered = await setup();
    rendered.unmount();
    rendered.queryClient.clear();
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
