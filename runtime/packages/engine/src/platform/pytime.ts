// Port of CPython `_strptime` for the directives the chain-log time format needs (06 3.10.4, registry C42).
// `pyStrptime` returns the parsed fields or null when the text does not match; an unsupported directive in the format is a
// programming or configuration error and throws `PyStrptimeFormatError` (config load validates with `pyStrptimeValidate`).

export interface PyTimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Whole milliseconds of `%f`. */
  ms: number;
  /** Offset east of UTC in minutes when the text carried `%z`; null for local time. */
  utcOffsetMin: number | null;
}

const SUPPORTED_DIRECTIVES = '%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%';
const SUPPORTED: ReadonlySet<string> = new Set('YmdHMSfybBaAIpjzZ%'.split(''));

export class PyStrptimeFormatError extends Error {
  readonly directive: string;

  constructor(directive: string) {
    super(`unsupported directive ${directive} (supported: ${SUPPORTED_DIRECTIVES})`);
    this.name = 'PyStrptimeFormatError';
    this.directive = directive;
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const DAY_ABBREVIATIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Longest alternative first, like CPython's `__seqToRE`, so `May` and `March` cannot shadow each other. */
function alternation(words: readonly string[]): string {
  return [...words].sort((a, b) => b.length - a.length).join('|');
}

/** The regular expression of each directive: one capture group each. */
const DIRECTIVE_PATTERNS: Readonly<Record<string, string>> = {
  Y: '(\\d\\d\\d\\d)',
  m: '(1[0-2]|0[1-9]|[1-9])',
  d: '(3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])',
  H: '(2[0-3]|[0-1]\\d|\\d| \\d)',
  I: '(1[0-2]|0[1-9]|[1-9]| [1-9])',
  M: '([0-5]\\d|\\d)',
  S: '(6[0-1]|[0-5]\\d|\\d)',
  f: '(\\d{1,6})',
  y: '(\\d\\d)',
  b: `(${alternation(MONTH_ABBREVIATIONS)})`,
  B: `(${alternation(MONTHS)})`,
  a: `(${alternation(DAY_ABBREVIATIONS)})`,
  A: `(${alternation(DAYS)})`,
  p: '(AM|PM)',
  j: '(36[0-6]|3[0-5]\\d|[1-2]\\d\\d|0[1-9]\\d|00[1-9]|[1-9]\\d|0[1-9]|[1-9])',
  z: '([+-]\\d\\d:?[0-5]\\d(?::?[0-5]\\d(?:\\.\\d{1,6})?)?|Z)',
  Z: '(UTC|GMT)',
};

const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SYNTAX, '\\$&');
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u000b' || ch === '\u000c';
}

interface Compiled {
  regex: RegExp;
  /** The directive letter of capture group `i + 1`. */
  groups: string[];
}

const compiledByFormat = new Map<string, Compiled>();
const MAX_CACHED_FORMATS = 64;

/** The first unsupported directive of `format` (`%` plus its character, or a lone `%`), or null. */
function firstUnsupported(format: string): string | null {
  for (let i = 0; i < format.length; i += 1) {
    if (format.charAt(i) !== '%') continue;
    const next = format.charAt(i + 1);
    if (next === '' || !SUPPORTED.has(next)) return `%${next}`;
    i += 1;
  }
  return null;
}

function compile(format: string): Compiled {
  const cached = compiledByFormat.get(format);
  if (cached !== undefined) return cached;
  const unsupported = firstUnsupported(format);
  if (unsupported !== null) throw new PyStrptimeFormatError(unsupported);

  let source = '^';
  const groups: string[] = [];
  for (let i = 0; i < format.length; i += 1) {
    const ch = format.charAt(i);
    if (ch === '%') {
      const directive = format.charAt(i + 1);
      i += 1;
      if (directive === '%') {
        source += '%';
      } else {
        source += DIRECTIVE_PATTERNS[directive] ?? '';
        groups.push(directive);
      }
    } else if (isWhitespace(ch)) {
      while (isWhitespace(format.charAt(i + 1))) i += 1;
      source += '\\s+';
    } else {
      source += escapeLiteral(ch);
    }
  }
  const compiled: Compiled = { regex: new RegExp(source, 'i'), groups };
  if (compiledByFormat.size >= MAX_CACHED_FORMATS) compiledByFormat.clear();
  compiledByFormat.set(format, compiled);
  return compiled;
}

