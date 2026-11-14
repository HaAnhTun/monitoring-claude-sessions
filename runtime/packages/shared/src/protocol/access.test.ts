// The login URL helpers (06 1.8, amendment A1): one host literal, one fragment key, one code alphabet.
import { describe, expect, it } from 'vitest';

import {
  ACCESS_CODE_RE,
  ACCESS_CODE_TTL_SECONDS,
  LOGIN_URL_RE,
  appBrowserUrl,
  buildLoginUrl,
  parseLoginFragment,
} from './access.ts';

const CODE = 'Ab3_-'.repeat(8); // 40 characters
const NL = String.fromCharCode(10);
const E_ACUTE = String.fromCharCode(0xe9);
const A31 = 'a'.repeat(31);

describe('ACCESS_CODE_RE', () => {
  it('takes 32 to 128 characters of the URL-safe alphabet', () => {
    expect(ACCESS_CODE_RE.test('a'.repeat(32))).toBe(true);
    expect(ACCESS_CODE_RE.test('a'.repeat(128))).toBe(true);
    expect(ACCESS_CODE_RE.test(CODE)).toBe(true);
    expect(ACCESS_CODE_RE.test(A31)).toBe(false);
    expect(ACCESS_CODE_RE.test('a'.repeat(129))).toBe(false);
    expect(ACCESS_CODE_RE.test('')).toBe(false);
  });

  it('refuses characters outside the alphabet and a trailing newline', () => {
    expect(ACCESS_CODE_RE.test('a'.repeat(32) + NL)).toBe(false);
    expect(ACCESS_CODE_RE.test(A31 + '=')).toBe(false);
    expect(ACCESS_CODE_RE.test(A31 + '/')).toBe(false);
    expect(ACCESS_CODE_RE.test(A31 + ' ')).toBe(false);
    expect(ACCESS_CODE_RE.test(A31 + E_ACUTE)).toBe(false);
  });

  it('lives 120 seconds', () => {
    expect(ACCESS_CODE_TTL_SECONDS).toBe(120);
  });
});

describe('appBrowserUrl', () => {
  it('names the loopback address, never localhost', () => {
    expect(appBrowserUrl(7690)).toBe('http://127.0.0.1:7690/');
    expect(appBrowserUrl(1)).toBe('http://127.0.0.1:1/');
    expect(appBrowserUrl(65535)).toBe('http://127.0.0.1:65535/');
    expect(appBrowserUrl(18000)).not.toContain('localhost');
  });

  it('refuses a port that is not an integer from 1 to 65535', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      expect(() => appBrowserUrl(port), String(port)).toThrow(RangeError);
    }
  });
});

describe('buildLoginUrl', () => {
  it('puts the code in the fragment under the key `code`', () => {
    expect(buildLoginUrl(7690, CODE)).toBe('http://127.0.0.1:7690/#code=' + CODE);
  });

  it('pins the prefix: 127.0.0.1 only, so a squatter on [::1] never receives the code (06 A1)', () => {
    const url = buildLoginUrl(18123, CODE);
    expect(url.startsWith('http://127.0.0.1:18123/#code=')).toBe(true);
    expect(url).not.toContain('localhost');
    expect(url).not.toContain('[::1]');
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(new URL(url).search).toBe('');
  });

  it('refuses a bad port and a code outside ACCESS_CODE_RE', () => {
    expect(() => buildLoginUrl(0, CODE)).toThrow(RangeError);
    expect(() => buildLoginUrl(65536, CODE)).toThrow(RangeError);
    expect(() => buildLoginUrl(80.5, CODE)).toThrow(RangeError);
    expect(() => buildLoginUrl(7690, A31)).toThrow(RangeError);
    expect(() => buildLoginUrl(7690, 'a'.repeat(129))).toThrow(RangeError);
    expect(() => buildLoginUrl(7690, A31 + '&')).toThrow(RangeError);
    expect(() => buildLoginUrl(7690, '')).toThrow(RangeError);
  });

  it('does not put the code into the error message', () => {
    const secret = 's'.repeat(31) + '&';
    let message = '';
    try {
      buildLoginUrl(7690, secret);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secret);
  });
});

describe('LOGIN_URL_RE', () => {
  it('matches what the builders produce', () => {
    expect(LOGIN_URL_RE.test(appBrowserUrl(7690))).toBe(true);
    expect(LOGIN_URL_RE.test(buildLoginUrl(7690, CODE))).toBe(true);
    expect(LOGIN_URL_RE.test(buildLoginUrl(65535, 'a'.repeat(128)))).toBe(true);
  });

  it('refuses localhost, another scheme, another path, a short or long code, an extra fragment key and a bad port', () => {
    const bad = [
      'http://localhost:7690/#code=' + CODE,
      'https://127.0.0.1:7690/#code=' + CODE,
      'http://127.0.0.1:7690/login#code=' + CODE,
      'http://127.0.0.1:7690/?x=1#code=' + CODE,
      'http://127.0.0.1:7690/#code=' + A31,
      'http://127.0.0.1:7690/#code=' + 'a'.repeat(129),
      'http://127.0.0.1:7690/#code=' + CODE + '&x=1',
      'http://127.0.0.1:7690/#x=1&code=' + CODE,
      'http://127.0.0.1:/#code=' + CODE,
      'http://127.0.0.1:123456/#code=' + CODE,
      'http://127.0.0.1/#code=' + CODE,
      'http://127.0.0.10:7690/#code=' + CODE,
      buildLoginUrl(7690, CODE) + NL,
    ];
    for (const url of bad) expect(LOGIN_URL_RE.test(url), url).toBe(false);
  });
});

describe('parseLoginFragment', () => {
  it('returns the code of `#code=<code>`', () => {
    expect(parseLoginFragment('#code=' + CODE)).toBe(CODE);
    expect(parseLoginFragment('#code=' + 'a'.repeat(32))).toBe('a'.repeat(32));
    expect(parseLoginFragment('#code=' + 'a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('returns null for everything else', () => {
    const bad = [
      '',
      '#',
      '#code=',
      CODE,
      'code=' + CODE,
      '#' + CODE,
      '#Code=' + CODE,
      '#codes=' + CODE,
      '# code=' + CODE,
      '#code=' + A31,
      '#code=' + 'a'.repeat(129),
      '#code=' + CODE + '&x=1',
      '#x=1&code=' + CODE,
      '#code=' + CODE + '&code=' + CODE,
      '#code=' + CODE + '#code=' + CODE,
      '#code=' + CODE + NL,
      '#code=' + A31 + '%41',
      '#code=' + A31 + '=',
    ];
    for (const hash of bad) expect(parseLoginFragment(hash), hash).toBeNull();
  });

  it('round-trips with buildLoginUrl through URL.hash', () => {
    const url = new URL(buildLoginUrl(7690, CODE));
    expect(parseLoginFragment(url.hash)).toBe(CODE);
  });
});
