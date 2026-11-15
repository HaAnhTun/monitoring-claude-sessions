// One open terminal session (design 04 7.7, 6.3): the region the program owns, the status line above it, the hint that names the way
// out, the pill that jumps back to the newest output, and the handle the page uses from outside. The default export is for
// `React.lazy`: the page loads this file (and through the seam, xterm) only when a session is open, so the first chunk stays small.
//
// Everything about the connection (engine, socket, size, keys) is `useTerminalConnection`; this file draws its state and owns the
// words. No heading: the page has exactly one `h1`, the session name or the notice title, and the pane header writes it. The view
// is keyed by instance and session name by its parent, so one view is one xterm instance.
//
// The keyboard: everything inside `[data-terminal-region]` belongs to the terminal (the shortcut registry refuses it), Tab and
// Shift+Tab belong to the program, and the way out is `RELEASE_CHORD` (WCAG 2.1.2). The hint says so, and the text area of xterm is
// described by it, so a screen reader announces the way out when the terminal takes the focus.
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { Button } from '../components/Button.tsx';
import { useNow } from '../components/RelativeTime.tsx';
import { useT } from '../i18n/context.ts';
import type { TFunction } from '../i18n/types.ts';
import type { EndedInfo, LiveSession } from '../lib/workspace-view.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { RELEASE_CHORD } from './protocol.ts';
import {
  useTerminalConnection,
  type SizeOwner,
  type TerminalHandle,
  type TerminalViewStatus,
} from './useTerminalConnection.ts';

/** What the page can do to the view from outside: focus it (the `t` key), redraw, take the size back, scroll to the newest output. */
export type TerminalViewHandle = TerminalHandle;

export interface TerminalViewProps {
  /** The session to show. The socket is the one of `session.name`; the rest is what the page knew when it ended. */
  session: LiveSession;
  /** The session list is fresh and lacks the session (the oracle of design 04 8.2): the view ends. */
  gone: boolean;
  /** Focus the terminal on the first `live`: the person picked this session. */
  focusOnLive: boolean;
  /** The session ended in this window; called with everything the pane needs to keep the frozen screen and offer what comes next. */
  onEnded: (info: EndedInfo) => void;
  /** The process runs under ConPTY. Left out when the page does not know: the wire contract carries no host platform today. */
  windowsHost?: boolean | undefined;
  ref?: Ref<TerminalViewHandle> | undefined;
}

/** The wait before the next reconnect, as words; a component of its own so that its clock starts when the wait does. */
function ReconnectText({ deadline, typingPaused }: { deadline: number; typingPaused: boolean }) {
  const t = useT();
  const now = useNow();
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const text = seconds > 0 ? t('terminal.status.reconnecting', { seconds }) : t('terminal.status.reconnectingNow');
  return typingPaused ? `${text} ${t('terminal.status.typingPaused')}` : text;
}

interface StatusLine {
  text: ReactNode;
  action: { label: string; run: () => void } | null;
}

interface StatusInput {
  status: TerminalViewStatus;
  sizeOwner: SizeOwner;
  typingPaused: boolean;
  t: TFunction;
  retryNow: () => void;
  takeSize: () => void;
}

/** What the status line says, or `null` when all is well (the hint is then the only text of the bar). */
function statusLineOf({ status, sizeOwner, typingPaused, t, retryNow, takeSize }: StatusInput): StatusLine | null {
  const withPause = (text: string): string => (typingPaused ? `${text} ${t('terminal.status.typingPaused')}` : text);
  switch (status.kind) {
    case 'loading-engine':
      return { text: t('terminal.status.loadingEngine'), action: null };
    case 'engine-failed':
      return { text: t('terminal.status.engineFailed'), action: { label: t('common.retry'), run: retryNow } };
    case 'connecting':
      return { text: withPause(t('terminal.status.connecting')), action: null };
    case 'reconnecting':
      return {
        text:
          status.nextRetryAt === null ? (
            withPause(t('terminal.status.reconnectingNow'))
          ) : (
            <ReconnectText deadline={status.nextRetryAt} typingPaused={typingPaused} />
          ),
        action: { label: t('common.retryNow'), run: retryNow },
      };
    case 'live':
      if (sizeOwner === 'self') return null;
      return {
        text: t('workspace.pane.sizeOther', { cols: sizeOwner.cols, rows: sizeOwner.rows }),
        action: { label: t('workspace.pane.sizeUse'), run: takeSize },
      };
    case 'ended':
      if (status.killed) return { text: t('terminal.ended.killed'), action: null };
      return {
        text:
          status.exitCode === null
            ? t('terminal.ended.exited')
            : t('terminal.ended.exitCode', { code: status.exitCode }),
        action: null,
      };
    case 'locked':
      return { text: t('access.locked.title'), action: null };
    case 'failed':
      return { text: t('terminal.status.failed'), action: { label: t('common.retry'), run: retryNow } };
  }
}

