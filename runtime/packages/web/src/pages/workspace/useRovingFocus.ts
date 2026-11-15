// Roving focus for the list of the Workspace sidebar (design 04 6.2, modelled on `SessionSwitcher`): one tab stop in the whole list,
// Up and Down over the items in document order, Home and End, and a focus that survives the live updates of the list. An item is any
// element with `data-nav-item` and a `data-nav-id`; the components of the list only mark their elements, so a head button, a
// session link, a Resume button and a "New session" button all take part without knowing about each other. The tab order is set on
// the DOM (`tabindex`) from a layout effect and a mutation observer, because rows arrive and leave on their own (a live session
// appears, a folder body opens, the recent sessions load) without the owner of the list rendering again.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const ITEM_SELECTOR = '[data-nav-item]';

export interface RovingFocusOptions {
  /** The `data-nav-id` of the item that is the tab stop while the person has not moved into the list (the selected row). */
  preferredId?: string | null;
  /** The elements that take part. Default: `[data-nav-item]`. */
  itemSelector?: string;
}

export interface RovingFocus<E extends HTMLElement> {
  /** The ref callback of the element that holds the items. */
  containerRef: (element: E | null) => void;
  /** Puts the focus on the tab stop (the item that Tab would reach); false when the list has no item. */
  focusTabStop: () => boolean;
}

const idOf = (item: HTMLElement): string => item.dataset['navId'] ?? '';

/** Whether the person can put the focus on the item: not disabled and not inside a hidden part of the list. */
function reachable(item: HTMLElement): boolean {
  return !item.hasAttribute('disabled') && item.closest('[hidden]') === null;
}

function itemsOf(container: HTMLElement, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)].filter(reachable);
}

/** The item that Tab reaches: the one the person is on, else the preferred one, else the first. */
function tabStopOf(
  items: readonly HTMLElement[],
  activeId: string | null,
  preferredId: string | null,
): HTMLElement | undefined {
  return (
    (activeId === null ? undefined : items.find((item) => idOf(item) === activeId)) ??
    (preferredId === null ? undefined : items.find((item) => idOf(item) === preferredId)) ??
    items[0]
  );
}

/**
 * One tab stop and the arrow keys over the `[data-nav-item]` elements below the element that carries `ref`. Up and Down move one item
 * (no wrap, as in the session switcher), Home and End jump to the ends, a key with Ctrl, Alt or Meta is left alone, and so is a key
 * pressed in a field of the list. A re-render that replaces the focused item gives the focus back to the item with the same id; a
 * focus that the person moved out of the list is never taken back.
 */
export function useRovingFocus<E extends HTMLElement = HTMLElement>(options: RovingFocusOptions = {}): RovingFocus<E> {
  const { preferredId = null, itemSelector = ITEM_SELECTOR } = options;
  const [container, setContainer] = useState<E | null>(null);
  const activeId = useRef<string | null>(null);
  /** The id of the item that has the focus, kept so that a replaced element can be found again; null once the person left. */
  const focusId = useRef<string | null>(null);

  const sync = useCallback(() => {
    if (container === null) return;
    const items = itemsOf(container, itemSelector);
    const stop = tabStopOf(items, activeId.current, preferredId);
    for (const item of items) {
      const wanted = item === stop ? '0' : '-1';
      if (item.getAttribute('tabindex') !== wanted) item.setAttribute('tabindex', wanted);
    }
    // A re-render replaced the focused item: the focus fell to the document. Put it back on the item with the same id; a focus
    // that the person moved elsewhere is left alone.
    const id = focusId.current;
    if (id === null || container.contains(document.activeElement)) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const again = items.find((item) => idOf(item) === id);
    if (again !== undefined) again.focus({ preventScroll: true });
  }, [container, itemSelector, preferredId]);

  // After every render of the owner, and when the preferred item changes.
  useLayoutEffect(() => {
    sync();
  });

  // Rows that arrive or leave without the owner rendering.
  useEffect(() => {
    if (container === null || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [container, sync]);

  useEffect(() => {
    if (container === null) return undefined;
    const itemOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(itemSelector) : null;

    function onFocusIn(event: FocusEvent): void {
      const item = itemOf(event.target);
      if (item === null) return;
      focusId.current = idOf(item);
      activeId.current = idOf(item);
      sync();
    }

    function onFocusOut(event: FocusEvent): void {
      const leaving = itemOf(event.target);
      if (leaving === null) return;
      if (event.relatedTarget instanceof Node && container?.contains(event.relatedTarget)) return;
      // An item that left the document was replaced by a re-render; one that is still there was left by the person.
      setTimeout(() => {
        if (leaving.isConnected) focusId.current = null;
      }, 0);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented || container === null) return;
      const current = itemOf(event.target);
      if (current === null) return;
      const items = itemsOf(container, itemSelector);
      const index = items.indexOf(current);
      if (index === -1) return;
      let next: number;
      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(items.length - 1, index + 1);
          break;
        case 'ArrowUp':
          next = Math.max(0, index - 1);
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
    }

    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [container, itemSelector, sync]);

  const focusTabStop = useCallback((): boolean => {
    if (container === null) return false;
    const stop = tabStopOf(itemsOf(container, itemSelector), activeId.current, preferredId);
    if (stop === undefined) return false;
    stop.focus();
    return true;
  }, [container, itemSelector, preferredId]);

  return { containerRef: setContainer, focusTabStop };
}
