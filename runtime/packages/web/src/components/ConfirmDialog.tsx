import { useEffect, useEffectEvent, useId, useRef, type ReactNode, type RefObject } from 'react';

import { Button } from './Button.tsx';

export interface ConfirmDialogProps {
  /** The page owns it: `true` opens the dialog as a modal, `false` closes it. */
  open: boolean;
  title: string;
  /** Left out: the dialog has only its Cancel button (a state with nothing to confirm yet, or nothing left to do). */
  confirmLabel?: string;
  cancelLabel: string;
  /** `danger` marks an action that stops or removes something. */
  tone?: 'primary' | 'danger';
  /** A request is running: the buttons wait and Escape and a click outside do not close the dialog. */
  busy?: boolean;
  /** A failure of the last attempt, shown inside the box as an alert; the dialog stays open. */
  error?: string | null;
  /** The confirm button waits (nothing to confirm yet, for example an empty field). */
  confirmDisabled?: boolean;
  /** The element that takes the focus when the dialog opens instead of Cancel (a dialog with a field). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** A second way forward, for example "Resume a copy". */
  secondary?: { label: string; onClick: () => void };
  onConfirm: () => void;
  /** Escape, a click on the backdrop and the Cancel button all end here (never while `busy`). */
  onCancel: () => void;
  children: ReactNode;
}

/**
 * A question in a native `<dialog>` (design 04 6.4, design 05 3.3): `showModal()` so the browser traps the focus, the focus on
 * Cancel (the safe answer), Escape and a click outside cancel unless a request is running, a failure is an alert inside the box,
 * and the focus goes back to the element that had it before the dialog opened. Where `showModal` does not exist (the test
 * environment) the dialog is opened with the `open` attribute and Escape is read from the keyboard.
 *
 * The content exists only while the dialog is open, so what a dialog asks of its children (a request, a timer) starts when it opens.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  busy = false,
  error = null,
  confirmDisabled = false,
  initialFocus,
  secondary,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  const requestCancel = useEffectEvent((): void => {
    if (!busy) onCancel();
  });

  // Read when the dialog opens, never later: a new ref object must not move the focus again.
  const focusInitial = useEffectEvent((): void => {
    (initialFocus?.current ?? cancelRef.current)?.focus();
  });

  // The dialog is not a control, so these listeners are native (the keyboard way out is Escape, the pointer way is the backdrop).
  // Escape is handled on the key itself and `cancel` (any other close request of the browser, such as the back gesture) is
  // refused and handled the same way: the page decides when the dialog closes, through `open`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const state = { pressedInside: false };
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      requestCancel();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestCancel();
    };
    // A drag that starts in the box and ends on the backdrop (selecting text) is not a click on the backdrop.
    const onMouseDown = (event: MouseEvent): void => {
      state.pressedInside = event.target !== dialog;
    };
    const onClick = (event: MouseEvent): void => {
      const insidePress = state.pressedInside;
      state.pressedInside = false;
      if (event.target === dialog && !insidePress) requestCancel();
    };
    dialog.addEventListener('cancel', onCancelEvent);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('mousedown', onMouseDown);
    dialog.addEventListener('click', onClick);
    return () => {
      dialog.removeEventListener('cancel', onCancelEvent);
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.removeEventListener('mousedown', onMouseDown);
      dialog.removeEventListener('click', onClick);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open) return undefined;
    if (!dialog.open) {
      opener.current = document.activeElement;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    focusInitial();
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      // Browsers give the focus back to the opener of a modal dialog; do it here too, for those that do not.
      const target = opener.current;
      opener.current = null;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [open]);

  // A button that becomes disabled loses the focus in a browser; keep it inside the box so Escape still reaches the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open || !busy) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !dialog.contains(active)) dialog.focus();
  }, [open, busy]);

  return (
    <dialog
      ref={dialogRef}
      className={tone === 'danger' ? 'dialog dialog--danger' : 'dialog'}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      {open ? (
        <>
          <h2 id={titleId} className="dialog__head">
            {title}
          </h2>
          <div className="dialog__body">
            {children}
            {error === null ? null : (
              <p role="alert" className="dialog__error">
                {error}
              </p>
            )}
          </div>
          <div className="dialog__foot">
            <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
            {secondary === undefined ? null : (
              <Button onClick={secondary.onClick} disabled={busy}>
                {secondary.label}
              </Button>
            )}
            {confirmLabel === undefined ? null : (
              <Button variant="primary" loading={busy} disabled={confirmDisabled} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
