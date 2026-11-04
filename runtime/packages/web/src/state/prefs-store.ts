// The preferences store of the UI (04 section 9, ADR 0036): `lib/prefs.ts` does the validation and the storage access, this file
// exposes it to React through `useSyncExternalStore`. Nothing here touches web storage itself.
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

import { createPrefs, safeLocalStorage, type PrefName, type Prefs, type PrefsData } from '../lib/prefs.ts';

/** What is stored; a field is absent until it was set (or imported), so the callers apply their own defaults. */
export type PrefsSnapshot = Readonly<Partial<PrefsData>>;

export interface PrefsStore {
  /** The same object until a preference changes (the contract of `useSyncExternalStore`). */
  readonly getSnapshot: () => PrefsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** False when the value was rejected or could not be persisted (it is still kept in memory when valid). */
  readonly setPref: <K extends PrefName>(name: K, value: PrefsData[K]) => boolean;
  /** Forgets every stored preference except the named ones (the reset of the display preferences); false when it could not be persisted. */
  readonly resetPrefs: (keep?: readonly PrefName[]) => boolean;
  readonly persistent: boolean;
}

export function createPrefsStore(prefs: Prefs): PrefsStore {
  let snapshot: PrefsSnapshot = prefs.all();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPref: (name, value) => {
      const before = prefs.get(name);
      const persisted = prefs.set(name, value);
      // `set` keeps a valid value in memory even when storage refuses it; an invalid one changes nothing.
      const after = prefs.get(name);
      if (after !== before) {
        snapshot = prefs.all();
        for (const listener of [...listeners]) listener();
      }
      return persisted;
    },
    resetPrefs: (keep) => {
      const before = snapshot;
      const persisted = prefs.clear(keep);
      const after = prefs.all();
      if (Object.keys(before).length > 0 || Object.keys(after).length > 0) {
        snapshot = after;
        for (const listener of [...listeners]) listener();
      }
      return persisted;
    },
    get persistent() {
      return prefs.persistent;
    },
  };
}

let sharedStore: PrefsStore | null = null;

/** The store of the page: created on first use from the page's localStorage (or in memory when that is unavailable). */
function sharedPrefsStore(): PrefsStore {
  sharedStore ??= createPrefsStore(createPrefs(safeLocalStorage()));
  return sharedStore;
}

/** Tests and embedders replace the store of the subtree; the default is the store of the page. */
export const PrefsStoreContext = createContext<PrefsStore | null>(null);

export function usePrefsStore(): PrefsStore {
  return useContext(PrefsStoreContext) ?? sharedPrefsStore();
}

export interface UsePrefs {
  prefs: PrefsSnapshot;
  setPref: PrefsStore['setPref'];
}

/** The stored preferences and the setter; re-renders on every change. */
export function usePrefs(): UsePrefs {
  const store = usePrefsStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const setPref = useCallback<PrefsStore['setPref']>((name, value) => store.setPref(name, value), [store]);
  return useMemo(() => ({ prefs, setPref }), [prefs, setPref]);
}

export interface DisplayPrefs {
  theme: PrefsData['theme'];
  density: PrefsData['density'];
}

const BUILT_IN_DISPLAY: DisplayPrefs = { theme: 'auto', density: 'comfortable' };

/** Precedence for display defaults (04 section 9): the stored value, then `instance.ui`, then the built-in. */
export function resolveDisplay(prefs: PrefsSnapshot, instanceUi: Partial<DisplayPrefs> | undefined): DisplayPrefs {
  return {
    theme: prefs.theme ?? instanceUi?.theme ?? BUILT_IN_DISPLAY.theme,
    density: prefs.density ?? instanceUi?.density ?? BUILT_IN_DISPLAY.density,
  };
}

/** Mirrors the display preferences into the attributes the stylesheet reads (`public/theme-init.js` does it before paint). */
export function applyDisplayPrefs(root: Element, display: DisplayPrefs): void {
  root.setAttribute('data-theme', display.theme);
  root.setAttribute('data-density', display.density);
}
