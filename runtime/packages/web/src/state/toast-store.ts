// Short messages ("Link copied") shown for a few seconds. The store keeps the list; `useShowToast` also announces the message
// through the live region (04 section 6.6 rule 6), so a toast is never visual only.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import { useAnnounce } from './announcer.tsx';

export type ToastKind = 'info' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ShowToastOptions {
  kind?: ToastKind;
  /** Milliseconds on screen; default 6000. */
  ttlMs?: number;
}

export interface ToastStore {
  readonly getSnapshot: () => readonly ToastItem[];
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the id to pass to `dismiss`. */
  readonly show: (message: string, options?: ShowToastOptions) => number;
  readonly dismiss: (id: number) => void;
}

export const DEFAULT_TOAST_TTL_MS = 6000;

export function createToastStore(): ToastStore {
  let items: readonly ToastItem[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function publish(next: readonly ToastItem[]): void {
    items = next;
    for (const listener of [...listeners]) listener();
  }

  function dismiss(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    if (items.some((item) => item.id === id)) publish(items.filter((item) => item.id !== id));
  }

  return {
    getSnapshot: () => items,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (message, options = {}) => {
      const id = nextId;
      nextId += 1;
      publish([...items, { id, message, kind: options.kind ?? 'info' }]);
      timers.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, options.ttlMs ?? DEFAULT_TOAST_TTL_MS),
      );
      return id;
    },
    dismiss,
  };
}

let sharedStore: ToastStore | null = null;

function sharedToastStore(): ToastStore {
  sharedStore ??= createToastStore();
  return sharedStore;
}

/** Tests and embedders replace the store of the subtree; the default is the store of the page. */
export const ToastStoreContext = createContext<ToastStore | null>(null);

function useToastStore(): ToastStore {
  return useContext(ToastStoreContext) ?? sharedToastStore();
}

export function useToasts(): { toasts: readonly ToastItem[]; dismiss: (id: number) => void } {
  const store = useToastStore();
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { toasts, dismiss: store.dismiss };
}

/** Shows a toast and announces its text. */
export function useShowToast(): (message: string, options?: ShowToastOptions) => void {
  const store = useToastStore();
  const announce = useAnnounce();
  return useCallback(
    (message, options) => {
      store.show(message, options);
      announce(message);
    },
    [store, announce],
  );
}
