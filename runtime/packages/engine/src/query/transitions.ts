// `sessionTransitions` (03 6.1) and the kernel that every read part of the query layer shares (WP-30). The kernel lives in
// this file because the work package lists no helper file: the snapshot step (one synchronous read with `asOfSeq`, DA-I8),
// the errors the query functions throw, the SQL binder, the keyset cursor helpers (03 5.3), the time window, and the
// projections that sessions, agents, events and tool calls all need (state assessment, token usage, file progress).
//
// Rules kept here (03 3.7, 5.3, 6.4):
//  - a query function reads inside `snapshot`, which takes `asOfSeq` and the rows in one synchronous step;
//  - every statement has a `LIMIT`; a cursor belongs to one route, sort, direction and filter, else `cursor_invalid`;
//  - the window of the first page is frozen in the cursor, later pages do not move with the clock;
//  - a missing value is `null`, a measured zero is `0` (DA-I9).
import {
  CATEGORY_OF,
  EVENT_KINDS,
  cursorMatches,
  decodeCursor,
  encodeCursor,
  filterHash,
  isoMsZ,
  resolveTimeWindow,
  type EvidenceItem,
  type EventCategory,
  type EventKind,
  type LegacyState,
  type LifecycleState,
  type Page,
  type Preset,
  type StateAssessment,
  type TimeWindowQuery,
  type TokenUsage,
  type ToolStatus,
  type TransitionItem,
  type TransitionListQuery,
} from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { parseEvidence } from '../db/repos/transitions.ts';
import { EVIDENCE_FACTS, EVIDENCE_SOURCES, type LifecycleEvidence } from '../lifecycle/facts.ts';
import { toLegacy } from '../lifecycle/legacy.ts';
import { toApiEvidence } from '../lifecycle/rules.ts';
import type { QueryDeps } from '../runtime/context.ts';

// ---- errors ----------------------------------------------------------------------------------------------------------------

/** The 404 codes a query function throws (03 12.1); the server maps them by the name `NotFoundError`. */
export type NotFoundCode = 'session_not_found' | 'agent_not_found' | 'event_not_found';

export class NotFoundError extends Error {
  readonly code: NotFoundCode;

  constructor(code: NotFoundCode) {
    super(code);
    this.name = 'NotFoundError';
    this.code = code;
  }
}

/** The 400 codes a query function throws: the request is well formed but not answerable (03 5.2). */
export type RefusalCode = 'cursor_invalid' | 'range_invalid' | 'range_too_large' | 'filter_requires_scope';

/** A refused request. Route handlers turn it into the envelope of its `code`; the message never carries request data. */
export class QueryRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.name = 'QueryRefusal';
    this.code = code;
  }
}

// ---- snapshot --------------------------------------------------------------------------------------------------------------

/**
 * Runs `read` inside one read transaction and hands it `asOfSeq`, the change-log head read in the same step, so that the
 * data never shows a change the head does not know (DA-I8). Checks the caller's scope first (DA-I3).
 */
export function snapshot<T>(db: InstanceDb, ctx: RepoContext, read: (asOfSeq: number) => T): T {
  db.assertScope(ctx);
  return db.driver.transaction(() => read(db.headSeq()));
}

// ---- SQL building ----------------------------------------------------------------------------------------------------------

/** Collects named parameters while a statement is assembled; values never enter the SQL text. */
export class Binder {
  readonly params: Record<string, SqlValue> = {};
  private next = 0;

  bind(value: SqlValue): string {
    const name = `b${String(this.next)}`;
    this.next += 1;
    this.params[name] = value;
    return `:${name}`;
  }

  /** `(:b0, :b1, ...)`; an empty list is `()`, which SQLite accepts and which matches nothing. */
  list(values: readonly SqlValue[]): string {
    return `(${values.map((value) => this.bind(value)).join(', ')})`;
  }
}

