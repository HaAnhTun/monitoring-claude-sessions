import type { SessionSummary } from '@mcs/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { createPrefs } from '../../lib/prefs.ts';
import { createPrefsStore, type PrefsStore } from '../../state/prefs-store.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandler } from '../../test/fake-api.ts';
import {
  makeHealth,
  makeInstance,
  makeMetric,
  makeOverview,
  makeSession,
  makeSessionPage,
  makeState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionExplorerPage } from './SessionExplorerPage.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

const INSTANCE = makeInstance();

function row(n: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({ id: sessionId(n), seq: n, label: `FIXTURE session ${String(n)}`, ...overrides });
}

interface Setup {
  route?: string;
  sessions?: FakeHandler;
  health?: FakeHandler;
  overview?: FakeHandler;
  toasts?: ReturnType<typeof createToastStore>;
  prefsStore?: PrefsStore;
  locale?: 'en' | 'vi';
}

function renderExplorer(setup: Setup = {}) {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    listSessions: setup.sessions ?? (() => makeSessionPage([row(1), row(2)], { total: 2 })),
    health: setup.health ?? (() => makeHealth('ok')),
    overview: setup.overview ?? (() => makeOverview({ metrics: [] })),
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ToastStoreContext value={setup.toasts ?? null}>
      <ShortcutRegistryProvider>
        <LocationProbe />
        {children}
      </ShortcutRegistryProvider>
    </ToastStoreContext>
  );
  const rendered = renderWithProviders(<SessionExplorerPage />, {
    route: setup.route ?? '/sessions',
    api,
    instance: INSTANCE,
    wrap,
    ...(setup.prefsStore === undefined ? {} : { prefsStore: setup.prefsStore }),
    ...(setup.locale === undefined ? {} : { locale: setup.locale }),
  });
  return { ...rendered, api };
}

function firstCall(api: FakeApi): URLSearchParams {
  const call = api.callsTo('listSessions')[0];
  if (call === undefined) throw new Error('listSessions was not called');
  return call.query;
}

function pagedSessions(pages: number): FakeHandler {
  return (query) => {
    const cursor = query.get('cursor');
    const index = cursor === null ? 0 : Number(cursor.slice(1));
    return makeSessionPage([row(index + 1)], {
      nextCursor: index + 1 < pages ? `c${String(index + 1)}` : null,
      total: pages,
    });
  };
}

/** A fake server that applies the filters the strip toggles use (`hasErrors` and `state`) to a fixed list. */
function filteringServer(all: SessionSummary[]): FakeHandler {
  return (query) => {
    let items = all;
    if (query.get('hasErrors') === '1') items = items.filter((item) => item.errorCount > 0);
    const states = query.get('state');
    if (states !== null) {
      const wanted = states.split(',');
      items = items.filter((item) => wanted.includes(item.state.state));
    }
    return makeSessionPage(items, { total: items.length });
  };
}

const MIXED: SessionSummary[] = [
  row(1),
  row(2, { errorCount: 1 }),
  row(3, { state: makeState('waiting_input') }),
  row(4, { state: makeState('running', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }) }),
  row(5, { state: makeState('failed'), errorCount: 2 }),
  row(6, { state: makeState('turn_ended') }),
];

function tile(name: string): HTMLElement {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => candidate.classList.contains('summary-tile') && candidate.textContent.includes(name));
  if (button === undefined) throw new Error(`no tile ${name}`);
  return button;
}

function figureOf(name: string): string | null | undefined {
  return tile(name).querySelector('.summary-tile__value > span[aria-hidden="true"]')?.textContent;
}

/** The label of a row, as written in the fixtures. */
function labelOf(element: HTMLElement): string | undefined {
  return /FIXTURE session [0-9]/.exec(element.textContent)?.[0];
}

function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

