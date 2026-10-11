import type { EntryKind } from '@mcs/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type SyntheticEvent } from 'react';

import { Button } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import { KINDS, KIND_LABELS, type TranscriptFilters } from '../lib/filters.ts';

/** The text filter commits this long after the last keystroke (legacy). */
export const QUERY_DEBOUNCE_MS = 150;

export interface TranscriptCounts {
  /** Units not hidden by a filter. */
  visible: number;
  /** Units loaded. */
  loaded: number;
  errors: number;
  firstIndex: number | null;
  lastIndex: number | null;
  total: number;
}

export interface TranscriptToolbarProps {
  /** The committed filters; `filters.q` is the debounced text. */
  filters: TranscriptFilters;
  onQueryChange: (q: string) => void;
  onToolChange: (tool: string) => void;
  onErrorsOnlyChange: (on: boolean) => void;
  onKindChange: (kind: EntryKind, on: boolean) => void;
  /** Distinct tool names of the loaded events; the selected name stays an option when it is no longer loaded. */
  toolNames: readonly string[];
  newestFirst: boolean;
  onNewestFirstChange: (on: boolean) => void;
  follow: boolean;
  onFollowChange: (on: boolean) => void;
  onPrevError: () => void;
  onNextError: () => void;
  /** Receives the text in the box, which may be newer than the committed filter. */
  onSearchWhole: (q: string) => void;
  onJump: (text: string) => void;
  jumpError: string | null;
  onLoadOlder: () => void;
  /** Why "Load older" is unavailable; `null` when it is available. */
  loadOlderDisabledReason: string | null;
  olderLoading: boolean;
  counts: TranscriptCounts;
  searchInputRef?: Ref<HTMLInputElement>;
  searchButtonRef?: Ref<HTMLButtonElement>;
}

function countLine(c: TranscriptCounts): string {
  if (c.firstIndex === null || c.lastIndex === null) return 'No events loaded';
  const errors = `${String(c.errors)} ${c.errors === 1 ? 'error' : 'errors'}`;
  return `Showing ${String(c.visible)} of ${String(c.loaded)} loaded items · ${errors} · events #${String(c.firstIndex)} to #${String(c.lastIndex)} of ${String(c.total)}`;
}

export function TranscriptToolbar({
  filters,
  onQueryChange,
  onToolChange,
  onErrorsOnlyChange,
  onKindChange,
  toolNames,
  newestFirst,
  onNewestFirstChange,
  follow,
  onFollowChange,
  onPrevError,
  onNextError,
  onSearchWhole,
  onJump,
  jumpError,
  onLoadOlder,
  loadOlderDisabledReason,
  olderLoading,
  counts,
  searchInputRef,
  searchButtonRef,
}: TranscriptToolbarProps) {
  const [draft, setDraft] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [jumpText, setJumpText] = useState('');

  // The committed query changed from outside (a jump cleared the filters): show it.
  const [seenQuery, setSeenQuery] = useState(filters.q);
  if (filters.q !== seenQuery) {
    setSeenQuery(filters.q);
    setDraft(filters.q);
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function cancelTimer(): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  function commit(value: string): void {
    cancelTimer();
    if (value !== filters.q) onQueryChange(value);
  }

  function onInput(value: string): void {
    setDraft(value);
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      onQueryChange(value);
    }, QUERY_DEBOUNCE_MS);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape' && draft !== '') {
      event.preventDefault();
      setDraft('');
      commit('');
    }
  }

  function onJumpSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    onJump(jumpText);
  }

  const toolOptions =
    filters.tool === '' || toolNames.includes(filters.tool)
      ? toolNames
      : [...toolNames, filters.tool].sort((a, b) => a.localeCompare(b));

  return (
    <div className="tv-toolbar">
      <form
        className="tv-filters"
        role="search"
        aria-label="Filter transcript"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <input
          ref={searchInputRef}
          type="search"
          className="tv-q"
          aria-label="Search loaded events"
          placeholder="Search loaded events"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            onInput(event.target.value);
          }}
          onKeyDown={onSearchKey}
        />
        <button
          ref={searchButtonRef}
          type="button"
          className="btn"
          onClick={() => {
            commit(draft);
            onSearchWhole(draft);
          }}
        >
          <Icon name="search" />
          Search whole transcript
        </button>
        <label className="tv-field">
          <span>Tool</span>
          <select
            value={filters.tool}
            onChange={(event) => {
              onToolChange(event.target.value);
            }}
          >
            <option value="">All tools</option>
            {toolOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="tv-check">
          <input
            type="checkbox"
            checked={filters.errorsOnly}
            onChange={(event) => {
              onErrorsOnlyChange(event.target.checked);
            }}
          />
          <span>Errors only</span>
        </label>
        <span className="btn-group">
          <Button icon="arrow-up" onClick={onPrevError}>
            Previous error
          </Button>
          <Button icon="arrow-down" onClick={onNextError}>
            Next error
          </Button>
        </span>
      </form>
      <fieldset className="tv-kinds">
        <legend className="sr-only">Show these kinds</legend>
        {KINDS.map((kind) => (
          <label className="tv-check" key={kind}>
            <input
              type="checkbox"
              checked={filters.kinds[kind]}
              onChange={(event) => {
                onKindChange(kind, event.target.checked);
              }}
            />
            <span>{KIND_LABELS[kind]}</span>
          </label>
        ))}
      </fieldset>
      <div className="tv-options">
        <label className="tv-check">
          <input
            type="checkbox"
            checked={newestFirst}
            onChange={(event) => {
              onNewestFirstChange(event.target.checked);
            }}
          />
          <span>Newest first</span>
        </label>
        <label className="tv-check">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => {
              onFollowChange(event.target.checked);
            }}
          />
          <span>Follow new events</span>
        </label>
        <Button
          icon="clock"
          loading={olderLoading}
          disabled={loadOlderDisabledReason !== null}
          title={loadOlderDisabledReason ?? undefined}
          onClick={onLoadOlder}
        >
          Load older
        </Button>
        <form className="tv-jump" onSubmit={onJumpSubmit}>
          <input
            type="text"
            aria-label="Jump to"
            placeholder="#N, HH:MM or ISO time"
            autoComplete="off"
            spellCheck={false}
            value={jumpText}
            onChange={(event) => {
              setJumpText(event.target.value);
            }}
          />
          <Button type="submit">Jump</Button>
          {jumpError === null ? null : <span className="tv-jump__error small">{jumpError}</span>}
        </form>
      </div>
      <p className="tv-count muted small" role="status">
        {countLine(counts)}
      </p>
    </div>
  );
}
