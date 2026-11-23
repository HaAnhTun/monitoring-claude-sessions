import { toQuery, type SessionSummary } from '@mcs/shared';
import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { AttentionStrip } from '../../components/AttentionStrip.tsx';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { useUrlState } from '../../components/FilterBar.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StaleDataIndicator } from '../../components/StaleDataIndicator.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { toSessionFilter } from '../../data/endpoints.ts';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { ApiContext, InstanceIdContext, useIid, useInstance } from '../../data/hooks/useInstance.ts';
import { useOverview } from '../../data/hooks/useOverview.ts';
import { SESSIONS_PAGE_LIMIT, useSessions } from '../../data/hooks/useSessions.ts';
import { qk, type ApiQuery } from '../../data/query-keys.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import type { Formatters } from '../../i18n/format.ts';
import type { MessageKey, TFunction } from '../../i18n/types.ts';
import {
  attentionFilterOf,
  attentionPatch,
  matchesAttention,
  sortByAttention,
  type AttentionFilter,
} from '../../lib/sessions-attention.ts';
import {
  formatUrlState,
  sessionsSpec,
  type Preset,
  type SessionSort,
  type SessionsUrlState,
  type Spec,
  type TimeRange,
} from '../../lib/url-state.ts';
import { useShortcut } from '../../state/shortcuts-registry.tsx';
import { useShowToast } from '../../state/toast-store.ts';
import { MQ_SHEET, useMediaQuery } from '../../state/use-media-query.ts';
import { ColumnChooser, useColumnChoice } from './ColumnChooser.tsx';
import { ListChangedNotice } from './ListChangedNotice.tsx';
import { SessionFilterBar } from './SessionFilterBar.tsx';
import {
  DEFAULT_SESSION_COLUMNS,
  REQUIRED_SESSION_COLUMNS,
  SESSIONS_TABLE_ID,
  SESSION_COLUMN_IDS,
  SessionTable,
  useSessionColumnOptions,
} from './SessionTable.tsx';

/** The server refuses a shorter search (`query_too_short`, 03 5.4). */
const MIN_SEARCH_CHARS = 2;
const DEFAULT_WINDOW_HOURS = 24;
const SKELETON_ROWS = 8;
const SKELETON_COLUMNS = 6;

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

const RANGE_KEYS = {
  '1h': 'filters.range.1h',
  '6h': 'filters.range.6h',
  '24h': 'filters.range.24h',
  '7d': 'filters.range.7d',
  '30d': 'filters.range.30d',
  all: 'filters.range.all',
} as const satisfies Readonly<Record<Preset, MessageKey>>;

/** The time range as a few words: "Last 24 hours", "since 12 Oct, 09:00". */
function rangeText(range: TimeRange, t: TFunction, format: Formatters): string {
  if (range.kind === 'preset') return t(RANGE_KEYS[range.preset]);
  return range.to === null
    ? t('filters.range.since', { from: format.dateTime(range.from) })
    : t('filters.range.customValue', { from: format.dateTime(range.from), to: format.dateTime(range.to) });
}

function LikelyHere() {
  const t = useT();
  return (
    <>
      {' '}
      <TagBadge tone="partial" icon="info">
        {t('sessions.empty.likely')}
      </TagBadge>
    </>
  );
}

interface EmptyExplorerProps {
  state: SessionsUrlState;
  onShowUnmatched: () => void;
}

