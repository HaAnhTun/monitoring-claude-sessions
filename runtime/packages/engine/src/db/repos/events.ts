// EventsRepo: the single `events` table that holds hook envelopes and transcript entries (03 3.6 "Events", 02 4.1, I-03).
// SQL only. A hook delivery and a transcript record that describe the same logical event share a natural key (registry
// 5.4) and become one row (`sources` 3); a redelivered envelope (`event_uid`) and a resume copy of a record (`record_uuid`)
// add no row.
//
// The statement is the one of 03 3.6, with its three ON CONFLICT clauses in that order: `event_uid` and `record_uuid` do
// nothing, `natural_key` merges (`sources` OR-ed, `tool.failure` wins, `severity` maximum, the first non-null ids and
// transcript reference, the record timestamp preferred over a hook time). SQLite fires the FIRST clause of the statement that
// matches a conflict, so a resume copy of a `tool_use` record (same `record_uuid` and same natural key) is a duplicate, not a
// merge; probed on SQLite 3.53 with every clause order (CR-WP-10-3).
//
// Deviation from the statement (CR-WP-10-3): the row is inserted with `change_seq 0` and stamped once the change is reserved.
// The statement stamps `:seq` at insert, which needs the reservation first, so a transaction that only carried duplicates
// would publish an empty `event/append`. Here a duplicate or a merge into an announced row reserves nothing, and "new" is
// exactly "RETURNING change_seq = 0".
//
// Every public method takes the `RepoContext` first and asserts the scope (03 4.5).
import type { EventKind } from '@mcs/shared';
import type { Stamp } from '@mcs/shared/protocol';

import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

/**
 * The input of `EventsRepo.insert`: the parameter names of the 03 3.6 statement, with the session and agent given by their
 * provider ids. The shape is that of `EventRowWrite` (02 4.1.2), so the ingestion writer passes its rows unchanged.
 */
export interface EventInsert {
  readonly sessionUid: string;
  /** `'main'` for the main agent, null for an event of the session itself. */
  readonly agentUid: string | null;
  readonly kind: EventKind;
  readonly entryKind: 'prompt' | 'say' | 'think' | 'tool' | 'result' | 'system' | 'attachment' | null;
  readonly severity: 0 | 1 | 2;
  /** Source bits: hook 1, transcript 2, monitor 4. */
  readonly sources: 1 | 2 | 4;
  readonly stamp: Stamp;
  readonly tsSource: 'record' | 'hook_received' | 'derived';
  readonly receivedAt: number;
  readonly eventUid: string | null;
  readonly naturalKey: string | null;
  readonly recordUuid: string | null;
  readonly hookEvent: string | null;
  readonly contentHash: string | null;
  readonly spoolSegment: string | null;
  readonly spoolOffset: number | null;
  readonly flags: readonly string[];
  readonly promptId: string | null;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  readonly messageId: string | null;
  readonly fileId: number | null;
  readonly byteOffset: number | null;
  readonly byteLength: number | null;
  readonly lineNo: number | null;
  readonly recordType: string | null;
  readonly subtype: string | null;
  readonly textLen: number | null;
  readonly summary: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>> | null;
}

export type EventInsertResult =
  /** A new row, announced as `event/append` with `seq`. */
  | { readonly outcome: 'inserted'; readonly id: number; readonly seq: number }
  /** Merged into the row of the same natural key; not announced again. */
  | { readonly outcome: 'merged'; readonly id: number }
  /** No row: a redelivered `event_uid`, or a record that exists already. `occurrence`: it exists at another place (a resume copy). */
  | { readonly outcome: 'duplicate'; readonly occurrence: boolean };

/** What dedupe rules D-2 and D-3 (02 4.4) need to know about an existing row. */
export interface EventRef {
  readonly id: number;
  /** Source bits of the stored row. */
  readonly sources: number;
}

/** D-3: the same hook event with the same content in the same session within `windowMs` of `receivedAt`. */
export interface ContentWindowQuery {
  readonly sessionUid: string;
  readonly hookEvent: string;
  readonly contentHash: string;
  readonly receivedAt: number;
  readonly windowMs: number;
}

