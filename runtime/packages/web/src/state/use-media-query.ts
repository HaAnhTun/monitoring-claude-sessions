import { useCallback, useSyncExternalStore } from 'react';

// The breakpoints of ADR 0071 decision 6, as the literal media queries the stylesheets use.
/** The sidebar is a rail (56 px). */
export const MQ_RAIL = '(max-width: 1199px)';
/** The rail becomes a menu sheet and tables become card lists. */
export const MQ_SHEET = '(max-width: 899px)';
/** Secondary table columns hide. */
export const MQ_NARROW_TABLE = '(max-width: 1279px)';
/** The project list of the Workspace is an overlay that a button opens, not a column (design 04 2.4). */
export const MQ_LIST_OVERLAY = '(max-width: 1023px)';

type MatchMedia = (query: string) => MediaQueryList;

/** `matchMedia` of this environment; the property is missing on a server and in some test environments. */
function matchMediaOf(): MatchMedia | undefined {
  if (!('matchMedia' in globalThis)) return undefined;
  const found: unknown = globalThis.matchMedia;
  return typeof found === 'function' ? globalThis.matchMedia.bind(globalThis) : undefined;
}

function noop(): void {
  // nothing to unsubscribe from
}

/** Whether the media query matches now and after every change; false where `matchMedia` does not exist (server render, tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const matchMedia = matchMediaOf();
      if (matchMedia === undefined) return noop;
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => {
        list.removeEventListener('change', notify);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => matchMediaOf()?.(query).matches ?? false, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
