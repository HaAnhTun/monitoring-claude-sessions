import { describe, expect, it, vi } from 'vitest';

import { PyStrptimeFormatError, pyStrptime, pyStrptimeValidate, toEpochMs, type PyTimeFields } from './pytime.ts';

const DEFAULT_FORMAT = '%Y-%m-%d %H:%M:%S';

function parse(text: string, format: string): PyTimeFields {
  const fields = pyStrptime(text, format);
  if (fields === null) throw new Error(`expected ${JSON.stringify(text)} to match ${format}`);
  return fields;
}

const BASE: PyTimeFields = {
  year: 1900,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  ms: 0,
  utcOffsetMin: null,
};

describe('pyStrptime defaults and the legacy format', () => {
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

  it('fills missing fields like CPython: year 1900, January 1st, midnight', () => {
    expect(parse('', '')).toEqual(BASE);
    expect(parse('07', '%H')).toEqual({ ...BASE, hour: 7 });
    expect(parse('2026', '%Y')).toEqual({ ...BASE, year: 2026 });
    expect(parse('10-11', '%m-%d')).toEqual({ ...BASE, month: 10, day: 11 });
  });
});

describe('pyStrptime directives', () => {
  it('%Y takes exactly four digits', () => {
    expect(parse('0099', '%Y').year).toBe(99);
    expect(pyStrptime('99', '%Y')).toBeNull();
    expect(pyStrptime('20260', '%Y')).toBeNull();
  });

  it('%m accepts 1 to 12 with or without a leading zero', () => {
    expect(parse('1', '%m').month).toBe(1);
    expect(parse('01', '%m').month).toBe(1);
    expect(parse('12', '%m').month).toBe(12);
    expect(pyStrptime('13', '%m')).toBeNull();
    expect(pyStrptime('00', '%m')).toBeNull();
  });

  it('%d accepts 1 to 31, a leading zero and a leading space', () => {
    expect(parse('5', '%d').day).toBe(5);
    expect(parse('05', '%d').day).toBe(5);
    expect(parse(' 5', '%d').day).toBe(5);
    expect(parse('31', '%d').day).toBe(31);
    expect(pyStrptime('32', '%d')).toBeNull();
    expect(pyStrptime('0', '%d')).toBeNull();
    expect(pyStrptime('00', '%d')).toBeNull();
  });

  it('%H accepts 0 to 23, with a leading zero or a leading space (CPython 3.14)', () => {
    expect(parse('0', '%H').hour).toBe(0);
    expect(parse('09', '%H').hour).toBe(9);
    expect(parse(' 7', '%H').hour).toBe(7);
    expect(parse('23', '%H').hour).toBe(23);
    expect(pyStrptime('24', '%H')).toBeNull();
    expect(pyStrptime('  7', '%H')).toBeNull();
  });

  it('%I with %p converts the twelve hour clock', () => {
    expect(parse('12 AM', '%I %p').hour).toBe(0);
    expect(parse('12 PM', '%I %p').hour).toBe(12);
    expect(parse('1 PM', '%I %p').hour).toBe(13);
    expect(parse('11 pm', '%I %p').hour).toBe(23);
    expect(parse('11 Am', '%I %p').hour).toBe(11);
    expect(pyStrptime('13 PM', '%I %p')).toBeNull();
    expect(pyStrptime('0 AM', '%I %p')).toBeNull();
  });

  it('%I accepts a leading space and rejects 0', () => {
    expect(parse(' 5 PM', '%I %p').hour).toBe(17);
    expect(pyStrptime(' 0 PM', '%I %p')).toBeNull();
  });

  it('%I without %p reads as AM, like CPython', () => {
    expect(parse('12', '%I').hour).toBe(0);
    expect(parse('7', '%I').hour).toBe(7);
  });

  it('%M and %S accept 0 to 59, and %S also 60 and 61 (clamped to 59)', () => {
    expect(parse('5', '%M').minute).toBe(5);
    expect(parse('59', '%M').minute).toBe(59);
    expect(pyStrptime('60', '%M')).toBeNull();
    expect(parse('59', '%S').second).toBe(59);
    expect(parse('60', '%S').second).toBe(59);
    expect(parse('61', '%S').second).toBe(59);
    expect(pyStrptime('62', '%S')).toBeNull();
  });

  it('%f takes one to six digits and keeps whole milliseconds', () => {
    expect(parse('5', '%f').ms).toBe(500);
    expect(parse('05', '%f').ms).toBe(50);
    expect(parse('123456', '%f').ms).toBe(123);
    expect(parse('000999', '%f').ms).toBe(0);
    expect(parse('999999', '%f').ms).toBe(999);
    expect(pyStrptime('1234567', '%f')).toBeNull();
  });

  it('%y pivots at 69: 69-99 are 19xx and 00-68 are 20xx', () => {
    expect(parse('68', '%y').year).toBe(2068);
    expect(parse('69', '%y').year).toBe(1969);
    expect(parse('99', '%y').year).toBe(1999);
    expect(parse('00', '%y').year).toBe(2000);
    expect(pyStrptime('7', '%y')).toBeNull();
  });

  it('%b and %B read English month names, case-insensitively', () => {
    expect(parse('Oct', '%b').month).toBe(10);
    expect(parse('oct', '%b').month).toBe(10);
    expect(parse('OCT', '%b').month).toBe(10);
    expect(parse('October', '%B').month).toBe(10);
    expect(parse('may', '%B').month).toBe(5);
    expect(parse('May', '%b').month).toBe(5);
    expect(parse('September', '%B').month).toBe(9);
    expect(pyStrptime('Octo', '%b')).toBeNull();
    expect(pyStrptime('Oct', '%B')).toBeNull();
    expect(pyStrptime('Sept', '%b')).toBeNull();
    expect(parse('Dec 5 2026', '%b %d %Y')).toEqual({ ...BASE, year: 2026, month: 12, day: 5 });
  });

  it('%a and %A read English day names and ignore them', () => {
    expect(parse('Sun 2026-10-11', '%a %Y-%m-%d')).toEqual({ ...BASE, year: 2026, month: 10, day: 11 });
    expect(parse('sunday 2026-10-11', '%A %Y-%m-%d').day).toBe(11);
    expect(pyStrptime('Sonday 2026-10-11', '%A %Y-%m-%d')).toBeNull();
    expect(pyStrptime('Sunday', '%a')).toBeNull();
  });

  it('%j sets month and day from the day of year (default year 1900 is not a leap year)', () => {
    expect(parse('001', '%j')).toEqual({ ...BASE });
    expect(parse('59', '%j')).toEqual({ ...BASE, month: 2, day: 28 });
    expect(parse('060', '%j')).toEqual({ ...BASE, month: 3, day: 1 });
    expect(parse('2024 060', '%Y %j')).toEqual({ ...BASE, year: 2024, month: 2, day: 29 });
    expect(parse('2024 366', '%Y %j')).toEqual({ ...BASE, year: 2024, month: 12, day: 31 });
    expect(pyStrptime('000', '%j')).toBeNull();
    expect(pyStrptime('367', '%j')).toBeNull();
  });

  it('%j rolling over past year 9999 is rejected, as CPython does ("year must be in 1..9999")', () => {
    expect(parse('9999365', '%Y%j')).toEqual({ ...BASE, year: 9999, month: 12, day: 31 });
    expect(pyStrptime('9999366', '%Y%j')).toBeNull();
    expect(pyStrptime('366 9999', '%j %Y')).toBeNull();
    expect(parse('0001001', '%Y%j')).toEqual({ ...BASE, year: 1 });
  });

  it('%z reads Z and +HHMM / +HH:MM offsets in minutes', () => {
    expect(parse('Z', '%z').utcOffsetMin).toBe(0);
    expect(parse('+0530', '%z').utcOffsetMin).toBe(330);
    expect(parse('-05:00', '%z').utcOffsetMin).toBe(-300);
    expect(parse('+0000', '%z').utcOffsetMin).toBe(0);
    expect(parse('2026-10-11T07:05:09+07:00', '%Y-%m-%dT%H:%M:%S%z').utcOffsetMin).toBe(420);
    expect(pyStrptime('z', '%z')).toBeNull();
    expect(pyStrptime('+05', '%z')).toBeNull();
    expect(pyStrptime('0530', '%z')).toBeNull();
  });

  it('%z accepts seconds and a fraction like CPython 3.14, in whole minutes, and an offset of a day or more', () => {
    expect(parse('+05:30:15', '%z').utcOffsetMin).toBe(330);
    expect(parse('+053015', '%z').utcOffsetMin).toBe(330);
    expect(parse('-05:30:15.123456', '%z').utcOffsetMin).toBe(-330);
    expect(parse('+2400', '%z').utcOffsetMin).toBe(1440);
    expect(pyStrptime('+05:3015', '%z')).toBeNull();
    expect(pyStrptime('+0530:15', '%z')).toBeNull();
    expect(pyStrptime('+0560', '%z')).toBeNull();
  });

  it('%Z accepts only UTC and GMT and gives no offset', () => {
    expect(parse('UTC', '%Z').utcOffsetMin).toBeNull();
    expect(parse('gmt', '%Z').utcOffsetMin).toBeNull();
    expect(pyStrptime('EST', '%Z')).toBeNull();
    expect(pyStrptime('CEST', '%Z')).toBeNull();
  });

  it('%% matches one percent sign', () => {
    expect(parse('100% 07', '100%% %H').hour).toBe(7);
    expect(pyStrptime('100 07', '100%% %H')).toBeNull();
  });
});

