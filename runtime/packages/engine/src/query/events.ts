// `listEvents`, `getEvent` and `eventsByIdRange` (03 5.3, 5.4, 6.1, 6.3, 3.7, 12.1). Three modes on one function: history pages
// (a keyset over `(ts, ts_rank, id)`, newest first by default), `around=<eventId>` (the page whose middle is that event)
// and the live tail `afterId` (ascending by id). Bounded by structure: the filters that cannot be answered from an index
// (`q`, `tool`) need a session or a window of at most 7 days (`filter_requires_scope`), and `q` scans at most the newest
// 50,000 rows of the window (`scanCapped`).
import {
  CATEGORY_OF,
  EVENT_KINDS,
  foldQuery,
  type ActivityEvent,
  type EventKind,
  type EventListQuery,
  type EventPage,
  type ToolStatus,
} from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { QueryDeps } from '../runtime/context.ts';
import {
  Binder,
  NotFoundError,
  QueryRefusal,
  agentRowId,
  filterOf,
  flatRecord,
  idsParam,
  isNarrow,
  iso,
  kindsOfCategories,
  likeContains,
  numericKey,
  readCursor,
  resolveWindow,
  snapshot,
  toolStatusOf,
  writeCursor,
  type PageSpec,
  type PathSessionOptions,
  type Resume,
  type Window,
} from './transitions.ts';

export interface EventQueries {
  listEvents(ctx: RepoContext, q: EventListQuery, options?: PathSessionOptions): EventPage;
  getEvent(ctx: RepoContext, eventId: number): ActivityEvent & { asOfSeq: number };
  /** Hydration of an `event/append` frame (03 9.3): the events of a session with `from <= id <= to`, ascending by id. */
  eventsByIdRange(ctx: RepoContext, sessionRowId: number, from: number, to: number, limit: number): ActivityEvent[];
}

/** `q` scans at most this many of the newest rows of the window (03 3.7 rule 2). */
const SCAN_CAP = 50_000;
const SEVERITIES: Readonly<Record<'info' | 'warning' | 'error', number>> = { info: 0, warning: 1, error: 2 };
const SEVERITY_NAMES = ['info', 'warning', 'error'] as const;
/** Two decimal digits of `ts_rank` (0..99) share the cursor key with `ts`. */
const RANK_STEP = 100;

// ---- rows ------------------------------------------------------------------------------------------------------------------

interface EventDbRow {
  id: number;
  seq: number;
  eventUid: string | null;
  naturalKey: string | null;
  recordUuid: string | null;
  sessionUid: string;
  sessionLabel: string;
  agentUid: string | null;
  agentLabel: string | null;
  agentType: string | null;
  ts: number;
  tsRank: number;
  tsSource: ActivityEvent['atSource'];
  receivedAt: number;
  sources: number;
  kind: string;
  entryKind: ActivityEvent['entryKind'];
  severity: number;
  hookEvent: string | null;
  toolName: string | null;
  toolUseId: string | null;
  summary: string | null;
  detail: string | null;
  fileId: number | null;
  byteOffset: number | null;
}

const EVENT_COLUMNS = `e.id AS id, e.change_seq AS seq, e.event_uid AS eventUid, e.natural_key AS naturalKey,
  e.record_uuid AS recordUuid, s.session_uid AS sessionUid, s.label AS sessionLabel, a.agent_uid AS agentUid,
  a.label AS agentLabel, a.agent_type AS agentType, e.ts AS ts, e.ts_rank AS tsRank, e.ts_source AS tsSource,
  e.received_at AS receivedAt, e.sources AS sources, e.kind AS kind, e.entry_kind AS entryKind, e.severity AS severity,
  e.hook_event AS hookEvent, e.tool_name AS toolName, e.tool_use_id AS toolUseId, e.summary AS summary,
  e.detail AS detail, e.file_id AS fileId, e.byte_offset AS byteOffset`;

const EVENT_FROM = 'events e JOIN sessions s ON s.id = e.session_id LEFT JOIN agents a ON a.id = e.agent_id';

function kindOf(stored: string): EventKind {
  return EVENT_KINDS.find((kind) => kind === stored) ?? 'system.info';
}

