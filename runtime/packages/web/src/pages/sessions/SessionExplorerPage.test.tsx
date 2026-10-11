import type { SessionSummary } from '@mcs/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandler } from '../../test/fake-api.ts';
import {
  makeHealth,
  makeInstance,
  makeSession,
  makeSessionPage,
  makeState,
  makeUsage,
  sessionId,
} from '../../test/fixtures/index.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionExplorerPage } from './SessionExplorerPage.tsx';

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
  toasts?: ReturnType<typeof createToastStore>;
}

function renderExplorer(setup: Setup = {}) {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    listSessions: setup.sessions ?? (() => makeSessionPage([row(1), row(2)], { total: 2 })),
    health: setup.health ?? (() => makeHealth('ok')),
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

describe('SessionExplorerPage', () => {
  it('renders one h1 and the rows with their state, project, tokens and a link to the session', async () => {
    const { api } = renderExplorer({
      sessions: () =>
        makeSessionPage([row(1, { state: makeState('waiting_input'), projectLabel: 'FIXTURE proj' })], { total: 1 }),
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /FIXTURE session 1/ });
    expect(link).toHaveAttribute('href', `/sessions/${sessionId(1)}`);
    const tableRow = link.closest('tr');
    expect(tableRow).not.toBeNull();
    const cells = within(tableRow as HTMLElement);
    expect(cells.getByText('Waiting for input')).toBeInTheDocument();
    expect(cells.getByText('FIXTURE proj')).toBeInTheDocument();
    expect(cells.getByText(/out 50 · new input 110 · cache read 200/)).toBeInTheDocument();
    expect(api.violations).toEqual([]);
  });

  it('shows a loading skeleton with a status text until the first page arrives', async () => {
    renderExplorer();
    expect(screen.getByText('Loading sessions')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.queryByText('Loading sessions')).toBeNull();
  });

  it('sends the default query: the window preset, last activity first, 100 rows and a total', async () => {
    const { api } = renderExplorer();
    await screen.findByRole('table');
    const query = firstCall(api);
    expect(Object.fromEntries(query.entries())).toEqual({
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

  it('does not send a one-character search (the server needs two) and says so', async () => {
    const { api } = renderExplorer({ route: '/sessions?q=a' });
    await screen.findByRole('table');
    expect(firstCall(api).has('q')).toBe(false);
    expect(screen.getByText('Type at least 2 characters to search.')).toBeInTheDocument();
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
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'ab');
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'c');
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
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'slow{Enter}');
    expect(await screen.findByText('Updating...')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /FIXTURE session 1/ })).toBeInTheDocument();
    expect(screen.getByTestId('explorer-results')).toHaveAttribute('aria-busy', 'true');
    act(() => {
      release();
    });
    expect(await screen.findByRole('link', { name: /FIXTURE filtered/ })).toBeInTheDocument();
    expect(screen.queryByText('Updating...')).toBeNull();
    expect(screen.getByTestId('explorer-results')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('keeps aria-sort and the URL in sync when a header is clicked', async () => {
    const user = userEvent.setup();
    const { api } = renderExplorer();
    await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: /Last activity/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Tokens/ })).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: /Last activity/ }));
    expect(screen.getByRole('columnheader', { name: /Last activity/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?dir=asc');

    await user.click(screen.getByRole('button', { name: /Tokens/ }));
    expect(screen.getByRole('columnheader', { name: /Tokens/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Last activity/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=tokens');
    await waitFor(() => {
      expect(api.callsTo('listSessions').some((call) => call.query.get('sort') === 'tokens')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: /^Session/ }));
    expect(screen.getByRole('columnheader', { name: /^Session/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=label&dir=asc');
  });

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

  it('explains an empty list without filters, flags the likely cause and offers the unmatched switch', async () => {
    const user = userEvent.setup();
    const health = makeHealth('ok');
    health.ingestion.transcripts.dirFound = false;
    renderExplorer({ sessions: () => makeSessionPage([], { total: 0 }), health: () => health });
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
    const folderCause = screen.getByText(/transcripts folder was not found/i).closest('li');
    await waitFor(() => {
      expect(folderCause).toHaveTextContent('Likely here');
    });
    const unmatchedCause = screen.getByText(/no project rule matched/i).closest('li');
    expect(unmatchedCause).toHaveTextContent('Likely here');
    expect(screen.getByText(/last 24 hours/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show unmatched sessions' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?unmatched=1');
  });

  it('says no session matches when filters are active and clears them with one button', async () => {
    const user = userEvent.setup();
    renderExplorer({
      route: '/sessions?errors=1&state=failed&sort=label&dir=asc',
      sessions: () => makeSessionPage([], { total: 0 }),
    });
    expect(await screen.findByText('No session matches these filters')).toBeInTheDocument();
    expect(screen.queryByText('No sessions yet')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: /Clear filters/ })[0]!);
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?sort=label&dir=asc');
  });

  it('shows a load error with a retry when no data has arrived yet', async () => {
    renderExplorer({ sessions: () => errorResponse('internal_error', 'FIXTURE boom') });
    expect(await screen.findByText(/Could not load sessions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
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

  it('never shows 0 tokens for numbers the monitor does not have', async () => {
    renderExplorer({
      sessions: () =>
        makeSessionPage(
          [
            row(1, {
              usageInclSubagents: makeUsage({
                input: null,
                output: null,
                cacheCreation: null,
                cacheRead: null,
                total: null,
                completeness: 'unavailable',
                scannedPct: null,
              }),
            }),
            row(2, { usageInclSubagents: makeUsage({ output: null, completeness: 'partial', lowerBound: true }) }),
          ],
          { total: 2 },
        ),
    });
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('not available')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/out n\/a/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('lower bound')).toBeInTheDocument();
    for (const r of rows) expect(r).not.toHaveTextContent(/out 0\b/);
  });

  it('tags rows: hooks and transcript sources, partial history, stale', async () => {
    renderExplorer({
      sessions: () =>
        makeSessionPage(
          [
            row(1, { sources: { hooks: true, transcript: true } }),
            row(2, { partial: true, state: makeState('stale') }),
          ],
          { total: 2 },
        ),
    });
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('hooks')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('transcript')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('partial history')).toBeInTheDocument();
    expect(within(rows[1]!).getAllByText('Stale').length).toBeGreaterThan(0);
  });

  it('lists ignored filters once, canonicalises the address and lets the user dismiss the note', async () => {
    const user = userEvent.setup();
    renderExplorer({ route: '/sessions?bogus=1&sort=nope&errors=1' });
    expect(await screen.findByText('Ignored invalid or unknown filter: bogus, sort')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/sessions?errors=1');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Ignored invalid or unknown filter/)).toBeNull();
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
      expect(toasts.getSnapshot().map((t) => t.message)).toEqual(['The list changed; reloaded from the top']);
    });
    await waitFor(() => {
      expect(api.callsTo('listSessions').filter((call) => call.query.get('cursor') === null).length).toBeGreaterThan(1);
    });
  });

  it('renders the heading, not a crash, when the data providers are missing', () => {
    render(
      <MemoryRouter initialEntries={['/sessions']}>
        <SessionExplorerPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
  });
});
