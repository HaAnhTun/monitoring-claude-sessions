import type { Page, SessionSummary, StreamChange, StreamHello } from '@mcs/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import { StrictMode, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStreamLive } from '../data/hooks/useInstance.ts';
import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import {
  FIXTURE_EPOCH,
  FIXTURE_INSTANCE_ID,
  iso,
  makeHealth,
  makeInstance,
  makeSession,
  makeSessionPage,
} from '../test/fixtures/index.ts';
import { renderWithProviders } from '../test/render.tsx';
import { IDLE_STREAM_SNAPSHOT, StreamProvider, useStreamControls, useStreamSnapshot } from './StreamProvider.tsx';

const IID = FIXTURE_INSTANCE_ID;
const INSTANCE = makeInstance();
const LIST_KEY = qk.sessions(IID, {});

function hello(over: Partial<StreamHello> = {}): StreamHello {
  return {
    instanceId: IID,
    epoch: FIXTURE_EPOCH,
    headSeq: INSTANCE.headSeq,
    heartbeatMs: 15_000,
    serverTime: iso(0),
    runtimeVersion: INSTANCE.runtimeVersion,
    codeStamp: INSTANCE.codeStamp,
    ...over,
  };
}

function sessionChange(seq: number, data: SessionSummary): StreamChange {
  return {
    seq,
    at: iso(0),
    instanceId: IID,
    kind: 'session',
    op: 'upsert',
    sessionId: data.id,
    data,
  };
}

function Probe(): ReactElement {
  const snapshot = useStreamSnapshot();
  const live = useStreamLive();
  const controls = useStreamControls();
  return (
    <>
      <p data-testid="probe">{`${snapshot.status}|${String(live)}|${controls?.monitorUpdated?.codeStamp ?? 'none'}`}</p>
      <p data-testid="ledger">{String(controls?.ledger.size ?? -1)}</p>
    </>
  );
}

let sources: FakeEventSources;

