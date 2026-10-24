// The transcript window of one session and agent (04-ui.md 5.4, ADR 0031): tail fetch, coalesced refresh, older pages, jump by
// window replacement. State changes go through the pure reducer of `transcript-reducer.ts`; a synchronous mirror of the state
// lets the fetch loops read `next` and `total` right after a response was applied.
import { routes, type TranscriptWindowResponse } from '@mcs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDataEnv } from '../data/hooks/useInstance.ts';
import { ApiError, describeApiError } from '../data/api-errors.ts';
import { pathFor } from '../data/endpoints.ts';
import { useT } from '../i18n/context.ts';
import { mergeEvents, type JumpTarget } from '../lib/timeline-model.ts';
import {
  MAX_TRANSCRIPT_EVENTS,
  createTranscriptReducer,
  initialTranscriptState,
  type TranscriptAction,
  type TranscriptWindowState,
} from './transcript-reducer.ts';

export type { TranscriptWindowState } from './transcript-reducer.ts';

export interface TranscriptWindowApi {
  state: TranscriptWindowState;
  /** `before=<first index>`, 250 entries; resolves with the number of older entries added. */
  loadOlder: () => Promise<number>;
  /** Locates the target and, when it is not loaded, replaces the window around it. Resolves with the index or `null`. */
  jumpTo: (target: JumpTarget) => Promise<number | null>;
  /** The state right now, including changes React has not rendered yet (a handler reads it right after an await). */
  peek: () => TranscriptWindowState;
  /** A coalesced `after=next` fetch (one in flight, one more when asked meanwhile, up to three while behind). */
  refresh: () => void;
}

export interface UseTranscriptWindowOptions {
  /** Announcements, worded through the catalogue (`transcript.notice.*`): "Loaded N older events", "The transcript was reset; reloading events". */
  onNotice?: (message: string) => void;
  /** Whether the viewer follows the latest edge; the cap rule of 4.4.3 step 12 reads it. Default true. */
  following?: boolean;
  /** The window cap; 5,000 unless a test or a performance fallback lowers it. */
  maxEvents?: number;
}

const PAGE = 250;
const JUMP_CONTEXT = 15;
const CHAIN = 3;

interface Control {
  abort: AbortController;
  gen: number;
  inFlight: boolean;
  again: boolean;
  /** 404 or 410: nothing is fetched until the session or agent changes. */
  stopped: boolean;
}

function newControl(): Control {
  return { abort: new AbortController(), gen: 0, inFlight: false, again: false, stopped: false };
}

/** Narrowing cannot see that a signal aborts while a request is awaited; this reads the flag afresh. */
function wantsAgain(c: Control): boolean {
  return c.again;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(error instanceof Error ? error.message : String(error), {
    kind: 'network',
    status: 0,
    code: null,
    endpoint: 'transcript',
    requestId: null,
  });
}

