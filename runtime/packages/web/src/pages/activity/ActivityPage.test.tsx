import type { ActivityEvent } from '@mcs/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { StreamProvider } from '../../stream/StreamProvider.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../../test/fake-event-source.ts';
import { iso, makeEvent, makeEventPage, makeHealth, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../../test/render.tsx';
import { ActivityPage } from './ActivityPage.tsx';

const INSTANCE = makeInstance();

function ev(n: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ id: n, seq: 100 + n, at: iso(n), summary: `FIXTURE event ${String(n)}`, ...overrides });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

interface Harness {
  api: FakeApi;
  sources: FakeEventSources;
}

function setup(route: string, handlers: FakeHandlers = {}, options: RenderOptions = {}): Harness {
  const sources = createFakeEventSources();
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () => makeHealth('ok'),
    listEvents: () => makeEventPage([ev(3), ev(2), ev(1)]),
    ...handlers,
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      <StreamProvider esFactory={sources.factory}>
        {children}
        <LocationProbe />
      </StreamProvider>
    </ShortcutRegistryProvider>
  );
  renderWithIntl(<ActivityPage />, { route, api, instance: INSTANCE, wrap, ...options });
  return { api, sources };
}

function lastEventsQuery(h: Harness): URLSearchParams {
  const call = h.api.callsTo('listEvents').at(-1);
  if (call === undefined) throw new Error('no events request');
  return call.query;
}

describe('ActivityPage', () => {
  it('shows the heading, sets the document title and lists the events of the last 24 hours', async () => {
    const h = setup('/activity');
    expect(screen.getByRole('heading', { level: 1, name: msg('route.activity.title') })).toBeInTheDocument();
    await screen.findByText('FIXTURE event 3');
    expect(document.title).toContain(msg('route.activity.title'));
    expect(lastEventsQuery(h).get('range')).toBe('24h');
  });

  it('shows only its heading until the app providers are there', () => {
    setup('/activity', {}, { instanceId: null });
    expect(screen.getByRole('heading', { level: 1, name: msg('route.activity.title') })).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('reads the filters of the address: /activity?severity=error asks only for errors', async () => {
    const h = setup('/activity?severity=error', {
      listEvents: () => makeEventPage([ev(3, { severity: 'error' })]),
    });
    await screen.findByText('FIXTURE event 3');
    expect(lastEventsQuery(h).get('severity')).toBe('error');
    expect(
      screen.getByRole('button', {
        name: msg('filters.multiCount', { label: msg('activity.filter.severity'), count: 1 }),
      }),
    ).toBeInTheDocument();
  });

  it('sends every filter of the address to the server', async () => {
    const h = setup('/activity?types=tool,error&severity=warning,error&session=sess-1&tool=Bash&q=build&range=7d');
    await screen.findByText('FIXTURE event 3');
    const query = lastEventsQuery(h);
    expect(query.get('category')).toBe('tool,error');
    expect(query.get('severity')).toBe('warning,error');
    expect(query.get('session')).toBe('sess-1');
    expect(query.get('tool')).toBe('Bash');
    expect(query.get('q')).toBe('build');
    expect(query.get('range')).toBe('7d');
  });

  it('does not send a search of one character, and says how many are needed', async () => {
    const h = setup('/activity?q=b');
    await screen.findByText('FIXTURE event 3');
    expect(lastEventsQuery(h).has('q')).toBe(false);
    expect(screen.getByText(msg('activity.filter.minSearch'))).toBeInTheDocument();
  });

  it('ignores an invalid filter, says so and cleans the address', async () => {
    setup('/activity?severity=bogus&unknown=1');
    await screen.findByText('FIXTURE event 3');
    expect(screen.getByText(/severity/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('search')).toHaveTextContent('');
    });
  });

  it('writes a filter change into the address and asks again', async () => {
    const user = userEvent.setup();
    const h = setup('/activity');
    await screen.findByText('FIXTURE event 3');
    await user.selectOptions(screen.getByRole('combobox', { name: msg('activity.filter.range') }), '7d');
    await waitFor(() => {
      expect(screen.getByTestId('search')).toHaveTextContent('range=7d');
    });
    await waitFor(() => {
      expect(lastEventsQuery(h).get('range')).toBe('7d');
    });
  });

  it('has an empty state when there is nothing and no filter is on', async () => {
    setup('/activity', { listEvents: () => makeEventPage([]) });
    expect(await screen.findByText(msg('activity.empty.title'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('activity.clearFilters') })).toBeNull();
  });

  it('has an empty state with a way out when a filter hides everything', async () => {
    const user = userEvent.setup();
    setup('/activity?severity=error', { listEvents: () => makeEventPage([]) });
    expect(await screen.findByText(msg('activity.emptyFiltered.title'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('activity.clearFilters') }));
    await waitFor(() => {
      expect(screen.getByTestId('search')).toHaveTextContent('');
    });
  });

  it('has an error state with a retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    const h = setup('/activity', {
      listEvents: () => (fail ? errorResponse('internal_error') : makeEventPage([ev(1)])),
    });
    const retry = await screen.findByRole('button', { name: msg('common.retryNow') });
    fail = false;
    await user.click(retry);
    await screen.findByText('FIXTURE event 1');
    expect(h.api.callsTo('listEvents').length).toBeGreaterThan(1);
  });

  it('shows a live error on /activity?severity=error and leaves other severities out', async () => {
    const h = setup('/activity?severity=error&range=all');
    await screen.findByText('FIXTURE event 3');
    act(() => {
      h.sources.last().open();
      h.sources.last().emit('hello', {
        instanceId: INSTANCE.instanceId,
        epoch: INSTANCE.epoch,
        headSeq: INSTANCE.headSeq,
        heartbeatMs: INSTANCE.heartbeatMs,
        serverTime: iso(0),
        runtimeVersion: INSTANCE.runtimeVersion,
        codeStamp: INSTANCE.codeStamp,
      });
    });
    await screen.findByText(msg('activity.status.live'));
    const frame = (seq: number, items: ActivityEvent[]) => ({
      seq,
      at: iso(0),
      instanceId: INSTANCE.instanceId,
      kind: 'event',
      op: 'append',
      sessionId: null,
      data: { items, count: items.length, truncated: false },
    });
    act(() => {
      h.sources
        .last()
        .emit('change', frame(INSTANCE.headSeq + 1, [ev(7, { severity: 'info' }), ev(8, { severity: 'error' })]));
    });
    await screen.findByText('FIXTURE event 8');
    expect(screen.queryByText('FIXTURE event 7')).toBeNull();
  });

  it('is written in Vietnamese', async () => {
    setup('/activity', {}, { locale: 'vi' });
    expect(
      screen.getByRole('heading', { level: 1, name: msg('route.activity.title', undefined, 'vi') }),
    ).toBeInTheDocument();
    await screen.findByText('FIXTURE event 3');
    expect(screen.getByText(msg('activity.description', undefined, 'vi'))).toBeInTheDocument();
  });
});
