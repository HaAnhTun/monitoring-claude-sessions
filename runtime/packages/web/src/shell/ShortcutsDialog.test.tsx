import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useT } from '../i18n/context.ts';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { ShortcutRegistryProvider, useShortcut, useShortcutRegistry } from '../state/shortcuts-registry.tsx';
import { RELEASE_CHORD } from '../terminal/protocol.ts';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';

// 04 6.5, review R-20: one key cap per key, grouped as Navigation, Search and Transcript; a key shows up while a component that
// registered it is mounted.

function Opener() {
  const { setHelpOpen } = useShortcutRegistry();
  return (
    <button
      type="button"
      onClick={() => {
        setHelpOpen(true);
      }}
    >
      open
    </button>
  );
}

/** What the shell registers. */
function ShellKeys() {
  useShortcut('?', () => undefined, { description: msg('shell.shortcutsHelp') });
  return null;
}

/** What a transcript viewer registers. */
function ViewerKeys() {
  useShortcut('/', () => undefined, { description: msg('transcript.shortcut.search') });
  useShortcut('f', () => undefined, { description: msg('transcript.shortcut.follow') });
  useShortcut(']', () => undefined, { description: msg('transcript.shortcut.nextError') });
  useShortcut('[', () => undefined, { description: msg('transcript.shortcut.prevError') });
  return null;
}

/** What the Workspace page registers while a session is selected (design 04 7.5). */
function WorkspaceKeys() {
  const t = useT();
  useShortcut('t', () => undefined, { description: t('workspace.shortcut.focusTerminal'), group: 'terminal' });
  return null;
}

function Harness({ viewer = false, workspace = false }: { viewer?: boolean; workspace?: boolean }) {
  const [mounted, setMounted] = useState(viewer);
  return (
    <ShortcutRegistryProvider>
      <ShellKeys />
      {workspace ? <WorkspaceKeys /> : null}
      {mounted ? <ViewerKeys /> : null}
      <button
        type="button"
        onClick={() => {
          setMounted((value) => !value);
        }}
      >
        toggle viewer
      </button>
      <Opener />
      <ShortcutsDialog />
    </ShortcutRegistryProvider>
  );
}

async function openDialog(options: { viewer?: boolean; workspace?: boolean; locale?: 'en' | 'vi' } = {}) {
  const user = userEvent.setup();
  const rendered = renderWithProviders(
    <Harness viewer={options.viewer ?? false} workspace={options.workspace ?? false} />,
    {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    },
  );
  await user.click(screen.getByRole('button', { name: 'open' }));
  const dialog = await screen.findByRole('dialog', { name: msg('shortcuts.title', undefined, options.locale ?? 'en') });
  return { user, dialog, ...rendered };
}

/** The key caps of the row whose description is `description`. */
function keysOf(dialog: HTMLElement, description: string): string[] {
  const term = within(dialog).getByText(description).closest('div')?.querySelector('dt');
  if (term === null || term === undefined) throw new Error(`no row for "${description}"`);
  return [...term.querySelectorAll('kbd')].map((key) => key.textContent);
}

