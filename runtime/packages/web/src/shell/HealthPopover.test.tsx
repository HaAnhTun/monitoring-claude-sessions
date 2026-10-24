import { routes, type HealthReport } from '@mcs/shared';
import { act, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import { createFormatters } from '../i18n/format.ts';
import type { EndpointRecord } from '../lib/connection-health.ts';
import { describeFreshness, type Freshness } from '../stream/freshness.ts';
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
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { HealthPopover, MAX_ERRORS_SHOWN } from './HealthPopover.tsx';

// ADR 0073 decision 5, review R-24: four sections (Connection, Ingestion, Server, Errors), each with a status dot; the endpoint
// lines, the stream line, the server facts and flags, the capped list of server errors, the link to the settings.
const INSTANCE = makeInstance({ staleAfterMs: 30_000 });
const START = new Date('2026-10-12T12:00:00Z');
const NOW = START.getTime();
const format = createFormatters('en');

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

function freshnessFor(health: HealthReport | null, over: { synced?: boolean } = {}): Freshness {
  const lastSuccess = over.synced === false ? NOW - 60_000 : NOW - 1_000;
  const record = (name: string): EndpointRecord => ({
    name,
    lastSuccess,
    failures: 0,
    lastError: null,
  });
  return describeFreshness({
    now: NOW,
    staleAfterMs: INSTANCE.staleAfterMs,
    online: true,
    pollSeconds: 6,
    stream: {
      status: over.synced === false ? 'backoff' : 'open',
      inSyncAt: over.synced === false ? NOW - 60_000 : NOW - 1_000,
      nextRetryAt: null,
      lastError: null,
    },
    core: [record('instance'), record('health')],
    health: health ?? undefined,
    healthRecord: health === null ? null : record('health'),
  });
}

function setup(report: HealthReport | null = makeHealth('ok'), options: { stream?: boolean; synced?: boolean } = {}) {
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () =>
      healthFails ? errorResponse('internal_error', 'FIXTURE health failure') : (report ?? makeHealth('ok')),
  });
  const queryClient = createQueryClient({ retry: false });
  if (report !== null) queryClient.setQueryData(qk.health(FIXTURE_INSTANCE_ID), report);
  const freshness = freshnessFor(report, options.synced === undefined ? {} : { synced: options.synced });
  return renderWithProviders(<HealthPopover freshness={freshness} />, {
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

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name });
  const found = heading.closest('section');
  if (found === null) throw new Error(`no section ${name}`);
  return found;
}

function serverError(at: string, message: string, code = 'internal_error') {
  return { at, source: 'server', code, where: null, message, sessionId: null };
}