export default function TerminalView({ session, gone, focusOnLive, onEnded, windowsHost, ref }: TerminalViewProps) {
  const t = useT();
  const announce = useAnnounce();
  const hintId = useId();
  const [focused, setFocused] = useState(false);
  const { name } = session;

  const connection = useTerminalConnection({
    name,
    gone,
    focusOnLive,
    onEnded: (outcome) => {
      onEnded({ name, session, exitCode: outcome.exitCode, killed: outcome.killed });
    },
    windowsHost,
  });
  const { status, size, sizeOwner, scrolledUp, typingPaused, handle, hostRef, retryNow } = connection;

  useImperativeHandle(ref, () => handle, [handle]);

  // The ending and the return of the connection are told to the live region of the page, once each (the announcer drops repeats);
  // the status line is a live region too, so the sentence is also read there.
  const previousKind = useRef<TerminalViewStatus['kind']>(status.kind);
  const wasReconnecting = useRef(false);
  const kind = status.kind;
  useEffect(() => {
    if (kind === 'ended' && previousKind.current !== 'ended') {
      announce(t('workspace.announce.ended', { name }));
    }
    if (kind === 'reconnecting') wasReconnecting.current = true;
    if (kind === 'live' && wasReconnecting.current) {
      wasReconnecting.current = false;
      announce(t('workspace.announce.reconnected', { name }));
    }
    previousKind.current = kind;
  }, [kind, announce, t, name]);

  useEffect(() => {
    if (typingPaused) announce(t('terminal.status.typingPaused'));
  }, [typingPaused, announce, t]);

  const line = statusLineOf({ status, sizeOwner, typingPaused, t, retryNow, takeSize: handle.takeSize });
  const action = line?.action ?? null;

  // `#terminal` is where the skip link lands: that focus belongs to the terminal. A focus that arrives from inside does not bounce.
  function onRootFocus(event: FocusEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) handle.focus();
  }

  function onRegionFocus(event: FocusEvent<HTMLDivElement>): void {
    setFocused(true);
    const target = event.target;
    // the text area belongs to xterm: it is described by the hint, so that the way out is read when the terminal takes the focus
    if (target instanceof HTMLTextAreaElement && !target.hasAttribute('aria-describedby')) {
      target.setAttribute('aria-describedby', hintId);
    }
  }

  function onRegionBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }

  return (
    <div id="terminal" className="terminal-view" tabIndex={-1} onFocus={onRootFocus}>
      <div className="terminal-bar">
        <p className="terminal-status" role="status">
          {line?.text}
        </p>
        {action === null ? null : (
          <Button variant="quiet" onClick={action.run}>
            {action.label}
          </Button>
        )}
        <p id={hintId} className="terminal-hint" aria-hidden={focused ? undefined : true}>
          {t('terminal.hint.leave')} <kbd className="kbd">{RELEASE_CHORD}</kbd>
        </p>
      </div>
      <div
        className="terminal-region"
        role="group"
        aria-label={t('terminal.region', { name })}
        data-terminal-region
        onFocus={onRegionFocus}
        onBlur={onRegionBlur}
      >
        <div
          ref={hostRef}
          className="terminal-host"
          data-terminal
          data-cols={size?.cols}
          data-rows={size?.rows}
          title={`${t('terminal.hint.leave')} ${RELEASE_CHORD}`}
        />
        {scrolledUp ? (
          <button type="button" className="terminal-latest" onClick={handle.scrollToLatest}>
            {t('workspace.pane.latest')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
