// Ported from the cases of the former Python `strptime` port test (ADR 0067). Cases that no longer hold are listed here
// with the rule that made them obsolete:
//   - `%S` accepting 60 and 61 (clamped to 59): obsolete, `%S` is 00 to 59 (no leap seconds).
//   - February 29th parsed without a year: obsolete, a format without a year cannot parse 29 February.
//   - `%z` with seconds, a fraction and an offset of a day or more (`+05:30:15`, `+2400`): obsolete, `%z` is `Z`, `+HH:MM` or `+HHMM`
//     with hours 00 to 23 and minutes 00 to 59.
//   - `%j` rolling over into the next year (`366` in a common year): obsolete, a day of year past the end of its year is refused.
//   - The names of the former Python port are gone; the new names are `TimeFormatError`, `parseTimeWithFormat`,
//     `validateTimeFormat`, `timeFieldsToEpochMs` and `TimeFields`.
import { describe, expect, it, vi } from 'vitest';

import {
  TimeFormatError,
  parseTimeWithFormat,
  timeFieldsToEpochMs,
  validateTimeFormat,
  type TimeFields,
} from './time-format.ts';

const DEFAULT_FORMAT = '%Y-%m-%d %H:%M:%S';
const SUPPORTED = '%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%';

function parse(text: string, format: string): TimeFields {
  const fields = parseTimeWithFormat(text, format);
  if (fields === null) throw new Error(`expected ${JSON.stringify(text)} to match ${format}`);
  return fields;
}

const BASE: TimeFields = {
  year: 1900,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  ms: 0,
  utcOffsetMin: null,
};

describe('parseTimeWithFormat defaults and the default format', () => {
  it('parses the default attempts format', () => {
    expect(parse('2026-10-11 07:05:09', DEFAULT_FORMAT)).toEqual({
      year: 2026,
      month: 10,
      day: 11,
      hour: 7,
      minute: 5,
      second: 9,
      ms: 0,
      utcOffsetMin: null,
    });
  });

  it('fills missing fields: year 1900, January 1st, midnight', () => {
    expect(parse('', '')).toEqual(BASE);
    expect(parse('07', '%H')).toEqual({ ...BASE, hour: 7 });
    expect(parse('2026', '%Y')).toEqual({ ...BASE, year: 2026 });
    expect(parse('10-11', '%m-%d')).toEqual({ ...BASE, month: 10, day: 11 });
  });
});

