// The terminal pane of the Workspace (design 04 6.3 and 8.1): by the state of `paneStateOf` it draws the locked notice, a plain
// notice, or a session: header, the ended banner when the process left, and the terminal itself. The terminal view is a lazy chunk
// (it brings the seam of the engine, xterm loads on its own import from there) and exists once per instance and session name.
// An ended session keeps its last output under the banner until another session is selected.
import { lazy, Suspense, type Ref, type RefObject } from 'react';

import { Button } from '../../components/Button.tsx';
import type { AccessFlow, AccessOutcome } from '../../data/access-flow.ts';
import { useIid } from '../../data/hooks/useInstance.ts';
import { useT } from '../../i18n/context.ts';
import type { EndedInfo, LiveSession, PaneState } from '../../lib/workspace-view.ts';
import type { TerminalViewHandle } from '../../terminal/TerminalView.tsx';
import { LockedNotice } from './LockedNotice.tsx';
import { PaneHeader, type ListToggle } from './PaneHeader.tsx';
import { TerminalNotice } from './TerminalNotice.tsx';

/** The one import of the view: the page starts it early (`preloadTerminalView`), the lazy component awaits the same promise. */
export function preloadTerminalView() {
  return import('../../terminal/TerminalView.tsx');
}

const TerminalView = lazy(preloadTerminalView);

export interface TerminalPaneProps {
  state: PaneState<AccessOutcome>;
  flow: AccessFlow;
  headingRef: Ref<HTMLHeadingElement>;
  /** The handle of the open view: the pane's Redraw button and the page's `t` shortcut use it. */
  viewRef: RefObject<TerminalViewHandle | null>;
  /** The session list is fresh and lacks the open session: the view ends (the oracle of design 04 8.2). */
  gone: boolean;
  /** `null`: the project column does not exist (terminals unavailable), so there is nothing to toggle. */
  list: ListToggle | null;
  /** The ref of the toggle button of the header. */
  toggleRef: Ref<HTMLButtonElement>;
  onEnded: (info: EndedInfo) => void;
  onStop: (session: LiveSession) => void;
  /** "Start a new session in this folder" of the ended banner. */
  onStartAgain: (session: LiveSession) => void;
  /** "Resume this conversation" of the ended banner: the id of the monitored session. */
  onResume: (sessionId: string) => void;
  onRetry: () => void;
  onOtherFolder?: (() => void) | undefined;
  onOpenList?: (() => void) | undefined;
}

function EndedBanner({
  info,
  onStartAgain,
  onResume,
}: {
  info: EndedInfo;
  onStartAgain: () => void;
  onResume: (sessionId: string) => void;
}) {
  const t = useT();
  const sessionId = info.session.link.sessionId;
  const why = info.killed
    ? t('terminal.ended.killed')
    : info.exitCode === null
      ? t('terminal.ended.exited')
      : t('terminal.ended.exitCode', { code: info.exitCode });
  return (
    <section className="workspace-ended" aria-labelledby="workspace-ended-title">
      <div className="workspace-ended__text">
        <h2 id="workspace-ended-title" className="workspace-ended__title">
          {t('terminal.ended.title')}
        </h2>
        <p>{why}</p>
      </div>
      <div className="workspace-ended__actions">
        <Button variant="primary" onClick={onStartAgain}>
          {t('terminal.ended.startAgain')}
        </Button>
        {sessionId === null ? null : (
          <Button
            onClick={() => {
              onResume(sessionId);
            }}
          >
            {t('terminal.ended.resume')}
          </Button>
        )}
      </div>
    </section>
  );
}

function LoadingView() {
  const t = useT();
  return (
    <p className="workspace-pane__loading" role="status">
      {t('terminal.status.loadingEngine')}
    </p>
  );
}

export function TerminalPane({
  state,
  flow,
  headingRef,
  viewRef,
  gone,
  list,
  toggleRef,
  onEnded,
  onStop,
  onStartAgain,
  onResume,
  onRetry,
  onOtherFolder,
  onOpenList,
}: TerminalPaneProps) {
  const iid = useIid();
  let body;
  switch (state.kind) {
    case 'locked':
      body = <LockedNotice outcome={state.outcome} flow={flow} headingRef={headingRef} />;
      break;
    case 'terminal': {
      const { session, row, ended } = state;
      body = (
        <>
          <PaneHeader
            session={session}
            row={row}
            headingRef={headingRef}
            ended={ended !== null}
            list={list}
            toggleRef={toggleRef}
            onRedraw={() => {
              viewRef.current?.redraw();
            }}
            onStop={() => {
              onStop(session);
            }}
          />
          {ended === null ? null : (
            <EndedBanner
              info={ended}
              onStartAgain={() => {
                onStartAgain(session);
              }}
              onResume={onResume}
            />
          )}
          <Suspense fallback={<LoadingView />}>
            <TerminalView
              key={`${iid}:${session.name}`}
              ref={viewRef}
              session={session}
              gone={gone}
              focusOnLive={state.focus}
              onEnded={onEnded}
            />
          </Suspense>
        </>
      );
      break;
    }
    case 'loading':
    case 'error':
    case 'unavailable':
    case 'none-selected':
    case 'not-found':
      body = (
        <TerminalNotice
          state={state}
          headingRef={headingRef}
          onRetry={onRetry}
          onOtherFolder={onOtherFolder}
          onOpenList={onOpenList}
        />
      );
  }
  return (
    <div className="workspace-pane" data-pane={state.kind}>
      {body}
    </div>
  );
}
