import type { ActivityEvent, SessionDetail } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation, useNavigationType } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext } from '../../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  agentId,
  iso,
  makeAgent,
  makeAgentPage,
  makeEvent,
  makeEventPage,
  makeInstance,
  makeSessionDetail,
  makeState,
  makeTranscriptWindow,
  makeUsage,
  sessionId,
} from '../../test/fixtures/index.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionDetailPage } from './SessionDetailPage.tsx';

const SID = sessionId(1);
const INSTANCE = makeInstance();

beforeAll(() => {
  // happy-dom has no layout: the transcript viewer scrolls rows into view
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe() {
  const { pathname, search } = useLocation();
  const type = useNavigationType();
  return (
    <>
      <output data-testid="location">{pathname + search}</output>
      <output data-testid="nav-type">{type}</output>
    </>
  );
}

interface Setup {
  route?: string;
  detail?: Partial<SessionDetail>;
  handlers?: FakeHandlers;
  toasts?: ReturnType<typeof createToastStore>;
}

function renderDetail(setup: Setup = {}) {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    getSession: () => makeSessionDetail(setup.detail),
    sessionAgents: () => makeAgentPage([makeAgent({ id: 'main', kind: 'main', depth: 0, parentAgentId: null })]),
    transcriptWindow: () => makeTranscriptWindow(4),
    sessionTimeline: () => makeEventPage([]),
    ...setup.handlers,
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      <ToastStoreContext value={setup.toasts ?? null}>
        <Probe />
        {children}
      </ToastStoreContext>
    </ShortcutRegistryProvider>
  );
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
      <Route path="/sessions" element={<p>FIXTURE sessions list</p>} />
    </Routes>,
    { route: setup.route ?? `/sessions/${SID}`, api, instance: INSTANCE, wrap },
  );
  return { ...rendered, api };
}

function location(): string {
  return screen.getByTestId('location').textContent;
}

