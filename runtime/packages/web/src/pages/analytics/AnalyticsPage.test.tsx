import type { CostSummary, InstanceInfo } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  makeInstance,
  makeSeriesPoint,
  makeToolFrequencyReport,
  makeToolFrequencyRow,
  makeUsage,
  makeUsageReport,
  makeUsageRow,
  makeUsageSeries,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { AnalyticsPage } from './AnalyticsPage.tsx';

const COST: CostSummary = {
  currency: 'USD',
  basis: 'estimate',
  source: 'configured_prices',
  amount: 4.26,
  pricedTokensPct: 92,
  pricedModels: ['model-a'],
  unpricedModels: ['model-z'],
  assumedCacheWriteTier: false,
  note: 'FIXTURE cost note',
};

const TOTALS = makeUsageRow({
  key: 'total',
  label: 'Total',
  usage: makeUsage({ input: 1200, output: 61_400, cacheCreation: 300, cacheRead: 9_240_000, total: 9_302_900 }),
  sessions: 4,
});
const ROWS = [makeUsageRow({ key: 'model-a', label: 'model-a', usage: TOTALS.usage, sessions: 4 })];

function instanceWith(features: Partial<InstanceInfo['features']>): InstanceInfo {
  const base = makeInstance();
  return { ...base, features: { ...base.features, ...features } };
}

interface Setup {
  route?: string;
  instance?: InstanceInfo;
  handlers?: FakeHandlers;
}

function renderPage(setup: Setup = {}) {
  const instance = setup.instance ?? instanceWith({ usageTrend: false, costEstimates: false });
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    analyticsUsage: () => makeUsageReport({ totals: TOTALS, rows: ROWS }),
    analyticsSeries: () =>
      makeUsageSeries({
        points: [makeSeriesPoint({ start: '2026-03-10T12:00:00.000Z' })],
        window: { from: null, to: '2026-03-11T00:00:00.000Z' },
      }),
    analyticsTools: () => makeToolFrequencyReport({ items: [makeToolFrequencyRow({ toolName: 'Bash', calls: 5 })] }),
    ...setup.handlers,
  });
  const wrap = (children: ReactNode): ReactNode => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>;
  const rendered = renderWithIntl(<AnalyticsPage />, { route: setup.route ?? '/analytics', api, instance, wrap });
  return { ...rendered, api };
}

function query(api: FakeApi, id: 'analyticsUsage' | 'analyticsSeries' | 'analyticsTools'): Record<string, string> {
  const call = api.callsTo(id)[0];
  if (call === undefined) throw new Error(`${id} was not called`);
  return Object.fromEntries(call.query.entries());
}

