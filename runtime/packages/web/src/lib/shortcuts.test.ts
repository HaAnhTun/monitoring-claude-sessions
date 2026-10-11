// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SHORTCUT_HELP, shouldHandleShortcut, type KeyboardEventLike, type ShortcutTarget } from './shortcuts.ts';

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

  it('documents the global shortcuts for the help dialog', () => {
    expect(SHORTCUT_HELP.map((s) => s.keys)).toEqual(['/', 'f', ']', '[', '?', 'Esc', 'Up / Down / Home / End']);
    for (const s of SHORTCUT_HELP) expect(s.description.length).toBeGreaterThan(5);
  });
});
