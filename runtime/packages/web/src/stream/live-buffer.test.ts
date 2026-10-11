import type { ToolCallItem } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';

import { makeEvent, sessionId, toolUseId } from '../test/fixtures/index.ts';
import {
  createLiveBuffer,
  createLiveBufferRegistry,
  initialLiveBufferState,
  liveBufferReducer,
  type LiveBufferAction,
  type LiveBufferHandle,
  type LiveBufferOptions,
  type LiveBufferState,
} from './live-buffer.ts';

interface Item {
  id: string;
  seq: number;
}

function options(over: Partial<LiveBufferOptions<Item>> = {}): LiveBufferOptions<Item> {
  return { key: (t) => t.id, accept: () => true, headCap: 5, pausedCap: 3, ...over };
}

function item(n: number): Item {
  return { id: `e${String(n)}`, seq: n };
}

function run(actions: LiveBufferAction<Item>[], o = options()) {
  let state: LiveBufferState<Item> = initialLiveBufferState<Item>();
  const effects: string[] = [];
  for (const action of actions) {
    const r = liveBufferReducer(state, action, o);
    state = r.state;
    effects.push(r.effect);
  }
  return { state, effects };
}

const ids = (xs: Item[]): string[] => xs.map((x) => x.id);

function handle(): LiveBufferHandle {
  return { offer: vi.fn(), refetchFirstPage: vi.fn(), patchToolCalls: vi.fn(), clear: vi.fn() };
}

function toolCall(): ToolCallItem {
  return {
    id: 1,
    seq: 2,
    toolUseId: toolUseId(1),
    sessionId: sessionId(1),
    agentId: 'main',
    promptId: null,
    name: 'Bash',
    mcpServer: null,
    status: 'succeeded',
    outcome: 'ok',
    summary: null,
    inputBytes: null,
    startedAt: null,
    endedAt: null,
    batchAt: null,
    durationMs: 5,
    durationSource: null,
    exitCode: null,
    sources: [],
    subagentId: null,
    workflowRunId: null,
    transcriptRef: null,
  };
}

describe('liveBufferReducer offer (live)', () => {
  it('puts the newest item first: a frame lists oldest to newest and the head is newest first', () => {
    const { state, effects } = run([{ type: 'offer', items: [item(1), item(2), item(3)] }]);
    expect(ids(state.head)).toEqual(['e3', 'e2', 'e1']);
    expect(effects).toEqual(['none']);
  });

  it('prepends later offers before earlier ones', () => {
    const { state } = run([
      { type: 'offer', items: [item(1), item(2)] },
      { type: 'offer', items: [item(3)] },
    ]);
    expect(ids(state.head)).toEqual(['e3', 'e2', 'e1']);
  });

  it('ignores items the filter rejects and items already seen (R2)', () => {
    const o = options({ accept: (t) => t.seq % 2 === 1 });
    const { state } = run(
      [
        { type: 'offer', items: [item(1), item(2), item(3)] },
        { type: 'offer', items: [item(3), item(5)] },
      ],
      o,
    );
    expect(ids(state.head)).toEqual(['e5', 'e3', 'e1']);
  });

  it('asks for a first-page refetch and empties the head when it passes headCap', () => {
    const { state, effects } = run([
      { type: 'offer', items: [item(1), item(2), item(3), item(4), item(5)] },
      { type: 'offer', items: [item(6)] },
    ]);
    expect(effects).toEqual(['none', 'refetch-first-page']);
    expect(state.head).toEqual([]);
  });

  it('keeps exactly headCap items without an effect', () => {
    const { state, effects } = run([{ type: 'offer', items: [item(1), item(2), item(3), item(4), item(5)] }]);
    expect(state.head).toHaveLength(5);
    expect(effects).toEqual(['none']);
  });
});

