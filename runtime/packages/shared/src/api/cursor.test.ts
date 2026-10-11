import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CURSOR_MAX_LENGTH,
  cursorMatches,
  decodeCursor,
  encodeCursor,
  filterHash,
  type CursorPayload,
} from './cursor.ts';

const base: Omit<CursorPayload, 'v'> = {
  r: 'listSessions',
  s: 'lastActivity',
  d: 'desc',
  k: 1_780_000_000_123,
  i: 4711,
  w: [1_779_000_000_000, 1_780_000_000_001],
  f: filterHash({ q: 'abc', state: ['working'] }),
};

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha12(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

describe('cursor codec (03 5.3)', () => {
  it('round trips and is base64url without padding', () => {
    const text = encodeCursor(base);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    expect(decodeCursor(text)).toEqual({ v: 1, ...base });
  });

  it('carries the documented JSON keys in the payload', () => {
    const json = atob(encodeCursor(base).replace(/-/g, '+').replace(/_/g, '/'));
    expect(Object.keys(JSON.parse(json) as object)).toEqual(['v', 'r', 's', 'd', 'k', 'i', 'w', 'f']);
  });

  it('round trips string keys, non-ASCII text and a null window', () => {
    const payload = { ...base, s: 'label', d: 'asc' as const, k: 'Tiếng Việt - 日本語 😀', w: null };
    expect(decodeCursor(encodeCursor(payload))).toEqual({ v: 1, ...payload });
  });

  it('refuses to encode more than 512 characters', () => {
    expect(() => encodeCursor({ ...base, k: 'x'.repeat(600) })).toThrow(RangeError);
  });

  it('decodes hostile input to null and never throws', () => {
    const bad = [
      '',
      'not base64 !!',
      'AAAA',
      'e30',
      base64Url('{"v":2,"r":"a","s":"b","d":"asc","k":1,"i":1,"w":null,"f":"0123456789ab"}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"up","k":1,"i":1,"w":null,"f":"0123456789ab"}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"asc","k":1,"i":1.5,"w":null,"f":"0123456789ab"}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"asc","k":1,"i":1,"w":[1],"f":"0123456789ab"}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"asc","k":1,"i":1,"w":null,"f":"XYZ"}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"asc","k":1,"i":1,"w":null,"f":"0123456789ab","extra":1}'),
      base64Url('{"v":1,"r":"a","s":"b","d":"asc","k":true,"i":1,"w":null,"f":"0123456789ab"}'),
      'x'.repeat(CURSOR_MAX_LENGTH + 1),
    ];
    for (const text of bad) expect(decodeCursor(text), text.slice(0, 30)).toBeNull();
  });

  it('matches only when route, sort, direction and filter hash agree (else 400 cursor_invalid)', () => {
    const c = decodeCursor(encodeCursor(base));
    expect(c).not.toBeNull();
    if (c === null) return;
    const want = { r: base.r, s: base.s, d: base.d, f: base.f };
    expect(cursorMatches(c, want)).toBe(true);
    expect(cursorMatches(c, { ...want, r: 'listAgents' })).toBe(false);
    expect(cursorMatches(c, { ...want, s: 'started' })).toBe(false);
    expect(cursorMatches(c, { ...want, d: 'asc' })).toBe(false);
    expect(cursorMatches(c, { ...want, f: filterHash({ q: 'other' }) })).toBe(false);
  });
});

describe('filterHash', () => {
  it('is 12 lowercase hex characters and ignores key order', () => {
    const a = filterHash({ q: 'x', state: ['a', 'b'] });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(filterHash({ state: ['a', 'b'], q: 'x' })).toBe(a);
  });

  it('changes with the filter, not with paging keys', () => {
    const a = filterHash({ q: 'x' });
    expect(filterHash({ q: 'y' })).not.toBe(a);
    expect(filterHash({ q: 'x', limit: 10, cursor: 'abc', includeTotal: true, sort: 'label', dir: 'asc' })).toBe(a);
    expect(filterHash({ q: 'x', state: ['a'] })).not.toBe(a);
  });

  it('is the first 12 hex characters of the SHA-256 of the canonical JSON (checked with node:crypto)', () => {
    expect(filterHash({ q: 'x' })).toBe(sha12('{"q":"x"}'));
    expect(filterHash({ b: [1, 2], a: 'é' })).toBe(sha12('{"a":"é","b":[1,2]}'));
  });
});
