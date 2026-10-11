import { ENTRY_KINDS, type EntryKind, type EventCategory } from '@mcs/shared';
import { useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { ErrorState } from '../../components/ErrorState.tsx';
import { useUrlState } from '../../components/FilterBar.tsx';
import { Icon } from '../../components/Icon.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { useAgents } from '../../data/hooks/useAgents.ts';
import { ApiContext, InstanceIdContext } from '../../data/hooks/useInstance.ts';
import { useSession } from '../../data/hooks/useSession.ts';
import { formatUrlState, sessionDetailSpec } from '../../lib/url-state.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { TranscriptViewer } from '../../transcript/TranscriptViewer.tsx';
import { AgentTree } from './AgentTree.tsx';
import { SessionErrors } from './SessionErrors.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { SessionTabs, TAB_PANEL_ID, tabId } from './SessionTabs.tsx';
import { SessionTimeline } from './SessionTimeline.tsx';
import { SessionTokens } from './SessionTokens.tsx';

const DEFAULT_TITLE = 'Session';
const MAIN_AGENT = 'main';

function isNotFound(error: Error | null): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.info.code === 'session_not_found' || (error.info.status === 404 && error.info.code === 'route_not_found')
  );
}

function Unavailable({ sessionId }: { sessionId: string | undefined }) {
  const headingRef = usePageChrome(DEFAULT_TITLE);
  return (
    <section className="page detail">
      <h1 ref={headingRef} tabIndex={-1}>
        {DEFAULT_TITLE}
      </h1>
      {sessionId === undefined ? null : (
        <p className="mono" data-testid="route-param">
          {sessionId}
        </p>
      )}
      <p className="muted">Waiting for the connection to the monitor.</p>
    </section>
  );
}

function kindsRecord(kinds: readonly EntryKind[]): Record<EntryKind, boolean> {
  return {
    prompt: kinds.includes('prompt'),
    say: kinds.includes('say'),
    think: kinds.includes('think'),
    tool: kinds.includes('tool'),
    result: kinds.includes('result'),
  };
}

