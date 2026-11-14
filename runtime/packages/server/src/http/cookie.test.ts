// The session cookie (CAW design 02 4.3, A2, ADR 0084): the name by instance, the exact bytes of the two headers, and a strict
// parser that reads only its own name. Pure functions: no server here.
import { ACCESS_LIMITS } from '@mcs/engine';
import { describe, expect, it } from 'vitest';

import {
  COOKIE_HEADER_MAX_CHARS,
  COOKIE_MAX_AGE_SECONDS,
  clearCookieHeader,
  cookieName,
  cookieValue,
  setCookieHeader,
} from './cookie.ts';

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const OTHER_INSTANCE = '1c7a1a5f-7d2f-4b57-8e1b-1b6c4a8d0f22';
const NAME = 'caw_0b6f0f4e';
const OTHER_NAME = 'caw_1c7a1a5f';
const CREDENTIAL = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCde';
const SECOND_CREDENTIAL = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwV';
// Characters outside the base64url alphabet, built from their code points so that this file stays ASCII.
const E_ACUTE = String.fromCharCode(0xe9);
const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);

describe('cookieName', () => {
  it('is caw_ and the first eight hex characters of the instance id', () => {
    expect(cookieName(INSTANCE)).toBe(NAME);
    expect(cookieName(OTHER_INSTANCE)).toBe(OTHER_NAME);
  });

  it('refuses a value that is not a lowercase uuid v4, without repeating it', () => {
    for (const bad of ['', 'caw', INSTANCE.toUpperCase(), `${INSTANCE} `, INSTANCE.slice(1), 'x'.repeat(36)]) {
      expect(() => cookieName(bad)).toThrow(RangeError);
      try {
        cookieName(bad);
      } catch (error) {
        expect(error instanceof Error ? error.message : '').not.toContain('xxxx');
      }
    }
  });
});

