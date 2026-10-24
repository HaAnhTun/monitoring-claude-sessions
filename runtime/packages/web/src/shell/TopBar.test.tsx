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
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { TopBar } from './TopBar.tsx';

// 04 11.2 TopBar matrix (ADR 0073 decisions 4 and 5): the bar shows ONE Live control whose colour is the worse of the connection and
// the ingestion; the two signals stay apart in its popover. The ingestion is never "OK" while the client is not in sync (UI-I4),
// "updated Ns ago" shows only when the data is stale, the refresh button says "Retry now" while the monitor cannot be reached.
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

const DEGRADED_REASON = '12 hook envelopes rejected in the last hour';

function healthBody() {
  if (healthMode === 'fail') return errorResponse('internal_error', 'FIXTURE health failure');
  return healthMode === 'degraded'
    ? makeHealth('degraded', {
        ingestion: {
          ...makeHealth('degraded').ingestion,
          status: 'degraded',
          reasons: [DEGRADED_REASON],
        },
      })
    : makeHealth('ok');
}

/** Renders the bar, lets the instance and the first health poll succeed, as the shell does at boot. */
async function setup(options: { stream?: boolean; instance?: typeof INSTANCE } = {}) {
  const instance = options.instance ?? INSTANCE;
  const api = createFakeApi({ instance: () => instance, health: healthBody });
  const rendered = renderWithProviders(<TopBar />, {
    instance,
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

function live(): HTMLElement {
  const control = screen.getByRole('banner').querySelector<HTMLElement>('.live-control');
  if (control === null) throw new Error('no Live control');
  return control;
}

/** The button of the Live control. */
function liveButton(): HTMLElement {
  return within(live()).getByRole('button');
}

async function openLive(): Promise<HTMLElement> {
  if (liveButton().getAttribute('aria-expanded') !== 'true') await press(liveButton());
  return screen.getByRole('dialog', { name: msg('live.popover.label') });
}

function connectionLine(panel: HTMLElement): HTMLElement {
  const line = panel.querySelector<HTMLElement>('[data-connection]');
  if (line === null) throw new Error('no connection line');
  return line;
}

function ingestionSection(panel: HTMLElement): HTMLElement {
  const section = within(panel)
    .getByRole('heading', { level: 3, name: msg('live.section.ingestion') })
    .closest('section');
  if (section === null) throw new Error('no ingestion section');
  return section;
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

  it('drops the task name when it repeats the title', async () => {
    await setup({ instance: makeInstance({ staleAfterMs: 30_000, title: 'same-name', slug: 'same-name' }) });
    const banner = screen.getByRole('banner');
    expect(banner.querySelectorAll('.topbar__title, .topbar__task')).toHaveLength(1);
    expect(banner).toHaveTextContent('same-name');
  });

  it('keeps a very long title in one line: the full text is in the title attribute', async () => {
    const title = `FIXTURE ${'long-title-'.repeat(30)}`;
    await setup({ instance: makeInstance({ staleAfterMs: 30_000, title, slug: 'fixture-task' }) });
    const element = screen.getByRole('banner').querySelector('.topbar__title');
    expect(element).toHaveTextContent(title);
    expect(element).toHaveAttribute('title', title);
  });

  it('shows the fallback title and a connecting Live control before the instance is known', async () => {
    const api = createFakeApi({ instance: () => new Promise(() => undefined) });
    renderWithProviders(<TopBar />, { instance: INSTANCE, instanceId: null, api, wrap: wrapper(false) });
    await flush(10);
    expect(screen.getByRole('banner')).toHaveTextContent(msg('shell.appTitle'));
    expect(liveButton()).toHaveTextContent(msg('live.bar.connecting'));
    expect(live()).toHaveAttribute('data-live-state', 'idle');
    expect(screen.queryByRole('button', { name: msg('menu.trigger') })).toBeNull();
  });

  it('has the one menu button once the instance is known, and no row of preference buttons', async () => {
    await setup();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('button', { name: msg('menu.trigger') })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(banner).queryByRole('button', { name: /^(Theme|Density|Shortcuts|Details)/ })).toBeNull();
  });

  it('has few tab stops: the Live control, the refresh button and the menu', async () => {
    await setup();
    expect(within(screen.getByRole('banner')).getAllByRole('button')).toHaveLength(3);
  });
});

describe('TopBar: one Live control, two signals (UI-I4)', () => {
  it('polling without a stream: the word is "paused" and the popover has the polled health', async () => {
    await setup();
    expect(liveButton()).toHaveTextContent(msg('live.bar.paused'));
    expect(live()).toHaveAttribute('data-connection', 'polling');
    const panel = await openLive();
    expect(connectionLine(panel)).toHaveTextContent(msg('live.conn.polling', { seconds: 6 }));
    expect(ingestionSection(panel)).toHaveTextContent(msg('live.ingest.ok'));
  });

  it('stream open and hooks delivering: Live and OK, nothing stale, no "updated" text', async () => {
    await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    expect(liveButton().textContent).toBe(msg('live.bar.live'));
    expect(live()).toHaveAttribute('data-live-state', 'ok');
    expect(screen.queryByText(/^updated /)).toBeNull();
    const panel = await openLive();
    expect(connectionLine(panel)).toHaveTextContent(msg('live.conn.live'));
    expect(ingestionSection(panel)).toHaveTextContent(msg('live.ingest.ok'));
  });

  it('stream open but ingestion degraded: the control takes the ingestion word and colour, the popover keeps both apart', async () => {
    healthMode = 'degraded';
    await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    expect(liveButton().textContent).toBe(msg('live.bar.ingestionDegraded'));
    expect(live()).toHaveAttribute('data-live-state', 'stale');
    expect(live()).toHaveAttribute('data-live-source', 'ingestion');
    const panel = await openLive();
    expect(connectionLine(panel)).toHaveTextContent(msg('live.conn.live'));
    expect(ingestionSection(panel)).toHaveTextContent(msg('live.ingest.degraded'));
    expect(ingestionSection(panel)).toHaveTextContent(DEGRADED_REASON);
  });

  it('browser offline: Offline, and the ingestion is not OK', async () => {
    await setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await flush(1_000);
    expect(liveButton().textContent).toBe(msg('live.bar.offline'));
    expect(live()).toHaveAttribute('data-live-state', 'failed');
    const panel = await openLive();
    expect(ingestionSection(panel)).toHaveTextContent(msg('live.ingest.unknown'));
    expect(ingestionSection(panel)).not.toHaveTextContent(msg('live.ingest.ok'));
  });

  it('server gone: the ingestion turns to unknown with the last known status as soon as the client is not in sync', async () => {
    await setup();
    expect(live()).toHaveAttribute('data-ingestion', 'ok');
    healthMode = 'fail';
    await flush(12_000);
    expect(live()).toHaveAttribute('data-connection', 'reconnecting');
    expect(live()).toHaveAttribute('data-ingestion', 'unknown');
    const panel = await openLive();
    const ingestion = ingestionSection(panel);
    expect(ingestion).toHaveTextContent(msg('live.ingest.unknown'));
    expect(ingestion).not.toHaveTextContent(msg('live.ingest.ok'));
    const lastKnown = msg('live.ingest.lastKnown', { status: msg('live.ingest.status.ok'), age: 'AGE' });
    expect(ingestion.textContent).toMatch(new RegExp(lastKnown.replace('AGE', '\\d+s')));
  });

  it('server killed for longer than staleAfterMs: connection lost, the age of the data shown beside the control', async () => {
    await setup();
    healthMode = 'fail';
    await flush(41_000);
    expect(live()).toHaveAttribute('data-connection', 'offline');
    expect(liveButton().textContent).toBe(msg('live.bar.lost'));
    expect(live()).toHaveAttribute('data-live-state', 'failed');
    expect(screen.getByText(/^updated 4\ds ago$/)).toBeInTheDocument();
    const panel = await openLive();
    expect(ingestionSection(panel)).not.toHaveTextContent(msg('live.ingest.ok'));
  });

  it('recovers: back to polling and OK when the server answers again, and the age text disappears', async () => {
    await setup();
    healthMode = 'fail';
    await flush(41_000);
    healthMode = 'ok';
    await flush(6_000);
    expect(live()).toHaveAttribute('data-connection', 'polling');
    expect(live()).toHaveAttribute('data-ingestion', 'ok');
    expect(screen.queryByText(/^updated /)).toBeNull();
  });
});

describe('TopBar: retry countdown and the refresh button', () => {
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

  function secondsLeft(panel: HTMLElement): number {
    const text = connectionLine(panel).textContent;
    // The message with a 0 for the seconds, turned into a pattern that captures them.
    const template = msg('live.conn.reconnectingRetry', { seconds: 0 }).replace(/[()]/g, String.raw`\$&`);
    const pattern = new RegExp(template.replace('0', String.raw`(\d+)`));
    const match = pattern.exec(text);
    if (match === null) throw new Error(`no countdown in "${text}"`);
    return Number(match[1]);
  }

  it('counts down every second on the fake clock, in the popover', async () => {
    await reconnecting();
    const panel = await openLive();
    expect(connectionLine(panel)).toHaveAttribute('data-connection', 'reconnecting');
    const before = secondsLeft(panel);
    expect(before).toBeGreaterThanOrEqual(3);
    await flush(1_000);
    expect(secondsLeft(panel)).toBe(before - 1);
    await flush(1_000);
    expect(secondsLeft(panel)).toBe(before - 2);
  });

  it('the refresh button says "Retry now" while the monitor cannot be reached; it asks the stream to reconnect at once and polls again', async () => {
    const { api } = await reconnecting();
    const sourcesBefore = sources.instances.length;
    const healthCallsBefore = api.callsTo('health').length;
    await press(within(screen.getByRole('banner')).getByRole('button', { name: msg('common.retryNow') }));
    expect(sources.instances.length).toBe(sourcesBefore + 1);
    expect(api.callsTo('health').length).toBeGreaterThan(healthCallsBefore);
  });

  it('is an icon button named "Refresh" while everything works', async () => {
    const { api } = await setup();
    const before = api.callsTo('health').length;
    const refresh = within(screen.getByRole('banner')).getByRole('button', { name: msg('topbar.refresh') });
    expect(refresh).toHaveTextContent('');
    expect(refresh.querySelector('svg.icon')).not.toBeNull();
    await press(refresh);
    expect(api.callsTo('health').length).toBeGreaterThan(before);
  });
});

describe('TopBar: the popover of the Live control', () => {
  it('opens in place, does not move the page and lists the endpoints', async () => {
    await setup();
    const panel = await openLive();
    expect(liveButton()).toHaveAttribute('aria-expanded', 'true');
    expect(panel.id).toBe(liveButton().getAttribute('aria-controls'));
    expect(within(panel).getByText('instance')).toBeInTheDocument();
    await press(liveButton());
    expect(liveButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('survives a stream that drops while it is open', async () => {
    await setup({ stream: true });
    streamOpen();
    await flush(1_000);
    const panel = await openLive();
    expect(connectionLine(panel)).toHaveAttribute('data-connection', 'live');
    act(() => {
      sources.last().fail();
    });
    await flush(1_000);
    expect(screen.getByRole('dialog')).toBe(panel);
    expect(connectionLine(panel)).toHaveAttribute('data-connection', 'polling');
  });
});

describe('TopBar: announcements', () => {
  it('announces a lost and a restored connection once, politely, in the words of the catalogue', async () => {
    await setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await flush(1_100);
    expect(liveRegion()).toHaveTextContent(msg('freshness.announce.lost'));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flush(1_100);
    expect(liveRegion()).toHaveTextContent(msg('freshness.announce.restored'));
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
