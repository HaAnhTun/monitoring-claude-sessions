import type { SessionSummary } from '@mcs/shared';
import { useMemo } from 'react';

import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { EvidenceLine } from '../../components/EvidenceLine.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import type { Formatters } from '../../i18n/format.ts';
import type { TFunction } from '../../i18n/types.ts';
import { SESSION_SORTS, type SessionSort } from '../../lib/url-state.ts';
import type { ColumnOption } from './ColumnChooser.tsx';
import { modelLineOf, modelsDiffer, SessionRow } from './SessionRow.tsx';

/** The id of the table in the `tableColumns` preference. */
export const SESSIONS_TABLE_ID = 'sessions';

/** Every column the table can draw, in its order. */
export const SESSION_COLUMN_IDS = [
  'state',
  'label',
  'project',
  'models',
  'started',
  'lastActivity',
  'duration',
  'errors',
  'output',
  'input',
  'freshness',
  'tokenDetail',
] as const;
export type SessionColumnId = (typeof SESSION_COLUMN_IDS)[number];

/** ADR 0073 decision 7: State, Session, Last activity, Errors, Output, Input. */
export const DEFAULT_SESSION_COLUMNS: readonly SessionColumnId[] = [
  'state',
  'label',
  'lastActivity',
  'errors',
  'output',
  'input',
];
/** The Session column carries the link of the row, so it cannot be turned off. */
export const REQUIRED_SESSION_COLUMNS: readonly SessionColumnId[] = ['label'];

export interface SessionTableProps {
  rows: SessionSummary[];
  sort: { key: SessionSort; dir: 'asc' | 'desc' };
  onSort: (key: SessionSort) => void;
  selectedId?: string | undefined;
  /** The columns to draw (ids of `SESSION_COLUMN_IDS`); the default columns when omitted. */
  columns?: readonly string[] | undefined;
}

function isSessionSort(key: string): key is SessionSort {
  return SESSION_SORTS.some((candidate) => candidate === key);
}

function isColumnId(id: string): id is SessionColumnId {
  return SESSION_COLUMN_IDS.some((candidate) => candidate === id);
}

// ---- cells -----------------------------------------------------------------------------------------------------------------

/** The badge with its honest state (dashed ring and question mark when inferred) and, under it, the one evidence line. */
function StateCell({ session }: { session: SessionSummary }) {
  return (
    <span className="session-state">
      <StateBadge state={session.state.state} assessment={session.state} lastActivityAt={session.lastActivityAt} />
      <EvidenceLine assessment={session.state} lastActivityAt={session.lastActivityAt} />
    </span>
  );
}

/** Empty when there is no error (ADR 0074 decision 6); a red chip with the count otherwise; warnings stay muted. */
function ErrorsCell({ session }: { session: SessionSummary }) {
  const t = useT();
  if (session.errorCount === 0 && session.warningCount === 0) return null;
  return (
    <span className="session-errors">
      {session.errorCount > 0 ? (
        <span className="session-errors__chip">
          <Icon name="failed" />
          <span>{t('sessions.errors.count', { count: session.errorCount })}</span>
        </span>
      ) : null}
      {session.warningCount > 0 ? (
        <span className="session-errors__warnings">
          <Icon name="alert" />
          <span>{t('sessions.errors.warnings', { count: session.warningCount })}</span>
        </span>
      ) : null}
    </span>
  );
}

function ProjectCell({ session }: { session: SessionSummary }) {
  const t = useT();
  const task = session.workItemIds[0];
  return (
    <>
      <span>{session.projectLabel ?? ''}</span>
      {task === undefined ? null : <span className="muted">{` ${t('sessions.session.task', { id: task })}`}</span>}
    </>
  );
}

function FreshnessCell({ session }: { session: SessionSummary }) {
  const t = useT();
  return (
    <span className="session-tags">
      {session.sources.hooks ? <TagBadge tone="neutral">{t('sessions.tag.hooks')}</TagBadge> : null}
      {session.sources.transcript ? <TagBadge tone="neutral">{t('sessions.tag.transcript')}</TagBadge> : null}
      {session.partial ? (
        <TagBadge tone="partial" icon="alert" tip={t('sessions.tag.partial.tip')}>
          {t('sessions.tag.partial')}
        </TagBadge>
      ) : null}
      {session.state.state === 'stale' ? (
        <TagBadge tone="stale" icon="clock" tip={t('sessions.tag.stale.tip')}>
          {t('sessions.tag.stale')}
        </TagBadge>
      ) : null}
    </span>
  );
}

