// `ops.data` (01 6.4): the operations behind `sessions list`, `sessions show`, `usage` and `errors`, and the builders that turn command-line
// flags (or the plain objects of another consumer, such as the MCP server) into the parsed query types of the routes. A builder
// writes the flags as the text a query string would carry and lets the shared Zod schema of the route parse it, so the CLI and the MCP
// server never restate a query shape, a default or a range. A value that does not parse is a `USAGE` error that names the flag.
//
// Every operation reads through an `InstanceReader` (reader/open.ts), opened for the call and closed after it, so the same code answers
// from the running instance or from its database. Nothing here prints; the commands render the results.
import {
  AnalyticsToolsQuerySchema,
  ErrorsQuerySchema,
  LIFECYCLE_STATES,
  McsError,
  PRESET_MS,
  PresetSchema,
  SeriesQuerySchema,
  SessionAgentsQuerySchema,
  SessionListQuerySchema,
  SessionTimelineQuerySchema,
  TranscriptWindowQuerySchema,
  UsageQuerySchema,
  isoMsZ,
  safeFromQuery,
  type ErrorsQuery,
  type ErrorsResult,
  type QueryParseResult,
  type SeriesQuery,
  type SessionEventLine,
  type SessionListQuery,
  type SessionsListResult,
  type SessionsShowResult,
  type ToolsQuery,
  type UsageGroup,
  type UsageQuery,
  type UsageResult,
} from '@mcs/shared';
import { SID_RE } from '@mcs/shared/protocol';
import type { z } from 'zod';

import { readerReasonOf, openInstanceReader, type InstanceReader, type ReaderDeps } from '../reader/open.ts';
import { openWorkspace, type OpContext } from './workspace.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';

// ---- dependencies ---------------------------------------------------------------------------------------------------------------

/** What a test (or another front end) can replace; the defaults are the real probe, HTTP client and readers. */
export interface DataDeps {
  /** Replaces `openInstanceReader` (a test hands out a reader over a fixture). */
  readonly openReader?: (ws: WorkspaceRef, deps: ReaderDeps) => Promise<InstanceReader>;
  readonly probe?: ReaderDeps['probe'];
  readonly httpGet?: ReaderDeps['httpGet'];
  readonly openStream?: ReaderDeps['openStream'];
  readonly migrations?: ReaderDeps['migrations'];
  readonly requestTimeoutMs?: number;
}

function readerDepsOf(ctx: OpContext, deps: DataDeps): ReaderDeps {
  return {
    skillDir: ctx.skillDir,
    runtimeDir: ctx.runtimeDir,
    env: ctx.env,
    clock: ctx.clock,
    log: ctx.log,
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    ...(deps.httpGet === undefined ? {} : { httpGet: deps.httpGet }),
    ...(deps.openStream === undefined ? {} : { openStream: deps.openStream }),
    ...(deps.migrations === undefined ? {} : { migrations: deps.migrations }),
    ...(deps.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: deps.requestTimeoutMs }),
  };
}

/** Opens the reader of task `task`, runs `run` with it and always closes it. */
export async function withReader<T>(
  ctx: OpContext,
  task: string,
  deps: DataDeps,
  run: (reader: InstanceReader) => Promise<T>,
): Promise<T> {
  const ws = await openWorkspace(ctx, task);
  const reader = await (deps.openReader ?? openInstanceReader)(ws, readerDepsOf(ctx, deps));
  try {
    return await run(reader);
  } finally {
    await reader.close();
  }
}

// ---- the flags as a query -----------------------------------------------------------------------------------------------------------

/** The flag that a query key came from, for the error message. */
const FLAG_OF: Readonly<Record<string, string>> = {
  state: '--state',
  limit: '--limit',
  range: '--since',
  from: '--since',
  to: '--until',
  since: '--since',
  session: '--session',
  source: '--source',
  groupBy: '--by',
  events: '--events',
};

const PRESET_TEXT = Object.keys(PRESET_MS).join(', ');