describe('HealthPopover: the four sections', () => {
  it('has Connection, Ingestion, Server and Errors, in that order, each with its own status dot', () => {
    setup();
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      msg('live.section.connection'),
      msg('live.section.ingestion'),
      msg('live.section.server'),
      msg('live.section.errors'),
    ]);
    for (const heading of headings) {
      const dot = heading.querySelector('.live-dot');
      expect(dot).not.toBeNull();
      expect(dot).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('the dots carry the tone of the section: live is ok, a degraded ingestion is stale', () => {
    const report = makeHealth('degraded');
    setup({ ...report, ingestion: { ...report.ingestion, status: 'degraded', reasons: ['spool is full'] } });
    const tone = (name: string) =>
      section(name).querySelector('.live-section__title .live-dot')?.getAttribute('data-tone');
    expect(tone(msg('live.section.connection'))).toBe('ok');
    expect(tone(msg('live.section.ingestion'))).toBe('stale');
    expect(tone(msg('live.section.server'))).toBe('ok');
    expect(tone(msg('live.section.errors'))).toBe('ok');
  });

  it('links to the health section of the settings', () => {
    setup();
    expect(screen.getByRole('link', { name: msg('live.popover.settings') })).toHaveAttribute(
      'href',
      '/settings?section=health',
    );
  });
});

describe('HealthPopover: Connection', () => {
  it('says the state of the connection in words', () => {
    setup();
    expect(within(section(msg('live.section.connection'))).getByText(msg('live.conn.live'))).toHaveAttribute(
      'data-connection',
      'live',
    );
  });

  it('lists every endpoint with the age of its last success', async () => {
    const rendered = setup();
    await pollCore(rendered);
    await flush(3_000);
    expect(screen.getByText('instance').closest('li')).toHaveTextContent(
      `instance ${msg('live.endpoint.ok', { age: '3s' })}`,
    );
    expect(screen.getByText('health').closest('li')).toHaveTextContent(
      `health ${msg('live.endpoint.ok', { age: '3s' })}`,
    );
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
    const line = screen.getByText('health').closest('li');
    expect(line).toHaveTextContent(msg('live.endpoint.ok', { age: '2s' }));
    expect(line).toHaveTextContent(msg('live.endpoint.failing', { count: 2 }));
    expect(line).toHaveTextContent('FIXTURE health failure');
    expect(line?.querySelector('.live-dot')).toHaveAttribute('data-tone', 'failed');
  });

  it('says so when an endpoint never succeeded', async () => {
    const rendered = setup();
    healthFails = true;
    await act(async () => {
      await rendered.apiClient.get('health', routes.health.path, routes.health.response).catch(() => undefined);
    });
    const line = screen.getByText('health').closest('li');
    expect(line).toHaveTextContent(msg('live.endpoint.never'));
    expect(line).toHaveTextContent(msg('live.endpoint.failing', { count: 1 }));
  });

  it('says that no endpoint was called yet', () => {
    setup();
    expect(screen.getByText(msg('live.endpoints.none'))).toBeInTheDocument();
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
    const connection = section(msg('live.section.connection'));
    expect(
      within(connection).getByText(msg('live.stream.connected', { time: format.clock(START) })),
    ).toBeInTheDocument();
    expect(
      within(connection).getByText(msg('live.stream.lastEvent', { seq: INSTANCE.headSeq + 1 })),
    ).toBeInTheDocument();
    expect(within(connection).getByText(msg('live.stream.invalid', { count: 1 }))).toBeInTheDocument();
  });

  it('describes a stream that is not connected', () => {
    setup(makeHealth('ok'), { stream: true });
    expect(
      screen.getByText(msg('live.stream.notConnected', { status: msg('live.stream.status.connecting') })),
    ).toBeInTheDocument();
    expect(screen.getByText(msg('live.stream.noEvent'))).toBeInTheDocument();
  });

  it('says nothing about resets and invalid messages while there were none, and the reason of a reset when there was one', async () => {
    const rendered = setup(makeHealth('ok'), { stream: true });
    expect(screen.queryByText(/cursor_too_old/)).toBeNull();
    expect(screen.queryByText(msg('live.stream.invalid', { count: 0 }))).toBeNull();
    expect(screen.queryByText(msg('live.stream.reset', { reason: '' }).trim())).toBeNull();
    await pollCore(rendered);
    streamOpen();
    act(() => {
      sources.last().emit('reset', { headSeq: INSTANCE.headSeq, reason: 'cursor_too_old' });
    });
    await flush(1_000);
    expect(screen.getByText(msg('live.stream.reset', { reason: 'cursor_too_old' }))).toBeInTheDocument();
  });
});

describe('HealthPopover: Ingestion', () => {
  it('says OK while the client is in sync and the server says so', () => {
    setup();
    expect(within(section(msg('live.section.ingestion'))).getByText(msg('live.ingest.ok'))).toBeInTheDocument();
  });

  it('lists every reason the server gave, as the server wrote it', () => {
    const report = makeHealth('degraded');
    setup({
      ...report,
      ingestion: {
        ...report.ingestion,
        status: 'degraded',
        reasons: ['12 hook envelopes rejected in the last hour', 'second reason'],
      },
    });
    const ingestion = section(msg('live.section.ingestion'));
    expect(within(ingestion).getByText(msg('live.ingest.degraded'))).toBeInTheDocument();
    const list = within(ingestion).getAllByRole('listitem');
    expect(list.map((item) => item.textContent)).toEqual([
      '12 hook envelopes rejected in the last hour',
      'second reason',
    ]);
  });

  it('never says OK while the client is not in sync: unknown, with the last known status and its age', () => {
    setup(makeHealth('ok'), { synced: false });
    const ingestion = section(msg('live.section.ingestion'));
    expect(within(ingestion).getByText(msg('live.ingest.unknown'))).toBeInTheDocument();
    expect(within(ingestion).queryByText(msg('live.ingest.ok'))).toBeNull();
    expect(
      within(ingestion).getByText(msg('live.ingest.lastKnown', { status: msg('live.ingest.status.ok'), age: '60s' })),
    ).toBeInTheDocument();
  });

  it('is unknown before any health report arrived', () => {
    setup(null);
    const ingestion = section(msg('live.section.ingestion'));
    expect(within(ingestion).getByText(msg('live.ingest.unknown'))).toBeInTheDocument();
  });
});

describe('HealthPopover: Server', () => {
  it('shows version, epoch, uptime and start time, with the restart note', () => {
    const report = makeHealth('ok');
    setup(report);
    const server = section(msg('live.section.server'));
    expect(within(server).getByText(report.runtime.version)).toBeInTheDocument();
    expect(within(server).getByText(FIXTURE_EPOCH)).toBeInTheDocument();
    expect(within(server).getByText(format.duration(report.runtime.uptimeMs / 1000))).toBeInTheDocument();
    expect(within(server).getByText(format.clock(report.runtime.startedAt))).toBeInTheDocument();
    expect(within(server).getByText(msg('live.server.epochNote'))).toBeInTheDocument();
  });

  it('flags nothing on a healthy server', () => {
    setup();
    const server = section(msg('live.section.server'));
    expect(within(server).queryByText(msg('live.server.unclean'))).toBeNull();
    expect(within(server).queryByText(msg('live.server.conflict'))).toBeNull();
    expect(within(server).queryByText(msg('live.server.restartNeeded'))).toBeNull();
  });

  it('flags an outdated server as stale', () => {
    const report = makeHealth('ok');
    setup({ ...report, runtime: { ...report.runtime, outdated: true } });
    const server = section(msg('live.section.server'));
    expect(within(server).getByText(msg('live.server.restartNeeded'))).toBeInTheDocument();
    expect(server.querySelector('.live-section__title .live-dot')).toHaveAttribute('data-tone', 'stale');
  });

  it('flags a previous run that ended uncleanly', () => {
    const report = makeHealth('ok');
    setup({ ...report, runtime: { ...report.runtime, previousRunUnclean: true } });
    const server = section(msg('live.section.server'));
    expect(within(server).getByText(msg('live.server.unclean'))).toBeInTheDocument();
    expect(within(server).queryByText(msg('live.server.conflict'))).toBeNull();
    expect(server.querySelector('.live-section__title .live-dot')).toHaveAttribute('data-tone', 'stale');
  });

  it('flags an ownership conflict as failed, above the other flags', () => {
    const report = makeHealth('ok');
    setup({ ...report, runtime: { ...report.runtime, ownershipConflict: true, previousRunUnclean: true } });
    const server = section(msg('live.section.server'));
    expect(within(server).getByText(msg('live.server.conflict'))).toBeInTheDocument();
    expect(within(server).getByText(msg('live.server.unclean'))).toBeInTheDocument();
    expect(server.querySelector('.live-section__title .live-dot')).toHaveAttribute('data-tone', 'failed');
    const flags = within(server)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(flags[0]).toBe(msg('live.server.conflict'));
  });

  it('works without a health report (the server was never reached)', () => {
    setup(null);
    expect(within(section(msg('live.section.server'))).getByText(msg('live.server.none'))).toBeInTheDocument();
  });
});

describe('HealthPopover: Errors', () => {
  it('says there are no server errors', () => {
    setup();
    expect(screen.getByText(msg('live.errors.none'))).toBeInTheDocument();
  });

  it('lists the server errors newest first with their time, source and code', () => {
    const report = makeHealth('degraded');
    setup({
      ...report,
      errors: [serverError(iso(-1), 'FIXTURE newest', 'one'), serverError(iso(-60), 'FIXTURE older', 'two')],
    });
    const errors = section(msg('live.section.errors'));
    const items = within(errors).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('FIXTURE newest');
    expect(items[0]).toHaveTextContent('server/one');
    expect(items[1]).toHaveTextContent('FIXTURE older');
    expect(errors.querySelector('.live-section__title .live-dot')).toHaveAttribute('data-tone', 'stale');
  });

  it('caps the list: 30 errors show the newest few and say how many there are', () => {
    const report = makeHealth('degraded');
    const many = Array.from({ length: 30 }, (_unused, i) =>
      serverError(iso(-i), `FIXTURE error ${String(i)}`, `c${String(i)}`),
    );
    setup({ ...report, errors: many });
    const errors = section(msg('live.section.errors'));
    const items = within(errors).getAllByRole('listitem');
    expect(items).toHaveLength(MAX_ERRORS_SHOWN);
    expect(items[0]).toHaveTextContent('FIXTURE error 0');
    expect(within(errors).queryByText(/FIXTURE error 29/)).toBeNull();
    expect(
      within(errors).getByText(msg('live.errors.shown', { shown: MAX_ERRORS_SHOWN, total: 30 })),
    ).toBeInTheDocument();
  });

  it('keeps a very long message inside the panel: it wraps and is clamped, the full text stays in the DOM', () => {
    const report = makeHealth('degraded');
    const long = `FIXTURE ${'very-long-unbroken-token-'.repeat(40)}`;
    setup({ ...report, errors: [serverError(iso(-1), long)] });
    const message = screen.getByText(long);
    expect(message).toHaveClass('live-error__message');
    expect(message.textContent).toBe(long);
  });

  it('marks server text as English when the page is in another language', () => {
    const report = makeHealth('degraded');
    renderWithProviders(<HealthPopover freshness={freshnessFor(report)} />, {
      locale: 'vi',
      instance: INSTANCE,
      queryClient: (() => {
        const client = createQueryClient({ retry: false });
        client.setQueryData(qk.health(FIXTURE_INSTANCE_ID), {
          ...report,
          errors: [serverError(iso(-1), 'FIXTURE english')],
        });
        return client;
      })(),
    });
    expect(screen.getByText('FIXTURE english')).toHaveAttribute('lang', 'en');
    expect(
      screen.getByRole('heading', { level: 3, name: msg('live.section.errors', undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});
