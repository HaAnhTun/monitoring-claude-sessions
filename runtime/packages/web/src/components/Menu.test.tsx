import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Menu, MenuGroup, MenuItem, MenuRadio, MenuSeparator } from './Menu.tsx';

// ADR 0073 decision 6: a menu button with radio groups and plain items; aria-checked, arrow keys, focus in and out.

function Demo({ onShortcuts = () => undefined }: { onShortcuts?: () => void }) {
  const [theme, setTheme] = useState('auto');
  const [density, setDensity] = useState('comfortable');
  return (
    <>
      <button type="button">before</button>
      <Menu label="Preferences" icon="user">
        <MenuGroup label="Theme">
          {['auto', 'light', 'dark'].map((value) => (
            <MenuRadio
              key={value}
              checked={theme === value}
              onSelect={() => {
                setTheme(value);
              }}
            >
              {`Theme ${value}`}
            </MenuRadio>
          ))}
        </MenuGroup>
        <MenuGroup label="Density">
          {['comfortable', 'compact'].map((value) => (
            <MenuRadio
              key={value}
              checked={density === value}
              onSelect={() => {
                setDensity(value);
              }}
            >
              {`Density ${value}`}
            </MenuRadio>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem icon="keyboard" onSelect={onShortcuts}>
          Shortcuts
        </MenuItem>
      </Menu>
      <button type="button">after</button>
    </>
  );
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Preferences' });

describe('Menu: the trigger', () => {
  it('is an icon button named by the label, collapsed, and says it opens a menu', () => {
    render(<Demo />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('title', 'Preferences');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click and points aria-controls at the menu', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    const menu = screen.getByRole('menu', { name: 'Preferences' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(menu.id).toBe(trigger().getAttribute('aria-controls'));
  });

  it('opens with the Down arrow', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('toggles closed on a second click', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Menu: items and groups', () => {
  it('groups the radio items under a visible heading and marks the chosen one with aria-checked', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    const theme = within(screen.getByRole('group', { name: 'Theme' }));
    expect(theme.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(screen.getByRole('group', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Shortcuts' })).toBeInTheDocument();
  });

  it('a radio choice changes the checked item and leaves the menu open', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitemradio', { name: 'Theme dark' }));
    expect(screen.getByRole('menuitemradio', { name: 'Theme dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Theme auto' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // A second choice in the same open menu works as well.
    await user.click(screen.getByRole('menuitemradio', { name: 'Density compact' }));
    expect(screen.getByRole('menuitemradio', { name: 'Density compact' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a plain item runs its action, closes the menu and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    const onShortcuts = vi.fn();
    render(<Demo onShortcuts={onShortcuts} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Shortcuts' }));
    expect(onShortcuts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('draws the icon at menu size (18 px) and a check mark on the chosen radio item only', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    const item = screen.getByRole('menuitem', { name: 'Shortcuts' });
    expect(item.querySelector('svg')).toHaveAttribute('width', '18');
    expect(screen.getByRole('menuitemradio', { name: 'Theme auto' }).querySelector('.menu__check')).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Theme dark' }).querySelector('.menu__check')).toBeNull();
  });
});

describe('Menu: keyboard', () => {
  it('moves the focus to the chosen item of the first group when it opens', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    expect(screen.getByRole('menuitemradio', { name: 'Theme auto' })).toHaveFocus();
  });

  it('Down and Up move between items across groups and wrap around', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    const names = ['Theme auto', 'Theme light', 'Theme dark', 'Density comfortable', 'Density compact', 'Shortcuts'];
    for (const name of names.slice(1)) {
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveAccessibleName(name);
    }
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveAccessibleName('Theme auto');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toHaveAccessibleName('Shortcuts');
  });

  it('Home and End jump to the first and the last item', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAccessibleName('Shortcuts');
    await user.keyboard('{Home}');
    expect(document.activeElement).toHaveAccessibleName('Theme auto');
  });

  it('Enter and Space choose the focused radio item', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('menuitemradio', { name: 'Theme light' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}{ }');
    expect(screen.getByRole('menuitemradio', { name: 'Theme dark' })).toHaveAttribute('aria-checked', 'true');
  });

  it('all items are out of the Tab order (the focus moves with the arrow keys)', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    const items = screen.getByRole('menu').querySelectorAll('[role^="menuitem"]');
    expect(items).toHaveLength(6);
    for (const item of items) expect(item).toHaveAttribute('tabindex', '-1');
  });

  it('Escape closes the menu and returns the focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('Tab closes the menu and moves on from the trigger', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });
});

describe('Menu: leaving without choosing', () => {
  it('closes on a click outside and leaves the focus where the user clicked', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'before' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'before' })).toHaveFocus();
  });
});
