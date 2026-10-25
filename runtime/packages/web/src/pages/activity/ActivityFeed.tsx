// The activity feed (04 4.4.4, 5.7): the events of the first pages of `GET /events`, the live events of the stream in front of them,
// and a pause that freezes what the reader sees while the new events are only counted. The page and the Overview both use it.
import { toQuery, matchesEventFilter, type ActivityEvent, type EventPage, type ToolCallItem } from '@mcs/shared';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { StaleDataIndicator } from '../../components/StaleDataIndicator.tsx';
import { ApiError } from '../../data/api-errors.ts';
import type { EventFilter } from '../../data/endpoints.ts';
import { ACTIVITY_POLL_MS, useActivity } from '../../data/hooks/useActivity.ts';
import { useIid, useStreamLive } from '../../data/hooks/useInstance.ts';
import { qk } from '../../data/query-keys.ts';
import { useT } from '../../i18n/context.ts';
import { useAnnounce } from '../../state/announcer.tsx';
import { useShowToast } from '../../state/toast-store.ts';
import { createLiveBuffer, type LiveBufferStore } from '../../stream/live-buffer.ts';
import { useStreamControls } from '../../stream/StreamProvider.tsx';
import { ActivityRow, type ActivityMode } from './ActivityRow.tsx';

/** More live events than this and the feed loads its first page again instead (5.7 rule 1). */
export const HEAD_CAP = 500;
/** More events than this while paused and the rest are only counted (5.7 rule 2). */
export const PAUSED_CAP = 500;
const COMPACT_LIMIT = 10;
const SKELETON_ROWS = 8;
const TOOL_PATCH_CAP = 1000;
/** The wait before a feed that cannot place a live event reloads its first page, so a burst costs one request. */
const UNRESOLVED_RELOAD_MS = 1000;

export interface ActivityFeedProps {
  /** The `listEvents` filter; the feed starts over when its content changes. */
  filter: EventFilter;
  mode: ActivityMode;
  /** Compact mode: the number of rows (default 10). */
  limit?: number;
  /** Page mode: a filter is on, so an empty list says "no match" and offers `onClearFilters`. */
  filtered?: boolean;
  onClearFilters?: (() => void) | undefined;
}

// ---- merging ---------------------------------------------------------------------------------------------------------------

function newestFirst(a: ActivityEvent, b: ActivityEvent): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  return byTime === 0 ? b.id - a.id : byTime;
}

/**
 * The rows to draw: the live events in front of the stored ones, an id once (the stored copy wins), newest first by time and then
 * by id (03 5.3 display order).
 */