describe('SessionExplorerPage', () => {
  it('renders one h1 and the rows with their state, project, tokens and a link to the session', async () => {
    const { api } = renderExplorer({
      sessions: () =>
        makeSessionPage([row(1, { state: makeState('waiting_input'), projectLabel: 'FIXTURE proj' })], { total: 1 }),
    });
    expect(screen.getByRole('heading', { level: 1, name: msg('route.sessions.title') })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /FIXTURE session 1/ });
    expect(link).toHaveAttribute('href', `/sessions/${sessionId(1)}`);
    const tableRow = link.closest('tr');
    expect(tableRow).not.toBeNull();
    const cells = within(tableRow as HTMLElement);
    expect(cells.getByText(msg('state.waiting_input.label'))).toBeInTheDocument();
    // Output 50; Input (new) is input 100 + cache write 10.
    expect(cells.getByText('50')).toBeInTheDocument();
    expect(cells.getByText('110')).toBeInTheDocument();
    expect(api.violations).toEqual([]);
  });

  it('says how many sessions the list holds and for which time range', async () => {
    renderExplorer();
    await screen.findByRole('table');
    const summary = document.querySelector('.explorer__summary');
    expect(summary).toHaveTextContent(msg('sessions.summary.count', { count: 2 }));
    expect(summary).toHaveTextContent(msg('filters.range.24h'));
  });

  it('shows no second filter box: one search field, one filter form', async () => {
    renderExplorer();
    await screen.findByRole('table');
    expect(screen.getAllByRole('search')).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: msg('sessions.filter.search') })).toHaveLength(1);
  });
});

