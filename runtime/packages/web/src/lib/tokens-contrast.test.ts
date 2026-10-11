// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// WCAG 2 contrast of the colour pairs of 04 6.1, read from styles/tokens.css (a port of experiment E3). A new colour pair
// must be added to PAIRS so that the check keeps covering every combination the components use.

type Theme = 'light' | 'dark';
type Tokens = Map<string, string>;

const tokensPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'tokens.css');
const css = readFileSync(tokensPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  body: string;
  inDarkMedia: boolean;
}

function readRules(source: string, inDarkMedia: boolean, out: Rule[]): void {
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
    if (header.startsWith('@media')) {
      readRules(body, inDarkMedia || /prefers-color-scheme:\s*dark/.test(header), out);
    } else if (header.startsWith('@layer')) {
      readRules(body, inDarkMedia, out);
    } else if (header.startsWith('@')) {
      // @font-face and similar blocks hold no theme tokens
    } else {
      out.push({ selector: header, body, inDarkMedia });
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

function themeOf(rule: Rule): Theme | 'auto-dark' | null {
  const selector = rule.selector.replaceAll("'", '"');
  if (selector.includes('data-theme="dark"')) return 'dark';
  if (selector.includes('data-theme="auto"') && rule.inDarkMedia) return 'auto-dark';
  if (selector.includes(':root') && !rule.inDarkMedia && !selector.includes('data-density')) {
    return selector.includes('data-theme="auto"') ? null : 'light';
  }
  return null;
}

const rules: Rule[] = [];
readRules(css, false, rules);

function collect(wanted: Theme | 'auto-dark'): Tokens {
  const tokens: Tokens = new Map();
  for (const rule of rules) {
    if (themeOf(rule) !== wanted) continue;
    for (const [name, value] of declarations(rule.body)) tokens.set(name, value);
  }
  return tokens;
}

const themes: Record<Theme, Tokens> = { light: collect('light'), dark: collect('dark') };
const autoDark = collect('auto-dark');

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

function contrast(theme: Theme, fg: string, bg: string): number {
  const tokens = themes[theme];
  const a = luminance(rgb(resolve(tokens, fg), fg));
  const b = luminance(rgb(resolve(tokens, bg), bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TEXT = 4.5; // WCAG 1.4.3
const UI = 3; // WCAG 1.4.11

const STATES = ['running', 'idle', 'completed', 'failed', 'unknown', 'stale', 'partial', 'ok', 'waiting'] as const;

const PAIRS: { name: string; fg: string; bg: string; min: number }[] = [
  ...STATES.map((s) => ({ name: `${s} text on its badge`, fg: `--${s}-fg`, bg: `--${s}-bg`, min: TEXT })),
  ...STATES.map((s) => ({ name: `${s} text on the surface`, fg: `--${s}-fg`, bg: '--surface', min: TEXT })),
  ...['--bg', '--surface', '--surface-2'].flatMap((bg) => [
    { name: `text on ${bg}`, fg: '--text', bg, min: TEXT },
    { name: `muted text on ${bg}`, fg: '--text-muted', bg, min: TEXT },
  ]),
  { name: 'accent text on the accent button', fg: '--accent-contrast', bg: '--accent', min: TEXT },
  { name: 'accent text on the surface', fg: '--accent', bg: '--surface', min: TEXT },
  { name: 'focus ring on the surface', fg: '--focus', bg: '--surface', min: UI },
  { name: 'focus ring on the page', fg: '--focus', bg: '--bg', min: UI },
  { name: 'control border on the surface', fg: '--control-border', bg: '--surface', min: UI },
  { name: 'control border on surface-2', fg: '--control-border', bg: '--surface-2', min: UI },
  { name: 'control border on the page', fg: '--control-border', bg: '--bg', min: UI },
];

describe('tokens.css contrast (04 6.1)', () => {
  it('finds the light, dark and auto-dark token blocks', () => {
    expect(themes.light.size).toBeGreaterThan(20);
    expect(themes.dark.size).toBeGreaterThan(20);
    expect(autoDark.size).toBeGreaterThan(20);
    expect(themes.light.has('--control-border')).toBe(true);
    expect(themes.dark.has('--waiting-fg')).toBe(true);
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

  it('the prefers-color-scheme block of data-theme="auto" repeats every colour of the dark theme', () => {
    for (const [name, value] of autoDark) {
      if (!themes.dark.has(name)) continue;
      expect(resolve(autoDark, name), name).toBe(resolve(themes.dark, name));
      expect(value.length).toBeGreaterThan(0);
    }
    for (const s of STATES) {
      expect(autoDark.has(`--${s}-fg`), `--${s}-fg in the auto block`).toBe(true);
      expect(autoDark.has(`--${s}-bg`), `--${s}-bg in the auto block`).toBe(true);
    }
    for (const name of ['--bg', '--surface', '--surface-2', '--text', '--text-muted', '--control-border']) {
      expect(autoDark.has(name), `${name} in the auto block`).toBe(true);
    }
  });

  it('the checker itself computes known WCAG ratios', () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
    const black = (luminance([0, 0, 0]) + 0.05) / (luminance([255, 255, 255]) + 0.05);
    expect(1 / black).toBeCloseTo(21, 5);
  });
});
