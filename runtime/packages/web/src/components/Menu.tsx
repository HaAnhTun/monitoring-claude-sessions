import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

interface MenuContextValue {
  /** Closes the menu; `returnFocus` puts the focus back on the trigger. */
  close: (returnFocus: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

function useMenu(): MenuContextValue {
  const value = useContext(MenuContext);
  if (value === null) throw new Error('A menu item must be rendered inside <Menu>');
  return value;
}

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

export interface MenuProps {
  /** The accessible name of the icon button that opens the menu, and of the menu itself. */
  label: string;
  icon: IconName;
  align?: 'start' | 'end';
  children: ReactNode;
}

/**
 * An icon button that opens a menu of actions and choices (ADR 0073 decision 6). The trigger carries `aria-haspopup="menu"`,
 * `aria-expanded` and `aria-controls`. Opening moves the focus to the first item (the checked one when a group has one); Up and
 * Down move between items and wrap, Home and End jump to the ends, Escape closes the menu and gives the focus back to the trigger,
 * and so does Tab. A click outside closes it without taking the focus. A radio item keeps the menu open, so a choice can be
 * changed twice; any other item runs its action and closes the menu. The panel is mounted only while open.
 */
export function Menu({ label, icon, align = 'end', children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const closeFromOutside = useEffectEvent(() => {
    setOpen(false);
  });

  // Opening puts the focus on the checked item of the first group that has one, else on the first item.
  useEffect(() => {
    if (!open) return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    if (items === undefined || items.length === 0) return;
    const checked = [...items].find((item) => item.getAttribute('aria-checked') === 'true');
    (checked ?? items[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      closeFromOutside();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      // The menu is not a place to tab through: leave it, and let the Tab move on from the trigger.
      close(true);
      return;
    }
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = at < 0 ? 0 : (at + 1) % items.length;
        break;
      case 'ArrowUp':
        next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
  };

  return (
    <MenuContext value={{ close }}>
      <div className="menu" ref={rootRef} onBlur={onBlur}>
        <Button
          ref={triggerRef}
          variant="icon"
          icon={icon}
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && !open) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        />
        {open ? (
          <div
            id={panelId}
            ref={panelRef}
            role="menu"
            aria-label={label}
            className={align === 'end' ? 'menu__panel menu__panel--end' : 'menu__panel'}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
          >
            {children}
          </div>
        ) : null}
      </div>
    </MenuContext>
  );
}

export interface MenuGroupProps {
  /** The visible heading of the group; it also names the group for assistive technology. */
  label: string;
  children: ReactNode;
}

/** A labelled run of items (a radio group when its items are radio items). */
export function MenuGroup({ label, children }: MenuGroupProps) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="menu__group">
      <div id={headingId} className="menu__heading">
        {label}
      </div>
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="menu__separator" />;
}

interface ItemBase {
  icon?: IconName;
  children: ReactNode;
}

export interface MenuItemProps extends ItemBase {
  /** Runs the action; the menu closes and the focus returns to the trigger. */
  onSelect: () => void;
}

/** An action. */
export function MenuItem({ icon, onSelect, children }: MenuItemProps) {
  const { close } = useMenu();
  return (
    <button
      type="button"
      role="menuitem"
      className="menu__item"
      tabIndex={-1}
      onClick={() => {
        close(true);
        onSelect();
      }}
    >
      {icon === undefined ? null : <Icon name={icon} size="menu" />}
      <span className="menu__text">{children}</span>
    </button>
  );
}

export interface MenuRadioProps extends ItemBase {
  checked: boolean;
  /** Called when the item is chosen; the menu stays open. */
  onSelect: () => void;
}

/** One choice of a group. The chosen one is marked by `aria-checked`, a check mark and the accent colour. */
export function MenuRadio({ icon, checked, onSelect, children }: MenuRadioProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="menu__item"
      tabIndex={-1}
      onClick={onSelect}
    >
      {icon === undefined ? null : <Icon name={icon} size="menu" />}
      <span className="menu__text">{children}</span>
      {checked ? <Icon name="check" className="menu__check" /> : null}
    </button>
  );
}