describe('liveBufferReducer pause and resume', () => {
  it('buffers accepted unseen items while paused, newest first, and leaves the head alone', () => {
    const { state } = run([
      { type: 'offer', items: [item(1)] },
      { type: 'pause' },
      { type: 'offer', items: [item(2), item(3)] },
      { type: 'offer', items: [item(3)] },
    ]);
    expect(state.paused).toBe(true);
    expect(ids(state.head)).toEqual(['e1']);
    expect(ids(state.buffered)).toEqual(['e3', 'e2']);
    expect(state.dropped).toBe(0);
  });

  it('counts what does not fit pausedCap as dropped', () => {
    const { state } = run([{ type: 'pause' }, { type: 'offer', items: [item(1), item(2), item(3), item(4), item(5)] }]);
    expect(state.buffered).toHaveLength(3);
    expect(state.dropped).toBe(2);
  });

  it('resume with nothing dropped merges the buffer in front of the head, deduped, with no effect', () => {
    const { state, effects } = run([
      { type: 'offer', items: [item(1)] },
      { type: 'pause' },
      { type: 'offer', items: [item(2), item(3)] },
      { type: 'resume' },
    ]);
    expect(state.paused).toBe(false);
    expect(ids(state.head)).toEqual(['e3', 'e2', 'e1']);
    expect(state.buffered).toEqual([]);
    expect(effects.at(-1)).toBe('none');
  });

  it('resume after items were dropped refetches the first page and clears both lists', () => {
    const { state, effects } = run([
      { type: 'offer', items: [item(1)] },
      { type: 'pause' },
      { type: 'offer', items: [item(2), item(3), item(4), item(5)] },
      { type: 'resume' },
    ]);
    expect(effects.at(-1)).toBe('refetch-first-page');
    expect(state.head).toEqual([]);
    expect(state.buffered).toEqual([]);
    expect(state.dropped).toBe(0);
    expect(state.paused).toBe(false);
  });

  it('resume that overflows headCap refetches instead of keeping an oversized head', () => {
    const o = options({ headCap: 3, pausedCap: 3 });
    const { state, effects } = run(
      [
        { type: 'offer', items: [item(1), item(2)] },
        { type: 'pause' },
        { type: 'offer', items: [item(3), item(4)] },
        { type: 'resume' },
      ],
      o,
    );
    expect(effects.at(-1)).toBe('refetch-first-page');
    expect(state.head).toEqual([]);
  });

  it('pausing twice or resuming while live is harmless', () => {
    const { state, effects } = run([{ type: 'resume' }, { type: 'pause' }, { type: 'pause' }, { type: 'resume' }]);
    expect(state.paused).toBe(false);
    expect(effects).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('liveBufferReducer snapshot and clear', () => {
  it('drops head and buffered items at or below asOfSeq (they are in the refetched page)', () => {
    const { state } = run([
      { type: 'offer', items: [item(1), item(2), item(3)] },
      { type: 'pause' },
      { type: 'offer', items: [item(4), item(5)] },
      { type: 'snapshot', asOfSeq: 3, seqOf: (t) => t.seq },
    ]);
    expect(state.head).toEqual([]);
    expect(ids(state.buffered)).toEqual(['e5', 'e4']);
    const later = run([
      { type: 'offer', items: [item(1), item(6)] },
      { type: 'snapshot', asOfSeq: 1, seqOf: (t) => t.seq },
    ]);
    expect(ids(later.state.head)).toEqual(['e6']);
  });

  it('does not show an item again after the snapshot removed it from the head', () => {
    const { state } = run([
      { type: 'offer', items: [item(1)] },
      { type: 'snapshot', asOfSeq: 1, seqOf: (t) => t.seq },
      { type: 'offer', items: [item(1)] },
    ]);
    expect(state.head).toEqual([]);
  });

  it('clear forgets everything, including what was seen', () => {
    const { state } = run([
      { type: 'offer', items: [item(1)] },
      { type: 'pause' },
      { type: 'offer', items: [item(2)] },
      { type: 'clear' },
      { type: 'offer', items: [item(1)] },
    ]);
    expect(ids(state.head)).toEqual(['e1']);
    expect(state.buffered).toEqual([]);
    expect(state.paused).toBe(false);
    expect(state.dropped).toBe(0);
  });

  it('bounds the seen set', () => {
    const o = options({ headCap: 2, pausedCap: 2 });
    let state = initialLiveBufferState<Item>();
    for (let i = 0; i < 500; i += 1) {
      state = liveBufferReducer(state, { type: 'offer', items: [item(i)] }, o).state;
    }
    expect(state.seen.size).toBeLessThanOrEqual(2 * (o.headCap + o.pausedCap));
  });
});

describe('createLiveBuffer (store)', () => {
  it('notifies subscribers, forwards the refetch effect and announces how many items a resume added', () => {
    const onEffect = vi.fn();
    const onResumed = vi.fn();
    const store = createLiveBuffer(options(), { onEffect, onResumed });
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.dispatch({ type: 'pause' });
    store.dispatch({ type: 'offer', items: [item(1), item(2)] });
    store.dispatch({ type: 'resume' });
    expect(onResumed).toHaveBeenCalledWith(2);
    expect(ids(store.getState().head)).toEqual(['e2', 'e1']);
    expect(seen).toHaveBeenCalled();
    store.dispatch({ type: 'offer', items: [item(3), item(4), item(5), item(6)] });
    expect(onEffect).toHaveBeenCalledWith('refetch-first-page');
    off();
    const calls = seen.mock.calls.length;
    store.dispatch({ type: 'clear' });
    expect(seen.mock.calls.length).toBe(calls);
  });

  it('does not announce a resume that refetches', () => {
    const onResumed = vi.fn();
    const store = createLiveBuffer(options({ pausedCap: 1 }), { onResumed });
    store.dispatch({ type: 'pause' });
    store.dispatch({ type: 'offer', items: [item(1), item(2)] });
    store.dispatch({ type: 'resume' });
    expect(onResumed).not.toHaveBeenCalled();
  });
});

describe('createLiveBufferRegistry', () => {
  it('offers events to every mounted buffer and stops after unregister', () => {
    const registry = createLiveBufferRegistry();
    const a = handle();
    const b = handle();
    const offA = registry.register(a);
    registry.register(b);
    const events = [makeEvent({ id: 1 })];
    registry.offer(events);
    expect(a.offer).toHaveBeenCalledWith(events);
    expect(b.offer).toHaveBeenCalledWith(events);
    offA();
    registry.offer(events);
    expect(a.offer).toHaveBeenCalledTimes(1);
    expect(b.offer).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(1);
  });

  it('forwards refetch, tool-call patches and clear to every buffer', () => {
    const registry = createLiveBufferRegistry();
    const a = handle();
    registry.register(a);
    const calls = [toolCall()];
    registry.refetchFirstPage();
    registry.patchToolCalls(calls);
    registry.clear();
    expect(a.refetchFirstPage).toHaveBeenCalledTimes(1);
    expect(a.patchToolCalls).toHaveBeenCalledWith(calls);
    expect(a.clear).toHaveBeenCalledTimes(1);
  });

  it('survives a buffer that throws (the others still get the events)', () => {
    const registry = createLiveBufferRegistry();
    const bad = handle();
    vi.mocked(bad.offer).mockImplementation(() => {
      throw new Error('boom');
    });
    const good = handle();
    registry.register(bad);
    registry.register(good);
    registry.offer([]);
    expect(good.offer).toHaveBeenCalledTimes(1);
  });
});
