// The React side of the catalogue (ADR 0072 decision 2): one context and three hooks. Without a provider the hooks answer in
// English, so a component works in isolation and a test that has not been converted yet keeps passing.
import { createContext, useContext } from 'react';

import { createFormatters, type Formatters } from './format.ts';
import { createT } from './translate.ts';
import type { Locale, LocalePreference, TFunction } from './types.ts';

export interface I18n {
  /** The language that is shown now. It stays English until the catalogue of the chosen language is loaded. */
  readonly locale: Locale;
  /** The stored choice; `auto` follows the browser. */
  readonly preference: LocalePreference;
  /** Stores the choice in the preferences; the provider loads the catalogue and switches. */
  readonly setLocale: (preference: LocalePreference) => void;
  readonly t: TFunction;
  readonly format: Formatters;
}

/** What the hooks return outside a provider. */
export const ENGLISH: I18n = {
  locale: 'en',
  preference: 'auto',
  setLocale: () => undefined,
  t: createT('en'),
  format: createFormatters('en'),
};

export const I18nContext = createContext<I18n>(ENGLISH);

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** `t(key, args?)`: the text of a message in the language that is shown. */
export function useT(): TFunction {
  return useI18n().t;
}

/** The formatters of the language that is shown: `number, compact, percent, bytes, duration, clock, dateTime, relative, age`. */
export function useFormat(): Formatters {
  return useI18n().format;
}
