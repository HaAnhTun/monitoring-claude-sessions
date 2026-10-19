// The token and cost rows of the overview (03 8.1, 8.2, 8.3): `tokens.input`, `tokens.input_new`, `tokens.output`,
// `tokens.cache_creation`, `tokens.cache_read`, `cost.estimate` and `cost.reported`. The overview adds them through
// `registerMetricProvider` between `events.errors` and `alerts.open`.
//
// Missing is never zero: a row's value is `null` when every counted message misses its field, and also when the window holds
// no message at all. `cost.estimate` is `null` without configured prices (the row stays, so the page can say why there is no
// figure). `source` and `rule` are the fixed English texts of the table of 03 8.1; the UI shows them in an info tip.
//
// The token rows equal `usage()` of the same window: both read the totals of `aggregateInstance` and project them with the
// same files.
import type { Completeness, Metric, TokenUsage } from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { MetricProviderInput } from '../query/overview.ts';
import { aggregateInstance } from '../tokens/aggregate.ts';
import { costRows, reportedCost, summarizeCost } from './cost.ts';
import { contributingFiles, tokenUsageFor, usageFilterOf } from './usage.ts';

interface Spec {
  readonly key: string;
  readonly label: string;
  readonly source: string;
  readonly rule: string;
}

const LINK = '/analytics';

const SPEC = {
  input: {
    key: 'tokens.input',
    label: 'Input tokens (uncached)',
    source: 'usage.input_tokens',
    rule: 'sum over message keys with ts in window',
  },
  inputNew: {
    key: 'tokens.input_new',
    label: 'New input tokens',
    source: 'usage.input_tokens + cache_creation_tokens',
    rule: 'sum; tokens sent to the model that were not read from cache',
  },
  output: {
    key: 'tokens.output',
    label: 'Output tokens',
    source: 'usage.output_tokens',
    rule: 'sum; lower bound when some messages never got a final record',
  },
  cacheCreation: {
    key: 'tokens.cache_creation',
    label: 'Cache writes',
    source: 'usage.cache_creation_tokens',
    rule: 'sum',
  },
  cacheRead: {
    key: 'tokens.cache_read',
    label: 'Cache reads',
    source: 'usage.cache_read_tokens',
    rule: 'sum (shown separately, never merged into input)',
  },
  estimate: {
    key: 'cost.estimate',
    label: 'Estimated cost',
    source: 'configured prices x usage',
    rule: 'estimate from the prices configured in runtime.json, not a bill; present only when prices are configured',
  },
  reported: {
    key: 'cost.reported',
    label: 'Cost reported by Claude Code',
    source: 'latest cost_states value per session',
    rule: 'sum over sessions in window that have one; cumulative per process, may include calls not in transcripts',
  },
} as const satisfies Record<string, Spec>;

/** The sessions of the overview window as a condition over `sessions s` with its named parameters (the state tiles' filter). */
export interface SessionsInWindow {
  readonly where: string;
  readonly params: Readonly<Record<string, SqlValue>>;
}

function tokenMetric(spec: Spec, value: number | null, completeness: Completeness, asOf: string): Metric {
  return {
    key: spec.key,
    label: spec.label,
    value,
    unit: 'tokens',
    source: spec.source,
    rule: spec.rule,
    completeness,
    asOf,
    link: LINK,
  };
}

/** The sum of the non-null parts; `null` when every part is. */
function sumOrNull(...parts: readonly (number | null)[]): number | null {
  const present = parts.filter((part): part is number => part !== null);
  return present.length === 0 ? null : present.reduce((sum, part) => sum + part, 0);
}

/** The metric rows of the window: tokens from the transcripts, the estimate from configured prices, the provider's own figure. */
export function usageMetrics(input: MetricProviderInput, sessions: SessionsInWindow): Metric[] {
  const { db, ctx, deps, window, asOf } = input;
  const filter = usageFilterOf(window, {});
  const usage: TokenUsage = tokenUsageFor(aggregateInstance(db, ctx, filter), contributingFiles(db, filter));
  // the output of a message that never got its final record is a lower bound (03 8.1)
  const outputCompleteness: Completeness =
    usage.completeness === 'complete' && usage.unfinalized > 0 ? 'partial' : usage.completeness;

  const metrics: Metric[] = [
    tokenMetric(SPEC.input, usage.input, usage.completeness, asOf),
    tokenMetric(SPEC.inputNew, sumOrNull(usage.input, usage.cacheCreation), usage.completeness, asOf),
    tokenMetric(SPEC.output, usage.output, outputCompleteness, asOf),
    tokenMetric(SPEC.cacheCreation, usage.cacheCreation, usage.completeness, asOf),
    tokenMetric(SPEC.cacheRead, usage.cacheRead, usage.completeness, asOf),
  ];

  // the estimate: only with configured prices; `partial` when a model has no price
  const { currency, models } = deps.config.runtime.pricing;
  const summary = models.length === 0 ? null : summarizeCost(models, currency, costRows(db, ctx, filter, 'none'));
  metrics.push({
    key: SPEC.estimate.key,
    label: SPEC.estimate.label,
    value: summary === null ? null : summary.amount,
    unit: 'currency',
    currency,
    source: SPEC.estimate.source,
    rule: SPEC.estimate.rule,
    completeness:
      summary === null
        ? 'unavailable'
        : summary.unpricedModels.length > 0 || usage.completeness !== 'complete'
          ? 'partial'
          : 'complete',
    asOf,
    link: LINK,
  });

  const reported = reportedCost(db, sessions.where, sessions.params);
  metrics.push({
    key: SPEC.reported.key,
    label: SPEC.reported.label,
    value: reported.amountUsd,
    unit: 'currency',
    currency: 'USD',
    source: SPEC.reported.source,
    rule: SPEC.reported.rule,
    completeness:
      reported.amountUsd === null
        ? 'unavailable'
        : reported.sessionsWithReport < reported.sessionsInScope
          ? 'partial'
          : 'complete',
    asOf,
    link: LINK,
  });
  return metrics;
}
