// The Workspace (design 04 2.2, 6 and 8): the project column and the terminal pane on `/`, with the dialogs that start, stop and
// resume terminals. The selection is the address (`/?session=<name>`); a bare `/` restores the last selection once per page load;
// a click on a row asks for the focus through router state, which this page consumes at once so that a reload or Back does not
// focus the terminal again. A task instance has no terminals, so the page sends it to the Overview.
import type { SessionSummary } from '@mcs/shared';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { ApiError, describeApiError } from '../../data/api-errors.ts';
import { AccessFlowContext, useAuthSession, useCreateAccessFlow } from '../../data/hooks/useAuth.ts';
import { useLinkedSessions } from '../../data/hooks/useFolders.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { usePickFolder, useStartInFolder } from '../../data/hooks/useTerminalActions.ts';
import { useTerminalState } from '../../data/hooks/useTerminalState.ts';
import { useT } from '../../i18n/context.ts';
import { selectedKeyOf } from '../../lib/attention-rows.ts';
import { parseUrlState, workspaceSpec } from '../../lib/url-state.ts';
import { nextNeeding } from '../../lib/workspace-attention.ts';
import { paneStateOf, type EndedInfo, type LiveSession, type PaneTerminalState } from '../../lib/workspace-view.ts';
import { useAnnounce } from '../../state/announcer.tsx';
import { useAttentionRows } from '../../state/attention-context.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { useShortcut } from '../../state/shortcuts-registry.tsx';
import { useShowToast } from '../../state/toast-store.ts';
import { MQ_LIST_OVERLAY, useMediaQuery } from '../../state/use-media-query.ts';
import { useTerminalEvents } from '../../terminal/useTerminalEvents.ts';
import type { TerminalViewHandle } from '../../terminal/TerminalView.tsx';
import {
  FolderPathDialog,
  NewSessionDialog,
  ResumeDialog,
  StopSessionDialog,
  type NewSessionTarget,
} from './ActionDialogs.tsx';
import type { ListToggle } from './PaneHeader.tsx';
import { preloadTerminalView, TerminalPane } from './TerminalPane.tsx';
import { PROJECT_LIST_ID, WorkspaceSidebar } from './WorkspaceSidebar.tsx';

const NO_SESSIONS: readonly LiveSession[] = [];