function TokenDetailCell({ session }: { session: SessionSummary }) {
  const t = useT();
  return (
    <span className="session-token-detail">
      <span>
        <span className="muted">{t('tokens.output')}</span>{' '}
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="output" />
      </span>
      <span>
        <span className="muted">{t('tokens.inputNew')}</span>{' '}
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="inputNew" />
      </span>
      <span>
        <span className="muted">{t('tokens.cacheRead')}</span>{' '}
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="cacheRead" />
      </span>
    </span>
  );
}

/** The plain text a cell stands for, so that a column of equal or empty cells can hide itself. */
function projectValue(session: SessionSummary): string {
  const project = session.projectLabel ?? '';
  const task = session.workItemIds[0];
  return project === '' && task === undefined ? '' : `${project}|${task === undefined ? '' : String(task)}`;
}

// ---- columns -----------------------------------------------------------------------------------------------------------------

function headerOf(t: TFunction, id: SessionColumnId): string {
  switch (id) {
    case 'state':
      return t('sessions.col.state');
    case 'label':
      return t('sessions.col.session');
    case 'project':
      return t('sessions.col.project');
    case 'models':
      return t('sessions.col.model');
    case 'started':
      return t('sessions.col.started');
    case 'lastActivity':
      return t('sessions.col.lastActivity');
    case 'duration':
      return t('sessions.col.activeSpan');
    case 'errors':
      return t('sessions.col.errors');
    case 'output':
      return t('sessions.col.output');
    case 'input':
      return t('sessions.col.input');
    case 'freshness':
      return t('sessions.col.freshness');
    case 'tokenDetail':
      return t('sessions.col.tokenDetail');
  }
}

/** The columns of the chooser: every column of the table, under the word of its header. */
export function useSessionColumnOptions(): ColumnOption[] {
  const t = useT();
  return useMemo(
    () =>
      SESSION_COLUMN_IDS.map((id) => ({
        id,
        label: headerOf(t, id),
        ...(REQUIRED_SESSION_COLUMNS.includes(id) ? { required: true } : {}),
      })),
    [t],
  );
}

interface ColumnContext {
  t: TFunction;
  format: Formatters;
  /** The Session column adds the model line (the Model column is not drawn and the sessions differ). */
  modelLine: boolean;
}

function columnOf(id: SessionColumnId, { t, format, modelLine }: ColumnContext): Column<SessionSummary> {
  const header = headerOf(t, id);
  switch (id) {
    case 'state':
      return { id, header, sortKey: 'state', nowrap: true, cell: (s) => <StateCell session={s} /> };
    case 'label':
      return {
        id,
        header,
        sortKey: 'label',
        link: true,
        cell: (s) => <SessionRow session={s} showModel={modelLine} />,
      };
    case 'project':
      return {
        id,
        header,
        priority: 2,
        hideWhenEmpty: true,
        value: projectValue,
        cell: (s) => <ProjectCell session={s} />,
      };
    case 'models':
      return {
        id,
        header,
        priority: 3,
        nowrap: true,
        hideWhenEmpty: 'same',
        value: modelLineOf,
        cell: (s) => modelLineOf(s),
      };
    case 'started':
      return {
        id,
        header,
        sortKey: 'started',
        priority: 3,
        nowrap: true,
        cell: (s) => <RelativeTime iso={s.startedAt} />,
      };
    case 'lastActivity':
      return {
        id,
        header,
        sortKey: 'lastActivity',
        nowrap: true,
        cell: (s) => <RelativeTime iso={s.lastActivityAt} />,
      };
    case 'duration':
      return {
        id,
        header,
        headerTitle: t('sessions.col.activeSpan.tip'),
        sortKey: 'duration',
        priority: 3,
        numeric: true,
        cell: (s) => format.duration(s.durationMs / 1000),
      };
    case 'errors':
      return {
        id,
        header,
        headerTitle: t('sessions.col.errors.tip'),
        sortKey: 'errors',
        nowrap: true,
        cell: (s) => <ErrorsCell session={s} />,
      };
    case 'output':
      return {
        id,
        header,
        headerTitle: t('sessions.col.output.tip'),
        sortKey: 'tokens',
        numeric: true,
        cell: (s) => <TokenFigures usage={s.usageInclSubagents} variant="cell" figure="output" />,
      };
    case 'input':
      return {
        id,
        header,
        headerTitle: t('sessions.col.input.tip'),
        numeric: true,
        cell: (s) => <TokenFigures usage={s.usageInclSubagents} variant="cell" figure="inputNew" />,
      };
    case 'freshness':
      return {
        id,
        header,
        headerTitle: t('sessions.col.freshness.tip'),
        priority: 2,
        hideWhenEmpty: 'same',
        value: (s) =>
          `${String(s.sources.hooks)}|${String(s.sources.transcript)}|${String(s.partial)}|${s.state.state}`,
        cell: (s) => <FreshnessCell session={s} />,
      };
    case 'tokenDetail':
      return {
        id,
        header,
        headerTitle: t('sessions.col.tokenDetail.tip'),
        priority: 2,
        numeric: true,
        cell: (s) => <TokenDetailCell session={s} />,
      };
  }
}

