// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  decideKey,
  NEWLINE_SEQUENCE,
  platformIsMac,
  type KeyContext,
  type KeyDecision,
  type KeyEventLike,
} from './keys.ts';
import { RELEASE_CHORD } from './protocol.ts';

// Every row of the table in design 04 section 7.5 (keyboard ownership, copy and paste), with and without a selection and with the
// modifier combinations that must NOT trigger a row. The function is pure: the view performs the effect of the answer.

const NO_SELECTION: KeyContext = { hasSelection: false, ctrlVPastes: true };
const SELECTION: KeyContext = { hasSelection: true, ctrlVPastes: true };
/** macOS: Ctrl+V stays the program's (Meta+V pastes there, and is the browser's). */
const MAC_NO_SELECTION: KeyContext = { hasSelection: false, ctrlVPastes: false };
const MAC_SELECTION: KeyContext = { hasSelection: true, ctrlVPastes: false };

function key(over: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    type: 'keydown',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...over,
  };
}

const ctrl = (k: string, over: Partial<KeyEventLike> = {}): KeyEventLike => key({ key: k, ctrlKey: true, ...over });

describe('decideKey: the release chord (TC-UI-09)', () => {
  const chord = (over: Partial<KeyEventLike> = {}): KeyEventLike =>
    key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, ...over });

  it('names the chord the protocol module shows next to the pane', () => {
    expect(RELEASE_CHORD).toBe('Ctrl+Shift+Space');
  });

  it.each([
    ['without a selection', NO_SELECTION],
    ['with a selection', SELECTION],
  ])('releases the keyboard on Ctrl+Shift+Space %s', (_name, ctx) => {
    expect(decideKey(chord(), ctx)).toBe('release');
  });

  it('reads the space bar by its key when the layout reports no code', () => {
    expect(decideKey(chord({ code: '' }), NO_SELECTION)).toBe('release');
    expect(decideKey(chord({ code: 'Space', key: 'Spacebar' }), NO_SELECTION)).toBe('release');
  });

  it.each([
    ['Ctrl+Space (the program owns it)', { shiftKey: false }],
    ['Shift+Space', { ctrlKey: false }],
    ['Space alone', { ctrlKey: false, shiftKey: false }],
    ['Ctrl+Alt+Shift+Space', { altKey: true }],
    ['Ctrl+Meta+Shift+Space', { metaKey: true }],
  ])('passes %s to the program', (_name, over) => {
    expect(decideKey(chord(over), NO_SELECTION)).toBe('pass');
  });
});

describe('decideKey: Ctrl+C (TC-UI-08, the MTOP rule)', () => {
  it('copies when there is a selection', () => {
    expect(decideKey(ctrl('c'), SELECTION)).toBe('copy');
  });

  it('passes without a selection, so the program is interrupted', () => {
    expect(decideKey(ctrl('c'), NO_SELECTION)).toBe('pass');
  });

  it('reads the letter in either case (Caps Lock)', () => {
    expect(decideKey(ctrl('C'), SELECTION)).toBe('copy');
    expect(decideKey(ctrl('C'), NO_SELECTION)).toBe('pass');
  });

  it.each([
    ['Ctrl+Alt+C (AltGr on some layouts)', { altKey: true }],
    ['Ctrl+Meta+C', { metaKey: true }],
  ])('passes %s even with a selection', (_name, over) => {
    expect(decideKey(ctrl('c', over), SELECTION)).toBe('pass');
  });

  it('does not take a plain C or another Ctrl letter', () => {
    expect(decideKey(key({ key: 'c' }), SELECTION)).toBe('pass');
    expect(decideKey(ctrl('x'), SELECTION)).toBe('pass');
    expect(decideKey(ctrl('d'), SELECTION)).toBe('pass');
  });
});

describe('decideKey: Meta+C (macOS parity)', () => {
  it('copies with a selection', () => {
    expect(decideKey(key({ key: 'c', metaKey: true }), SELECTION)).toBe('copy');
  });

  it('passes without a selection', () => {
    expect(decideKey(key({ key: 'c', metaKey: true }), NO_SELECTION)).toBe('pass');
  });

  it('passes Meta+Shift+C and Meta+Alt+C', () => {
    expect(decideKey(key({ key: 'c', metaKey: true, shiftKey: true }), SELECTION)).toBe('pass');
    expect(decideKey(key({ key: 'c', metaKey: true, altKey: true }), SELECTION)).toBe('pass');
  });
});

