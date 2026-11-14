// The terminal theme as data (ADR 0100, design 05 section 4). The 16 ANSI colours, the terminal aliases and the selection are CSS
// custom properties (`--ansi-*`, `--term-*`, `--selection` of `styles/tokens.css`); this module reads them from the computed style
// and returns the object a terminal widget takes as its `theme` option. No dependency on xterm: `TerminalTheme` is structural, so
// the module is testable on its own and the terminal area owns the package pin (ADR 0097).
//
// Why a probe element: a custom property declared as `light-dark(a, b)` is stored unresolved, so
// `getComputedStyle(root).getPropertyValue('--bg')` is the text `light-dark(#f5f2ea, #141414)`. The probe sets
// `probe.style.color = 'var(--ansi-red)'` (a CSSOM write, which the CSP `style-src 'self'` allows), reads the resolved `color` and
// converts it to hex. Only values that are not colours (the font family) are read straight from the custom property.
//
// What is deliberately not here (conflict X6 of the plan): the renderer choice, a minimum contrast ratio and the scrollback. They
// belong to the terminal area (`terminal/options.ts`, ADR 0097); `readTerminalOptions` hands over theme, font family, size and line
// height only.

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
}

/** The CSS custom property behind each key of the theme. */
export const TERMINAL_THEME_TOKENS: Readonly<Record<keyof TerminalTheme, string>> = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-bg',
  selectionBackground: '--selection',
  black: '--ansi-black',
  red: '--ansi-red',
  green: '--ansi-green',
  yellow: '--ansi-yellow',
  blue: '--ansi-blue',
  magenta: '--ansi-magenta',
  cyan: '--ansi-cyan',
  white: '--ansi-white',
  brightBlack: '--ansi-bright-black',
  brightRed: '--ansi-bright-red',
  brightGreen: '--ansi-bright-green',
  brightYellow: '--ansi-bright-yellow',
  brightBlue: '--ansi-bright-blue',
  brightMagenta: '--ansi-bright-magenta',
  brightCyan: '--ansi-bright-cyan',
  brightWhite: '--ansi-bright-white',
  scrollbarSliderBackground: '--border-strong',
  scrollbarSliderHoverBackground: '--control-border',
  scrollbarSliderActiveBackground: '--text-muted',
};

/** Resolves a custom property name (`--ansi-red`) to the colour it has right now (`#e06c75`). */
export type ColorResolver = (token: string) => string;

/** The theme for the colours a resolver returns; the resolver is asked once per key. */
export function terminalThemeFrom(resolve: ColorResolver): TerminalTheme {
  // written key by key, so that the compiler fails when a key is added to the theme and not here
  const t = TERMINAL_THEME_TOKENS;
  return {
    background: resolve(t.background),
    foreground: resolve(t.foreground),
    cursor: resolve(t.cursor),
    cursorAccent: resolve(t.cursorAccent),
    selectionBackground: resolve(t.selectionBackground),
    black: resolve(t.black),
    red: resolve(t.red),
    green: resolve(t.green),
    yellow: resolve(t.yellow),
    blue: resolve(t.blue),
    magenta: resolve(t.magenta),
    cyan: resolve(t.cyan),
    white: resolve(t.white),
    brightBlack: resolve(t.brightBlack),
    brightRed: resolve(t.brightRed),
    brightGreen: resolve(t.brightGreen),
    brightYellow: resolve(t.brightYellow),
    brightBlue: resolve(t.brightBlue),
    brightMagenta: resolve(t.brightMagenta),
    brightCyan: resolve(t.brightCyan),
    brightWhite: resolve(t.brightWhite),
    scrollbarSliderBackground: resolve(t.scrollbarSliderBackground),
    scrollbarSliderHoverBackground: resolve(t.scrollbarSliderHoverBackground),
    scrollbarSliderActiveBackground: resolve(t.scrollbarSliderActiveBackground),
  };
}

const byteHex = (value: number): string =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');

/** One number of a colour function: `12`, `-5`, `0.5` or `50%` (a percentage is a fraction of `full`). */
function channelOf(text: string, full: number): number {
  return text.endsWith('%') ? (Number.parseFloat(text) / 100) * full : Number.parseFloat(text);
}

