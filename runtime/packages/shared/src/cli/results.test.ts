import { describe, expect, it } from 'vitest';

import { compareCodePoints } from './results.ts';

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
