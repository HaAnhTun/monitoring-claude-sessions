import { PRESETS } from '@mcs/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSearchParams } from 'react-router';

import { useFormat, useT } from '../i18n/context.ts';
import type { Formatters } from '../i18n/format.ts';
import type { MessageKey, TFunction } from '../i18n/types.ts';
import { pad2 } from '../lib/format.ts';
import { formatUrlState, parseUrlState, type Preset, type Spec, type TimeRange } from '../lib/url-state.ts';
import { useShortcut } from '../state/shortcuts-registry.tsx';
import { Button } from './Button.tsx';
import { Disclosure } from './Disclosure.tsx';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';

// ---- field model (04-ui.md 4.3) -----------------------------------------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
}

interface FieldBase {
  id: string;
  label: string;
  /**
   * Whether the filter differs from its default, when the page knows better than the field. It counts in "More filters (n)" and
   * decides whether the filter has a chip. Without it the field decides from its value.
   */
  active?: boolean | undefined;
}

export type FilterField =
  | (FieldBase & {
      kind: 'text';
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
      shortcutSlash?: boolean;
    })
  | (FieldBase & {
      kind: 'select';
      value: string;
      options: FilterOption[];
      onChange: (v: string) => void;
      /** The value that means "no filter"; default: the first option. */
      defaultValue?: string;
    })
  | (FieldBase & { kind: 'multi'; value: string[]; options: FilterOption[]; onChange: (v: string[]) => void })
  | (FieldBase & { kind: 'flag'; value: boolean; onChange: (v: boolean) => void })
  | (FieldBase & {
      kind: 'range';
      value: TimeRange;
      onChange: (v: TimeRange) => void;
      /** The range that means "no filter"; without it a range is never counted as an active filter and has no chip. */
      defaultValue?: TimeRange;
    })
  | (FieldBase & {
      kind: 'intRange';
      min: number | null;
      max: number | null;
      onChange: (min: number | null, max: number | null) => void;
    });

export interface FilterBarProps {
  /** Accessible name of the search form. */
  label: string;
  /** Every field of the list, in order. */
  fields: FilterField[];
  /**
   * The fields that sit in the row (matched by `id`). The others of `fields` go to the "More filters" popover and their active
   * values are shown as removable chips. Without it every field is drawn inline, as in V3.
   */
  primary?: FilterField[];
  /** URL keys that were invalid or unknown (keys only, never values). */
  ignoredKeys: string[];
  onDismissIgnored: () => void;
  activeCount: number;
  onClearAll: () => void;
}

/** Typing waits this long before it reaches the address (04 3.2 rule 3). */
export const TEXT_DEBOUNCE_MS = 250;

/**
 * - `legacy`: V3, every field inline with its label in front;
 * - `row`: a compact control in the one-row bar (the label is for screen readers or sits in the control);
 * - `stacked`: label above the control, inside the "More filters" popover.
 */
type Mode = 'legacy' | 'row' | 'stacked';

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
  /** Escape clears a typed text at once (and leaves an empty box). */
  clearOnEscape?: boolean | undefined;
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
  clearOnEscape = false,
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
        if (event.key === 'Enter') {
          event.preventDefault();
          flush();
          return;
        }
        if (event.key === 'Escape' && clearOnEscape) {
          event.preventDefault();
          if (draft === '') {
            event.currentTarget.blur();
            return;
          }
          setDraft('');
          if (committed !== '') send('');
        }
      }}
    />
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

// ---- fields -------------------------------------------------------------------------------------------------------------

function trimText(text: string): string {
  return text.trim();
}