/**
 * A computed colour as `#rrggbb`, or `#rrggbbaa` when it is not opaque. Chrome reports `rgb(r, g, b)` or `rgba(r, g, b, a)` for a
 * resolved colour; the space-separated form and `color(srgb ...)` are read too. A text that is none of these (an empty answer, a
 * keyword, another colour space) is returned unchanged, so the caller sees what the browser said and nothing is invented.
 */
export function colorToHex(computed: string): string {
  const value = computed.trim().toLowerCase();
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(value);
  if (long !== null) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short !== null)
    return `#${short
      .slice(1)
      .map((c) => c + c)
      .join('')}`;
  const fn = /^(rgba?|color)\(([^)]*)\)$/.exec(value);
  if (fn?.[1] === undefined || fn[2] === undefined) return computed;
  let body = fn[2].trim();
  let full = 255;
  if (fn[1] === 'color') {
    if (!body.startsWith('srgb')) return computed;
    body = body.slice('srgb'.length);
    full = 1;
  }
  const numbers = body.match(/-?\d*\.?\d+%?/g);
  if (numbers === null || numbers.length < 3 || numbers.length > 4) return computed;
  const [r = '', g = '', b = '', a] = numbers;
  const scale = 255 / full;
  const rgb = [r, g, b].map((n) => channelOf(n, full) * scale);
  const alpha = a === undefined ? 1 : channelOf(a, 1);
  if (rgb.some((n) => Number.isNaN(n)) || Number.isNaN(alpha)) return computed;
  const hex = `#${rgb.map(byteHex).join('')}`;
  return alpha >= 1 ? hex : `${hex}${byteHex(Math.max(0, alpha) * 255)}`;
}

/**
 * A resolver that reads each token through a hidden probe element under `root` (default: the document element, where the tokens are
 * declared): `color: var(--token)` resolves `light-dark()` for the scheme of the probe. Without `scheme` the probe inherits the page's
 * `color-scheme` (the theme choice, or the system under `auto`); with it the probe states the scheme itself, so the answer does not
 * depend on when the page applied a change. The probe is removed after every read.
 */
export function cssColorResolver(root?: HTMLElement, scheme?: 'light' | 'dark'): ColorResolver {
  return (token) => {
    const host = root ?? document.documentElement;
    const probe = host.ownerDocument.createElement('span');
    probe.hidden = true;
    if (scheme !== undefined) probe.style.colorScheme = scheme;
    probe.style.color = `var(${token})`;
    host.append(probe);
    try {
      return colorToHex(getComputedStyle(probe).color);
    } finally {
      probe.remove();
    }
  };
}

/** The terminal font and sizes (design 05 section 4). The family repeats `--mono`; a test holds the two equal. */
export const TERMINAL_FONT: {
  readonly family: string;
  readonly size: 13;
  readonly sizeNarrow: 12;
  readonly narrowBelow: 700;
  readonly lineHeight: 1.2;
} = {
  family:
    "'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', 'Segoe UI Symbol', monospace",
  size: 13,
  sizeNarrow: 12,
  narrowBelow: 700,
  // the default of 1.0 clips the stacked marks of Vietnamese letters at the row boundary
  lineHeight: 1.2,
};

/** 13 px, and 12 px below a 700 px viewport (81 columns at 600 px). */
export function terminalFontSize(viewportWidth: number): 12 | 13 {
  return viewportWidth < TERMINAL_FONT.narrowBelow ? TERMINAL_FONT.sizeNarrow : TERMINAL_FONT.size;
}

/** What the page decides about the terminal's look; the terminal area adds everything else (scrollback, cursor, renderer). */
export interface TerminalLook {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/**
 * The look of the terminal for the page as it is now: the theme of the scheme in force, the `--mono` family, the size for the
 * viewport and the line height. Read again whenever `useTerminalTheme()` changes (state/color-scheme.ts).
 */
export function readTerminalOptions(
  root: HTMLElement = document.documentElement,
  viewportWidth: number = globalThis.innerWidth,
): TerminalLook {
  const family = getComputedStyle(root).getPropertyValue('--mono').trim();
  return {
    theme: terminalThemeFrom(cssColorResolver(root)),
    fontFamily: family === '' ? TERMINAL_FONT.family : family,
    fontSize: terminalFontSize(viewportWidth),
    lineHeight: TERMINAL_FONT.lineHeight,
  };
}
