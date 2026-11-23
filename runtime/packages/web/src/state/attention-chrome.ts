// What the attention center shows outside the page (ADR 0107, design attention-trust 3.5): a count in front of the tab title
// and a dot on the tab icon. A small external store, so `usePageChrome` stays the only writer of `document.title`. The store
// holds a kind and a count, never a name; the words come from the catalogue of the reader.
import type { AttentionEventKind } from '@mcs/shared';
import { createContext, useContext, useSyncExternalStore } from 'react';

import { NO_ATTENTION, type AttentionSummary } from './attention-notifier.ts';

export interface AttentionChrome {
  /** The highest settled count that is not zero, or `null`: nothing in front of the title. */
  readonly title: { readonly kind: AttentionEventKind; readonly count: number } | null;
  /** The tab icon carries the dot. */
  readonly icon: boolean;
}

export const NO_ATTENTION_CHROME: AttentionChrome = Object.freeze({ title: null, icon: false });

export const FAVICON_PLAIN = '/favicon.svg';
export const FAVICON_ATTENTION = '/favicon-attention.svg';

/**
 * The title shows the highest count: needs you, then failed, then done. The icon has its dot while a session needs the person
 * or failed (`done` has none: the title says it). Each is switched off by its preference.
 */
export function chromeOf(
  summary: AttentionSummary = NO_ATTENTION,
  prefs: { title: boolean; favicon: boolean },
): AttentionChrome {
  const counts: readonly [AttentionEventKind, number][] = [
    ['needs_you', summary.needsYou],
    ['failed', summary.failed],
    ['done', summary.done],
  ];
  const top = counts.find(([, count]) => count > 0);
  return {
    title: prefs.title && top !== undefined ? { kind: top[0], count: top[1] } : null,
    icon: prefs.favicon && summary.needsYou + summary.failed > 0,
  };
}

function sameChrome(a: AttentionChrome, b: AttentionChrome): boolean {
  return a.icon === b.icon && a.title?.kind === b.title?.kind && a.title?.count === b.title?.count;
}

export interface AttentionChromeStore {
  /** The same object until the chrome changes (the contract of `useSyncExternalStore`). */
  readonly getSnapshot: () => AttentionChrome;
  readonly subscribe: (listener: () => void) => () => void;
  readonly set: (next: AttentionChrome) => void;
}

export function createAttentionChromeStore(): AttentionChromeStore {
  let chrome: AttentionChrome = NO_ATTENTION_CHROME;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => chrome,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (sameChrome(chrome, next)) return;
      chrome = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

let sharedStore: AttentionChromeStore | null = null;

function sharedAttentionChromeStore(): AttentionChromeStore {
  sharedStore ??= createAttentionChromeStore();
  return sharedStore;
}

/** Tests replace the store of the subtree; the default is the store of the page. */
export const AttentionChromeStoreContext = createContext<AttentionChromeStore | null>(null);

export function useAttentionChromeStore(): AttentionChromeStore {
  return useContext(AttentionChromeStoreContext) ?? sharedAttentionChromeStore();
}

/** What `usePageChrome` composes into the title and the icon; re-renders when it changes. */
export function useAttentionChrome(): AttentionChrome {
  const store = useAttentionChromeStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The part of `document` the icon swap touches. */
export interface FaviconDocument {
  querySelector(
    selectors: string,
  ): { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void } | null;
}

/** Points the icon link of the page at the plain icon or at the one with the dot; a page without the link is left alone. */
export function applyFavicon(doc: FaviconDocument, attention: boolean): void {
  const link = doc.querySelector('link[rel~="icon"]');
  const href = attention ? FAVICON_ATTENTION : FAVICON_PLAIN;
  if (link !== null && link.getAttribute('href') !== href) link.setAttribute('href', href);
}