/** A `LIKE` pattern that matches `needle` as a substring, with `\`, `%` and `_` escaped (use `ESCAPE '\'`). */
export function likeContains(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `sessions.id` of a session by its provider id, or `undefined`. */
export function sessionRowId(db: InstanceDb, sessionUid: string): number | undefined {
  return db.driver.prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = :uid').get({ uid: sessionUid })
    ?.id;
}

/** `agents.id` of an agent of a session, or `undefined`. */
export function agentRowId(db: InstanceDb, sessionRowIdValue: number, agentUid: string): number | undefined {
  return db.driver
    .prepare<{ id: number }>('SELECT id FROM agents WHERE session_id = :sid AND agent_uid = :uid')
    .get({ sid: sessionRowIdValue, uid: agentUid })?.id;
}

// ---- time ------------------------------------------------------------------------------------------------------------------

export function iso(ms: number): string {
  return isoMsZ(ms);
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : isoMsZ(ms);
}

const DAY_MS = 86_400_000;
/** Event `q` and `tool` filters need a session or a window of at most this long (03 3.7 rule 2): a `7d` preset is 7 days + 1 ms. */
export const SCOPED_WINDOW_MS = 7 * DAY_MS + 1;

export interface Window {
  /** `null` = no lower bound. */
  readonly fromMs: number | null;
  readonly toMs: number;
  readonly source: 'window_hours' | 'range' | 'custom';
}

/**
 * The window of a request (03 5.4). A cursor carries the window of its first page; the query is still resolved so that a bad
 * `range` refuses the request and so that the source (`window=1` includes pinned sessions) never depends on the clock.
 */
export function resolveWindow(
  deps: QueryDeps,
  query: TimeWindowQuery,
  defaultRange: Preset | 'window',
  resume: Resume | null,
): Window {
  const resolved = resolveTimeWindow(query, {
    nowMs: deps.now(),
    defaultRange,
    windowHours: deps.config.monitor.window_hours,
  });
  if (!resolved.ok) throw new QueryRefusal(resolved.code);
  if (resume !== null && resume.w !== null) {
    return { fromMs: resume.w[0] === 0 ? null : resume.w[0], toMs: resume.w[1], source: resolved.source };
  }
  return { fromMs: resolved.window.fromMs, toMs: resolved.window.toMs, source: resolved.source };
}

/** True when a window is narrow enough for the expensive event filters. */
export function isNarrow(window: Window): boolean {
  return window.fromMs !== null && window.toMs - window.fromMs <= SCOPED_WINDOW_MS;
}

// ---- keyset cursors --------------------------------------------------------------------------------------------------------

export interface PageSpec {
  readonly route: string;
  readonly sort: string;
  readonly dir: 'asc' | 'desc';
  /** The filter that makes a result set: everything except the paging keys (the hash drops `cursor limit includeTotal sort dir`). */
  readonly filter: Readonly<Record<string, unknown>>;
}

/** Where a cursor says the next page starts. */
export interface Resume {
  readonly k: string | number;
  readonly i: number;
  readonly w: readonly [number, number] | null;
}

/** Reads the cursor of a request. `undefined` = first page. A cursor of another route, sort, direction or filter refuses. */
export function readCursor(text: string | undefined, spec: PageSpec): Resume | null {
  if (text === undefined) return null;
  const payload = decodeCursor(text);
  const expected = { r: spec.route, s: spec.sort, d: spec.dir, f: filterHash(spec.filter) };
  if (payload === null || !cursorMatches(payload, expected)) throw new QueryRefusal('cursor_invalid');
  return { k: payload.k, i: payload.i, w: payload.w };
}

/**
 * Encodes the cursor of the row `(k, i)`. The key is the value the keyset compares, so it is never clipped here: a text key
 * is bounded by construction in the query (`LABEL_KEY_CHARS` in sessions.ts), and a key that still does not fit throws
 * `RangeError` instead of paging wrongly.
 */
export function writeCursor(spec: PageSpec, k: string | number, i: number, window: Window | null): string {
  const w: [number, number] | null = window === null ? null : [window.fromMs ?? 0, window.toMs];
  return encodeCursor({ r: spec.route, s: spec.sort, d: spec.dir, i, w, f: filterHash(spec.filter), k });
}

/** The sort key of a cursor of a numeric sort; a text key there means a forged cursor. */
export function numericKey(resume: Resume): number {
  if (typeof resume.k !== 'number') throw new QueryRefusal('cursor_invalid');
  return resume.k;
}

/** A `Page<T>` of `items`; `nextCursor` is `null` when there is nothing more in this direction. */
export function pageOf<T>(
  items: T[],
  o: { nextCursor: string | null; asOfSeq: number; limit: number; total?: number | null; lowerBound?: boolean },
): Page<T> {
  return {
    items,
    nextCursor: o.nextCursor,
    asOfSeq: o.asOfSeq,
    total: o.total ?? null,
    totalIsLowerBound: o.lowerBound ?? false,
    limit: o.limit,
  };
}

/** `includeTotal` is capped at 10,000 (03 5.3). */
export const TOTAL_CAP = 10_000;

/** The filter object of a cursor hash: the query without the keys that choose a page or a mode. */
export function filterOf(
  query: object,
  extra: Readonly<Record<string, unknown>> = {},
  omit: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && !omit.includes(key)) out[key] = value;
  }
  return out;
}

