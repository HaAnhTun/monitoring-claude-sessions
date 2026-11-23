// The header of an open terminal (design 04 6.3): the session name as the heading of the page, its folder, its state and tokens
// from the monitor, how many windows watch it, and the actions of the pane. The state is a word as well as a colour, the tokens
// are the figures of the transcript (nothing is shown for a process that has no transcript yet). Beside the name stands the title of
// the session when the person allows titles (the preference `workspaceTitles`, ADR 0107): the same text as on its row of the list.
import type { Ref } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import { attentionPrefsOf } from '../../lib/prefs.ts';
import type { LiveSession, RowState } from '../../lib/workspace-view.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { registryAssessment, rowTitleOf } from './SessionRow.tsx';

/** The button that folds the project column away or opens the overlay; the header only draws it. */
export interface ListToggle {
  /** The column (or the overlay) is shown. */
  expanded: boolean;
  /** The id of the list it controls. */
  controlsId: string;
  onToggle: () => void;
}

export interface PaneHeaderProps {
  session: LiveSession;
  row: RowState;
  headingRef: Ref<HTMLHeadingElement>;
  /** The session ended in this window: nothing can be redrawn or stopped any more. */
  ended: boolean;
  list: ListToggle | null;
  /** The ref of the list toggle: the overlay of the list gives the focus back to it. */
  toggleRef: Ref<HTMLButtonElement>;
  onRedraw: () => void;
  onStop: () => void;
}

function RowStatus({ row }: { row: RowState }) {
  const t = useT();
  switch (row.kind) {
    case 'starting':
      return <span className="workspace-header__note">{t('workspace.session.starting')}</span>;
    case 'not-linked':
      return <span className="workspace-header__note">{t('workspace.session.notLinked')}</span>;
    case 'ambiguous':
      return <span className="workspace-header__note">{t('workspace.session.ambiguous')}</span>;
    case 'registry':
      return <StateBadge state={row.state} assessment={registryAssessment(row)} size="md" />;
    case 'monitor':
      return (
        <>
          <StateBadge
            state={row.summary.state.state}
            assessment={row.summary.state}
            lastActivityAt={row.summary.lastActivityAt}
            size="md"
          />
          <TokenFigures usage={row.summary.usage} variant="line" breakdown={false} />
        </>
      );
  }
}

export function PaneHeader({ session, row, headingRef, ended, list, toggleRef, onRedraw, onStop }: PaneHeaderProps) {
  const t = useT();
  const monitorId = session.link.sessionId;
  const label = rowTitleOf(row, attentionPrefsOf(usePrefs().prefs).workspaceTitles);
  return (
    <header className="workspace-header">
      <div className="workspace-header__main">
        {list === null ? null : (
          <Button
            ref={toggleRef}
            variant="icon"
            icon="panel-left"
            aria-label={t('workspace.pane.toggleList')}
            title={t('workspace.pane.toggleList')}
            aria-expanded={list.expanded}
            aria-controls={list.controlsId}
            onClick={list.onToggle}
          />
        )}
        <div className="workspace-header__title">
          <div className="workspace-header__heading">
            <h1 ref={headingRef} tabIndex={-1} className="workspace-header__name">
              {session.name}
            </h1>
            {label === null ? null : (
              <span className="workspace-header__label" title={label}>
                <ServerText>{label}</ServerText>
              </span>
            )}
          </div>
          <p className="workspace-header__path muted" title={session.path}>
            {session.path}
          </p>
        </div>
      </div>
      <div className="workspace-header__facts">
        <RowStatus row={row} />
        {session.viewers > 1 ? (
          <span className="workspace-header__note">{t('workspace.session.viewers', { count: session.viewers })}</span>
        ) : null}
      </div>
      <div className="workspace-header__actions">
        {monitorId === null ? null : (
          <Link className="btn btn-quiet" to={`/sessions/${encodeURIComponent(monitorId)}`}>
            {t('workspace.session.openMonitor')}
          </Link>
        )}
        {ended ? null : (
          <>
            <Button variant="quiet" title={t('workspace.pane.redrawTip')} onClick={onRedraw}>
              {t('workspace.pane.redraw')}
            </Button>
            <Button data-tone="danger" onClick={onStop}>
              {t('workspace.pane.stop')}
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
