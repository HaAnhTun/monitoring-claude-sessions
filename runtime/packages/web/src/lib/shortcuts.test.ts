// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hasMessageKey } from '../i18n/translate.ts';
import { RELEASE_CHORD } from '../terminal/protocol.ts';
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

  // TC-UI-12, design 04 D12 and 7.5: the terminal owns the keyboard while the focus is anywhere inside its region
  it('ignores every key whose target is inside the terminal region, whatever the element (insideTerminal)', () => {
    for (const tagName of ['DIV', 'BUTTON', 'A', 'BODY', 'TEXTAREA']) {
      expect(on({ tagName, insideTerminal: true }), tagName).toBe(false);
    }
    expect(on({ tagName: 'DIV', insideTerminal: true }, { key: '?' })).toBe(false);
    expect(on({ tagName: 'DIV', insideTerminal: true }, { key: '/' })).toBe(false);
  });

  it('handles the same keys outside the region: the flag is absent or false', () => {
    expect(on({ tagName: 'DIV', insideTerminal: false })).toBe(true);
    expect(on({ tagName: 'DIV' })).toBe(true);
    expect(on({ tagName: 'BUTTON', insideTerminal: false }, { key: '?' })).toBe(true);
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
      ['t'],
      ['n'],
      [RELEASE_CHORD],
      ['Ctrl+C'],
      ['Ctrl+V'],
      ['Shift+Enter'],
      ['Shift+PageUp', 'Shift+PageDown'],
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
      'workspace.shortcut.release',
      'workspace.shortcut.copy',
      'workspace.shortcut.paste',
      'workspace.shortcut.newline',
      'workspace.shortcut.scroll',
    ]);
  });

  it('groups the registered keys: search, transcript, terminal and navigation (an unknown key is navigation)', () => {
    expect(groupOfKey('/')).toBe('search');
    expect(['f', ']', '['].map(groupOfKey)).toEqual(['transcript', 'transcript', 'transcript']);
    expect(groupOfKey('t')).toBe('terminal');
    expect(groupOfKey('?')).toBe('navigation');
    expect(groupOfKey('x')).toBe('navigation');
  });

  // design 04 7.5: the dialog draws every string of `keys` as its own key cap and several caps are alternatives, so a chord is ONE cap
  it('writes a chord as one key cap string and the two scroll keys as two alternatives', () => {
    const terminalRows = SHORTCUT_HELP.filter((row) => row.group === 'terminal');
    expect(terminalRows.map((row) => row.descriptionKey)).toEqual([
      'workspace.shortcut.focusTerminal',
      'workspace.shortcut.nextNeeding',
      'workspace.shortcut.release',
      'workspace.shortcut.copy',
      'workspace.shortcut.paste',
      'workspace.shortcut.newline',
      'workspace.shortcut.scroll',
    ]);
    const release = terminalRows.find((row) => row.descriptionKey === 'workspace.shortcut.release');
    expect(release?.keys).toEqual([RELEASE_CHORD]);
    expect(RELEASE_CHORD).toBe('Ctrl+Shift+Space');
    // ADR 0110: Shift+Enter inserts a new line, one chord in one cap
    expect(terminalRows.find((row) => row.descriptionKey === 'workspace.shortcut.newline')?.keys).toEqual([
      'Shift+Enter',
    ]);
    for (const row of terminalRows) {
      for (const cap of row.keys) expect(typeof cap, row.descriptionKey).toBe('string');
    }
  });

  it('adds the terminal group after the other groups', () => {
    expect(SHORTCUT_GROUPS).toEqual(['navigation', 'search', 'transcript', 'terminal']);
    expect(msg('shortcuts.group.terminal').length).toBeGreaterThan(0);
  });

  it('registers only `t` and `n` through a component; the other terminal rows are the program and the browser', () => {
    const terminalRows = SHORTCUT_HELP.filter((row) => row.group === 'terminal');
    expect(terminalRows.filter((row) => !row.fixed).map((row) => row.keys)).toEqual([['t'], ['n']]);
    expect(terminalRows.filter((row) => row.fixed)).toHaveLength(5);
  });
});