/** What a flag expects, for the keys whose Zod message is not helpful on a command line. */
const EXPECTS: Readonly<Record<string, string>> = {
  state: `a comma-separated list of ${[...LIFECYCLE_STATES, 'active'].join(', ')}`,
  range: `one of ${PRESET_TEXT}, all, or an ISO-8601 time with Z or an offset`,
  from: `one of ${PRESET_TEXT}, all, or an ISO-8601 time with Z or an offset`,
  since: `one of ${PRESET_TEXT}, all, or an ISO-8601 time with Z or an offset`,
  to: 'an ISO-8601 time with Z or an offset',
  session: 'one or more session ids (full, as `sessions list --json` shows them)',
  source: 'a comma-separated list of server, spool, transcript, external, writer, handler, alerts, db',
};

interface QueryLimits {
  readonly limitMax: number;
}

function flagErrorOf(error: z.ZodError, limits: QueryLimits): McsError {
  const issue = error.issues[0];
  const key = String(issue?.path[0] ?? '');
  const flag = FLAG_OF[key] ?? (key === '' ? 'the options' : `--${key}`);
  const expects = key === 'limit' ? `an integer from 1 to ${String(limits.limitMax)}` : EXPECTS[key];
  const message =
    key === 'limit' || EXPECTS[key] !== undefined
      ? `${flag} expects ${expects ?? ''}`
      : `${flag} is not valid${issue === undefined ? '' : `: ${issue.message}`}`;
  return new McsError('USAGE', message, { details: { reason: 'validation_failed', flag } });
}

function parsed<T>(result: QueryParseResult<T>, limits: QueryLimits): T {
  if (result.success) return result.data;
  throw flagErrorOf(result.error, limits);
}

function usageError(message: string): McsError {
  return new McsError('USAGE', message, { details: { reason: 'validation_failed' } });
}

/** A number or a text from a flag, as the text a query string would carry. */
function textOf(value: number | string): string {
  return typeof value === 'number' ? String(value) : value.trim();
}

/** A list flag as the comma-separated text of a query: a text is split at its commas, every item trimmed. */
function listOf(value: string | readonly string[]): string {
  const items = typeof value === 'string' ? value.split(',') : value;
  return items.map((item) => item.trim()).join(',');
}

/**
 * `--since` / `--until` as the time keys of a route: a preset (`1h` .. `30d`, `all`) is `range`; an ISO-8601 time is `from`, and
 * `--until` is `to` (it needs an ISO `--since`). A value that is neither is left for the schema, which names the flag.
 */
function timeKeys(since: string | undefined, until: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (until !== undefined && since === undefined) throw usageError('--until needs --since');
  if (since === undefined) return out;
  const text = since.trim();
  if (PresetSchema.safeParse(text).success) {
    if (until !== undefined) throw usageError('--until needs --since as an ISO-8601 time, not a preset');
    out['range'] = text;
    return out;
  }
  out['from'] = text;
  if (until !== undefined) {
    out['to'] = until.trim();
    const fromMs = Date.parse(text);
    const toMs = Date.parse(out['to']);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs >= toMs) {
      throw usageError('--since must be earlier than --until');
    }
  }
  return out;
}

// ---- builders ----------------------------------------------------------------------------------------------------------------------

export interface SessionsListFlags {
  /** A state or a comma-separated list (`active` is the alias of the running states). */
  readonly state?: string | readonly string[];
  /** A preset (`1h`, `6h`, `24h`, `7d`, `30d`, `all`) or an ISO-8601 time. Default: the monitor's window. */
  readonly since?: string;
  /** 1..200, default 50. */
  readonly limit?: number | string;
  /** Sessions that no rule matched too, and no time window unless `since` is given. */
  readonly all?: boolean;
}

const SESSIONS_LIMIT_MAX = 200;
const SESSIONS_LIMIT_DEFAULT = 50;

