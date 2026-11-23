// @vitest-environment node
import type { AttentionClass } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { AttentionRow } from '../lib/attention-rows.ts';
import type { SeenMap } from '../lib/attention-seen.ts';
import {
  ATTENTION_TAG,
  createNotifier,
  FIRED_MAX,
  type AttentionTextEvent,
  type NotifierConfig,
  type OsNotification,
} from './attention-notifier.ts';

const START = Date.UTC(2026, 0, 1);
/** A time `second` seconds after the page was opened (negative: before). */
const at = (second: number): string => new Date(START + second * 1000).toISOString();

const CLS = {
  needs: { posture: 'needs_you', reason: 'permission', family: 'S-6' },
  working: { posture: 'working', reason: null, family: 'S-7' },
  done: { posture: 'ready', reason: 'turn_done', family: 'S-8' },
  failed: { posture: 'failed', reason: 'session_failed', family: 'S-3' },
  unknown: { posture: 'unknown', reason: null, family: 'S-5' },
} as const satisfies Record<string, AttentionClass>;

function row(n: number, cls: AttentionClass, since: string | null = at(1)): AttentionRow {
  const id = `id-${String(n)}`;
  return {
    key: `s:${id}`,
    sessionId: id,
    terminal: `term-${String(n)}`,
    folderKey: 'f',
    cls,
    since,
    label: null,
    labelSource: null,
  };
}

function harness(initial: Partial<NotifierConfig> = {}) {
  let now = START;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const config: NotifierConfig = { delayMs: 5000, notify: true, ...initial };
  const page = { visible: true, focused: true };
  const out = {
    announced: [] as string[],
    notified: [] as OsNotification[],
    texts: [] as AttentionTextEvent[],
    opened: [] as string[],
    seen: {} as SeenMap,
    writes: 0,
  };
  const notifier = createNotifier({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(nextId, { at: now + ms, fn });
      nextId += 1;
      return nextId - 1;
    },
    clearTimer: (handle) => {
      timers.delete(Number(handle));
    },
    page: () => ({ ...page }),
    announce: (text) => out.announced.push(text),
    notify: (n) => out.notified.push(n),
    seen: {
      read: () => out.seen,
      write: (next) => {
        out.seen = next;
        out.writes += 1;
      },
    },
    text: (event) => {
      out.texts.push(event);
      const text = `${event.kind}:${String(event.count)}:${event.name ?? '-'}`;
      return { announce: text, title: 'FIXTURE app', body: `body ${text}` };
    },
    config: () => config,
    open: (target) => out.opened.push(target.key),
  });
  /** Runs every timer that is due inside the next `ms`, in time order. */
  function advance(ms: number): void {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  }
  const ingest = (rows: AttentionRow[], selectedKey: string | null = null): void => {
    notifier.ingest(rows, { selectedKey });
  };
  return { notifier, out, page, config, timers, advance, ingest };
}

