// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// WCAG 2 contrast of the colour pairs of ADR 0071 decision 11, read from styles/tokens.css. Colours are written once as
// `light-dark(light, dark)` inside `@supports`; the plain `:root` block holds the light fallback. A new colour pair that a
// component uses must be added to PAIRS so that the check keeps covering every combination.

type Theme = 'light' | 'dark';
type Tokens = Map<string, string>;

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Rule {
  selector: string;
  body: string;
  /** Names of the enclosing at-rules, outermost first (`@media (prefers-color-scheme: dark)`, `@supports (...)`). */
  context: string[];
}

function readRules(source: string, context: string[], out: Rule[]): void {
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open === -1) return;
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      const ch = source.charAt(j);
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    const header = source.slice(i, open).trim();
    const body = source.slice(open + 1, j - 1);
    if (header.startsWith('@media') || header.startsWith('@supports') || header.startsWith('@layer')) {
      readRules(body, [...context, header], out);
    } else if (!header.startsWith('@')) {
      out.push({ selector: header, body, context });
    }
    i = j;
  }
}

function declarations(body: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) found.push([name, value.trim()]);
  }
  return found;
}

/** Splits the arguments of the function whose opening parenthesis is at `open`; returns the arguments and the end index. */
function readArguments(text: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 1;
  let start = open + 1;
  let k = open + 1;
  while (k < text.length && depth > 0) {
    const ch = text.charAt(k);
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if ((ch === ',' && depth === 1) || depth === 0) {
      args.push(text.slice(start, k).trim());
      start = k + 1;
    }
    k += 1;
  }
  return { args, end: k };
}

/** The light and dark reading of a value that holds `light-dark(a, b)` anywhere; null when it holds none. */
function splitLightDark(value: string): { light: string; dark: string } | null {
  let light = '';
  let dark = '';
  let cursor = 0;
  let found = false;
  for (;;) {
    const at = value.indexOf('light-dark(', cursor);
    if (at === -1) break;
    const { args, end } = readArguments(value, at + 'light-dark'.length);
    if (args.length !== 2) throw new Error(`light-dark() takes two arguments: ${value}`);
    const [a = '', b = ''] = args;
    light += value.slice(cursor, at) + a;
    dark += value.slice(cursor, at) + b;
    cursor = end;
    found = true;
  }
  if (!found) return null;
  return { light: light + value.slice(cursor), dark: dark + value.slice(cursor) };
}

interface TokenSheet {
  /** Declarations of the plain `:root` blocks (the fallback). */
  plain: Tokens;
  /** The two halves of every `light-dark()` declaration of the `@supports` blocks. */
  pairs: Map<string, { light: string; dark: string }>;
  light: Tokens;
  dark: Tokens;
  /** Blocks that declare colour tokens for the dark theme outside `light-dark()` (there must be none). */
  darkBlocks: string[];
}

function readSheet(raw: string): TokenSheet {
  const rules: Rule[] = [];
  readRules(stripComments(raw), [], rules);
  const plain: Tokens = new Map();
  const pairs = new Map<string, { light: string; dark: string }>();
  const supported: Tokens = new Map();
  const darkBlocks: string[] = [];
  for (const rule of rules) {
    const selector = rule.selector.replaceAll("'", '"');
    const inSupports = rule.context.some((c) => c.startsWith('@supports'));
    const inDarkMedia = rule.context.some((c) => /prefers-color-scheme:\s*dark/.test(c));
    const decls = declarations(rule.body);
    if (inDarkMedia || selector.includes('data-theme="dark"') || selector.includes('data-theme="auto"')) {
      if (decls.length > 0) darkBlocks.push(`${rule.context.join(' ')} ${rule.selector}`.trim());
    }
    if (selector !== ':root') continue;
    for (const [name, value] of decls) {
      if (inSupports) {
        const split = splitLightDark(value);
        if (split === null) supported.set(name, value);
        else pairs.set(name, split);
      } else {
        plain.set(name, value);
      }
    }
  }
  const light: Tokens = new Map(plain);
  const dark: Tokens = new Map(plain);
  for (const [name, value] of supported) {
    light.set(name, value);
    dark.set(name, value);
  }
  for (const [name, split] of pairs) {
    light.set(name, split.light);
    dark.set(name, split.dark);
  }
  return { plain, pairs, light, dark, darkBlocks };
}

function resolve(tokens: Tokens, name: string, depth = 0): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`token ${name} is missing in tokens.css`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (ref?.[1] !== undefined && depth < 5) return resolve(tokens, ref[1], depth + 1);
  return value;
}

