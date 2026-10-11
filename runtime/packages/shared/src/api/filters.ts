// The typed filter model (03 5.4, brief 8.5): one strict Zod schema per list route, composed from shared field schemas,
// plus the pure functions the UI, the CLI and the server share: `fromQuery` / `toQuery` (URL mapping with a round trip),
// `matchesEventFilter` (the predicate the UI's live buffers use and the server's SQL is tested against) with `foldQuery`
// (the fold of a `q` needle) and `resolveTimeWindow` (presets resolve with the server clock). Parameters combine with
// AND, values inside one list with OR.
//
// Query values arrive as text. Lists are comma-separated in one key, flags are `1`, numbers are plain decimal digits
// (never `z.coerce`, which would accept `''`, `'1e3'` or `'0x10'`), and times are ISO-8601 with `Z` or an offset.
import { z } from 'zod';

import {
  ACTIVE_STATES,
  AGENT_KINDS,
  ALERT_RULE_KINDS,
  BOARD_STATES,
  ENTRY_KINDS,
  EVENT_CATEGORIES,
  EVENT_KINDS,
  LIFECYCLE_STATES,
  TOOL_STATUSES,
  type ActivityEvent,
  type LifecycleState,
} from './entities.ts';
import type { ErrorCode } from './errors.ts';
import {
  AgentIdSchema,
  EpochSchema,
  ModelIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  ToolNameSchema,
  intString,
} from './ids.ts';
import type { PanelKey } from './panels.ts';
import { IsoTimeInputSchema, type IsoTime } from './time.ts';

const MAX_INT = Number.MAX_SAFE_INTEGER;

// ---- field schemas -------------------------------------------------------------------------------------------------

/** `1h 6h 24h 7d 30d all`; presets resolve with the server clock. */
export const PRESETS = ['1h', '6h', '24h', '7d', '30d', 'all'] as const;
export const PresetSchema = z.enum(PRESETS);
export type Preset = z.infer<typeof PresetSchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const PRESET_MS: Readonly<Record<Exclude<Preset, 'all'>, number>> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

/** A comma-separated list of 1..`max` values, each checked by `item`. */
export function csvOf<S extends z.ZodType<unknown, string>>(item: S, max: number) {
  return z
    .string()
    .transform((text) => text.split(','))
    .pipe(z.array(item).min(1).max(max));
}

/** A flag: the text `1` means true; any other text is refused. */
export const flagParam = z.literal('1').transform((): true => true);

/** Text trimmed to `min..max` characters. A too-short `q` is reported as `query_too_short` (see `classifyQueryIssues`). */
export function textOf(min: number, max: number) {
  return z
    .string()
    .transform((text) => text.trim())
    .pipe(z.string().min(min).max(max));
}

const STATE_FILTER_VALUES = [...LIFECYCLE_STATES, 'active'] as const;
const StateFilterSchema = z.enum(STATE_FILTER_VALUES);
export type StateFilterValue = z.infer<typeof StateFilterSchema>;

const DirSchema = z.enum(['asc', 'desc']);
const SeveritySchema = z.enum(['info', 'warning', 'error']);
const CursorParam = z.string().min(1).max(512);

/** Expands the alias `active` and removes duplicates; the order of first appearance is kept. */
export function expandStateFilter(states: readonly StateFilterValue[]): LifecycleState[] {
  const out: LifecycleState[] = [];
  for (const state of states) {
    for (const concrete of state === 'active' ? ACTIVE_STATES : [state]) {
      if (!out.includes(concrete)) out.push(concrete);
    }
  }
  return out;
}