function sourcesOf(bits: number): ActivityEvent['sources'] {
  const out: ActivityEvent['sources'] = [];
  if ((bits & 1) !== 0) out.push('hook');
  if ((bits & 2) !== 0) out.push('transcript');
  if ((bits & 4) !== 0) out.push('monitor');
  return out.length > 0 ? out : ['monitor'];
}

/** The stored label, else the agent type, else the agent id (03 5.5); `null` for an event of the session itself. */
function agentLabelOf(row: EventDbRow): string | null {
  if (row.agentUid === null) return null;
  return row.agentLabel !== null && row.agentLabel !== '' ? row.agentLabel : (row.agentType ?? row.agentUid);
}

function keyOf(row: EventDbRow): string {
  if (row.naturalKey !== null) return row.naturalKey;
  if (row.eventUid !== null) return `h:${row.eventUid}`;
  return `t:${row.recordUuid ?? String(row.id)}`;
}

interface ToolFacts {
  status: ToolStatus;
  durationMs: number | null;
}

/** The status and duration of the tool calls that the events of a page mention, by one primary-key lookup. */
function toolFactsOf(db: InstanceDb, rows: readonly EventDbRow[]): Map<string, ToolFacts> {
  const ids = rows.flatMap((row) => (row.toolUseId === null ? [] : [row.toolUseId]));
  const facts = new Map<string, ToolFacts>();
  if (ids.length === 0) return facts;
  for (const call of db.driver
    .prepare<{
      toolUseId: string;
      outcome: 'ok' | 'error' | 'denied' | 'interrupted' | null;
      endedAt: number | null;
      batchAt: number | null;
      durationMs: number | null;
    }>(
      `SELECT tool_use_id AS toolUseId, outcome, ended_at AS endedAt, batch_at AS batchAt, duration_ms AS durationMs
         FROM tool_calls WHERE tool_use_id IN (SELECT value FROM json_each(:ids))`,
    )
    .all({ ids: idsParam(ids) })) {
    facts.set(call.toolUseId, {
      status: toolStatusOf(call.outcome, call.endedAt, call.batchAt),
      durationMs: call.durationMs,
    });
  }
  return facts;
}

