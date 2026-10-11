// Live buffers and pause/resume of 04 5.7. A feed (the activity page, the session timeline) keeps a bounded `head` of events that
// arrived on the stream while it is live, and, while the user has paused it, a bounded `buffered` list that "Resume" merges in.
// The reducer is pure; `createLiveBuffer` wraps it in a small external store, and the registry lets the reconciler offer stream
// events to every mounted buffer without knowing the pages.
import type { ActivityEvent, ToolCallItem } from '@mcs/shared';

export interface LiveBufferOptions<T> {
  key(t: T): string;
  accept(t: T): boolean;
  /** 500: more live items than this and the feed refetches its first page instead. */
  headCap: number;
  /** 500: more buffered items than this while paused and the rest are dropped (counted). */
  pausedCap: number;
}

export interface LiveBufferState<T> {
  /** Newest first. */
  head: T[];
  paused: boolean;
  /** Newest first; only filled while paused. */
  buffered: T[];
  dropped: number;
  /** Keys already shown or buffered, bounded to twice the caps (the oldest keys are forgotten first). */
  seen: Set<string>;
}

export type LiveBufferAction<T> =
  | { type: 'offer'; items: readonly T[] }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'snapshot'; asOfSeq: number; seqOf(t: T): number }
  | { type: 'clear' };

export type LiveBufferEffect = 'none' | 'refetch-first-page';

export function initialLiveBufferState<T>(): LiveBufferState<T> {
  return { head: [], paused: false, buffered: [], dropped: 0, seen: new Set() };
}

function boundedSeen(seen: Set<string>, limit: number): Set<string> {
  if (seen.size <= limit) return seen;
  const keep = new Set(seen);
  for (const key of seen) {
    if (keep.size <= limit) break;
    keep.delete(key);
  }
  return keep;
}

function unseen<T>(items: readonly T[], seen: ReadonlySet<string>, o: LiveBufferOptions<T>): T[] {
  const local = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!o.accept(item)) continue;
    const key = o.key(item);
    if (seen.has(key) || local.has(key)) continue;
    local.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Items of one `offer` are in arrival order (a stream frame lists events oldest to newest, as the server reads them by id), so
 * the newest ends up first in `head` and `buffered`.
 */
export function liveBufferReducer<T>(
  s: LiveBufferState<T>,
  a: LiveBufferAction<T>,
  o: LiveBufferOptions<T>,
): { state: LiveBufferState<T>; effect: LiveBufferEffect } {
  const seenLimit = 2 * (o.headCap + o.pausedCap);
  switch (a.type) {
    case 'offer': {
      const fresh = unseen(a.items, s.seen, o);
      if (fresh.length === 0) return { state: s, effect: 'none' };
      if (!s.paused) {
        const seen = new Set(s.seen);
        for (const item of fresh) seen.add(o.key(item));
        const head = [...fresh.reverse(), ...s.head];
        const state = { ...s, seen: boundedSeen(seen, seenLimit) };
        if (head.length > o.headCap) return { state: { ...state, head: [] }, effect: 'refetch-first-page' };
        return { state: { ...state, head }, effect: 'none' };
      }
      const room = Math.max(0, o.pausedCap - s.buffered.length);
      const taken = fresh.slice(0, room);
      const seen = new Set(s.seen);
      for (const item of taken) seen.add(o.key(item));
      return {
        state: {
          ...s,
          buffered: [...taken.reverse(), ...s.buffered],
          dropped: s.dropped + (fresh.length - taken.length),
          seen: boundedSeen(seen, seenLimit),
        },
        effect: 'none',
      };
    }
    case 'pause':
      return { state: s.paused ? s : { ...s, paused: true }, effect: 'none' };
    case 'resume': {
      if (!s.paused) return { state: s, effect: 'none' };
      if (s.dropped > 0) {
        return { state: { ...s, head: [], buffered: [], dropped: 0, paused: false }, effect: 'refetch-first-page' };
      }
      const keys = new Set<string>();
      const head: T[] = [];
      for (const item of [...s.buffered, ...s.head]) {
        const key = o.key(item);
        if (keys.has(key)) continue;
        keys.add(key);
        head.push(item);
      }
      // The merged head is held to the same cap as a live one: a resume that would pass it refetches instead.
      if (head.length > o.headCap) {
        return { state: { ...s, head: [], buffered: [], dropped: 0, paused: false }, effect: 'refetch-first-page' };
      }
      return { state: { ...s, head, buffered: [], paused: false }, effect: 'none' };
    }
    case 'snapshot': {
      const newer = (t: T): boolean => a.seqOf(t) > a.asOfSeq;
      return { state: { ...s, head: s.head.filter(newer), buffered: s.buffered.filter(newer) }, effect: 'none' };
    }
    case 'clear':
      return { state: initialLiveBufferState<T>(), effect: 'none' };
  }
}