export function mergeLive(head: readonly ActivityEvent[], stored: readonly ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<number>();
  const merged: ActivityEvent[] = [];
  for (const event of [...stored, ...head]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged.sort(newestFirst);
}

interface Boundary {
  atMs: number;
  id: number;
}

/** What a paused feed shows: the rows that were on screen when it was paused and the older ones that load later. */
const NOTHING_YET: Boundary = { atMs: Number.NEGATIVE_INFINITY, id: Number.NEGATIVE_INFINITY };

function atOrBelow(event: ActivityEvent, boundary: Boundary): boolean {
  const at = Date.parse(event.at);
  return at < boundary.atMs || (at === boundary.atMs && event.id <= boundary.id);
}

type ToolPatch = Pick<ToolCallItem, 'status' | 'durationMs'>;

function withToolPatches(events: ActivityEvent[], patches: ReadonlyMap<string, ToolPatch>): ActivityEvent[] {
  if (patches.size === 0) return events;
  const next = events.map((event) => {
    const patch = event.toolUseId === null ? undefined : patches.get(event.toolUseId);
    if (patch === undefined || (patch.status === event.toolStatus && patch.durationMs === event.durationMs))
      return event;
    return { ...event, toolStatus: patch.status, durationMs: patch.durationMs };
  });
  return next.some((event, index) => event !== events[index]) ? next : events;
}

// ---- live events -----------------------------------------------------------------------------------------------------------

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function projectOfRow(row: unknown, sessionId: string): string | null | undefined {
  if (!isRecord(row) || row['id'] !== sessionId) return undefined;
  const projectId = row['projectId'];
  if (typeof projectId === 'string') return projectId;
  return projectId === null ? null : undefined;
}

/**
 * The project of a session as far as the cache knows it (a loaded session list or a session page); `undefined` when no loaded
 * answer names the session. The shared predicate fails closed without an answer, so an event of an unknown session is not shown.
 */
function projectIdFromCache(queryClient: QueryClient, iid: string, sessionId: string): string | null | undefined {
  const detail = projectOfRow(queryClient.getQueryData(qk.session(iid, sessionId)), sessionId);
  if (detail !== undefined) return detail;
  for (const [, data] of queryClient.getQueriesData({ queryKey: [...qk.root(iid), 'sessions'] })) {
    if (!isRecord(data)) continue;
    for (const page of arrayOf(data['pages'])) {
      if (!isRecord(page)) continue;
      for (const row of arrayOf(page['items'])) {
        const found = projectOfRow(row, sessionId);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * Whether a live event belongs in the feed. The same predicate as the server's SQL (`matchesEventFilter`), with one exception:
 * a `monitor.gap` event ignores the category and type filters, so the reader always sees where events may be missing (4.4.4).
 */
function liveAccepts(
  filter: EventFilter,
  event: ActivityEvent,
  projectIdOf: (sessionId: string) => string | null | undefined,
): boolean {
  let applied = filter;
  if (event.type === 'monitor.gap') {
    applied = { ...filter };
    delete applied.category;
    delete applied.type;
  }
  return matchesEventFilter(applied, event, { nowMs: Date.now(), projectIdOf });
}

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

// ---- the component ----------------------------------------------------------------------------------------------------------

function useLiveBuffer(
  filter: EventFilter,
  reload: () => void,
): { store: LiveBufferStore<ActivityEvent>; scheduleReload: () => void } {
  const queryClient = useQueryClient();
  const iid = useIid();
  const [store] = useState(() =>
    createLiveBuffer<ActivityEvent>(
      {
        key: (event) => String(event.id),
        accept: (event) => liveAccepts(filter, event, (sessionId) => projectIdFromCache(queryClient, iid, sessionId)),
        headCap: HEAD_CAP,
        pausedCap: PAUSED_CAP,
      },
      {
        onEffect: (effect) => {
          if (effect === 'refetch-first-page') reload();
        },
      },
    ),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const scheduleReload = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload();
    }, UNRESOLVED_RELOAD_MS);
  }, [reload]);
  return { store, scheduleReload };
}

function Feed({ filter, mode, limit = COMPACT_LIMIT, filtered = false, onClearFilters }: ActivityFeedProps) {
  const t = useT();
  const announce = useAnnounce();
  const showToast = useShowToast();
  const queryClient = useQueryClient();
  const iid = useIid();
  const live = useStreamLive();
  const controls = useStreamControls();
  const page = mode === 'page';

  // The component is keyed by the content of the filter, so both are fixed for its life.
  const [initialFilter] = useState(filter);
  const [q] = useState(() => toQuery(filter));

  const list = useActivity(q, {
    onCursorReset: () => {
      showToast(t('error.handling.listChanged'));
    },
  });
  const result = list.query;

  /** The first page again: the stored pages shrink to it, so the rows stay on screen while it loads. */
  const reload = useCallback(() => {
    const key = qk.activity(iid, q);
    queryClient.setQueryData<InfiniteData<EventPage>>(key, (old) =>
      old === undefined ? old : { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) },
    );
    void queryClient.refetchQueries({ queryKey: key, exact: true });
  }, [queryClient, iid, q]);

  const { store, scheduleReload } = useLiveBuffer(initialFilter, reload);
  const subscribe = useCallback((notify: () => void) => store.subscribe(notify), [store]);
  const readBuffer = useCallback(() => store.getState(), [store]);
  const buffer = useSyncExternalStore(subscribe, readBuffer);
  const { paused } = buffer;
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [toolPatches, setToolPatches] = useState<ReadonlyMap<string, ToolPatch>>(new Map());

  // The stream offers every event to every mounted feed; each keeps the ones that match its own filter.
  useEffect(() => {
    if (controls === null) return undefined;
    return controls.liveBuffers.register({
      offer: (items) => {
        const unresolved =
          initialFilter.project !== undefined &&
          items.some((item) => projectIdFromCache(queryClient, iid, item.sessionId) === undefined);
        store.dispatch({ type: 'offer', items });
        if (unresolved) scheduleReload();
      },
      refetchFirstPage: reload,
      patchToolCalls: (items) => {
        setToolPatches((previous) => {
          const next = new Map(previous);
          for (const item of items) next.set(item.toolUseId, { status: item.status, durationMs: item.durationMs });
          for (const key of next.keys()) {
            if (next.size <= TOOL_PATCH_CAP) break;
            next.delete(key);
          }
          return next;
        });
      },
      clear: () => {
        store.dispatch({ type: 'clear' });
      },
    });
  }, [controls, store, reload, scheduleReload, initialFilter, queryClient, iid]);

  // Live events that the refetched first page now holds are dropped from the buffer (5.7 rule 4). Not while paused: the reader
  // still counts them as new.
  const firstAsOf = result.data?.pages[0]?.asOfSeq;
  useEffect(() => {
    if (paused || firstAsOf === undefined) return;
    store.dispatch({ type: 'snapshot', asOfSeq: firstAsOf, seqOf: (event) => event.seq });
  }, [store, paused, firstAsOf]);

  const pages = result.data?.pages;
  const stored = useMemo(() => (pages ?? []).flatMap((p) => p.items), [pages]);
  const merged = useMemo(() => mergeLive(buffer.head, stored), [buffer.head, stored]);
  const patched = useMemo(() => withToolPatches(merged, toolPatches), [merged, toolPatches]);
  const visible = useMemo(() => {
    const shown = paused && boundary !== null ? patched.filter((event) => atOrBelow(event, boundary)) : patched;
    return page ? shown : shown.slice(0, limit);
  }, [patched, paused, boundary, page, limit]);

  const pause = (): void => {
    const top = visible[0];
    setBoundary(top === undefined ? NOTHING_YET : { atMs: Date.parse(top.at), id: top.id });
    store.dispatch({ type: 'pause' });
  };
  const resume = (): void => {
    const before = store.getState();
    store.dispatch({ type: 'resume' });
    setBoundary(null);
    const reloaded = store.getState().head.length === 0 && before.buffered.length + before.head.length > 0;
    announce(reloaded ? t('activity.resumedReload') : t('activity.resumed', { count: before.buffered.length }), {
      force: true,
    });
  };

  const lastPage = pages?.at(-1);
  let body: ReactNode;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind={kindOf(result.error)}
        subjectKey="error.subject.events"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="list" rows={page ? SKELETON_ROWS : 3} label={t('activity.loading')} />
    );
  } else if (visible.length === 0) {
    if (!page) {
      body = <p className="muted">{t('activity.emptyCompact')}</p>;
    } else if (filtered) {
      body = (
        <EmptyState
          title={t('activity.emptyFiltered.title')}
          icon="activity"
          primary={
            onClearFilters === undefined ? undefined : { label: t('activity.clearFilters'), onClick: onClearFilters }
          }
        >
          <p>{t('activity.emptyFiltered.body')}</p>
        </EmptyState>
      );
    } else {
      body = (
        <EmptyState title={t('activity.empty.title')} icon="activity">
          <p>{t('activity.empty.body')}</p>
        </EmptyState>
      );
    }
  } else {
    body = (
      <ul
        className={page ? 'activity-list card card--flush' : 'activity-list activity-list--compact'}
        aria-label={t('activity.list.label')}
      >
        {visible.map((event) => (
          <ActivityRow key={event.id} event={event} mode={mode} />
        ))}
      </ul>
    );
  }

  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;
  return (
    <div className={`activity-feed activity-feed--${mode}`}>
      {page ? (
        <div className="activity-toolbar">
          <StatusLine paused={paused} live={live} buffered={buffer.buffered.length} dropped={buffer.dropped} />
          {result.data === undefined ? null : (
            <Button
              variant="quiet"
              icon={paused ? 'play' : 'pause'}
              onClick={paused ? resume : pause}
              title={t('activity.pauseTip')}
            >
              {paused ? t('activity.resume') : t('activity.pause')}
            </Button>
          )}
        </div>
      ) : null}
      {page ? (
        <StaleDataIndicator
          asOf={result.dataUpdatedAt === 0 ? null : result.dataUpdatedAt}
          fetchFailing={refreshFailing}
          scope={t('activity.scope')}
        />
      ) : null}
      {refreshFailing && page ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.events"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      <div className="activity-feed__body" data-stale-scope aria-busy={result.isPlaceholderData}>
        {body}
      </div>
      {page && result.data !== undefined && visible.length > 0 ? (
        <>
          {lastPage?.scanCapped === true ? <p className="muted small">{t('activity.scanCapped')}</p> : null}
          <LoadMore
            hasMore={result.hasNextPage}
            loading={result.isFetchingNextPage}
            onLoad={() => {
              void result.fetchNextPage();
            }}
            shown={visible.length}
            total={null}
            nounKey="common.noun.events"
            capped={list.capped}
          />
        </>
      ) : null}
    </div>
  );
}

