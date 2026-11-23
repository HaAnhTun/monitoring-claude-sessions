import type { AttentionClass } from '@mcs/shared';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AttentionRow, AttentionScope } from '../lib/attention-rows.ts';
import { createFakeApi } from '../test/fake-api.ts';
import { makeInstance, makeSession, makeSessionPage, makeState, sessionId } from '../test/fixtures/index.ts';
import { renderHookWithProviders } from '../test/render.tsx';
import { AttentionChromeStoreContext, createAttentionChromeStore, NO_ATTENTION_CHROME } from './attention-chrome.ts';
import type { AttentionTextEvent, OsNotification } from './attention-notifier.ts';
import { useAttentionCore, useTaskAttention, type AttentionSeams } from './useAttention.ts';

const START = Date.UTC(2026, 0, 1);
const at = (second: number): string => new Date(START + second * 1000).toISOString();

const NEEDS: AttentionClass = { posture: 'needs_you', reason: 'permission', family: 'S-6' };
const WORKING: AttentionClass = { posture: 'working', reason: null, family: 'S-7' };
const DONE: AttentionClass = { posture: 'ready', reason: 'turn_done', family: 'S-8' };
const FAILED: AttentionClass = { posture: 'failed', reason: 'session_failed', family: 'S-3' };

function row(n: number, cls: AttentionClass, since = at(1)): AttentionRow {
  return {
    key: `s:id-${String(n)}`,
    sessionId: `id-${String(n)}`,
    terminal: null,
    folderKey: null,
    cls,
    since,
    label: null,
    labelSource: null,
  };
}

function fakeSeams() {
  let now = START;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const notified: OsNotification[] = [];
  const active = new Set<() => void>();
  const seams: AttentionSeams = {
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(nextId, { at: now + ms, fn });
      nextId += 1;
      return nextId - 1;
    },
    clearTimer: (handle) => {
      timers.delete(Number(handle));
    },
    page: () => ({ visible: true, focused: true }),
    notify: (n) => notified.push(n),
    onPageActive: (listener) => {
      active.add(listener);
      return () => {
        active.delete(listener);
      };
    },
  };
  function advance(ms: number): void {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  }
  return { seams, timers, notified, active, advance };
}

interface Props {
  rows: AttentionRow[];
  ready: boolean;
  scope: AttentionScope;
  selectedKey: string | null;
}

function renderCore(initial: Props) {
  const fake = fakeSeams();
  const chrome = createAttentionChromeStore();
  const texts: AttentionTextEvent[] = [];
  const text = (event: AttentionTextEvent) => {
    texts.push(event);
    return { announce: 'FIXTURE announcement', title: 'FIXTURE app', body: 'FIXTURE body' };
  };
  const open = (): void => undefined;
  const hook = renderHookWithProviders(
    (props: Props) => useAttentionCore({ ...props, text, open, seams: fake.seams }),
    {
      initialProps: initial,
      wrap: (children) => <AttentionChromeStoreContext value={chrome}>{children}</AttentionChromeStoreContext>,
    },
  );
  return { ...hook, ...fake, chrome, texts };
}

describe('useAttentionCore', () => {
  it('waits for the lists, takes the first snapshot in silence, then announces a change after the delay', () => {
    const h = renderCore({ rows: [row(1, NEEDS)], ready: false, scope: 'here', selectedKey: null });
    expect(h.result.current.items).toEqual([]);
    h.rerender({ rows: [row(1, NEEDS), row(2, WORKING)], ready: true, scope: 'here', selectedKey: null });
    expect(h.result.current.summary).toEqual({ needsYou: 1, failed: 0, done: 0 });
    expect(h.chrome.getSnapshot()).toEqual({ title: { kind: 'needs_you', count: 1 }, icon: true });
    h.rerender({ rows: [row(1, NEEDS), row(2, NEEDS, at(2))], ready: true, scope: 'here', selectedKey: null });
    expect(h.texts).toEqual([]);
    expect(h.result.current.items.map((item) => item.level)).toEqual(['needs_you', 'needs_you']);
    expect(h.result.current.summary.needsYou).toBe(1);
    act(() => {
      h.advance(5000);
    });
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatchObject({ kind: 'needs_you', count: 1 });
    expect(h.chrome.getSnapshot().title).toEqual({ kind: 'needs_you', count: 2 });
    expect(h.notified).toEqual([]);
  });

  it('reads the preferences at every use and writes the seen marks as ids and times', () => {
    const h = renderCore({ rows: [row(1, WORKING)], ready: true, scope: 'here', selectedKey: null });
    act(() => {
      h.prefsStore.setPref('attentionDelaySeconds', 0);
      h.prefsStore.setPref('attentionTitle', false);
    });
    h.rerender({ rows: [row(1, DONE, at(2))], ready: true, scope: 'here', selectedKey: null });
    expect(h.texts).toHaveLength(1);
    expect(h.result.current.summary.done).toBe(1);
    expect(h.chrome.getSnapshot()).toEqual({ title: null, icon: false });
    act(() => {
      h.result.current.markSeen(['s:id-1']);
    });
    expect(h.prefsStore.getSnapshot().attentionSeen).toEqual({ 'id-1': at(2) });
    expect(h.result.current.summary.done).toBe(0);
    expect(h.result.current.items[0]).toMatchObject({ level: 'idle', unseen: false });
  });

  it('a change of scope is a new silent baseline, and unmounting clears the chrome, the timers and the listeners', () => {
    const h = renderCore({ rows: [row(1, WORKING)], ready: true, scope: 'here', selectedKey: 's:id-1' });
    h.rerender({
      rows: [row(1, WORKING), row(2, FAILED, at(3)), row(3, NEEDS)],
      ready: true,
      scope: 'all',
      selectedKey: 's:id-1',
    });
    act(() => {
      h.advance(60_000);
    });
    expect(h.texts).toEqual([]);
    expect(h.result.current.scope).toBe('all');
    expect(h.result.current.summary).toEqual({ needsYou: 1, failed: 0, done: 0 });
    expect(h.active.size).toBe(1);
    h.unmount();
    expect(h.chrome.getSnapshot()).toBe(NO_ATTENTION_CHROME);
    expect(h.timers.size).toBe(0);
    expect(h.active.size).toBe(0);
  });
});

describe('useTaskAttention', () => {
  it('reads the sidebar list with scope all and no terminal request', async () => {
    const waiting = makeSession({
      id: sessionId(1),
      state: makeState('waiting_input', { rule: 'S-6a', waitReason: 'permission' }),
    });
    const api = createFakeApi({
      instance: () => makeInstance(),
      listSessions: () => makeSessionPage([waiting, makeSession({ id: sessionId(2) })]),
    });
    const fake = fakeSeams();
    const { result } = renderHookWithProviders(
      () =>
        useTaskAttention({
          selected: { terminal: null, sessionId: null },
          text: () => ({ announce: '', title: '', body: '' }),
          open: () => undefined,
          seams: fake.seams,
        }),
      { api },
    );
    await waitFor(() => {
      expect(result.current.summary.needsYou).toBe(1);
    });
    expect(result.current.scope).toBe('all');
    expect(result.current.items.map((item) => [item.key, item.terminal])).toEqual([
      [`s:${sessionId(1)}`, null],
      [`s:${sessionId(2)}`, null],
    ]);
    expect(api.calls.map((call) => call.url).join('\n')).not.toContain('terminal');
    expect(api.violations).toEqual([]);
  });
});
