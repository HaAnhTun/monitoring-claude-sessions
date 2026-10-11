// Scroll anchoring for the transcript list (04-ui.md 4.4.3 rule 6, ADR 0038): the first visible row stays where it is while rows
// are added above it, hidden or shown; while following, the list snaps to the latest edge instead. No virtualization, plain DOM.
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

export interface ScrollAnchorOptions {
  /** Follow mode: after a layout change the scroller snaps to the latest edge instead of restoring the anchor. */
  follow: boolean;
  /** Newest-first lists have their latest edge at the top, oldest-first lists at the bottom. */
  newestFirst: boolean;
}

export interface ScrollAnchor {
  /** Remembers the first visible row and its offset from the top of the scroller. Cheap; call before a known change. */
  captureAnchor: () => void;
  /** Moves `scrollTop` by however far the remembered row has drifted. */
  restoreAnchor: () => void;
}

interface Anchor {
  key: string;
  offset: number;
}

const ROW_SELECTOR = '[data-row-key]:not([hidden])';

/** The first visible row: rows are in visual order, so the first whose bottom edge is below the top of the scroller. */
function firstVisibleRow(scroller: HTMLElement): HTMLElement | null {
  const rows = scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  const top = scroller.getBoundingClientRect().top;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid];
    if (row !== undefined && row.getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return rows[lo] ?? null;
}

function findRow(scroller: HTMLElement, key: string): HTMLElement | null {
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-row-key]')) {
    if (row.dataset['rowKey'] === key) return row;
  }
  return null;
}

/**
 * `layoutKey` changes whenever the rows change (merge, filter, order). After the commit of such a change the hook either
 * snaps to the latest edge (follow) or restores the anchor captured before it. The anchor is refreshed after every
 * adjustment, so callers only need `captureAnchor` on scroll and before changes they trigger themselves.
 */
export function useScrollAnchor(
  scrollerRef: RefObject<HTMLElement | null>,
  layoutKey: string,
  options: ScrollAnchorOptions,
): ScrollAnchor {
  const anchor = useRef<Anchor | null>(null);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const captureAnchor = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const row = firstVisibleRow(scroller);
    const key = row?.dataset['rowKey'];
    if (row === null || key === undefined) {
      anchor.current = null;
      return;
    }
    anchor.current = { key, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
  }, [scrollerRef]);

  const restoreAnchor = useCallback((): void => {
    const scroller = scrollerRef.current;
    const saved = anchor.current;
    if (scroller === null || saved === null) return;
    const row = findRow(scroller, saved.key);
    if (row === null || row.hidden) return;
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
    if (delta !== 0) scroller.scrollTop += delta;
  }, [scrollerRef]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    if (optionsRef.current.follow) {
      scroller.scrollTop = optionsRef.current.newestFirst ? 0 : scroller.scrollHeight;
    } else {
      restoreAnchor();
    }
    captureAnchor();
  }, [layoutKey, scrollerRef, restoreAnchor, captureAnchor]);

  return { captureAnchor, restoreAnchor };
}
