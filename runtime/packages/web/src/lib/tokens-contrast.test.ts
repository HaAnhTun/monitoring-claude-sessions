// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STYLES_DIR,
  luminance,
  ratio,
  readRules,
  readSheet,
  readTokenSheet,
  readTokensCss,
  resolve,
  rgb,
  splitLightDark,
  stripComments,
  type Rule,
  type Theme,
  type Tokens,
} from '../test/css-tokens.ts';

// WCAG 2 contrast of the colour pairs of ADR 0100 (which carries the gate of ADR 0071 decision 11 forward), read from
// styles/tokens.css. Colours are written once as `light-dark(light, dark)` inside `@supports`; the plain `:root` block holds the
// light fallback. The parser lives in `test/css-tokens.ts`. A new colour pair that a component uses must be added to PAIRS so that
// the check keeps covering every combination. The core set below is the set of the design calculator
// (`.dev/caw/design/contrast-check.mjs`: 135 pairs per theme, 270 checks), which produced the values of tokens.css.

/** Lines of a style sheet that carry a font weight of 700 or bold (ADR 0071 decision 4: 400, 500 and 600 only). */
function heavyWeights(raw: string): string[] {
  return stripComments(raw)
    .split('\n')
    .filter((line) => /font-weight\s*:\s*(?:700|800|900|bold|bolder)\b/i.test(line))
    .map((line) => line.trim());
}

/** Declarations of a `transition` that lists `outline`, `outline-color` or `all` (a transition fades the focus ring). */
function outlineTransitions(raw: string): string[] {
  const found: string[] = [];
  for (const m of stripComments(raw).matchAll(/transition(?:-property)?\s*:([^;}]*)[;}]/gi)) {
    const value = m[1] ?? '';
    if (/\boutline(?:-[a-z]+)?\b/i.test(value) || /(^|[\s,])all\b/i.test(value)) found.push(value.trim());
  }
  return found;
}