describe('decideKey: Ctrl+Shift+C (never an interrupt, never DevTools)', () => {
  const chordC = (over: Partial<KeyEventLike> = {}): KeyEventLike => ctrl('C', { shiftKey: true, ...over });

  it('copies with a selection', () => {
    expect(decideKey(chordC(), SELECTION)).toBe('copy');
  });

  it('swallows the key without a selection', () => {
    expect(decideKey(chordC(), NO_SELECTION)).toBe('swallow');
  });

  it('reads the letter in either case', () => {
    expect(decideKey(ctrl('c', { shiftKey: true }), NO_SELECTION)).toBe('swallow');
  });

  it('passes the combinations that add Alt or Meta', () => {
    expect(decideKey(chordC({ altKey: true }), NO_SELECTION)).toBe('pass');
    expect(decideKey(chordC({ metaKey: true }), SELECTION)).toBe('pass');
  });
});

describe('decideKey: paste (CAW-144: plain Ctrl+V does not paste in xterm 6.0.0, it sends 0x16)', () => {
  it.each([
    ['without a selection', NO_SELECTION],
    ['with a selection', SELECTION],
  ])('answers paste for Ctrl+V %s, in either letter case', (_name, ctx) => {
    expect(decideKey(ctrl('v'), ctx)).toBe('paste');
    expect(decideKey(ctrl('V'), ctx)).toBe('paste');
  });

  it.each([
    ['without a selection', MAC_NO_SELECTION],
    ['with a selection', MAC_SELECTION],
  ])('passes Ctrl+V on macOS %s, where it stays with the program', (_name, ctx) => {
    expect(decideKey(ctrl('v'), ctx)).toBe('pass');
  });

  it.each([
    ['Meta+V', key({ key: 'v', metaKey: true })],
    ['Ctrl+Meta+V', ctrl('v', { metaKey: true })],
    ['Ctrl+Alt+V (AltGr on some layouts)', ctrl('v', { altKey: true })],
    ['Alt+V (the image paste of Claude Code on Windows)', key({ key: 'v', altKey: true })],
    ['Ctrl+Shift+V', ctrl('V', { shiftKey: true })],
    ['Shift+Insert', key({ key: 'Insert', shiftKey: true })],
    ['Ctrl+Insert (xterm copies through its own listener)', key({ key: 'Insert', ctrlKey: true })],
    ['a plain V', key({ key: 'v' })],
  ])('passes %s to xterm and the browser', (_name, event) => {
    expect(decideKey(event, NO_SELECTION)).toBe('pass');
    expect(decideKey(event, SELECTION)).toBe('pass');
  });

  it('leaves Ctrl+V alone during an input method composition and on keyup', () => {
    expect(decideKey(ctrl('v', { isComposing: true }), NO_SELECTION)).toBe('pass');
    expect(decideKey(ctrl('v', { keyCode: 229 }), NO_SELECTION)).toBe('pass');
    expect(decideKey({ ...ctrl('v'), type: 'keyup' }, NO_SELECTION)).toBe('pass');
    expect(decideKey({ ...ctrl('v'), type: 'keypress' }, NO_SELECTION)).toBe('pass');
  });
});