describe('SessionExplorerPage: loading, empty, error states', () => {
  it('shows a skeleton shaped like the table, with a status text and a strip of unknown figures, until the first page arrives', () => {
    renderExplorer({ sessions: () => new Promise<never>(() => undefined) });
    expect(screen.getByText(msg('sessions.loading'))).toBeInTheDocument();
    const skeleton = document.querySelector('.skeleton--table');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.querySelector('.skeleton__head')).not.toBeNull();
    expect(skeleton?.querySelectorAll('.skeleton__row')).toHaveLength(8);
    expect(screen.queryByRole('table')).toBeNull();
    expect(figureOf(msg('attention.working'))).toBe('–');
    expect(tile(msg('attention.working'))).toHaveTextContent(msg('common.notAvailable'));
  });

  it('replaces the skeleton by the table', async () => {
    renderExplorer();
    expect(screen.getByText(msg('sessions.loading'))).toBeInTheDocument();
    await screen.findByRole('table', { name: msg('sessions.table.caption') });
    expect(screen.queryByText(msg('sessions.loading'))).toBeNull();
  });

  it('explains an empty list without filters, flags the likely cause and offers the unmatched switch', async () => {
    const user = userEvent.setup();
    const health = makeHealth('ok');
    health.ingestion.transcripts.dirFound = false;
    renderExplorer({ sessions: () => makeSessionPage([], { total: 0 }), health: () => health });
    expect(await screen.findByText(msg('sessions.empty.title'))).toBeInTheDocument();
    const folderCause = screen.getByText(msg('sessions.empty.cause.folder'), { exact: false }).closest('li');
    await waitFor(() => {
      expect(folderCause).toHaveTextContent(msg('sessions.empty.likely'));
    });
    const unmatchedCause = screen.getByText(msg('sessions.empty.cause.unmatched'), { exact: false }).closest('li');
    expect(unmatchedCause).toHaveTextContent(msg('sessions.empty.likely'));
    expect(
      screen.getByText(msg('sessions.empty.cause.range', { range: msg('filters.range.24h') })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('sessions.empty.showUnmatched') }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?unmatched=1');
  });

  it('says no session matches when filters are active and offers exactly one way to clear them', async () => {
    const user = userEvent.setup();
    renderExplorer({
      route: '/sessions?errors=1&state=failed&sort=label&dir=asc',
      sessions: () => makeSessionPage([], { total: 0 }),
    });
    expect(await screen.findByText(msg('sessions.noMatch.title'))).toBeInTheDocument();
    expect(screen.queryByText(msg('sessions.empty.title'))).toBeNull();
    const clear = screen.getAllByRole('button', { name: /^Clear filters/ });
    expect(clear).toHaveLength(1);
    expect(clear[0]).toHaveTextContent(msg('sessions.noMatch.clear'));
    await user.click(clear[0]!);
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=label&dir=asc');
  });

  it('keeps the removable chips and the clear button of the bar when the list is not empty', async () => {
    renderExplorer({ route: '/sessions?project=billing' });
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }) })).toBeInTheDocument();
  });

  it('shows a load error with a retry when no data has arrived yet', async () => {
    renderExplorer({ sessions: () => errorResponse('internal_error', 'FIXTURE boom') });
    expect(await screen.findByText(/Could not load sessions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps the rows when a refetch fails and says how old they are (UI-I5)', async () => {
    let failing = false;
    const { queryClient } = renderExplorer({
      sessions: () =>
        failing ? errorResponse('internal_error', 'FIXTURE boom') : makeSessionPage([row(1)], { total: 1 }),
    });
    await screen.findByRole('link', { name: /FIXTURE session 1/ });
    failing = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.root(INSTANCE.instanceId) });
    });
    expect(await screen.findByText(/Could not refresh sessions/)).toBeInTheDocument();
    expect(screen.getByText(/Showing data from/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /FIXTURE session 1/ })).toBeInTheDocument();
    failing = false;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.root(INSTANCE.instanceId) });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Could not refresh sessions/)).toBeNull();
    });
  });

  it('renders the heading, not a crash, when the data providers are missing', () => {
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionExplorerPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: msg('route.sessions.title') })).toBeInTheDocument();
    expect(screen.getByText(msg('sessions.waiting'))).toBeInTheDocument();
  });

  it('speaks Vietnamese when the language is Vietnamese', async () => {
    renderExplorer({ locale: 'vi' });
    expect(
      screen.getByRole('heading', { level: 1, name: msg('route.sessions.title', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByText(msg('sessions.loading', undefined, 'vi'))).toBeInTheDocument();
    await screen.findByRole('table', { name: msg('sessions.table.caption', undefined, 'vi') });
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.state', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('sessions.columns.button', undefined, 'vi') })).toBeInTheDocument();
  });
});

describe('SessionExplorerPage: the query', () => {
  it('sends the default query: the window preset, last activity first, 100 rows and a total', async () => {
    const { api } = renderExplorer();
    await screen.findByRole('table');
    expect(Object.fromEntries(firstCall(api).entries())).toEqual({
      range: '24h',
      sort: 'lastActivity',
      dir: 'desc',
      limit: '100',
      includeTotal: '1',
    });
  });

  it('maps every URL filter to its API parameter (task is sent as workItem)', async () => {
    const { api } = renderExplorer({
      route:
        '/sessions?q=build&state=working,failed&project=p1&task=7&model=m1&errors=1&range=7d&tokMin=10&tokMax=900&sort=tokens&dir=asc&unmatched=1',
    });
    await screen.findByRole('table');
    expect(Object.fromEntries(firstCall(api).entries())).toEqual({
      q: 'build',
      state: 'working,failed',
      project: 'p1',
      workItem: '7',
      model: 'm1',
      hasErrors: '1',
      range: '7d',
      tokensMin: '10',
      tokensMax: '900',
      sort: 'tokens',
      dir: 'asc',
      includeUnmatched: '1',
      limit: '100',
      includeTotal: '1',
    });
    expect(firstCall(api).has('task')).toBe(false);
  });

  it('sends the errors sort of the server when the Errors header is pressed, and keeps the address in step', async () => {
    const user = userEvent.setup();
    const { api } = renderExplorer();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: msg('sessions.col.errors') }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=errors');
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.errors') })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await waitFor(() => {
      expect(api.callsTo('listSessions').some((call) => call.query.get('sort') === 'errors')).toBe(true);
    });
  });

  it('round-trips the address: a canonical form is kept, a sort and a direction survive', async () => {
    renderExplorer({ route: '/sessions?sort=label&dir=asc&range=7d&errors=1' });
    await screen.findByRole('table');
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?errors=1&range=7d&sort=label&dir=asc');
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.session') })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByRole('combobox', { name: msg('sessions.filter.range') })).toHaveValue('7d');
    expect(screen.getByRole('checkbox', { name: msg('sessions.filter.errors') })).toBeChecked();
  });

  it('lists ignored filters once, canonicalises the address and lets the user dismiss the note', async () => {
    const user = userEvent.setup();
    renderExplorer({ route: '/sessions?bogus=1&sort=nope&errors=1' });
    expect(await screen.findByText(msg('filters.ignored', { keys: 'bogus, sort' }))).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?errors=1');
    await user.click(screen.getByRole('button', { name: msg('filters.dismiss') }));
    expect(screen.queryByText(msg('filters.ignored', { keys: 'bogus, sort' }))).toBeNull();
  });

  it('does not send a one-character search (the server needs two) and says so', async () => {
    const { api } = renderExplorer({ route: '/sessions?q=a' });
    await screen.findByRole('table');
    expect(firstCall(api).has('q')).toBe(false);
    expect(screen.getByText(msg('sessions.searchHint'))).toBeInTheDocument();
  });

  it('sends a two-character search and does not show the hint', async () => {
    const { api } = renderExplorer({ route: '/sessions?q=ab' });
    await screen.findByRole('table');
    expect(firstCall(api).get('q')).toBe('ab');
    expect(screen.queryByText(msg('sessions.searchHint'))).toBeNull();
  });

  it('aborts the previous request when a filter changes', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const { api } = renderExplorer({
      sessions: (query, request) => {
        if (query.get('q') === 'ab') {
          if (request.signal !== null) signals.push(request.signal);
          return new Promise<never>(() => undefined);
        }
        return makeSessionPage([row(1)], { total: 1 });
      },
    });
    await screen.findByRole('table');
    await user.type(screen.getByRole('textbox', { name: msg('sessions.filter.search') }), 'ab');
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);
    await user.type(screen.getByRole('textbox', { name: msg('sessions.filter.search') }), 'c');
    await waitFor(() => {
      expect(api.callsTo('listSessions').some((call) => call.query.get('q') === 'abc')).toBe(true);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?q=abc');
  });

  it('keeps the previous rows visible and busy while a new filter loads', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    renderExplorer({
      sessions: (query) => {
        if (query.get('q') === 'slow') {
          return new Promise((resolve) => {
            release = () => {
              resolve(makeSessionPage([row(9, { label: 'FIXTURE filtered' })], { total: 1 }));
            };
          });
        }
        return makeSessionPage([row(1)], { total: 1 });
      },
    });
    await screen.findByRole('link', { name: /FIXTURE session 1/ });
    await user.type(screen.getByRole('textbox', { name: msg('sessions.filter.search') }), 'slow{Enter}');
    expect(await screen.findByText(msg('sessions.updating'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /FIXTURE session 1/ })).toBeInTheDocument();
    expect(screen.getByTestId('explorer-results')).toHaveAttribute('aria-busy', 'true');
    act(() => {
      release();
    });
    expect(await screen.findByRole('link', { name: /FIXTURE filtered/ })).toBeInTheDocument();
    expect(screen.queryByText(msg('sessions.updating'))).toBeNull();
    expect(screen.getByTestId('explorer-results')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('keeps aria-sort and the URL in sync when a header is clicked', async () => {
    const user = userEvent.setup();
    const { api } = renderExplorer({
      prefsStore: storeWithColumns(['state', 'label', 'lastActivity', 'errors', 'output']),
    });
    await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.lastActivity') })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.output') })).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: msg('sessions.col.lastActivity') }));
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.lastActivity') })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?dir=asc');

    await user.click(screen.getByRole('button', { name: msg('sessions.col.output') }));
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.output') })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.lastActivity') })).toHaveAttribute(
      'aria-sort',
      'none',
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=tokens');
    await waitFor(() => {
      expect(api.callsTo('listSessions').some((call) => call.query.get('sort') === 'tokens')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: new RegExp(`^${msg('sessions.col.session')}`) }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=label&dir=asc');
  });
});

