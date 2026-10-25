import type { Metric } from '@mcs/shared';
import { useId } from 'react';

import { useT } from '../../i18n/context.ts';
import { MetricTile } from './MetricTile.tsx';

export interface MetricGridProps {
  /** The metrics of `GET /overview` in the order the server sent them. A metric that is not in the list has no tile. */
  metrics: readonly Metric[];
}

function isUsageMetric(metric: Metric): boolean {
  return metric.key.startsWith('tokens.') || metric.key.startsWith('cost.');
}

interface GroupProps {
  titleKey: 'overview.figures.sessions' | 'overview.figures.usage';
  metrics: readonly Metric[];
}

function Group({ titleKey, metrics }: GroupProps) {
  const t = useT();
  const headingId = useId();
  if (metrics.length === 0) return null;
  return (
    <section className="overview-figures" aria-labelledby={headingId}>
      <h2 id={headingId} className="overview-figures__title">
        {t(titleKey)}
      </h2>
      <ul className="overview-grid">
        {metrics.map((metric) => (
          <li key={metric.key} className="overview-grid__item">
            <MetricTile metric={metric} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The figures of the overview in two groups: sessions and errors, then tokens and cost (the estimate and the cost the provider
 * reported are two separate tiles). Only the metrics the server returned are drawn, so a figure the monitor does not have is
 * absent, never a zero.
 */
export function MetricGrid({ metrics }: MetricGridProps) {
  return (
    <>
      <Group titleKey="overview.figures.sessions" metrics={metrics.filter((metric) => !isUsageMetric(metric))} />
      <Group titleKey="overview.figures.usage" metrics={metrics.filter(isUsageMetric)} />
    </>
  );
}
