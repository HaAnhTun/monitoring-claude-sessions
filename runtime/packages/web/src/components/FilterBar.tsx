import { PRESETS } from '@mcs/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSearchParams } from 'react-router';

import { pad2 } from '../lib/format.ts';
import { formatUrlState, parseUrlState, type Preset, type Spec, type TimeRange } from '../lib/url-state.ts';
import { useShortcut } from '../state/shortcuts-registry.tsx';
import { Button } from './Button.tsx';
import { Disclosure } from './Disclosure.tsx';

// ---- field model (04-ui.md 4.3) -----------------------------------------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterField =
  | {
      kind: 'text';
      id: string;
      label: string;
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
      shortcutSlash?: boolean;
    }
  | { kind: 'select'; id: string; label: string; value: string; options: FilterOption[]; onChange: (v: string) => void }
  | {
      kind: 'multi';
      id: string;
      label: string;
      value: string[];
      options: FilterOption[];
      onChange: (v: string[]) => void;
    }
  | { kind: 'flag'; id: string; label: string; value: boolean; onChange: (v: boolean) => void }
  | { kind: 'range'; id: string; label: string; value: TimeRange; onChange: (v: TimeRange) => void }
  | {
      kind: 'intRange';
      id: string;
      label: string;
      min: number | null;
      max: number | null;
      onChange: (min: number | null, max: number | null) => void;
    };

export interface FilterBarProps {
  /** Accessible name of the search form. */
  label: string;
  fields: FilterField[];
  /** URL keys that were invalid or unknown (keys only, never values). */
  ignoredKeys: string[];
  onDismissIgnored: () => void;
  activeCount: number;
  onClearAll: () => void;
}

/** Typing waits this long before it reaches the address (04 3.2 rule 3). */
export const TEXT_DEBOUNCE_MS = 250;

// ---- text input with local state ----------------------------------------------------------------------------------------

interface DebouncedInputProps {
  id: string;
  type: 'text' | 'number';
  /** The committed value (from the address). */
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string | undefined;
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  /** What the address will hold for a typed text (trimming); the committed value and the echo are compared in this form. */
  normalize?: ((text: string) => string) | undefined;
}

/**
 * A text box that keeps what the user types and reports it 250 ms after the last key (at once on Enter or when it loses
 * focus). A value that arrives from outside (clear all, the back button) replaces the draft; the echo of its own commit does
 * not, so keystrokes made while the address updates are never lost.
 */
function identity(text: string): string {
  return text;
}

function DebouncedInput({
  id,
  type,
  value,
  onCommit,
  placeholder,
  inputRef,
  normalize = identity,
}: DebouncedInputProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== committed) {
      setDraft(value);
      setCommitted(value);
    }
  }

  const send = (next: string): void => {
    const normalized = normalize(next);
    setCommitted(normalized);
    onCommit(normalized);
  };
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });

  useEffect(() => {
    if (normalize(draft) === committed) return undefined;
    const timer = setTimeout(() => {
      sendRef.current(draft);
    }, TEXT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, committed, normalize]);

  const flush = (): void => {
    if (normalize(draft) !== committed) send(draft);
  };

  return (
    <input
      ref={inputRef}
      id={id}
      className="input"
      type={type}
      {...(type === 'number' ? { min: 0, inputMode: 'numeric' as const } : {})}
      value={draft}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
      }}
      onBlur={flush}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        flush();
      }}
    />
  );
}

function SlashFocus({ target }: { target: RefObject<HTMLInputElement | null> }) {
  useShortcut(
    '/',
    () => {
      target.current?.focus();
    },
    { description: 'Focus the search field' },
  );
  return null;
}

// ---- fields -------------------------------------------------------------------------------------------------------------

function trimText(text: string): string {
  return text.trim();
}

function TextField({ field }: { field: Extract<FilterField, { kind: 'text' }> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="filter-bar__field">
      <label htmlFor={field.id}>{field.label}</label>
      <DebouncedInput
        id={field.id}
        type="text"
        value={field.value}
        onCommit={field.onChange}
        placeholder={field.placeholder}
        inputRef={inputRef}
        normalize={trimText}
      />
      {field.shortcutSlash === true ? <SlashFocus target={inputRef} /> : null}
    </div>
  );
}