function storeWithColumns(columns: string[]): PrefsStore {
  const store = createPrefsStore(createPrefs(null));
  store.setPref('tableColumns', { sessions: columns });
  return store;
}

describe('SessionExplorerPage: paging', () => {
  it('loads more pages and appends the rows after the previous ones', async () => {
    const user = userEvent.setup();
    const { api } = renderExplorer({ sessions: pagedSessions(3) });
    await screen.findByRole('link', { name: /FIXTURE session 1/ });
    expect(screen.getByText('Showing 1 of 3 sessions')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Load .* more/ }));
    await screen.findByRole('link', { name: /FIXTURE session 2/ });
    expect(api.callsTo('listSessions')[1]?.query.get('cursor')).toBe('c1');
    const names = screen.getAllByRole('link', { name: /FIXTURE session/ }).map((a) => a.textContent);
    expect(names[0]).toContain('FIXTURE session 1');
    expect(names[1]).toContain('FIXTURE session 2');
    expect(screen.getByText('Showing 2 of 3 sessions')).toBeInTheDocument();
  });

  it('stops at 10 pages and shows the capped note instead of the button', async () => {
    const user = userEvent.setup();
    renderExplorer({ sessions: pagedSessions(30) });
    await screen.findByRole('link', { name: /^FIXTURE session 1 / });
    for (let loaded = 1; loaded < 10; loaded += 1) {
      await user.click(await screen.findByRole('button', { name: /Load .* more/ }));
      await screen.findByRole('link', { name: new RegExp(`^FIXTURE session ${String(loaded + 1)} `) });
    }
    expect(
      await screen.findByText(/Showing the first 10 sessions; narrow the filters to see others/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load .* more/ })).toBeNull();
  });

  it('shows a toast when the server rejects the cursor and restarts from the first page', async () => {
    const user = userEvent.setup();
    const toasts = createToastStore();
    let rejectCursor = true;
    const { api } = renderExplorer({
      toasts,
      sessions: (query) =>
        query.get('cursor') !== null && rejectCursor
          ? (() => {
              rejectCursor = false;
              return errorResponse('cursor_invalid');
            })()
          : makeSessionPage([row(1)], { nextCursor: query.get('cursor') === null ? 'c1' : null, total: 3 }),
    });
    await screen.findByRole('link', { name: /FIXTURE session 1/ });
    await user.click(screen.getByRole('button', { name: /Load .* more/ }));
    await waitFor(() => {
      expect(toasts.getSnapshot().map((t) => t.message)).toEqual([msg('error.handling.listChanged')]);
    });
    await waitFor(() => {
      expect(api.callsTo('listSessions').filter((call) => call.query.get('cursor') === null).length).toBeGreaterThan(1);
    });
  });

  it('counts at least N sessions in the summary when more pages exist and the server did not count', async () => {
    renderExplorer({
      sessions: () => makeSessionPage([row(1), row(2)], { nextCursor: 'c1', total: null }),
    });
    await screen.findByRole('table');
    expect(document.querySelector('.explorer__summary')).toHaveTextContent(
      msg('sessions.summary.countAtLeast', { count: 2 }),
    );
  });
});

