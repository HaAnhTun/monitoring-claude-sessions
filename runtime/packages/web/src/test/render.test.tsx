import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useI18n } from '../i18n/context.ts';
import { createPrefs } from '../lib/prefs.ts';
import { createPrefsStore } from '../state/prefs-store.ts';
import { msg } from './msg.ts';
import { renderHookWithProviders, renderWithIntl, renderWithProviders } from './render.tsx';

function Words() {
  const { t, setLocale } = useI18n();
  return (
    <div>
      <p>{t('common.close')}</p>
      <button
        type="button"
        data-testid="vi"
        onClick={() => {
          setLocale('vi');
        }}
      />
    </div>
  );
}

describe('renderWithProviders', () => {
  it('wraps the English provider', () => {
    renderWithProviders(<Words />);
    expect(screen.getByText(msg('common.close'))).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('returns the prefs store it gave the tree', () => {
    const { prefsStore } = renderWithProviders(<Words />);
    expect(prefsStore.getSnapshot().locale).toBe('en');
  });
});

describe('renderWithIntl', () => {
  it('renders in English by default', () => {
    renderWithIntl(<Words />);
    expect(screen.getByText(msg('common.close'))).toBeInTheDocument();
  });

  it('renders in Vietnamese at once, without waiting for a lazy chunk', () => {
    renderWithIntl(<Words />, { locale: 'vi' });
    expect(screen.getByText(msg('common.close', undefined, 'vi'))).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('vi');
  });

  it('switches language when the tree asks for it, through the store of the render', () => {
    const { prefsStore } = renderWithIntl(<Words />);
    act(() => {
      screen.getByTestId('vi').click();
    });
    expect(prefsStore.getSnapshot().locale).toBe('vi');
    expect(screen.getByText(msg('common.close', undefined, 'vi'))).toBeInTheDocument();
  });

  it('uses the store it is given, with its stored language', () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('locale', 'vi');
    renderWithIntl(<Words />, { prefsStore });
    expect(screen.getByText(msg('common.close', undefined, 'vi'))).toBeInTheDocument();
  });

  it('lets an explicit locale win over the stored one of a given store', () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('locale', 'vi');
    renderWithIntl(<Words />, { prefsStore, locale: 'en' });
    expect(screen.getByText(msg('common.close'))).toBeInTheDocument();
  });
});

describe('renderHookWithProviders', () => {
  it('gives a hook the language of the render', () => {
    const { result } = renderHookWithProviders(() => useI18n().t('common.retry'), { locale: 'vi' });
    expect(result.current).toBe(msg('common.retry', undefined, 'vi'));
  });
});
