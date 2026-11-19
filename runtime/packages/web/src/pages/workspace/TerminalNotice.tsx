// What the pane says when there is no terminal to show (design 04 6.3 and 8.1): loading, nothing selected, a session that is not
// running, terminals that cannot run on this system, and a failed first load. Each one is the heading of the page, because no
// session header exists then: an `EmptyState` with heading level 1 (the error state has no heading of its own, so a hidden one
// stands in). The locked state has its own file (`LockedNotice.tsx`), it carries a form.
import type { Ref } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import type { PaneState, PaneUnavailableReason } from '../../lib/workspace-view.ts';

export type NoticeState = Extract<
  PaneState,
  { kind: 'loading' | 'error' | 'unavailable' | 'none-selected' | 'not-found' }
>;

export interface TerminalNoticeProps {
  state: NoticeState;
  headingRef: Ref<HTMLHeadingElement>;
  /** Retry after a failed first load. */
  onRetry: () => void;
  /** Only where the project column is hidden: the one primary button of "nothing selected". */
  onOtherFolder?: (() => void) | undefined;
  /** Only where the project list is an overlay: opens it. */
  onOpenList?: (() => void) | undefined;
}

/** Stands in for the name while the sentence is translated; the name itself is inserted afterwards as text. */
const NAME_SLOT = '';

const UNAVAILABLE = {
  unsupported_os: { title: 'terminal.unavailable.os.title', body: 'terminal.unavailable.os.body' },
  addon_missing: { title: 'terminal.unavailable.addon.title', body: 'terminal.unavailable.addon.body' },
  claude_not_found: { title: 'terminal.unavailable.claude.title', body: 'terminal.unavailable.claude.body' },
} as const satisfies Readonly<Record<PaneUnavailableReason, { title: MessageKey; body: MessageKey }>>;

export function TerminalNotice({ state, headingRef, onRetry, onOtherFolder, onOpenList }: TerminalNoticeProps) {
  const t = useT();
  switch (state.kind) {
    case 'loading':
      return <EmptyState icon="terminal" title={t('workspace.loading')} headingLevel={1} titleRef={headingRef} />;
    case 'error':
      return (
        <>
          <h1 ref={headingRef} tabIndex={-1} className="sr-only">
            {t('route.workspace.title')}
          </h1>
          <ErrorState
            kind="load"
            size="page"
            subjectKey="error.subject.workspace"
            error={state.error}
            onRetry={onRetry}
          />
        </>
      );
    case 'unavailable': {
      const words = UNAVAILABLE[state.reason];
      return (
        <EmptyState icon="terminal" title={t(words.title)} headingLevel={1} titleRef={headingRef}>
          <p>{t(words.body)}</p>
        </EmptyState>
      );
    }
    case 'none-selected':
      return (
        <EmptyState
          icon="terminal"
          title={t('workspace.pane.none.title')}
          headingLevel={1}
          titleRef={headingRef}
          primary={
            onOtherFolder === undefined ? undefined : { label: t('workspace.otherFolder'), onClick: onOtherFolder }
          }
          secondary={
            onOpenList === undefined ? undefined : (
              <Button variant="quiet" icon="panel-left" onClick={onOpenList}>
                {t('workspace.pane.toggleList')}
              </Button>
            )
          }
        >
          <p>{t('workspace.pane.none.body')}</p>
        </EmptyState>
      );
    case 'not-found': {
      const [before = '', after = ''] = t('workspace.pane.notFound.body', { name: NAME_SLOT }).split(NAME_SLOT);
      return (
        <EmptyState
          icon="search"
          title={t('workspace.pane.notFound.title')}
          headingLevel={1}
          titleRef={headingRef}
          secondary={<Link to="/">{t('route.workspace.title')}</Link>}
        >
          <p>
            {before}
            <code className="mono">{state.name}</code>
            {after}
          </p>
        </EmptyState>
      );
    }
  }
}