describe('the attention notifier', () => {
  it('the first snapshot is silent and settled: no announcement, and old failures and finished turns count as seen', () => {
    const h = harness();
    h.ingest([row(1, CLS.needs), row(2, CLS.failed, at(-60)), row(3, CLS.done, at(-30))]);
    h.advance(60_000);
    expect(h.out.announced).toEqual([]);
    expect(h.out.notified).toEqual([]);
    expect(h.notifier.summary()).toEqual({ needsYou: 1, failed: 0, done: 0 });
    expect(h.notifier.getSnapshot().items.map((item) => item.level)).toEqual(['needs_you', 'idle', 'idle']);
  });

  it('a session that starts to need the person is announced once, after the delay, and then counts', () => {
    const h = harness();
    h.ingest([row(1, CLS.working)]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.advance(4999);
    expect(h.out.announced).toEqual([]);
    expect(h.notifier.summary().needsYou).toBe(0);
    h.advance(1);
    expect(h.out.announced).toEqual(['needs_you:1:term-1']);
    expect(h.out.texts[0]).toMatchObject({ kind: 'needs_you', count: 1, name: 'term-1', row: { key: 's:id-1' } });
    expect(h.notifier.summary().needsYou).toBe(1);
    // the person is on the page: the live region says it, the system does not
    expect(h.out.notified).toEqual([]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.advance(60_000);
    expect(h.out.announced).toHaveLength(1);
  });

  it('a permission answered inside the delay says nothing', () => {
    const h = harness();
    h.ingest([row(1, CLS.working)]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.advance(2000);
    h.ingest([row(1, CLS.working, at(4))]);
    h.advance(60_000);
    expect(h.out.announced).toEqual([]);
    expect(h.notifier.summary()).toEqual({ needsYou: 0, failed: 0, done: 0 });
  });

  it.each([
    {
      title: 'selected, visible and focused: silent',
      selected: true,
      visible: true,
      focused: true,
      announced: 0,
      notified: 0,
    },
    {
      title: 'another row is selected: the page says it',
      selected: false,
      visible: true,
      focused: true,
      announced: 1,
      notified: 0,
    },
    {
      title: 'selected but the window lost the focus: both',
      selected: true,
      visible: true,
      focused: false,
      announced: 1,
      notified: 1,
    },
    { title: 'the tab is hidden: both', selected: false, visible: false, focused: false, announced: 1, notified: 1 },
    {
      title: 'away with the preference off: the page only',
      selected: false,
      visible: false,
      focused: false,
      notify: false,
      announced: 1,
      notified: 0,
    },
  ])('$title', ({ selected, visible, focused, notify, announced, notified }) => {
    const h = harness({ notify: notify ?? true });
    const selectedKey = selected ? 's:id-1' : null;
    h.ingest([row(1, CLS.working)], selectedKey);
    h.page.visible = visible;
    h.page.focused = focused;
    h.ingest([row(1, CLS.needs, at(2))], selectedKey);
    h.advance(5000);
    expect(h.out.announced).toHaveLength(announced);
    expect(h.out.notified).toHaveLength(notified);
  });

  it('everything due at the same moment is one announcement and one OS notification of the highest kind', () => {
    const h = harness();
    h.ingest([row(1, CLS.working), row(2, CLS.working), row(3, CLS.working), row(4, CLS.working)]);
    h.page.focused = false;
    h.ingest([row(1, CLS.done, at(2)), row(2, CLS.needs, at(2)), row(3, CLS.needs, at(2)), row(4, CLS.failed, at(2))]);
    h.advance(5000);
    expect(h.out.announced).toEqual(['needs_you:2:-']);
    expect(h.out.notified).toHaveLength(1);
    expect(h.out.notified[0]).toMatchObject({ title: 'FIXTURE app', body: 'body needs_you:2:-', tag: ATTENTION_TAG });
    h.out.notified[0]?.onClick();
    expect(h.out.opened).toEqual(['s:id-2']);
    expect(h.notifier.summary()).toEqual({ needsYou: 2, failed: 1, done: 1 });
  });

  it('a reconnect repeats nothing: the same state after an unknown one stays silent', () => {
    const h = harness();
    h.ingest([row(1, CLS.working)]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.advance(5000);
    h.ingest([row(1, CLS.unknown, at(2))]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.advance(60_000);
    expect(h.out.announced).toHaveLength(1);
    // a later ask of the same session is a new event
    h.ingest([row(1, CLS.working, at(70))]);
    h.ingest([row(1, CLS.needs, at(80))]);
    h.advance(5000);
    expect(h.out.announced).toHaveLength(2);
  });

  it('remembers at most 256 fired events', () => {
    const h = harness({ delayMs: 0 });
    h.ingest([]);
    const ask = (n: number): void => {
      h.ingest([row(n, CLS.unknown)]);
      h.ingest([row(n, CLS.needs, at(2))]);
    };
    for (let n = 0; n <= FIRED_MAX; n += 1) ask(n);
    expect(h.out.announced).toHaveLength(FIRED_MAX + 1);
    ask(FIRED_MAX);
    expect(h.out.announced).toHaveLength(FIRED_MAX + 1);
    ask(0);
    expect(h.out.announced).toHaveLength(FIRED_MAX + 2);
  });

  it('a row that is gone fires nothing and takes its pending event with it', () => {
    const h = harness();
    h.ingest([row(1, CLS.working), row(2, CLS.working)]);
    h.ingest([row(1, CLS.needs, at(2))]);
    h.ingest([]);
    h.advance(60_000);
    expect(h.out.announced).toEqual([]);
    expect(h.timers.size).toBe(0);
  });

  it('a row that enters the list already failed is news only when it failed after the page was opened', () => {
    const h = harness({ delayMs: 0 });
    h.ingest([]);
    h.ingest([row(1, CLS.failed, at(-600)), row(2, CLS.failed, at(3))]);
    expect(h.out.announced).toEqual(['failed:1:term-2']);
    expect(h.notifier.summary().failed).toBe(1);
  });

  it('finished turns count until they are marked as seen, and the mark is an id and a time', () => {
    const h = harness({ delayMs: 0 });
    h.ingest([row(1, CLS.working), row(2, CLS.working, null)]);
    h.ingest([row(1, CLS.done, at(2)), row(2, CLS.done, null)]);
    expect(h.notifier.summary().done).toBe(2);
    let changes = 0;
    h.notifier.subscribe(() => {
      changes += 1;
    });
    h.notifier.markSeen(['s:id-1', 's:id-2', 's:missing']);
    expect(h.notifier.summary().done).toBe(0);
    expect(h.out.seen).toEqual({ 'id-1': at(2) });
    expect(changes).toBe(1);
    const snapshot = h.notifier.getSnapshot();
    h.notifier.markSeen(['s:id-1']);
    expect(h.notifier.getSnapshot()).toBe(snapshot);
  });

  it('looking at a row for one second on an active page marks it as seen; an inactive page does not', () => {
    const h = harness({ delayMs: 0 });
    h.ingest([row(1, CLS.working)]);
    h.page.focused = false;
    h.ingest([row(1, CLS.done, at(2))], 's:id-1');
    h.advance(5000);
    expect(h.out.seen).toEqual({});
    expect(h.notifier.summary().done).toBe(1);
    h.page.focused = true;
    h.notifier.viewing('s:id-1');
    h.advance(999);
    expect(h.out.seen).toEqual({});
    h.advance(1);
    expect(h.out.seen).toEqual({ 'id-1': at(2) });
    expect(h.notifier.summary().done).toBe(0);
    // the row finishes again while the person watches: silent and seen at once
    h.ingest([row(1, CLS.working, at(8))], 's:id-1');
    h.ingest([row(1, CLS.done, at(9))], 's:id-1');
    expect(h.out.announced).toHaveLength(1);
    expect(h.out.seen).toEqual({ 'id-1': at(9) });
  });

  it('dispose clears the timers and a later ingest arms them again', () => {
    const h = harness();
    h.ingest([row(1, CLS.working)]);
    h.ingest([row(1, CLS.needs, at(2))], 's:id-9');
    expect(h.timers.size).toBeGreaterThan(0);
    h.notifier.dispose();
    expect(h.timers.size).toBe(0);
    h.ingest([row(1, CLS.needs, at(2))], 's:id-9');
    h.advance(5000);
    expect(h.out.announced).toHaveLength(1);
  });
});