describe('setCookieHeader (TC-SEC-05, A2)', () => {
  it('is these bytes and no others', () => {
    expect(setCookieHeader(CREDENTIAL, INSTANCE)).toBe(
      `caw_0b6f0f4e=${CREDENTIAL}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    );
  });

  it('has no Domain, no Secure, no Expires and exactly the attributes that were decided', () => {
    const header = setCookieHeader(CREDENTIAL, INSTANCE);
    expect(header.split('; ').slice(1)).toEqual(['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=86400']);
    for (const absent of ['Domain', 'Secure', 'Expires', 'Partitioned', 'SameSite=Lax']) {
      expect(header).not.toContain(absent);
    }
  });

  it('lives as long as the credential: 24 hours', () => {
    expect(COOKIE_MAX_AGE_SECONDS).toBe(86_400);
    expect(COOKIE_MAX_AGE_SECONDS * 1000).toBe(ACCESS_LIMITS.credentialMaxAgeMs);
  });

  it('refuses a value that is not a credential, so that nothing can ride along in the header', () => {
    for (const bad of [
      '',
      'short',
      `${CREDENTIAL}x`,
      CREDENTIAL.slice(1),
      `${CREDENTIAL.slice(0, 40)}; a=`,
      `${CREDENTIAL.slice(0, 41)}\r\n`,
      `${CREDENTIAL.slice(0, 42)}=`,
      `${CREDENTIAL.slice(0, 42)}+`,
    ]) {
      expect(() => setCookieHeader(bad, INSTANCE), bad).toThrow(RangeError);
    }
  });

  it('keeps the credential out of the message of a refusal', () => {
    const wrong = `${CREDENTIAL.slice(0, 40)};x=1`;
    try {
      setCookieHeader(wrong, INSTANCE);
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(CREDENTIAL.slice(0, 20));
    }
    expect.assertions(1);
  });
});

describe('clearCookieHeader', () => {
  it('is the same name and attributes with an empty value and Max-Age=0', () => {
    expect(clearCookieHeader(INSTANCE)).toBe('caw_0b6f0f4e=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  });

  it('clears the cookie that setCookieHeader sets: same name, same path', () => {
    const set = setCookieHeader(CREDENTIAL, INSTANCE).split('; ');
    const cleared = clearCookieHeader(INSTANCE).split('; ');
    expect(set[0]?.split('=')[0]).toBe(cleared[0]?.split('=')[0]);
    expect(set.slice(1, 4)).toEqual(cleared.slice(1, 4));
  });
});

describe('cookieValue: the parser (TC-SEC-06)', () => {
  it('reads the value of its own name', () => {
    expect(cookieValue(`${NAME}=${CREDENTIAL}`, NAME)).toBe(CREDENTIAL);
  });

  it('finds it among other cookies, with or without spaces and tabs around them', () => {
    expect(cookieValue(`theme=dark; ${NAME}=${CREDENTIAL}; lang=en`, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`a=1;${NAME}=${CREDENTIAL};b=2`, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`a=1;\t${NAME}=${CREDENTIAL}\t;b=2`, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`  ${NAME}=${CREDENTIAL}  `, NAME)).toBe(CREDENTIAL);
  });

  it('ignores the cookie of another instance, and reads only its own when both are there', () => {
    expect(cookieValue(`${OTHER_NAME}=${CREDENTIAL}`, NAME)).toBeNull();
    expect(cookieValue(`${OTHER_NAME}=${SECOND_CREDENTIAL}; ${NAME}=${CREDENTIAL}`, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`${NAME}=${CREDENTIAL}; ${OTHER_NAME}=${SECOND_CREDENTIAL}`, OTHER_NAME)).toBe(
      SECOND_CREDENTIAL,
    );
    expect(cookieValue(`${NAME}=${CREDENTIAL}; ${OTHER_NAME}=${SECOND_CREDENTIAL}`, NAME)).toBe(CREDENTIAL);
  });

  it('takes the first cookie of the name, even when a later one is valid and the first is not', () => {
    expect(cookieValue(`${NAME}=${CREDENTIAL}; ${NAME}=${SECOND_CREDENTIAL}`, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`${NAME}=junk; ${NAME}=${SECOND_CREDENTIAL}`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=; ${NAME}=${SECOND_CREDENTIAL}`, NAME)).toBeNull();
  });

  it('treats a name that merely contains or extends its own as another cookie', () => {
    for (const name of [`x${NAME}`, `${NAME}x`, `${NAME}2`, NAME.toUpperCase(), NAME.slice(1), `${NAME} `]) {
      expect(cookieValue(`${name}=${CREDENTIAL}`, NAME), name).toBeNull();
    }
    expect(cookieValue(`${NAME}x=${CREDENTIAL}; ${NAME}=${SECOND_CREDENTIAL}`, NAME)).toBe(SECOND_CREDENTIAL);
  });

  it('reads nothing from junk', () => {
    for (const header of [
      '',
      ';',
      ';;;',
      '=',
      NAME,
      `${NAME}=`,
      `=${CREDENTIAL}`,
      `${NAME}:${CREDENTIAL}`,
      `${NAME} = ${CREDENTIAL}`,
      `${NAME}=${LEFT_QUOTE}${CREDENTIAL}${RIGHT_QUOTE}`,
      `${NAME}="${CREDENTIAL}"`,
      `${NAME}=${CREDENTIAL},${SECOND_CREDENTIAL}`,
      `${NAME}=${CREDENTIAL} ${SECOND_CREDENTIAL}`,
    ]) {
      expect(cookieValue(header, NAME), header).toBeNull();
    }
  });

  it('wants a credential: exactly 43 base64url characters', () => {
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(1)}`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL}A`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(0, 42)}+`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(0, 42)}/`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(0, 42)}=`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(0, 42)}%`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${CREDENTIAL.slice(0, 42)}${E_ACUTE}`, NAME)).toBeNull();
    expect(cookieValue(`${NAME}=${'-'.repeat(43)}`, NAME)).toBe('-'.repeat(43));
    expect(cookieValue(`${NAME}=${'_'.repeat(43)}`, NAME)).toBe('_'.repeat(43));
  });

  it('treats a header over 4 KiB as absent, even when the cookie comes first', () => {
    const padding = `; pad=${'x'.repeat(COOKIE_HEADER_MAX_CHARS)}`;
    expect(cookieValue(`${NAME}=${CREDENTIAL}${padding}`, NAME)).toBeNull();
    const exact = `${NAME}=${CREDENTIAL}; pad=`;
    const atLimit = `${exact}${'x'.repeat(COOKIE_HEADER_MAX_CHARS - exact.length)}`;
    expect(atLimit).toHaveLength(COOKIE_HEADER_MAX_CHARS);
    expect(cookieValue(atLimit, NAME)).toBe(CREDENTIAL);
    expect(cookieValue(`${atLimit}x`, NAME)).toBeNull();
  });

  it('reads nothing when there is no header, or when the header is not a string', () => {
    expect(cookieValue(undefined, NAME)).toBeNull();
    expect(cookieValue(null as unknown as string, NAME)).toBeNull();
    expect(cookieValue(42 as unknown as string, NAME)).toBeNull();
  });

  it('reads back what setCookieHeader wrote, as a browser would send it', () => {
    const sent = setCookieHeader(CREDENTIAL, INSTANCE).split('; ')[0] ?? '';
    expect(cookieValue(sent, cookieName(INSTANCE))).toBe(CREDENTIAL);
    expect(cookieValue(sent, cookieName(OTHER_INSTANCE))).toBeNull();
  });
});
