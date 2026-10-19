import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrefs, PREFS_KEY, type StorageLike } from '../lib/prefs.ts';
import { createPrefsStore, PrefsStoreContext, type PrefsStore } from '../state/prefs-store.ts';
import { useI18n } from './context.ts';
import { I18nProvider } from './I18nProvider.tsx';
import { enMessages } from './messages/en.ts';
import { viMessages } from './messages/vi.ts';
import { createCatalogues, type Catalogues } from './translate.ts';
import type { Messages } from './types.ts';

function Probe() {
  const { t, locale, preference, setLocale } = useI18n();
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <output data-testid="preference">{preference}</output>
      <p>{t('common.close')}</p>
      <button
        type="button"
        data-testid="to-vi"
        onClick={() => {
          setLocale('vi');
        }}
      />
      <button
        type="button"
        data-testid="to-en"
        onClick={() => {
          setLocale('en');
        }}
      />
      <button
        type="button"
        data-testid="to-auto"
        onClick={() => {
          setLocale('auto');
        }}
      />
    </div>
  );
}

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function store(locale?: 'auto' | 'en' | 'vi', storage: StorageLike | null = null): PrefsStore {
  const prefsStore = createPrefsStore(createPrefs(storage));
  if (locale !== undefined) prefsStore.setPref('locale', locale);
  return prefsStore;
}

function mount(prefsStore: PrefsStore, catalogues: Catalogues) {
  return render(
    <PrefsStoreContext value={prefsStore}>
      <I18nProvider catalogues={catalogues}>
        <Probe />
      </I18nProvider>
    </PrefsStoreContext>,
  );
}

const EN = enMessages['common.close'];
const VI = viMessages['common.close'];

describe('I18nProvider', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.lang = '';
  });

  it('shows English and never loads Vietnamese when the choice is English', async () => {
    const loader = vi.fn(() => Promise.resolve(viMessages));
    mount(store('en'), createCatalogues({ initial: { en: enMessages }, loaders: { vi: loader } }));
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(document.documentElement.lang).toBe('en');
    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('follows the browser languages for auto', async () => {
    vi.stubGlobal('navigator', { languages: ['vi-VN', 'en'], language: 'vi-VN' });
    const gate = deferred<Messages>();
    mount(store(), createCatalogues({ initial: { en: enMessages }, loaders: { vi: () => gate.promise } }));
    await act(async () => {
      gate.resolve(viMessages);
      await gate.promise;
    });
    expect(screen.getByText(VI)).toBeInTheDocument();
    expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    expect(screen.getByTestId('locale')).toHaveTextContent('vi');
    expect(document.documentElement.lang).toBe('vi');
  });

  it('draws nothing at first when the stored language is not loaded, then draws Vietnamese straight away', async () => {
    const gate = deferred<Messages>();
    mount(store('vi'), createCatalogues({ initial: { en: enMessages }, loaders: { vi: () => gate.promise } }));
    expect(screen.queryByText(EN)).toBeNull();
    expect(screen.queryByTestId('locale')).toBeNull();
    await act(async () => {
      gate.resolve(viMessages);
      await gate.promise;
    });
    expect(screen.queryByText(EN)).toBeNull();
    expect(screen.getByText(VI)).toBeInTheDocument();
  });

  it('keeps showing English while a switched language loads, then switches text and lang together', async () => {
    const gate = deferred<Messages>();
    const loader = vi.fn(() => gate.promise);
    mount(store('en'), createCatalogues({ initial: { en: enMessages }, loaders: { vi: loader } }));
    expect(loader).not.toHaveBeenCalled();
    act(() => {
      screen.getByTestId('to-vi').click();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByTestId('preference')).toHaveTextContent('vi');
    await act(async () => {
      gate.resolve(viMessages);
      await gate.promise;
    });
    expect(screen.getByText(VI)).toBeInTheDocument();
    expect(screen.queryByText(EN)).toBeNull();
    expect(document.documentElement.lang).toBe('vi');
    act(() => {
      screen.getByTestId('to-en').click();
    });
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('stores the choice through the prefs store and reads it again', () => {
    const storage = new MemoryStorage();
    const prefsStore = store(undefined, storage);
    const catalogues = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
    const first = mount(prefsStore, catalogues);
    expect(prefsStore.getSnapshot().locale).toBeUndefined();
    act(() => {
      screen.getByTestId('to-vi').click();
    });
    expect(prefsStore.getSnapshot().locale).toBe('vi');
    expect(JSON.parse(storage.items.get(PREFS_KEY) ?? '{}')).toEqual({ locale: 'vi' });
    first.unmount();
    mount(store(undefined, storage), catalogues);
    expect(screen.getByText(VI)).toBeInTheDocument();
  });

  it('keeps English when the Vietnamese catalogue fails to load, on the first render and on a switch', async () => {
    const failing = createCatalogues({
      initial: { en: enMessages },
      loaders: { vi: () => Promise.reject(new Error('x')) },
    });
    mount(store('vi'), failing);
    expect(screen.queryByText(EN)).toBeNull();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('preference')).toHaveTextContent('vi');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps English when a switch cannot load the catalogue and recovers when it can', async () => {
    let attempt = 0;
    const loader = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(viMessages);
    });
    mount(store('en'), createCatalogues({ initial: { en: enMessages }, loaders: { vi: loader } }));
    await act(async () => {
      screen.getByTestId('to-vi').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    await act(async () => {
      screen.getByTestId('to-en').click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByTestId('to-vi').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(VI)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('vi');
  });

  it('puts the previous lang back when it unmounts', () => {
    document.documentElement.lang = 'fr';
    const view = mount(store('en'), createCatalogues({ initial: { en: enMessages, vi: viMessages } }));
    expect(document.documentElement.lang).toBe('en');
    view.unmount();
    expect(document.documentElement.lang).toBe('fr');
  });

  it('gives the formatters of the language that is shown', () => {
    function Numbers() {
      const { format } = useI18n();
      return <output data-testid="n">{format.number(1234.5)}</output>;
    }
    const catalogues = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
    render(
      <PrefsStoreContext value={store('vi')}>
        <I18nProvider catalogues={catalogues}>
          <Numbers />
        </I18nProvider>
      </PrefsStoreContext>,
    );
    expect(screen.getByTestId('n')).toHaveTextContent(new Intl.NumberFormat('vi').format(1234.5));
  });
});
