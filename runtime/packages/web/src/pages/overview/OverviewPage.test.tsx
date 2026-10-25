import type { ActivityEvent, Metric, Overview, SessionSummary } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { StreamProvider } from '../../stream/StreamProvider.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { createFakeEventSources } from '../../test/fake-event-source.ts';
import {
  FIXTURE_INSTANCE_ID,
  iso,
  makeEvent,
  makeEventPage,
  makeHealth,
  makeInstance,
  makeMetric,
  makeOverview,
  makePage,
  makeSession,
  makeState,
  makeUsage,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../../test/render.tsx';
import { OverviewPage } from './OverviewPage.tsx';

const INSTANCE = makeInstance();

function session(
  n: number,
  state: Parameters<typeof makeState>[0],
  over: Partial<SessionSummary> = {},
): SessionSummary {
  return makeSession({
    id: sessionId(n),
    label: `FIXTURE session ${String(n)}`,
    lastActivityAt: iso(-n * 60),
    state: makeState(state),
    usageInclSubagents: makeUsage({ output: 1000 * n }),
    ...over,
  });
}

const SESSIONS: SessionSummary[] = [
  session(1, 'working'),
  session(2, 'waiting_input'),
  session(3, 'turn_ended', { errorCount: 2 }),
  session(4, 'working', { state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }) }),
  session(5, 'completed'),
];

const METRICS: Metric[] = [
  makeMetric({ key: 'sessions.active', label: 'Active sessions', value: 2, link: '/sessions?state=active' }),
  makeMetric({ key: 'sessions.waiting_input', value: 1, link: '/sessions?state=waiting_input' }),
  makeMetric({ key: 'events.errors', value: 6, link: '/activity?severity=error' }),
  makeMetric({
    key: 'tokens.output',
    unit: 'tokens',
    value: 61_400,
    link: '/analytics',
    source: 'usage.output_tokens',
    rule: 'FIXTURE output rule',
  }),
  makeMetric({ key: 'tokens.input_new', unit: 'tokens', value: 118_900, link: '/analytics' }),
  makeMetric({ key: 'tokens.cache_read', unit: 'tokens', value: 9_240_000, link: '/analytics' }),
  makeMetric({ key: 'cost.estimate', unit: 'currency', currency: 'USD', value: 4.26, link: '/analytics' }),
];

function event(n: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({
    id: n,
    seq: 100 + n,
    key: `t:fixture-${String(n)}`,
    at: iso(-n),
    summary: `FIXTURE event ${String(n)}`,
    ...over,
  });
}

function overviewOf(over: Partial<Overview> = {}): Overview {
  return makeOverview({
    metrics: METRICS,
    recentErrors: [event(901, { severity: 'error', type: 'tool.failure', summary: 'FIXTURE recent error' })],
    alerts: { open: 1, critical: 0, items: [] },
    ...over,
  });
}

interface Harness {
  api: FakeApi;
  rendered: ReturnType<typeof renderWithIntl>;
}

function setup(handlers: FakeHandlers = {}, options: RenderOptions = {}): Harness {
  const sources = createFakeEventSources();
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () => makeHealth('ok'),
    overview: () => overviewOf(),
    listSessions: () => makePage(SESSIONS, { total: SESSIONS.length }),
    listEvents: () => makeEventPage(Array.from({ length: 20 }, (_unused, i) => event(i + 1))),
    ...handlers,
  });
  const wrap = (children: ReactNode): ReactNode => (
    <StreamProvider esFactory={sources.factory}>{children}</StreamProvider>
  );
  const rendered = renderWithIntl(<OverviewPage />, { api, instance: INSTANCE, wrap, ...options });
  return { api, rendered };
}

function strip(): HTMLElement {
  return screen.getByRole('list', { name: msg('attention.label') });
}

function section(titleKey: Parameters<typeof msg>[0]): HTMLElement {
  return screen.getByRole('region', { name: msg(titleKey as 'overview.attention.title') });
}

