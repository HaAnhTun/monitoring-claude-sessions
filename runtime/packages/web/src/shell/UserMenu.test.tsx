import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { createPrefs } from '../lib/prefs.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { createPrefsStore, type PrefsStore } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider, useShortcutRegistry } from '../state/shortcuts-registry.tsx';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { UserMenu } from './UserMenu.tsx';

// ADR 0073 decision 6: theme, density and language are radio groups, the shortcuts are an item; every change is applied at once,
// announced politely, and the menu stays usable (also after the language switched).

function HelpState() {
  const { helpOpen } = useShortcutRegistry();
  return <output data-testid="help">{helpOpen ? 'open' : 'closed'}</output>;
}

function setup(options: { locale?: 'en' | 'vi'; store?: PrefsStore } = {}) {
  const store = options.store ?? createPrefsStore(createPrefs(null));
  const rendered = renderWithProviders(<UserMenu />, {
    prefsStore: store,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    wrap: (children: ReactNode) => (
      <AnnouncerProvider>
        <ShortcutRegistryProvider>
          {children}
          <HelpState />
        </ShortcutRegistryProvider>
      </AnnouncerProvider>
    ),
  });
  return { ...rendered, store, user: userEvent.setup() };
}

function liveRegion(): HTMLElement {
  const region = document.getElementById('live-region');
  if (region === null) throw new Error('no live region');
  return region;
}

async function open(user: ReturnType<typeof userEvent.setup>, locale: 'en' | 'vi' = 'en') {
  await user.click(screen.getByRole('button', { name: msg('menu.trigger', undefined, locale) }));
  return screen.getByRole('menu');
}

describe('UserMenu: the groups', () => {
  it('offers Theme, Density and Language as labelled radio groups and a shortcuts item', async () => {
    const { user } = setup();
    const menu = await open(user);
    const groups = within(menu).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby') !== null)).toEqual([true, true, true]);
    for (const [name, items] of [
      [msg('menu.theme'), [msg('menu.theme.auto'), msg('menu.theme.light'), msg('menu.theme.dark')]],
      [msg('menu.density'), [msg('menu.density.comfortable'), msg('menu.density.compact')]],
    ] as const) {
      const group = within(within(menu).getByRole('group', { name }));
      expect(group.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(items);
    }
    expect(within(menu).getByRole('menuitem', { name: msg('menu.shortcuts') })).toBeInTheDocument();
  });

  it('names the languages in their own language: the Vietnamese name stays Vietnamese in the English menu', async () => {
    const { user } = setup();
    const menu = await open(user);
    const group = within(within(menu).getByRole('group', { name: msg('menu.language') }));
    expect(group.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      msg('lang.auto'),
      msg('lang.en'),
      msg('lang.vi', undefined, 'vi'),
    ]);
    expect(group.getByText(msg('lang.vi', undefined, 'vi'))).toHaveAttribute('lang', 'vi');
  });

  it('marks the stored choices: automatic theme, comfortable density, automatic language', async () => {
    const { user } = setup();
    const menu = await open(user);
    const checked = within(menu)
      .getAllByRole('menuitemradio')
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.textContent);
    expect(checked).toEqual([msg('menu.theme.auto'), msg('menu.density.comfortable'), msg('lang.auto')]);
  });
});

describe('UserMenu: theme and density', () => {
  it('stores the theme, moves the check and announces it', async () => {
    const { user, store } = setup();
    const menu = await open(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: msg('menu.theme.dark') }));
    expect(store.getSnapshot().theme).toBe('dark');
    expect(within(menu).getByRole('menuitemradio', { name: msg('menu.theme.dark') })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(msg('menu.announce.theme', { value: msg('menu.theme.dark') }));
    });
  });

  it('stores the density and announces it', async () => {
    const { user, store } = setup();
    const menu = await open(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: msg('menu.density.compact') }));
    expect(store.getSnapshot().density).toBe('compact');
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(msg('menu.announce.density', { value: msg('menu.density.compact') }));
    });
  });

  it('shows the stored preference as chosen', async () => {
    const store = createPrefsStore(createPrefs(null));
    store.setPref('theme', 'light');
    store.setPref('density', 'compact');
    const { user } = setup({ store });
    const menu = await open(user);
    expect(within(menu).getByRole('menuitemradio', { name: msg('menu.theme.light') })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitemradio', { name: msg('menu.density.compact') })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('the icons of the theme group are the 18 px menu size', async () => {
    const { user } = setup();
    const menu = await open(user);
    const group = within(menu).getByRole('group', { name: msg('menu.theme') });
    for (const svg of group.querySelectorAll('svg.icon:not(.menu__check)')) expect(svg).toHaveAttribute('width', '18');
  });
});

