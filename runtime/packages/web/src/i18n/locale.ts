// Which language the UI shows (ADR 0072 decision 3): the stored choice, or for `auto` the first language of the browser whose
// primary subtag is supported. `public/theme-init.js` repeats `detectLocale` in plain JavaScript to set `<html lang>` before the
// first paint; the locale test runs that script against this function.
import { LOCALES, type Locale, type LocalePreference } from './types.ts';

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'auto' || isLocale(value);
}

/** The primary language subtag of a tag such as `vi-VN`, `VI_vn` or `vi-Latn-VN`: lower case, '' when there is none. */
function primarySubtag(tag: unknown): string {
  if (typeof tag !== 'string') return '';
  return (tag.trim().toLowerCase().split(/[-_]/)[0] ?? '').trim();
}

/** The first supported language of a browser language list; English when none is. */
export function detectLocale(languages: readonly unknown[] | null | undefined): Locale {
  for (const tag of languages ?? []) {
    const primary = primarySubtag(tag);
    const found = LOCALES.find((locale) => locale === primary);
    if (found !== undefined) return found;
  }
  return 'en';
}

/** The language to show for a stored preference. */
export function resolveLocale(preference: LocalePreference, languages: readonly unknown[] | null | undefined): Locale {
  return preference === 'auto' ? detectLocale(languages) : preference;
}

/** `navigator.languages` (or `navigator.language`), or an empty list when the browser says nothing or the access throws. */
export function browserLanguages(): readonly string[] {
  try {
    const nav: unknown = Reflect.get(globalThis, 'navigator');
    if (typeof nav !== 'object' || nav === null) return [];
    const list: unknown = Reflect.get(nav, 'languages');
    if (Array.isArray(list) && list.length > 0) return list.filter((tag): tag is string => typeof tag === 'string');
    const single: unknown = Reflect.get(nav, 'language');
    return typeof single === 'string' && single !== '' ? [single] : [];
  } catch {
    return [];
  }
}
