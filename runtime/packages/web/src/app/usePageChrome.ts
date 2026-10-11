import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router';

export const APP_TITLE = 'Claude session monitor';

/** Initial history entry key of react-router: set before any navigation happened in this document. */
const INITIAL_LOCATION_KEY = 'default';

export function documentTitleFor(title: string): string {
  return title === '' ? APP_TITLE : `${title} - ${APP_TITLE}`;
}

/**
 * Page chrome of every route (04-ui.md 3.1 rule 5): sets `document.title`, and on a pathname change scrolls `#main`
 * to the top and moves focus to the page heading. Search-only changes do nothing, and neither does the first load.
 * Attach the returned ref to the page `<h1 tabIndex={-1}>`.
 */
export function usePageChrome(title: string): RefObject<HTMLHeadingElement | null> {
  const { pathname, key } = useLocation();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const lastPathname = useRef<string | null>(null);

  useEffect(() => {
    document.title = documentTitleFor(title);
  }, [title]);

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
