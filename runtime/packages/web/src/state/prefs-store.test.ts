import { act, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPrefs, LEGACY_PREFS_KEY, PREFS_KEY, type StorageLike } from '../lib/prefs.ts';
import {
  applyDisplayPrefs,
  createPrefsStore,
  PrefsStoreContext,
  resolveDisplay,
  usePrefs,
  type PrefsStore,
} from './prefs-store.ts';

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.items.set(key, value);
  }
}

function storeOf(storage: StorageLike | null): PrefsStore {
  return createPrefsStore(createPrefs(storage));
}

describe('prefs store (04-ui.md section 9, ADR 0036)', () => {
  it('starts with no stored values and hands out a stable snapshot between changes', () => {
    const store = storeOf(new MemoryStorage());
    expect(store.getSnapshot()).toEqual({});
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('stores a change under the v3 key, notifies subscribers and replaces the snapshot', () => {
    const storage = new MemoryStorage();
    const store = storeOf(storage);
    const before = store.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.setPref('theme', 'dark')).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().theme).toBe('dark');
    expect(JSON.parse(storage.items.get(PREFS_KEY) ?? '{}')).toMatchObject({ theme: 'dark' });

    unsubscribe();
    store.setPref('density', 'compact');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid value without notifying', () => {
    const store = storeOf(new MemoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    // @ts-expect-error run-time check of a value the types forbid
    expect(store.setPref('theme', 'purple')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({});
  });

  it('imports the shared fields of the legacy key once and drops what v3 does not keep', () => {
    const storage = new MemoryStorage();
    storage.items.set(
      LEGACY_PREFS_KEY,
      JSON.stringify({
        theme: 'dark',
        density: 'compact',
        filter: 'abc',
        sel: 'x|y',
        unknown: 1,
        kinds: { tool: false },
      }),
    );
    const store = storeOf(storage);
    expect(store.getSnapshot()).toEqual({ theme: 'dark', density: 'compact', filter: 'abc', kinds: { tool: false } });
    expect(JSON.parse(storage.items.get(PREFS_KEY) ?? '{}')).toEqual(store.getSnapshot());
  });

  it('never writes the legacy key, not even after later changes', () => {
    const storage = new MemoryStorage();
    storage.items.set(LEGACY_PREFS_KEY, JSON.stringify({ theme: 'light' }));
    const legacyBefore = storage.items.get(LEGACY_PREFS_KEY);
    const store = storeOf(storage);
    store.setPref('theme', 'dark');
    store.setPref('navOpen', true);
    expect(storage.writes.length).toBeGreaterThan(0);
    expect(storage.writes.every((key) => key === PREFS_KEY)).toBe(true);
    expect(storage.items.get(LEGACY_PREFS_KEY)).toBe(legacyBefore);
  });

  it('does not import again once v3 exists', () => {
    const storage = new MemoryStorage();
    storage.items.set(PREFS_KEY, JSON.stringify({ density: 'compact' }));
    storage.items.set(LEGACY_PREFS_KEY, JSON.stringify({ theme: 'dark' }));
    expect(storeOf(storage).getSnapshot()).toEqual({ density: 'compact' });
  });

  it('keeps working in memory when storage is missing, throws or holds corrupt JSON', () => {
    const missing = storeOf(null);
    expect(missing.setPref('theme', 'light')).toBe(false);
    expect(missing.getSnapshot().theme).toBe('light');
    expect(missing.persistent).toBe(false);

    const throwing = storeOf({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(throwing.getSnapshot()).toEqual({});
    throwing.setPref('density', 'compact');
    expect(throwing.getSnapshot().density).toBe('compact');

    const corrupt = new MemoryStorage();
    corrupt.items.set(PREFS_KEY, '{not json');
    expect(storeOf(corrupt).getSnapshot()).toEqual({});
  });
});

describe('resetPrefs', () => {
  it('replaces the snapshot, notifies once and writes only the v3 key; the kept preference stays', () => {
    const storage = new MemoryStorage();
    const store = storeOf(storage);
    store.setPref('theme', 'dark');
    store.setPref('lastInstanceId', 'iid-1');
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.resetPrefs(['lastInstanceId'])).toBe(true);
    expect(store.getSnapshot()).toEqual({ lastInstanceId: 'iid-1' });
    expect(store.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new Set(storage.writes)).toEqual(new Set([PREFS_KEY]));
  });

  it('does not notify when there was nothing to clear', () => {
    const store = storeOf(new MemoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    store.resetPrefs();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('usePrefs', () => {
  function wrapperFor(store: PrefsStore) {
    return ({ children }: { children: ReactNode }) => createElement(PrefsStoreContext, { value: store }, children);
  }

  it('re-renders when a preference changes', () => {
    const store = storeOf(new MemoryStorage());
    const { result } = renderHook(() => usePrefs(), { wrapper: wrapperFor(store) });
    expect(result.current.prefs.theme).toBeUndefined();
    act(() => {
      result.current.setPref('theme', 'dark');
    });
    expect(result.current.prefs.theme).toBe('dark');
  });

  it('shares one store between components of the same tree', () => {
    const store = storeOf(new MemoryStorage());
    function Reader() {
      return createElement('output', null, usePrefs().prefs.filter ?? 'none');
    }
    const { container } = render(createElement(PrefsStoreContext, { value: store }, createElement(Reader)));
    expect(container.textContent).toBe('none');
    act(() => {
      store.setPref('filter', 'build');
    });
    expect(container.textContent).toBe('build');
  });
});

describe('display preferences on the document element', () => {
  it('precedence: prefs value, then the instance default, then the built-in', () => {
    expect(resolveDisplay({ theme: 'dark' }, { theme: 'light', density: 'compact' })).toEqual({
      theme: 'dark',
      density: 'compact',
    });
    expect(resolveDisplay({}, { theme: 'light', density: 'compact' })).toEqual({ theme: 'light', density: 'compact' });
    expect(resolveDisplay({}, undefined)).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  it('sets data-theme and data-density', () => {
    const root = document.createElement('html');
    applyDisplayPrefs(root, { theme: 'dark', density: 'compact' });
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-density')).toBe('compact');
  });
});
