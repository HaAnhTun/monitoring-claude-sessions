import { Link } from 'react-router';

import { DETAIL_TABS, formatUrlState, parseUrlState, sessionDetailSpec, type DetailTab } from '../../lib/url-state.ts';

export interface SessionTabsProps {
  active: DetailTab;
  /** The chosen agent ('' is the main agent); a tab change keeps it. */
  agent: string;
  /** Errors and warnings of the session, shown on the Errors tab. */
  issueCount?: number;
}

const LABELS: Readonly<Record<DetailTab, string>> = {
  transcript: 'Transcript',
  timeline: 'Timeline',
  agents: 'Agents',
  tokens: 'Tokens',
  errors: 'Errors',
};

const DEFAULTS = parseUrlState(sessionDetailSpec, new URLSearchParams()).value;

export function tabId(tab: DetailTab): string {
  return `detail-tab-${tab}`;
}

export const TAB_PANEL_ID = 'detail-tab-panel';

/** The address of a tab: only the tab and the agent are carried over, filters belong to the tab they were set on. */
function tabSearch(tab: DetailTab, agent: string): string {
  return `?${formatUrlState(sessionDetailSpec, { ...DEFAULTS, tab, agent }).toString()}`;
}

/** The tabs of the session page. Each tab is a router link, so choosing one adds a history entry (`?tab=`). */
export function SessionTabs({ active, agent, issueCount = 0 }: SessionTabsProps) {
  return (
    <div className="session-tabs" role="tablist" aria-label="Session views">
      {DETAIL_TABS.map((tab) => {
        const selected = tab === active;
        return (
          <Link
            key={tab}
            id={tabId(tab)}
            role="tab"
            aria-selected={selected}
            aria-controls={TAB_PANEL_ID}
            className={selected ? 'session-tabs__tab is-active' : 'session-tabs__tab'}
            to={{ search: tabSearch(tab, agent) }}
          >
            {LABELS[tab]}
            {tab === 'errors' && issueCount > 0 ? ` (${String(issueCount)})` : ''}
          </Link>
        );
      })}
    </div>
  );
}
