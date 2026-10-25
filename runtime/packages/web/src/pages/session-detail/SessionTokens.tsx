import type { AgentNode, SessionDetail, TokenUsage } from '@mcs/shared';
import { useMemo, useState } from 'react';

import { DataTable, type Column } from '../../components/DataTable.tsx';
import { TokenFigures, type TokenFigureId } from '../../components/TokenFigures.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';

export interface SessionTokensProps {
  session: SessionDetail;
  agents: AgentNode[];
}

/** The five figures of the tiles and of the table, in this order. */
const TILE_FIGURES: readonly TokenFigureId[] = ['output', 'inputNew', 'input', 'cacheWrite', 'cacheRead'];

/** The columns of the table: the usage field a column compares and the figure it draws. */
const FIGURE_COLUMNS = [
  { id: 'output', figure: 'output', field: 'output', label: 'tokens.output', tip: 'tabs.tokens.col.output.tip' },
  { id: 'input', figure: 'input', field: 'input', label: 'tokens.input', tip: 'tabs.tokens.col.input.tip' },
  {
    id: 'cacheWrite',
    figure: 'cacheWrite',
    field: 'cacheCreation',
    label: 'tokens.cacheWrite',
    tip: 'tabs.tokens.col.cacheWrite.tip',
  },
  {
    id: 'cacheRead',
    figure: 'cacheRead',
    field: 'cacheRead',
    label: 'tokens.cacheRead',
    tip: 'tabs.tokens.col.cacheRead.tip',
  },
] as const satisfies readonly {
  id: string;
  figure: TokenFigureId;
  field: 'output' | 'input' | 'cacheCreation' | 'cacheRead';
  label: MessageKey;
  tip: MessageKey;
}[];

type FigureColumnId = (typeof FIGURE_COLUMNS)[number]['id'];
type SortKey = 'agent' | 'model' | FigureColumnId;

interface SortState {
  key: SortKey | null;
  dir: 'asc' | 'desc';
}

/** A row of the table: an agent, or the total of the session, which stays last whatever the sort. */
type Row = { kind: 'agent'; agent: AgentNode } | { kind: 'total' };

const TEXT_KEYS: readonly SortKey[] = ['agent', 'model'];

function isSortKey(key: string): key is SortKey {
  return key === 'agent' || key === 'model' || FIGURE_COLUMNS.some((column) => column.id === key);
}

function fieldOf(usage: TokenUsage, key: FigureColumnId): number | null {
  const column = FIGURE_COLUMNS.find((candidate) => candidate.id === key);
  return column === undefined || usage.completeness === 'unavailable' ? null : usage[column.field];
}

/** Sorts the agents; a figure that is not known goes last in either direction. */
function sortAgents(agents: readonly AgentNode[], sort: SortState, sessionModel: string | null): AgentNode[] {
  const { key } = sort;
  if (key === null) return [...agents];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...agents].sort((a, b) => {
    if (key === 'agent' || key === 'model') {
      const left = key === 'agent' ? a.label : (a.model ?? sessionModel ?? '');
      const right = key === 'agent' ? b.label : (b.model ?? sessionModel ?? '');
      return sign * left.localeCompare(right);
    }
    const left = fieldOf(a.usage, key);
    const right = fieldOf(b.usage, key);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return sign * (left - right);
  });
}

function rowKey(row: Row): string {
  return row.kind === 'total' ? 'total' : `agent:${row.agent.id}`;
}

function rowClass(row: Row): string | undefined {
  return row.kind === 'total' ? 'token-total-row' : undefined;
}

/**
 * Token numbers of the session (review R-15): five tiles with the totals of the session including its subagents (Output, Input (new),
 * Input, Cache write, Cache read), then a table per agent that falls back to the model of the session, sortable by every column,
 * ending in a Total row that equals the figures of the Sessions list. A number the monitor does not have is "n/a", never 0, and a
 * scan that is not complete is labelled "lower bound". The note on where the numbers come from is at the bottom.
 */
export function SessionTokens({ session, agents }: SessionTokensProps) {
  const t = useT();
  const format = useFormat();
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'desc' });
  const sessionModel = session.lastModel ?? session.models[0] ?? null;
  const rows = useMemo<Row[]>(
    () => [
      ...sortAgents(agents, sort, sessionModel).map((agent): Row => ({ kind: 'agent', agent })),
      { kind: 'total' },
    ],
    [agents, sort, sessionModel],
  );
  const columns = useMemo<Column<Row>[]>(() => {
    const figureColumns = FIGURE_COLUMNS.map((column): Column<Row> => ({
      id: column.id,
      header: t(column.label),
      headerTitle: t(column.tip),
      sortKey: column.id,
      numeric: true,
      cell: (row) => (
        <TokenFigures
          usage={row.kind === 'total' ? session.usageInclSubagents : row.agent.usage}
          variant="cell"
          figure={column.figure}
        />
      ),
    }));
    return [
      {
        id: 'agent',
        header: t('tabs.agents.col.agent'),
        sortKey: 'agent',
        cell: (row) => (row.kind === 'total' ? t('tabs.tokens.total') : row.agent.label),
      },
      {
        id: 'model',
        header: t('tabs.agents.col.model'),
        sortKey: 'model',
        priority: 2,
        nowrap: true,
        cell: (row) => {
          if (row.kind === 'total') return null;
          if (row.agent.model !== null) return row.agent.model;
          return sessionModel === null ? null : <span title={t('tabs.tokens.sessionModel')}>{sessionModel}</span>;
        },
      },
      ...figureColumns,
    ];
  }, [t, session.usageInclSubagents, sessionModel]);

  const onSort = (key: string): void => {
    if (!isSortKey(key)) return;
    setSort((previous) => {
      if (previous.key === key) return { key, dir: previous.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: TEXT_KEYS.includes(key) ? 'asc' : 'desc' };
    });
  };

  const { cost } = session;
  return (
    <section className="session-tokens" aria-label={t('tabs.tokens.region')}>
      <div className="session-tokens__totals">
        <h2 className="session-tokens__heading">{t('tabs.tokens.totals')}</h2>
        <TokenFigures usage={session.usageInclSubagents} variant="tiles" figures={TILE_FIGURES} breakdown={false} />
        {cost === null ? null : (
          <p className="session-tokens__cost" title={t('analytics.cost.estimateTip')}>
            <span className="muted">{t('analytics.cost.label')}</span>{' '}
            <span className="session-tokens__amount">{`${format.number(cost.amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cost.currency}`}</span>
            {cost.pricedTokensPct < 100 ? (
              <span className="muted">{` ${t('analytics.cost.priced', { pct: format.percent(cost.pricedTokensPct / 100) })}`}</span>
            ) : null}
          </p>
        )}
      </div>
      {agents.length === 0 ? null : (
        <DataTable<Row>
          caption={t('tabs.tokens.caption')}
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          rowClass={rowClass}
          sort={{ key: sort.key ?? '', dir: sort.dir, onSort }}
        />
      )}
      <p className="muted session-tokens__note">{t('tabs.tokens.note')}</p>
    </section>
  );
}
