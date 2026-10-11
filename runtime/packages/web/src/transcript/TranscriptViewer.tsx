// The transcript viewer (04-ui.md 4.4.3, port of legacy timeline.js, must-preserve #14-#27): one row per display unit, rows
// hidden (not unmounted) by filters, follow mode, scroll anchoring, error stepping, jump and whole-transcript search.
import { toQuery, type EntryKind } from '@mcs/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Button } from '../components/Button.tsx';
import { useTranscriptSearch } from '../data/hooks/useTranscriptSearch.ts';
import { collectToolNames, defaultFilters, searchQuery, unitVisible, type TranscriptFilters } from '../lib/filters.ts';
import {
  atLatestEdge,
  followReducer,
  initialFollow,
  isErrorUnit,
  pairEvents,
  parseJump,
  stepError,
  type JumpTarget,
} from '../lib/timeline-model.ts';
import { PartialBanner } from './PartialBanner.tsx';
import { ResumeFollowButton } from './ResumeFollowButton.tsx';
import { ToolUnitRow } from './ToolUnitRow.tsx';
import { TranscriptRow } from './TranscriptRow.tsx';
import { TranscriptSearchResults } from './TranscriptSearchResults.tsx';
import { TranscriptToolbar } from './TranscriptToolbar.tsx';
import { useScrollAnchor } from './useScrollAnchor.ts';
import { useTranscriptWindow } from './useTranscriptWindow.ts';

export interface TranscriptViewerProps {
  sessionId: string;
  /** `null` is the main agent. */
  agentId: string | null;
  /** Display order; newest first when omitted. With `onNewestFirstChange` the page keeps it in the preferences. */
  newestFirst?: boolean;
  onNewestFirstChange?: (newestFirst: boolean) => void;
  /** Which kinds start visible: prompts, Claude, tools and results; thinking is off. */
  defaultKinds?: Partial<Record<EntryKind, boolean>>;
  onKindsChange?: (kinds: Readonly<Record<EntryKind, boolean>>) => void;
  /** The `i` URL parameter: jump there once the window is loaded, then call `onInitialIndexDone` (the page removes it). */
  initialIndex?: number | null;
  onInitialIndexDone?: () => void;
  /** Changes when the stream reports `transcript/append` for this session and agent (04 5.4); each change refreshes. */
  refreshToken?: number;
  /** Toasts and screen reader announcements; the viewer also shows the last one in its own status line. */
  onNotice?: (message: string) => void;
  /** Window cap; 5,000 unless a performance fallback (04 O-2) or a test lowers it. */
  maxEvents?: number;
}

const BASE_KINDS: Readonly<Record<EntryKind, boolean>> = {
  prompt: true,
  say: true,
  think: false,
  tool: true,
  result: true,
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, n) => value === b[n]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function addTo(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (set.has(value)) return set;
  return new Set(set).add(value);
}