/** No session at all: the list of causes, with the likely one flagged from what the monitor knows. */
function EmptyExplorer({ state, onShowUnmatched }: EmptyExplorerProps) {
  const t = useT();
  const format = useFormat();
  const health = useHealth();
  const folderMissing = health.data?.ingestion.transcripts.dirFound === false;
  const unmatchedHidden = !state.unmatched;
  return (
    <EmptyState title={t('sessions.empty.title')} icon="sessions">
      <ul className="causes">
        <li>
          {t('sessions.empty.cause.folder')}
          {folderMissing ? <LikelyHere /> : null}
        </li>
        <li>
          {t('sessions.empty.cause.unmatched')}
          {unmatchedHidden ? <LikelyHere /> : null}
          {unmatchedHidden ? (
            <>
              {' '}
              <Button variant="quiet" onClick={onShowUnmatched}>
                {t('sessions.empty.showUnmatched')}
              </Button>
            </>
          ) : null}
        </li>
        {state.range.kind === 'preset' && state.range.preset !== 'all' ? (
          <li>{t('sessions.empty.cause.range', { range: rangeText(state.range, t, format) })}</li>
        ) : null}
      </ul>
    </EmptyState>
  );
}

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

function ExplorerUnavailable() {
  const t = useT();
  const headingRef = usePageChrome(t('route.sessions.title'));
  return (
    <section className="page explorer">
      <h1 ref={headingRef} tabIndex={-1}>
        {t('route.sessions.title')}
      </h1>
      <p className="muted">{t('sessions.waiting')}</p>
    </section>
  );
}

/**
 * "Attention first" (ADR 0073 decision 7) on the rows that are loaded. A live list must not reorder under the reader, so the order
 * is worked out when the sort is chosen or the rows that are loaded are other rows (a filter, a page, a refresh), and is kept
 * while the rows only change in place.
 */
function useAttentionOrder(rows: readonly SessionSummary[], enabled: boolean): readonly SessionSummary[] {
  const signature = enabled ? rows.map((row) => row.id).join(',') : null;
  const [kept, setKept] = useState<{ signature: string; ids: readonly string[] } | null>(null);
  if (signature === null) {
    if (kept !== null) setKept(null);
    return rows;
  }
  if (kept?.signature !== signature) {
    const ordered = sortByAttention(rows);
    setKept({ signature, ids: ordered.map((row) => row.id) });
    return ordered;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return kept.ids.flatMap((id) => byId.get(id) ?? []);
}

/** `j` and `k`: the focus goes to the link of the next or the previous row. `Enter` then opens it, as on any link. */
function moveRowFocus(container: HTMLElement | null, step: 1 | -1): void {
  if (container === null) return;
  const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.data-table__link'));
  if (links.length === 0) return;
  const current = links.findIndex((link) => link === document.activeElement);
  const next =
    current < 0 ? (step > 0 ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, current + step));
  links[next]?.focus();
}

