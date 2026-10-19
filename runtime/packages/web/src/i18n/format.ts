// Locale-bound formatting of numbers, sizes, durations, times and relative times (ADR 0072 decision 4). Everything here takes the
// locale as an argument and goes through `Intl`; no function reads the browser default, and no locale is written as a literal.
// A missing or unusable value (null, undefined, NaN, an unparsable timestamp) gives '' and never throws: the caller decides what
// "not known" looks like (`common.notAvailable`), so a null is never shown as zero.
import type { Locale } from './types.ts';

/** A point in time: an ISO string, epoch milliseconds or a Date. */
export type TimeInput = string | number | Date | null | undefined;

export interface Formatters {
  readonly locale: Locale;
  /** 1234.5 -> "1,234.5" (en) or "1.234,5" (vi). At most three fraction digits unless `options` say otherwise. */
  number(value: number | null | undefined, options?: NumberOptions): string;
  /** Compact notation for big figures: 12345 -> "12K" (en), "12 N" (vi). Show the exact value in a tooltip. */
  compact(value: number | null | undefined): string;
  /** A fraction as a percentage: 0.42 -> "42%". `digits` is the fixed number of fraction digits (0 to 6). */
  percent(fraction: number | null | undefined, digits?: number): string;
  /** A byte count in 1024-based units: 1536 -> "1.5 KB". */
  bytes(value: number | null | undefined): string;
  /** A span in seconds as unit parts: 8 -> "8s", 125 -> "2m 5s", 4020 -> "1h 7m" (full unit words in Vietnamese). */
  duration(seconds: number | null | undefined): string;
  /** The wall-clock time on the 24-hour clock in the time zone of the browser: "08:09:32". */
  clock(time: TimeInput, options?: ClockOptions): string;
  /** Date and 24-hour time: "Oct 18, 2026, 08:09:32". */
  dateTime(time: TimeInput, options?: ClockOptions): string;
  /** "3m ago", "now", "in 2h"; `nowMs` defaults to the current time. */
  relative(time: TimeInput, nowMs?: number): string;
  /** A compact age without direction: 45 -> "45s", 720 -> "12m", 10800 -> "3h", 172800 -> "2d". */
  age(seconds: number | null | undefined): string;
}

export interface NumberOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export interface ClockOptions {
  /** Default true. */
  seconds?: boolean;
}

const MAX_TIME_MS = 8.64e15;
const MAX_DIGITS = 6;

// Building an Intl object is slow, so each kind keeps the ones it made, keyed by locale and options.
const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRulesByLocale = new Map<Locale, Intl.PluralRules>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>();

function cached<K, T>(cache: Map<K, T>, key: K, create: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const made = create();
  cache.set(key, made);
  return made;
}

function clampDigits(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_DIGITS, Math.max(0, Math.trunc(value)));
}

/** A cached `Intl.NumberFormat`; also used by the message formatter. */
export function numberFormat(locale: Locale, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(numberFormats, `${locale}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options));
}

/** A cached `Intl.PluralRules`; also used by the message formatter. */
export function pluralRules(locale: Locale): Intl.PluralRules {
  return cached(pluralRulesByLocale, locale, () => new Intl.PluralRules(locale));
}

function unitFormat(locale: Locale, unit: 'second' | 'minute' | 'hour' | 'day'): Intl.NumberFormat {
  return numberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 0 });
}

function dateTimeFormat(locale: Locale, withDate: boolean, withSeconds: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${String(withDate)}|${String(withSeconds)}`;
  return cached(dateTimeFormats, key, () => {
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(withSeconds ? { second: '2-digit' } : {}),
      ...(withDate ? { year: 'numeric', month: 'short', day: 'numeric' } : {}),
    };
    return new Intl.DateTimeFormat(locale, options);
  });
}

function relativeFormat(locale: Locale): Intl.RelativeTimeFormat {
  return cached(
    relativeFormats,
    locale,
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }),
  );
}

function isUsable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** Epoch milliseconds of a time input, or NaN when it is missing, unparsable or outside the range of a Date. */
export function timeToMs(time: TimeInput): number {
  let ms: number;
  if (time === null || time === undefined) return Number.NaN;
  if (typeof time === 'string') ms = time === '' ? Number.NaN : Date.parse(time);
  else if (typeof time === 'number') ms = time;
  else ms = time.getTime();
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS ? ms : Number.NaN;
}

const KB = 1024;
const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(locale: Locale, value: number): string {
  if (value < KB) return `${numberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value))} B`;
  let scaled = value / KB;
  let index = 0;
  while (scaled >= KB && index < BYTE_UNITS.length - 1) {
    scaled /= KB;
    index += 1;
  }
  const digits = scaled < 10 ? 1 : 0;
  const text = numberFormat(locale, { maximumFractionDigits: digits }).format(scaled);
  return `${text} ${BYTE_UNITS[index] ?? 'TB'}`;
}

