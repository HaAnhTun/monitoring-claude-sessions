// FIXTURE: invented data for tests
import type { Metric, Overview } from '@mcs/shared';

import { iso } from './ids.ts';

export function makeMetric(overrides: Partial<Metric> = {}): Metric {
  return {
    key: 'sessions.active',
    label: 'Active sessions',
    value: 2,
    unit: 'count',
    source: 'FIXTURE metric source',
    rule: 'FIXTURE metric rule',
    completeness: 'complete',
    asOf: iso(0),
    link: null,
    ...overrides,
  };
}

export function makeOverview(overrides: Partial<Overview> = {}): Overview {
  return {
    asOfSeq: 10,
    generatedAt: iso(0),
    window: { from: iso(-86_400), to: iso(0), source: 'window_hours' },
    metrics: [makeMetric(), makeMetric({ key: 'sessions.failed', label: 'Failed sessions', value: 1 })],
    recentActivity: [],
    recentErrors: [],
    alerts: { open: 0, critical: 0, items: [] },
    ...overrides,
  };
}
