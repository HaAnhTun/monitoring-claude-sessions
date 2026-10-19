// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Style architecture of ADR 0071 decision 10: one file per feature, each imported once from index.css in a fixed layer, no
// selector defined in two files, no work-package marker left in a stylesheet (index.css keeps the marked import blocks of the
// page work packages), and pages.css gone.

const stylesDir = dirname(fileURLToPath(import.meta.url));

const LAYERS = ['tokens', 'base', 'layout', 'components', 'pages'] as const;

/** Every stylesheet and the layer index.css must import it into. */
const EXPECTED_LAYER: Record<string, (typeof LAYERS)[number]> = {
  'tokens.css': 'tokens',
  'base.css': 'base',
  'layout.css': 'layout',
  'components.css': 'components',
  'badges.css': 'components',
  'states.css': 'components',
  'topbar.css': 'components',
  'lists.css': 'components',
  'transcript.css': 'components',
  'panels.css': 'components',
  'shell.css': 'pages',
  'sessions.css': 'pages',
  'session-detail.css': 'pages',
  'session-tabs.css': 'pages',
};

/** Marked blocks that index.css keeps for the work packages that add a page stylesheet. */
const MARKED_BLOCKS = ['WP-53', 'WP-54', 'WP-66', 'WP-67', 'WP-121'];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssFiles(): string[] {
  return readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .sort();
}

/** Selector lists of every style rule (inside @media and @supports too; keyframe steps are not selectors). */
function selectorsOf(raw: string): string[] {
  const found: string[] = [];
  const walk = (source: string, inKeyframes: boolean): void => {
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
      if (header.startsWith('@keyframes')) {
        // steps are percentages, not selectors
      } else if (header.startsWith('@')) {
        walk(body, inKeyframes);
      } else if (!inKeyframes) {
        let depthParen = 0;
        let start = 0;
        for (let k = 0; k <= header.length; k += 1) {
          const ch = header.charAt(k);
          if (ch === '(' || ch === '[') depthParen += 1;
          else if (ch === ')' || ch === ']') depthParen -= 1;
          if ((ch === ',' && depthParen === 0) || k === header.length) {
            found.push(header.slice(start, k).replace(/\s+/g, ' ').trim());
            start = k + 1;
          }
        }
      }
      i = j;
    }
  };
  walk(stripComments(raw), false);
  return found.filter((s) => s !== '');
}

interface Import {
  file: string;
  layer: string;
}

function importsOf(index: string): Import[] {
  return [...stripComments(index).matchAll(/@import\s+'\.\/([a-z0-9-]+\.css)'\s+layer\(([a-z]+)\)\s*;/g)].map((m) => ({
    file: m[1] ?? '',
    layer: m[2] ?? '',
  }));
}

/** Selectors defined by more than one file, as `selector: fileA, fileB`. */
function duplicateSelectors(sources: Record<string, string>): string[] {
  const owners = new Map<string, Set<string>>();
  for (const [file, text] of Object.entries(sources)) {
    for (const selector of selectorsOf(text)) {
      const set = owners.get(selector) ?? new Set<string>();
      set.add(file);
      owners.set(selector, set);
    }
  }
  return [...owners]
    .filter(([, files]) => files.size > 1)
    .map(([selector, files]) => `${selector}: ${[...files].sort().join(', ')}`);
}

/** Ownership map of the plan (selector prefix to file); the first match wins. */
const OWNERS: [RegExp, string][] = [
  [/^(?:\.chip__detail|\.chip\[|a\.chip)/, 'topbar.css'],
  [/^\.(?:btn|input|chip|card|kbd|popover)(?![a-z0-9])/, 'components.css'],
  [/^\.(?:badge|tone-|state-dot|evidence)/, 'badges.css'],
  [/^\.(?:state(?!-dot)|skeleton|causes|load-more|disclosure|clamped|copy-btn)/, 'states.css'],
  [/^\.(?:shell|sidebar|skip-links|toast|notice)/, 'shell.css'],
  [/^\.(?:topbar|live-|health-|stale-|shortcuts-dialog|prefs-controls)/, 'topbar.css'],
  [/^\.(?:filter-bar|data-table|tbl-wrap|token-|summary-strip)/, 'lists.css'],
  [/^\.(?:explorer|session-cell|session-errors|session-tags)/, 'sessions.css'],
  [/^\.(?:session-header|detail|audit-refs)/, 'session-detail.css'],
  [/^\.(?:session-tabs|agent-|timeline|session-tokens)/, 'session-tabs.css'],
  [/^\.(?:tv|tr|tu|hide-result|md)(?![a-z0-9])/, 'transcript.css'],
];

function misplaced(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (file === 'tokens.css') continue;
    for (const selector of selectorsOf(text)) {
      const owner = OWNERS.find(([re]) => re.test(selector));
      if (owner !== undefined && owner[1] !== file) problems.push(`${selector} is in ${file}, owned by ${owner[1]}`);
    }
  }
  return problems;
}

