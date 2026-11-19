import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createPrefs, LEGACY_PREFS_KEY, PREFS_KEY, type StorageLike } from '../../lib/prefs.ts';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { createPrefsStore } from '../../state/prefs-store.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { PreferencesForm } from './PreferencesForm.tsx';

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.items.set(key, value);
  }
}

afterEach(() => {
  document.documentElement.lang = '';
});

function setup(storage: StorageLike | null = new MemoryStorage(), locale: 'en' | 'vi' = 'en') {
  const prefsStore = createPrefsStore(createPrefs(storage));
  const rendered = renderWithProviders(<PreferencesForm />, {
    prefsStore,
    locale,
    wrap: (children: ReactNode) => <AnnouncerProvider>{children}</AnnouncerProvider>,
  });
  return { ...rendered, prefsStore, user: userEvent.setup() };
}

function group(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

describe('PreferencesForm', () => {
  it('offers theme, density and language as radio groups and the transcript options', () => {
    setup();
    expect(within(group(msg('menu.theme'))).getAllByRole('radio')).toHaveLength(3);
    expect(within(group(msg('menu.density'))).getAllByRole('radio')).toHaveLength(2);
    expect(within(group(msg('menu.language'))).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: new RegExp(msg('transcript.toolbar.newestFirst')) })).toBeChecked();
    const kinds = within(group(msg('settings.prefs.kinds'))).getAllByRole('checkbox');
    expect(kinds.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false, true, true]);
  });

  it('changes the theme and the density at once and keeps them in the preferences', async () => {
    const { user, prefsStore } = setup();
    await user.click(within(group(msg('menu.theme'))).getByRole('radio', { name: msg('menu.theme.dark') }));
    await user.click(within(group(msg('menu.density'))).getByRole('radio', { name: msg('menu.density.compact') }));
    expect(prefsStore.getSnapshot().theme).toBe('dark');
    expect(prefsStore.getSnapshot().density).toBe('compact');
    expect(within(group(msg('menu.theme'))).getByRole('radio', { name: msg('menu.theme.dark') })).toBeChecked();
    expect(within(group(msg('menu.density'))).getByRole('radio', { name: msg('menu.density.compact') })).toBeChecked();
  });

  it('changes the language: the document language and the stored preference follow', async () => {
    const { user, prefsStore } = setup();
    await user.click(within(group(msg('menu.language'))).getByRole('radio', { name: /Vi/i }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('vi');
    });
    expect(prefsStore.getSnapshot().locale).toBe('vi');
    // The page itself is now in Vietnamese.
    expect(await screen.findByRole('group', { name: msg('menu.language', undefined, 'vi') })).toBeInTheDocument();
    await user.click(
      within(group(msg('menu.language', undefined, 'vi'))).getByRole('radio', {
        name: msg('lang.auto', undefined, 'vi'),
      }),
    );
    expect(prefsStore.getSnapshot().locale).toBe('auto');
  });

  it('stores the order and the kinds of a transcript', async () => {
    const { user, prefsStore } = setup();
    await user.click(screen.getByRole('checkbox', { name: new RegExp(msg('transcript.toolbar.newestFirst')) }));
    await user.click(screen.getByRole('checkbox', { name: msg('transcript.toolbar.kind.think') }));
    await user.click(screen.getByRole('checkbox', { name: msg('transcript.toolbar.kind.tool') }));
    expect(prefsStore.getSnapshot().newestFirst).toBe(false);
    expect(prefsStore.getSnapshot().kinds).toEqual({
      prompt: true,
      say: true,
      think: true,
      tool: false,
      result: true,
    });
  });

  it('resets the display preferences: only the v3 key changes, the remembered instance stays, the rest of storage is untouched', async () => {
    const storage = new MemoryStorage();
    storage.items.set('other.key', 'untouched');
    storage.items.set(LEGACY_PREFS_KEY, JSON.stringify({ theme: 'light' }));
    storage.items.set(
      PREFS_KEY,
      JSON.stringify({ theme: 'dark', density: 'compact', locale: 'vi', lastInstanceId: 'iid-1', newestFirst: false }),
    );
    const { user, prefsStore } = setup(storage, 'vi');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('vi');
    });
    await user.click(screen.getByRole('button', { name: msg('settings.prefs.reset', undefined, 'vi') }));

    expect(prefsStore.getSnapshot()).toEqual({ lastInstanceId: 'iid-1' });
    expect(JSON.parse(storage.items.get(PREFS_KEY) ?? 'null')).toEqual({ lastInstanceId: 'iid-1' });
    expect(storage.items.get('other.key')).toBe('untouched');
    expect(storage.items.get(LEGACY_PREFS_KEY)).toBe(JSON.stringify({ theme: 'light' }));
    expect(new Set(storage.writes)).toEqual(new Set([PREFS_KEY]));
    // The form shows the defaults again, in the language the browser gives (English in the test); the announcement was made in the language of the click.
    await waitFor(() => {
      expect(within(group(msg('menu.theme'))).getByRole('radio', { name: msg('menu.theme.auto') })).toBeChecked();
    });
    expect(screen.getByRole('checkbox', { name: new RegExp(msg('transcript.toolbar.newestFirst')) })).toBeChecked();
    await waitFor(() => {
      expect(document.getElementById('live-region')).toHaveTextContent(
        msg('settings.prefs.resetDone', undefined, 'vi'),
      );
    });
  });

  it('TC-UI-11 offers the terminal screen reader mode, off by default, with its hint', () => {
    setup();
    const box = screen.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.screenReader')) });
    expect(box).not.toBeChecked();
    expect(screen.getByText(msg('settings.prefs.screenReaderHint'))).toBeInTheDocument();
  });

  it('TC-UI-11 keeps the screen reader mode in the preferences and shows the stored value', async () => {
    const { user, prefsStore } = setup();
    const box = screen.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.screenReader')) });
    await user.click(box);
    expect(prefsStore.getSnapshot().terminalScreenReader).toBe(true);
    expect(box).toBeChecked();
    await user.click(box);
    expect(prefsStore.getSnapshot().terminalScreenReader).toBe(false);
    expect(box).not.toBeChecked();
  });

  it('shows the screen reader mode as set when the browser stored it, in both languages', () => {
    const storage = new MemoryStorage();
    storage.items.set(PREFS_KEY, JSON.stringify({ terminalScreenReader: true }));
    const { unmount } = setup(storage);
    expect(screen.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.screenReader')) })).toBeChecked();
    unmount();
    setup(storage, 'vi');
    expect(
      screen.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.screenReader', undefined, 'vi')) }),
    ).toBeChecked();
  });

  it('forgets the screen reader mode with the other display preferences', async () => {
    const storage = new MemoryStorage();
    storage.items.set(PREFS_KEY, JSON.stringify({ terminalScreenReader: true }));
    const { user, prefsStore } = setup(storage);
    await user.click(screen.getByRole('button', { name: msg('settings.prefs.reset') }));
    expect(prefsStore.getSnapshot().terminalScreenReader).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.screenReader')) })).not.toBeChecked();
    });
  });

  describe('the Terminal card (CAW-144)', () => {
    const terminalCard = (language?: 'vi'): HTMLElement => {
      const title = msg('settings.prefs.terminal', undefined, language);
      return screen.getByRole('heading', { name: title }).closest('section') ?? document.body;
    };

    it('offers the renderer, the cursor, the right click and copy on select, with the defaults checked', () => {
      setup();
      const card = within(terminalCard());
      const renderer = within(card.getByRole('group', { name: msg('settings.prefs.renderer') }));
      expect(renderer.getByRole('radio', { name: msg('settings.prefs.renderer.auto') })).toBeChecked();
      expect(renderer.getByRole('radio', { name: msg('settings.prefs.renderer.dom') })).not.toBeChecked();
      const cursor = within(card.getByRole('group', { name: msg('settings.prefs.cursor') }));
      expect(cursor.getByRole('radio', { name: msg('settings.prefs.cursor.block') })).toBeChecked();
      const rightClick = within(card.getByRole('group', { name: msg('settings.prefs.rightClick') }));
      expect(rightClick.getByRole('radio', { name: msg('settings.prefs.rightClick.smart') })).toBeChecked();
      expect(card.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.copyOnSelect')) })).not.toBeChecked();
      expect(card.getByText(msg('settings.prefs.renderer.hint'))).toBeInTheDocument();
      expect(card.getByText(msg('settings.prefs.rightClick.hint'))).toBeInTheDocument();
      expect(card.getByText(msg('settings.prefs.copyOnSelect.hint'))).toBeInTheDocument();
    });

    it('leaves the screen reader mode where it was, in the appearance card', () => {
      setup();
      const appearance = screen.getByRole('heading', { name: msg('settings.prefs.appearance') }).closest('section');
      expect(
        within(appearance ?? document.body).getByRole('checkbox', {
          name: new RegExp(msg('settings.prefs.screenReader')),
        }),
      ).toBeInTheDocument();
    });

    it('writes each choice to its preference', async () => {
      const { user, prefsStore } = setup();
      const card = within(terminalCard());
      await user.click(card.getByRole('radio', { name: msg('settings.prefs.renderer.dom') }));
      expect(prefsStore.getSnapshot().terminalRenderer).toBe('dom');
      await user.click(card.getByRole('radio', { name: msg('settings.prefs.cursor.bar') }));
      expect(prefsStore.getSnapshot().terminalCursor).toBe('bar');
      await user.click(card.getByRole('radio', { name: msg('settings.prefs.cursor.underline') }));
      expect(prefsStore.getSnapshot().terminalCursor).toBe('underline');
      await user.click(card.getByRole('radio', { name: msg('settings.prefs.rightClick.menu') }));
      expect(prefsStore.getSnapshot().terminalRightClick).toBe('menu');
      const copyOnSelect = card.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.copyOnSelect')) });
      await user.click(copyOnSelect);
      expect(prefsStore.getSnapshot().terminalCopyOnSelect).toBe(true);
      expect(copyOnSelect).toBeChecked();
      await user.click(card.getByRole('radio', { name: msg('settings.prefs.renderer.auto') }));
      expect(prefsStore.getSnapshot().terminalRenderer).toBe('auto');
    });

    it('shows the stored choices, in both languages', () => {
      const storage = new MemoryStorage();
      storage.items.set(
        PREFS_KEY,
        JSON.stringify({
          terminalRenderer: 'dom',
          terminalCursor: 'bar',
          terminalRightClick: 'menu',
          terminalCopyOnSelect: true,
        }),
      );
      const { unmount } = setup(storage);
      const en = within(terminalCard());
      expect(en.getByRole('radio', { name: msg('settings.prefs.renderer.dom') })).toBeChecked();
      expect(en.getByRole('radio', { name: msg('settings.prefs.cursor.bar') })).toBeChecked();
      expect(en.getByRole('radio', { name: msg('settings.prefs.rightClick.menu') })).toBeChecked();
      expect(en.getByRole('checkbox', { name: new RegExp(msg('settings.prefs.copyOnSelect')) })).toBeChecked();
      unmount();
      setup(storage, 'vi');
      const vi = within(terminalCard('vi'));
      expect(vi.getByRole('radio', { name: msg('settings.prefs.renderer.dom', undefined, 'vi') })).toBeChecked();
      expect(vi.getByRole('radio', { name: msg('settings.prefs.cursor.bar', undefined, 'vi') })).toBeChecked();
    });

    it('forgets the four choices with the other display preferences', async () => {
      const storage = new MemoryStorage();
      storage.items.set(PREFS_KEY, JSON.stringify({ terminalRenderer: 'dom', terminalCursor: 'bar' }));
      const { user, prefsStore } = setup(storage);
      await user.click(screen.getByRole('button', { name: msg('settings.prefs.reset') }));
      expect(prefsStore.getSnapshot().terminalRenderer).toBeUndefined();
      expect(prefsStore.getSnapshot().terminalCursor).toBeUndefined();
    });
  });

  it('says so when this browser cannot store preferences, and not otherwise', () => {
    const { unmount } = setup(null);
    expect(screen.getByText(msg('settings.prefs.memoryOnly'))).toBeInTheDocument();
    unmount();
    setup(new MemoryStorage());
    expect(screen.queryByText(msg('settings.prefs.memoryOnly'))).not.toBeInTheDocument();
  });
});
