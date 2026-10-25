import { toQuery, type UsageReport } from '@mcs/shared';
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { FilterBar, useUrlState, type FilterField } from '../../components/FilterBar.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { toAnalyticsSeriesFilter, toAnalyticsToolsFilter, toAnalyticsUsageFilter } from '../../data/endpoints.ts';
import { useAnalytics } from '../../data/hooks/useAnalytics.ts';
import { ApiContext, InstanceIdContext, useInstance } from '../../data/hooks/useInstance.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { tokenParts } from '../../lib/format.ts';
import { ANALYTICS_GROUPS, analyticsSpec, formatUrlState, type AnalyticsUrlState } from '../../lib/url-state.ts';
import { NumberCell, useMoney } from './figures.tsx';
import { ToolFrequency } from './ToolFrequency.tsx';
import { GROUP_LABEL, UsageTable } from './UsageTable.tsx';
import { UsageTrend } from './UsageOverTime.tsx';

/** Rows asked of the usage report (the server caps at 500) and of the tool report (the server caps at 200). */
const USAGE_ROWS = 200;
const TOOL_ROWS = 200;
const BUCKETS = ['hour', 'day'] as const;

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

/** The offset the server aligns the buckets to: minutes east of UTC in the zone of the browser. */
function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset() || 0;
}

interface TileProps {
  id: string;
  label: string;
  /** The figure, drawn by the caller (a number, a currency amount, "n/a"). */
  value: ReactNode;
  /** One muted line under the figure. */
  note?: ReactNode;
  tag?: ReactNode;
  /** What the figure is (the title of the tile). */
  tip?: string;
}

function Tile({ id, label, value, note, tag, tip }: TileProps) {
  return (
    <li className="metric-tile" data-tile={id} title={tip}>
      <span className="metric-tile__label">
        {label}
        {tag}
      </span>
      <span className="metric-tile__value">{value}</span>
      {note === undefined ? null : <span className="metric-tile__note">{note}</span>}
    </li>
  );
}

function Totals({ report }: { report: UsageReport }) {
  const t = useT();
  const format = useFormat();
  const money = useMoney();
  const { usage } = report.totals;
  const parts = usage.completeness === 'unavailable' ? null : tokenParts(usage);
  const { cost } = report;
  const inputNote =
    usage.input === null || usage.cacheCreation === null || parts?.newInput === null || parts === null
      ? undefined
      : t('tokens.inputNewTip', {
          input: format.number(usage.input),
          cacheWrite: format.number(usage.cacheCreation),
          sum: format.number(parts.newInput),
        });
  // A lower bound is said on the figures it concerns (ADR 0074 decision 5).
  const bound =
    usage.completeness === 'partial' || usage.lowerBound ? (
      <TagBadge tone="partial" tip={t('tokens.lowerBoundUnknown')}>
        {t('tokens.lowerBound')}
      </TagBadge>
    ) : undefined;
  const facts: string[] = [];
  if (cost !== null && cost.unpricedModels.length > 0) {
    facts.push(t('analytics.cost.unpricedModels', { models: cost.unpricedModels.join(', ') }));
  }
  if (cost?.assumedCacheWriteTier === true) facts.push(t('analytics.cost.assumedTier'));
  return (
    <div className="analytics__totals">
      <ul className="metric-tiles" aria-label={t('analytics.totals.label')}>
        <Tile
          id="output"
          label={t('tokens.output')}
          tag={bound}
          value={<NumberCell value={parts?.out ?? null} compact />}
        />
        <Tile
          id="inputNew"
          label={t('tokens.inputNew')}
          tag={bound}
          value={<NumberCell value={parts?.newInput ?? null} compact />}
          note={inputNote}
        />
        <Tile
          id="cacheRead"
          label={t('tokens.cacheRead')}
          tag={bound}
          value={<NumberCell value={parts?.cacheRead ?? null} compact />}
        />
        {cost === null ? null : (
          <Tile
            id="cost"
            label={t('analytics.cost.label')}
            tip={t('analytics.cost.estimateTip')}
            value={money(cost.amount, cost.currency)}
            note={t('analytics.cost.priced', { pct: format.percent(cost.pricedTokensPct / 100) })}
          />
        )}
      </ul>
      {facts.length === 0 ? null : <p className="muted analytics__facts">{facts.join(' ')}</p>}
    </div>
  );
}

function countActive(state: AnalyticsUrlState): number {
  const keys = new Set<string>();
  for (const key of formatUrlState(analyticsSpec, state).keys())
    keys.add(key === 'from' || key === 'to' ? 'range' : key);
  return keys.size;
}

