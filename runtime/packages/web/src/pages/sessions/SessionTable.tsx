import type { SessionSummary } from '@mcs/shared';

import { DataTable, type Column } from '../../components/DataTable.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenLine } from '../../components/TokenLine.tsx';
import { fmtDuration, plural } from '../../lib/format.ts';
import { SESSION_SORTS, type SessionSort } from '../../lib/url-state.ts';
import { SessionRow } from './SessionRow.tsx';

export interface SessionTableProps {
  rows: SessionSummary[];
  sort: { key: SessionSort; dir: 'asc' | 'desc' };
  onSort: (key: SessionSort) => void;
  selectedId?: string | undefined;
}

function isSessionSort(key: string): key is SessionSort {
  return SESSION_SORTS.some((candidate) => candidate === key);
}

function ProjectCell({ session }: { session: SessionSummary }) {
  const task = session.workItemIds[0];
  return (
    <>
      <span>{session.projectLabel ?? '-'}</span>
      {task === undefined ? null : <span className="muted">{` Task #${String(task)}`}</span>}
    </>
  );
}

function ErrorsCell({ session }: { session: SessionSummary }) {
  if (session.errorCount === 0 && session.warningCount === 0) return <span className="muted">none</span>;
  return (
    <span className="session-errors">
      {session.errorCount > 0 ? (
        <span className="session-errors__errors">
          <Icon name="failed" /> {plural(session.errorCount, 'error')}
        </span>
      ) : null}
      {session.warningCount > 0 ? (
        <span className="session-errors__warnings">
          <Icon name="alert" /> {plural(session.warningCount, 'warning')}
        </span>
      ) : null}
    </span>
  );
}

function FreshnessCell({ session }: { session: SessionSummary }) {
  return (
    <span className="session-tags">
      {session.sources.hooks ? <TagBadge tone="neutral">hooks</TagBadge> : null}
      {session.sources.transcript ? <TagBadge tone="neutral">transcript</TagBadge> : null}
      {session.partial ? (
        <TagBadge tone="partial" icon="alert" tip="Only part of this session's history was read">
          partial history
        </TagBadge>
      ) : null}
      {session.state.state === 'stale' ? (
        <TagBadge tone="stale" icon="clock" tip="No recent activity">
          stale
        </TagBadge>
      ) : null}
    </span>
  );
}

const COLUMNS: Column<SessionSummary>[] = [
  {
    id: 'state',
    header: 'State',
    sortKey: 'state',
    cell: (s) => <StateBadge state={s.state.state} {...tipOf(s)} />,
  },
  { id: 'label', header: 'Session', sortKey: 'label', link: true, cell: (s) => <SessionRow session={s} /> },
  { id: 'project', header: 'Project / task', cell: (s) => <ProjectCell session={s} /> },
  {
    id: 'models',
    header: 'Model',
    hideBelow: 'narrow',
    cell: (s) => (s.models.length === 0 ? '-' : s.models.join(', ')),
  },
  {
    id: 'started',
    header: 'Started',
    sortKey: 'started',
    hideBelow: 'narrow',
    cell: (s) => <RelativeTime iso={s.startedAt} />,
  },
  {
    id: 'lastActivity',
    header: 'Last activity',
    sortKey: 'lastActivity',
    cell: (s) => <RelativeTime iso={s.lastActivityAt} />,
  },
  {
    id: 'duration',
    header: 'Duration',
    sortKey: 'duration',
    hideBelow: 'narrow',
    align: 'end',
    cell: (s) => fmtDuration(s.durationMs / 1000),
  },
  { id: 'tokens', header: 'Tokens', sortKey: 'tokens', cell: (s) => <TokenLine usage={s.usageInclSubagents} /> },
  { id: 'errors', header: 'Errors', cell: (s) => <ErrorsCell session={s} /> },
  { id: 'freshness', header: 'Freshness', cell: (s) => <FreshnessCell session={s} /> },
];

/** The first evidence line of the state is its tooltip; without one the badge shows its own label. */
function tipOf(session: SessionSummary): { evidenceTip?: string } {
  const text = session.state.evidence[0]?.text;
  return text === undefined || text === '' ? {} : { evidenceTip: text };
}

function rowKey(session: SessionSummary): string {
  return session.id;
}

function rowHref(session: SessionSummary): string {
  return `/sessions/${encodeURIComponent(session.id)}`;
}

/** The session list as a table: sortable columns, one link per row, no virtualisation (ADR 0038). */
export function SessionTable({ rows, sort, onSort, selectedId }: SessionTableProps) {
  return (
    <DataTable<SessionSummary>
      caption="Sessions"
      columns={COLUMNS}
      rows={rows}
      rowKey={rowKey}
      rowHref={rowHref}
      sort={{
        key: sort.key,
        dir: sort.dir,
        onSort: (key) => {
          if (isSessionSort(key)) onSort(key);
        },
      }}
      selectedKey={selectedId ?? null}
    />
  );
}
