import type { EntryKind } from '@mcs/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type SyntheticEvent } from 'react';
import { Link } from 'react-router';

import { Button } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import { Popover } from '../components/Popover.tsx';
import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { KINDS, type TranscriptFilters } from '../lib/filters.ts';

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

/** The errors of the whole session split by where they happened (ADR 0074 decision 6). */
export interface SessionErrorBreakdown {
  /** Errors of the agent this transcript belongs to. */
  thisAgent: number;
  /** Errors of the subagents of the session. */
  subagents: number;
  /** Link to the Errors tab, which lists every error of the session with its agent. */
  errorsTabHref: string;
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
  /** Receives the text of the jump box; answers whether it could be read (the menu closes then). */
  onJump: (text: string) => boolean;
  jumpError: string | null;
  onLoadOlder: () => void;
  /** Whether older events exist and the window may still grow; "Load older" is in the menu only then. */
  canLoadOlder: boolean;
  olderLoading: boolean;
  counts: TranscriptCounts;
  /** The per-agent against subagent error counts; omitted when the page does not know them. */
  sessionErrors?: SessionErrorBreakdown | undefined;
  searchInputRef?: Ref<HTMLInputElement>;
}

const KIND_LABEL_KEYS = {
  prompt: 'transcript.toolbar.kind.prompt',
  say: 'transcript.toolbar.kind.say',
  think: 'transcript.toolbar.kind.think',
  tool: 'transcript.toolbar.kind.tool',
  result: 'transcript.toolbar.kind.result',
} as const satisfies Record<EntryKind, MessageKey>;

interface SwitchProps {
  label: string;
  tip?: string | undefined;
  checked: boolean;
  onChange: (on: boolean) => void;
}