/** The blended colour the design calculator uses for a state tint: `fg` mixed into `bg` with weight `t` for `fg`. */
function mix(fg: string, bg: string, t: number): string {
  const f = rgb(fg, 'tint foreground');
  const b = rgb(bg, 'tint background');
  const channel = (i: number): string => {
    const base = b[i] ?? 0;
    return Math.round(base + ((f[i] ?? 0) - base) * t)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

const sheet = readTokenSheet();
const themes: Record<Theme, Tokens> = { light: sheet.light, dark: sheet.dark };

function contrast(theme: Theme, fg: string, bg: string): number {
  const tokens = themes[theme];
  return ratio(resolve(tokens, fg), resolve(tokens, bg));
}

const TEXT = 4.5; // WCAG 1.4.3
const UI = 3; // WCAG 1.4.11
const INFO = 1; // informational: reported, never required

/** The four page surfaces: the page, the panel, the hover fill and the selected row. */
const SURFACES = ['--bg', '--surface', '--surface-2', '--selected'] as const;
const STATES = ['working', 'waiting', 'ended', 'completed', 'failed', 'stale', 'unknown'] as const;
/** Names of ADR 0035 that components still use; they must keep resolving and keep their contrast. */
const LEGACY = ['running', 'waiting', 'idle', 'completed', 'failed', 'unknown', 'stale', 'partial', 'ok'] as const;
const ROLES = ['user', 'assistant', 'tool'] as const;
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const;

interface Pair {
  name: string;
  fg: string;
  bg: string;
  min: number;
  /** The dark theme is exempt (reported only): the dark ANSI black is the background colour of terminal programs. */
  exemptDark?: true;
}

/** The design set: every pair the calculator checks, in the same groups. */
const CORE_PAIRS: Pair[] = [
  ...SURFACES.flatMap((s): Pair[] => [
    { name: `text on ${s}`, fg: '--text', bg: s, min: TEXT },
    { name: `strong on ${s}`, fg: '--strong', bg: s, min: TEXT },
    { name: `muted text on ${s}`, fg: '--text-muted', bg: s, min: TEXT },
    { name: `accent text on ${s}`, fg: '--accent', bg: s, min: TEXT },
    { name: `focus ring on ${s}`, fg: '--focus', bg: s, min: UI },
    { name: `control border on ${s}`, fg: '--control-border', bg: s, min: UI },
    ...ROLES.map((r) => ({ name: `role ${r} on ${s}`, fg: `--role-${r}`, bg: s, min: UI })),
  ]),
  { name: 'accent-contrast on the accent button', fg: '--accent-contrast', bg: '--accent', min: TEXT },
  ...STATES.flatMap((state): Pair[] => [
    { name: `${state} label on its tint`, fg: `--state-${state}-fg`, bg: `--state-${state}-bg`, min: TEXT },
    { name: `text on the ${state} tint`, fg: '--text', bg: `--state-${state}-bg`, min: TEXT },
    { name: `muted text on the ${state} tint`, fg: '--text-muted', bg: `--state-${state}-bg`, min: TEXT },
    ...SURFACES.map((s) => ({ name: `${state} label on ${s}`, fg: `--state-${state}-fg`, bg: s, min: TEXT })),
    ...SURFACES.map((s) => ({ name: `${state} dot on ${s}`, fg: `--state-${state}-dot`, bg: s, min: UI })),
  ]),
  ...ANSI.map((n): Pair => ({
    name: `ansi ${n} on the terminal background`,
    fg: `--ansi-${n}`,
    bg: '--term-bg',
    min: TEXT,
    ...(n === 'black' ? { exemptDark: true as const } : {}),
  })),
  { name: 'terminal text on the terminal background', fg: '--term-fg', bg: '--term-bg', min: TEXT },
  { name: 'terminal cursor on the terminal background', fg: '--term-cursor', bg: '--term-bg', min: UI },
  { name: 'terminal text on the selection', fg: '--term-fg', bg: '--selection', min: TEXT },
  { name: 'brand mark on the surface (a graphic)', fg: '--brand', bg: '--surface', min: UI },
  { name: 'faint on the surface (decoration only)', fg: '--faint', bg: '--surface', min: INFO },
];

/** Aliases of ADR 0035 that components still use. */
const LEGACY_PAIRS: Pair[] = LEGACY.flatMap((s) => [
  { name: `legacy ${s} text on its badge`, fg: `--${s}-fg`, bg: `--${s}-bg`, min: TEXT },
  { name: `legacy ${s} text on the surface`, fg: `--${s}-fg`, bg: '--surface', min: TEXT },
]);

const PAIRS: Pair[] = [...CORE_PAIRS, ...LEGACY_PAIRS];

function minimumFor(pair: Pair, theme: Theme): number {
  return theme === 'dark' && pair.exemptDark === true ? INFO : pair.min;
}

describe('tokens.css contrast (ADR 0100)', () => {
  it('finds the plain fallback and the light-dark pairs', () => {
    expect(sheet.plain.size).toBeGreaterThan(100);
    expect(sheet.pairs.size).toBeGreaterThanOrEqual(58);
    for (const name of [
      '--bg',
      '--surface',
      '--surface-2',
      '--selected',
      '--text',
      '--strong',
      '--faint',
      '--accent',
      '--focus',
      '--control-border',
      '--state-working-dot',
      '--role-user',
      '--ansi-red',
      '--selection',
      '--backdrop',
      '--elev-1',
      '--elev-2',
    ]) {
      expect(sheet.pairs.has(name), `${name} is a light-dark pair`).toBe(true);
    }
  });

  it('checks the 270 pairs of the design calculator, each pair name once', () => {
    expect(CORE_PAIRS).toHaveLength(135);
    expect(CORE_PAIRS.length * 2).toBe(270);
    expect(new Set(PAIRS.map((p) => p.name)).size).toBe(PAIRS.length);
  });

  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      for (const pair of PAIRS) {
        const min = minimumFor(pair, theme);
        it(`${pair.name} (${pair.fg} on ${pair.bg}) is at least ${String(min)}:1`, () => {
          expect(contrast(theme, pair.fg, pair.bg)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it('the plain fallback of :root equals the light half of every pair', () => {
    for (const [name, split] of sheet.pairs) {
      expect(sheet.plain.get(name), `${name} is declared in the plain :root block`).toBe(split.light);
    }
  });

  it('keeps one source for the dark values: light-dark(), no dark block, no auto block', () => {
    expect(sheet.darkBlocks).toEqual([]);
  });

  describe('the dark theme is the MTOP palette with two measured deviations', () => {
    const mtop: Record<string, string> = {
      '--bg': '#141414',
      '--surface': '#1b1b1b',
      '--surface-2': '#242424',
      '--border': '#2c2c2c',
      '--text': '#d4d4d4',
      '--strong': '#f0f0f0',
      '--faint': '#5e5e5e',
      '--accent': '#d97757',
      '--state-completed-dot': '#6cc785',
      '--state-stale-dot': '#e2c070',
      '--state-working-dot': '#7aa2f7',
      '--state-failed-dot': '#e06c75',
    };
    for (const [name, value] of Object.entries(mtop)) {
      it(`${name} keeps the MTOP value ${value}`, () => {
        expect(sheet.dark.get(name)).toBe(value);
      });
    }

    it('--text-muted deviates from the MTOP dim colour, which fails on the MTOP selected surface', () => {
      expect(ratio('#8c8c8c', '#2a2e33')).toBeLessThan(TEXT);
      expect(sheet.dark.get('--text-muted')).toBe('#9a9a9a');
      expect(contrast('dark', '--text-muted', '--selected')).toBeGreaterThanOrEqual(TEXT);
    });

    it('--selected deviates from the MTOP selected colour, on which the accent fails as link text', () => {
      expect(ratio('#d97757', '#2a2e33')).toBeLessThan(TEXT);
      expect(sheet.dark.get('--selected')).toBe('#262a2f');
      expect(contrast('dark', '--accent', '--selected')).toBeGreaterThanOrEqual(TEXT);
    });
  });

  describe('the light theme is warm', () => {
    it('is a cream page, a lighter panel and a darker hover and selected fill', () => {
      expect(sheet.light.get('--bg')).toBe('#f5f2ea');
      const lum = (token: string): number => luminance(rgb(resolve(sheet.light, token), token));
      expect(lum('--surface')).toBeGreaterThan(lum('--bg'));
      expect(lum('--surface-2')).toBeLessThan(lum('--surface'));
      expect(lum('--selected')).toBeLessThan(lum('--surface'));
    });

    it('--accent is darker than the brand orange, which is too light for text on the cream surface', () => {
      expect(sheet.plain.get('--brand')).toBe('#d97757');
      expect(contrast('light', '--brand', '--surface')).toBeLessThan(TEXT);
      expect(sheet.light.get('--accent')).not.toBe(sheet.plain.get('--brand'));
      expect(sheet.light.get('--focus')).toBe(sheet.light.get('--accent'));
    });
  });

  it('declares --brand once, in the plain :root block, never as a pair', () => {
    expect(sheet.plain.get('--brand')).toBe('#d97757');
    expect(sheet.pairs.has('--brand')).toBe(false);
    expect(sheet.dark.get('--brand')).toBe(sheet.light.get('--brand'));
    expect(readTokensCss().match(/--brand\s*:/g)).toHaveLength(1);
  });

  it('derives every state tint from its label colour and the surface (10 % light, 14 % dark)', () => {
    const weight: Record<Theme, number> = { light: 0.1, dark: 0.14 };
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themes[theme];
      for (const state of STATES) {
        const fg = resolve(tokens, `--state-${state}-fg`);
        const surface = resolve(tokens, '--surface');
        expect(resolve(tokens, `--state-${state}-bg`), `${theme} ${state} tint`).toBe(mix(fg, surface, weight[theme]));
      }
    }
  });

  it('declares the terminal and recency aliases and the ANSI colours', () => {
    expect(sheet.plain.get('--term-bg')).toBe('var(--bg)');
    expect(sheet.plain.get('--term-fg')).toBe('var(--text)');
    expect(sheet.plain.get('--term-cursor')).toBe('var(--text)');
    expect(sheet.plain.get('--recency-full')).toBe('var(--state-completed-dot)');
    expect(sheet.plain.get('--recency-half')).toBe('var(--state-stale-dot)');
    expect(sheet.plain.get('--recency-none')).toBe('var(--faint)');
    for (const name of ANSI) expect(sheet.pairs.has(`--ansi-${name}`), `--ansi-${name}`).toBe(true);
    expect(sheet.light.get('--ansi-white')).toBe('#4a453b');
    expect(sheet.dark.get('--ansi-white')).toBe('#d4d4d4');
  });

  it('declares the tokens of ADR 0100 with their values', () => {
    const values: Record<string, string> = {
      '--fs-xs': '0.6875rem',
      '--fs-sm': '0.75rem',
      '--fs-md': '0.8125rem',
      '--fs-lg': '0.9375rem',
      '--fs-xl': '1.125rem',
      '--fs-2xl': '1.5rem',
      '--lh-xs': '1rem',
      '--lh-sm': '1.125rem',
      '--lh-md': '1.25rem',
      '--lh-lg': '1.375rem',
      '--lh-xl': '1.625rem',
      '--lh-2xl': '2rem',
      '--lh': '1.5',
      '--fw-regular': '400',
      '--fw-medium': '500',
      '--fw-semibold': '600',
      '--radius-sm': '3px',
      '--radius': '4px',
      '--radius-lg': '6px',
      '--radius-pill': '999px',
      '--border-w': '1px',
      '--d': '1',
      '--ctl-h': '30px',
      '--ctl-h-inline': '24px',
      '--row-h': '36px',
      '--row-h-list': '26px',
      '--topbar-h': '40px',
      '--side-w': '240px',
      '--side-w-rail': '56px',
      '--list-w': '320px',
      '--bp-wide': '1280px',
      '--bp-rail': '1199px',
      '--bp-narrow': '899px',
      '--bp-list': '1023px',
      '--bp-min': '600px',
      '--t-fast': '120ms ease',
      '--t-med': '200ms ease',
      '--focus-ring': '2px solid var(--focus)',
    };
    for (const [name, value] of Object.entries(values)) expect(sheet.plain.get(name), name).toBe(value);
    for (const [i, px] of [2, 4, 8, 12, 16, 24, 32, 48].entries()) {
      expect(sheet.plain.get(`--sp-${String(i + 1)}`), `--sp-${String(i + 1)}`).toBe(
        `calc(${String(px)}px * var(--d))`,
      );
    }
    for (const name of ['--elev-1', '--elev-2', '--backdrop', '--page-pad', '--row-cv-size', '--shadow']) {
      expect(sheet.plain.has(name), name).toBe(true);
    }
  });

  describe('the compact density', () => {
    const rules: Rule[] = [];
    readRules(stripComments(readTokensCss()), [], rules);
    const compact = rules.find((r) => r.selector.replaceAll("'", '"') === ':root[data-density="compact"]');

    it('lowers the spacing factor, the line height, the control and the rows', () => {
      expect(compact).toBeDefined();
      const body = (compact?.body ?? '').replace(/\s+/g, ' ');
      for (const part of ['--d: 0.75;', '--lh: 1.35;', '--ctl-h: 26px;', '--row-h: 28px;', '--row-h-list: 24px;']) {
        expect(body, part).toContain(part);
      }
    });

    it('keeps every interactive row at 24 px or more (WCAG 2.2)', () => {
      const px = (name: string): number => {
        const found = new RegExp(`${name}:\\s*([0-9.]+)px`).exec(compact?.body ?? '');
        return Number.parseFloat(found?.[1] ?? '0');
      };
      expect(px('--row-h-list')).toBeGreaterThanOrEqual(24);
      expect(px('--ctl-h')).toBeGreaterThanOrEqual(24);
      expect(Number.parseFloat(sheet.plain.get('--ctl-h-inline') ?? '0')).toBeGreaterThanOrEqual(24);
    });
  });

  describe('the monospace stack (ADR 0100, measured glyph coverage)', () => {
    const mono = (sheet.plain.get('--mono') ?? '').replaceAll('"', "'");
    const quoted = (name: string): number => mono.indexOf(`'${name}'`);

    it('starts with Cascadia Mono and ends with the generic monospace family', () => {
      expect(mono.startsWith("'Cascadia Mono'")).toBe(true);
      expect(mono.trim().endsWith('monospace')).toBe(true);
    });

    it('lists Consolas, then Courier New, then Segoe UI Symbol, then the generic family', () => {
      const consolas = mono.search(/(^|,)\s*Consolas\s*(,|$)/);
      const courier = quoted('Courier New');
      const symbol = quoted('Segoe UI Symbol');
      expect(consolas).toBeGreaterThan(-1);
      expect(courier).toBeGreaterThan(consolas);
      expect(symbol).toBeGreaterThan(courier);
      expect(mono.lastIndexOf('monospace')).toBeGreaterThan(symbol);
    });

    it('never lists Lucida Console (42 of 134 Vietnamese letters) or a proportional family', () => {
      expect(mono).not.toMatch(/lucida|sans-serif|system-ui|'segoe ui'|\bserif\b/i);
    });

    it('makes --font an alias of --mono', () => {
      expect(sheet.plain.get('--font')).toBe('var(--mono)');
    });
  });

  describe('every style file', () => {
    const files = readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css'));
    it('sees the style files', () => {
      expect(files).toContain('tokens.css');
      expect(files.length).toBeGreaterThan(5);
    });
    for (const file of files) {
      const text = readFileSync(join(STYLES_DIR, file), 'utf8');
      it(`${file} has no font weight above 600`, () => {
        expect(heavyWeights(text)).toEqual([]);
      });
      it(`${file} has no transition that lists outline`, () => {
        expect(outlineTransitions(text)).toEqual([]);
      });
    }
  });

  describe('the checks themselves (negative probes)', () => {
    it('computes known WCAG ratios', () => {
      expect(ratio('#ffffff', '#000000')).toBeCloseTo(21, 5);
      expect(ratio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    });

    it('rejects a deliberately weak colour pair', () => {
      expect(ratio('#aaaaaa', '#ffffff')).toBeLessThan(TEXT);
      const weak = readSheet(
        ':root{--a:#ffffff;--b:#ffffff;}@supports (color: light-dark(black, white)){:root{--a:light-dark(#ffffff,#000000);--b:light-dark(#ffffff,#000000);}}',
      );
      expect(ratio(weak.light.get('--a') ?? '', weak.light.get('--b') ?? '')).toBe(1);
    });

    it('reads light-dark() pairs, including the ones inside a shadow', () => {
      expect(splitLightDark('light-dark(#fff, #000)')).toEqual({ light: '#fff', dark: '#000' });
      expect(splitLightDark('0 1px 2px light-dark(rgb(0 0 0 / 0.1), rgb(0 0 0 / 0.4))')).toEqual({
        light: '0 1px 2px rgb(0 0 0 / 0.1)',
        dark: '0 1px 2px rgb(0 0 0 / 0.4)',
      });
      expect(splitLightDark('#fff')).toBeNull();
    });

    it('reads a two-layer shadow whose layers swap with the theme', () => {
      expect(
        splitLightDark(
          '0 6px 18px light-dark(rgb(1 2 3 / 0.1), transparent), 0 8px 24px light-dark(transparent, #000)',
        ),
      ).toEqual({
        light: '0 6px 18px rgb(1 2 3 / 0.1), 0 8px 24px transparent',
        dark: '0 6px 18px transparent, 0 8px 24px #000',
      });
    });

    it('follows a bare var() reference and fails on a missing token', () => {
      const tokens: Tokens = new Map([
        ['--a', 'var(--b)'],
        ['--b', '#123456'],
      ]);
      expect(resolve(tokens, '--a')).toBe('#123456');
      expect(() => resolve(tokens, '--missing')).toThrow('--missing');
    });

    it('refuses a colour that is not a hex value', () => {
      expect(() => rgb('rgb(1 2 3)', '--x')).toThrow('--x');
      expect(rgb('#fff', '--x')).toEqual([255, 255, 255]);
    });

    it('catches a plain value that differs from the light half', () => {
      const bad = readSheet(
        ':root{--a:#111111;}@supports (color: light-dark(black, white)){:root{--a:light-dark(#222222,#eeeeee);}}',
      );
      expect(bad.plain.get('--a')).not.toBe(bad.pairs.get('--a')?.light);
    });

    it('catches weight 700 and bold', () => {
      expect(heavyWeights('a{font-weight:700}')).toHaveLength(1);
      expect(heavyWeights('a{font-weight: bold;}')).toHaveLength(1);
      expect(heavyWeights('a{font-weight: 600;}\n/* font-weight: 700 */')).toEqual([]);
    });

    it('catches a transition that lists outline or all', () => {
      expect(outlineTransitions('a{transition: outline 120ms ease}')).toHaveLength(1);
      expect(outlineTransitions('a{transition: background 1s, outline-color 1s;}')).toHaveLength(1);
      expect(outlineTransitions('a{transition: all 1s;}')).toHaveLength(1);
      expect(outlineTransitions('a{transition: background 1s, color 1s;}')).toEqual([]);
    });

    it('catches a second block of dark values', () => {
      const second = readSheet(":root{--a:#fff;}:root[data-theme='dark']{--a:#000;}");
      expect(second.darkBlocks).toHaveLength(1);
      const media = readSheet('@media (prefers-color-scheme: dark){:root{--a:#000;}}');
      expect(media.darkBlocks).toHaveLength(1);
      const auto = readSheet("@media (prefers-color-scheme: dark){:root[data-theme='auto']{--a:#000;}}");
      expect(auto.darkBlocks.length).toBeGreaterThan(0);
      expect(readSheet(":root[data-theme='dark']{color-scheme:dark;}").darkBlocks).toEqual([]);
    });

    it('catches a tint that is not the mix of its label and the surface', () => {
      expect(mix('#000000', '#ffffff', 0.1)).toBe('#e6e6e6');
      expect(mix('#000000', '#ffffff', 0.14)).not.toBe('#e6e6e6');
    });

    it('exempts only the dark ANSI black from the text minimum', () => {
      const black = PAIRS.find((p) => p.name === 'ansi black on the terminal background');
      const red = PAIRS.find((p) => p.name === 'ansi red on the terminal background');
      expect(black).toBeDefined();
      expect(red).toBeDefined();
      expect(black && minimumFor(black, 'dark')).toBe(INFO);
      expect(black && minimumFor(black, 'light')).toBe(TEXT);
      expect(red && minimumFor(red, 'dark')).toBe(TEXT);
      expect(contrast('dark', '--ansi-black', '--term-bg')).toBeLessThan(TEXT);
    });
  });
});
