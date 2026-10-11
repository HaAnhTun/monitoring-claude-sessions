// `work_items` and `work_item_sessions` (03 3.5; 02 7.11): the derived board of tasks. SQL only: the derivation rules
// (W-DECL, W-ATT, W-LBL) and the board states live in the lifecycle module of 02.
//
// Spelling (registry C52): the stored `kind` is `declared | attempt | label`; only the API says `attempts` (the query
// layer maps it, 03 5.5). The column CHECK refuses `attempts`.
import type { BOARD_STATES, WORK_ITEM_RULES } from '@mcs/shared';
import { z } from 'zod';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type WorkItemKind = 'declared' | 'attempt' | 'label';
export type WorkItemState = (typeof BOARD_STATES)[number];
export type WorkItemRule = (typeof WORK_ITEM_RULES)[number];

const EvidenceSchema = z.array(z.object({ sessionId: z.string(), state: z.string(), ruleId: z.string() }));
export type WorkItemEvidence = z.infer<typeof EvidenceSchema>[number];

export interface NewWorkItem {
  /** `attempt:<part>`, `label:<label>` or a declared key. */
  itemKey: string;
  kind: WorkItemKind;
  title: string;
  state: WorkItemState;
  rule: WorkItemRule;
  /** The order row of the board state table (02 7.11). */
  boardReason: string;
  evidence: readonly WorkItemEvidence[];
  stateSince: number;
  lastActivityAt: number | null;
}

export interface WorkItemRow extends Omit<NewWorkItem, 'evidence'> {
  id: number;
  evidence: WorkItemEvidence[];
  sessionCount: number;
  createdAt: number;
  updatedSeq: number;
  updatedAt: number;
}

interface WorkItemDbRow extends Omit<WorkItemRow, 'evidence'> {
  evidence: string;
}

const COLUMNS = `id, item_key AS itemKey, kind, title, state, rule, board_reason AS boardReason, evidence,
  state_since AS stateSince, session_count AS sessionCount, last_activity_at AS lastActivityAt, created_at AS createdAt,
  updated_seq AS updatedSeq, updated_at AS updatedAt`;

function toRow(row: WorkItemDbRow): WorkItemRow {
  let evidence: WorkItemEvidence[] = [];
  try {
    const parsed = EvidenceSchema.safeParse(JSON.parse(row.evidence));
    if (parsed.success) evidence = parsed.data;
  } catch {
    // a damaged evidence column reads as empty; the next derivation rewrites it
  }
  return { ...row, evidence };
}

const UPSERT_SQL = `INSERT INTO work_items (item_key, kind, title, state, rule, board_reason, evidence, state_since,
    last_activity_at, created_at, updated_seq, updated_at)
  VALUES (:itemKey, :kind, :title, :state, :rule, :boardReason, :evidence, :stateSince, :lastActivityAt, :now,
    coalesce(:seq, 0), :now)
  ON CONFLICT(item_key) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, state = excluded.state, rule = excluded.rule,
    board_reason = excluded.board_reason, evidence = excluded.evidence, state_since = excluded.state_since,
    last_activity_at = excluded.last_activity_at, updated_seq = coalesce(:seq, work_items.updated_seq),
    updated_at = excluded.updated_at
  RETURNING id`;

const RECOUNT_SQL = `UPDATE work_items SET session_count = (SELECT count(*) FROM work_item_sessions WHERE work_item_id = :id)
  WHERE id = :id`;

