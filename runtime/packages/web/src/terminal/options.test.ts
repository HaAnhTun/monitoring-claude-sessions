import { describe, expect, it } from 'vitest';

import { readTerminalOptions, TERMINAL_FONT, type TerminalLook } from '../lib/term-theme.ts';
import { DOM_RENDERER_MIN_CONTRAST, TERMINAL_SCROLLBACK, terminalOptionsFor } from './options.ts';

// Design 04 7.2: `terminalOptionsFor` is the one place that mixes the values of the visual system (`readTerminalOptions`: theme, font,
// size) with the ones of the terminal area (scrollback, cursor, screen reader mode, the Windows hint, the contrast ratio).

function look(over: Partial<TerminalLook> = {}): TerminalLook {
  return {
    // the colours are invented: the test only follows them through
    theme: { background: '#101010', foreground: '#eeeeee' } as TerminalLook['theme'],
    fontFamily: "'Test Mono', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    ...over,
  };
}

const CALM = { prefs: {}, reducedMotion: false } as const;

describe('terminalOptionsFor', () => {
  it('passes the theme, the font family, the size and the line height of the visual system through unchanged', () => {
    const base = look({ fontSize: 12, lineHeight: 1.25 });
    const options = terminalOptionsFor({ base, ...CALM });
    expect(options.theme).toBe(base.theme);
    expect(options.fontFamily).toBe("'Test Mono', monospace");
    expect(options.fontSize).toBe(12);
    expect(options.lineHeight).toBe(1.25);
  });

  it('takes the output of readTerminalOptions as it is, at a wide and at a narrow viewport (13 and 12 px)', () => {
    const wide = terminalOptionsFor({ base: readTerminalOptions(document.documentElement, 1280), ...CALM });
    const narrow = terminalOptionsFor({ base: readTerminalOptions(document.documentElement, 600), ...CALM });
    expect(wide.fontSize).toBe(TERMINAL_FONT.size);
    expect(narrow.fontSize).toBe(TERMINAL_FONT.sizeNarrow);
    expect(wide.fontFamily).toBe(TERMINAL_FONT.family);
    expect(Object.keys(wide.theme)).toEqual(Object.keys(readTerminalOptions().theme));
  });

  it('keeps 20000 lines of history', () => {
    expect(TERMINAL_SCROLLBACK).toBe(20_000);
    expect(terminalOptionsFor({ base: look(), ...CALM }).scrollback).toBe(20_000);
  });

  it('blinks the cursor unless the person asked for reduced motion', () => {
    expect(terminalOptionsFor({ base: look(), prefs: {}, reducedMotion: false }).cursorBlink).toBe(true);
    expect(terminalOptionsFor({ base: look(), prefs: {}, reducedMotion: true }).cursorBlink).toBe(false);
  });

  it('follows the screen reader preference and is off when the preference was never set', () => {
    expect(terminalOptionsFor({ base: look(), prefs: {}, reducedMotion: false }).screenReaderMode).toBe(false);
    expect(
      terminalOptionsFor({ base: look(), prefs: { terminalScreenReader: false }, reducedMotion: false })
        .screenReaderMode,
    ).toBe(false);
    expect(
      terminalOptionsFor({ base: look(), prefs: { terminalScreenReader: true }, reducedMotion: false })
        .screenReaderMode,
    ).toBe(true);
  });

  it('says the process runs under ConPTY only when the host is known to be Windows', () => {
    expect('windowsPty' in terminalOptionsFor({ base: look(), ...CALM })).toBe(false);
    expect('windowsPty' in terminalOptionsFor({ base: look(), ...CALM, windowsHost: false })).toBe(false);
    expect(terminalOptionsFor({ base: look(), ...CALM, windowsHost: true }).windowsPty).toEqual({ backend: 'conpty' });
  });

  it('keeps the minimum contrast ratio at 1 whatever the base says (X6, ADR 0097)', () => {
    expect(DOM_RENDERER_MIN_CONTRAST).toBe(1);
    // a base that carries a ratio of its own (a later change of the visual system) must not reach the terminal
    const greedy = { ...look(), minimumContrastRatio: 4.5 };
    expect(terminalOptionsFor({ base: greedy, ...CALM }).minimumContrastRatio).toBe(1);
    expect(terminalOptionsFor({ base: look(), ...CALM }).minimumContrastRatio).toBe(1);
  });

  it('returns exactly the options of the engine seam: no proposed API flag, no line feed conversion (the engine sets those)', () => {
    expect(Object.keys(terminalOptionsFor({ base: look(), ...CALM })).sort()).toEqual(
      [
        'cursorBlink',
        'fontFamily',
        'fontSize',
        'lineHeight',
        'minimumContrastRatio',
        'screenReaderMode',
        'scrollback',
        'theme',
      ].sort(),
    );
  });

  it('does not change its input', () => {
    const base = look();
    const copy = structuredClone(base);
    terminalOptionsFor({ base, prefs: { terminalScreenReader: true }, reducedMotion: true, windowsHost: true });
    expect(base).toEqual(copy);
  });
});
