// The export `mcs.export/1` (03 11.1, ADR 0028): JSON lines, metadata only by default, written to a stream as they are read.
//
//   header, then the records in the order of `EXPORT_RECORD_TYPES` (session, agent, workflow, work_item, turn, event,
//   tool_call, usage, transition, alert), then with `includeContent` the transcript lines, then the trailer with the counts,
//   the transcript files that are gone, and the SHA-256 of every byte before the trailer line.
//
// The data objects are the shapes of the API (`packages/shared/src/api/export.ts` only adds the `type` discriminator): the
// rows are hydrated by the same query functions the routes use, so there is no second definition of a session or an event.
// Each table is read in keyset pages of 1,000 ids (`WHERE id > :last ORDER BY id LIMIT 1000`); between pages the export
// yields to the event loop, checks the abort signal and, when the output is full, waits for `drain`. Nothing is buffered
// beyond one page and one chunk of at most 64 KiB, and there is no size cap.
//
// The database handed in must not change while the export runs: the server exports from an online-backup copy of its
// database (`data/exports/.tmp-*.db`, see the route), the CLI from a read-only connection on a stopped instance. An export
// never reads another instance: `db.assertScope` refuses a context of another instance before anything is written.
import { createHash } from 'node:crypto';

import {
  EXPORT_FORMAT,
  EXPORT_INCLUDES,
  WorkItemSchema,
  isoMsZ,
  resolveTimeWindow,
  type Clock,
  type ExportInclude,
  type ExportLine,
  type ExportQuery,
  type ExportSummary,
  type ActivityEvent,
  type EXPORT_RECORD_TYPES,
  type TranscriptWindowResponse,
} from '@mcs/shared';

import type { ResolvedConfig } from '../config/resolve.ts';
import { pragmaNumber, type SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { selectAlerts } from '../query/alerts.ts';
import { eventsByIds } from '../query/events.ts';
import { createQueries, type Queries } from '../query/index.ts';
import { Binder, QueryRefusal, toTransitionItem, type TransitionDbRow } from '../query/transitions.ts';
import type { TranscriptWindowQueries } from '../transcript/window.ts';

/** Rows per page (03 11.1); a test may use a smaller one to get several pages from a small database. */
const PAGE_SIZE = 1000;
/** Entries per transcript line (the format allows at most 500). */
const TRANSCRIPT_ENTRIES = 500;
/** Bytes collected before a chunk is written to the output. */
const CHUNK_BYTES = 64 * 1024;
/** `toolCallsByIds` answers at most this many ids per call. */
const TOOL_CALL_CHUNK = 500;

const PRIVACY_METADATA = 'Metadata only: no prompt, reply, thinking or tool result text.';
const PRIVACY_CONTENT = 'Contains transcript text: treat as confidential.';

/** What the export needs to know about the instance (the server context satisfies it, the CLI builds one). */
export interface ExportContext extends RepoContext {
  readonly slug: string;
  readonly runtimeVersion: string;
  /** The resolved configuration: the query layer reads `monitor.*` from it. */
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  /**
   * Needed for `includeContent` only: the transcript window of the instance. It keeps its entry index in the database it was
   * made for, which must be writable, so the export hands it the live instance and not the copy.
   */
  readonly transcripts?: Pick<TranscriptWindowQueries, 'window'>;
}

export interface ExportOptions {
  /** Rows per page; production 1,000. */
  readonly pageSize?: number;
}

/** The part of a stream the export writes to (`res`, a file stream, a collecting stream of a test). */
export type ExportOutput = NodeJS.WritableStream;

// ---- the output ----------------------------------------------------------------------------------------------------------------

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('The export was aborted', 'AbortError');
}

