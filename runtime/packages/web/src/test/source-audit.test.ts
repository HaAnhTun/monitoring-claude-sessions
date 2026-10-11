import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

// Port of the legacy source audit (04-ui.md sections 2 and 8, UI-I1, UI-I3, UI-I12). Scans the sources, never `dist/`:
// the React bundle itself contains innerHTML and URL strings.
function slashes(path: string): string {
  return path.split(sep).join('/');
}

const SRC_ROOT = slashes(resolve(import.meta.dirname, '..'));
const WEB_ROOT = slashes(resolve(import.meta.dirname, '../..'));
const SELF = slashes(resolve(import.meta.dirname, 'source-audit.test.ts'));

const FORBIDDEN = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'new Function',
  'srcdoc',
  'eval(',
] as const;

const FIXTURE_HEADER = '// FIXTURE: invented data for tests';

function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => slashes(`${entry.parentPath}${sep}${entry.name}`))
    .filter((file) => file !== SELF);
}

/** Pure check of an index.html text; exported shape kept small so the negative probes below can feed it bad input. */
function auditIndexHtml(html: string): string[] {
  const problems: string[] = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const modules = scripts.filter((m) => /\btype\s*=\s*["']module["']/i.test(m[1] ?? ''));
  const classic = scripts.filter((m) => !/\btype\s*=\s*["']module["']/i.test(m[1] ?? ''));
  for (const script of scripts) {
    if ((script[2] ?? '').trim() !== '') problems.push('inline script body');
  }
  if (modules.length !== 1) problems.push(`expected one module script, found ${modules.length}`);
  if (classic.length !== 1 || !/\bsrc\s*=\s*["']\/theme-init\.js["']/.test(classic[0]?.[1] ?? '')) {
    problems.push('expected exactly one classic script /theme-init.js');
  }
  if (/https?:\/\//i.test(html)) problems.push('external URL');
  return problems;
}

describe('source audit', () => {
  const files = sourceFiles();

  it('sees the source tree (the audit cannot pass by scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('/app/routes.tsx'))).toBe(true);
  });

  it('keeps unsafe HTML and dynamic code APIs out of src/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const word of FORBIDDEN) {
        if (text.includes(word)) offenders.push(`${file}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('starts every fixture with the invented-data header (UI-I12)', () => {
    const fixtures = files.filter((f) => f.includes('/test/fixtures/') && f.endsWith('.ts'));
    const missing = fixtures.filter((f) => !readFileSync(f, 'utf8').startsWith(FIXTURE_HEADER));
    expect(missing).toEqual([]);
  });

  describe('index.html', () => {
    const html = readFileSync(`${WEB_ROOT}/index.html`, 'utf8');

    it('has no inline script, no external URL, one module script and one classic /theme-init.js', () => {
      expect(auditIndexHtml(html)).toEqual([]);
    });

    it('loads the theme script before the module entry', () => {
      expect(html.indexOf('/theme-init.js')).toBeGreaterThan(-1);
      expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/main.tsx'));
    });

    it('rejects an inline script (negative probe)', () => {
      const bad = html.replace('</head>', '<script>window.x = 1</script></head>');
      expect(auditIndexHtml(bad)).toContain('inline script body');
    });

    it('rejects an external URL (negative probe)', () => {
      const bad = html.replace('</head>', '<link rel="stylesheet" href="https://example.invalid/a.css"></head>');
      expect(auditIndexHtml(bad)).toContain('external URL');
    });

    it('rejects a second module script (negative probe)', () => {
      const bad = html.replace('</head>', '<script type="module" src="/other.js"></script></head>');
      expect(auditIndexHtml(bad).join(' ')).toContain('expected one module script');
    });
  });
});
