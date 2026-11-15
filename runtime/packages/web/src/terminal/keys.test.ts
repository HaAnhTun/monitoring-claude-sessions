// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { decideKey, type KeyContext, type KeyDecision, type KeyEventLike } from './keys.ts';
import { RELEASE_CHORD } from './protocol.ts';

// Every row of the table in design 04 section 7.5 (keyboard ownership, copy and paste), with and without a selection and with the
// modifier combinations that must NOT trigger a row. The function is pure: the view performs the effect of the answer.

const NO_SELECTION: KeyContext = { hasSelection: false };
const SELECTION: KeyContext = { hasSelection: true };

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

describe('decideKey: paste and everything else', () => {
  it.each([
    ['Ctrl+V', ctrl('v')],
    ['Ctrl+Shift+V', ctrl('V', { shiftKey: true })],
    ['Shift+Insert', key({ key: 'Insert', shiftKey: true })],
  ])('passes %s to the browser, which pastes into the text area of the terminal', (_name, event) => {
    expect(decideKey(event, NO_SELECTION)).toBe('pass');
    expect(decideKey(event, SELECTION)).toBe('pass');
  });

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
    ['Ctrl+V', ctrl('v'), NO_SELECTION, 'pass'],
    ['Ctrl+Shift+V', ctrl('V', { shiftKey: true }), NO_SELECTION, 'pass'],
    ['Shift+Insert', key({ key: 'Insert', shiftKey: true }), NO_SELECTION, 'pass'],
    ['everything else', key({ key: 'q' }), SELECTION, 'pass'],
  ];

  it.each(rows)('%s', (_name, event, ctx, expected) => {
    expect(decideKey(event, ctx)).toBe(expected);
  });
});
