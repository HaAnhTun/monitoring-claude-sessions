// Global single-key shortcuts (04 section 6.5): one `keydown` listener, a stack of registrations per key, and the state of the
// help dialog. The ignore rules are the pure `shouldHandleShortcut` of `lib/shortcuts.ts`.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { groupOfKey, shouldHandleShortcut, type KeyboardEventLike, type ShortcutGroup } from '../lib/shortcuts.ts';

export interface ShortcutOptions {
  /** A disabled registration is not in the stack. Default true. */
  enabled?: boolean;
  /** The row of the shortcuts dialog, in the language that is shown. */
  description: string;
  /** The group of the row in the dialog; a key the table of `lib/shortcuts.ts` knows has its own group, any other is navigation. */
  group?: ShortcutGroup;
}

export interface ActiveShortcut {
  key: string;
  description: string;
  group: ShortcutGroup;
}

interface Registration {
  key: string;
  description: string;
  group: ShortcutGroup;
  run: (event: KeyboardEvent) => void;
}

interface Registry {
  /** Puts a registration on top of the stack; returns the function that removes it. */
  readonly register: (entry: Registration) => () => void;
  /** The most recently registered handler of the key. */
  readonly winnerFor: (key: string) => Registration | undefined;
  readonly getSnapshot: () => readonly ActiveShortcut[];
  readonly subscribe: (listener: () => void) => () => void;
}

function createRegistry(): Registry {
  let stack: readonly Registration[] = [];
  let snapshot: readonly ActiveShortcut[] = [];
  const listeners = new Set<() => void>();

  function publish(next: readonly Registration[]): void {
    stack = next;
    // The winner of every key, in order of first registration.
    const winners = new Map<string, Registration>();
    for (const entry of stack) winners.set(entry.key, entry);
    snapshot = [...winners.values()].map(({ key, description, group }) => ({ key, description, group }));
    for (const listener of [...listeners]) listener();
  }

  return {
    register: (entry) => {
      publish([...stack, entry]);
      return () => {
        publish(stack.filter((candidate) => candidate !== entry));
      };
    },
    winnerFor: (key) => stack.findLast((entry) => entry.key === key),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function toEventLike(event: KeyboardEvent): KeyboardEventLike {
  const target = event.target instanceof Element ? event.target : null;
  return {
    key: event.key,
    defaultPrevented: event.defaultPrevented,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    target:
      target === null
        ? null
        : {
            tagName: target.tagName,
            type: target instanceof HTMLInputElement ? target.type : undefined,
            isContentEditable: target instanceof HTMLElement ? target.isContentEditable : undefined,
          },
  };
}

interface RegistryContextValue {
  registry: Registry;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

const RegistryContext = createContext<RegistryContextValue | null>(null);

function useRegistryContext(): RegistryContextValue {
  const value = useContext(RegistryContext);
  if (value === null) throw new Error('No shortcut registry: render inside <ShortcutRegistryProvider>');
  return value;
}

/** Owns the registry, the one global listener and the open state of the shortcuts dialog. */
export function ShortcutRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialogOpen = document.querySelector('dialog[open]') !== null;
      if (!shouldHandleShortcut(toEventLike(event), dialogOpen)) return;
      const winner = registry.winnerFor(event.key);
      if (winner === undefined) return;
      event.preventDefault();
      winner.run(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [registry]);

  const value = useMemo<RegistryContextValue>(() => ({ registry, helpOpen, setHelpOpen }), [registry, helpOpen]);
  return <RegistryContext value={value}>{children}</RegistryContext>;
}

/**
 * Registers `handler` for `key` while the component is mounted and `enabled`. The most recently mounted enabled handler for a
 * key wins. The handler may change on every render without re-registering.
 */
export function useShortcut(key: string, handler: (event: KeyboardEvent) => void, options: ShortcutOptions): void {
  const { registry } = useRegistryContext();
  const { enabled = true, description } = options;
  const group = options.group ?? groupOfKey(key);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return registry.register({
      key,
      description,
      group,
      run: (event) => {
        latest.current(event);
      },
    });
  }, [registry, key, description, group, enabled]);
}

export interface ShortcutRegistryView {
  /** The winner of every registered key, for the shortcuts dialog. */
  shortcuts: readonly ActiveShortcut[];
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

export function useShortcutRegistry(): ShortcutRegistryView {
  const { registry, helpOpen, setHelpOpen } = useRegistryContext();
  const shortcuts = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  return { shortcuts, helpOpen, setHelpOpen };
}
