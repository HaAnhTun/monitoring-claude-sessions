import { afterEach, describe, expect, it, vi } from 'vitest';

import { ratio, readTokenSheet, resolve, type Theme, type Tokens } from '../test/css-tokens.ts';
import {
  TERMINAL_FONT,
  TERMINAL_THEME_TOKENS,
  colorToHex,
  cssColorResolver,
  readTerminalOptions,
  terminalFontSize,
  terminalThemeFrom,
  type ColorResolver,
  type TerminalTheme,
} from './term-theme.ts';

// The terminal theme is data (ADR 0100, design 05 section 4): sixteen ANSI tokens, the three terminal aliases and the selection are
// read from the computed style and handed to the terminal as an object. `light-dark()` custom properties are stored unresolved, so
// the browser path goes through a probe element; here the resolver is fed from the parsed tokens.css, once per theme, and a small
// stand-in for `getComputedStyle` proves the probe path end to end. The terminal package (xterm) is not imported: the type is structural.

const sheet = readTokenSheet();
const themes: Record<Theme, Tokens> = { light: sheet.light, dark: sheet.dark };

/** A resolver that answers from the tokens of one theme (what the probe gives in a real browser). */
function tokenResolver(theme: Theme): ColorResolver {
  return (token) => resolve(themes[theme], token);
}

const KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
  'scrollbarSliderBackground',
  'scrollbarSliderHoverBackground',
  'scrollbarSliderActiveBackground',
] as const satisfies readonly (keyof TerminalTheme)[];

const ANSI_KEYS = KEYS.slice(5, 21);

/** `#rrggbb` as the `rgb(r, g, b)` text a browser reports for a computed colour. */
function asRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