function toggleIn(set: ReadonlySet<string>, value: string, on: boolean): ReadonlySet<string> {
  if (set.has(value) === on) return set;
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

function TranscriptViewerBody(props: TranscriptViewerProps) {
  const { sessionId, agentId, initialIndex, onInitialIndexDone, refreshToken, maxEvents } = props;
  const agent = agentId ?? 'main';
  const [newestLocal, setNewestLocal] = useState(true);
  const newestFirst = props.newestFirst ?? newestLocal;
  const [filters, setFilters] = useState<TranscriptFilters>(() => ({
    ...defaultFilters(),
    kinds: { ...BASE_KINDS, ...props.defaultKinds },
  }));
  const [follow, dispatchFollow] = useReducer(followReducer, undefined, initialFollow);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [errorCursor, setErrorCursor] = useState<string | null>(null);
  const [target, setTarget] = useState<{ key: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [searchQueryState, setSearchQueryState] = useState<Record<string, string> | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const nonce = useRef(0);

  const latest = useRef({ filters, props, follow, newestFirst });
  useEffect(() => {
    latest.current = { filters, props, follow, newestFirst };
  });

  const say = useCallback((message: string): void => {
    setNotice(message);
    latest.current.props.onNotice?.(message);
  }, []);

  const win = useTranscriptWindow(sessionId, agentId, {
    onNotice: say,
    following: follow.follow,
    ...(maxEvents === undefined ? {} : { maxEvents }),
  });
  const { state } = win;
  const { events } = state;
  const { refresh, peek, jumpTo, loadOlder } = win;

  // ---- derived rows -------------------------------------------------------------------------------------------------
  const units = useMemo(() => pairEvents(events), [events]);
  const visible = useMemo(() => {
    const keys = new Set<string>();
    for (const unit of units) if (unitVisible(unit, filters)) keys.add(unit.key);
    return keys;
  }, [units, filters]);
  const ordered = useMemo(() => (newestFirst ? [...units].reverse() : units), [units, newestFirst]);
  const errorKeys = useMemo(
    () => ordered.filter((unit) => visible.has(unit.key) && isErrorUnit(unit)).map((unit) => unit.key),
    [ordered, visible],
  );
  const names = collectToolNames(units);
  const [stableNames, setStableNames] = useState(names);
  if (!sameList(stableNames, names)) setStableNames(names);
  const toolNames = sameList(stableNames, names) ? stableNames : names;
  const hasActive = units.some((unit) => unit.status === 'active');

  // ---- follow: count events that arrive while it is off ------------------------------------------------------------
  const lastIndex = events[events.length - 1]?.i ?? -1;
  const [seen, setSeen] = useState({ gen: -1, last: -1 });
  if (seen.gen !== state.gen || seen.last !== lastIndex) {
    setSeen({ gen: state.gen, last: lastIndex });
    if (seen.gen === state.gen && lastIndex > seen.last) {
      let count = 0;
      for (let n = events.length - 1; n >= 0 && (events[n]?.i ?? -1) > seen.last; n -= 1) count += 1;
      dispatchFollow({ type: 'events', count });
    }
  }

  // ---- scroll anchoring --------------------------------------------------------------------------------------------
  const layoutKey = [
    state.gen,
    events[0]?.i ?? -1,
    lastIndex,
    events.length,
    newestFirst,
    follow.follow,
    visible.size,
    filters.q,
    filters.tool,
    filters.errorsOnly,
  ].join('|');
  const anchor = useScrollAnchor(scrollerRef, layoutKey, { follow: follow.follow, newestFirst });

  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const onScroll = (): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    dispatchFollow({
      type: 'scroll',
      atEdge: atLatestEdge(
        { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
        newestFirst,
      ),
    });
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      anchor.captureAnchor();
    });
  };

  // ---- the clock of running tools -----------------------------------------------------------------------------------
  useEffect(() => {
    if (!hasActive) return undefined;
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [hasActive]);

  // ---- refresh from the stream --------------------------------------------------------------------------------------
  useEffect(() => {
    if (refreshToken !== undefined && refreshToken > 0) refresh();
  }, [refreshToken, refresh]);

  // ---- moving to a row: scroll, focus (static outline) --------------------------------------------------------------
  useEffect(() => {
    if (target === null) return;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-row-key]')) {
      if (row.dataset['rowKey'] === target.key && !row.hidden) {
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
        row.focus({ preventScroll: true });
        return;
      }
    }
  }, [target]);

  // ---- handlers -----------------------------------------------------------------------------------------------------
  const prefix = `${sessionId}|${agent}|`;
  const onOpenChange = useCallback(
    (key: string, open: boolean): void => {
      setOpenRows((set) => toggleIn(set, prefix + key, open));
    },
    [prefix],
  );
  const onToggleExpanded = useCallback(
    (id: string, on: boolean): void => {
      setExpanded((set) => toggleIn(set, prefix + id, on));
    },
    [prefix],
  );

  const updateFilters = useCallback((change: Partial<TranscriptFilters>): void => {
    setFilters((current) => ({ ...current, ...change }));
    setErrorCursor(null);
  }, []);

  const onKindChange = (kind: EntryKind, on: boolean): void => {
    const kinds = { ...filters.kinds, [kind]: on };
    updateFilters({ kinds });
    props.onKindsChange?.(kinds);
  };

  const setNewest = (value: boolean): void => {
    setNewestLocal(value);
    props.onNewestFirstChange?.(value);
  };

  const doJump = useCallback(
    async (jump: JumpTarget): Promise<void> => {
      const index = await jumpTo(jump);
      const unit =
        index === null ? undefined : pairEvents(peek().events).find((u) => u.ev.i === index || u.result?.i === index);
      if (index === null || unit === undefined) {
        say('No event found for that jump');
        return;
      }
      dispatchFollow({ type: 'off' });
      const current = latest.current.filters;
      let cleared = false;
      if (!unitVisible(unit, current)) {
        const widened: TranscriptFilters = {
          ...current,
          q: '',
          tool: '',
          errorsOnly: false,
          kinds: { ...current.kinds, [unit.kind]: true },
        };
        setFilters(widened);
        setErrorCursor(null);
        cleared = true;
      }
      if (unit.kind === 'tool' && (unit.result?.i === index || unit.status === 'failed')) {
        setOpenRows((set) => addTo(set, `${sessionId}|${agent}|${unit.key}`));
      }
      nonce.current += 1;
      setTarget({ key: unit.key, nonce: nonce.current });
      say(`Jumped to #${String(index)}`);
      if (cleared) say(`Filters cleared to show #${String(index)}`);
    },
    [jumpTo, peek, say, sessionId, agent],
  );

  const onJump = (text: string): void => {
    const parsed = parseJump(text);
    if (parsed === null) {
      setJumpError('Enter #N, HH:MM[:SS] or an ISO time');
      return;
    }
    setJumpError(null);
    void doJump(parsed);
  };

  const initialConsumed = useRef<number | null>(null);
  useEffect(() => {
    if (initialIndex === undefined || initialIndex === null || state.status !== 'ready') return;
    if (initialConsumed.current === initialIndex) return;
    initialConsumed.current = initialIndex;
    void doJump({ type: 'index', i: initialIndex }).then(() => {
      onInitialIndexDone?.();
    });
  }, [initialIndex, state.status, doJump, onInitialIndexDone]);

  const stepErrors = (dir: number): void => {
    if (errorKeys.length === 0) {
      say('No errors in the loaded events');
      return;
    }
    const next = stepError(errorKeys, errorCursor, dir);
    if (next === null) {
      say('No more errors in that direction');
      return;
    }
    setErrorCursor(next);
    nonce.current += 1;
    setTarget({ key: next, nonce: nonce.current });
    say(`Error ${String(errorKeys.indexOf(next) + 1)} of ${String(errorKeys.length)}`);
  };

  const setFollow = (on: boolean): void => {
    if (on) {
      dispatchFollow({ type: 'resume' });
      refresh();
    } else {
      dispatchFollow({ type: 'off' });
    }
  };

  const onLoadOlder = (): void => {
    dispatchFollow({ type: 'off' });
    anchor.captureAnchor();
    void loadOlder();
  };

  const searchSubmit = (q: string): void => {
    const params = searchQuery({ ...filters, q }, sessionId, agentId);
    setSearchQueryState(toQuery({ ...params }));
    setSearchOpen(true);
  };
  const search = useTranscriptSearch(searchQueryState);
  const searchFailed = search.isError;
  const searchAnswer = search.data;
  const searchStale = searchAnswer !== undefined && searchAnswer.query.q !== (searchQueryState?.['q'] ?? '');
  const searchStatus: 'loading' | 'error' | 'ready' = searchFailed
    ? 'error'
    : searchAnswer === undefined || searchStale
      ? 'loading'
      : 'ready';
  const closeSearch = (): void => {
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };

  // ---- shortcuts: / search, f follow, ] and [ errors (04 6.5) ------------------------------------------------------
  const shortcuts = useRef({ stepErrors, setFollow, say });
  useEffect(() => {
    shortcuts.current = { stepErrors, setFollow, say };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const handlers = shortcuts.current;
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === 'f') {
        const turnOn = !latest.current.follow.follow;
        handlers.setFollow(turnOn);
        handlers.say(turnOn ? 'Following new events' : 'Follow off');
      } else if (event.key === ']') {
        handlers.stepErrors(1);
      } else if (event.key === '[') {
        handlers.stepErrors(-1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // ---- render -------------------------------------------------------------------------------------------------------
  const first = events[0]?.i;
  const olderReason =
    first === undefined || first <= 0 ? 'Already at the first event' : state.capped ? 'Window limit reached' : null;
  const hasEvents = events.length > 0;
  const noneVisible = hasEvents && visible.size === 0;
  const kindsOff = !filters.kinds.result;

  const olderRow =
    first !== undefined && first > 0 ? (
      <li className="tv-older" key="older">
        <Button
          icon="clock"
          loading={state.olderLoading}
          disabled={olderReason !== null}
          title={olderReason ?? undefined}
          onClick={onLoadOlder}
        >
          Load older
        </Button>
      </li>
    ) : null;

  const rows = ordered.map((unit) => {
    const hidden = !visible.has(unit.key);
    const isTarget = target?.key === unit.key;
    if (unit.kind === 'tool') {
      return (
        <ToolUnitRow
          key={unit.key}
          unit={unit}
          hidden={hidden}
          open={openRows.has(prefix + unit.key)}
          onOpenChange={onOpenChange}
          expandedInput={expanded.has(`${prefix}${unit.key}-input`)}
          expandedResult={expanded.has(`${prefix}${unit.key}-result`)}
          onToggleExpanded={onToggleExpanded}
          hideResult={kindsOff}
          isTarget={isTarget}
          nowMs={unit.status === 'active' ? nowMs : 0}
        />
      );
    }
    return (
      <TranscriptRow
        key={unit.key}
        unit={unit}
        hidden={hidden}
        expanded={expanded.has(`${prefix}${unit.key}-text`)}
        isTarget={isTarget}
        onToggleExpanded={onToggleExpanded}
      />
    );
  });

  const resumeButton = follow.follow ? null : (
    <ResumeFollowButton
      unseen={follow.unseen}
      onResume={() => {
        setFollow(true);
      }}
    />
  );

  const status = state.status;
  return (
    <section className={newestFirst ? 'tv tv--newest' : 'tv tv--oldest'} aria-label="Transcript">
      <TranscriptToolbar
        filters={filters}
        onQueryChange={(q) => {
          updateFilters({ q });
        }}
        onToolChange={(tool) => {
          updateFilters({ tool });
        }}
        onErrorsOnlyChange={(errorsOnly) => {
          updateFilters({ errorsOnly });
        }}
        onKindChange={onKindChange}
        toolNames={toolNames}
        newestFirst={newestFirst}
        onNewestFirstChange={setNewest}
        follow={follow.follow}
        onFollowChange={setFollow}
        onPrevError={() => {
          stepErrors(-1);
        }}
        onNextError={() => {
          stepErrors(1);
        }}
        onSearchWhole={searchSubmit}
        onJump={onJump}
        jumpError={jumpError}
        onLoadOlder={onLoadOlder}
        loadOlderDisabledReason={olderReason}
        olderLoading={state.olderLoading}
        counts={{
          visible: visible.size,
          loaded: units.length,
          errors: errorKeys.length,
          firstIndex: first ?? null,
          lastIndex: hasEvents ? lastIndex : null,
          total: state.total,
        }}
        searchInputRef={searchInputRef}
        searchButtonRef={searchButtonRef}
      />
      <PartialBanner partial={state.partial} pendingBytes={state.pendingBytes} />
      {state.capped ? (
        <p className="tv-banner" role="status">
          Window limit reached. Use Jump to view another part.
        </p>
      ) : null}
      {state.error !== null && hasEvents && status === 'ready' ? (
        <p className="tv-banner tv-banner--warn" role="status">
          {`Could not refresh events: ${state.error.message}. Showing the events loaded earlier.`}
        </p>
      ) : null}
      {notice === '' ? null : (
        <p className="tv-notice muted small" role="status">
          {notice}
        </p>
      )}
      {searchOpen ? (
        <TranscriptSearchResults
          status={searchStatus}
          response={searchStatus === 'ready' ? (searchAnswer ?? null) : null}
          error={search.error}
          onJump={(index) => {
            void doJump({ type: 'index', i: index });
          }}
          onClose={closeSearch}
        />
      ) : null}
      {status === 'idle' || (status === 'loading' && !hasEvents) ? <p role="status">Loading events...</p> : null}
      {status === 'error' && !hasEvents ? (
        <ErrorState kind="load" size="block" subject="events" error={state.error ?? undefined} onRetry={refresh} />
      ) : null}
      {status === 'not-found' ? <ErrorState kind="not-found" size="block" /> : null}
      {status === 'gone' ? (
        <EmptyState title="This transcript is no longer available (the file was removed)." icon="alert" />
      ) : null}
      {status === 'ready' && !hasEvents ? <EmptyState title="No events recorded for this session yet." /> : null}
      {noneVisible ? <EmptyState title="No events match the current filters." /> : null}
      <div className="tv-scroller" role="region" aria-label="Transcript events" ref={scrollerRef} onScroll={onScroll}>
        {newestFirst ? resumeButton : null}
        <ol className="tv-list">
          {newestFirst ? null : olderRow}
          {rows}
          {newestFirst ? olderRow : null}
        </ol>
        {newestFirst ? null : resumeButton}
      </div>
    </section>
  );
}

/** Remounts the body for another session or agent, so no filter, open row or search of the old one survives. */
export function TranscriptViewer(props: TranscriptViewerProps) {
  return <TranscriptViewerBody key={`${props.sessionId}|${props.agentId ?? 'main'}`} {...props} />;
}
