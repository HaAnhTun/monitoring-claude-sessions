// The "Recent sessions" group of an open folder (design 04 6.2): the monitor sessions of the folder that are not open as a terminal, at
// most five, each with a Resume button that asks the page to open the resume dialog, and, where the host can open a window of the
// person's own terminal (`capabilities.nativeOpen`), a quiet second button that opens the same dialog for that target (CAW-145; the
// group owns that dialog, because opening a window changes nothing the page has to follow). The request is made only while the
// group is mounted, which is while the folder body is open.
import type { SessionSummary } from '@mcs/shared';
import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { useFolderSessions } from '../../data/hooks/useFolders.ts';
import { useTerminalState } from '../../data/hooks/useTerminalState.ts';
import { useT } from '../../i18n/context.ts';
import { recentRowsOf, type LiveSession } from '../../lib/workspace-view.ts';
import { ResumeDialog } from './ActionDialogs.tsx';

export interface RecentRowsProps {
  folderKey: string;
  /** Every live terminal: a session that is open in one of them is not "recent". */
  live: readonly LiveSession[];
  onResume: (summary: SessionSummary) => void;
}

interface RecentRowProps {
  summary: SessionSummary;
  onResume: RecentRowsProps['onResume'];
  /** Present only where the host can open a window of the person's own terminal. */
  onOpenNative: RecentRowsProps['onResume'] | null;
}

function RecentRow({ summary, onResume, onOpenNative }: RecentRowProps) {
  const t = useT();
  return (
    <li className="workspace-recent__row">
      <span className="workspace-recent__label" title={summary.label}>
        {summary.label}
      </span>
      <StateBadge
        state={summary.state.state}
        assessment={summary.state}
        lastActivityAt={summary.lastActivityAt}
        size="sm"
      />
      <span className="workspace-recent__time">
        <RelativeTime iso={summary.lastActivityAt} />
      </span>
      <Button
        variant="quiet"
        data-nav-item=""
        data-nav-id={`resume:${summary.id}`}
        aria-label={[t('workspace.recent.resume'), summary.label].join(' ')}
        title={t('workspace.recent.resumeTip')}
        onClick={() => {
          onResume(summary);
        }}
      >
        {t('workspace.recent.resume')}
      </Button>
      {onOpenNative === null ? null : (
        <Button
          variant="icon"
          icon="external"
          data-nav-item=""
          data-nav-id={`native:${summary.id}`}
          aria-label={[t('workspace.recent.openNative'), summary.label].join(' ')}
          title={t('workspace.recent.openNativeTip')}
          onClick={() => {
            onOpenNative(summary);
          }}
        />
      )}
    </li>
  );
}

/** The collapsible group under the live rows of a folder. */
export function RecentRows({ folderKey, live, onResume }: RecentRowsProps) {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(true);
  const [nativeId, setNativeId] = useState<string | null>(null);
  // the page shares this query (one cached entry); a task instance and a locked page never ask
  const terminals = useTerminalState({ eventsOpen: true });
  const nativeOpen = terminals.data?.capabilities.nativeOpen === true;
  const openNative = useCallback((summary: SessionSummary) => {
    setNativeId(summary.id);
  }, []);
  const query = useFolderSessions(folderKey, true);
  const { rows, more } = recentRowsOf(query.data?.items ?? [], live);
  const failed = query.data === undefined && query.isError ? query.error : null;

  let body;
  if (failed !== null) {
    body = (
      <ErrorState
        kind="load"
        size="inline"
        subjectKey="error.subject.sessions"
        error={failed}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (query.data === undefined) {
    body = <p className="muted small">{t('workspace.recent.loading')}</p>;
  } else if (rows.length === 0) {
    body = <p className="muted small">{t('workspace.recent.empty')}</p>;
  } else {
    body = (
      <>
        <ul className="plain workspace-recent__list" aria-label={t('workspace.recent.title')}>
          {rows.map(({ summary }) => (
            <RecentRow
              key={summary.id}
              summary={summary}
              onResume={onResume}
              onOpenNative={nativeOpen ? openNative : null}
            />
          ))}
        </ul>
        {more ? (
          <Link
            to="/sessions"
            className="workspace-recent__all small"
            data-nav-item=""
            data-nav-id={`recent-all:${folderKey}`}
          >
            {t('workspace.recent.all')}
          </Link>
        ) : null}
      </>
    );
  }

  return (
    <div className="workspace-recent">
      <button
        type="button"
        className="btn btn-quiet workspace-recent__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        data-nav-item=""
        data-nav-id={`recent:${folderKey}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {t('workspace.recent.title')}
      </button>
      {open ? (
        <div id={panelId} className="workspace-recent__panel">
          {body}
        </div>
      ) : null}
      {nativeOpen ? (
        <ResumeDialog
          sessionId={nativeId}
          target="native"
          onCancel={() => {
            setNativeId(null);
          }}
        />
      ) : null}
    </div>
  );
}
