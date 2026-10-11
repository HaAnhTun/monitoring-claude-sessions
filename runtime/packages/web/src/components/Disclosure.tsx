import { useState, type ReactNode } from 'react';

import { Icon } from './Icon.tsx';

export interface DisclosureProps {
  /** Id of the panel; the button controls it. */
  id: string;
  label: ReactNode;
  /** Controlled state; omit for local state. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/** A button that shows or hides a panel (04-ui.md 6.6 rule 9: `button[aria-expanded][aria-controls]`). */
export function Disclosure({ id, label, open, defaultOpen = false, onToggle, children }: DisclosureProps) {
  const [local, setLocal] = useState(defaultOpen);
  const isOpen = open ?? local;
  return (
    <div className="disclosure">
      <button
        type="button"
        className="btn btn-quiet disclosure__toggle"
        aria-expanded={isOpen}
        aria-controls={id}
        onClick={() => {
          const next = !isOpen;
          setLocal(next);
          onToggle?.(next);
        }}
      >
        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
        {label}
      </button>
      <div id={id} className="disclosure__panel" hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
