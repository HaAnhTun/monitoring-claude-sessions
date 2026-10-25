// The address of /search and the request it makes (WP-121). The address holds the text and the entry kinds only; the limits are
// the page's own and are sent with every request, so the cache key of a search holds every parameter.
import { ENTRY_KINDS, toQuery, type EntryKind } from '@mcs/shared';

import type { ApiQuery } from '../../data/query-keys.ts';
import { setOf, text, type Spec } from '../../lib/url-state.ts';

/** The server refuses a shorter text (`query_too_short`, 03 5.4). */
export const MIN_QUERY_CHARS = 2;
/** The longest text the server accepts. */
export const MAX_QUERY_CHARS = 200;
/** Matches asked for; the server cuts the list at this number and says so (`truncated`). */
export const SEARCH_LIMIT = 100;
/** The time the page asks the server to search for (the server may allow `limits.searchBudgetMsMax` at most). */
export const DEFAULT_BUDGET_MS = 3000;

export interface SearchUrlState {
  q: string;
  /** Empty: every kind. */
  kinds: EntryKind[];
}

export const searchSpec: Spec<SearchUrlState> = {
  q: text('q', MAX_QUERY_CHARS),
  kinds: setOf('kinds', ENTRY_KINDS),
};

export function charCount(value: string): number {
  return Array.from(value).length;
}

/** The request of a submitted search, or `null` while the text is empty or too short. */
export function toSearchQuery(state: SearchUrlState, budgetMs: number): ApiQuery | null {
  if (charCount(state.q) < MIN_QUERY_CHARS) return null;
  return toQuery({ q: state.q, kinds: state.kinds, limit: SEARCH_LIMIT, budgetMs });
}
