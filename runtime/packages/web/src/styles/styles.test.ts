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
  'work.css': 'pages',
  'activity.css': 'pages',
  'overview.css': 'pages',
  'settings.css': 'pages',
  'search.css': 'pages',
  'terminal.css': 'pages',
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

/** Imports of a package file (`@import '@scope/pkg/file.css' layer(x)`): the path and the layer. */
function packageImportsOf(index: string): Import[] {
  return [...stripComments(index).matchAll(/@import\s+'(@?[a-z][a-z0-9-]*\/[^':]*)'\s+layer\(([a-z]+)\)\s*;/g)].map(
    (m) => ({
      file: m[1] ?? '',
      layer: m[2] ?? '',
    }),
  );
}

/** Selectors of a file that are not a `.terminal-*` class (alone or with descendants and states): terminal.css restyles nothing else. */
function foreignSelectors(css: string): string[] {
  return selectorsOf(css).filter((selector) => !/^\.terminal-[a-z0-9-]+(?![a-z0-9-])/.test(selector));
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

/** A style rule with the `@media` or `@supports` prelude it sits in (null at the top level) and the text of its declarations. */
interface Rule {
  media: string | null;
  selectors: string[];
  body: string;
}

/** Every style rule of a sheet, nested at-rules included (keyframe steps are not rules). */
function rulesOf(raw: string): Rule[] {
  const found: Rule[] = [];
  const walk = (source: string, media: string | null): void => {
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
        // steps are percentages, not rules
      } else if (header.startsWith('@')) {
        walk(body, header);
      } else {
        found.push({ media, selectors: selectorsOf(`${header} {}`), body });
      }
      i = j;
    }
  };
  walk(stripComments(raw), null);
  return found;
}

/** The declarations (`property: value`) of every rule whose selector list names `selector`, in the given prelude (null = top level). */
function declarationsOf(raw: string, selector: string, media: string | null = null): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const rule of rulesOf(raw)) {
    if (rule.media !== media || !rule.selectors.includes(selector)) continue;
    for (const part of rule.body.split(/;(?![^(]*\))/)) {
      const m = /^\s*([a-z-]+)\s*:\s*([\s\S]*?)\s*$/.exec(part);
      if (m?.[1] !== undefined && m[2] !== undefined) declarations.set(m[1], m[2].replace(/\s+/g, ' '));
    }
  }
  return declarations;
}

/** Selector lists (as written) of the rules that name `selector`, to see which selectors share a rule. */
function selectorListsOf(raw: string, selector: string): string[][] {
  return rulesOf(raw)
    .filter((rule) => rule.media === null && rule.selectors.includes(selector))
    .map((rule) => rule.selectors);
}

