// The transcript window as a pure reducer (04-ui.md 5.4, ADR 0031): index-addressed, append-only, with a generation guard,
// window replacement, reset detection and the 5,000-entry cap of 4.4.3 step 12.
import type { TranscriptEntry, TranscriptWindowResponse } from '@mcs/shared';

import type { ApiError } from '../data/api-errors.ts';
import { mergeEvents } from '../lib/timeline-model.ts';

/** `MAX_TRANSCRIPT_EVENTS`: the most entries a viewer holds (ADR 0038). */
export const MAX_TRANSCRIPT_EVENTS = 5000;

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'error' | 'not-found' | 'gone';

export interface TranscriptWindowState {
  /** Bumps on reset and on window replacement; an async result of an older generation is dropped. */
  gen: number;
  /** Ascending by `i`, without duplicates. */
  events: readonly TranscriptEntry[];
  /** The first index of the window: 0, or the first kept index after the oldest events were dropped. */
  base: number;
  total: number;
  /** The index after the last stored event: the next `after` request starts here. */
  next: number;
  partial: boolean;
  skippedBytes: number;
  /** Bytes of the file the server has not indexed yet (03 7.3): drives the partial banner. */
  pendingBytes: number;
  status: TranscriptStatus;
  error: ApiError | null;
  lastSuccessAt: number | null;
  olderLoading: boolean;
  /** `events.length` reached the cap. */
  capped: boolean;
  /** An `after` response said the transcript is shorter than what was loaded: the owner resets and reloads. */
  needsReset: boolean;
  /** Entries the server has that were not stored because the window is full and the viewer is not following. */
  unseenBeyondCap: number;
}

export type TranscriptAction =
  | { type: 'reset'; gen: number }
  | {
      type: 'loaded';
      gen: number;
      mode: 'tail' | 'after' | 'before' | 'window';
      resp: TranscriptWindowResponse;
      at: number;
      /** Whether the viewer follows the latest edge; only the cap rule reads it (default true). */
      following?: boolean;
    }
  | { type: 'olderLoading'; gen: number; value: boolean }
  | { type: 'failed'; gen: number; error: ApiError; at: number };

export function initialTranscriptState(): TranscriptWindowState {
  return {
    gen: 0,
    events: [],
    base: 0,
    total: 0,
    next: 0,
    partial: false,
    skippedBytes: 0,
    pendingBytes: 0,
    status: 'idle',
    error: null,
    lastSuccessAt: null,
    olderLoading: false,
    capped: false,
    needsReset: false,
    unseenBeyondCap: 0,
  };
}

function lastIndex(events: readonly TranscriptEntry[]): number {
  return events[events.length - 1]?.i ?? -1;
}

function loaded(
  state: TranscriptWindowState,
  action: Extract<TranscriptAction, { type: 'loaded' }>,
  max: number,
): TranscriptWindowState {
  const { resp, mode, at } = action;
  if (mode === 'after' && resp.total < state.next) return { ...state, needsReset: true, olderLoading: false };

  let events: readonly TranscriptEntry[];
  let base: number = resp.base;
  let next = resp.next;
  let gen = state.gen;
  let unseen = 0;

  if (mode === 'tail') {
    events = resp.events;
  } else if (mode === 'window') {
    events = resp.events;
    gen = state.gen + 1;
  } else {
    events = mergeEvents(state.events, resp.events).events;
    if (mode === 'after') base = state.base;
    if (mode === 'before') next = state.next;
  }

  if (events.length > max) {
    if (mode === 'after' && action.following !== false) {
      // following: the newest entries matter, the oldest are dropped and `base` moves up
      events = events.slice(events.length - max);
      base = events[0]?.i ?? base;
    } else {
      // not following (or a window that is too large): keep the position, store no more than fits and let `next` follow
      // what is stored, so the rest is fetched again on resume
      events = events.slice(0, max);
      next = lastIndex(events) + 1;
      unseen = Math.max(0, resp.total - next);
    }
  }

  return {
    ...state,
    gen,
    events,
    base,
    total: resp.total,
    next,
    partial: resp.partial,
    skippedBytes: resp.skippedBytes,
    pendingBytes: resp.pendingBytes,
    status: 'ready',
    error: null,
    lastSuccessAt: at,
    olderLoading: false,
    capped: events.length >= max,
    needsReset: false,
    unseenBeyondCap: unseen,
  };
}

/** The reducer with a configurable cap (the viewer's `maxEvents` seam); `transcriptReducer` uses the documented 5,000. */
export function createTranscriptReducer(max: number) {
  return function reduce(state: TranscriptWindowState, action: TranscriptAction): TranscriptWindowState {
    switch (action.type) {
      case 'reset':
        return { ...initialTranscriptState(), gen: action.gen, status: 'loading' };
      case 'olderLoading':
        if (action.gen !== state.gen) return state;
        return { ...state, olderLoading: action.value };
      case 'loaded':
        if (action.gen !== state.gen) return state;
        return loaded(state, action, max);
      case 'failed': {
        if (action.gen !== state.gen) return state;
        const { status, code } = action.error.info;
        if (status === 410 || code === 'transcript_gone') {
          return { ...state, status: 'gone', error: action.error, olderLoading: false };
        }
        if (status === 404) return { ...state, status: 'not-found', error: action.error, olderLoading: false };
        const hasData = state.status === 'ready' && state.lastSuccessAt !== null;
        return {
          ...state,
          status: hasData ? 'ready' : 'error',
          error: action.error,
          olderLoading: false,
        };
      }
    }
  };
}

export const transcriptReducer = createTranscriptReducer(MAX_TRANSCRIPT_EVENTS);
