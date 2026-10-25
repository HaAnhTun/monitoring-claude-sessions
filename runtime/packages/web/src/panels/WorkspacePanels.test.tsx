import type { InstanceInfo, PanelKey } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLL } from '../data/hooks/useInstance.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../test/fake-api.ts';
import { iso, makeInstance, makePanelData, makePanelResponse } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../test/render.tsx';
import { createPrefs } from '../lib/prefs.ts';
import { createPrefsStore } from '../state/prefs-store.ts';
import { WorkspacePanels, collapsedKey } from './WorkspacePanels.tsx';

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;
const NONE: InstanceInfo['panels'] = {
  git: false,
  machine: false,
  attempts: false,
  ledger: false,
  chainLog: false,
  logs: false,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** An answer made now: the status of a panel depends on the age of `generatedAt`, and the fixture clock is in the past. */
function fresh<K extends PanelKey>(key: K, over: Parameters<typeof makePanelResponse<K>>[1] = {}) {
  const generatedAt = new Date(Date.now()).toISOString();
  return makePanelResponse(key, {
    generatedAt,
    sources: [{ source: 'memory', status: 'ok', sampledAt: generatedAt, message: null }],
    ...over,
  });
}

function instanceWith(on: PanelKey[], over: Partial<InstanceInfo> = {}): InstanceInfo {
  const panels = { ...NONE };
  for (const key of on) panels[key] = true;
  return makeInstance({ panels, ...over });
}

function setup(instance: InstanceInfo, handlers: FakeHandlers = {}, options: RenderOptions = {}) {
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    panel: (_query, request) => fresh(request.params['key'] as PanelKey),
    ...handlers,
  });
  const rendered = renderWithIntl(<WorkspacePanels />, { api, instance, ...options });
  return { ...rendered, api };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function headings(): string[] {
  return screen.queryAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
}

/** The browser reports a narrow window (below 900 px). */
function stubNarrowWindow(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: query === '(max-width: 899px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

describe('WorkspacePanels: which panels', () => {
  it('shows only the panels the instance enables, in the legacy order', async () => {
    setup(instanceWith(['logs', 'git', 'ledger']));
    await waitFor(() => {
      expect(headings()).toEqual([msg('panels.git.title'), msg('panels.ledger.title'), msg('panels.logs.title')]);
    });
  });

  it('draws nothing when no panel is enabled', () => {
    const { container, api } = setup(instanceWith([]));
    expect(container).toBeEmptyDOMElement();
    expect(api.callsTo('panel')).toHaveLength(0);
  });

  it('draws nothing before the instance is known', () => {
    const { container } = setup(instanceWith(['git']), {}, { instanceId: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('removes a panel that answers 404 panel_disabled and stops asking for it', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const instance = instanceWith(['git', 'ledger'], { poll: { ...DEFAULT_POLL, overviewMs: 1000 } });
    const { api } = setup(instance, {
      panel: (_query, request) =>
        request.params['key'] === 'git' ? errorResponse('panel_disabled', 'disabled') : fresh('ledger'),
    });
    await flush(0);
    expect(headings()).toEqual([msg('panels.ledger.title')]);
    const gitCalls = () => api.callsTo('panel').filter((call) => call.params['key'] === 'git').length;
    expect(gitCalls()).toBe(1);
    await flush(5000);
    expect(gitCalls()).toBe(1);
    expect(api.callsTo('panel').filter((call) => call.params['key'] === 'ledger').length).toBeGreaterThan(3);
  });
});

describe('WorkspacePanels: collapse', () => {
  it('starts expanded in a wide window and fetches the body', async () => {
    const { api } = setup(instanceWith(['git']));
    const toggle = screen.getByRole('button', { name: msg('panels.git.title') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => {
      expect(screen.getByText('fixture-branch')).toBeVisible();
    });
    expect(api.callsTo('panel')).toHaveLength(1);
  });

  it('keeps the choice in the preferences and reads it back', async () => {
    const user = userEvent.setup();
    const prefsStore = createPrefsStore(createPrefs(null));
    const first = setup(instanceWith(['git']), {}, { prefsStore });
    await waitFor(() => {
      expect(screen.getByText('fixture-branch')).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: msg('panels.git.title') }));
    expect(screen.getByRole('button', { name: msg('panels.git.title') })).toHaveAttribute('aria-expanded', 'false');
    expect(prefsStore.getSnapshot().collapsed).toEqual({ [collapsedKey('git')]: true });
    first.unmount();

    const second = setup(instanceWith(['git']), {}, { prefsStore });
    expect(screen.getByRole('button', { name: msg('panels.git.title') })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: msg('panels.git.title') }));
    expect(prefsStore.getSnapshot().collapsed).toEqual({ [collapsedKey('git')]: false });
    expect(second.api.callsTo('panel')).toHaveLength(1);
  });

  it('does not fetch the body of a collapsed panel until it is opened', async () => {
    const user = userEvent.setup();
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('collapsed', { [collapsedKey('machine')]: true });
    const { api } = setup(instanceWith(['machine', 'git']), {}, { prefsStore });
    await waitFor(() => {
      expect(screen.getByText('fixture-branch')).toBeVisible();
    });
    expect(api.callsTo('panel').map((call) => call.params['key'])).toEqual(['git']);
    await user.click(screen.getByRole('button', { name: msg('panels.machine.title') }));
    await waitFor(() => {
      expect(api.callsTo('panel').map((call) => call.params['key'])).toEqual(['git', 'machine']);
    });
  });

  it('starts collapsed below 900 px, fetches nothing, and a stored choice wins', async () => {
    stubNarrowWindow();
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('collapsed', { [collapsedKey('git')]: false });
    const { api } = setup(instanceWith(['git', 'ledger']), {}, { prefsStore });
    expect(screen.getByRole('button', { name: msg('panels.ledger.title') })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: msg('panels.git.title') })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => {
      expect(screen.getByText('fixture-branch')).toBeVisible();
    });
    expect(api.callsTo('panel').map((call) => call.params['key'])).toEqual(['git']);
  });
});

