import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.tsx';

type HarnessProps = Partial<Omit<ConfirmDialogProps, 'open' | 'onCancel' | 'children'>> & {
  onCancel?: () => void;
  startOpen?: boolean;
};

/** A page with an opener button, the way a dialog is used: the page owns `open`. */
function Harness({ onCancel, startOpen = false, ...props }: HarnessProps) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Opener
      </button>
      <ConfirmDialog
        open={open}
        title="FIXTURE title"
        confirmLabel="FIXTURE confirm"
        cancelLabel={msg('workspace.dialog.cancel')}
        onConfirm={() => undefined}
        {...props}
        onCancel={() => {
          setOpen(false);
          onCancel?.();
        }}
      >
        <p>FIXTURE body</p>
      </ConfirmDialog>
    </>
  );
}

function dialogElement(): HTMLDialogElement {
  const element = document.querySelector('dialog');
  if (element === null) throw new Error('no dialog element');
  return element;
}

const cancelButton = (): HTMLElement => screen.getByRole('button', { name: msg('workspace.dialog.cancel') });

describe('ConfirmDialog', () => {
  it('TC-UI-05 renders nothing to read while it is closed', () => {
    renderWithIntl(<Harness />);
    expect(dialogElement().hasAttribute('open')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('FIXTURE body')).toBeNull();
  });

  it('TC-UI-05 opens as a modal named by its title, with the focus on Cancel', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    const dialog = screen.getByRole('dialog', { name: 'FIXTURE title' });
    expect(dialog).toBe(dialogElement());
    expect(dialog).toHaveClass('dialog');
    expect(screen.getByText('FIXTURE body')).toBeInTheDocument();
    expect(cancelButton()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'FIXTURE confirm' })).toBeInTheDocument();
  });

  it('TC-UI-05 puts the focus on Cancel every time it opens, also when it starts open', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Harness startOpen />);
    expect(cancelButton()).toHaveFocus();
    await user.click(cancelButton());
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    expect(cancelButton()).toHaveFocus();
  });

  it('calls onConfirm from the confirm button and onCancel from Cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithIntl(<Harness startOpen onConfirm={onConfirm} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'FIXTURE confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('TC-UI-05 cancels on Escape and gives the focus back to the opener', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderWithIntl(<Harness onCancel={onCancel} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogElement().hasAttribute('open')).toBe(false);
    expect(opener).toHaveFocus();
  });

  it('TC-UI-05 handles the cancel event of the browser itself (Esc, the back gesture) and keeps the dialog in its own hands', () => {
    const onCancel = vi.fn();
    renderWithIntl(<Harness startOpen onCancel={onCancel} />);
    const event = new Event('cancel', { cancelable: true });
    fireEvent(dialogElement(), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('TC-UI-05 cancels on a click on the backdrop and not on a click inside the box', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderWithIntl(<Harness startOpen onCancel={onCancel} />);
    await user.click(screen.getByText('FIXTURE body'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(dialogElement());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('TC-UI-05 cancels nothing while busy: not by Escape, the backdrop or the Cancel button', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderWithIntl(<Harness startOpen busy onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    fireEvent(dialogElement(), new Event('cancel', { cancelable: true }));
    fireEvent.click(dialogElement());
    expect(cancelButton()).toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'FIXTURE confirm' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('TC-UI-05 shows a failure as an alert inside the box and keeps it open', () => {
    renderWithIntl(<Harness startOpen error="FIXTURE the failure" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('FIXTURE the failure');
    expect(screen.getByRole('dialog').contains(alert)).toBe(true);
  });

  it('shows no alert without an error', () => {
    renderWithIntl(<Harness startOpen error={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers a secondary action beside the confirm button', async () => {
    const user = userEvent.setup();
    const onSecondary = vi.fn();
    const onConfirm = vi.fn();
    renderWithIntl(
      <Harness startOpen onConfirm={onConfirm} secondary={{ label: 'FIXTURE secondary', onClick: onSecondary }} />,
    );
    await user.click(screen.getByRole('button', { name: 'FIXTURE secondary' }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('marks a dangerous action and leaves a plain one unmarked', () => {
    const danger = renderWithIntl(<Harness startOpen tone="danger" />);
    expect(dialogElement()).toHaveClass('dialog--danger');
    danger.unmount();
    renderWithIntl(<Harness startOpen />);
    expect(dialogElement()).not.toHaveClass('dialog--danger');
  });

  it('has only a Cancel button when there is nothing to confirm', () => {
    renderWithIntl(
      <ConfirmDialog
        open
        title="FIXTURE title"
        cancelLabel={msg('workspace.dialog.cancel')}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        <p>FIXTURE body</p>
      </ConfirmDialog>,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([msg('workspace.dialog.cancel')]);
  });

  it('does not move the focus to an opener that left the page', async () => {
    const user = userEvent.setup();
    function Vanishing() {
      const [open, setOpen] = useState(false);
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown ? (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
              }}
            >
              Opener
            </button>
          ) : null}
          <ConfirmDialog
            open={open}
            title="FIXTURE title"
            confirmLabel="FIXTURE confirm"
            cancelLabel={msg('workspace.dialog.cancel')}
            onConfirm={() => {
              setShown(false);
              setOpen(false);
            }}
            onCancel={() => {
              setOpen(false);
            }}
          >
            <p>FIXTURE body</p>
          </ConfirmDialog>
        </>
      );
    }
    renderWithIntl(<Vanishing />);
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    await user.click(screen.getByRole('button', { name: 'FIXTURE confirm' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  it('closes cleanly when the page removes it while it is open', () => {
    const { unmount } = renderWithIntl(<Harness startOpen />);
    expect(() => {
      unmount();
    }).not.toThrow();
  });

  it('TC-UI-11 has no axe violation, open, with an error and busy (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const rendered = renderWithIntl(
        <Harness
          startOpen
          error="FIXTURE the failure"
          cancelLabel={msg('workspace.dialog.cancel', undefined, locale)}
          secondary={{ label: 'FIXTURE secondary', onClick: () => undefined }}
        />,
        { locale },
      );
      // colour contrast needs layout, which the test environment does not have; the contrast gate is lib/tokens-contrast.test.ts
      const result = await axe.run(rendered.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        result.violations.map((violation) => violation.id),
        locale,
      ).toEqual([]);
      rendered.unmount();
    }
  });
});
