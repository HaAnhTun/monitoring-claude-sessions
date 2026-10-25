import type { ActivityEvent } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeHandlers } from '../../test/fake-api.ts';
import { agentId, iso, makeEvent, makeInstance, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, renderWithProviders } from '../../test/render.tsx';
import { TimelineRow, useShowInTranscript, type TimelineRowProps } from './TimelineRow.tsx';

const SID = sessionId(1);
const INSTANCE = makeInstance();

function renderRow(event: ActivityEvent, props: Partial<TimelineRowProps> = {}, locale: 'en' | 'vi' = 'en') {
  const onToggle = vi.fn();
  const onShowInTranscript = vi.fn();
  const rendered = renderWithIntl(
    <ul>
      <TimelineRow event={event} open={false} onToggle={onToggle} onShowInTranscript={onShowInTranscript} {...props} />
    </ul>,
    { locale },
  );
  return { ...rendered, onToggle, onShowInTranscript };
}

describe('TimelineRow', () => {
  it('is one line: the time, the category, the event name, the summary and the agent', () => {
    renderRow(
      makeEvent({
        id: 7,
        type: 'tool.call',
        category: 'tool',
        toolName: 'Grep',
        summary: 'FIXTURE the pattern',
        agentLabel: 'FIXTURE helper',
        durationMs: 250,
      }),
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveAttribute('id', 'ev-7');
    expect(within(row).getByText('tool.call')).toBeInTheDocument();
    expect(within(row).getByText('Grep')).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE the pattern')).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE helper')).toBeInTheDocument();
    expect(within(row).getByText(msg('tabs.events.durationMs', { ms: 250 }))).toBeInTheDocument();
    expect(within(row).getByText(msg('activity.category.tool'))).toBeInTheDocument();
    // the whole line is the one row of the list: nothing but the summary text stacks below it while the details are closed
    expect(row.querySelector('.event-row__more')).toBeNull();
  });

  it('shows the status of a tool call as a dot with a word for a screen reader', () => {
    renderRow(makeEvent({ type: 'tool.failure', category: 'tool', toolStatus: 'failed', severity: 'error' }));
    const dot = document.querySelector('.event-dot--failed');
    expect(dot).not.toBeNull();
    expect(screen.getByText(msg('tabs.events.status.failed'))).toHaveClass('sr-only');
    expect(screen.getByRole('listitem')).toHaveClass('event-row--error');
  });

  it('shows a dot for a warning that is not a tool call, and none for an ordinary event', () => {
    const { unmount } = renderRow(makeEvent({ severity: 'warning' }));
    expect(document.querySelector('.event-dot--stale')).not.toBeNull();
    expect(screen.getByText(msg('tabs.severity.warning'))).toBeInTheDocument();
    unmount();
    renderRow(makeEvent({ severity: 'info', toolStatus: null }));
    expect(document.querySelector('.event-dot')).toBeNull();
  });

  it('draws the source tags only when the list asks for them', () => {
    const event = makeEvent({ sources: ['hook', 'transcript'] });
    const { unmount } = renderRow(event);
    expect(screen.queryByText(msg('tabs.events.source.hook'))).toBeNull();
    unmount();
    renderRow(event, { showSources: true });
    expect(screen.getByText(msg('tabs.events.source.hook'))).toBeInTheDocument();
    expect(screen.getByText(msg('tabs.events.source.transcript'))).toBeInTheDocument();
  });

  it('asks to show the event in the transcript from an icon button named after the event', async () => {
    const event = makeEvent({ toolName: 'Grep', transcriptRef: { agentId: 'main', offset: 12 } });
    const { onShowInTranscript } = renderRow(event);
    const button = screen.getByRole('button', { name: msg('tabs.events.showInTranscriptFor', { what: 'Grep' }) });
    expect(button).toHaveAttribute('title', msg('tabs.events.showInTranscript'));
    await userEvent.click(button);
    expect(onShowInTranscript).toHaveBeenCalledWith(event);
  });

  it('offers no transcript button without a transcript reference or without a handler', () => {
    const { unmount } = renderRow(makeEvent({ transcriptRef: null }));
    expect(screen.queryByRole('button', { name: new RegExp(msg('tabs.events.showInTranscript')) })).toBeNull();
    unmount();
    renderRow(makeEvent(), { onShowInTranscript: undefined });
    expect(screen.queryByRole('button', { name: new RegExp(msg('tabs.events.showInTranscript')) })).toBeNull();
  });

  it('opens the details on request: the whole summary and the detail keys', async () => {
    const event = makeEvent({
      id: 9,
      type: 'tool.call',
      summary: 'FIXTURE long summary',
      details: { cwd: 'FIXTURE dir', empty: null },
    });
    const { onToggle, rerender } = renderRow(event);
    const toggle = screen.getByRole('button', { name: msg('tabs.events.details', { type: 'tool.call' }) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(9, true);
    rerender(
      <ul>
        <TimelineRow event={event} open onToggle={onToggle} />
      </ul>,
    );
    expect(screen.getByRole('button', { name: msg('tabs.events.details', { type: 'tool.call' }) })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const more = document.getElementById('ev-details-9');
    if (more === null) throw new Error('the details are not open');
    expect(more).toHaveTextContent('FIXTURE dir');
    expect(within(more).getByText('cwd')).toBeInTheDocument();
    expect(within(more).getByText(msg('tabs.events.noValue'))).toBeInTheDocument();
    expect(within(more).getAllByText('FIXTURE long summary').length).toBeGreaterThan(0);
  });

  it('has no details button for an event with neither a summary nor details', () => {
    renderRow(makeEvent({ summary: '', details: {} }));
    expect(
      screen.queryByRole('button', { name: new RegExp(msg('tabs.events.details', { type: '' }).trim()) }),
    ).toBeNull();
  });

  it('shows a gap as a note, with the reason when there is one', () => {
    const { unmount } = renderRow(makeEvent({ type: 'monitor.gap', category: 'ingest', summary: '' }));
    expect(screen.getByRole('note')).toHaveTextContent(msg('tabs.events.gap'));
    unmount();
    renderRow(makeEvent({ type: 'monitor.gap', category: 'ingest', summary: 'FIXTURE reason' }));
    expect(screen.getByRole('note')).toHaveTextContent(msg('tabs.events.gapDetail', { detail: 'FIXTURE reason' }));
  });

  it('is worded in Vietnamese', () => {
    renderRow(makeEvent({ type: 'tool.failure', toolStatus: 'failed', category: 'tool', toolName: 'Grep' }), {}, 'vi');
    expect(screen.getByText(msg('tabs.events.status.failed', undefined, 'vi'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: msg('tabs.events.showInTranscriptFor', { what: 'Grep' }, 'vi') }),
    ).toBeInTheDocument();
  });
});

function Probe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function Locator({ event }: { event: ActivityEvent }) {
  const show = useShowInTranscript();
  return (
    <button
      type="button"
      onClick={() => {
        show(event);
      }}
    >
      locate
    </button>
  );
}

function renderLocator(event: ActivityEvent, handlers: FakeHandlers, locale: 'en' | 'vi' = 'en') {
  const toasts = createToastStore();
  const api = createFakeApi({ instance: () => INSTANCE, ...handlers });
  renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionId" element={<Locator event={event} />} />
    </Routes>,
    {
      route: `/sessions/${SID}?tab=events`,
      api,
      instance: INSTANCE,
      locale,
      wrap: (children) => (
        <ToastStoreContext value={toasts}>
          <Probe />
          {children}
        </ToastStoreContext>
      ),
    },
  );
  return { toasts, api };
}

describe('useShowInTranscript', () => {
  it('resolves the entry and opens it in the transcript, for the agent of the event', async () => {
    const event = makeEvent({ transcriptRef: { agentId: agentId(2), offset: 128 } });
    const { api } = renderLocator(event, { transcriptLocate: () => ({ i: 7, t: iso(-5), base: 0, total: 10 }) });
    await userEvent.click(screen.getByRole('button', { name: 'locate' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(`/sessions/${SID}?agent=${agentId(2)}&i=7`);
    });
    expect(api.callsTo('transcriptLocate')[0]?.query.get('offset')).toBe('128');
  });

  it('leaves the agent out of the address for the main agent', async () => {
    const event = makeEvent({ transcriptRef: { agentId: 'main', offset: 0 } });
    renderLocator(event, { transcriptLocate: () => ({ i: 3, t: iso(-5), base: 0, total: 10 }) });
    await userEvent.click(screen.getByRole('button', { name: 'locate' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(`/sessions/${SID}?i=3`);
    });
  });

  it('says in a toast that the entry could not be opened, and stays where it is', async () => {
    const event = makeEvent({ transcriptRef: { agentId: 'main', offset: 0 } });
    const { toasts } = renderLocator(event, { transcriptLocate: () => errorResponse('transcript_gone') });
    await userEvent.click(screen.getByRole('button', { name: 'locate' }));
    const prefix = msg('tabs.events.locateFailed', { detail: '' }).trim();
    await waitFor(() => {
      expect(toasts.getSnapshot()).toHaveLength(1);
    });
    expect(toasts.getSnapshot()[0]?.message.startsWith(prefix)).toBe(true);
    expect(toasts.getSnapshot()[0]?.kind).toBe('error');
    expect(screen.getByTestId('location').textContent).toBe(`/sessions/${SID}?tab=events`);
  });

  it('words the toast in Vietnamese', async () => {
    const event = makeEvent({ transcriptRef: { agentId: 'main', offset: 0 } });
    const { toasts } = renderLocator(event, { transcriptLocate: () => errorResponse('transcript_gone') }, 'vi');
    await userEvent.click(screen.getByRole('button', { name: 'locate' }));
    await waitFor(() => {
      expect(toasts.getSnapshot()).toHaveLength(1);
    });
    const prefix = msg('tabs.events.locateFailed', { detail: '' }, 'vi').trim();
    expect(toasts.getSnapshot()[0]?.message.startsWith(prefix)).toBe(true);
  });

  it('does nothing for an event without a transcript reference', async () => {
    const event = makeEvent({ transcriptRef: null });
    const { api } = renderLocator(event, {});
    await userEvent.click(screen.getByRole('button', { name: 'locate' }));
    expect(api.callsTo('transcriptLocate')).toHaveLength(0);
  });
});