interface StatusLineProps {
  paused: boolean;
  live: boolean;
  buffered: number;
  dropped: number;
}

/** "Live", "Paused, 37 new events", "Paused, 500+ new events, older ones load from history" or the polling fallback. */
function StatusLine({ paused, live, buffered, dropped }: StatusLineProps) {
  const t = useT();
  let tone: 'running' | 'idle' | 'stale';
  let dot: 'pulse' | 'solid' | 'ring';
  let text: string;
  if (paused) {
    tone = 'idle';
    dot = 'ring';
    text =
      dropped > 0
        ? t('activity.status.pausedOverflow', { count: buffered })
        : t('activity.status.paused', { count: buffered });
  } else if (live) {
    tone = 'running';
    dot = 'pulse';
    text = t('activity.status.live');
  } else {
    tone = 'stale';
    dot = 'solid';
    text = t('activity.status.disconnected', { seconds: Math.round(ACTIVITY_POLL_MS / 1000) });
  }
  return (
    <p className={`activity-status tone-${tone}`}>
      <span className={`state-dot state-dot--${dot}`} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

/**
 * The feed of events. Page mode has the status line, Pause and Resume, the stale-data line and "Load more"; compact mode (the
 * Overview) is only the newest `limit` rows, still live. The feed starts over when the content of `filter` changes.
 */
export function ActivityFeed(props: ActivityFeedProps) {
  const key = JSON.stringify(toQuery(props.filter));
  return <Feed key={key} {...props} />;
}
