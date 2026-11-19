// The bundle budget of the web build (design 04 section 7.1, ADR 0097; ADR 0039 for the first three rows) on a throw-away `dist`
// with a manifest: every row, the terminal chunk computed from the manifest graph, and the two ways xterm.js could end up in the
// first load. The script is the one `vite build` runs after every production build.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const SCRIPT = join(RUNTIME, 'packages', 'web', 'scripts', 'check-bundle-budget.mjs');
const KB = 1000;

interface Row {
  name: string;
  size: number;
  limit: number;
  ok: boolean;
  note?: string;
}
interface Result {
  exitCode: number;
  rows: Row[];
  problems: string[];
}
interface Chunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
interface BudgetModule {
  LIMITS: { initialJs: number; allJs: number; terminalJs: number; css: number };
  TERMINAL_ENTRIES: string[];
  XTERM_MARKER: string;
  auditHtml(html: string): string[];
  checkBudget(dist: string): Result;
}

const budget = (await import(pathToFileURL(SCRIPT).href)) as BudgetModule;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Deterministic bytes that gzip hardly shrinks, so a file of `n` bytes weighs about `n` gzipped. */
function noise(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

const gz = (content: Buffer | string): number => gzipSync(content, { level: 9 }).length;

const GOOD_HTML = [
  '<!doctype html><html><head>',
  '<meta name="csp-nonce" content="__CSP_NONCE__">',
  '<script src="/theme-init.js"></script>',
  '<script type="module" src="/assets/index-a.js"></script>',
  '</head><body><div id="root"></div></body></html>',
].join('');

interface Fixture {
  html?: string;
  files: Record<string, Buffer>;
  manifest: Record<string, Chunk>;
  extraFiles?: Record<string, Buffer | string>;
}

function makeDist(fixture: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), 'mcs-web-budget-'));
  roots.push(root);
  const dist = join(root, 'dist');
  mkdirSync(join(dist, '.vite'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), fixture.html ?? GOOD_HTML);
  writeFileSync(join(dist, '.vite', 'manifest.json'), JSON.stringify(fixture.manifest));
  for (const [file, content] of Object.entries({ ...fixture.files, ...fixture.extraFiles })) {
    mkdirSync(dirname(join(dist, file)), { recursive: true });
    writeFileSync(join(dist, file), content);
  }
  return dist;
}

/**
 * A build shaped like the real one: an entry with a shared `hooks` chunk, a Workspace page that loads the terminal page lazily, and
 * the terminal page that loads the loader, which loads xterm and its two addons lazily. `sizes` are in bytes of noise.
 */
function standardFixture(sizes: Partial<Record<string, number>> = {}, over: Partial<Fixture> = {}): Fixture {
  const n = (key: string, fallback: number): number => sizes[key] ?? fallback;
  const files: Record<string, Buffer> = {
    'assets/index-a.js': noise(n('index', 40 * KB), 1),
    'assets/hooks-b.js': noise(n('hooks', 20 * KB), 2),
    'assets/WorkspacePage-c.js': noise(n('workspace', 10 * KB), 3),
    'assets/TerminalView-d.js': noise(n('view', 6 * KB), 4),
    'assets/xterm-loader-e.js': noise(n('loader', 3 * KB), 5),
    'assets/xterm-f.js': noise(n('xterm', 70 * KB), 6),
    'assets/addon-fit-g.js': noise(n('fit', 1 * KB), 7),
    'assets/addon-web-links-h.js': noise(n('links', 2 * KB), 8),
    'assets/index-a.css': noise(n('css', 12 * KB), 9),
  };
  const manifest: Record<string, Chunk> = {
    'index.html': {
      file: 'assets/index-a.js',
      isEntry: true,
      imports: ['_hooks-b.js'],
      dynamicImports: ['src/pages/WorkspacePage.tsx'],
    },
    '_hooks-b.js': { file: 'assets/hooks-b.js' },
    'src/pages/WorkspacePage.tsx': {
      file: 'assets/WorkspacePage-c.js',
      isDynamicEntry: true,
      imports: ['_hooks-b.js'],
      dynamicImports: ['src/terminal/TerminalView.tsx'],
    },
    'src/terminal/TerminalView.tsx': {
      file: 'assets/TerminalView-d.js',
      isDynamicEntry: true,
      imports: ['_hooks-b.js', '_xterm-loader-e.js'],
    },
    '_xterm-loader-e.js': {
      file: 'assets/xterm-loader-e.js',
      dynamicImports: [
        'node_modules/@xterm/xterm/lib/xterm.mjs',
        'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
        'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
      ],
    },
    'node_modules/@xterm/xterm/lib/xterm.mjs': { file: 'assets/xterm-f.js', isDynamicEntry: true },
    'node_modules/@xterm/addon-fit/lib/addon-fit.mjs': { file: 'assets/addon-fit-g.js', isDynamicEntry: true },
    'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs': {
      file: 'assets/addon-web-links-h.js',
      isDynamicEntry: true,
    },
  };
  return { files, manifest, ...over };
}