/** The flags of `sessions list` as the parsed query of the `listSessions` route (newest activity first, with the total). */
export function sessionListQueryOf(flags: SessionsListFlags = {}): SessionListQuery {
  const raw: Record<string, string> = {
    includeTotal: '1',
    limit: textOf(flags.limit ?? SESSIONS_LIMIT_DEFAULT),
    ...timeKeys(flags.since, undefined),
  };
  if (flags.state !== undefined) raw['state'] = listOf(flags.state);
  if (flags.all === true) {
    raw['includeUnmatched'] = '1';
    if (flags.since === undefined) raw['range'] = 'all';
  }
  return parsed(safeFromQuery(SessionListQuerySchema, raw), { limitMax: SESSIONS_LIMIT_MAX });
}

export interface ErrorsFlags {
  /** A preset (`1h` .. `30d`; `all` is no bound) or an ISO-8601 time. */
  readonly since?: string;
  /** 1..200, default 50. */
  readonly limit?: number | string;
  /** The sources to keep (`spool`, `transcript`, ...). */
  readonly source?: string | readonly string[];
}

const ERRORS_LIMIT_MAX = 200;

/** The flags of `errors` as the parsed query of the `errors` route. A preset becomes the ISO time it means at `nowMs`. */
export function errorsQueryOf(flags: ErrorsFlags = {}, nowMs: number = Date.now()): ErrorsQuery {
  const raw: Record<string, string> = {};
  if (flags.limit !== undefined) raw['limit'] = textOf(flags.limit);
  if (flags.source !== undefined) raw['source'] = listOf(flags.source);
  if (flags.since !== undefined) {
    const text = flags.since.trim();
    const preset = PresetSchema.safeParse(text);
    if (!preset.success) raw['since'] = text;
    else if (preset.data !== 'all') raw['since'] = isoMsZ(nowMs - PRESET_MS[preset.data]);
  }
  return parsed(safeFromQuery(ErrorsQuerySchema, raw), { limitMax: ERRORS_LIMIT_MAX });
}

export interface UsageFlags {
  /** Default `model`. */
  readonly by?: UsageGroup;
  readonly session?: string | readonly string[];
  /** A preset or an ISO-8601 time. */
  readonly since?: string;
  /** An ISO-8601 time; needs an ISO `since`. */
  readonly until?: string;
  /** Rows: 1..500 for `session` and `model`, 1..200 for `tool`. */
  readonly limit?: number | string;
}

/** The query of the analytics route that answers `usage --by <group>`. */
export type UsageRequest =
  | { readonly by: 'session' | 'model'; readonly query: UsageQuery }
  | { readonly by: 'day'; readonly query: SeriesQuery }
  | { readonly by: 'tool'; readonly query: ToolsQuery };

/** The flags of `usage` as the parsed query of `analyticsUsage` (session, model), `analyticsSeries` (day) or `analyticsTools` (tool). */
export function usageQueryOf(flags: UsageFlags = {}): UsageRequest {
  const by = flags.by ?? 'model';
  const raw: Record<string, string> = { ...timeKeys(flags.since, flags.until) };
  if (flags.session !== undefined) raw['session'] = listOf(flags.session);
  if (by === 'day') {
    return { by, query: parsed(safeFromQuery(SeriesQuerySchema, { bucket: 'day', ...raw }), { limitMax: 0 }) };
  }
  if (flags.limit !== undefined) raw['limit'] = textOf(flags.limit);
  if (by === 'tool') {
    return {
      by,
      query: parsed(safeFromQuery(AnalyticsToolsQuerySchema, { groupBy: 'tool', ...raw }), { limitMax: 200 }),
    };
  }
  return {
    by,
    query: parsed(safeFromQuery(UsageQuerySchema, { groupBy: by, includeCost: '1', ...raw }), { limitMax: 500 }),
  };
}

// ---- the operations -------------------------------------------------------------------------------------------------------------------

export interface SessionsListInput extends SessionsListFlags {
  readonly task: string;
}

