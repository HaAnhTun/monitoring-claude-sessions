import type { EventCategory } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { agentId, makeEvent, makeEventPage, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { SessionTimeline } from './SessionTimeline.tsx';

import { sessionId } from '../../test/fixtures/index.ts';

const SID = sessionId(1);
const INSTANCE = makeInstance();

interface HarnessProps {
  initial?: EventCategory[];
  agentId?: string | null;
  hooksEnabled?: boolean;
  filter?: boolean;
  seen?: EventCategory[][];
}

/** Holds the chosen categories the way the page does (in its address), so that a click changes what the list asks for. */
function Harness({ initial = [], agentId: agent = null, hooksEnabled = true, filter = true, seen }: HarnessProps) {
  const [types, setTypes] = useState<EventCategory[]>(initial);
  return (
    <SessionTimeline
      sessionId={SID}
      agentId={agent}
      types={types}
      onTypesChange={
        filter
          ? (next) => {
              seen?.push(next);
              setTypes(next);
            }
          : undefined
      }
      hooksEnabled={hooksEnabled}
    />
  );
}

function renderTimeline(props: HarnessProps = {}, handlers: FakeHandlers = {}, locale: 'en' | 'vi' = 'en') {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    sessionTimeline: () => makeEventPage([]),
    ...handlers,
  });
  const toasts = createToastStore();
  const rendered = renderWithProviders(<Harness {...props} />, {
    api,
    instance: INSTANCE,
    locale,
    wrap: (children) => <ToastStoreContext value={toasts}>{children}</ToastStoreContext>,
  });
  return { ...rendered, api, toasts };
}

describe('SessionTimeline: the filter', () => {
  it('says that choosing no category means every event, and asks the server for no category then', async () => {
    const { api } = renderTimeline();
    expect(screen.getByText(msg('tabs.events.intro'))).toBeInTheDocument();
    expect(msg('tabs.events.intro')).toMatch(/no category chosen, every event is shown/i);
    await waitFor(() => {
      expect(api.callsTo('sessionTimeline')).toHaveLength(1);
    });
    expect(api.callsTo('sessionTimeline')[0]?.query.has('category')).toBe(false);
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
  });

  it('offers the eight categories under the names of the Activity page', () => {
    renderTimeline();
    const group = screen.getByRole('group', { name: msg('tabs.events.categories') });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(8);
    expect(within(group).getByRole('checkbox', { name: msg('activity.category.compaction') })).toBeInTheDocument();
  });

  it('narrows the list to the chosen categories, in the order of the categories, and widens it again when none is left', async () => {
    const seen: EventCategory[][] = [];
    const { api } = renderTimeline({ seen });
    await userEvent.click(screen.getByRole('checkbox', { name: msg('activity.category.tool') }));
    await userEvent.click(screen.getByRole('checkbox', { name: msg('activity.category.prompt') }));
    expect(seen).toEqual([['tool'], ['prompt', 'tool']]);
    await waitFor(() => {
      expect(api.callsTo('sessionTimeline').some((call) => call.query.get('category') === 'prompt,tool')).toBe(true);
    });
    await userEvent.click(screen.getByRole('checkbox', { name: msg('activity.category.tool') }));
    await userEvent.click(screen.getByRole('checkbox', { name: msg('activity.category.prompt') }));
    expect(seen.at(-1)).toEqual([]);
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    // the list of every event was loaded at the start and is still fresh, so it is shown again without a new request
    expect(api.callsTo('sessionTimeline').filter((call) => !call.query.has('category'))).toHaveLength(1);
  });

  it('offers no filter when the page gives no handler', () => {
    renderTimeline({ filter: false });
    expect(screen.queryByRole('group', { name: msg('tabs.events.categories') })).toBeNull();
  });

  it('restricts the list to the chosen agent', async () => {
    const { api } = renderTimeline({ agentId: agentId(1) });
    await waitFor(() => {
      expect(api.callsTo('sessionTimeline')[0]?.query.get('agent')).toBe(agentId(1));
    });
  });
});

