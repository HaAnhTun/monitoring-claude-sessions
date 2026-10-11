import { toQuery } from '@mcs/shared';
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { useUrlState } from '../../components/FilterBar.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { toSessionFilter } from '../../data/endpoints.ts';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { ApiContext, InstanceIdContext, useInstance } from '../../data/hooks/useInstance.ts';
import { SESSIONS_PAGE_LIMIT, useSessions } from '../../data/hooks/useSessions.ts';
import type { ApiQuery } from '../../data/query-keys.ts';
import {
  formatUrlState,
  sessionsSpec,
  type SessionSort,
  type SessionsUrlState,
  type Spec,
} from '../../lib/url-state.ts';
import { useShowToast } from '../../state/toast-store.ts';
import { SessionFilterBar } from './SessionFilterBar.tsx';
import { SessionTable } from './SessionTable.tsx';

const TITLE = 'Sessions';
/** The server refuses a shorter search (`query_too_short`, 03 5.4). */
const MIN_SEARCH_CHARS = 2;
const DEFAULT_WINDOW_HOURS = 24;
const SKELETON_ROWS = 8;

/** The `listSessions` query of the URL state: renamed filters, a total for "N of M", and no search the server would refuse. */
function sessionQuery(state: SessionsUrlState): ApiQuery {
  const filter = toSessionFilter(state);
  if (Array.from(state.q).length < MIN_SEARCH_CHARS) delete filter.q;
  return toQuery({ ...filter, includeTotal: true });
}

/** How many filters differ from their defaults; the sort is not a filter. A custom range counts once. */
function countActive(spec: Spec<SessionsUrlState>, state: SessionsUrlState): number {
  const keys = new Set<string>();
  for (const key of formatUrlState(spec, state).keys()) {
    if (key === 'sort' || key === 'dir') continue;
    keys.add(key === 'from' || key === 'to' ? 'range' : key);
  }
  return keys.size;
}

