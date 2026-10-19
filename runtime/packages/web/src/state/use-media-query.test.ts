import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MQ_NARROW_TABLE, MQ_RAIL, MQ_SHEET, useMediaQuery } from './use-media-query.ts';

type Listener = (event: { matches: boolean }) => void;

/** A controllable stand-in for `window.matchMedia` that counts the listeners it holds. */
function installMatchMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Map<string, Set<Listener>>();
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    get matches() {
      return state[query] ?? false;
    },
    addEventListener: (type: string, listener: Listener) => {
      if (type !== 'change') return;
      const set = listeners.get(query) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (type === 'change') listeners.get(query)?.delete(listener);
    },
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    count: (query: string) => listeners.get(query)?.size ?? 0,
    set: (query: string, matches: boolean) => {
      state[query] = matches;
      for (const listener of listeners.get(query) ?? []) listener({ matches });
    },
  };
}

describe('query constants (ADR 0071 decision 6)', () => {
  it('uses the literal breakpoints of the stylesheets', () => {
    expect(MQ_RAIL).toBe('(max-width: 1199px)');
    expect(MQ_SHEET).toBe('(max-width: 899px)');
    expect(MQ_NARROW_TABLE).toBe('(max-width: 1279px)');
  });
});

describe('useMediaQuery', () => {
  it('reads the current match', () => {
    installMatchMedia({ [MQ_RAIL]: true });
    const { result } = renderHook(() => useMediaQuery(MQ_RAIL));
    expect(result.current).toBe(true);
  });

  it('follows a change of the media query', () => {
    const media = installMatchMedia({ [MQ_SHEET]: false });
    const { result } = renderHook(() => useMediaQuery(MQ_SHEET));
    expect(result.current).toBe(false);
    act(() => {
      media.set(MQ_SHEET, true);
    });
    expect(result.current).toBe(true);
    act(() => {
      media.set(MQ_SHEET, false);
    });
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const media = installMatchMedia({ [MQ_RAIL]: false });
    const { unmount } = renderHook(() => useMediaQuery(MQ_RAIL));
    expect(media.count(MQ_RAIL)).toBe(1);
    unmount();
    expect(media.count(MQ_RAIL)).toBe(0);
  });

  it('moves its listener when the query changes', () => {
    const media = installMatchMedia({ [MQ_RAIL]: false, [MQ_SHEET]: true });
    const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), { initialProps: { query: MQ_RAIL } });
    expect(result.current).toBe(false);
    rerender({ query: MQ_SHEET });
    expect(result.current).toBe(true);
    expect(media.count(MQ_RAIL)).toBe(0);
    expect(media.count(MQ_SHEET)).toBe(1);
  });

  it('is false when matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result, unmount } = renderHook(() => useMediaQuery(MQ_RAIL));
    expect(result.current).toBe(false);
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});
