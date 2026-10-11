// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  LEGACY_PREFS_KEY,
  PREFS_KEY,
  buildHash,
  createPrefs,
  parseHash,
  safeLocalStorage,
  sanitize,
  type StorageLike,
} from './prefs.ts';

class MemStorage implements StorageLike {
  readonly m = new Map<string, string>();
  readonly writes: string[] = [];
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k, v);
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.writes.push(k);
    this.m.set(k, v);
  }
}

const throwing: StorageLike = {
  getItem(): string | null {
    throw new Error('denied');
  },
  setItem(): void {
    throw new Error('quota');
  },
};

describe('prefs', () => {
  it('legacy: prefs persist known keys and reject bad values', () => {
    const st = new MemStorage();
    const p = createPrefs(st);
    expect(p.get('theme', 'auto')).toBe('auto');
    expect(p.set('theme', 'dark')).toBe(true);
    expect(p.set('theme', 'neon' as never)).toBe(false);
    expect(p.set('apiKey' as never, 'x' as never)).toBe(false);
    expect(p.set('lastInstanceId', 'abc')).toBe(true);
    const q = createPrefs(st);
    expect(q.get('theme')).toBe('dark');
    expect(q.get('lastInstanceId')).toBe('abc');
    expect(st.m.has(PREFS_KEY)).toBe(true);
  });

  it('legacy: prefs survive storage that throws on read and write', () => {
    const p = createPrefs(throwing);
    expect(p.get('density', 'comfortable')).toBe('comfortable');
    expect(p.set('density', 'compact')).toBe(false); // not persisted ...
    expect(p.get('density')).toBe('compact'); // ... but kept in memory
    expect(p.persistent).toBe(false);
  });

  it('legacy: prefs survive missing storage and corrupt JSON', () => {
    expect(createPrefs(null).get('theme', 'auto')).toBe('auto');
    const bad = new MemStorage({ [PREFS_KEY]: '{not json' });
    expect(createPrefs(bad).get('theme', 'auto')).toBe('auto');
    expect(sanitize({ theme: 5, density: 'compact', evil: 1, sel: { sid: 3 } })).toEqual({ density: 'compact' });
    expect(sanitize([1, 2])).toEqual({});
    expect(sanitize(null)).toEqual({});
    expect(sanitize('text')).toEqual({});
  });

  it('legacy: hash round trip', () => {
    expect(parseHash('#sid=abc-123&agent=a%2Fb')).toEqual({ sid: 'abc-123', agent: 'a/b' });
    expect(parseHash('')).toEqual({ sid: '', agent: '' });
    expect(buildHash({ sid: 'x y', agent: '' })).toBe('#sid=x+y');
    expect(buildHash({ sid: '', agent: 'a' })).toBe('');
    const h = buildHash({ sid: 's1', agent: 'ag 2' });
    expect(parseHash(h)).toEqual({ sid: 's1', agent: 'ag 2' });
  });

  it('hash values are capped at 200 characters', () => {
    const long = 'x'.repeat(300);
    const parsed = parseHash(`#sid=${long}&agent=${long}`);
    expect(parsed.sid).toHaveLength(200);
    expect(parsed.agent).toHaveLength(200);
  });

  it('validators: every known field accepts its shape and drops everything else', () => {
    const good = {
      theme: 'light',
      density: 'compact',
      newestFirst: true,
      showAll: false,
      filter: 'planner',
      kinds: { prompt: true, say: false },
      collapsed: { 'g:s1:': true },
      navOpen: true,
      lastInstanceId: 'inst-1',
    };
    expect(sanitize(good)).toEqual(good);
    expect(sanitize({ ...good, filter: 'x'.repeat(401) }).filter).toBeUndefined();
    expect(sanitize({ filter: 'x'.repeat(400) }).filter).toHaveLength(400);
    expect(sanitize({ lastInstanceId: 'x'.repeat(65) }).lastInstanceId).toBeUndefined();
    expect(sanitize({ kinds: { bogus: true } }).kinds).toBeUndefined();
    expect(sanitize({ kinds: { prompt: 'yes' } }).kinds).toBeUndefined();
    expect(sanitize({ kinds: [true] }).kinds).toBeUndefined();
    expect(sanitize({ collapsed: { a: 1 } }).collapsed).toBeUndefined();
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, true]));
    expect(sanitize({ collapsed: many }).collapsed).toBeUndefined();
    expect(sanitize({ navOpen: 'yes' }).navOpen).toBeUndefined();
    expect(sanitize({ theme: 'auto' }).theme).toBe('auto');
  });

  it('unknown v3 keys are dropped, including the legacy selection (selection is the URL now)', () => {
    const st = new MemStorage({
      [PREFS_KEY]: JSON.stringify({ theme: 'dark', sel: { sid: 'abc', agent: '' }, extra: 1 }),
    });
    const p = createPrefs(st);
    expect(p.all()).toEqual({ theme: 'dark' });
    expect(p.set('density', 'compact')).toBe(true);
    expect(JSON.parse(st.m.get(PREFS_KEY) ?? '{}')).toEqual({ theme: 'dark', density: 'compact' });
  });

  it('imports the legacy v1 key once, writes only the v3 key and never writes v1', () => {
    const legacy = JSON.stringify({ theme: 'dark', filter: 'abc', sel: { sid: 'old', agent: '' }, bogus: 1 });
    const st = new MemStorage({ [LEGACY_PREFS_KEY]: legacy });
    const first = createPrefs(st);
    expect(first.all()).toEqual({ theme: 'dark', filter: 'abc' });
    expect(JSON.parse(st.m.get(PREFS_KEY) ?? '{}')).toEqual({ theme: 'dark', filter: 'abc' });
    expect(st.writes).toEqual([PREFS_KEY]);
    expect(st.m.get(LEGACY_PREFS_KEY)).toBe(legacy);
    // a later change to v1 is not imported again
    st.m.set(LEGACY_PREFS_KEY, JSON.stringify({ theme: 'light' }));
    const second = createPrefs(st);
    expect(second.get('theme')).toBe('dark');
    expect(second.set('navOpen', true)).toBe(true);
    expect(st.writes.every((k) => k === PREFS_KEY)).toBe(true);
    expect(st.m.get(LEGACY_PREFS_KEY)).toBe(JSON.stringify({ theme: 'light' }));
  });

  it('a v3 value wins over the legacy key and a corrupt legacy key is ignored', () => {
    const both = new MemStorage({
      [PREFS_KEY]: JSON.stringify({ theme: 'light' }),
      [LEGACY_PREFS_KEY]: JSON.stringify({ theme: 'dark' }),
    });
    expect(createPrefs(both).get('theme')).toBe('light');
    const corrupt = new MemStorage({ [LEGACY_PREFS_KEY]: '{not json' });
    const p = createPrefs(corrupt);
    expect(p.all()).toEqual({});
    expect(corrupt.writes).toEqual([]);
  });

  it('nothing is written when there is nothing to import', () => {
    const st = new MemStorage();
    createPrefs(st);
    expect(st.writes).toEqual([]);
  });

  it('safeLocalStorage returns null when the global is missing or throws', () => {
    expect(safeLocalStorage()).toBeNull();
  });
});
