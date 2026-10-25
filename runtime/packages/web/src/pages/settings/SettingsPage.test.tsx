import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes, lazyPage } from '../../app/routes.tsx';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { createFakeApi, type FakeApi } from '../../test/fake-api.ts';
import { makeConfigInspection, makeHealth, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SETTINGS_SECTIONS } from '../../lib/url-state.ts';
import { SettingsPage } from './SettingsPage.tsx';

const INSTANCE = makeInstance();

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function makeApi(): FakeApi {
  return createFakeApi({
    instance: () => INSTANCE,
    health: () => makeHealth('ok'),
    config: () => makeConfigInspection(),
  });
}

function renderPage(route: string, api: FakeApi = makeApi()) {
  const wrap = (children: ReactNode): ReactNode => (
    <AnnouncerProvider>
      <LocationProbe />
      {children}
    </AnnouncerProvider>
  );
  return { ...renderWithProviders(<SettingsPage />, { route, api, instance: INSTANCE, wrap }), api };
}

function location(): string {
  return screen.getByTestId('location').textContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsPage: the sections', () => {
  it('opens on Health, with the page heading, the section list and the lead', async () => {
    renderPage('/settings');
    expect(screen.getByRole('heading', { level: 1, name: msg('route.settings.title') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: msg('settings.section.health') })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: msg('settings.nav.label') });
    expect(within(nav).getAllByRole('link')).toHaveLength(SETTINGS_SECTIONS.length);
    expect(within(nav).getByRole('link', { name: msg('settings.section.health') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText(msg('settings.lead'))).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: msg('settings.health.database') })).toBeInTheDocument();
    expect(document.title).toContain(msg('route.settings.title'));
  });

  it.each([
    ['config', 'settings.section.config', 'settings.config.values'],
    ['preferences', 'settings.section.preferences', 'settings.prefs.appearance'],
    ['data', 'settings.section.data', 'settings.data.commands'],
    ['about', 'settings.section.about', 'settings.about.running'],
  ] as const)('shows the %s section from the address', async (section, title, card) => {
    renderPage(`/settings?section=${section}`);
    expect(screen.getByRole('heading', { level: 2, name: msg(title) })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: msg(card) })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: msg('settings.nav.label') })).getByRole('link', {
        name: msg(title),
      }),
    ).toHaveAttribute('aria-current', 'page');
    expect(location()).toBe(`/settings?section=${section}`);
  });

  it('canonicalises an unknown section: the address loses it and Health is shown', async () => {
    renderPage('/settings?section=nonsense&other=1');
    await waitFor(() => {
      expect(location()).toBe('/settings');
    });
    expect(screen.getByRole('heading', { level: 2, name: msg('settings.section.health') })).toBeInTheDocument();
  });

  it('writes the default section as the bare page and the others as ?section=', () => {
    renderPage('/settings?section=about');
    const nav = screen.getByRole('navigation', { name: msg('settings.nav.label') });
    expect(within(nav).getByRole('link', { name: msg('settings.section.health') })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(nav).getByRole('link', { name: msg('settings.section.config') })).toHaveAttribute(
      'href',
      '/settings?section=config',
    );
  });

  it('switches section with the links and keeps the browser history usable', async () => {
    const user = userEvent.setup();
    renderPage('/settings');
    const nav = screen.getByRole('navigation', { name: msg('settings.nav.label') });
    await user.click(within(nav).getByRole('link', { name: msg('settings.section.preferences') }));
    expect(location()).toBe('/settings?section=preferences');
    expect(await screen.findByRole('group', { name: msg('menu.theme') })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: msg('settings.section.health') }));
    expect(location()).toBe('/settings');
    expect(screen.getByRole('heading', { level: 2, name: msg('settings.section.health') })).toBeInTheDocument();
  });

  it('is in Vietnamese when the language is', () => {
    const wrap = (children: ReactNode): ReactNode => <AnnouncerProvider>{children}</AnnouncerProvider>;
    renderWithProviders(<SettingsPage />, {
      route: '/settings?section=about',
      api: makeApi(),
      instance: INSTANCE,
      locale: 'vi',
      wrap,
    });
    expect(
      screen.getByRole('heading', { level: 2, name: msg('settings.section.about', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: msg('settings.nav.label', undefined, 'vi') })).toBeInTheDocument();
  });
});

describe('SettingsPage: read only', () => {
  it('sends only GET requests, whatever is opened, copied, changed or reset', async () => {
    vi.stubGlobal('isSecureContext', true);
    const api = makeApi();
    const methods: string[] = [];
    const inner = api.fetchImpl;
    api.fetchImpl = (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      methods.push(method.toUpperCase());
      return inner(input, init);
    };
    const user = userEvent.setup();
    renderPage('/settings', api);
    const nav = screen.getByRole('navigation', { name: msg('settings.nav.label') });
    await screen.findByRole('region', { name: msg('settings.health.database') });

    await user.click(within(nav).getByRole('link', { name: msg('settings.section.config') }));
    await user.click(await screen.findByRole('button', { name: msg('settings.config.copyInspect') }));

    await user.click(within(nav).getByRole('link', { name: msg('settings.section.preferences') }));
    await user.click(await screen.findByRole('radio', { name: msg('menu.theme.dark') }));
    await user.click(screen.getByRole('button', { name: msg('settings.prefs.reset') }));

    await user.click(within(nav).getByRole('link', { name: msg('settings.section.data') }));
    for (const label of [
      'settings.data.copyExport',
      'settings.data.copyBackup',
      'settings.data.copyCleanup',
    ] as const) {
      await user.click(await screen.findByRole('button', { name: msg(label) }));
    }

    await user.click(within(nav).getByRole('link', { name: msg('settings.section.about') }));
    await screen.findByRole('region', { name: msg('settings.about.running') });

    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.filter((method) => method !== 'GET')).toEqual([]);
    expect(api.calls.every((call) => ['instance', 'health', 'config'].includes(call.id))).toBe(true);
    expect(api.violations).toEqual([]);
  });

  it('has no form to submit and no control that is not a link, a copy button, a radio, a checkbox or the reset button', async () => {
    const user = userEvent.setup();
    renderPage('/settings?section=preferences');
    await screen.findByRole('group', { name: msg('menu.theme') });
    expect(document.querySelector('form')).toBeNull();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual([msg('settings.prefs.reset')]);
    await user.click(within(screen.getByRole('navigation')).getByRole('link', { name: msg('settings.section.data') }));
    await screen.findByRole('region', { name: msg('settings.data.commands') });
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('the /health address', () => {
  it('still lands on the Health section of the settings', async () => {
    const wrap = (children: ReactNode): ReactNode => <AnnouncerProvider>{children}</AnnouncerProvider>;
    const registry = { settings: lazyPage(() => Promise.resolve({ default: SettingsPage })) };
    renderWithProviders(
      <>
        <LocationProbe />
        <AppRoutes registry={registry} />
      </>,
      { route: '/health', api: makeApi(), instance: INSTANCE, wrap },
    );
    expect(await screen.findByRole('heading', { level: 2, name: msg('settings.section.health') })).toBeInTheDocument();
    await waitFor(() => {
      expect(location()).toBe('/settings');
    });
  });
});