describe('decideKey: Shift+Enter is a new line (TC-ERGO-01, ADR 0110)', () => {
  const enter = (over: Partial<KeyEventLike> = {}): KeyEventLike => key({ key: 'Enter', code: 'Enter', ...over });

  it('sends the bytes xterm sends for Alt+Enter: ESC CR, the one constant to change', () => {
    expect(Array.from(NEWLINE_SEQUENCE, (char) => char.charCodeAt(0))).toEqual([0x1b, 0x0d]);
  });

  it.each([
    ['without a selection', NO_SELECTION],
    ['with a selection', SELECTION],
    ['on macOS', MAC_NO_SELECTION],
  ])('answers newline for Shift+Enter %s, on the main and the numeric Enter key', (_name, ctx) => {
    expect(decideKey(enter({ shiftKey: true }), ctx)).toBe('newline');
    expect(decideKey(enter({ shiftKey: true, code: 'NumpadEnter' }), ctx)).toBe('newline');
    expect(decideKey(enter({ shiftKey: true, code: '' }), ctx)).toBe('newline');
  });

  it.each([
    ['Enter', {}],
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Alt+Enter (xterm sends ESC CR itself)', { altKey: true }],
    ['Meta+Enter', { metaKey: true }],
    ['Ctrl+Shift+Enter', { ctrlKey: true, shiftKey: true }],
    ['Alt+Shift+Enter', { altKey: true, shiftKey: true }],
    ['Meta+Shift+Enter', { metaKey: true, shiftKey: true }],
  ])('passes %s to xterm', (_name, over) => {
    expect(decideKey(enter(over), NO_SELECTION)).toBe('pass');
    expect(decideKey(enter(over), SELECTION)).toBe('pass');
  });

  it('passes Shift with another key, and Shift+Enter that an input method has taken (it commits the composition)', () => {
    expect(decideKey(key({ key: 'A', shiftKey: true }), NO_SELECTION)).toBe('pass');
    expect(decideKey(enter({ shiftKey: true, isComposing: true }), NO_SELECTION)).toBe('pass');
    expect(decideKey(enter({ shiftKey: true, keyCode: 229 }), NO_SELECTION)).toBe('pass');
    expect(decideKey(enter({ shiftKey: true, key: 'Process' }), NO_SELECTION)).toBe('pass');
  });
});

describe('decideKey: letters on a layout that types no Latin letter (TC-ERGO-01, TC-ERGO-03)', () => {
  // by code point, so that the letters cannot be mistaken for Latin ones here
  const cyrillicC = { key: String.fromCodePoint(0x441), code: 'KeyC' };
  const hebrewC = { key: String.fromCodePoint(0x5d1), code: 'KeyC' };
  const cyrillicV = { key: String.fromCodePoint(0x43c), code: 'KeyV' };

  it.each([
    ['Cyrillic', cyrillicC],
    ['Hebrew', hebrewC],
  ])('reads the copy rows by the physical key on a %s layout', (_name, layout) => {
    expect(decideKey(key({ ...layout, ctrlKey: true }), SELECTION)).toBe('copy');
    expect(decideKey(key({ ...layout, ctrlKey: true }), NO_SELECTION)).toBe('pass');
    expect(decideKey(key({ ...layout, ctrlKey: true, shiftKey: true }), SELECTION)).toBe('copy');
    expect(decideKey(key({ ...layout, ctrlKey: true, shiftKey: true }), NO_SELECTION)).toBe('swallow');
    expect(decideKey(key({ ...layout, metaKey: true }), SELECTION)).toBe('copy');
  });

  it('reads the paste row the same way', () => {
    expect(decideKey(key({ ...cyrillicV, ctrlKey: true }), NO_SELECTION)).toBe('paste');
    expect(decideKey(key({ ...cyrillicV, ctrlKey: true }), MAC_NO_SELECTION)).toBe('pass');
  });

  it('follows the letter, not the position, on a Latin layout (Dvorak)', () => {
    // the physical C key types `j`: not a copy; `c` typed on the physical J key is one
    expect(decideKey(ctrl('j', { code: 'KeyC' }), SELECTION)).toBe('pass');
    expect(decideKey(ctrl('c', { code: 'KeyJ' }), SELECTION)).toBe('copy');
    expect(decideKey(ctrl('k', { code: 'KeyV' }), NO_SELECTION)).toBe('pass');
  });
});

