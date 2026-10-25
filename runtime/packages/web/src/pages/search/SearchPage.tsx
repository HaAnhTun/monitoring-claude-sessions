import { ENTRY_KINDS, type EntryKind } from '@mcs/shared';
import { useContext, useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { useUrlState } from '../../components/FilterBar.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { describeApiError } from '../../data/api-errors.ts';
import { ApiContext, InstanceIdContext, useInstance } from '../../data/hooks/useInstance.ts';
import { useInstanceSearch, type InstanceSearchState } from '../../data/hooks/useInstanceSearch.ts';
import { useT } from '../../i18n/context.ts';
import { useShortcut } from '../../state/shortcuts-registry.tsx';
import { ROW_LABEL_KEYS } from '../../transcript/TranscriptRow.tsx';
import {
  charCount,
  DEFAULT_BUDGET_MS,
  MAX_QUERY_CHARS,
  MIN_QUERY_CHARS,
  searchSpec,
  toSearchQuery,
} from './search-state.ts';
import { SearchResults } from './SearchResults.tsx';

const SKELETON_ROWS = 4;
const MS_PER_SECOND = 1000;
const BUDGET_NOTE_ID = 'search-budget';

function SearchHeadingOnly() {
  const t = useT();
  const title = t('route.search.title');
  const headingRef = usePageChrome(title);
  return (
    <section className="page search">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
    </section>
  );
}

function SlashFocus({ target }: { target: RefObject<HTMLInputElement | null> }) {
  const t = useT();
  useShortcut(
    '/',
    () => {
      target.current?.focus();
    },
    { description: t('filters.focusSearch') },
  );
  return null;
}

/** Escape cancels the search that is running, wherever the focus is on the page (a dialog that is open keeps its own Escape). */
function CancelOnEscape({ onCancel }: { onCancel: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]') !== null) return;
      event.preventDefault();
      onCancel();
    };
    // In the capture phase, so that it runs before the Escape of the search box (which clears the text) and takes the key.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onCancel]);
  return null;
}

interface SearchFormProps {
  seconds: number;
  inputRef: RefObject<HTMLInputElement | null>;
  draft: string;
  onDraft: (value: string) => void;
  kinds: EntryKind[];
  onKinds: (kinds: EntryKind[]) => void;
  /** Called with the trimmed text and the selected kinds. */
  onSubmit: (q: string, kinds: EntryKind[]) => void;
}

function SearchForm({ seconds, inputRef, draft, onDraft, kinds, onKinds, onSubmit }: SearchFormProps) {
  const t = useT();
  const tooShort = charCount(draft.trim()) === MIN_QUERY_CHARS - 1;
  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (tooShort) {
      inputRef.current?.focus();
      return;
    }
    onSubmit(draft.trim(), kinds);
  }
  return (
    <form className="search-form" role="search" aria-label={t('search.form.label')} onSubmit={submit}>
      <div className="search-form__row">
        <input
          ref={inputRef}
          type="search"
          className="input search-form__q"
          aria-label={t('search.form.query')}
          aria-describedby={BUDGET_NOTE_ID}
          placeholder={t('search.form.placeholder')}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_CHARS}
          value={draft}
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && draft !== '' && !event.defaultPrevented) {
              event.preventDefault();
              onDraft('');
            }
          }}
        />
        <Button type="submit" variant="primary" icon="search">
          {t('search.form.submit')}
        </Button>
      </div>
      <fieldset className="search-form__kinds">
        <legend className="search-form__legend">{t('search.form.kinds')}</legend>
        <div className="tv-chips">
          {ENTRY_KINDS.map((kind) => {
            const on = kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className={on ? 'tv-chip is-on' : 'tv-chip'}
                aria-pressed={on}
                onClick={() => {
                  onKinds(ENTRY_KINDS.filter((other) => (other === kind ? !on : kinds.includes(other))));
                }}
              >
                {on ? <Icon name="check" /> : null}
                {t(ROW_LABEL_KEYS[kind])}
              </button>
            );
          })}
        </div>
        {kinds.length === 0 ? <span className="small muted">{t('search.form.kindsHint')}</span> : null}
      </fieldset>
      {tooShort ? (
        <p className="small search-form__short" role="status">
          {t('search.form.minChars')}
        </p>
      ) : null}
      <p className="small muted" id={BUDGET_NOTE_ID}>
        {t('search.form.budget', { seconds })}
      </p>
    </form>
  );
}

