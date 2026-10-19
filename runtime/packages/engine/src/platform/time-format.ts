// The `attempts.time_format` subset (ADR 0067, design 01 section 2.8): how the time column of a chain-log line is read.
//
// Rules of the time format:
//   - Directives: `%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%`. Any other directive, and a lone `%` at the end, is
//     refused (`validateTimeFormat` at config load, `TimeFormatError` when a format is used anyway).
//   - Names (`%b %B %a %A %p %Z`) are English and case-insensitive; literal characters of the format match case-insensitively too.
//   - Whitespace in the format (a run of it) matches one or more whitespace characters of the text.
//   - The whole text must match: text left over after the format means no match.
//   - `%S` is 00 to 59 (no leap seconds). `%f` is one to six digits, kept as whole milliseconds. `%y` pivots at 69.
//   - A field the format does not carry defaults to year 1900, January 1st, midnight, so a format without a year cannot
//     parse 29 February (1900 is not a leap year).
//   - `%z` is `Z`, `+HH:MM` or `+HHMM` (hours 00 to 23, minutes 00 to 59). Without `%z` the fields are local time of the host.
//   - `%j` sets month and day from the day of the year; a day past the end of its year is refused (no roll-over into the next
//     year). `%j` together with `%m`, `%d`, `%b` or `%B` is refused by `validateTimeFormat`.
//   - A format is at most 200 characters with at most 16 directives, so a hostile format cannot cost much to compile or to match.
//
// `parseTimeWithFormat` returns the parsed fields or null when the text does not match; a format that breaks the rules above
// is a configuration error and throws `TimeFormatError` (config load validates with `validateTimeFormat` first).

export interface TimeFields {
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
/** Directives that name a month or a day of the month: they cannot be combined with `%j`. */
const DATE_DIRECTIVES: ReadonlySet<string> = new Set(['m', 'd', 'b', 'B']);

const MAX_FORMAT_LENGTH = 200;
const MAX_DIRECTIVES = 16;
/** A time column is short; a longer text cannot match and is not given to the matcher. */
const MAX_TEXT_LENGTH = 256;

/** A format that breaks the rules of the time format. The message carries no key name; `validateTimeFormat` adds it. */
export class TimeFormatError extends Error {
  /** The offending directive (`%` plus its character, or a lone `%`), or null when the problem is not one directive. */
  readonly directive: string | null;

  constructor(message: string, directive: string | null = null) {
    super(message);
    this.name = 'TimeFormatError';
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

/** Longest alternative first, so `May` and `March` cannot shadow each other. */
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
  S: '([0-5]\\d|\\d)',
  f: '(\\d{1,6})',
  y: '(\\d\\d)',
  b: `(${alternation(MONTH_ABBREVIATIONS)})`,
  B: `(${alternation(MONTHS)})`,
  a: `(${alternation(DAY_ABBREVIATIONS)})`,
  A: `(${alternation(DAYS)})`,
  p: '(AM|PM)',
  j: '(36[0-6]|3[0-5]\\d|[1-2]\\d\\d|0[1-9]\\d|00[1-9]|[1-9]\\d|0[1-9]|[1-9])',
  z: '([+-](?:[01]\\d|2[0-3]):?[0-5]\\d|Z)',
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

/** Why `format` breaks the rules (message without a key name, and the directive when there is one), or null when it is fine. */
function formatProblem(format: string): { message: string; directive: string | null } | null {
  if (format.length > MAX_FORMAT_LENGTH) {
    return { message: `longer than ${String(MAX_FORMAT_LENGTH)} characters`, directive: null };
  }
  let count = 0;
  let hasJulian = false;
  let hasDate = false;
  for (let i = 0; i < format.length; i += 1) {
    if (format.charAt(i) !== '%') continue;
    const next = format.charAt(i + 1);
    if (next === '' || !SUPPORTED.has(next)) {
      return { message: `unsupported directive %${next} (supported: ${SUPPORTED_DIRECTIVES})`, directive: `%${next}` };
    }
    i += 1;
    if (next === '%') continue;
    count += 1;
    if (next === 'j') hasJulian = true;
    if (DATE_DIRECTIVES.has(next)) hasDate = true;
  }
  if (count > MAX_DIRECTIVES) return { message: `more than ${String(MAX_DIRECTIVES)} directives`, directive: null };
  if (hasJulian && hasDate) return { message: '%j cannot be combined with %m, %d, %b or %B', directive: '%j' };
  return null;
}

function compile(format: string): Compiled {
  const cached = compiledByFormat.get(format);
  if (cached !== undefined) return cached;
  const problem = formatProblem(format);
  if (problem !== null) throw new TimeFormatError(problem.message, problem.directive);

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

/**
 * `null` when `format` follows the rules of the time format, otherwise a message that starts with `key` (for example
 * `attempts.time_format: unsupported directive %X (supported: ...)`).
 */
export function validateTimeFormat(format: string, key = 'attempts.time_format'): string | null {
  const problem = formatProblem(format);
  return problem === null ? null : `${key}: ${problem.message}`;
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

/** The `%z` text as minutes east of UTC: `Z`, `+HHMM` or `+HH:MM`. Null for anything else (a lower case `z` included). */
function parseOffset(text: string): number | null {
  if (text === 'Z') return 0;
  const match = /^([+-])(\d\d):?(\d\d)$/.exec(text);
  if (match === null) return null;
  const total = Number.parseInt(match[2] ?? '', 10) * 60 + Number.parseInt(match[3] ?? '', 10);
  return match[1] === '-' ? -total : total;
}

/** Parses `text` with a time format. Returns null when the text does not match the whole format. */
export function parseTimeWithFormat(text: string, format: string): TimeFields | null {
  const { regex, groups } = compile(format);
  if (text.length > MAX_TEXT_LENGTH) return null;
  const match = regex.exec(text);
  if (match?.[0].length !== text.length) return null;

  const found = new Map<string, string>();
  groups.forEach((directive, index) => {
    const value = match[index + 1];
    if (value !== undefined) found.set(directive, value);
  });

  let year = 1900;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let milliseconds = 0;
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
        second = Number.parseInt(value, 10);
        break;
      case 'f':
        milliseconds = Math.floor(Number.parseInt(value.padEnd(6, '0'), 10) / 1000);
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

  if (julian !== null) {
    if (julian > (isLeapYear(year) ? 366 : 365)) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, 0, julian);
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  }
  if (year < 1 || year > 9999) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day, hour, minute, second, ms: milliseconds, utcOffsetMin };
}

/**
 * Epoch milliseconds of parsed fields. With an offset the offset is applied; without one the fields are local time of the
 * host (daylight saving decided by the host).
 */
export function timeFieldsToEpochMs(fields: TimeFields): number {
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