describe('SessionExplorerPage: the attention strip', () => {
  it('counts the four tiles from the rows, and the counts equal the rows they stand for', async () => {
    renderExplorer({ sessions: filteringServer(MIXED) });
    await screen.findByRole('table');
    expect(bodyRows()).toHaveLength(6);
    expect(figureOf(msg('attention.working'))).toBe('3');
    expect(figureOf(msg('attention.quiet'))).toBe('1');
    expect(figureOf(msg('attention.errors'))).toBe('2');
    expect(figureOf(msg('attention.waiting'))).toBe('1');
    const states = bodyRows().map((r) => r.querySelector('[data-state]')?.getAttribute('data-state'));
    expect(states.filter((s) => s === 'working' || s === 'running')).toHaveLength(3);
  });

  it('puts the filter of a pressed tile in the address, narrows the list and keeps the counts equal to the rows', async () => {
    const user = userEvent.setup();
    renderExplorer({ sessions: filteringServer(MIXED) });
    await screen.findByRole('table');

    await user.click(tile(msg('attention.errors')));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?errors=1');
    expect(tile(msg('attention.errors'))).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(2);
    });
    expect(figureOf(msg('attention.errors'))).toBe('2');

    await user.click(tile(msg('attention.working')));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?state=active');
    expect(tile(msg('attention.errors'))).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(3);
    });
    expect(figureOf(msg('attention.working'))).toBe('3');

    await user.click(tile(msg('attention.waiting')));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?state=waiting_input');
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    expect(figureOf(msg('attention.waiting'))).toBe('1');

    await user.click(tile(msg('attention.waiting')));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/sessions$/);
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(6);
    });
  });

  it('narrows the loaded rows to the quiet ones for the quiet tile', async () => {
    const user = userEvent.setup();
    renderExplorer({ sessions: filteringServer(MIXED) });
    await screen.findByRole('table');
    await user.click(tile(msg('attention.quiet')));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?state=running%2Cworking');
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    expect(bodyRows()[0]).toHaveTextContent('FIXTURE session 4');
    expect(figureOf(msg('attention.quiet'))).toBe('1');
  });

  it('shows the monitor count while the list is not filtered, and the count of the rows once a tile is pressed', async () => {
    const user = userEvent.setup();
    renderExplorer({
      sessions: filteringServer(MIXED),
      overview: () => makeOverview({ metrics: [makeMetric({ key: 'sessions.active', value: 9 })] }),
    });
    await screen.findByRole('table');
    await waitFor(() => {
      expect(figureOf(msg('attention.working'))).toBe('9');
    });
    await user.click(tile(msg('attention.errors')));
    await waitFor(() => {
      expect(figureOf(msg('attention.working'))).toBe('1');
    });
  });

  it('marks the rows with errors for the left bar', async () => {
    renderExplorer({ sessions: filteringServer(MIXED) });
    await screen.findByRole('table');
    expect(bodyRows().map((r) => r.classList.contains('session-row--error'))).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
  });
});

