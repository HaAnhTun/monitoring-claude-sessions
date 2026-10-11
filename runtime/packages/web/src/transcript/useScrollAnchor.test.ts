import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useScrollAnchor, type ScrollAnchorOptions } from './useScrollAnchor.ts';

interface FakeRow {
  key: string;
  height: number;
  hidden?: boolean;
}

/** A scroller whose rows have a computed geometry (happy-dom does no layout). */
function makeScroller(rows: FakeRow[]) {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const state = { rows, scrollTop: 0, clientHeight: 200 };
  const elements = new Map<string, HTMLElement>();
  const rectOf = (key: string): { top: number; bottom: number } => {
    let top = 0;
    for (const row of state.rows) {
      if (row.key === key) return { top: top - state.scrollTop, bottom: top + row.height - state.scrollTop };
      if (row.hidden !== true) top += row.height;
    }
    return { top: 0, bottom: 0 };
  };
  const total = (): number => state.rows.reduce((sum, row) => sum + (row.hidden === true ? 0 : row.height), 0);
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollHeight', { get: total, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { get: () => state.clientHeight, configurable: true });
  scroller.getBoundingClientRect = () => ({
    top: 0,
    bottom: state.clientHeight,
    left: 0,
    right: 100,
    width: 100,
    height: state.clientHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  function sync(): void {
    scroller.replaceChildren();
    for (const row of state.rows) {
      let el = elements.get(row.key);
      if (el === undefined) {
        el = document.createElement('div');
        el.dataset['rowKey'] = row.key;
        const key = row.key;
        el.getBoundingClientRect = () => {
          const { top, bottom } = rectOf(key);
          return {
            top,
            bottom,
            left: 0,
            right: 100,
            width: 100,
            height: bottom - top,
            x: 0,
            y: top,
            toJSON: () => ({}),
          };
        };
        elements.set(row.key, el);
      }
      el.hidden = row.hidden === true;
      scroller.append(el);
    }
  }
  sync();
  return { scroller, state, sync };
}

const OLDEST_FIRST: ScrollAnchorOptions = { follow: false, newestFirst: false };

afterEach(() => {
  document.body.replaceChildren();
});

describe('useScrollAnchor', () => {
  const rows = (...keys: string[]): FakeRow[] => keys.map((key) => ({ key, height: 50 }));

  it('keeps the first visible row where it was when rows are added above it', () => {
    const env = makeScroller(rows('e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'));
    env.state.scrollTop = 70; // e4 is the first row that reaches into the view: top -20
    const ref = { current: env.scroller };
    const { result, rerender } = renderHook((p: { key: string }) => useScrollAnchor(ref, p.key, OLDEST_FIRST), {
      initialProps: { key: 'a' },
    });
    result.current.captureAnchor();
    env.state.rows = [...rows('e1', 'e2'), ...env.state.rows];
    env.sync();
    rerender({ key: 'b' });
    expect(env.state.scrollTop).toBe(170);
  });

  it('keeps the anchor when rows above it are hidden by a filter', () => {
    const env = makeScroller(rows('a', 'b', 'c', 'd', 'e', 'f'));
    env.state.scrollTop = 120; // c: top -20
    const ref = { current: env.scroller };
    const { result, rerender } = renderHook((p: { key: string }) => useScrollAnchor(ref, p.key, OLDEST_FIRST), {
      initialProps: { key: '1' },
    });
    result.current.captureAnchor();
    env.state.rows = env.state.rows.map((row) => (row.key === 'a' || row.key === 'b' ? { ...row, hidden: true } : row));
    env.sync();
    rerender({ key: '2' });
    expect(env.state.scrollTop).toBe(20);
  });

  it('ignores hidden rows when choosing the anchor', () => {
    const env = makeScroller([{ key: 'h', height: 50, hidden: true }, ...rows('v1', 'v2', 'v3', 'v4')]);
    env.state.scrollTop = 0;
    const ref = { current: env.scroller };
    const { result, rerender } = renderHook((p: { key: string }) => useScrollAnchor(ref, p.key, OLDEST_FIRST), {
      initialProps: { key: '1' },
    });
    result.current.captureAnchor();
    env.state.rows = [{ key: 'new', height: 80 }, ...env.state.rows];
    env.sync();
    rerender({ key: '2' });
    expect(env.state.scrollTop).toBe(80);
  });

  it('snaps to the bottom when following in oldest-first order', () => {
    const env = makeScroller(rows('a', 'b', 'c', 'd', 'e', 'f'));
    const ref = { current: env.scroller };
    const options: ScrollAnchorOptions = { follow: true, newestFirst: false };
    const { rerender } = renderHook((p: { key: string }) => useScrollAnchor(ref, p.key, options), {
      initialProps: { key: '1' },
    });
    expect(env.state.scrollTop).toBe(300);
    env.state.rows = [...env.state.rows, ...rows('g')];
    env.sync();
    rerender({ key: '2' });
    expect(env.state.scrollTop).toBe(350);
  });

  it('snaps to the top when following in newest-first order', () => {
    const env = makeScroller(rows('a', 'b', 'c', 'd', 'e', 'f'));
    env.state.scrollTop = 90;
    const ref = { current: env.scroller };
    const options: ScrollAnchorOptions = { follow: true, newestFirst: true };
    renderHook(() => useScrollAnchor(ref, 'k', options));
    expect(env.state.scrollTop).toBe(0);
  });

  it('does not move the scroll position when the anchor row is gone', () => {
    const env = makeScroller(rows('a', 'b', 'c', 'd'));
    env.state.scrollTop = 60;
    const ref = { current: env.scroller };
    const { result, rerender } = renderHook((p: { key: string }) => useScrollAnchor(ref, p.key, OLDEST_FIRST), {
      initialProps: { key: '1' },
    });
    result.current.captureAnchor();
    env.state.rows = rows('x', 'y', 'z', 'w');
    env.sync();
    rerender({ key: '2' });
    expect(env.state.scrollTop).toBe(60);
  });

  it('does nothing without a scroller element', () => {
    const { result, rerender } = renderHook(
      (p: { key: string }) => useScrollAnchor({ current: null }, p.key, OLDEST_FIRST),
      {
        initialProps: { key: '1' },
      },
    );
    expect(() => {
      result.current.captureAnchor();
      result.current.restoreAnchor();
      rerender({ key: '2' });
    }).not.toThrow();
  });
});