describe('SessionTimeline: the rows', () => {
  it('lists the events one per line and shows a gap as a separator', async () => {
    renderTimeline(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([
            makeEvent({ id: 3, summary: 'FIXTURE tool event', type: 'tool.call', category: 'tool' }),
            makeEvent({ id: 2, summary: 'FIXTURE missing events', type: 'monitor.gap', category: 'ingest' }),
            makeEvent({ id: 1, summary: 'FIXTURE failed', severity: 'error', type: 'tool.failure', category: 'tool' }),
          ]),
      },
    );
    expect(await screen.findByText('FIXTURE tool event')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('note')).toHaveTextContent(
      msg('tabs.events.gapDetail', { detail: 'FIXTURE missing events' }),
    );
    expect(screen.getByText('FIXTURE failed').closest('li')).toHaveClass('event-row--error');
  });

  it('draws the source tags only when the events differ in their sources', async () => {
    const { unmount } = renderTimeline(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([
            makeEvent({ id: 2, summary: 'FIXTURE a', sources: ['transcript'] }),
            makeEvent({ id: 1, summary: 'FIXTURE b', sources: ['transcript'] }),
          ]),
      },
    );
    await screen.findByText('FIXTURE a');
    expect(screen.queryByText(msg('tabs.events.source.transcript'))).toBeNull();
    expect(document.querySelector('.event-list--sources')).toBeNull();
    unmount();
    renderTimeline(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([
            makeEvent({ id: 2, summary: 'FIXTURE a', sources: ['hook', 'transcript'] }),
            makeEvent({ id: 1, summary: 'FIXTURE b', sources: ['transcript'] }),
          ]),
      },
    );
    await screen.findByText('FIXTURE a');
    expect(screen.getAllByText(msg('tabs.events.source.transcript'))).toHaveLength(2);
    expect(screen.getByText(msg('tabs.events.source.hook'))).toBeInTheDocument();
    expect(document.querySelector('.event-list--sources')).not.toBeNull();
  });

  it('keeps the details of a row open when the list refreshes', async () => {
    renderTimeline(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([makeEvent({ id: 4, type: 'tool.call', summary: 'FIXTURE row', details: { a: 'b' } })]),
      },
    );
    await userEvent.click(
      await screen.findByRole('button', { name: msg('tabs.events.details', { type: 'tool.call' }) }),
    );
    expect(document.getElementById('ev-details-4')).not.toBeNull();
  });
});

describe('SessionTimeline: the length of the list', () => {
  function pagedHandler(pages: number) {
    return (query: URLSearchParams) => {
      const page = query.get('cursor') === null ? 1 : Number(query.get('cursor'));
      const items = Array.from({ length: 2 }, (_unused, index) =>
        makeEvent({ id: 1000 - page * 10 - index, summary: `FIXTURE page ${String(page)} event ${String(index)}` }),
      );
      return makeEventPage(items, { nextCursor: page < pages ? String(page + 1) : null, total: pages * 2 });
    };
  }

  it('loads the next page on request, and appends it to the list', async () => {
    renderTimeline({}, { sessionTimeline: pagedHandler(2) });
    expect(await screen.findByText('FIXTURE page 1 event 0')).toBeInTheDocument();
    expect(
      screen.getByText(msg('common.loadMore.showingOf', { shown: 2, total: 4, noun: 'events' })),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: new RegExp(msg('common.loadMore.button', { count: 2 }).replace(/\d+/, '\\d+')),
      }),
    );
    expect(await screen.findByText('FIXTURE page 2 event 1')).toBeInTheDocument();
    expect(screen.getByText('FIXTURE page 1 event 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
  });

  it('stops offering more at the page limit and says to narrow the filters', async () => {
    renderTimeline({}, { sessionTimeline: pagedHandler(40) });
    await screen.findByText('FIXTURE page 1 event 0');
    for (let page = 2; page <= 20; page += 1) {
      await userEvent.click(
        screen.getByRole('button', {
          name: new RegExp(msg('common.loadMore.button', { count: 2 }).replace(/\d+/, '\\d+')),
        }),
      );
      await screen.findByText(`FIXTURE page ${String(page)} event 0`);
    }
    expect(screen.getByText(msg('common.loadMore.capped', { shown: 40, noun: 'events' }))).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: new RegExp(msg('common.loadMore.button', { count: 2 }).replace(/\d+/, '\\d+')),
      }),
    ).toBeNull();
  }, 60_000);
});

describe('SessionTimeline: when there is nothing to show', () => {
  it('says so while hooks are on', async () => {
    renderTimeline();
    expect(await screen.findByText(msg('tabs.events.empty.none'))).toBeInTheDocument();
  });

  it('explains that hooks may be off', async () => {
    renderTimeline({ hooksEnabled: false });
    expect(await screen.findByText(msg('tabs.events.empty.noHooks'))).toBeInTheDocument();
  });

  it('says that no event is in the chosen categories', async () => {
    renderTimeline({ initial: ['tool'], hooksEnabled: false });
    expect(await screen.findByText(msg('tabs.events.empty.filtered'))).toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    renderTimeline({}, { sessionTimeline: () => errorResponse('internal_error') });
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
  });

  it('shows a placeholder while the first page loads', () => {
    renderTimeline({}, { sessionTimeline: () => new Promise(() => undefined) });
    expect(screen.getByText(msg('tabs.events.loading'))).toBeInTheDocument();
  });

  it('is worded in Vietnamese', async () => {
    renderTimeline({}, {}, 'vi');
    expect(screen.getByText(msg('tabs.events.intro', undefined, 'vi'))).toBeInTheDocument();
    expect(await screen.findByText(msg('tabs.events.empty.none', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: msg('activity.category.tool', undefined, 'vi') })).toBeInTheDocument();
  });
});