describe('SessionExplorerPage: Attention first', () => {
  it('orders the loaded rows by attention, asks the server for the newest activity, and keeps the order while rows change in place', async () => {
    const user = userEvent.setup();
    let current = MIXED;
    const { api, queryClient } = renderExplorer({
      sessions: () => makeSessionPage(current, { total: current.length }),
    });
    await screen.findByRole('table');
    expect(bodyRows().map(labelOf)).toEqual([
      'FIXTURE session 1',
      'FIXTURE session 2',
      'FIXTURE session 3',
      'FIXTURE session 4',
      'FIXTURE session 5',
      'FIXTURE session 6',
    ]);

    await user.click(screen.getByRole('button', { name: msg('sessions.sort.attention') }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=attention');
    expect(screen.getByRole('button', { name: msg('sessions.sort.attention') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Errors (and failed) first, then waiting for input, then quiet, then working, then the rest; equal ranks keep their order.
    const order = (): (string | undefined)[] => bodyRows().map(labelOf);
    expect(order()).toEqual([
      'FIXTURE session 2',
      'FIXTURE session 5',
      'FIXTURE session 3',
      'FIXTURE session 4',
      'FIXTURE session 1',
      'FIXTURE session 6',
    ]);
    await waitFor(() => {
      expect(api.callsTo('listSessions').at(-1)?.query.get('sort')).toBe('lastActivity');
    });
    expect(api.callsTo('listSessions').at(-1)?.query.get('dir')).toBe('desc');
    for (const column of screen.getAllByRole('columnheader')) {
      if (column.querySelector('button') !== null) expect(column).toHaveAttribute('aria-sort', 'none');
    }

    // Session 1 now has an error: it is updated in place and the rows do not jump under the reader.
    current = current.map((item) => (item.id === sessionId(1) ? { ...item, errorCount: 3 } : item));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.root(INSTANCE.instanceId) });
    });
    await waitFor(() => {
      expect(bodyRows()[4]).toHaveTextContent(msg('sessions.errors.count', { count: 3 }));
    });
    expect(order()).toEqual([
      'FIXTURE session 2',
      'FIXTURE session 5',
      'FIXTURE session 3',
      'FIXTURE session 4',
      'FIXTURE session 1',
      'FIXTURE session 6',
    ]);

    await user.click(screen.getByRole('button', { name: msg('sessions.sort.attention') }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/sessions$/);
    expect(order()[0]).toBe('FIXTURE session 1');
  });
});

describe('SessionExplorerPage: columns', () => {
  it('draws the default columns, with Duration renamed and every empty column gone', async () => {
    renderExplorer();
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      msg('sessions.col.state'),
      msg('sessions.col.session'),
      msg('sessions.col.lastActivity'),
      msg('sessions.col.errors'),
      msg('sessions.col.output'),
      msg('sessions.col.input'),
    ]);
  });

  it('draws the columns of the stored choice and changes them from the Columns button', async () => {
    const user = userEvent.setup();
    // A wide window: Started hides below 1280 px.
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const prefsStore = storeWithColumns(['label', 'started']);
    renderExplorer({ prefsStore });
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      msg('sessions.col.session'),
      msg('sessions.col.started'),
    ]);
    await user.click(screen.getByRole('button', { name: msg('sessions.columns.button') }));
    await user.click(screen.getByRole('checkbox', { name: msg('sessions.col.errors') }));
    expect(prefsStore.getSnapshot().tableColumns).toEqual({ sessions: ['label', 'started', 'errors'] });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      msg('sessions.col.session'),
      msg('sessions.col.started'),
      msg('sessions.col.errors'),
    ]);
    await user.click(screen.getByRole('button', { name: msg('sessions.columns.reset') }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(6);
  });

  it('draws cards without a Columns button below 900 px', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      matches: query === '(max-width: 899px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    renderExplorer();
    await screen.findByRole('list', { name: msg('sessions.table.caption') });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: msg('sessions.columns.button') })).toBeNull();
  });
});

describe('SessionExplorerPage: the keyboard', () => {
  it('moves the focus to the next and the previous row with j and k, and Enter opens the row', async () => {
    const user = userEvent.setup();
    renderExplorer({ sessions: () => makeSessionPage([row(1), row(2), row(3)], { total: 3 }) });
    await screen.findByRole('table');
    const links = screen.getAllByRole('link', { name: /FIXTURE session/ });
    await user.keyboard('j');
    expect(links[0]).toHaveFocus();
    await user.keyboard('j');
    expect(links[1]).toHaveFocus();
    await user.keyboard('j');
    await user.keyboard('j');
    expect(links[2]).toHaveFocus();
    await user.keyboard('k');
    expect(links[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(`/sessions/${sessionId(2)}`);
  });

  it('does not take j and k from the search field', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await screen.findByRole('table');
    const box = screen.getByRole('textbox', { name: msg('sessions.filter.search') });
    await user.click(box);
    await user.keyboard('jk');
    expect(box).toHaveValue('jk');
  });
});