/** `null` when `format` uses only supported directives, otherwise the message `<key>: unsupported directive %X (supported: ...)`. */
export function pyStrptimeValidate(format: string, key = 'attempts.time_format'): string | null {
  const unsupported = firstUnsupported(format);
  if (unsupported === null) return null;
  return `${key}: unsupported directive ${unsupported} (supported: ${SUPPORTED_DIRECTIVES})`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function lookupMonth(names: readonly string[], text: string): number {
  const wanted = text.toLowerCase();
  return names.findIndex((name) => name.toLowerCase() === wanted) + 1;
}

/**
 * The `%z` text as minutes east of UTC, like CPython 3.14: `Z` (upper case only), `+HHMM`, `+HH:MM` and the same with
 * seconds (`+HH:MM:SS`, `+HHMMSS`, an optional fraction that is ignored). Seconds are cut off: the result is whole
 * minutes. A colon that is used in only one of the two places is an error (null), as in CPython.
 */
function parseOffset(text: string): number | null {
  if (text === 'z') return null;
  if (text === 'Z') return 0;
  let z = text;
  if (z.charAt(3) === ':') {
    z = z.slice(0, 3) + z.slice(4);
    if (z.length > 5) {
      if (z.charAt(5) !== ':') return null;
      z = z.slice(0, 5) + z.slice(6);
    }
  }
  const hours = Number.parseInt(z.slice(1, 3), 10);
  const minutes = Number.parseInt(z.slice(3, 5), 10);
  const secondsText = z.slice(5, 7);
  const seconds =
    secondsText === '' ? 0 : /^[0-9]{2}$/.test(secondsText) ? Number.parseInt(secondsText, 10) : Number.NaN;
  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  const total = Math.trunc((hours * 3600 + minutes * 60 + seconds) / 60);
  return z.startsWith('-') ? -total : total;
}

/** Parses `text` with a Python `strptime` format. Returns null when the text does not match the whole format. */
export function pyStrptime(text: string, format: string): PyTimeFields | null {
  const { regex, groups } = compile(format);
  const match = regex.exec(text);
  // CPython: `re.match`, then "unconverted data remains" when the match is shorter than the text.
  if (match?.[0].length !== text.length) return null;

  const found = new Map<string, string>();
  groups.forEach((directive, index) => {
    const value = match[index + 1];
    if (value !== undefined) found.set(directive, value);
  });

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let microseconds = 0;
  let julian: number | null = null;
  let utcOffsetMin: number | null = null;

  for (const [directive, value] of found) {
    switch (directive) {
      case 'Y':
        year = Number.parseInt(value, 10);
        break;
      case 'y': {
        const short = Number.parseInt(value, 10);
        year = short <= 68 ? 2000 + short : 1900 + short;
        break;
      }
      case 'm':
        month = Number.parseInt(value, 10);
        break;
      case 'b':
        month = lookupMonth(MONTH_ABBREVIATIONS, value);
        break;
      case 'B':
        month = lookupMonth(MONTHS, value);
        break;
      case 'd':
        day = Number.parseInt(value, 10);
        break;
      case 'H':
        hour = Number.parseInt(value, 10);
        break;
      case 'I': {
        const twelve = Number.parseInt(value, 10);
        const pm = (found.get('p') ?? '').toLowerCase() === 'pm';
        hour = pm ? (twelve === 12 ? 12 : twelve + 12) : twelve === 12 ? 0 : twelve;
        break;
      }
      case 'M':
        minute = Number.parseInt(value, 10);
        break;
      case 'S':
        // 60 and 61 are leap seconds in CPython; `Date` cannot represent them, so they clamp to 59 (documented, 06 3.10.4).
        second = Math.min(Number.parseInt(value, 10), 59);
        break;
      case 'f':
        microseconds = Number.parseInt(value.padEnd(6, '0'), 10);
        break;
      case 'j':
        julian = Number.parseInt(value, 10);
        break;
      case 'z': {
        const offset = parseOffset(value);
        if (offset === null) return null;
        utcOffsetMin = offset;
        break;
      }
      default:
        // %a %A %p %Z: validated by the pattern, nothing to store (%p was read by %I).
        break;
    }
  }

  let resolvedYear = year ?? 1900;
  let resolvedMonth = month ?? 1;
  let resolvedDay = day ?? 1;
  let reportYear = resolvedYear;
  if (julian !== null) {
    // CPython: a day of year overrides month and day; the date rolls over like `date.fromordinal`.
    const date = new Date(0);
    date.setUTCFullYear(resolvedYear, 0, julian);
    resolvedYear = date.getUTCFullYear();
    resolvedMonth = date.getUTCMonth() + 1;
    resolvedDay = date.getUTCDate();
    reportYear = resolvedYear;
  } else if (year === null && resolvedMonth === 2 && resolvedDay === 29) {
    // CPython validates a year-less February 29th against a leap year, then reports the default year 1900.
    reportYear = 1900;
    resolvedYear = 1904;
  }
  // CPython: `year must be in 1..9999`; a day of year past December 31st of 9999 rolls over into year 10000.
  if (resolvedYear < 1 || resolvedYear > 9999) return null;
  if (resolvedDay < 1 || resolvedDay > daysInMonth(resolvedYear, resolvedMonth)) return null;

  return {
    year: reportYear,
    month: resolvedMonth,
    day: resolvedDay,
    hour,
    minute,
    second,
    ms: Math.floor(microseconds / 1000),
    utcOffsetMin,
  };
}

/**
 * Epoch milliseconds of parsed fields. With an offset the offset is applied (deliberate fix: the legacy `time.mktime`
 * ignored `%z`, D21); without one the fields are local time of the host, like `time.mktime` with `tm_isdst = -1`.
 */
export function toEpochMs(fields: PyTimeFields): number {
  const date = new Date(0);
  if (fields.utcOffsetMin !== null) {
    date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
    date.setUTCHours(fields.hour, fields.minute, fields.second, fields.ms);
    return date.getTime() - fields.utcOffsetMin * 60_000;
  }
  // `setFullYear` instead of the constructor: years 0-99 must not turn into 1900-1999.
  date.setFullYear(fields.year, fields.month - 1, fields.day);
  date.setHours(fields.hour, fields.minute, fields.second, fields.ms);
  return date.getTime();
}
