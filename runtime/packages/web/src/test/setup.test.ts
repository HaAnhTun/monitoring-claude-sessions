import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { readTokenSheet } from './css-tokens.ts';

// Covers the test setup itself (jest-dom matchers, per-test cleanup), the pre-paint script public/theme-init.js, which no
// component imports (04-ui.md section 9), and the head of index.html that the script and the tokens meet in: the theme-color
// metas, whose two colours are the `--bg` pair of tokens.css, and the favicon (ADR 0100).

describe('test setup', () => {
  it('registers the jest-dom matchers', () => {
    const element = document.createElement('p');
    document.body.append(element);
    expect(element).toBeInTheDocument();
    element.remove();
  });

  it('starts every test with an empty body (cleanup runs between tests)', () => {
    expect(document.body.children).toHaveLength(0);
  });
});

const WEB_ROOT = resolve(import.meta.dirname, '../..');
const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

/** A `<meta name="theme-color">` as the script sees it: it reads and writes `content`, and leaves `media` alone. */
class FakeMeta {
  readonly media: string;
  content: string;
  constructor(media: string, content: string) {
    this.media = media;
    this.content = content;
  }
  setAttribute(name: string, value: string): void {
    if (name === 'content') this.content = value;
  }
  getAttribute(name: string): string | null {
    if (name === 'content') return this.content;
    if (name === 'media') return this.media;
    return null;
  }
}

/** The two metas of index.html, in the order of the file. */
function indexMetas(): FakeMeta[] {
  return [
    new FakeMeta('(prefers-color-scheme: light)', '#f5f2ea'),
    new FakeMeta('(prefers-color-scheme: dark)', '#141414'),
  ];
}