function row(result: Result, name: string): Row {
  const found = result.rows.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no row ${name}: ${result.rows.map((r) => r.name).join(', ')}`);
  return found;
}

describe('LIMITS', () => {
  it('holds the numbers of the plan: initial 200, all JS 420, css 30, and a cap for the terminal chunk', () => {
    expect(budget.LIMITS.initialJs).toBe(200 * KB);
    expect(budget.LIMITS.allJs).toBe(420 * KB);
    expect(budget.LIMITS.css).toBe(30 * KB);
    // the terminal chunk: 85.3 kB on a fresh build of xterm 6.0.0, the two addons and the loader, plus ten percent (ADR 0097)
    expect(budget.LIMITS.terminalJs).toBe(94 * KB);
  });

  it('names the two files that open the terminal chunk', () => {
    expect(budget.TERMINAL_ENTRIES).toEqual(['src/terminal/TerminalView.tsx', 'src/terminal/xterm-loader.ts']);
  });
});

describe('checkBudget: the four rows', () => {
  it('passes a build within budget and prints the rows in order', () => {
    const result = budget.checkBudget(makeDist(standardFixture()));
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((r) => r.name)).toEqual([
      'Initial JS (gzip)',
      'All JS (gzip)',
      'Terminal chunk (gzip)',
      'CSS total (gzip)',
    ]);
    expect(result.rows.every((r) => r.ok)).toBe(true);
    expect(result.rows.map((r) => r.limit)).toEqual([
      budget.LIMITS.initialJs,
      budget.LIMITS.allJs,
      budget.LIMITS.terminalJs,
      budget.LIMITS.css,
    ]);
  });

  it('measures the initial JS as the entry and its static imports only', () => {
    const fixture = standardFixture();
    const result = budget.checkBudget(makeDist(fixture));
    const expected = gz(fixture.files['assets/index-a.js'] ?? '') + gz(fixture.files['assets/hooks-b.js'] ?? '');
    expect(row(result, 'Initial JS (gzip)').size).toBe(expected);
  });

  it('measures all JS as every .js file of the build', () => {
    const fixture = standardFixture();
    const result = budget.checkBudget(makeDist(fixture));
    const expected = Object.entries(fixture.files)
      .filter(([file]) => file.endsWith('.js'))
      .reduce((sum, [, content]) => sum + gz(content), 0);
    expect(row(result, 'All JS (gzip)').size).toBe(expected);
  });

  it('measures the css as every .css file of the build', () => {
    const fixture = standardFixture();
    const result = budget.checkBudget(makeDist(fixture));
    expect(row(result, 'CSS total (gzip)').size).toBe(gz(fixture.files['assets/index-a.css'] ?? ''));
  });

  it.each([
    ['initial JS', { index: 190 * KB }, 'Initial JS (gzip)'],
    ['all JS', { workspace: 420 * KB }, 'All JS (gzip)'],
    ['css', { css: 31 * KB }, 'CSS total (gzip)'],
  ])('fails when the %s is over its limit', (_name, sizes, rowName) => {
    const result = budget.checkBudget(makeDist(standardFixture(sizes)));
    expect(row(result, rowName).ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('fails for a missing manifest with exit code 2', () => {
    const dist = makeDist(standardFixture());
    rmSync(join(dist, '.vite'), { recursive: true });
    const result = budget.checkBudget(dist);
    expect(result.exitCode).toBe(2);
    expect(result.problems[0]).toMatch(/manifest/);
  });
});

describe('checkBudget: the terminal chunk', () => {
  it('sums every file reachable from the terminal page through imports and dynamic imports, minus the initial set', () => {
    const fixture = standardFixture();
    const result = budget.checkBudget(makeDist(fixture));
    const parts = ['TerminalView-d', 'xterm-loader-e', 'xterm-f', 'addon-fit-g', 'addon-web-links-h'];
    const expected = parts.reduce((sum, p) => sum + gz(fixture.files[`assets/${p}.js`] ?? ''), 0);
    const terminal = row(result, 'Terminal chunk (gzip)');
    expect(terminal.size).toBe(expected);
    // the shared hooks chunk is in the initial set and the Workspace page is not part of the terminal
    expect(terminal.size).toBeLessThan(expected + gz(fixture.files['assets/hooks-b.js'] ?? ''));
    expect(terminal.ok).toBe(true);
  });

  it('counts a chunk the terminal shares with a page that is not initial', () => {
    const fixture = standardFixture();
    fixture.files['assets/shared-x.js'] = noise(5 * KB, 11);
    fixture.manifest['_shared-x.js'] = { file: 'assets/shared-x.js' };
    const view = fixture.manifest['src/terminal/TerminalView.tsx'];
    if (view === undefined) throw new Error('fixture');
    view.imports = [...(view.imports ?? []), '_shared-x.js'];
    const result = budget.checkBudget(makeDist(fixture));
    const plain = budget.checkBudget(makeDist(standardFixture()));
    expect(row(result, 'Terminal chunk (gzip)').size).toBe(
      row(plain, 'Terminal chunk (gzip)').size + gz(fixture.files['assets/shared-x.js'] ?? ''),
    );
  });

  it('does not walk into the entry: the terminal page imports it, and its dynamic imports are every other page', () => {
    const fixture = standardFixture();
    fixture.files['assets/OtherPage-z.js'] = noise(30 * KB, 12);
    fixture.manifest['src/pages/OtherPage.tsx'] = { file: 'assets/OtherPage-z.js', isDynamicEntry: true };
    const entry = fixture.manifest['index.html'];
    const view = fixture.manifest['src/terminal/TerminalView.tsx'];
    if (entry === undefined || view === undefined) throw new Error('fixture');
    entry.dynamicImports = [...(entry.dynamicImports ?? []), 'src/pages/OtherPage.tsx'];
    view.imports = [...(view.imports ?? []), 'index.html'];
    const result = budget.checkBudget(makeDist(fixture));
    const plain = budget.checkBudget(makeDist(standardFixture()));
    expect(row(result, 'Terminal chunk (gzip)').size).toBe(row(plain, 'Terminal chunk (gzip)').size);
  });

  it('does not count what the page that loads the terminal fetches anyway: that page, and the chunks it imports', () => {
    const fixture = standardFixture();
    fixture.files['assets/pane-y.js'] = noise(20 * KB, 13);
    fixture.manifest['_pane-y.js'] = { file: 'assets/pane-y.js' };
    const page = fixture.manifest['src/pages/WorkspacePage.tsx'];
    const view = fixture.manifest['src/terminal/TerminalView.tsx'];
    if (page === undefined || view === undefined) throw new Error('fixture');
    page.imports = [...(page.imports ?? []), '_pane-y.js'];
    // the bundler leaves a module out of a shared chunk when the lazily loaded page can count on its importer: the page chunk is imported
    view.imports = [...(view.imports ?? []), '_pane-y.js', 'src/pages/WorkspacePage.tsx'];
    const result = budget.checkBudget(makeDist(fixture));
    const plain = budget.checkBudget(makeDist(standardFixture()));
    expect(row(result, 'Terminal chunk (gzip)').size).toBe(row(plain, 'Terminal chunk (gzip)').size);
  });

  it('is measured from the loader alone while the page does not exist yet', () => {
    const fixture = standardFixture();
    delete fixture.manifest['src/terminal/TerminalView.tsx'];
    fixture.manifest['src/terminal/xterm-loader.ts'] = {
      ...(fixture.manifest['_xterm-loader-e.js'] ?? { file: '' }),
      isDynamicEntry: true,
    };
    delete fixture.manifest['_xterm-loader-e.js'];
    const result = budget.checkBudget(makeDist(fixture));
    const expected = ['xterm-loader-e', 'xterm-f', 'addon-fit-g', 'addon-web-links-h'].reduce(
      (sum, p) => sum + gz(fixture.files[`assets/${p}.js`] ?? ''),
      0,
    );
    expect(row(result, 'Terminal chunk (gzip)').size).toBe(expected);
  });

  it('is zero, and says why, when the build has no terminal at all', () => {
    const fixture = standardFixture();
    const manifest = Object.fromEntries(
      Object.entries(fixture.manifest).filter(([key]) => !/terminal|xterm|addon/.test(key)),
    );
    const result = budget.checkBudget(makeDist({ ...fixture, manifest }));
    const terminal = row(result, 'Terminal chunk (gzip)');
    expect(terminal.size).toBe(0);
    expect(terminal.ok).toBe(true);
    expect(terminal.note).toMatch(/no terminal/i);
    expect(result.problems).toEqual([]);
  });

  it('fails when the terminal chunk is over its limit', () => {
    const result = budget.checkBudget(makeDist(standardFixture({ xterm: budget.LIMITS.terminalJs + KB })));
    expect(row(result, 'Terminal chunk (gzip)').ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('passes a terminal chunk just under the limit', () => {
    const base = budget.checkBudget(makeDist(standardFixture()));
    const room = budget.LIMITS.terminalJs - row(base, 'Terminal chunk (gzip)').size;
    expect(room).toBeGreaterThan(0);
    // noise gzips to a little more than its length, so keep a margin
    const fits = budget.checkBudget(makeDist(standardFixture({ xterm: 70 * KB + room - 500 })));
    const terminal = row(fits, 'Terminal chunk (gzip)');
    expect(terminal.size).toBeGreaterThan(budget.LIMITS.terminalJs - 1000);
    expect(terminal.ok).toBe(true);
  });
});

describe('checkBudget: xterm in the initial chunks', () => {
  const MARKER = '/* xterm-dom-renderer-owner-1 */';

  it('knows what marks xterm by content', () => {
    expect(budget.XTERM_MARKER).toBe('xterm-dom-renderer-owner');
  });

  it('fails when the code of xterm is in an initial chunk', () => {
    const fixture = standardFixture();
    fixture.files['assets/hooks-b.js'] = Buffer.concat([noise(20 * KB, 2), Buffer.from(MARKER)]);
    const result = budget.checkBudget(makeDist(fixture));
    expect(result.problems).toContain('xterm is in the initial chunks: assets/hooks-b.js');
    expect(result.exitCode).toBe(1);
  });

  it('fails when the entry itself holds xterm', () => {
    const fixture = standardFixture();
    fixture.files['assets/index-a.js'] = Buffer.concat([noise(40 * KB, 1), Buffer.from(MARKER)]);
    const result = budget.checkBudget(makeDist(fixture));
    expect(result.problems).toContain('xterm is in the initial chunks: assets/index-a.js');
  });

  it('fails when an initial chunk imports the terminal page statically', () => {
    const fixture = standardFixture();
    const entry = fixture.manifest['index.html'];
    if (entry === undefined) throw new Error('fixture');
    entry.imports = [...(entry.imports ?? []), 'src/terminal/TerminalView.tsx'];
    const result = budget.checkBudget(makeDist(fixture));
    expect(result.problems).toContain('xterm is in the initial chunks: assets/TerminalView-d.js');
    expect(result.exitCode).toBe(1);
  });

  it('allows the loader itself in the first load: it imports xterm only lazily and holds none of its code', () => {
    const fixture = standardFixture();
    const entry = fixture.manifest['index.html'];
    if (entry === undefined) throw new Error('fixture');
    entry.imports = [...(entry.imports ?? []), '_xterm-loader-e.js'];
    const result = budget.checkBudget(makeDist(fixture));
    expect(result.problems).toEqual([]);
  });

  it('does not mistake a dynamic import of the terminal for an initial one', () => {
    const result = budget.checkBudget(makeDist(standardFixture()));
    expect(result.problems.filter((p) => p.startsWith('xterm'))).toEqual([]);
  });
});

describe('auditHtml', () => {
  it('accepts the page shape of the build', () => {
    expect(budget.auditHtml(GOOD_HTML)).toEqual([]);
  });

  it('accepts either order of the attributes of the nonce tag and a self-closing tag', () => {
    expect(
      budget.auditHtml(
        GOOD_HTML.replace(
          '<meta name="csp-nonce" content="__CSP_NONCE__">',
          '<meta content="__CSP_NONCE__" name="csp-nonce" />',
        ),
      ),
    ).toEqual([]);
  });

  it('requires the csp-nonce tag with the placeholder: without it the server cannot give xterm a nonce', () => {
    const without = GOOD_HTML.replace('<meta name="csp-nonce" content="__CSP_NONCE__">', '');
    expect(budget.auditHtml(without)).toEqual([
      'index.html must carry <meta name="csp-nonce" content="__CSP_NONCE__"> exactly once',
    ]);
    const wrong = GOOD_HTML.replace('__CSP_NONCE__', 'abc');
    expect(budget.auditHtml(wrong)).toHaveLength(1);
  });

  it('allows the tag only once', () => {
    const twice = GOOD_HTML.replace('<script src', '<meta name="csp-nonce" content="__CSP_NONCE__"><script src');
    expect(budget.auditHtml(twice)).toHaveLength(1);
  });

  it('still reports an inline script, a second module script and an external URL', () => {
    expect(budget.auditHtml(GOOD_HTML.replace('<div id', '<script>run()</script><div id'))).toContain(
      'index.html has an inline script body',
    );
    expect(
      budget.auditHtml(GOOD_HTML.replace('<div id', '<script type="module" src="/b.js"></script><div id')),
    ).toEqual(['index.html must have exactly one module script, found 2']);
    expect(budget.auditHtml(GOOD_HTML.replace('<div id', '<link href="https://example.invalid/x"><div id'))).toEqual([
      'index.html contains an http:// or https:// URL',
    ]);
  });

  it('is satisfied by the index.html of the web package', () => {
    const html = readFileSync(join(RUNTIME, 'packages', 'web', 'index.html'), 'utf8');
    // the source page names the entry as /src/main.tsx; the audit reads shapes, not names
    expect(budget.auditHtml(html)).toEqual([]);
    expect(html).toContain('<meta name="csp-nonce" content="__CSP_NONCE__" />');
  });

  it('fails a build whose index.html lost the tag', () => {
    const fixture = standardFixture();
    const result = budget.checkBudget(
      makeDist({ ...fixture, html: GOOD_HTML.replace('<meta name="csp-nonce" content="__CSP_NONCE__">', '') }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.problems.join('\n')).toMatch(/csp-nonce/);
  });
});

describe('the command line', () => {
  function run(dist: string): { status: number | null; out: string } {
    const result = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it('prints a table with the terminal row and exits 0 within budget, and writes the report', () => {
    const dist = makeDist(standardFixture());
    const { status, out } = run(dist);
    expect(status).toBe(0);
    expect(out).toMatch(/^ok {2} Initial JS \(gzip\)/m);
    expect(out).toMatch(/^ok {2} Terminal chunk \(gzip\)/m);
    const report = JSON.parse(readFileSync(join(dist, 'build-report.json'), 'utf8')) as {
      rows: Row[];
      problems: string[];
    };
    expect(report.rows.map((r) => r.name)).toContain('Terminal chunk (gzip)');
    expect(report.problems).toEqual([]);
  });

  it('prints FAIL lines and exits 1 when xterm is in the first load', () => {
    const fixture = standardFixture();
    fixture.files['assets/hooks-b.js'] = Buffer.concat([noise(20 * KB, 2), Buffer.from('xterm-dom-renderer-owner')]);
    const { status, out } = run(makeDist(fixture));
    expect(status).toBe(1);
    expect(out).toContain('FAIL xterm is in the initial chunks: assets/hooks-b.js');
  });

  it('exits 2 when dist is missing', () => {
    const { status } = run(join(tmpdir(), 'mcs-web-budget-does-not-exist'));
    expect(status).toBe(2);
  });
});
