// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STYLES_DIR, stripComments } from '../test/css-tokens.ts';

// Style guards of ADR 0100 (design 05, section 8): the style sheets consume tokens and never define their own colours or fonts.
//   1. No colour literal (`#hex`, `rgb(`, `hsl(` and the other colour functions) outside `tokens.css`; the `light-dark()` pairs and
//      the shadow colours live there.
//   2. No `font-family` except `var(--mono)` and `var(--font)`, no web font, no family inside a `font` shorthand.
//   3. No `color: var(--faint)`: `--faint` is decoration (2.4:1 on the surface) and never text.
//   4. Every `var(--x)` names a token of `tokens.css` or a custom property the same file declares.
//   5. The only import that is not a local file is the xterm style sheet.
// Every guard is a pure function of the CSS text, so the negative probes at the end feed it bad input.

const SRC_DIR = dirname(STYLES_DIR);

/**
 * The declarations and at-statements of a style sheet, one string each, with the preludes of rules (selectors, `@media` queries,
 * keyframe selectors) left out. Quotes and parentheses are respected, so a `;` inside a string or a `url(data:...)` does not split.
 */
function chunksOf(raw: string): string[] {
  const text = stripComments(raw);
  const chunks: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed !== '') chunks.push(trimmed);
    current = '';
  };
  for (const ch of text) {
    if (quote !== '') {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && ch === '{') {
      current = '';
    } else if (depth === 0 && (ch === ';' || ch === '}')) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return chunks;
}