// ---- event kinds -----------------------------------------------------------------------------------------------------------

/** The stored kinds of a set of categories (`category` filter). */
export function kindsOfCategories(categories: readonly EventCategory[]): EventKind[] {
  return EVENT_KINDS.filter((kind) => categories.includes(CATEGORY_OF[kind]));
}

// ---- state assessment ------------------------------------------------------------------------------------------------------

/** The lifecycle view columns as the queries select them (aliases of `viewColumns`). */
export interface ViewRow {
  state: LifecycleState;
  presence: 'open' | 'ended' | 'unknown';
  waitReason: StateAssessment['waitReason'];
  staleKind: StateAssessment['staleKind'];
  endReason: string | null;
  turnOutcome: StateAssessment['turnOutcome'];
  basis: 'observed' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  ruleId: string;
  evidence: string;
  since: number | null;
  evaluatedAt: number | null;
}

/** The columns of a `sessions` or `agents` row that make a `StateAssessment`, with the aliases `ViewRow` expects. */
export function viewColumns(alias: string): string {
  return `${alias}.state AS state, ${alias}.presence AS presence, ${alias}.wait_reason AS waitReason,
    ${alias}.stale_kind AS staleKind, ${alias}.end_reason AS endReason, ${alias}.turn_outcome AS turnOutcome,
    ${alias}.state_basis AS basis, ${alias}.state_confidence AS confidence, ${alias}.state_rule AS ruleId,
    ${alias}.state_evidence AS evidence, ${alias}.state_since AS since, ${alias}.evaluated_at AS evaluatedAt`;
}

function evidenceSource(value: string): LifecycleEvidence['source'] | undefined {
  return EVIDENCE_SOURCES.find((source) => source === value);
}

function evidenceFact(value: string): LifecycleEvidence['fact'] | undefined {
  return EVIDENCE_FACTS.find((fact) => fact === value);
}

/** The API form of a stored evidence column: words rendered at `nowMs`, an item with an unknown source or fact left out (<= 8). */
export function apiEvidence(stored: string, nowMs: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const item of parseEvidence(stored)) {
    const source = evidenceSource(item.source);
    const fact = evidenceFact(item.fact);
    if (source === undefined || fact === undefined) continue;
    const engine: LifecycleEvidence = {
      source,
      fact,
      at: item.at,
      ...(item.count === undefined ? {} : { count: item.count }),
      ...(item.value === undefined ? {} : { value: item.value }),
    };
    items.push(toApiEvidence(engine, nowMs));
    if (items.length === 8) break;
  }
  return items;
}

export function legacyOf(state: LifecycleState): LegacyState {
  return toLegacy({ state });
}

/** `StateAssessment` of a stored view (03 5.5). `evaluatedAt` 0 or missing reads as `null` (never evaluated). */
export function assessmentOf(view: ViewRow, nowMs: number): StateAssessment {
  return {
    state: view.state,
    presence: view.presence,
    waitReason: view.waitReason,
    staleKind: view.staleKind,
    endReason: view.endReason,
    turnOutcome: view.turnOutcome,
    basis: view.basis,
    confidence: view.confidence,
    rule: view.ruleId,
    evidence: apiEvidence(view.evidence, nowMs),
    since: isoOrNull(view.since),
    evaluatedAt: view.evaluatedAt === null || view.evaluatedAt === 0 ? null : isoOrNull(view.evaluatedAt),
    legacyState: legacyOf(view.state),
  };
}

// ---- token usage -----------------------------------------------------------------------------------------------------------

/** What a rollup says about the messages of one scope (a session's columns, an agent's columns, or a grouped `usage` query). */
export interface UsageTotals {
  messages: number;
  synthetic: number;
  unfinalized: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  missingInput: number;
  missingOutput: number;
  missingCacheRead: number;
  missingCacheCreation: number;
}

export const NO_USAGE: UsageTotals = {
  messages: 0,
  synthetic: 0,
  unfinalized: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  missingInput: 0,
  missingOutput: 0,
  missingCacheRead: 0,
  missingCacheCreation: 0,
};

