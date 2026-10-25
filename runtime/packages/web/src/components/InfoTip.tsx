import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Popover } from './Popover.tsx';

export interface InfoTipProps {
  /** Accessible name of the trigger, for example "About Output tokens". It names what the tip explains. */
  label: string;
  /** The text of the tip. */
  children: ReactNode;
  /** Which edge of the trigger the panel lines up with first. It turns to the other edge when it would leave the window. */
  align?: 'start' | 'end';
}

/** The space kept between the panel and the edge of the window. */
const EDGE_GAP = 8;
const OTHER_SIDE = { start: 'end', end: 'start' } as const;

/**
 * A small info button that opens a panel with an explanation (the source and the rule of a metric). It is a button, not a
 * hover target: Enter and Space open it, Escape closes it and returns the focus to the button, and the next Tab enters the
 * panel (ADR 0071 decision 7, WCAG 1.4.13). Used where a title attribute would hide text from keyboard and touch users. A panel
 * that would run past the edge of the window opens towards the other side instead, so a tile at either edge of a grid works.
 */
export function InfoTip({ label, children, align = 'start' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const side = flipped ? OTHER_SIDE[align] : align;

  useLayoutEffect(() => {
    if (!open || flipped) return;
    const panel = rootRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (panel === null || panel === undefined) return;
    const rect = panel.getBoundingClientRect();
    if (rect.width === 0) return;
    const overflows = side === 'start' ? rect.right > window.innerWidth - EDGE_GAP : rect.left < EDGE_GAP;
    if (overflows) setFlipped(true);
  }, [open, flipped, side]);

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) setFlipped(false);
  };

  return (
    <span className="info-tip" ref={rootRef}>
      <Popover
        icon="info"
        variant="icon"
        ariaLabel={label}
        panelLabel={label}
        align={side}
        open={open}
        onOpenChange={onOpenChange}
      >
        <div className="info-tip__body">{children}</div>
      </Popover>
    </span>
  );
}
