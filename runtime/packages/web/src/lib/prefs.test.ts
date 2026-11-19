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

describe('language and table columns (ADR 0072, ADR 0073)', () => {
  it('accepts the three language values and drops everything else', () => {
    for (const locale of ['auto', 'en', 'vi'] as const) expect(sanitize({ locale }).locale).toBe(locale);
    for (const locale of ['fr', 'VI', '', 5, null, ['vi'], { vi: true }]) {
      expect(sanitize({ locale }).locale).toBeUndefined();
    }
  });

  it('stores the language through set and reads it back from storage', () => {
    const st = new MemStorage();
    const p = createPrefs(st);
    expect(p.get('locale', 'auto')).toBe('auto');
    expect(p.set('locale', 'vi')).toBe(true);
    expect(p.set('locale', 'klingon' as never)).toBe(false);
    expect(p.get('locale')).toBe('vi');
    expect(createPrefs(st).get('locale')).toBe('vi');
    expect(JSON.parse(st.m.get(PREFS_KEY) ?? '{}')).toEqual({ locale: 'vi' });
  });

  it('accepts a map of column ids per table', () => {
    const good = { sessions: ['state', 'session', 'last-activity'], tasks: [] };
    expect(sanitize({ tableColumns: good }).tableColumns).toEqual(good);
    expect(sanitize({ tableColumns: {} }).tableColumns).toEqual({});
  });

  it('rejects a column map of the wrong shape', () => {
    const bad: unknown[] = [
      'sessions',
      ['state'],
      null,
      { sessions: 'state' },
      { sessions: [1, 2] },
      { sessions: [''] },
      { sessions: ['has space'] },
      { sessions: ['x'.repeat(65)] },
      { '': ['state'] },
      { 'bad key': ['state'] },
      { sessions: Array.from({ length: 41 }, (_, i) => `c${String(i)}`) },
      Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`t${String(i)}`, ['a']])),
    ];
    for (const tableColumns of bad) expect(sanitize({ tableColumns }).tableColumns).toBeUndefined();
  });

  it('rejects the names that could reach the prototype', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const parsed: unknown = JSON.parse(`{"${name}": ["a"]}`);
      expect(sanitize({ tableColumns: parsed }).tableColumns).toBeUndefined();
      expect(sanitize({ tableColumns: { sessions: [name] } }).tableColumns).toBeUndefined();
    }
  });

  it('drops keys of the old versions and still keeps the old fields intact', () => {
    const st = new MemStorage({
      [PREFS_KEY]: JSON.stringify({
        theme: 'dark',
        sel: { sid: 'x', agent: '' },
        lang: 'vi',
        columns: ['state'],
        locale: 'vi',
        tableColumns: { sessions: ['state'] },
      }),
    });
    const p = createPrefs(st);
    expect(p.all()).toEqual({ theme: 'dark', locale: 'vi', tableColumns: { sessions: ['state'] } });
  });

  it('does not import language or columns from the legacy key by accident when they are invalid', () => {
    const st = new MemStorage({
      [LEGACY_PREFS_KEY]: JSON.stringify({ theme: 'light', locale: 'xx', tableColumns: 3 }),
    });
    expect(createPrefs(st).all()).toEqual({ theme: 'light' });
  });

  describe('clear (the reset of the display preferences)', () => {
    it('empties the stored value, keeps the named preferences and leaves every other key alone', () => {
      const st = new MemStorage({
        other: 'untouched',
        [LEGACY_PREFS_KEY]: JSON.stringify({ theme: 'light' }),
        [PREFS_KEY]: JSON.stringify({ theme: 'dark', density: 'compact', lastInstanceId: 'iid-1' }),
      });
      const p = createPrefs(st);
      expect(p.clear(['lastInstanceId'])).toBe(true);
      expect(p.all()).toEqual({ lastInstanceId: 'iid-1' });
      expect(JSON.parse(st.m.get(PREFS_KEY) ?? 'null')).toEqual({ lastInstanceId: 'iid-1' });
      expect(st.m.get('other')).toBe('untouched');
      expect(st.m.get(LEGACY_PREFS_KEY)).toBe(JSON.stringify({ theme: 'light' }));
      expect(st.writes.every((key) => key === PREFS_KEY)).toBe(true);
    });

    it('clears everything without a keep list, and a later load does not import the legacy key again', () => {
      const st = new MemStorage({ [PREFS_KEY]: JSON.stringify({ theme: 'dark' }) });
      const p = createPrefs(st);
      expect(p.clear()).toBe(true);
      expect(p.all()).toEqual({});
      expect(createPrefs(st).all()).toEqual({});
    });

    it('empties memory and reports false when storage refuses the write', () => {
      const p = createPrefs(throwing);
      p.set('theme', 'dark');
      expect(p.clear()).toBe(false);
      expect(p.all()).toEqual({});
      expect(createPrefs(null).clear()).toBe(false);
    });
  });
});

