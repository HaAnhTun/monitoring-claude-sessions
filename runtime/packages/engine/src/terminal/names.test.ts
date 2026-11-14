import { describe, expect, it } from 'vitest';

import { Prng } from '../../test/support/prng.ts';
import { TerminalError } from './errors.ts';
import { SESSION_NAME_RE } from './limits.ts';
import { NameAllocator, sessionBase } from './names.ts';

describe('TC-UNIT-01 sessionBase', () => {
  it.each([
    ['D:\\work\\my-project', 'my-project'],
    ['D:\\work\\my-project\\', 'my-project'],
    ['D:\\work\\my-project\\\\//', 'my-project'],
    ['D:/work/a b', 'a_b'],
    ['/home/dev/proj.name', 'proj_name'],
    ['D:\\keep_under-score9', 'keep_under-score9'],
    ['D:\\', 'D_'],
    ['proj', 'proj'],
    // every code point outside [A-Za-z0-9_-] becomes one underscore, as MTOP's `re.sub` does
    ['D:\\D\u1ef1 \u00e1n', 'D___n'],
    ['D:\\\u{1f600}', '_'],
    ['D:\\a$b#c%d', 'a_b_c_d'],
  ])('%j -> %j', (folder, expected) => {
    expect(sessionBase(folder)).toBe(expected);
  });

  it.each([[''], ['/'], ['///'], ['\\'], ['\\\\\\']])(
    'a folder with no last segment (%j) becomes "session"',
    (folder) => {
      expect(sessionBase(folder)).toBe('session');
    },
  );

  it('cuts a 200-character folder name to 60 characters', () => {
    const base = sessionBase(`D:\\${'x'.repeat(200)}`);
    expect(base).toBe('x'.repeat(60));
  });

  it('keeps the first 60 characters of a long mixed name', () => {
    const name = `${'ab-'.repeat(30)}tail`;
    expect(sessionBase(`D:\\${name}`)).toBe(name.slice(0, 60));
  });

  it('a reserved device name stays a valid base (the folder rules refuse such a folder elsewhere)', () => {
    for (const device of ['CON', 'NUL', 'COM1', 'lpt9']) {
      const base = sessionBase(`D:\\${device}`);
      expect(base).toBe(device);
      expect(SESSION_NAME_RE.test(`${base}-1`)).toBe(true);
    }
  });

  it('property: any text gives a base that matches [A-Za-z0-9_-]{1,60} and a name that matches the session pattern', () => {
    const prng = new Prng(14_001);
    const alphabet = [
      'a',
      'Z',
      '0',
      '-',
      '_',
      ' ',
      '.',
      '\\',
      '/',
      ':',
      '\u1ef1',
      '\u00e9',
      '\u{1f600}',
      '%',
      '"',
      '\u200b',
    ];
    for (let round = 0; round < 300; round += 1) {
      const length = prng.range(0, 90);
      let folder = '';
      for (let i = 0; i < length; i += 1) folder += prng.pick(alphabet);
      const base = sessionBase(folder);
      expect(base, `seed ${String(prng.seed)} folder ${JSON.stringify(folder)}`).toMatch(/^[A-Za-z0-9_-]{1,60}$/);
      expect(new NameAllocator().next(base)).toMatch(SESSION_NAME_RE);
    }
  });
});

describe('TC-UNIT-01 NameAllocator', () => {
  it('numbers each base from 1, independently', () => {
    const names = new NameAllocator();
    expect(names.next('proj')).toBe('proj-1');
    expect(names.next('proj')).toBe('proj-2');
    expect(names.next('other')).toBe('other-1');
    expect(names.next('proj')).toBe('proj-3');
    expect(names.next('other')).toBe('other-2');
  });

  it('is monotonic and never hands a name out twice (a stale tab can never reach another session)', () => {
    const names = new NameAllocator();
    const seen = new Set<string>();
    let previous = 0;
    for (let i = 0; i < 2500; i += 1) {
      const name = names.next('proj');
      expect(seen.has(name), name).toBe(false);
      seen.add(name);
      const n = Number(name.slice('proj-'.length));
      expect(n).toBe(previous + 1);
      previous = n;
    }
  });

  it('a base that ends in "-1" does not collide with the numbering of its parent base', () => {
    const names = new NameAllocator();
    const all = [names.next('a'), names.next('a-1'), names.next('a'), names.next('a-1'), names.next('a-1-1')];
    expect(all).toEqual(['a-1', 'a-1-1', 'a-2', 'a-1-2', 'a-1-1-1']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps every name at 64 characters or fewer for n >= 1000, shortening the base', () => {
    const names = new NameAllocator();
    const base = 'b'.repeat(60);
    const seen = new Set<string>();
    for (let n = 1; n <= 12_000; n += 1) {
      const name = names.next(base);
      expect(name.length, name).toBeLessThanOrEqual(64);
      expect(name).toMatch(SESSION_NAME_RE);
      seen.add(name);
    }
    expect(seen.size).toBe(12_000);
    // the numbering itself is untouched: only the base gives way
    expect(names.next(base)).toBe(`${'b'.repeat(64 - 1 - 5)}-12001`);
  });

  it('a 60-character base is whole while the number has up to three digits and loses one character at 1000', () => {
    const names = new NameAllocator();
    const base = 'c'.repeat(60);
    let name = '';
    for (let n = 1; n <= 999; n += 1) name = names.next(base);
    expect(name).toBe(`${base}-999`);
    expect(name.length).toBe(64);
    name = names.next(base);
    expect(name).toBe(`${'c'.repeat(59)}-1000`);
    expect(name.length).toBe(64);
  });

  it('two bases that differ only in the characters cut away never produce the same name', () => {
    const names = new NameAllocator();
    const left = `${'x'.repeat(59)}a`;
    const right = `${'x'.repeat(59)}b`;
    const seen = new Set<string>();
    for (let i = 0; i < 1500; i += 1) {
      seen.add(names.next(left));
      seen.add(names.next(right));
    }
    expect(seen.size).toBe(3000);
    for (const name of seen) expect(name.length).toBeLessThanOrEqual(64);
  });

  it.each([[''], ['a b'], ['x'.repeat(61)], ['\u00e9'], ['a/b'], ['a\u0000']])(
    'refuses the base %j with NAME_INVALID',
    (base) => {
      const names = new NameAllocator();
      expect(() => names.next(base)).toThrow(TerminalError);
      try {
        names.next(base);
      } catch (error) {
        expect(error).toBeInstanceOf(TerminalError);
        expect((error as TerminalError).code).toBe('NAME_INVALID');
      }
    },
  );

  it('a refused base does not use up a number', () => {
    const names = new NameAllocator();
    expect(() => names.next('bad base')).toThrow(TerminalError);
    expect(names.next('good')).toBe('good-1');
  });
});
