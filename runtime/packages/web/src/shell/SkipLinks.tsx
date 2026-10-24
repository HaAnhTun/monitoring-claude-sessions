import type { MouseEvent } from 'react';

import { useT } from '../i18n/context.ts';
import { SESSION_LIST_ID, useShowSwitcher } from './SessionSwitcher.tsx';

export const MAIN_ID = 'main';
export { SESSION_LIST_ID };

/**
 * "Skip to main content", and on the session page "Skip to session switcher" while the switcher is on screen (04-ui.md 6.6 rule 2).
 * The handler focuses the target and prevents the default navigation, so the URL and the router state stay as they are.
 */
export function SkipLinks() {
  const t = useT();
  const hasSwitcher = useShowSwitcher();

  function skipTo(id: string) {
    return (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      document.getElementById(id)?.focus();
    };
  }

  // The hrefs are literals (the lint rule forbids computed ones): they must equal MAIN_ID and SESSION_LIST_ID, and the shell tests
  // follow the links to the elements with those ids.
  return (
    <div className="skip-links">
      <a className="skip-links__link" href="#main" onClick={skipTo(MAIN_ID)}>
        {t('shell.skip.main')}
      </a>
      {hasSwitcher ? (
        <a className="skip-links__link" href="#session-list" onClick={skipTo(SESSION_LIST_ID)}>
          {t('shell.skip.switcher')}
        </a>
      ) : null}
    </div>
  );
}
