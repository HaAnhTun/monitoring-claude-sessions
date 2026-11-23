// The project column of the Workspace (design 04 6.1 and 6.2): a filter, the folders with their live and recent sessions, and a footer.
// From 1024 px it is a column; below, it is an overlay that a button of the pane header opens: a dialog that traps Tab, closes on
// Escape (the focus goes back to that button), on a click outside and after a selection. It reads its own data (folders, terminals
// and the monitor rows of the linked sessions) and hands every action to the page: New session, Other folder and Resume open
// dialogs that the page owns. It renders nothing when terminals are unavailable or the browser has no session (the pane then takes
// the whole width and says why). Above the filter stands the "Needs you" strip (ADR 0107) while the attention center has a row for
// it; the folders below keep their order.
import type { SessionSummary } from '@mcs/shared';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StaleDataIndicator } from '../../components/StaleDataIndicator.tsx';
import { useAuthSession } from '../../data/hooks/useAuth.ts';
import { useFolders, useLinkedSessions, type FolderList } from '../../data/hooks/useFolders.ts';
import { useTerminalState } from '../../data/hooks/useTerminalState.ts';
import { useT } from '../../i18n/context.ts';
import { attentionPrefsOf } from '../../lib/prefs.ts';
import { rollupByFolder, stripOf } from '../../lib/workspace-attention.ts';
import { buildWorkspaceView, folderPrefKey, type FolderModel, type LiveSession } from '../../lib/workspace-view.ts';
import { useAttentionValue } from '../../state/attention-context.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { MQ_LIST_OVERLAY, useMediaQuery } from '../../state/use-media-query.ts';
import { useShortcut } from '../../state/shortcuts-registry.tsx';
import type { NewSessionTarget } from './ActionDialogs.tsx';
import { FolderRow } from './FolderRow.tsx';
import { NeedsYouStrip } from './NeedsYouStrip.tsx';
import { useRovingFocus } from './useRovingFocus.ts';

/** The id of the column: the target of the skip link "Skip to project list". */
export const PROJECT_LIST_ID = 'project-list';

const NO_SESSIONS: readonly LiveSession[] = [];
const NO_OPEN: Readonly<Record<string, boolean>> = {};

const TAB_CANDIDATES = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]';

/** The elements Tab can reach inside `root`, in document order (the roving items with tabindex -1 are not among them). */
function tabOrderIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TAB_CANDIDATES)].filter(
    (element) => element.getAttribute('tabindex') !== '-1' && element.closest('[hidden]') === null,
  );
}

/** What the folder list said about its sources: the names of those that could not be read completely. */
function degradedSources(sources: FolderList['sources']): string[] {
  const names: string[] = [];
  if (sources.daMemory.status === 'unreadable') names.push('daMemory');
  if (sources.claudeHome.status === 'unreadable' || sources.claudeHome.truncated) names.push('claudeHome');
  if (sources.userFolders.status === 'corrupt' || sources.userFolders.status === 'newer_version') {
    names.push('userFolders');
  }
  return names;
}

