import type { TranscriptEntry } from '@mcs/shared';
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeApi, errorResponse, type FakeApi, type FakeHandler, type FakeHandlers } from '../test/fake-api.ts';
import { makeInstance, makeTranscript, makeTranscriptWindow, sessionId } from '../test/fixtures/index.ts';
import { renderHookWithProviders } from '../test/render.tsx';
import { useTranscriptWindow, type UseTranscriptWindowOptions } from './useTranscriptWindow.ts';

const SID = sessionId(1);

afterEach(() => {
  vi.useRealTimers();
});

/** A server whose transcript can grow: the 03 7.3 window semantics over `size()` entries. */
function windowServer(initial: number) {
  const state = { total: initial, calls: [] as URLSearchParams[], gate: null as Promise<void> | null };
  const handler: FakeHandler = async (query) => {
    state.calls.push(query);
    if (state.gate !== null) await state.gate;
    const total = state.total;
    const all: TranscriptEntry[] = makeTranscript(total);
    const before = query.get('before');
    const after = Number(query.get('after') ?? '-1');
    const limit = Number(query.get('limit') ?? (before !== null || after === -1 ? '250' : '2000'));
    let start: number;
    let end: number;
    if (before !== null) {
      end = Math.min(Number(before), total);
      start = Math.max(0, end - limit);
    } else if (after === -1) {
      end = total;
      start = Math.max(0, total - limit);
    } else {
      start = Math.min(after, total);
      end = Math.min(total, start + limit);
    }
    return makeTranscriptWindow(0, { events: all.slice(start, end), from: start, next: end, total });
  };
  return { state, handler };
}

function setup(
  handlers: FakeHandlers,
  options: UseTranscriptWindowOptions = {},
  extra: { sessionId?: string; agentId?: string | null; poll?: number; live?: boolean } = {},
) {
  const instance = makeInstance();
  const api: FakeApi = createFakeApi({ instance: () => instance, ...handlers });
  const rendered = renderHookWithProviders(
    (props: { sid: string; agent: string | null }) => useTranscriptWindow(props.sid, props.agent, options),
    {
      api,
      instance:
        extra.poll === undefined ? instance : { ...instance, poll: { ...instance.poll, transcriptMs: extra.poll } },
      live: extra.live ?? true,
      initialProps: { sid: extra.sessionId ?? SID, agent: extra.agentId === undefined ? 'main' : extra.agentId },
    },
  );
  return rendered;
}

async function ready(result: { current: ReturnType<typeof useTranscriptWindow> }) {
  await waitFor(() => {
    expect(result.current.state.status).toBe('ready');
  });
}