describe('WorkspacePanels: status lines', () => {
  it('shows the data of a partial answer and one note per source that is not ok', async () => {
    setup(instanceWith(['machine']), {
      panel: () =>
        fresh('machine', {
          status: 'partial',
          data: { ...makePanelData('machine'), procs: [], procsStatus: 'pending' },
          sources: [
            { source: 'memory', status: 'ok', sampledAt: iso(-1), message: null },
            { source: 'processes', status: 'pending', sampledAt: null, message: null },
            { source: 'docker', status: 'unavailable', sampledAt: iso(-3), message: 'docker is not installed' },
          ],
        }),
    });
    const panel = await screen.findByRole('region', { name: msg('panels.machine.title') });
    await waitFor(() => {
      expect(within(panel).getAllByRole('meter').length).toBeGreaterThan(0);
    });
    const notes = within(within(panel).getByRole('status')).getAllByRole('listitem');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent('processes: pending');
    expect(notes[1]).toHaveTextContent('docker: unavailable, docker is not installed');
  });

  it('says Could not load for an answer without data', async () => {
    setup(instanceWith(['ledger']), {
      panel: () =>
        fresh('ledger', {
          status: 'error',
          data: null,
          sources: [{ source: 'ledger', status: 'error', sampledAt: null, message: 'the ledger file is unreadable' }],
        }),
    });
    const panel = await screen.findByRole('region', { name: msg('panels.ledger.title') });
    await waitFor(() => {
      expect(within(panel).getByRole('status')).toHaveTextContent(
        `${msg('panels.status.errorLead')} the ledger file is unreadable.`,
      );
    });
  });

  it('says Could not load for a request that failed', async () => {
    setup(instanceWith(['ledger']), { panel: () => errorResponse('internal_error') });
    const panel = await screen.findByRole('region', { name: msg('panels.ledger.title') });
    await waitFor(() => {
      expect(within(panel).getByRole('status')).toHaveTextContent(msg('panels.status.errorLead'));
    });
  });

  it('says Stale when the answer is older than the instance allows', async () => {
    setup(instanceWith(['git'], { staleAfterMs: 15_000 }), {
      panel: () => fresh('git', { generatedAt: new Date(Date.now() - 120_000).toISOString() }),
    });
    const panel = await screen.findByRole('region', { name: msg('panels.git.title') });
    await waitFor(() => {
      expect(within(panel).getByRole('status')).toHaveTextContent(msg('panels.status.stale', { age: '2m' }));
    });
    expect(within(panel).getByText('fixture-branch')).toBeVisible();
  });

  it('keeps the last data and says how old it is when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.setSystemTime(Date.parse('2026-10-25T10:00:00.000Z'));
    let fail = false;
    const instance = instanceWith(['git'], { poll: { ...DEFAULT_POLL, overviewMs: 5000 }, staleAfterMs: 600_000 });
    setup(instance, {
      panel: () => (fail ? errorResponse('internal_error') : fresh('git')),
    });
    await flush(0);
    const panel = screen.getByRole('region', { name: msg('panels.git.title') });
    expect(within(panel).getByText('fixture-branch')).toBeVisible();
    expect(within(panel).getByRole('status')).toBeEmptyDOMElement();
    fail = true;
    await flush(5000);
    // The failing request is retried by the poll only; the first failure is already shown.
    await flush(0);
    const line = within(panel).getByRole('status');
    expect(line).toHaveTextContent(msg('panels.status.refreshLead'));
    expect(line).toHaveTextContent(/\ds ago/);
    expect(within(panel).getByText('fixture-branch')).toBeVisible();
  });
});

describe('WorkspacePanels: polling', () => {
  it('polls an expanded git panel every poll.overviewMs', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const instance = instanceWith(['git'], { poll: { ...DEFAULT_POLL, overviewMs: 7000 } });
    const { api } = setup(instance);
    await flush(0);
    expect(api.callsTo('panel')).toHaveLength(1);
    await flush(6900);
    expect(api.callsTo('panel')).toHaveLength(1);
    await flush(200);
    expect(api.callsTo('panel')).toHaveLength(2);
  });

  it('does not poll a collapsed panel', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('collapsed', { [collapsedKey('git')]: true });
    const instance = instanceWith(['git'], { poll: { ...DEFAULT_POLL, overviewMs: 1000 } });
    const { api } = setup(instance, {}, { prefsStore });
    await flush(5000);
    expect(api.callsTo('panel')).toHaveLength(0);
  });
});

describe('WorkspacePanels: language', () => {
  it('names the panels in Vietnamese', async () => {
    setup(instanceWith(['machine', 'logs']), {}, { locale: 'vi' });
    await waitFor(() => {
      expect(headings()).toEqual([
        msg('panels.machine.title', undefined, 'vi'),
        msg('panels.logs.title', undefined, 'vi'),
      ]);
    });
  });
});