describe('UserMenu: language', () => {
  it('switches to Vietnamese: the document language follows, the menu stays open and speaks Vietnamese', async () => {
    const { user, store } = setup();
    const menu = await open(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: msg('lang.vi', undefined, 'vi') }));
    expect(store.getSnapshot().locale).toBe('vi');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('vi');
    });
    const still = screen.getByRole('menu');
    expect(still).toBeInTheDocument();
    expect(within(still).getByRole('group', { name: msg('menu.theme', undefined, 'vi') })).toBeInTheDocument();
    expect(within(still).getByRole('menuitemradio', { name: msg('lang.vi', undefined, 'vi') })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The menu is still usable: another choice works in the new language.
    await user.click(within(still).getByRole('menuitemradio', { name: msg('menu.theme.dark', undefined, 'vi') }));
    expect(store.getSnapshot().theme).toBe('dark');
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(
        msg('menu.announce.theme', { value: msg('menu.theme.dark', undefined, 'vi') }, 'vi'),
      );
    });
  });

  it('switches back to English and to the browser language', async () => {
    const store = createPrefsStore(createPrefs(null));
    store.setPref('locale', 'vi');
    const { user } = setup({ store, locale: 'vi' });
    const menu = await open(user, 'vi');
    await user.click(within(menu).getByRole('menuitemradio', { name: msg('lang.en', undefined, 'vi') }));
    expect(store.getSnapshot().locale).toBe('en');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en');
    });
    await user.click(
      within(screen.getByRole('group', { name: msg('menu.language') })).getByRole('menuitemradio', {
        name: msg('lang.auto'),
      }),
    );
    expect(store.getSnapshot().locale).toBe('auto');
  });

  it('announces the language that was chosen', async () => {
    const { user } = setup();
    const menu = await open(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: msg('lang.vi', undefined, 'vi') }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(msg('menu.announce.language', { value: msg('lang.vi', undefined, 'vi') }));
    });
  });
});

describe('UserMenu: keyboard and focus', () => {
  it('is reachable and usable with the keyboard alone, and Escape returns the focus to the button', async () => {
    const { user, store } = setup();
    screen.getByRole('button', { name: msg('menu.trigger') }).focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu');
    const themes = within(menu).getByRole('group', { name: msg('menu.theme') });
    expect(within(themes).getByRole('menuitemradio', { name: msg('menu.theme.auto') })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(store.getSnapshot().theme).toBe('dark');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: msg('menu.trigger') })).toHaveFocus();
  });

  it('the shortcuts item opens the dialog state, closes the menu and leaves the focus on the button', async () => {
    const { user } = setup();
    const menu = await open(user);
    await user.click(within(menu).getByRole('menuitem', { name: msg('menu.shortcuts') }));
    expect(screen.getByTestId('help')).toHaveTextContent('open');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: msg('menu.trigger') })).toHaveFocus();
  });
});

describe('UserMenu in Vietnamese', () => {
  it('words the button, the groups and the items in Vietnamese', async () => {
    const { user } = setup({ locale: 'vi' });
    const menu = await open(user, 'vi');
    for (const key of ['menu.theme', 'menu.density', 'menu.language'] as const) {
      expect(within(menu).getByRole('group', { name: msg(key, undefined, 'vi') })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('menuitem', { name: msg('menu.shortcuts', undefined, 'vi') })).toBeInTheDocument();
  });
});
