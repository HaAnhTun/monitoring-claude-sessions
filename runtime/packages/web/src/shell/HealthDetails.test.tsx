import { routes } from '@mcs/shared';
import { act, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import { fmtClock } from '../lib/format.ts';
import { StreamProvider } from '../stream/StreamProvider.tsx';
import { createFakeApi, errorResponse } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import {
  FIXTURE_EPOCH,
  FIXTURE_INSTANCE_ID,
  iso,
  makeHealth,
  makeInstance,
  sessionId,
} from '../test/fixtures/index.ts';
import { renderWithProviders } from '../test/render.tsx';
import { HealthDetails } from './HealthDetails.tsx';

// 04 4.4 `HealthDetails`: per endpoint "name: ok 3s ago; N failures in a row, last: msg", the stream line, the runtime line, the
// server errors (newest first), the epoch and the last stream reset reason.
const INSTANCE = makeInstance({ staleAfterMs: 30_000 });
const START = new Date('2026-10-12T12:00:00Z');

let sources: FakeEventSources;
let healthFails = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sources = createFakeEventSources();
  healthFails = false;
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

function setup(report = makeHealth('ok'), options: { stream?: boolean } = {}) {
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () => (healthFails ? errorResponse('internal_error', 'FIXTURE health failure') : report),
  });
  const queryClient = createQueryClient({ retry: false });
  queryClient.setQueryData(qk.health(FIXTURE_INSTANCE_ID), report);
  return renderWithProviders(<HealthDetails />, {
    instance: INSTANCE,
    api,
    queryClient,
    ...(options.stream === true ? { wrap: withStream } : {}),
  });
}

async function pollCore(rendered: ReturnType<typeof setup>): Promise<void> {
  await act(async () => {
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
    await rendered.apiClient.get('health', routes.health.path, routes.health.response);
  });
}

function streamOpen(): void {
  const headSeq = INSTANCE.headSeq;
  act(() => {
    sources.last().open();
    sources.last().emit('hello', {
      instanceId: FIXTURE_INSTANCE_ID,
      epoch: FIXTURE_EPOCH,
      headSeq,
      heartbeatMs: 15_000,
      serverTime: iso(0),
      runtimeVersion: INSTANCE.runtimeVersion,
      codeStamp: INSTANCE.codeStamp,
    });
    sources.last().emit('heartbeat', { headSeq, epoch: FIXTURE_EPOCH, serverTime: iso(0) });
  });
}

describe('HealthDetails', () => {
  it('lists every endpoint with the age of its last success', async () => {
    const rendered = setup();
    await pollCore(rendered);
    await flush(3_000);
    expect(screen.getByText('instance: ok 3s ago')).toBeInTheDocument();
    expect(screen.getByText('health: ok 3s ago')).toBeInTheDocument();
  });

  it('shows the failures in a row and the last message of a failing endpoint', async () => {
    const rendered = setup();
    await pollCore(rendered);
    healthFails = true;
    await act(async () => {
      for (let i = 0; i < 2; i += 1) {
        await rendered.apiClient.get('health', routes.health.path, routes.health.response).catch(() => undefined);
      }
    });
    await flush(2_000);
    expect(
      screen.getByText(/^health: ok 2s ago; 2 failures in a row, last: .*FIXTURE health failure/),
    ).toBeInTheDocument();
  });

  it('says so when an endpoint never succeeded', async () => {
    const rendered = setup();
    healthFails = true;
    await act(async () => {
      await rendered.apiClient.get('health', routes.health.path, routes.health.response).catch(() => undefined);
    });
    expect(screen.getByText(/^health: never succeeded; 1 failure in a row, last: /)).toBeInTheDocument();
  });

  it('says that no endpoint was called yet', () => {
    setup();
    expect(screen.getByText('No request has been made yet.')).toBeInTheDocument();
  });

  it('describes the stream: connected since, last event number and invalid messages', async () => {
    const rendered = setup(makeHealth('ok'), { stream: true });
    await pollCore(rendered);
    streamOpen();
    act(() => {
      sources.last().emit('change', {
        seq: INSTANCE.headSeq + 1,
        at: iso(0),
        instanceId: FIXTURE_INSTANCE_ID,
        kind: 'usage',
        op: 'invalidate',
        sessionId: sessionId(1),
        data: { sessionId: sessionId(1) },
      });
      sources.last().emit('change', '{not json');
    });
    await flush(1_000);
    const clock = fmtClock(START.toISOString());
    expect(
      screen.getByText(
        `Live updates: connected since ${clock}, last event #${String(INSTANCE.headSeq + 1)}, 1 invalid message`,
      ),
    ).toBeInTheDocument();
  });

  it('describes a stream that is not connected', () => {
    setup(makeHealth('ok'), { stream: true });
    expect(screen.getByText(/^Live updates: not connected/)).toBeInTheDocument();
  });

  it('shows the runtime line and flags an outdated server', () => {
    const report = makeHealth('ok');
    setup({ ...report, runtime: { ...report.runtime, outdated: true } });
    expect(screen.getByText(/^Server: version 3\.0\.0, pid 4242, up 2h/)).toHaveTextContent(
      'restart needed (the code changed)',
    );
  });

  it('shows the epoch and when the server started, with the restart note', () => {
    setup();
    const line = screen.getByText(/^Server epoch /);
    expect(line).toHaveTextContent(FIXTURE_EPOCH);
    expect(line).toHaveTextContent('a new epoch means the server restarted');
  });

  it('lists the server errors newest first', () => {
    const report = makeHealth('degraded');
    const error = (at: string, message: string) => ({
      at,
      source: 'server',
      code: 'internal_error',
      where: null,
      message,
      sessionId: null,
    });
    setup({ ...report, errors: [error(iso(-1), 'FIXTURE newest'), error(iso(-60), 'FIXTURE older')] });
    const list = screen.getByRole('list', { name: 'Server errors' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('FIXTURE newest');
    expect(items[1]).toHaveTextContent('FIXTURE older');
  });

  it('says there are no server errors', () => {
    setup();
    expect(screen.getByText('No server errors recorded.')).toBeInTheDocument();
  });

  it('shows the reason of the last stream reset when there was one', async () => {
    const rendered = setup(makeHealth('ok'), { stream: true });
    await pollCore(rendered);
    streamOpen();
    act(() => {
      sources.last().emit('reset', { headSeq: INSTANCE.headSeq, reason: 'cursor_too_old' });
    });
    await flush(1_000);
    expect(screen.getByText('Last stream reset: cursor_too_old')).toBeInTheDocument();
  });

  it('says there was no stream reset otherwise', () => {
    setup();
    expect(screen.getByText('Last stream reset: none')).toBeInTheDocument();
  });

  it('works without a health report (the server was never reached)', () => {
    const api = createFakeApi({ instance: () => INSTANCE });
    renderWithProviders(<HealthDetails />, { instance: INSTANCE, api });
    expect(screen.getByText('No health report received yet.')).toBeInTheDocument();
  });
});
