import type { SessionSummary } from '@mcs/shared';
import { useLayoutEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler } from 'react';
import { Link, useMatch } from 'react-router';

import { ErrorState } from '../components/ErrorState.tsx';
import { useSidebarSessions } from '../data/hooks/useSessions.ts';
import { useT } from '../i18n/context.ts';
import { lifecycleDisplay } from '../lib/lifecycle-display.ts';
import { switcherView } from '../lib/sessions-view.ts';
import { MQ_RAIL, useMediaQuery } from '../state/use-media-query.ts';

/** The id of the focusable list of the switcher: the target of its skip link. */
export const SESSION_LIST_ID = 'session-list';

/** The route of one session; the switcher lives on it and nowhere else. */
const DETAIL_PATTERN = '/sessions/:sessionId';

/** The id of the open session, or null when the page is not the session page. */
function useOpenSessionId(): string | null {
  return useMatch(DETAIL_PATTERN)?.params.sessionId ?? null;
}

/**
 * Whether the sidebar shows the switcher: on the session page, and only while the sidebar is a full column (from 1200 px; the rail
 * and the sheet have no room for a list). The skip link to it uses the same answer, so it never points at nothing.
 */
export function useShowSwitcher(): boolean {
  const onDetail = useOpenSessionId() !== null;
  const narrow = useMediaQuery(MQ_RAIL);
  return onDetail && !narrow;
}

const SWITCHER_HEADING_ID = 'switcher-heading';

const sessionHref = (id: string): string => `/sessions/${encodeURIComponent(id)}`;

interface RowHandlers {
  onFocus: FocusEventHandler<HTMLAnchorElement>;
  onBlur: FocusEventHandler<HTMLAnchorElement>;
  onKeyDown: KeyboardEventHandler<HTMLAnchorElement>;
}

function SwitcherBody({ openId }: { openId: string }) {
  const t = useT();
  const query = useSidebarSessions(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusId = useRef<string | null>(null);

  const sessions = query.data?.items;
  const view = switcherView(sessions ?? [], undefined, openId);
  const ids = view.groups.flatMap((group) => group.sessions.map((s) => s.id));
  const tabStopId =
    activeId !== null && ids.includes(activeId) ? activeId : ids.includes(openId) ? openId : (ids[0] ?? '');

  // Live updates never move focus (UI-I13). When a re-render replaced the focused row (it moved to another group), put the
  // focus back on the row with the same id; a focus that the user moved elsewhere is left alone.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const id = focusId.current;
    if (container === null || id === null || container.contains(document.activeElement)) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    for (const row of container.querySelectorAll<HTMLElement>('[data-session-id]')) {
      if (row.dataset['sessionId'] === id) {
        row.focus({ preventScroll: true });
        return;
      }
    }
  });

  const handlers: RowHandlers = {
    onFocus(event) {
      const id = event.currentTarget.dataset['sessionId'];
      if (id === undefined) return;
      focusId.current = id;
      setActiveId(id);
    },
    onBlur(event) {
      const leaving = event.currentTarget;
      const container = containerRef.current;
      if (container === null || (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)))
        return;
      // A row that is gone from the document was replaced by a re-render; a row that is still there was left by the user.
      setTimeout(() => {
        if (leaving.isConnected) focusId.current = null;
      }, 0);
    },
    onKeyDown(event) {
      const container = containerRef.current;
      if (container === null) return;
      const rows = [...container.querySelectorAll<HTMLElement>('[data-session-id]')];
      const index = rows.indexOf(event.currentTarget);
      if (index === -1) return;
      let next: number;
      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(rows.length - 1, index + 1);
          break;
        case 'ArrowUp':
          next = Math.max(0, index - 1);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = rows.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      rows[next]?.focus();
    },
  };

  const failure = sessions === undefined && query.isError ? query.error : null;
  const loading = sessions === undefined && failure === null;

  let body;
  if (loading) body = <p className="muted small">{t('shell.switcher.loading')}</p>;
  else if (failure !== null)
    body = (
      <ErrorState
        kind="load"
        size="inline"
        subjectKey="error.subject.sessions"
        error={failure}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  else if (view.groups.length === 0) body = <p className="muted small">{t('shell.switcher.empty')}</p>;
  else
    body = (
      <>
        {view.groups.map((group) => (
          <section key={group.id} className="sidebar-switcher__group" data-group={group.id}>
            <p className="sidebar-switcher__title" id={`switcher-${group.id}`}>
              {t(group.titleKey)}
            </p>
            <ul className="plain" aria-labelledby={`switcher-${group.id}`}>
              {group.sessions.map((s: SessionSummary) => {
                const display = lifecycleDisplay(s.state.state);
                return (
                  <li key={s.id}>
                    <Link
                      to={sessionHref(s.id)}
                      className="sidebar-switcher__row"
                      data-session-id={s.id}
                      tabIndex={s.id === tabStopId ? 0 : -1}
                      aria-current={s.id === openId ? 'page' : undefined}
                      title={s.label}
                      {...handlers}
                    >
                      <span
                        className={`state-dot state-dot--${display.dot} ${display.toneClass}`}
                        aria-hidden="true"
                        data-state={display.state}
                      />
                      <span className="sidebar-switcher__label">{s.label}</span>
                      <span className="sr-only"> {t(display.labelKey)}</span>
                      {s.errorCount > 0 ? (
                        <span className="sidebar-switcher__errors">
                          {t('shell.switcher.errorCount', { count: s.errorCount })}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {view.hidden > 0 ? (
          <Link to="/sessions" className="sidebar-switcher__more small">
            {t('shell.switcher.more', { count: view.hidden })}
          </Link>
        ) : null}
      </>
    );

  return (
    <nav className="sidebar-switcher" aria-labelledby={SWITCHER_HEADING_ID}>
      <p className="sidebar-switcher__heading" id={SWITCHER_HEADING_ID}>
        {t('shell.switcher.label')}
      </p>
      <div
        id={SESSION_LIST_ID}
        data-testid="session-list"
        ref={containerRef}
        tabIndex={-1}
        aria-busy={loading ? 'true' : 'false'}
        className="sidebar-switcher__rows"
      >
        {body}
      </div>
    </nav>
  );
}

/**
 * The compact session list of the sidebar on the session page (ADR 0073 decision 4): sessions with errors first, then the active
 * ones, the open one marked with `aria-current`. No filter box. It loads the list only while it is on screen; on any other route it
 * renders nothing and asks for nothing. One tab stop with arrow-key navigation (roving tabindex), focus kept across live updates.
 */
export function SessionSwitcher() {
  const openId = useOpenSessionId();
  if (openId === null) return null;
  return <SwitcherBody openId={openId} />;
}
