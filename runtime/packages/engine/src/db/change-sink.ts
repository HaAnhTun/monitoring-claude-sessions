// The `ChangeSink` of the ingestion writer (02 4.6) on top of the change recorder (03 9.1, ADR 0025, registry C59).
//
// One `createChangeSink(tx)` per `withWriteTx` call. `record(entity, key, op)` maps the entity names that 02 uses to the
// change kind and op of the 03 9.1 table and reserves it through `tx.changes.reserve`, which coalesces per transaction.
// `flush()` and `discard()` do nothing: publication happens in `onCommitted`, and a ROLLBACK removes the reserved rows.
//
// The key of `record` is not specified by 02 or 03 (CR-WP-10-2). It carries what `reserve` needs:
//   - session level entities (`session`, `turn`, `tool_call`, `event`, `usage`, `reconciliation`): `<session uid>`, or
//     `<sessions.id>:<session uid>` when the row id is known (the change row then carries `entity_id`, which the stream
//     hydrates `session/upsert` from, 03 9.3);
//   - entities with a row of their own (`agent`, `workflow_run`): `<row id>` or `<row id>:<session uid>` (the uid of the
//     SESSION, for the `changes.session_uid` column);
//   - instance level (`ingest_health`, an instance level `reconciliation`): `INSTANCE_KEY`.
//
// The repositories of this folder reserve and note their own changes (`event/append` with its ids, `tool_call/upsert`,
// `usage/invalidate`, `transcript/append`), because they must stamp `change_seq` / `updated_seq` with the seq. A `record`
// of the same entity in the same transaction joins that reservation (same coalescing key): never two rows for one change.
//
// Activity-only updates (03 3.6): a session, a turn or an agent that changed without a lifecycle view change announces
// `session/upsert` / `agent/upsert` at most once per second. That state outlives the transaction, so it lives in an
// `ActivityThrottle` owned by the writer and passed to every sink; without one every `record` reserves (still coalesced
// per transaction). Inside the window the change is remembered as dirty, and the writer's 1 s timer runs
// `withWriteTx((tx) => throttle.flush(tx))` and stamps `updated_seq` of the entities it gets back. A view change is
// reserved by `SessionsRepo.writeView` directly and is never deferred; the writer tells the throttle with `announced()` so
// that the window restarts. The state of the throttle is not rolled back with a transaction: a batch that is retried records
// its updates again (they are deferred and flushed, never lost), and a `flush` whose transaction failed is followed by
// `restore(reserved)`.
import { SID_RE } from '@mcs/shared/protocol';

import type { ChangeKind, ChangeOp, ChangeRecorder } from './changes.ts';
import type { WriteTx } from './write.ts';

/** The entity names of `ChangeSink.record` (02 4.6). `event` replaces the former `hook_event` and `transcript_entry` (C59). */
export type ChangeEntity =
  'session' | 'agent' | 'workflow_run' | 'tool_call' | 'turn' | 'event' | 'usage' | 'ingest_health' | 'reconciliation';

export type ChangeSinkOp = 'insert' | 'update' | 'delete';

/** The key of an instance level change. */
export const INSTANCE_KEY = 'instance';

/** Activity-only session and agent updates are announced at most once per this many milliseconds (03 3.6). */
export const ACTIVITY_INTERVAL_MS = 1000;

/** The throttle forgets entities whose window has passed once it tracks more than this many. */
const MAX_TRACKED = 4096;

export interface ChangeSink {
  /**
   * Maps the entity to its change (03 9.1) and reserves it in the transaction. Returns the reserved seq, so that the
   * caller can stamp `updated_seq` of the entity, or null when the throttle deferred an activity-only update.
   * Throws a `RangeError` for a key the entity cannot use; nothing is reserved then.
   */
  record(entity: ChangeEntity, key: string, op: ChangeSinkOp): number | null;
  /** No-op (03 9.1): publication happens in `onCommitted`. */
  flush(): void;
  /** No-op (03 9.1): a ROLLBACK removes the reserved change rows. */
  discard(): void;
}

type Ref = Parameters<ChangeRecorder['reserve']>[2];

/** What an entity, a key and an op mean as a change. */
export interface ChangeTarget {
  readonly entity: ChangeEntity;
  readonly key: string;
  readonly kind: ChangeKind;
  readonly op: ChangeOp;
  readonly ref: Ref;
  /** Identifies the entity for the throttle (a turn and a session share one window); null: the entity is never throttled. */
  readonly windowKey: string | null;
  /** True when this call is an activity-only update that the throttle may defer. */
  readonly deferrable: boolean;
}

export interface ReservedChange {
  readonly entity: ChangeEntity;
  readonly key: string;
  readonly seq: number;
}

