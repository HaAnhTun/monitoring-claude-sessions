import type { ToolCallItem } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  agentId,
  iso,
  makeEvent,
  makeEventPage,
  makeInstance,
  makePage,
  sessionId,
  toolUseId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionErrors, firstLine, type SessionErrorsProps } from './SessionErrors.tsx';

const SID = sessionId(1);
const INSTANCE = makeInstance();

function Probe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function renderErrors(
  props: Partial<SessionErrorsProps> = {},
  handlers: FakeHandlers = {},
  locale: 'en' | 'vi' = 'en',
) {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    sessionTimeline: () => makeEventPage([]),
    ...handlers,
  });
  const toasts = createToastStore();
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionErrors sessionId={SID} {...props} />} />
    </Routes>,
    {
      route: `/sessions/${SID}?tab=errors`,
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
  return { ...rendered, api, toasts };
}

const FAILED_TOOL = makeEvent({
  id: 11,
  at: iso(-120),
  type: 'tool.failure',
  category: 'error',
  severity: 'error',
  toolName: 'Grep',
  toolStatus: 'failed',
  durationMs: 4000,
  summary: 'FIXTURE no such file\nsecond line of the message',
  agentLabel: 'FIXTURE helper',
  transcriptRef: { agentId: agentId(2), offset: 64 },
});

