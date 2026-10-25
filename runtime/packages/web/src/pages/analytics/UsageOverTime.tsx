import type { SeriesPoint, UsageSeries } from '@mcs/shared';
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { Button } from '../../components/Button.tsx';
import { DataTable, type Column } from '../../components/DataTable.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useAnalytics } from '../../data/hooks/useAnalytics.ts';
import type { ApiQuery } from '../../data/query-keys.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import type { Formatters } from '../../i18n/format.ts';
import type { MessageKey } from '../../i18n/types.ts';
import {
  buildAxis,
  niceMax,
  peakSlot,
  SERIES_METRICS,
  tickSlots,
  type Axis,
  type SeriesMetric,
} from './trend-model.ts';

const METRIC_LABEL = {
  output: 'tokens.output',
  input: 'tokens.input',
  cacheCreation: 'tokens.cacheWrite',
  cacheRead: 'tokens.cacheRead',
} as const satisfies Readonly<Record<SeriesMetric, MessageKey>>;

// The drawing area in viewBox units. The svg stretches to the width of its box, so the labels are HTML (crisp, wrapping) and only
// the marks live in the svg.
const VIEW_W = 600;
const VIEW_H = 140;
const BAR_MAX_W = 24;
const BAR_FILL = 0.7;
const MIN_BAR_H = 2;
const DAY_MS = 86_400_000;
const LONG_SPAN_DAYS = 300;
const GRID_FRACTIONS = [0, 0.5, 1] as const;

interface WhenFormat {
  /** A short label for the axis. */
  axis: (ms: number) => string;
  /** The full day (and hour) of a bucket, for names, tooltips and the table. */
  full: (ms: number) => string;
}

/** Formats the instant of a bucket in the language shown: the day for a day bucket, the day and the hour for an hour bucket. */
function useWhenFormat(bucket: UsageSeries['bucket'], axis: Axis | null): WhenFormat {
  const { locale } = useFormat();
  const spanMs = axis === null ? 0 : axis.count * axis.stepMs;
  return useMemo(() => {
    const hour = bucket === 'hour';
    const singleDay = hour && spanMs <= DAY_MS;
    const dayLabel = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      ...(spanMs > LONG_SPAN_DAYS * DAY_MS ? { year: '2-digit' } : {}),
      ...(hour ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
    });
    const clockLabel = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const full = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(hour ? { timeStyle: 'short', hourCycle: 'h23' } : {}),
    });
    return {
      axis: (ms: number) => (singleDay ? clockLabel.format(ms) : dayLabel.format(ms)),
      full: (ms: number) => full.format(ms),
    };
  }, [locale, bucket, spanMs]);
}

interface ChartProps {
  axis: Axis;
  metric: SeriesMetric;
  when: WhenFormat;
  format: Formatters;
}

function tickClass(position: number, total: number): string {
  if (position === 0) return 'chart__tick chart__tick--first';
  if (position === total - 1) return 'chart__tick chart__tick--last';
  return 'chart__tick';
}

