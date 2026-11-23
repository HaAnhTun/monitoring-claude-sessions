// One live terminal in a folder of the Workspace sidebar (design 04 6.2): a link that selects the session, the name and the state in a
// word, and under them what the monitor knows (tokens, age, errors) or why it knows nothing yet. The state is never colour alone:
// the badge always carries its word. A session with a title the person allows (the preference `workspaceTitles`) shows it on a
// muted line of its own, as text of the server, one line with an ellipsis.
import { Link } from 'react-router';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge, type StateBadgeProps } from '../../components/StateBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import { titleOf, type TitleMode } from '../../lib/workspace-attention.ts';
import type { RowState, SessionRowModel } from '../../lib/workspace-view.ts';

/**
 * A linked process without a transcript reads its registry status. `waiting` there is exactly the case of lifecycle rule S-6b, so the
 * badge gets that rule and reads "Needs you" like the monitor row that follows (ADR 0107); any other status keeps its plain word.
 */
export function registryAssessment(row: Extract<RowState, { kind: 'registry' }>): StateBadgeProps['assessment'] {
  if (row.state !== 'waiting_input') return undefined;
  return {
    basis: 'observed',
    confidence: 'high',
    staleKind: null,
    evidence: [],
    since: null,
    rule: 'S-6b',
    waitReason: row.waitingFor?.includes('permission') === true ? 'permission' : 'user',
  };
}

/** The title a row may show: only a session the monitor knows has one. */
export function rowTitleOf(row: RowState, titles: TitleMode): string | null {
  return row.kind === 'monitor' ? titleOf(row.summary, titles) : null;
}

/** The state a row without a lifecycle state of its own is drawn with: a word of the catalogue and the shape of its dot. */
function PlainBadge({
  labelKey,
  dot,
}: {
  labelKey: 'workspace.session.starting' | 'state.unknown.label';
  dot: 'ring' | 'solid';
}) {
  const t = useT();
  const display = lifecycleDisplay('unknown');
  return (
    <span className={`badge badge--state badge--sm ${display.toneClass}`} data-state={display.state}>
      <span className={`state-dot state-dot--${dot}`} aria-hidden="true" />
      <span className="badge__word">{t(labelKey)}</span>
    </span>
  );
}

function RowBadge({ row }: { row: RowState }) {
  switch (row.kind) {
    case 'starting':
      return <PlainBadge labelKey="workspace.session.starting" dot="ring" />;
    case 'not-linked':
    case 'ambiguous':
      return <PlainBadge labelKey="state.unknown.label" dot="solid" />;
    case 'registry':
      return <StateBadge state={row.state} assessment={registryAssessment(row)} size="sm" />;
    case 'monitor':
      return (
        <StateBadge
          state={row.summary.state.state}
          assessment={row.summary.state}
          lastActivityAt={row.summary.lastActivityAt}
          size="sm"
        />
      );
  }
}

/** The muted second line: the figures of the transcript, or the reason the row has none. */
function RowDetail({ row }: { row: RowState }) {
  const t = useT();
  switch (row.kind) {
    case 'starting':
      return null;
    case 'not-linked':
      return <span className="workspace-session__note">{t('workspace.session.notLinked')}</span>;
    case 'ambiguous':
      return <span className="workspace-session__note">{t('workspace.session.ambiguous')}</span>;
    case 'registry':
      if (row.waitingFor !== null) {
        return <ServerText className="workspace-session__note">{row.waitingFor}</ServerText>;
      }
      return row.state === 'turn_ended' ? (
        <span className="workspace-session__note">{t('workspace.session.waitingPrompt')}</span>
      ) : null;
    case 'monitor': {
      const { summary } = row;
      return (
        <>
          <TokenFigures usage={summary.usage} variant="cell" figure="output" />
          <RelativeTime iso={summary.lastActivityAt} />
          {summary.errorCount > 0 ? (
            <span className="workspace-session__errors">
              {t('workspace.session.errors', { count: summary.errorCount })}
            </span>
          ) : null}
        </>
      );
    }
  }
}

export interface SessionRowProps {
  model: SessionRowModel;
  /** Called after a click on the row (the overlay of the list closes on a selection). */
  onNavigate?: () => void;
  /** Which titles a row shows (the preference `workspaceTitles`). Default: none. */
  titles?: TitleMode | undefined;
}

/** A live session of a folder: `Link` to `/?session=<name>`, which asks the page to focus the terminal. */
export function SessionRow({ model, onNavigate, titles = 'off' }: SessionRowProps) {
  const t = useT();
  const { session, row, selected } = model;
  const label = rowTitleOf(row, titles);
  const title = [session.path, session.viewers > 1 ? t('workspace.session.viewers', { count: session.viewers }) : '']
    .filter((part) => part !== '')
    .join('\n');
  return (
    <li className="workspace-session">
      <Link
        to={{ pathname: '/', search: `?session=${encodeURIComponent(session.name)}` }}
        state={{ focusTerminal: true }}
        className="workspace-session__link"
        data-nav-item=""
        data-nav-id={`session:${session.name}`}
        aria-current={selected ? 'true' : undefined}
        title={title}
        onClick={onNavigate}
      >
        <span className="workspace-session__head">
          <span className="workspace-session__name">{session.name}</span>
          <RowBadge row={row} />
        </span>
        <span className="workspace-session__detail">
          <RowDetail row={row} />
        </span>
        {label === null ? null : (
          <span className="workspace-session__title" title={label}>
            <ServerText>{label}</ServerText>
          </span>
        )}
      </Link>
    </li>
  );
}