const INSERT = `INSERT INTO events (session_id, agent_id, kind, entry_kind, severity, sources, ts, ts_rank, ts_tie, ts_source,
    received_at, event_uid, natural_key, record_uuid, hook_event, content_hash, spool_segment, spool_offset, flags, prompt_id,
    tool_use_id, tool_name, message_id, file_id, byte_offset, byte_length, line_no, record_type, subtype, text_len, summary,
    detail, change_seq)
  VALUES (:sessionId, :agentId, :kind, :entryKind, :severity, :sources, :ts, :tsRank, :tsTie, :tsSource, :receivedAt,
    :eventUid, :naturalKey, :recordUuid, :hookEvent, :contentHash, :spoolSegment, :spoolOffset, :flags, :promptId,
    :toolUseId, :toolName, :messageId, :fileId, :byteOffset, :byteLength, :lineNo, :recordType, :subtype, :textLen,
    :summary, :detail, 0)
  ON CONFLICT(event_uid) WHERE event_uid IS NOT NULL DO NOTHING
  ON CONFLICT(record_uuid) WHERE record_uuid IS NOT NULL DO NOTHING
  ON CONFLICT(natural_key) WHERE natural_key IS NOT NULL DO UPDATE SET
    sources     = events.sources | excluded.sources,
    kind        = CASE WHEN excluded.kind = 'tool.failure' THEN 'tool.failure' ELSE events.kind END,
    severity    = max(events.severity, excluded.severity),
    event_uid   = coalesce(events.event_uid, excluded.event_uid),
    record_uuid = coalesce(events.record_uuid, excluded.record_uuid),
    hook_event  = coalesce(events.hook_event, excluded.hook_event),
    entry_kind  = coalesce(events.entry_kind, excluded.entry_kind),
    file_id     = coalesce(events.file_id, excluded.file_id),
    byte_offset = coalesce(events.byte_offset, excluded.byte_offset),
    byte_length = coalesce(events.byte_length, excluded.byte_length),
    summary     = coalesce(events.summary, excluded.summary),
    ts          = CASE WHEN events.ts_source = 'record' THEN events.ts
                       WHEN excluded.ts_source = 'record' THEN excluded.ts
                       ELSE min(events.ts, excluded.ts) END,
    ts_source   = CASE WHEN excluded.ts_source = 'record' THEN 'record' ELSE events.ts_source END
  RETURNING id, change_seq`;

function notFound(what: string): DbError {
  return new DbError('db_constraint', `the ${what} does not exist`, { constraint: 'foreignkey' });
}

