// TC-ATT-13, 14, 17, 18 (ADR 0107): the host turns a session that starts to need the person into a count in the tab title, a
// dot on the tab icon, one polite announcement and, when the person asked for it and is away, one OS notification with fixed text.
import type { SessionSummary } from '@mcs/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usePageChrome } from '../app/usePageChrome.ts';
import { createPrefs } from '../lib/prefs.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import {
  AttentionChromeStoreContext,
  createAttentionChromeStore,
  FAVICON_ATTENTION,
  FAVICON_PLAIN,
} from '../state/attention-chrome.ts';
import { useAttentionValue } from '../state/attention-context.ts';
import { ATTENTION_TAG, type OsNotification } from '../state/attention-notifier.ts';
import { createPrefsStore } from '../state/prefs-store.ts';
import { browserAttentionSeams, type AttentionSeams } from '../state/useAttention.ts';
import { createFakeApi } from '../test/fake-api.ts';
import { makeInstance, makeSession, makeSessionPage, makeState, sessionId } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { AttentionHost } from './AttentionHost.tsx';

const CANARY_LABEL = 'CANARY label of a fixture session';
const CANARY_PROJECT = 'CANARY-project-folder';

function Page() {
  const headingRef = usePageChrome('Overview');
  const { pathname } = useLocation();
  const attention = useAttentionValue();
  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1}>
        Overview
      </h1>
      <output data-testid="location">{pathname}</output>
      <output data-testid="scope">{attention.scope}</output>
      <output data-testid="needs">{attention.summary.needsYou}</output>
    </section>
  );
}

const working = (): SessionSummary =>
  makeSession({ id: sessionId(1), label: CANARY_LABEL, projectLabel: CANARY_PROJECT, state: makeState('working') });
const waiting = (): SessionSummary =>
  makeSession({
    id: sessionId(1),
    label: CANARY_LABEL,
    projectLabel: CANARY_PROJECT,
    state: makeState('waiting_input', { rule: 'S-6a', waitReason: 'permission' }),
  });

interface HostOptions {
  notify?: boolean;
  away?: boolean;
}

function renderHost(options: HostOptions = {}) {
  let sessions = [working()];
  const notified: OsNotification[] = [];
  const seams: AttentionSeams = {
    ...browserAttentionSeams,
    page: () => (options.away === true ? { visible: false, focused: false } : { visible: true, focused: true }),
    notify: (notification) => notified.push(notification),
  };
  const store = createPrefsStore(createPrefs(null));
  // no delay: a state is told as soon as it is seen, so the test needs no clock
  store.setPref('attentionDelaySeconds', 0);
  if (options.notify === true) store.setPref('attentionNotify', true);
  const api = createFakeApi({ listSessions: () => makeSessionPage(sessions) });
  const rendered = renderWithProviders(
    <AnnouncerProvider>
      <AttentionChromeStoreContext value={createAttentionChromeStore()}>
        <AttentionHost kind="task" seams={seams}>
          <Page />
        </AttentionHost>
      </AttentionChromeStoreContext>
    </AnnouncerProvider>,
    { route: '/overview', instance: makeInstance({ kind: 'task' }), api, prefsStore: store },
  );
  /** The first list was read (the silent baseline); then the session starts to wait for a permission. */
  async function startWaiting(): Promise<void> {
    await waitFor(() => {
      expect(api.callsTo('listSessions').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(document.title).toBe(`Overview - ${msg('shell.appTitle')}`);
    });
    sessions = [waiting()];
    await act(() => rendered.queryClient.invalidateQueries());
  }
  return { ...rendered, notified, startWaiting };
}

function iconHref(): string | null {
  return document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null;
}

beforeEach(() => {
  const link = document.createElement('link');
  link.setAttribute('rel', 'icon');
  link.setAttribute('href', FAVICON_PLAIN);
  document.head.append(link);
});

afterEach(() => {
  document.querySelector('link[rel~="icon"]')?.remove();
  document.title = '';
});

describe('AttentionHost', () => {
  it('puts the count in front of the tab title, the dot on the tab icon and one sentence in the live region', async () => {
    const host = renderHost();
    expect(screen.getByTestId('scope')).toHaveTextContent('all');
    await host.startWaiting();

    const prefix = msg('attention.title.needs_you', { count: 1 });
    await waitFor(() => {
      expect(document.title).toBe(`${prefix} Overview - ${msg('shell.appTitle')}`);
    });
    expect(prefix).toBe('(1 needs you)');
    expect(iconHref()).toBe(FAVICON_ATTENTION);
    expect(screen.getByTestId('needs')).toHaveTextContent('1');
    // the session is no terminal and its title comes from a first prompt: the announcement names it by its short id
    const spoken = msg('attention.announce.needs_you', { name: sessionId(1).slice(0, 8) });
    await waitFor(() => {
      expect(document.getElementById('live-region')).toHaveTextContent(spoken);
    });
    // the person is here: no OS notification, whatever the preference
    expect(host.notified).toHaveLength(0);

    host.unmount();
    expect(iconHref()).toBe(FAVICON_PLAIN);
  });

  it('sends one OS notification with fixed text to a person who is away, and a click opens the session', async () => {
    const host = renderHost({ notify: true, away: true });
    await host.startWaiting();

    await waitFor(() => {
      expect(host.notified).toHaveLength(1);
    });
    const [notification] = host.notified;
    expect(notification?.title).toBe(msg('shell.appTitle'));
    expect(notification?.body).toBe(msg('attention.os.needs_you', { count: 1 }));
    expect(notification?.tag).toBe(ATTENTION_TAG);
    const sent = JSON.stringify(notification);
    expect(sent).not.toContain('CANARY');
    expect(sent).not.toContain(sessionId(1).slice(0, 8));

    act(() => {
      notification?.onClick();
    });
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/sessions/${sessionId(1)}`);
    });
  });
});
