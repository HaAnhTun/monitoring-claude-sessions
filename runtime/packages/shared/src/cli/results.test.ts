import { describe, expect, it } from 'vitest';

import { AutostartStatusSchema, compareCodePoints } from './results.ts';

/** U+FF5E is one UTF-16 code unit (0xFF5E); U+1F600 is the pair 0xD83D 0xDE00, which sorts before it by code unit. */
const BMP_HIGH = String.fromCodePoint(0xff5e);
const ASTRAL = String.fromCodePoint(0x1f600);

describe('compareCodePoints', () => {
  it('orders plain strings like the code point order, independent of the locale', () => {
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('b', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('same', 'same')).toBe(0);
    expect(compareCodePoints('Z', 'a')).toBeLessThan(0);
    expect(compareCodePoints('a', 'a1')).toBeLessThan(0);
    expect(compareCodePoints('', 'a')).toBeLessThan(0);
  });

  it('orders an astral character by its code point, after a BMP character with a higher unit', () => {
    expect(ASTRAL < BMP_HIGH).toBe(true); // the UTF-16 order the helper must not follow
    expect(compareCodePoints(BMP_HIGH, ASTRAL)).toBeLessThan(0);
    expect(compareCodePoints(ASTRAL, BMP_HIGH)).toBeGreaterThan(0);
    expect(compareCodePoints(`x${BMP_HIGH}`, `x${ASTRAL}`)).toBeLessThan(0);
  });

  it('sorts a mixed list by code point', () => {
    const sorted = [ASTRAL, 'b', BMP_HIGH, 'a', `${ASTRAL}a`].sort(compareCodePoints);
    expect(sorted).toEqual(['a', 'b', BMP_HIGH, ASTRAL, `${ASTRAL}a`]);
  });
});

describe('AutostartStatusSchema (06 2.7)', () => {
  const on = {
    supported: true,
    enabled: true,
    shortcut: 'Startup/Claude Agent Workspace.lnk',
    target: 'node.exe',
    arguments: '"caw.mjs" start --no-open',
    targetExists: true,
    matchesLauncher: true,
    note: null,
  };
  const unsupported = {
    supported: false,
    enabled: false,
    shortcut: null,
    target: null,
    arguments: null,
    targetExists: null,
    matchesLauncher: null,
    note: null,
  };

  it('accepts an enabled shortcut and the answer of a platform without autostart', () => {
    expect(AutostartStatusSchema.parse(on)).toEqual(on);
    expect(AutostartStatusSchema.parse(unsupported)).toEqual(unsupported);
    expect(AutostartStatusSchema.safeParse({ ...on, matchesLauncher: false, note: 'stale target' }).success).toBe(true);
  });

  it('needs all eight keys, allows no other key and refuses a wrong type', () => {
    for (const key of Object.keys(on)) {
      const rest = Object.fromEntries(Object.entries(on).filter(([name]) => name !== key));
      expect(AutostartStatusSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(AutostartStatusSchema.safeParse({ ...on, extra: 1 }).success).toBe(false);
    expect(AutostartStatusSchema.safeParse({ ...on, supported: null }).success).toBe(false);
    expect(AutostartStatusSchema.safeParse({ ...on, enabled: 'yes' }).success).toBe(false);
    expect(AutostartStatusSchema.safeParse({ ...on, shortcut: 1 }).success).toBe(false);
    expect(AutostartStatusSchema.safeParse({ ...on, targetExists: 'maybe' }).success).toBe(false);
  });
});
