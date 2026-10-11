// Reconciliation of stream changes into the query cache (04 5.5). `applyChange` is the dispatch table of the design: one case per
// `kind`/`op` of 03 9.2, every patch guarded by R1 (apply only when `incoming.seq > cached.seq`), lists patched in place (R3),
// `data: null` meaning "invalidate that entity". `createReconciler` binds a context (query client, patch ledger, live buffers,
// transcript viewers, debounced invalidations) and offers `applyBatch`, the R5 resync and the instance-change reset.
// `installLedgerReapply` closes R4: a snapshot response that was read before a patch arrived is corrected from the ledger.
//
// Cached values are `unknown` to the query client, so every patch goes through small structural guards (the API client already
// validated them with the shared schemas when they were fetched); a value that has another shape is left alone.
import type {
  ActivityEvent,
  AgentNode,
  AlertItem,
  HealthReport,
  SessionSummary,
  StreamChange,
  ToolCallItem,
  WorkItem,
  WorkflowRunItem,
} from '@mcs/shared';
import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

import { qk } from '../data/query-keys.ts';
import { createLiveBufferRegistry, type LiveBufferRegistry } from './live-buffer.ts';
import { createPatchLedger, ledgerKey, type LedgerKind, type LedgerKinds, type PatchLedger } from './patch-ledger.ts';
import type { ResyncReason } from './stream-client.ts';

// ---- collaborators ---------------------------------------------------------------------------------------------------------

/** The mounted transcript viewers (04 5.4): the stream only asks them to refresh. */
export interface TranscriptRegistry {
  get: (sessionId: string, agentId: string) => { refresh: () => void } | undefined;
  /** Every mounted viewer of the session. */
  refreshSession: (sessionId: string) => void;
  /** Every mounted viewer (R5). */
  refreshAll: () => void;
}

export const NO_TRANSCRIPTS: TranscriptRegistry = {
  get: () => undefined,
  refreshSession: () => undefined,
  refreshAll: () => undefined,
};

/** Rule R3: the number of membership changes a list did not show, per cached list query (the "List changed: Refresh" button). */
export interface PendingChanges {
  bump(key: QueryKey): void;
  get(key: QueryKey): number;
  /** The list was refreshed. */
  reset(key: QueryKey): void;
  clear(): void;
  total(): number;
  /** Fits `useSyncExternalStore`: changes whenever a count changes. */
  version(): number;
  subscribe(fn: () => void): () => void;
}