/** A chunk without strings and `url(...)` arguments, so that an id selector in `url(#a)` or a quoted `#fff` is not read as a colour. */
function withoutStringsAndUrls(chunk: string): string {
  return chunk.replace(/"[^"]*"|'[^']*'/g, '""').replace(/url\([^)]*\)/gi, 'url()');
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![-\w])color\(/i;

/** Declarations that hold a colour literal. */
function colourLiterals(raw: string): string[] {
  return chunksOf(raw).filter((chunk) => COLOUR_LITERAL.test(withoutStringsAndUrls(chunk)));
}

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

function stripImportant(value: string): string {
  return value.replace(/\s*!important\s*$/i, '').trim();
}

/** `font-family` declarations other than the two tokens, and `font` shorthands that do not end in one of them. */
function fontFamilyLiterals(raw: string): string[] {
  const found: string[] = [];
  for (const chunk of chunksOf(raw)) {
    const family = /^font-family\s*:\s*([\s\S]*)$/i.exec(chunk);
    if (family?.[1] !== undefined) {
      const value = stripImportant(family[1]);
      if (value !== 'var(--mono)' && value !== 'var(--font)' && !CSS_WIDE.has(value)) found.push(chunk);
      continue;
    }
    const shorthand = /^font\s*:\s*([\s\S]*)$/i.exec(chunk);
    if (shorthand?.[1] !== undefined) {
      const value = stripImportant(shorthand[1]);
      if (!CSS_WIDE.has(value) && !/\bvar\(--(?:font|mono)\)$/.test(value)) found.push(chunk);
    }
  }
  return found;
}

/** `color` declarations that read `--faint`, directly or inside another function. */
function fadedText(raw: string): string[] {
  return chunksOf(raw).filter((chunk) => /^color\s*:/i.test(chunk) && /var\(\s*--faint\b/.test(chunk));
}

/** Custom properties a sheet declares (`--x: value`). */
function declaredProperties(raw: string): Set<string> {
  const names = new Set<string>();
  for (const chunk of chunksOf(raw)) {
    const m = /^(--[a-z0-9-]+)\s*:/i.exec(chunk);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return names;
}

/** Custom properties a sheet reads with `var()`, fallbacks included. */
function usedProperties(raw: string): Set<string> {
  const names = new Set<string>();
  for (const chunk of chunksOf(raw)) {
    for (const m of chunk.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) if (m[1] !== undefined) names.add(m[1]);
  }
  return names;
}

/** `var()` references that name neither a token, nor a property of the same file, nor an allowed runtime property. */
function undefinedVars(
  raw: string,
  tokenNames: ReadonlySet<string>,
  allowed: ReadonlySet<string> = new Set(),
): string[] {
  const own = declaredProperties(raw);
  return [...usedProperties(raw)]
    .filter((name) => !tokenNames.has(name) && !own.has(name) && !allowed.has(name))
    .sort();
}

/** The one import that does not name a local file (ADR 0097: the xterm style sheet, in the components layer). */
const XTERM_IMPORT = '@xterm/xterm/css/xterm.css';

/** `@import` statements of a file that name something other than a local `./file.css` or the xterm style sheet. */
function foreignImports(raw: string): string[] {
  const found: string[] = [];
  for (const chunk of chunksOf(raw)) {
    if (!/^@import\b/i.test(chunk)) continue;
    const m = /^@import\s+(?:url\(\s*)?["']?([^"')\s]+)/i.exec(chunk);
    const specifier = m?.[1] ?? '';
    if (!specifier.startsWith('./') && specifier !== XTERM_IMPORT) found.push(chunk);
  }
  return found;
}

/**
 * Custom properties that a sheet reads without declaring them, each with the file that does set them. They are listed so that the
 * guard stays strict for everything else; the test below proves the named file still mentions the property, so an entry cannot
 * outlive its setter.
 */
const RUNTIME_PROPERTIES: Readonly<Record<string, { source: string; why: string }>> = {
  '--tone-fg': {
    source: 'styles/badges.css',
    why: 'the state badge selectors declare it and the activity and panel stripes read it',
  },
  '--x': {
    source: 'pages/analytics/UsageOverTime.tsx',
    why: 'the chart tooltip sets the position through the style prop (a CSSOM write, which the CSP allows)',
  },
  '--board-cols': {
    source: 'pages/work-items/WorkItemBoardPage.tsx',
    why: 'the board sets its column template through the style prop (a CSSOM write, which the CSP allows)',
  },
};
const ALLOWED_RUNTIME = new Set(Object.keys(RUNTIME_PROPERTIES));

const files = readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();
const sources = new Map(files.map((name) => [name, readFileSync(join(STYLES_DIR, name), 'utf8')]));
const tokensText = sources.get('tokens.css') ?? '';
const tokenNames = declaredProperties(tokensText);
const consumers = files.filter((name) => name !== 'tokens.css');

describe('style guards (ADR 0100)', () => {
  it('sees the style sheets and the tokens (a guard cannot pass by scanning nothing)', () => {
    expect(files).toContain('tokens.css');
    expect(consumers.length).toBeGreaterThan(15);
    expect(tokenNames.size).toBeGreaterThan(120);
    expect(colourLiterals(tokensText).length).toBeGreaterThan(100);
  });

  describe('colour literals live in tokens.css only', () => {
    for (const name of consumers) {
      it(`${name} has no #hex, rgb(), hsl() or other colour literal`, () => {
        expect(colourLiterals(sources.get(name) ?? '')).toEqual([]);
      });
    }
  });

  describe('fonts come from the tokens', () => {
    for (const name of files) {
      it(`${name} names no font family except var(--mono) and var(--font)`, () => {
        expect(fontFamilyLiterals(sources.get(name) ?? '')).toEqual([]);
      });
    }
  });

  describe('faint is never text', () => {
    for (const name of files) {
      it(`${name} has no color: var(--faint)`, () => {
        expect(fadedText(sources.get(name) ?? '')).toEqual([]);
      });
    }
  });

  describe('every var() resolves', () => {
    for (const name of files) {
      it(`${name} reads only tokens, its own properties and the listed runtime properties`, () => {
        expect(undefinedVars(sources.get(name) ?? '', tokenNames, ALLOWED_RUNTIME)).toEqual([]);
      });
    }

    for (const [property, { source, why }] of Object.entries(RUNTIME_PROPERTIES)) {
      it(`${property} is still set by ${source} (${why})`, () => {
        expect(readFileSync(join(SRC_DIR, source), 'utf8')).toContain(property);
      });
    }

    it('lists only runtime properties that a sheet reads', () => {
      const used = new Set(consumers.flatMap((name) => [...usedProperties(sources.get(name) ?? '')]));
      for (const property of ALLOWED_RUNTIME) expect(used.has(property), property).toBe(true);
    });
  });

  describe('imports', () => {
    for (const name of files) {
      it(`${name} imports only local files and the xterm style sheet`, () => {
        expect(foreignImports(sources.get(name) ?? '')).toEqual([]);
      });
    }
  });

  describe('the guards themselves (negative probes)', () => {
    it('splits declarations and leaves the preludes out', () => {
      expect(chunksOf('a, #abc { color: red; background: url(data:image/png;base64,AAA) }')).toEqual([
        'color: red',
        'background: url(data:image/png;base64,AAA)',
      ]);
      expect(chunksOf('@media (max-width: 1px) { a { margin: 0 } } @keyframes k { 0% { top: 0 } }')).toEqual([
        'margin: 0',
        'top: 0',
      ]);
      expect(chunksOf("a::after { content: ';{}'; } /* color: #fff; */")).toEqual(["content: ';{}'"]);
    });

    it('catches a hex colour, rgb(), hsl() and the other colour functions', () => {
      for (const css of [
        'a{color:#fff}',
        'a{color:#FFFFFF}',
        'a{background:#12345678}',
        'a{background:rgb(0 0 0 / 0.4)}',
        'a{background:rgba(0,0,0,.4)}',
        'a{color:hsl(10 20% 30%)}',
        'a{color:hsla(10,20%,30%,.5)}',
        'a{color:oklch(60% 0.1 30)}',
        'a{color:color(srgb 1 0 0)}',
        'a{box-shadow:0 1px 2px rgb(0 0 0 / 0.1)}',
        '@keyframes k{0%{color:#fff}}',
        '@media (max-width:1px){a{border:1px solid #abc}}',
        'a{background:linear-gradient(#fff,#000)}',
      ]) {
        expect(colourLiterals(css), css).toHaveLength(1);
      }
    });

    it('lets tokens, colour mixes of tokens, selectors, strings and url fragments through', () => {
      for (const css of [
        'a{color:var(--text)}',
        'a{background:color-mix(in srgb, var(--accent) 18%, var(--surface))}',
        'a{border-color:light-dark(var(--a), var(--b))}',
        '#abc{margin:0}',
        '#root{margin:0}',
        'a:not(#fade){margin:0}',
        'a{fill:url(#abc)}',
        "a::after{content:'#fff'}",
        'a{color:transparent;outline-color:currentcolor}',
      ]) {
        expect(colourLiterals(css), css).toEqual([]);
      }
    });

    it('catches a font family literal, a web font and a font shorthand with a family', () => {
      for (const css of [
        "a{font-family:'Segoe UI', sans-serif}",
        'a{font-family:Consolas}',
        'a{font-family: system-ui}',
        "@font-face{font-family:'X';src:url(x.woff2)}",
        'a{font: 13px/1.5 Consolas}',
        'a{font: 13px sans-serif}',
        'a{font-family:var(--other)}',
        'a{font-family:var(--mono), monospace}',
      ]) {
        expect(fontFamilyLiterals(css), css).toHaveLength(1);
      }
    });

    it('lets the font tokens and the CSS-wide keywords through', () => {
      for (const css of [
        'a{font-family:var(--mono)}',
        'a{font-family: var(--font) !important}',
        'a{font-family:inherit}',
        'a{font: inherit}',
        'a{font: var(--fw-regular) var(--fs-md) / var(--lh) var(--font)}',
        'a{--mono: Consolas, monospace}',
        'a{font-size:12px;font-weight:600}',
      ]) {
        expect(fontFamilyLiterals(css), css).toEqual([]);
      }
    });

    it('catches color: var(--faint) and lets decoration through', () => {
      expect(fadedText('a{color:var(--faint)}')).toHaveLength(1);
      expect(fadedText('a{color: var( --faint ) !important}')).toHaveLength(1);
      expect(fadedText('a{color:var(--faint, #fff)}')).toHaveLength(1);
      expect(fadedText('a{color:color-mix(in srgb, var(--faint) 50%, var(--text))}')).toHaveLength(1);
      expect(fadedText('a{border-color:var(--faint)}')).toEqual([]);
      expect(fadedText('a{background:var(--faint)}')).toEqual([]);
      expect(fadedText('a{color:var(--text-muted)}')).toEqual([]);
      expect(fadedText('a{--tone:var(--faint)}')).toEqual([]);
    });

    it('catches a var() that names nothing and a property that only a comment declares', () => {
      const tokens = new Set(['--text', '--bg']);
      expect(undefinedVars('a{color:var(--missing)}', tokens)).toEqual(['--missing']);
      expect(undefinedVars('a{color:var(--text, var(--also-missing))}', tokens)).toEqual(['--also-missing']);
      expect(undefinedVars('a{color:var(--text)}/* --missing: red; */a{color:var(--missing)}', tokens)).toEqual([
        '--missing',
      ]);
      expect(undefinedVars('a{--local:1px;margin:var(--local)}', tokens)).toEqual([]);
      expect(undefinedVars('a{margin:var(--elsewhere)}', tokens)).toEqual(['--elsewhere']);
      expect(undefinedVars('a{margin:var(--elsewhere)}', tokens, new Set(['--elsewhere']))).toEqual([]);
      expect(undefinedVars('a{color:var(--text);background:var(--bg)}', tokens)).toEqual([]);
    });

    it('catches an import that is neither local nor the xterm style sheet', () => {
      for (const css of [
        "@import 'https://example.invalid/a.css';",
        '@import url(https://example.invalid/a.css);',
        "@import url('//example.invalid/a.css');",
        "@import '@other/pkg/style.css';",
        "@import '@xterm/xterm/css/other.css';",
        "@import 'a.css';",
      ]) {
        expect(foreignImports(css), css).toHaveLength(1);
      }
      for (const css of [
        "@import './base.css' layer(base);",
        '@import url(./base.css) layer(base);',
        "@import '@xterm/xterm/css/xterm.css' layer(components);",
        'a{margin:0}',
      ]) {
        expect(foreignImports(css), css).toEqual([]);
      }
    });
  });
});
