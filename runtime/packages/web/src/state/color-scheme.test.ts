import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ColorResolver, TerminalTheme } from '../lib/term-theme.ts';
import { ratio, readTokenSheet, resolve, type Theme, type Tokens } from '../test/css-tokens.ts';
import { resolveScheme, useColorScheme, useTerminalTheme } from './color-scheme.ts';

// The scheme hook (ADR 0100, design 05 section 3.4): CSS follows `color-scheme` by itself, so only JavaScript consumers (the
// terminal) need to know which scheme is in force. It is a pure table (`resolveScheme`) plus a subscription to the two things that
// change it: the `data-theme` attribute of the root element (the choice in the user menu) and the operating-system preference.

const DARK_QUERY = '(prefers-color-scheme: dark)';
const sheet = readTokenSheet();
const themes: Record<Theme, Tokens> = { light: sheet.light, dark: sheet.dark };

type Listener = (event: { matches: boolean }) => void;

/** A controllable `matchMedia` for the dark-scheme query that counts the listeners it holds. */
function installMatchMedia(systemDark: boolean) {
  const state = { dark: systemDark };
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return query === DARK_QUERY && state.dark;
      },
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'change' && query === DARK_QUERY) listeners.add(listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (type === 'change' && query === DARK_QUERY) listeners.delete(listener);
      },
    })),
  );
  return {
    listeners: () => listeners.size,
    set: (dark: boolean) => {
      state.dark = dark;
      for (const listener of [...listeners]) listener({ matches: dark });
    },
  };
}