const RANGE_TEXT: Readonly<Record<string, string>> = {
  '1h': 'last hour',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

interface EmptyExplorerProps {
  state: SessionsUrlState;
  onShowUnmatched: () => void;
}

/** No session at all: the legacy list of causes, with the likely one flagged from what the monitor knows. */
function EmptyExplorer({ state, onShowUnmatched }: EmptyExplorerProps) {
  const health = useHealth();
  const folderMissing = health.data?.ingestion.transcripts.dirFound === false;
  const unmatchedHidden = !state.unmatched;
  const rangeText = state.range.kind === 'preset' ? RANGE_TEXT[state.range.preset] : undefined;
  return (
    <EmptyState title="No sessions yet" icon="sessions">
      <ul className="causes">
        <li>
          The transcripts folder was not found, so nothing could be read.
          {folderMissing ? <LikelyHere /> : null}
        </li>
        <li>
          No project rule matched the sessions and unmatched sessions are hidden.
          {unmatchedHidden ? <LikelyHere /> : null}
          {unmatchedHidden ? (
            <>
              {' '}
              <Button variant="quiet" onClick={onShowUnmatched}>
                Show unmatched sessions
              </Button>
            </>
          ) : null}
        </li>
        {rangeText === undefined ? null : <li>{`The time range only covers the ${rangeText}.`}</li>}
      </ul>
    </EmptyState>
  );
}

function LikelyHere() {
  return (
    <>
      {' '}
      <TagBadge tone="partial" icon="info">
        Likely here
      </TagBadge>
    </>
  );
}

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

function ExplorerUnavailable() {
  const headingRef = usePageChrome(TITLE);
  return (
    <section className="page explorer">
      <h1 ref={headingRef} tabIndex={-1}>
        {TITLE}
      </h1>
      <p className="muted">Waiting for the connection to the monitor.</p>
    </section>
  );
}

function Explorer() {
  const headingRef = usePageChrome(TITLE);
  const instance = useInstance();
  const windowHours = instance.data?.windowHours ?? DEFAULT_WINDOW_HOURS;
  const spec = useMemo(() => sessionsSpec(windowHours), [windowHours]);
  const [state, setState, ignored] = useUrlState(spec);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  const showToast = useShowToast();

  const query = useMemo(() => sessionQuery(state), [state]);
  // STREAM SEAM: while the stream is live `useSessions` stops polling (StreamLiveContext) and the stream provider patches or
  // invalidates this query key. The explorer needs no code for that; the "List changed" notice of 04 5.5 rule R3 attaches here
  // once the stream is integrated. Until then the list refetches at `poll.sessionsMs` (and on a filter change).
  const list = useSessions(query, {
    onCursorReset: () => {
      showToast('The list changed; reloaded from the top');
    },
  });
  const { items, capped } = list;
  const result = list.query;

  const activeCount = countActive(spec, state);
  const onSort = useCallback(
    (key: SessionSort) => {
      if (key === state.sort) setState({ dir: state.dir === 'desc' ? 'asc' : 'desc' });
      else setState({ sort: key, dir: key === 'label' ? 'asc' : 'desc' });
    },
    [state.sort, state.dir, setState],
  );
  const clearAll = useCallback(() => {
    setState({
      q: '',
      state: [],
      project: '',
      task: null,
      model: '',
      errors: false,
      range: spec.range.default,
      tokMin: null,
      tokMax: null,
      unmatched: false,
    });
  }, [setState, spec]);
  const showUnmatched = useCallback(() => {
    setState({ unmatched: true });
  }, [setState]);

  let body: ReactNode;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind={kindOf(result.error)}
        subject="sessions"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="table" rows={SKELETON_ROWS} label="Loading sessions" />
    );
  } else if (items.length === 0) {
    body =
      activeCount > 0 ? (
        <EmptyState title="No session matches these filters">
          <p>Widen the time range or remove a filter to see more.</p>
          <Button onClick={clearAll}>Clear filters</Button>
        </EmptyState>
      ) : (
        <EmptyExplorer state={state} onShowUnmatched={showUnmatched} />
      );
  } else {
    const lastPage = result.data.pages.at(-1);
    body = (
      <>
        <SessionTable rows={items} sort={{ key: state.sort, dir: state.dir }} onSort={onSort} />
        <LoadMore
          hasMore={result.hasNextPage}
          loading={result.isFetchingNextPage}
          onLoad={() => {
            void result.fetchNextPage();
          }}
          shown={items.length}
          total={lastPage?.total ?? null}
          totalIsLowerBound={lastPage?.totalIsLowerBound ?? false}
          noun="sessions"
          capped={capped}
          pageSize={SESSIONS_PAGE_LIMIT}
        />
        {result.isFetchNextPageError ? (
          <ErrorState kind="load" size="inline" subject="more sessions" error={result.error} />
        ) : null}
      </>
    );
  }

  // A failed refetch keeps the rows on screen and says how old they are (UI-I5).
  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;

  return (
    <section className="page explorer">
      <h1 ref={headingRef} tabIndex={-1}>
        {TITLE}
      </h1>
      <SessionFilterBar
        state={state}
        onChange={setState}
        ignoredKeys={ignored.length > 0 && dismissed !== ignored ? ignored : []}
        onDismissIgnored={() => {
          setDismissed(ignored);
        }}
        activeCount={activeCount}
        onClearAll={clearAll}
      />
      {Array.from(state.q).length === 1 ? <p className="muted">Type at least 2 characters to search.</p> : null}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subject="sessions"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      <div className="explorer__results" data-testid="explorer-results" aria-busy={result.isPlaceholderData}>
        {result.isPlaceholderData ? (
          <p role="status" className="muted">
            Updating...
          </p>
        ) : null}
        {body}
      </div>
    </section>
  );
}

/**
 * `/sessions`: filters in the URL, sortable columns, load-more paging and the states of 04 7. Until the app providers are
 * mounted (no API client or no active instance) it shows only its heading, so the route never crashes the shell.
 */
export function SessionExplorerPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <ExplorerUnavailable /> : <Explorer />;
}