/** The columns of a transcript file the progress projections read (aliases of `FILE_COLUMNS`). */
export interface FileFacts {
  fileId: number;
  sessionUid: string;
  agentUid: string | null;
  agentId: number | null;
  kind: 'session' | 'subagent' | 'workflow_agent' | 'workflow_journal' | 'workflow_status';
  state: 'active' | 'missing' | 'unreadable' | 'untracked' | 'retired';
  usageState: 'complete' | 'partial' | 'skipped_backfill';
  headEnd: number;
  backfillOffset: number;
  tailStart: number;
  tailOffset: number;
  sizeSeen: number;
  partialBytes: number;
  entriesTotal: number;
}

/** `FileFacts` as a column list over `transcript_files f`. */
export const FILE_COLUMNS = `f.id AS fileId, f.session_uid AS sessionUid, f.agent_uid AS agentUid, f.agent_id AS agentId,
  f.kind AS kind, f.state AS state, f.usage_state AS usageState, f.head_end AS headEnd,
  f.backfill_offset AS backfillOffset, f.tail_start AS tailStart, f.tail_offset AS tailOffset, f.size_seen AS sizeSeen,
  f.partial_bytes AS partialBytes, f.entries_total AS entriesTotal`;

/** Bytes of a file the importer has consumed: head, backfill and tail (02 5.5). */
export function consumedBytes(file: FileFacts): number {
  return Math.max(0, file.backfillOffset + file.tailOffset - file.tailStart);
}

/** `floor(100 * consumed / max(1, size - partialBytes))`, at most 100 (02 5.5). */
export function scannedPercent(file: FileFacts): number {
  const denominator = Math.max(1, file.sizeSeen - file.partialBytes);
  return Math.min(100, Math.floor((100 * consumedBytes(file)) / denominator));
}

/** Bytes the file has beyond the tail cursor; only an active file can be behind. */
export function behindBytes(file: FileFacts): number {
  return file.state === 'active' ? Math.max(0, file.sizeSeen - file.tailOffset) : 0;
}

/** The files that carry assistant messages and are still tracked (03 8.2 "contributing files"). */
export function contributing(files: readonly FileFacts[]): FileFacts[] {
  return files.filter(
    (file) =>
      (file.kind === 'session' || file.kind === 'subagent' || file.kind === 'workflow_agent') &&
      file.state !== 'retired',
  );
}

/**
 * `TokenUsage` (02 6.3, 03 8.2): a field is `null` when no counted message has a value for it; `total` is the sum of the
 * non-null fields and `null` without messages; `completeness` follows the contributing files; `scannedPct` is their minimum.
 */
export function tokenUsageOf(totals: UsageTotals, files: readonly FileFacts[]): TokenUsage {
  const counted = contributing(files);
  const field = (sum: number, missing: number): number | null =>
    totals.messages === 0 || missing >= totals.messages ? null : sum;
  const input = field(totals.input, totals.missingInput);
  const output = field(totals.output, totals.missingOutput);
  const cacheCreation = field(totals.cacheCreation, totals.missingCacheCreation);
  const cacheRead = field(totals.cacheRead, totals.missingCacheRead);
  const present = [input, output, cacheCreation, cacheRead].filter((value): value is number => value !== null);
  const everyComplete = counted.every((file) => file.usageState === 'complete');
  const everySkipped = counted.length > 0 && counted.every((file) => file.usageState === 'skipped_backfill');
  const completeness = everyComplete ? 'complete' : everySkipped ? 'unavailable' : 'partial';
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: totals.messages === 0 ? null : present.reduce((sum, value) => sum + value, 0),
    missing: {
      input: totals.missingInput,
      output: totals.missingOutput,
      cacheCreation: totals.missingCacheCreation,
      cacheRead: totals.missingCacheRead,
    },
    turns: totals.messages,
    synthetic: totals.synthetic,
    unfinalized: totals.unfinalized,
    completeness,
    scannedPct: counted.length === 0 ? null : Math.min(...counted.map(scannedPercent)),
    lowerBound: totals.unfinalized > 0 || completeness !== 'complete',
  };
}

// ---- small row readers -----------------------------------------------------------------------------------------------------

const FLAT_VALUE_KEYS = 24;

/** A JSON object column read as a flat record of strings, numbers, booleans and nulls (<= 24 keys); anything else is `{}`. */
export function flatRecord(text: string | null): Record<string, string | number | boolean | null> {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(value)) {
    const item: unknown = Reflect.get(value, key);
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item;
      if (Object.keys(out).length === FLAT_VALUE_KEYS) break;
    }
  }
  return out;
}

/** A JSON array column read as a list of strings. */
export function stringList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** `{ ids: json }` for `... WHERE id IN (SELECT value FROM json_each(:ids))`: one parameter for any number of ids. */
export function idsParam(ids: readonly (number | string)[]): string {
  return JSON.stringify([...new Set(ids)]);
}