function tile(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-tile="${id}"]`);
  if (found === null) throw new Error(`no tile ${id}`);
  return found;
}

describe('AnalyticsPage', () => {
  it('renders one h1, the totals as the API reports them, the usage table and the tool table', async () => {
    const { api } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: msg('route.analytics.title') })).toBeInTheDocument();
    await screen.findByRole('table', { name: msg('analytics.table.caption', { group: msg('analytics.group.model') }) });
    expect(tile('output')).toHaveTextContent('61K');
    expect(within(tile('output')).getByTitle('61,400')).toBeInTheDocument();
    expect(within(tile('cacheRead')).getByTitle('9,240,000')).toBeInTheDocument();
    // Input (new) is input plus cache write, and the tile says what it is made of
    expect(within(tile('inputNew')).getByTitle('1,500')).toBeInTheDocument();
    expect(tile('inputNew')).toHaveTextContent(
      msg('tokens.inputNewTip', { input: '1,200', cacheWrite: '300', sum: '1,500' }),
    );
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(api.violations).toEqual([]);
  });

  it('sends the default query: the instance default range, grouped by model, with a row limit', async () => {
    const { api } = renderPage();
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(query(api, 'analyticsUsage')).toEqual({ groupBy: 'model', limit: '200', range: '7d' });
    expect(query(api, 'analyticsTools')).toEqual({ limit: '200', range: '7d' });
  });

  it('asks for the work item grouping when the page is grouped by task', async () => {
    const { api } = renderPage({ route: '/analytics?by=task&range=30d' });
    await screen.findByRole('table', { name: msg('analytics.table.caption', { group: msg('analytics.group.task') }) });
    expect(query(api, 'analyticsUsage')).toMatchObject({ groupBy: 'workItem', range: '30d' });
  });

  it('hides the cost when the report has none, and says why', async () => {
    renderPage();
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(document.querySelector('[data-tile="cost"]')).toBeNull();
    expect(screen.getByText(new RegExp(msg('analytics.note.noCost')))).toBeInTheDocument();
  });

  it('labels the cost as an estimate, with the share of priced tokens, and asks for it only when prices are configured', async () => {
    const { api } = renderPage({
      instance: instanceWith({ usageTrend: false, costEstimates: true }),
      handlers: { analyticsUsage: () => makeUsageReport({ totals: TOTALS, rows: ROWS, cost: COST }) },
    });
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    const cost = tile('cost');
    expect(within(cost).getByText('$4.26')).toBeInTheDocument();
    expect(within(cost).getByText(msg('analytics.cost.label'))).toBeInTheDocument();
    expect(cost).toHaveAttribute('title', msg('analytics.cost.estimateTip'));
    expect(within(cost).getByText(msg('analytics.cost.priced', { pct: '92%' }))).toBeInTheDocument();
    expect(screen.getByText(msg('analytics.cost.unpricedModels', { models: 'model-z' }))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(msg('analytics.note.cost')))).toBeInTheDocument();
    expect(api.callsTo('analyticsUsage').some((call) => call.query.get('includeCost') === '1')).toBe(true);
  });

  it('does not ask for the cost when prices are not configured', async () => {
    const { api } = renderPage();
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(api.callsTo('analyticsUsage').every((call) => !call.query.has('includeCost'))).toBe(true);
  });

  it('writes a total the monitor does not have as not available, never as 0', async () => {
    renderPage({
      handlers: {
        analyticsUsage: () =>
          makeUsageReport({
            totals: makeUsageRow({
              key: 'total',
              usage: makeUsage({
                output: null,
                input: null,
                cacheCreation: null,
                cacheRead: null,
                total: null,
                completeness: 'unavailable',
                turns: 2,
              }),
            }),
            rows: ROWS,
          }),
      },
    });
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    for (const id of ['output', 'inputNew', 'cacheRead']) {
      expect(tile(id)).toHaveTextContent(msg('tokens.na'));
      expect(within(tile(id)).getByText(msg('tokens.notAvailable'))).toHaveClass('sr-only');
    }
  });

  it('marks totals that are only a lower bound', async () => {
    renderPage({
      handlers: {
        analyticsUsage: () =>
          makeUsageReport({
            totals: makeUsageRow({ key: 'total', usage: makeUsage({ completeness: 'partial', lowerBound: true }) }),
            rows: ROWS,
          }),
      },
    });
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(screen.getAllByText(msg('tokens.lowerBound'))).toHaveLength(3);
  });

  it('draws no trend, and sends no series request, when the instance does not enable it', async () => {
    const { api, container } = renderPage();
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
    expect(container.querySelector('.trend')).toBeNull();
    expect(api.callsTo('analyticsSeries')).toHaveLength(0);
    expect(screen.queryByRole('combobox', { name: msg('analytics.filter.bucket') })).toBeNull();
  });

  it('draws the trend when the instance enables it, and sends the time zone offset of the browser', async () => {
    const { api, container } = renderPage({ instance: instanceWith({ usageTrend: true, costEstimates: false }) });
    await waitFor(() => {
      expect(container.querySelector('.trend .chart')).not.toBeNull();
    });
    const sent = query(api, 'analyticsSeries');
    expect(sent['bucket']).toBe('day');
    expect(sent['tzOffsetMinutes']).toBe(String(-new Date().getTimezoneOffset() || 0));
    expect(screen.getByRole('combobox', { name: msg('analytics.filter.bucket') })).toBeInTheDocument();
  });

  it('shows the series as a table on request', async () => {
    const user = userEvent.setup();
    renderPage({ instance: instanceWith({ usageTrend: true, costEstimates: false }) });
    await user.click(await screen.findByRole('button', { name: msg('analytics.trend.showTable') }));
    expect(screen.getByRole('table', { name: msg('analytics.trend.tableCaptionDay') })).toBeInTheDocument();
  });

  it('explains an empty range instead of showing zeros', async () => {
    renderPage({
      handlers: {
        analyticsUsage: () =>
          makeUsageReport({
            rows: [],
            totals: makeUsageRow({
              key: 'total',
              usage: makeUsage({
                output: null,
                input: null,
                cacheCreation: null,
                cacheRead: null,
                total: null,
                turns: 0,
              }),
            }),
          }),
      },
    });
    expect(await screen.findByText(msg('analytics.empty.title'))).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /Token usage/ })).toBeNull();
  });

  it('says when the table is cut at the row limit', async () => {
    renderPage({
      handlers: { analyticsUsage: () => makeUsageReport({ totals: TOTALS, rows: ROWS, rowsTruncated: true }) },
    });
    expect(await screen.findByText(msg('analytics.table.truncated', { count: 1 }))).toBeInTheDocument();
  });

  it('shows an error state for a usage report that cannot be loaded, with a retry', async () => {
    renderPage({ handlers: { analyticsUsage: () => errorResponse('internal_error') } });
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    await screen.findByRole('table', { name: msg('analytics.tools.caption') });
  });

  it('shows a loading status first', () => {
    renderPage();
    expect(screen.getByText(msg('analytics.loading'))).toBeInTheDocument();
  });

  it('is drawn in Vietnamese', async () => {
    renderWithIntl(<AnalyticsPage />, {
      locale: 'vi',
      route: '/analytics',
      api: createFakeApi({
        instance: () => instanceWith({ usageTrend: false, costEstimates: false }),
        analyticsUsage: () => makeUsageReport({ totals: TOTALS, rows: ROWS }),
        analyticsTools: () => makeToolFrequencyReport(),
      }),
      instance: instanceWith({ usageTrend: false, costEstimates: false }),
      wrap: (children) => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>,
    });
    expect(
      await screen.findByRole('table', { name: msg('analytics.tools.caption', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: msg('analytics.table.title', undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});
