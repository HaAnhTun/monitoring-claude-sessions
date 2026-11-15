// The options the app gives a terminal (design 04 7.2): the one place that mixes the values of the visual system (`readTerminalOptions`
// of `lib/term-theme.ts`: theme, font family, size, line height) with the ones this area owns. Pure, so each rule is a unit test.
// `useTerminalConnection` builds the creation options from it and applies the live ones (theme, size, screen reader mode, cursor)
// again when the page changes them.
import type { TerminalLook } from '../lib/term-theme.ts';
import type { TerminalOptions } from './engine.ts';

/**
 * Lines of history the terminal keeps (MTOP's value). Memory is allocated per used line: a full 200-column buffer is about 48 MB,
 * accepted for the one terminal that is open at a time.
 */
export const TERMINAL_SCROLLBACK = 20_000;

/**
 * The minimum contrast ratio the renderer enforces: 1, which is "off", whatever the visual system hands over (conflict X6, ADR 0097).
 * A higher value makes the DOM renderer recolour each cell it adjusts, so a program's own colours are no longer what the screen
 * shows. ADR 0097 decision 4 measured that with the CSSOM colour adapter a ratio of 4.5 now runs without a policy violation, and
 * recommends 1 on the dark theme and 4.5 on the light one (a dark 24-bit background with the default foreground is unreadable on
 * the light theme at 1). That is a product choice for the owner and is not made here: the value stays 1, and this constant is
 * the one line to change when the choice is made.
 */
export const DOM_RENDERER_MIN_CONTRAST = 1;

export interface TerminalOptionsInput {
  /** What the visual system decides (`readTerminalOptions(root, viewportWidth)`, with the theme of the scheme in force). */
  base: TerminalLook;
  /** The stored preferences that matter here; a missing one is off. */
  prefs: { readonly terminalScreenReader?: boolean | undefined };
  /** `prefers-reduced-motion: reduce`: the cursor does not blink. */
  reducedMotion: boolean;
  /**
   * The process runs under ConPTY, so xterm must not reflow the lines the way a Unix terminal does. `true` only when the host is
   * known to be Windows: the wire contract carries no host platform today, so a caller that does not know leaves it out.
   */
  windowsHost?: boolean | undefined;
}

export function terminalOptionsFor(input: TerminalOptionsInput): TerminalOptions {
  const { base, prefs, reducedMotion, windowsHost } = input;
  return {
    theme: base.theme,
    fontFamily: base.fontFamily,
    fontSize: base.fontSize,
    lineHeight: base.lineHeight,
    scrollback: TERMINAL_SCROLLBACK,
    cursorBlink: !reducedMotion,
    screenReaderMode: prefs.terminalScreenReader ?? false,
    minimumContrastRatio: DOM_RENDERER_MIN_CONTRAST,
    ...(windowsHost === true ? { windowsPty: { backend: 'conpty' as const } } : {}),
  };
}