describe('SessionErrors', () => {
  it('asks for warnings and errors only, for the chosen agent', async () => {
    const { api } = renderErrors({ agentId: agentId(2), agentLabel: 'FIXTURE helper' });
    await waitFor(() => {
      expect(api.callsTo('sessionTimeline')).toHaveLength(1);
    });
    const call = api.callsTo('sessionTimeline')[0];
    expect(call?.query.get('severity')).toBe('warning,error');
    expect(call?.query.get('agent')).toBe(agentId(2));
  });

  it('names the tool, how long it took and the first line of the message', async () => {
    renderErrors({}, { sessionTimeline: () => makeEventPage([FAILED_TOOL]) });
    const row = (await screen.findByText('Grep')).closest('tr') as HTMLElement;
    expect(within(row).getByText(msg('tabs.errors.failedAfter', { duration: '4s' }))).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE no such file')).toBeInTheDocument();
    expect(within(row).queryByText(/second line/)).toBeNull();
    // the whole text stays in the tooltip
    expect(within(row).getByText('FIXTURE no such file').closest('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining('second line of the message'),
    );
    expect(within(row).getByText('#11')).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE helper')).toBeInTheDocument();
  });

  it('cuts the first line of a message at 120 characters', () => {
    const long = `FIXTURE ${'x'.repeat(200)}`;
    const cut = firstLine(`${long}\nnext`);
    expect(cut).toHaveLength(121);
    expect(cut.endsWith('…')).toBe(true);
    expect(firstLine('short\nnext')).toBe('short');
    expect(firstLine('')).toBe('');
  });

  it('says "no message" for an event without a summary and names the kind of the event when no tool was involved', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([makeEvent({ id: 5, type: 'api.error', toolName: null, summary: '', severity: 'error' })]),
      },
    );
    expect(await screen.findByText('api.error')).toBeInTheDocument();
    expect(screen.getByText(msg('tabs.errors.noMessage'))).toBeInTheDocument();
  });

  it('marks a warning as a warning, in words for a screen reader', async () => {
    renderErrors(
      {},
      { sessionTimeline: () => makeEventPage([makeEvent({ id: 4, severity: 'warning', toolName: 'Edit' })]) },
    );
    const row = (await screen.findByText('Edit')).closest('tr') as HTMLElement;
    expect(within(row).getByText(msg('tabs.severity.warning'))).toBeInTheDocument();
  });

  it('opens the event in the transcript from a button', async () => {
    const { api } = renderErrors(
      {},
      {
        sessionTimeline: () => makeEventPage([FAILED_TOOL]),
        transcriptLocate: () => ({ i: 7, t: iso(-5), base: 0, total: 10 }),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: msg('tabs.errors.openFor', { what: 'Grep' }) }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(`/sessions/${SID}?agent=${agentId(2)}&i=7`);
    });
    expect(api.callsTo('transcriptLocate')[0]?.query.get('offset')).toBe('64');
  });

  it('puts a toast, not a navigation, when the entry cannot be opened', async () => {
    const { toasts } = renderErrors(
      {},
      {
        sessionTimeline: () => makeEventPage([FAILED_TOOL]),
        transcriptLocate: () => errorResponse('transcript_gone'),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: msg('tabs.errors.openFor', { what: 'Grep' }) }));
    const prefix = msg('tabs.events.locateFailed', { detail: '' }).trim();
    await waitFor(() => {
      expect(toasts.getSnapshot().some((toast) => toast.message.startsWith(prefix))).toBe(true);
    });
    expect(screen.getByTestId('location').textContent).toBe(`/sessions/${SID}?tab=errors`);
  });

  it('offers no button for an event without a transcript reference', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([makeEvent({ id: 3, severity: 'error', toolName: 'Bash', transcriptRef: null })]),
      },
    );
    await screen.findByText('Bash');
    expect(screen.queryByRole('button', { name: new RegExp(msg('tabs.errors.open')) })).toBeNull();
  });

  it('hides the agent column when every row is from the same agent', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([
            makeEvent({ id: 2, severity: 'error', toolName: 'Bash', agentLabel: 'FIXTURE same' }),
            makeEvent({ id: 1, severity: 'error', toolName: 'Grep', agentLabel: 'FIXTURE same' }),
          ]),
      },
    );
    await screen.findByText('Bash');
    expect(screen.queryByRole('columnheader', { name: msg('tabs.errors.col.agent') })).toBeNull();
  });

  it('shows the errors and warnings of the whole session above the list', async () => {
    renderErrors({ errorCount: 3, warningCount: 1 }, { sessionTimeline: () => makeEventPage([FAILED_TOOL]) });
    expect(await screen.findByText(msg('tabs.errors.summary', { errors: 3, warnings: 1 }))).toBeInTheDocument();
  });

  it('says that the list is narrowed to an agent and links back to every agent', async () => {
    renderErrors({ agentId: agentId(2), agentLabel: 'FIXTURE helper', errorCount: 1, warningCount: 0 });
    expect(await screen.findByText(msg('tabs.errors.emptyAgent', { agent: 'FIXTURE helper' }))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('tabs.errors.showAll') })).toHaveAttribute(
      'href',
      `/sessions/${SID}?tab=errors`,
    );
  });

  it('says so when there is nothing to list', async () => {
    renderErrors();
    expect(await screen.findByText(msg('tabs.errors.empty'))).toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    renderErrors({}, { sessionTimeline: () => errorResponse('internal_error') });
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
  });

  it('is worded in Vietnamese', async () => {
    renderErrors({ errorCount: 1, warningCount: 0 }, { sessionTimeline: () => makeEventPage([FAILED_TOOL]) }, 'vi');
    const failedAfter = msg('tabs.errors.failedAfter', { duration: 'XX' }, 'vi').replace('XX', '.+');
    expect(await screen.findByText(new RegExp(`^${failedAfter}$`))).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: msg('tabs.errors.col.message', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: msg('tabs.errors.openFor', { what: 'Grep' }, 'vi') }),
    ).toBeInTheDocument();
  });
});

function toolCall(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    id: 1,
    seq: 1,
    toolUseId: toolUseId(1),
    sessionId: SID,
    agentId: agentId(2),
    promptId: null,
    name: 'Grep',
    mcpServer: null,
    status: 'failed',
    outcome: 'error',
    summary: 'TODO src',
    inputBytes: null,
    startedAt: iso(-125),
    endedAt: iso(-121),
    batchAt: null,
    durationMs: 4000,
    durationSource: 'timestamps',
    exitCode: null,
    sources: ['transcript_use', 'transcript_result'],
    subagentId: null,
    workflowRunId: null,
    transcriptRef: null,
    ...overrides,
  };
}

