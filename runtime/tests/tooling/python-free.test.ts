// The Python-free guard (ADR 0066, plan WP-96): the repository holds no Python file, none of the removed Python-era trees and
// no mention of the removed engine, its tools or its environment switches. Every token is built at run time, so this file
// never matches itself.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCUMENTED_ENV_VARS } from '@mcs/shared';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

/** Folder names skipped anywhere in the walk (`.dev` holds ignored local run logs). */
const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', '.dev', 'coverage', 'test-results', 'playwright-report']);

/** Historic records, kept as written (repository-relative, forward slashes). */
const SKIP_PATHS = ['docs/design', 'docs/decisions', 'docs/research', 'docs/legacy'];

/** Paths whose text may name the legacy dialect: the upgrade path's regex translator and its corpus. */
const TOKEN_EXEMPT_PREFIXES = [
  'runtime/packages/engine/src/migrate/regex/',
  'runtime/packages/engine/test/fixtures/regex-translator/',
];

/**
 * Cut line of WP-96: the top-level product documents (`docs/*.md`) are rewritten or moved to `docs/legacy/` in WP-96b, so the
 * token scan leaves them out until then.
 */
const PENDING_DOC = /^docs\/[^/]+\.md$/;

const j = (...parts: string[]): string => parts.join('');

/** The removed trees and files (repository-relative). */
const REMOVED = [
  'src',
  'template',
  j('tests/test_cli', '.py'),
  j('tests/test_reader', '.py'),
  j('tests/test_server', '.py'),
  j('tests/test_state_config_tasks', '.py'),
  'tests/fixtures',
  'tests/frontend',
  j('tests/', 'tools'),
  j('tests/legacy', '-parity'),
  'config',
  'reference',
];

/** The tokens of the removed engine (plan WP-96 Tests). */
const TOKENS = [
  j('viewer', '.py'),
  j('PYTHONDONT', 'WRITEBYTECODE'),
  j('setup-', 'python'),
  j('unit', 'test'),
  j('MCS_', 'PYTHON'),
  j('MCS_', 'GOLDEN'),
  j('MCS_', 'PARITY'),
  j('legacy', '-parity'),
  j('LEGACY_', 'DELEGATES'),
  j('make', '.py'),
  j('demo', '.py'),
  j('tests/', 'tools'),
  j('python', ' -'),
  j('python', '3'),
  j('compilePy', 'Regex'),
];

// Not enforced yet: the plan also lists the legacy source folder name and the two spellings of the Python-compatible JSON
// module; that module and the comments that cite the legacy sources stay until WP-93 (neutral JSON module) replaces them,
// and enforcing those three tokens is part of that work package.

const toPosix = (path: string): string => path.split(sep).join('/');

interface Entry {
  readonly rel: string;
  readonly dir: boolean;
}

function walk(): Entry[] {
  const out: Entry[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_NAMES.has(name)) continue;
      const full = join(dir, name);
      const rel = toPosix(relative(REPO, full));
      if (SKIP_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      out.push({ rel, dir: stat.isDirectory() });
      if (stat.isDirectory()) visit(full);
    }
  };
  visit(REPO);
  return out;
}

const ENTRIES = walk();

/** The text of a file, or `null` for a binary file (one that holds a NUL byte). */
function textOf(rel: string): string | null {
  const bytes = readFileSync(join(REPO, rel));
  if (bytes.includes(0)) return null;
  return bytes.toString('utf8');
}

function tokenHits(rel: string, text: string): string[] {
  return TOKENS.filter((token) => text.includes(token)).map((token) => `${rel}: ${token}`);
}

describe('the Python-free guard (ADR 0066)', () => {
  it('finds no Python source, compiled file or cache folder', () => {
    const python = ENTRIES.filter(
      (e) => (e.dir && e.rel.split('/').pop() === '__pycache__') || (!e.dir && /\.pyc?$/.test(e.rel)),
    ).map((e) => e.rel);
    expect(python).toEqual([]);
  });

  it('finds none of the removed trees or files, including the root config/ and reference/ folders', () => {
    expect(REMOVED.filter((rel) => existsSync(join(REPO, rel)))).toEqual([]);
  });

  it('finds no token of the removed engine in any text file outside the exempt paths', () => {
    const hits: string[] = [];
    for (const { rel, dir } of ENTRIES) {
      if (dir || TOKEN_EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
      // frozen captures of the pre-4.0 engine stay byte-identical (ADR 0066)
      if (rel.endsWith('.frozen.json') || PENDING_DOC.test(rel)) continue;
      const text = textOf(rel);
      if (text !== null) hits.push(...tokenHits(rel, text));
    }
    expect(hits).toEqual([]);
  });

  it('keeps the testkit demo builder free of every token', () => {
    const text = readFileSync(join(REPO, 'runtime/packages/testkit/src/demo.ts'), 'utf8');
    expect(tokenHits('demo.ts', text)).toEqual([]);
  });

  it('allows the process names of watched_processes: python.exe is a process, not a Python dependency', () => {
    const exe = j('python', '.exe');
    expect(TOKENS.some((token) => exe.includes(token))).toBe(false);
  });

  it('documents no environment variable that names Python', () => {
    expect(DOCUMENTED_ENV_VARS.map((v) => v.name).filter((name) => name.toUpperCase().includes('PYTHON'))).toEqual([]);
  });

  it('flags each probe: a .py file, a token in a runtime file and a Python setup line in a script', () => {
    expect(/\.pyc?$/.test(j('probe', '.py'))).toBe(true);
    expect(tokenHits('runtime/x.ts', `// see ${j('viewer', '.py')}`)).toHaveLength(1);
    expect(tokenHits('runtime/scripts/ci.mjs', `- uses: actions/${j('setup-', 'python')}@v5`)).toHaveLength(1);
  });
});