export interface WorkspaceSidebarProps {
  /** The name of the selected terminal, '' for none. */
  selected: string;
  /** The events channel of the terminals is open (the list then polls slowly). */
  eventsOpen?: boolean;
  /** Below 1024 px: the overlay is shown. Ignored from 1024 px, where the list is a column. */
  open?: boolean;
  /** The overlay asks to be closed (Escape, a click outside, a selection). */
  onClose?: () => void;
  /** The button that opened the overlay: Escape gives the focus back to it, and a click on it is not a click outside. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onNewSession: (target: NewSessionTarget) => void;
  onOtherFolder: () => void;
  onResume: (summary: SessionSummary) => void;
}

export function WorkspaceSidebar({
  selected,
  eventsOpen = false,
  open = false,
  onClose,
  returnFocusRef,
  onNewSession,
  onOtherFolder,
  onResume,
}: WorkspaceSidebarProps) {
  const t = useT();
  const listId = useId();
  const auth = useAuthSession();
  const terminal = useTerminalState({ eventsOpen });
  const folders = useFolders();
  const { prefs, setPref } = usePrefs();
  const overlay = useMediaQuery(MQ_LIST_OVERLAY);
  // No column at all without the session, and where terminals cannot run: the pane takes the whole width and says why.
  const present = auth.data?.authenticated !== false && terminal.data?.capabilities.available !== false;
  const shown = !overlay || open;
  const dialog = overlay && open;
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

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
  const foldersData = folders.data;
  const view = useMemo(
    () =>
      buildWorkspaceView({
        folders: foldersData?.folders ?? [],
        sessions,
        monitor,
        filter,
        open: prefs.workspaceOpen ?? NO_OPEN,
        selected,
        pinStartingFolders: true,
      }),
    [foldersData, sessions, monitor, filter, prefs.workspaceOpen, selected],
  );
  const knownKeys = useMemo(() => new Set((foldersData?.folders ?? []).map((folder) => folder.key)), [foldersData]);
  // The attention center of the shell: what the strip shows and what a closed folder says. Outside the shell it is empty.
  const attention = useAttentionValue();
  const strip = useMemo(() => stripOf(attention.items), [attention.items]);
  const rollup = useMemo(() => rollupByFolder(attention.items), [attention.items]);
  const titles = attentionPrefsOf(prefs).workspaceTitles;

  const roving = useRovingFocus<HTMLDivElement>({ preferredId: selected === '' ? null : `session:${selected}` });
  const { containerRef: rovingRef, focusTabStop } = roving;
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      rovingRef(element);
    },
    [rovingRef],
  );

  useShortcut(
    '/',
    () => {
      filterRef.current?.focus();
    },
    { description: t('filters.focusSearch'), enabled: present && shown },
  );

  const closeEvent = useEffectEvent((returnFocus: boolean): void => {
    onClose?.();
    if (returnFocus) returnFocusRef?.current?.focus();
  });
  const focusInside = useEffectEvent((): void => {
    if (!focusTabStop()) filterRef.current?.focus();
  });

  // Opening the overlay moves the focus into it: the selected row, else the first entry, else the filter.
  useEffect(() => {
    if (dialog) focusInside();
  }, [dialog]);

  // Escape and the Tab trap are native listeners on the dialog (as in the sheet of the sidebar): the panel is a container, not a
  // control. A typed filter is cleared by the first Escape (the field does that), and the overlay closes on the second.
  useEffect(() => {
    const element = rootRef.current;
    if (!dialog || element === null) return undefined;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (element === null) return;
      if (event.key === 'Escape') {
        if (event.target instanceof HTMLInputElement && event.target.value !== '') return;
        event.preventDefault();
        event.stopPropagation();
        closeEvent(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const order = tabOrderIn(element);
      const active = document.activeElement;
      const first = order[0];
      const last = order[order.length - 1];
      if (first === undefined || last === undefined || active === null) return;
      const before = (a: Element, b: Element): boolean =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const hasNext = order.some((candidate) => candidate !== active && before(active, candidate));
      const hasPrevious = order.some((candidate) => candidate !== active && before(candidate, active));
      if (!event.shiftKey && !hasNext) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && !hasPrevious) {
        event.preventDefault();
        last.focus();
      }
    }
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [dialog]);

  // A press outside the overlay closes it, except on the button that opens it and inside a modal dialog that the list opened.
  useEffect(() => {
    if (!dialog) return undefined;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      if (rootRef.current?.contains(target) === true) return;
      if (returnFocusRef?.current?.contains(target) === true) return;
      if (target.closest('dialog[open]') !== null) return;
      closeEvent(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [dialog, returnFocusRef]);

  if (!present) return null;

  const toggleFolder = (folder: FolderModel, next: boolean): void => {
    setPref('workspaceOpen', { ...(prefs.workspaceOpen ?? NO_OPEN), [folderPrefKey(folder.key)]: next });
  };
  const startIn = (folder: FolderModel): void => {
    if (folder.path === null) return;
    onNewSession({ name: folder.name, path: folder.path, known: knownKeys.has(folder.key) });
  };
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && filter !== '') {
      event.preventDefault();
      event.stopPropagation();
      setFilter('');
    } else if (event.key === 'ArrowDown' && focusTabStop()) {
      event.preventDefault();
    }
  };

  const loading = foldersData === undefined && !folders.isError;
  const failure = foldersData === undefined && folders.isError ? folders.error : null;
  const empty =
    foldersData !== undefined && view.rows.length === 0 && view.hiddenByFilter === 0 && filter.trim() === '';
  const refreshFailing = foldersData !== undefined && (folders.isError || terminal.isError);
  const degraded = foldersData === undefined ? [] : degradedSources(foldersData.sources);
  const hasFolderList = !loading && failure === null && !empty && view.rows.length > 0;
  const onNavigate = dialog ? onClose : undefined;

  let list;
  if (loading) {
    list = <Skeleton rows={6} variant="list" label={t('workspace.loading')} />;
  } else if (failure !== null) {
    list = (
      <ErrorState
        kind="load"
        size="inline"
        subjectKey="error.subject.workspace"
        error={failure}
        onRetry={() => {
          void folders.refetch();
        }}
      />
    );
  } else if (empty) {
    list = (
      <EmptyState
        title={t('workspace.empty.title')}
        primary={{ label: t('workspace.otherFolder'), onClick: onOtherFolder }}
      >
        <p>{t('workspace.empty.body')}</p>
      </EmptyState>
    );
  } else if (view.rows.length === 0) {
    list = <p className="muted small workspace-sidebar__none">{t('workspace.filter.empty')}</p>;
  } else {
    list = (
      <ul className="plain workspace-sidebar__folders" id={listId}>
        {view.rows.map((row) => (
          <FolderRow
            key={row.folder.key}
            model={row}
            liveAll={sessions}
            attention={rollup.get(row.folder.key)}
            titles={titles}
            onToggle={(next) => {
              toggleFolder(row.folder, next);
            }}
            onNewSession={startIn}
            onResume={onResume}
            {...(onNavigate === undefined ? {} : { onNavigate })}
          />
        ))}
      </ul>
    );
  }

  return (
    <div
      ref={setRoot}
      className="workspace-sidebar"
      role={dialog ? 'dialog' : undefined}
      aria-label={dialog ? t('workspace.sidebar.label') : undefined}
      hidden={!shown}
      data-overlay={overlay ? 'true' : 'false'}
      data-open={dialog ? 'true' : 'false'}
    >
      <nav
        id={PROJECT_LIST_ID}
        className="workspace-sidebar__nav"
        aria-label={t('workspace.sidebar.label')}
        tabIndex={-1}
      >
        <h2 className="workspace-sidebar__heading">{t('workspace.sidebar.heading')}</h2>
        {/* nothing while the terminals are still loading: the strip never flashes in front of an unknown list */}
        {terminal.data === undefined ? null : (
          <NeedsYouStrip model={strip} titles={titles} onMarkSeen={attention.markSeen} onNavigate={onNavigate} />
        )}
        <input
          ref={filterRef}
          type="search"
          className="input workspace-sidebar__filter"
          aria-label={t('workspace.filter.label')}
          aria-controls={hasFolderList ? listId : undefined}
          placeholder={t('workspace.filter.placeholder')}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          onKeyDown={onFilterKeyDown}
        />
        <div className="workspace-sidebar__status">
          {foldersData === undefined ? null : (
            <StaleDataIndicator
              asOf={folders.dataUpdatedAt === 0 ? null : folders.dataUpdatedAt}
              fetchFailing={refreshFailing}
              scope={t('workspace.scope')}
            />
          )}
          {degraded.length === 0 ? null : (
            <p className="muted small workspace-sidebar__degraded" title={degraded.join(', ')}>
              {t('workspace.sources.degraded')}
            </p>
          )}
        </div>
        <div className="workspace-sidebar__list" aria-busy={loading ? 'true' : 'false'}>
          {list}
        </div>
        <div className="workspace-sidebar__foot">
          {empty ? null : (
            <Button variant="quiet" data-nav-item="" data-nav-id="other-folder" onClick={onOtherFolder}>
              {t('workspace.otherFolder')}
            </Button>
          )}
          <ul className="plain workspace-legend" aria-label={t('workspace.legend.label')}>
            {(['full', 'half', 'none'] as const).map((level) => (
              <li key={level} className="workspace-legend__item">
                <span className="workspace-mark" data-level={level} aria-hidden="true" />
                <span>{t(`workspace.legend.${level}`)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small workspace-sidebar__note">{t('workspace.footer.endsWithApp')}</p>
        </div>
      </nav>
    </div>
  );
}