function Explorer() {
  const t = useT();
  const format = useFormat();
  const headingRef = usePageChrome(t('route.sessions.title'));
  const instance = useInstance();
  const windowHours = instance.data?.windowHours ?? DEFAULT_WINDOW_HOURS;
  const spec = useMemo(() => sessionsSpec(windowHours), [windowHours]);
  const [state, setState, ignored] = useUrlState(spec);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  const showToast = useShowToast();
  const sheet = useMediaQuery(MQ_SHEET);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const query = useMemo(() => sessionQuery(state), [state]);
  // While the stream is live `useSessions` stops polling (StreamLiveContext) and the stream provider patches rows in place. A
  // session that is new to the list joins it by itself only when the list is one unscrolled page; otherwise the reconciler counts
  // it and `ListChangedNotice` offers "Refresh" (04 5.5 rule R3). Without a stream the list refetches at `poll.sessionsMs`.
  const list = useSessions(query, {
    onCursorReset: () => {
      showToast(t('error.handling.listChanged'));
    },
  });
  const { items, capped } = list;
  const result = list.query;
  const listKey = qk.sessions(useIid(), query);
  const overview = useOverview();

  const attention = attentionFilterOf({ state: state.state, errors: state.errors, attn: state.attn });
  // A pressed tile is one filter: `attn` belongs to the state it narrows and is not counted a second time.
  const activeCount = countActive(spec, state) - (state.attn === 'any' ? 0 : 1);
  // The monitor's own counts describe the whole window; they stand in for the rows only while no filter narrows the list.
  const unfiltered = attention === null && countActive(spec, state) === 0;
  const complete = result.data !== undefined && !result.hasNextPage;

  const columnOptions = useSessionColumnOptions();
  const columnChoice = useColumnChoice(
    SESSIONS_TABLE_ID,
    SESSION_COLUMN_IDS,
    REQUIRED_SESSION_COLUMNS,
    DEFAULT_SESSION_COLUMNS,
  );

  // The server filters by state; these three tiles are a part of a state, so the page narrows the loaded rows.
  const narrowBy = attention === 'quiet' || attention === 'needs' || attention === 'ready' ? attention : null;
  const narrowed = useMemo(
    () => (narrowBy === null ? items : items.filter((row) => matchesAttention(row, narrowBy))),
    [narrowBy, items],
  );
  const rows = useAttentionOrder(narrowed, state.sort === 'attention');
  const tableRows = useMemo(() => [...rows], [rows]);

  const onSort = useCallback(
    (key: SessionSort) => {
      if (key === 'attention') setState({ sort: 'attention', dir: 'desc' });
      else if (key === state.sort) setState({ dir: state.dir === 'desc' ? 'asc' : 'desc' });
      else setState({ sort: key, dir: key === 'label' ? 'asc' : 'desc' });
    },
    [state.sort, state.dir, setState],
  );
  const toggleAttentionSort = useCallback(() => {
    if (state.sort === 'attention') setState({ sort: 'lastActivity', dir: 'desc' });
    else setState({ sort: 'attention', dir: 'desc' });
  }, [state.sort, setState]);
  const onAttention = useCallback(
    (next: AttentionFilter) => {
      setState(attentionPatch(next));
    },
    [setState],
  );
  // A state or error filter chosen by hand replaces the tile, so the half of `waiting_input` it stood for goes with it.
  const onFilterChange = useCallback(
    (patch: Partial<SessionsUrlState>) => {
      setState('state' in patch || 'errors' in patch ? { attn: 'any', ...patch } : patch);
    },
    [setState],
  );
  const clearAll = useCallback(() => {
    setState({
      q: '',
      state: [],
      project: '',
      task: null,
      model: '',
      errors: false,
      attn: 'any',
      range: spec.range.default,
      tokMin: null,
      tokMax: null,
      unmatched: false,
    });
  }, [setState, spec]);
  const showUnmatched = useCallback(() => {
    setState({ unmatched: true });
  }, [setState]);

  useShortcut(
    'j',
    () => {
      moveRowFocus(resultsRef.current, 1);
    },
    { description: t('sessions.shortcut.next'), enabled: tableRows.length > 0 },
  );
  useShortcut(
    'k',
    () => {
      moveRowFocus(resultsRef.current, -1);
    },
    { description: t('sessions.shortcut.prev'), enabled: tableRows.length > 0 },
  );

  const lastPage = result.data?.pages.at(-1);
  const noMatch = result.data !== undefined && tableRows.length === 0 && activeCount > 0;

  let body: ReactNode;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind={kindOf(result.error)}
        subjectKey="error.subject.sessions"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="table" rows={SKELETON_ROWS} columns={SKELETON_COLUMNS} label={t('sessions.loading')} />
    );
  } else if (tableRows.length === 0) {
    body = noMatch ? (
      <EmptyState
        title={t('sessions.noMatch.title')}
        primary={{ label: t('sessions.noMatch.clear'), onClick: clearAll }}
      >
        <p>{t('sessions.noMatch.hint')}</p>
      </EmptyState>
    ) : (
      <EmptyExplorer state={state} onShowUnmatched={showUnmatched} />
    );
  } else {
    body = (
      <>
        <SessionTable
          rows={tableRows}
          sort={{ key: state.sort, dir: state.dir }}
          onSort={onSort}
          columns={columnChoice.selected}
        />
        <LoadMore
          hasMore={result.hasNextPage}
          loading={result.isFetchingNextPage}
          onLoad={() => {
            void result.fetchNextPage();
          }}
          shown={tableRows.length}
          total={narrowBy === null ? (lastPage?.total ?? null) : null}
          totalIsLowerBound={lastPage?.totalIsLowerBound ?? false}
          nounKey="common.noun.sessions"
          capped={capped}
          pageSize={SESSIONS_PAGE_LIMIT}
        />
        {result.isFetchNextPageError ? (
          <ErrorState kind="load" size="inline" subjectKey="error.subject.moreSessions" error={result.error} />
        ) : null}
      </>
    );
  }

  // A failed refetch keeps the rows on screen and says how old they are (UI-I5).
  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;

  let summary: string | null = null;
  if (result.data !== undefined && tableRows.length > 0) {
    const total = narrowBy === null ? (lastPage?.total ?? null) : null;
    if (total !== null) {
      summary =
        lastPage?.totalIsLowerBound === true
          ? t('sessions.summary.countAtLeast', { count: total })
          : t('sessions.summary.count', { count: total });
    } else {
      summary = result.hasNextPage
        ? t('sessions.summary.countAtLeast', { count: tableRows.length })
        : t('sessions.summary.count', { count: tableRows.length });
    }
  }

  return (
    <section className="page explorer">
      <div className="explorer__head">
        <div className="explorer__title">
          <h1 ref={headingRef} tabIndex={-1}>
            {t('route.sessions.title')}
          </h1>
          {summary === null ? null : (
            <p className="explorer__summary">
              <span>{summary}</span>
              <span>{rangeText(state.range, t, format)}</span>
            </p>
          )}
        </div>
        <div className="explorer__tools">
          <Button
            icon="alert"
            aria-pressed={state.sort === 'attention'}
            title={t('sessions.sort.attention.tip')}
            onClick={toggleAttentionSort}
          >
            {t('sessions.sort.attention')}
          </Button>
          {sheet ? null : (
            <ColumnChooser tableId={SESSIONS_TABLE_ID} options={columnOptions} defaults={DEFAULT_SESSION_COLUMNS} />
          )}
        </div>
      </div>
      <AttentionStrip
        overview={unfiltered ? overview.data : null}
        loadedRows={items}
        complete={complete}
        filter={attention}
        onFilter={onAttention}
      />
      <SessionFilterBar
        state={state}
        onChange={onFilterChange}
        rangeDefault={spec.range.default}
        ignoredKeys={ignored.length > 0 && dismissed !== ignored ? ignored : []}
        onDismissIgnored={() => {
          setDismissed(ignored);
        }}
        activeCount={noMatch ? 0 : activeCount}
        onClearAll={clearAll}
      />
      {Array.from(state.q).length === 1 ? <p className="muted">{t('sessions.searchHint')}</p> : null}
      <ListChangedNotice
        queryKey={listKey}
        onRefresh={() => {
          void result.refetch();
        }}
      />
      {result.data === undefined ? null : (
        <StaleDataIndicator asOf={result.dataUpdatedAt} scope={t('error.subject.sessions')} />
      )}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.sessions"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      <div
        className="explorer__results"
        data-testid="explorer-results"
        aria-busy={result.isPlaceholderData}
        ref={resultsRef}
      >
        {result.isPlaceholderData ? (
          <p role="status" className="muted">
            {t('sessions.updating')}
          </p>
        ) : null}
        {body}
      </div>
    </section>
  );
}

/**
 * `/sessions`: the attention strip, one filter row in the URL, a sortable table with the columns the user chose (cards below
 * 900 px), load-more paging and the states of 04 7. Until the app providers are mounted (no API client or no active instance) it
 * shows only its heading, so the route never crashes the shell.
 */
export function SessionExplorerPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <ExplorerUnavailable /> : <Explorer />;
}