const f = {
  q: textOf(2, 200),
  state: csvOf(StateFilterSchema, 10),
  presence: csvOf(z.enum(['open', 'ended', 'unknown']), 3),
  project: csvOf(ProjectIdSchema, 20),
  workItem: intString(1, MAX_INT),
  session: csvOf(SessionIdSchema, 50),
  agent: AgentIdSchema,
  type: csvOf(z.enum(EVENT_KINDS), 40),
  category: csvOf(z.enum(EVENT_CATEGORIES), 8),
  severity: csvOf(SeveritySchema, 3),
  tool: csvOf(ToolNameSchema, 20),
  status: csvOf(z.enum(TOOL_STATUSES), 6),
  model: csvOf(ModelIdSchema, 10),
  hasErrors: flagParam,
  includeInternal: flagParam,
  range: PresetSchema,
  from: IsoTimeInputSchema,
  to: IsoTimeInputSchema,
  window: flagParam,
  includeUnmatched: flagParam,
  dir: DirSchema,
  cursor: CursorParam,
  includeTotal: flagParam,
};

const opt = <S extends z.ZodType>(schema: S) => schema.optional();

/** `range`, `from`, `to`: the explicit-time group of 5.4. */
const timeShape = { range: opt(f.range), from: opt(f.from), to: opt(f.to) };
/** The same group plus `window=1`. */
const windowedTimeShape = { ...timeShape, window: opt(f.window) };

function pagingShape<const Sorts extends readonly [string, ...string[]]>(
  sorts: Sorts,
  defaultLimit: number,
  maxLimit: number,
) {
  return {
    sort: z.enum(sorts).default(sorts[0]),
    dir: opt(f.dir),
    cursor: opt(f.cursor),
    limit: intString(1, maxLimit).default(defaultLimit),
  };
}

function agentNeedsOneSession(q: { agent?: string | undefined; session?: readonly string[] | undefined }): boolean {
  return q.agent === undefined || q.session?.length === 1;
}

const AGENT_NEEDS_SESSION = { message: 'agent requires exactly one session', path: ['agent'] };

// ---- list routes ---------------------------------------------------------------------------------------------------

export const SESSION_SORTS = ['lastActivity', 'started', 'duration', 'tokens', 'state', 'label', 'errors'] as const;
export const AGENT_SORTS = ['lastActivity', 'started'] as const;
export const TOOL_CALL_SORTS = ['started', 'duration'] as const;

export const SessionListQuerySchema = z
  .strictObject({
    q: opt(f.q),
    state: opt(f.state),
    presence: opt(f.presence),
    project: opt(f.project),
    workItem: opt(f.workItem),
    model: opt(f.model),
    hasErrors: opt(f.hasErrors),
    ...windowedTimeShape,
    tokensMin: opt(intString(0, 1e15)),
    tokensMax: opt(intString(0, 1e15)),
    includeUnmatched: opt(f.includeUnmatched),
    ...pagingShape(SESSION_SORTS, 50, 200),
    /** Only the session list counts its rows (capped at 10000). */
    includeTotal: opt(f.includeTotal),
  })
  .refine((q) => q.tokensMin === undefined || q.tokensMax === undefined || q.tokensMin <= q.tokensMax, {
    message: 'tokensMin must not exceed tokensMax',
    path: ['tokensMin'],
  });
export type SessionListQuery = z.output<typeof SessionListQuerySchema>;

export const AgentListQuerySchema = z.strictObject({
  state: opt(f.state),
  kind: opt(csvOf(z.enum(AGENT_KINDS), 5)),
  q: opt(f.q),
  session: opt(f.session),
  project: opt(f.project),
  hasErrors: opt(f.hasErrors),
  includeInternal: opt(f.includeInternal),
  ...windowedTimeShape,
  includeUnmatched: opt(f.includeUnmatched),
  ...pagingShape(AGENT_SORTS, 50, 200),
});
export type AgentListQuery = z.output<typeof AgentListQuerySchema>;

export const SessionAgentsQuerySchema = z.strictObject({
  state: opt(f.state),
  includeInternal: opt(f.includeInternal),
  cursor: opt(f.cursor),
  limit: intString(1, 500).default(200),
});
export type SessionAgentsQuery = z.output<typeof SessionAgentsQuerySchema>;

