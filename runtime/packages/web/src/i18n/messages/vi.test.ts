// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { viMessages } from './vi.ts';

/** The work packages that own a block of the catalogue, in the order of the shared-file register of the plan. */
const BLOCKS = [
  'WP-53',
  'WP-54',
  'WP-65',
  'WP-66',
  'WP-67',
  'WP-112',
  'WP-113',
  'WP-114',
  'WP-115',
  'WP-116',
  'WP-117',
  'WP-118',
  'WP-119',
  'WP-120',
  'WP-121',
  'WP-124',
  'WP-136',
] as const;

const BACKSLASH = String.fromCharCode(92);
const bytes = readFileSync(resolve(import.meta.dirname, 'vi.ts'));
const source = bytes.toString('utf8');
const header = source.slice(0, source.indexOf('export const'));

describe('messages/vi.ts (the file, as bytes)', () => {
  it('is valid UTF-8 without a byte order mark', () => {
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
  });

  it('holds real Vietnamese characters, not escape sequences', () => {
    let nonAscii = 0;
    for (const char of source) if (char.charCodeAt(0) > 127) nonAscii += 1;
    expect(nonAscii).toBeGreaterThan(50);
    expect(source.includes(`${BACKSLASH}u`)).toBe(false);
    expect(source.includes(`${BACKSLASH}x`)).toBe(false);
    expect(source.includes('&#')).toBe(false);
  });

  it('is in Unicode normalisation form NFC and has no replacement character', () => {
    expect(source === source.normalize('NFC')).toBe(true);
    expect(source.includes(String.fromCodePoint(0xfffd))).toBe(false);
  });

  it('has the glossary of the terms in its header', () => {
    expect(header).toContain('Glossary');
    for (const concept of ['session', 'subagent', 'token', 'error', 'warning', 'live', 'stale', 'language names']) {
      expect(header, concept).toContain(concept);
    }
    expect(header).toContain('the ten states');
  });

  it('has one empty pair of markers per work package, in the order of the register', () => {
    const markers = [...source.matchAll(/\/\/ @wp-(begin|end) (WP-\d+)/g)].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`);
    expect(markers).toEqual(BLOCKS.flatMap((wp) => [`begin ${wp}`, `end ${wp}`]));
  });
});

describe('messages/vi.ts (the values)', () => {
  it('translates the seed entries, with letters that carry marks', () => {
    const marked = (text: string): boolean => text !== text.normalize('NFD').replace(/\p{M}/gu, '');
    for (const key of [
      'common.close',
      'common.retry',
      'common.copy',
      'common.copied',
      'common.notAvailable',
    ] as const) {
      expect(marked(viMessages[key]), key).toBe(true);
    }
    expect(viMessages['lang.en']).toBe('English');
  });

  it('does not repeat the English text for a translated message', () => {
    expect(viMessages['common.close']).not.toBe('Close');
    expect(viMessages['common.loading']).not.toBe('Loading...');
  });
});

describe('messages/vi.ts (the Workspace block, WP-136)', () => {
  const keysOf = (text: string): string[] => {
    const begin = text.indexOf('// @wp-begin WP-136');
    const end = text.indexOf('// @wp-end WP-136');
    return [...text.slice(begin, end).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] ?? '');
  };
  const english = readFileSync(resolve(import.meta.dirname, 'en.ts'), 'utf8');

  it('has the keys of the English block, in the same order, between its own markers', () => {
    const keys = keysOf(source);
    expect(keys.length).toBeGreaterThanOrEqual(115);
    expect(keys).toEqual(keysOf(english));
  });

  it('writes the block in Vietnamese: marked letters, and the terms of the glossary', () => {
    const marked = (text: string): boolean => text !== text.normalize('NFD').replace(/\p{M}/gu, '');
    // Entries that are legitimately plain ASCII: the loanword on its own and the two counters of the DA memory.
    const plain = new Set(['shortcuts.group.terminal', 'workspace.pane.label', 'workspace.folder.counts']);
    const catalogue: Readonly<Record<string, string>> = viMessages;
    const unmarked = keysOf(source).filter((key) => !plain.has(key) && !marked(catalogue[key] ?? ''));
    expect(unmarked).toEqual([]);
    expect(viMessages['workspace.recent.title']).toBe('Phiên gần đây');
    expect(viMessages['workspace.sidebar.heading']).toBe('Dự án');
    expect(viMessages['workspace.recent.resume']).toBe('Tiếp tục');
  });
});
