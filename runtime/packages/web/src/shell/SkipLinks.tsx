import type { MouseEvent } from 'react';

import { useRouteLayout } from '../app/routes.tsx';
import { useT } from '../i18n/context.ts';
import { SESSION_LIST_ID, useShowSwitcher } from './SessionSwitcher.tsx';

export const MAIN_ID = 'main';
/** The ids the Workspace page gives its project list and its terminal (`PROJECT_LIST_ID`, the terminal view root). */
const PROJECT_LIST_TARGET = 'project-list';
const TERMINAL_TARGET = 'terminal';
export { SESSION_LIST_ID };

/**
 * "Skip to main content", on the session page "Skip to session switcher" while the switcher is on screen (04-ui.md 6.6 rule 2), and
 * on a bleed route (the Workspace) "Skip to project list" and "Skip to terminal" (design 04 2.3). The handler focuses the target
 * (the main region when the target is not on the page: a locked or empty Workspace) and prevents the default navigation, so the
 * URL and the router state stay as they are.
 */
export function SkipLinks() {
  const t = useT();
  const hasSwitcher = useShowSwitcher();
  const bleed = useRouteLayout() === 'bleed';

  function skipTo(id: string) {
    return (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      (document.getElementById(id) ?? document.getElementById(MAIN_ID))?.focus();
    };
  }

  // The hrefs are literals (the lint rule forbids computed ones): they must equal MAIN_ID, SESSION_LIST_ID, PROJECT_LIST_TARGET and
  // TERMINAL_TARGET, and the shell tests follow the links to the elements with those ids.
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
      {bleed ? (
        <>
          <a className="skip-links__link" href="#project-list" onClick={skipTo(PROJECT_LIST_TARGET)}>
            {t('shell.skip.projects')}
          </a>
          <a className="skip-links__link" href="#terminal" onClick={skipTo(TERMINAL_TARGET)}>
            {t('shell.skip.terminal')}
          </a>
        </>
      ) : null}
    </div>
  );
}