/** A labelled on/off switch: a button with `role="switch"`, so Space and Enter work and the state is spoken. */
function Switch({ label, tip, checked, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="tv-switch"
      title={tip}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className="tv-switch__track" aria-hidden="true">
        <span className="tv-switch__thumb" />
      </span>
      <span>{label}</span>
    </button>
  );
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
  canLoadOlder,
  olderLoading,
  counts,
  sessionErrors,
  searchInputRef,
}: TranscriptToolbarProps) {
  const t = useT();
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

  /** Enter in the search box also searches the whole transcript for the text (the filter only reads the loaded part). */
  function onSearchSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    if (draft.trim() === '') return;
    commit(draft);
    onSearchWhole(draft);
  }

  const toolOptions =
    filters.tool === '' || toolNames.includes(filters.tool)
      ? toolNames
      : [...toolNames, filters.tool].sort((a, b) => a.localeCompare(b));

  const countLine =
    counts.firstIndex === null || counts.lastIndex === null
      ? t('transcript.countEmpty')
      : t('transcript.count', {
          visible: counts.visible,
          loaded: counts.loaded,
          errors: counts.errors,
          first: String(counts.firstIndex),
          last: String(counts.lastIndex),
          total: counts.total,
        });

  return (
    <div className="tv-toolbar">
      <div className="tv-main" role="search" aria-label={t('transcript.toolbar.label')}>
        <form className="tv-searchform" onSubmit={onSearchSubmit}>
          <input
            ref={searchInputRef}
            type="search"
            className="input tv-q"
            aria-label={t('transcript.toolbar.search')}
            placeholder={t('transcript.toolbar.search')}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              onInput(event.target.value);
            }}
            onKeyDown={onSearchKey}
          />
        </form>
        <div className="tv-controls">
          <Switch
            label={t('transcript.toolbar.errorsOnly')}
            checked={filters.errorsOnly}
            onChange={onErrorsOnlyChange}
          />
          <span className="tv-steps">
            <Button
              variant="icon"
              icon="arrow-up"
              aria-label={t('transcript.toolbar.prevError')}
              title={t('transcript.toolbar.prevError')}
              onClick={onPrevError}
            />
            <Button
              variant="icon"
              icon="arrow-down"
              aria-label={t('transcript.toolbar.nextError')}
              title={t('transcript.toolbar.nextError')}
              onClick={onNextError}
            />
          </span>
          <Switch
            label={t('transcript.toolbar.follow')}
            tip={t('transcript.toolbar.followTip')}
            checked={follow}
            onChange={onFollowChange}
          />
        </div>
        <div className="tv-menus">
          <Popover
            icon="filter"
            label={t('transcript.toolbar.show')}
            panelLabel={t('transcript.toolbar.showPanel')}
            align="end"
          >
            <div className="tv-show">
              <fieldset className="tv-kinds">
                <legend className="tv-show__legend">{t('transcript.toolbar.kinds')}</legend>
                <div className="tv-chips">
                  {KINDS.map((kind) => {
                    const on = filters.kinds[kind];
                    return (
                      <button
                        key={kind}
                        type="button"
                        className={on ? 'tv-chip is-on' : 'tv-chip'}
                        aria-pressed={on}
                        onClick={() => {
                          onKindChange(kind, !on);
                        }}
                      >
                        {on ? <Icon name="check" /> : null}
                        {t(KIND_LABEL_KEYS[kind])}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <label className="tv-check">
                <input
                  type="checkbox"
                  checked={newestFirst}
                  onChange={(event) => {
                    onNewestFirstChange(event.target.checked);
                  }}
                />
                <span>{t('transcript.toolbar.newestFirst')}</span>
              </label>
              <label className="tv-field">
                <span>{t('transcript.toolbar.tool')}</span>
                <select
                  className="input"
                  value={filters.tool}
                  onChange={(event) => {
                    onToolChange(event.target.value);
                  }}
                >
                  <option value="">{t('transcript.toolbar.allTools')}</option>
                  {toolOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Popover>
          <Popover
            variant="icon"
            icon="more"
            ariaLabel={t('transcript.toolbar.more')}
            panelLabel={t('transcript.toolbar.more')}
            align="end"
          >
            {({ close }) => (
              <div className="tv-more">
                <Button
                  variant="quiet"
                  icon="search"
                  onClick={() => {
                    commit(draft);
                    onSearchWhole(draft);
                    close();
                  }}
                >
                  {t('transcript.toolbar.searchWhole')}
                </Button>
                <form
                  className="tv-jump"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (onJump(jumpText)) close();
                  }}
                >
                  <label className="tv-field">
                    <span>{t('transcript.toolbar.jumpTo')}</span>
                    <input
                      type="text"
                      className="input"
                      placeholder={t('transcript.toolbar.jumpHint')}
                      autoComplete="off"
                      spellCheck={false}
                      value={jumpText}
                      onChange={(event) => {
                        setJumpText(event.target.value);
                      }}
                    />
                  </label>
                  <Button type="submit">{t('transcript.toolbar.jump')}</Button>
                  {jumpError === null ? null : <span className="tv-jump__error small">{jumpError}</span>}
                </form>
                {canLoadOlder ? (
                  <Button
                    variant="quiet"
                    icon="clock"
                    loading={olderLoading}
                    onClick={() => {
                      onLoadOlder();
                      close();
                    }}
                  >
                    {t('transcript.loadOlder')}
                  </Button>
                ) : null}
              </div>
            )}
          </Popover>
        </div>
      </div>
      <div className="tv-meta muted small">
        <span className="tv-count">{countLine}</span>
        {sessionErrors === undefined || sessionErrors.subagents <= 0 ? null : (
          <span className="tv-errors">
            <span>
              {t('transcript.errors.breakdown', {
                thisAgent: sessionErrors.thisAgent,
                subagents: sessionErrors.subagents,
              })}
            </span>{' '}
            <Link to={sessionErrors.errorsTabHref}>{t('transcript.errors.viewAll')}</Link>
          </span>
        )}
      </div>
    </div>
  );
}
