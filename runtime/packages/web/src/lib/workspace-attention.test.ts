// @vitest-environment node
import type { AttentionClass, AttentionLevel } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { AttentionItem } from './attention-rows.ts';
import { isAttentionLevel, nextNeeding, rollupByFolder, stripOf, STRIP_MAX, titleOf } from './workspace-attention.ts';

const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

const CLS: Record<AttentionLevel, AttentionClass> = {
  needs_you: { posture: 'needs_you', reason: 'permission', family: 'S-6' },
  failed: { posture: 'failed', reason: 'session_failed', family: 'S-3' },
  done: { posture: 'ready', reason: 'turn_done', family: 'S-8' },
  working: { posture: 'working', reason: null, family: 'S-7' },
  idle: { posture: 'ready', reason: 'first_prompt', family: 'S-8' },
  unknown: { posture: 'unknown', reason: null, family: 'S-5' },
};

function item(name: string, level: AttentionLevel, second: number, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    key: `s:${name}`,
    sessionId: name,
    terminal: `term-${name}`,
    folderKey: 'folder-a',
    cls: CLS[level],
    since: at(second),
    label: null,
    labelSource: null,
    level,
    unseen: level === 'failed' || level === 'done',
    ...over,
  };
}

/** The sidebar order: nothing below may change it. */
const LIST: readonly AttentionItem[] = Object.freeze([
  item('a', 'working', 1),
  item('b', 'done', 20),
  item('c', 'needs_you', 30),
  item('d', 'failed', 10),
  item('e', 'idle', 5),
  item('f', 'needs_you', 3, { folderKey: 'folder-b' }),
  item('g', 'done', 40, { folderKey: 'folder-b' }),
  item('h', 'unknown', 2, { folderKey: 'folder-c' }),
  item('i', 'failed', 50, { terminal: null, folderKey: null }),
]);

const keys = (rows: readonly AttentionItem[]): string[] => rows.map((row) => row.sessionId ?? '');

describe('stripOf', () => {
  it('draws needs you first (the longest blocked on top), then failed and done, the newest first', () => {
    const strip = stripOf(LIST);
    expect(keys(strip.rows)).toEqual(['f', 'c', 'i', 'd', 'g']);
    expect(strip).toMatchObject({ total: 6, more: 1 });
    expect(strip.dismissable).toEqual(['s:i', 's:d', 's:g', 's:b']);
    expect(strip.rows.length).toBe(STRIP_MAX);
  });

  it.each([
    [0, 0, 0],
    [3, 3, 0],
    [5, 5, 0],
    [9, 5, 4],
  ])('with %i rows that need the person it draws %i and says "and %i more"', (count, drawn, more) => {
    const items = Array.from({ length: count }, (_, n) => item(`n${String(n)}`, 'needs_you', n));
    const strip = stripOf(items);
    expect([strip.rows.length, strip.total, strip.more]).toEqual([drawn, count, more]);
    expect(strip.dismissable).toEqual([]);
  });

  it('is empty when nothing is above working, and never changes the list it was given', () => {
    expect(stripOf([item('a', 'working', 1), item('b', 'idle', 2), item('c', 'unknown', 3)])).toEqual({
      rows: [],
      total: 0,
      more: 0,
      dismissable: [],
    });
    const before = keys(LIST);
    stripOf(LIST);
    rollupByFolder(LIST);
    nextNeeding(LIST, 's:c');
    expect(keys(LIST)).toEqual(before);
  });
});

describe('rollupByFolder', () => {
  it('gives each folder its highest level and how many terminals are at it; a session without a terminal is left out', () => {
    const rollup = rollupByFolder(LIST);
    expect([...rollup]).toEqual([
      ['folder-a', { level: 'needs_you', count: 1 }],
      ['folder-b', { level: 'needs_you', count: 1 }],
      ['folder-c', { level: 'unknown', count: 1 }],
    ]);
    const two = rollupByFolder([item('a', 'done', 1), item('b', 'working', 2), item('c', 'done', 3)]);
    expect(two.get('folder-a')).toEqual({ level: 'done', count: 2 });
  });

  it('a chip is drawn only for a level above working', () => {
    expect((['needs_you', 'failed', 'done', 'working', 'idle', 'unknown'] as const).map(isAttentionLevel)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('nextNeeding', () => {
  it.each([
    [null, 'f'],
    ['s:f', 'c'],
    ['s:c', 'i'],
    ['s:b', 'f'],
    ['s:a', 'f'],
    ['s:gone', 'f'],
  ])('after %s comes %s: strip order, wrapping, the first one for a row outside the strip', (selected, expected) => {
    expect(nextNeeding(LIST, selected)?.sessionId).toBe(expected);
  });

  it('is null when no row is in the strip, and the only row is its own next', () => {
    expect(nextNeeding([], null)).toBeNull();
    expect(nextNeeding([item('a', 'working', 1)], 's:a')).toBeNull();
    const only = [item('a', 'needs_you', 1)];
    expect(nextNeeding(only, 's:a')?.key).toBe('s:a');
  });
});

describe('titleOf', () => {
  it.each([
    ['custom_title', 'FIXTURE title', 'FIXTURE title', 'FIXTURE title'],
    ['ai_title', 'FIXTURE title', 'FIXTURE title', 'FIXTURE title'],
    ['rule', 'FIXTURE title', 'FIXTURE title', 'FIXTURE title'],
    ['first_prompt', 'FIXTURE prompt', 'FIXTURE prompt', null],
    ['none', 'FIXTURE id', null, null],
    ['custom_title', '', null, null],
    [null, null, null, null],
  ] as const)(
    'a label from %s (%s) shows as %s with all and %s with named, and never with off',
    (labelSource, label, all, named) => {
      const row = { label, labelSource };
      expect(titleOf(row, 'all')).toBe(all);
      expect(titleOf(row, 'named')).toBe(named);
      expect(titleOf(row, 'off')).toBeNull();
    },
  );
});