function tile(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-metric="${key}"]`);
  if (found === null) throw new Error(`no tile for ${key}`);
  return found;
}

/** The tiles of the figures are drawn (the label "Output" is also a column header, so the tile is the sign). */
async function figuresReady(key = 'tokens.output'): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-metric="' + key + '"]')).not.toBeNull();
  });
}

describe('OverviewPage', () => {
  it('shows the heading, sets the document title and says which time range the figures cover', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: msg('route.overview.title') })).toBeInTheDocument();
    expect(document.title).toContain(msg('route.overview.title'));
    expect(await screen.findByText(/^Figures cover the time since/)).toBeInTheDocument();
  });

  it('shows only its heading until the app providers are there', () => {
    setup({}, { instanceId: null });
    expect(screen.getByRole('heading', { level: 1, name: msg('route.overview.title') })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: msg('attention.label') })).toBeNull();
  });

  it('draws the attention strip as links to the filtered session lists, with the counts of the monitor', async () => {
    setup();
    await screen.findByText('FIXTURE session 1');
    const links = within(strip()).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/sessions?state=active',
      '/sessions?state=running,working',
      '/sessions?errors=1',
      '/sessions?state=waiting_input',
    ]);
    // Working and waiting come from the metrics; quiet and errors are counted in the rows (all of them are loaded).
    expect(links[0]).toHaveTextContent(/^2/);
    expect(links[1]).toHaveTextContent(/^1/);
    expect(links[2]).toHaveTextContent(/^1/);
    expect(links[3]).toHaveTextContent(/^1/);
  });

  it('asks for the same first page of sessions as the Sessions page does without a filter', async () => {
    const { api } = setup();
    await screen.findByText('FIXTURE session 1');
    const query = api.callsTo('listSessions').at(-1)?.query;
    expect(query?.get('includeTotal')).toBe('1');
    expect(query?.get('state')).toBeNull();
    expect(query?.get('hasErrors')).toBeNull();
  });

  it('lists the sessions that need attention, the most urgent first, and those that run now', async () => {
    setup();
    const attention = await screen.findByRole('list', { name: msg('overview.attention.list') });
    const titles = within(attention)
      .getAllByRole('listitem')
      .map((item) => within(item).getAllByRole('link')[0]?.textContent);
    expect(titles).toEqual(['FIXTURE session 3', 'FIXTURE session 2', 'FIXTURE session 4']);
    const running = screen.getByRole('table', { name: msg('overview.running.caption') });
    expect(within(running).getByRole('link', { name: 'FIXTURE session 1' })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
    expect(within(running).queryByRole('link', { name: 'FIXTURE session 5' })).toBeNull();
  });

  it('draws a tile for each metric the server returned, with token figures and the estimated cost', async () => {
    setup();
    await figuresReady();
    expect(within(tile('tokens.output')).getByText('61K')).toHaveAttribute('title', '61,400');
    expect(within(tile('tokens.input_new')).getByText('119K')).toBeInTheDocument();
    expect(within(tile('tokens.cache_read')).getByText('9.2M')).toBeInTheDocument();
    expect(within(tile('cost.estimate')).getByText('$4.26')).toBeInTheDocument();
    expect(within(tile('cost.estimate')).getByText(msg('metric.estimate'))).toBeInTheDocument();
  });

  it('leaves out the tiles of metrics the server did not return, with no zero in their place', async () => {
    setup({
      overview: () =>
        overviewOf({
          metrics: METRICS.filter((metric) => !metric.key.startsWith('tokens.') && !metric.key.startsWith('cost.')),
        }),
    });
    await screen.findByText(msg('metric.sessions.waiting_input'));
    expect(document.querySelector('[data-metric^="tokens."]')).toBeNull();
    expect(document.querySelector('[data-metric^="cost."]')).toBeNull();
    expect(screen.queryByRole('region', { name: msg('overview.figures.usage') })).toBeNull();
    expect(screen.queryByText(msg('metric.tokens.output'))).toBeNull();
  });

  it('says that the monitor has no figures yet when it returns no metric at all', async () => {
    setup({ overview: () => overviewOf({ metrics: [] }) });
    expect(await screen.findByText(msg('overview.figures.empty'))).toBeInTheDocument();
    expect(document.querySelector('[data-metric]')).toBeNull();
  });

  it('shows the source and the rule of a metric exactly as the server wrote them, in a tip that opens with the keyboard', async () => {
    const user = userEvent.setup();
    setup();
    await figuresReady();
    const trigger = within(tile('tokens.output')).getByRole('button', {
      name: msg('metric.info', { label: msg('metric.tokens.output') }),
    });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('usage.output_tokens')).toBeInTheDocument();
    expect(screen.getByText('FIXTURE output rule')).toBeInTheDocument();
  });

  it('links the tiles of states to their sessions and the tokens to the page of the server', async () => {
    setup();
    await figuresReady();
    expect(within(tile('events.errors')).getByRole('link')).toHaveAttribute('href', '/activity?severity=error');
    expect(within(tile('tokens.output')).getByRole('link')).toHaveAttribute('href', '/analytics');
    expect(within(tile('sessions.waiting_input')).getByRole('link')).toHaveAttribute(
      'href',
      '/sessions?state=waiting_input',
    );
  });

  it('shows the recent errors, the compact feed of at most fifteen events and the ingestion summary', async () => {
    setup();
    expect(await screen.findByText('FIXTURE recent error')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('overview.errors.viewAll') })).toHaveAttribute(
      'href',
      '/activity?severity=error',
    );
    const activity = section('overview.activity.title');
    await waitFor(() => {
      expect(within(activity).getAllByRole('listitem')).toHaveLength(15);
    });
    expect(within(activity).getByRole('link', { name: msg('overview.activity.viewAll') })).toHaveAttribute(
      'href',
      '/activity',
    );
    const ingestion = section('overview.ingestion.title');
    expect(within(ingestion).getByRole('link', { name: msg('overview.ingestion.details') })).toHaveAttribute(
      'href',
      '/settings?section=health',
    );
    await waitFor(() => {
      expect(ingestion).toHaveTextContent(msg('overview.ingestion.alerts'));
    });
  });

  it('mounts the workspace panels of the instance in the side column', () => {
    setup();
    const side = screen.getByRole('complementary', { name: msg('overview.side.label') });
    const panels = side.querySelector('[data-slot="workspace-panels"]');
    expect(panels).not.toBeNull();
    expect(
      within(panels as HTMLElement).getByRole('heading', { level: 2, name: msg('panels.git.title') }),
    ).toBeInTheDocument();
  });

  it('shows placeholders while the data loads, not zeros', () => {
    setup({ overview: () => new Promise(() => undefined), listSessions: () => new Promise(() => undefined) });
    expect(screen.getByText(msg('overview.attention.loading'))).toBeInTheDocument();
    expect(screen.getByText(msg('overview.running.loading'))).toBeInTheDocument();
    expect(screen.getByText(msg('overview.figures.loading'))).toBeInTheDocument();
    for (const link of within(strip()).queryAllByRole('link')) expect(link).not.toHaveTextContent(/^0/);
  });

  it('keeps the rest of the page usable when the overview cannot be loaded', async () => {
    setup({ overview: () => errorResponse('internal_error') });
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(await screen.findByText('FIXTURE session 3')).toBeInTheDocument();
    // The strip falls back to the rows that are loaded.
    expect(within(strip()).getAllByRole('link')[0]).toHaveTextContent(/^2/);
    expect(screen.getByRole('table', { name: msg('overview.running.caption') })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: msg('overview.ingestion.title') })).toBeInTheDocument();
    expect(document.querySelector('[data-metric]')).toBeNull();
  });

  it('keeps the figures usable when the sessions cannot be loaded', async () => {
    setup({ listSessions: () => errorResponse('internal_error') });
    await figuresReady();
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: msg('overview.attention.title') })).toBeNull();
    expect(tile('tokens.output')).toBeInTheDocument();
  });

  it('keeps the data on screen with the dashed outline and the as-of line when a refresh fails', async () => {
    const { api, rendered } = setup();
    await figuresReady();
    api.handlers.overview = () => errorResponse('internal_error');
    await rendered.queryClient.refetchQueries({ queryKey: qk.overview(FIXTURE_INSTANCE_ID) });
    await waitFor(() => {
      expect(document.querySelector('.overview__main')).toHaveAttribute('data-stale', 'true');
    });
    expect(document.querySelector('.stale-indicator')).toHaveTextContent(msg('overview.scope'));
    expect(within(tile('tokens.output')).getByText('61K')).toBeInTheDocument();
  });

  it('explains an empty instance and offers the ways out, while the ingestion summary stays', async () => {
    setup({
      listSessions: () => makePage([], { total: 0 }),
      overview: () => overviewOf({ metrics: [], recentErrors: [] }),
      listEvents: () => makeEventPage([]),
    });
    expect(await screen.findByRole('heading', { level: 2, name: msg('overview.empty.title') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('overview.empty.showAll') })).toHaveAttribute(
      'href',
      '/sessions?range=all',
    );
    expect(screen.getByRole('link', { name: msg('overview.empty.health') })).toHaveAttribute(
      'href',
      '/settings?section=health',
    );
    expect(screen.queryByRole('list', { name: msg('attention.label') })).toBeNull();
    expect(screen.getByRole('region', { name: msg('overview.ingestion.title') })).toBeInTheDocument();
  });

  it('speaks Vietnamese and writes the compact figures for it', async () => {
    setup({}, { locale: 'vi' });
    expect(
      screen.getByRole('heading', { level: 1, name: msg('route.overview.title', undefined, 'vi') }),
    ).toBeInTheDocument();
    await figuresReady();
    expect(within(tile('tokens.output')).getByText(/^61\s?N$/)).toHaveAttribute('title', '61.400');
    expect(
      screen.getByRole('heading', { level: 2, name: msg('overview.attention.title', undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});
