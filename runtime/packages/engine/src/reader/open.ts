// `InstanceReader` and `openInstanceReader` (01 6.1, 03 12.2, T-CLI-05): the one way the CLI, the MCP server and later consumers read the data
// of an instance. Two readers answer with identical JSON:
//   - `ApiReader` when the instance runs (loopback HTTP over the route registry of `@mcs/shared`, every body validated with the response
//     schema of its route, every reply checked for the `X-MCS-Instance` header);
//   - `DbReader` when it does not (a read-only database and the same engine query functions the server routes call).
// The probe of 01 4.8 decides, once per `openInstanceReader` call, and only `running` selects the API: a monitor that this runtime did not
// start (`unmanaged-running`) is not ours to ask, and a runtime that is starting, stopping or unhealthy is read through the database.
// A reader belongs to one call: the next call probes again, so a start or stop in between switches the mode.
//
// The module also holds what both readers share, the mapping of every failure to one `McsError` (so a bad request, a missing session or a
// busy search fails the same way in both modes). The readers import it from here; they are created from `openInstanceReader`.
import type {
  AgentNode,
  AlertItem,
  AlertListQuery,
  CompletionResponse,
  ErrorCode,
  ErrorItem,
  ErrorsQuery,
  EventPage,
  ExportQuery,
  ExportSummary,
  InstanceSearchQuery,
  InstanceSearchResponse,
  Overview,
  OverviewQuery,
  Page,
  ReaderMode,
  SeriesQuery,
  SessionAgentsQuery,
  SessionDetail,
  SessionListQuery,
  SessionSummary,
  SessionTimelineQuery,
  ToolFrequencyReport,
  ToolsQuery,
  TranscriptSearchQuery,
  TranscriptSearchResponse,
  TranscriptWindowQuery,
  TranscriptWindowResponse,
  UsageQuery,
  UsageReport,
  UsageSeries,
  Clock,
} from '@mcs/shared';
import { McsError } from '@mcs/shared';
import { z } from 'zod';

import type { MigrationsLocation } from '../db/migrations.ts';
import type { CompletionTarget } from '../lifecycle/completion.ts';
import type { Logger } from '../log/logger.ts';
import { requireInstance } from '../ops/backup.ts';
import { isLoopbackBase, probeInstance, type ProbeOptions, type ProbeResult } from '../ops/probe.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { createApiReader, type ApiHttpGet, type ApiStreamOpen } from './api-reader.ts';
import { openDbReader } from './db-reader.ts';

// ---- the contract ----------------------------------------------------------------------------------------------------------

/** The text sink of `exportTo`: the caller creates and ends it (`exportInstance` has the same rule). */
export type ReaderOutput = NodeJS.WritableStream;

/**
 * Everything the readers answer. The results are the parsed bodies of the API (`Page<SessionSummary>`, `UsageReport`, ...): the
 * same JSON from both modes except `asOfSeq` and the fields that are relative to the moment of the call. A session that does not
 * exist is `null` from `session` and `NOT_FOUND` from the methods that need one.
 */
export interface InstanceReader {
  /** For debugging and tests; it is not part of the data. */
  readonly mode: ReaderMode;
  readonly instanceId: string;
  sessions(q: SessionListQuery): Promise<Page<SessionSummary>>;
  /** The session with its audit references (I-19), or `null`. */
  session(id: string): Promise<(SessionDetail & { asOfSeq: number }) | null>;
  sessionAgents(id: string, q: SessionAgentsQuery): Promise<Page<AgentNode>>;
  /** The activity events of one session (the timeline route). */
  sessionEvents(id: string, q: SessionTimelineQuery): Promise<EventPage>;
  usage(q: UsageQuery): Promise<UsageReport>;
  series(q: SeriesQuery): Promise<UsageSeries>;
  tools(q: ToolsQuery): Promise<ToolFrequencyReport>;
  /** Newest first. Offline only the stored ingestion errors exist; a running server adds the entries of its error ring. */
  errors(q: ErrorsQuery): Promise<ErrorItem[]>;
  overview(q: OverviewQuery): Promise<Overview>;
  alerts(q: AlertListQuery): Promise<Page<AlertItem>>;
  /** Rejects `McsError` `USAGE` (`target_invalid`) or `NOT_FOUND` (`target_not_found`), registry C16. */
  explainCompletion(target: CompletionTarget): Promise<CompletionResponse>;
  searchTranscript(q: TranscriptSearchQuery): Promise<TranscriptSearchResponse>;
  searchTranscripts(q: InstanceSearchQuery): Promise<InstanceSearchResponse>;
  transcriptWindow(q: TranscriptWindowQuery & { readonly sessionId: string }): Promise<TranscriptWindowResponse>;
  /** Writes `mcs.export/1` to `out` and returns what was written. */
  exportTo(q: ExportQuery, out: ReaderOutput): Promise<ExportSummary>;
  close(): Promise<void>;
}

