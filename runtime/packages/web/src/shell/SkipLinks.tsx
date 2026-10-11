import type { MouseEvent } from 'react';

import { usePrefs } from '../state/prefs-store.ts';

export const MAIN_ID = 'main';
export const SESSION_LIST_ID = 'session-list';

/**
 * "Skip to main content" and "Skip to session list" (04-ui.md 6.6 rule 2). The handler focuses the target and prevents the
 * default navigation, so the URL and the router state stay as they are (legacy kept the `#sid` hash).
 */
export function SkipLinks() {
  const { prefs, setPref } = usePrefs();

  function skipTo(id: string) {
    return (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      const target = document.getElementById(id);
      if (target === null) return;
      target.focus();
      // In the narrow layout the session list is hidden while the menu is closed and cannot take focus: open it and retry.
      if (document.activeElement !== target && id === SESSION_LIST_ID && prefs.navOpen !== true) {
        setPref('navOpen', true);
        requestAnimationFrame(() => {
          document.getElementById(id)?.focus();
        });
      }
    };
  }

  return (
    <div className="skip-links">
      <a className="skip-links__link" href="#main" onClick={skipTo(MAIN_ID)}>
        Skip to main content
      </a>
      <a className="skip-links__link" href="#session-list" onClick={skipTo(SESSION_LIST_ID)}>
        Skip to session list
      </a>
    </div>
  );
}