/** A stand-in for `getComputedStyle` that behaves like Chrome for the two reads this module makes. */
function stubComputedStyle(theme: Theme, overrides: { mono?: string } = {}): void {
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const written = (element as HTMLElement).style.color;
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(written);
    return {
      color: ref?.[1] === undefined ? '' : asRgb(resolve(themes[theme], ref[1])),
      getPropertyValue: (name: string) =>
        name === '--mono' ? (overrides.mono ?? sheet.plain.get('--mono') ?? '') : '',
    };
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('TERMINAL_THEME_TOKENS', () => {
  it('names the 24 keys of the theme', () => {
    expect(Object.keys(TERMINAL_THEME_TOKENS).sort()).toEqual([...KEYS].sort());
  });

  it('maps each key to the token of design 05 section 4', () => {
    expect(TERMINAL_THEME_TOKENS).toMatchObject({
      background: '--term-bg',
      foreground: '--term-fg',
      cursor: '--term-cursor',
      cursorAccent: '--term-bg',
      selectionBackground: '--selection',
      black: '--ansi-black',
      white: '--ansi-white',
      brightBlack: '--ansi-bright-black',
      brightWhite: '--ansi-bright-white',
      scrollbarSliderBackground: '--border-strong',
      scrollbarSliderHoverBackground: '--control-border',
      scrollbarSliderActiveBackground: '--text-muted',
    });
    for (const key of ANSI_KEYS) {
      const name = key.startsWith('bright') ? `bright-${key.slice(6).toLowerCase()}` : key;
      expect(TERMINAL_THEME_TOKENS[key], key).toBe(`--ansi-${name}`);
    }
  });

  it('names only tokens that tokens.css declares', () => {
    for (const token of Object.values(TERMINAL_THEME_TOKENS)) {
      expect(sheet.light.has(token), `${token} is declared`).toBe(true);
      expect(sheet.dark.has(token), `${token} is declared`).toBe(true);
    }
  });
});

describe.each(['light', 'dark'] as const)('terminalThemeFrom, %s theme, resolver fed from tokens.css', (theme) => {
  const built = terminalThemeFrom(tokenResolver(theme));

  it('fills every key with a #rrggbb colour', () => {
    expect(Object.keys(built).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(built[key], key).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('asks the resolver for exactly the token of each key', () => {
    const asked: string[] = [];
    terminalThemeFrom((token) => {
      asked.push(token);
      return '#000000';
    });
    expect(asked.sort()).toEqual(Object.values(TERMINAL_THEME_TOKENS).sort());
  });

  it('uses the page background, the text colour and the selection of the theme', () => {
    expect(built.background).toBe(resolve(themes[theme], '--bg'));
    expect(built.foreground).toBe(resolve(themes[theme], '--text'));
    expect(built.cursor).toBe(resolve(themes[theme], '--text'));
    expect(built.cursorAccent).toBe(built.background);
    expect(built.selectionBackground).toBe(resolve(themes[theme], '--selection'));
  });

  it('keeps the text at 4.5:1 and the cursor at 3:1 on the background, and the text on the selection at 4.5:1', () => {
    expect(ratio(built.foreground, built.background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(built.cursor, built.background)).toBeGreaterThanOrEqual(3);
    expect(ratio(built.foreground, built.selectionBackground)).toBeGreaterThanOrEqual(4.5);
  });

  for (const key of ANSI_KEYS) {
    const exempt = theme === 'dark' && key === 'black';
    it(`${key} is ${exempt ? 'the one colour below' : 'at least'} 4.5:1 on the terminal background`, () => {
      const value = ratio(built[key], built.background);
      if (exempt) expect(value).toBeLessThan(4.5);
      else expect(value).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the two themes', () => {
  it('differ in the colours and agree on the keys', () => {
    const light = terminalThemeFrom(tokenResolver('light'));
    const dark = terminalThemeFrom(tokenResolver('dark'));
    expect(light.background).toBe('#f5f2ea');
    expect(dark.background).toBe('#141414');
    expect(dark.red).toBe('#e06c75');
    expect(light.white).toBe('#4a453b');
    expect(dark.white).toBe('#d4d4d4');
    expect(Object.keys(light)).toEqual(Object.keys(dark));
  });
});

describe('colorToHex', () => {
  it.each([
    ['rgb(224, 108, 117)', '#e06c75'],
    ['rgb(224 108 117)', '#e06c75'],
    ['rgba(224, 108, 117, 1)', '#e06c75'],
    ['rgba(224, 108, 117, 0.5)', '#e06c7580'],
    ['rgb(224 108 117 / 50%)', '#e06c7580'],
    ['rgb(100% 0% 0%)', '#ff0000'],
    ['rgba(0, 0, 0, 0)', '#00000000'],
    ['color(srgb 0.8784 0.4235 0.4588)', '#e06c75'],
    ['color(srgb 1 0 0 / 0.5)', '#ff000080'],
    ['#E06C75', '#e06c75'],
    ['#abc', '#aabbcc'],
    ['#e06c75ff', '#e06c75ff'],
    ['  rgb(1, 2, 3)  ', '#010203'],
  ])('reads %s as %s', (input, expected) => {
    expect(colorToHex(input)).toBe(expected);
  });

  it.each([[''], ['red'], ['var(--x)'], ['rgb(1, 2)'], ['color(display-p3 1 0 0)']])(
    'returns %j unchanged (the caller sees what the browser said)',
    (input) => {
      expect(colorToHex(input)).toBe(input);
    },
  );

  it('clamps channels to the byte range', () => {
    expect(colorToHex('rgb(300, -5, 12)')).toBe('#ff000c');
  });
});

describe('cssColorResolver (the probe element)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`reads the ${theme} theme through a probe: the same theme as the parsed tokens`, () => {
      stubComputedStyle(theme);
      expect(terminalThemeFrom(cssColorResolver())).toEqual(terminalThemeFrom(tokenResolver(theme)));
    });
  }

  it('writes var(--token) to the color of a hidden probe and removes the probe afterwards', () => {
    const seen: { color: string; hidden: boolean; parent: Element | null }[] = [];
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
      seen.push({ color: element.style.color, hidden: element.hidden === true, parent: element.parentElement });
      return { color: 'rgb(224, 108, 117)', getPropertyValue: () => '' };
    });
    const before = document.documentElement.childElementCount;
    expect(cssColorResolver()('--ansi-red')).toBe('#e06c75');
    expect(seen).toEqual([{ color: 'var(--ansi-red)', hidden: true, parent: document.documentElement }]);
    expect(document.documentElement.childElementCount).toBe(before);
  });

  it('leaves the color-scheme of the probe to the page unless a scheme is given, and then states it', () => {
    const schemes: string[] = [];
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
      schemes.push(element.style.colorScheme);
      return { color: 'rgb(0, 0, 0)', getPropertyValue: () => '' };
    });
    cssColorResolver()('--bg');
    cssColorResolver(undefined, 'dark')('--bg');
    cssColorResolver(undefined, 'light')('--bg');
    expect(schemes).toEqual(['', 'dark', 'light']);
  });

  it('puts the probe under the given root and leaves the root as it was', () => {
    const root = document.createElement('div');
    document.body.append(root);
    let parent: Element | null = null;
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
      parent = element.parentElement;
      return { color: 'rgb(0, 0, 0)', getPropertyValue: () => '' };
    });
    expect(cssColorResolver(root)('--bg')).toBe('#000000');
    expect(parent).toBe(root);
    expect(root.childElementCount).toBe(0);
  });

  it('removes the probe even when the style read throws', () => {
    vi.stubGlobal('getComputedStyle', () => {
      throw new Error('style read failed');
    });
    const before = document.documentElement.childElementCount;
    expect(() => cssColorResolver()('--bg')).toThrow('style read failed');
    expect(document.documentElement.childElementCount).toBe(before);
  });

  it('hands back an unparsed answer as it is (no throw, no invented colour)', () => {
    vi.stubGlobal('getComputedStyle', () => ({ color: '', getPropertyValue: () => '' }));
    expect(cssColorResolver()('--bg')).toBe('');
  });
});

