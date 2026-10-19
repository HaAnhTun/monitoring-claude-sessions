import { useEffect, useEffectEvent, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';

import { Button, type ButtonVariant } from './Button.tsx';
import type { IconName } from './icons.ts';

export interface PopoverApi {
  /** Closes the panel and returns the focus to the trigger. */
  close: () => void;
}

export interface PopoverProps {
  /** Visible text of the trigger. */
  label?: ReactNode;
  /** Accessible name of an icon-only trigger. */
  ariaLabel?: string;
  icon?: IconName;
  variant?: ButtonVariant;
  /** Accessible name of the panel; without it the panel is named by its trigger. */
  panelLabel?: string;
  align?: 'start' | 'end';
  /** Controlled state; leave it out for an uncontrolled popover. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode | ((api: PopoverApi) => ReactNode);
}

/**
 * A trigger button and a panel below it (ADR 0071 decision 7). The trigger carries `aria-expanded` and `aria-controls`. The panel
 * closes on Escape (the focus returns to the trigger), on a click outside (the focus stays where the user clicked) and when the
 * keyboard focus leaves it. The panel is mounted only while open; the focus is not moved on open, so the next Tab enters it.
 */
export function Popover({
  label,
  ariaLabel,
  icon,
  variant = 'default',
  panelLabel,
  align = 'start',
  open,
  onOpenChange,
  children,
}: PopoverProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : innerOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const triggerId = useId();

  const setOpen = (next: boolean, returnFocus: boolean): void => {
    if (isOpen === next) return;
    if (!controlled) setInnerOpen(next);
    onOpenChange?.(next);
    if (!next && returnFocus) triggerRef.current?.focus();
  };

  // Effect events always see the latest render, so the document listeners are registered once per open.
  const closeFromKeyboard = useEffectEvent(() => {
    setOpen(false, true);
  });
  const closeFromOutside = useEffectEvent(() => {
    setOpen(false, false);
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeFromKeyboard();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      closeFromOutside();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen]);

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false, false);
  };

  const close = (): void => {
    setOpen(false, true);
  };
  return (
    <div className="popover" ref={rootRef} onBlur={onBlur}>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant={variant}
        {...(icon === undefined ? {} : { icon })}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!isOpen, false);
        }}
      >
        {label}
      </Button>
      {isOpen ? (
        <div
          id={panelId}
          role="dialog"
          className={align === 'end' ? 'popover__panel popover__panel--end' : 'popover__panel'}
          aria-label={panelLabel}
          aria-labelledby={panelLabel === undefined ? triggerId : undefined}
        >
          <PanelContent close={close}>{children}</PanelContent>
        </div>
      ) : null}
    </div>
  );
}

/** Renders the children of the panel; a function child gets the close callback. */
function PanelContent({ close, children }: { close: () => void; children: PopoverProps['children'] }) {
  return typeof children === 'function' ? children({ close }) : children;
}