describe('pyStrptime literals and whitespace', () => {
  it('matches literal characters case-insensitively and escapes regular expression characters', () => {
    expect(parse('DATE: 2026', 'date: %Y').year).toBe(2026);
    expect(parse('2026-10-11t07:05', '%Y-%m-%dT%H:%M').hour).toBe(7);
    expect(parse('a.b(1)+[x]*?|^$ 07', 'a.b(1)+[x]*?|^$ %H').hour).toBe(7);
    expect(pyStrptime('aXb 07', 'a.b %H')).toBeNull();
  });

  it('lets any run of whitespace in the format match one or more whitespace characters', () => {
    expect(parse('2026 \t 10', '%Y  %m').month).toBe(10);
    expect(parse('2026 10', '%Y \t%m').month).toBe(10);
    expect(pyStrptime('202610', '%Y %m')).toBeNull();
  });
});

describe('pyStrptime rejections', () => {
  it('returns null when text remains after the format (unconverted data)', () => {
    expect(pyStrptime('2026-10-11 07:05:09 extra', DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptime('2026-10-11 07:05:09 ', DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptime(' 2026-10-11 07:05:09', DEFAULT_FORMAT)).toBeNull();
  });

  it('returns null when the text is shorter than the format or empty', () => {
    expect(pyStrptime('2026-10-11', DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptime('', DEFAULT_FORMAT)).toBeNull();
  });

  it('validates the calendar like CPython: day must exist in that month and year', () => {
    expect(pyStrptime('2026-02-29 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2024-02-29 00:00:00', DEFAULT_FORMAT).day).toBe(29);
    expect(pyStrptime('1900-02-29 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2000-02-29 00:00:00', DEFAULT_FORMAT).day).toBe(29);
    expect(pyStrptime('2026-04-31 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptime('2026-06-31 00:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(parse('2026-12-31 23:59:59', DEFAULT_FORMAT).month).toBe(12);
  });

  it('accepts February 29th without a year (CPython uses a leap year to validate, then reports 1900)', () => {
    expect(parse('02-29', '%m-%d')).toEqual({ ...BASE, month: 2, day: 29 });
    expect(pyStrptime('02-30', '%m-%d')).toBeNull();
  });

  it('rejects an hour of 24 and a minute of 60', () => {
    expect(pyStrptime('2026-10-11 24:00:00', DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptime('2026-10-11 00:60:00', DEFAULT_FORMAT)).toBeNull();
  });

  it('throws PyStrptimeFormatError for an unsupported directive instead of returning null', () => {
    for (const directive of ['%X', '%c', '%x', '%U', '%W', '%w', '%u', '%G', '%V', '%e', '%-d', '%q']) {
      expect(() => pyStrptime('x', directive)).toThrow(PyStrptimeFormatError);
    }
    expect(() => pyStrptime('x', '%Y %X')).toThrow(/unsupported directive %X/);
  });

  it('throws for a stray percent sign at the end of the format', () => {
    expect(() => pyStrptime('2026%', '%Y%')).toThrow(PyStrptimeFormatError);
    expect(() => pyStrptime('', '%')).toThrow(/unsupported directive %/);
  });
});

describe('pyStrptimeValidate', () => {
  it('returns null for formats built only from supported directives', () => {
    expect(pyStrptimeValidate(DEFAULT_FORMAT)).toBeNull();
    expect(pyStrptimeValidate('%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%')).toBeNull();
    expect(pyStrptimeValidate('')).toBeNull();
    expect(pyStrptimeValidate('no directives at all')).toBeNull();
  });

  it('names the first unsupported directive and lists the supported ones', () => {
    expect(pyStrptimeValidate('%Y-%m-%d %X')).toBe(
      'attempts.time_format: unsupported directive %X (supported: %Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%)',
    );
  });

  it('reports a stray trailing percent sign as an unsupported directive', () => {
    expect(pyStrptimeValidate('%Y%')).toMatch(/^attempts\.time_format: unsupported directive % \(supported: /);
  });

  it('uses the key name the caller passes', () => {
    expect(pyStrptimeValidate('%q', 'config.attempts.time_format')).toMatch(
      /^config\.attempts\.time_format: unsupported directive %q /,
    );
  });

  it('agrees with pyStrptime about which formats throw', () => {
    for (const format of ['%Y', '%X', '%Y %q', '%%', '%', '%j']) {
      const message = pyStrptimeValidate(format);
      const throws = (() => {
        try {
          pyStrptime('', format);
          return false;
        } catch (error) {
          return error instanceof PyStrptimeFormatError;
        }
      })();
      expect(message !== null).toBe(throws);
    }
  });
});

describe('toEpochMs', () => {
  it('uses the host time zone when there is no offset (the suite runs with TZ=UTC)', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    expect(toEpochMs(parse('2026-01-01 00:00:00', DEFAULT_FORMAT))).toBe(1767225600000);
    expect(toEpochMs(parse('2026-10-11 07:05:09.250', `${DEFAULT_FORMAT}.%f`))).toBe(
      Date.UTC(2026, 9, 11, 7, 5, 9, 250),
    );
  });

  it('follows the host zone when TZ changes (local time like time.mktime)', () => {
    vi.stubEnv('TZ', 'Asia/Ho_Chi_Minh');
    const expected = Date.UTC(2026, 0, 1) - 7 * 3_600_000;
    expect(toEpochMs(parse('2026-01-01 00:00:00', DEFAULT_FORMAT))).toBe(expected);
  });

  it('applies an explicit offset instead of ignoring it (deliberate fix of the legacy %z behaviour)', () => {
    const fields = parse('2026-10-11 07:05:09 +0530', `${DEFAULT_FORMAT} %z`);
    expect(toEpochMs(fields)).toBe(Date.UTC(2026, 9, 11, 7, 5, 9) - 330 * 60_000);
    expect(toEpochMs(parse('2026-10-11 07:05:09 Z', `${DEFAULT_FORMAT} %z`))).toBe(Date.UTC(2026, 9, 11, 7, 5, 9));
    expect(toEpochMs(parse('2026-10-11 07:05:09 -05:00', `${DEFAULT_FORMAT} %z`))).toBe(
      Date.UTC(2026, 9, 11, 7, 5, 9) + 300 * 60_000,
    );
  });

  it('keeps years below 100 as they are (no 19xx mapping of the Date constructor)', () => {
    expect(toEpochMs(parse('0099-01-01 00:00:00 +0000', `${DEFAULT_FORMAT} %z`))).toBe(
      Date.parse('0099-01-01T00:00:00.000Z'),
    );
    expect(toEpochMs(parse('0099-01-01 00:00:00', DEFAULT_FORMAT))).toBe(Date.parse('0099-01-01T00:00:00.000Z'));
  });
});