describe('platformIsMac', () => {
  it('reads userAgentData.platform first', () => {
    expect(platformIsMac({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true);
    expect(platformIsMac({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
  });

  it.each([
    ['MacIntel', true],
    ['MacPPC', true],
    ['iPhone', true],
    ['iPad', true],
    ['Win32', false],
    ['Linux x86_64', false],
    ['', false],
  ])('falls back to platform %j (%s)', (platform, expected) => {
    expect(platformIsMac({ platform })).toBe(expected);
    expect(platformIsMac({ userAgentData: {}, platform })).toBe(expected);
    expect(platformIsMac({ userAgentData: { platform: '' }, platform })).toBe(expected);
  });

  it('is false when the browser tells nothing', () => {
    expect(platformIsMac({})).toBe(false);
    expect(platformIsMac(undefined)).toBe(false);
  });
});

describe('decideKey: everything else', () => {
  it.each([
    ['Tab', key({ key: 'Tab', code: 'Tab' })],
    ['Shift+Tab', key({ key: 'Tab', code: 'Tab', shiftKey: true })],
    ['Escape', key({ key: 'Escape' })],
    ['Enter', key({ key: 'Enter' })],
    ['an arrow', key({ key: 'ArrowUp' })],
    ['Shift+PageUp (scrolls the history)', key({ key: 'PageUp', shiftKey: true })],
    ['a letter', key({ key: 'a' })],
    ['Ctrl+Z', ctrl('z')],
    ['Ctrl+L', ctrl('l')],
    ['Alt+B', key({ key: 'b', altKey: true })],
  ])('passes %s to xterm, which encodes it', (_name, event) => {
    expect(decideKey(event, NO_SELECTION)).toBe('pass');
    expect(decideKey(event, SELECTION)).toBe('pass');
  });
});

describe('decideKey: only keydown is decided', () => {
  const chords: [string, KeyEventLike][] = [
    ['the release chord', key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true })],
    ['Ctrl+C', ctrl('c')],
    ['Ctrl+Shift+C', ctrl('C', { shiftKey: true })],
    ['Meta+C', key({ key: 'c', metaKey: true })],
    ['Shift+Enter', key({ key: 'Enter', code: 'Enter', shiftKey: true })],
  ];

  it.each(['keyup', 'keypress'])('passes %s of every chord, so xterm sees the whole sequence of the key', (type) => {
    for (const [, event] of chords) {
      expect(decideKey({ ...event, type }, SELECTION), `${type} ${event.key}`).toBe('pass');
    }
  });

  it('does not interfere with an input method composition', () => {
    for (const [name, event] of chords) {
      expect(decideKey({ ...event, isComposing: true }, SELECTION), name).toBe('pass');
      // the legacy "processing" key code that browsers send during composition
      expect(decideKey({ ...event, key: 'Process' }, SELECTION), name).toBe('pass');
    }
  });
});

describe('decideKey: the table, as one list', () => {
  // The rows of 7.5 in the order of the design, so a change to the table is a change to this list.
  const rows: [string, KeyEventLike, KeyContext, KeyDecision][] = [
    ['Ctrl+Shift+Space', key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }), NO_SELECTION, 'release'],
    ['Ctrl+C with a selection', ctrl('c'), SELECTION, 'copy'],
    ['Ctrl+C without a selection', ctrl('c'), NO_SELECTION, 'pass'],
    ['Meta+C with a selection', key({ key: 'c', metaKey: true }), SELECTION, 'copy'],
    ['Ctrl+Shift+C with a selection', ctrl('C', { shiftKey: true }), SELECTION, 'copy'],
    ['Ctrl+Shift+C without a selection', ctrl('C', { shiftKey: true }), NO_SELECTION, 'swallow'],
    ['Ctrl+V', ctrl('v'), NO_SELECTION, 'paste'],
    ['Ctrl+V on macOS', ctrl('v'), MAC_NO_SELECTION, 'pass'],
    ['Ctrl+Shift+V', ctrl('V', { shiftKey: true }), NO_SELECTION, 'pass'],
    ['Shift+Insert', key({ key: 'Insert', shiftKey: true }), NO_SELECTION, 'pass'],
    ['Ctrl+Insert', key({ key: 'Insert', ctrlKey: true }), NO_SELECTION, 'pass'],
    ['Shift+Enter', key({ key: 'Enter', shiftKey: true }), NO_SELECTION, 'newline'],
    ['Shift+Enter with a selection', key({ key: 'Enter', shiftKey: true }), SELECTION, 'newline'],
    ['Enter', key({ key: 'Enter' }), NO_SELECTION, 'pass'],
    ['Alt+Enter', key({ key: 'Enter', altKey: true }), NO_SELECTION, 'pass'],
    ['everything else', key({ key: 'q' }), SELECTION, 'pass'],
  ];

  it.each(rows)('%s', (_name, event, ctx, expected) => {
    expect(decideKey(event, ctx)).toBe(expected);
  });
});