function detailDuration(details: ActivityEvent['details']): number | null {
  const value = details['durationMs'] ?? details['duration_ms'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function eventItems(db: InstanceDb, rows: readonly EventDbRow[]): ActivityEvent[] {
  const tools = toolFactsOf(db, rows);
  return rows.map((row): ActivityEvent => {
    const kind = kindOf(row.kind);
    const sources = sourcesOf(row.sources);
    const details = flatRecord(row.detail);
    const tool = row.toolUseId === null ? undefined : tools.get(row.toolUseId);
    return {
      id: row.id,
      seq: row.seq,
      key: keyOf(row),
      sessionId: row.sessionUid,
      sessionLabel: row.sessionLabel,
      agentId: row.agentUid,
      agentLabel: agentLabelOf(row),
      at: iso(row.ts),
      atSource: row.tsSource,
      receivedAt: iso(row.receivedAt),
      sources,
      source: sources[0] ?? 'monitor',
      type: kind,
      category: CATEGORY_OF[kind],
      severity: SEVERITY_NAMES[row.severity] ?? 'info',
      hookEvent: row.hookEvent,
      entryKind: row.entryKind,
      toolName: row.toolName,
      toolUseId: row.toolUseId,
      toolStatus: tool?.status ?? null,
      durationMs: tool?.durationMs ?? detailDuration(details),
      summary: row.summary ?? '',
      details,
      transcriptRef:
        row.fileId === null || row.byteOffset === null
          ? null
          : { agentId: row.agentUid ?? 'main', offset: row.byteOffset },
    };
  });
}

// ---- scope and filters -----------------------------------------------------------------------------------------------------

interface Scope {
  /** `null` = no `session` filter; a list (possibly empty: every named session is unknown). */
  readonly sessionIds: readonly number[] | null;
  readonly agentId: number | null;
}

function resolveScope(db: InstanceDb, q: EventListQuery, options: PathSessionOptions): Scope {
  let sessionIds: number[] | null = null;
  if (q.session !== undefined) {
    const bind = new Binder();
    sessionIds = db.driver
      .prepare<{ id: number }>(`SELECT id FROM sessions WHERE session_uid IN ${bind.list(q.session)}`)
      .all(bind.params)
      .map((row) => row.id);
    if (options.pathSession === true && sessionIds.length === 0) throw new NotFoundError('session_not_found');
  }
  let agentId: number | null = null;
  if (q.agent !== undefined) {
    const only = sessionIds?.[0];
    if (only === undefined) throw new NotFoundError('session_not_found');
    const found = agentRowId(db, only, q.agent);
    if (found === undefined) throw new NotFoundError('agent_not_found');
    agentId = found;
  }
  return { sessionIds, agentId };
}

/** The `type` and `category` filters together: the kinds that satisfy both (`null` = neither is set). */
function kindFilter(q: EventListQuery): readonly EventKind[] | null {
  const byCategory = q.category === undefined ? null : kindsOfCategories(q.category);
  if (q.type === undefined) return byCategory;
  return byCategory === null ? q.type : q.type.filter((kind) => byCategory.includes(kind));
}

/** The `WHERE` terms that make the result set (everything except the keyset and the id modes), over `events e`. */
function filterTerms(q: EventListQuery, scope: Scope, window: Window, bind: Binder): string[] {
  const where: string[] = [];
  if (scope.sessionIds !== null) {
    const [only] = scope.sessionIds;
    where.push(
      scope.sessionIds.length === 1 && only !== undefined
        ? `e.session_id = ${bind.bind(only)}`
        : `e.session_id IN ${bind.list(scope.sessionIds)}`,
    );
  }
  if (scope.agentId !== null) where.push(`e.agent_id = ${bind.bind(scope.agentId)}`);
  if (q.project !== undefined) {
    where.push(
      `e.session_id IN (SELECT id FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)}))`,
    );
  }
  if (q.workItem !== undefined) {
    where.push(
      `e.session_id IN (SELECT session_id FROM work_item_sessions WHERE work_item_id = ${bind.bind(q.workItem)})`,
    );
  }
  const kinds = kindFilter(q);
  if (kinds !== null) where.push(kinds.length === 0 ? '0' : `e.kind IN ${bind.list(kinds)}`);
  if (q.severity !== undefined) {
    const levels = q.severity.map((name) => SEVERITIES[name]);
    where.push(`e.severity IN ${bind.list(levels)}`);
    // lets the partial index of problems answer a filter that excludes `info`
    if (!levels.includes(0)) where.push('e.severity > 0');
  }
  if (q.tool !== undefined) {
    const bounds = [
      window.fromMs === null ? '' : ` AND started_at >= ${bind.bind(window.fromMs)}`,
      ` AND started_at < ${bind.bind(window.toMs)}`,
    ].join('');
    where.push(
      `e.tool_use_id IN (SELECT tool_use_id FROM tool_calls INDEXED BY idx_tool_calls_name WHERE name IN ${bind.list(q.tool)}${bounds})`,
    );
  }
  if (window.fromMs !== null) where.push(`e.ts >= ${bind.bind(window.fromMs)}`);
  where.push(`e.ts < ${bind.bind(window.toMs)}`);
  return where;
}

/** The text condition of `q` over the rows of the capped scan (alias `c`), ASCII case-insensitive like SQLite `LIKE`. */
function textTerm(q: string, bind: Binder): string {
  const pattern = bind.bind(likeContains(foldQuery(q)));
  return `(c.summary LIKE ${pattern} ESCAPE '\\' OR c.tool_name LIKE ${pattern} ESCAPE '\\')`;
}

type Direction = 'asc' | 'desc';

/** `(ts, ts_rank)` as the single number a cursor carries, and back. */
function sortKeyOf(row: Pick<EventDbRow, 'ts' | 'tsRank'>): number {
  return row.ts * RANK_STEP + row.tsRank;
}

interface Position {
  readonly ts: number;
  readonly rank: number;
  readonly id: number;
}

function positionOf(resume: Resume): Position {
  const key = numericKey(resume);
  if (!Number.isSafeInteger(key) || key < 0) throw new QueryRefusal('cursor_invalid');
  return { ts: Math.floor(key / RANK_STEP), rank: key % RANK_STEP, id: resume.i };
}

/** The keyset term for rows strictly after `at` in the direction `dir`; the plain `ts` bound lets the index narrow the range. */
function keysetTerm(at: Position, dir: Direction, bind: Binder): string {
  const op = dir === 'desc' ? '<' : '>';
  const edge = dir === 'desc' ? '<=' : '>=';
  const ts = bind.bind(at.ts);
  return `e.ts ${edge} ${ts} AND (e.ts, e.ts_rank, e.id) ${op} (${ts}, ${bind.bind(at.rank)}, ${bind.bind(at.id)})`;
}

interface Fetch {
  readonly q: EventListQuery;
  readonly scope: Scope;
  readonly window: Window;
  readonly dir: Direction;
  readonly after: Position | null;
  readonly limit: number;
  /** Extra terms over `e` (the id modes). */
  readonly extra?: (bind: Binder) => string[];
}

/** The rows of one ordered scan, and whether the capped scan of `q` reached its cap. */
function fetchRows(db: InstanceDb, f: Fetch): { rows: EventDbRow[]; capped: boolean } {
  const bind = new Binder();
  const where = filterTerms(f.q, f.scope, f.window, bind);
  if (f.after !== null) where.push(keysetTerm(f.after, f.dir, bind));
  if (f.extra !== undefined) where.push(...f.extra(bind));
  const direction = f.dir.toUpperCase();
  const order = `ORDER BY e.ts ${direction}, e.ts_rank ${direction}, e.id ${direction}`;
  if (f.q.q === undefined) {
    // the page is chosen on `events` alone, by index, and joined to its session and agent afterwards: with the join in
    // the same query the planner may walk the sessions first and sort every event (03 3.7)
    const rows = db.driver
      .prepare<EventDbRow>(
        `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
          WHERE e.id IN (SELECT e.id FROM events e WHERE ${where.join(' AND ')} ${order} LIMIT ${bind.bind(f.limit)})
          ${order}`,
      )
      .all(bind.params);
    return { rows, capped: false };
  }
  // the capped text scan: the newest SCAN_CAP rows of the window, then the text condition, then the page
  const outerOrder = `ORDER BY c.ts ${direction}, c.ts_rank ${direction}, c.id ${direction}`;
  const text = textTerm(f.q.q, bind);
  const rows = db.driver
    .prepare<EventDbRow>(
      `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE e.id IN (
          SELECT c.id FROM (SELECT e.id, e.ts, e.ts_rank, e.summary, e.tool_name FROM events e
                             WHERE ${where.join(' AND ')} ${order} LIMIT ${String(SCAN_CAP)}) c
           WHERE ${text} ${outerOrder} LIMIT ${bind.bind(f.limit)})
        ${order}`,
    )
    .all(bind.params);
  const countBind = new Binder();
  const countWhere = filterTerms(f.q, f.scope, f.window, countBind);
  if (f.after !== null) countWhere.push(keysetTerm(f.after, f.dir, countBind));
  if (f.extra !== undefined) countWhere.push(...f.extra(countBind));
  const scanned =
    db.driver
      .prepare<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM events e WHERE ${countWhere.join(' AND ')} LIMIT ${String(SCAN_CAP)})`,
      )
      .get(countBind.params)?.n ?? 0;
  return { rows, capped: scanned >= SCAN_CAP };
}

function emptyPage(asOfSeq: number, limit: number): EventPage {
  return {
    items: [],
    nextCursor: null,
    asOfSeq,
    total: null,
    totalIsLowerBound: false,
    limit,
    scanCapped: false,
    newerCursor: null,
  };
}

// ---- the part --------------------------------------------------------------------------------------------------------------

export function createEventQueries(db: InstanceDb, deps: QueryDeps): EventQueries {
  function run(q: EventListQuery, options: PathSessionOptions, asOfSeq: number): EventPage {
    const dir: Direction = q.afterId === undefined ? (q.dir ?? 'desc') : 'asc';
    const spec: PageSpec = {
      route: 'listEvents',
      sort: 'at',
      dir,
      filter: filterOf(q, {}, ['around', 'afterId']),
    };
    const resume = q.afterId === undefined && q.around === undefined ? readCursor(q.cursor, spec) : null;
    const window = resolveWindow(deps, q, options.pathSession === true ? 'all' : '24h', resume);
    if ((q.q !== undefined || q.tool !== undefined) && q.session === undefined && !isNarrow(window)) {
      throw new QueryRefusal('filter_requires_scope');
    }
    const scope = resolveScope(db, q, options);
    if (scope.sessionIds !== null && scope.sessionIds.length === 0) return emptyPage(asOfSeq, q.limit);
    const base: Fetch = { q, scope, window, dir, after: null, limit: q.limit + 1 };
    const finish = (rows: EventDbRow[], capped: boolean, cursorWindow: Window): EventPage => {
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > q.limit && last !== undefined ? writeCursor(spec, sortKeyOf(last), last.id, cursorWindow) : null;
      return { ...emptyPage(asOfSeq, q.limit), items: eventItems(db, page), nextCursor, scanCapped: capped };
    };

    if (q.afterId !== undefined) {
      // the live tail: ascending by id, no cursor
      const afterId = q.afterId;
      const { rows, capped } = fetchRows(db, {
        ...base,
        dir: 'asc',
        limit: q.limit,
        extra: (bind) => [`e.id > ${bind.bind(afterId)}`],
      });
      const idOrdered = [...rows].sort((a, b) => a.id - b.id);
      return { ...emptyPage(asOfSeq, q.limit), items: eventItems(db, idOrdered), scanCapped: capped };
    }

    if (q.around !== undefined) return around(q, base, spec, window, asOfSeq, q.around);

    const { rows, capped } = fetchRows(db, { ...base, after: resume === null ? null : positionOf(resume) });
    return finish(rows, capped, window);
  }

  /** The page whose middle is `pivotId`: newer rows (ascending probe), the pivot, older rows; both ends are cursors. */
  function around(
    q: EventListQuery,
    base: Fetch,
    spec: PageSpec,
    window: Window,
    asOfSeq: number,
    pivotId: number,
  ): EventPage {
    const pivots = fetchRows(db, {
      ...base,
      dir: 'desc',
      limit: 1,
      extra: (bind) => [`e.id = ${bind.bind(pivotId)}`],
    }).rows;
    const pivot = pivots[0];
    if (pivot === undefined) throw new NotFoundError('event_not_found');
    const at: Position = { ts: pivot.ts, rank: pivot.tsRank, id: pivot.id };
    const half = Math.floor(q.limit / 2);
    const newerProbe = fetchRows(db, { ...base, dir: 'asc', after: at, limit: half + 1 });
    const newer = newerProbe.rows.slice(0, half);
    const olderLimit = q.limit - 1 - newer.length;
    const olderProbe = fetchRows(db, { ...base, dir: 'desc', after: at, limit: olderLimit + 1 });
    const older = olderProbe.rows.slice(0, olderLimit);
    const items = [...newer.reverse(), pivot, ...older];
    const oldest = older[older.length - 1] ?? pivot;
    const newest = items[0] ?? pivot;
    const hasOlder = olderProbe.rows.length > olderLimit;
    const hasNewer = newerProbe.rows.length > half;
    const descSpec: PageSpec = { ...spec, dir: 'desc' };
    const ascSpec: PageSpec = { ...spec, dir: 'asc' };
    return {
      ...emptyPage(asOfSeq, q.limit),
      items: eventItems(db, items),
      nextCursor: hasOlder ? writeCursor(descSpec, sortKeyOf(oldest), oldest.id, window) : null,
      newerCursor: hasNewer ? writeCursor(ascSpec, sortKeyOf(newest), newest.id, window) : null,
      scanCapped: newerProbe.capped || olderProbe.capped,
    };
  }

  return {
    listEvents: (ctx, q, options = {}) => snapshot(db, ctx, (asOfSeq) => run(q, options, asOfSeq)),

    getEvent: (ctx, eventId) =>
      snapshot(db, ctx, (asOfSeq) => {
        const row = db.driver
          .prepare<EventDbRow>(`SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE e.id = :id`)
          .get({ id: eventId });
        const item = row === undefined ? undefined : eventItems(db, [row])[0];
        if (item === undefined) throw new NotFoundError('event_not_found');
        return { ...item, asOfSeq };
      }),

    eventsByIdRange: (ctx, sessionRowId, from, to, limit) =>
      snapshot(db, ctx, () => {
        const params: Record<string, SqlValue> = { sid: sessionRowId, from, to, limit };
        const rows = db.driver
          .prepare<EventDbRow>(
            `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
              WHERE e.id BETWEEN :from AND :to AND +e.session_id = :sid ORDER BY e.id LIMIT :limit`,
          )
          .all(params);
        return eventItems(db, rows);
      }),
  };
}
