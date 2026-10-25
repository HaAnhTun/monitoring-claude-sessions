import type { UsageRow } from '@mcs/shared';
import { useMemo, useState, type ReactNode } from 'react';

import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import type { AnalyticsUrlState, TimeRange } from '../../lib/url-state.ts';
import { NumberCell, useMoney } from './figures.tsx';

type Group = AnalyticsUrlState['by'];

export const GROUP_LABEL = {
  model: 'analytics.group.model',
  session: 'analytics.group.session',
  project: 'analytics.group.project',
  task: 'analytics.group.task',
} as const satisfies Readonly<Record<Group, MessageKey>>;

const SORT_KEYS = ['label', 'output', 'input', 'cacheCreation', 'cacheRead', 'total', 'sessions', 'cost'] as const;
type SortKey = (typeof SORT_KEYS)[number];

function toSortKey(key: string): SortKey | undefined {
  return SORT_KEYS.find((candidate) => candidate === key);
}

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

function valueOf(row: UsageRow, key: Exclude<SortKey, 'label'>): number | null {
  if (key === 'sessions') return row.sessions;
  if (key === 'cost') return row.cost?.amount ?? null;
  return row.usage[key];
}

/** Sorts the rows that are loaded; a missing figure is last in both directions, and equal figures keep the order of the labels. */
export function sortRows(rows: readonly UsageRow[], sort: SortState): UsageRow[] {
  const byLabel = (a: UsageRow, b: UsageRow): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'label') return sign * byLabel(a, b);
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);
    if (left === null && right === null) return byLabel(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return left === right ? byLabel(a, b) : sign * (left - right);
  });
}

function rangeParams(range: TimeRange, into: URLSearchParams): void {
  if (range.kind === 'preset') {
    into.set('range', range.preset);
    return;
  }
  into.set('from', range.from);
  if (range.to !== null) into.set('to', range.to);
}

/** The sessions behind a row: the session itself, or the sessions list filtered like the row and in the same time range. */
export function rowLink(group: Group, key: string, range: TimeRange): string {
  if (key === '') return '/sessions';
  if (group === 'session') return `/sessions/${encodeURIComponent(key)}`;
  const params = new URLSearchParams();
  params.set({ model: 'model', project: 'project', task: 'task' }[group], key);
  rangeParams(range, params);
  return `/sessions?${params.toString()}`;
}

export interface UsageTableProps {
  rows: readonly UsageRow[];
  groupBy: Group;
  /** The time range of the page; the links of the rows carry it. */
  range: TimeRange;
}

/**
 * Token usage per group (04 4.4.6). Sorting works on the rows that are loaded (the server already cut the list at its limit). The
 * total column carries a single-hue bar, the length of which is the share of the largest total. A figure the monitor does not have
 * is "n/a", and the cost column is there only when at least one row was priced.
 */
export function UsageTable({ rows, groupBy, range }: UsageTableProps) {
  const t = useT();
  const format = useFormat();
  const money = useMoney();
  const [sort, setSort] = useState<SortState>({ key: 'total', dir: 'desc' });
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const maxTotal = useMemo(() => Math.max(0, ...rows.map((row) => row.usage.total ?? 0)), [rows]);
  const groupName = t(GROUP_LABEL[groupBy]);

  const numeric = (
    id: Exclude<SortKey, 'label' | 'cost' | 'sessions' | 'total'>,
    header: string,
    priority: 1 | 2 | 3,
  ): Column<UsageRow> => ({
    id,
    header,
    numeric: true,
    sortKey: id,
    priority,
    cell: (row) => <NumberCell value={row.usage[id]} />,
    value: (row) => row.usage[id],
  });

  const columns: Column<UsageRow>[] = [
    {
      id: 'label',
      header: groupName,
      sortKey: 'label',
      link: true,
      stickyStart: true,
      cell: (row) => <span className="usage-label">{row.label === '' ? row.key : row.label}</span>,
    },
    numeric('output', t('tokens.output'), 1),
    numeric('input', t('tokens.input'), 2),
    numeric('cacheCreation', t('tokens.cacheWrite'), 3),
    numeric('cacheRead', t('tokens.cacheRead'), 2),
    {
      id: 'total',
      header: t('analytics.col.total'),
      numeric: true,
      sortKey: 'total',
      cell: (row) => {
        const total = row.usage.total;
        const share = total === null || maxTotal === 0 ? 0 : (total / maxTotal) * 100;
        return (
          <span className="usage-total">
            <NumberCell value={total} />
            <span className="mag" aria-hidden="true">
              <span className="mag__fill" style={{ inlineSize: `${String(share)}%` }} />
            </span>
          </span>
        );
      },
      value: (row) => row.usage.total,
    },
    {
      id: 'sessions',
      header: t('analytics.col.sessions'),
      numeric: true,
      sortKey: 'sessions',
      priority: 2,
      cell: (row) => format.number(row.sessions),
    },
    {
      id: 'cost',
      header: t('analytics.col.cost'),
      headerTitle: t('analytics.col.costTip'),
      numeric: true,
      sortKey: 'cost',
      hideWhenEmpty: true,
      value: (row) => row.cost?.amount ?? null,
      cell: (row) =>
        row.cost === null ? (
          <span className="muted" title={t('analytics.cost.rowUnpriced')}>
            <span aria-hidden="true">{t('tokens.na')}</span>
            <span className="sr-only">{t('tokens.notAvailable')}</span>
          </span>
        ) : (
          money(row.cost.amount, row.cost.currency)
        ),
    },
  ];

  const card = (row: UsageRow): DataCard => {
    const part = (label: 'tokens.output' | 'tokens.input' | 'tokens.cacheRead', value: number | null): ReactNode => (
      <span key={label}>
        {t(label)} <NumberCell value={value} compact />
      </span>
    );
    return {
      title: <span className="usage-label">{row.label === '' ? row.key : row.label}</span>,
      end: <NumberCell value={row.usage.total} compact />,
      meta: (
        <span className="usage-card-meta">
          {part('tokens.output', row.usage.output)}
          {part('tokens.input', row.usage.input)}
          {part('tokens.cacheRead', row.usage.cacheRead)}
        </span>
      ),
    };
  };

  return (
    <DataTable
      caption={t('analytics.table.caption', { group: groupName })}
      columns={columns}
      rows={sorted}
      rowKey={(row) => row.key}
      rowHref={(row) => rowLink(groupBy, row.key, range)}
      sort={{
        key: sort.key,
        dir: sort.dir,
        onSort: (key) => {
          const next = toSortKey(key);
          if (next === undefined) return;
          setSort((current) =>
            current.key === next
              ? { key: next, dir: current.dir === 'desc' ? 'asc' : 'desc' }
              : { key: next, dir: next === 'label' ? 'asc' : 'desc' },
          );
        },
      }}
      card={card}
    />
  );
}
