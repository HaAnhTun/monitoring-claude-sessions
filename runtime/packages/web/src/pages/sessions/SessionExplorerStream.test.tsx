// LF-10 (CR-LF-7-3): the "List changed: Refresh" notice of 04 5.5 rule R3. The explorer runs under the real `StreamProvider` and
// reconciler; only the `EventSource` is scripted. A new session joins a list the user has scrolled away from only through the
// notice; at the top the list follows the stream by itself.
import type { SessionSummary, StreamChange, StreamHello } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { StreamProvider } from '../../stream/StreamProvider.tsx';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createFakeApi, type FakeApi } from '../../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../../test/fake-event-source.ts';
import {
  iso,
  makeHealth,
  makeInstance,
  makeOverview,
  makeSession,
  makeSessionPage,
  makeState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionExplorerPage } from './SessionExplorerPage.tsx';

const INSTANCE = makeInstance();

function row(n: number): SessionSummary {
  return makeSession({ id: sessionId(n), seq: n, label: `FIXTURE session ${String(n)}` });
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

function sessionChange(seq: number, data: SessionSummary): StreamChange {
  return {
    seq,
    at: iso(0),
    instanceId: INSTANCE.instanceId,
    kind: 'session',
    op: 'upsert',
    sessionId: data.id,
    data,
  };
}

interface Harness {
  api: FakeApi;
  sources: FakeEventSources;
  /** The server side: what the next `GET /sessions` returns. */
  sessions: SessionSummary[];
  scrolled: { value: boolean };
}

function setup(): Harness {
  const sources = createFakeEventSources();
  const scrolled = { value: false };
  const state: Harness = {
    api: createFakeApi({
      instance: () => INSTANCE,
      health: () => makeHealth('ok'),
      overview: () => makeOverview({ metrics: [] }),
      listSessions: () => makeSessionPage([...state.sessions], { total: state.sessions.length }),
    }),
    sources,
    sessions: [row(1), row(2)],
    scrolled,
  };
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      <StreamProvider esFactory={sources.factory} listAtTop={() => !scrolled.value}>
        {children}
      </StreamProvider>
    </ShortcutRegistryProvider>
  );
  renderWithProviders(<SessionExplorerPage />, { route: '/sessions', api: state.api, instance: INSTANCE, wrap });
  return state;
}

async function openStream(h: Harness): Promise<void> {
  await screen.findByRole('table', { name: msg('sessions.table.caption') });
  act(() => {
    h.sources.last().open();
    h.sources.last().emit('hello', hello());
  });
}

function listCalls(h: Harness): number {
  return h.api.callsTo('listSessions').length;
}

describe('SessionExplorerPage with the realtime stream', () => {
  it('does not add a new session to a scrolled list, and offers a Refresh notice instead', async () => {
    const h = setup();
    await openStream(h);
    h.scrolled.value = true;
    const added = makeSession({ id: sessionId(3), seq: 3, label: 'FIXTURE session 3' });
    h.sessions = [added, ...h.sessions];
    const before = listCalls(h);
    act(() => {
      h.sources.last().emit('change', sessionChange(11, added));
    });
    const notice = await screen.findByRole('status', { name: msg('sessions.changed.label') });
    expect(notice).toHaveTextContent(msg('sessions.changed.text', { count: 1 }));
    expect(within(notice).getByRole('button', { name: msg('sessions.changed.refresh') })).toBeEnabled();
    expect(screen.queryByText('FIXTURE session 3')).toBeNull();
    expect(listCalls(h)).toBe(before);
  });

  it('shows a Refresh button that adds the row, refetches and removes the notice', async () => {
    const user = userEvent.setup();
    const h = setup();
    await openStream(h);
    h.scrolled.value = true;
    const added = makeSession({ id: sessionId(3), seq: 3, label: 'FIXTURE session 3' });
    h.sessions = [added, ...h.sessions];
    act(() => {
      h.sources.last().emit('change', sessionChange(11, added));
    });
    const notice = await screen.findByRole('status', { name: msg('sessions.changed.label') });
    const before = listCalls(h);
    const button = within(notice).getByRole('button', { name: msg('sessions.changed.refresh') });
    // Reachable with the keyboard: Tab from the page start lands on the first focusable control, the button is a real button.
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByText('FIXTURE session 3');
    expect(listCalls(h)).toBeGreaterThan(before);
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: msg('sessions.changed.label') })).toBeNull();
    });
    expect(screen.getByText('FIXTURE session 1')).toBeInTheDocument();
  });

  it('counts several changes in one notice', async () => {
    const h = setup();
    await openStream(h);
    h.scrolled.value = true;
    act(() => {
      h.sources
        .last()
        .emit('change', sessionChange(11, makeSession({ id: sessionId(3), seq: 3, label: 'FIXTURE session 3' })));
      h.sources
        .last()
        .emit('change', sessionChange(12, makeSession({ id: sessionId(4), seq: 4, label: 'FIXTURE session 4' })));
    });
    expect(await screen.findByRole('status', { name: msg('sessions.changed.label') })).toHaveTextContent(
      msg('sessions.changed.text', { count: 2 }),
    );
  });

  it('follows the stream without a notice while the list is at the top', async () => {
    const h = setup();
    await openStream(h);
    const added = makeSession({ id: sessionId(3), seq: 3, label: 'FIXTURE session 3' });
    h.sessions = [added, ...h.sessions];
    act(() => {
      h.sources.last().emit('change', sessionChange(11, added));
    });
    // The first page is invalidated after the 2 s debounce of 04 5.5.
    await screen.findByText('FIXTURE session 3', undefined, { timeout: 5000 });
    expect(screen.queryByRole('status', { name: msg('sessions.changed.label') })).toBeNull();
  }, 10_000);

  it('patches a row in place when the stream updates a session that is in the list: same place, no refetch, no notice', async () => {
    const h = setup();
    await openStream(h);
    const labels = (): (string | undefined)[] =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((r) => /FIXTURE session [0-9]/.exec(r.textContent)?.[0]);
    expect(labels()).toEqual(['FIXTURE session 1', 'FIXTURE session 2']);
    const before = listCalls(h);
    act(() => {
      h.sources
        .last()
        .emit(
          'change',
          sessionChange(11, { ...row(2), seq: 20, state: makeState('failed'), errorCount: 2, lastActivityAt: iso(-1) }),
        );
    });
    const second = screen.getAllByRole('row')[2]!;
    await waitFor(() => {
      expect(within(second).getByText(msg('sessions.errors.count', { count: 2 }))).toBeInTheDocument();
    });
    expect(second).toHaveClass('session-row--error');
    expect(within(second).getByText(msg('state.failed.label'))).toBeInTheDocument();
    expect(labels()).toEqual(['FIXTURE session 1', 'FIXTURE session 2']);
    expect(listCalls(h)).toBe(before);
    expect(screen.queryByRole('status', { name: msg('sessions.changed.label') })).toBeNull();
  });

  it('shows no notice when nothing changed', async () => {
    const h = setup();
    await openStream(h);
    expect(screen.queryByRole('status', { name: msg('sessions.changed.label') })).toBeNull();
  });
});
