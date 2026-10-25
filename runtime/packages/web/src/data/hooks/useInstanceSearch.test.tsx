import type { InstanceSearchResponse } from '@mcs/shared';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeApi, errorResponse, type FakeHandler } from '../../test/fake-api.ts';
import { makeInstance, makeInstanceSearch, makeInstanceSearchMatch } from '../../test/fixtures/index.ts';
import { renderHookWithProviders } from '../../test/render.tsx';
import { qk } from '../query-keys.ts';
import { useInstanceSearch } from './useInstanceSearch.ts';

const INSTANCE = makeInstance();
const IID = INSTANCE.instanceId;

interface Props {
  q: Record<string, string> | null;
}

function answerOf(q: string, over: Partial<InstanceSearchResponse> = {}): InstanceSearchResponse {
  return makeInstanceSearch({
    query: { q, kinds: [] },
    matches: [makeInstanceSearchMatch({ snippet: `FIXTURE ${q}` })],
    ...over,
  });
}

function setup(handler: FakeHandler, initial: Props = { q: null }) {
  const api = createFakeApi({ instance: () => INSTANCE, searchTranscripts: handler });
  const rendered = renderHookWithProviders((props: Props) => useInstanceSearch(props.q), {
    api,
    instance: INSTANCE,
    initialProps: initial,
  });
  return rendered;
}

/** A request that stays open until `release` is called with its answer. */
function pending() {
  const waiting: Record<string, (body: InstanceSearchResponse) => void> = {};
  const handler: FakeHandler = (query) =>
    new Promise<InstanceSearchResponse>((resolve) => {
      waiting[query.get('q') ?? ''] = resolve;
    });
  return { handler, release: (q: string, body: InstanceSearchResponse) => waiting[q]?.(body) };
}

describe('useInstanceSearch', () => {
  it('sends nothing until a query is submitted, then sends every parameter', async () => {
    const { api, result, rerender } = setup((query) => answerOf(query.get('q') ?? ''));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.callsTo('searchTranscripts')).toHaveLength(0);
    expect(result.current.status).toBe('idle');
    rerender({ q: { q: 'needle', kinds: 'tool,result', limit: '100', budgetMs: '3000' } });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const call = api.callsTo('searchTranscripts')[0];
    expect(call?.query.get('q')).toBe('needle');
    expect(call?.query.get('kinds')).toBe('tool,result');
    expect(call?.query.get('limit')).toBe('100');
    expect(call?.query.get('budgetMs')).toBe('3000');
    expect(result.current.data?.matches).toHaveLength(1);
  });

  it('keys the cache by every parameter and by the instance', async () => {
    const { result, rerender, queryClient } = setup((query) => answerOf(query.get('q') ?? ''));
    rerender({ q: { q: 'needle', kinds: 'tool' } });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(queryClient.getQueryState(qk.instanceSearch(IID, { q: 'needle', kinds: 'tool' }))).toBeDefined();
    expect(queryClient.getQueryState(qk.instanceSearch(IID, { q: 'needle' }))).toBeUndefined();
    expect(qk.instanceSearch(IID, { q: 'a' }).slice(0, 2)).toEqual(['mcs', IID]);
  });

  it('aborts the previous request when the query changes', async () => {
    const signals: (AbortSignal | null)[] = [];
    const server = pending();
    const { result, rerender } = setup((query, request) => {
      signals.push(request.signal);
      return server.handler(query, request);
    });
    rerender({ q: { q: 'first' } });
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(result.current.status).toBe('loading');
    rerender({ q: { q: 'second' } });
    await waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('drops the answer of a query that is no longer the current one', async () => {
    const server = pending();
    const { result, rerender } = setup(server.handler);
    rerender({ q: { q: 'first' } });
    rerender({ q: { q: 'second' } });
    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });
    await act(async () => {
      server.release('first', answerOf('first'));
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();
    await act(async () => {
      server.release('second', answerOf('second'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data?.query.q).toBe('second');
  });

  it('drops an answer that echoes another text than the one asked', async () => {
    const { result, rerender } = setup(() => answerOf('something else'));
    rerender({ q: { q: 'needle' } });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.data).toBeNull();
    expect(result.current.dropped).toBe(true);
  });

  it('reports a failure with its error, and runs again on request', async () => {
    let busy = true;
    const { result, rerender, api } = setup((query) =>
      busy ? errorResponse('search_busy') : answerOf(query.get('q') ?? ''),
    );
    rerender({ q: { q: 'needle' } });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.info.code).toBe('search_busy');
    busy = false;
    act(() => {
      result.current.search();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(api.callsTo('searchTranscripts')).toHaveLength(2);
  });

  it('searches the same text again on request instead of serving the cache', async () => {
    const { result, rerender, api } = setup((query) => answerOf(query.get('q') ?? ''));
    rerender({ q: { q: 'needle' } });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    act(() => {
      result.current.search();
    });
    await waitFor(() => {
      expect(api.callsTo('searchTranscripts')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });

  it('cancels the running request and says so', async () => {
    const signals: (AbortSignal | null)[] = [];
    const server = pending();
    const { result, rerender } = setup((query, request) => {
      signals.push(request.signal);
      return server.handler(query, request);
    });
    rerender({ q: { q: 'needle' } });
    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });
    act(() => {
      result.current.cancel();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('cancelled');
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.data).toBeNull();
  });
});