function SelectField({ field }: { field: Extract<FilterField, { kind: 'select' }> }) {
  return (
    <div className="filter-bar__field">
      <label htmlFor={field.id}>{field.label}</label>
      <select
        id={field.id}
        className="input"
        value={field.value}
        onChange={(event) => {
          field.onChange(event.target.value);
        }}
      >
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function MultiField({ field }: { field: Extract<FilterField, { kind: 'multi' }> }) {
  const count = field.value.length;
  function toggle(value: string, on: boolean): void {
    const next = new Set(field.value);
    if (on) next.add(value);
    else next.delete(value);
    // Members stay in the order of the options, so the same selection always gives the same address.
    field.onChange(field.options.map((option) => option.value).filter((v) => next.has(v)));
  }
  return (
    <div className="filter-bar__field filter-bar__field--multi">
      <Disclosure id={`${field.id}-panel`} label={count > 0 ? `${field.label} (${String(count)})` : field.label}>
        <fieldset className="filter-bar__group">
          <legend className="sr-only">{field.label}</legend>
          {field.options.map((option) => (
            <label key={option.value} className="filter-bar__check">
              <input
                type="checkbox"
                checked={field.value.includes(option.value)}
                onChange={(event) => {
                  toggle(option.value, event.target.checked);
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      </Disclosure>
    </div>
  );
}

function FlagField({ field }: { field: Extract<FilterField, { kind: 'flag' }> }) {
  return (
    <div className="filter-bar__field">
      <label className="filter-bar__check" htmlFor={field.id}>
        <input
          id={field.id}
          type="checkbox"
          checked={field.value}
          onChange={(event) => {
            field.onChange(event.target.checked);
          }}
        />
        <span>{field.label}</span>
      </label>
    </div>
  );
}

const PRESET_LABELS: Readonly<Record<Preset, string>> = {
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

const CUSTOM = 'custom';
const DAY_MS = 86_400_000;

function toLocalInput(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The local `datetime-local` text as an ISO time; null when empty or not a time. */
function fromLocalInput(text: string): string | null {
  if (text === '') return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function isPreset(value: string): value is Preset {
  return PRESETS.some((preset) => preset === value);
}

function RangeField({ field }: { field: Extract<FilterField, { kind: 'range' }> }) {
  const { value } = field;
  const custom = value.kind === 'custom' ? value : null;
  function onSelect(next: string): void {
    if (isPreset(next)) field.onChange({ kind: 'preset', preset: next });
    else if (next === CUSTOM) {
      field.onChange({ kind: 'custom', from: new Date(Date.now() - DAY_MS).toISOString(), to: null });
    }
  }
  function onFrom(text: string): void {
    const from = fromLocalInput(text);
    if (custom === null || from === null) return;
    if (custom.to !== null && Date.parse(from) >= Date.parse(custom.to)) return;
    field.onChange({ kind: 'custom', from, to: custom.to });
  }
  function onTo(text: string): void {
    if (custom === null) return;
    if (text === '') {
      field.onChange({ kind: 'custom', from: custom.from, to: null });
      return;
    }
    const to = fromLocalInput(text);
    if (to === null || Date.parse(to) <= Date.parse(custom.from)) return;
    field.onChange({ kind: 'custom', from: custom.from, to });
  }
  return (
    <div className="filter-bar__field">
      <label htmlFor={field.id}>{field.label}</label>
      <select
        id={field.id}
        className="input"
        value={value.kind === 'preset' ? value.preset : CUSTOM}
        onChange={(event) => {
          onSelect(event.target.value);
        }}
      >
        {PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {PRESET_LABELS[preset]}
          </option>
        ))}
        <option value={CUSTOM}>Custom range</option>
      </select>
      {custom === null ? null : (
        <>
          <label htmlFor={`${field.id}-from`}>From</label>
          <input
            id={`${field.id}-from`}
            className="input"
            type="datetime-local"
            value={toLocalInput(custom.from)}
            onChange={(event) => {
              onFrom(event.target.value);
            }}
          />
          <label htmlFor={`${field.id}-to`}>To</label>
          <input
            id={`${field.id}-to`}
            className="input"
            type="datetime-local"
            value={custom.to === null ? '' : toLocalInput(custom.to)}
            onChange={(event) => {
              onTo(event.target.value);
            }}
          />
        </>
      )}
    </div>
  );
}

/** '' is "no bound"; a whole number is a bound; anything else is not committed. */
function parseBound(text: string): { ok: true; value: number | null } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

function IntRangeField({ field }: { field: Extract<FilterField, { kind: 'intRange' }> }) {
  const text = (n: number | null): string => (n === null ? '' : String(n));
  function commit(which: 'min' | 'max', next: string): void {
    const parsed = parseBound(next);
    if (!parsed.ok) return;
    if (which === 'min') field.onChange(parsed.value, field.max);
    else field.onChange(field.min, parsed.value);
  }
  return (
    <div className="filter-bar__field filter-bar__field--range">
      <label htmlFor={`${field.id}-min`}>{`${field.label} min`}</label>
      <DebouncedInput
        id={`${field.id}-min`}
        type="number"
        value={text(field.min)}
        onCommit={(next) => {
          commit('min', next);
        }}
      />
      <label htmlFor={`${field.id}-max`}>{`${field.label} max`}</label>
      <DebouncedInput
        id={`${field.id}-max`}
        type="number"
        value={text(field.max)}
        onCommit={(next) => {
          commit('max', next);
        }}
      />
    </div>
  );
}

function renderField(field: FilterField): ReactNode {
  switch (field.kind) {
    case 'text':
      return <TextField key={field.id} field={field} />;
    case 'select':
      return <SelectField key={field.id} field={field} />;
    case 'multi':
      return <MultiField key={field.id} field={field} />;
    case 'flag':
      return <FlagField key={field.id} field={field} />;
    case 'range':
      return <RangeField key={field.id} field={field} />;
    case 'intRange':
      return <IntRangeField key={field.id} field={field} />;
  }
}

/** The filter form shared by the list pages: a search landmark, the fields in order, "Clear filters" and the ignored-keys note. */
export function FilterBar({ label, fields, ignoredKeys, onDismissIgnored, activeCount, onClearAll }: FilterBarProps) {
  return (
    <form
      role="search"
      aria-label={label}
      className="filter-bar"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="filter-bar__fields">{fields.map(renderField)}</div>
      {activeCount > 0 ? (
        <Button variant="quiet" icon="x" onClick={onClearAll}>
          {`Clear filters (${String(activeCount)})`}
        </Button>
      ) : null}
      {ignoredKeys.length > 0 ? (
        <p className="filter-bar__ignored" role="status">
          <span>{`Ignored invalid or unknown filter: ${ignoredKeys.join(', ')}`}</span>
          <Button variant="quiet" onClick={onDismissIgnored}>
            Dismiss
          </Button>
        </p>
      ) : null}
    </form>
  );
}

// ---- URL state (04-ui.md 3.2) -------------------------------------------------------------------------------------------

export interface SetUrlStateOptions {
  /** Add a history entry instead of replacing the current one (route and tab changes push, filters replace). */
  push?: boolean;
}
export type SetUrlState<S> = (patch: Partial<S>, options?: SetUrlStateOptions) => void;

/**
 * The filter state of the current route, read from and written to the query string through the spec of `lib/url-state.ts`.
 * Invalid or unknown keys fall back to their defaults and the address is replaced once with the canonical form; the keys are
 * returned (and kept) so the page can tell the user. Cursors, loaded pages and scroll positions never live here.
 */
export function useUrlState<S extends object>(spec: Spec<S>): [S, SetUrlState<S>, string[]] {
  const [searchParams, setSearchParams] = useSearchParams();
  const parsed = useMemo(() => parseUrlState(spec, searchParams), [spec, searchParams]);
  const canonical = useMemo(() => formatUrlState(spec, parsed.value).toString(), [spec, parsed.value]);

  // The ignored keys of the last address that had any: the canonical replace below removes them from the address itself.
  const [seenParams, setSeenParams] = useState(searchParams);
  const [ignored, setIgnored] = useState<string[]>(() => [...parsed.ignored].sort());
  if (searchParams !== seenParams) {
    setSeenParams(searchParams);
    if (parsed.ignored.length > 0) setIgnored([...parsed.ignored].sort());
  }

  useEffect(() => {
    if (parsed.ignored.length > 0 || canonical !== searchParams.toString()) {
      setSearchParams(new URLSearchParams(canonical), { replace: true });
    }
  }, [parsed, canonical, searchParams, setSearchParams]);

  const setState = useCallback<SetUrlState<S>>(
    (patch, options = {}) => {
      setSearchParams((previous) => formatUrlState(spec, { ...parseUrlState(spec, previous).value, ...patch }), {
        replace: options.push !== true,
      });
    },
    [spec, setSearchParams],
  );

  return [parsed.value, setState, ignored];
}