function SearchFailure({ search }: { search: InstanceSearchState }) {
  const t = useT();
  const detail = describeApiError(search.error ?? undefined, t);
  let text: string;
  if (search.dropped) text = t('search.dropped');
  else if (search.error?.info.code === 'search_busy') text = t('search.busy');
  else text = detail === undefined ? t('search.failedPlain') : t('search.failed', { detail });
  return (
    <div className="state state--error state--block" role="status">
      <div className="state__title">
        <Icon name="alert" />
        <span>{text}</span>
      </div>
      <div className="state__actions">
        <Button icon="refresh" onClick={search.search}>
          {t('common.retry')}
        </Button>
      </div>
    </div>
  );
}

function SearchOutcome({ search }: { search: InstanceSearchState }) {
  const t = useT();
  switch (search.status) {
    case 'idle':
      return (
        <EmptyState icon="search" title={t('search.idle.title')}>
          {t('search.idle.body')}
        </EmptyState>
      );
    case 'loading':
      return (
        <div className="search-loading">
          <Skeleton variant="list" rows={SKELETON_ROWS} label={t('search.loading')} />
          <div className="search-loading__bar">
            <span className="small muted">{t('search.cancelHint')}</span>
            <Button variant="quiet" icon="x" onClick={search.cancel}>
              {t('search.cancel')}
            </Button>
          </div>
        </div>
      );
    case 'cancelled':
      return (
        <EmptyState
          icon="x"
          title={t('search.cancelled')}
          primary={{ label: t('search.again'), onClick: search.search }}
        />
      );
    case 'error':
      return <SearchFailure search={search} />;
    case 'ready':
      return search.data === null ? null : <SearchResults response={search.data} />;
  }
}

function Search() {
  const t = useT();
  const title = t('route.search.title');
  const headingRef = usePageChrome(title);
  const instance = useInstance();
  const available = instance.data?.features.transcriptSearch === 'instance';
  const budgetMs = Math.min(DEFAULT_BUDGET_MS, instance.data?.limits.searchBudgetMsMax ?? DEFAULT_BUDGET_MS);

  const [url, setUrl] = useUrlState(searchSpec);
  const [draft, setDraft] = useState(url.q);
  const [kinds, setKinds] = useState(url.kinds);
  // The address changed from outside (the back button, a link): show it in the form.
  const addressKey = JSON.stringify([url.q, url.kinds]);
  const [seenAddress, setSeenAddress] = useState(addressKey);
  if (addressKey !== seenAddress) {
    setSeenAddress(addressKey);
    setDraft(url.q);
    setKinds(url.kinds);
  }

  const query = useMemo(() => (available ? toSearchQuery(url, budgetMs) : null), [available, url, budgetMs]);
  const search = useInstanceSearch(query);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function submit(q: string, selected: EntryKind[]): void {
    const same = q === url.q && selected.join(',') === url.kinds.join(',');
    if (same && query !== null) search.search();
    else setUrl({ q, kinds: selected }, { push: true });
  }

  return (
    <section className="page search">
      <header className="search__header">
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="muted">{t('search.description')}</p>
      </header>
      {available ? (
        <>
          <SlashFocus target={inputRef} />
          {search.status === 'loading' ? <CancelOnEscape onCancel={search.cancel} /> : null}
          <SearchForm
            seconds={Math.round(budgetMs / MS_PER_SECOND)}
            inputRef={inputRef}
            draft={draft}
            onDraft={setDraft}
            kinds={kinds}
            onKinds={setKinds}
            onSubmit={submit}
          />
          <SearchOutcome search={search} />
        </>
      ) : (
        <EmptyState icon="search" title={t('search.unavailable.title')}>
          {t('search.unavailable.body')}
        </EmptyState>
      )}
    </section>
  );
}

/**
 * `/search`: the instance-wide transcript search. It runs only when the form is submitted (or the address already holds a
 * search), shows what was and was not searched, and links every match into the transcript at its entry. Until the app providers
 * are mounted it shows only its heading, so the route never crashes the shell.
 */
export function SearchPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <SearchHeadingOnly /> : <Search />;
}
