import { routes } from '@mcs/shared';
import { act, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { StreamProvider } from '../stream/StreamProvider.tsx';
import { createFakeApi, errorResponse } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso, makeHealth, makeInstance } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { StaleDataIndicator } from './StaleDataIndicator.tsx';

// UI-I5: a stale view is never blank; the last good data stays and a marker says how old it is (04 5.6, 7).
const INSTANCE = makeInstance({ staleAfterMs: 30_000 });
const START = new Date('2026-10-12T12:00:00Z');
const format = createFormatters('en');
const CLOCK = format.clock(START);
const asOfLine = (o: { scope: string; time: string; age: string; reason: string }): string => msg('freshness.asOf', o);

let sources: FakeEventSources;
let healthFails = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sources = createFakeEventSources();
  healthFails = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function withStream(children: ReactNode): ReactNode {
  return (
    <StreamProvider esFactory={sources.factory} windowTarget={new EventTarget()}>
      {children}
    </StreamProvider>
  );
}

function setup(ui: ReactNode, options: { stream?: boolean; instance?: typeof INSTANCE; locale?: 'en' | 'vi' } = {}) {
  const instance = options.instance ?? INSTANCE;
  const api = createFakeApi({
    instance: () => instance,
    health: () => (healthFails ? errorResponse('internal_error') : makeHealth('ok')),
  });
  return renderWithProviders(<main data-stale-scope>{ui}</main>, {
    instance,
    api,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.stream === true ? { wrap: withStream } : {}),
  });
}

/** Records successes for `instance` and `health`, as the shell's polling does. */
async function pollCore(rendered: ReturnType<typeof setup>): Promise<void> {
  await act(async () => {
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
    await rendered.apiClient.get('health', routes.health.path, routes.health.response);
  });
}