describe('SessionDetailPage', () => {
  it('shows the header of the session and the transcript tab by default', async () => {
    const { api } = renderDetail({ detail: { label: 'FIXTURE detail label' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'FIXTURE detail label' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Transcript/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeInTheDocument();
    expect(api.callsTo('getSession')[0]?.params['sessionId']).toBe(SID);
    expect(document.title).toContain('FIXTURE detail label');
    expect(api.violations).toEqual([]);
  });

  it('pushes ?tab= when a tab is chosen and keeps the chosen agent', async () => {
    renderDetail({ route: `/sessions/${SID}?agent=${agentId(1)}` });
    await screen.findByRole('tablist');
    expect(screen.getByTestId('nav-type')).toHaveTextContent('POP');
    await userEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
    expect(location()).toBe(`/sessions/${SID}?tab=timeline&agent=${agentId(1)}`);
    expect(screen.getByTestId('nav-type')).toHaveTextContent('PUSH');
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Transcript/ }));
    expect(location()).toBe(`/sessions/${SID}?agent=${agentId(1)}`);
  });

  it('opens the tab named in the address', async () => {
    renderDetail({ route: `/sessions/${SID}?tab=tokens` });
    expect(await screen.findByRole('tab', { name: /Tokens/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Token numbers come from transcripts only; hooks carry no usage.')).toBeInTheDocument();
  });

  it('shows the not-found state for an unknown session', async () => {
    renderDetail({ handlers: { getSession: () => errorResponse('session_not_found') } });
    expect(
      await screen.findByText(
        'The monitor does not know this session. It may be outside the session window or belong to another task.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sessions' })).toHaveAttribute('href', '/sessions');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows a banner for an agent that is not part of the session', async () => {
    renderDetail({ route: `/sessions/${SID}?agent=agent-9999` });
    expect(await screen.findByText('Agent agent-9999 is not part of this session')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open the main agent' });
    expect(link).toHaveAttribute('href', `/sessions/${SID}`);
  });

  it('does not show the banner for an agent of the session', async () => {
    renderDetail({
      route: `/sessions/${SID}?agent=${agentId(1)}`,
      handlers: {
        sessionAgents: () =>
          makeAgentPage([
            makeAgent({ id: 'main', kind: 'main', depth: 0, parentAgentId: null }),
            makeAgent({ id: agentId(1), label: 'FIXTURE agent A' }),
          ]),
      },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'FIXTURE build step A / FIXTURE agent A' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is not part of this session/)).toBeNull();
  });

  it('lists the evidence of the state behind a disclosure', async () => {
    renderDetail({
      detail: {
        state: makeState('waiting_input', {
          basis: 'inferred',
          confidence: 'medium',
          evidence: [{ kind: 'hook:notification', at: iso(-20), text: 'FIXTURE evidence text' }],
        }),
      },
    });
    const toggle = await screen.findByRole('button', { name: 'Why this state?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('FIXTURE evidence text')).not.toBeVisible();
    await userEvent.click(toggle);
    expect(screen.getByText('FIXTURE evidence text')).toBeVisible();
    expect(screen.getByText(/inferred/)).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/)).toBeInTheDocument();
  });

  it('tags a session that is not in the list and a label that comes from a rule', async () => {
    renderDetail({ detail: { matched: false, labelSource: 'rule' } });
    expect(await screen.findByText('not in list')).toBeInTheDocument();
    expect(screen.getByText('label from rule')).toBeInTheDocument();
  });

  it('links the work items of the session to the filtered session list', async () => {
    renderDetail({ detail: { workItems: [{ id: 7, title: 'FIXTURE work item', state: 'working' }] } });
    const link = await screen.findByRole('link', { name: /FIXTURE work item/ });
    expect(link).toHaveAttribute('href', '/sessions?task=7');
  });

  it('copies the link of the current view', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderDetail({ route: `/sessions/${SID}?tab=timeline` });
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/sessions/${SID}?tab=timeline`);
    });
  });

  it('shows the audit references of the session as text', async () => {
    renderDetail({
      detail: {
        auditRefs: [{ file: 'decisions', at: iso(-100), title: 'FIXTURE decision title', summary: 'FIXTURE <b>x</b>' }],
      },
    });
    const section = await screen.findByRole('region', { name: 'Audit references' });
    expect(within(section).getByText('FIXTURE decision title')).toBeInTheDocument();
    expect(within(section).getByText('FIXTURE <b>x</b>')).toBeInTheDocument();
    expect(within(section).getByText('decisions')).toBeInTheDocument();
  });

  it('shows no audit section without references', async () => {
    renderDetail();
    await screen.findByRole('tablist');
    expect(screen.queryByRole('region', { name: 'Audit references' })).toBeNull();
  });

  it('keeps the header and shows a refresh failure when a later load fails', async () => {
    let fail = false;
    const { queryClient } = renderDetail({
      handlers: { getSession: () => (fail ? errorResponse('internal_error') : makeSessionDetail()) },
    });
    await screen.findByRole('tablist');
    fail = true;
    await queryClient.refetchQueries({ queryKey: ['mcs'], type: 'active' });
    expect(await screen.findByText(/Could not refresh session/)).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  describe('Timeline tab', () => {
    const route = `/sessions/${SID}?tab=timeline`;

    it('lists the events with their sources and shows a gap as a separator', async () => {
      renderDetail({
        route,
        handlers: {
          sessionTimeline: () =>
            makeEventPage([
              makeEvent({ id: 3, summary: 'FIXTURE tool event', sources: ['hook', 'transcript'], type: 'tool.call' }),
              makeEvent({ id: 2, summary: 'FIXTURE missing events', type: 'monitor.gap', category: 'ingest' }),
              makeEvent({
                id: 1,
                summary: 'FIXTURE failed',
                severity: 'error',
                type: 'tool.failure',
                category: 'tool',
              }),
            ]),
        },
      });
      expect(await screen.findByText('FIXTURE tool event')).toBeInTheDocument();
      const row = screen.getByText('FIXTURE tool event').closest('li') as HTMLElement;
      expect(within(row).getByText('hook')).toBeInTheDocument();
      expect(within(row).getByText('transcript')).toBeInTheDocument();
      const gap = screen.getByRole('note');
      expect(gap).toHaveTextContent('Events may be missing here: FIXTURE missing events');
      const failed = screen.getByText('FIXTURE failed').closest('li') as HTMLElement;
      expect(within(failed).getByText('error')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Events recorded by the monitor (hooks and lifecycle). For the conversation itself see Transcript.',
        ),
      ).toBeInTheDocument();
    });

    it('explains an empty timeline when hooks are off', async () => {
      renderDetail({ route, detail: { sources: { hooks: false, transcript: true } } });
      expect(
        await screen.findByText(
          'No monitor events for this session. Hooks may be off; the Transcript tab shows the conversation.',
        ),
      ).toBeInTheDocument();
    });

    it('filters by category through the URL', async () => {
      const { api } = renderDetail({ route });
      await screen.findByRole('group', { name: 'Event categories' });
      await userEvent.click(screen.getByRole('checkbox', { name: 'tool' }));
      expect(location()).toBe(`/sessions/${SID}?tab=timeline&types=tool`);
      await waitFor(() => {
        expect(api.callsTo('sessionTimeline').some((call) => call.query.get('category') === 'tool')).toBe(true);
      });
    });

    it('restricts the timeline to the chosen agent', async () => {
      const { api } = renderDetail({ route: `${route}&agent=${agentId(1)}` });
      await screen.findByRole('tablist');
      await waitFor(() => {
        expect(api.callsTo('sessionTimeline')[0]?.query.get('agent')).toBe(agentId(1));
      });
    });

    it('locates an event in the transcript and opens that entry', async () => {
      const event: ActivityEvent = makeEvent({
        id: 5,
        summary: 'FIXTURE locatable',
        transcriptRef: { agentId: agentId(2), offset: 128 },
      });
      const { api } = renderDetail({
        route,
        handlers: {
          sessionTimeline: () => makeEventPage([event]),
          transcriptLocate: () => ({ i: 7, t: iso(-5), base: 0, total: 10 }),
        },
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Show in transcript' }));
      await waitFor(() => {
        expect(location()).toBe(`/sessions/${SID}?agent=${agentId(2)}&i=7`);
      });
      const call = api.callsTo('transcriptLocate')[0];
      expect(call?.query.get('agent')).toBe(agentId(2));
      expect(call?.query.get('offset')).toBe('128');
    });

    it('tells the user when the entry cannot be located', async () => {
      const toasts = createToastStore();
      renderDetail({
        route,
        toasts,
        handlers: {
          sessionTimeline: () => makeEventPage([makeEvent({ id: 5, transcriptRef: { agentId: 'main', offset: 0 } })]),
          transcriptLocate: () => errorResponse('transcript_gone'),
        },
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Show in transcript' }));
      await waitFor(() => {
        expect(toasts.getSnapshot().some((toast) => toast.message.startsWith('Could not open the transcript'))).toBe(
          true,
        );
      });
      expect(location()).toBe(`/sessions/${SID}?tab=timeline`);
    });

    it('offers no transcript link for an event without a transcript reference', async () => {
      renderDetail({
        route,
        handlers: { sessionTimeline: () => makeEventPage([makeEvent({ id: 5, transcriptRef: null })]) },
      });
      await screen.findByText('FIXTURE assistant reply');
      expect(screen.queryByRole('button', { name: 'Show in transcript' })).toBeNull();
    });
  });

  describe('Agents tab', () => {
    it('renders the agent tree', async () => {
      renderDetail({
        route: `/sessions/${SID}?tab=agents`,
        handlers: {
          sessionAgents: () =>
            makeAgentPage([
              makeAgent({ id: 'main', kind: 'main', depth: 0, parentAgentId: null, label: 'FIXTURE main agent' }),
              makeAgent({ id: agentId(1), label: 'FIXTURE agent A' }),
            ]),
        },
      });
      expect(await screen.findByText('FIXTURE agent A')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Subagents/ })).toBeInTheDocument();
    });

    it('says so when the session has no subagents', async () => {
      renderDetail({ route: `/sessions/${SID}?tab=agents` });
      expect(await screen.findByText('This session has no subagents.')).toBeInTheDocument();
    });
  });

  describe('Tokens tab', () => {
    it('shows the token source note, the session numbers and one row per agent', async () => {
      renderDetail({
        route: `/sessions/${SID}?tab=tokens`,
        handlers: {
          sessionAgents: () =>
            makeAgentPage([
              makeAgent({ id: 'main', kind: 'main', depth: 0, parentAgentId: null, label: 'FIXTURE main agent' }),
              makeAgent({
                id: agentId(1),
                label: 'FIXTURE partial agent',
                model: 'fixture-model-b',
                usage: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 50 }),
              }),
              makeAgent({ id: agentId(2), label: 'FIXTURE complete agent' }),
            ]),
        },
      });
      expect(
        await screen.findByText('Token numbers come from transcripts only; hooks carry no usage.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Cache read')).toBeInTheDocument();
      const table = await screen.findByRole('table', { name: 'Tokens per agent' });
      const partial = within(table).getByText('FIXTURE partial agent').closest('tr') as HTMLElement;
      const complete = within(table).getByText('FIXTURE complete agent').closest('tr') as HTMLElement;
      expect(within(partial).getByText('lower bound')).toBeInTheDocument();
      expect(within(partial).getByText('fixture-model-b')).toBeInTheDocument();
      expect(within(complete).queryByText('lower bound')).toBeNull();
    });

    it('labels session numbers as a lower bound when the usage says so', async () => {
      renderDetail({
        route: `/sessions/${SID}?tab=tokens`,
        detail: { usageInclSubagents: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 10 }) },
      });
      await screen.findByText('Cache read');
      expect(screen.getAllByText('lower bound').length).toBeGreaterThan(0);
      expect(screen.getAllByText('(incl. subagents)').length).toBeGreaterThan(1);
    });
  });

  describe('Errors tab', () => {
    it('asks for warnings and errors only and lists them', async () => {
      const { api } = renderDetail({
        route: `/sessions/${SID}?tab=errors`,
        handlers: {
          sessionTimeline: () =>
            makeEventPage([
              makeEvent({
                id: 2,
                severity: 'error',
                summary: 'FIXTURE the error',
                category: 'error',
                type: 'api.error',
              }),
              makeEvent({ id: 1, severity: 'warning', summary: 'FIXTURE the warning', category: 'tool' }),
            ]),
        },
      });
      expect(await screen.findByText('FIXTURE the error')).toBeInTheDocument();
      expect(screen.getByText('FIXTURE the warning')).toBeInTheDocument();
      expect(api.callsTo('sessionTimeline')[0]?.query.get('severity')).toBe('warning,error');
    });

    it('says so when there are no errors', async () => {
      renderDetail({ route: `/sessions/${SID}?tab=errors` });
      expect(await screen.findByText('No errors or warnings recorded for this session.')).toBeInTheDocument();
    });
  });
});
