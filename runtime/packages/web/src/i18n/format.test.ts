// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createFormatters, timeToMs } from './format.ts';
import type { Locale } from './types.ts';

const LOCALES: readonly Locale[] = ['en', 'vi'];

// Every expectation is built with `Intl` from the locale argument of the case, so the suite passes under any default locale and
// proves that the formatter uses the locale it was given, not a fixed one.
const unit = (locale: Locale, name: 'second' | 'minute' | 'hour' | 'day', value: number): string =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0 }).format(
    value,
  );

describe.each(LOCALES)('formatters for %s', (locale) => {
  const f = createFormatters(locale);

  describe('number', () => {
    it('groups and separates like the locale', () => {
      expect(f.number(1234567.891)).toBe(new Intl.NumberFormat(locale).format(1234567.891));
      expect(f.number(0)).toBe(new Intl.NumberFormat(locale).format(0));
      expect(f.number(-42.5)).toBe(new Intl.NumberFormat(locale).format(-42.5));
    });

    it('honours the fraction digits and keeps them in a sane range', () => {
      expect(f.number(1.23456, { maximumFractionDigits: 1 })).toBe(
        new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(1.23456),
      );
      expect(f.number(2, { minimumFractionDigits: 2 })).toBe(
        new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(2),
      );
      expect(() => f.number(1, { maximumFractionDigits: 500 })).not.toThrow();
      expect(() => f.number(1, { minimumFractionDigits: -5, maximumFractionDigits: 1 })).not.toThrow();
      expect(() => f.number(1, { minimumFractionDigits: 4, maximumFractionDigits: 1 })).not.toThrow();
    });

    it('formats a huge number without throwing', () => {
      expect(f.number(1e21)).toBe(new Intl.NumberFormat(locale).format(1e21));
      expect(f.number(Number.MAX_VALUE).length).toBeGreaterThan(300);
    });

    it('gives an empty string for a value that is not a finite number', () => {
      for (const value of [null, undefined, Number.NaN, Infinity, -Infinity]) {
        expect(f.number(value)).toBe('');
        expect(f.compact(value)).toBe('');
        expect(f.percent(value)).toBe('');
        expect(f.bytes(value)).toBe('');
        expect(f.duration(value)).toBe('');
        expect(f.age(value)).toBe('');
      }
    });
  });

  describe('compact', () => {
    it('uses the compact notation of the locale', () => {
      const compact = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'short' });
      for (const value of [0, 999, 1234, 12345, 123456, 1234567, 2.5e9, -4200]) {
        expect(f.compact(value)).toBe(compact.format(value));
      }
    });
  });

  describe('percent', () => {
    it('takes a fraction and prints it as a percentage', () => {
      expect(f.percent(0.42)).toBe(new Intl.NumberFormat(locale, { style: 'percent' }).format(0.42));
      expect(f.percent(0.4237, 1)).toBe(
        new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
          0.4237,
        ),
      );
      expect(f.percent(1.5)).toBe(new Intl.NumberFormat(locale, { style: 'percent' }).format(1.5));
      expect(() => f.percent(0.5, 99)).not.toThrow();
    });
  });

  describe('bytes', () => {
    const num = (value: number, digits: number): string =>
      new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);

    it('counts in 1024-based units with one fraction digit below ten', () => {
      expect(f.bytes(0)).toBe('0 B');
      expect(f.bytes(1023)).toBe(`${num(1023, 0)} B`);
      expect(f.bytes(1536)).toBe(`${num(1.5, 1)} KB`);
      expect(f.bytes(10 * 1024)).toBe(`${num(10, 0)} KB`);
      expect(f.bytes(5 * 1024 * 1024)).toBe(`${num(5, 1)} MB`);
      expect(f.bytes(3 * 1024 ** 3)).toBe(`${num(3, 1)} GB`);
    });

    it('stops at terabytes and refuses a negative size', () => {
      expect(f.bytes(1024 ** 5)).toBe(`${num(1024, 0)} TB`);
      expect(f.bytes(-1)).toBe('');
    });
  });

  describe('duration', () => {
    it('composes unit parts: seconds, minutes and seconds, hours and minutes, days and hours', () => {
      expect(f.duration(8)).toBe(unit(locale, 'second', 8));
      expect(f.duration(0)).toBe(unit(locale, 'second', 0));
      expect(f.duration(125)).toBe(`${unit(locale, 'minute', 2)} ${unit(locale, 'second', 5)}`);
      expect(f.duration(120)).toBe(unit(locale, 'minute', 2));
      expect(f.duration(4020)).toBe(`${unit(locale, 'hour', 1)} ${unit(locale, 'minute', 7)}`);
      expect(f.duration(7200)).toBe(unit(locale, 'hour', 2));
      expect(f.duration(2 * 86400 + 3 * 3600 + 59)).toBe(`${unit(locale, 'day', 2)} ${unit(locale, 'hour', 3)}`);
    });

    it('rounds to whole seconds and treats a negative span as zero', () => {
      expect(f.duration(7.6)).toBe(unit(locale, 'second', 8));
      expect(f.duration(-30)).toBe(unit(locale, 'second', 0));
    });
  });

  describe('age', () => {
    it('changes unit at 90 seconds, 90 minutes and 36 hours', () => {
      expect(f.age(45)).toBe(unit(locale, 'second', 45));
      expect(f.age(89)).toBe(unit(locale, 'second', 89));
      expect(f.age(90)).toBe(unit(locale, 'minute', 2));
      expect(f.age(720)).toBe(unit(locale, 'minute', 12));
      expect(f.age(5399)).toBe(unit(locale, 'minute', 90));
      expect(f.age(5400)).toBe(unit(locale, 'hour', 2));
      expect(f.age(10800)).toBe(unit(locale, 'hour', 3));
      expect(f.age(129599)).toBe(unit(locale, 'hour', 36));
      expect(f.age(129600)).toBe(unit(locale, 'day', 2));
      expect(f.age(-5)).toBe(unit(locale, 'second', 0));
    });
  });

  describe('clock and dateTime', () => {
    const local = new Date(2026, 9, 18, 15, 4, 5);
    const midnight = new Date(2026, 9, 18, 0, 9, 32);
    const clock = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    it('prints the 24-hour wall-clock time of the browser time zone', () => {
      expect(f.clock(local)).toBe(clock.format(local));
      expect(f.clock(local)).toMatch(/^15:04:05$/);
      expect(f.clock(midnight)).toMatch(/^00:09:32$/);
    });

    it('accepts an ISO string, epoch milliseconds and a Date alike', () => {
      const iso = new Date(Date.UTC(2026, 9, 18, 8, 9, 32)).toISOString();
      const ms = Date.parse(iso);
      expect(f.clock(iso)).toBe(clock.format(ms));
      expect(f.clock(ms)).toBe(f.clock(iso));
      expect(f.clock(new Date(ms))).toBe(f.clock(iso));
    });

    it('can leave out the seconds', () => {
      const short = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      expect(f.clock(local, { seconds: false })).toBe(short.format(local));
      expect(f.clock(local, { seconds: false })).toMatch(/^15:04$/);
    });

    it('writes the date before the time in dateTime', () => {
      const full = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      expect(f.dateTime(local)).toBe(full.format(local));
      expect(f.dateTime(local)).toContain('2026');
    });

    it('gives an empty string for a missing, empty, unparsable or out-of-range time', () => {
      for (const time of [null, undefined, '', 'not a time', Number.NaN, Infinity, 9e15, new Date(Number.NaN)]) {
        expect(f.clock(time)).toBe('');
        expect(f.dateTime(time)).toBe('');
        expect(f.relative(time, 0)).toBe('');
      }
    });
  });

  describe('relative', () => {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const at = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();

    it('says now within five seconds either way', () => {
      expect(f.relative(at(0), now)).toBe(rtf.format(0, 'second'));
      expect(f.relative(at(4), now)).toBe(rtf.format(0, 'second'));
      expect(f.relative(at(-4), now)).toBe(rtf.format(0, 'second'));
    });

    it('counts back in seconds, minutes, hours and days', () => {
      expect(f.relative(at(45), now)).toBe(rtf.format(-45, 'second'));
      expect(f.relative(at(180), now)).toBe(rtf.format(-3, 'minute'));
      expect(f.relative(at(7200), now)).toBe(rtf.format(-2, 'hour'));
      expect(f.relative(at(3 * 86400), now)).toBe(rtf.format(-3, 'day'));
    });

    it('counts forward for a time in the future', () => {
      expect(f.relative(at(-180), now)).toBe(rtf.format(3, 'minute'));
    });

    it('uses the current time when none is given', () => {
      expect(f.relative(new Date(Date.now() - 3 * 3600 * 1000))).toBe(rtf.format(-3, 'hour'));
    });

    it('refuses an unusable clock', () => {
      expect(f.relative(at(60), Number.NaN)).toBe('');
    });
  });
});

describe('createFormatters', () => {
  it('returns the same object for the same locale and tells its locale', () => {
    expect(createFormatters('en')).toBe(createFormatters('en'));
    expect(createFormatters('vi').locale).toBe('vi');
    expect(createFormatters('en')).not.toBe(createFormatters('vi'));
  });

  it('writes the two languages differently', () => {
    expect(createFormatters('en').compact(12345)).not.toBe(createFormatters('vi').compact(12345));
    expect(createFormatters('en').number(1234.5)).not.toBe(createFormatters('vi').number(1234.5));
  });
});

describe('timeToMs', () => {
  it('reads strings, numbers and dates and rejects the rest', () => {
    expect(timeToMs('2026-10-18T08:09:32.000Z')).toBe(Date.UTC(2026, 9, 18, 8, 9, 32));
    expect(timeToMs(1000)).toBe(1000);
    expect(timeToMs(new Date(5))).toBe(5);
    expect(Number.isNaN(timeToMs(null))).toBe(true);
    expect(Number.isNaN(timeToMs('x'))).toBe(true);
    expect(Number.isNaN(timeToMs(8.64e15 + 1))).toBe(true);
  });
});