describe('TERMINAL_FONT', () => {
  it('repeats the --mono token exactly (the fallback when the page has not loaded its styles)', () => {
    const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();
    expect(squash(TERMINAL_FONT.family)).toBe(squash(sheet.plain.get('--mono') ?? ''));
  });

  it('holds the sizes of the design: 13 px, 12 px below 700 px, line height 1.2', () => {
    expect(TERMINAL_FONT).toMatchObject({ size: 13, sizeNarrow: 12, narrowBelow: 700, lineHeight: 1.2 });
  });

  it('holds no contrast ratio: a minimum contrast is the terminal area decision (conflict X6, ADR 0097)', () => {
    expect('minimumContrastRatio' in TERMINAL_FONT).toBe(false);
  });
});

describe('terminalFontSize', () => {
  it.each([
    [0, 12],
    [600, 12],
    [699, 12],
    [699.5, 12],
    [700, 13],
    [701, 13],
    [1024, 13],
    [1920, 13],
  ])('is %d px wide: %d px font', (width, size) => {
    expect(terminalFontSize(width)).toBe(size);
  });

  it('reads a width that is not a finite number as wide', () => {
    expect(terminalFontSize(Number.NaN)).toBe(13);
    expect(terminalFontSize(Number.POSITIVE_INFINITY)).toBe(13);
  });
});

describe('readTerminalOptions', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`returns the ${theme} theme, the --mono family, the size and the line height`, () => {
      stubComputedStyle(theme);
      const options = readTerminalOptions(undefined, 1280);
      expect(options.theme).toEqual(terminalThemeFrom(tokenResolver(theme)));
      expect(options.fontFamily).toBe(sheet.plain.get('--mono'));
      expect(options.fontSize).toBe(13);
      expect(options.lineHeight).toBe(1.2);
    });
  }

  it('returns theme, fontFamily, fontSize and lineHeight only (no minimumContrastRatio)', () => {
    stubComputedStyle('dark');
    expect(Object.keys(readTerminalOptions(undefined, 1280)).sort()).toEqual([
      'fontFamily',
      'fontSize',
      'lineHeight',
      'theme',
    ]);
  });

  it('uses 12 px below 700 px of viewport width and 13 px from 700 px', () => {
    stubComputedStyle('dark');
    expect(readTerminalOptions(undefined, 699).fontSize).toBe(12);
    expect(readTerminalOptions(undefined, 700).fontSize).toBe(13);
  });

  it('reads the width of the window when none is given', () => {
    stubComputedStyle('dark');
    vi.stubGlobal('innerWidth', 600);
    expect(readTerminalOptions().fontSize).toBe(12);
    vi.stubGlobal('innerWidth', 1440);
    expect(readTerminalOptions().fontSize).toBe(13);
  });

  it('falls back to the family constant when the page has no --mono', () => {
    stubComputedStyle('light', { mono: '   ' });
    expect(readTerminalOptions(undefined, 1280).fontFamily).toBe(TERMINAL_FONT.family);
  });

  it('trims the family the browser reports', () => {
    stubComputedStyle('light', { mono: '  Consolas, monospace  ' });
    expect(readTerminalOptions(undefined, 1280).fontFamily).toBe('Consolas, monospace');
  });
});