export interface ActivityThrottle {
  readonly intervalMs: number;
  /** True: reserve now (the window restarts). False: deferred, the entity is dirty until `flush` announces it. */
  admit(target: ChangeTarget, now: number): boolean;
  /** An announcement that bypassed the throttle (a view change, an insert): restarts the window, drops a pending one. */
  announced(entity: ChangeEntity, key: string, now: number): void;
  /** Reserves every deferred change whose window has passed. Call inside `withWriteTx` from the writer's timer. */
  flush(tx: WriteTx): ReservedChange[];
  /**
   * Puts the changes of a `flush` back as due: call it when the transaction that flushed them failed, so that the next
   * `flush` announces them (the state of `flush` is not rolled back with the transaction).
   */
  restore(changes: readonly ReservedChange[]): void;
  /** The time from which `flush` has something to announce, or null when nothing is deferred. */
  nextDueAt(): number | null;
  /** How many entities the throttle remembers (bounded; for tests and diagnostics). */
  trackedCount(): number;
}

type Scope = 'session' | 'entity' | 'instance';

interface Mapping {
  readonly kind: ChangeKind;
  readonly op: ChangeOp;
  readonly scope: Scope;
  /** The entity takes part in the activity window: its announcements restart it, and `defer` ops may be held back. */
  readonly windowed: boolean;
  /** The ops that are activity-only and may be deferred by the throttle; every other op is announced at once. */
  readonly defer: readonly ChangeSinkOp[];
}

const ALL_OPS: readonly ChangeSinkOp[] = ['insert', 'update', 'delete'];

function mappingOf(entity: ChangeEntity, key: string, op: ChangeSinkOp): Mapping {
  switch (entity) {
    case 'session':
      return op === 'delete'
        ? { kind: 'session', op: 'delete', scope: 'session', windowed: false, defer: [] }
        : { kind: 'session', op: 'upsert', scope: 'session', windowed: true, defer: ['update'] };
    case 'turn':
      // a turn is a change of its session (03 9.1)
      return { kind: 'session', op: 'upsert', scope: 'session', windowed: true, defer: ALL_OPS };
    case 'agent':
      // there is no agent/delete in the CHECK of `changes`: an agent row only disappears with its session
      return { kind: 'agent', op: 'upsert', scope: 'entity', windowed: true, defer: ['update'] };
    case 'workflow_run':
      return { kind: 'workflow', op: 'upsert', scope: 'entity', windowed: false, defer: [] };
    case 'tool_call':
      return { kind: 'tool_call', op: 'upsert', scope: 'session', windowed: false, defer: [] };
    case 'event':
      return { kind: 'event', op: 'append', scope: 'session', windowed: false, defer: [] };
    case 'usage':
      return { kind: 'usage', op: 'invalidate', scope: 'session', windowed: false, defer: [] };
    case 'ingest_health':
      return { kind: 'health', op: 'upsert', scope: 'instance', windowed: true, defer: ALL_OPS };
    case 'reconciliation':
      // the monitor row of a session shows up in its timeline; an instance level row only changes the health
      return key === INSTANCE_KEY
        ? { kind: 'health', op: 'upsert', scope: 'instance', windowed: true, defer: [] }
        : { kind: 'event', op: 'append', scope: 'session', windowed: false, defer: [] };
  }
}

const DIGITS = /^[0-9]{1,15}$/;

function badKey(entity: ChangeEntity, scope: Scope): RangeError {
  const shape =
    scope === 'instance'
      ? `'${INSTANCE_KEY}'`
      : scope === 'session'
        ? "'<session uid>' or '<row id>:<session uid>'"
        : "'<row id>' or '<row id>:<session uid>'";
  return new RangeError(`change key of ${entity} must be ${shape}`);
}

function refOf(entity: ChangeEntity, scope: Scope, key: string): Ref {
  if (scope === 'instance') {
    if (key !== INSTANCE_KEY) throw badKey(entity, scope);
    return { entityId: null, sessionUid: null };
  }
  const colon = key.indexOf(':');
  const idText = colon === -1 ? null : key.slice(0, colon);
  const rest = colon === -1 ? key : key.slice(colon + 1);
  if (colon === -1 && DIGITS.test(key)) {
    if (scope === 'session') throw badKey(entity, scope);
    return { entityId: Number(key), sessionUid: null };
  }
  if (!SID_RE.test(rest)) throw badKey(entity, scope);
  if (idText !== null && !DIGITS.test(idText)) throw badKey(entity, scope);
  const entityId = idText === null ? null : Number(idText);
  if (scope === 'entity' && entityId === null) throw badKey(entity, scope);
  return { entityId, sessionUid: rest };
}