describe('theme-init.js', () => {
  const script = readFileSync(resolve(WEB_ROOT, 'public/theme-init.js'), 'utf8');

  interface Options {
    throwing?: boolean;
    metas?: FakeMeta[];
    /** The document has no `querySelectorAll` (an old or partial environment). */
    noQuery?: boolean;
    /** What the sandbox hands to a `querySelectorAll` call, and what it asked for. */
    asked?: string[];
  }

  function runScript(stored: Record<string, string>, options: Options = {}) {
    const attributes = new Map<string, string>([
      ['data-theme', 'auto'],
      ['data-density', 'comfortable'],
    ]);
    const metas = options.metas ?? indexMetas();
    const sandbox = {
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
        },
        ...(options.noQuery === true
          ? {}
          : {
              querySelectorAll: (selector: string) => {
                options.asked?.push(selector);
                return selector === THEME_COLOR_SELECTOR ? metas : [];
              },
            }),
      },
      localStorage: {
        getItem: (key: string): string | null => {
          if (options.throwing === true) throw new Error('storage blocked');
          return stored[key] ?? null;
        },
      },
    };
    runInNewContext(script, sandbox);
    return { attributes, metas };
  }

  function run(stored: Record<string, string>, throwing = false) {
    const { attributes } = runScript(stored, { throwing });
    return { theme: attributes.get('data-theme'), density: attributes.get('data-density') };
  }

  it('keeps the defaults without stored preferences', () => {
    expect(run({})).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  it('applies theme and density of the new key', () => {
    const stored = { 'mcs.ui.v3': JSON.stringify({ theme: 'dark', density: 'compact' }) };
    expect(run(stored)).toEqual({ theme: 'dark', density: 'compact' });
  });

  it('falls back to the legacy key', () => {
    const stored = { 'ccm.prefs.v1': JSON.stringify({ theme: 'light' }) };
    expect(run(stored)).toEqual({ theme: 'light', density: 'comfortable' });
  });

  it('prefers the new key over the legacy key', () => {
    const stored = {
      'mcs.ui.v3': JSON.stringify({ theme: 'dark' }),
      'ccm.prefs.v1': JSON.stringify({ theme: 'light' }),
    };
    expect(run(stored).theme).toBe('dark');
  });

  it('ignores invalid values, corrupt JSON and blocked storage', () => {
    expect(run({ 'mcs.ui.v3': JSON.stringify({ theme: 'neon', density: 7 }) })).toEqual({
      theme: 'auto',
      density: 'comfortable',
    });
    expect(run({ 'mcs.ui.v3': '{not json' })).toEqual({ theme: 'auto', density: 'comfortable' });
    expect(run({}, true)).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  describe('theme-color (ADR 0100)', () => {
    const bg = readTokenSheet().pairs.get('--bg');

    function contentsAfter(theme: string): string[] {
      return runScript({ 'mcs.ui.v3': JSON.stringify({ theme }) }).metas.map((m) => m.content);
    }

    it('reads the two colours from the --bg pair of tokens.css (a drift guard)', () => {
      expect(bg).toBeDefined();
      expect(contentsAfter('light')).toEqual([bg?.light, bg?.light]);
      expect(contentsAfter('dark')).toEqual([bg?.dark, bg?.dark]);
    });

    it('asks the document for the theme-color metas only', () => {
      const asked: string[] = [];
      runScript({ 'mcs.ui.v3': JSON.stringify({ theme: 'dark' }) }, { asked });
      expect(asked).toEqual([THEME_COLOR_SELECTOR]);
    });

    it('leaves the media-conditional metas alone under auto, where the browser picks by the system preference', () => {
      expect(contentsAfter('auto')).toEqual([bg?.light, bg?.dark]);
      expect(runScript({}).metas.map((m) => m.content)).toEqual([bg?.light, bg?.dark]);
    });

    it('leaves the metas alone for an invalid theme, corrupt JSON and blocked storage', () => {
      expect(contentsAfter('neon')).toEqual([bg?.light, bg?.dark]);
      expect(runScript({ 'mcs.ui.v3': '{not json' }).metas.map((m) => m.content)).toEqual([bg?.light, bg?.dark]);
      expect(runScript({}, { throwing: true }).metas.map((m) => m.content)).toEqual([bg?.light, bg?.dark]);
    });

    it('keeps the media of every meta (the no-script default stays valid)', () => {
      const { metas } = runScript({ 'mcs.ui.v3': JSON.stringify({ theme: 'dark' }) });
      expect(metas.map((m) => m.media)).toEqual(['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
    });

    it('still applies theme and density when the document cannot be queried or has no meta', () => {
      const stored = { 'mcs.ui.v3': JSON.stringify({ theme: 'dark', density: 'compact' }) };
      const bare = runScript(stored, { noQuery: true });
      expect(bare.attributes.get('data-theme')).toBe('dark');
      expect(bare.attributes.get('data-density')).toBe('compact');
      expect(runScript(stored, { metas: [] }).attributes.get('data-theme')).toBe('dark');
    });

    it('stays a classic script: no import statement, no export statement', () => {
      expect(script).not.toMatch(/^\s*(?:import|export)\s/m);
    });
  });
});

describe('index.html head (ADR 0100)', () => {
  const html = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');
  const sheet = readTokenSheet();
  const bg = sheet.pairs.get('--bg');

  function attributesOf(tag: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) found[(m[1] ?? '').toLowerCase()] = m[2] ?? '';
    return found;
  }

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => attributesOf(m[0]))
    .filter((attrs) => attrs['name'] === 'theme-color');

  it('carries one theme-color meta per scheme, in the colours of --bg', () => {
    expect(metas).toHaveLength(2);
    expect(metas.find((m) => m['media'] === '(prefers-color-scheme: light)')?.['content']).toBe(bg?.light);
    expect(metas.find((m) => m['media'] === '(prefers-color-scheme: dark)')?.['content']).toBe(bg?.dark);
  });

  it('puts the theme-color metas before the theme script, which edits them', () => {
    const script = html.indexOf('/theme-init.js');
    const lastMeta = html.lastIndexOf('name="theme-color"');
    expect(lastMeta).toBeGreaterThan(-1);
    expect(lastMeta).toBeLessThan(script);
  });

  it('declares both color schemes', () => {
    const scheme = [...html.matchAll(/<meta\b[^>]*>/gi)]
      .map((m) => attributesOf(m[0]))
      .find((attrs) => attrs['name'] === 'color-scheme');
    expect(scheme?.['content']).toBe('light dark');
  });

  it('links the svg favicon instead of the empty data URL', () => {
    const icon = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attributesOf(m[0])).find((a) => a['rel'] === 'icon');
    expect(icon).toMatchObject({ href: '/favicon.svg', type: 'image/svg+xml' });
    expect(html).not.toContain('data:,');
  });
});

describe('favicon.svg (ADR 0100)', () => {
  const path = resolve(WEB_ROOT, 'public/favicon.svg');
  const sheet = readTokenSheet();

  it('exists and is a 32 px square drawing with a rounded dark background', () => {
    expect(existsSync(path)).toBe(true);
    const svg = readFileSync(path, 'utf8');
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/viewBox="0 0 32 32"/);
    expect(svg).toMatch(/<rect\b[^>]*\brx="[1-9][0-9]*"[^>]*\bfill="#141414"/);
    expect(sheet.dark.get('--bg')).toBe('#141414');
  });

  it('draws the >_ mark with paths in the brand orange', () => {
    const svg = readFileSync(path, 'utf8');
    expect(svg.match(/<path\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain(`stroke="${sheet.plain.get('--brand') ?? 'missing'}"`);
  });

  it('needs no font, script, style, image or external reference', () => {
    const svg = readFileSync(path, 'utf8');
    expect(svg).not.toMatch(/<(?:text|tspan|style|script|image|use|foreignObject|a)\b/i);
    expect(svg).not.toMatch(/font|href=|url\(/i);
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//i);
  });
});
