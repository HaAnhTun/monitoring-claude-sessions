// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hasMessageKey } from '../i18n/translate.ts';
import { msg } from '../test/msg.ts';
import {
  groupOfKey,
  SHORTCUT_GROUPS,
  SHORTCUT_HELP,
  shouldHandleShortcut,
  type KeyboardEventLike,
  type ShortcutTarget,
} from './shortcuts.ts';

function event(over: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return {
    key: 'f',
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: 'BODY' },
    ...over,
  };
}

function on(target: ShortcutTarget | null, over: Partial<KeyboardEventLike> = {}): boolean {
  return shouldHandleShortcut(event({ target, ...over }), false);
}

describe('shouldHandleShortcut', () => {
  it('handles a plain key on the page body, a button or a link', () => {
    expect(on({ tagName: 'BODY' })).toBe(true);
    expect(on({ tagName: 'BUTTON' })).toBe(true);
    expect(on({ tagName: 'A' })).toBe(true);
    expect(on({ tagName: 'DIV' })).toBe(true);
    expect(on(null)).toBe(true);
  });

  it('ignores keys typed into textareas, selects and editable content', () => {
    expect(on({ tagName: 'TEXTAREA' })).toBe(false);
    expect(on({ tagName: 'SELECT' })).toBe(false);
    expect(on({ tagName: 'DIV', isContentEditable: true })).toBe(false);
    expect(on({ tagName: 'textarea' })).toBe(false);
  });

  it('ignores every text-like input type and an input without a type', () => {
    for (const type of [
      'text',
      'search',
      'number',
      'email',
      'url',
      'tel',
      'password',
      'date',
      'time',
      'datetime-local',
      '',
      'TEXT',
    ]) {
      expect(on({ tagName: 'INPUT', type }), type).toBe(false);
    }
    expect(on({ tagName: 'INPUT' })).toBe(false);
  });

  it('handles keys on checkboxes, radios, buttons and ranges', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) {
      expect(on({ tagName: 'INPUT', type }), type).toBe(true);
    }
  });

  it('ignores Ctrl, Meta and Alt combinations but not Shift (for "?")', () => {
    expect(on({ tagName: 'BODY' }, { ctrlKey: true })).toBe(false);
    expect(on({ tagName: 'BODY' }, { metaKey: true })).toBe(false);
    expect(on({ tagName: 'BODY' }, { altKey: true })).toBe(false);
    expect(on({ tagName: 'BODY' }, { key: '?' })).toBe(true);
  });

  it('ignores an event that was already handled', () => {
    expect(on({ tagName: 'BODY' }, { defaultPrevented: true })).toBe(false);
  });

  it('ignores everything while a dialog is open', () => {
    expect(shouldHandleShortcut(event(), true)).toBe(false);
    expect(shouldHandleShortcut(event(), false)).toBe(true);
  });

  it('documents the global shortcuts for the help dialog, each row with a catalogue key and a group', () => {
    expect(SHORTCUT_HELP.map((s) => s.keys)).toEqual([
      ['/'],
      ['f'],
      [']'],
      ['['],
      ['?'],
      [{ cap: 'esc' }],
      [{ cap: 'up' }, { cap: 'down' }, { cap: 'home' }, { cap: 'end' }],
    ]);
    for (const row of SHORTCUT_HELP) {
      expect(hasMessageKey(row.descriptionKey), row.descriptionKey).toBe(true);
      expect(SHORTCUT_GROUPS).toContain(row.group);
      expect(msg(row.descriptionKey).length).toBeGreaterThan(5);
    }
  });

  it('only the rows that no component registers are fixed', () => {
    expect(SHORTCUT_HELP.filter((row) => row.fixed).map((row) => row.descriptionKey)).toEqual([
      'shortcuts.fixed.escape',
      'shortcuts.fixed.sidebar',
    ]);
  });

  it('groups the registered keys: search, transcript and navigation (an unknown key is navigation)', () => {
    expect(groupOfKey('/')).toBe('search');
    expect(['f', ']', '['].map(groupOfKey)).toEqual(['transcript', 'transcript', 'transcript']);
    expect(groupOfKey('?')).toBe('navigation');
    expect(groupOfKey('x')).toBe('navigation');
  });
});