/** `sessions list`: one page of sessions, newest activity first. */
export async function listSessions(
  ctx: OpContext,
  input: SessionsListInput,
  deps: DataDeps = {},
): Promise<SessionsListResult> {
  const query = sessionListQueryOf(input);
  return withReader(ctx, input.task, deps, async (reader) => {
    const page = await reader.sessions(query);
    return {
      task: input.task,
      mode: reader.mode,
      items: page.items,
      total: page.total,
      totalIsLowerBound: page.totalIsLowerBound,
      limit: page.limit,
      hasMore: page.nextCursor !== null,
    };
  });
}

export interface SessionsShowInput {
  readonly task: string;
  /** The session id, or the first characters of one (the table shows 8) when they name exactly one session. */
  readonly session: string;
  /** How many events (and transcript entries) at most: 1..100, default 10. */
  readonly events?: number | string;
  /** Adds the tool summaries of the events and the newest transcript entries of the main agent, each clipped. */
  readonly includeText?: boolean;
}

export const SHOW_EVENTS_DEFAULT = 10;
export const SHOW_EVENTS_MAX = 100;
/** Each transcript text and each tool summary printed by `--include-text` is cut at this many characters. */
export const SHOW_TEXT_CLIP = 300;
const PREFIX_SCAN_PAGES = 5;
const PREFIX_RE = /^[0-9a-f-]{4,35}$/;

/** `--events`: a whole number from 1 to `SHOW_EVENTS_MAX`. */
function eventsCount(value: number | string | undefined): number {
  if (value === undefined) return SHOW_EVENTS_DEFAULT;
  const text = textOf(value);
  const n = Number(text);
  if (!/^[0-9]{1,3}$/.test(text) || n < 1 || n > SHOW_EVENTS_MAX) {
    throw new McsError('USAGE', `--events expects an integer from 1 to ${String(SHOW_EVENTS_MAX)}`, {
      details: { reason: 'validation_failed', flag: '--events' },
    });
  }
  return n;
}