function Detail({ sessionId }: { sessionId: string }) {
  const [state, setState] = useUrlState(sessionDetailSpec);
  const session = useSession(sessionId);
  const agents = useAgents(sessionId);
  const { prefs, setPref } = usePrefs();
  const showToast = useShowToast();
  const detail = session.data;
  const headingRef = usePageChrome(detail?.label ?? DEFAULT_TITLE);

  const agentId = state.agent === '' || state.agent === MAIN_AGENT ? null : state.agent;
  const agent = agentId === null ? null : (agents.items.find((candidate) => candidate.id === agentId) ?? null);
  const agentsComplete = agents.query.data !== undefined && !agents.query.hasNextPage;
  const agentMissing = agentId !== null && agent === null && agentsComplete;

  const defaultKinds = useMemo(
    () => (state.kinds.length > 0 ? kindsRecord(state.kinds) : prefs.kinds),
    [state.kinds, prefs.kinds],
  );
  const onKindsChange = useCallback(
    (kinds: Readonly<Record<EntryKind, boolean>>) => {
      setPref('kinds', { ...kinds });
      setState({ kinds: ENTRY_KINDS.filter((kind) => kinds[kind]) });
    },
    [setPref, setState],
  );
  const onNewestFirstChange = useCallback(
    (newestFirst: boolean) => {
      setPref('newestFirst', newestFirst);
    },
    [setPref],
  );
  const onInitialIndexDone = useCallback(() => {
    setState({ i: null });
  }, [setState]);
  const onTypesChange = useCallback(
    (types: EventCategory[]) => {
      setState({ types });
    },
    [setState],
  );

  if (detail === undefined) {
    return (
      <section className="page detail">
        <h1 ref={headingRef} tabIndex={-1}>
          {DEFAULT_TITLE}
        </h1>
        {session.isError ? (
          isNotFound(session.error) ? (
            <ErrorState kind="not-found">
              <Link to="/sessions">Back to sessions</Link>
            </ErrorState>
          ) : (
            <ErrorState
              kind={session.error instanceof ApiError && session.error.info.kind === 'contract' ? 'contract' : 'load'}
              subject="session"
              error={session.error}
              onRetry={() => {
                void session.refetch();
              }}
            />
          )
        ) : (
          <Skeleton variant="text" rows={4} label="Loading session" />
        )}
      </section>
    );
  }

  let panel: ReactNode;
  switch (state.tab) {
    case 'transcript':
      panel = (
        <TranscriptViewer
          key={`${sessionId}|${agentId ?? MAIN_AGENT}`}
          sessionId={sessionId}
          agentId={agentId}
          {...(prefs.newestFirst === undefined ? {} : { newestFirst: prefs.newestFirst })}
          onNewestFirstChange={onNewestFirstChange}
          defaultKinds={defaultKinds ?? {}}
          onKindsChange={onKindsChange}
          initialIndex={state.i}
          onInitialIndexDone={onInitialIndexDone}
          onNotice={showToast}
        />
      );
      break;
    case 'timeline':
      panel = (
        <SessionTimeline
          sessionId={sessionId}
          agentId={agentId}
          types={state.types}
          onTypesChange={onTypesChange}
          hooksEnabled={detail.sources.hooks}
        />
      );
      break;
    case 'agents':
      panel =
        agents.query.data === undefined ? (
          agents.query.isError ? (
            <ErrorState
              kind="load"
              subject="agents"
              error={agents.query.error}
              onRetry={() => {
                void agents.query.refetch();
              }}
            />
          ) : (
            <Skeleton variant="list" rows={4} label="Loading agents" />
          )
        ) : (
          <>
            <AgentTree sessionId={sessionId} agents={agents.items} selectedAgentId={agentId} />
            <LoadMore
              hasMore={agents.query.hasNextPage}
              loading={agents.query.isFetchingNextPage}
              onLoad={() => {
                void agents.query.fetchNextPage();
              }}
              shown={agents.items.length}
              total={null}
              noun="agents"
              capped={agents.capped}
              pageSize={500}
            />
          </>
        );
      break;
    case 'tokens':
      panel = <SessionTokens session={detail} agents={agents.items} />;
      break;
    case 'errors':
      panel = <SessionErrors sessionId={sessionId} agentId={agentId} />;
      break;
  }

  const refreshFailing = session.isError;
  const mainSearch = formatUrlState(sessionDetailSpec, { ...state, agent: '' }).toString();
  const mainAgentLink = `/sessions/${sessionId}${mainSearch === '' ? '' : `?${mainSearch}`}`;
  return (
    <section className="page detail">
      <SessionHeader session={detail} agent={agent} headingRef={headingRef}>
        {refreshFailing ? (
          <ErrorState
            kind="refresh"
            size="inline"
            subject="session"
            error={session.error}
            lastGoodAt={session.dataUpdatedAt}
            onRetry={() => {
              void session.refetch();
            }}
          />
        ) : null}
        {agentMissing ? (
          <p className="detail__banner" role="status">
            <Icon name="alert" />
            <span>{`Agent ${state.agent} is not part of this session`}</span>
            <Link to={mainAgentLink}>Open the main agent</Link>
          </p>
        ) : null}
      </SessionHeader>
      <SessionTabs active={state.tab} agent={state.agent} issueCount={detail.errorCount + detail.warningCount} />
      <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={tabId(state.tab)} className="detail__panel">
        {panel}
      </div>
    </section>
  );
}

/**
 * `/sessions/:sessionId`: the header with the evidence for the state, and the transcript, timeline, agents, tokens and
 * errors tabs (04 4.4). The tab, the agent and the transcript filters live in the address. Until the app providers are
 * mounted it shows only its heading, so the route never crashes the shell.
 */
export function SessionDetailPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  const { sessionId } = useParams();
  if (api === null || instanceId === null || sessionId === undefined) return <Unavailable sessionId={sessionId} />;
  return <Detail sessionId={sessionId} />;
}
