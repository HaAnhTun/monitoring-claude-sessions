// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { messageArguments, parseMessage } from './format-message.ts';
import { enMessages } from './messages/en.ts';
import { viMessages } from './messages/vi.ts';

// The checks of ADR 0072 decision 7 that look at both catalogues together: the keys, the placeholders and the plural syntax of
// `en` and `vi` agree, no value is empty or untrimmed, Vietnamese is NFC without a replacement character and is written with its
// diacritics. The checks that read one file as bytes are in `messages/en.test.ts` and `messages/vi.test.ts`.

const en: Readonly<Record<string, string>> = enMessages;
const vi: Readonly<Record<string, string>> = viMessages;

const KEY = /^[a-z][A-Za-z0-9]*(?:[.][A-Za-z0-9_-]+)+$/;
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** Vietnamese words that exist only with diacritics; written without them a string was stripped by mistake. */
const STRIPPED_WORDS = ['khong', 'duoc', 'nguoi', 'tieng', 'viet', 'phien', 'luot', 'cac', 'mot', 'nhieu', 'vao'];
const STRIPPED_PHRASES = [
  'trang thai',
  'hien thi',
  'thu lai',
  'tai lai',
  'sao chep',
  'dang tai',
  'canh bao',
  'that bai',
  'hoan tat',
  'truc tiep',
  'cap nhat',
  'ket thuc',
  'bat dau',
  'lam viec',
  'tu dong',
  'cai dat',
  'tim kiem',
  'man hinh',
  'phan hoi',
  'cong cu',
  'dau ra',
  'dau vao',
  'loi thoi',
  'khong ro',
];

/** The Vietnamese words of `text` that are written without their diacritics. */
export function strippedVietnamese(text: string): string[] {
  const lower = text.toLowerCase();
  const letters = /[\p{L}\p{M}]/u;
  const found: string[] = [];
  for (const word of [...STRIPPED_WORDS, ...STRIPPED_PHRASES]) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at === -1) break;
      const before = at === 0 ? '' : lower.charAt(at - 1);
      const after = lower.charAt(at + word.length);
      if (!letters.test(before) && !letters.test(after)) {
        found.push(word);
        break;
      }
      from = at + 1;
    }
  }
  return found;
}

const isNfc = (text: string): boolean => text === text.normalize('NFC');

describe('the two catalogues agree', () => {
  const enKeys = Object.keys(en).sort();
  const viKeys = Object.keys(vi).sort();

  it('have the same keys', () => {
    expect(viKeys.filter((key) => !(key in en))).toEqual([]);
    expect(enKeys.filter((key) => !(key in vi))).toEqual([]);
    expect(viKeys).toEqual(enKeys);
  });

  it('have well-formed keys: lower-case feature prefix, dotted', () => {
    expect(enKeys.filter((key) => !KEY.test(key))).toEqual([]);
  });

  it('seed the keys other work packages build on', () => {
    for (const key of [
      'common.close',
      'common.retry',
      'common.copy',
      'common.copied',
      'common.loading',
      'common.notAvailable',
      'lang.en',
      'lang.vi',
    ]) {
      expect(enKeys).toContain(key);
    }
  });

  it('have the same placeholders in every message, and the same plural counters', () => {
    const problems: string[] = [];
    for (const key of enKeys) {
      const english = [...messageArguments(en[key] ?? '').entries()].sort();
      const vietnamese = [...messageArguments(vi[key] ?? '').entries()].sort();
      if (JSON.stringify(english) !== JSON.stringify(vietnamese)) {
        problems.push(`${key}: en ${JSON.stringify(english)} vs vi ${JSON.stringify(vietnamese)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe.each([
  ['en', en],
  ['vi', vi],
] as const)('every %s message', (_name, catalogue) => {
  it('parses: valid plural syntax, an other form, no stray braces', () => {
    const problems: string[] = [];
    for (const [key, text] of Object.entries(catalogue)) {
      try {
        parseMessage(text);
      } catch (error) {
        problems.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('is neither empty nor untrimmed, and has no control character or double space', () => {
    const problems: string[] = [];
    for (const [key, text] of Object.entries(catalogue)) {
      if (text === '' || text !== text.trim()) problems.push(`${key}: empty or untrimmed`);
      if (/[\p{Cc}]/u.test(text)) problems.push(`${key}: control character`);
      if (text.includes('  ')) problems.push(`${key}: double space`);
    }
    expect(problems).toEqual([]);
  });

  it('has no replacement character', () => {
    expect(Object.entries(catalogue).filter(([, text]) => text.includes(REPLACEMENT_CHARACTER))).toEqual([]);
  });
});

describe('the Vietnamese catalogue', () => {
  it('is in Unicode normalisation form NFC, keys included', () => {
    expect(Object.entries(vi).filter(([key, text]) => !isNfc(key) || !isNfc(text))).toEqual([]);
  });

  it('writes no word without its diacritics', () => {
    const problems = Object.entries(vi)
      .map(([key, text]) => [key, strippedVietnamese(text)] as const)
      .filter(([, words]) => words.length > 0);
    expect(problems).toEqual([]);
  });

  it('keeps the names of the languages in their own language', () => {
    expect(vi['lang.en']).toBe('English');
    expect(vi['lang.vi']).not.toBe(en['lang.vi']);
  });
});

describe('the checks themselves catch what they are for (negative probes)', () => {
  it('recognises text that is not NFC', () => {
    const decomposed = String.fromCodePoint(0x65, 0x302);
    expect(isNfc(decomposed)).toBe(false);
    expect(isNfc(decomposed.normalize('NFC'))).toBe(true);
  });

  it('finds Vietnamese written without diacritics, as a word and as a phrase', () => {
    expect(strippedVietnamese('Khong the hien thi')).toEqual(expect.arrayContaining(['khong', 'hien thi']));
    expect(strippedVietnamese('Thu lai')).toEqual(['thu lai']);
    expect(strippedVietnamese('Dang tai...')).toEqual(['dang tai']);
  });

  it('does not take a word that merely contains one of the words', () => {
    expect(strippedVietnamese('Vietnamese tokens')).toEqual([]);
    expect(strippedVietnamese('motor')).toEqual([]);
    expect(strippedVietnamese('session count')).toEqual([]);
  });

  it('accepts text that keeps its diacritics', () => {
    const withMarks = [
      String.fromCodePoint(0x4b, 0x68, 0xf4, 0x6e, 0x67),
      String.fromCodePoint(0x74, 0x68, 0x1eed, 0x20, 0x6c, 0x1ea1, 0x69),
    ].join(' ');
    expect(strippedVietnamese(withMarks)).toEqual([]);
  });

  it('rejects mismatched placeholders (the comparison that the parity test makes)', () => {
    const left = [...messageArguments('Hello {name}').entries()];
    const right = [...messageArguments('Hello {user}').entries()];
    expect(JSON.stringify(left)).not.toBe(JSON.stringify(right));
    const plural = [...messageArguments('{n, plural, other {#}}').entries()];
    const simple = [...messageArguments('{n}').entries()];
    expect(JSON.stringify(plural)).not.toBe(JSON.stringify(simple));
  });
});
