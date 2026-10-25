// The feed of /activity (04 4.4.4, 5.7). It runs under the real StreamProvider and reconciler; only the EventSource is scripted, so
// the events reach the live buffer the way they do in the browser.
import type { ActivityEvent, SessionSummary, StreamChange, StreamHello, ToolCallItem } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { StreamProvider } from '../../stream/StreamProvider.tsx';
import { createFakeApi, type FakeApi } from '../../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../../test/fake-event-source.ts';
import {
  iso,
  makeEvent,
  makeEventPage,
  makeHealth,
  makeInstance,
  makeSession,
  makeSessionPage,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders, type RenderOptions } from '../../test/render.tsx';
import { ActivityFeed, mergeLive, type ActivityFeedProps } from './ActivityFeed.tsx';

const INSTANCE = makeInstance();

/** Event `n`: a later number is a later event (`id`, `seq` and `at` all grow with it). */
function ev(n: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({
    id: n,
    seq: 100 + n,
    key: `t:fixture-record-${String(n)}`,
    at: iso(n),
    summary: `FIXTURE event ${String(n)}`,
    ...overrides,
  });
}

function range(from: number, to: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => ev(from + index, overrides));
}

function hello(): StreamHello {
  return {
    instanceId: INSTANCE.instanceId,
    epoch: INSTANCE.epoch,
    headSeq: INSTANCE.headSeq,
    heartbeatMs: INSTANCE.heartbeatMs,
    serverTime: iso(0),
    runtimeVersion: INSTANCE.runtimeVersion,
    codeStamp: INSTANCE.codeStamp,
  };
}

interface Harness {
  api: FakeApi;
  sources: FakeEventSources;
  /** The server side: newest first, what `GET /events` returns. */
  server: { events: ActivityEvent[]; nextCursor: string | null };
  seq: { next: number };
  queryClient: ReturnType<typeof renderWithProviders>['queryClient'];
}

function setup(
  props: Partial<ActivityFeedProps> = {},
  events: ActivityEvent[] = range(1, 3).reverse(),
  options: RenderOptions = {},
  nextCursor: string | null = null,
): Harness {
  const sources = createFakeEventSources();
  const server = { events, nextCursor };
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () => makeHealth('ok'),
    listEvents: (query) => {
      const cursor = query.get('cursor');
      if (cursor === 'older') {
        return makeEventPage([ev(50, { at: iso(-50), summary: 'FIXTURE older event' })], { nextCursor: null });
      }
      return makeEventPage([...server.events], { nextCursor: server.nextCursor });
    },
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      <AnnouncerProvider>
        <StreamProvider esFactory={sources.factory}>{children}</StreamProvider>
      </AnnouncerProvider>
    </ShortcutRegistryProvider>
  );
  const view = renderWithProviders(<ActivityFeed filter={{}} mode="page" {...props} />, {
    route: '/activity',
    api,
    instance: INSTANCE,
    wrap,
    ...options,
  });
  return { api, sources, server, seq: { next: INSTANCE.headSeq + 1 }, queryClient: view.queryClient };
}

async function openStream(h: Harness): Promise<void> {
  await screen.findByRole('list', { name: msg('activity.list.label') });
  act(() => {
    h.sources.last().open();
    h.sources.last().emit('hello', hello());
  });
  await screen.findByText(msg('activity.status.live'));
}

function appendFrame(h: Harness, items: ActivityEvent[], truncated = false): StreamChange {
  const change: StreamChange = {
    seq: h.seq.next,
    at: iso(0),
    instanceId: INSTANCE.instanceId,
    kind: 'event',
    op: 'append',
    sessionId: null,
    data: { items, count: items.length, truncated },
  };
  h.seq.next += 1;
  return change;
}

function emitEvents(h: Harness, items: ActivityEvent[], truncated = false): void {
  act(() => {
    // A frame carries at most 50 items; a longer burst arrives as several frames, oldest first.
    for (let from = 0; from < items.length || from === 0; from += 50) {
      h.sources.last().emit('change', appendFrame(h, items.slice(from, from + 50), truncated));
      if (items.length === 0) break;
    }
  });
}

