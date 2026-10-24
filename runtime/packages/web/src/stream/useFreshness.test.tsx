import { routes } from '@mcs/shared';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { createFormatters } from '../i18n/format.ts';
import { createFakeApi } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso, makeHealth, makeInstance } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderHookWithProviders } from '../test/render.tsx';
import { StreamProvider } from './StreamProvider.tsx';
import { useFreshness } from './useFreshness.ts';

const INSTANCE = makeInstance({ staleAfterMs: 30_000 });
const START = new Date('2026-10-12T12:00:00Z');

let sources: FakeEventSources;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sources = createFakeEventSources();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function withStream(children: ReactNode): ReactNode {
  return (
    <StreamProvider esFactory={sources.factory} windowTarget={new EventTarget()}>
      {children}
    </StreamProvider>
  );
}

function setup(options: { stream?: boolean; announce?: (m: string) => void; locale?: 'en' | 'vi' } = {}) {
  const api = createFakeApi({ instance: () => INSTANCE, health: () => makeHealth('ok') });
  const rendered = renderHookWithProviders(
    () => useFreshness({ ...(options.announce === undefined ? {} : { announce: options.announce }) }),
    {
      instance: INSTANCE,
      api,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.stream === true ? { wrap: withStream } : {}),
    },
  );
  rendered.queryClient.setQueryData(qk.health(FIXTURE_INSTANCE_ID), makeHealth('ok'));
  return rendered;
}

/** Makes the API client record successes for `instance` and `health`, as the shell's polling does. */
async function pollCore(rendered: ReturnType<typeof setup>): Promise<void> {
  await act(async () => {
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
    await rendered.apiClient.get('health', routes.health.path, routes.health.response);
  });
}

function streamOpen(): void {
  act(() => {
    sources.last().open();
    sources.last().emit('hello', {
      instanceId: FIXTURE_INSTANCE_ID,
      epoch: FIXTURE_EPOCH,
      headSeq: INSTANCE.headSeq,
      heartbeatMs: 15_000,
      serverTime: iso(0),
      runtimeVersion: INSTANCE.runtimeVersion,
      codeStamp: INSTANCE.codeStamp,
    });
    sources.last().emit('heartbeat', { headSeq: INSTANCE.headSeq, epoch: FIXTURE_EPOCH, serverTime: iso(0) });
  });
}

describe('useFreshness', () => {
  it('is connecting before anything was fetched', () => {
    const { result } = setup();
    expect(result.current.connection.state).toBe('connecting');
    expect(result.current.connectionChip.textKey).toBe('live.conn.connecting');
    expect(result.current.staleLine).toBeNull();
  });

  it('polls without a stream: Live updates paused, with the polled health shown', async () => {
    const rendered = setup();
    await pollCore(rendered);
    expect(rendered.result.current.connection.state).toBe('polling');
    expect(rendered.result.current.connectionChip).toMatchObject({
      textKey: 'live.conn.polling',
      args: { seconds: 6 },
    });
    expect(rendered.result.current.ingestionChip.textKey).toBe('live.ingest.ok');
  });

  it('is live while the stream is open and in sync, and moves to paused when it drops', async () => {
    const announce = vi.fn<(m: string) => void>();
    const rendered = setup({ stream: true, announce });
    await pollCore(rendered);
    streamOpen();
    await flush(1_000);
    expect(rendered.result.current.connectionChip).toMatchObject({ textKey: 'live.conn.live', tone: 'ok' });
    act(() => {
      sources.last().fail();
    });
    await flush(1_000);
    expect(rendered.result.current.connection.state).toBe('polling');
    expect(announce).toHaveBeenCalledWith(msg('freshness.announce.paused'));
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('marks the data stale after staleAfterMs and shows when it was last in sync', async () => {
    const rendered = setup();
    await pollCore(rendered);
    expect(rendered.result.current.staleLine).toBeNull();
    await flush(31_000);
    expect(rendered.result.current.connection.stale).toBe(true);
    expect(rendered.result.current.staleLine).toEqual({ lastSyncAt: START.getTime(), ageSeconds: 31 });
    expect(rendered.result.current.connectionChip.textKey).toBe('live.conn.pollingFailing');
    expect(rendered.result.current.ingestionChip.textKey).toBe('live.ingest.unknown');
  });

  it('announces the stale transition once', async () => {
    const announce = vi.fn<(m: string) => void>();
    const rendered = setup({ announce });
    await pollCore(rendered);
    await flush(31_000);
    expect(announce.mock.calls.map(([m]) => m)).toEqual([msg('freshness.announce.stale', { age: '31s' })]);
    await flush(5_000);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('announces in the language that is shown', async () => {
    const announce = vi.fn<(m: string) => void>();
    const rendered = setup({ announce, locale: 'vi' });
    await pollCore(rendered);
    await flush(31_000);
    expect(announce.mock.calls.map(([m]) => m)).toEqual([
      msg('freshness.announce.stale', { age: createFormatters('vi').age(31) }, 'vi'),
    ]);
  });

  it('follows the browser: offline shows Offline', async () => {
    const rendered = setup();
    await pollCore(rendered);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(rendered.result.current.connectionChip.textKey).toBe('live.conn.offline');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(rendered.result.current.connection.state).toBe('polling');
  });

  it('stops its timer when unmounted', () => {
    const rendered = setup();
    rendered.unmount();
    rendered.queryClient.clear();
    // the query cache schedules its own zero-delay notification; the hook's tick (1 s) is what must be gone
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
