// What the attention center gives the pages (ADR 0107, design attention-trust 3.1): the rows with their levels and the settled
// counts. The host of the shell provides the value of `useAttention`; without a provider everything reads as empty, so a page
// or a test that mounts no host simply shows no attention.
import { createContext, useContext } from 'react';

import type { AttentionItem, AttentionScope } from '../lib/attention-rows.ts';
import { NO_ATTENTION, type AttentionSummary } from './attention-notifier.ts';

export interface AttentionValue {
  /** Every row of the effective scope with its level, in the order of the lists (never sorted here). */
  readonly items: readonly AttentionItem[];
  /** The settled counts the tab title and the tab icon read. */
  readonly summary: AttentionSummary;
  /** The effective scope (`all` on a task instance). */
  readonly scope: AttentionScope;
  /** "Mark as seen" and "Dismiss all": the rows with these keys stop counting as `failed` or `done`. */
  readonly markSeen: (keys: readonly string[]) => void;
}

const NO_ITEMS: readonly AttentionItem[] = Object.freeze([]);

export const EMPTY_ATTENTION: AttentionValue = Object.freeze({
  items: NO_ITEMS,
  summary: NO_ATTENTION,
  scope: 'here',
  markSeen: () => undefined,
});

export const AttentionContext = createContext<AttentionValue>(EMPTY_ATTENTION);

export function useAttentionValue(): AttentionValue {
  return useContext(AttentionContext);
}

/** The rows of the attention center; empty outside the host. */
export function useAttentionRows(): readonly AttentionItem[] {
  return useContext(AttentionContext).items;
}