describe('the Workspace preferences (design 04 sections 2.2, 2.4, 6.2 and 6.5)', () => {
  const hashed = (n: number): string => `f_${n.toString(16).padStart(13, '0')}`;

  it('workspaceOpen keeps the open or closed choice per hashed folder key, at most 300 of them', () => {
    const good = { [hashed(1)]: true, [hashed(2)]: false };
    expect(sanitize({ workspaceOpen: good }).workspaceOpen).toEqual(good);
    expect(sanitize({ workspaceOpen: {} }).workspaceOpen).toEqual({});
    const entries = (count: number): Record<string, boolean> =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [hashed(i), i % 2 === 0]));
    expect(Object.keys(sanitize({ workspaceOpen: entries(300) }).workspaceOpen ?? {})).toHaveLength(300);
    expect(sanitize({ workspaceOpen: entries(301) }).workspaceOpen).toBeUndefined();
  });

  it('workspaceOpen rejects a value of the wrong shape, a long or odd key and the names of the prototype', () => {
    const bad: unknown[] = [
      'open',
      [true],
      null,
      7,
      { [hashed(1)]: 1 },
      { [hashed(1)]: 'yes' },
      { [hashed(1)]: null },
      { '': true },
      { 'has space': true },
      { 'a/b': true },
      { ['f_'.padEnd(65, 'a')]: true },
      { [`caf${String.fromCharCode(0xe9)}`]: true },
    ];
    for (const workspaceOpen of bad) expect(sanitize({ workspaceOpen }).workspaceOpen).toBeUndefined();
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const parsed: unknown = JSON.parse(`{"${name}": true}`);
      expect(sanitize({ workspaceOpen: parsed }).workspaceOpen).toBeUndefined();
    }
  });

  it('lastTerminal is a terminal name of the server pattern, or empty once it was cleared', () => {
    for (const lastTerminal of ['repo-1', 'A_b-9', 'x'.repeat(64), '']) {
      expect(sanitize({ lastTerminal }).lastTerminal, lastTerminal).toBe(lastTerminal);
    }
    const odd = [`a${String.fromCharCode(92)}b`, `caf${String.fromCharCode(0xe9)}`];
    for (const lastTerminal of ['x'.repeat(65), 'a b', 'a.b', 'a/b', ...odd, '..', 5, null, ['a'], { a: 1 }]) {
      expect(sanitize({ lastTerminal }).lastTerminal, JSON.stringify(lastTerminal)).toBeUndefined();
    }
  });

  it('workspaceCollapsed and terminalScreenReader are booleans', () => {
    expect(sanitize({ workspaceCollapsed: true, terminalScreenReader: false })).toEqual({
      workspaceCollapsed: true,
      terminalScreenReader: false,
    });
    for (const value of ['true', 1, 0, null, [], {}]) {
      expect(sanitize({ workspaceCollapsed: value }).workspaceCollapsed).toBeUndefined();
      expect(sanitize({ terminalScreenReader: value }).terminalScreenReader).toBeUndefined();
    }
  });

  it('the four terminal preferences of CAW-144 take only their own values', () => {
    expect(
      sanitize({
        terminalRenderer: 'dom',
        terminalCursor: 'bar',
        terminalRightClick: 'menu',
        terminalCopyOnSelect: true,
      }),
    ).toEqual({
      terminalRenderer: 'dom',
      terminalCursor: 'bar',
      terminalRightClick: 'menu',
      terminalCopyOnSelect: true,
    });
    for (const value of ['auto', 'dom']) expect(sanitize({ terminalRenderer: value }).terminalRenderer).toBe(value);
    for (const value of ['block', 'bar', 'underline'])
      expect(sanitize({ terminalCursor: value }).terminalCursor).toBe(value);
    for (const value of ['smart', 'menu'])
      expect(sanitize({ terminalRightClick: value }).terminalRightClick).toBe(value);
    for (const value of ['webgl', 'gpu', 'AUTO', '', 1, true, null, [], {}]) {
      expect(sanitize({ terminalRenderer: value }).terminalRenderer, JSON.stringify(value)).toBeUndefined();
    }
    for (const value of ['beam', 'Block', '', 1, true, null, [], {}]) {
      expect(sanitize({ terminalCursor: value }).terminalCursor, JSON.stringify(value)).toBeUndefined();
    }
    for (const value of ['copy', 'paste', 'Smart', '', 1, true, null, [], {}]) {
      expect(sanitize({ terminalRightClick: value }).terminalRightClick, JSON.stringify(value)).toBeUndefined();
    }
    for (const value of ['true', 1, 0, null, [], {}]) {
      expect(sanitize({ terminalCopyOnSelect: value }).terminalCopyOnSelect, JSON.stringify(value)).toBeUndefined();
    }
    expect(sanitize({ terminalRendererX: 'dom', terminalCursors: 'bar' })).toEqual({});
  });

  it('keeps the four terminal preferences through set and a reload, and rejects a wrong value', () => {
    const st = new MemStorage();
    const p = createPrefs(st);
    expect(p.set('terminalRenderer', 'dom')).toBe(true);
    expect(p.set('terminalCursor', 'underline')).toBe(true);
    expect(p.set('terminalRightClick', 'menu')).toBe(true);
    expect(p.set('terminalCopyOnSelect', true)).toBe(true);
    // the type forbids these; callers may still pass anything at run time
    expect(p.set('terminalRenderer', 'webgl' as never)).toBe(false);
    expect(p.set('terminalCursor', 'beam' as never)).toBe(false);
    const again = createPrefs(st);
    expect(again.get('terminalRenderer', 'auto')).toBe('dom');
    expect(again.get('terminalCursor', 'block')).toBe('underline');
    expect(again.get('terminalRightClick', 'smart')).toBe('menu');
    expect(again.get('terminalCopyOnSelect', false)).toBe(true);
  });

  it('are stored and read back through set, and a rejected value changes nothing', () => {
    const st = new MemStorage();
    const p = createPrefs(st);
    expect(p.set('workspaceOpen', { [hashed(3)]: true })).toBe(true);
    expect(p.set('lastTerminal', 'repo-2')).toBe(true);
    expect(p.set('workspaceCollapsed', true)).toBe(true);
    expect(p.set('terminalScreenReader', true)).toBe(true);
    expect(p.set('lastTerminal', 'not a name')).toBe(false);
    expect(p.set('workspaceOpen', { '__proto__x y': true })).toBe(false);
    const again = createPrefs(st);
    expect(again.get('workspaceOpen')).toEqual({ [hashed(3)]: true });
    expect(again.get('lastTerminal')).toBe('repo-2');
    expect(again.get('workspaceCollapsed', false)).toBe(true);
    expect(again.get('terminalScreenReader', false)).toBe(true);
    expect(p.set('lastTerminal', '')).toBe(true);
    expect(createPrefs(st).get('lastTerminal')).toBe('');
  });

  it('the legacy key never supplies a Workspace preference of a wrong shape', () => {
    const st = new MemStorage({
      [LEGACY_PREFS_KEY]: JSON.stringify({
        theme: 'light',
        lastTerminal: 'a b',
        workspaceOpen: [1],
        workspaceCollapsed: 'x',
      }),
    });
    expect(createPrefs(st).all()).toEqual({ theme: 'light' });
  });
});