/** A field with its label: in front of the control (V3), above it (popover), or for screen readers only (the row). */
function Labelled({
  mode,
  htmlFor,
  label,
  children,
}: {
  mode: Mode;
  htmlFor: string;
  label: string;
  children: ReactNode;
}) {
  if (mode === 'row') {
    return (
      <>
        <label htmlFor={htmlFor} className="sr-only">
          {label}
        </label>
        {children}
      </>
    );
  }
  return (
    <div className={mode === 'stacked' ? 'filter-bar__stack' : 'filter-bar__field'}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

type FieldOf<K extends FilterField['kind']> = Extract<FilterField, { kind: K }>;

function TextField({ field, mode }: { field: FieldOf<'text'>; mode: Mode }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchBox = mode === 'row' && field.shortcutSlash === true;
  const input = (
    <DebouncedInput
      id={field.id}
      type="text"
      value={field.value}
      onCommit={field.onChange}
      placeholder={field.placeholder ?? (mode === 'row' ? field.label : undefined)}
      inputRef={inputRef}
      normalize={trimText}
      clearOnEscape={mode === 'row'}
    />
  );
  return (
    <>
      {mode === 'row' ? (
        <div className={searchBox ? 'filter-bar__search' : 'filter-bar__text'}>
          {searchBox ? <Icon name="search" /> : null}
          <Labelled mode={mode} htmlFor={field.id} label={field.label}>
            {input}
          </Labelled>
        </div>
      ) : (
        <Labelled mode={mode} htmlFor={field.id} label={field.label}>
          {input}
        </Labelled>
      )}
      {field.shortcutSlash === true ? <SlashFocus target={inputRef} /> : null}
    </>
  );
}

function SelectField({ field, mode }: { field: FieldOf<'select'>; mode: Mode }) {
  return (
    <Labelled mode={mode} htmlFor={field.id} label={field.label}>
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
    </Labelled>
  );
}

function MultiChecks({ field }: { field: FieldOf<'multi'> }) {
  function toggle(value: string, on: boolean): void {
    const next = new Set(field.value);
    if (on) next.add(value);
    else next.delete(value);
    // Members stay in the order of the options, so the same selection always gives the same address.
    field.onChange(field.options.map((option) => option.value).filter((v) => next.has(v)));
  }
  return (
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
  );
}

function MultiField({ field, mode }: { field: FieldOf<'multi'>; mode: Mode }) {
  const t = useT();
  const count = field.value.length;
  const name = count > 0 ? t('filters.multiCount', { label: field.label, count }) : field.label;
  if (mode === 'row') {
    return (
      <Popover
        label={
          <>
            {name}
            <Icon name="chevron-down" />
          </>
        }
        panelLabel={field.label}
      >
        <div className="filter-bar__menu">
          <MultiChecks field={field} />
        </div>
      </Popover>
    );
  }
  if (mode === 'stacked') {
    return (
      <div className="filter-bar__stack">
        <span className="filter-bar__stack-label" aria-hidden="true">
          {field.label}
        </span>
        <MultiChecks field={field} />
      </div>
    );
  }
  return (
    <div className="filter-bar__field filter-bar__field--multi">
      <Disclosure id={`${field.id}-panel`} label={name}>
        <MultiChecks field={field} />
      </Disclosure>
    </div>
  );
}

function FlagField({ field, mode }: { field: FieldOf<'flag'>; mode: Mode }) {
  const className = mode === 'row' ? 'filter-bar__toggle' : 'filter-bar__check';
  const check = (
    <label className={className} htmlFor={field.id}>
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
  );
  return mode === 'row' ? (
    check
  ) : (
    <div className={mode === 'stacked' ? 'filter-bar__stack' : 'filter-bar__field'}>{check}</div>
  );
}

const PRESET_KEYS = {
  '1h': 'filters.range.1h',
  '6h': 'filters.range.6h',
  '24h': 'filters.range.24h',
  '7d': 'filters.range.7d',
  '30d': 'filters.range.30d',
  all: 'filters.range.all',
} as const satisfies Readonly<Record<Preset, MessageKey>>;

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

function RangeField({ field, mode }: { field: FieldOf<'range'>; mode: Mode }) {
  const t = useT();
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
  const select = (
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
          {t(PRESET_KEYS[preset])}
        </option>
      ))}
      <option value={CUSTOM}>{t('filters.range.custom')}</option>
    </select>
  );
  const bounds =
    custom === null ? null : (
      <>
        <label htmlFor={`${field.id}-from`}>{t('filters.range.from')}</label>
        <input
          id={`${field.id}-from`}
          className="input"
          type="datetime-local"
          value={toLocalInput(custom.from)}
          onChange={(event) => {
            onFrom(event.target.value);
          }}
        />
        <label htmlFor={`${field.id}-to`}>{t('filters.range.to')}</label>
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
    );
  if (mode === 'row') {
    return (
      <>
        <label htmlFor={field.id} className="sr-only">
          {field.label}
        </label>
        {select}
        {bounds === null ? null : <div className="filter-bar__bounds">{bounds}</div>}
      </>
    );
  }
  return (
    <div className={mode === 'stacked' ? 'filter-bar__stack' : 'filter-bar__field'}>
      <label htmlFor={field.id}>{field.label}</label>
      {select}
      {bounds}
    </div>
  );
}