/** The event ids of the rows on screen, top to bottom. */
function rowIds(): number[] {
  const list = screen.getByRole('list', { name: msg('activity.list.label') });
  return Array.from(list.children)
    .filter((li) => li.id.startsWith('ev-'))
    .map((li) => Number(li.id.slice(3)));
}

function listCalls(h: Harness): number {
  return h.api.callsTo('listEvents').length;
}

describe('mergeLive', () => {
  it('puts the newest first and drops an id that appears twice', () => {
    const merged = mergeLive([ev(5), ev(4)], [ev(4), ev(3), ev(2)]);
    expect(merged.map((e) => e.id)).toEqual([5, 4, 3, 2]);
  });

  it('orders by time and then by id, newest first', () => {
    const a = ev(1, { at: iso(10) });
    const b = ev(2, { at: iso(10) });
    const c = ev(3, { at: iso(20) });
    expect(mergeLive([], [a, b, c]).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('keeps the page version of an id when both lists hold it', () => {
    const live = ev(7, { summary: 'live copy' });
    const stored = ev(7, { summary: 'stored copy' });
    expect(mergeLive([live], [stored])[0]?.summary).toBe('stored copy');
  });
});

describe('ActivityFeed', () => {
  it('lists the events of the first page, newest first', async () => {
    setup();
    await screen.findByText('FIXTURE event 3');
    expect(rowIds()).toEqual([3, 2, 1]);
  });

  it('prepends a live event at the top', async () => {
    const h = setup();
    await openStream(h);
    emitEvents(h, [ev(4)]);
    await screen.findByText('FIXTURE event 4');
    expect(rowIds()).toEqual([4, 3, 2, 1]);
    emitEvents(h, [ev(5), ev(6)]);
    await screen.findByText('FIXTURE event 6');
    expect(rowIds()).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('never shows an event twice', async () => {
    const h = setup();
    await openStream(h);
    emitEvents(h, [ev(4)]);
    await screen.findByText('FIXTURE event 4');
    emitEvents(h, [ev(4), ev(3)]);
    // The same event again, and one that the first page already holds.
    emitEvents(h, [ev(5)]);
    await screen.findByText('FIXTURE event 5');
    expect(rowIds()).toEqual([5, 4, 3, 2, 1]);
  });

  it('shows only the live events that match the filter', async () => {
    const h = setup({ filter: { severity: ['error'] } });
    await openStream(h);
    emitEvents(h, [ev(4, { severity: 'info' }), ev(5, { severity: 'error' })]);
    await screen.findByText('FIXTURE event 5');
    expect(screen.queryByText('FIXTURE event 4')).toBeNull();
  });

  it('asks the server for the events that match the filter', async () => {
    const h = setup({ filter: { severity: ['error'], category: ['tool', 'error'] } });
    await screen.findByText('FIXTURE event 3');
    const query = h.api.callsTo('listEvents')[0]?.query;
    expect(query?.get('severity')).toBe('error');
    expect(query?.get('category')).toBe('tool,error');
  });

  it('keeps a monitor.gap separator that the category filter would hide, and still hides other events of the category', async () => {
    const h = setup({ filter: { category: ['prompt'] } });
    await openStream(h);
    emitEvents(h, [
      ev(4, { type: 'hook.unknown', category: 'ingest', summary: 'FIXTURE unknown hook' }),
      ev(5, { type: 'monitor.gap', category: 'ingest', severity: 'warning', summary: 'FIXTURE hooks were off' }),
      ev(6, { type: 'assistant.message', category: 'prompt' }),
    ]);
    await screen.findByText('FIXTURE event 6');
    expect(screen.getByRole('note')).toHaveTextContent('FIXTURE hooks were off');
    expect(screen.queryByText('FIXTURE unknown hook')).toBeNull();
    expect(rowIds()).toEqual([6, 5, 3, 2, 1]);
  });

  it('shows a gap that the server returned among filtered events', async () => {
    setup({ filter: { category: ['prompt'] } }, [
      ev(3),
      ev(2, { type: 'monitor.gap', category: 'ingest', severity: 'warning', summary: 'FIXTURE reconnect gap' }),
      ev(1),
    ]);
    expect(await screen.findByRole('note')).toHaveTextContent('FIXTURE reconnect gap');
  });

  it('applies a live gap only inside the filter time window', async () => {
    const h = setup({ filter: { from: iso(2) } });
    await openStream(h);
    emitEvents(h, [ev(1, { type: 'monitor.gap', category: 'ingest', at: iso(1), summary: 'FIXTURE too old' })]);
    emitEvents(h, [ev(4)]);
    await screen.findByText('FIXTURE event 4');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('updates the status and duration of a tool call row in place', async () => {
    const h = setup({}, [ev(2, { toolUseId: 'toolu_000001', toolName: 'Bash', toolStatus: 'pending' }), ev(1)]);
    await openStream(h);
    const item: ToolCallItem = {
      id: 1,
      seq: 50,
      toolUseId: 'toolu_000001',
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
      durationMs: 420,
      durationSource: 'hook',
      exitCode: 0,
      sources: ['hook_post'],
      subagentId: null,
      workflowRunId: null,
      transcriptRef: null,
    };
    // The event is live (not from the page) so that only the buffer patch can change it.
    emitEvents(h, [ev(3, { toolUseId: 'toolu_000002', toolName: 'Read', toolStatus: 'pending' })]);
    await screen.findByText('FIXTURE event 3');
    act(() => {
      h.sources.last().emit('change', {
        seq: h.seq.next,
        at: iso(0),
        instanceId: INSTANCE.instanceId,
        kind: 'tool_call',
        op: 'upsert',
        sessionId: sessionId(1),
        data: { items: [{ ...item, toolUseId: 'toolu_000002', name: 'Read' }], truncated: false },
      } satisfies StreamChange);
      h.seq.next += 1;
    });
    const row = document.getElementById('ev-3');
    await waitFor(() => {
      expect(row).toHaveTextContent(msg('activity.toolStatus.succeeded'));
    });
    expect(row).toHaveTextContent(msg('activity.duration.ms', { value: 420 }));
  });

  describe('pause and resume', () => {
    it('freezes the list, counts the new events and adds them when the user resumes', async () => {
      const user = userEvent.setup();
      const h = setup();
      await openStream(h);
      await user.click(screen.getByRole('button', { name: msg('activity.pause') }));
      expect(screen.getByText(msg('activity.status.paused', { count: 0 }))).toBeInTheDocument();
      emitEvents(h, [ev(4), ev(5)]);
      await screen.findByText(msg('activity.status.paused', { count: 2 }));
      expect(rowIds()).toEqual([3, 2, 1]);
      emitEvents(h, [ev(6)]);
      await screen.findByText(msg('activity.status.paused', { count: 3 }));
      expect(rowIds()).toEqual([3, 2, 1]);

      await user.click(screen.getByRole('button', { name: msg('activity.resume') }));
      expect(rowIds()).toEqual([6, 5, 4, 3, 2, 1]);
      expect(screen.getByText(msg('activity.status.live'))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: msg('activity.pause') })).toBeInTheDocument();
    });

    it('announces the resume with the number of new events', async () => {
      const user = userEvent.setup();
      const h = setup();
      await openStream(h);
      await user.click(screen.getByRole('button', { name: msg('activity.pause') }));
      emitEvents(h, [ev(4), ev(5)]);
      await screen.findByText(msg('activity.status.paused', { count: 2 }));
      await user.click(screen.getByRole('button', { name: msg('activity.resume') }));
      await waitFor(() => {
        expect(document.getElementById('live-region')).toHaveTextContent(msg('activity.resumed', { count: 2 }));
      });
    });

    it('moves no row while paused, even when the server list changes under the page', async () => {
      const user = userEvent.setup();
      const h = setup();
      await openStream(h);
      await user.click(screen.getByRole('button', { name: msg('activity.pause') }));
      h.server.events = [ev(9), ev(8), ...h.server.events];
      await act(async () => {
        await h.queryClient.invalidateQueries({ queryKey: qk.root(INSTANCE.instanceId) });
      });
      await waitFor(() => {
        expect(listCalls(h)).toBeGreaterThan(1);
      });
      expect(rowIds()).toEqual([3, 2, 1]);
      await user.click(screen.getByRole('button', { name: msg('activity.resume') }));
      await waitFor(() => {
        expect(rowIds()).toEqual([9, 8, 3, 2, 1]);
      });
    });

    it('says that older events load from history once more than 500 are buffered, and refetches on resume', async () => {
      const user = userEvent.setup();
      const h = setup();
      await openStream(h);
      await user.click(screen.getByRole('button', { name: msg('activity.pause') }));
      emitEvents(h, range(10, 559));
      await screen.findByText(msg('activity.status.pausedOverflow', { count: 500 }));
      expect(rowIds()).toEqual([3, 2, 1]);
      const before = listCalls(h);
      h.server.events = [ev(559), ev(558), ...h.server.events];
      await user.click(screen.getByRole('button', { name: msg('activity.resume') }));
      await waitFor(() => {
        expect(listCalls(h)).toBeGreaterThan(before);
      });
      await waitFor(() => {
        expect(rowIds().slice(0, 2)).toEqual([559, 558]);
      });
      expect(screen.getByText(msg('activity.status.live'))).toBeInTheDocument();
    });

    it('refetches the first page instead of growing without bound when 1,000 live events arrive', async () => {
      const h = setup();
      await openStream(h);
      const before = listCalls(h);
      h.server.events = range(960, 1009).reverse();
      emitEvents(h, range(10, 1009));
      await waitFor(() => {
        expect(listCalls(h)).toBeGreaterThan(before);
      });
      await waitFor(() => {
        expect(rowIds()[0]).toBe(1009);
      });
      expect(rowIds().length).toBeLessThanOrEqual(600);
    });

    it('refetches the first page when the stream says an append was truncated', async () => {
      const h = setup();
      await openStream(h);
      const before = listCalls(h);
      emitEvents(h, [ev(4)], true);
      await waitFor(() => {
        expect(listCalls(h)).toBeGreaterThan(before);
      });
    });
  });

  describe('the project filter', () => {
    function withSession(h: Harness, session: SessionSummary): void {
      h.queryClient.setQueryData(qk.sessions(INSTANCE.instanceId, {}), {
        pages: [makeSessionPage([session])],
        pageParams: [null],
      });
    }

    it('matches a live event through the project of its session when the session list is cached', async () => {
      const h = setup({ filter: { project: ['proj-a'] } });
      withSession(h, makeSession({ id: sessionId(7), projectId: 'proj-a' }));
      await openStream(h);
      emitEvents(h, [ev(4, { sessionId: sessionId(7) }), ev(5, { sessionId: sessionId(8) })]);
      await screen.findByText('FIXTURE event 4');
      expect(screen.queryByText('FIXTURE event 5')).toBeNull();
    });

    it('reloads the first page when it cannot tell the project of a live event', async () => {
      const h = setup({ filter: { project: ['proj-a'] } });
      await openStream(h);
      const before = listCalls(h);
      emitEvents(h, [ev(4, { sessionId: sessionId(9) })]);
      await waitFor(
        () => {
          expect(listCalls(h)).toBeGreaterThan(before);
        },
        { timeout: 3000 },
      );
    });
  });

  describe('older events', () => {
    it('loads the next page below the loaded rows', async () => {
      const user = userEvent.setup();
      setup({}, undefined, {}, 'older');
      await screen.findByText('FIXTURE event 3');
      await user.click(await screen.findByRole('button', { name: msg('common.loadMore.button', { count: 100 }) }));
      await screen.findByText('FIXTURE older event');
      expect(rowIds()).toEqual([3, 2, 1, 50]);
    });

    it('keeps the older rows visible while paused', async () => {
      const user = userEvent.setup();
      const h = setup({}, undefined, {}, 'older');
      await openStream(h);
      await user.click(screen.getByRole('button', { name: msg('activity.pause') }));
      await user.click(screen.getByRole('button', { name: msg('common.loadMore.button', { count: 100 }) }));
      await screen.findByText('FIXTURE older event');
      expect(rowIds()).toEqual([3, 2, 1, 50]);
    });
  });

  describe('status', () => {
    it('says Live while the stream is open and says so when it is not', async () => {
      const h = setup();
      await screen.findByText('FIXTURE event 3');
      expect(screen.queryByText(msg('activity.status.live'))).toBeNull();
      expect(screen.getByText(msg('activity.status.disconnected', { seconds: 3 }))).toBeInTheDocument();
      act(() => {
        h.sources.last().open();
        h.sources.last().emit('hello', hello());
      });
      expect(await screen.findByText(msg('activity.status.live'))).toBeInTheDocument();
      expect(screen.queryByText(msg('activity.status.disconnected', { seconds: 3 }))).toBeNull();
    });

    it('writes the status and the buttons in Vietnamese', async () => {
      const user = userEvent.setup();
      const h = setup({}, undefined, { locale: 'vi' });
      await screen.findByText('FIXTURE event 3');
      expect(screen.getByText(msg('activity.status.disconnected', { seconds: 3 }, 'vi'))).toBeInTheDocument();
      act(() => {
        h.sources.last().open();
        h.sources.last().emit('hello', hello());
      });
      expect(await screen.findByText(msg('activity.status.live', undefined, 'vi'))).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: msg('activity.pause', undefined, 'vi') }));
      emitEvents(h, [ev(4)]);
      expect(await screen.findByText(msg('activity.status.paused', { count: 1 }, 'vi'))).toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('has no pause button, no status and no load more, and shows at most `limit` rows', async () => {
      setup({ mode: 'compact', limit: 2 }, undefined, {}, 'older');
      await screen.findByText('FIXTURE event 3');
      expect(rowIds()).toEqual([3, 2]);
      expect(screen.queryByRole('button', { name: msg('activity.pause') })).toBeNull();
      expect(screen.queryByRole('search')).toBeNull();
      expect(screen.queryByText(msg('activity.status.disconnected', { seconds: 3 }))).toBeNull();
      expect(screen.queryByRole('button', { name: /Load/ })).toBeNull();
    });

    it('still prepends a live event and keeps to the limit', async () => {
      const h = setup({ mode: 'compact', limit: 3 });
      await screen.findByText('FIXTURE event 3');
      act(() => {
        h.sources.last().open();
        h.sources.last().emit('hello', hello());
      });
      emitEvents(h, [ev(4)]);
      await screen.findByText('FIXTURE event 4');
      expect(rowIds()).toEqual([4, 3, 2]);
    });

    it('says there is no recent activity when the list is empty', async () => {
      setup({ mode: 'compact' }, []);
      expect(await screen.findByText(msg('activity.emptyCompact'))).toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows an empty state with the chance to clear the filters when a filter is on', async () => {
      const user = userEvent.setup();
      const onClearFilters = vi.fn();
      setup({ filtered: true, onClearFilters }, []);
      expect(await screen.findByText(msg('activity.emptyFiltered.title'))).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: msg('activity.clearFilters') }));
      expect(onClearFilters).toHaveBeenCalledOnce();
    });

    it('shows an empty state without a button when nothing is filtered', async () => {
      setup({}, []);
      const title = await screen.findByText(msg('activity.empty.title'));
      const card = title.closest<HTMLElement>('.state');
      if (card === null) throw new Error('the empty state has no card');
      expect(within(card).queryByRole('button')).toBeNull();
    });

    it('shows an error state with a retry when the first page fails', async () => {
      const sources = createFakeEventSources();
      const api = createFakeApi({
        instance: () => INSTANCE,
        health: () => makeHealth('ok'),
        listEvents: () => new Response('{"broken":', { status: 200 }),
      });
      renderWithProviders(<ActivityFeed filter={{}} mode="page" />, {
        route: '/activity',
        api,
        instance: INSTANCE,
        wrap: (children) => (
          <ShortcutRegistryProvider>
            <StreamProvider esFactory={sources.factory}>{children}</StreamProvider>
          </ShortcutRegistryProvider>
        ),
      });
      expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    });

    it('notes that the server stopped scanning early', async () => {
      const sources = createFakeEventSources();
      const api = createFakeApi({
        instance: () => INSTANCE,
        health: () => makeHealth('ok'),
        listEvents: () => makeEventPage([ev(1)], { scanCapped: true }),
      });
      renderWithProviders(<ActivityFeed filter={{}} mode="page" />, {
        route: '/activity',
        api,
        instance: INSTANCE,
        wrap: (children) => <StreamProvider esFactory={sources.factory}>{children}</StreamProvider>,
      });
      expect(await screen.findByText(msg('activity.scanCapped'))).toBeInTheDocument();
    });
  });
});