/** A full session id is used as it is; anything else must be a hex prefix of at least four characters that names exactly one session. */
async function resolveSessionId(reader: InstanceReader, text: string): Promise<string> {
  const wanted = text.trim().toLowerCase();
  if (SID_RE.test(wanted)) return wanted;
  if (!PREFIX_RE.test(wanted)) {
    throw new McsError('USAGE', '--session expects a session id (or its first characters)', {
      details: { reason: 'validation_failed', flag: '--session' },
    });
  }
  const found: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PREFIX_SCAN_PAGES; page += 1) {
    const query = parsed(
      safeFromQuery(SessionListQuerySchema, {
        limit: '200',
        range: 'all',
        includeUnmatched: '1',
        ...(cursor === undefined ? {} : { cursor }),
      }),
      { limitMax: 200 },
    );
    const result = await reader.sessions(query);
    for (const item of result.items) if (item.id.startsWith(wanted)) found.push(item.id);
    if (found.length > 1 || result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  if (found.length > 1) {
    throw new McsError('USAGE', `${String(found.length)} sessions start with that; give more characters of the id`, {
      details: { reason: 'ambiguous_session' },
    });
  }
  const [only] = found;
  if (only === undefined) {
    throw new McsError('NOT_FOUND', 'no session has that id', { details: { reason: 'session_not_found' } });
  }
  return only;
}

function clipped(text: string): string {
  const points = Array.from(text);
  return points.length <= SHOW_TEXT_CLIP ? text : `${points.slice(0, SHOW_TEXT_CLIP - 1).join('')}…`;
}

/** What `showSession` hands back: the result, and the notes that are not errors (a transcript that is gone). */
export interface SessionsShowOutcome {
  readonly result: SessionsShowResult;
  readonly warnings: readonly string[];
}

/**
 * `sessions show`: the state with its basis and evidence, the agents, the newest events and, only with `includeText`, the tool
 * summaries and the newest entries of the main transcript, each clipped to `SHOW_TEXT_CLIP` characters. Without `includeText` no
 * prompt, reply, thinking or tool text is read at all.
 */
export async function showSession(
  ctx: OpContext,
  input: SessionsShowInput,
  deps: DataDeps = {},
): Promise<SessionsShowOutcome> {
  const count = eventsCount(input.events);
  const includeText = input.includeText === true;
  return withReader(ctx, input.task, deps, async (reader) => {
    const id = await resolveSessionId(reader, input.session);
    const found = await reader.session(id);
    if (found === null) {
      throw new McsError('NOT_FOUND', 'no session has that id', { details: { reason: 'session_not_found' } });
    }
    const { asOfSeq, ...session } = found;
    const agents = await reader.sessionAgents(
      id,
      parsed(safeFromQuery(SessionAgentsQuerySchema, { limit: '200' }), { limitMax: 200 }),
    );
    const timeline = await reader.sessionEvents(
      id,
      parsed(safeFromQuery(SessionTimelineQuerySchema, { dir: 'desc', limit: String(count) }), { limitMax: 200 }),
    );
    const events: SessionEventLine[] = timeline.items
      .map((event) => ({
        id: event.id,
        at: event.at,
        agentId: event.agentId,
        type: event.type,
        category: event.category,
        severity: event.severity,
        toolName: event.toolName,
        toolStatus: event.toolStatus,
        durationMs: event.durationMs,
        summary: includeText && event.summary !== '' ? clipped(event.summary) : null,
      }))
      .reverse();
    const warnings: string[] = [];
    let transcript: SessionsShowResult['transcript'] = null;
    if (includeText) {
      try {
        const query = parsed(
          safeFromQuery(TranscriptWindowQuerySchema, {
            agent: 'main',
            limit: String(count),
            textChars: String(SHOW_TEXT_CLIP),
          }),
          { limitMax: 2000 },
        );
        const window = await reader.transcriptWindow({ ...query, sessionId: id });
        transcript = {
          agentId: window.agentId,
          total: window.total,
          clipChars: SHOW_TEXT_CLIP,
          entries: window.events.map((entry) => ({
            i: entry.i,
            t: entry.t,
            k: entry.k,
            name: entry.name ?? null,
            text: clipped(entry.text ?? entry.summary ?? ''),
          })),
        };
      } catch (error) {
        if (readerReasonOf(error) !== 'transcript_gone') throw error;
        warnings.push('the transcript file is gone, so no text is shown');
      }
    }
    return {
      result: {
        task: input.task,
        mode: reader.mode,
        asOfSeq,
        session,
        agents: agents.items,
        agentsTruncated: agents.nextCursor !== null,
        events,
        eventsTruncated: timeline.nextCursor !== null,
        transcript,
      },
      warnings,
    };
  });
}

export interface UsageInput extends UsageFlags {
  readonly task: string;
}

/** `usage`: the report of the route behind `--by`. */
export async function usageReport(ctx: OpContext, input: UsageInput, deps: DataDeps = {}): Promise<UsageResult> {
  const request = usageQueryOf(input);
  return withReader(ctx, input.task, deps, async (reader): Promise<UsageResult> => {
    const base = { task: input.task, mode: reader.mode };
    if (request.by === 'day') return { ...base, by: 'day', series: await reader.series(request.query) };
    if (request.by === 'tool') return { ...base, by: 'tool', tools: await reader.tools(request.query) };
    return { ...base, by: request.by, report: await reader.usage(request.query) };
  });
}

export interface ErrorsInput extends ErrorsFlags {
  readonly task: string;
}

/** `errors`: the recent errors, newest first. */
export async function recentErrors(ctx: OpContext, input: ErrorsInput, deps: DataDeps = {}): Promise<ErrorsResult> {
  const query = errorsQueryOf(input, ctx.clock.now());
  return withReader(ctx, input.task, deps, async (reader) => ({
    task: input.task,
    mode: reader.mode,
    items: await reader.errors(query),
  }));
}