/** '' is "no bound"; a whole number is a bound; anything else is not committed. */
function parseBound(text: string): { ok: true; value: number | null } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

function IntRangeField({ field, mode }: { field: FieldOf<'intRange'>; mode: Mode }) {
  const t = useT();
  const text = (n: number | null): string => (n === null ? '' : String(n));
  function commit(which: 'min' | 'max', next: string): void {
    const parsed = parseBound(next);
    if (!parsed.ok) return;
    if (which === 'min') field.onChange(parsed.value, field.max);
    else field.onChange(field.min, parsed.value);
  }
  return (
    <div
      className={
        mode === 'stacked' ? 'filter-bar__stack filter-bar__field--range' : 'filter-bar__field filter-bar__field--range'
      }
    >
      <label htmlFor={`${field.id}-min`}>{t('filters.min', { label: field.label })}</label>
      <DebouncedInput
        id={`${field.id}-min`}
        type="number"
        value={text(field.min)}
        onCommit={(next) => {
          commit('min', next);
        }}
      />
      <label htmlFor={`${field.id}-max`}>{t('filters.max', { label: field.label })}</label>
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

function renderField(field: FilterField, mode: Mode): ReactNode {
  switch (field.kind) {
    case 'text':
      return <TextField key={field.id} field={field} mode={mode} />;
    case 'select':
      return <SelectField key={field.id} field={field} mode={mode} />;
    case 'multi':
      return <MultiField key={field.id} field={field} mode={mode} />;
    case 'flag':
      return <FlagField key={field.id} field={field} mode={mode} />;
    case 'range':
      return <RangeField key={field.id} field={field} mode={mode} />;
    case 'intRange':
      return <IntRangeField key={field.id} field={field} mode={mode} />;
  }
}

// ---- active filters: which are on, what they say, how to turn them off --------------------------------------------------

function sameRange(a: TimeRange, b: TimeRange): boolean {
  if (a.kind === 'preset') return b.kind === 'preset' && a.preset === b.preset;
  return b.kind === 'custom' && a.from === b.from && a.to === b.to;
}

/** Whether the field holds a filter. */
function isActive(field: FilterField): boolean {
  if (field.active !== undefined) return field.active;
  switch (field.kind) {
    case 'text':
      return field.value !== '';
    case 'select':
      return field.value !== (field.defaultValue ?? field.options[0]?.value ?? '');
    case 'multi':
      return field.value.length > 0;
    case 'flag':
      return field.value;
    case 'range':
      return field.defaultValue !== undefined && !sameRange(field.value, field.defaultValue);
    case 'intRange':
      return field.min !== null || field.max !== null;
  }
}

/** Puts the field back to "no filter"; null for a field that cannot be turned off from here. */
function clearerOf(field: FilterField): (() => void) | null {
  switch (field.kind) {
    case 'text':
      return () => {
        field.onChange('');
      };
    case 'select': {
      const empty = field.defaultValue ?? field.options[0]?.value;
      return empty === undefined
        ? null
        : () => {
            field.onChange(empty);
          };
    }
    case 'multi':
      return () => {
        field.onChange([]);
      };
    case 'flag':
      return () => {
        field.onChange(false);
      };
    case 'range': {
      const empty = field.defaultValue;
      return empty === undefined
        ? null
        : () => {
            field.onChange(empty);
          };
    }
    case 'intRange':
      return () => {
        field.onChange(null, null);
      };
  }
}

/** What a chip says about the value of its field; '' for a flag, whose label is the whole chip. */
function summaryOf(field: FilterField, t: TFunction, format: Formatters): string {
  switch (field.kind) {
    case 'text':
      return field.value;
    case 'select':
      return field.options.find((option) => option.value === field.value)?.label ?? field.value;
    case 'multi':
      return field.options
        .filter((option) => field.value.includes(option.value))
        .map((option) => option.label)
        .join(', ');
    case 'flag':
      return '';
    case 'range': {
      const { value } = field;
      if (value.kind === 'preset') return t(PRESET_KEYS[value.preset]);
      return value.to === null
        ? t('filters.range.since', { from: format.dateTime(value.from) })
        : t('filters.range.customValue', { from: format.dateTime(value.from), to: format.dateTime(value.to) });
    }
    case 'intRange': {
      if (field.min !== null && field.max !== null) {
        return t('filters.bounds.both', { min: format.number(field.min), max: format.number(field.max) });
      }
      if (field.min !== null) return t('filters.bounds.min', { min: format.number(field.min) });
      return field.max === null ? '' : t('filters.bounds.max', { max: format.number(field.max) });
    }
  }
}

interface Chip {
  id: string;
  label: string;
  text: string;
  clear: () => void;
}

function chipsOf(fields: readonly FilterField[], t: TFunction, format: Formatters): Chip[] {
  const chips: Chip[] = [];
  for (const field of fields) {
    if (!isActive(field)) continue;
    const clear = clearerOf(field);
    if (clear === null) continue;
    const summary = summaryOf(field, t, format);
    chips.push({
      id: field.id,
      label: field.label,
      text: summary === '' ? field.label : t('filters.chip', { label: field.label, value: summary }),
      clear,
    });
  }
  return chips;
}

function ClearButton({
  count,
  onClear,
  ref,
}: {
  count: number;
  onClear: () => void;
  ref?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const t = useT();
  return (
    <Button {...(ref === undefined ? {} : { ref })} variant="quiet" icon="x" onClick={onClear}>
      {t('filters.clearCount', { count })}
    </Button>
  );
}

interface ActiveChipsProps {
  chips: Chip[];
  onClearAll: () => void;
  activeCount: number;
  /** The form: where the focus goes when the last chip is gone and nothing else of the row is left to take it. */
  formRef: RefObject<HTMLFormElement | null>;
}

function ActiveChips({ chips, onClearAll, activeCount, formRef }: ActiveChipsProps) {
  const t = useT();
  const listRef = useRef<HTMLUListElement | null>(null);
  // Set by the click that removes a chip, read once the chips have shrunk.
  const removedRef = useRef<{ index: number; count: number } | null>(null);
  const clearRef = useRef<HTMLButtonElement | null>(null);

  // After a chip is removed the focus goes to the chip that took its place, else to "Clear filters", so it is never lost.
  useLayoutEffect(() => {
    const removed = removedRef.current;
    if (removed === null) return;
    removedRef.current = null;
    if (chips.length >= removed.count) return;
    const removeButtons = listRef.current?.querySelectorAll<HTMLButtonElement>('button.chip__remove') ?? [];
    const target =
      removeButtons[Math.min(removed.index, removeButtons.length - 1)] ??
      clearRef.current ??
      formRef.current?.querySelector<HTMLElement>('.filter-bar__end button');
    target?.focus();
  }, [chips.length, formRef]);

  if (chips.length === 0) return null;
  return (
    <div className="filter-bar__active">
      <ul className="filter-bar__chips" ref={listRef} aria-label={t('filters.active')}>
        {chips.map((chip, index) => (
          <li key={chip.id} className="chip chip--filter">
            <span className="filter-bar__chip-text" title={chip.text}>
              {chip.text}
            </span>
            <button
              type="button"
              className="chip__remove"
              aria-label={t('filters.remove', { label: chip.label })}
              onClick={() => {
                removedRef.current = { index, count: chips.length };
                chip.clear();
              }}
            >
              <Icon name="x" />
            </button>
          </li>
        ))}
      </ul>
      {activeCount > 0 ? <ClearButton ref={clearRef} count={activeCount} onClear={onClearAll} /> : null}
    </div>
  );
}

function IgnoredNote({ keys, onDismiss }: { keys: string[]; onDismiss: () => void }) {
  const t = useT();
  if (keys.length === 0) return null;
  return (
    <p className="filter-bar__ignored" role="status">
      <span>{t('filters.ignored', { keys: keys.join(', ') })}</span>
      <Button variant="quiet" onClick={onDismiss}>
        {t('filters.dismiss')}
      </Button>
    </p>
  );
}

/**
 * The filter form shared by the list pages. With `primary` it is one row (search, the primary controls, "More filters (n)") and a
 * line of removable chips for the hidden filters that are on; without it every field is drawn inline, as in V3.
 */
export function FilterBar({
  label,
  fields,
  primary,
  ignoredKeys,
  onDismissIgnored,
  activeCount,
  onClearAll,
}: FilterBarProps) {
  const t = useT();
  const format = useFormat();
  const primaryIds = useMemo(() => new Set((primary ?? []).map((field) => field.id)), [primary]);
  const more = useMemo(() => fields.filter((field) => !primaryIds.has(field.id)), [fields, primaryIds]);
  const chips = useMemo(() => chipsOf(more, t, format), [more, t, format]);
  const formRef = useRef<HTMLFormElement | null>(null);

  if (primary === undefined) {
    return (
      <form
        role="search"
        aria-label={label}
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="filter-bar__fields">{fields.map((field) => renderField(field, 'legacy'))}</div>
        {activeCount > 0 ? (
          <Button variant="quiet" icon="x" onClick={onClearAll}>
            {t('filters.clearCount', { count: activeCount })}
          </Button>
        ) : null}
        <IgnoredNote keys={ignoredKeys} onDismiss={onDismissIgnored} />
      </form>
    );
  }

  const hidden = more.filter(isActive).length;
  // Without chips the clear button joins the row, so a filtered list does not get a line of its own for it.
  const clearInRow = chips.length === 0 && activeCount > 0;
  return (
    <form
      ref={formRef}
      role="search"
      aria-label={label}
      className="filter-bar filter-bar--row"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="filter-bar__row">
        {primary.map((field) => renderField(field, 'row'))}
        {more.length === 0 && !clearInRow ? null : (
          <div className="filter-bar__end">
            {more.length === 0 ? null : (
              <div className="filter-bar__more">
                <Popover
                  icon="filter"
                  label={
                    <>
                      {hidden > 0 ? t('filters.moreCount', { count: hidden }) : t('filters.more')}
                      <Icon name="chevron-down" />
                    </>
                  }
                  panelLabel={t('filters.more')}
                  align="end"
                >
                  <div className="filter-bar__panel">{more.map((field) => renderField(field, 'stacked'))}</div>
                </Popover>
              </div>
            )}
            {clearInRow ? <ClearButton count={activeCount} onClear={onClearAll} /> : null}
          </div>
        )}
      </div>
      <ActiveChips chips={chips} onClearAll={onClearAll} activeCount={activeCount} formRef={formRef} />
      <IgnoredNote keys={ignoredKeys} onDismiss={onDismissIgnored} />
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
