// The attention model of the Workspace (ADR 0107, design attention-trust 4.2 to 4.5): which rows the "Needs you" strip shows,
// what a collapsed folder says, which row the key `n` selects next and which title a live row may show. Pure, over the rows of
// the attention center (`AttentionItem`). Nothing here sorts or changes the list it is given: the order of the sidebar stays
// the order of the sidebar (ADR 0073 decision 7); the strip is a separate, sorted copy.
import { ATTENTION_LEVELS, compareAttention, type AttentionLevel, type SessionSummary } from '@mcs/shared';

import type { AttentionItem } from './attention-rows.ts';

/** The most rows the strip draws. */
export const STRIP_MAX = 5;

/** A level a person should look at: above `working`. */
export function isAttentionLevel(level: AttentionLevel): level is 'needs_you' | 'failed' | 'done' {
  return level === 'needs_you' || level === 'failed' || level === 'done';
}

/** Every row that belongs in the strip, in strip order: needs you (the longest blocked first), then failed, then done. */
function stripOrder(items: readonly AttentionItem[]): AttentionItem[] {
  return items.filter((item) => isAttentionLevel(item.level)).sort(compareAttention);
}

export interface StripModel {
  /** At most `STRIP_MAX` rows: tier 1 (needs you) first, then tier 2 (failed and done that were not seen yet). */
  rows: AttentionItem[];
  /** Every row that belongs in the strip: the count of the heading. */
  total: number;
  /** How many are not drawn: the "and N more" line. */
  more: number;
  /** The keys of every tier 2 row, drawn or not: what "Dismiss all" marks as seen. Empty: no such button. */
  dismissable: string[];
}

export function stripOf(items: readonly AttentionItem[], max: number = STRIP_MAX): StripModel {
  const ordered = stripOrder(items);
  const rows = ordered.slice(0, Math.max(0, max));
  return {
    rows,
    total: ordered.length,
    more: ordered.length - rows.length,
    dismissable: ordered.filter((item) => item.level !== 'needs_you').map((item) => item.key),
  };
}

export interface FolderRollup {
  /** The highest level among the live terminals of the folder. */
  level: AttentionLevel;
  /** How many of them are at that level. */
  count: number;
}

/**
 * What a collapsed folder head says instead of its live count, by `folderKey`, over the terminal rows only. A folder is in the
 * map when it has a terminal row; the head shows the chip when `isAttentionLevel(level)`.
 */
export function rollupByFolder(items: readonly AttentionItem[]): Map<string, FolderRollup> {
  const rollup = new Map<string, FolderRollup>();
  for (const item of items) {
    if (item.terminal === null || item.folderKey === null) continue;
    const known = rollup.get(item.folderKey);
    const rank = ATTENTION_LEVELS.indexOf(item.level);
    const knownRank = known === undefined ? Infinity : ATTENTION_LEVELS.indexOf(known.level);
    if (known === undefined || rank < knownRank) rollup.set(item.folderKey, { level: item.level, count: 1 });
    else if (rank === knownRank) known.count += 1;
  }
  return rollup;
}

/**
 * The row the key `n` goes to: the one after `selectedKey` in strip order, wrapping at the end; the first one when the selected
 * row is not in the strip; `null` when the strip is empty (the page says "No session needs you").
 */
export function nextNeeding(items: readonly AttentionItem[], selectedKey: string | null): AttentionItem | null {
  const ordered = stripOrder(items);
  if (ordered.length === 0) return null;
  const at = selectedKey === null ? -1 : ordered.findIndex((item) => item.key === selectedKey);
  return ordered[(at + 1) % ordered.length] ?? null;
}

/** The preference `workspaceTitles`. */
export type TitleMode = 'all' | 'named' | 'off';

const NAMED: ReadonlySet<string> = new Set(['custom_title', 'ai_title', 'rule']);

/**
 * The title a live row may show, or `null`. `named` (the default) shows only a title somebody or something gave the session;
 * `all` also shows a label taken from the first prompt, which may hold a secret; `off` shows none.
 */
export function titleOf(
  row: { label: string | null; labelSource: SessionSummary['labelSource'] | null },
  mode: TitleMode,
): string | null {
  if (mode === 'off' || row.label === null || row.label === '' || row.labelSource === null) return null;
  if (row.labelSource === 'none') return null;
  return mode === 'all' || NAMED.has(row.labelSource) ? row.label : null;
}