const files = cssFiles();
const sources: Record<string, string> = Object.fromEntries(
  files.filter((f) => f !== 'index.css').map((f) => [f, readFileSync(join(stylesDir, f), 'utf8')]),
);
const index = readFileSync(join(stylesDir, 'index.css'), 'utf8');

describe('style architecture (ADR 0071 decision 10)', () => {
  it('sees the stylesheets', () => {
    expect(files).toContain('index.css');
    expect(Object.keys(sources).length).toBe(Object.keys(EXPECTED_LAYER).length);
  });

  it('declares the layer order once, first', () => {
    const statements = [...stripComments(index).matchAll(/@layer\s+([^;{]+);/g)];
    expect(statements).toHaveLength(1);
    expect((statements[0]?.[1] ?? '').split(',').map((s) => s.trim())).toEqual([...LAYERS]);
    expect(stripComments(index).trimStart().startsWith('@layer')).toBe(true);
  });

  it('imports every stylesheet exactly once, in its layer', () => {
    const imports = importsOf(index);
    expect(imports.map((i) => i.file).sort()).toEqual(Object.keys(EXPECTED_LAYER).sort());
    for (const entry of imports) {
      expect(LAYERS as readonly string[], entry.file).toContain(entry.layer);
      expect(entry.layer, entry.file).toBe(EXPECTED_LAYER[entry.file]);
      expect(existsSync(join(stylesDir, entry.file)), `${entry.file} exists`).toBe(true);
    }
    expect(new Set(imports.map((i) => i.file)).size).toBe(imports.length);
  });

  it('has every stylesheet of the folder in index.css (no orphan file)', () => {
    const imported = new Set(importsOf(index).map((i) => i.file));
    expect(Object.keys(sources).filter((f) => !imported.has(f))).toEqual([]);
  });

  it('has no pages.css any more', () => {
    expect(existsSync(join(stylesDir, 'pages.css'))).toBe(false);
  });

  it('keeps work-package markers only as the import blocks of index.css', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/@wp-/);
    }
    const begins = [...index.matchAll(/@wp-begin (WP-\d+)/g)].map((m) => m[1]);
    const ends = [...index.matchAll(/@wp-end (WP-\d+)/g)].map((m) => m[1]);
    expect(begins).toEqual(MARKED_BLOCKS);
    expect(ends).toEqual(MARKED_BLOCKS);
  });

  it('defines no selector in two files', () => {
    expect(duplicateSelectors(sources)).toEqual([]);
  });

  it('keeps every rule in the file that owns its selector prefix', () => {
    expect(misplaced(sources)).toEqual([]);
  });

  it('declares the reduced-motion rule once in base.css', () => {
    expect(sources['base.css']).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  describe('the checks themselves (negative probes)', () => {
    it('finds a selector defined in two files', () => {
      expect(duplicateSelectors({ 'a.css': '.x { color: red }', 'b.css': '.y, .x { color: blue }' })).toEqual([
        '.x: a.css, b.css',
      ]);
      expect(
        duplicateSelectors({ 'a.css': '.x { color: red }', 'b.css': '@media (max-width: 1px) { .y { color: blue } }' }),
      ).toEqual([]);
    });

    it('finds a rule in the wrong file', () => {
      expect(misplaced({ 'components.css': '.sidebar-row { color: red }' })).toHaveLength(1);
      expect(misplaced({ 'shell.css': '.sidebar-row { color: red }' })).toEqual([]);
    });

    it('reads selector lists with attribute selectors and ignores keyframe steps', () => {
      expect(selectorsOf("a[href='x,y'], b { c: d } @keyframes k { 50% { e: f } }")).toEqual(["a[href='x,y']", 'b']);
    });
  });
});
