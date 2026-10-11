import type { TranscriptEntry, TranscriptWindowResponse } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../data/api-errors.ts';
import { makeTranscript, makeTranscriptWindow } from '../test/fixtures/index.ts';
import {
  MAX_TRANSCRIPT_EVENTS,
  initialTranscriptState,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptWindowState,
} from './transcript-reducer.ts';

function slice(from: number, to: number, total: number, extra: Partial<TranscriptWindowResponse> = {}) {
  const events: TranscriptEntry[] = makeTranscript(Math.max(to, 1)).slice(from, to);
  return makeTranscriptWindow(0, { events, from, next: to, total, ...extra });
}

function apply(state: TranscriptWindowState, ...actions: TranscriptAction[]): TranscriptWindowState {
  return actions.reduce(transcriptReducer, state);
}

function failure(status: number, code: ApiError['info']['code'], kind: ApiError['info']['kind'] = 'http'): ApiError {
  return new ApiError('FIXTURE failure', { kind, status, code, endpoint: 'transcript', requestId: null });
}

const tail = (n: number, total = n): TranscriptAction => ({
  type: 'loaded',
  gen: 1,
  mode: 'tail',
  resp: slice(0, n, total),
  at: 1000,
});

describe('transcriptReducer', () => {
  it('starts idle and a reset moves to loading with the new generation', () => {
    const s = initialTranscriptState();
    expect(s.status).toBe('idle');
    expect(s.gen).toBe(0);
    const r = transcriptReducer(s, { type: 'reset', gen: 4 });
    expect(r.gen).toBe(4);
    expect(r.status).toBe('loading');
    expect(r.events).toEqual([]);
  });

  it('a tail load becomes ready with the counters of the response', () => {
    const s = apply(initialTranscriptState(), { type: 'reset', gen: 1 }, tail(8, 8));
    expect(s.status).toBe('ready');
    expect(s.events).toHaveLength(8);
    expect([s.base, s.next, s.total]).toEqual([0, 8, 8]);
    expect(s.lastSuccessAt).toBe(1000);
    expect(s.error).toBeNull();
  });

  it('ignores a response of an older generation (stale-response guard)', () => {
    const ready = apply(initialTranscriptState(), { type: 'reset', gen: 2 });
    const same = transcriptReducer(ready, tail(5));
    expect(same).toBe(ready);
    const failed = transcriptReducer(ready, { type: 'failed', gen: 1, error: failure(500, null), at: 5 });
    expect(failed).toBe(ready);
  });

  it('merges an after-load by index without duplicates', () => {
    const s = apply(initialTranscriptState(), { type: 'reset', gen: 1 }, tail(6, 6), {
      type: 'loaded',
      gen: 1,
      mode: 'after',
      resp: slice(4, 10, 10),
      at: 2000,
    });
    expect(s.events.map((e) => e.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.next).toBe(10);
    expect(s.total).toBe(10);
  });

  it('a before-load prepends older events and keeps next', () => {
    const s = apply(
      initialTranscriptState(),
      { type: 'reset', gen: 1 },
      { type: 'loaded', gen: 1, mode: 'tail', resp: slice(6, 10, 10), at: 1 },
      { type: 'olderLoading', gen: 1, value: true },
      { type: 'loaded', gen: 1, mode: 'before', resp: slice(2, 6, 10, { next: 6 }), at: 2 },
    );
    expect(s.events.map((e) => e.i)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.next).toBe(10);
    expect(s.olderLoading).toBe(false);
  });

  it('flags a reset when an after-response reports fewer entries than already seen', () => {
    const loaded = apply(initialTranscriptState(), { type: 'reset', gen: 1 }, tail(8, 8));
    const s = transcriptReducer(loaded, {
      type: 'loaded',
      gen: 1,
      mode: 'after',
      resp: makeTranscriptWindow(0, { total: 0, next: 0, events: [] }),
      at: 3,
    });
    expect(s.needsReset).toBe(true);
    expect(s.events).toHaveLength(8);
  });

  it('a window replace swaps the events and bumps the generation', () => {
    const loaded = apply(initialTranscriptState(), { type: 'reset', gen: 1 }, tail(8, 100));
    const s = transcriptReducer(loaded, {
      type: 'loaded',
      gen: 1,
      mode: 'window',
      resp: slice(40, 60, 100),
      at: 9,
    });
    expect(s.gen).toBe(2);
    expect(s.events[0]?.i).toBe(40);
    expect(s.events).toHaveLength(20);
    expect(s.next).toBe(60);
    // a response started under the old generation is now dropped
    expect(transcriptReducer(s, { type: 'loaded', gen: 1, mode: 'after', resp: slice(60, 70, 100), at: 10 })).toBe(s);
  });

  it('copies partial, pendingBytes and skippedBytes from the response', () => {
    const s = apply(
      initialTranscriptState(),
      { type: 'reset', gen: 1 },
      {
        type: 'loaded',
        gen: 1,
        mode: 'tail',
        resp: slice(0, 3, 3, { partial: true, pendingBytes: 1_500_000, skippedBytes: 7 }),
        at: 1,
      },
    );
    expect([s.partial, s.pendingBytes, s.skippedBytes]).toEqual([true, 1_500_000, 7]);
    const next = transcriptReducer(s, {
      type: 'loaded',
      gen: 1,
      mode: 'after',
      resp: slice(3, 3, 3, { partial: false, pendingBytes: 0 }),
      at: 2,
    });
    expect(next.partial).toBe(false);
    expect(next.pendingBytes).toBe(0);
  });

  describe('failures', () => {
    const loading = apply(initialTranscriptState(), { type: 'reset', gen: 1 });

    it('is an error when nothing was loaded yet', () => {
      const s = transcriptReducer(loading, { type: 'failed', gen: 1, error: failure(503, 'db_busy'), at: 4 });
      expect(s.status).toBe('error');
      expect(s.error?.info.status).toBe(503);
    });

    it('keeps the loaded events and stays ready when a refresh fails', () => {
      const ready = transcriptReducer(loading, tail(5));
      const s = transcriptReducer(ready, { type: 'failed', gen: 1, error: failure(0, null, 'network'), at: 7 });
      expect(s.status).toBe('ready');
      expect(s.events).toHaveLength(5);
      expect(s.error).not.toBeNull();
      expect(s.lastSuccessAt).toBe(1000);
    });

    it('maps 404 to not-found and 410 transcript_gone to gone', () => {
      expect(
        transcriptReducer(loading, { type: 'failed', gen: 1, error: failure(404, 'session_not_found'), at: 1 }).status,
      ).toBe('not-found');
      expect(
        transcriptReducer(loading, { type: 'failed', gen: 1, error: failure(410, 'transcript_gone'), at: 1 }).status,
      ).toBe('gone');
    });

    it('clears the older-loading flag', () => {
      const s = apply(
        transcriptReducer(loading, tail(5)),
        { type: 'olderLoading', gen: 1, value: true },
        { type: 'failed', gen: 1, error: failure(500, null), at: 2 },
      );
      expect(s.olderLoading).toBe(false);
    });
  });

  describe('window cap (04 4.4.3 step 12)', () => {
    const base = MAX_TRANSCRIPT_EVENTS - 10;
    const full = (): TranscriptWindowState =>
      apply(
        initialTranscriptState(),
        { type: 'reset', gen: 1 },
        {
          type: 'loaded',
          gen: 1,
          mode: 'tail',
          resp: makeTranscriptWindow(base, { total: base, next: base }),
          at: 1,
        },
      );

    it('has the documented limit', () => {
      expect(MAX_TRANSCRIPT_EVENTS).toBe(5000);
    });

    it('drops the oldest events while following and moves base', () => {
      const total = MAX_TRANSCRIPT_EVENTS + 20;
      const s = transcriptReducer(full(), {
        type: 'loaded',
        gen: 1,
        mode: 'after',
        following: true,
        resp: slice(base, total, total),
        at: 2,
      });
      expect(s.events).toHaveLength(MAX_TRANSCRIPT_EVENTS);
      expect(s.events[0]?.i).toBe(20);
      expect(s.events.at(-1)?.i).toBe(total - 1);
      expect(s.base).toBe(20);
      expect(s.next).toBe(total);
      expect(s.capped).toBe(true);
    });

    it('keeps its position when not following and counts the rest as unseen', () => {
      const total = MAX_TRANSCRIPT_EVENTS + 20;
      const s = transcriptReducer(full(), {
        type: 'loaded',
        gen: 1,
        mode: 'after',
        following: false,
        resp: slice(base, total, total),
        at: 2,
      });
      expect(s.events).toHaveLength(MAX_TRANSCRIPT_EVENTS);
      expect(s.events[0]?.i).toBe(0);
      expect(s.next).toBe(MAX_TRANSCRIPT_EVENTS);
      expect(s.total).toBe(total);
      expect(s.capped).toBe(true);
      expect(s.unseenBeyondCap).toBe(20);
    });

    it('is not capped below the limit', () => {
      expect(apply(initialTranscriptState(), { type: 'reset', gen: 1 }, tail(10)).capped).toBe(false);
    });
  });
});