describe('parseTimeWithFormat directives', () => {
  it('%Y takes exactly four digits', () => {
    expect(parse('0099', '%Y').year).toBe(99);
    expect(parseTimeWithFormat('99', '%Y')).toBeNull();
    expect(parseTimeWithFormat('20260', '%Y')).toBeNull();
  });

  it('%m accepts 1 to 12 with or without a leading zero', () => {
    expect(parse('1', '%m').month).toBe(1);
    expect(parse('01', '%m').month).toBe(1);
    expect(parse('12', '%m').month).toBe(12);
    expect(parseTimeWithFormat('13', '%m')).toBeNull();
    expect(parseTimeWithFormat('00', '%m')).toBeNull();
  });

  it('%d accepts 1 to 31, a leading zero and a leading space', () => {
    expect(parse('5', '%d').day).toBe(5);
    expect(parse('05', '%d').day).toBe(5);
    expect(parse(' 5', '%d').day).toBe(5);
    expect(parse('31', '%d').day).toBe(31);
    expect(parseTimeWithFormat('32', '%d')).toBeNull();
    expect(parseTimeWithFormat('0', '%d')).toBeNull();
    expect(parseTimeWithFormat('00', '%d')).toBeNull();
  });

  it('%H accepts 0 to 23, with a leading zero or a leading space', () => {
    expect(parse('0', '%H').hour).toBe(0);
    expect(parse('09', '%H').hour).toBe(9);
    expect(parse(' 7', '%H').hour).toBe(7);
    expect(parse('23', '%H').hour).toBe(23);
    expect(parseTimeWithFormat('24', '%H')).toBeNull();
    expect(parseTimeWithFormat('  7', '%H')).toBeNull();
  });

  it('%I with %p converts the twelve hour clock', () => {
    expect(parse('12 AM', '%I %p').hour).toBe(0);
    expect(parse('12 PM', '%I %p').hour).toBe(12);
    expect(parse('1 PM', '%I %p').hour).toBe(13);
    expect(parse('11 pm', '%I %p').hour).toBe(23);
    expect(parse('11 Am', '%I %p').hour).toBe(11);
    expect(parseTimeWithFormat('13 PM', '%I %p')).toBeNull();
    expect(parseTimeWithFormat('0 AM', '%I %p')).toBeNull();
  });

  it('%I accepts a leading space and rejects 0', () => {
    expect(parse(' 5 PM', '%I %p').hour).toBe(17);
    expect(parseTimeWithFormat(' 0 PM', '%I %p')).toBeNull();
  });

  it('%I without %p reads as AM', () => {
    expect(parse('12', '%I').hour).toBe(0);
    expect(parse('7', '%I').hour).toBe(7);
  });

  it('%M and %S accept 0 to 59', () => {
    expect(parse('5', '%M').minute).toBe(5);
    expect(parse('59', '%M').minute).toBe(59);
    expect(parseTimeWithFormat('60', '%M')).toBeNull();
    expect(parse('0', '%S').second).toBe(0);
    expect(parse('59', '%S').second).toBe(59);
  });

  it('%S refuses 60 and 61: there are no leap seconds', () => {
    expect(parseTimeWithFormat('60', '%S')).toBeNull();
    expect(parseTimeWithFormat('61', '%S')).toBeNull();
    expect(parseTimeWithFormat('62', '%S')).toBeNull();
    expect(parseTimeWithFormat('2026-10-11 23:59:60', DEFAULT_FORMAT)).toBeNull();
  });

  it('%f takes one to six digits and keeps whole milliseconds', () => {
    expect(parse('5', '%f').ms).toBe(500);
    expect(parse('05', '%f').ms).toBe(50);
    expect(parse('123456', '%f').ms).toBe(123);
    expect(parse('000999', '%f').ms).toBe(0);
    expect(parse('999999', '%f').ms).toBe(999);
    expect(parseTimeWithFormat('1234567', '%f')).toBeNull();
  });

  it('%y pivots at 69: 69-99 are 19xx and 00-68 are 20xx', () => {
    expect(parse('68', '%y').year).toBe(2068);
    expect(parse('69', '%y').year).toBe(1969);
    expect(parse('99', '%y').year).toBe(1999);
    expect(parse('00', '%y').year).toBe(2000);
    expect(parseTimeWithFormat('7', '%y')).toBeNull();
  });

  it('%b and %B read English month names, case-insensitively', () => {
    expect(parse('Oct', '%b').month).toBe(10);
    expect(parse('oct', '%b').month).toBe(10);
    expect(parse('OCT', '%b').month).toBe(10);
    expect(parse('October', '%B').month).toBe(10);
    expect(parse('may', '%B').month).toBe(5);
    expect(parse('May', '%b').month).toBe(5);
    expect(parse('September', '%B').month).toBe(9);
    expect(parseTimeWithFormat('Octo', '%b')).toBeNull();
    expect(parseTimeWithFormat('Oct', '%B')).toBeNull();
    expect(parseTimeWithFormat('Sept', '%b')).toBeNull();
    expect(parse('Dec 5 2026', '%b %d %Y')).toEqual({ ...BASE, year: 2026, month: 12, day: 5 });
  });

  it('%a and %A read English day names and ignore them', () => {
    expect(parse('Sun 2026-10-11', '%a %Y-%m-%d')).toEqual({ ...BASE, year: 2026, month: 10, day: 11 });
    expect(parse('sunday 2026-10-11', '%A %Y-%m-%d').day).toBe(11);
    expect(parseTimeWithFormat('Sonday 2026-10-11', '%A %Y-%m-%d')).toBeNull();
    expect(parseTimeWithFormat('Sunday', '%a')).toBeNull();
  });

  it('%j sets month and day from the day of year (the default year 1900 is not a leap year)', () => {
    expect(parse('001', '%j')).toEqual({ ...BASE });
    expect(parse('59', '%j')).toEqual({ ...BASE, month: 2, day: 28 });
    expect(parse('060', '%j')).toEqual({ ...BASE, month: 3, day: 1 });
    expect(parse('365', '%j')).toEqual({ ...BASE, month: 12, day: 31 });
    expect(parse('2024 060', '%Y %j')).toEqual({ ...BASE, year: 2024, month: 2, day: 29 });
    expect(parse('2024 366', '%Y %j')).toEqual({ ...BASE, year: 2024, month: 12, day: 31 });
    expect(parseTimeWithFormat('000', '%j')).toBeNull();
    expect(parseTimeWithFormat('367', '%j')).toBeNull();
  });

  it('%j past the end of its year is refused instead of rolling over into the next year', () => {
    expect(parseTimeWithFormat('366', '%j')).toBeNull();
    expect(parseTimeWithFormat('2026 366', '%Y %j')).toBeNull();
    expect(parse('9999365', '%Y%j')).toEqual({ ...BASE, year: 9999, month: 12, day: 31 });
    expect(parseTimeWithFormat('9999366', '%Y%j')).toBeNull();
    expect(parseTimeWithFormat('366 9999', '%j %Y')).toBeNull();
    expect(parse('0001001', '%Y%j')).toEqual({ ...BASE, year: 1 });
  });

  it('%z reads Z, +HH:MM and +HHMM offsets in minutes', () => {
    expect(parse('Z', '%z').utcOffsetMin).toBe(0);
    expect(parse('+0530', '%z').utcOffsetMin).toBe(330);
    expect(parse('+05:30', '%z').utcOffsetMin).toBe(330);
    expect(parse('-05:00', '%z').utcOffsetMin).toBe(-300);
    expect(parse('-0500', '%z').utcOffsetMin).toBe(-300);
    expect(parse('+0000', '%z').utcOffsetMin).toBe(0);
    expect(parse('+23:59', '%z').utcOffsetMin).toBe(1439);
    expect(parse('2026-10-11T07:05:09+07:00', '%Y-%m-%dT%H:%M:%S%z').utcOffsetMin).toBe(420);
    expect(parseTimeWithFormat('z', '%z')).toBeNull();
    expect(parseTimeWithFormat('+05', '%z')).toBeNull();
    expect(parseTimeWithFormat('0530', '%z')).toBeNull();
  });

  it('%z refuses seconds, a fraction, a colon in one place only and an offset of a day or more', () => {
    for (const text of [
      '+05:30:15',
      '+053015',
      '-05:30:15.123456',
      '+2400',
      '+05:3015',
      '+0530:15',
      '+0560',
      '+05:60',
    ]) {
      expect(parseTimeWithFormat(text, '%z'), text).toBeNull();
    }
  });

  it('%Z accepts only UTC and GMT and gives no offset', () => {
    expect(parse('UTC', '%Z').utcOffsetMin).toBeNull();
    expect(parse('gmt', '%Z').utcOffsetMin).toBeNull();
    expect(parseTimeWithFormat('EST', '%Z')).toBeNull();
    expect(parseTimeWithFormat('CEST', '%Z')).toBeNull();
  });

  it('%% matches one percent sign, also in runs', () => {
    expect(parse('100% 07', '100%% %H').hour).toBe(7);
    expect(parseTimeWithFormat('100 07', '100%% %H')).toBeNull();
    expect(parse('%%%', '%%%%%%')).toEqual(BASE);
    expect(parseTimeWithFormat('%%', '%%%%%%')).toBeNull();
    expect(parse('%7', '%%%H').hour).toBe(7);
  });
});