function rowKey(session: SessionSummary): string {
  return session.id;
}

function rowHref(session: SessionSummary): string {
  return `/sessions/${encodeURIComponent(session.id)}`;
}

/** The mark of a row with errors: a bar on its left side in the error tone (review R-11). */
function rowClass(session: SessionSummary): string | undefined {
  return session.errorCount > 0 ? 'session-row--error' : undefined;
}

/** One session as a card (below 900 px): state, label and time on the first line, errors and tokens on the second. */
function CardOf({ session }: { session: SessionSummary }) {
  const t = useT();
  return (
    <span className="session-card__meta">
      <ErrorsCell session={session} />
      <span className="session-card__figure">
        <span className="muted">{t('sessions.col.output')}</span>{' '}
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="output" />
      </span>
      <span className="session-card__figure">
        <span className="muted">{t('sessions.col.input')}</span>{' '}
        <TokenFigures usage={session.usageInclSubagents} variant="cell" figure="inputNew" />
      </span>
      <EvidenceLine assessment={session.state} lastActivityAt={session.lastActivityAt} />
    </span>
  );
}

function cardOf(session: SessionSummary): DataCard {
  return {
    lead: (
      <StateBadge
        state={session.state.state}
        assessment={session.state}
        lastActivityAt={session.lastActivityAt}
        size="sm"
      />
    ),
    title: (
      <span className="session-card__title" title={session.label}>
        {session.label}
      </span>
    ),
    end: <RelativeTime iso={session.lastActivityAt} />,
    meta: <CardOf session={session} />,
  };
}

/**
 * The session list as a table: the default columns of ADR 0073 decision 7 or the ones the user chose, sortable headers (Errors
 * included), one link per row, an error bar on the rows with errors, and a card list below 900 px. A column that carries nothing
 * hides itself. No virtualisation (ADR 0038).
 */
export function SessionTable({ rows, sort, onSort, selectedId, columns }: SessionTableProps) {
  const t = useT();
  const format = useFormat();
  const chosen = useMemo(() => (columns ?? DEFAULT_SESSION_COLUMNS).filter(isColumnId), [columns]);
  const modelDrawn = chosen.includes('models');
  const differ = useMemo(() => modelsDiffer(rows), [rows]);
  const modelLine = !modelDrawn && differ;
  const tableColumns = useMemo(
    () => SESSION_COLUMN_IDS.filter((id) => chosen.includes(id)).map((id) => columnOf(id, { t, format, modelLine })),
    [chosen, t, format, modelLine],
  );
  const extra = useMemo(() => [{ key: 'attention', label: t('sessions.sort.attention') }], [t]);
  return (
    <DataTable<SessionSummary>
      caption={t('sessions.table.caption')}
      columns={tableColumns}
      rows={rows}
      rowKey={rowKey}
      rowHref={rowHref}
      rowClass={rowClass}
      card={cardOf}
      sort={{
        key: sort.key,
        dir: sort.dir,
        extra,
        onSort: (key) => {
          if (isSessionSort(key)) onSort(key);
        },
      }}
      selectedKey={selectedId ?? null}
    />
  );
}
