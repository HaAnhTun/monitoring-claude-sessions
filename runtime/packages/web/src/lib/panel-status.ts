// The view status of a workspace panel (04-ui.md 4.4.1): maps the TanStack query state of `usePanel` and the wire envelope of
// 06 3.3 to what the panel frame shows. Pure: the clock and `staleAfterMs` are arguments.
import type { PanelResponse } from '@mcs/shared';

import { ApiError } from '../data/api-errors.ts';
import { fmtClock } from './format.ts';

/** UI-only view status; named apart from the wire type `PanelStatus` (`ok | partial | error`) so they never collide. */
export type PanelViewStatus =
  | { kind: 'ok'; asOf: number }
  | { kind: 'loading' }
  /** Some sources are not ok; the data is shown with these notes. */
  | { kind: 'partial'; asOf: number; notes: string[] }
  | { kind: 'error'; message: string; lastGoodAt: number | null }
  | { kind: 'stale'; asOf: number };

/** The part of the TanStack query state `toPanelViewStatus` reads. */
export interface PanelQueryState {
  data: PanelResponse | undefined;
  error: unknown;
  isFetching: boolean;
  /** Epoch milliseconds of the last successful fetch, 0 when there was none. */
  dataUpdatedAt: number;
}

/** `404 panel_disabled`: the config changed under the page, so the panel is removed instead of showing an error. */
export function isPanelDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.info.code === 'panel_disabled';
}

function notesOf(response: PanelResponse): string[] {
  return response.sources
    .filter((source) => source.status !== 'ok')
    .map((source) => {
      const parts = [`${source.source}: ${source.status}`];
      if (source.message !== null) parts.push(source.message);
      if (source.sampledAt !== null) parts.push(`as of ${fmtClock(source.sampledAt)}`);
      return parts.join(', ');
    });
}

function firstMessage(response: PanelResponse): string {
  for (const source of response.sources) {
    if (source.message !== null) return source.message;
  }
  return 'No source produced data';
}

/** Rules 1-6 of 04 4.4.1, in order. */
export function toPanelViewStatus(q: PanelQueryState, now: number, staleAfterMs: number): PanelViewStatus {
  if (q.error !== null && q.error !== undefined) {
    const message = q.error instanceof Error ? q.error.message : 'Could not load the panel';
    return {
      kind: 'error',
      message,
      lastGoodAt: q.data === undefined || q.dataUpdatedAt <= 0 ? null : q.dataUpdatedAt,
    };
  }
  const response = q.data;
  if (response === undefined) return { kind: 'loading' };
  if (response.status === 'error') return { kind: 'error', message: firstMessage(response), lastGoodAt: null };
  const parsed = Date.parse(response.generatedAt);
  const asOf = Number.isNaN(parsed) ? 0 : parsed;
  if (now - asOf > staleAfterMs) return { kind: 'stale', asOf };
  return response.status === 'partial' ? { kind: 'partial', asOf, notes: notesOf(response) } : { kind: 'ok', asOf };
}
