// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isLetterKey, type LetterEventLike } from './key-match.ts';

// The letters other layouts type on the C and V keys, by code point so that they cannot be mistaken for Latin letters here.
const CYRILLIC_ES = String.fromCodePoint(0x441);
const CYRILLIC_EM = String.fromCodePoint(0x43c);
const HEBREW_BET = String.fromCodePoint(0x5d1);

// TC-ERGO-03 (ADR 0110): a letter is read by `key`, and by the physical key only when the layout types no ASCII character there.
describe('isLetterKey (TC-ERGO-03)', () => {
  const rows: [string, LetterEventLike, string, boolean][] = [
    ['key c', { key: 'c', code: 'KeyC' }, 'c', true],
    ['key C (Shift or Caps Lock)', { key: 'C', code: 'KeyC' }, 'c', true],
    ['key c without a code (a synthetic event)', { key: 'c' }, 'c', true],
    ['Cyrillic on the C key', { key: CYRILLIC_ES, code: 'KeyC' }, 'c', true],
    ['Hebrew on the C key', { key: HEBREW_BET, code: 'KeyC' }, 'c', true],
    ['Cyrillic on the V key', { key: CYRILLIC_EM, code: 'KeyV' }, 'v', true],
    ['Cyrillic on another key', { key: CYRILLIC_ES, code: 'KeyS' }, 'c', false],
    ['Dvorak: the C key types j', { key: 'j', code: 'KeyC' }, 'c', false],
    ['Dvorak: c is typed on the J key', { key: 'c', code: 'KeyJ' }, 'c', true],
    ['a different ASCII letter', { key: 'x', code: 'KeyX' }, 'c', false],
    ['ASCII punctuation on a letter key', { key: ',', code: 'KeyC' }, 'c', false],
    ['a key an input method has taken', { key: 'Process', code: 'KeyC' }, 'c', false],
    ['a dead key', { key: 'Dead', code: 'KeyC' }, 'c', false],
    ['a letter outside ASCII with an empty code', { key: CYRILLIC_ES, code: '' }, 'c', false],
    ['a letter outside ASCII without a code', { key: CYRILLIC_ES }, 'c', false],
  ];

  it.each(rows)('%s', (_name, event, letter, expected) => {
    expect(isLetterKey(event, letter)).toBe(expected);
  });
});
