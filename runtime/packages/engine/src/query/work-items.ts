// `workItemBoard` and `getWorkItem` (03 5.5, 6.1, 12.1; 02 7.11): the derived board of tasks. The derivation (rules W-DECL,
// W-ATT, W-LBL and the board state table) is the lifecycle module's and is stored in `work_items`; this file only reads
// it: the stored kind `attempt` is spelled `attempts` (registry C52), each evidence entry becomes the line
// `<label>: <state> (<rule>)`, and the usage of an item is the sum of the usage of its member sessions (never an estimate).
import {
  foldQuery,
  type BoardState,
  type EvidenceItem,
  type SessionSummary,
  type WorkItem,
  type WorkItemBoard,
  type WorkItemBoardQuery,
} from '@mcs/shared';
import { z } from 'zod';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { createSessionQueries } from './sessions.ts';
import {
  Binder,
  FILE_COLUMNS,
  idsParam,
  iso,
  isoOrNull,
  likeContains,
  snapshot,
  tokenUsageOf,
  type FileFacts,
  type UsageTotals,
} from './transitions.ts';

export interface WorkItemQueries {
  workItemBoard(ctx: RepoContext, q: WorkItemBoardQuery): WorkItemBoard;
  /** Throws a `NotFoundError` with the code `work_item_not_found` for an unknown id. */
  getWorkItem(ctx: RepoContext, id: number): WorkItem & { sessions: SessionSummary[]; asOfSeq: number };
}

/** The board shows every item up to this many (03 6.1); one more row is read to know that the list is cut. */
const BOARD_CAP = 500;
/** `WorkItem.sessionIds` and the member sessions of `getWorkItem`. */
const MAX_SESSION_IDS = 50;
const MAX_MEMBER_SESSIONS = 100;

/** The text of `WorkItemBoard.derivation`: how the board is made (02 7.11), for the info tip of the page. */
export const BOARD_DERIVATION =
  'Each session belongs to at most one item and the first matching rule wins: W-DECL (items declared in the ' +
  'configuration), W-ATT (attempt rows grouped by part), W-LBL (matched sessions grouped by exact label). The state of ' +
  'an item is the first match of: the latest attempt has ended; a member is working; a member waits for input; the ' +
  'most recently started member completed or failed; a member is stale; every open member ended its turn (waiting); ' +
  'otherwise unknown.';

/**
 * The 404 of `getWorkItem`. It carries the name `NotFoundError` because the server maps the engine's not-found errors by
 * that name and the code (`server/src/errors.ts`); the shared class of `transitions.ts` does not list this code yet (CR-WP-31-1).
 */
class WorkItemNotFoundError extends Error {
  readonly code = 'work_item_not_found';

  constructor() {
    super('work_item_not_found');
    this.name = 'NotFoundError';
  }
}

interface ItemDbRow {
  id: number;
  itemKey: string;
  kind: 'declared' | 'attempt' | 'label';
  title: string;
  state: BoardState;
  rule: WorkItem['rule'];
  boardReason: string;
  evidence: string;
  stateSince: number;
  sessionCount: number;
  lastActivityAt: number | null;
  updatedSeq: number;
}

const ITEM_COLUMNS = `id, item_key AS itemKey, kind, title, state, rule, board_reason AS boardReason, evidence,
  state_since AS stateSince, session_count AS sessionCount, last_activity_at AS lastActivityAt, updated_seq AS updatedSeq`;

const StoredEvidenceSchema = z.array(z.object({ sessionId: z.string(), state: z.string(), ruleId: z.string() }));