// ---- store -----------------------------------------------------------------------------------------------------------------

export interface LiveBufferHooks {
  /** Called after a dispatch whose effect is not `none`. */
  onEffect?(effect: LiveBufferEffect): void;
  /** Called after a resume that merged `n` buffered items without refetching ("Resumed: N new events"). */
  onResumed?(n: number): void;
}

export interface LiveBufferStore<T> {
  getState(): LiveBufferState<T>;
  /** Fits `useSyncExternalStore`. */
  subscribe(fn: () => void): () => void;
  dispatch(action: LiveBufferAction<T>): void;
}

export function createLiveBuffer<T>(o: LiveBufferOptions<T>, hooks: LiveBufferHooks = {}): LiveBufferStore<T> {
  let state = initialLiveBufferState<T>();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispatch(action) {
      const before = state;
      const result = liveBufferReducer(state, action, o);
      state = result.state;
      if (state !== before) for (const fn of [...listeners]) fn();
      if (result.effect !== 'none') hooks.onEffect?.(result.effect);
      if (action.type === 'resume' && before.paused && result.effect === 'none')
        hooks.onResumed?.(before.buffered.length);
    },
  };
}

// ---- registry --------------------------------------------------------------------------------------------------------------

/** What the reconciler needs from a mounted feed (each feed applies its own filter, 4.4.4). */
export interface LiveBufferHandle {
  offer: (items: readonly ActivityEvent[]) => void;
  /** `event/append` with `truncated`, or an overflow: refetch the first page. */
  refetchFirstPage: () => void;
  /** `tool_call/upsert`: rows with the same `toolUseId` get the new status and duration in place. */
  patchToolCalls: (items: readonly ToolCallItem[]) => void;
  clear: () => void;
}

export interface LiveBufferRegistry {
  register(handle: LiveBufferHandle): () => void;
  offer(items: readonly ActivityEvent[]): void;
  refetchFirstPage(): void;
  patchToolCalls(items: readonly ToolCallItem[]): void;
  clear(): void;
  readonly size: number;
}

export function createLiveBufferRegistry(): LiveBufferRegistry {
  const handles = new Set<LiveBufferHandle>();

  /** One feed failing must not keep the others from the stream. */
  function each(fn: (h: LiveBufferHandle) => void): void {
    for (const handle of [...handles]) {
      try {
        fn(handle);
      } catch {
        // a feed bug is that feed's problem; its next refetch repairs it
      }
    }
  }

  return {
    register(handle) {
      handles.add(handle);
      return () => {
        handles.delete(handle);
      };
    },
    offer: (items) => {
      each((h) => {
        h.offer(items);
      });
    },
    refetchFirstPage: () => {
      each((h) => {
        h.refetchFirstPage();
      });
    },
    patchToolCalls: (items) => {
      each((h) => {
        h.patchToolCalls(items);
      });
    },
    clear: () => {
      each((h) => {
        h.clear();
      });
    },
    get size() {
      return handles.size;
    },
  };
}