function Analytics() {
  const t = useT();
  const title = t('route.analytics.title');
  const headingRef = usePageChrome(title);
  const instance = useInstance();
  const features = instance.data?.features ?? null;
  const trendEnabled = features?.usageTrend === true;
  const [state, setState, ignored] = useUrlState(analyticsSpec);
  const [dismissed, setDismissed] = useState<string[] | null>(null);

  const usageQuery = useMemo(
    () =>
      toQuery({
        ...toAnalyticsUsageFilter(state),
        limit: USAGE_ROWS,
        ...(features?.costEstimates === true ? { includeCost: true } : {}),
      }),
    [state, features?.costEstimates],
  );
  const toolsQuery = useMemo(() => toQuery({ ...toAnalyticsToolsFilter(state), limit: TOOL_ROWS }), [state]);
  const seriesQuery = useMemo(
    () => toQuery({ ...toAnalyticsSeriesFilter(state), tzOffsetMinutes: tzOffsetMinutes() }),
    [state],
  );
  const usage = useAnalytics('usage', usageQuery);
  const tools = useAnalytics('tools', toolsQuery);

  const groupOptions = ANALYTICS_GROUPS.map((value) => ({ value, label: t(GROUP_LABEL[value]) }));
  const bucketOptions = BUCKETS.map((value) => ({
    value,
    label: t(value === 'hour' ? 'analytics.bucket.hour' : 'analytics.bucket.day'),
  }));
  const fields: FilterField[] = [
    {
      kind: 'range',
      id: 'analytics-range',
      label: t('analytics.filter.range'),
      value: state.range,
      defaultValue: analyticsSpec.range.default,
      onChange: (range) => {
        setState({ range });
      },
    },
    {
      kind: 'select',
      id: 'analytics-by',
      label: t('analytics.filter.groupBy'),
      value: state.by,
      options: groupOptions,
      defaultValue: 'model',
      onChange: (value) => {
        const by = ANALYTICS_GROUPS.find((group) => group === value);
        if (by !== undefined) setState({ by });
      },
    },
    ...(trendEnabled
      ? [
          {
            kind: 'select',
            id: 'analytics-bucket',
            label: t('analytics.filter.bucket'),
            value: state.bucket,
            options: bucketOptions,
            defaultValue: 'day',
            onChange: (value: string) => {
              const bucket = BUCKETS.find((candidate) => candidate === value);
              if (bucket !== undefined) setState({ bucket });
            },
          } satisfies FilterField,
        ]
      : []),
  ];
  const clearAll = useCallback(() => {
    setState({ range: analyticsSpec.range.default, by: 'model', bucket: 'day' });
  }, [setState]);

  let usageBody: ReactNode;
  const report = usage.data;
  if (report === undefined) {
    usageBody = usage.isError ? (
      <ErrorState
        kind={kindOf(usage.error)}
        subjectKey="error.subject.analytics"
        error={usage.error}
        onRetry={() => {
          void usage.refetch();
        }}
      />
    ) : (
      <>
        <Skeleton variant="tiles" rows={3} label={t('analytics.loading')} />
        <Skeleton variant="table" rows={5} columns={6} label={t('analytics.table.loading')} />
      </>
    );
  } else if (report.rows.length === 0 && report.totals.usage.turns === 0) {
    usageBody = (
      <EmptyState title={t('analytics.empty.title')} icon="analytics">
        <p>{t('analytics.empty.body')}</p>
      </EmptyState>
    );
  } else {
    usageBody = (
      <>
        <Totals report={report} />
        <section className="analytics__section" aria-labelledby="analytics-usage-h">
          <h2 id="analytics-usage-h">{t('analytics.table.title')}</h2>
          <UsageTable rows={report.rows} groupBy={state.by} range={state.range} />
          {report.rowsTruncated ? (
            <p className="muted">{t('analytics.table.truncated', { count: report.rows.length })}</p>
          ) : null}
        </section>
        {trendEnabled ? <UsageTrend query={seriesQuery} /> : null}
      </>
    );
  }

  let toolsBody: ReactNode;
  if (tools.data === undefined) {
    toolsBody = tools.isError ? (
      <ErrorState
        kind={kindOf(tools.error)}
        subjectKey="error.subject.tools"
        error={tools.error}
        onRetry={() => {
          void tools.refetch();
        }}
      />
    ) : (
      <Skeleton variant="table" rows={4} columns={5} label={t('analytics.tools.loading')} />
    );
  } else if (tools.data.items.length === 0) {
    toolsBody = <p className="muted">{t('analytics.tools.empty')}</p>;
  } else {
    toolsBody = <ToolFrequency report={tools.data} />;
  }

  const refreshFailing = usage.isError && usage.data !== undefined;
  return (
    <section className="page analytics">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <FilterBar
        label={t('analytics.filter.label')}
        fields={fields}
        primary={fields}
        ignoredKeys={ignored.length > 0 && dismissed !== ignored ? ignored : []}
        onDismissIgnored={() => {
          setDismissed(ignored);
        }}
        activeCount={countActive(state)}
        onClearAll={clearAll}
      />
      <p className="muted analytics__source">
        {t('analytics.note.source')} {report?.cost === null ? t('analytics.note.noCost') : t('analytics.note.cost')}
      </p>
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.analytics"
          error={usage.error}
          lastGoodAt={usage.dataUpdatedAt}
          onRetry={() => {
            void usage.refetch();
          }}
        />
      ) : null}
      <div className="analytics__results" aria-busy={usage.isFetching && report === undefined}>
        {usageBody}
      </div>
      <section className="analytics__section" aria-labelledby="analytics-tools-h">
        <h2 id="analytics-tools-h">{t('analytics.tools.title')}</h2>
        {toolsBody}
      </section>
    </section>
  );
}

function AnalyticsUnavailable() {
  const t = useT();
  const title = t('route.analytics.title');
  const headingRef = usePageChrome(title);
  return (
    <section className="page analytics">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <p className="muted">{t('analytics.waiting')}</p>
    </section>
  );
}

/**
 * `/analytics`: totals, the trend charts when the instance enables them, usage per group and tool frequency (04 4.4.6). Until the
 * app providers are mounted it shows only its heading, so the route never crashes the shell.
 */
export function AnalyticsPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <AnalyticsUnavailable /> : <Analytics />;
}