describe('ShortcutsDialog: content', () => {
  it('is a modal dialog named "Keyboard shortcuts" with a Close button', async () => {
    const { dialog } = await openDialog();
    expect(dialog.tagName).toBe('DIALOG');
    expect(within(dialog).getByRole('heading', { level: 2, name: msg('shortcuts.title') })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: msg('common.close') })).toBeInTheDocument();
  });

  it('lists the registered shortcut of the shell and the fixed rows, each key in its own kbd', async () => {
    const { dialog } = await openDialog();
    expect(keysOf(dialog, msg('shell.shortcutsHelp'))).toEqual(['?']);
    expect(keysOf(dialog, msg('shortcuts.fixed.escape'))).toEqual([msg('shortcuts.key.esc')]);
    expect(keysOf(dialog, msg('shortcuts.fixed.sidebar'))).toEqual([
      msg('shortcuts.key.up'),
      msg('shortcuts.key.down'),
      msg('shortcuts.key.home'),
      msg('shortcuts.key.end'),
    ]);
    for (const key of dialog.querySelectorAll('kbd')) expect(key).toHaveClass('kbd');
  });

  it('does not list f [ ] and the search key when no viewer is mounted', async () => {
    const { dialog } = await openDialog();
    for (const key of ['f', '[', ']', '/']) {
      expect([...dialog.querySelectorAll('kbd')].map((cap) => cap.textContent)).not.toContain(key);
    }
    expect(within(dialog).queryByRole('heading', { name: msg('shortcuts.group.transcript') })).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: msg('shortcuts.group.search') })).toBeNull();
  });

  it('lists / f [ ] with the words of the viewer that registered them, grouped as Search and Transcript', async () => {
    const { dialog } = await openDialog({ viewer: true });
    expect(keysOf(dialog, msg('transcript.shortcut.search'))).toEqual(['/']);
    expect(keysOf(dialog, msg('transcript.shortcut.follow'))).toEqual(['f']);
    expect(keysOf(dialog, msg('transcript.shortcut.nextError'))).toEqual([']']);
    expect(keysOf(dialog, msg('transcript.shortcut.prevError'))).toEqual(['[']);
    const section = (name: string): HTMLElement => {
      const found = within(dialog).getByRole('heading', { name }).closest('section');
      if (found === null) throw new Error(`no section ${name}`);
      return found;
    };
    expect(within(section(msg('shortcuts.group.search'))).getAllByRole('term')).toHaveLength(1);
    expect(within(section(msg('shortcuts.group.transcript'))).getAllByRole('term')).toHaveLength(3);
    const navigation = within(section(msg('shortcuts.group.navigation')));
    expect(navigation.getByText(msg('shell.shortcutsHelp'))).toBeInTheDocument();
    expect(navigation.getByText(msg('shortcuts.fixed.escape'))).toBeInTheDocument();
    expect(navigation.getByText(msg('shortcuts.fixed.sidebar'))).toBeInTheDocument();
  });

  it('draws the groups in the order Navigation, Search, Transcript, Terminal', async () => {
    const { dialog } = await openDialog({ viewer: true });
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      msg('shortcuts.group.navigation'),
      msg('shortcuts.group.search'),
      msg('shortcuts.group.transcript'),
      msg('shortcuts.group.terminal'),
    ]);
  });

  describe('the Terminal group (design 04 7.5, TC-UI-12)', () => {
    const section = (dialog: HTMLElement): HTMLElement => {
      const found = within(dialog)
        .getByRole('heading', { name: msg('shortcuts.group.terminal') })
        .closest('section');
      if (found === null) throw new Error('no Terminal section');
      return found;
    };

    it('always lists the way out of the terminal, copy, paste and scrolling, each chord in ONE key cap', async () => {
      const { dialog } = await openDialog();
      expect(keysOf(dialog, msg('workspace.shortcut.release'))).toEqual([RELEASE_CHORD]);
      expect(keysOf(dialog, msg('workspace.shortcut.copy'))).toEqual(['Ctrl+C']);
      expect(keysOf(dialog, msg('workspace.shortcut.paste'))).toEqual(['Ctrl+V']);
      // two keys that both scroll are two caps: alternatives, not a chord
      expect(keysOf(dialog, msg('workspace.shortcut.scroll'))).toEqual(['Shift+PageUp', 'Shift+PageDown']);
      expect(within(section(dialog)).getAllByRole('term')).toHaveLength(4);
    });

    it('lists the key `t` only while the page that registered it is mounted, in the same group', async () => {
      const without = await openDialog();
      expect(within(section(without.dialog)).queryByText(msg('workspace.shortcut.focusTerminal'))).toBeNull();
      without.unmount();
      const withIt = await openDialog({ workspace: true });
      expect(keysOf(withIt.dialog, msg('workspace.shortcut.focusTerminal'))).toEqual(['t']);
      expect(within(section(withIt.dialog)).getAllByRole('term')).toHaveLength(5);
    });

    it('speaks Vietnamese: the heading and the descriptions of the rows', async () => {
      const { dialog } = await openDialog({ locale: 'vi', workspace: true });
      const vi = (
        key: 'shortcuts.group.terminal' | 'workspace.shortcut.release' | 'workspace.shortcut.focusTerminal',
      ) => msg(key, undefined, 'vi');
      expect(
        within(dialog).getByRole('heading', { level: 3, name: vi('shortcuts.group.terminal') }),
      ).toBeInTheDocument();
      expect(keysOf(dialog, vi('workspace.shortcut.release'))).toEqual([RELEASE_CHORD]);
      expect(keysOf(dialog, vi('workspace.shortcut.focusTerminal'))).toEqual(['t']);
    });
  });

  it('follows the mounted viewer while the dialog is open: unmounting removes its keys', async () => {
    const { dialog } = await openDialog({ viewer: true });
    expect(within(dialog).getByText(msg('transcript.shortcut.follow'))).toBeInTheDocument();
    // The registry is what the dialog reads, so a viewer that unmounts takes its keys with it.
    act(() => {
      screen.getByRole('button', { name: 'toggle viewer' }).click();
    });
    expect(within(dialog).queryByText(msg('transcript.shortcut.follow'))).toBeNull();
  });

  it('speaks Vietnamese when the page does', async () => {
    const { dialog } = await openDialog({ locale: 'vi' });
    expect(
      within(dialog).getByRole('heading', { level: 3, name: msg('shortcuts.group.navigation', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(msg('shortcuts.fixed.sidebar', undefined, 'vi'))).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: msg('common.close', undefined, 'vi') })).toBeInTheDocument();
  });
});

describe('ShortcutsDialog: closing', () => {
  it('closes with its Close button and returns the focus to the element that opened it', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: msg('common.close') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'open' })).toHaveFocus();
  });

  it('closes on a click on the backdrop but not on a click inside', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('heading', { name: msg('shortcuts.title') }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('closes with the native close event (Esc) and can be opened again', async () => {
    const { user, dialog } = await openDialog();
    act(() => {
      (dialog as HTMLDialogElement).close();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByRole('dialog', { name: msg('shortcuts.title') })).toBeInTheDocument();
  });
});
