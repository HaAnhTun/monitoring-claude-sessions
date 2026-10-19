// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserLanguages, detectLocale, isLocale, isLocalePreference, resolveLocale } from './locale.ts';

describe('detectLocale (the auto preference)', () => {
  it('takes the first language whose primary subtag is supported', () => {
    expect(detectLocale(['vi'])).toBe('vi');
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale(['fr-FR', 'vi', 'en'])).toBe('vi');
    expect(detectLocale(['de', 'en-GB', 'vi'])).toBe('en');
  });

  it('maps a regional Vietnamese tag to Vietnamese, in any letter case and with an underscore', () => {
    expect(detectLocale(['vi-VN'])).toBe('vi');
    expect(detectLocale(['VI-vn'])).toBe('vi');
    expect(detectLocale(['vi_VN'])).toBe('vi');
    expect(detectLocale(['vi-Latn-VN'])).toBe('vi');
  });

  it('gives English for an unknown, empty or missing list', () => {
    expect(detectLocale(['fr', 'ja-JP', 'xx'])).toBe('en');
    expect(detectLocale([])).toBe('en');
    expect(detectLocale(null)).toBe('en');
    expect(detectLocale(undefined)).toBe('en');
  });

  it('skips entries that are not language tags', () => {
    expect(detectLocale(['', '   ', 'vii', 'v', 'viet', 42, null, {}, 'vi'])).toBe('vi');
    expect(detectLocale(['vietnamese'])).toBe('en');
    expect(detectLocale(['-vi'])).toBe('en');
  });
});

describe('resolveLocale', () => {
  it('lets a chosen language win over the browser', () => {
    expect(resolveLocale('vi', ['en-US'])).toBe('vi');
    expect(resolveLocale('en', ['vi-VN'])).toBe('en');
  });

  it('follows the browser for auto', () => {
    expect(resolveLocale('auto', ['vi-VN'])).toBe('vi');
    expect(resolveLocale('auto', ['en'])).toBe('en');
    expect(resolveLocale('auto', [])).toBe('en');
  });
});

describe('guards', () => {
  it('recognises the supported locales and the preference values', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('vi')).toBe(true);
    expect(isLocale('auto')).toBe(false);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocalePreference('auto')).toBe(true);
    expect(isLocalePreference('vi')).toBe(true);
    expect(isLocalePreference('VI')).toBe(false);
    expect(isLocalePreference(null)).toBe(false);
  });
});

describe('browserLanguages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads navigator.languages', () => {
    vi.stubGlobal('navigator', { languages: ['vi-VN', 'en'], language: 'en' });
    expect(browserLanguages()).toEqual(['vi-VN', 'en']);
  });

  it('falls back to navigator.language and then to an empty list', () => {
    vi.stubGlobal('navigator', { language: 'vi' });
    expect(browserLanguages()).toEqual(['vi']);
    vi.stubGlobal('navigator', {});
    expect(browserLanguages()).toEqual([]);
    vi.stubGlobal('navigator', undefined);
    expect(browserLanguages()).toEqual([]);
  });

  it('survives a navigator whose getter throws', () => {
    vi.stubGlobal('navigator', {
      get languages(): string[] {
        throw new Error('blocked');
      },
    });
    expect(browserLanguages()).toEqual([]);
  });
});

// public/theme-init.js cannot import the module above (it is a classic script that runs before the bundle), so it carries its own
// copy of the detection. This block runs the script and checks that it agrees with detectLocale for the same inputs.
describe('theme-init.js: the language before the first paint', () => {
  const script = readFileSync(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8');

  function run(options: {
    stored?: Record<string, string>;
    languages?: unknown;
    throwing?: boolean;
  }): string | undefined {
    const attributes = new Map<string, string>();
    const sandbox: Record<string, unknown> = {
      document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
      localStorage: {
        getItem: (key: string): string | null => {
          if (options.throwing === true) throw new Error('storage blocked');
          return options.stored?.[key] ?? null;
        },
      },
    };
    if (options.languages !== undefined) sandbox['navigator'] = { languages: options.languages };
    runInNewContext(script, sandbox);
    return attributes.get('lang');
  }

  const stored = (locale: unknown): Record<string, string> => ({ 'mcs.ui.v3': JSON.stringify({ locale }) });

  it('sets lang to vi from a stored Vietnamese choice, before anything is drawn', () => {
    expect(run({ stored: stored('vi'), languages: ['en-US'] })).toBe('vi');
  });

  it('sets lang to en from a stored English choice even in a Vietnamese browser', () => {
    expect(run({ stored: stored('en'), languages: ['vi-VN'] })).toBe('en');
  });

  it('follows the browser for auto, for no choice and for an invalid choice', () => {
    expect(run({ stored: stored('auto'), languages: ['vi-VN'] })).toBe('vi');
    expect(run({ languages: ['vi'] })).toBe('vi');
    expect(run({ stored: stored('klingon'), languages: ['vi'] })).toBe('vi');
    expect(run({ stored: stored(5), languages: ['fr', 'en'] })).toBe('en');
  });

  it('agrees with detectLocale on a table of browser language lists', () => {
    const lists: unknown[] = [
      ['vi'],
      ['vi-VN'],
      ['VI-vn'],
      ['vi_VN'],
      ['fr-FR', 'vi', 'en'],
      ['de', 'en-GB', 'vi'],
      ['fr', 'ja'],
      [],
      ['', 'vi'],
      ['vietnamese'],
      [42, 'vi'],
    ];
    for (const languages of lists) {
      const expected = detectLocale(Array.isArray(languages) ? languages : []);
      const actual = run({ languages });
      expect(actual ?? 'en').toBe(expected);
    }
  });

  it('leaves the lang of index.html alone without a navigator and without a choice', () => {
    expect(run({})).toBeUndefined();
  });

  it('survives blocked storage', () => {
    expect(run({ throwing: true, languages: ['vi'] })).toBe('vi');
  });
});