const eventFilterShape = {
  type: opt(f.type),
  category: opt(f.category),
  severity: opt(f.severity),
  agent: opt(f.agent),
  workItem: opt(f.workItem),
  tool: opt(f.tool),
  q: opt(f.q),
  ...timeShape,
  dir: opt(f.dir),
  cursor: opt(f.cursor),
  /** At most 200, and up to 500 only with `afterId` (the live tail). */
  limit: intString(1, 500).default(100),
  around: opt(intString(1, MAX_INT)),
  afterId: opt(intString(1, MAX_INT)),
};

function eventModes(q: { around?: number | undefined; afterId?: number | undefined; limit: number }): boolean {
  return !(q.around !== undefined && q.afterId !== undefined);
}
const EVENT_MODES = { message: 'around and afterId cannot be combined', path: ['around'] };
function eventLimit(q: { afterId?: number | undefined; limit: number }): boolean {
  return q.limit <= 200 || q.afterId !== undefined;
}
const EVENT_LIMIT = { message: 'limit is at most 200 (500 with afterId)', path: ['limit'] };

export const EventListQuerySchema = z
  .strictObject({ session: opt(f.session), project: opt(f.project), ...eventFilterShape })
  .refine(agentNeedsOneSession, AGENT_NEEDS_SESSION)
  .refine(eventModes, EVENT_MODES)
  .refine(eventLimit, EVENT_LIMIT);
export type EventListQuery = z.output<typeof EventListQuerySchema>;

/** `sessionTimeline`: the events parameters without `session` and `project` (the session is in the path). */
export const SessionTimelineQuerySchema = z
  .strictObject(eventFilterShape)
  .refine(eventModes, EVENT_MODES)
  .refine(eventLimit, EVENT_LIMIT);
export type SessionTimelineQuery = z.output<typeof SessionTimelineQuerySchema>;

export const ToolCallListQuerySchema = z
  .strictObject({
    session: opt(f.session),
    agent: opt(f.agent),
    project: opt(f.project),
    tool: opt(f.tool),
    status: opt(f.status),
    q: opt(f.q),
    ...timeShape,
    ...pagingShape(TOOL_CALL_SORTS, 50, 200),
  })
  .refine(agentNeedsOneSession, AGENT_NEEDS_SESSION);
export type ToolCallListQuery = z.output<typeof ToolCallListQuerySchema>;

/** `sessionToolCalls`: the session is in the path. */
export const SessionToolCallsQuerySchema = z.strictObject({
  agent: opt(f.agent),
  tool: opt(f.tool),
  status: opt(f.status),
  q: opt(f.q),
  ...timeShape,
  ...pagingShape(TOOL_CALL_SORTS, 50, 200),
});
export type SessionToolCallsQuery = z.output<typeof SessionToolCallsQuerySchema>;

export const TransitionListQuerySchema = z.strictObject({
  agent: opt(f.agent),
  cursor: opt(f.cursor),
  limit: intString(1, 200).default(50),
});
export type TransitionListQuery = z.output<typeof TransitionListQuerySchema>;

export const ERROR_SOURCES = [
  'server',
  'spool',
  'transcript',
  'external',
  'writer',
  'handler',
  'alerts',
  'db',
] as const;

export const ErrorsQuerySchema = z.strictObject({
  since: opt(f.from),
  source: opt(csvOf(z.enum(ERROR_SOURCES), 8)),
  limit: intString(1, 200).default(50),
});
export type ErrorsQuery = z.output<typeof ErrorsQuerySchema>;

export const OverviewQuerySchema = z.strictObject({ ...windowedTimeShape, includeUnmatched: opt(f.includeUnmatched) });
export type OverviewQuery = z.output<typeof OverviewQuerySchema>;

export const WorkItemBoardQuerySchema = z.strictObject({ state: opt(csvOf(z.enum(BOARD_STATES), 6)), q: opt(f.q) });
export type WorkItemBoardQuery = z.output<typeof WorkItemBoardQuerySchema>;