/** A damaged evidence column reads as no evidence; the next derivation rewrites it. */
function storedEvidence(text: string): z.infer<typeof StoredEvidenceSchema> {
  try {
    const parsed = StoredEvidenceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

interface MemberUsageRow {
  itemId: number;
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The API items of stored rows, in the order of `rows`; a few indexed statements over all of them (no query per item). */
function itemsOf(db: InstanceDb, rows: readonly ItemDbRow[]): WorkItem[] {
  if (rows.length === 0) return [];
  const { driver } = db;
  const ids = idsParam(rows.map((row) => row.id));

  const sessionIds = new Map<number, string[]>();
  for (const row of driver
    .prepare<{ itemId: number; uid: string }>(
      `SELECT itemId, uid FROM (
         SELECT w.work_item_id AS itemId, s.session_uid AS uid,
                row_number() OVER (PARTITION BY w.work_item_id ORDER BY w.session_id) AS rn
           FROM work_item_sessions w JOIN sessions s ON s.id = w.session_id
          WHERE w.work_item_id IN (SELECT value FROM json_each(:ids)))
        WHERE rn <= :cap ORDER BY itemId, rn`,
    )
    .all({ ids, cap: MAX_SESSION_IDS })) {
    push(sessionIds, row.itemId, row.uid);
  }

  const evidence = new Map(rows.map((row) => [row.id, storedEvidence(row.evidence)]));
  const memberUids = [...new Set([...evidence.values()].flatMap((list) => list.map((entry) => entry.sessionId)))];
  const labels = new Map<string, string>();
  if (memberUids.length > 0) {
    for (const row of driver
      .prepare<{ uid: string; label: string }>(
        'SELECT session_uid AS uid, label FROM sessions WHERE session_uid IN (SELECT value FROM json_each(:uids))',
      )
      .all({ uids: idsParam(memberUids) })) {
      labels.set(row.uid, row.label);
    }
  }

  /** An item with at least one member session has an entry; an item without members has `usage: null`. */
  const totals = new Map<number, UsageTotals>();
  for (const row of driver
    .prepare<MemberUsageRow>(
      `SELECT w.work_item_id AS itemId, sum(s.usage_messages) AS messages, sum(s.usage_synthetic) AS synthetic,
              sum(s.usage_unfinalized) AS unfinalized, sum(s.tok_input) AS input, sum(s.tok_output) AS output,
              sum(s.tok_cache_read) AS cacheRead, sum(s.tok_cache_creation) AS cacheCreation,
              sum(s.tok_input_missing) AS missingInput, sum(s.tok_output_missing) AS missingOutput,
              sum(s.tok_cache_read_missing) AS missingCacheRead, sum(s.tok_cache_creation_missing) AS missingCacheCreation
         FROM work_item_sessions w JOIN sessions s ON s.id = w.session_id
        WHERE w.work_item_id IN (SELECT value FROM json_each(:ids)) GROUP BY w.work_item_id`,
    )
    .all({ ids })) {
    const { itemId, ...usage } = row;
    totals.set(itemId, usage);
  }
  const files = new Map<number, FileFacts[]>();
  for (const file of driver
    .prepare<FileFacts & { itemId: number }>(
      `SELECT w.work_item_id AS itemId, ${FILE_COLUMNS}
         FROM transcript_files f JOIN sessions s ON s.session_uid = f.session_uid
         JOIN work_item_sessions w ON w.session_id = s.id
        WHERE w.work_item_id IN (SELECT value FROM json_each(:ids)) ORDER BY f.id`,
    )
    .all({ ids })) {
    push(files, file.itemId, file);
  }

  return rows.map((row): WorkItem => {
    const member = totals.get(row.id);
    const lines: EvidenceItem[] = (evidence.get(row.id) ?? []).map((entry) => ({
      kind: 'board:member',
      at: null,
      text: `${labels.get(entry.sessionId) ?? entry.sessionId}: ${entry.state} (${entry.ruleId})`,
    }));
    return {
      id: row.id,
      key: row.itemKey,
      seq: row.updatedSeq,
      title: row.title,
      source: row.kind === 'attempt' ? 'attempts' : row.kind,
      rule: row.rule,
      state: row.state,
      boardReason: row.boardReason,
      evidence: lines,
      since: iso(row.stateSince),
      sessionIds: sessionIds.get(row.id) ?? [],
      sessionCount: row.sessionCount,
      lastActivityAt: isoOrNull(row.lastActivityAt),
      usage: member === undefined ? null : tokenUsageOf(member, files.get(row.id) ?? []),
    };
  });
}

export function createWorkItemQueries(db: InstanceDb, deps: QueryDeps): WorkItemQueries {
  const sessions = createSessionQueries(db, deps);
  return {
    workItemBoard: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq): WorkItemBoard => {
        const bind = new Binder();
        const where: string[] = [];
        if (q.state !== undefined) where.push(`state IN ${bind.list(q.state)}`);
        if (q.q !== undefined) {
          const pattern = bind.bind(likeContains(foldQuery(q.q)));
          where.push(`(title LIKE ${pattern} ESCAPE '\\' OR item_key LIKE ${pattern} ESCAPE '\\')`);
        }
        const rows = db.driver
          .prepare<ItemDbRow>(
            `SELECT ${ITEM_COLUMNS} FROM work_items ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
              ORDER BY last_activity_at IS NULL, last_activity_at DESC, id DESC LIMIT ${bind.bind(BOARD_CAP + 1)}`,
          )
          .all(bind.params);
        return {
          asOfSeq,
          derivation: BOARD_DERIVATION,
          items: itemsOf(db, rows.slice(0, BOARD_CAP)),
          truncated: rows.length > BOARD_CAP,
        };
      }),

    getWorkItem: (ctx, id) =>
      snapshot(db, ctx, (asOfSeq) => {
        const row = db.driver.prepare<ItemDbRow>(`SELECT ${ITEM_COLUMNS} FROM work_items WHERE id = :id`).get({ id });
        if (row === undefined) throw new WorkItemNotFoundError();
        const [item] = itemsOf(db, [row]);
        if (item === undefined) throw new Error('a work item row produced no item');
        const memberRows = db.driver
          .prepare<{ id: number }>(
            `SELECT s.id AS id FROM work_item_sessions w JOIN sessions s ON s.id = w.session_id
              WHERE w.work_item_id = :id ORDER BY s.last_activity_at DESC, s.id DESC LIMIT :cap`,
          )
          .all({ id, cap: MAX_MEMBER_SESSIONS });
        return {
          ...item,
          sessions: sessions.sessionSummaries(
            ctx,
            memberRows.map((m) => m.id),
          ),
          asOfSeq,
        };
      }),
  };
}