export function createPendingChanges(): PendingChanges {
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  function changed(): void {
    version += 1;
    for (const fn of [...listeners]) fn();
  }
  return {
    bump(key) {
      const hash = hashKey(key);
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
      changed();
    },
    get: (key) => counts.get(hashKey(key)) ?? 0,
    reset(key) {
      if (counts.delete(hashKey(key))) changed();
    },
    clear() {
      if (counts.size === 0) return;
      counts.clear();
      changed();
    },
    total() {
      let sum = 0;
      for (const n of counts.values()) sum += n;
      return sum;
    },
    version: () => version,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface Debouncer {
  /** Trailing debounce per key: a later call with the same key replaces the earlier one and restarts the wait. */
  schedule: (key: string, ms: number, fn: () => void) => void;
  /** Drops everything that has not run yet. */
  cancelAll: () => void;
  readonly size: number;
}

export function createDebouncer(
  setTimer: (fn: () => void, ms: number) => TimerHandle = (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h: TimerHandle) => void = (h) => {
    clearTimeout(h);
  },
): Debouncer {
  const timers = new Map<string, TimerHandle>();
  return {
    schedule(key, ms, fn) {
      const old = timers.get(key);
      if (old !== undefined) clearTimer(old);
      timers.set(
        key,
        setTimer(() => {
          timers.delete(key);
          fn();
        }, ms),
      );
    },
    cancelAll() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
    },
    get size() {
      return timers.size;
    },
  };
}

/** Debounce periods of the dispatch table (04 5.5). */
export const DEBOUNCE_MS = { default: 2000, usage: 10_000 } as const;

export interface ReconcileContext {
  queryClient: QueryClient;
  iid: string;
  ledger: PatchLedger;
  liveBuffers: LiveBufferRegistry;
  transcriptRegistry: TranscriptRegistry;
  pending: PendingChanges;
  schedule: Debouncer['schedule'];
  cancelScheduled(): void;
  /** Polite announcement through the page live region. */
  announce(message: string): void;
  /** R3 exception: the list is scrolled to the top (scrollTop < 8 px). */
  listAtTop(queryKey: QueryKey): boolean;
  /** `session/delete`: the detail page shows "This session was removed by retention cleanup". */
  onSessionRemoved(sessionId: string): void;
}

// ---- structural guards -----------------------------------------------------------------------------------------------------

/** One field of a record the shapes of which the cache does not promise (index-signature access needs a variable key). */
function field(x: Record<string, unknown>, name: string): unknown {
  return x[name];
}

function isQueryKey(x: unknown): x is QueryKey {
  return Array.isArray(x);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isSessionItem(x: unknown): x is SessionSummary {
  return (
    isRecord(x) &&
    typeof field(x, 'id') === 'string' &&
    typeof field(x, 'seq') === 'number' &&
    isRecord(field(x, 'state'))
  );
}

function isAgentItem(x: unknown): x is AgentNode {
  return (
    isRecord(x) &&
    typeof field(x, 'id') === 'string' &&
    typeof field(x, 'seq') === 'number' &&
    typeof field(x, 'sessionId') === 'string'
  );
}

function isWorkItem(x: unknown): x is WorkItem {
  return (
    isRecord(x) &&
    typeof field(x, 'id') === 'number' &&
    typeof field(x, 'seq') === 'number' &&
    typeof field(x, 'title') === 'string'
  );
}

function isEventRow(x: unknown): x is ActivityEvent {
  return (
    isRecord(x) && typeof field(x, 'id') === 'number' && 'toolUseId' in x && 'toolStatus' in x && 'durationMs' in x
  );
}

type PageOf<T> = Record<string, unknown> & { items: T[] };
type InfiniteOf<T> = Record<string, unknown> & { pages: PageOf<T>[] };

function isPageOf<T>(x: unknown, isItem: (item: unknown) => item is T): x is PageOf<T> {
  if (!isRecord(x)) return false;
  const items = field(x, 'items');
  return Array.isArray(items) && items.every(isItem);
}

function isInfiniteOf<T>(x: unknown, isItem: (item: unknown) => item is T): x is InfiniteOf<T> {
  if (!isRecord(x)) return false;
  const pages = field(x, 'pages');
  return Array.isArray(pages) && Array.isArray(field(x, 'pageParams')) && pages.every((p) => isPageOf(p, isItem));
}

/** Where `mapPages` is: the page record (for its meta, such as `asOfSeq`), its index and the number of pages. */
interface PageAt<T> {
  page: PageOf<T>;
  index: number;
  count: number;
}

/** The pages of a cached list: an infinite query's pages, or the one page of a plain list; `null` for any other shape. */
function pagesOf<T>(data: unknown, isItem: (item: unknown) => item is T): PageOf<T>[] | null {
  if (isInfiniteOf(data, isItem)) return data.pages;
  if (isPageOf(data, isItem)) return [data];
  return null;
}

/**
 * Rebuilds a cached list with `fn` applied to the items of each page (`fn` returns the same array when it changes nothing).
 * Returns `undefined` when the value is not a list of `T` or no page changed, so a caller writes the cache only for a change.
 */
function mapPages<T>(
  data: unknown,
  isItem: (item: unknown) => item is T,
  fn: (items: T[], at: PageAt<T>) => T[],
): unknown {
  if (isInfiniteOf(data, isItem)) {
    const state = { changed: false };
    const pages = data.pages.map((page, index) => {
      const items = fn(page.items, { page, index, count: data.pages.length });
      if (items === page.items) return page;
      state.changed = true;
      return { ...page, items };
    });
    return state.changed ? { ...data, pages } : undefined;
  }
  if (isPageOf(data, isItem)) {
    const items = fn(data.items, { page: data, index: 0, count: 1 });
    return items === data.items ? undefined : { ...data, items };
  }
  return undefined;
}

/** `items` with the one entity of `id` replaced by `patch` when the patch is newer (R1); the same array otherwise. */
function replaceNewer<T extends { seq: number }>(items: T[], index: number, patch: T): T[] {
  const current = items[index];
  if (current === undefined || patch.seq <= current.seq) return items;
  const copy = [...items];
  copy[index] = patch;
  return copy;
}

// ---- cache helpers ---------------------------------------------------------------------------------------------------------

function invalidate(ctx: ReconcileContext, queryKey: QueryKey, exact = false): void {
  void ctx.queryClient.invalidateQueries({ queryKey, exact });
}

function debouncedInvalidate(ctx: ReconcileContext, queryKey: QueryKey, ms: number = DEBOUNCE_MS.default): void {
  ctx.schedule(`invalidate:${hashKey(queryKey)}`, ms, () => {
    invalidate(ctx, queryKey);
  });
}

function cachedQueries(ctx: ReconcileContext, prefix: QueryKey): [QueryKey, unknown][] {
  return ctx.queryClient.getQueriesData({ queryKey: prefix });
}

const sessionsPrefix = (iid: string): QueryKey => [...qk.root(iid), 'sessions'];

function isSidebarKey(key: QueryKey): boolean {
  const q = key[3];
  return isRecord(q) && field(q, 'sidebar') === true;
}

// ---- dispatch --------------------------------------------------------------------------------------------------------------

function sessionUpserted(data: SessionSummary, ctx: ReconcileContext): void {
  ctx.ledger.put('session', data);
  const detailKey = qk.session(ctx.iid, data.id);
  const detail = ctx.queryClient.getQueryData(detailKey);
  const cachedSeq = isRecord(detail) ? field(detail, 'seq') : undefined;
  if (isRecord(detail) && typeof cachedSeq === 'number' && data.seq > cachedSeq) {
    ctx.queryClient.setQueryData(detailKey, { ...detail, ...data });
  }
  for (const [key, cached] of cachedQueries(ctx, sessionsPrefix(ctx.iid))) {
    const state = { found: false };
    const next = mapPages(cached, isSessionItem, (items) => {
      const index = items.findIndex((s) => s.id === data.id);
      if (index < 0) return items;
      state.found = true;
      return replaceNewer(items, index, data);
    });
    if (next !== undefined) ctx.queryClient.setQueryData(key, next);
    if (state.found) continue;
    const pages = pagesOf(cached, isSessionItem);
    if (pages === null) continue;
    if (isSidebarKey(key)) {
      // The sidebar is a live list by design: a new session joins it and the sidebar re-groups.
      const joined = mapPages(cached, isSessionItem, (items) => [data, ...items]);
      if (joined !== undefined) ctx.queryClient.setQueryData(key, joined);
    } else if (pages.length === 1 && ctx.listAtTop(key)) {
      debouncedInvalidate(ctx, key);
    } else {
      ctx.pending.bump(key);
    }
  }
  debouncedInvalidate(ctx, qk.overview(ctx.iid));
}

/** Lists that hold the session get a pending change; the detail is refetched. */
function sessionUnreadable(sessionId: string, ctx: ReconcileContext): void {
  invalidate(ctx, qk.session(ctx.iid, sessionId), true);
  for (const [key, cached] of cachedQueries(ctx, sessionsPrefix(ctx.iid))) {
    if (isSidebarKey(key)) continue;
    const pages = pagesOf(cached, isSessionItem);
    if (pages?.some((page) => page.items.some((s) => s.id === sessionId)) === true) ctx.pending.bump(key);
  }
}

function sessionDeleted(sessionId: string, ctx: ReconcileContext): void {
  for (const [key, cached] of cachedQueries(ctx, sessionsPrefix(ctx.iid))) {
    const next = mapPages(cached, isSessionItem, (items) =>
      items.some((s) => s.id === sessionId) ? items.filter((s) => s.id !== sessionId) : items,
    );
    if (next !== undefined) ctx.queryClient.setQueryData(key, next);
  }
  ctx.queryClient.removeQueries({ queryKey: qk.session(ctx.iid, sessionId) });
  ctx.ledger.remove('session', ledgerKey.session(sessionId));
  ctx.onSessionRemoved(sessionId);
}

function agentUpserted(data: AgentNode, ctx: ReconcileContext): void {
  ctx.ledger.put('agent', data);
  const key = qk.agents(ctx.iid, data.sessionId);
  const cached = ctx.queryClient.getQueryData(key);
  const pages = pagesOf(cached, isAgentItem);
  if (pages === null) return;
  const present = pages.some((page) => page.items.some((a) => a.id === data.id));
  const next = mapPages(cached, isAgentItem, (items, at) => {
    const index = items.findIndex((a) => a.id === data.id);
    if (index >= 0) return replaceNewer(items, index, data);
    return !present && at.index === at.count - 1 ? [...items, data] : items;
  });
  if (next !== undefined) ctx.queryClient.setQueryData(key, next);
}

function workflowUpserted(data: WorkflowRunItem, ctx: ReconcileContext): void {
  if (!ctx.ledger.put('workflow', data)) return;
  const key = qk.agents(ctx.iid, data.sessionId);
  const next = mapPages(ctx.queryClient.getQueryData(key), isAgentItem, (items) => {
    const state = { changed: false };
    const mapped = items.map((agent) => {
      if (agent.workflow?.runId !== data.runId || agent.workflow.state === data.state.state) return agent;
      state.changed = true;
      return { ...agent, workflow: { ...agent.workflow, state: data.state.state } };
    });
    return state.changed ? mapped : items;
  });
  if (next !== undefined) ctx.queryClient.setQueryData(key, next);
}

function isTimelineOrActivityKey(key: QueryKey): boolean {
  return key[2] === 'activity' || (key[2] === 'session' && key[4] === 'timeline');
}

function toolCallsUpserted(
  items: readonly ToolCallItem[],
  truncated: boolean,
  sessionId: string | null,
  ctx: ReconcileContext,
): void {
  const byUse = new Map(items.map((item) => [item.toolUseId, item]));
  for (const [key, cached] of cachedQueries(ctx, qk.root(ctx.iid))) {
    if (!isTimelineOrActivityKey(key)) continue;
    const next = mapPages(cached, isEventRow, (rows) => {
      const state = { changed: false };
      const mapped = rows.map((row) => {
        const call = row.toolUseId === null ? undefined : byUse.get(row.toolUseId);
        if (call === undefined || (row.toolStatus === call.status && row.durationMs === call.durationMs)) return row;
        state.changed = true;
        return { ...row, toolStatus: call.status, durationMs: call.durationMs };
      });
      return state.changed ? mapped : rows;
    });
    if (next !== undefined) ctx.queryClient.setQueryData(key, next);
  }
  ctx.liveBuffers.patchToolCalls(items);
  if (truncated && sessionId !== null) debouncedInvalidate(ctx, [...qk.session(ctx.iid, sessionId), 'timeline']);
}

function workItemUpserted(data: WorkItem, ctx: ReconcileContext): void {
  if (!ctx.ledger.put('work_item', data)) return;
  const key = qk.workItems(ctx.iid);
  const cached = ctx.queryClient.getQueryData(key);
  const state = { found: false };
  const next = mapPages(cached, isWorkItem, (items) => {
    const index = items.findIndex((w) => w.id === data.id);
    if (index < 0) return items;
    state.found = true;
    return replaceNewer(items, index, data);
  });
  if (next !== undefined) ctx.queryClient.setQueryData(key, next);
  if (!state.found) invalidate(ctx, key);
  for (const [detailKey, detail] of cachedQueries(ctx, [...qk.root(ctx.iid), 'session'])) {
    if (detailKey.length !== 4 || !isRecord(detail)) continue;
    const listed = field(detail, 'workItems');
    if (Array.isArray(listed) && listed.some((w: unknown) => isRecord(w) && field(w, 'id') === data.id)) {
      debouncedInvalidate(ctx, detailKey);
    }
  }
}

function alertUpserted(data: AlertItem | null, ctx: ReconcileContext): void {
  if (data !== null) {
    if (!ctx.ledger.put('alert', data)) return;
    const health = ctx.queryClient.getQueryData<HealthReport>(qk.health(ctx.iid));
    const known = health?.alerts.some((a) => a.id === data.id) === true;
    if (data.status === 'open' && data.severity === 'critical' && !known) ctx.announce(`Alert: ${data.title}`);
  }
  debouncedInvalidate(ctx, qk.health(ctx.iid));
  debouncedInvalidate(ctx, qk.overview(ctx.iid));
}

function healthUpserted(data: HealthReport, ctx: ReconcileContext): void {
  const cached = ctx.queryClient.getQueryData<HealthReport>(qk.health(ctx.iid));
  if (cached === undefined || Date.parse(data.checkedAt) > Date.parse(cached.checkedAt)) {
    ctx.queryClient.setQueryData(qk.health(ctx.iid), data);
  }
}

/**
 * One row of the 04 5.5 dispatch table. A kind this build does not know never gets here: the stream client counts it in
 * `unknownKinds` and lets the sequence advance (forward compatibility).
 */
export function applyChange(change: StreamChange, ctx: ReconcileContext): void {
  const sessionId = change.sessionId;
  switch (change.kind) {
    case 'session':
      if (change.op === 'delete') {
        if (sessionId !== null) sessionDeleted(sessionId, ctx);
      } else if (change.data !== null) {
        sessionUpserted(change.data, ctx);
      } else if (sessionId !== null) {
        sessionUnreadable(sessionId, ctx);
      }
      return;
    case 'agent':
      if (change.data !== null) agentUpserted(change.data, ctx);
      else if (sessionId !== null) invalidate(ctx, qk.agents(ctx.iid, sessionId), true);
      return;
    case 'workflow':
      if (change.data !== null) workflowUpserted(change.data, ctx);
      else if (sessionId !== null) invalidate(ctx, qk.agents(ctx.iid, sessionId), true);
      return;
    case 'tool_call':
      toolCallsUpserted(change.data.items, change.data.truncated, sessionId, ctx);
      return;
    case 'event':
      ctx.liveBuffers.offer(change.data.items);
      if (change.data.truncated) ctx.liveBuffers.refetchFirstPage();
      debouncedInvalidate(ctx, qk.overview(ctx.iid));
      return;
    case 'transcript':
      if (sessionId === null) return;
      if (change.data === null) ctx.transcriptRegistry.refreshSession(sessionId);
      else ctx.transcriptRegistry.get(sessionId, change.data.agentId)?.refresh();
      return;
    case 'work_item':
      if (change.data !== null) workItemUpserted(change.data, ctx);
      else invalidate(ctx, qk.workItems(ctx.iid));
      return;
    case 'usage':
      debouncedInvalidate(ctx, [...qk.root(ctx.iid), 'analytics'], DEBOUNCE_MS.usage);
      debouncedInvalidate(ctx, qk.overview(ctx.iid), DEBOUNCE_MS.usage);
      return;
    case 'alert':
      alertUpserted(change.data, ctx);
      return;
    case 'health':
      healthUpserted(change.data, ctx);
      return;
    case 'attempt':
      invalidate(ctx, qk.panel(ctx.iid, 'attempts'), true);
      return;
  }
}

// ---- R5 and instance change ------------------------------------------------------------------------------------------------

/** R5: forget every patch, drop the live buffers, refetch what the instance has cached, refresh the mounted transcripts. */
export function resetAll(ctx: ReconcileContext): void {
  ctx.cancelScheduled();
  ctx.ledger.clear();
  ctx.liveBuffers.clear();
  ctx.pending.clear();
  void ctx.queryClient.invalidateQueries({ queryKey: qk.root(ctx.iid) });
  ctx.transcriptRegistry.refreshAll();
}

/**
 * UI-I11: another instance owns the address. Everything cached belongs to the old one: clear all of it except the boot query,
 * which is refetched to learn the new instance id.
 */
export function resetForInstanceChange(ctx: ReconcileContext): void {
  ctx.cancelScheduled();
  ctx.ledger.clear();
  ctx.liveBuffers.clear();
  ctx.pending.clear();
  ctx.queryClient.removeQueries({ queryKey: ['mcs'], predicate: (query) => query.queryKey[1] !== 'boot' });
  ctx.transcriptRegistry.refreshAll();
  void ctx.queryClient.invalidateQueries({ queryKey: qk.instance(), exact: true });
}

// ---- reconciler ------------------------------------------------------------------------------------------------------------

export interface ReconcilerOptions {
  queryClient: QueryClient;
  iid: string;
  ledger?: PatchLedger;
  liveBuffers?: LiveBufferRegistry;
  transcriptRegistry?: TranscriptRegistry;
  pending?: PendingChanges;
  announce?: (message: string) => void;
  listAtTop?: (queryKey: QueryKey) => boolean;
  onSessionRemoved?: (sessionId: string) => void;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface Reconciler {
  readonly ctx: ReconcileContext;
  readonly ledger: PatchLedger;
  readonly pending: PendingChanges;
  readonly liveBuffers: LiveBufferRegistry;
  /** One batch of the stream client. A change that throws does not stop the others; the batch then resyncs (R5). */
  applyBatch(changes: readonly StreamChange[]): void;
  resync(reason?: ResyncReason): void;
  instanceChanged(): void;
  /** Cancels every debounced invalidation: no timer is left. */
  dispose(): void;
}

export function createReconciler(o: ReconcilerOptions): Reconciler {
  const ledger = o.ledger ?? createPatchLedger();
  const liveBuffers = o.liveBuffers ?? createLiveBufferRegistry();
  const pending = o.pending ?? createPendingChanges();
  const debouncer = createDebouncer(o.setTimer, o.clearTimer);
  const ctx: ReconcileContext = {
    queryClient: o.queryClient,
    iid: o.iid,
    ledger,
    liveBuffers,
    transcriptRegistry: o.transcriptRegistry ?? NO_TRANSCRIPTS,
    pending,
    schedule: debouncer.schedule,
    cancelScheduled: debouncer.cancelAll,
    announce: o.announce ?? ((): void => undefined),
    listAtTop: o.listAtTop ?? ((): boolean => false),
    onSessionRemoved: o.onSessionRemoved ?? ((): void => undefined),
  };
  return {
    ctx,
    ledger,
    pending,
    liveBuffers,
    applyBatch(changes) {
      let failed = false;
      for (const change of changes) {
        try {
          applyChange(change, ctx);
        } catch {
          failed = true;
        }
      }
      // A change that could not be applied leaves the cache half patched: refetch instead of guessing.
      if (failed) resetAll(ctx);
    },
    resync() {
      resetAll(ctx);
    },
    instanceChanged() {
      resetForInstanceChange(ctx);
    },
    dispose() {
      debouncer.cancelAll();
    },
  };
}

// ---- R4: late snapshot -----------------------------------------------------------------------------------------------------

function reapplyPages<K extends LedgerKind>(
  kind: K,
  isItem: (item: unknown) => item is LedgerKinds[K],
  data: unknown,
  ledger: PatchLedger,
): unknown {
  return mapPages(data, isItem, (items, at) => {
    const asOfSeq = field(at.page, 'asOfSeq');
    if (typeof asOfSeq !== 'number') return items;
    const out = ledger.reapplyList(kind, items, asOfSeq);
    // `reapplyList` returns its input array when nothing changed.
    return out === items ? items : [...out];
  });
}

function reapplyCached(key: QueryKey, data: unknown, ledger: PatchLedger): unknown {
  switch (key[2]) {
    case 'sessions':
      return reapplyPages('session', isSessionItem, data, ledger);
    case 'session':
      if (key.length === 4) {
        const asOfSeq = isRecord(data) ? field(data, 'asOfSeq') : undefined;
        if (!isSessionItem(data) || typeof asOfSeq !== 'number') return undefined;
        const chosen = ledger.reapplyEntity('session', data, asOfSeq);
        return chosen === data ? undefined : { ...data, ...chosen };
      }
      return key[4] === 'agents' ? reapplyPages('agent', isAgentItem, data, ledger) : undefined;
    case 'workItems':
      return reapplyPages('work_item', isWorkItem, data, ledger);
    default:
      return undefined;
  }
}

/**
 * R4: every query result that holds entities passes through the ledger. Installed on the query cache, so the data hooks stay
 * unaware: when a fetch succeeds (or `setQueryData` runs) for a list, a detail, the agents or the work-item board of this
 * instance, an entity older than its ledger copy is replaced by the copy, and ledger entries the snapshot includes are
 * evicted. A corrective write is made only when something changed, so it does not loop. Returns the uninstall function.
 */
export function installLedgerReapply(queryClient: QueryClient, ledger: PatchLedger, iid: string): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    // The cache event is typed with `any` keys and data; take them as `unknown` and check what is used.
    const key: unknown = event.query.queryKey;
    const data: unknown = event.query.state.data;
    if (!isQueryKey(key) || key[0] !== 'mcs' || key[1] !== iid) return;
    const next = reapplyCached(key, data, ledger);
    if (next !== undefined) queryClient.setQueryData(key, next);
  });
}