export class WorkItemsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /**
   * Inserts the item or replaces its derived columns (`item_key` is the identity; `created_at` stays). `seq` stamps
   * `updated_seq` when the caller reserved a `work_item/upsert` for a real change; `session_count` is kept by
   * `setSessions`.
   */
  upsert(ctx: RepoContext, tx: WriteTx, item: NewWorkItem, seq: number | null): { id: number; created: boolean } {
    this.db.assertScope(ctx);
    const created =
      this.db.driver.prepare('SELECT 1 FROM work_items WHERE item_key = :itemKey').get({ itemKey: item.itemKey }) ===
      undefined;
    const row = this.db.driver.prepare<{ id: number }>(UPSERT_SQL).get({
      itemKey: item.itemKey,
      kind: item.kind,
      title: item.title,
      state: item.state,
      rule: item.rule,
      boardReason: item.boardReason,
      evidence: JSON.stringify(item.evidence),
      stateSince: item.stateSince,
      lastActivityAt: item.lastActivityAt,
      now: tx.now,
      seq,
    });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    return { id: row.id, created };
  }

  byKey(ctx: RepoContext, itemKey: string): WorkItemRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<WorkItemDbRow>(`SELECT ${COLUMNS} FROM work_items WHERE item_key = :itemKey`)
      .get({ itemKey });
    return row === undefined ? undefined : toRow(row);
  }

  byId(ctx: RepoContext, id: number): WorkItemRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver.prepare<WorkItemDbRow>(`SELECT ${COLUMNS} FROM work_items WHERE id = :id`).get({ id });
    return row === undefined ? undefined : toRow(row);
  }

  /** Most recently active first (`idx_work_items_state` order is applied by the query layer for filtered lists). */
  list(ctx: RepoContext): WorkItemRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<WorkItemDbRow>(`SELECT ${COLUMNS} FROM work_items ORDER BY last_activity_at DESC, id DESC`)
      .all()
      .map(toRow);
  }

  /**
   * Makes `sessionIds` the sessions of the item. A session belongs to at most one item, so a session that is linked to
   * another item moves; `session_count` of every touched item is recomputed.
   */
  setSessions(
    ctx: RepoContext,
    _tx: WriteTx,
    itemId: number,
    sessionIds: readonly number[],
    linkedAt: number,
  ): { added: number; removed: number } {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const wanted = [...new Set(sessionIds)];
    const wantedJson = JSON.stringify(wanted);
    const current = new Set(
      driver
        .prepare<{ sessionId: number }>(
          'SELECT session_id AS sessionId FROM work_item_sessions WHERE work_item_id = :itemId',
        )
        .all({ itemId })
        .map((row) => row.sessionId),
    );
    const removed = driver
      .prepare(
        `DELETE FROM work_item_sessions WHERE work_item_id = :itemId
           AND session_id NOT IN (SELECT value FROM json_each(:wantedJson))`,
      )
      .run({ itemId, wantedJson }).changes;
    const touchedItems = new Set<number>([itemId]);
    let added = 0;
    for (const sessionId of wanted) {
      if (current.has(sessionId)) continue;
      const previous = driver
        .prepare<{ itemId: number }>(
          'SELECT work_item_id AS itemId FROM work_item_sessions WHERE session_id = :sessionId',
        )
        .get({ sessionId });
      if (previous !== undefined) {
        touchedItems.add(previous.itemId);
        driver.prepare('DELETE FROM work_item_sessions WHERE session_id = :sessionId').run({ sessionId });
      }
      driver
        .prepare(
          'INSERT INTO work_item_sessions (work_item_id, session_id, linked_at) VALUES (:itemId, :sessionId, :linkedAt)',
        )
        .run({ itemId, sessionId, linkedAt });
      added += 1;
    }
    for (const id of touchedItems) driver.prepare(RECOUNT_SQL).run({ id });
    return { added, removed };
  }

  /** Session row ids of an item, ascending. */
  sessionsOf(ctx: RepoContext, itemId: number): number[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ sessionId: number }>(
        'SELECT session_id AS sessionId FROM work_item_sessions WHERE work_item_id = :itemId ORDER BY session_id',
      )
      .all({ itemId })
      .map((row) => row.sessionId);
  }

  itemOfSession(ctx: RepoContext, sessionId: number): number | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ itemId: number }>(
        'SELECT work_item_id AS itemId FROM work_item_sessions WHERE session_id = :sessionId',
      )
      .get({ sessionId })?.itemId;
  }

  /** Deletes the item; its links go with it (cascade). True when it existed. */
  delete(ctx: RepoContext, _tx: WriteTx, id: number): boolean {
    this.db.assertScope(ctx);
    return this.db.driver.prepare('DELETE FROM work_items WHERE id = :id').run({ id }).changes > 0;
  }
}
