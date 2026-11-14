// Reader of the design tokens for tests (ADR 0071, ADR 0100). `styles/tokens.css` writes every colour once: the plain `:root` block holds
// the light value (the fallback of a browser without `light-dark()`), the `@supports` block holds the same names as
// `light-dark(light, dark)`. This module parses that file into the plain fallback, the two halves of every pair and the resolved
// light and dark token maps, and holds the WCAG 2 arithmetic. Three suites share it: `lib/tokens-contrast.test.ts` (the gate),
// `styles/tokens-usage.test.ts` (the style guards) and `lib/term-theme.test.ts` (the terminal theme read from the real tokens), so
// that none of them keeps its own copy of the parser. Tests only: production code never imports this folder.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Theme = 'light' | 'dark';
export type Tokens = Map<string, string>;

/** The folder of the style sheets (`src/styles`). */
export const STYLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface Rule {
  selector: string;
  body: string;
  /** Names of the enclosing at-rules, outermost first (`@media (prefers-color-scheme: dark)`, `@supports (...)`). */
  context: string[];
}

export function readRules(source: string, context: string[], out: Rule[]): void {
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

export function declarations(body: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) found.push([name, value.trim()]);
  }
  return found;
}

/** Splits the arguments of the function whose opening parenthesis is at `open`; returns the arguments and the end index. */
export function readArguments(text: string, open: number): { args: string[]; end: number } {
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
export function splitLightDark(value: string): { light: string; dark: string } | null {
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

export interface TokenSheet {
  /** Declarations of the plain `:root` blocks (the fallback). */
  plain: Tokens;
  /** The two halves of every `light-dark()` declaration of the `@supports` blocks. */
  pairs: Map<string, { light: string; dark: string }>;
  light: Tokens;
  dark: Tokens;
  /** Blocks that declare colour tokens for the dark theme outside `light-dark()` (there must be none). */
  darkBlocks: string[];
}

export function readSheet(raw: string): TokenSheet {
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

/** The text of `styles/tokens.css`. */
export function readTokensCss(): string {
  return readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8');
}

/** The parsed `styles/tokens.css`. */
export function readTokenSheet(): TokenSheet {
  return readSheet(readTokensCss());
}

/** The value of a token with `var(--other)` references followed (a bare reference only, as the token file writes them). */
export function resolve(tokens: Tokens, name: string, depth = 0): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`token ${name} is missing in tokens.css`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (ref?.[1] !== undefined && depth < 5) return resolve(tokens, ref[1], depth + 1);
  return value;
}

export function rgb(value: string, name: string): [number, number, number] {
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

export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours. */
export function ratio(fg: string, bg: string): number {
  const a = luminance(rgb(fg, 'foreground'));
  const b = luminance(rgb(bg, 'background'));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
