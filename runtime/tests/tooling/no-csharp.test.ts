// The no-C# guard (TC-GATE-05, design 08 section 4.2 and amendment A1): the repository holds no C# or Visual Basic source or
// project file, and no tracked text file compiles C# (through PowerShell `Add-Type` or a compiler command). Every token is
// built at run time, so this file never matches itself. `Add-Type -AssemblyName System.Windows.Forms` loads an existing
// assembly and stays allowed.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

/** Folder names skipped by the fallback walk (the Docker harness unpacks a tar without `.git`). */
const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', '.dev']);

const j = (...parts: string[]): string => parts.join('');

/** C# and Visual Basic source and project file extensions. */
const SOURCE_EXTENSIONS = ['.cs', '.csproj', '.sln', '.vb'];

interface Token {
  readonly text: string;
  /** The C# compiler command stays case-sensitive: an upper-case abbreviation is not the compiler. */
  readonly flags: string;
}

/** The tokens of C# compiled from a script or a build (A1), spelled in parts. */
const TOKENS: readonly Token[] = [
  { text: j('Type', 'Definition'), flags: 'i' },
  { text: j('Member', 'Definition'), flags: 'i' },
  { text: j('Language', ' CSharp'), flags: 'i' },
  { text: j('c', 'sc'), flags: '' },
  { text: j('dotnet', ' build'), flags: 'i' },
  { text: j('ms', 'build'), flags: 'i' },
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One word-bounded pattern per token, so `\bcsc\b` does not match `cscope`. */
const PATTERNS = TOKENS.map((t) => ({ text: t.text, re: new RegExp(`\\b${escapeRegExp(t.text)}\\b`, t.flags) }));

const toPosix = (path: string): string => path.split(sep).join('/');

/** Tracked files from `git ls-files -z`; a walk when the folder is no git work tree. */
function listFiles(root: string): string[] {
  if (!existsSync(join(root, '.git'))) return walk(root);
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf8')
      .split('\0')
      .filter((p) => p !== '');
  } catch {
    return walk(root);
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_NAMES.has(name)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(full);
      else out.push(toPosix(relative(root, full)));
    }
  };
  visit(root);
  return out;
}

/** `package-lock.json` (random base64) and the bundled native libraries give false hits and are not authored text. */
function skipped(rel: string): boolean {
  return (rel.split('/').pop() ?? '') === 'package-lock.json' || /^skills\/[^/]+\/bundle\/native\//.test(rel);
}

/** The text of a file, or `null` for a binary file (one that holds a NUL byte) or a file that is gone. */
function textOf(root: string, rel: string): string | null {
  const full = join(root, rel);
  if (!existsSync(full)) return null;
  const bytes = readFileSync(full);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

/** Every violation of the guard in a tree, as `path: reason` lines. */
function findings(root: string): string[] {
  const hits: string[] = [];
  for (const rel of listFiles(root)) {
    if (skipped(rel)) continue;
    const lower = rel.toLowerCase();
    if (SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) hits.push(`${rel}: source or project file`);
    const text = textOf(root, rel);
    if (text === null) continue;
    for (const { text: token, re } of PATTERNS) if (re.test(text)) hits.push(`${rel}: ${token}`);
  }
  return hits;
}

const temps: string[] = [];

/** A throw-away tree with the given files (path to content). */
function plant(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'mcs-no-csharp-'));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('TC-GATE-05: the no-C# guard (amendment A1)', () => {
  it('finds no C# or Visual Basic file and no C# compile token in the tracked text files', () => {
    expect(findings(REPO)).toEqual([]);
  });

  describe('negative probes on a throw-away tree', () => {
    for (const ext of SOURCE_EXTENSIONS) {
      it(`flags a planted ${ext} file (also in upper case)`, () => {
        expect(findings(plant({ [`tools/probe${ext}`]: 'x' }))).toEqual([`tools/probe${ext}: source or project file`]);
        expect(findings(plant({ [`tools/PROBE${ext.toUpperCase()}`]: 'x' }))).toHaveLength(1);
      });
    }

    for (const { text } of TOKENS) {
      it(`flags the token "${text}" in a tracked text file`, () => {
        const root = plant({ 'runtime/tests/probe.ts': `const script = 'Add-Type -x ${text} y';\n` });
        expect(findings(root)).toEqual([`runtime/tests/probe.ts: ${text}`]);
      });
    }

    it('flags a planted member-definition line with its DllImport (the T-LC-13 shape)', () => {
      const line = `Add-Type -Name P -Namespace X -${j('Member', 'Definition')} '[DllImport("kernel32.dll")] public static extern bool FreeConsole();'`;
      expect(findings(plant({ 'runtime/tests/probe.test.ts': line }))).toEqual([
        `runtime/tests/probe.test.ts: ${j('Member', 'Definition')}`,
      ]);
    });

    it('matches on word boundaries: a longer word is not the compiler', () => {
      const root = plant({ 'docs/notes.md': `${j('c', 'scope')} and ${j('Ex', 'c', 'sc', 'ape')} and CSC\n` });
      expect(findings(root)).toEqual([]);
      expect(findings(plant({ 'docs/notes.md': `run ${j('c', 'sc')} /out:x\n` }))).toEqual([
        `docs/notes.md: ${j('c', 'sc')}`,
      ]);
    });

    it('allows Add-Type -AssemblyName System.Windows.Forms (an existing assembly, the folder picker)', () => {
      const root = plant({ 'runtime/packages/engine/src/probe.ts': "'Add-Type -AssemblyName System.Windows.Forms'\n" });
      expect(findings(root)).toEqual([]);
    });

    it('skips package-lock.json, binary files and the bundled native libraries', () => {
      const token = j('Member', 'Definition');
      const root = plant({
        'runtime/package-lock.json': `"integrity": "${token}"`,
        'tools/blob.bin': Buffer.concat([Buffer.from(token), Buffer.from([0, 1, 2])]),
        'skills/s/bundle/native/readme.txt': `${token} ${j('ms', 'build')}`,
        'skills/s/bundle/native/probe.cs': 'x',
      });
      expect(findings(root)).toEqual([]);
    });

    it('does not skip the same text one level outside bundle/native', () => {
      const root = plant({ 'skills/s/bundle/other.txt': j('Member', 'Definition') });
      expect(findings(root)).toHaveLength(1);
    });

    it('skips node_modules, dist, .git and .dev in the fallback walk', () => {
      const token = j('Member', 'Definition');
      const root = plant({
        'node_modules/p/x.cs': token,
        'dist/x.cs': token,
        '.dev/x.cs': token,
        '.git/x.cs': token,
        'kept/y.cs': token,
      });
      expect(findings(root).sort()).toEqual([`kept/y.cs: ${token}`, 'kept/y.cs: source or project file'].sort());
    });
  });
});
