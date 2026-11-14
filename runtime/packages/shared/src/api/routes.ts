// The route registry (03 6.1, 13): one `defineRoute` per route of API v3, shared by the server (`registerRoute`), the web
// client (`data/endpoints.ts`), the CLI `ApiReader` and the JSON Schema generator. A handler, a client or a document never
// restates a path, a query or a response shape: they import it from here.
import { z } from 'zod';

// eslint-disable-next-line no-restricted-imports -- WP-03 CR-WP-03-3: the rule reads `../cli/` inside @mcs/shared as the workspace package `cli`; this is shared's own folder src/cli/
import { ConfigInspectionSchema } from '../cli/results.ts';
import { IngestHealthSchema, NudgeBodySchema } from '../schemas/ingest.ts';
import { CompletionQuerySchema, CompletionResponseSchema } from './completion.ts';
import {
  ActivityEventSchema,
  AlertItemSchema,
  AlertRulesViewSchema,
  AgentNodeSchema,
  EventPageSchema,
  InstanceSearchResponseSchema,
  OverviewSchema,
  SessionDetailSchema,
  SessionSummarySchema,
  ToolCallItemSchema,
  ToolFrequencyReportSchema,
  TranscriptLocateResponseSchema,
  TranscriptSearchResponseSchema,
  TranscriptWindowResponseSchema,
  TransitionItemSchema,
  UsageReportSchema,
  UsageSeriesSchema,
  WorkItemSchema,
  pageSchema,
} from './entities.ts';
import type { ErrorCode } from './errors.ts';
import { ExportQuerySchema } from './export.ts';
import {
  AgentListQuerySchema,
  AlertListQuerySchema,
  AnalyticsToolsQuerySchema,
  ErrorsQuerySchema,
  EventListQuerySchema,
  InstanceSearchQuerySchema,
  OverviewQuerySchema,
  PanelQuerySchema,
  SeriesQuerySchema,
  SessionAgentsQuerySchema,
  SessionListQuerySchema,
  SessionTimelineQuerySchema,
  SessionToolCallsQuerySchema,
  SessionUsageQuerySchema,
  StreamQuerySchema,
  ToolCallListQuerySchema,
  TranscriptLocateQuerySchema,
  TranscriptSearchQuerySchema,
  TranscriptWindowQuerySchema,
  TransitionListQuerySchema,
  UsageQuerySchema,
  WorkItemBoardQuerySchema,
  queryString,
  toQuery,
} from './filters.ts';
import { AddFolderBodySchema, FolderListResponseSchema, FolderSchema, ResumeEligibilitySchema } from './folders.ts';
import { ErrorItemSchema, HealthReportSchema, HookProbeResultSchema, InstanceInfoSchema } from './health.ts';
import { CountSchema, ProbeSessionIdSchema, ProjectIdSchema, SessionIdSchema, intString } from './ids.ts';
import { LegacyHealthSchema } from './legacy-health.ts';
import { PanelKeySchema, PanelResponseSchema } from './panels.ts';

// ---- definition ----------------------------------------------------------------------------------------------------

export type RouteMethod = 'GET' | 'POST';
export type RouteContentType = 'application/json' | 'application/x-ndjson' | 'text/event-stream' | 'websocket';

/**
 * Who may call a route (02 2.1, A1). `open`: any local client that passes the guards. `reader`: a session cookie, or on a
 * GET the control token as a Bearer header; served open when no access service is wired (a task instance). `session`: a
 * valid session cookie. `ticket`: the one route that redeems an access code (it needs a body).
 */
export type RouteAccess = 'open' | 'reader' | 'session' | 'ticket';

/** The body limit of a route with a body that names none (02 2.1). */
export const DEFAULT_MAX_BODY_BYTES = 4096;

/** The one write route that stays `open`: the hook nudge of the spool (03 5.1). */
const OPEN_WRITE_ROUTE_ID = 'ingestNudge';

export interface RouteDefinition<
  Id extends string = string,
  P extends z.ZodObject | null = z.ZodObject | null,
  Q extends z.ZodType | null = z.ZodType | null,
  B extends z.ZodType | null = z.ZodType | null,
  R extends z.ZodType | null = z.ZodType | null,
