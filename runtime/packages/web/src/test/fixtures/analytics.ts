// FIXTURE: invented data for tests
import type {
  SeriesPoint,
  ToolFrequencyReport,
  ToolFrequencyRow,
  UsageReport,
  UsageRow,
  UsageSeries,
} from '@mcs/shared';

import { iso } from './ids.ts';
import { makeUsage } from './sessions.ts';

export function makeUsageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return { key: 'fixture-model', label: 'fixture-model', usage: makeUsage(), cost: null, sessions: 1, ...overrides };
}

export function makeUsageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    asOfSeq: 10,
    window: { from: iso(-86_400), to: iso(0) },
    groupBy: 'model',
    totals: makeUsageRow({ key: 'total', label: 'Total' }),
    rows: [makeUsageRow()],
    rowsTruncated: false,
    source: 'FIXTURE usage source',
    cost: null,
    reportedCost: null,
    ...overrides,
  };
}

export function makeSeriesPoint(overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    start: iso(-3600),
    input: 10,
    output: 5,
    cacheCreation: 1,
    cacheRead: 20,
    messages: 2,
    completeness: 'complete',
    ...overrides,
  };
}

export function makeUsageSeries(overrides: Partial<UsageSeries> = {}): UsageSeries {
  return {
    asOfSeq: 10,
    bucket: 'day',
    tzOffsetMinutes: 0,
    window: { from: iso(-86_400), to: iso(0) },
    points: [makeSeriesPoint()],
    series: null,
    ...overrides,
  };
}

export function makeToolFrequencyRow(overrides: Partial<ToolFrequencyRow> = {}): ToolFrequencyRow {
  return {
    toolName: 'FixtureTool',
    mcpServer: null,
    calls: 4,
    succeeded: 3,
    failed: 1,
    denied: 0,
    interrupted: 0,
    pending: 0,
    unknown: 0,
    failurePct: 25,
    medianDurationMs: 120,
    maxDurationMs: 800,
    ...overrides,
  };
}

export function makeToolFrequencyReport(overrides: Partial<ToolFrequencyReport> = {}): ToolFrequencyReport {
  return {
    asOfSeq: 10,
    window: { from: iso(-86_400), to: iso(0) },
    items: [makeToolFrequencyRow()],
    sampled: false,
    ...overrides,
  };
}