export class EventsRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /**
   * Inserts the event, merges it into the row of its natural key, or recognises it as already stored. A new row is announced
   * as `event/append` (one change per transaction and session, listing the ids); a duplicate and a merge write no change row.
   * A session, agent or transcript file that does not exist is a `db_constraint` error.
   */
  insert(ctx: RepoContext, tx: WriteTx, row: EventInsert): EventInsertResult {
    this.#db.assertScope(ctx);
    const driver = this.#db.driver;
    const session = driver
      .prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = ?')
      .get([row.sessionUid]);
    if (session === undefined) throw notFound('session');
    let agentId: number | null = null;
    if (row.agentUid !== null) {
      const agent = driver
        .prepare<{ id: number }>('SELECT id FROM agents WHERE session_id = ? AND agent_uid = ?')
        .get([session.id, row.agentUid]);
      if (agent === undefined) throw notFound('agent');
      agentId = agent.id;
    }
    if (
      row.fileId !== null &&
      driver.prepare('SELECT 1 FROM transcript_files WHERE id = ?').get([row.fileId]) === undefined
    ) {
      throw notFound('transcript file');
    }

    const written = driver.prepare<{ id: number; change_seq: number }>(INSERT).get({
      sessionId: session.id,
      agentId,
      kind: row.kind,
      entryKind: row.entryKind,
      severity: row.severity,
      sources: row.sources,
      ts: row.stamp.at,
      tsRank: row.stamp.rank,
      tsTie: row.stamp.tie,
      tsSource: row.tsSource,
      receivedAt: row.receivedAt,
      eventUid: row.eventUid,
      naturalKey: row.naturalKey,
      recordUuid: row.recordUuid,
      hookEvent: row.hookEvent,
      contentHash: row.contentHash,
      spoolSegment: row.spoolSegment,
      spoolOffset: row.spoolOffset,
      flags: JSON.stringify(row.flags),
      promptId: row.promptId,
      toolUseId: row.toolUseId,
      toolName: row.toolName,
      messageId: row.messageId,
      fileId: row.fileId,
      byteOffset: row.byteOffset,
      byteLength: row.byteLength,
      lineNo: row.lineNo,
      recordType: row.recordType,
      subtype: row.subtype,
      textLen: row.textLen,
      summary: row.summary,
      detail: row.detail === null ? null : JSON.stringify(row.detail),
    });
    if (written === undefined) return { outcome: 'duplicate', occurrence: this.#recordOccurrence(row) };
    if (written.change_seq !== 0) return { outcome: 'merged', id: written.id };

    const seq = tx.changes.reserve('event', 'append', { entityId: session.id, sessionUid: row.sessionUid });
    tx.changes.noteId(seq, written.id);
    driver.prepare('UPDATE events SET change_seq = ? WHERE id = ?').run([seq, written.id]);
    return { outcome: 'inserted', id: written.id, seq };
  }

  /** D-2 (02 4.4): the row of a natural key, if any. */
  findByNaturalKey(ctx: RepoContext, naturalKey: string): EventRef | null {
    this.#db.assertScope(ctx);
    return (
      this.#db.driver.prepare<EventRef>('SELECT id, sources FROM events WHERE natural_key = ?').get([naturalKey]) ??
      null
    );
  }

  /** D-3 (02 4.4): a hook row of the same session, event and content hash received within the window (`idx_events_content`). */
  findByContent(ctx: RepoContext, query: ContentWindowQuery): EventRef | null {
    this.#db.assertScope(ctx);
    return (
      this.#db.driver
        .prepare<EventRef>(
          `SELECT id, sources FROM events
             WHERE session_id = (SELECT id FROM sessions WHERE session_uid = :sessionUid)
               AND hook_event = :hookEvent AND content_hash = :contentHash
               AND received_at BETWEEN :from AND :to
             ORDER BY received_at LIMIT 1`,
        )
        .get({
          sessionUid: query.sessionUid,
          hookEvent: query.hookEvent,
          contentHash: query.contentHash,
          from: query.receivedAt - query.windowMs,
          to: query.receivedAt + query.windowMs,
        }) ?? null
    );
  }

  /**
   * The time of the newest record or hook event stored for the session, of any of its agents; `null` when it has none
   * (`idx_events_session_ts`). A note of the monitor (`sources` 4 alone) is not activity of the session and is skipped.
   */
  newestActivityAt(ctx: RepoContext, sessionId: number): number | null {
    this.#db.assertScope(ctx);
    return (
      this.#db.driver
        .prepare<{ ts: number }>(
          'SELECT ts FROM events WHERE session_id = ? AND (sources & 3) != 0 ORDER BY ts DESC, id DESC LIMIT 1',
        )
        .get([sessionId])?.ts ?? null
    );
  }

  /** Identity reset of a file (02 5.3): deletes the rows that only the transcript knew about, and returns how many. */
  deleteTranscriptOnly(ctx: RepoContext, _tx: WriteTx, fileId: number): number {
    this.#db.assertScope(ctx);
    return this.#db.driver.prepare('DELETE FROM events WHERE file_id = ? AND sources = 2').run([fileId]).changes;
  }

  /**
   * Identity reset of a file (02 5.3): a row that also came from a hook keeps its hook part; the transcript reference and
   * the transcript source bit go, so that the re-read merges again through the natural key. Returns how many rows.
   */
  detachTranscript(ctx: RepoContext, _tx: WriteTx, fileId: number): number {
    this.#db.assertScope(ctx);
    return this.#db.driver
      .prepare(
        `UPDATE events SET sources = sources & ~2, record_uuid = NULL, file_id = NULL, byte_offset = NULL,
             byte_length = NULL, line_no = NULL
           WHERE file_id = ? AND sources & 1 = 1 AND (event_uid IS NOT NULL OR natural_key IS NOT NULL)`,
      )
      .run([fileId]).changes;
  }

  /** Identity reset of a file (02 5.3): the second and later occurrences of records that this file held. */
  deleteOccurrences(ctx: RepoContext, _tx: WriteTx, fileId: number): number {
    this.#db.assertScope(ctx);
    return this.#db.driver.prepare('DELETE FROM entry_occurrences WHERE file_id = ?').run([fileId]).changes;
  }

  /**
   * A record whose `record_uuid` exists: when the stored row is at another place (another file, or another offset) this
   * is a resume copy, and its place is recorded. The same place read again is no occurrence.
   */
  #recordOccurrence(row: EventInsert): boolean {
    if (row.recordUuid === null || row.fileId === null || row.byteOffset === null) return false;
    const driver = this.#db.driver;
    const stored = driver
      .prepare<{ file_id: number | null; byte_offset: number | null }>(
        'SELECT file_id, byte_offset FROM events WHERE record_uuid = ?',
      )
      .get([row.recordUuid]);
    if (stored === undefined || (stored.file_id === row.fileId && stored.byte_offset === row.byteOffset)) return false;
    driver
      .prepare('INSERT OR IGNORE INTO entry_occurrences (file_id, byte_offset, record_uuid) VALUES (?, ?, ?)')
      .run([row.fileId, row.byteOffset, row.recordUuid]);
    return true;
  }
}