> {
  readonly id: Id;
  readonly method: RouteMethod;
  /** `/api/v3/...` with `:name` segments; the legacy health route is `/api/health`. */
  readonly path: string;
  /** Path parameters (raw text in, typed out). */
  readonly params: P;
  /** Query parameters (raw text in, typed out). */
  readonly query: Q;
  readonly body: B;
  /** `null` for the streams, for `204` and for a WebSocket upgrade. */
  readonly response: R;
  /** `101` only with the content type `websocket` (the status after the upgrade). */
  readonly successStatus: 101 | 200 | 204;
  /** The specific error codes of the route (the registry column "Specific errors"); see `routeErrors` for the full list. */
  readonly errors: readonly ErrorCode[];
  readonly summary: string;
  readonly contentType: RouteContentType | null;
  /** Who may call the route; `open` unless the definition says otherwise. */
  readonly access: RouteAccess;
  /** The largest request body in bytes: `DEFAULT_MAX_BODY_BYTES` for a route with a body that names none, `0` without a body. */
  readonly maxBodyBytes: number;
}

/** What a route definition spells out: `access` and `maxBodyBytes` are optional, so a route written before them stays valid. */
export type RouteSpec<
  Id extends string = string,
  P extends z.ZodObject | null = z.ZodObject | null,
  Q extends z.ZodType | null = z.ZodType | null,
  B extends z.ZodType | null = z.ZodType | null,
  R extends z.ZodType | null = z.ZodType | null,
> = Omit<RouteDefinition<Id, P, Q, B, R>, 'access' | 'maxBodyBytes'> & {
  readonly access?: RouteAccess;
  readonly maxBodyBytes?: number;
};

/** Declares a route and checks the invariants that a typo would break silently. Throws an `Error` on a broken definition. */
export function defineRoute<
  const Id extends string,
  P extends z.ZodObject | null,
  Q extends z.ZodType | null,
  B extends z.ZodType | null,
  R extends z.ZodType | null,
