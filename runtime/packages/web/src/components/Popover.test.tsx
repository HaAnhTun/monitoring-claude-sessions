import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Popover } from './Popover.tsx';

function setup(props: Partial<Parameters<typeof Popover>[0]> = {}) {
  const user = userEvent.setup();
  render(
    <div>
      <button type="button">Outside</button>
      <Popover label="Columns" panelLabel="Choose columns" {...props}>
        <button type="button">First option</button>
        <button type="button">Second option</button>
      </Popover>
      <button type="button">After</button>
    </div>,
  );
  return { user, trigger: screen.getByRole('button', { name: 'Columns' }) };
}

describe('Popover', () => {
  it('starts closed: the trigger says so and no panel exists', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on click and wires aria-expanded and aria-controls to the panel', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Choose columns' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.id).not.toBe('');
    expect(screen.getByRole('button', { name: 'First option' })).toBeInTheDocument();
  });

  it('toggles closed on a second click of the trigger', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and returns the focus to the trigger', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Second option' }));
    expect(screen.getByRole('button', { name: 'Second option' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on a click outside and keeps the focus where the user clicked', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays open on a click inside the panel', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'First option' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes when the focus leaves the popover with the keyboard', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Second option' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('lets a render-prop child close it, and the focus returns to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Popover label="Language">
        {({ close }) => (
          <button type="button" onClick={close}>
            Pick
          </button>
        )}
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Language' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Pick' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('reports every change through onOpenChange', async () => {
    const onOpenChange = vi.fn();
    const { user, trigger } = setup({ onOpenChange });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('is controllable from outside', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <Popover label="Columns" open onOpenChange={onOpenChange}>
        <p>Body</p>
      </Popover>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // still open: the parent did not accept the change
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(
      <Popover label="Columns" open={false} onOpenChange={onOpenChange}>
        <p>Body</p>
      </Popover>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives an icon-only trigger its accessible name from ariaLabel', () => {
    render(
      <Popover icon="more" variant="icon" ariaLabel="More actions">
        <p>Body</p>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveClass('btn', 'btn-icon');
  });

  it('aligns the panel to the end when asked', async () => {
    const { user, trigger } = setup({ align: 'end' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toHaveClass('popover__panel', 'popover__panel--end');
  });

  it('removes its document listeners on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const user = userEvent.setup();
    const { unmount } = render(
      <Popover label="Columns">
        <p>Body</p>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const added = add.mock.calls.filter(([type]) => type === 'keydown' || type === 'pointerdown').length;
    expect(added).toBeGreaterThan(0);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === 'keydown' || type === 'pointerdown').length;
    expect(removed).toBe(added);
  });
});
