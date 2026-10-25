// URL parameter schema (04 section 3.2, UI-I10): one module owns parsing and serialisation of the filter state that lives
// in the query string. A route declares a spec (an object of codecs); parsing is total and never throws, invalid or
// unknown keys fall back to their defaults and are reported by key only (never by value), and formatting omits defaults.
import {
  ACTIVE_STATES,
  BOARD_STATES,
  ENTRY_KINDS,
  EVENT_CATEGORIES,
  LIFECYCLE_STATES,
  PRESETS,
  SESSION_SORTS as API_SESSION_SORTS,
  type BoardState,
  type EntryKind,
  type EventCategory,
  type LifecycleState,
  type Preset,
} from '@mcs/shared';

export const INVALID: unique symbol = Symbol('invalid');

export interface ParamCodec<T> {
  /** The URL key (the primary key of a multi-key codec). */
  readonly key: string;
  /** Every URL key the codec owns when it is more than `key`. */
  readonly keys?: readonly string[];
  /** Omitted from the URL when equal (arrays are compared element-wise). */
  readonly default: T;
  /** Total: never throws. `null` means the key is absent. */
  parse(raw: string | null): T | typeof INVALID;
  /** The canonical text. */
  format(v: T): string;
  /** Multi-key codecs read the whole query instead of one value. */
  parseParams?(sp: URLSearchParams): T | typeof INVALID;
  formatParams?(v: T): [string, string][];
}

export type Spec<S> = { readonly [K in keyof S]: ParamCodec<S[K]> };

export interface Parsed<S> {
  value: S;
  /** Keys that were present but invalid or unknown (keys only, never values). */
  ignored: string[];
}

// ---- engine --------------------------------------------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item: unknown, i) => sameValue(item, b[i]));
  }
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameValue(Reflect.get(a, k), Reflect.get(b, k)))
    );
  }
  return false;
}

function keysOf<S>(spec: Spec<S>): (keyof S & string)[] {
  const keys: (keyof S & string)[] = [];
  for (const k in spec) keys.push(k);
  return keys;
}

function readField<T>(codec: ParamCodec<T>, sp: URLSearchParams): T | typeof INVALID {
  if (codec.parseParams !== undefined) return codec.parseParams(sp);
  const all = sp.getAll(codec.key);
  if (all.length > 1) return INVALID;
  return codec.parse(all[0] ?? null);
}

/** Builds the state object field by field from a spec; the one place that needs a cast, because TypeScript cannot
 * synthesise a value of a mapped generic type key by key. */
function build<S>(spec: Spec<S>, field: <K extends keyof S & string>(key: K, codec: ParamCodec<S[K]>) => S[K]): S {
  const out: Record<string, unknown> = {};
  for (const key of keysOf(spec)) out[key] = field(key, spec[key]);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every key of S was filled from its own codec above
  return out as S;
}

export function parseUrlState<S>(spec: Spec<S>, sp: URLSearchParams): Parsed<S> {
  const ignored = new Set<string>();
  const owned = new Set<string>();
  for (const key of keysOf(spec)) {
    const codec = spec[key];
    for (const k of codec.keys ?? [codec.key]) owned.add(k);
  }
  const value = build(spec, (_key, codec) => {
    const result = readField(codec, sp);
    if (result !== INVALID) return result;
    for (const k of codec.keys ?? [codec.key]) if (sp.has(k)) ignored.add(k);
    return codec.default;
  });
  for (const k of sp.keys()) if (!owned.has(k)) ignored.add(k);
  return { value, ignored: [...ignored] };
}

/** The canonical query: defaults omitted, keys in spec order. */
export function formatUrlState<S>(spec: Spec<S>, s: S): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of keysOf(spec)) {
    const codec = spec[key];
    const v = s[key];
    if (sameValue(v, codec.default)) continue;
    if (codec.formatParams !== undefined) for (const [k, text] of codec.formatParams(v)) out.append(k, text);
    else out.append(codec.key, codec.format(v));
  }
  return out;
}

// ---- codecs --------------------------------------------------------------------------------------------------------------

function capCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Free text: trimmed, capped at `max` characters, default ''. */
export function text(key: string, max: number): ParamCodec<string> {
  return {
    key,
    default: '',
    parse: (raw) => (raw === null ? '' : capCodePoints(raw.trim(), max)),
    format: (v) => v,
  };
}

/** Free-form id such as a project or a model: any characters, capped at 200 (the legacy cap), not trimmed. */
export function idText(key: string): ParamCodec<string> {
  return { key, default: '', parse: (raw) => (raw === null ? '' : capCodePoints(raw, 200)), format: (v) => v };
}

export function oneOf<T extends string>(key: string, values: readonly T[], def: T): ParamCodec<T> {
  return {
    key,
    default: def,
    parse: (raw) => {
      if (raw === null) return def;
      return values.find((v) => v === raw) ?? INVALID;
    },
    format: (v) => v,
  };
}

