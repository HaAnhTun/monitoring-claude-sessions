// TurnsRepo: one row per (session, prompt) with the start and the last end of the turn (03 3.6 "Turns", 02 4.1). SQL only.
// The start is the minimum over the sources, the end follows the greatest stamp `(ended_at, end_rank, end_tie)` of 02 4.3
// (last write wins by stamp, so a hook `Stop` of equal time outranks a transcript `end_turn`, and an older interrupt never
// replaces a newer end). A turn has no change kind of its own: the writer announces it as a change of its session
// through `ChangeSink.record('turn', ...)`. No seq or time column is written, so applying a write twice leaves the row
// as it was.
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

/** The values of the CHECK of `turns.end_kind`. */
export type TurnEndKind = 'stop' | 'stop_failure' | 'end_turn' | 'turn_duration' | 'interrupted';

export interface TurnWrite {
  /** `sessions.id` */
  readonly sessionId: number;
  /** `agents.id` of an agent of the same session; null = the main agent. The agent of the first write stays. */
  readonly agentId: number | null;
  readonly promptId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly endKind: TurnEndKind | null;
  /** With `endedAt` and `endTie`: the stamp of `endKind`; all three are set together or not at all. */
  readonly endRank: number | null;
  readonly endTie: string | null;
  readonly origin: string | null;
  readonly toolCount: number;
}

export interface TurnRow extends TurnWrite {
  readonly id: number;
}

interface TurnDbRow {
  id: number;
  session_id: number;
  agent_id: number | null;
  prompt_id: string;
  started_at: number | null;
  ended_at: number | null;
  end_kind: TurnEndKind | null;
  end_rank: number | null;
  end_tie: string | null;
  origin: string | null;
  tool_count: number;
}

// `excluded` carries an end and it is greater than the stored one (or there is none): the stamps are compared as row values
const NEWER = `(excluded.ended_at IS NOT NULL AND (turns.ended_at IS NULL OR
  (excluded.ended_at, excluded.end_rank, excluded.end_tie) > (turns.ended_at, turns.end_rank, turns.end_tie)))`;

const UPSERT = `INSERT INTO turns (session_id, agent_id, prompt_id, started_at, ended_at, end_kind, end_rank, end_tie, origin, tool_count)
VALUES (:sessionId, :agentId, :promptId, :startedAt, :endedAt, :endKind, :endRank, :endTie, :origin, :toolCount)
ON CONFLICT(session_id, prompt_id) DO UPDATE SET
  started_at = coalesce(min(turns.started_at, excluded.started_at), turns.started_at, excluded.started_at),
  end_kind = CASE WHEN ${NEWER} THEN excluded.end_kind ELSE turns.end_kind END,
  end_rank = CASE WHEN ${NEWER} THEN excluded.end_rank ELSE turns.end_rank END,
  end_tie = CASE WHEN ${NEWER} THEN excluded.end_tie ELSE turns.end_tie END,
  ended_at = CASE WHEN ${NEWER} THEN excluded.ended_at ELSE turns.ended_at END,
  origin = coalesce(turns.origin, excluded.origin),
  tool_count = max(turns.tool_count, excluded.tool_count)`;

function toTurn(row: TurnDbRow): TurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    promptId: row.prompt_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endKind: row.end_kind,
    endRank: row.end_rank,
    endTie: row.end_tie,
    origin: row.origin,
    toolCount: row.tool_count,
  };
}

export class TurnsRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /** Inserts the turn or merges the write into it. An unknown session or an agent of another session is a `db_constraint`. */
  upsert(ctx: RepoContext, _tx: WriteTx, turn: TurnWrite): void {
    this.#db.assertScope(ctx);
    if (turn.agentId !== null) this.#requireAgentOf(turn.sessionId, turn.agentId);
    this.#db.driver.prepare(UPSERT).run({
      sessionId: turn.sessionId,
      agentId: turn.agentId,
      promptId: turn.promptId,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      endKind: turn.endKind,
      endRank: turn.endRank,
      endTie: turn.endTie,
      origin: turn.origin,
      toolCount: turn.toolCount,
    });
  }

  get(ctx: RepoContext, sessionId: number, promptId: string): TurnRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver
      .prepare<TurnDbRow>(
        `SELECT id, session_id, agent_id, prompt_id, started_at, ended_at, end_kind, end_rank, end_tie, origin, tool_count
           FROM turns WHERE session_id = ? AND prompt_id = ?`,
      )
      .get([sessionId, promptId]);
    return row === undefined ? undefined : toTurn(row);
  }

  #requireAgentOf(sessionId: number, agentId: number): void {
    const found = this.#db.driver
      .prepare<{ id: number }>('SELECT id FROM agents WHERE id = ? AND session_id = ?')
      .get([agentId, sessionId]);
    if (found === undefined) {
      throw new DbError('db_constraint', 'the agent does not exist in this session', { constraint: 'foreignkey' });
    }
  }
}
