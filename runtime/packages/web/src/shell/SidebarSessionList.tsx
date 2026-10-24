import type { AgentNode, SessionSummary } from '@mcs/shared';
import { useEffect, useLayoutEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { Button } from '../components/Button.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StateBadge } from '../components/StateBadge.tsx';
import { useAgents } from '../data/hooks/useAgents.ts';
import { useInstance } from '../data/hooks/useInstance.ts';
import { useSidebarSessions } from '../data/hooks/useSessions.ts';
import { useT } from '../i18n/context.ts';
import {
  AGENT_PAGE,
  buildSessionView,
  groupAgents,
  LAZY_AGENT_THRESHOLD,
  type AgentGroup,
  type SessionViewEntry,
} from '../lib/sessions-view.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { SESSION_LIST_ID } from './SkipLinks.tsx';

const FILTER_MAX = 400;

interface AgentFeed {
  sessionId: string;
  agents: readonly AgentNode[];
}

/**
 * Loads the agents of the open session and reports them upward. A separate component, because hooks cannot be conditional and
 * the list itself must not remount when the first session is opened (it would lose the focus of the row that was activated).
 */
function OpenSessionAgents({ sessionId, onFeed }: { sessionId: string; onFeed: (feed: AgentFeed) => void }) {
  const agents = useAgents(sessionId);
  const data = agents.query.data;
  useEffect(() => {
    onFeed({ sessionId, agents: data === undefined ? [] : data.pages.flatMap((page) => page.items) });
  }, [sessionId, data, onFeed]);
  return null;
}

const sessionKey = (id: string): string => `${id}|`;
const agentKey = (sessionId: string, agentId: string): string => `${sessionId}|${agentId}`;

function sessionHref(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

function agentHref(sessionId: string, agentId: string): string {
  return `${sessionHref(sessionId)}?agent=${encodeURIComponent(agentId)}`;
}

function rowKeys(entries: readonly SessionViewEntry<SessionSummary, AgentNode>[]): string[] {
  return entries.flatMap((entry) => [
    sessionKey(entry.s.id),
    ...entry.agents.map((agent) => agentKey(entry.s.id, agent.id)),
  ]);
}

interface RowHandlers {
  onFocus: FocusEventHandler<HTMLAnchorElement>;
  onBlur: FocusEventHandler<HTMLAnchorElement>;
  onKeyDown: KeyboardEventHandler<HTMLAnchorElement>;
}

interface AgentRowsProps {
  sessionId: string;
  groups: AgentGroup<AgentNode>[];
  total: number;
  currentAgent: string | null;
  tabStopKey: string;
  handlers: RowHandlers;
}

/** Agent sub-rows of the open session: collapsed behind a button above 30, shown 100 at a time (04 4.4). */
function AgentRows({ sessionId, groups, total, currentAgent, tabStopKey, handlers }: AgentRowsProps) {
  const [view, setView] = useState<{ sessionId: string; shown: number } | null>(null);
  const collapsed = total > LAZY_AGENT_THRESHOLD && view?.sessionId !== sessionId;
  if (collapsed) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setView({ sessionId, shown: AGENT_PAGE });
        }}
      >
        {`Show ${String(total)} agents`}
      </Button>
    );
  }
  const shown = view?.sessionId === sessionId ? view.shown : AGENT_PAGE;
  const visible: { group: AgentGroup<AgentNode>; agents: AgentNode[] }[] = [];
  let remaining = shown;
  for (const group of groups) {
    const agents = group.agents.slice(0, Math.max(0, remaining));
    remaining -= agents.length;
    visible.push({ group, agents });
  }
  const hidden = Math.max(0, total - shown);
  return (
    <div className="sidebar-agents">
      {visible.map(({ group, agents }) =>
        agents.length === 0 ? null : (
          <div key={group.key === '' ? 'subagents' : group.key} className="sidebar-agents__group">
            <p className="sidebar-agents__title small muted">
              {group.title} ({group.summary})
            </p>
            <ul className="plain">
              {agents.map((agent) => {
                const key = agentKey(sessionId, agent.id);
                return (
                  <li key={agent.id}>
                    <Link
                      to={agentHref(sessionId, agent.id)}
                      className="sidebar-row sidebar-row--agent"
                      data-key={key}
                      tabIndex={key === tabStopKey ? 0 : -1}
                      aria-current={currentAgent === agent.id ? 'page' : undefined}
                      {...handlers}
                    >
                      <StateBadge state={agent.state.state} size="sm" />
                      <span className="sidebar-row__label">{agent.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ),
      )}
      {hidden > 0 ? (
        <Button
          variant="quiet"
          onClick={() => {
            setView({ sessionId, shown: shown + AGENT_PAGE });
          }}
        >
          {`Show ${String(Math.min(AGENT_PAGE, hidden))} more`}
        </Button>
      ) : null}
    </div>
  );
}

function EmptyCauses({ windowHours }: { windowHours: number | undefined }) {
  return (
    <EmptyState title="No sessions to show" icon="info">
      <p className="small">The monitor is running but returned no sessions. Likely causes:</p>
      <ul className="small">
        <li>
          No session has been imported yet, or the Claude Code transcripts folder of this repository was not found.
        </li>
        <li>No session rule matched any session. Tick &quot;Show unmatched sessions&quot; to list everything.</li>
        <li>
          Only sessions written to in the last {windowHours === undefined ? 'N' : String(windowHours)} hours are listed;
          older ones are hidden.
        </li>
      </ul>
    </EmptyState>
  );
}

/**
 * The live session list of the sidebar (04-ui.md 4.4): filter, groups in the legacy order, one tab stop with arrow-key
 * navigation (roving tabindex), focus kept by `data-key` across re-renders.
 */
export function SidebarSessionList() {
  const t = useT();
  const { prefs, setPref } = usePrefs();
  const showAll = prefs.showAll ?? false;
  const filter = prefs.filter ?? '';
  const instance = useInstance().data;
  const query = useSidebarSessions(showAll);
  const { sessionId: openId } = useParams();
  const [searchParams] = useSearchParams();
  const currentAgent = searchParams.get('agent');
  const [feed, setFeed] = useState<AgentFeed | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusKey = useRef<string | null>(null);

  const sessions = query.data?.items;
  const agentsOf = (s: SessionSummary): readonly AgentNode[] => (feed?.sessionId === s.id ? feed.agents : []);
  const groups = buildSessionView<SessionSummary, AgentNode>(sessions ?? [], filter, agentsOf);
  const keys = groups.flatMap((group) => rowKeys(group.entries));
  const openKey = openId === undefined ? null : sessionKey(openId);
  const tabStopKey =
    activeKey !== null && keys.includes(activeKey)
      ? activeKey
      : openKey !== null && keys.includes(openKey)
        ? openKey
        : (keys[0] ?? '');

  // Live updates never move focus (UI-I13). When a re-render replaced the focused row (it moved to another group), put the
  // focus back on the row with the same key; a focus that the user moved elsewhere is left alone.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const key = focusKey.current;
    if (container === null || key === null || container.contains(document.activeElement)) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    for (const row of container.querySelectorAll<HTMLElement>('[data-key]')) {
      if (row.dataset['key'] === key) {
        row.focus({ preventScroll: true });
        return;
      }
    }
  });

  const handlers: RowHandlers = {
    onFocus(event) {
      const key = event.currentTarget.dataset['key'];
      if (key === undefined) return;
      focusKey.current = key;
      setActiveKey(key);
    },
    onBlur(event) {
      const leaving = event.currentTarget;
      const container = containerRef.current;
      if (container === null || (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)))
        return;
      // A row that is gone from the document was replaced by a re-render; a row that is still there was left by the user.
      setTimeout(() => {
        if (leaving.isConnected) focusKey.current = null;
      }, 0);
    },
    onKeyDown(event) {
      const container = containerRef.current;
      if (container === null) return;
      const rows = [...container.querySelectorAll<HTMLElement>('[data-key]')];
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
  const noSessions = sessions?.length === 0;

  let body;
  if (loading) body = <p className="muted small">Loading sessions...</p>;
  else if (failure !== null)
    body = (
      <ErrorState
        kind="load"
        size="inline"
        subject="sessions"
        error={failure}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  else if (noSessions) body = <EmptyCauses windowHours={instance?.windowHours} />;
  else if (groups.length === 0) body = <p className="muted small">No session matches this filter.</p>;
  else
    body = groups.map((group) => (
      <section key={group.id} aria-labelledby={`sidebar-group-${group.id}`} className="sidebar-group">
        <div className="sidebar-group__head">
          <h3 id={`sidebar-group-${group.id}`}>{t(group.titleKey)}</h3>
          <span className="muted small">({group.entries.length})</span>
        </div>
        <ul className="plain">
          {group.entries.map(({ s, agents }) => {
            const key = sessionKey(s.id);
            const tip = s.state.evidence.map((item) => item.text).join('; ');
            return (
              <li key={s.id}>
                <Link
                  to={sessionHref(s.id)}
                  className="sidebar-row"
                  data-key={key}
                  tabIndex={key === tabStopKey ? 0 : -1}
                  aria-current={openId === s.id && currentAgent === null ? 'page' : undefined}
                  {...handlers}
                >
                  <StateBadge state={s.state.state} size="sm" {...(tip === '' ? {} : { evidenceTip: tip })} />
                  <span className="sidebar-row__label">{s.label}</span>
                </Link>
                {agents.length === 0 ? null : (
                  <AgentRows
                    sessionId={s.id}
                    groups={groupAgents(agents)}
                    total={agents.length}
                    currentAgent={currentAgent}
                    tabStopKey={tabStopKey}
                    handlers={handlers}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>
    ));

  return (
    <div className="sidebar-list">
      <form
        role="search"
        className="sidebar-list__filter"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="sr-only" htmlFor="sidebar-filter">
          Filter sessions
        </label>
        <input
          id="sidebar-filter"
          className="input"
          type="search"
          placeholder="Filter sessions"
          autoComplete="off"
          maxLength={FILTER_MAX}
          value={filter}
          onChange={(event) => {
            setPref('filter', event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter !== '') {
              event.preventDefault();
              setPref('filter', '');
            }
          }}
        />
        <label className="check small">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => {
              setPref('showAll', event.target.checked);
            }}
          />
          <span>Show unmatched sessions</span>
        </label>
      </form>
      {openId === undefined ? null : <OpenSessionAgents key={openId} sessionId={openId} onFeed={setFeed} />}
      <div
        id={SESSION_LIST_ID}
        data-testid="session-list"
        ref={containerRef}
        tabIndex={-1}
        aria-busy={loading ? 'true' : 'false'}
        className="sidebar-list__rows"
      >
        {body}
      </div>
      <Link to="/sessions" className="small">
        All sessions
      </Link>
    </div>
  );
}