/** Resolves when `out` emits `drain`; rejects when it closes or fails first, or when `signal` aborts. */
function drained(out: ExportOutput, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const cleanup = (): void => {
      out.removeListener('drain', onDrain);
      out.removeListener('close', onClose);
      out.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('the output closed before the export ended'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
    out.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface LineSink {
  /** Appends one line (the JSON of `value` and LF). Waits for `drain` when the output is full. */
  line(value: ExportLine): Promise<void>;
  /** SHA-256 (hex) of every byte appended so far; later lines do not change a digest already taken. */
  digest(): string;
  /** Writes what is still collected. */
  finish(): Promise<void>;
  /** Stops listening to the output. Call it when the export ends, however it ends. */
  release(): void;
  readonly lines: number;
  readonly bytes: number;
}

/** Collects lines into chunks of about `chunkBytes`, hashes every byte, and honours the back pressure of `out`. */
export function createLineSink(out: ExportOutput, signal: AbortSignal, chunkBytes: number = CHUNK_BYTES): LineSink {
  const hash = createHash('sha256');
  let parts: string[] = [];
  let pending = 0;
  let lines = 0;
  let bytes = 0;
  // an `error` event of the output with no listener would end the process: the first one is kept and thrown at the next write
  const failed: { error: Error | null } = { error: null };
  const remember = (error: Error): void => {
    failed.error ??= error;
  };
  out.on('error', remember);

  async function flush(): Promise<void> {
    if (failed.error !== null) throw failed.error;
    if (parts.length === 0) return;
    const chunk = parts.join('');
    parts = [];
    pending = 0;
    signal.throwIfAborted();
    if (!out.write(chunk, 'utf8')) await drained(out, signal);
  }

  return {
    async line(value) {
      const text = `${JSON.stringify(value)}\n`;
      const size = Buffer.byteLength(text, 'utf8');
      hash.update(text, 'utf8');
      parts.push(text);
      pending += size;
      bytes += size;
      lines += 1;
      if (pending >= chunkBytes) await flush();
    },
    digest: () => hash.copy().digest('hex'),
    finish: flush,
    release: () => {
      out.removeListener('error', remember);
    },
    get lines() {
      return lines;
    },
    get bytes() {
      return bytes;
    },
  };
}

/** Lets the rest of the event loop (the ingest writer, other requests) run between two pages. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// ---- strict redaction ------------------------------------------------------------------------------------------------------------

/** `p-` and the first 12 hex digits of the SHA-256 of the project id: the same project keeps the same pseudonym. */
export function projectPseudonym(projectId: string): string {
  return `p-${createHash('sha256').update(projectId).digest('hex').slice(0, 12)}`;
}

/**
 * The line as `redaction: 'strict'` writes it (03 11.1): the first-prompt label, every summary, the labels and names that a
 * person typed, the working directory, the branch and the project name are removed; the project id becomes a pseudonym.
 */
export function redactLine(line: ExportLine): ExportLine {
  switch (line.type) {
    case 'session':
      return {
        type: 'session',
        data: {
          ...line.data,
          label: line.data.labelSource === 'first_prompt' ? '' : line.data.label,
          projectId: line.data.projectId === null ? null : projectPseudonym(line.data.projectId),
          projectLabel: null,
          cwd: null,
          gitBranch: null,
        },
      };
    case 'agent':
      return {
        type: 'agent',
        data: {
          ...line.data,
          label: line.data.agentType ?? line.data.id,
          workflow: line.data.workflow === null ? null : { ...line.data.workflow, name: null },
        },
      };
    case 'workflow':
      return { type: 'workflow', data: { ...line.data, name: null } };
    case 'event':
      return { type: 'event', data: { ...line.data, summary: '' } };
    case 'tool_call':
      return { type: 'tool_call', data: { ...line.data, summary: null } };
    case 'header':
    case 'work_item':
    case 'turn':
    case 'usage':
    case 'transition':
    case 'alert':
    case 'transcript':
    case 'trailer':
      return line;
  }
}

// ---- scope ----------------------------------------------------------------------------------------------------------------------

interface Scope {
  /** Some filter limits the sessions (`session`, `workItem`, a time window). */
  readonly narrowed: boolean;
  /** Terms over `sessions s`; `1` when nothing limits. */
  readonly sessionWhere: string;
  readonly params: Record<string, SqlValue>;
  readonly window: { readonly fromMs: number | null; readonly toMs: number; readonly custom: boolean } | null;
  readonly workItemParam: string | null;
}

function scopeOf(ctx: ExportContext, query: ExportQuery): Scope {
  const bind = new Binder();
  const where: string[] = [];
  let window: Scope['window'] = null;
  if (query.range !== undefined || query.from !== undefined || query.to !== undefined) {
    const resolved = resolveTimeWindow(
      {
        ...(query.range === undefined ? {} : { range: query.range }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
      },
      { nowMs: ctx.clock.now(), defaultRange: 'all', windowHours: ctx.config.monitor.window_hours },
    );
    // an export has no size cap: a span beyond ten years is just an invalid range
    if (!resolved.ok) throw new QueryRefusal('range_invalid');
    window = { ...resolved.window, custom: resolved.source === 'custom' };
    if (window.fromMs !== null) where.push(`s.last_activity_at >= ${bind.bind(window.fromMs)}`);
    where.push(`s.started_at < ${bind.bind(window.toMs)}`);
  }
  if (query.session !== undefined) where.push(`s.session_uid IN ${bind.list(query.session)}`);
  let workItemParam: string | null = null;
  if (query.workItem !== undefined) {
    workItemParam = bind.bind(query.workItem);
    where.push(`s.id IN (SELECT session_id FROM work_item_sessions WHERE work_item_id = ${workItemParam})`);
  }
  return {
    narrowed: where.length > 0,
    sessionWhere: where.length === 0 ? '1' : where.join(' AND '),
    params: bind.params,
    window,
    workItemParam,
  };
}

// ---- readers --------------------------------------------------------------------------------------------------------------------

/** The records of one type, read in pages of ids. */
interface Reader {
  readonly include: ExportInclude;
  readonly type: (typeof EXPORT_RECORD_TYPES)[number];
  /** The rows after id `last`: their lines, and the id of the last row read; `null` when there are none. */
  page(last: number, limit: number): { lines: ExportLine[]; rows: number; last: number } | null;
}

interface TurnRow {
  id: number;
  sessionId: string;
  agentUid: string | null;
  promptId: string;
  startedAt: number | null;
  endedAt: number | null;
  endKind: string | null;
  origin: string | null;
  toolCount: number;
}

interface UsageRow {
  id: number;
  messageKey: string;
  sessionId: string;
  agentUid: string | null;
  model: string;
  ts: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  cacheCreation5m: number | null;
  cacheCreation1h: number | null;
  thinking: number | null;
  finalized: number;
  synthetic: number;
  usageSource: string;
  files: number;
}

/** A work item or a tool call that a page names but that is gone by the time it is hydrated is skipped, never an error. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

function withoutLabels(event: ActivityEvent): Extract<ExportLine, { type: 'event' }>['data'] {
  return {
    id: event.id,
    seq: event.seq,
    key: event.key,
    sessionId: event.sessionId,
    agentId: event.agentId,
    at: event.at,
    atSource: event.atSource,
    receivedAt: event.receivedAt,
    sources: event.sources,
    source: event.source,
    type: event.type,
    category: event.category,
    severity: event.severity,
    hookEvent: event.hookEvent,
    entryKind: event.entryKind,
    toolName: event.toolName,
    toolUseId: event.toolUseId,
    toolStatus: event.toolStatus,
    durationMs: event.durationMs,
    summary: event.summary,
    details: event.details,
    transcriptRef: event.transcriptRef,
  };
}

function readersOf(db: InstanceDb, ctx: ExportContext, scope: Scope, queries: Queries): Reader[] {
  const { driver } = db;
  const nowMs = ctx.clock.now();
  /** ` AND <column> IN (the selected sessions)`, or nothing when no filter limits the sessions. */
  const restrict = (column: string): string =>
    scope.narrowed ? ` AND ${column} IN (SELECT s.id FROM sessions s WHERE ${scope.sessionWhere})` : '';
  const idsSql = (table: string, alias: string, extra: string): string =>
    `SELECT ${alias}.id AS id FROM ${table} ${alias} WHERE ${alias}.id > :last${extra} ORDER BY ${alias}.id LIMIT :limit`;
  const idsOf = (sql: string, last: number, limit: number): number[] =>
    driver
      .prepare<{ id: number }>(sql)
      .all({ ...scope.params, last, limit })
      .map((row) => row.id);
  const jsonIds = (ids: readonly number[]): string => JSON.stringify(ids);

  const sessionsSql = idsSql('sessions', 's', scope.narrowed ? ` AND (${scope.sessionWhere})` : '');
  const agentsSql = idsSql('agents', 'a', restrict('a.session_id'));
  const workflowsSql = idsSql('workflow_runs', 'w', restrict('w.session_id'));
  const workItemsSql = idsSql(
    'work_items',
    'w',
    scope.narrowed
      ? ` AND (w.id IN (SELECT ws.work_item_id FROM work_item_sessions ws WHERE ws.session_id IN
            (SELECT s.id FROM sessions s WHERE ${scope.sessionWhere}))${scope.workItemParam === null ? '' : ` OR w.id = ${scope.workItemParam}`})`
      : '',
  );
  const eventsSql = idsSql('events', 'e', restrict('e.session_id'));
  const toolCallsSql = idsSql('tool_calls', 't', restrict('t.session_id'));
  const alertsSql = idsSql('alerts', 'a', restrict('a.session_id'));
  const turnsSql = `SELECT t.id AS id, ses.session_uid AS sessionId, a.agent_uid AS agentUid, t.prompt_id AS promptId,
      t.started_at AS startedAt, t.ended_at AS endedAt, t.end_kind AS endKind, t.origin AS origin, t.tool_count AS toolCount
    FROM turns t JOIN sessions ses ON ses.id = t.session_id LEFT JOIN agents a ON a.id = t.agent_id
   WHERE t.id > :last${restrict('t.session_id')} ORDER BY t.id LIMIT :limit`;
  const usageSql = `SELECT u.id AS id, u.message_key AS messageKey, ses.session_uid AS sessionId, a.agent_uid AS agentUid,
      u.model AS model, u.ts AS ts, u.input_tokens AS input, u.output_tokens AS output, u.cache_read_tokens AS cacheRead,
      u.cache_creation_tokens AS cacheCreation, u.cache_creation_5m_tokens AS cacheCreation5m,
      u.cache_creation_1h_tokens AS cacheCreation1h, u.thinking_tokens AS thinking, u.finalized AS finalized,
      u.synthetic AS synthetic, u.usage_source AS usageSource, u.files AS files
    FROM usage u JOIN sessions ses ON ses.id = u.session_id LEFT JOIN agents a ON a.id = u.agent_id
   WHERE u.id > :last${restrict('u.session_id')} ORDER BY u.id LIMIT :limit`;
  const transitionsSql = `SELECT t.id AS id, t.at AS at, a.agent_uid AS agentUid, t.from_state AS fromState,
      t.to_state AS toState, t.rule AS rule, t.basis AS basis, t.confidence AS confidence, t.evidence AS evidence,
      ses.session_uid AS sessionId
    FROM state_transitions t JOIN sessions ses ON ses.id = t.session_id LEFT JOIN agents a ON a.id = t.agent_id
   WHERE t.id > :last${restrict('t.session_id')} ORDER BY t.id LIMIT :limit`;

  /** A reader over a table whose rows are hydrated from their ids. */
  const byIds = (
    include: ExportInclude,
    type: Reader['type'],
    sql: string,
    hydrate: (ids: number[]) => ExportLine[],
  ): Reader => ({
    include,
    type,
    page(last, limit) {
      const ids = idsOf(sql, last, limit);
      const tail = ids.at(-1);
      return tail === undefined ? null : { lines: hydrate(ids), rows: ids.length, last: tail };
    },
  });

  return [
    byIds('sessions', 'session', sessionsSql, (ids) => {
      const extra = new Map(
        driver
          .prepare<{ uid: string; cwd: string | null; gitBranch: string | null; permissionMode: string | null }>(
            `SELECT session_uid AS uid, cwd, git_branch AS gitBranch, permission_mode AS permissionMode
               FROM sessions WHERE id IN (SELECT value FROM json_each(:ids))`,
          )
          .all({ ids: jsonIds(ids) })
          .map((row) => [row.uid, row] as const),
      );
      return queries.sessionSummaries(ctx, ids).map((summary): ExportLine => {
        const more = extra.get(summary.id);
        return {
          type: 'session',
          data: {
            ...summary,
            cwd: more?.cwd ?? null,
            gitBranch: more?.gitBranch ?? null,
            permissionMode: more?.permissionMode ?? null,
          },
        };
      });
    }),

    byIds('agents', 'agent', agentsSql, (ids) =>
      ids.flatMap((id): ExportLine[] => {
        const node = queries.agentNode(ctx, id);
        return node === null ? [] : [{ type: 'agent', data: node }];
      }),
    ),

    byIds('workflows', 'workflow', workflowsSql, (ids) =>
      ids.flatMap((id): ExportLine[] => {
        const run = queries.workflowRun(ctx, id);
        return run === null ? [] : [{ type: 'workflow', data: run }];
      }),
    ),

    byIds('work_items', 'work_item', workItemsSql, (ids) =>
      ids.flatMap((id): ExportLine[] => {
        try {
          const full = queries.getWorkItem(ctx, id);
          // the route answer adds the member sessions and asOfSeq to the item; the export carries the item alone
          const item = WorkItemSchema.parse(
            Object.fromEntries(Object.entries(full).filter(([key]) => key in WorkItemSchema.shape)),
          );
          return [{ type: 'work_item', data: item }];
        } catch (error) {
          if (isNotFound(error)) return [];
          throw error;
        }
      }),
    ),

    {
      include: 'turns',
      type: 'turn',
      page(last, limit) {
        const rows = driver.prepare<TurnRow>(turnsSql).all({ ...scope.params, last, limit });
        const tail = rows.at(-1);
        if (tail === undefined) return null;
        const lines = rows.flatMap((row): ExportLine[] => {
          // a turn that was only known from a tool call has no time at all: the format cannot hold it
          const startedAt = row.startedAt ?? row.endedAt;
          if (startedAt === null) return [];
          return [
            {
              type: 'turn',
              data: {
                sessionId: row.sessionId,
                agentId: row.agentUid ?? 'main',
                promptId: row.promptId,
                startedAt: isoMsZ(startedAt),
                endedAt: row.endedAt === null ? null : isoMsZ(row.endedAt),
                endKind: row.endKind,
                origin: row.origin,
                toolCount: row.toolCount,
              },
            },
          ];
        });
        return { lines, rows: rows.length, last: tail.id };
      },
    },

    byIds('events', 'event', eventsSql, (ids) =>
      eventsByIds(db, ids).map((event): ExportLine => ({ type: 'event', data: withoutLabels(event) })),
    ),

    byIds('tool_calls', 'tool_call', toolCallsSql, (ids) => {
      const lines: ExportLine[] = [];
      for (let from = 0; from < ids.length; from += TOOL_CALL_CHUNK) {
        for (const call of queries.toolCallsByIds(ctx, ids.slice(from, from + TOOL_CALL_CHUNK))) {
          lines.push({ type: 'tool_call', data: call });
        }
      }
      return lines;
    }),

    {
      include: 'usage',
      type: 'usage',
      page(last, limit) {
        const rows = driver.prepare<UsageRow>(usageSql).all({ ...scope.params, last, limit });
        const tail = rows.at(-1);
        if (tail === undefined) return null;
        const lines = rows.map((row): ExportLine => ({
          type: 'usage',
          data: {
            messageKey: row.messageKey,
            sessionId: row.sessionId,
            agentId: row.agentUid ?? 'main',
            model: row.model,
            ts: isoMsZ(row.ts),
            input: row.input,
            output: row.output,
            cacheRead: row.cacheRead,
            cacheCreation: row.cacheCreation,
            cacheCreation5m: row.cacheCreation5m,
            cacheCreation1h: row.cacheCreation1h,
            thinking: row.thinking,
            finalized: row.finalized === 1,
            synthetic: row.synthetic === 1,
            usageSource: row.usageSource,
            files: row.files,
          },
        }));
        return { lines, rows: rows.length, last: tail.id };
      },
    },

    {
      include: 'transitions',
      type: 'transition',
      page(last, limit) {
        const rows = driver
          .prepare<TransitionDbRow & { sessionId: string }>(transitionsSql)
          .all({ ...scope.params, last, limit });
        const tail = rows.at(-1);
        if (tail === undefined) return null;
        const lines = rows.map((row): ExportLine => ({
          type: 'transition',
          data: { ...toTransitionItem(row, nowMs), sessionId: row.sessionId },
        }));
        return { lines, rows: rows.length, last: tail.id };
      },
    },

    byIds('alerts', 'alert', alertsSql, (ids) => {
      const bind = new Binder();
      const found = selectAlerts(
        db,
        [`a.id IN (SELECT value FROM json_each(${bind.bind(jsonIds(ids))}))`],
        bind,
        ids.length,
      );
      return found
        .map((entry) => entry.item)
        .sort((a, b) => a.id - b.id)
        .map((alert): ExportLine => ({ type: 'alert', data: alert }));
    }),
  ];
}

// ---- transcript content ---------------------------------------------------------------------------------------------------------

interface MissingTranscript {
  readonly sessionId: string;
  readonly agentId: string;
}

/** A refusal of the transcript service other than a stop; recognised by name, like the server does, so any copy of the class counts. */
function isMissingTranscript(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TranscriptError') return false;
  const code: unknown = Reflect.get(error, 'code');
  return code !== 'aborted';
}

/**
 * One window of a transcript, or `null` when the file or the agent is no longer there (the trailer lists it). A stop of the
 * export is not a missing file and passes on.
 */
async function windowOf(
  transcripts: Pick<TranscriptWindowQueries, 'window'>,
  ctx: RepoContext,
  sessionId: string,
  agent: string,
  after: number,
  signal: AbortSignal,
): Promise<TranscriptWindowResponse | null> {
  try {
    return await transcripts.window(ctx, { sessionId, agent, after, limit: TRANSCRIPT_ENTRIES }, signal);
  } catch (error) {
    if (isMissingTranscript(error)) return null;
    throw error;
  }
}

/**
 * With `includeContent`: after the records, the display entries of every transcript file of the selected sessions that is
 * still on disk, 500 per line, thinking entries left out (03 11.1 step 3). A file that is gone is listed for the trailer.
 */
async function writeTranscripts(
  db: InstanceDb,
  ctx: ExportContext,
  scope: Scope,
  sink: LineSink,
  signal: AbortSignal,
  pageSize: number,
): Promise<{ lines: number; missing: MissingTranscript[] }> {
  const { transcripts } = ctx;
  if (transcripts === undefined) throw new RangeError('includeContent needs the transcript window of the instance');
  const { driver } = db;
  const sessionsSql = `SELECT s.id AS id, s.session_uid AS uid FROM sessions s
     WHERE s.id > :last${scope.narrowed ? ` AND (${scope.sessionWhere})` : ''} ORDER BY s.id LIMIT :limit`;
  const filesSql = `SELECT agent_uid AS agentUid, kind, state FROM transcript_files
     WHERE session_uid = :uid AND kind IN ('session', 'subagent', 'workflow_agent') ORDER BY id`;
  const missing: MissingTranscript[] = [];
  let written = 0;
  let last = 0;
  for (;;) {
    signal.throwIfAborted();
    const sessions = driver
      .prepare<{ id: number; uid: string }>(sessionsSql)
      .all({ ...scope.params, last, limit: pageSize });
    if (sessions.length === 0) break;
    for (const session of sessions) {
      const files = driver
        .prepare<{ agentUid: string | null; kind: string; state: string }>(filesSql)
        .all({ uid: session.uid });
      for (const file of files) {
        const agentId = file.kind === 'session' ? 'main' : file.agentUid;
        if (agentId === null) continue;
        if (file.state === 'missing') {
          missing.push({ sessionId: session.uid, agentId });
          continue;
        }
        let from = 0;
        for (;;) {
          signal.throwIfAborted();
          const response = await windowOf(transcripts, ctx, session.uid, agentId, from, signal);
          if (response === null) {
            missing.push({ sessionId: session.uid, agentId });
            break;
          }
          if (response.events.length > 0) {
            await sink.line({ type: 'transcript', sessionId: session.uid, agentId, entries: response.events });
            written += 1;
          }
          if (response.next >= response.total || response.next <= from) break;
          from = response.next;
        }
      }
    }
    const tail = sessions.at(-1);
    if (tail === undefined || sessions.length < pageSize) break;
    last = tail.id;
    await yieldToLoop();
  }
  return { lines: written, missing };
}

// ---- the export -----------------------------------------------------------------------------------------------------------------

/** The refusals that come before the first byte, and the scope of the query. */
function checkQuery(ctx: ExportContext, query: ExportQuery): Scope {
  if (query.includeContent === true && query.redaction === 'strict') {
    throw new RangeError('includeContent is not allowed with strict redaction');
  }
  if (query.includeContent === true && ctx.transcripts === undefined) {
    throw new RangeError('includeContent needs the transcript window of the instance');
  }
  return scopeOf(ctx, query);
}

/**
 * Throws what `exportInstance` would throw before it writes the first byte (`RangeError`, or `QueryRefusal('range_invalid')`).
 * The server asks before it makes the copy of the database and before it sends the headers, so that a bad query is a plain 400.
 */
export function assertExportable(ctx: ExportContext, query: ExportQuery): void {
  checkQuery(ctx, query);
}

function includesOf(query: ExportQuery): readonly ExportInclude[] {
  const wanted = query.include;
  return wanted === undefined ? EXPORT_INCLUDES : EXPORT_INCLUDES.filter((name) => wanted.includes(name));
}

/**
 * Writes the export of `db` to `out` and returns what it wrote. The caller creates and ends the stream. A refused query is
 * thrown before the first byte: `RangeError` for `includeContent` with `strict` redaction (the API answers that earlier, 400
 * `validation_failed`), `QueryRefusal('range_invalid')` for a time range that is not valid. `signal` stops the export
 * between pages and while the output is full.
 */
export async function exportInstance(
  db: InstanceDb,
  ctx: ExportContext,
  query: ExportQuery,
  out: ExportOutput,
  signal: AbortSignal,
  options: ExportOptions = {},
): Promise<ExportSummary> {
  db.assertScope(ctx);
  const scope = checkQuery(ctx, query);
  signal.throwIfAborted();
  const sink = createLineSink(out, signal);
  try {
    return await writeExport(db, ctx, query, scope, sink, signal, options.pageSize ?? PAGE_SIZE);
  } finally {
    sink.release();
  }
}

async function writeExport(
  db: InstanceDb,
  ctx: ExportContext,
  query: ExportQuery,
  scope: Scope,
  sink: LineSink,
  signal: AbortSignal,
  pageSize: number,
): Promise<ExportSummary> {
  const redaction = query.redaction ?? 'standard';
  const includeContent = query.includeContent === true;
  const included = includesOf(query);
  const queries = createQueries(db, {
    config: ctx.config,
    now: () => ctx.clock.now(),
    audit: { entriesBetween: () => Promise.resolve([]) },
  });
  const finalize = (line: ExportLine): ExportLine => (redaction === 'strict' ? redactLine(line) : line);

  const scopedSessions =
    query.session !== undefined || query.workItem !== undefined
      ? db.driver
          .prepare<{ uid: string }>(
            `SELECT s.session_uid AS uid FROM sessions s WHERE ${scope.sessionWhere} ORDER BY s.id`,
          )
          .all(scope.params)
          .map((row) => row.uid)
      : [];
  const nowMs = ctx.clock.now();
  const scopeFrom = scope.window?.fromMs ?? null;
  await sink.line({
    type: 'header',
    format: EXPORT_FORMAT,
    instanceId: ctx.instanceId,
    slug: ctx.slug,
    exportedAt: isoMsZ(nowMs),
    runtimeVersion: ctx.runtimeVersion,
    dbSchemaVersion: pragmaNumber(db.driver, 'user_version'),
    scope: {
      from: scopeFrom === null ? null : isoMsZ(scopeFrom),
      to: isoMsZ(scope.window?.custom === true ? scope.window.toMs : nowMs),
      sessions: scopedSessions,
    },
    include: [...included],
    redaction,
    includeContent,
    privacyNote: includeContent ? PRIVACY_CONTENT : PRIVACY_METADATA,
  });

  const counts: Record<string, number> = {};
  for (const reader of readersOf(db, ctx, scope, queries)) {
    if (!included.includes(reader.include)) continue;
    counts[reader.type] = 0;
    let last = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = reader.page(last, pageSize);
      if (page === null) break;
      for (const line of page.lines) await sink.line(finalize(line));
      counts[reader.type] = (counts[reader.type] ?? 0) + page.lines.length;
      last = page.last;
      if (page.rows < pageSize) break;
      await yieldToLoop();
    }
  }
  let missingTranscripts: MissingTranscript[] = [];
  if (includeContent) {
    const content = await writeTranscripts(db, ctx, scope, sink, signal, pageSize);
    counts['transcript'] = content.lines;
    missingTranscripts = content.missing;
  }
  const sha256 = sink.digest();
  await sink.line({ type: 'trailer', counts, missingTranscripts, sha256 });
  await sink.finish();
  return { lines: sink.lines, bytes: sink.bytes, sha256, counts, includeContent };
}
