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
import { msg } from '../../test/msg.ts';
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
  locale?: 'en' | 'vi';
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
    { route: setup.route ?? `/sessions/${SID}`, api, instance: INSTANCE, wrap, locale: setup.locale ?? 'en' },
  );
  return { ...rendered, api };
}

function location(): string {
  return screen.getByTestId('location').textContent;
}

function viewLink(tab: 'transcript' | 'errors' | 'agents' | 'tokens' | 'events'): HTMLElement {
  return screen.getByRole('link', { name: new RegExp(`^${msg(`detail.tab.${tab}`)}`) });
}

async function openDetails(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: msg('detail.details') }));
}

describe('SessionDetailPage', () => {
  it('shows the header of the session and the transcript view by default', async () => {
    const { api } = renderDetail({ detail: { label: 'FIXTURE detail label' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'FIXTURE detail label' })).toBeInTheDocument();
    expect(viewLink('transcript')).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeInTheDocument();
    expect(api.callsTo('getSession')[0]?.params['sessionId']).toBe(SID);
    expect(document.title).toContain('FIXTURE detail label');
    expect(api.violations).toEqual([]);
  });

  it('is a header, four tiles and a navigation of links, with no tab roles', async () => {
    renderDetail();
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    expect(screen.getByRole('group', { name: msg('detail.stats.label') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.back') })).toHaveAttribute('href', '/sessions');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('pushes ?tab= when a view link is chosen and keeps the chosen agent', async () => {
    renderDetail({ route: `/sessions/${SID}?agent=${agentId(1)}` });
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    expect(screen.getByTestId('nav-type')).toHaveTextContent('POP');
    await userEvent.click(viewLink('events'));
    expect(location()).toBe(`/sessions/${SID}?tab=events&agent=${agentId(1)}`);
    expect(screen.getByTestId('nav-type')).toHaveTextContent('PUSH');
    expect(viewLink('events')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(viewLink('transcript'));
    expect(location()).toBe(`/sessions/${SID}?agent=${agentId(1)}`);
  });

  it('opens the view named in the address', async () => {
    renderDetail({ route: `/sessions/${SID}?tab=tokens` });
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    expect(viewLink('tokens')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Token numbers come from transcripts only; hooks carry no usage.')).toBeInTheDocument();
  });

  it('reads the old timeline address as the Events view and writes the new name back', async () => {
    renderDetail({ route: `/sessions/${SID}?tab=timeline&types=tool` });
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    await waitFor(() => {
      expect(location()).toBe(`/sessions/${SID}?tab=events&types=tool`);
    });
    expect(viewLink('events')).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('group', { name: 'Event categories' })).toBeInTheDocument();
  });

  it('shows the not-found state for an unknown session', async () => {
    renderDetail({ handlers: { getSession: () => errorResponse('session_not_found') } });
    expect(await screen.findByText(msg('error.sessionNotFound'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.notFound.back') })).toHaveAttribute('href', '/sessions');
    expect(screen.getByRole('heading', { level: 1, name: msg('route.sessionDetail.title') })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: msg('detail.tabs.label') })).toBeNull();
  });

  it('shows a header-shaped placeholder while the session loads', async () => {
    renderDetail({ handlers: { getSession: () => new Promise<never>(() => undefined) } });
    const statuses = () => screen.queryAllByRole('status').filter((element) => element.tagName === 'SPAN');
    await waitFor(() => {
      expect(statuses()).toHaveLength(1);
    });
    expect(statuses()[0]).toHaveTextContent(msg('detail.loading'));
    const frame = document.querySelector('.session-frame');
    expect(frame).toHaveAttribute('data-loading', 'true');
    expect(frame?.querySelector('.skeleton--header')).not.toBeNull();
    expect(frame?.querySelectorAll('.skeleton--tiles .skeleton__row')).toHaveLength(4);
    // one status for screen readers (the tile placeholders are hidden), a heading to focus, and no view links yet
    expect(screen.getByRole('heading', { level: 1, name: msg('route.sessionDetail.title') })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: msg('detail.tabs.label') })).toBeNull();
  });

  it('draws the loaded header in the same frame as the placeholder, with as many tiles as it had', async () => {
    renderDetail();
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    const frame = document.querySelector('.session-frame');
    expect(frame).not.toHaveAttribute('data-loading');
    expect(frame?.classList.contains('card')).toBe(true);
    expect(frame?.querySelectorAll('.session-stat')).toHaveLength(4);
  });

  it('shows the contract error when the monitor answers something the page cannot read', async () => {
    renderDetail({
      handlers: {
        getSession: () =>
          new Response('{"unexpected":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      },
    });
    const state = await screen.findByText(/this page cannot read/);
    expect(state.closest('[data-kind]')).toHaveAttribute('data-kind', 'contract');
    expect(screen.getByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
  });

  it('shows a load error with a retry for another failure', async () => {
    renderDetail({ handlers: { getSession: () => errorResponse('internal_error') } });
    const state = await screen.findByText(/Could not load session/);
    expect(state.closest('[data-kind]')).toHaveAttribute('data-kind', 'load');
    expect(screen.getByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
  });

  it('shows a banner for an agent that is not part of the session', async () => {
    renderDetail({ route: `/sessions/${SID}?agent=agent-9999` });
    expect(await screen.findByText(msg('detail.agentMissing', { agent: 'agent-9999' }))).toBeInTheDocument();
    const link = screen.getByRole('link', { name: msg('detail.agentMissing.open') });
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
    expect(screen.queryByText(msg('detail.agentMissing', { agent: agentId(1) }))).toBeNull();
  });

  it('puts the evidence of the state behind a button, in plain words', async () => {
    renderDetail({
      detail: {
        state: makeState('waiting_input', {
          basis: 'inferred',
          confidence: 'medium',
          evidence: [{ kind: 'hook:notification', at: iso(-20), text: 'FIXTURE evidence text' }],
        }),
      },
    });
    const toggle = await screen.findByRole('button', { name: msg('detail.evidence') });
    expect(screen.queryByText('FIXTURE evidence text', { selector: 'li' })).toBeNull();
    await userEvent.click(toggle);
    const panel = screen.getByRole('dialog', { name: msg('detail.evidence.panel') });
    expect(within(panel).getByText('FIXTURE evidence text')).toBeInTheDocument();
    expect(panel).toHaveTextContent(msg('evidence.confidence.medium'));
  });

  it('has the Details section closed, with no field of dashes, and the whole id inside it', async () => {
    renderDetail({ detail: { id: SID, cwd: null, permissionMode: null, gitBranch: null } });
    const toggle = await screen.findByRole('button', { name: msg('detail.details') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(SID)).not.toBeVisible();
    expect(screen.queryByText(msg('detail.details.cwd'))).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText(SID)).toBeVisible();
  });

  it('tags a session that is not in the list and says where its label came from', async () => {
    renderDetail({ detail: { matched: false, labelSource: 'rule' } });
    expect(await screen.findByText(msg('detail.notInList'))).toBeInTheDocument();
    await openDetails();
    expect(screen.getByText(msg('detail.details.label.rule'))).toBeInTheDocument();
  });

  it('links the work items of the session to the filtered session list', async () => {
    renderDetail({ detail: { workItems: [{ id: 7, title: 'FIXTURE work item', state: 'working' }] } });
    await openDetails();
    const link = screen.getByRole('link', { name: /FIXTURE work item/ });
    expect(link).toHaveAttribute('href', '/sessions?task=7');
  });

  it('copies the link of the current view', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderDetail({ route: `/sessions/${SID}?tab=events` });
    await user.click(await screen.findByRole('button', { name: msg('detail.copyLink') }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/sessions/${SID}?tab=events`);
    });
  });

  it('shows the audit references of the session as text, inside Details', async () => {
    renderDetail({
      detail: {
        auditRefs: [{ file: 'decisions', at: iso(-100), title: 'FIXTURE decision title', summary: 'FIXTURE <b>x</b>' }],
      },
    });
    await openDetails();
    const section = screen.getByRole('region', { name: msg('detail.auditRefs.title') });
    expect(within(section).getByText('FIXTURE decision title')).toBeInTheDocument();
    expect(within(section).getByText('FIXTURE <b>x</b>')).toBeInTheDocument();
    expect(within(section).getByText(msg('detail.auditRefs.decisions'))).toBeInTheDocument();
  });

  it('shows no audit section without references', async () => {
    renderDetail();
    await openDetails();
    expect(screen.queryByRole('region', { name: msg('detail.auditRefs.title') })).toBeNull();
  });

  it('keeps the header and shows a refresh failure when a later load fails', async () => {
    let fail = false;
    const { queryClient } = renderDetail({
      handlers: { getSession: () => (fail ? errorResponse('internal_error') : makeSessionDetail()) },
    });
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    fail = true;
    await queryClient.refetchQueries({ queryKey: ['mcs'], type: 'active' });
    expect(await screen.findByText(/Could not refresh session/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: msg('detail.tabs.label') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('shows the count of errors and warnings on the Errors link', async () => {
    renderDetail({ detail: { errorCount: 2, warningCount: 1 } });
    await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
    expect(screen.getByRole('link', { name: new RegExp(msg('detail.tab.issues', { count: 3 })) })).toHaveAttribute(
      'href',
      `/sessions/${SID}?tab=errors`,
    );
  });

  describe('error breakdown', () => {
    const agents = (mainErrors: number, helperErrors: number) => ({
      sessionAgents: () =>
        makeAgentPage([
          makeAgent({ id: 'main', kind: 'main', depth: 0, parentAgentId: null, errorCount: mainErrors }),
          makeAgent({ id: agentId(1), label: 'FIXTURE helper', errorCount: helperErrors }),
        ]),
    });
    const breakdown = msg('transcript.errors.breakdown', { thisAgent: 0, subagents: 1 });

    it('says that the only error belongs to a subagent, in the tile and in the transcript, with a link to the Errors view', async () => {
      renderDetail({ detail: { errorCount: 1 }, handlers: agents(0, 1) });
      const links = await screen.findAllByRole('link', { name: msg('transcript.errors.viewAll') });
      expect(links.length).toBeGreaterThanOrEqual(2);
      for (const link of links) expect(link).toHaveAttribute('href', `/sessions/${SID}?tab=errors`);
      expect(screen.getAllByText(breakdown)).toHaveLength(2);
    });

    it('draws no breakdown while the agents are not known', async () => {
      renderDetail({
        detail: { errorCount: 1 },
        handlers: { sessionAgents: () => new Promise<never>(() => undefined) },
      });
      await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
      expect(screen.queryByText(breakdown)).toBeNull();
    });

    it('draws no breakdown when the main agent has all the errors', async () => {
      renderDetail({ detail: { errorCount: 2 }, handlers: agents(2, 0) });
      await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
      await screen.findByRole('region', { name: 'Transcript' });
      expect(screen.queryByText(/in subagents/)).toBeNull();
    });

    it('draws no breakdown for a chosen subagent, whose rest is not all subagents', async () => {
      renderDetail({
        route: `/sessions/${SID}?agent=${agentId(1)}`,
        detail: { errorCount: 1 },
        handlers: agents(0, 1),
      });
      await screen.findByRole('heading', { level: 1, name: 'FIXTURE build step A / FIXTURE helper' });
      expect(screen.queryByText(breakdown)).toBeNull();
    });
  });

  it('is worded in Vietnamese', async () => {
    renderDetail({ locale: 'vi', detail: { errorCount: 1, matched: false } });
    expect(
      await screen.findByRole('navigation', { name: msg('detail.tabs.label', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.back', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('detail.notInList', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByText(msg('detail.stats.activeSpan', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('detail.details', undefined, 'vi') })).toBeInTheDocument();
  });

  describe('Timeline tab', () => {
    const route = `/sessions/${SID}?tab=events`;

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
      expect(location()).toBe(`/sessions/${SID}?tab=events&types=tool`);
      await waitFor(() => {
        expect(api.callsTo('sessionTimeline').some((call) => call.query.get('category') === 'tool')).toBe(true);
      });
    });

    it('restricts the timeline to the chosen agent', async () => {
      const { api } = renderDetail({ route: `${route}&agent=${agentId(1)}` });
      await screen.findByRole('navigation', { name: msg('detail.tabs.label') });
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
      expect(location()).toBe(`/sessions/${SID}?tab=events`);
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
