import type { InstanceInfo, InstanceSearchResponse } from '@mcs/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { makeInstance, makeInstanceSearch, makeInstanceSearchMatch, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../../test/render.tsx';
import { SearchPage } from './SearchPage.tsx';

const INSTANCE = makeInstance({
  features: { transcriptSearch: 'instance', costEstimates: false, usageTrend: true, hooks: false },
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function answer(q: string, over: Partial<InstanceSearchResponse> = {}): InstanceSearchResponse {
  return makeInstanceSearch({
    query: { q, kinds: [] },
    matches: [
      makeInstanceSearchMatch({
        sessionId: sessionId(1),
        sessionLabel: 'FIXTURE alpha',
        i: 4,
        snippet: `FIXTURE ${q} one`,
      }),
      makeInstanceSearchMatch({
        sessionId: sessionId(1),
        sessionLabel: 'FIXTURE alpha',
        agentId: 'agentqa001',
        i: 9,
        snippet: `FIXTURE ${q} two`,
      }),
      makeInstanceSearchMatch({
        sessionId: sessionId(2),
        sessionLabel: 'FIXTURE beta',
        i: 1,
        snippet: `FIXTURE ${q} three`,
      }),
    ],
    ...over,
  });
}

interface Harness {
  api: FakeApi;
}

function setup(
  route: string,
  handlers: FakeHandlers = {},
  options: RenderOptions & { served?: InstanceInfo } = {},
): Harness {
  const { served, ...renderOptions } = options;
  const api = createFakeApi({
    instance: () => served ?? INSTANCE,
    searchTranscripts: (query) => answer(query.get('q') ?? ''),
    ...handlers,
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      {children}
      <LocationProbe />
    </ShortcutRegistryProvider>
  );
  renderWithIntl(<SearchPage />, { route, api, instance: served ?? INSTANCE, wrap, ...renderOptions });
  return { api };
}

const box = () => screen.getByRole('searchbox', { name: msg('search.form.query') });
const submitButton = () => screen.getByRole('button', { name: msg('search.form.submit') });
const SUMMARY = () => msg('search.summary', { count: 3, sessions: 2 });

/** A request that stays open until the test ends. */
const never: FakeHandlers = { searchTranscripts: () => new Promise(() => undefined) };

describe('SearchPage', () => {
  it('shows the heading, sets the document title and starts idle without a request', () => {
    const h = setup('/search');
    expect(screen.getByRole('heading', { level: 1, name: msg('route.search.title') })).toBeInTheDocument();
    expect(document.title).toContain(msg('route.search.title'));
    expect(screen.getByText(msg('search.idle.title'))).toBeInTheDocument();
    expect(screen.getByText(msg('search.form.budget', { seconds: 3 }))).toBeInTheDocument();
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(0);
  });

  it('shows only its heading until the app providers are there', () => {
    setup('/search', {}, { instanceId: null });
    expect(screen.getByRole('heading', { level: 1, name: msg('route.search.title') })).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('says that search across sessions is not available when the instance does not offer it', () => {
    const served = makeInstance();
    const h = setup('/search?q=needle', {}, { served });
    expect(screen.getByText(msg('search.unavailable.title'))).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(0);
  });

  it('asks for two characters and sends nothing for one', async () => {
    const user = userEvent.setup();
    const h = setup('/search');
    await user.type(box(), 'a');
    expect(screen.getByText(msg('search.form.minChars'))).toBeInTheDocument();
    await user.click(submitButton());
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(0);
    expect(screen.getByTestId('search')).toHaveTextContent('');
  });

  it('does not send a one character text from the address either', () => {
    const h = setup('/search?q=a');
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(0);
    expect(screen.getByText(msg('search.form.minChars'))).toBeInTheDocument();
  });

  it('runs only on submit: typing sends nothing, Search puts the text in the address and shows the matches by session', async () => {
    const user = userEvent.setup();
    const h = setup('/search');
    await user.type(box(), 'needle');
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(0);
    await user.click(submitButton());
    await screen.findByText(SUMMARY());
    expect(screen.getByTestId('search')).toHaveTextContent('?q=needle');
    const call = h.api.callsTo('searchTranscripts')[0];
    expect(call?.query.get('q')).toBe('needle');
    expect(call?.query.get('limit')).toBe('100');
    expect(call?.query.get('budgetMs')).toBe('3000');
    expect(call?.query.has('kinds')).toBe(false);
    expect(screen.getByRole('link', { name: 'FIXTURE alpha' })).toHaveAttribute('href', `/sessions/${sessionId(1)}`);
    expect(screen.getByRole('link', { name: 'FIXTURE beta' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /FIXTURE needle one/ })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}?tab=transcript&i=4`,
    );
    expect(screen.getByRole('link', { name: /FIXTURE needle two/ })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}?tab=transcript&agent=agentqa001&i=9`,
    );
  });

  it('sends the selected kinds and writes them into the address', async () => {
    const user = userEvent.setup();
    const h = setup('/search');
    await user.click(screen.getByRole('button', { name: msg('transcript.kind.tool') }));
    await user.click(screen.getByRole('button', { name: msg('transcript.kind.result') }));
    await user.type(box(), 'needle{Enter}');
    await screen.findByText(SUMMARY());
    expect(h.api.callsTo('searchTranscripts')[0]?.query.get('kinds')).toBe('tool,result');
    expect(screen.getByTestId('search')).toHaveTextContent('q=needle');
    expect(screen.getByTestId('search')).toHaveTextContent('kinds=tool%2Cresult');
  });

  it('runs the search that the address holds', async () => {
    const h = setup('/search?q=needle&kinds=say');
    await screen.findByText(SUMMARY());
    expect(h.api.callsTo('searchTranscripts')[0]?.query.get('kinds')).toBe('say');
    expect(box()).toHaveValue('needle');
    expect(screen.getByRole('button', { name: msg('transcript.kind.say') })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the searched text out of the document title', async () => {
    setup('/search?q=needle-secret');
    await screen.findByText(SUMMARY());
    expect(document.title).not.toContain('needle-secret');
  });

  it('shows a loading state, and Escape cancels the search and offers to run it again', async () => {
    const user = userEvent.setup();
    const h = setup('/search', never);
    await user.type(box(), 'needle{Enter}');
    expect(await screen.findByText(msg('search.loading'))).toBeInTheDocument();
    expect(screen.getByText(msg('search.cancelHint'))).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(await screen.findByText(msg('search.cancelled'))).toBeInTheDocument();
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(1);
    h.api.handlers = { ...h.api.handlers, searchTranscripts: (query) => answer(query.get('q') ?? '') };
    await user.click(screen.getByRole('button', { name: msg('search.again') }));
    await screen.findByText(SUMMARY());
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(2);
  });

  it('cancels with the button as well', async () => {
    const user = userEvent.setup();
    setup('/search', never);
    await user.type(box(), 'needle{Enter}');
    await user.click(await screen.findByRole('button', { name: msg('search.cancel') }));
    expect(await screen.findByText(msg('search.cancelled'))).toBeInTheDocument();
  });

  it('runs the same search again when Search is pressed twice', async () => {
    const user = userEvent.setup();
    const h = setup('/search');
    await user.type(box(), 'needle{Enter}');
    await screen.findByText(SUMMARY());
    await user.click(submitButton());
    await waitFor(() => {
      expect(h.api.callsTo('searchTranscripts')).toHaveLength(2);
    });
    await screen.findByText(SUMMARY());
  });

  it('clears the text with Escape when nothing is running', async () => {
    const user = userEvent.setup();
    setup('/search');
    await user.type(box(), 'needle');
    await user.keyboard('{Escape}');
    expect(box()).toHaveValue('');
  });

  it('says there are no matches, and that the whole instance was searched', async () => {
    setup('/search?q=needle', { searchTranscripts: () => makeInstanceSearch({ query: { q: 'needle', kinds: [] } }) });
    expect(await screen.findByText(msg('search.empty.title'))).toBeInTheDocument();
    expect(screen.getByText(msg('search.coverage.files', { scanned: 3, total: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(msg('search.coverage.incomplete'))).toBeNull();
  });

  it('does not claim "no matches" when part of the transcripts was not searched', async () => {
    setup('/search?q=needle', {
      searchTranscripts: () =>
        makeInstanceSearch({
          query: { q: 'needle', kinds: [] },
          coverage: {
            ...makeInstanceSearch().coverage,
            filesInScope: 5,
            filesScanned: 2,
            complete: false,
            stoppedBy: 'time_budget',
          },
        }),
    });
    expect(await screen.findByText(msg('search.empty.incompleteTitle'))).toBeInTheDocument();
    expect(screen.queryByText(msg('search.empty.title'))).toBeNull();
  });

  it('shows incomplete coverage with its reasons and the note of the server', async () => {
    setup('/search?q=needle', {
      searchTranscripts: () =>
        answer('needle', {
          truncated: true,
          coverage: {
            ...makeInstanceSearch().coverage,
            filesInScope: 5,
            filesScanned: 2,
            filesMissing: 1,
            filesUnreadable: 2,
            bytesNotIndexed: 2048,
            complete: false,
            stoppedBy: 'time_budget',
            note: 'FIXTURE server note about the files',
          },
        }),
    });
    await screen.findByText(msg('search.coverage.files', { scanned: 2, total: 5 }));
    expect(screen.getByText(msg('search.coverage.incomplete'))).toBeInTheDocument();
    expect(screen.getByText(msg('search.coverage.missing', { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(msg('search.coverage.unreadable', { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(msg('search.coverage.timeBudget'))).toBeInTheDocument();
    expect(screen.getByText('FIXTURE server note about the files')).toBeInTheDocument();
    expect(screen.getByText(msg('search.truncated', { count: 3 }))).toBeInTheDocument();
  });

  it('shows the busy message and tries again on request', async () => {
    const user = userEvent.setup();
    const h = setup('/search?q=needle', { searchTranscripts: () => errorResponse('search_busy') });
    expect(await screen.findByText(msg('search.busy'))).toBeInTheDocument();
    h.api.handlers = { ...h.api.handlers, searchTranscripts: (query) => answer(query.get('q') ?? '') };
    await user.click(screen.getByRole('button', { name: msg('common.retry') }));
    await screen.findByText(SUMMARY());
    expect(h.api.callsTo('searchTranscripts')).toHaveLength(2);
  });

  it('shows another failure with its reason', async () => {
    setup('/search?q=needle', { searchTranscripts: () => errorResponse('internal_error') });
    const prefix = msg('search.failedPlain').slice(0, -1);
    expect(await screen.findByText((text) => text.startsWith(prefix))).toBeInTheDocument();
  });

  it('puts nothing of the typed text in the address of any request but the search', async () => {
    const user = userEvent.setup();
    const h = setup('/search');
    await user.type(box(), 'needle-secret{Enter}');
    await screen.findByText(SUMMARY());
    for (const call of h.api.calls) {
      if (call.id !== 'searchTranscripts') expect(call.url).not.toContain('needle-secret');
    }
  });

  it('speaks Vietnamese', () => {
    setup('/search', {}, { locale: 'vi' });
    expect(screen.getByText(msg('search.idle.title', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('search.form.submit', undefined, 'vi') })).toBeInTheDocument();
  });
});
