// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { enMessages } from './messages/en.ts';
import { viMessages } from './messages/vi.ts';
import {
  catalogues,
  createCatalogues,
  createT,
  hasMessageKey,
  loadCatalogue,
  translate,
  translateKey,
} from './translate.ts';
import type { Messages } from './types.ts';

const EN: Messages = {
  'x.plain': 'Plain',
  'x.hello': 'Hello {name}',
  'x.errors': '{count, plural, =0 {No errors} one {# error} other {# errors}}',
  'x.onlyEnglish': 'English only',
};
const VI: Messages = {
  'x.plain': 'Plain VI',
  'x.hello': 'Hello VI {name}',
  'x.errors': '{count, plural, other {# errors VI}}',
};

function sample() {
  return createCatalogues({ initial: { en: EN, vi: VI } });
}

describe('translate (the real catalogues)', () => {
  it('returns the English text of a key', () => {
    expect(translate('en', 'common.close')).toBe(enMessages['common.close']);
    expect(translate('en', 'lang.vi')).toBe(enMessages['lang.vi']);
  });

  it('falls back to English while the Vietnamese catalogue is not loaded', () => {
    expect(catalogues.isLoaded('vi')).toBe(false);
    expect(translate('vi', 'common.close')).toBe(enMessages['common.close']);
  });

  it('returns the Vietnamese text once the catalogue is loaded', async () => {
    await expect(loadCatalogue('vi')).resolves.toBe(true);
    expect(catalogues.isLoaded('vi')).toBe(true);
    expect(translate('vi', 'common.close')).toBe(viMessages['common.close']);
    expect(translate('vi', 'lang.vi')).toBe(viMessages['lang.vi']);
    expect(translate('en', 'common.close')).toBe(enMessages['common.close']);
  });

  it('createT binds a locale to the translate function', async () => {
    await loadCatalogue('vi');
    expect(createT('en')('common.retry')).toBe(enMessages['common.retry']);
    expect(createT('vi')('common.retry')).toBe(viMessages['common.retry']);
  });

  it('knows its keys', () => {
    expect(hasMessageKey('common.close')).toBe(true);
    expect(hasMessageKey('common.nope')).toBe(false);
    expect(hasMessageKey('constructor')).toBe(false);
    expect(hasMessageKey('__proto__')).toBe(false);
  });
});

describe('translateKey', () => {
  it('formats arguments and plurals for the locale', () => {
    const c = sample();
    expect(translateKey(c, 'en', 'x.hello', { name: 'Ada' })).toBe('Hello Ada');
    expect(translateKey(c, 'vi', 'x.hello', { name: 'Ada' })).toBe('Hello VI Ada');
    expect(translateKey(c, 'en', 'x.errors', { count: 0 })).toBe('No errors');
    expect(translateKey(c, 'en', 'x.errors', { count: 1 })).toBe('1 error');
    expect(translateKey(c, 'en', 'x.errors', { count: 2000 })).toBe(
      `${new Intl.NumberFormat('en').format(2000)} errors`,
    );
    expect(translateKey(c, 'vi', 'x.errors', { count: 2000 })).toBe(
      `${new Intl.NumberFormat('vi').format(2000)} errors VI`,
    );
  });

  it('uses English for a key the other catalogue lacks', () => {
    expect(translateKey(sample(), 'vi', 'x.onlyEnglish', undefined)).toBe('English only');
  });

  it('uses English while the catalogue of the locale is not loaded', () => {
    const c = createCatalogues({ initial: { en: EN } });
    expect(translateKey(c, 'vi', 'x.plain', undefined)).toBe('Plain');
  });

  it('fails on a missing argument and an unknown key when strict, and degrades otherwise', () => {
    const c = sample();
    expect(() => translateKey(c, 'en', 'x.hello', {})).toThrow(/name/);
    expect(() => translateKey(c, 'en', 'x.missing', undefined)).toThrow(/x\.missing/);
    expect(translateKey(c, 'en', 'x.hello', {}, { strict: false })).toBe('Hello ');
    expect(translateKey(c, 'en', 'x.missing', undefined, { strict: false })).toBe('x.missing');
  });

  it('returns the raw text of a malformed message when not strict', () => {
    const c = createCatalogues({ initial: { en: { 'x.bad': 'Oops {count, plural,' } } });
    expect(() => translateKey(c, 'en', 'x.bad', { count: 1 })).toThrow();
    expect(translateKey(c, 'en', 'x.bad', { count: 1 }, { strict: false })).toBe('Oops {count, plural,');
  });

  it('does not read keys from the prototype', () => {
    expect(() => translateKey(sample(), 'en', 'constructor', undefined)).toThrow();
    expect(translateKey(sample(), 'en', 'toString', undefined, { strict: false })).toBe('toString');
  });

  it('ignores arguments that are not an object', () => {
    expect(translateKey(sample(), 'en', 'x.plain', 'oops')).toBe('Plain');
    expect(translateKey(sample(), 'en', 'x.plain', null)).toBe('Plain');
  });
});

describe('createCatalogues', () => {
  it('has the initial catalogues loaded and English always', () => {
    const c = createCatalogues({ initial: { en: EN } });
    expect(c.isLoaded('en')).toBe(true);
    expect(c.isLoaded('vi')).toBe(false);
    expect(c.messages('vi')).toBeUndefined();
    expect(c.messages('en')).toBe(EN);
  });

  it('loads a catalogue once for concurrent calls and tells the subscribers', async () => {
    const loader = vi.fn(() => Promise.resolve(VI));
    const c = createCatalogues({ initial: { en: EN }, loaders: { vi: loader } });
    const listener = vi.fn();
    const unsubscribe = c.subscribe(listener);
    const results = await Promise.all([c.load('vi'), c.load('vi')]);
    expect(results).toEqual([true, true]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.isLoaded('vi')).toBe(true);
    await expect(c.load('vi')).resolves.toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps English and reports false when the load fails, and tries again on the next call', async () => {
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('chunk failed')) : Promise.resolve(VI);
    });
    const c = createCatalogues({ initial: { en: EN }, loaders: { vi: loader } });
    const listener = vi.fn();
    c.subscribe(listener);
    await expect(c.load('vi')).resolves.toBe(false);
    expect(c.isLoaded('vi')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(translateKey(c, 'vi', 'x.plain', undefined)).toBe('Plain');
    await expect(c.load('vi')).resolves.toBe(true);
    expect(translateKey(c, 'vi', 'x.plain', undefined)).toBe('Plain VI');
  });

  it('reports false for a locale without a loader and when a loader throws at once', async () => {
    const c = createCatalogues({ initial: { en: EN } });
    await expect(c.load('vi')).resolves.toBe(false);
    const throwing = createCatalogues({
      initial: { en: EN },
      loaders: {
        vi: () => {
          throw new Error('sync failure');
        },
      },
    });
    await expect(throwing.load('vi')).resolves.toBe(false);
  });

  it('stops notifying an unsubscribed listener', async () => {
    const c = createCatalogues({ initial: { en: EN }, loaders: { vi: () => Promise.resolve(VI) } });
    const listener = vi.fn();
    c.subscribe(listener)();
    await c.load('vi');
    expect(listener).not.toHaveBeenCalled();
  });
});