/** What the readers need from the call that opens them (an `OpContext` satisfies the first five). */
export interface ReaderDeps {
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly log?: Logger;
  /** Default: `probeInstance`. */
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  /** The HTTP client of the `ApiReader` (default: the loopback client of the probe, with headers). */
  readonly httpGet?: ApiHttpGet;
  /** The streaming client of `ApiReader.exportTo` (default: a loopback `http.request`). */
  readonly openStream?: ApiStreamOpen;
  /** The migration files the runtime ships (default: the folder of `runtimeDir`). */
  readonly migrations?: MigrationsLocation;
  /** Per request, default 15 s; a search adds its budget. */
  readonly requestTimeoutMs?: number;
}

/**
 * The reader for the instance of `ws`: probes it now and returns an `ApiReader` when it runs, else a `DbReader`. Throws
 * `INSTANCE_NOT_INITIALIZED` for a workspace without `instance.json` and the configuration and database errors of the `DbReader`.
 */
export async function openInstanceReader(ws: WorkspaceRef, deps: ReaderDeps): Promise<InstanceReader> {
  const instance = await requireInstance(ws);
  const probe = await (deps.probe ?? probeInstance)(ws, { runtimeDir: deps.runtimeDir });
  if (probe.state === 'running' && probe.url !== null && isLoopbackBase(probe.url)) {
    return createApiReader({
      base: probe.url,
      instanceId: instance.instanceId,
      ...(deps.httpGet === undefined ? {} : { httpGet: deps.httpGet }),
      ...(deps.openStream === undefined ? {} : { openStream: deps.openStream }),
      ...(deps.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: deps.requestTimeoutMs }),
    });
  }
  // a stopped instance is read as an immutable file (no -wal or -shm is left behind); any other state may have a writer
  return openDbReader(ws, instance.instanceId, deps, { stopped: probe.state === 'stopped' || probe.state === 'stale' });
}

/** `schema.safeParse(value)` that keeps the output type of a schema known only as a type parameter. */
export function parseBody<S extends z.ZodType>(
  schema: S,
  value: unknown,
): { readonly ok: true; readonly data: z.output<S> } | { readonly ok: false } {
  const checked = z.safeParse(schema, value);
  return checked.success ? { ok: true, data: checked.data } : { ok: false };
}

// ---- failures (shared by both readers) -----------------------------------------------------------------------------------------

const USAGE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'validation_failed',
  'param_repeated',
  'cursor_invalid',
  'range_invalid',
  'range_too_large',
  'filter_requires_scope',
  'query_too_short',
]);

const NOT_FOUND_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'session_not_found',
  'agent_not_found',
  'event_not_found',
  'work_item_not_found',
  'alert_not_found',
  'completion_target_not_found',
  'transcript_gone',
]);

const BUSY_HINTS: Readonly<Partial<Record<ErrorCode, string>>> = {
  search_busy: 'another search is running; try again in a moment',
  export_busy: 'another export is running; try again in a moment',
  db_busy: 'the database is busy; try again in a moment',
  shutting_down: 'the instance is stopping; run the command again',
  disk_full: 'the disk of the instance is full',
};

/** The words for a code. Fixed text: the message of an engine error or of a request never carries a label, a query or a path. */
const CODE_TEXT: Readonly<Partial<Record<ErrorCode, string>>> = {
  validation_failed: 'the request was not valid',
  param_repeated: 'a parameter was given twice',
  cursor_invalid: 'the page cursor is not valid',
  range_invalid: 'the time range is not valid',
  range_too_large: 'the time range is too large',
  filter_requires_scope: 'the filter needs a session',
  query_too_short: 'the search text is too short',
  session_not_found: 'no such session',
  agent_not_found: 'no such agent',
  event_not_found: 'no such event',
  completion_target_not_found: 'no run matches the target',
  transcript_gone: 'the transcript file is gone',
  search_busy: 'the search is busy',
  export_busy: 'an export is already running',
  db_busy: 'the database is busy',
  disk_full: 'the disk is full',
  shutting_down: 'the instance is shutting down',
  internal_error: 'the instance reported an internal error',
};

/** The `McsError` for an error code of the API (or of the engine, which uses the same catalogue). `details.reason` keeps the code. */
export function readerErrorOfCode(code: ErrorCode): McsError {
  const text = CODE_TEXT[code] ?? `the instance refused the request (${code})`;
  const details = { reason: code };
  if (USAGE_CODES.has(code)) return new McsError('USAGE', text, { details });
  if (NOT_FOUND_CODES.has(code)) return new McsError('NOT_FOUND', text, { details });
  const hint = BUSY_HINTS[code];
  return new McsError('API_ERROR', text, { details, ...(hint === undefined ? {} : { hint }) });
}

/** The reason code of a failure made by `readerErrorOfCode`, or `null` for any other error. */
export function readerReasonOf(error: unknown): string | null {
  if (!(error instanceof McsError) || error.details === undefined) return null;
  const reason = error.details['reason'];
  return typeof reason === 'string' ? reason : null;
}