/** What the engine writes for the result of a failed call: no tool name, no message and no duration on the event itself. */
const BARE_FAILURE = makeEvent({
  id: 21,
  type: 'tool.failure',
  category: 'error',
  severity: 'error',
  toolName: null,
  toolUseId: toolUseId(1),
  toolStatus: 'failed',
  durationMs: null,
  summary: '',
  agentLabel: 'FIXTURE helper',
});

describe('SessionErrors: the failed tool call behind an event', () => {
  it('asks for the failed tool calls of the session, for the chosen agent', async () => {
    const { api } = renderErrors({ agentId: agentId(2) }, { sessionToolCalls: () => makePage([]) });
    await waitFor(() => {
      expect(api.callsTo('sessionToolCalls')).toHaveLength(1);
    });
    const call = api.callsTo('sessionToolCalls')[0];
    expect(call?.query.get('status')).toBe('failed');
    expect(call?.query.get('agent')).toBe(agentId(2));
  });

  it('names the tool and its argument and says how long it took, with the exit code', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () => makeEventPage([BARE_FAILURE]),
        sessionToolCalls: () => makePage([toolCall({ exitCode: 2 })]),
      },
    );
    const row = (await screen.findByText('Grep')).closest('tr') as HTMLElement;
    expect(within(row).getByText('TODO src')).toBeInTheDocument();
    expect(within(row).getByText(msg('tabs.errors.failedAfter', { duration: '4s' }))).toBeInTheDocument();
    expect(within(row).getByText(msg('tabs.errors.exitCode', { code: 2 }))).toBeInTheDocument();
    expect(within(row).queryByText('tool.failure')).toBeNull();
    expect(screen.getByRole('button', { name: msg('tabs.errors.openFor', { what: 'Grep' }) })).toBeInTheDocument();
  });

  it('leaves out an exit code of 0 and a call that has no argument', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () => makeEventPage([BARE_FAILURE]),
        sessionToolCalls: () => makePage([toolCall({ exitCode: 0, summary: null })]),
      },
    );
    const row = (await screen.findByText('Grep')).closest('tr') as HTMLElement;
    expect(within(row).getByText(msg('tabs.errors.failedAfter', { duration: '4s' }))).toBeInTheDocument();
    expect(row.querySelector('.error-row__argument')).toBeNull();
  });

  it('keeps what the event itself says when it names a tool', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () =>
          makeEventPage([
            makeEvent({ ...BARE_FAILURE, toolName: 'Bash', summary: 'FIXTURE own message', durationMs: 2000 }),
          ]),
        sessionToolCalls: () => makePage([toolCall()]),
      },
    );
    const row = (await screen.findByText('Bash')).closest('tr') as HTMLElement;
    expect(within(row).getByText('FIXTURE own message')).toBeInTheDocument();
    expect(within(row).getByText(msg('tabs.errors.failedAfter', { duration: '2s' }))).toBeInTheDocument();
    expect(within(row).queryByText('Grep')).toBeNull();
  });

  it('draws the events without a tool when the tool calls cannot be read', async () => {
    renderErrors(
      {},
      { sessionTimeline: () => makeEventPage([BARE_FAILURE]), sessionToolCalls: () => errorResponse('internal_error') },
    );
    const row = (await screen.findByText('tool.failure')).closest('tr') as HTMLElement;
    expect(within(row).getByText(msg('tabs.errors.noMessage'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('common.retryNow') })).toBeNull();
  });

  it('does not match a call of another tool use', async () => {
    renderErrors(
      {},
      {
        sessionTimeline: () => makeEventPage([BARE_FAILURE]),
        sessionToolCalls: () => makePage([toolCall({ toolUseId: toolUseId(2) })]),
      },
    );
    expect(await screen.findByText('tool.failure')).toBeInTheDocument();
    expect(screen.queryByText('Grep')).toBeNull();
  });
});
