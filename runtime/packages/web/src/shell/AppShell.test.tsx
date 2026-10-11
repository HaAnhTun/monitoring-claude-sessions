import type { InstanceInfo } from '@mcs/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePageChrome } from '../app/usePageChrome.ts';
import { qk } from '../data/query-keys.ts';
import { createPrefs } from '../lib/prefs.ts';
import { AnnouncerProvider, useAnnounce } from '../state/announcer.tsx';
import { createPrefsStore, PrefsStoreContext, type PrefsStore } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider, useShortcut } from '../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext, useShowToast, useToasts } from '../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi } from '../test/fake-api.ts';
import {
  makeInstance,
  makeSession,
  makeSessionPage,
  makeState,
  sessionId,
  FIXTURE_INSTANCE_ID,
} from '../test/fixtures/index.ts';
import { renderWithProviders } from '../test/render.tsx';
import { AppShell } from './AppShell.tsx';

const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function Page({ title }: { title: string }) {
  const headingRef = usePageChrome(title);
  const { pathname, search, hash } = useLocation();
  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <output data-testid="location">{pathname + search + hash}</output>
    </section>
  );
}

function Pages() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Page title="Overview" />} />
        <Route path="/sessions" element={<Page title="Sessions" />} />
        <Route path="/sessions/:sessionId" element={<Page title="Session" />} />
        <Route path="/settings" element={<Page title="Settings" />} />
      </Route>
    </Routes>
  );
}

interface ShellOptions {
  route?: string;
  instance?: InstanceInfo;
  instanceId?: string | null;
  api?: FakeApi;
  store?: PrefsStore;
}

function renderShell(options: ShellOptions = {}) {
  const store = options.store ?? createPrefsStore(createPrefs(null));
  const instance = options.instance ?? makeInstance();
  const api =
    options.api ??
    createFakeApi({
      instance: () => instance,
      listSessions: () =>
        makeSessionPage([
          makeSession({ id: sessionId(1), seq: 1, label: 'Alpha build', state: makeState('working') }),
          makeSession({ id: sessionId(2), seq: 2, label: 'Beta done', state: makeState('completed') }),
        ]),
      sessionAgents: () => makeSessionPage([]),
    });
  const rendered = renderWithProviders(<Pages />, {
    route: options.route ?? '/',
    instance,
    api,
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    wrap: (children: ReactNode) => <PrefsStoreContext value={store}>{children}</PrefsStoreContext>,
  });
  return { ...rendered, store, api };
}

function liveRegion(): HTMLElement {
  const region = document.getElementById('live-region');
  if (region === null) throw new Error('no live region');
  return region;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.title = '';
});

