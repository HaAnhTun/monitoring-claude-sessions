// The change recorder (03 9.1, ADR 0025, DA-I7, DA-I8): `changes` rows are small references written in the same transaction
// as the data they describe. A transaction reserves at most one row per (kind, op, coalescing key); the caller stamps
// `updated_seq` / `change_seq` of the entity with the seq it gets back. `withWriteTx` creates the recorder, calls `flush()`
// before COMMIT and publishes after it, so a rolled-back transaction leaves no row and no gap in the sequence.
import type { ChangeKind, ChangeOp } from '@mcs/shared';

import type { SqlDriver } from './driver.ts';

export type { ChangeKind, ChangeOp } from '@mcs/shared';

/** `ids` of a `tool_call` or `attempt` change, and the frames that hydrate from them (03 9.2: at most 50 per frame). */
export const MAX_CHANGE_IDS = 50;

export interface ChangeRecorder {
  /**
   * Reserves at most one change row per (kind, op, coalescing key) per transaction and returns its seq; the caller
   * stamps `updated_seq` / `change_seq` with it in the statement that modifies the entity.
   */
  reserve(kind: ChangeKind, op: ChangeOp, ref: { entityId: number | null; sessionUid: string | null }): number;
  /** Event ids (`event/append`) and tool call or attempt run ids (`tool_call/upsert`, `attempt/upsert`) under one reservation. */
  noteId(seq: number, id: number): void;
  /** The size, tail offset and agent of a `transcript/append` reservation; the last note wins. */
  noteTranscript(seq: number, p: { sizeBytes: number; tailOffset: number; agentUid: string | null }): void;
  /** Writes the final payloads; called by `withWriteTx` before COMMIT. Idempotent. */
  flush(): void;
}

interface Reservation {
  readonly kind: ChangeKind;
  readonly distinct: Set<number>;
  /** The first ids in the order they were noted (kept up to one more than `MAX_CHANGE_IDS`, to know about truncation). */
  readonly firstIds: number[];
  min: number;
  max: number;
  transcript: { sizeBytes: number; tailOffset: number; agentUid: string | null } | undefined;
}

/** Kinds whose change is one row per session; the others are one row per entity, or one row for the whole instance. */
const SESSION_SCOPED: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['session', 'tool_call', 'event', 'usage']);
const ENTITY_SCOPED: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'agent',
  'workflow',
  'transcript',
  'work_item',
  'alert',
]);
const CARRIES_IDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['event', 'tool_call', 'attempt']);

function coalescingKey(
  kind: ChangeKind,
  op: ChangeOp,
  ref: { entityId: number | null; sessionUid: string | null },
): string {
  let scope = 'instance';
  if (SESSION_SCOPED.has(kind)) scope = `session:${ref.sessionUid ?? `row:${String(ref.entityId)}`}`;
  else if (ENTITY_SCOPED.has(kind))
    scope = `entity:${ref.entityId === null ? String(ref.sessionUid) : String(ref.entityId)}`;
  return `${kind}/${op}|${scope}`;
}

function payloadOf(reservation: Reservation): string {
  const { kind } = reservation;
  if (kind === 'event') {
    const empty = reservation.distinct.size === 0;
    return JSON.stringify({
      from: empty ? 0 : reservation.min,
      to: empty ? 0 : reservation.max,
      count: reservation.distinct.size,
    });
  }
  if (kind === 'tool_call' || kind === 'attempt') {
    // No id at all (a reset or a detach changed rows without naming them) also says truncated: clients refetch.
    const truncated = reservation.firstIds.length > MAX_CHANGE_IDS || reservation.firstIds.length === 0;
    return JSON.stringify({ ids: reservation.firstIds.slice(0, MAX_CHANGE_IDS), truncated });
  }
  if (kind === 'transcript' && reservation.transcript !== undefined) {
    const { sizeBytes, tailOffset, agentUid } = reservation.transcript;
    return JSON.stringify({ size: sizeBytes, tail: tailOffset, agent: agentUid });
  }
  return '{}';
}

/** A recorder over `driver`, which must be inside the transaction of the caller; `at` is the time of every row. */
export function createChangeRecorder(driver: SqlDriver, at: number): ChangeRecorder {
  const reservations = new Map<number, Reservation>();
  const seqByKey = new Map<string, number>();
  let flushed = false;

  const open = (): void => {
    if (flushed) throw new Error('the change recorder was already flushed: its transaction is ending');
  };
  const reservationOf = (seq: number): Reservation => {
    const reservation = reservations.get(seq);
    if (reservation === undefined)
      throw new RangeError(`change seq ${String(seq)} was not reserved by this transaction`);
    return reservation;
  };

  return {
    reserve: (kind, op, ref) => {
      open();
      const key = coalescingKey(kind, op, ref);
      const existing = seqByKey.get(key);
      if (existing !== undefined) return existing;
      const { lastInsertRowid: seq } = driver
        .prepare("INSERT INTO changes (at, kind, op, session_uid, entity_id, payload) VALUES (?, ?, ?, ?, ?, '{}')")
        .run([at, kind, op, ref.sessionUid, ref.entityId]);
      seqByKey.set(key, seq);
      reservations.set(seq, {
        kind,
        distinct: new Set<number>(),
        firstIds: [],
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        transcript: undefined,
      });
      return seq;
    },
    noteId: (seq, id) => {
      open();
      const reservation = reservationOf(seq);
      if (!CARRIES_IDS.has(reservation.kind)) {
        throw new RangeError(`change kind ${reservation.kind} does not carry ids`);
      }
      if (reservation.distinct.has(id)) return;
      reservation.distinct.add(id);
      if (reservation.firstIds.length <= MAX_CHANGE_IDS) reservation.firstIds.push(id);
      reservation.min = Math.min(reservation.min, id);
      reservation.max = Math.max(reservation.max, id);
    },
    noteTranscript: (seq, p) => {
      open();
      const reservation = reservationOf(seq);
      if (reservation.kind !== 'transcript') {
        throw new RangeError(`change kind ${reservation.kind} does not carry a transcript position`);
      }
      reservation.transcript = { ...p };
    },
    flush: () => {
      if (flushed) return;
      flushed = true;
      const update = driver.prepare('UPDATE changes SET payload = ? WHERE seq = ?');
      for (const [seq, reservation] of reservations) {
        const payload = payloadOf(reservation);
        if (payload !== '{}') update.run([payload, seq]);
      }
    },
  };
}