async function failHealth(rendered: ReturnType<typeof setup>): Promise<void> {
  healthFails = true;
  await act(async () => {
    await rendered.apiClient.get('health', routes.health.path, routes.health.response).catch(() => undefined);
  });
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

function scope(): HTMLElement {
  return screen.getByRole('main');
}

describe('StaleDataIndicator', () => {
  it('renders nothing while the data is fresh and marks no scope', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    await flush(5_000);
    expect(scope()).toBeEmptyDOMElement();
    expect(scope()).not.toHaveAttribute('data-stale');
  });

  it('renders nothing before the first fetch (no staleness is computed while connecting)', async () => {
    setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await flush(60_000);
    expect(scope()).toBeEmptyDOMElement();
  });

  it('shows "as of HH:MM:SS (Ns ago)" with the reason once the polling stops, and marks the scope', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    await flush(31_000);
    expect(
      screen.getByText(
        asOfLine({ scope: 'sessions', time: CLOCK, age: '31s', reason: msg('freshness.reason.refreshFailing') }),
      ),
    ).toBeInTheDocument();
    expect(scope()).toHaveAttribute('data-stale', 'true');
  });

  it('words the line in Vietnamese when the page is Vietnamese', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="scope-vi" />, { locale: 'vi' });
    await pollCore(rendered);
    await flush(31_000);
    const viFormat = createFormatters('vi');
    expect(
      screen.getByText(
        msg(
          'freshness.asOf',
          {
            scope: 'scope-vi',
            time: viFormat.clock(START),
            age: viFormat.age(31),
            reason: msg('freshness.reason.refreshFailing', undefined, 'vi'),
          },
          'vi',
        ),
      ),
    ).toBeInTheDocument();
  });

  it('uses the time of the data (asOf) in the line when it is given', async () => {
    const asOf = START.getTime() - 20_000;
    const rendered = setup(<StaleDataIndicator asOf={asOf} scope="activity" />);
    await pollCore(rendered);
    await flush(31_000);
    const clock = format.clock(asOf);
    expect(
      screen.getByText(
        asOfLine({ scope: 'activity', time: clock, age: '51s', reason: msg('freshness.reason.refreshFailing') }),
      ),
    ).toBeInTheDocument();
  });

  it('shows a failing refresh even while the connection is in sync, with the age of the data', async () => {
    const rendered = setup(<StaleDataIndicator asOf={START.getTime()} fetchFailing scope="sessions" />);
    await pollCore(rendered);
    await flush(4_000);
    expect(
      screen.getByText(
        asOfLine({ scope: 'sessions', time: CLOCK, age: '4s', reason: msg('freshness.reason.refreshFailing') }),
      ),
    ).toBeInTheDocument();
    expect(scope()).toHaveAttribute('data-stale', 'true');
  });

  it('still says something useful when no time is known', async () => {
    setup(<StaleDataIndicator asOf={null} fetchFailing scope="sessions" />);
    await flush(1_000);
    expect(
      screen.getByText(
        msg('freshness.asOfUnknown', { scope: 'sessions', reason: msg('freshness.reason.refreshFailing') }),
      ),
    ).toBeInTheDocument();
  });

  it('blames the dropped live updates when the connection is lost', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    await failHealth(rendered);
    await flush(31_000);
    expect(screen.getByText(new RegExp(`: ${msg('freshness.reason.disconnected')}$`))).toBeInTheDocument();
    expect(scope()).toHaveAttribute('data-stale', 'true');
  });

  it('names the silence when the stream is open but nothing arrives', async () => {
    const instance = makeInstance({ staleAfterMs: 10_000 });
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />, { stream: true, instance });
    await pollCore(rendered);
    streamOpen();
    await flush(11_000);
    expect(screen.getByText(new RegExp(`: ${msg('freshness.reason.noUpdate', { age: '11s' })}$`))).toBeInTheDocument();
  });

  it('clears the marker when the data is fresh again', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    await flush(31_000);
    expect(scope()).toHaveAttribute('data-stale', 'true');
    await pollCore(rendered);
    expect(scope()).not.toHaveAttribute('data-stale');
    expect(screen.queryByText(/as of/)).toBeNull();
  });

  it('keeps the scope marked until every indicator of the scope is gone', async () => {
    const rendered = setup(
      <>
        <StaleDataIndicator asOf={null} scope="first" />
        <StaleDataIndicator asOf={null} scope="second" />
      </>,
    );
    await pollCore(rendered);
    await flush(31_000);
    expect(scope()).toHaveAttribute('data-stale', 'true');
    expect(screen.getAllByText(/as of/)).toHaveLength(2);
    // The indicators keep their own subscription (`useFreshness`), so the router and API contexts stay in place.
    rendered.rerender(
      <main data-stale-scope>
        <StaleDataIndicator asOf={null} scope="first" />
      </main>,
    );
    expect(scope()).toHaveAttribute('data-stale', 'true');
    rendered.rerender(<main data-stale-scope />);
    expect(scope()).not.toHaveAttribute('data-stale');
  });

  it('works outside a stale scope wrapper: the line shows and nothing throws', async () => {
    const api = createFakeApi({ instance: () => INSTANCE, health: () => makeHealth('ok') });
    const rendered = renderWithProviders(<StaleDataIndicator asOf={null} scope="sessions" />, {
      instance: INSTANCE,
      api,
    });
    await act(async () => {
      await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
      await rendered.apiClient.get('health', routes.health.path, routes.health.response);
    });
    await flush(31_000);
    expect(screen.getByText(/^sessions as of /)).toBeInTheDocument();
  });

  it('is a plain status line: text and an icon, not colour only, and not a live region of its own', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    await flush(31_000);
    const line = screen.getByText(/^sessions as of /).closest('.stale-indicator');
    expect(line).not.toBeNull();
    expect(line).toHaveClass('tone-stale');
    expect(line?.querySelector('svg.icon')).toHaveAttribute('aria-hidden', 'true');
    expect(line).not.toHaveAttribute('role');
    expect(line).not.toHaveAttribute('aria-live');
  });

  it('stops its timers when unmounted', async () => {
    const rendered = setup(<StaleDataIndicator asOf={null} scope="sessions" />);
    await pollCore(rendered);
    rendered.unmount();
    rendered.queryClient.clear();
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
