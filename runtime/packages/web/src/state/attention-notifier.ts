// The attention notifier (ADR 0107, design attention-trust 3.4): it turns snapshots of rows into at most one announcement
// and one OS notification per moment, and into the settled counts the tab title and the tab icon read. A closure over
// injected seams: no `window`, no `Notification`, no clock and no timer of its own in here.
//
// The rules: the first snapshot is silent; an event waits `delayMs` and is dropped when the row left the posture meanwhile (a
// permission answered inside the delay says nothing); the row the person looks at is silent; everything due at the same
// moment is one announcement; the OS notification is only for a person who is away; nothing fires twice.
import { attentionEventOf, type AttentionClass, type AttentionEventKind } from '@mcs/shared';

import { itemsOf, type AttentionItem, type AttentionRow } from '../lib/attention-rows.ts';
import { hasDwelled, isUnseen, markSeen, SEEN_DWELL_MS, type SeenMap } from '../lib/attention-seen.ts';

/** Settled counts: `failed` and `done` count only what the person has not seen. */
export interface AttentionSummary {
  readonly needsYou: number;
  readonly failed: number;
  readonly done: number;
}

export const NO_ATTENTION: AttentionSummary = Object.freeze({ needsYou: 0, failed: 0, done: 0 });

/** One OS notification: a fixed phrase with a count, never a session name, a label or a path. */
export interface OsNotification {
  title: string;
  body: string;
  tag: string;
  onClick(): void;
}

export const ATTENTION_TAG = 'caw-attention';
/** How many `(row, kind, since)` triples are remembered as already fired. */
export const FIRED_MAX = 256;

/** What the text seam is asked for: the highest kind due, how many rows of that kind, and the row when it is one. */
export interface AttentionTextEvent {
  kind: AttentionEventKind;
  count: number;
  /** The terminal name when exactly one row is due and it is a terminal, else `null`. */
  name: string | null;
  row: AttentionRow | null;
}

export interface NotifierConfig {
  delayMs: number;
  /** The preference `attentionNotify`. */
  notify: boolean;
}

export interface NotifierSeams {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  page(): { visible: boolean; focused: boolean };
  /** The live region; always after the delay. */
  announce(text: string): void;
  /** The OS notification; called only while the person is away and the preference is on. */
  notify(notification: OsNotification): void;
  seen: { read(): SeenMap; write(next: SeenMap): void };
  /** The words, from the catalogue of the caller: `title` is the application title. */
  text(event: AttentionTextEvent): { announce: string; title: string; body: string };
  /** Read at every use, so a changed preference applies at once. */
  config(): NotifierConfig;
  /** A click on the OS notification: go to this row. */
  open(row: AttentionRow): void;
}

export interface AttentionSnapshot {
  readonly items: readonly AttentionItem[];
  readonly summary: AttentionSummary;
}

export interface IngestContext {
  /** The row the person looks at (a change restarts the dwell). */
  selectedKey: string | null;
  /** Names the list the rows come from (the scope). A change swaps the whole list, so it starts a new silent baseline. */
  epoch?: string;
}

export interface Notifier {
  /** The current rows. The first call, and the first one of a new `epoch`, is the silent baseline. */
  readonly ingest: (rows: readonly AttentionRow[], context: IngestContext) => void;
  /** The row the person looks at; call it again when the page becomes visible or focused, the dwell restarts. */
  readonly viewing: (key: string | null) => void;
  /** "Mark as seen" and "Dismiss all": these rows stop counting as `failed` or `done`. */
  readonly markSeen: (keys: readonly string[]) => void;
  /** The same object until something changes (the contract of `useSyncExternalStore`). */
  readonly getSnapshot: () => AttentionSnapshot;
  readonly summary: () => AttentionSummary;
  readonly subscribe: (listener: () => void) => () => void;
  /** Clears the timers. What is known stays, and a later `ingest` arms them again (an effect that runs twice is safe). */
  readonly dispose: () => void;
}

interface Pending {
  kind: AttentionEventKind;
  cls: AttentionClass;
  since: string | null;
  due: number;
}

const KIND_ORDER: readonly AttentionEventKind[] = ['needs_you', 'failed', 'done'];

/** A state the person could have "seen": a failure, a finished turn or a finished session. */
function isSeeable(cls: AttentionClass): boolean {
  return (
    cls.posture === 'failed' ||
    (cls.posture === 'ready' && cls.reason === 'turn_done') ||
    (cls.posture === 'ended' && cls.reason === 'session_done')
  );
}

