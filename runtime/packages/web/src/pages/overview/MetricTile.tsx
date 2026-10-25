import type { Metric, OVERVIEW_METRIC_KEYS } from '@mcs/shared';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';

import { InfoTip } from '../../components/InfoTip.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import { useMoney } from '../analytics/figures.tsx';

type MetricKey = (typeof OVERVIEW_METRIC_KEYS)[number];

/**
 * The words of the metrics the UI knows (ADR 0074 decision 5 for the tokens). A key that is not here, such as `cost.reported`
 * with its own label from the provider, is drawn with the label the server sent, marked as server text.
 */
const LABEL_KEYS = {
  'sessions.active': 'metric.sessions.active',
  'sessions.waiting_input': 'metric.sessions.waiting_input',
  'sessions.turn_ended': 'metric.sessions.turn_ended',
  'sessions.completed': 'metric.sessions.completed',
  'sessions.failed': 'metric.sessions.failed',
  'sessions.stale': 'metric.sessions.stale',
  'sessions.unknown': 'metric.sessions.unknown',
  'agents.running': 'metric.agents.running',
  'events.errors': 'metric.events.errors',
  'tokens.input': 'metric.tokens.input',
  'tokens.input_new': 'metric.tokens.input_new',
  'tokens.output': 'metric.tokens.output',
  'tokens.cache_creation': 'metric.tokens.cache_creation',
  'tokens.cache_read': 'metric.tokens.cache_read',
  'cost.estimate': 'metric.cost.estimate',
  'alerts.open': 'metric.alerts.open',
} as const satisfies Partial<Record<MetricKey, MessageKey>>;

type LabelKey = (typeof LABEL_KEYS)[keyof typeof LABEL_KEYS];

function labelKeyOf(key: string): LabelKey | null {
  const found = Object.entries(LABEL_KEYS).find(([known]) => known === key);
  return found === undefined ? null : found[1];
}

/** Where a state count leads when the server sent no link. Tokens and cost follow the server link only. */
const STATE_LINKS: Readonly<Record<string, string>> = {
  'sessions.active': '/sessions?state=active',
  'sessions.waiting_input': '/sessions?state=waiting_input',
  'sessions.turn_ended': '/sessions?state=turn_ended',
  'sessions.completed': '/sessions?state=completed',
  'sessions.failed': '/sessions?state=failed',
  'sessions.stale': '/sessions?state=stale',
  'sessions.unknown': '/sessions?state=unknown',
};

/** A path of this application. The link comes from the server, so a full address or a protocol-relative one is never followed. */
function isAppPath(link: string): boolean {
  return link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\');
}

/** The page a tile opens: the server link when it is a path of this application, else the page of a state count. */
export function metricLink(metric: Pick<Metric, 'key' | 'link'>): string | null {
  if (metric.link !== null && isAppPath(metric.link)) return metric.link;
  return Object.hasOwn(STATE_LINKS, metric.key) ? (STATE_LINKS[metric.key] ?? null) : null;
}

/** Whether the value of a metric can be shown: a null value, or a metric the monitor marks unavailable, is "not available". */
export function metricKnown(metric: Pick<Metric, 'value' | 'completeness'>): boolean {
  return metric.value !== null && metric.completeness !== 'unavailable';
}

export interface MetricTileProps {
  metric: Metric;
}

function Figure({ metric }: MetricTileProps) {
  const t = useT();
  const format = useFormat();
  const money = useMoney();
  const { value } = metric;
  if (value === null || !metricKnown(metric)) {
    return (
      <span className="overview-tile__value overview-tile__value--unknown">
        <span aria-hidden="true">–</span>
        <span className="sr-only">{t('common.notAvailable')}</span>
      </span>
    );
  }
  const lowerBound = metric.completeness === 'partial';
  let text: string;
  let exact: string | undefined;
  switch (metric.unit) {
    case 'count':
      text = format.number(value);
      break;
    case 'tokens':
      text = format.compact(value);
      exact = format.number(value);
      break;
    case 'currency':
      text =
        metric.currency === undefined
          ? format.number(value, { maximumFractionDigits: 2 })
          : money(value, metric.currency);
      break;
    case 'ms':
      text = format.duration(value / 1000);
      exact = format.number(value);
      break;
    case 'bytes':
      text = format.bytes(value);
      exact = format.number(value);
      break;
  }
  const shown = lowerBound && metric.unit === 'count' ? `${text}+` : text;
  return (
    <span className="overview-tile__value" title={exact}>
      {shown}
    </span>
  );
}

function Tags({ metric }: MetricTileProps) {
  const t = useT();
  const tags: ReactNode[] = [];
  if (metric.key === 'cost.estimate') {
    tags.push(
      <TagBadge key="estimate" tone="neutral" tip={t('analytics.cost.estimateTip')}>
        {t('metric.estimate')}
      </TagBadge>,
    );
  }
  if (metric.completeness === 'partial' && metricKnown(metric)) {
    tags.push(
      <TagBadge key="lower" tone="partial" tip={t('metric.lowerBound.tip')}>
        {t('metric.lowerBound')}
      </TagBadge>,
    );
  }
  return tags.length === 0 ? null : <span className="overview-tile__tags">{tags}</span>;
}

/**
 * One figure of the overview (04 4.4.1): its label, the headline number at 28 px with its unit, a completeness tag and an info
 * tip that shows the source and the rule exactly as the server wrote them (every metric must say where it comes from and how it
 * is counted). A value the server did not give is "not available", never 0. The tile is a link when the metric has a page.
 */
export function MetricTile({ metric }: MetricTileProps) {
  const t = useT();
  const figureId = useId();
  const labelKey = labelKeyOf(metric.key);
  const label: ReactNode = labelKey === null ? <ServerText>{metric.label}</ServerText> : t(labelKey);
  const labelText = labelKey === null ? metric.label : t(labelKey);
  const href = metricLink(metric);
  return (
    <div className="overview-tile" data-metric={metric.key}>
      <div className="overview-tile__head">
        <span className="overview-tile__label">
          {href === null ? (
            label
          ) : (
            <Link to={href} className="overview-tile__link" aria-describedby={figureId}>
              {label}
            </Link>
          )}
        </span>
        <InfoTip label={t('metric.info', { label: labelText })}>
          <dl className="overview-tile__tip">
            <div>
              <dt>{t('metric.source')}</dt>
              <dd>
                <ServerText>{metric.source}</ServerText>
              </dd>
            </div>
            <div>
              <dt>{t('metric.rule')}</dt>
              <dd>
                <ServerText>{metric.rule}</ServerText>
              </dd>
            </div>
          </dl>
        </InfoTip>
      </div>
      <p className="overview-tile__figure" id={figureId}>
        <Figure metric={metric} />
        {metric.unit === 'tokens' && metricKnown(metric) ? (
          <span className="overview-tile__unit">{t('metric.unit.tokens')}</span>
        ) : null}
        <Tags metric={metric} />
      </p>
    </div>
  );
}
