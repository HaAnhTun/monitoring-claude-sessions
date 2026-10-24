import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { Button } from '../components/Button.tsx';
import { useT } from '../i18n/context.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { MQ_RAIL, MQ_SHEET, useMediaQuery } from '../state/use-media-query.ts';
import { SessionSwitcher, useShowSwitcher } from './SessionSwitcher.tsx';
import { ConnectedSidebarNav } from './SidebarNav.tsx';

export const SIDEBAR_ID = 'sidebar';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.closest('[hidden]') === null,
  );
}

/**
 * The navigation of the shell in three layouts (ADR 0071 decision 6, ADR 0073 decision 4). The widths are CSS media queries:
 * a 240 px sidebar from 1200 px, a 56 px rail of icons from 900 px (labels move into tooltips, counts become dots), and below
 * 900 px a one-line Menu bar under the top bar that opens the navigation as a sheet. The sheet is a modal dialog: it takes the
 * focus, keeps it inside, closes on Escape, on a click outside and after a navigation, and gives the focus back to the Menu button.
 * Its state is the `navOpen` preference. The session switcher shows in the full sidebar on the session page only.
 */
export function Sidebar() {
  const t = useT();
  const sheet = useMediaQuery(MQ_SHEET);
  const rail = useMediaQuery(MQ_RAIL) && !sheet;
  const switcher = useShowSwitcher();
  const { prefs, setPref } = usePrefs();
  const { pathname } = useLocation();
  const open = sheet && (prefs.navOpen ?? false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const lastPathname = useRef(pathname);

  const close = useCallback(
    (returnFocus: boolean) => {
      setPref('navOpen', false);
      if (returnFocus) menuButton.current?.focus();
    },
    [setPref],
  );

  // A sheet that was left open must not come back open at a wider window.
  useEffect(() => {
    if (!sheet && prefs.navOpen === true) setPref('navOpen', false);
  }, [sheet, prefs.navOpen, setPref]);

  // A navigation closes the sheet; the focus goes to the new page (usePageChrome), not back to the button.
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    if (open) close(false);
  }, [pathname, open, close]);

  // Opening moves the focus into the sheet: the current page, or the first entry.
  useEffect(() => {
    if (!open || panel.current === null) return;
    const current = panel.current.querySelector<HTMLElement>('[aria-current="page"]');
    (current ?? focusableIn(panel.current)[0])?.focus();
  }, [open]);

  // Escape and the Tab trap are a native listener on the dialog: the panel is a landmark-like container, not a control, and a
  // React handler on it would be a keyboard handler on a non-interactive element.
  useEffect(() => {
    const element = panel.current;
    if (!open || element === null) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key !== 'Tab' || element === null) return;
      const items = focusableIn(element);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const navigation = <ConnectedSidebarNav tooltips={rail} />;

  if (!sheet) {
    return (
      <aside
        id={SIDEBAR_ID}
        className="sidebar"
        aria-label={t('shell.sidebar.label')}
        data-mode={rail ? 'rail' : 'full'}
      >
        <div className="sidebar__inner">
          {navigation}
          {switcher ? <SessionSwitcher /> : null}
        </div>
      </aside>
    );
  }

  return (
    <>
      <div className="sidebar-menubar">
        <Button
          ref={menuButton}
          icon="menu"
          aria-expanded={open}
          aria-controls={SIDEBAR_ID}
          onClick={() => {
            if (open) close(true);
            else setPref('navOpen', true);
          }}
        >
          {t('shell.menu.open')}
        </Button>
      </div>
      {open ? (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => {
            close(true);
          }}
        />
      ) : null}
      <div
        id={SIDEBAR_ID}
        ref={panel}
        className="sidebar"
        data-mode="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.menu.title')}
        hidden={!open}
      >
        <div className="sidebar__sheet-head">
          <span className="sidebar__sheet-title">{t('shell.menu.title')}</span>
          <Button
            variant="icon"
            icon="x"
            aria-label={t('shell.menu.close')}
            onClick={() => {
              close(true);
            }}
          />
        </div>
        <div className="sidebar__inner">{navigation}</div>
      </div>
    </>
  );
}