const SECONDS_PER = { minute: 60, hour: 3600, day: 86400 } as const;

function formatDuration(locale: Locale, seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const part = (amount: number, unit: 'second' | 'minute' | 'hour' | 'day'): string =>
    unitFormat(locale, unit).format(amount);
  if (total < SECONDS_PER.minute) return part(total, 'second');
  if (total < SECONDS_PER.hour) {
    const rest = total % SECONDS_PER.minute;
    const head = part(Math.floor(total / SECONDS_PER.minute), 'minute');
    return rest === 0 ? head : `${head} ${part(rest, 'second')}`;
  }
  if (total < SECONDS_PER.day) {
    const rest = Math.floor((total % SECONDS_PER.hour) / SECONDS_PER.minute);
    const head = part(Math.floor(total / SECONDS_PER.hour), 'hour');
    return rest === 0 ? head : `${head} ${part(rest, 'minute')}`;
  }
  const rest = Math.floor((total % SECONDS_PER.day) / SECONDS_PER.hour);
  const head = part(Math.floor(total / SECONDS_PER.day), 'day');
  return rest === 0 ? head : `${head} ${part(rest, 'hour')}`;
}

// Where an age changes unit: seconds below 90 s, minutes below 90 min, hours below 36 h, then days.
const AGE_SECONDS_LIMIT = 90;
const AGE_MINUTES_LIMIT = 5400;
const AGE_HOURS_LIMIT = 129600;

function ageUnit(seconds: number): { amount: number; unit: 'second' | 'minute' | 'hour' | 'day' } {
  const total = Math.max(0, seconds);
  if (total < AGE_SECONDS_LIMIT) return { amount: Math.round(total), unit: 'second' };
  if (total < AGE_MINUTES_LIMIT) return { amount: Math.round(total / SECONDS_PER.minute), unit: 'minute' };
  if (total < AGE_HOURS_LIMIT) return { amount: Math.round(total / SECONDS_PER.hour), unit: 'hour' };
  return { amount: Math.round(total / SECONDS_PER.day), unit: 'day' };
}

/** Under this many seconds either side of now a relative time reads "now". */
const NOW_WINDOW_SECONDS = 5;

function formatRelative(locale: Locale, ms: number, nowMs: number): string {
  const diffSeconds = (nowMs - ms) / 1000;
  const format = relativeFormat(locale);
  if (Math.abs(diffSeconds) < NOW_WINDOW_SECONDS) return format.format(0, 'second');
  const { amount, unit } = ageUnit(Math.abs(diffSeconds));
  return format.format(diffSeconds > 0 ? -amount : amount, unit);
}

const formatters = new Map<Locale, Formatters>();

/** The formatters of a locale; the same object for the same locale, so it is safe in a dependency list. */
export function createFormatters(locale: Locale): Formatters {
  const known = formatters.get(locale);
  if (known !== undefined) return known;
  const made: Formatters = {
    locale,
    number(value, options) {
      if (!isUsable(value)) return '';
      const min = clampDigits(options?.minimumFractionDigits);
      const max = clampDigits(options?.maximumFractionDigits);
      return numberFormat(locale, {
        ...(min === undefined ? {} : { minimumFractionDigits: min }),
        ...(max === undefined ? {} : { maximumFractionDigits: max < (min ?? 0) ? (min ?? 0) : max }),
      }).format(value);
    },
    compact(value) {
      if (!isUsable(value)) return '';
      return numberFormat(locale, { notation: 'compact', compactDisplay: 'short' }).format(value);
    },
    percent(fraction, digits = 0) {
      if (!isUsable(fraction)) return '';
      const fixed = clampDigits(digits) ?? 0;
      return numberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: fixed,
        maximumFractionDigits: fixed,
      }).format(fraction);
    },
    bytes(value) {
      if (!isUsable(value) || value < 0) return '';
      return formatBytes(locale, value);
    },
    duration(seconds) {
      if (!isUsable(seconds)) return '';
      return formatDuration(locale, seconds);
    },
    clock(time, options) {
      const ms = timeToMs(time);
      return Number.isNaN(ms) ? '' : dateTimeFormat(locale, false, options?.seconds !== false).format(ms);
    },
    dateTime(time, options) {
      const ms = timeToMs(time);
      return Number.isNaN(ms) ? '' : dateTimeFormat(locale, true, options?.seconds !== false).format(ms);
    },
    relative(time, nowMs = Date.now()) {
      const ms = timeToMs(time);
      if (Number.isNaN(ms) || !Number.isFinite(nowMs)) return '';
      return formatRelative(locale, ms, nowMs);
    },
    age(seconds) {
      if (!isUsable(seconds)) return '';
      const { amount, unit } = ageUnit(seconds);
      return unitFormat(locale, unit).format(amount);
    },
  };
  formatters.set(locale, made);
  return made;
}