describe('AppShell (04-ui.md 4.1, 4.4, 6.6)', () => {
  it('renders the landmarks of 6.6 rule 1 around the routed page', async () => {
    renderShell();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'Navigation and live sessions' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(within(main).getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('has one polite atomic live region', async () => {
    renderShell();
    await screen.findByRole('complementary');
    const region = liveRegion();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(document.querySelectorAll('#live-region')).toHaveLength(1);
  });

  it('shows only the frame and a skeleton until the instance is known, then the sidebar', async () => {
    let release: (value: InstanceInfo) => void = () => undefined;
    const pending = new Promise<InstanceInfo>((resolve) => {
      release = resolve;
    });
    const api = createFakeApi({ instance: () => pending, listSessions: () => makeSessionPage([]) });
    renderShell({ api, instanceId: null });
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading page')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();

    release(makeInstance());
    expect(await screen.findByRole('complementary', { name: 'Navigation and live sessions' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('shows a failure page when the instance cannot be loaded and recovers on retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    const instance = makeInstance();
    const api = createFakeApi({
      instance: () => (fail ? errorResponse('internal_error') : instance),
      listSessions: () => makeSessionPage([]),
    });
    renderShell({ api, instanceId: null });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load the monitor/);
    expect(screen.queryByRole('complementary')).toBeNull();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry now' }));
    expect(await screen.findByRole('complementary', { name: 'Navigation and live sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('degrades to the bare main landmark when no API client is provided', () => {
    render(
      <MemoryRouter>
        <Pages />
      </MemoryRouter>,
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  describe('skip links', () => {
    it('are the first focusable elements and move focus without touching the URL', async () => {
      const user = userEvent.setup();
      renderShell({ route: '/sessions' });
      await screen.findByRole('complementary');

      await user.tab();
      expect(document.activeElement).toHaveTextContent('Skip to main content');
      await user.tab();
      expect(document.activeElement).toHaveTextContent('Skip to session list');

      await user.click(screen.getByRole('link', { name: 'Skip to main content' }));
      expect(screen.getByRole('main')).toHaveFocus();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/sessions$/);
      expect(window.location.hash).toBe('');

      await user.click(screen.getByRole('link', { name: 'Skip to session list' }));
      expect(screen.getByTestId('session-list')).toHaveFocus();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/sessions$/);
      expect(window.location.hash).toBe('');
    });
  });

  describe('navigation', () => {
    it('lists the six views and marks the current one with aria-current', async () => {
      renderShell({ route: '/sessions' });
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      expect(
        within(nav)
          .getAllByRole('link')
          .map((a) => a.getAttribute('href')),
      ).toEqual(['/', '/sessions', '/activity', '/tasks', '/analytics', '/settings']);
      expect(within(nav).getByRole('link', { name: /^Sessions/ })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: /^Overview/ })).not.toHaveAttribute('aria-current');
    });

    it('keeps Sessions current on a session page', async () => {
      renderShell({ route: `/sessions/${sessionId(1)}` });
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      expect(within(nav).getByRole('link', { name: /^Sessions/ })).toHaveAttribute('aria-current', 'page');
    });

    it('counts the active sessions on the Sessions link', async () => {
      renderShell();
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      await waitFor(() => {
        expect(within(nav).getByRole('link', { name: /Sessions 1 active/ })).toBeInTheDocument();
      });
    });

    it('moves focus to the page heading after a navigation but not on the first load', async () => {
      const user = userEvent.setup();
      renderShell({ route: '/sessions' });
      await screen.findByRole('complementary');
      expect(document.activeElement).toBe(document.body);
      await user.click(
        within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /^Settings/ }),
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
      });
    });
  });

  describe('narrow layout menu', () => {
    it('toggles "Menu and sessions" and remembers the state', async () => {
      const user = userEvent.setup();
      const { store } = renderShell();
      const toggle = await screen.findByRole('button', { name: 'Menu and sessions' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'sidebar-body');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(store.getSnapshot().navOpen).toBe(true);
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(store.getSnapshot().navOpen).toBe(false);
    });
  });

  describe('preference controls', () => {
    it('cycles the theme auto, light, dark, auto, sets data-theme and announces it', async () => {
      const user = userEvent.setup();
      const { store } = renderShell();
      const button = await screen.findByRole('button', { name: 'Theme: auto' });
      await user.click(button);
      expect(screen.getByRole('button', { name: 'Theme: light' })).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
      await user.click(screen.getByRole('button', { name: 'Theme: light' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      await waitFor(() => {
        expect(liveRegion()).toHaveTextContent('Theme: dark');
      });
      await user.click(screen.getByRole('button', { name: 'Theme: dark' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'auto');
      expect(store.getSnapshot().theme).toBe('auto');
    });

    it('toggles the density and announces it', async () => {
      const user = userEvent.setup();
      renderShell();
      await user.click(await screen.findByRole('button', { name: 'Density: comfortable' }));
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
      expect(screen.getByRole('button', { name: 'Density: compact' })).toBeInTheDocument();
      await waitFor(() => {
        expect(liveRegion()).toHaveTextContent('Density: compact');
      });
    });

    it('uses the instance default until a preference is stored', async () => {
      renderShell({ instance: makeInstance({ ui: { ...makeInstance().ui, theme: 'dark', density: 'compact' } }) });
      expect(await screen.findByRole('button', { name: 'Theme: dark' })).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    });

    it('prefers the stored value over the instance default', async () => {
      const store = createPrefsStore(createPrefs(null));
      store.setPref('theme', 'light');
      renderShell({ store, instance: makeInstance({ ui: { ...makeInstance().ui, theme: 'dark' } }) });
      expect(await screen.findByRole('button', { name: 'Theme: light' })).toBeInTheDocument();
    });
  });

  describe('shortcuts dialog', () => {
    it('opens with ?, lists the active shortcuts and closes with its button', async () => {
      const user = userEvent.setup();
      renderShell();
      await screen.findByRole('complementary');
      await user.keyboard('?');
      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
      expect(within(dialog).getByText('Show this list of shortcuts')).toBeInTheDocument();
      expect(within(dialog).getByText('Up / Down / Home / End')).toBeInTheDocument();
      expect(within(dialog).getByText('Esc')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('opens from the button of the preference controls', async () => {
      const user = userEvent.setup();
      renderShell();
      await user.click(await screen.findByRole('button', { name: 'Shortcuts' }));
      expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    });

    it('does not open while typing in the sidebar filter', async () => {
      const user = userEvent.setup();
      renderShell();
      await user.type(await screen.findByRole('searchbox', { name: 'Filter sessions' }), '?');
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('instance changed notice (UI-I11)', () => {
    it('stays quiet for the same instance and remembers its id', async () => {
      const store = createPrefsStore(createPrefs(null));
      store.setPref('lastInstanceId', FIXTURE_INSTANCE_ID);
      renderShell({ store });
      await screen.findByRole('complementary');
      expect(screen.queryByText(/different monitor instance/)).toBeNull();
      expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
    });

    it('stays quiet on the very first visit and stores the id', async () => {
      const { store } = renderShell();
      await screen.findByRole('complementary');
      expect(screen.queryByText(/different monitor instance/)).toBeNull();
      await waitFor(() => {
        expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
      });
    });

    it('tells the user when the stored instance id differs, and can be dismissed', async () => {
      const user = userEvent.setup();
      const store = createPrefsStore(createPrefs(null));
      store.setPref('lastInstanceId', OTHER_INSTANCE_ID);
      renderShell({ store });
      const notice = await screen.findByText(/different monitor instance/);
      expect(notice).toBeInTheDocument();
      expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/different monitor instance/)).toBeNull();
    });

    it('clears the cached data of the old instance when the id changes while the page is open', async () => {
      const { queryClient } = renderShell();
      await screen.findByRole('complementary');
      await waitFor(() => {
        expect(queryClient.getQueryCache().findAll({ queryKey: qk.root(FIXTURE_INSTANCE_ID) }).length).toBeGreaterThan(
          0,
        );
      });

      act(() => {
        queryClient.setQueryData(qk.instance(), makeInstance({ instanceId: OTHER_INSTANCE_ID }));
      });

      expect(await screen.findByText(/different monitor instance/)).toBeInTheDocument();
      expect(queryClient.getQueryCache().findAll({ queryKey: qk.root(FIXTURE_INSTANCE_ID) })).toHaveLength(0);
    });
  });
});

describe('announcer (04-ui.md 6.6 rule 6)', () => {
  function Announcing({ message }: { message: string }) {
    const announce = useAnnounce();
    return (
      <button
        type="button"
        onClick={() => {
          announce(message);
        }}
      >
        say
      </button>
    );
  }

  it('sets the message in the shared region after a short delay', async () => {
    const user = userEvent.setup();
    render(
      <AnnouncerProvider>
        <Announcing message="Following new events" />
      </AnnouncerProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'say' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('Following new events');
    });
  });

  it('is a harmless no-op outside a provider', async () => {
    const user = userEvent.setup();
    render(<Announcing message="nobody listens" />);
    await user.click(screen.getByRole('button', { name: 'say' }));
    expect(document.getElementById('live-region')).toBeNull();
  });
});

describe('shortcut registry (04-ui.md 6.5)', () => {
  function Key({ id, enabled = true, onKey }: { id: string; enabled?: boolean; onKey: (id: string) => void }) {
    useShortcut(
      'x',
      () => {
        onKey(id);
      },
      { enabled, description: `Handler ${id}` },
    );
    return null;
  }

  function Harness({ children }: { children: ReactNode }) {
    return (
      <ShortcutRegistryProvider>
        <input aria-label="text box" />
        <input type="checkbox" aria-label="check box" />
        {children}
      </ShortcutRegistryProvider>
    );
  }

  it('runs the handler of a pressed key', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledWith('a');
  });

  it('gives the key to the most recently mounted enabled handler', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    function Toggle() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <Key id="first" onKey={onKey} />
          {second ? <Key id="second" onKey={onKey} /> : null}
          <button
            type="button"
            onClick={() => {
              setSecond((v) => !v);
            }}
          >
            toggle
          </button>
        </>
      );
    }
    render(
      <Harness>
        <Toggle />
      </Harness>,
    );
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenLastCalledWith('second');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenLastCalledWith('first');
  });

  it('skips a disabled handler', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
        <Key id="b" enabled={false} onKey={onKey} />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith('a');
  });

  it('ignores keys typed in text fields, with modifiers, or already handled', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
      </Harness>,
    );
    await user.type(screen.getByRole('textbox', { name: 'text box' }), 'x');
    expect(onKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: 'check box' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledTimes(1);
    await user.keyboard('{Control>}x{/Control}');
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a dialog is open', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
        <dialog open aria-label="open dialog" />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('toast store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast, announces it and removes it after its time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createToastStore();
    function Toasts() {
      const { toasts } = useToasts();
      const show = useShowToast();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              show('Link copied');
            }}
          >
            show
          </button>
          <ul>
            {toasts.map((t) => (
              <li key={t.id}>{t.message}</li>
            ))}
          </ul>
        </>
      );
    }
    render(
      <AnnouncerProvider>
        <ToastStoreContext value={store}>
          <Toasts />
        </ToastStoreContext>
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'show' }).click();
    });
    expect(screen.getByRole('listitem')).toHaveTextContent('Link copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(liveRegion()).toHaveTextContent('Link copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('dismisses by id and keeps the others', () => {
    const store = createToastStore();
    const first = store.show('one');
    store.show('two');
    store.dismiss(first);
    expect(store.getSnapshot().map((t) => t.message)).toEqual(['two']);
  });
});