export const AlertListQuerySchema = z.strictObject({
  // `prefault` (not `default`): the list parser transforms, and zod drops the default of a transforming schema from the
  // generated input schema; the prefault is the text `open`, which is what a query string would say
  status: csvOf(z.enum(['open', 'resolved']), 2).prefault('open'),
  severity: opt(csvOf(z.enum(['warning', 'critical']), 2)),
  rule: opt(csvOf(z.enum(ALERT_RULE_KINDS), 8)),
  session: opt(f.session),
  cursor: opt(f.cursor),
  limit: intString(1, 200).default(50),
});
export type AlertListQuery = z.output<typeof AlertListQuerySchema>;

// ---- analytics -----------------------------------------------------------------------------------------------------

export const UsageQuerySchema = z.strictObject({
  groupBy: z.enum(['model', 'session', 'project', 'workItem', 'agent', 'none']).default('model'),
  session: opt(f.session),
  project: opt(f.project),
  workItem: opt(f.workItem),
  model: opt(f.model),
  ...windowedTimeShape,
  limit: intString(1, 500).default(50),
  includeCost: opt(flagParam),
});
export type UsageQuery = z.output<typeof UsageQuerySchema>;

export const SessionUsageQuerySchema = z.strictObject({
  groupBy: z.enum(['agent', 'model']).default('agent'),
  includeCost: opt(flagParam),
});
export type SessionUsageQuery = z.output<typeof SessionUsageQuerySchema>;

export const SeriesQuerySchema = z.strictObject({
  bucket: z.enum(['hour', 'day']).default('day'),
  tzOffsetMinutes: intString(-840, 840).default(0),
  groupBy: z.enum(['none', 'model']).default('none'),
  session: opt(f.session),
  project: opt(f.project),
  workItem: opt(f.workItem),
  model: opt(f.model),
  ...timeShape,
});
export type SeriesQuery = z.output<typeof SeriesQuerySchema>;

export const AnalyticsToolsQuerySchema = z
  .strictObject({
    groupBy: z.enum(['tool', 'mcpServer']).default('tool'),
    session: opt(f.session),
    agent: opt(f.agent),
    project: opt(f.project),
    tool: opt(f.tool),
    ...timeShape,
    limit: intString(1, 200).default(50),
  })
  .refine(agentNeedsOneSession, AGENT_NEEDS_SESSION);
export type ToolsQuery = z.output<typeof AnalyticsToolsQuerySchema>;

// ---- transcripts ---------------------------------------------------------------------------------------------------

export const TranscriptWindowQuerySchema = z.strictObject({
  agent: f.agent.default('main'),
  /** Entries after this index (`-1` = the tail); `before` wins when both are present. */
  after: intString(-1, MAX_INT).default(-1),
  before: opt(intString(0, MAX_INT)),
  /** 1..2000; the server default is 250 for tail and `before`, 2000 for `after`. */
  limit: opt(intString(1, 2000)),
  /** 200..20000; the server default is config `limits.text_chars`. */
  textChars: opt(intString(200, 20000)),
  thinking: opt(flagParam),
});
export type TranscriptWindowQuery = z.output<typeof TranscriptWindowQuerySchema>;

export const TranscriptLocateQuerySchema = z
  .strictObject({
    agent: f.agent.default('main'),
    // negative is valid: the handler clamps `i` into [0, total - 1] (03 7.3)
    i: opt(intString(-MAX_INT, MAX_INT)),
    ts: opt(f.from),
    offset: opt(intString(0, MAX_INT)),
  })
  .refine((q) => [q.i, q.ts, q.offset].filter((value) => value !== undefined).length === 1, {
    message: 'exactly one of i, ts and offset is required',
    path: ['i'],
  });
export type TranscriptLocateQuery = z.output<typeof TranscriptLocateQuerySchema>;

const EntryKindsParam = csvOf(z.enum(ENTRY_KINDS), 5);

export const TranscriptSearchQuerySchema = z.strictObject({
  session: SessionIdSchema,
  agent: opt(f.agent),
  /** 0..200; empty is allowed together with the other filters. */
  q: opt(textOf(0, 200)),
  kinds: opt(EntryKindsParam),
  tool: opt(ToolNameSchema),
  errors: opt(flagParam),
  limit: intString(1, 1000).default(200),
  budgetMs: intString(100, 10000).default(3000),
});
export type TranscriptSearchQuery = z.output<typeof TranscriptSearchQuerySchema>;

