import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ENGLISH, I18nContext, useFormat, useI18n, useT, type I18n } from './context.ts';
import { createFormatters } from './format.ts';
import { enMessages } from './messages/en.ts';
import { viMessages } from './messages/vi.ts';
import { createCatalogues, createT } from './translate.ts';

describe('the hooks without a provider', () => {
  it('answer in English', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.locale).toBe('en');
    expect(result.current.preference).toBe('auto');
    expect(result.current.t('common.close')).toBe(enMessages['common.close']);
    expect(result.current.format.number(1234.5)).toBe(new Intl.NumberFormat('en').format(1234.5));
  });

  it('offer useT and useFormat as the pieces of useI18n', () => {
    const t = renderHook(() => useT());
    const format = renderHook(() => useFormat());
    expect(t.result.current('common.retry')).toBe(enMessages['common.retry']);
    expect(format.result.current).toBe(createFormatters('en'));
  });

  it('have a setLocale that does nothing and does not throw', () => {
    const { result } = renderHook(() => useI18n());
    expect(() => {
      result.current.setLocale('vi');
    }).not.toThrow();
    expect(result.current.locale).toBe('en');
  });

  it('return the same object on every render', () => {
    const { result, rerender } = renderHook(() => useI18n());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toBe(ENGLISH);
  });
});

describe('the hooks with a context value', () => {
  const catalogues = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
  const setLocale = vi.fn();
  const value: I18n = {
    locale: 'vi',
    preference: 'auto',
    setLocale,
    t: createT('vi', catalogues),
    format: createFormatters('vi'),
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nContext, { value }, children);

  it('read the value of the nearest provider', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current).toBe(value);
    expect(result.current.t('common.close')).toBe(viMessages['common.close']);
  });

  it('give useT and useFormat the language of the value', () => {
    const t = renderHook(() => useT(), { wrapper });
    const format = renderHook(() => useFormat(), { wrapper });
    expect(t.result.current('common.retry')).toBe(viMessages['common.retry']);
    expect(format.result.current.locale).toBe('vi');
  });

  it('pass setLocale through', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    result.current.setLocale('en');
    expect(setLocale).toHaveBeenCalledWith('en');
  });
});