describe('parseTimeWithFormat literals and whitespace', () => {
  it('matches literal characters case-insensitively and escapes regular expression characters', () => {
    expect(parse('DATE: 2026', 'date: %Y').year).toBe(2026);
    expect(parse('2026-10-11t07:05', '%Y-%m-%dT%H:%M').hour).toBe(7);
    expect(parse('a.b(1)+[x]*?|^$ 07', 'a.b(1)+[x]*?|^$ %H').hour).toBe(7);
    expect(parseTimeWithFormat('aXb 07', 'a.b %H')).toBeNull();
  });

  it('lets any run of whitespace in the format match one or more whitespace characters', () => {
    expect(parse('2026 \t 10', '%Y  %m').month).toBe(10);
    expect(parse('2026 10', '%Y \t%m').month).toBe(10);
    expect(parseTimeWithFormat('202610', '%Y %m')).toBeNull();
  });
});

describe('parseTimeWithFormat rejections', () => {
  it('returns null when text remains after the format or the whole text does not match', () => {
    expect(parseTimeWithFormat('2026-10-11 07:05:09 extra', DEFAULT_FORMAT)).toBeNull();
    expect(parseTimeWithFormat('2026-10-11 07:05:09 ', DEFAULT_FORMAT)).toBeNull();
    expect(parseTimeWithFormat(' 2026-10-11 07:05:09', DEFAULT_FORMAT)).toBeNull();
  });

  it('returns null when the text is shorter than the format or empty', () => {
    expect(parseTimeWithFormat('2026-10-11', DEFAULT_FORMAT)).toBeNull();
    expect(parseTimeWithFormat('', DEFAULT_FORMAT)).toBeNull();
  });

  it('validates the calendar: the day must exist in that month and year', () => {
    expect(parseTimeWithFormat('2026-02-29 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2024-02-29 00:00:00', DEFAULT_FORMAT).day).toBe(29);
    expect(parseTimeWithFormat('1900-02-29 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2000-02-29 00:00:00', DEFAULT_FORMAT).day).toBe(29);
    expect(parseTimeWithFormat('2026-04-31 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parseTimeWithFormat('2026-06-31 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2026-12-31 23:59:59', DEFAULT_FORMAT).month).toBe(12);
  });

  it('refuses 29 February when the format has no year', () => {
    expect(parseTimeWithFormat('02-29', '%m-%d')).toBeNull();
    expect(parseTimeWithFormat('Feb 29', '%b %d')).toBeNull();
    expect(parseTimeWithFormat('02-30', '%m-%d')).toBeNull();
    expect(parse('02-28', '%m-%d')).toEqual({ ...BASE, month: 2, day: 28 });
    expect(parse('24-02-29', '%y-%m-%d')).toEqual({ ...BASE, year: 2024, month: 2, day: 29 });
  });

  it('rejects an hour of 24 and a minute of 60', () => {
    expect(parseTimeWithFormat('2026-10-11 24:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parseTimeWithFormat('2026-10-11 00:60:00', DEFAULT_FORMAT)).toBeNull();
  });

  it('throws TimeFormatError for an unsupported directive instead of returning null', () => {
    for (const directive of ['%X', '%c', '%x', '%U', '%W', '%w', '%u', '%G', '%V', '%e', '%-d', '%q']) {
      expect(() => parseTimeWithFormat('x', directive)).toThrow(TimeFormatError);
    }
    expect(() => parseTimeWithFormat('x', '%Y %X')).toThrow(/unsupported directive %X/);
  });

  it('throws for a stray percent sign at the end of the format', () => {
    expect(() => parseTimeWithFormat('2026%', '%Y%')).toThrow(TimeFormatError);
    expect(() => parseTimeWithFormat('', '%')).toThrow(/unsupported directive %/);
    expect(() => parseTimeWithFormat('', '%%%')).toThrow(TimeFormatError);
  });

  it('throws TimeFormatError for %j mixed with %m, %d, %b or %B', () => {
    for (const format of ['%j %m', '%d %j', '%Y %b %j', '%B%j']) {
      expect(() => parseTimeWithFormat('x', format), format).toThrow(TimeFormatError);
    }
  });

  it('throws only TimeFormatError for adversarial formats and answers quickly', () => {
    const started = Date.now();
    expect(() => parseTimeWithFormat('2026', '%Y-'.repeat(350_000))).toThrow(TimeFormatError);
    expect(() => parseTimeWithFormat('2026', 'x'.repeat(1_000_000))).toThrow(TimeFormatError);
    expect(() => parseTimeWithFormat('1'.repeat(80), '%d'.repeat(40))).toThrow(TimeFormatError);
    expect(parseTimeWithFormat('1'.repeat(10_000), '%d')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not backtrack for long on a format of many variable-width directives', () => {
    const started = Date.now();
    expect(parseTimeWithFormat(`${'1'.repeat(31)}x`, '%d'.repeat(16))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('validateTimeFormat', () => {
  it('returns null for formats built only from supported directives', () => {
    expect(validateTimeFormat(DEFAULT_FORMAT)).toBeNull();
    expect(validateTimeFormat('%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %z %Z %%')).toBeNull();
    expect(validateTimeFormat('%Y %j %H %z')).toBeNull();
    expect(validateTimeFormat('')).toBeNull();
    expect(validateTimeFormat('no directives at all')).toBeNull();
    expect(validateTimeFormat('%%j %m')).toBeNull();
  });

  it('names the first unsupported directive and lists the supported ones', () => {
    expect(validateTimeFormat('%Y-%m-%d %X')).toBe(
      `attempts.time_format: unsupported directive %X (supported: ${SUPPORTED})`,
    );
  });

  it('reports a stray trailing percent sign as an unsupported directive', () => {
    expect(validateTimeFormat('%Y%')).toMatch(/^attempts\.time_format: unsupported directive % \(supported: /);
  });

  it('uses the key name the caller passes', () => {
    expect(validateTimeFormat('%q', 'config.attempts.time_format')).toMatch(
      /^config\.attempts\.time_format: unsupported directive %q /,
    );
  });

  it('refuses %j together with %m, %d, %b or %B', () => {
    const message = 'attempts.time_format: %j cannot be combined with %m, %d, %b or %B';
    for (const format of ['%j %m', '%d %j', '%Y %b %j', '%B %Y %j', '%j%j%d']) {
      expect(validateTimeFormat(format), format).toBe(message);
    }
    expect(validateTimeFormat('%j %y')).toBeNull();
  });

  it('refuses a format that is too long or has too many directives, without reading all of it', () => {
    expect(validateTimeFormat('x'.repeat(1_000_000))).toBe('attempts.time_format: longer than 200 characters');
    expect(validateTimeFormat('x'.repeat(200))).toBeNull();
    expect(validateTimeFormat('%d'.repeat(17))).toBe('attempts.time_format: more than 16 directives');
    expect(validateTimeFormat('%d'.repeat(16))).toBeNull();
  });

  it('agrees with parseTimeWithFormat about which formats throw', () => {
    const formats = ['%Y', '%X', '%Y %q', '%%', '%', '%j', '%j %m', '%d%j', 'x'.repeat(300), '%d'.repeat(20), '%j %y'];
    for (const format of formats) {
      const message = validateTimeFormat(format);
      const throws = (() => {
        try {
          parseTimeWithFormat('', format);
          return false;
        } catch (error) {
          return error instanceof TimeFormatError;
        }
      })();
      expect(message !== null, format).toBe(throws);
    }
  });
});

describe('timeFieldsToEpochMs', () => {
  it('uses the host time zone when there is no offset (the suite runs with TZ=UTC)', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    expect(timeFieldsToEpochMs(parse('2026-01-01 00:00:00', DEFAULT_FORMAT))).toBe(1767225600000);
    expect(timeFieldsToEpochMs(parse('2026-10-11 07:05:09.250', `${DEFAULT_FORMAT}.%f`))).toBe(
      Date.UTC(2026, 9, 11, 7, 5, 9, 250),
    );
  });

  it('follows the host zone when TZ changes (local time)', () => {
    vi.stubEnv('TZ', 'Asia/Ho_Chi_Minh');
    const expected = Date.UTC(2026, 0, 1) - 7 * 3_600_000;
    expect(timeFieldsToEpochMs(parse('2026-01-01 00:00:00', DEFAULT_FORMAT))).toBe(expected);
  });

  it('applies an explicit offset instead of ignoring it', () => {
    const fields = parse('2026-10-11 07:05:09 +0530', `${DEFAULT_FORMAT} %z`);
    expect(timeFieldsToEpochMs(fields)).toBe(Date.UTC(2026, 9, 11, 7, 5, 9) - 330 * 60_000);
    expect(timeFieldsToEpochMs(parse('2026-10-11 07:05:09 Z', `${DEFAULT_FORMAT} %z`))).toBe(
      Date.UTC(2026, 9, 11, 7, 5, 9),
    );
    expect(timeFieldsToEpochMs(parse('2026-10-11 07:05:09 -05:00', `${DEFAULT_FORMAT} %z`))).toBe(
      Date.UTC(2026, 9, 11, 7, 5, 9) + 300 * 60_000,
    );
  });

  it('keeps years below 100 as they are (no 19xx mapping of the Date constructor)', () => {
    expect(timeFieldsToEpochMs(parse('0099-01-01 00:00:00 +0000', `${DEFAULT_FORMAT} %z`))).toBe(
      Date.parse('0099-01-01T00:00:00.000Z'),
    );
    expect(timeFieldsToEpochMs(parse('0099-01-01 00:00:00', DEFAULT_FORMAT))).toBe(
      Date.parse('0099-01-01T00:00:00.000Z'),
    );
  });
});