function rgb(value: string, name: string): [number, number, number] {
  let hex = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short !== null)
    hex = `#${short
      .slice(1)
      .map((c) => c + c)
      .join('')}`;
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`token ${name} is not a hex colour: ${value}`);
  return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(fg: string, bg: string): number {
  const a = luminance(rgb(fg, 'foreground'));
  const b = luminance(rgb(bg, 'background'));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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

const sheet = readSheet(readFileSync(join(stylesDir, 'tokens.css'), 'utf8'));
const themes: Record<Theme, Tokens> = { light: sheet.light, dark: sheet.dark };

function contrast(theme: Theme, fg: string, bg: string): number {
  const tokens = themes[theme];
  return ratio(resolve(tokens, fg), resolve(tokens, bg));
}

const TEXT = 4.5; // WCAG 1.4.3
const UI = 3; // WCAG 1.4.11

const STATES = ['working', 'waiting', 'ended', 'completed', 'failed', 'stale', 'unknown'] as const;
/** Names of ADR 0035 that components still use; they must keep resolving and keep their contrast. */
const LEGACY = ['running', 'waiting', 'idle', 'completed', 'failed', 'unknown', 'stale', 'partial', 'ok'] as const;
const ROLES = ['user', 'assistant', 'tool'] as const;

const PAIRS: { name: string; fg: string; bg: string; min: number }[] = [
  ...STATES.flatMap((s) => [
    { name: `${s} label on its tint`, fg: `--state-${s}-fg`, bg: `--state-${s}-bg`, min: TEXT },
    { name: `${s} label on the surface`, fg: `--state-${s}-fg`, bg: '--surface', min: TEXT },
    { name: `${s} label on the page`, fg: `--state-${s}-fg`, bg: '--bg', min: TEXT },
    { name: `${s} dot on the surface`, fg: `--state-${s}-dot`, bg: '--surface', min: UI },
  ]),
  ...LEGACY.flatMap((s) => [
    { name: `legacy ${s} text on its badge`, fg: `--${s}-fg`, bg: `--${s}-bg`, min: TEXT },
    { name: `legacy ${s} text on the surface`, fg: `--${s}-fg`, bg: '--surface', min: TEXT },
  ]),
  ...ROLES.map((r) => ({ name: `${r} role colour on the surface`, fg: `--role-${r}`, bg: '--surface', min: UI })),
  ...['--bg', '--surface', '--surface-2'].flatMap((bg) => [
    { name: `text on ${bg}`, fg: '--text', bg, min: TEXT },
    { name: `muted text on ${bg}`, fg: '--text-muted', bg, min: TEXT },
  ]),
  { name: 'accent text on the accent button', fg: '--accent-contrast', bg: '--accent', min: TEXT },
  { name: 'accent text on the surface', fg: '--accent', bg: '--surface', min: TEXT },
  { name: 'accent text on the page', fg: '--accent', bg: '--bg', min: TEXT },
  { name: 'accent text on surface-2', fg: '--accent', bg: '--surface-2', min: TEXT },
  { name: 'focus ring on the surface', fg: '--focus', bg: '--surface', min: UI },
  { name: 'focus ring on the page', fg: '--focus', bg: '--bg', min: UI },
  { name: 'focus ring on surface-2', fg: '--focus', bg: '--surface-2', min: UI },
  { name: 'control border on the surface', fg: '--control-border', bg: '--surface', min: UI },
  { name: 'control border on surface-2', fg: '--control-border', bg: '--surface-2', min: UI },
  { name: 'control border on the page', fg: '--control-border', bg: '--bg', min: UI },
];

describe('tokens.css contrast (ADR 0071 decision 11)', () => {
  it('finds the plain fallback and the light-dark pairs', () => {
    expect(sheet.plain.size).toBeGreaterThan(30);
    expect(sheet.pairs.size).toBeGreaterThan(30);
    for (const name of [
      '--bg',
      '--surface',
      '--text',
      '--accent',
      '--control-border',
      '--state-working-dot',
      '--role-user',
    ]) {
      expect(sheet.pairs.has(name), `${name} is a light-dark pair`).toBe(true);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      for (const pair of PAIRS) {
        it(`${pair.name} (${pair.fg} on ${pair.bg}) is at least ${String(pair.min)}:1`, () => {
          expect(contrast(theme, pair.fg, pair.bg)).toBeGreaterThanOrEqual(pair.min);
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

  it('declares the tokens of ADR 0071 decisions 2 to 8', () => {
    const names = [
      '--fs-2xl',
      '--sp-7',
      '--sp-8',
      '--elev-1',
      '--elev-2',
      '--ctl-h',
      '--side-w',
      '--side-w-rail',
      '--topbar-h',
      '--page-pad',
      '--role-user',
      '--role-assistant',
      '--role-tool',
      ...STATES.flatMap((s) => [`--state-${s}-dot`, `--state-${s}-fg`, `--state-${s}-bg`]),
    ];
    for (const name of names) expect(sheet.plain.has(name), name).toBe(true);
    expect(sheet.plain.get('--side-w')).toBe('240px');
    expect(sheet.plain.get('--side-w-rail')).toBe('56px');
    expect(sheet.plain.get('--topbar-h')).toBe('48px');
    expect(sheet.plain.get('--ctl-h')).toBe('32px');
  });

  describe('every style file', () => {
    const files = readdirSync(stylesDir).filter((f) => f.endsWith('.css'));
    it('sees the style files', () => {
      expect(files).toContain('tokens.css');
      expect(files.length).toBeGreaterThan(5);
    });
    for (const file of files) {
      const text = readFileSync(join(stylesDir, file), 'utf8');
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
  });
});