export function useTranscriptWindow(
  sessionId: string,
  agentId: string | null,
  options: UseTranscriptWindowOptions = {},
): TranscriptWindowApi {
  const { api, iid, live, poll } = useDataEnv();
  const t = useT();
  const agent = agentId ?? 'main';
  const max = options.maxEvents ?? MAX_TRANSCRIPT_EVENTS;
  const reduce = useMemo(() => createTranscriptReducer(max), [max]);

  const [state, setState] = useState<TranscriptWindowState>(initialTranscriptState);
  const mirror = useRef<TranscriptWindowState>(state);
  const controlRef = useRef<Control | null>(null);
  const getControl = useCallback((): Control => {
    controlRef.current ??= newControl();
    return controlRef.current;
  }, []);
  const latest = useRef({ options, reduce, max, t });
  useEffect(() => {
    latest.current = { options, reduce, max, t };
  });

  const send = useCallback((action: TranscriptAction): void => {
    const next = latest.current.reduce(mirror.current, action);
    if (next === mirror.current) return;
    mirror.current = next;
    setState(next);
  }, []);

  const request = useCallback(
    (query: Record<string, string | number>, signal: AbortSignal): Promise<TranscriptWindowResponse> =>
      api.get(
        'transcript',
        pathFor('transcript', routes.transcriptWindow, { sessionId }),
        routes.transcriptWindow.response,
        { query: { agent, ...query }, signal },
      ),
    [api, sessionId, agent],
  );

  const fail = useCallback(
    (error: unknown, gen: number, signal: AbortSignal): void => {
      if (signal.aborted) return;
      const apiError = asApiError(error);
      if (apiError.info.kind === 'aborted') return;
      if (apiError.info.status === 404 || apiError.info.status === 410) getControl().stopped = true;
      send({ type: 'failed', gen, error: apiError, at: Date.now() });
    },
    [send, getControl],
  );

  const loadTail = useCallback(
    async (gen: number, signal: AbortSignal): Promise<void> => {
      try {
        const resp = await request({ after: -1, limit: Math.min(PAGE, latest.current.max) }, signal);
        if (signal.aborted) return;
        send({ type: 'loaded', gen, mode: 'tail', resp, at: Date.now() });
      } catch (error) {
        fail(error, gen, signal);
      }
    },
    [request, send, fail],
  );

  /** Aborts everything in flight, bumps the generation and fetches the tail again. */
  const startOver = useCallback((): void => {
    const c = getControl();
    c.abort.abort();
    c.abort = new AbortController();
    c.inFlight = false;
    c.again = false;
    c.stopped = false;
    c.gen = Math.max(c.gen, mirror.current.gen) + 1;
    send({ type: 'reset', gen: c.gen });
    void loadTail(c.gen, c.abort.signal);
  }, [send, loadTail, getControl]);

  useEffect(() => {
    startOver();
    return () => {
      getControl().abort.abort();
    };
  }, [startOver, getControl, iid]);

  const runRefresh = useCallback(async (): Promise<void> => {
    const c = getControl();
    const signal = c.abort.signal;
    c.inFlight = true;
    try {
      do {
        c.again = false;
        for (let n = 0; n < CHAIN; n += 1) {
          const gen = mirror.current.gen;
          const resp = await request({ after: mirror.current.next }, signal);
          if (signal.aborted) return;
          send({
            type: 'loaded',
            gen,
            mode: 'after',
            resp,
            at: Date.now(),
            following: latest.current.options.following ?? true,
          });
          const s = mirror.current;
          if (s.needsReset) {
            latest.current.options.onNotice?.(latest.current.t('transcript.notice.reset'));
            c.inFlight = false;
            startOver();
            return;
          }
          const stalled = s.capped && latest.current.options.following === false;
          if (s.next >= s.total || stalled) break;
        }
      } while (wantsAgain(c) && !isAborted(signal));
    } catch (error) {
      fail(error, mirror.current.gen, signal);
    } finally {
      if (c.abort.signal === signal) c.inFlight = false;
    }
  }, [request, send, fail, startOver, getControl]);

  const refresh = useCallback((): void => {
    const c = getControl();
    if (c.stopped) return;
    const status = mirror.current.status;
    if (status === 'error') {
      startOver();
      return;
    }
    if (status !== 'ready') return;
    if (c.inFlight) {
      c.again = true;
      return;
    }
    void runRefresh();
  }, [runRefresh, startOver, getControl]);

  useEffect(() => {
    if (live) return undefined;
    const id = setInterval(refresh, poll.transcriptMs);
    return () => {
      clearInterval(id);
    };
  }, [live, poll.transcriptMs, refresh]);

  const loadOlder = useCallback(async (): Promise<number> => {
    const c = getControl();
    const s = mirror.current;
    const first = s.events[0]?.i;
    if (c.stopped || first === undefined || first <= 0 || s.capped || s.olderLoading) return 0;
    const signal = c.abort.signal;
    const gen = s.gen;
    send({ type: 'olderLoading', gen, value: true });
    try {
      const resp = await request(
        { before: first, limit: Math.min(PAGE, latest.current.max - s.events.length) },
        signal,
      );
      if (signal.aborted) return 0;
      const added = mergeEvents(mirror.current.events, resp.events).olderAdded;
      send({ type: 'loaded', gen, mode: 'before', resp, at: Date.now() });
      if (added > 0)
        latest.current.options.onNotice?.(latest.current.t('transcript.notice.olderLoaded', { count: added }));
      return added;
    } catch (error) {
      fail(error, gen, signal);
      return 0;
    }
  }, [request, send, fail, getControl]);

  const jumpTo = useCallback(
    async (target: JumpTarget): Promise<number | null> => {
      const c = getControl();
      if (c.stopped) return null;
      const loaded = (i: number): boolean => mirror.current.events.some((e) => e.i === i);
      if (target.type === 'index' && loaded(target.i)) return target.i;
      const signal = c.abort.signal;
      try {
        const located = await api.get(
          'transcriptLocate',
          pathFor('transcriptLocate', routes.transcriptLocate, { sessionId }),
          routes.transcriptLocate.response,
          { query: target.type === 'index' ? { agent, i: target.i } : { agent, ts: target.ts }, signal },
        );
        if (isAborted(signal)) return null;
        if (loaded(located.i)) return located.i;
        const start = Math.max(located.base, located.i - JUMP_CONTEXT);
        const resp = await request({ after: start, limit: Math.min(PAGE, latest.current.max) }, signal);
        if (isAborted(signal)) return null;
        send({
          type: 'loaded',
          gen: mirror.current.gen,
          mode: 'window',
          resp,
          at: Date.now(),
          following: false,
        });
        return located.i;
      } catch (error) {
        if (isAborted(signal)) return null;
        const apiError = asApiError(error);
        if (apiError.info.code !== 'event_not_found' && apiError.info.kind !== 'aborted') {
          const { t: say } = latest.current;
          const detail = describeApiError(apiError, say);
          latest.current.options.onNotice?.(
            detail === undefined
              ? say('transcript.notice.jumpFailedPlain')
              : say('transcript.notice.jumpFailed', { detail }),
          );
        }
        return null;
      }
    },
    [api, sessionId, agent, request, send, getControl],
  );

  const peek = useCallback((): TranscriptWindowState => mirror.current, []);

  return { state, peek, loadOlder, jumpTo, refresh };
}
