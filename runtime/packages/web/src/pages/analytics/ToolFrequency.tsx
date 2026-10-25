import type { ToolFrequencyReport, ToolFrequencyRow } from '@mcs/shared';
import { useMemo } from 'react';

import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { NumberCell, useMillis } from './figures.tsx';

/** The number of calls whose durations the server reads for the median (`MEDIAN_ROW_LIMIT` of the analytics engine). */
const SAMPLE_CALLS = 100_000;

export interface ToolFrequencyProps {
  report: ToolFrequencyReport;
}

/**
 * How often each tool was called and how it ended (04 4.4.6). The calls cell carries a single-hue bar (share of the busiest tool).
 * A failure rate or a duration the monitor does not have is "n/a"; when the durations were sampled the page says so.
 */
export function ToolFrequency({ report }: ToolFrequencyProps) {
  const t = useT();
  const format = useFormat();
  const millis = useMillis();
  const maxCalls = useMemo(() => Math.max(0, ...report.items.map((row) => row.calls)), [report.items]);

  const count = (id: 'failed' | 'denied' | 'interrupted' | 'pending', header: string, priority: 1 | 2 | 3) => {
    const column: Column<ToolFrequencyRow> = {
      id,
      header,
      numeric: true,
      priority,
      cell: (row) => {
        const value = row[id];
        return id === 'failed' && value > 0 ? (
          <span className="usage-failed">{format.number(value)}</span>
        ) : (
          format.number(value)
        );
      },
    };
    return column;
  };

  const duration = (id: 'medianDurationMs' | 'maxDurationMs', header: string, priority: 1 | 2 | 3) => {
    const column: Column<ToolFrequencyRow> = {
      id,
      header,
      numeric: true,
      priority,
      cell: (row) => {
        const value = row[id];
        return value === null ? <NumberCell value={null} /> : millis(value);
      },
      value: (row) => row[id],
    };
    return column;
  };

  const columns: Column<ToolFrequencyRow>[] = [
    {
      id: 'tool',
      header: t('analytics.tools.col.tool'),
      stickyStart: true,
      cell: (row) => (
        <span className="usage-tool">
          <span className="mono">{row.toolName}</span>
          {row.mcpServer === null ? null : (
            <span className="muted">{t('analytics.tools.mcp', { server: row.mcpServer })}</span>
          )}
        </span>
      ),
    },
    {
      id: 'calls',
      header: t('analytics.tools.col.calls'),
      numeric: true,
      cell: (row) => (
        <span className="usage-total">
          {format.number(row.calls)}
          <span className="mag" aria-hidden="true">
            <span
              className="mag__fill"
              style={{ inlineSize: `${String(maxCalls === 0 ? 0 : (row.calls / maxCalls) * 100)}%` }}
            />
          </span>
        </span>
      ),
    },
    count('failed', t('analytics.tools.col.failed'), 1),
    count('denied', t('analytics.tools.col.denied'), 2),
    count('interrupted', t('analytics.tools.col.interrupted'), 3),
    count('pending', t('analytics.tools.col.pending'), 3),
    {
      id: 'failurePct',
      header: t('analytics.tools.col.failurePct'),
      numeric: true,
      cell: (row) =>
        row.failurePct === null ? (
          <NumberCell value={null} />
        ) : (
          format.percent(row.failurePct / 100, row.failurePct % 1 === 0 ? 0 : 1)
        ),
      value: (row) => row.failurePct,
    },
    duration('medianDurationMs', t('analytics.tools.col.median'), 2),
    duration('maxDurationMs', t('analytics.tools.col.slowest'), 2),
  ];

  const card = (row: ToolFrequencyRow): DataCard => ({
    title: <span className="mono">{row.toolName}</span>,
    end: format.number(row.calls),
    meta: (
      <span className="usage-card-meta">
        <span>{`${t('analytics.tools.col.failed')} ${format.number(row.failed)}`}</span>
        {row.mcpServer === null ? null : <span>{t('analytics.tools.mcp', { server: row.mcpServer })}</span>}
      </span>
    ),
  });

  return (
    <>
      <DataTable
        caption={t('analytics.tools.caption')}
        columns={columns}
        rows={report.items}
        rowKey={(row) => `${row.mcpServer ?? ''}|${row.toolName}`}
        card={card}
      />
      {report.sampled ? <p className="muted">{t('analytics.tools.sampled', { count: SAMPLE_CALLS })}</p> : null}
    </>
  );
}