export const InstanceSearchQuerySchema = z.strictObject({
  q: f.q,
  session: opt(f.session),
  project: opt(f.project),
  workItem: opt(f.workItem),
  ...windowedTimeShape,
  kinds: opt(EntryKindsParam),
  limit: intString(1, 500).default(100),
  budgetMs: intString(100, 10000).default(3000),
  /** The opaque `c-<random>` handle of a previous response. */
  continue: opt(z.string().regex(/^c-[A-Za-z0-9_-]{1,64}$/)),
});
export type InstanceSearchQuery = z.output<typeof InstanceSearchQuerySchema>;

// ---- panels and stream ---------------------------------------------------------------------------------------------

/** `limit` applies to the `attempts` panel only (default 30, applied by the handler); see `panelQueryAllowed`. */
export const PanelQuerySchema = z.strictObject({ limit: opt(intString(1, 200)) });
export type PanelQuery = z.output<typeof PanelQuerySchema>;

/**
 * Whether a parsed panel query is valid for the panel: `limit` is only meaningful for `attempts` (06 3.4), so the other
 * five panels refuse it (`validation_failed`). The one rule server, CLI and UI share instead of repeating it.
 */
export function panelQueryAllowed(key: PanelKey, query: PanelQuery): boolean {
  return key === 'attempts' || query.limit === undefined;
}

export const StreamQuerySchema = z.strictObject({ since: opt(intString(0, MAX_INT)), epoch: opt(EpochSchema) });
export type StreamQuery = z.output<typeof StreamQuerySchema>;

// ---- URL mapping ---------------------------------------------------------------------------------------------------

/** A query string (with or without `?`), entries (`URLSearchParams` works), or a record of strings. */
export type QueryInput =
  string | Iterable<readonly [string, string]> | Readonly<Record<string, string | readonly string[] | undefined>>;

function decodeComponent(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function isEntries(input: object): input is Iterable<readonly [string, string]> {
  return Symbol.iterator in input;
}

function addValue(target: Map<string, string | string[]>, key: string, value: string): void {
  const previous = target.get(key);
  if (previous === undefined) target.set(key, value);
  else if (typeof previous === 'string') target.set(key, [previous, value]);
  else previous.push(value);
}

/** Collects the input into a record; a repeated key becomes an array (a schema refuses it). `null`: malformed percent-encoding. */
function collect(input: QueryInput): Record<string, string | string[]> | null {
  const out = new Map<string, string | string[]>();
  if (typeof input === 'string') {
    const text = input.startsWith('?') ? input.slice(1) : input;
    for (const part of text.split('&')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      const key = decodeComponent(eq < 0 ? part : part.slice(0, eq));
      const value = decodeComponent(eq < 0 ? '' : part.slice(eq + 1));
      if (key === null || value === null) return null;
      addValue(out, key, value);
    }
    return Object.fromEntries(out);
  }
  if (isEntries(input)) {
    for (const [key, value] of input) addValue(out, key, value);
    return Object.fromEntries(out);
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string') addValue(out, key, value);
    else for (const item of value) addValue(out, key, item);
  }
  return Object.fromEntries(out);
}

function malformed(): z.ZodError {
  return new z.ZodError([{ code: 'custom', path: [], message: 'malformed percent-encoding', input: undefined }]);
}

/** The result of `safeFromQuery`: the typed value or the Zod error. */
export type QueryParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

/** `safeParse` of a query input against a route schema; never throws. */
export function safeFromQuery<S extends z.ZodType>(schema: S, input: QueryInput): QueryParseResult<z.output<S>> {
  const record = collect(input);
  if (record === null) return { success: false, error: malformed() };
  const parsed = schema.safeParse(record);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
}

/** Parses a query input against a route schema; throws a `ZodError` (an API route answers `400 validation_failed`). */
export function fromQuery<S extends z.ZodType>(schema: S, input: QueryInput): z.output<S> {
  const record = collect(input);
  if (record === null) throw malformed();
  return schema.parse(record);
}

function scalarText(key: string, value: unknown): string {
  if (typeof value === 'string') {
    if (value.includes(',')) throw new TypeError(`toQuery: a list item of ${key} contains a comma`);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError(`toQuery: unsupported list item for ${key}`);
}

/**
 * Serialises a parsed filter back to query values: `true` is `1`, lists are comma-separated, `undefined`, `null`, `false`
 * and empty lists are left out, keys are sorted. `fromQuery(schema, toQuery(f))` equals `f` for any `f` a schema produced.
 */
export function toQuery(filter: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(filter).sort()) {
    const value = filter[key];
    if (value === undefined || value === null || value === false) continue;
    if (value === true) out[key] = '1';
    else if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    else if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.map((item: unknown) => scalarText(key, item)).join(',');
    } else throw new TypeError(`toQuery: unsupported value for ${key}`);
  }
  return out;
}