function windowKeyOf(mapping: Mapping, ref: Ref): string {
  // the same identity as the recorder's coalescing key: a session by its uid, an entity by its row id
  const scope =
    mapping.scope === 'session'
      ? `s:${ref.sessionUid ?? `row:${String(ref.entityId)}`}`
      : mapping.scope === 'entity'
        ? `e:${ref.entityId === null ? String(ref.sessionUid) : String(ref.entityId)}`
        : 'i';
  return `${mapping.kind}|${scope}`;
}

/** Resolves an entity, a key and an op to a change. Throws `RangeError` for a key that does not fit the entity. */
export function describeChange(entity: ChangeEntity, key: string, op: ChangeSinkOp): ChangeTarget {
  const mapping = mappingOf(entity, key, op);
  const ref = refOf(entity, mapping.scope, key);
  return {
    entity,
    key,
    kind: mapping.kind,
    op: mapping.op,
    ref,
    windowKey: mapping.windowed ? windowKeyOf(mapping, ref) : null,
    deferrable: mapping.defer.includes(op),
  };
}

interface Pending {
  readonly target: ChangeTarget;
}

/** The window state of the activity-only announcements. One per writer; every `createChangeSink` of it gets the same one. */
export function createActivityThrottle(options: { intervalMs?: number } = {}): ActivityThrottle {
  const intervalMs = options.intervalMs ?? ACTIVITY_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`throttle interval must be a positive number of milliseconds, got ${String(intervalMs)}`);
  }
  // When the entity was last announced, and the changes held back since. A clock that moved backwards counts as elapsed.
  const lastAt = new Map<string, number>();
  const dirty = new Map<string, Pending>();
  const elapsed = (since: number, now: number): boolean => now < since || now - since >= intervalMs;

  // Forgets the entities whose window has passed. The next sweep waits until the map has doubled, so that a burst of
  // entities that are all still inside their window costs one pass, not one per entity.
  let pruneAt = MAX_TRACKED;
  const prune = (now: number): void => {
    if (lastAt.size <= pruneAt) return;
    for (const [windowKey, at] of lastAt) {
      if (!dirty.has(windowKey) && elapsed(at, now)) lastAt.delete(windowKey);
    }
    pruneAt = Math.max(MAX_TRACKED, lastAt.size * 2);
  };

  return {
    intervalMs,
    admit(target, now) {
      const { windowKey } = target;
      if (windowKey === null) return true;
      const at = lastAt.get(windowKey);
      if (target.deferrable && at !== undefined && !elapsed(at, now)) {
        dirty.set(windowKey, { target });
        return false;
      }
      lastAt.set(windowKey, now);
      dirty.delete(windowKey);
      prune(now);
      return true;
    },
    announced(entity, key, now) {
      const { windowKey } = describeChange(entity, key, 'update');
      if (windowKey === null) return;
      lastAt.set(windowKey, now);
      dirty.delete(windowKey);
      prune(now);
    },
    flush(tx) {
      const reserved: ReservedChange[] = [];
      for (const [windowKey, { target }] of dirty) {
        const at = lastAt.get(windowKey);
        if (at !== undefined && !elapsed(at, tx.now)) continue;
        const seq = tx.changes.reserve(target.kind, target.op, target.ref);
        lastAt.set(windowKey, tx.now);
        dirty.delete(windowKey);
        reserved.push({ entity: target.entity, key: target.key, seq });
      }
      prune(tx.now);
      return reserved;
    },
    restore(changes) {
      for (const { entity, key } of changes) {
        const target = describeChange(entity, key, 'update');
        if (target.windowKey === null) continue;
        lastAt.delete(target.windowKey);
        dirty.set(target.windowKey, { target });
      }
    },
    nextDueAt() {
      let next: number | null = null;
      for (const windowKey of dirty.keys()) {
        const due = (lastAt.get(windowKey) ?? 0) + intervalMs;
        if (next === null || due < next) next = due;
      }
      return next;
    },
    trackedCount: () => lastAt.size,
  };
}

export interface ChangeSinkOptions {
  /** The writer's throttle for activity-only updates; without it every update reserves. */
  readonly throttle?: ActivityThrottle;
}

/** The `ChangeSink` of one write transaction (03 9.1). */
export function createChangeSink(tx: WriteTx, options: ChangeSinkOptions = {}): ChangeSink {
  const { throttle } = options;
  return {
    record(entity, key, op) {
      const target = describeChange(entity, key, op);
      if (throttle !== undefined && !throttle.admit(target, tx.now)) return null;
      return tx.changes.reserve(target.kind, target.op, target.ref);
    },
    flush: () => undefined,
    discard: () => undefined,
  };
}