/**
 * A comma list of members of `values`: deduplicated, in `values` order; any unknown member invalidates the whole value.
 *
 * `aliases` name groups of members (`{ active: ACTIVE_STATES }`): the name in a list stands for all its members, and a list that
 * holds every member of a group is written back as the name, so `?state=active` is already the canonical address and a
 * bookmarked list of the four members reads the same. Only the exact lower-case name is an alias.
 */
export function setOf<T extends string>(
  key: string,
  values: readonly T[],
  aliases: Readonly<Record<string, readonly T[]>> = {},
): ParamCodec<T[]> {
  const names = Object.keys(aliases);
  return {
    key,
    default: [],
    parse: (raw) => {
      if (raw === null || raw === '') return [];
      const members = raw.split(',');
      const known = new Set<string>();
      for (const m of members) {
        const group = Object.hasOwn(aliases, m) ? aliases[m] : undefined;
        if (group !== undefined) {
          for (const member of group) known.add(member);
        } else if (values.some((v) => v === m)) {
          known.add(m);
        } else {
          return INVALID;
        }
      }
      return values.filter((v) => known.has(v));
    },
    format: (v) => {
      if (names.length === 0) return v.join(',');
      const rest = new Set<string>(v);
      const out: string[] = [];
      for (const name of names) {
        const group = aliases[name] ?? [];
        if (group.length > 0 && group.every((member) => rest.has(member))) {
          out.push(name);
          for (const member of group) rest.delete(member);
        }
      }
      for (const member of v) if (rest.has(member)) out.push(member);
      return out.join(',');
    },
  };
}

/** '1' is true; absent is false; anything else is invalid. */
export function flag(key: string): ParamCodec<boolean> {
  return {
    key,
    default: false,
    parse: (raw) => {
      if (raw === null) return false;
      return raw === '1' ? true : INVALID;
    },
    format: () => '1',
  };
}

/** A plain decimal integer within [min, max]; absent is null. */
export function intRange(key: string, min: number, max: number): ParamCodec<number | null> {
  return {
    key,
    default: null,
    parse: (raw) => {
      if (raw === null) return null;
      if (!/^-?\d{1,16}$/.test(raw)) return INVALID;
      const n = Number(raw);
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : INVALID;
    },
    format: (v) => String(v),
  };
}

// ---- time range ----------------------------------------------------------------------------------------------------------

export type { Preset } from '@mcs/shared';
export type TimeRange = { kind: 'preset'; preset: Preset } | { kind: 'custom'; from: string; to: string | null };

function isPreset(raw: string): raw is Preset {
  return PRESETS.some((p) => p === raw);
}

/**
 * `range=<preset>` or `from=<ISO>[&to=<ISO>]` as one field named `range` (spread it into a route spec). A custom range
 * needs a parseable `from` before `to`; dates are normalised to ISO. Mixed forms and `to` without `from` are invalid.
 */
export function timeRange(defaultPreset: Preset): Spec<{ range: TimeRange }> {
  const def: TimeRange = { kind: 'preset', preset: defaultPreset };
  const codec: ParamCodec<TimeRange> = {
    key: 'range',
    keys: ['range', 'from', 'to'],
    default: def,
    parse: (raw) => {
      if (raw === null) return def;
      return isPreset(raw) ? { kind: 'preset', preset: raw } : INVALID;
    },
    format: (v) => (v.kind === 'preset' ? v.preset : v.from),
    parseParams: (sp) => {
      const range = sp.getAll('range');
      const from = sp.getAll('from');
      const to = sp.getAll('to');
      if (range.length > 1 || from.length > 1 || to.length > 1) return INVALID;
      const r = range[0] ?? null;
      const f = from[0] ?? null;
      const t = to[0] ?? null;
      if (r !== null) return f !== null || t !== null ? INVALID : codec.parse(r);
      if (f === null) return t === null ? def : INVALID;
      const fromMs = Date.parse(f);
      if (Number.isNaN(fromMs)) return INVALID;
      const fromIso = new Date(fromMs).toISOString();
      if (t === null) return { kind: 'custom', from: fromIso, to: null };
      const toMs = Date.parse(t);
      if (Number.isNaN(toMs) || !(fromMs < toMs)) return INVALID;
      return { kind: 'custom', from: fromIso, to: new Date(toMs).toISOString() };
    },
    formatParams: (v) => {
      if (v.kind === 'preset') return [['range', v.preset]];
      return v.to === null
        ? [['from', v.from]]
        : [
            ['from', v.from],
            ['to', v.to],
          ];
    },
  };
  return { range: codec };
}

/** The default preset of `/sessions` for the instance window (04 3.2). */
export function defaultPresetForWindow(windowHours: number): Preset {
  if (!Number.isFinite(windowHours)) return '24h';
  if (windowHours <= 1) return '1h';
  if (windowHours <= 6) return '6h';
  if (windowHours <= 24) return '24h';
  if (windowHours <= 168) return '7d';
  return '30d';
}

// ---- route specs (04 3.2 table) --------------------------------------------------------------------------------------------

/**
 * The sorts of `/sessions`: the ones the server knows (`errors` included) and `attention`, which only the UI knows. "Attention
 * first" orders the rows that are loaded (errors, then waiting for you, then quiet, then the rest) and is never sent to the API,
 * because a live list must not reorder itself under the reader (ADR 0073 decision 7).
 */