describe('useTranscriptWindow', () => {
  it('fetches the tail of the main agent on mount', async () => {
    const server = windowServer(400);
    const { result, api } = setup({ transcriptWindow: server.handler });
    expect(result.current.state.status === 'loading' || result.current.state.status === 'idle').toBe(true);
    await ready(result);
    const call = api.callsTo('transcriptWindow')[0];
    expect(call?.params['sessionId']).toBe(SID);
    expect(call?.query.get('agent')).toBe('main');
    expect(call?.query.get('after')).toBe('-1');
    expect(call?.query.get('limit')).toBe('250');
    expect(result.current.state.events).toHaveLength(250);
    expect(result.current.state.events[0]?.i).toBe(150);
    expect(result.current.state.total).toBe(400);
    expect(result.current.state.next).toBe(400);
  });

  it('treats a null agent as main', async () => {
    const server = windowServer(3);
    const { result, api } = setup({ transcriptWindow: server.handler }, {}, { agentId: null });
    await ready(result);
    expect(api.callsTo('transcriptWindow')[0]?.query.get('agent')).toBe('main');
  });

  it('loads older events before the first loaded index and announces the count', async () => {
    const server = windowServer(400);
    const onNotice = vi.fn();
    const { result, api } = setup({ transcriptWindow: server.handler }, { onNotice });
    await ready(result);
    let added = -1;
    await act(async () => {
      added = await result.current.loadOlder();
    });
    expect(added).toBe(150);
    expect(api.callsTo('transcriptWindow')[1]?.query.get('before')).toBe('150');
    expect(result.current.state.events[0]?.i).toBe(0);
    expect(result.current.state.events).toHaveLength(400);
    expect(result.current.state.next).toBe(400);
    expect(onNotice).toHaveBeenCalledWith('Loaded 150 older events');
  });

  it('does nothing when the first entry is already loaded', async () => {
    const server = windowServer(10);
    const { result, api } = setup({ transcriptWindow: server.handler });
    await ready(result);
    let added = -1;
    await act(async () => {
      added = await result.current.loadOlder();
    });
    expect(added).toBe(0);
    expect(api.callsTo('transcriptWindow')).toHaveLength(1);
  });

  it('refresh fetches after next and appends', async () => {
    const server = windowServer(10);
    const { result, api } = setup({ transcriptWindow: server.handler });
    await ready(result);
    server.state.total = 14;
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.state.total).toBe(14);
    });
    expect(api.callsTo('transcriptWindow')[1]?.query.get('after')).toBe('10');
    expect(result.current.state.events.map((e) => e.i)).toEqual(Array.from({ length: 14 }, (_unused, i) => i));
  });

  it('coalesces refreshes requested while a fetch is in flight into one more fetch', async () => {
    const server = windowServer(10);
    const { result, api } = setup({ transcriptWindow: server.handler });
    await ready(result);
    let release: () => void = () => undefined;
    server.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.state.total = 12;
    act(() => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });
    server.state.gate = null;
    release();
    await waitFor(() => {
      expect(result.current.state.total).toBe(12);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // one initial tail, one in-flight refresh, one "again" refresh
    expect(api.callsTo('transcriptWindow')).toHaveLength(3);
  });

  it('chains up to three fetches while next is behind total', async () => {
    const server = windowServer(10);
    const { result, api } = setup({ transcriptWindow: server.handler });
    await ready(result);
    // the server returns at most 2 entries per after-request
    const original = server.handler;
    const limited: FakeHandler = (query, request) => {
      if (query.get('after') !== '-1') query.set('limit', '2');
      return original(query, request);
    };
    api.handlers = { ...api.handlers, transcriptWindow: limited };
    server.state.total = 30;
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(api.callsTo('transcriptWindow').length).toBeGreaterThanOrEqual(4);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.callsTo('transcriptWindow')).toHaveLength(4);
    expect(result.current.state.next).toBe(16);
  });

  it('resets, announces and reloads when the transcript shrank', async () => {
    const server = windowServer(20);
    const onNotice = vi.fn();
    const { result, api } = setup({ transcriptWindow: server.handler }, { onNotice });
    await ready(result);
    const firstGen = result.current.state.gen;
    server.state.total = 5;
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith('The transcript was reset; reloading events');
    });
    await waitFor(() => {
      expect(result.current.state.total).toBe(5);
      expect(result.current.state.status).toBe('ready');
    });
    expect(result.current.state.gen).toBeGreaterThan(firstGen);
    expect(result.current.state.events).toHaveLength(5);
    const afters = api.callsTo('transcriptWindow').map((c) => c.query.get('after'));
    expect(afters.at(-1)).toBe('-1');
  });

  it('is gone after a 410 and stops refreshing until the session changes', async () => {
    const server = windowServer(5);
    const gone: FakeHandler = () => errorResponse('transcript_gone');
    const { result, api, rerender } = setup({ transcriptWindow: gone });
    await waitFor(() => {
      expect(result.current.state.status).toBe('gone');
    });
    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.callsTo('transcriptWindow')).toHaveLength(1);
    api.handlers = { ...api.handlers, transcriptWindow: server.handler };
    rerender({ sid: sessionId(2), agent: 'main' });
    await ready(result);
    expect(api.callsTo('transcriptWindow')[1]?.params['sessionId']).toBe(sessionId(2));
  });

  it('is not-found for an unknown session', async () => {
    const { result } = setup({ transcriptWindow: () => errorResponse('session_not_found') });
    await waitFor(() => {
      expect(result.current.state.status).toBe('not-found');
    });
  });

  it('starts over with a new generation when the agent changes and drops the old response', async () => {
    const server = windowServer(5);
    let release: () => void = () => undefined;
    server.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result, rerender, api } = setup({ transcriptWindow: server.handler });
    const firstGen = result.current.state.gen;
    rerender({ sid: SID, agent: 'agent-0001' });
    server.state.gate = null;
    release();
    await ready(result);
    expect(result.current.state.gen).toBeGreaterThan(firstGen);
    expect(api.callsTo('transcriptWindow').at(-1)?.query.get('agent')).toBe('agent-0001');
    expect(result.current.state.events).toHaveLength(5);
  });

  it('keeps the loaded events and reports the error when a refresh fails', async () => {
    const server = windowServer(5);
    const { result, api } = setup({ transcriptWindow: server.handler });
    await ready(result);
    api.handlers = { ...api.handlers, transcriptWindow: () => errorResponse('internal_error') };
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.state.error).not.toBeNull();
    });
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.events).toHaveLength(5);
  });

  describe('polling fallback', () => {
    it('refreshes on the transcript interval while the stream is not live', async () => {
      const server = windowServer(5);
      const { result, api } = setup({ transcriptWindow: server.handler }, {}, { live: false, poll: 25 });
      await ready(result);
      server.state.total = 7;
      await waitFor(() => {
        expect(result.current.state.total).toBe(7);
      });
      expect(api.callsTo('transcriptWindow').length).toBeGreaterThanOrEqual(2);
    });

    it('does not poll while the stream is live', async () => {
      const server = windowServer(5);
      const timers = vi.spyOn(globalThis, 'setInterval');
      const { result, api } = setup({ transcriptWindow: server.handler }, {}, { live: true, poll: 20 });
      await ready(result);
      expect(timers.mock.calls.filter((call) => call[1] === 20)).toHaveLength(0);
      expect(api.callsTo('transcriptWindow')).toHaveLength(1);
    });
  });

  describe('jumpTo', () => {
    function locateHandler(
      answer: (q: URLSearchParams) => Response | { i: number; t: string; base: number; total: number },
    ) {
      return (query: URLSearchParams) => answer(query);
    }

    it('answers a loaded index without a request', async () => {
      const server = windowServer(50);
      const { result, api } = setup({
        transcriptWindow: server.handler,
        transcriptLocate: locateHandler(() => errorResponse('event_not_found')),
      });
      await ready(result);
      let index: number | null = null;
      await act(async () => {
        index = await result.current.jumpTo({ type: 'index', i: 40 });
      });
      expect(index).toBe(40);
      expect(api.callsTo('transcriptLocate')).toHaveLength(0);
    });

    it('locates an index that is not loaded and replaces the window around it', async () => {
      const server = windowServer(2000);
      const { result, api } = setup({
        transcriptWindow: server.handler,
        transcriptLocate: locateHandler((q) => ({
          i: Number(q.get('i')),
          t: '2026-10-12T12:00:00.000Z',
          base: 0,
          total: 2000,
        })),
      });
      await ready(result);
      const gen = result.current.state.gen;
      let index: number | null = null;
      await act(async () => {
        index = await result.current.jumpTo({ type: 'index', i: 500 });
      });
      expect(index).toBe(500);
      expect(api.callsTo('transcriptLocate')[0]?.query.get('i')).toBe('500');
      const windowCall = api.callsTo('transcriptWindow').at(-1);
      expect(windowCall?.query.get('after')).toBe('485');
      expect(result.current.state.events[0]?.i).toBe(485);
      expect(result.current.state.events.some((e) => e.i === 500)).toBe(true);
      expect(result.current.state.gen).toBeGreaterThan(gen);
    });

    it('locates by time', async () => {
      const server = windowServer(2000);
      const { result, api } = setup({
        transcriptWindow: server.handler,
        transcriptLocate: locateHandler(() => ({ i: 700, t: '2026-10-12T12:00:00.000Z', base: 0, total: 2000 })),
      });
      await ready(result);
      let index: number | null = null;
      await act(async () => {
        index = await result.current.jumpTo({ type: 'time', ts: '2026-10-12T12:00:00.000Z' });
      });
      expect(index).toBe(700);
      expect(api.callsTo('transcriptLocate')[0]?.query.get('ts')).toBe('2026-10-12T12:00:00.000Z');
    });

    it('returns null when nothing is located', async () => {
      const server = windowServer(2000);
      const { result } = setup({
        transcriptWindow: server.handler,
        transcriptLocate: () => errorResponse('event_not_found'),
      });
      await ready(result);
      let index: number | null = 1;
      await act(async () => {
        index = await result.current.jumpTo({ type: 'index', i: 99999 });
      });
      expect(index).toBeNull();
    });
  });
});
