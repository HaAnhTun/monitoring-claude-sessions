import { ENTRY_KINDS, type AgentNode, type EntryKind, type EventCategory, type SessionDetail } from '@mcs/shared';
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
import { useT } from '../../i18n/context.ts';
import { formatUrlState, sessionDetailSpec } from '../../lib/url-state.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { TranscriptViewer } from '../../transcript/TranscriptViewer.tsx';
import { AgentTree } from './AgentTree.tsx';
import { SessionDetails } from './SessionDetails.tsx';
import { SessionErrors } from './SessionErrors.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { SessionStats, type SessionErrorSplit } from './SessionStats.tsx';
import { SessionTabs } from './SessionTabs.tsx';
import { SessionTimeline } from './SessionTimeline.tsx';
import { SessionTokens } from './SessionTokens.tsx';

const MAIN_AGENT = 'main';
const STAT_TILES = 4;

function isNotFound(error: Error | null): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.info.code === 'session_not_found' || (error.info.status === 404 && error.info.code === 'route_not_found')
  );
}

function Unavailable({ sessionId }: { sessionId: string | undefined }) {
  const t = useT();
  const title = t('route.sessionDetail.title');
  const headingRef = usePageChrome(title);
  return (
    <section className="page detail">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {sessionId === undefined ? null : (
        <p className="mono" data-testid="route-param">
          {sessionId}
        </p>
      )}
      <p className="muted">{t('detail.unavailable')}</p>
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

/**
 * The errors of the main agent against those of its subagents (ADR 0074 decision 6). Known only for the main agent once the agent
 * list holds it: a subagent's own count has no matching "rest" that is all subagents.
 */
function errorSplit(
  session: SessionDetail,
  agents: readonly AgentNode[],
  agentId: string | null,
): SessionErrorSplit | null {
  if (agentId !== null) return null;
  const main = agents.find((candidate) => candidate.kind === 'main' || candidate.id === MAIN_AGENT);
  if (main === undefined) return null;
  return { thisAgent: main.errorCount, subagents: Math.max(0, session.errorCount - main.errorCount) };
}

/** The frame of the first load: the shape of the header and its four tiles, so that nothing jumps when the session arrives. */
function LoadingFrame({ headingRef }: { headingRef: ReturnType<typeof usePageChrome> }) {
  const t = useT();
  return (
    <section className="page detail">
      <h1 ref={headingRef} tabIndex={-1} className="sr-only">
        {t('route.sessionDetail.title')}
      </h1>
      <div className="session-frame card" data-loading="true">
        <Skeleton variant="header" rows={1} label={t('detail.loading')} />
        <div aria-hidden="true">
          <Skeleton variant="tiles" rows={STAT_TILES} label={t('detail.loading')} />
        </div>
      </div>
    </section>
  );
}

function Detail({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [state, setState] = useUrlState(sessionDetailSpec);
  const session = useSession(sessionId);
  const agents = useAgents(sessionId);
  const { prefs, setPref } = usePrefs();
  const showToast = useShowToast();
  const detail = session.data;
  const headingRef = usePageChrome(detail?.label ?? t('route.sessionDetail.title'));

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
    if (!session.isError) return <LoadingFrame headingRef={headingRef} />;
    return (
      <section className="page detail">
        <h1 ref={headingRef} tabIndex={-1}>
          {t('route.sessionDetail.title')}
        </h1>
        {isNotFound(session.error) ? (
          <ErrorState kind="not-found">
            <Link to="/sessions">{t('detail.notFound.back')}</Link>
          </ErrorState>
        ) : (
          <ErrorState
            kind={session.error instanceof ApiError && session.error.info.kind === 'contract' ? 'contract' : 'load'}
            subjectKey="error.subject.session"
            error={session.error}
            onRetry={() => {
              void session.refetch();
            }}
          />
        )}
      </section>
    );
  }

  const split = errorSplit(detail, agents.items, agentId);
  const errorsHref = `/sessions/${encodeURIComponent(sessionId)}?tab=errors`;

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
          {...(split === null ? {} : { sessionErrors: { ...split, errorsTabHref: errorsHref } })}
        />
      );
      break;
    case 'events':
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
              subjectKey="error.subject.agents"
              error={agents.query.error}
              onRetry={() => {
                void agents.query.refetch();
              }}
            />
          ) : (
            <Skeleton variant="list" rows={4} label={t('detail.agents.loading')} />
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
              nounKey="common.noun.agents"
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
      <div className="session-frame card">
        <SessionHeader session={detail} agent={agent} headingRef={headingRef}>
          {refreshFailing ? (
            <ErrorState
              kind="refresh"
              size="inline"
              subjectKey="error.subject.session"
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
              <span>{t('detail.agentMissing', { agent: state.agent })}</span>
              <Link to={mainAgentLink}>{t('detail.agentMissing.open')}</Link>
            </p>
          ) : null}
        </SessionHeader>
        <div className="session-frame__row">
          <SessionStats session={detail} errors={split} errorsHref={errorsHref} />
          <SessionDetails session={detail} />
        </div>
      </div>
      <SessionTabs active={state.tab} agent={state.agent} issueCount={detail.errorCount + detail.warningCount} />
      <div className="detail__panel">{panel}</div>
    </section>
  );
}

/**
 * `/sessions/:sessionId`: the header with the state and its evidence, the four tiles, the closed Details section, and the
 * transcript, errors, agents, tokens and events views (04 4.4, ADR 0073 decision 8). The view, the agent and the transcript
 * filters live in the address. Until the app providers are mounted it shows only its heading, so the route never crashes the shell.
 */
export function SessionDetailPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  const { sessionId } = useParams();
  if (api === null || instanceId === null || sessionId === undefined) return <Unavailable sessionId={sessionId} />;
  return <Detail sessionId={sessionId} />;
}