/** The router state a click on a session row (or a new session) carries: the person picked it, so the terminal takes the focus. */
function wantsFocus(state: unknown): boolean {
  return typeof state === 'object' && state !== null && Reflect.get(state, 'focusTerminal') === true;
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

/** The last segment of a folder path: how the dialogs name a folder. */
function folderNameOf(path: string): string {
  return (
    path
      .split(/[\\/]/u)
      .filter((part) => part !== '')
      .at(-1) ?? path
  );
}

function sessionSearch(name: string): string {
  return `?session=${encodeURIComponent(name)}`;
}

/** The route component of `/`. */
export function WorkspacePage() {
  const instance = useInstance().data;
  // A task instance has no terminals: a bookmark of `/` still lands on the page it always had.
  if (instance?.kind === 'task') return <Navigate to="/overview" replace />;
  return <WorkspaceScreen />;
}

function WorkspaceScreen(): ReactNode {
  const t = useT();
  const announce = useAnnounce();
  const showToast = useShowToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { prefs, setPref } = usePrefs();
  const overlay = useMediaQuery(MQ_LIST_OVERLAY);

  const selected = parseUrlState(workspaceSpec, searchParams).value.session;

  // ---- data -------------------------------------------------------------------------------------------------------------
  const auth = useAuthSession();
  const ownFlow = useCreateAccessFlow();
  const flow = useContext(AccessFlowContext) ?? ownFlow;
  const subscribeAccess = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const readAccess = useCallback(() => flow.snapshot(), [flow]);
  const accessOutcome = useSyncExternalStore(subscribeAccess, readAccess, readAccess);
  const authenticated = auth.data?.authenticated === true;
  const events = useTerminalEvents({ enabled: authenticated });
  const eventsOpen = events.status === 'open';
  const terminal = useTerminalState({ eventsOpen });
  const sessions = terminal.data?.sessions ?? NO_SESSIONS;
  const linkedIds = useMemo(
    () =>
      sessions
        .filter((session) => session.link.transcript === 'tracked')
        .flatMap((session) => (session.link.sessionId === null ? [] : [session.link.sessionId])),
    [sessions],
  );
  const linked = useLinkedSessions(linkedIds);
  const monitor = useMemo(
    () => new Map((linked.data?.items ?? []).map((summary) => [summary.id, summary])),
    [linked.data],
  );

  // The code of the next chunk is fetched while the list loads: opening a session then waits for nothing but its socket.
  useEffect(() => {
    void preloadTerminalView();
  }, []);

  // ---- the selection ----------------------------------------------------------------------------------------------------
  const present = sessions.find((session) => session.name === selected);
  // What the list said about the selected session before it left: the view that is open keeps its header and ends itself.
  const [seen, setSeen] = useState<LiveSession | null>(null);
  if (present !== undefined && seen !== present) setSeen(present);

  // A session that ended in this window keeps its screen and a banner until another one is selected.
  const [endedLocal, setEndedLocal] = useState<EndedInfo | null>(null);
  const [endedFor, setEndedFor] = useState(selected);
  if (endedFor !== selected) {
    setEndedFor(selected);
    setEndedLocal(null);
  }

  const dataReady = terminal.data !== undefined;
  const gone =
    dataReady && selected !== '' && present === undefined && seen?.name === selected && endedLocal?.name !== selected;
  const paneData = useMemo<PaneTerminalState | undefined>(() => {
    const data = terminal.data;
    if (data === undefined) return undefined;
    if (!gone) return data;
    return { capabilities: data.capabilities, sessions: [...data.sessions, seen] };
  }, [terminal.data, gone, seen]);

  // The click that selected a session asked for the focus: remember it for this session and clear the history entry.
  const focusAsked = wantsFocus(location.state);
  const [focusFor, setFocusFor] = useState<string | null>(null);
  const { pathname, search } = location;
  if (focusAsked && focusFor !== selected) setFocusFor(selected);
  useEffect(() => {
    if (focusAsked) void navigate({ pathname, search }, { replace: true, state: null });
  }, [focusAsked, navigate, pathname, search]);
  const focusRequested = focusAsked || (focusFor !== null && focusFor === selected);

  const authQuery = useMemo(
    () => ({ data: auth.data, error: auth.error instanceof ApiError ? auth.error : null }),
    [auth.data, auth.error],
  );
  const pane = paneStateOf({
    auth: authQuery,
    terminal: { data: paneData, error: terminal.error },
    monitor,
    selected,
    endedLocal,
    focusRequested,
    accessOutcome,
  });

  // A bare `/` restores the last selection, once per page load, when that session still runs.
  const restored = useRef(false);
  useEffect(() => {
    const data = terminal.data;
    if (restored.current || data === undefined) return;
    restored.current = true;
    if (selected !== '') return;
    const last = prefs.lastTerminal ?? '';
    if (last !== '' && data.sessions.some((session) => session.name === last)) {
      void navigate({ pathname: '/', search: sessionSearch(last) }, { replace: true });
    }
  }, [terminal.data, selected, prefs.lastTerminal, navigate]);

  // A selected session that runs is the one to restore next time.
  // Once per selection: a stop or a lock that clears the preference must not be undone by the render that still shows the session.
  const live = pane.kind === 'terminal' && pane.ended === null ? pane.session.name : '';
  const remembered = useRef('');
  useEffect(() => {
    if (live === '') {
      remembered.current = '';
      return;
    }
    if (remembered.current === live) return;
    remembered.current = live;
    if (prefs.lastTerminal !== live) setPref('lastTerminal', live);
  }, [live, prefs.lastTerminal, setPref]);

  // ---- the page chrome and the keys --------------------------------------------------------------------------------------
  const headingRef = usePageChrome(pane.kind === 'terminal' ? pane.session.name : t('route.workspace.title'));
  const viewRef = useRef<TerminalViewHandle | null>(null);
  useShortcut(
    't',
    () => {
      viewRef.current?.focus();
    },
    { description: t('workspace.shortcut.focusTerminal'), enabled: pane.kind === 'terminal' && pane.ended === null },
  );

  // `n` goes through the sessions of the "Needs you" strip in its order, wrapping; a terminal is selected with the focus, a session
  // that is no terminal opens its page. A key pressed inside the terminal belongs to the program, so it never reaches this.
  const attentionRows = useAttentionRows();
  useShortcut(
    'n',
    () => {
      const current = selectedKeyOf(attentionRows, { terminal: selected === '' ? null : selected, sessionId: null });
      const next = nextNeeding(attentionRows, current);
      if (next === null) {
        announce(t('workspace.attention.none'), { force: true });
      } else if (next.terminal !== null) {
        void navigate({ pathname: '/', search: sessionSearch(next.terminal) }, { state: { focusTerminal: true } });
      } else if (next.sessionId !== null) {
        void navigate(`/sessions/${encodeURIComponent(next.sessionId)}`);
      }
    },
    { description: t('workspace.shortcut.nextNeeding') },
  );

  // ---- the project column and its toggle ----------------------------------------------------------------------------------
  const [overlayOpen, setOverlayOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const columnPresent = authenticated && terminal.data?.capabilities.available !== false;
  const collapsed = prefs.workspaceCollapsed;
  const closeOverlay = useCallback(() => {
    setOverlayOpen(false);
  }, []);
  const list: ListToggle | null = columnPresent
    ? {
        expanded: overlay ? overlayOpen : !collapsed,
        controlsId: PROJECT_LIST_ID,
        onToggle: () => {
          if (overlay) setOverlayOpen((open) => !open);
          else setPref('workspaceCollapsed', !collapsed);
        },
      }
    : null;
  const listState = overlay ? (overlayOpen ? 'open' : 'closed') : collapsed ? 'collapsed' : 'open';

  // ---- actions ----------------------------------------------------------------------------------------------------------
  const [newTarget, setNewTarget] = useState<NewSessionTarget | null>(null);
  const [stopTarget, setStopTarget] = useState<LiveSession | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const picker = usePickFolder();
  const startInFolder = useStartInFolder();
  const [picking, setPicking] = useState(false);

  /** A session was started or resumed: select it, give it the focus, say so. */
  const opened = useCallback(
    (session: LiveSession) => {
      setNewTarget(null);
      setResumeId(null);
      setFolderOpen(false);
      showToast(t('workspace.toast.started', { name: session.name }));
      void navigate({ pathname: '/', search: sessionSearch(session.name) }, { state: { focusTerminal: true } });
    },
    [navigate, showToast, t],
  );

  const stopped = useCallback(
    (name: string) => {
      setStopTarget(null);
      showToast(t('workspace.toast.stopped', { name }));
      setPref('lastTerminal', '');
      const next = sessions.find((session) => session.name !== name);
      void navigate(next === undefined ? { pathname: '/' } : { pathname: '/', search: sessionSearch(next.name) }, {
        replace: true,
      });
    },
    [sessions, navigate, showToast, setPref, t],
  );

  const otherFolder = useCallback(() => {
    if (picking) return;
    if (terminal.data?.capabilities.folderPicker !== true) {
      setFolderOpen(true);
      return;
    }
    setPicking(true);
    announce(t('workspace.picker.waiting'));
    picker
      .pick()
      .then(async (path) => {
        if (path === null) return;
        try {
          opened(await startInFolder.start(path));
        } catch (error) {
          showToast(t('workspace.error.create', { detail: describeApiError(asError(error), t) ?? '' }), {
            kind: 'error',
          });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.info.code === 'terminal_unavailable') {
          setFolderOpen(true);
          return;
        }
        showToast(t('workspace.error.pick', { detail: describeApiError(asError(error), t) ?? '' }), { kind: 'error' });
      })
      .finally(() => {
        setPicking(false);
      });
  }, [picking, terminal.data, picker, startInFolder, opened, announce, showToast, t]);

  const resume = useCallback((summary: SessionSummary) => {
    setResumeId(summary.id);
  }, []);

  const onEnded = useCallback((info: EndedInfo) => {
    setEndedLocal(info);
  }, []);

  const hideColumn = !columnPresent || overlay || collapsed;
  return (
    <div className="workspace" data-list={listState}>
      <WorkspaceSidebar
        selected={selected}
        eventsOpen={eventsOpen}
        open={overlayOpen}
        onClose={closeOverlay}
        returnFocusRef={toggleRef}
        onNewSession={setNewTarget}
        onOtherFolder={otherFolder}
        onResume={resume}
      />
      <TerminalPane
        state={pane}
        flow={flow}
        headingRef={headingRef}
        viewRef={viewRef}
        gone={gone}
        list={list}
        toggleRef={toggleRef}
        onEnded={onEnded}
        onStop={setStopTarget}
        onStartAgain={(session) => {
          setNewTarget({ name: folderNameOf(session.path), path: session.path, known: true });
        }}
        onResume={setResumeId}
        onRetry={() => {
          void terminal.refetch();
        }}
        onOtherFolder={hideColumn ? otherFolder : undefined}
        onOpenList={
          overlay && columnPresent
            ? () => {
                setOverlayOpen(true);
              }
            : undefined
        }
      />
      <NewSessionDialog
        target={newTarget}
        onCancel={() => {
          setNewTarget(null);
        }}
        onStarted={opened}
      />
      <StopSessionDialog
        session={stopTarget}
        onCancel={() => {
          setStopTarget(null);
        }}
        onStopped={stopped}
      />
      <ResumeDialog
        sessionId={resumeId}
        onCancel={() => {
          setResumeId(null);
        }}
        onResumed={opened}
      />
      <FolderPathDialog
        open={folderOpen}
        onCancel={() => {
          setFolderOpen(false);
        }}
        onStarted={opened}
      />
    </div>
  );
}
