// The patch ledger of 04 5.5 rule R4 (late snapshot): the latest stream patch per entity, so that a snapshot response that was
// read before the patch arrived cannot overwrite it. Entities carry the change-log `seq` of their last change (03 9.1); a
// patch is kept only when it is newer than the held one (R1), and an entry the snapshot already includes (`seq <= asOfSeq`)
// is evicted. LRU of 2,000 keys. Pure data structure: no React, no timers.
import type { AgentNode, AlertItem, SessionSummary, WorkflowRunItem, WorkItem } from '@mcs/shared';

/** The entity kinds the ledger holds and their data types. */
export interface LedgerKinds {
  session: SessionSummary;
  agent: AgentNode;
  workflow: WorkflowRunItem;
  work_item: WorkItem;
  alert: AlertItem;
}
export type LedgerKind = keyof LedgerKinds;

export const LEDGER_MAX_KEYS = 2000;

const KINDS: readonly LedgerKind[] = ['session', 'agent', 'workflow', 'work_item', 'alert'];

/** The entity keys of R4: `session:<id>`, `agent:<sid>:<aid>`, `workflow:<runId>`, `work_item:<id>`, `alert:<id>`. */
export const ledgerKey = {
  session: (id: string): string => `session:${id}`,
  agent: (sessionId: string, agentId: string): string => `agent:${sessionId}:${agentId}`,
  workflow: (runId: string): string => `workflow:${runId}`,
  workItem: (id: number): string => `work_item:${String(id)}`,
  alert: (id: number): string => `alert:${String(id)}`,
};

const KEY_OF: { [K in LedgerKind]: (data: LedgerKinds[K]) => string } = {
  session: (d) => ledgerKey.session(d.id),
  agent: (d) => ledgerKey.agent(d.sessionId, d.id),
  workflow: (d) => ledgerKey.workflow(d.runId),
  work_item: (d) => ledgerKey.workItem(d.id),
  alert: (d) => ledgerKey.alert(d.id),
};

export interface LedgerEntry<T> {
  seq: number;
  data: T;
}

export interface PatchLedger {
  /** Stores the patch when it is newer than the held one (R1). Returns whether it was stored. */
  put<K extends LedgerKind>(kind: K, data: LedgerKinds[K]): boolean;
  /** The held patch of an entity key (see `ledgerKey`), marking it recently used. */
  get<K extends LedgerKind>(kind: K, key: string): LedgerEntry<LedgerKinds[K]> | undefined;
  /** Replaces every snapshot entity that is older than its ledger copy; returns the same array when nothing changed. */
  reapplyList<K extends LedgerKind>(
    kind: K,
    items: readonly LedgerKinds[K][],
    asOfSeq: number,
  ): readonly LedgerKinds[K][];
  /** The same for one entity (a detail query). */
  reapplyEntity<K extends LedgerKind>(kind: K, entity: LedgerKinds[K], asOfSeq: number): LedgerKinds[K];
  /** Forgets one entity (it was deleted). */
  remove(kind: LedgerKind, key: string): void;
  /** Drops the entries the snapshot already includes (`seq <= asOfSeq`). */
  evictThrough(asOfSeq: number): void;
  clear(): void;
  readonly size: number;
}

export function createPatchLedger(maxKeys: number = LEDGER_MAX_KEYS): PatchLedger {
  const stores: { [K in LedgerKind]: Map<string, LedgerEntry<LedgerKinds[K]>> } = {
    session: new Map(),
    agent: new Map(),
    workflow: new Map(),
    work_item: new Map(),
    alert: new Map(),
  };
  /** Recency order across all kinds: oldest first. The value is the kind that owns the key. */
  const recency = new Map<string, LedgerKind>();

  function touch(key: string, kind: LedgerKind): void {
    recency.delete(key);
    recency.set(key, kind);
  }

  function drop(key: string, kind: LedgerKind): void {
    stores[kind].delete(key);
    recency.delete(key);
  }

  function enforceLimit(): void {
    while (recency.size > maxKeys) {
      const oldest = recency.entries().next();
      if (oldest.done === true) return;
      drop(oldest.value[0], oldest.value[1]);
    }
  }

  function get<K extends LedgerKind>(kind: K, key: string): LedgerEntry<LedgerKinds[K]> | undefined {
    const entry = stores[kind].get(key);
    if (entry !== undefined) touch(key, kind);
    return entry;
  }

  function newest<K extends LedgerKind>(kind: K, entity: LedgerKinds[K]): LedgerKinds[K] {
    const held = stores[kind].get(KEY_OF[kind](entity));
    return held !== undefined && entity.seq < held.seq ? held.data : entity;
  }

  function reapplyList<K extends LedgerKind>(
    kind: K,
    items: readonly LedgerKinds[K][],
    asOfSeq: number,
  ): readonly LedgerKinds[K][] {
    let out: LedgerKinds[K][] | null = null;
    for (const [index, entity] of items.entries()) {
      const chosen = newest(kind, entity);
      if (chosen === entity) continue;
      out ??= [...items];
      out[index] = chosen;
    }
    ledger.evictThrough(asOfSeq);
    return out ?? items;
  }

  const ledger: PatchLedger = {
    put(kind, data) {
      const key = KEY_OF[kind](data);
      const held = stores[kind].get(key);
      if (held !== undefined && data.seq <= held.seq) return false;
      stores[kind].set(key, { seq: data.seq, data });
      touch(key, kind);
      enforceLimit();
      return true;
    },
    get,
    reapplyList,
    reapplyEntity(kind, entity, asOfSeq) {
      const chosen = newest(kind, entity);
      ledger.evictThrough(asOfSeq);
      return chosen;
    },
    remove: (kind, key) => {
      drop(key, kind);
    },
    evictThrough(asOfSeq) {
      for (const kind of KINDS) {
        for (const [key, entry] of stores[kind]) {
          if (entry.seq <= asOfSeq) drop(key, kind);
        }
      }
    },
    clear() {
      for (const kind of KINDS) stores[kind].clear();
      recency.clear();
    },
    get size() {
      return recency.size;
    },
  };
  return ledger;
}
