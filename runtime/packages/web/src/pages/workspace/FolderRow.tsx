// One project folder of the Workspace sidebar (design 04 6.2): a head button that opens and closes the body, and in the body the
// summary of the DA memory, the live sessions, the recent sessions and "New session". The activity mark is a disc drawn by CSS from
// `data-level`; its words are for assistive technology, so the mark is never colour alone.
import type { SessionSummary } from '@mcs/shared';
import { useId } from 'react';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { useT } from '../../i18n/context.ts';
import type { FolderModel, FolderRowModel, LiveSession } from '../../lib/workspace-view.ts';
import { RecentRows } from './RecentRows.tsx';
import { SessionRow } from './SessionRow.tsx';

export interface FolderRowProps {
  model: FolderRowModel;
  /** Every live terminal of the page, so the recent sessions of this folder can hide those that are open anywhere. */
  liveAll: readonly LiveSession[];
  /** The person opened (`true`) or closed (`false`) the body. */
  onToggle: (open: boolean) => void;
  onNewSession: (folder: FolderModel) => void;
  onResume: (summary: SessionSummary) => void;
  /** Called after a click on a live session (the overlay of the list closes on a selection). */
  onNavigate?: () => void;
}

export function FolderRow({ model, liveAll, onToggle, onNewSession, onResume, onNavigate }: FolderRowProps) {
  const t = useT();
  const bodyId = useId();
  const { folder, live, liveCount, open } = model;
  const canStart = folder.canStart && folder.path !== null;
  return (
    <li className="workspace-folder" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="workspace-folder__head"
        aria-expanded={open}
        aria-controls={bodyId}
        data-nav-item=""
        data-nav-id={`folder:${folder.key}`}
        onClick={() => {
          onToggle(!open);
        }}
      >
        <span className="workspace-mark" data-level={folder.activity} aria-hidden="true" />
        <span className="sr-only">{t(`workspace.folder.activity.${folder.activity}`)}</span>
        <span className="workspace-folder__name" title={folder.path ?? undefined}>
          {folder.name}
        </span>
        {liveCount > 0 ? (
          <span className="workspace-folder__live">{t('workspace.folder.live', { count: liveCount })}</span>
        ) : null}
        <span className="workspace-folder__time muted">
          {folder.hasMemory ? <RelativeTime iso={folder.lastActivityAt} /> : t('workspace.folder.noMemory')}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="workspace-folder__body">
          {folder.summary === null ? null : (
            <p className="workspace-folder__summary muted small" title={folder.summary}>
              {folder.summary}
            </p>
          )}
          {folder.summary !== null && folder.counts !== null ? (
            <p className="workspace-folder__counts muted small">{t('workspace.folder.counts', folder.counts)}</p>
          ) : null}
          {live.length === 0 ? null : (
            <ul className="plain workspace-folder__live-rows">
              {live.map((entry) => (
                <SessionRow
                  key={entry.session.name}
                  model={entry}
                  {...(onNavigate === undefined ? {} : { onNavigate })}
                />
              ))}
            </ul>
          )}
          <RecentRows folderKey={folder.key} live={liveAll} onResume={onResume} />
          <button
            type="button"
            className="btn btn-quiet workspace-folder__new"
            data-nav-item=""
            data-nav-id={`new:${folder.key}`}
            aria-disabled={canStart ? undefined : 'true'}
            title={canStart ? undefined : t('workspace.folder.cannotStart')}
            onClick={() => {
              if (canStart) onNewSession(folder);
            }}
          >
            {t('workspace.newSession')}
          </button>
        </div>
      ) : null}
    </li>
  );
}