/** Ownership map of the plan (selector prefix to file); the first match wins. */
const OWNERS: [RegExp, string][] = [
  [/^(?:\.chip__detail|\.chip\[|a\.chip)/, 'topbar.css'],
  [/^\.(?:btn|input|chip|card|kbd|popover|dialog)(?![a-z0-9])/, 'components.css'],
  [/^\.(?:badge|tone-|state-dot|evidence)/, 'badges.css'],
  [/^\.(?:state(?!-dot)|skeleton|causes|load-more|disclosure|clamped|copy-btn)/, 'states.css'],
  [/^\.(?:shell|sidebar|skip-links|toast|notice|brand(?![a-z0-9]))/, 'shell.css'],
  [/^\.(?:topbar|live-|health-|stale-|shortcuts-dialog|prefs-controls)/, 'topbar.css'],
  [/^\.(?:filter-bar|data-table|tbl-wrap|token-|summary-strip)/, 'lists.css'],
  [/^\.(?:explorer|session-cell|session-errors|session-tags)/, 'sessions.css'],
  [/^\.(?:session-header|detail|audit-refs)/, 'session-detail.css'],
  [/^\.(?:session-tabs|agent-|timeline|session-tokens)/, 'session-tabs.css'],
  [/^\.(?:tv|tr|tu|hide-result|md)(?![a-z0-9])/, 'transcript.css'],
  [/^\.terminal(?![a-z0-9])/, 'terminal.css'],
];

/**
 * Selectors a file may carry although another file owns their prefix: the dialogs that compose the `.dialog` primitive. The
 * shortcuts dialog is native markup that carries no `dialog` class, so the rule that draws a dialog names it next to `.dialog`
 * (one rule, no second copy of the box). The entry goes when the markup takes the class.
 */
const COMPOSERS: Record<string, readonly string[]> = {
  'components.css': ['.shortcuts-dialog', '.shortcuts-dialog::backdrop'],
};

function misplaced(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (file === 'tokens.css') continue;
    for (const selector of selectorsOf(text)) {
      if (COMPOSERS[file]?.includes(selector) === true) continue;
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

  it('imports the xterm style sheet once, in the components layer, so the rules of the pages layer can override it (ADR 0097)', () => {
    expect(packageImportsOf(index)).toEqual([{ file: '@xterm/xterm/css/xterm.css', layer: 'components' }]);
  });

  it('keeps terminal.css to `.terminal-*` selectors, in the pages layer after xterm.css', () => {
    expect(foreignSelectors(sources['terminal.css'] ?? '')).toEqual([]);
    expect(EXPECTED_LAYER['terminal.css']).toBe('pages');
    expect(selectorsOf(sources['terminal.css'] ?? '')).toEqual(
      expect.arrayContaining(['.terminal-region', '.terminal-host', '.terminal-latest', '.terminal-hint']),
    );
  });

  it('declares the reduced-motion rule once in base.css', () => {
    expect(sources['base.css']).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  describe('the shared surfaces of the restyle (design 05, section 3.3)', () => {
    const css = (file: string): string => sources[file] ?? '';
    const declared = (file: string, selector: string, property: string, media: string | null = null): string =>
      declarationsOf(css(file), selector, media).get(property) ?? '';

    it('draws buttons 30 px high and the quiet and icon buttons from the control height, 24 px at the least', () => {
      expect(declared('components.css', '.btn', 'min-height')).toBe('var(--ctl-h)');
      const smaller = 'max(var(--ctl-h-inline), calc(var(--ctl-h) - 4px))';
      expect(declared('components.css', '.btn-quiet', 'min-height')).toBe(smaller);
      expect(declared('components.css', '.btn-icon', 'min-height')).toBe(smaller);
      expect(declared('components.css', '.btn-icon', 'min-width')).toBe(smaller);
    });

    it('has the dialog primitive: a native dialog with a head, a body and a foot, the scrim from --backdrop', () => {
      const dialog = (property: string): string => declared('components.css', '.dialog', property);
      expect(dialog('background')).toBe('var(--surface)');
      expect(dialog('border')).toBe('var(--border-w) solid var(--border-strong)');
      expect(dialog('border-radius')).toBe('var(--radius)');
      expect(dialog('box-shadow')).toBe('var(--elev-2)');
      expect(dialog('width')).toBe('min(32.5rem, calc(100vw - 2 * var(--sp-5)))');
      expect(declared('components.css', '.dialog::backdrop', 'background')).toBe('var(--backdrop)');
      expect(declared('components.css', '.dialog__head', 'font-weight')).toBe('var(--fw-semibold)');
      expect(declared('components.css', '.dialog__head', 'color')).toBe('var(--strong)');
      expect(declared('components.css', '.dialog__head', 'border-bottom')).toContain('var(--border)');
      expect(declared('components.css', '.dialog__body', 'overflow-y')).toBe('auto');
      expect(declared('components.css', '.dialog__foot', 'justify-content')).toBe('flex-end');
      expect(declared('components.css', '.dialog__foot', 'border-top')).toContain('var(--border)');
    });

    it('lets the shortcuts dialog compose the primitive: one rule draws both, topbar.css keeps only the inside', () => {
      expect(selectorListsOf(css('components.css'), '.dialog')).toContainEqual(['.dialog', '.shortcuts-dialog']);
      expect(selectorListsOf(css('components.css'), '.dialog::backdrop')).toContainEqual([
        '.dialog::backdrop',
        '.shortcuts-dialog::backdrop',
      ]);
      expect(selectorsOf(css('topbar.css'))).not.toContain('.shortcuts-dialog');
      // the dialog scrim exists once: no other sheet draws a `::backdrop`
      for (const [file, text] of Object.entries(sources)) {
        if (file === 'components.css') continue;
        expect(
          selectorsOf(text).filter((selector) => selector.includes('::backdrop')),
          file,
        ).toEqual([]);
      }
    });

    it('sets the table row height from --row-h and the card row at least as high', () => {
      expect(declared('lists.css', '.data-table td', 'height')).toBe('var(--row-h)');
      expect(declared('lists.css', '.data-card', 'min-height')).toBe('var(--row-h)');
      for (const file of ['lists.css', 'states.css']) {
        expect(css(file), file).not.toMatch(/calc\((?:44|34)px \* var\(--d\)\)/);
      }
    });

    it('sizes the sidebar and menu rows from --row-h-list', () => {
      expect(declared('shell.css', '.sidebar-nav__link', 'min-height')).toBe('var(--row-h-list)');
      expect(declared('shell.css', '.sidebar-switcher__row', 'min-height')).toBe('var(--row-h-list)');
      expect(declared('topbar.css', '.menu__item', 'min-height')).toBe('var(--row-h-list)');
    });

    /** Selected states: the --selected fill and the accent (2 px bar at the start, or the accent border of a toggle). */
    const SELECTED: { file: string; selector: string; accent: 'bar' | 'border' }[] = [
      { file: 'lists.css', selector: ".data-table__row[aria-current='true']", accent: 'bar' },
      { file: 'lists.css', selector: ".data-card[aria-current='true']", accent: 'bar' },
      { file: 'shell.css', selector: ".sidebar-nav__link[aria-current='page']", accent: 'bar' },
      { file: 'shell.css', selector: ".sidebar-switcher__row[aria-current='page']", accent: 'bar' },
      { file: 'lists.css', selector: '.filter-bar__toggle:has(input:checked)', accent: 'border' },
      { file: 'lists.css', selector: "button.summary-tile[aria-pressed='true']", accent: 'bar' },
      { file: 'transcript.css', selector: '.tv-chip.is-on', accent: 'border' },
    ];

    for (const { file, selector, accent } of SELECTED) {
      it(`marks ${selector} with --selected and the accent`, () => {
        expect(declared(file, selector, 'background'), 'fill').toBe('var(--selected)');
        if (accent === 'bar') expect(declared(file, selector, 'box-shadow')).toContain('inset 2px 0 0 var(--accent)');
        else expect(declared(file, selector, 'border-color')).toBe('var(--accent)');
      });
    }

    it('gives the selected sticky cell of a table row the selected fill too', () => {
      expect(declared('lists.css', ".data-table__row[aria-current='true'] .is-sticky-start", 'background')).toBe(
        'var(--selected)',
      );
    });

    it('keeps hover on --surface-2, so a hovered row and the current row differ', () => {
      expect(declared('lists.css', '.data-card--link:hover', 'background')).toBe('var(--surface-2)');
      expect(declared('shell.css', '.sidebar-nav__link:hover', 'background')).toBe('var(--surface-2)');
      expect(declared('transcript.css', '.tv-chip:hover', 'background')).toBe('var(--surface-2)');
    });

    it('has the .brand mark in shell.css: the product name at 13 px and 600, the brand orange only as a shape', () => {
      expect(declared('shell.css', '.brand', 'font-size')).toBe('var(--fs-md)');
      expect(declared('shell.css', '.brand', 'font-weight')).toBe('var(--fw-semibold)');
      expect(declared('shell.css', '.brand', 'color')).toBe('var(--strong)');
      expect(declared('shell.css', '.brand::before', 'background')).toBe('var(--brand)');
    });

    describe('forced colours', () => {
      const FORCED = '@media (forced-colors: active)';
      const dots: [string, string][] = [
        ['badges.css', '.state-dot'],
        ['topbar.css', '.live-dot'],
        ['lists.css', '.summary-tile__dot'],
      ];
      for (const [file, selector] of dots) {
        it(`turns ${selector} into a CanvasText disc`, () => {
          expect(declared(file, selector, 'background', FORCED)).toBe('CanvasText');
          expect(declared(file, selector, 'forced-color-adjust', FORCED)).toBe('none');
        });
      }

      it('keeps the ring as a shape', () => {
        expect(declared('badges.css', '.state-dot--ring', 'border-color', FORCED)).toBe('CanvasText');
        expect(declared('badges.css', '.state-dot--ring', 'background', FORCED)).toBe('transparent');
      });

      for (const { file, selector } of SELECTED) {
        it(`outlines ${selector} with Highlight`, () => {
          expect(declared(file, selector, 'outline', FORCED)).toBe('2px solid Highlight');
        });
      }
    });
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

    it('finds the package imports and nothing else', () => {
      expect(
        packageImportsOf(
          ["@import './base.css' layer(base);", "@import '@xterm/xterm/css/xterm.css' layer(components);"].join('\n'),
        ),
      ).toEqual([{ file: '@xterm/xterm/css/xterm.css', layer: 'components' }]);
      expect(packageImportsOf("/* @import '@x/y.css' layer(base); */ @import './a.css' layer(base);")).toEqual([]);
      expect(packageImportsOf("@import 'https://example.invalid/a.css' layer(base);")).toEqual([]);
    });

    it('reads the declarations of a rule by selector and prelude', () => {
      const text =
        '.a, .b { color: red; box-shadow: 0 0 1px var(--x); } @media (forced-colors: active) { .a { color: CanvasText } } @keyframes k { 50% { color: blue } }';
      expect(rulesOf(text).map((rule) => [rule.media, rule.selectors])).toEqual([
        [null, ['.a', '.b']],
        ['@media (forced-colors: active)', ['.a']],
      ]);
      expect(declarationsOf(text, '.b').get('color')).toBe('red');
      expect(declarationsOf(text, '.b').get('box-shadow')).toBe('0 0 1px var(--x)');
      expect(declarationsOf(text, '.a', '@media (forced-colors: active)').get('color')).toBe('CanvasText');
      expect(declarationsOf(text, '.c').size).toBe(0);
      expect(selectorListsOf(text, '.b')).toEqual([['.a', '.b']]);
    });

    it('finds a dialog or a brand rule in the wrong file, and lets the composing selectors through', () => {
      expect(misplaced({ 'topbar.css': '.dialog__head { color: red }' })).toHaveLength(1);
      expect(misplaced({ 'components.css': '.dialog__head { color: red }' })).toEqual([]);
      expect(misplaced({ 'components.css': '.brand { color: red }' })).toHaveLength(1);
      expect(misplaced({ 'shell.css': '.brand::before { color: red }' })).toEqual([]);
      expect(misplaced({ 'components.css': '.dialog, .shortcuts-dialog { color: red }' })).toEqual([]);
      expect(misplaced({ 'shell.css': '.shortcuts-dialog { color: red }' })).toHaveLength(1);
      expect(misplaced({ 'components.css': '.shortcuts-dialog__title { color: red }' })).toHaveLength(1);
    });

    it('finds a selector of terminal.css that is not a terminal class', () => {
      expect(
        foreignSelectors(
          '.terminal-host .xterm, .terminal-host:focus-within { a: b } .xterm { c: d } .terminals { e: f }',
        ),
      ).toEqual(['.xterm', '.terminals']);
      expect(foreignSelectors('.terminal-region { a: b } .terminal-host .xterm-viewport { c: d }')).toEqual([]);
    });

    it('reads selector lists with attribute selectors and ignores keyframe steps', () => {
      expect(selectorsOf("a[href='x,y'], b { c: d } @keyframes k { 50% { e: f } }")).toEqual(["a[href='x,y']", 'b']);
    });
  });
});