function TrendChart({ axis, metric, when, format }: ChartProps) {
  const t = useT();
  const rawId = useId();
  const patternId = `hatch-${rawId.replaceAll(/[^a-zA-Z0-9]/g, '')}`;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [tabStop, setTabStop] = useState<number | null>(null);
  const label = t(METRIC_LABEL[metric]);

  const present = axis.slots.flatMap((point, index) => (point === null ? [] : [index]));
  const max = niceMax(Math.max(0, ...axis.slots.map((point) => point?.[metric] ?? 0)));
  const slotW = VIEW_W / axis.count;
  const barW = Math.min(BAR_MAX_W, slotW * BAR_FILL);
  const roving = tabStop !== null && present.includes(tabStop) ? tabStop : (present[0] ?? null);
  const slotMs = (index: number): number => axis.startMs + index * axis.stepMs;

  const peak = peakSlot(axis.slots, metric);
  const first = present[0];
  const last = present.at(-1);
  const peakPoint = peak === null ? null : (axis.slots[peak] ?? null);
  const summary =
    first === undefined || last === undefined || peak === null || peakPoint === null
      ? label
      : t('analytics.trend.summary', {
          label,
          from: when.full(slotMs(first)),
          to: when.full(slotMs(last)),
          count: present.length,
          max: format.number(peakPoint[metric]),
          peak: when.full(slotMs(peak)),
        });

  const shown = focused ?? hover;
  const shownPoint = shown === null ? null : (axis.slots[shown] ?? null);
  const tipStyle: CSSProperties & { '--x': number } = { '--x': (((shown ?? 0) + 0.5) / axis.count) * 100 };

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    if (svgRef.current === null) return;
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const hits = Array.from(svgRef.current.querySelectorAll<SVGRectElement>('.chart__hit'));
    const at = hits.findIndex((hit) => hit === document.activeElement);
    if (at === -1) return;
    event.preventDefault();
    let next = hits.length - 1;
    if (event.key === 'ArrowRight') next = Math.min(hits.length - 1, at + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    hits[next]?.focus();
  }

  return (
    <figure className="chart" data-metric={metric}>
      <figcaption className="chart__title">{label}</figcaption>
      <div className="chart__body">
        <div className="chart__yaxis" aria-hidden="true">
          <span>{format.compact(max)}</span>
          <span>0</span>
        </div>
        <div className="chart__plot">
          <svg
            ref={svgRef}
            className="chart__svg"
            viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={summary}
            onKeyDown={onKeyDown}
          >
            <defs>
              <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect className="chart__hatch-bg" width="6" height="6" />
                <line className="chart__hatch-line" x1="0" y1="0" x2="0" y2="6" />
              </pattern>
            </defs>
            {GRID_FRACTIONS.map((fraction) => (
              <line
                key={fraction}
                className="chart__grid"
                x1="0"
                x2={VIEW_W}
                y1={VIEW_H * fraction}
                y2={VIEW_H * fraction}
              />
            ))}
            {axis.slots.map((point, index) => {
              if (point === null) return null;
              const value = point[metric];
              const height = value > 0 ? Math.max(MIN_BAR_H, (value / max) * VIEW_H) : 0;
              const partial = point.completeness === 'partial';
              const args = { when: when.full(slotMs(index)), label, value: format.number(value) };
              const name = partial ? t('analytics.trend.barPartial', args) : t('analytics.trend.bar', args);
              return (
                <g key={point.start}>
                  {height > 0 ? (
                    <rect
                      className={partial ? 'chart__bar chart__bar--partial' : 'chart__bar'}
                      x={index * slotW + (slotW - barW) / 2}
                      y={VIEW_H - height}
                      width={barW}
                      height={height}
                      rx="2"
                      style={partial ? { fill: `url(#${patternId})` } : undefined}
                    />
                  ) : null}
                  <rect
                    className="chart__hit"
                    x={index * slotW}
                    y="0"
                    width={slotW}
                    height={VIEW_H}
                    tabIndex={index === roving ? 0 : -1}
                    role="img"
                    aria-label={name}
                    data-partial={partial ? 'true' : undefined}
                    onFocus={() => {
                      setFocused(index);
                      setTabStop(index);
                    }}
                    onBlur={() => {
                      setFocused(null);
                    }}
                    onPointerEnter={() => {
                      setHover(index);
                    }}
                    onPointerLeave={() => {
                      setHover(null);
                    }}
                  />
                </g>
              );
            })}
          </svg>
          {shown === null || shownPoint === null ? null : (
            <div className="chart__tip" aria-hidden="true" style={tipStyle}>
              <span className="chart__tip-when">{when.full(slotMs(shown))}</span>
              <span>{`${label} ${format.number(shownPoint[metric])}`}</span>
              {shownPoint.completeness === 'partial' ? <span className="muted">{t('tokens.lowerBound')}</span> : null}
            </div>
          )}
          <div className="chart__xaxis" aria-hidden="true">
            {tickSlots(axis.count).map((slot, position, all) => (
              <span
                key={slot}
                className={tickClass(position, all.length)}
                style={
                  position > 0 && position < all.length - 1
                    ? { left: `${String(((slot + 0.5) / axis.count) * 100)}%` }
                    : undefined
                }
              >
                {when.axis(slotMs(slot))}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

function TrendTable({ series, when }: { series: UsageSeries; when: WhenFormat }) {
  const t = useT();
  const format = useFormat();
  const numeric = (metric: SeriesMetric): Column<SeriesPoint> => ({
    id: metric,
    header: t(METRIC_LABEL[metric]),
    numeric: true,
    cell: (row) => format.number(row[metric]),
    value: (row) => row[metric],
  });
  const columns: Column<SeriesPoint>[] = [
    {
      id: 'when',
      header: t('analytics.trend.interval'),
      nowrap: true,
      cell: (row) => when.full(Date.parse(row.start)),
    },
    ...SERIES_METRICS.map(numeric),
    {
      id: 'bound',
      header: t('analytics.trend.completeness'),
      hideWhenEmpty: true,
      cell: (row) =>
        row.completeness === 'partial' ? (
          <TagBadge tone="partial" tip={t('analytics.trend.partialTip')}>
            {t('tokens.lowerBound')}
          </TagBadge>
        ) : null,
      value: (row) => row.completeness === 'partial',
    },
  ];
  return (
    <DataTable
      caption={t(series.bucket === 'hour' ? 'analytics.trend.tableCaptionHour' : 'analytics.trend.tableCaptionDay')}
      columns={columns}
      rows={series.points}
      rowKey={(row) => row.start}
    />
  );
}

export interface UsageOverTimeProps {
  series: UsageSeries;
}

/**
 * Four small-multiple column charts of the token categories (04 4.4.6): one hue, one scale per chart, a bucket the server omitted
 * left blank (never a zero bar), a bucket with unfinished messages hatched ("lower bound"). The bars are named and reachable by
 * keyboard (one tab stop per chart, the arrow keys move between bars); "Show as table" swaps the charts for the same numbers.
 */
export function UsageOverTime({ series }: UsageOverTimeProps) {
  const t = useT();
  const format = useFormat();
  const [asTable, setAsTable] = useState(false);
  const axis = useMemo(() => buildAxis(series), [series]);
  const when = useWhenFormat(series.bucket, axis);
  const headingId = useId();

  return (
    <section className="trend" aria-labelledby={headingId}>
      <div className="trend__head">
        <h2 id={headingId}>{t('analytics.trend.title')}</h2>
        {axis === null ? null : (
          <Button
            aria-pressed={asTable}
            onClick={() => {
              setAsTable((value) => !value);
            }}
          >
            {t(asTable ? 'analytics.trend.showChart' : 'analytics.trend.showTable')}
          </Button>
        )}
      </div>
      {axis === null ? (
        <p className="muted">{t('analytics.trend.noData')}</p>
      ) : (
        <>
          {asTable ? (
            <TrendTable series={series} when={when} />
          ) : (
            <div className="trend__grid">
              {SERIES_METRICS.map((metric) => (
                <TrendChart key={metric} axis={axis} metric={metric} when={when} format={format} />
              ))}
            </div>
          )}
          <p className="muted trend__notes">
            <span>{t('analytics.trend.gapNote')}</span>
            {series.points.some((point) => point.completeness === 'partial') ? (
              <span className="trend__legend">
                <span className="trend__swatch" aria-hidden="true" />
                {t('analytics.trend.partialLegend')}
              </span>
            ) : null}
            {axis.clipped ? <span>{t('analytics.trend.clipped', { count: axis.count })}</span> : null}
          </p>
        </>
      )}
    </section>
  );
}

export interface UsageTrendProps {
  /** The canonical series query (the page adds `tzOffsetMinutes`). */
  query: ApiQuery;
}

/** Loads the series and draws `UsageOverTime`; the page mounts it only when the instance enables the trend. */
export function UsageTrend({ query }: UsageTrendProps) {
  const t = useT();
  const result = useAnalytics('series', query);
  if (result.data === undefined) {
    return result.isError ? (
      <ErrorState
        kind="load"
        subjectKey="error.subject.analytics"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="tiles" rows={4} label={t('analytics.loading')} />
    );
  }
  return <UsageOverTime series={result.data} />;
}
