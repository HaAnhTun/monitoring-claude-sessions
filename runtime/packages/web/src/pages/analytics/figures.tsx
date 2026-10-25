import { useCallback } from 'react';

import { useFormat, useT } from '../../i18n/context.ts';
import { numberFormat } from '../../i18n/format.ts';

/** A figure the monitor may not have: "not available" with a title and a screen-reader text, never a 0 (UI-I9). */
export function NumberCell({ value, compact = false }: { value: number | null; compact?: boolean }) {
  const t = useT();
  const format = useFormat();
  if (value === null) {
    return (
      <span className="muted" title={t('tokens.notAvailable')}>
        <span aria-hidden="true">{t('tokens.na')}</span>
        <span className="sr-only">{t('tokens.notAvailable')}</span>
      </span>
    );
  }
  const exact = format.number(value);
  return compact ? <span title={exact}>{format.compact(value)}</span> : <span>{exact}</span>;
}

/** An amount of money in the language shown; a currency code the browser does not know is written after the number. */
export function useMoney(): (amount: number, currency: string) => string {
  const format = useFormat();
  const { locale } = format;
  return useCallback(
    (amount, currency) => {
      try {
        return numberFormat(locale, {
          style: 'currency',
          currency,
          maximumFractionDigits: amount < 100 ? 2 : 0,
        }).format(amount);
      } catch {
        return `${format.number(amount, { maximumFractionDigits: 2 })} ${currency}`;
      }
    },
    [locale, format],
  );
}

/** A duration in milliseconds: "120 ms" below a second, "1.4 s" below a minute, then the shared duration format. */
export function useMillis(): (ms: number) => string {
  const format = useFormat();
  const { locale } = format;
  return useCallback(
    (ms) => {
      if (ms < 1000) {
        return numberFormat(locale, {
          style: 'unit',
          unit: 'millisecond',
          unitDisplay: 'narrow',
          maximumFractionDigits: 0,
        }).format(ms);
      }
      if (ms < 60_000) {
        return numberFormat(locale, {
          style: 'unit',
          unit: 'second',
          unitDisplay: 'narrow',
          maximumFractionDigits: 1,
        }).format(ms / 1000);
      }
      return format.duration(ms / 1000);
    },
    [locale, format],
  );
}
