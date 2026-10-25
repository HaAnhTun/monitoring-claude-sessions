import { Link } from 'react-router';

import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { DETAIL_TABS, formatUrlState, parseUrlState, sessionDetailSpec, type DetailTab } from '../../lib/url-state.ts';

export interface SessionTabsProps {
  active: DetailTab;
  /** The chosen agent ('' is the main agent); a tab change keeps it. */
  agent: string;
  /** Errors and warnings of the session, shown as a count on the Errors tab. */
  issueCount?: number;
}

const LABEL_KEYS = {
  transcript: 'detail.tab.transcript',
  errors: 'detail.tab.errors',
  agents: 'detail.tab.agents',
  tokens: 'detail.tab.tokens',
  events: 'detail.tab.events',
} as const satisfies Readonly<Record<DetailTab, MessageKey>>;

const DEFAULTS = parseUrlState(sessionDetailSpec, new URLSearchParams()).value;

/** The address of a tab: only the tab and the agent are carried over, filters belong to the tab they were set on. */
function tabSearch(tab: DetailTab, agent: string): string {
  return `?${formatUrlState(sessionDetailSpec, { ...DEFAULTS, tab, agent }).toString()}`;
}

/**
 * The views of the session page as a navigation landmark of links (ADR 0073 decision 8, review R-19): the chosen view has
 * `aria-current="page"`, every link is one Tab stop and no arrow keys are needed. Choosing a view adds a history entry (`?tab=`).
 * The bar stays at the top of the window while the page scrolls.
 */
export function SessionTabs({ active, agent, issueCount = 0 }: SessionTabsProps) {
  const t = useT();
  return (
    <nav className="session-tabs" aria-label={t('detail.tabs.label')}>
      {DETAIL_TABS.map((tab) => (
        <Link
          key={tab}
          className="session-tabs__tab"
          aria-current={tab === active ? 'page' : undefined}
          to={{ search: tabSearch(tab, agent) }}
        >
          {t(LABEL_KEYS[tab])}
          {tab === 'errors' && issueCount > 0 ? (
            <>
              <span className="session-tabs__count" aria-hidden="true">
                {issueCount}
              </span>
              <span className="sr-only"> {t('detail.tab.issues', { count: issueCount })}</span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