beforeEach(() => {
  vi.useFakeTimers();
  sources = createFakeEventSources();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(options: { strict?: boolean; instanceId?: string | null } = {}) {
  const queryClient = createQueryClient({ retry: false });
  const tree = (
    <StreamProvider esFactory={sources.factory} windowTarget={new EventTarget()}>
      <Probe />
    </StreamProvider>
  );
  const rendered = renderWithProviders(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree, {
    queryClient,
    instance: INSTANCE,
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
  });
  return { ...rendered, queryClient };
}

function openAndHello(over: Partial<StreamHello> = {}): void {
  act(() => {
    sources.last().open();
    sources.last().emit('hello', hello(over));
  });
}

const probe = (): string => screen.getByTestId('probe').textContent;

describe('StreamProvider', () => {
  it('starts one client with since=headSeq and the instance epoch, and reports live while the stream is open', () => {
    mount();
    expect(sources.urls()).toEqual([`/api/v3/stream?since=${String(INSTANCE.headSeq)}&epoch=${FIXTURE_EPOCH}`]);
    expect(probe()).toBe('connecting|false|none');
    openAndHello();
    expect(probe()).toBe('open|true|none');
  });

  it('waits for the instance info before it opens a source', async () => {
    mount({ instanceId: null });
    // the cached instance is seeded by the harness only when an id is given: nothing is known yet
    expect(sources.instances).toHaveLength(0);
    expect(probe()).toBe('idle|false|none');
    await flush();
    expect(sources.instances).toHaveLength(1);
  });

  it('applies a change frame to the query cache after the flush window', async () => {
    const { queryClient } = mount();
    const row = makeSession({ seq: 1, label: 'before' });
    queryClient.setQueryData<InfiniteData<Page<SessionSummary>>>(LIST_KEY, {
      pages: [makeSessionPage([row])],
      pageParams: [null],
    });
    openAndHello();
    act(() => {
      sources.last().emit('change', sessionChange(11, makeSession({ seq: 5, label: 'after' })));
    });
    await flush(100);
    const data = queryClient.getQueryData<InfiniteData<Page<SessionSummary>>>(LIST_KEY);
    expect(data?.pages[0]?.items[0]?.label).toBe('after');
  });

  it('protects a patched entity from an older snapshot that lands later (R4 is installed)', async () => {
    const { queryClient } = mount();
    openAndHello();
    act(() => {
      sources.last().emit('change', sessionChange(11, makeSession({ seq: 9, label: 'patched' })));
    });
    await flush(100);
    queryClient.setQueryData<InfiniteData<Page<SessionSummary>>>(LIST_KEY, {
      pages: [makeSessionPage([makeSession({ seq: 7, label: 'stale' })], { asOfSeq: 8 })],
      pageParams: [null],
    });
    const data = queryClient.getQueryData<InfiniteData<Page<SessionSummary>>>(LIST_KEY);
    expect(data?.pages[0]?.items[0]?.label).toBe('patched');
  });

  it('a reset frame runs R5: patches forgotten, instance queries invalidated', async () => {
    const { queryClient } = mount();
    queryClient.setQueryData(qk.health(IID), makeHealth());
    openAndHello();
    act(() => {
      sources.last().emit('change', sessionChange(11, makeSession({ seq: 9 })));
    });
    await flush(100);
    expect(screen.getByTestId('ledger').textContent).toBe('1');
    act(() => {
      sources.last().emit('reset', { headSeq: 50, reason: 'cursor_too_old' });
    });
    await flush(100);
    expect(screen.getByTestId('ledger').textContent).toBe('0');
    expect(queryClient.getQueryState(qk.health(IID))?.isInvalidated).toBe(true);
  });

  it('a new epoch refetches the instance and offers a reload when the code differs', async () => {
    const { api } = mount();
    expect(api.callsTo('instance')).toHaveLength(0);
    openAndHello({ epoch: 'ffeeddcc', runtimeVersion: '3.1.0', codeStamp: 'stamp-2' });
    await flush(100);
    expect(api.callsTo('instance')).toHaveLength(1);
    expect(probe()).toContain('stamp-2');
  });

  it('a new epoch with the same code does not offer a reload', async () => {
    mount();
    openAndHello({ epoch: 'ffeeddcc' });
    await flush(100);
    expect(probe().endsWith('|none')).toBe(true);
  });

  it('another instance id empties the cache except the boot query and stops the client', async () => {
    const { queryClient } = mount();
    queryClient.setQueryData(qk.health(IID), makeHealth());
    queryClient.setQueryData(LIST_KEY, { pages: [makeSessionPage([makeSession()])], pageParams: [null] });
    act(() => {
      sources.last().open();
      sources.last().emit('hello', hello({ instanceId: '22222222-2222-4222-8222-222222222222' }));
    });
    await flush();
    expect(queryClient.getQueryData(qk.health(IID))).toBeUndefined();
    expect(queryClient.getQueryData(LIST_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(qk.instance())).toBeDefined();
    expect(sources.last().closed).toBe(true);
  });

  it('unmounting closes the source and leaves no stream timer behind', async () => {
    const { unmount, queryClient } = mount();
    openAndHello();
    act(() => {
      sources.last().emit('change', sessionChange(11, makeSession({ seq: 2 })));
    });
    unmount();
    expect(sources.last().closed).toBe(true);
    queryClient.clear();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives Strict Mode: start, stop, start leaves exactly one live source', () => {
    mount({ strict: true });
    expect(sources.instances.filter((es) => !es.closed)).toHaveLength(1);
    expect(sources.instances.length).toBeGreaterThanOrEqual(1);
    openAndHello();
    expect(probe()).toBe('open|true|none');
  });

  it('shows polling (live false) once the stream fails, and retryNow reconnects', async () => {
    function Retry(): ReactElement {
      const controls = useStreamControls();
      return (
        <button
          type="button"
          onClick={() => {
            controls?.retryNow();
          }}
        >
          retry
        </button>
      );
    }
    renderWithProviders(
      <StreamProvider esFactory={sources.factory} windowTarget={new EventTarget()}>
        <Probe />
        <Retry />
      </StreamProvider>,
      { instance: INSTANCE },
    );
    openAndHello();
    act(() => {
      sources.last().fail();
    });
    expect(probe()).toBe('backoff|false|none');
    act(() => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    expect(sources.instances).toHaveLength(2);
    expect(probe().startsWith('connecting')).toBe(true);
    await flush();
  });
});

describe('without a provider', () => {
  it('the snapshot is the idle one and nothing is live', () => {
    renderWithProviders(<Probe />, { instance: INSTANCE });
    expect(probe()).toBe('idle|false|none');
    expect(IDLE_STREAM_SNAPSHOT.status).toBe('idle');
  });
});