// ---- sessionTransitions ----------------------------------------------------------------------------------------------------

export interface TransitionDbRow {
  id: number;
  at: number;
  agentUid: string | null;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  rule: string;
  basis: 'observed' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

/** The API item of a stored transition: `sessionTransitions` and the export (03 11.1) read the same columns. */
export function toTransitionItem(row: TransitionDbRow, nowMs: number): TransitionItem {
  return {
    id: row.id,
    at: iso(row.at),
    agentId: row.agentUid,
    from: row.fromState,
    to: row.toState,
    rule: row.rule,
    basis: row.basis,
    confidence: row.confidence,
    evidence: apiEvidence(row.evidence, nowMs),
  };
}

export interface TransitionQueries {
  sessionTransitions(ctx: RepoContext, sessionId: string, q: TransitionListQuery): Page<TransitionItem>;
}

export function createTransitionQueries(db: InstanceDb, deps: QueryDeps): TransitionQueries {
  return {
    sessionTransitions: (ctx, sessionId, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const sid = sessionRowId(db, sessionId);
        if (sid === undefined) throw new NotFoundError('session_not_found');
        let agentRow: number | undefined;
        if (q.agent !== undefined) {
          agentRow = agentRowId(db, sid, q.agent);
          if (agentRow === undefined) throw new NotFoundError('agent_not_found');
        }
        const spec: PageSpec = {
          route: 'sessionTransitions',
          sort: 'at',
          dir: 'desc',
          filter: filterOf(q, { sessionId }),
        };
        const resume = readCursor(q.cursor, spec);
        const bind = new Binder();
        const where = [`t.session_id = ${bind.bind(sid)}`];
        if (agentRow !== undefined) where.push(`t.agent_id = ${bind.bind(agentRow)}`);
        if (resume !== null) {
          const k = bind.bind(numericKey(resume));
          where.push(`(t.at < ${k} OR (t.at = ${k} AND t.id < ${bind.bind(resume.i)}))`);
        }
        const rows = db.driver
          .prepare<TransitionDbRow>(
            `SELECT t.id AS id, t.at AS at, a.agent_uid AS agentUid, t.from_state AS fromState, t.to_state AS toState,
                    t.rule AS rule, t.basis AS basis, t.confidence AS confidence, t.evidence AS evidence
               FROM state_transitions t LEFT JOIN agents a ON a.id = t.agent_id
              WHERE ${where.join(' AND ')}
              ORDER BY t.at DESC, t.id DESC LIMIT ${bind.bind(q.limit + 1)}`,
          )
          .all(bind.params);
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        const nextCursor =
          rows.length > q.limit && last !== undefined ? writeCursor(spec, last.at, last.id, null) : null;
        const nowMs = deps.now();
        const items = page.map((row) => toTransitionItem(row, nowMs));
        return pageOf(items, { nextCursor, asOfSeq, limit: q.limit });
      }),
  };
}

// ---- tool status -----------------------------------------------------------------------------------------------------------

/** The derived `ToolStatus` of a tool call (03 5.5): the stored outcome, else pending (not ended, not batched) or unknown. */
export function toolStatusOf(
  outcome: 'ok' | 'error' | 'denied' | 'interrupted' | null,
  endedAt: number | null,
  batchAt: number | null,
): ToolStatus {
  switch (outcome) {
    case 'ok':
      return 'succeeded';
    case 'error':
      return 'failed';
    case 'denied':
      return 'denied';
    case 'interrupted':
      return 'interrupted';
    case null:
      return endedAt === null && batchAt === null ? 'pending' : 'unknown';
  }
}

/** The same derivation as SQL over a `tool_calls` alias (the `status` filter and sort). */
export function toolStatusSql(alias: string): string {
  return `(CASE ${alias}.outcome WHEN 'ok' THEN 'succeeded' WHEN 'error' THEN 'failed' WHEN 'denied' THEN 'denied'
    WHEN 'interrupted' THEN 'interrupted'
    ELSE CASE WHEN ${alias}.ended_at IS NULL AND ${alias}.batch_at IS NULL THEN 'pending' ELSE 'unknown' END END)`;
}

/** Options of the list functions that serve a route with a session in its path (`sessionTimeline`, `sessionToolCalls`). */
export interface PathSessionOptions {
  /** The query has exactly one `session`, taken from the path: an unknown session is `session_not_found`, and the default window is `all`. */
  readonly pathSession?: boolean;
}