export const SESSION_SORTS = [...API_SESSION_SORTS, 'attention'] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];
/** A sort the server accepts. */
export type ApiSessionSort = (typeof API_SESSION_SORTS)[number];

/** The sort and direction the `listSessions` request carries: the UI-only `attention` asks for the newest activity first. */
export function apiSortOf(state: Pick<SessionsUrlState, 'sort' | 'dir'>): {
  sort: ApiSessionSort;
  dir: 'asc' | 'desc';
} {
  if (state.sort === 'attention') return { sort: 'lastActivity', dir: 'desc' };
  return { sort: state.sort, dir: state.dir };
}

export interface SessionsUrlState {
  q: string;
  state: LifecycleState[];
  project: string;
  /** The work item id; `task` is the UI-only name (04 3.1 rule 6). */
  task: number | null;
  model: string;
  errors: boolean;
  range: TimeRange;
  tokMin: number | null;
  tokMax: number | null;
  sort: SessionSort;
  dir: 'desc' | 'asc';
  unmatched: boolean;
}

export function sessionsSpec(windowHours: number): Spec<SessionsUrlState> {
  return {
    q: text('q', 200),
    state: setOf('state', LIFECYCLE_STATES, { active: ACTIVE_STATES }),
    project: idText('project'),
    task: intRange('task', 1, Number.MAX_SAFE_INTEGER),
    model: idText('model'),
    errors: flag('errors'),
    ...timeRange(defaultPresetForWindow(windowHours)),
    tokMin: intRange('tokMin', 0, 1e12),
    tokMax: intRange('tokMax', 0, 1e12),
    sort: oneOf('sort', SESSION_SORTS, 'lastActivity'),
    dir: oneOf('dir', ['desc', 'asc'] as const, 'desc'),
    unmatched: flag('unmatched'),
  };
}

/** The tabs of the session page, in the order of the tab bar (ADR 0073 decision 8). `timeline` is the old name of `events`. */
export const DETAIL_TABS = ['transcript', 'errors', 'agents', 'tokens', 'events'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** Old values of `tab` that are still read and written back under their new name. */
export const DETAIL_TAB_ALIASES: Readonly<Record<string, DetailTab>> = { timeline: 'events' };

function detailTab(): ParamCodec<DetailTab> {
  const base = oneOf('tab', DETAIL_TABS, 'transcript');
  return {
    ...base,
    parse: (raw) => {
      const alias = raw === null || !Object.hasOwn(DETAIL_TAB_ALIASES, raw) ? undefined : DETAIL_TAB_ALIASES[raw];
      return alias ?? base.parse(raw);
    },
  };
}

export interface SessionDetailUrlState {
  tab: DetailTab;
  /** '' is the main agent. */
  agent: string;
  /** Transcript index to jump to. */
  i: number | null;
  /** Empty means "use the stored preference". */
  kinds: EntryKind[];
  tq: string;
  tool: string;
  terr: boolean;
  types: EventCategory[];
}

export const sessionDetailSpec: Spec<SessionDetailUrlState> = {
  tab: detailTab(),
  agent: idText('agent'),
  i: intRange('i', 0, 1e9),
  kinds: setOf('kinds', ENTRY_KINDS),
  tq: text('tq', 200),
  tool: idText('tool'),
  terr: flag('terr'),
  types: setOf('types', EVENT_CATEGORIES),
};

export const SEVERITIES = ['info', 'warning', 'error'] as const;

export interface ActivityUrlState {
  types: EventCategory[];
  session: string;
  project: string;
  tool: string;
  severity: (typeof SEVERITIES)[number][];
  q: string;
  range: TimeRange;
}

export const activitySpec: Spec<ActivityUrlState> = {
  types: setOf('types', EVENT_CATEGORIES),
  session: idText('session'),
  project: idText('project'),
  tool: idText('tool'),
  severity: setOf('severity', SEVERITIES),
  q: text('q', 200),
  ...timeRange('24h'),
};

export interface TasksUrlState {
  q: string;
  state: BoardState[];
}

export const tasksSpec: Spec<TasksUrlState> = {
  q: text('q', 200),
  state: setOf('state', BOARD_STATES),
};

export const ANALYTICS_GROUPS = ['model', 'session', 'project', 'task'] as const;

export interface AnalyticsUrlState {
  range: TimeRange;
  by: (typeof ANALYTICS_GROUPS)[number];
  bucket: 'hour' | 'day';
}

export const analyticsSpec: Spec<AnalyticsUrlState> = {
  ...timeRange('7d'),
  by: oneOf('by', ANALYTICS_GROUPS, 'model'),
  bucket: oneOf('bucket', ['hour', 'day'] as const, 'day'),
};

export const SETTINGS_SECTIONS = ['health', 'config', 'preferences', 'data', 'about'] as const;

export interface SettingsUrlState {
  section: (typeof SETTINGS_SECTIONS)[number];
}

export const settingsSpec: Spec<SettingsUrlState> = {
  section: oneOf('section', SETTINGS_SECTIONS, 'health'),
};