const samePosture = (a: AttentionClass, b: AttentionClass): boolean => a.posture === b.posture;

function sameItems(a: readonly AttentionItem[], b: readonly AttentionItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      if (other === undefined) return false;
      return (
        item.key === other.key &&
        item.level === other.level &&
        item.unseen === other.unseen &&
        item.since === other.since &&
        item.terminal === other.terminal &&
        item.folderKey === other.folderKey &&
        item.label === other.label &&
        item.labelSource === other.labelSource &&
        item.cls.posture === other.cls.posture &&
        item.cls.reason === other.cls.reason
      );
    })
  );
}

export function createNotifier(seams: NotifierSeams): Notifier {
  const startedAt = seams.now();
  let baselineDone = false;
  let epoch: string | undefined;
  let rows: readonly AttentionRow[] = [];
  const known = new Map<string, AttentionRow>();
  /** Rows whose posture is younger than the delay: key -> the moment it settles. */
  const settleAt = new Map<string, number>();
  const pending = new Map<string, Pending>();
  const fired = new Set<string>();
  /** Seen without the store: the first snapshot, old news of a new row, and rows the store cannot hold. Key -> `since`. */
  const quiet = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  let snapshot: AttentionSnapshot = { items: [], summary: NO_ATTENTION };
  let viewedKey: string | null = null;
  let viewedAt: number | null = null;
  let dwellTimer: unknown = null;
  let tickTimer: unknown = null;

  const pageActive = (): boolean => {
    const page = seams.page();
    return page.visible && page.focused;
  };

  function unseen(row: AttentionRow): boolean {
    if (quiet.has(row.key) && quiet.get(row.key) === row.since) return false;
    return row.sessionId === null || isUnseen(seams.seen.read(), row.sessionId, row.since);
  }

  function publish(): void {
    const items = itemsOf(rows, unseen);
    let needsYou = 0;
    let failed = 0;
    let done = 0;
    for (const item of items) {
      if (settleAt.has(item.key)) continue;
      if (item.level === 'needs_you') needsYou += 1;
      else if (item.level === 'failed') failed += 1;
      else if (item.level === 'done') done += 1;
    }
    const before = snapshot.summary;
    const sameSummary = before.needsYou === needsYou && before.failed === failed && before.done === done;
    if (sameSummary && sameItems(snapshot.items, items)) return;
    snapshot = { items, summary: sameSummary ? before : { needsYou, failed, done } };
    for (const listener of [...listeners]) listener();
  }

  function rememberFired(id: string): void {
    fired.add(id);
    for (const oldest of fired) {
      if (fired.size <= FIRED_MAX) break;
      fired.delete(oldest);
    }
  }

  /** Writes the seen mark of the viewed row once the person has looked at it long enough on an active page. */
  function markViewed(): void {
    if (viewedKey === null || !hasDwelled(viewedAt, seams.now()) || !pageActive()) return;
    const row = known.get(viewedKey);
    if (row === undefined || !isSeeable(row.cls) || !unseen(row)) return;
    see(row);
  }

  function see(row: AttentionRow): void {
    quiet.set(row.key, row.since);
    if (row.sessionId === null) return;
    const before = seams.seen.read();
    const after = markSeen(before, row.sessionId, row.since);
    if (after !== before) seams.seen.write(after);
  }

  function deliver(due: readonly { kind: AttentionEventKind; row: AttentionRow }[]): void {
    const kind = KIND_ORDER.find((candidate) => due.some((event) => event.kind === candidate));
    if (kind === undefined) return;
    const ofKind = due.filter((event) => event.kind === kind);
    const first = ofKind[0];
    if (first === undefined) return;
    const single = ofKind.length === 1 ? first.row : null;
    const text = seams.text({ kind, count: ofKind.length, name: single?.terminal ?? null, row: single });
    seams.announce(text.announce);
    if (seams.config().notify && !pageActive()) {
      seams.notify({
        title: text.title,
        body: text.body,
        tag: ATTENTION_TAG,
        onClick: () => {
          seams.open(first.row);
        },
      });
    }
  }

  function arm(): void {
    if (tickTimer !== null) seams.clearTimer(tickTimer);
    tickTimer = null;
    let next = Infinity;
    for (const event of pending.values()) next = Math.min(next, event.due);
    for (const at of settleAt.values()) next = Math.min(next, at);
    if (next === Infinity) return;
    tickTimer = seams.setTimer(tick, Math.max(0, next - seams.now()));
  }

  /** Everything whose time has come: settles rows, re-checks the pending events and delivers the due ones as one. */
  function flush(): void {
    const now = seams.now();
    for (const [key, at] of settleAt) if (at <= now) settleAt.delete(key);
    const due: { kind: AttentionEventKind; row: AttentionRow }[] = [];
    for (const [key, event] of pending) {
      if (event.due > now) continue;
      pending.delete(key);
      const row = known.get(key);
      if (row === undefined || !samePosture(row.cls, event.cls)) continue;
      rememberFired(`${key}|${event.kind}|${String(event.since)}`);
      if (key === viewedKey && pageActive()) continue;
      due.push({ kind: event.kind, row });
    }
    if (due.length > 0) deliver(due);
  }

  function tick(): void {
    tickTimer = null;
    flush();
    markViewed();
    publish();
    arm();
  }

  function viewing(key: string | null): void {
    if (dwellTimer !== null) seams.clearTimer(dwellTimer);
    dwellTimer = null;
    viewedKey = key;
    viewedAt = key === null ? null : seams.now();
    if (key === null) return;
    dwellTimer = seams.setTimer(() => {
      dwellTimer = null;
      markViewed();
      publish();
    }, SEEN_DWELL_MS);
  }

  function baseline(next: readonly AttentionRow[]): void {
    for (const row of next) {
      known.set(row.key, row);
      // Opening the page never produces a burst: what already failed or finished is old news.
      if (isSeeable(row.cls)) quiet.set(row.key, row.since);
    }
    baselineDone = true;
  }

  function step(next: readonly AttentionRow[]): void {
    const now = seams.now();
    const delayMs = Math.max(0, seams.config().delayMs);
    const present = new Set<string>();
    for (const row of next) {
      present.add(row.key);
      const prev = known.get(row.key) ?? null;
      known.set(row.key, row);
      let event = attentionEventOf(prev?.cls ?? null, row.cls, { baseline: false });
      const fresh = prev === null || prev.cls.posture === 'unknown';
      if (fresh && isSeeable(row.cls) && row.since !== null && Date.parse(row.since) < startedAt) {
        // A row that enters the list (or leaves `unknown`) failed or finished before this page was opened: old news.
        quiet.set(row.key, row.since);
        event = null;
      }
      if (prev?.cls.posture !== row.cls.posture) {
        if (delayMs > 0) settleAt.set(row.key, now + delayMs);
        else settleAt.delete(row.key);
      }
      const waiting = pending.get(row.key);
      // Only the posture is compared: a terminal row that gets its monitor row inside the delay changes its family
      // (`link` to `S-6`) and still needs the person.
      if (waiting !== undefined && !samePosture(waiting.cls, row.cls)) pending.delete(row.key);
      if (event === null || fired.has(`${row.key}|${event}|${String(row.since)}`)) continue;
      pending.set(row.key, { kind: event, cls: row.cls, since: row.since, due: now + delayMs });
    }
    // A row that is gone (a closed terminal, a session out of the list) takes its pending event with it.
    for (const key of [...known.keys()]) {
      if (present.has(key)) continue;
      known.delete(key);
      pending.delete(key);
      settleAt.delete(key);
      quiet.delete(key);
    }
  }

  return {
    ingest(next, context) {
      rows = next;
      if (context.epoch !== epoch) {
        epoch = context.epoch;
        baselineDone = false;
        for (const map of [known, settleAt, pending, quiet]) map.clear();
      }
      if (baselineDone) step(next);
      else baseline(next);
      if (context.selectedKey !== viewedKey) viewing(context.selectedKey);
      flush();
      markViewed();
      publish();
      arm();
    },
    viewing,
    markSeen(keys) {
      for (const key of keys) {
        const row = known.get(key);
        if (row !== undefined) see(row);
      }
      publish();
    },
    getSnapshot: () => snapshot,
    summary: () => snapshot.summary,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (tickTimer !== null) seams.clearTimer(tickTimer);
      if (dwellTimer !== null) seams.clearTimer(dwellTimer);
      tickTimer = null;
      dwellTimer = null;
    },
  };
}
