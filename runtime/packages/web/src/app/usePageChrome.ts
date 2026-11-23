import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router';

import { useT } from '../i18n/context.ts';
import { useAttentionChrome } from '../state/attention-chrome.ts';

/** Initial history entry key of react-router: set before any navigation happened in this document. */
const INITIAL_LOCATION_KEY = 'default';

/** The document title: the page before the application name; an empty page title gives the application name alone. */
export function documentTitleFor(title: string, appTitle: string): string {
  return title === '' ? appTitle : `${title} - ${appTitle}`;
}

/** The words in front of the title while sessions wait (ADR 0107): a count and a fixed phrase, never a name. */
const ATTENTION_TITLE_KEYS = {
  needs_you: 'attention.title.needs_you',
  failed: 'attention.title.failed',
  done: 'attention.title.done',
} as const;

/**
 * Page chrome of every route (04-ui.md 3.1 rule 5): sets `document.title` (the page name, already in the language that is shown,
 * before the application name from `shell.appTitle`; in front of both the count of the attention center, which this hook reads
 * from its store so that it stays the only writer of the title), and on a pathname change scrolls `#main` to the top and moves focus to the
 * page heading. Search-only changes do nothing, and neither does the first load. When the page replaces its heading element while
 * the old one holds the focus (a loading frame gives way to the loaded page), the focus follows to the new heading: removing a
 * focused element would otherwise drop it on the document. Attach the returned ref to the page `<h1 tabIndex={-1}>`.
 */
export function usePageChrome(title: string): RefObject<HTMLHeadingElement | null> {
  const t = useT();
  const appTitle = t('shell.appTitle');
  const attention = useAttentionChrome().title;
  const prefix = attention === null ? '' : `${t(ATTENTION_TITLE_KEYS[attention.kind], { count: attention.count })} `;
  const { pathname, key } = useLocation();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const lastPathname = useRef<string | null>(null);
  const lastHeading = useRef<HTMLHeadingElement | null>(null);
  const focusedHeading = useRef<HTMLHeadingElement | null>(null);

  // Which heading element holds the focus. A heading that is removed while focused keeps the mark (the document reports the body
  // by then), and that is what the effect below reads. A heading that loses the focus while it stays in the page (a click on an
  // empty part) loses the mark; the check waits for the end of the task because a browser may report the loss of the focus just
  // before it removes the element, and a window that goes to the background reports one while the element stays focused.
  useEffect(() => {
    function onFocusIn(event: FocusEvent): void {
      const target = event.target;
      focusedHeading.current = target !== null && target === headingRef.current ? headingRef.current : null;
    }
    function onFocusOut(event: FocusEvent): void {
      const left = focusedHeading.current;
      if (left === null || event.target !== left) return;
      queueMicrotask(() => {
        if (focusedHeading.current === left && left.isConnected && document.activeElement !== left) {
          focusedHeading.current = null;
        }
      });
    }
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // After every commit: a new heading element takes the focus that the old, removed one had.
  useEffect(() => {
    const heading = headingRef.current;
    const previous = lastHeading.current;
    lastHeading.current = heading;
    if (previous === null || heading === null || previous === heading || previous.isConnected) return;
    if (focusedHeading.current !== previous) return;
    focusedHeading.current = null;
    if (document.activeElement === document.body || document.activeElement === null) heading.focus();
  });

  useEffect(() => {
    document.title = `${prefix}${documentTitleFor(title, appTitle)}`;
  }, [title, appTitle, prefix]);

  useEffect(() => {
    if (lastPathname.current === pathname) return;
    const firstOfDocument = lastPathname.current === null && key === INITIAL_LOCATION_KEY;
    lastPathname.current = pathname;
    if (firstOfDocument) return;
    const main = document.getElementById('main');
    if (main !== null && typeof main.scrollTo === 'function') main.scrollTo({ top: 0 });
    headingRef.current?.focus();
  }, [pathname, key]);

  return headingRef;
}