>(spec: RouteSpec<Id, P, Q, B, R>): RouteDefinition<Id, P, Q, B, R> {
  const names = [...spec.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '').sort();
  const declared = spec.params === null ? [] : Object.keys(spec.params.shape).sort();
  if (names.join() !== declared.join()) {
    throw new Error(
      `route ${spec.id}: path parameter names [${names.join()}] differ from the params schema [${declared.join()}]`,
    );
  }
  if (!spec.path.startsWith('/api/')) throw new Error(`route ${spec.id}: path must start with /api/`);
  if (spec.method === 'GET' && spec.body !== null) throw new Error(`route ${spec.id}: a GET route has no body`);
  if (spec.successStatus === 204 && (spec.response !== null || spec.contentType !== null)) {
    throw new Error(`route ${spec.id}: a 204 route has neither a response schema nor a content type`);
  }
  if (spec.successStatus === 200 && spec.contentType === 'application/json' && spec.response === null) {
    throw new Error(`route ${spec.id}: a JSON route needs a response schema`);
  }
  const access = spec.access ?? 'open';
  if (spec.contentType === 'websocket') {
    if (spec.method !== 'GET' || spec.response !== null || spec.successStatus !== 101) {
      throw new Error(`route ${spec.id}: a websocket route is a GET with no response schema and the status 101`);
    }
  } else if (spec.successStatus === 101) {
    throw new Error(`route ${spec.id}: the status 101 belongs to a websocket route`);
  }
  if (access === 'ticket' && spec.body === null) throw new Error(`route ${spec.id}: a ticket route needs a body`);
  if (spec.method !== 'GET' && access === 'open' && spec.id !== OPEN_WRITE_ROUTE_ID) {
    throw new Error(`route ${spec.id}: a write route must not be open`);
  }
  // 0 is what a definition without a body reads back as, so that `defineRoute({ ...route })` stays valid
  if (spec.body === null && spec.maxBodyBytes !== undefined && spec.maxBodyBytes !== 0) {
    throw new Error(`route ${spec.id}: maxBodyBytes needs a body`);
  }
  if (
    spec.body !== null &&
    spec.maxBodyBytes !== undefined &&
    !(Number.isInteger(spec.maxBodyBytes) && spec.maxBodyBytes > 0)
  ) {
    throw new Error(`route ${spec.id}: maxBodyBytes must be a positive integer`);
  }
  return {
    ...spec,
    access,
    maxBodyBytes: spec.body === null ? 0 : (spec.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
  };
}

/**
 * Codes any route can answer (03 5.2 and the header of registry section 3): guards, the query parser, the router and the
 * error mapper. A route lists only its specific codes in `errors`.
 */
export const COMMON_ERROR_CODES: readonly ErrorCode[] = [
  'validation_failed',
  'param_repeated',
  'host_not_allowed',
  'origin_not_allowed',
  'cross_site_request',
  'route_not_found',
  'method_not_allowed',
  'uri_too_long',
  'internal_error',
  'db_busy',
  'disk_full',
  'shutting_down',
];

/**
 * Every code the route can answer: the common ones, then the ones its metadata implies (a route behind a credential can
 * answer `access_required`; a route with a body can answer `csrf_rejected`, `payload_too_large` and `body_invalid_json`),
 * then its own. A route that omits `access` and `body` (as the partial route of a test may) implies nothing.
 */
export function routeErrors(
  route: Pick<RouteDefinition, 'errors'> & Partial<Pick<RouteDefinition, 'access' | 'body'>>,
): ErrorCode[] {
  const derived: ErrorCode[] = [];
  if (route.access === 'session' || route.access === 'reader') derived.push('access_required');
  if (route.body !== undefined && route.body !== null) {
    derived.push('csrf_rejected', 'payload_too_large', 'body_invalid_json');
  }
  return [...new Set<ErrorCode>([...COMMON_ERROR_CODES, ...derived, ...route.errors])];
}

// ---- parameter and response schemas that belong to no entity -------------------------------------------------------

const SessionPath = z.strictObject({ sessionId: SessionIdSchema });

/** The body of a POST that carries no data: `{}` and nothing else (an extra key is refused). */
const NoBodySchema = z.strictObject({});

/** `GET /work-items`: every item (cap 500) and the text that explains how the board is derived (02 7.11). */
export const WorkItemBoardSchema = z.strictObject({
  asOfSeq: CountSchema,
  derivation: z.string(),
  items: z.array(WorkItemSchema).max(500),
  truncated: z.boolean(),
});
export type WorkItemBoard = z.infer<typeof WorkItemBoardSchema>;

/** `GET /errors`. */
export const ErrorsResponseSchema = z.strictObject({ asOfSeq: CountSchema, items: z.array(ErrorItemSchema) });
export type ErrorsResponse = z.infer<typeof ErrorsResponseSchema>;

const WorkItemDetailSchema = WorkItemSchema.extend({
  sessions: z.array(SessionSummarySchema).max(100),
  asOfSeq: CountSchema,
});

// ---- the registry --------------------------------------------------------------------------------------------------

/** Each key is the route id (03 6.1). `explainCompletion` is added by WP-29 inside its block. */
export const routes = {
  legacyHealth: defineRoute({
    id: 'legacyHealth',
    method: 'GET',
    path: '/api/health',
    params: null,
    query: null,
    body: null,
    response: LegacyHealthSchema,
    successStatus: 200,
    errors: [],
    summary: 'Legacy health body (13 keys) that the legacy CLI readers understand.',
    contentType: 'application/json',
  }),
  health: defineRoute({
    id: 'health',
    method: 'GET',
    path: '/api/v3/health',
    params: null,
    query: null,
    body: null,
    response: HealthReportSchema,
    successStatus: 200,
    errors: [],
    summary: 'Runtime, database, ingestion, child process and panel health of the instance.',
    contentType: 'application/json',
  }),
  healthIngest: defineRoute({
    id: 'healthIngest',
    method: 'GET',
    path: '/api/v3/health/ingest',
    params: null,
    query: null,
    body: null,
    // strict at the top level (03 5.1); the nested objects are WP-04's (see CR-WP-03-7)
    response: z.strictObject({ ...IngestHealthSchema.shape, asOfSeq: CountSchema }),
    successStatus: 200,
    errors: [],
    summary: 'The last ingestion health report of the ingest service.',
    contentType: 'application/json',
  }),
  instance: defineRoute({
    id: 'instance',
    method: 'GET',
    path: '/api/v3/instance',
    params: null,
    query: null,
    body: null,
    response: InstanceInfoSchema,
    successStatus: 200,
    errors: [],
    summary: 'Identity, configuration summary, poll intervals, features and limits of the instance.',
    contentType: 'application/json',
  }),
  config: defineRoute({
    id: 'config',
    method: 'GET',
    path: '/api/v3/config',
    params: null,
    query: null,
    body: null,
    response: ConfigInspectionSchema,
    successStatus: 200,
    errors: [],
    summary: 'Effective configuration with the source of every value.',
    contentType: 'application/json',
  }),
  errors: defineRoute({
    id: 'errors',
    method: 'GET',
    path: '/api/v3/errors',
    params: null,
    query: ErrorsQuerySchema,
    body: null,
    response: ErrorsResponseSchema,
    successStatus: 200,
    errors: [],
    summary: 'Recent server and ingestion errors, newest first.',
    contentType: 'application/json',
  }),
  overview: defineRoute({
    id: 'overview',
    method: 'GET',
    path: '/api/v3/overview',
    params: null,
    query: OverviewQuerySchema,
    body: null,
    response: OverviewSchema,
    successStatus: 200,
    errors: ['range_invalid'],
    summary: 'Metrics with their source and rule, recent activity, recent errors and open alerts.',
    contentType: 'application/json',
  }),
  listSessions: defineRoute({
    id: 'listSessions',
    method: 'GET',
    path: '/api/v3/sessions',
    params: null,
    query: SessionListQuerySchema,
    body: null,
    response: pageSchema(SessionSummarySchema),
    successStatus: 200,
    errors: ['cursor_invalid', 'range_invalid', 'range_too_large', 'query_too_short'],
    summary: 'Sessions, filtered, sorted and paged with a keyset cursor.',
    contentType: 'application/json',
  }),
  getSession: defineRoute({
    id: 'getSession',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId',
    params: SessionPath,
    query: null,
    body: null,
    response: SessionDetailSchema.extend({ asOfSeq: CountSchema }),
    successStatus: 200,
    errors: ['session_not_found'],
    summary: 'One session with its files, reconciliations and audit references.',
    contentType: 'application/json',
  }),
  sessionAgents: defineRoute({
    id: 'sessionAgents',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/agents',
    params: SessionPath,
    query: SessionAgentsQuerySchema,
    body: null,
    response: pageSchema(AgentNodeSchema),
    successStatus: 200,
    errors: ['session_not_found'],
    summary: 'The agents of one session in depth order.',
    contentType: 'application/json',
  }),
  sessionTimeline: defineRoute({
    id: 'sessionTimeline',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/timeline',
    params: SessionPath,
    query: SessionTimelineQuerySchema,
    body: null,
    response: EventPageSchema,
    successStatus: 200,
    errors: ['session_not_found', 'agent_not_found', 'query_too_short'],
    summary: 'The activity events of one session (the events route with the session fixed).',
    contentType: 'application/json',
    access: 'reader',
  }),
  sessionToolCalls: defineRoute({
    id: 'sessionToolCalls',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/tool-calls',
    params: SessionPath,
    query: SessionToolCallsQuerySchema,
    body: null,
    response: pageSchema(ToolCallItemSchema),
    successStatus: 200,
    errors: ['session_not_found', 'query_too_short'],
    summary: 'The tool calls of one session.',
    contentType: 'application/json',
    access: 'reader',
  }),
  sessionTransitions: defineRoute({
    id: 'sessionTransitions',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/transitions',
    params: SessionPath,
    query: TransitionListQuerySchema,
    body: null,
    response: pageSchema(TransitionItemSchema),
    successStatus: 200,
    errors: ['session_not_found'],
    summary: 'Lifecycle transitions of one session, newest first.',
    contentType: 'application/json',
  }),
  sessionUsage: defineRoute({
    id: 'sessionUsage',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/usage',
    params: SessionPath,
    query: SessionUsageQuerySchema,
    body: null,
    response: UsageReportSchema,
    successStatus: 200,
    errors: ['session_not_found'],
    summary: 'Token usage of one session by agent or model.',
    contentType: 'application/json',
  }),
  transcriptWindow: defineRoute({
    id: 'transcriptWindow',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/transcript',
    params: SessionPath,
    query: TranscriptWindowQuerySchema,
    body: null,
    response: TranscriptWindowResponseSchema,
    successStatus: 200,
    errors: ['session_not_found', 'agent_not_found', 'transcript_gone'],
    summary: 'A window of transcript entries read from the transcript file on request.',
    contentType: 'application/json',
    access: 'reader',
  }),
  transcriptLocate: defineRoute({
    id: 'transcriptLocate',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/transcript/locate',
    params: SessionPath,
    query: TranscriptLocateQuerySchema,
    body: null,
    response: TranscriptLocateResponseSchema,
    successStatus: 200,
    errors: ['session_not_found', 'agent_not_found', 'transcript_gone', 'event_not_found'],
    summary: 'The transcript entry at an index, a time or a byte offset.',
    contentType: 'application/json',
    access: 'reader',
  }),
  searchTranscript: defineRoute({
    id: 'searchTranscript',
    method: 'GET',
    path: '/api/v3/search/transcript',
    params: null,
    query: TranscriptSearchQuerySchema,
    body: null,
    response: TranscriptSearchResponseSchema,
    successStatus: 200,
    errors: ['session_not_found', 'search_busy', 'transcript_gone'],
    summary: 'Content search inside one session transcript, with honest coverage.',
    contentType: 'application/json',
    access: 'reader',
  }),
  searchTranscripts: defineRoute({
    id: 'searchTranscripts',
    method: 'GET',
    path: '/api/v3/search/transcripts',
    params: null,
    query: InstanceSearchQuerySchema,
    body: null,
    response: InstanceSearchResponseSchema,
    successStatus: 200,
    errors: ['search_busy', 'cursor_invalid', 'query_too_short'],
    summary: 'Content search across the transcripts of the instance, with honest coverage.',
    contentType: 'application/json',
    access: 'reader',
  }),
  listAgents: defineRoute({
    id: 'listAgents',
    method: 'GET',
    path: '/api/v3/agents',
    params: null,
    query: AgentListQuerySchema,
    body: null,
    response: pageSchema(AgentNodeSchema),
    successStatus: 200,
    errors: ['query_too_short'],
    summary: 'Agents across sessions, filtered, sorted and paged.',
    contentType: 'application/json',
  }),
  listEvents: defineRoute({
    id: 'listEvents',
    method: 'GET',
    path: '/api/v3/events',
    params: null,
    query: EventListQuerySchema,
    body: null,
    response: EventPageSchema,
    successStatus: 200,
    errors: ['filter_requires_scope', 'event_not_found', 'query_too_short'],
    summary: 'Activity events: history pages, a page around an event, or the live tail after an id.',
    contentType: 'application/json',
  }),
  getEvent: defineRoute({
    id: 'getEvent',
    method: 'GET',
    path: '/api/v3/events/:eventId',
    params: z.strictObject({ eventId: intString(1, Number.MAX_SAFE_INTEGER) }),
    query: null,
    body: null,
    response: ActivityEventSchema.extend({ asOfSeq: CountSchema }),
    successStatus: 200,
    errors: ['event_not_found'],
    summary: 'One activity event.',
    contentType: 'application/json',
    access: 'reader',
  }),
  listToolCalls: defineRoute({
    id: 'listToolCalls',
    method: 'GET',
    path: '/api/v3/tool-calls',
    params: null,
    query: ToolCallListQuerySchema,
    body: null,
    response: pageSchema(ToolCallItemSchema),
    successStatus: 200,
    errors: ['filter_requires_scope', 'query_too_short'],
    summary: 'Tool calls across sessions, filtered, sorted and paged.',
    contentType: 'application/json',
    access: 'reader',
  }),
  workItemBoard: defineRoute({
    id: 'workItemBoard',
    method: 'GET',
    path: '/api/v3/work-items',
    params: null,
    query: WorkItemBoardQuerySchema,
    body: null,
    response: WorkItemBoardSchema,
    successStatus: 200,
    errors: ['query_too_short'],
    summary: 'The work item board: every item (at most 500) and how it is derived.',
    contentType: 'application/json',
  }),
  getWorkItem: defineRoute({
    id: 'getWorkItem',
    method: 'GET',
    path: '/api/v3/work-items/:workItemId',
    params: z.strictObject({ workItemId: intString(1, Number.MAX_SAFE_INTEGER) }),
    query: null,
    body: null,
    response: WorkItemDetailSchema,
    successStatus: 200,
    errors: ['work_item_not_found'],
    summary: 'One work item with its member sessions.',
    contentType: 'application/json',
  }),
  analyticsUsage: defineRoute({
    id: 'analyticsUsage',
    method: 'GET',
    path: '/api/v3/analytics/usage',
    params: null,
    query: UsageQuerySchema,
    body: null,
    response: UsageReportSchema,
    successStatus: 200,
    errors: ['range_too_large'],
    summary: 'Token usage grouped by model, session, project, work item, agent or not at all.',
    contentType: 'application/json',
  }),
  analyticsSeries: defineRoute({
    id: 'analyticsSeries',
    method: 'GET',
    path: '/api/v3/analytics/series',
    params: null,
    query: SeriesQuerySchema,
    body: null,
    response: UsageSeriesSchema,
    successStatus: 200,
    errors: ['range_too_large'],
    summary: 'Token usage over time in hour or day buckets (empty buckets are omitted).',
    contentType: 'application/json',
  }),
  analyticsTools: defineRoute({
    id: 'analyticsTools',
    method: 'GET',
    path: '/api/v3/analytics/tools',
    params: null,
    query: AnalyticsToolsQuerySchema,
    body: null,
    response: ToolFrequencyReportSchema,
    successStatus: 200,
    errors: [],
    summary: 'Tool call frequency, failures and durations by tool or MCP server.',
    contentType: 'application/json',
  }),
  listAlerts: defineRoute({
    id: 'listAlerts',
    method: 'GET',
    path: '/api/v3/alerts',
    params: null,
    query: AlertListQuerySchema,
    body: null,
    response: pageSchema(AlertItemSchema),
    successStatus: 200,
    errors: [],
    summary: 'Alerts, open by default.',
    contentType: 'application/json',
  }),
  alertRules: defineRoute({
    id: 'alertRules',
    method: 'GET',
    path: '/api/v3/alerts/rules',
    params: null,
    query: null,
    body: null,
    response: AlertRulesViewSchema,
    successStatus: 200,
    errors: [],
    summary: 'The alert rules and their configured thresholds.',
    contentType: 'application/json',
  }),
  panel: defineRoute({
    id: 'panel',
    method: 'GET',
    path: '/api/v3/panels/:key',
    params: z.strictObject({ key: PanelKeySchema }),
    query: PanelQuerySchema,
    body: null,
    response: PanelResponseSchema,
    successStatus: 200,
    errors: ['panel_disabled'],
    summary:
      'One panel (git, machine, attempts, ledger, chain log, logs) with the state of each source. The query `limit` (1..200, default 30) applies to attempts only (panelQueryAllowed).',
    contentType: 'application/json',
  }),
  export: defineRoute({
    id: 'export',
    method: 'GET',
    path: '/api/v3/export',
    params: null,
    query: ExportQuerySchema,
    body: null,
    response: null,
    successStatus: 200,
    errors: ['range_invalid', 'export_busy'],
    summary: 'Streams the instance data as JSON lines in the format mcs.export/1.',
    contentType: 'application/x-ndjson',
    access: 'reader',
  }),
  ingestNudge: defineRoute({
    id: 'ingestNudge',
    method: 'POST',
    path: '/api/v3/ingest/nudge',
    params: null,
    query: null,
    body: NudgeBodySchema,
    response: null,
    successStatus: 204,
    errors: ['instance_mismatch', 'payload_too_large', 'unsupported_media_type', 'body_invalid_json'],
    summary: 'Tells the server that the spool has new data; the body carries no event data.',
    contentType: null,
    maxBodyBytes: 256, // the limit of the nudge guard (NUDGE_MAX_BODY_BYTES of the server)
  }),
  ingestProbe: defineRoute({
    id: 'ingestProbe',
    method: 'GET',
    path: '/api/v3/ingest/probes/:probeSessionId',
    params: z.strictObject({ probeSessionId: ProbeSessionIdSchema }),
    query: null,
    body: null,
    response: HookProbeResultSchema,
    successStatus: 200,
    errors: ['probe_not_found'],
    summary: 'Whether a hook probe envelope has been committed (the hook verification check V7).',
    contentType: 'application/json',
  }),
  stream: defineRoute({
    id: 'stream',
    method: 'GET',
    path: '/api/v3/stream',
    params: null,
    query: StreamQuerySchema,
    body: null,
    response: null,
    successStatus: 200,
    errors: ['stream_limit'],
    summary: 'Server-sent events: hello, change, heartbeat and reset frames.',
    contentType: 'text/event-stream',
  }),
  // the projects routes (CAW-08, design 03 7.2, Option A): every one needs the session cookie, because folder paths and
  // DA summaries are private; they are mounted on the user instance only
  listFolders: defineRoute({
    id: 'listFolders',
    method: 'GET',
    path: '/api/v3/folders',
    params: null,
    query: null,
    body: null,
    response: FolderListResponseSchema,
    successStatus: 200,
    errors: [],
    summary: 'The project folders with their DA memory and Claude home details, and what each source said.',
    contentType: 'application/json',
    access: 'session',
  }),
  addFolder: defineRoute({
    id: 'addFolder',
    method: 'POST',
    path: '/api/v3/folders',
    params: null,
    query: null,
    body: AddFolderBodySchema,
    response: FolderSchema,
    successStatus: 200,
    errors: ['folder_invalid', 'folder_limit'],
    summary: 'Adds a folder by hand to the folder list; the answer is its row.',
    contentType: 'application/json',
    access: 'session',
  }),
  removeFolder: defineRoute({
    id: 'removeFolder',
    method: 'POST',
    path: '/api/v3/folders/:key/remove',
    params: z.strictObject({ key: ProjectIdSchema }),
    query: null,
    body: NoBodySchema,
    response: null,
    successStatus: 204,
    errors: ['folder_not_found'],
    summary: 'Removes a folder that was added by hand from the folder list; the folder on disk is not touched.',
    contentType: null,
    access: 'session',
  }),
  sessionResume: defineRoute({
    id: 'sessionResume',
    method: 'GET',
    path: '/api/v3/sessions/:sessionId/resume',
    params: SessionPath,
    query: null,
    body: null,
    response: ResumeEligibilitySchema,
    successStatus: 200,
    errors: ['session_not_found'],
    summary: 'Whether the session can be resumed in a terminal, whether a copy can, and why not.',
    contentType: 'application/json',
    access: 'session',
  }),
  // @wp-begin WP-29
  explainCompletion: defineRoute({
    id: 'explainCompletion',
    method: 'GET',
    path: '/api/v3/completion',
    params: null,
    query: CompletionQuerySchema,
    body: null,
    response: CompletionResponseSchema,
    successStatus: 200,
    errors: ['completion_target_not_found'],
    summary:
      'Whether an unattended run really finished: the outcome (completed, failed or not terminal), the lifecycle state and the evidence. Give exactly one of session (a session id), label (an exact, case-sensitive label, 1..200 characters) and attemptPart (0..512 characters; the empty part is allowed). A terminal outcome rests on observed evidence only.',
    contentType: 'application/json',
  }),
  // @wp-end WP-29
} as const;

export type Routes = typeof routes;
export type RouteId = keyof Routes;

/** Every route id of the registry, in declaration order. */
export const ROUTE_IDS: readonly RouteId[] = Object.values(routes).map((route) => route.id);

// ---- URL building --------------------------------------------------------------------------------------------------

/**
 * Fills the `:name` segments of a route path. Each value is checked with the route's `params` schema in its text form,
 * then percent-encoded; a missing or invalid value throws.
 */
export function buildPath(
  route: Pick<RouteDefinition, 'path' | 'params' | 'id'>,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const text: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) text[key] = String(value);
  if (route.params !== null) {
    const checked = route.params.safeParse(text);
    if (!checked.success) throw new TypeError(`route ${route.id}: invalid path parameters`);
  }
  return route.path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = text[name];
    if (value === undefined) throw new TypeError(`route ${route.id}: missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

/** `buildPath` plus the query string of `toQuery(query)` (sorted keys); the URL is relative to the server origin. */
export function routeUrl(
  route: Pick<RouteDefinition, 'path' | 'params' | 'id'>,
  options: { params?: Readonly<Record<string, string | number>>; query?: Readonly<Record<string, unknown>> } = {},
): string {
  const path = buildPath(route, options.params);
  const query = queryString(toQuery(options.query ?? {}));
  return query === '' ? path : `${path}?${query}`;
}
