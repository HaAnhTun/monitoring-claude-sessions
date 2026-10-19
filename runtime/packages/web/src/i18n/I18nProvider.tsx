import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { usePrefs } from '../state/prefs-store.ts';
import { I18nContext, type I18n } from './context.ts';
import { createFormatters } from './format.ts';
import { browserLanguages, resolveLocale } from './locale.ts';
import { catalogues as pageCatalogues, createT, type Catalogues } from './translate.ts';
import type { Locale, LocalePreference } from './types.ts';

export interface ActiveLocale {
  /** The language to show: the target once its catalogue is loaded, English before that and when the load failed. */
  readonly locale: Locale;
  /** True once the target catalogue is loaded or its load failed, so the first paint knows which text to use. */
  readonly settled: boolean;
}

/**
 * Starts loading the catalogue of `target` and tells which language can be shown. English is always available; Vietnamese is
 * fetched the first time it is wanted, and a failed fetch leaves the page in English.
 */
export function useActiveLocale(source: Catalogues, target: Locale): ActiveLocale {
  const loaded = useSyncExternalStore(
    source.subscribe,
    () => source.isLoaded(target),
    () => source.isLoaded(target),
  );
  const [failedFor, setFailedFor] = useState<Locale | null>(null);
  useEffect(() => {
    if (source.isLoaded(target)) return undefined;
    let current = true;
    void source.load(target).then((ok) => {
      if (current) setFailedFor(ok ? null : target);
    });
    return () => {
      current = false;
    };
  }, [source, target]);
  return { locale: loaded ? target : 'en', settled: loaded || failedFor === target };
}

export interface I18nProviderProps {
  children: ReactNode;
  /** Defaults to the catalogues of the page; tests and embedders pass their own. */
  catalogues?: Catalogues;
}

/**
 * Holds the language of the UI. The choice comes from the preferences (`locale`, default `auto`); the provider loads the catalogue
 * of that language, sets `<html lang>`, and hands out `t` and the formatters of the language that is shown. On the first render
 * it waits for a catalogue that is not English, so a Vietnamese page never flashes English; after that a switch keeps showing the
 * old language until the new catalogue has arrived.
 */
export function I18nProvider({ children, catalogues = pageCatalogues }: I18nProviderProps) {
  const { prefs, setPref } = usePrefs();
  const preference = prefs.locale ?? 'auto';
  const [languages] = useState(browserLanguages);
  const target = resolveLocale(preference, languages);
  const { locale, settled } = useActiveLocale(catalogues, target);
  const [revealed, setRevealed] = useState(false);
  if (settled && !revealed) setRevealed(true);

  const setLocale = useCallback(
    (next: LocalePreference) => {
      setPref('locale', next);
    },
    [setPref],
  );
  const value = useMemo<I18n>(
    () => ({
      locale,
      preference,
      setLocale,
      t: createT(locale, catalogues),
      format: createFormatters(locale),
    }),
    [locale, preference, setLocale, catalogues],
  );

  useLayoutEffect(() => {
    const root = document.documentElement;
    const before = root.lang;
    root.lang = locale;
    return () => {
      root.lang = before;
    };
  }, [locale]);

  return <I18nContext value={value}>{settled || revealed ? children : null}</I18nContext>;
}