/** A `MutationObserver` that does nothing until the test says the attribute changed. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: { target: Node; options: MutationObserverInit | undefined }[] = [];
  disconnected = false;
  private readonly callback: MutationCallback;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }
  observe(target: Node, options?: MutationObserverInit): void {
    this.observed.push({ target, options });
  }
  disconnect(): void {
    this.disconnected = true;
  }
  takeRecords(): MutationRecord[] {
    return [];
  }
  fire(): void {
    this.callback([], this);
  }
}

function setThemeAttribute(value: string | null): void {
  if (value === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', value);
  act(() => {
    for (const observer of FakeObserver.instances) if (!observer.disconnected) observer.fire();
  });
}

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal('MutationObserver', FakeObserver);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('resolveScheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['auto', false, 'light'],
    ['auto', true, 'dark'],
    [null, false, 'light'],
    [null, true, 'dark'],
    [undefined, true, 'dark'],
    ['', true, 'dark'],
    ['neon', false, 'light'],
    ['neon', true, 'dark'],
    ['DARK', false, 'light'],
  ] as const)('theme %j with the system dark %s is %s', (theme, systemDark, expected) => {
    expect(resolveScheme(theme, systemDark)).toBe(expected);
  });
});

describe('useColorScheme', () => {
  it('reads the attribute and the system preference', () => {
    installMatchMedia(true);
    document.documentElement.setAttribute('data-theme', 'auto');
    expect(renderHook(() => useColorScheme()).result.current).toBe('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    expect(renderHook(() => useColorScheme()).result.current).toBe('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    installMatchMedia(false);
    expect(renderHook(() => useColorScheme()).result.current).toBe('dark');
  });

  it('is light when the page names no theme and the system is light, dark when the system is dark', () => {
    installMatchMedia(false);
    expect(renderHook(() => useColorScheme()).result.current).toBe('light');
    installMatchMedia(true);
    expect(renderHook(() => useColorScheme()).result.current).toBe('dark');
  });

  it('follows a change of the data-theme attribute', () => {
    installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => useColorScheme());
    expect(result.current).toBe('light');
    setThemeAttribute('dark');
    expect(result.current).toBe('dark');
    setThemeAttribute('light');
    expect(result.current).toBe('light');
    setThemeAttribute('auto');
    expect(result.current).toBe('light');
  });

  it('follows the operating system while the theme is auto, and ignores it under an explicit theme', () => {
    const media = installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'auto');
    const { result } = renderHook(() => useColorScheme());
    expect(result.current).toBe('light');
    act(() => {
      media.set(true);
    });
    expect(result.current).toBe('dark');
    setThemeAttribute('light');
    expect(result.current).toBe('light');
    act(() => {
      media.set(false);
    });
    act(() => {
      media.set(true);
    });
    expect(result.current).toBe('light');
  });

  it('observes only the data-theme attribute of the root element', () => {
    installMatchMedia(false);
    renderHook(() => useColorScheme());
    const observed = FakeObserver.instances.flatMap((o) => o.observed);
    expect(observed.length).toBeGreaterThan(0);
    for (const { target, options } of observed) {
      expect(target).toBe(document.documentElement);
      expect(options).toMatchObject({ attributes: true, attributeFilter: ['data-theme'] });
    }
  });

  it('stops observing and listening on unmount', () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useColorScheme());
    expect(media.listeners()).toBe(1);
    unmount();
    expect(media.listeners()).toBe(0);
    expect(FakeObserver.instances.length).toBeGreaterThan(0);
    expect(FakeObserver.instances.every((o) => o.disconnected)).toBe(true);
  });

  it('is light without matchMedia and without a MutationObserver (no crash on a bare environment)', () => {
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('MutationObserver', undefined);
    const { result, unmount } = renderHook(() => useColorScheme());
    expect(result.current).toBe('light');
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});

describe('useTerminalTheme', () => {
  /** A resolver that answers from the tokens of the scheme the page is in right now, as the probe does in a browser. */
  function resolverForPage(calls: { count: number }): ColorResolver {
    return (token) => {
      calls.count += 1;
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return resolve(themes[dark ? 'dark' : 'light'], token);
    };
  }

  it('returns the theme of the scheme in force', () => {
    installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'dark');
    const calls = { count: 0 };
    const resolver = resolverForPage(calls);
    const { result } = renderHook(() => useTerminalTheme(resolver));
    expect(result.current.background).toBe('#141414');
    expect(result.current.foreground).toBe('#d4d4d4');
  });

  it('builds a new theme when the scheme changes, from the tokens of the new scheme', () => {
    installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'light');
    const calls = { count: 0 };
    const resolver = resolverForPage(calls);
    const { result } = renderHook(() => useTerminalTheme(resolver));
    const light: TerminalTheme = result.current;
    expect(light.background).toBe('#f5f2ea');
    setThemeAttribute('dark');
    const dark = result.current;
    expect(dark).not.toBe(light);
    expect(dark.background).toBe('#141414');
    expect(ratio(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5);
    setThemeAttribute('light');
    expect(result.current.background).toBe('#f5f2ea');
  });

  it('builds a new theme when the system changes under auto', () => {
    const media = installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'auto');
    // under auto the page is dark exactly when the system is, so this resolver reads the system preference
    const resolver: ColorResolver = (token) =>
      resolve(themes[matchMedia(DARK_QUERY).matches ? 'dark' : 'light'], token);
    const { result } = renderHook(() => useTerminalTheme(resolver));
    expect(result.current.background).toBe('#f5f2ea');
    act(() => {
      media.set(true);
    });
    expect(result.current.background).toBe('#141414');
  });

  it('keeps the same theme object while the scheme does not change (no rebuild per render)', () => {
    installMatchMedia(false);
    document.documentElement.setAttribute('data-theme', 'dark');
    const calls = { count: 0 };
    const resolver = resolverForPage(calls);
    const { result, rerender } = renderHook(() => useTerminalTheme(resolver));
    const first = result.current;
    const afterFirst = calls.count;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(calls.count).toBe(afterFirst);
    setThemeAttribute('dark');
    expect(result.current).toBe(first);
  });

  it('reads the page through a probe that states the scheme in force when no resolver is given', () => {
    installMatchMedia(false);
    const schemes: string[] = [];
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
      schemes.push(element.style.colorScheme);
      return { color: 'rgb(1, 2, 3)', getPropertyValue: () => '' };
    });
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => useTerminalTheme());
    expect(result.current.background).toBe('#010203');
    expect(result.current.brightWhite).toBe('#010203');
    expect(new Set(schemes)).toEqual(new Set(['light']));
    schemes.length = 0;
    setThemeAttribute('dark');
    expect(new Set(schemes)).toEqual(new Set(['dark']));
  });
});