/** `a=1&b=2` with sorted keys and percent-encoding; `''` for an empty record. */
export function queryString(values: Readonly<Record<string, string>>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(values[key] ?? '')}`)
    .join('&');
}

/**
 * The error code of a failed query parse: `query_too_short` when `q` is shorter than its minimum, otherwise
 * `validation_failed`. (`param_repeated`, `cursor_invalid`, `range_invalid` come from the guards and handlers.)
 */
export function classifyQueryIssues(issues: readonly { code: string; path: readonly PropertyKey[] }[]): ErrorCode {
  return issues.some((issue) => issue.code === 'too_small' && issue.path.length === 1 && issue.path[0] === 'q')
    ? 'query_too_short'
    : 'validation_failed';
}

// ---- time window ---------------------------------------------------------------------------------------------------

export interface TimeWindowQuery {
  range?: Preset | undefined;
  from?: IsoTime | undefined;
  to?: IsoTime | undefined;
  window?: boolean | undefined;
}

export interface TimeWindowOptions {
  /** The server clock. */
  nowMs: number;
  /** What a request without any time parameter means for this route. */
  defaultRange: Preset | 'window';
  /** Config `window_hours`, used by `window=1` and by `defaultRange: 'window'`. */
  windowHours: number;
}

export type TimeWindowResult =
  | { ok: true; window: { fromMs: number | null; toMs: number }; source: 'window_hours' | 'range' | 'custom' }
  | { ok: false; code: 'range_invalid' | 'range_too_large' };

const MAX_SPAN_MS = 3650 * DAY_MS;

/**
 * Resolves `range` / `from`+`to` / `window` to epoch milliseconds (03 5.4). A preset runs from `now - span` to `now + 1`;
 * `all` has no lower bound; `to` defaults to now; `range`, `from`/`to` and `window` exclude each other; `to` needs `from`,
 * `from` must precede `to` and the span is at most 3650 days.
 */
export function resolveTimeWindow(q: TimeWindowQuery, o: TimeWindowOptions): TimeWindowResult {
  const explicit = q.from !== undefined || q.to !== undefined;
  const modes = [q.range !== undefined, explicit, q.window === true].filter(Boolean).length;
  if (modes > 1 || (q.to !== undefined && q.from === undefined)) return { ok: false, code: 'range_invalid' };
  if (explicit && q.from !== undefined) {
    const fromMs = Date.parse(q.from);
    const toMs = q.to === undefined ? o.nowMs : Date.parse(q.to);
    if (!(fromMs < toMs)) return { ok: false, code: 'range_invalid' };
    if (toMs - fromMs > MAX_SPAN_MS) return { ok: false, code: 'range_too_large' };
    return { ok: true, window: { fromMs, toMs }, source: 'custom' };
  }
  const windowed = (): TimeWindowResult => ({
    ok: true,
    window: { fromMs: o.nowMs - o.windowHours * HOUR_MS, toMs: o.nowMs + 1 },
    source: 'window_hours',
  });
  if (q.window === true) return windowed();
  const preset = q.range ?? o.defaultRange;
  if (preset === 'window') return windowed();
  return {
    ok: true,
    window: { fromMs: preset === 'all' ? null : o.nowMs - PRESET_MS[preset], toMs: o.nowMs + 1 },
    source: 'range',
  };
}

// ---- event predicate -----------------------------------------------------------------------------------------------

type EventFilterKey =
  | 'type'
  | 'category'
  | 'severity'
  | 'session'
  | 'agent'
  | 'project'
  | 'workItem'
  | 'tool'
  | 'q'
  | 'range'
  | 'from'
  | 'to';

/**
 * The event parameters of an `EventListQuery` or `SessionTimelineQuery` that decide whether one event belongs (no paging
 * keys). Not the web's `EventFilter` alias of the whole `listEvents` query (04 4.4.4): that alias is `EventListQuery`
 * and the web module defines it itself; this type is only the argument of `matchesEventFilter`.
 */
export type EventMatchFilter = { [K in EventFilterKey]?: EventListQuery[K] | undefined };

export interface EventMatchOptions {
  /** The clock; needed to apply a `range` preset (otherwise the preset is left to the server). */
  nowMs?: number | undefined;
  /** Which project a session belongs to; required when the filter has `project` (without it nothing matches). */
  projectIdOf?: ((sessionId: string) => string | null | undefined) | undefined;
  /** Which work items a session belongs to; required when the filter has `workItem` (without it nothing matches). */
  workItemIdsOf?: ((sessionId: string) => readonly number[] | undefined) | undefined;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The fold of a `q` needle (03 5.4): Unicode `NFKC`, then lower case. The server's SQL layer, the CLI and the UI buffers
 * all fold with this one function; the haystack is only ASCII-lowered, as SQLite `LIKE` does.
 */
export function foldQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase();
}

/**
 * The shared predicate of the live buffers (and the contract the server's SQL is tested against). `q` is a literal
 * substring of the summary or the tool name, case-insensitive for ASCII only (SQLite `LIKE`), with the needle folded
 * `NFKC` + lower case. Paging parameters (`dir`, `cursor`, `limit`, `around`, `afterId`) never matter here.
 */
export function matchesEventFilter(
  filter: EventMatchFilter,
  event: ActivityEvent,
  options: EventMatchOptions = {},
): boolean {
  if (filter.type !== undefined && !filter.type.includes(event.type)) return false;
  if (filter.category !== undefined && !filter.category.includes(event.category)) return false;
  if (filter.severity !== undefined && !filter.severity.includes(event.severity)) return false;
  if (filter.session !== undefined && !filter.session.includes(event.sessionId)) return false;
  if (filter.agent !== undefined && event.agentId !== filter.agent) return false;
  if (filter.tool !== undefined && (event.toolName === null || !filter.tool.includes(event.toolName))) return false;
  if (filter.q !== undefined) {
    const needle = foldQuery(filter.q);
    const inSummary = asciiLower(event.summary).includes(needle);
    const inTool = event.toolName !== null && asciiLower(event.toolName).includes(needle);
    if (!inSummary && !inTool) return false;
  }
  // fail closed: a missing resolver must never show the events of other projects or work items
  if (filter.project !== undefined) {
    const projectId = options.projectIdOf?.(event.sessionId);
    if (projectId === undefined || projectId === null || !filter.project.includes(projectId)) return false;
  }
  if (filter.workItem !== undefined) {
    const ids = options.workItemIdsOf?.(event.sessionId);
    if (!ids?.includes(filter.workItem)) return false;
  }
  return withinTime(filter, event, options.nowMs);
}

function withinTime(filter: EventMatchFilter, event: ActivityEvent, nowMs: number | undefined): boolean {
  const at = Date.parse(event.at);
  if (filter.from !== undefined || filter.to !== undefined) {
    if (filter.from !== undefined && at < Date.parse(filter.from)) return false;
    if (filter.to !== undefined && at >= Date.parse(filter.to)) return false;
    return true;
  }
  if (filter.range !== undefined && filter.range !== 'all' && nowMs !== undefined) {
    return at >= nowMs - PRESET_MS[filter.range] && at < nowMs + 1;
  }
  return true;
}
