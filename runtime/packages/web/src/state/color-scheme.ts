// Which colour scheme is in force (ADR 0100, design 05 section 3.4). CSS needs none of this: `color-scheme` follows the operating
// system live and `light-dark()` follows `color-scheme`. Only JavaScript consumers that paint with colours of their own (the terminal)
// have to know, so that they can re-apply their theme when the user switches or the system changes under `auto`.
import { useMemo, useSyncExternalStore } from 'react';

import { cssColorResolver, terminalThemeFrom, type ColorResolver, type TerminalTheme } from '../lib/term-theme.ts';
import { useMediaQuery } from './use-media-query.ts';

export type ColorScheme = 'light' | 'dark';

/** The media query of the operating-system preference. */
export const MQ_SYSTEM_DARK = '(prefers-color-scheme: dark)';

/**
 * The scheme for the `data-theme` attribute of the root element and the system preference: an explicit `light` or `dark` wins,
 * anything else (`auto`, no attribute, a value this code does not know) follows the system, as the CSS does.
 */
export function resolveScheme(themeAttribute: string | null | undefined, systemDark: boolean): ColorScheme {
  if (themeAttribute === 'light' || themeAttribute === 'dark') return themeAttribute;
  return systemDark ? 'dark' : 'light';
}

function noop(): void {
  // nothing to unsubscribe from
}

/** Calls `notify` whenever the `data-theme` attribute of the root element changes; a bare environment gets a no-op. */
function subscribeThemeAttribute(notify: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return noop;
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
  };
}

function readThemeAttribute(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

function serverThemeAttribute(): string | null {
  return null;
}

/** The scheme in force now and after every change of the theme choice or of the system preference. */
export function useColorScheme(): ColorScheme {
  const themeAttribute = useSyncExternalStore(subscribeThemeAttribute, readThemeAttribute, serverThemeAttribute);
  const systemDark = useMediaQuery(MQ_SYSTEM_DARK);
  return resolveScheme(themeAttribute, systemDark);
}

/**
 * The terminal theme of the scheme in force, read from the tokens through the probe resolver (`lib/term-theme.ts`), whose probe
 * states that scheme. It is a new object when the scheme changes (a user's switch, or the system under `auto`) and the same object
 * otherwise, so a terminal that applies it in an effect updates exactly then. A test passes its own resolver.
 */
export function useTerminalTheme(resolver?: ColorResolver): TerminalTheme {
  const scheme = useColorScheme();
  return useMemo(() => terminalThemeFrom(resolver ?? cssColorResolver(undefined, scheme)), [scheme, resolver]);
}
