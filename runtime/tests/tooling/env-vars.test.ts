// The one list of documented environment variables (01 section 2.10, I-27, D-18) is a real grep, not a fixed list:
// 1. every `MCS_*` and `CAW_*` name found in the sources is a `name` or a `legacyName` in `DOCUMENTED_ENV_VARS`;
// 2. every documented name is read by at least one of its `readers` files that exists (a reader may mention either spelling
//    and may be a `.bat` file); a name whose reader files do not exist yet (or are still scaffold stubs) is printed as `pending`
//    and does not fail (the Phase 6 gate requires zero `pending`);
// 3. a test hook name (`MCS_TEST_*` or `CAW_TEST_*`) never appears in production sources outside `test-hooks.ts`.
// The scanner is a pure function over a skill-shaped folder, so its own rules are tested on throw-away trees first.
import { type Dirent, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { DOCUMENTED_ENV_VARS, type DocumentedEnvVar } from '@mcs/shared';
import { afterEach, describe, expect, it } from 'vitest';

const SKILL = join(import.meta.dirname, '..', '..', '..');

/** `MCS_` or `CAW_` followed by upper-case words. A trailing underscore (a prefix test) is not a name. */
const ENV_NAME = /\b(?:MCS|CAW)_[A-Z0-9_]*[A-Z0-9]\b/g;
/** The prefixes of a test hook name: it lives only in `test-hooks.ts` (07 section 3.5). */
const TEST_HOOK_PREFIXES = ['MCS_TEST_', 'CAW_TEST_'] as const;
const TEST_HOOK_HOME = 'runtime/packages/engine/src/runtime/test-hooks.ts';
/** The declaration of the list itself names every variable; it is not a reader. */
const DECLARATION = 'runtime/packages/shared/src/env.ts';
/** A file whose first lines call it a scaffold stub is a placeholder that a later work package replaces. */
const STUB_MARKER = /scaffold stub|stub for the scaffold/i;

/**
 * Builds a variable name at run time. This file is scanned like every other, so it must not spell an undocumented name
 * in full.
 */
const mcs = (rest: string): string => `MCS_${rest}`;
const caw = (rest: string): string => `CAW_${rest}`;

/**
 * Names that a committed file mentions on purpose without documenting them, each with the reason. The test fails when a
 * listed name becomes documented or disappears from its file, so the list cannot rot. It is empty: a sample variable in a
 * test uses a name without the product prefix.
 */
const KNOWN_UNDOCUMENTED: readonly { file: string; name: string; reason: string }[] = [];

function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    if (entry.name === 'test-results' || entry.name === 'playwright-report' || entry.name === '.dev') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** The spellings under which a registry entry is known: its canonical name and its legacy name. */
const spellings = (v: DocumentedEnvVar): string[] => (v.legacyName === undefined ? [v.name] : [v.name, v.legacyName]);

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/;
const TEST_FILE = /(?:\.test\.|\.spec\.)[cm]?[jt]sx?$|\/(?:test|tests|e2e)\//;

/** Production code: a package `src` folder that is not a test file and not the testkit (a dev-only package). */
function isProduction(file: string): boolean {
  return file.includes('/src/') && !TEST_FILE.test(`/${file}`) && !file.startsWith('runtime/packages/testkit/');
}

/** Every source file that can read the environment, as skill-relative POSIX paths. */
function sourceFiles(skill: string): string[] {
  const found: string[] = [];
  const add = (dir: string) => {
    for (const file of walk(dir)) {
      if (SOURCE_FILE.test(file)) found.push(relative(skill, file).split(sep).join('/'));
    }
  };
  const packages = join(skill, 'runtime', 'packages');
  let names: string[] = [];
  try {
    names = readdirSync(packages);
  } catch {
    // no packages folder
  }
  for (const name of names) {
    for (const folder of ['src', 'test', 'e2e']) add(join(packages, name, folder));
    for (const file of readdirSync(join(packages, name))) {
      if (/\.config\.[cm]?[jt]s$/.test(file)) found.push(`runtime/packages/${name}/${file}`);
    }
  }
  add(join(skill, 'runtime', 'scripts'));
  add(join(skill, 'runtime', 'tests'));
  try {
    for (const file of readdirSync(join(skill, 'runtime'))) {
      if (/\.config\.[cm]?[jt]s$/.test(file)) found.push(`runtime/${file}`);
    }
  } catch {
    // no runtime folder
  }
  try {
    for (const file of readdirSync(join(skill, 'scripts'))) {
      if (file.endsWith('.mjs')) found.push(`scripts/${file}`);
    }
  } catch {
    // no skill-level scripts folder
  }
  // the scripts of the skill folders of the plugin layout (`skills/<name>/scripts/*.mjs`, ADR 0061, 0062); never `bundle/`
  let skills: string[] = [];
  try {
    skills = readdirSync(join(skill, 'skills'));
  } catch {
    // no plugin layout
  }
  for (const name of skills) {
    try {
      for (const file of readdirSync(join(skill, 'skills', name, 'scripts'))) {
        if (file.endsWith('.mjs')) found.push(`skills/${name}/scripts/${file}`);
      }
    } catch {
      // a skill folder without scripts
    }
  }
  // the compatibility scripts of a skill folder (`skills/<name>/compat/*.mjs`, 07 section 12.1)
  for (const name of skills) {
    try {
      for (const file of readdirSync(join(skill, 'skills', name, 'compat'))) {
        if (file.endsWith('.mjs')) found.push(`skills/${name}/compat/${file}`);
      }
    } catch {
      // a skill folder without compatibility scripts
    }
  }
  return [...new Set(found)].sort();
}

/** `process.env.NAME` and `process.env['NAME']`: the forms in which code reads the environment of its own process. */
const READ_FORM = /process\.env(?:\.|\[\s*['"`])((?:MCS|CAW)_[A-Z0-9_]*[A-Z0-9])\b/g;

/** Test code: test files, test folders and the dev-only testkit package. */
function isTestCode(file: string): boolean {
  return TEST_FILE.test(`/${file}`) || file.startsWith('runtime/packages/testkit/');
}

/**
 * The names of a file that rule 1 judges. Production code: every mention. Test code: only names it reads from its own
 * `process.env`, because a test may set a sample variable (`vi.stubEnv`, an env object for a child) to prove that it is
 * dropped or passed on; that is not a read of the product's environment.
 */
function namesIn(skill: string, file: string): string[] {
  const content = readFileSync(join(skill, file), 'utf8');
  const found = isTestCode(file)
    ? [...content.matchAll(READ_FORM)].map((m) => m[1] ?? '')
    : (content.match(ENV_NAME) ?? []);
  return [...new Set(found)];
}

function allNamesIn(skill: string, file: string): string[] {
  return [...new Set(readFileSync(join(skill, file), 'utf8').match(ENV_NAME) ?? [])];
}

interface EnvReport {
  /** `<file>: <name>` for every `MCS_*` or `CAW_*` name that is neither documented nor a known exception. */
  undocumented: string[];
  /** Known exceptions that no longer hold. */
  staleExceptions: string[];
  /** Documented names with no reader file yet (printed, not failing). */
  pending: string[];
  /** Documented names whose existing reader files never mention them. */
  unread: string[];
  /** Test hook names (`MCS_TEST_*`, `CAW_TEST_*`) in production sources outside `test-hooks.ts`. */
  hookLeaks: string[];
}

function scanEnvironment(
  skill: string,
  documented: readonly DocumentedEnvVar[],
  known: readonly { file: string; name: string }[] = [],
): EnvReport {
  const names = new Set(documented.flatMap(spellings));
  const files = sourceFiles(skill);
  const report: EnvReport = { undocumented: [], staleExceptions: [], pending: [], unread: [], hookLeaks: [] };

  const exceptions = new Set(known.map((k) => `${k.file}: ${k.name}`));
  const used = new Set<string>();
  for (const file of files) {
    if (file === DECLARATION) continue;
    for (const name of namesIn(skill, file)) {
      const key = `${file}: ${name}`;
      if (exceptions.has(key)) used.add(key);
      else if (!names.has(name)) report.undocumented.push(key);
    }
    if (isProduction(file) && file !== TEST_HOOK_HOME) {
      for (const name of allNamesIn(skill, file)) {
        if (TEST_HOOK_PREFIXES.some((prefix) => name.startsWith(prefix))) report.hookLeaks.push(`${file}: ${name}`);
      }
    }
  }
  for (const key of exceptions) {
    const [, name] = key.split(': ');
    if (!used.has(key) || (name !== undefined && names.has(name))) report.staleExceptions.push(key);
  }

  for (const variable of documented) {
    const pattern = new RegExp(`\\b(?:${spellings(variable).join('|')})\\b`);
    const existing: { reader: string; stub: boolean; mentions: boolean }[] = [];
    for (const reader of variable.readers) {
      let content: string;
      try {
        content = readFileSync(join(skill, reader), 'utf8');
      } catch {
        continue;
      }
      existing.push({
        reader,
        stub: STUB_MARKER.test(content.split('\n').slice(0, 3).join('\n')),
        mentions: pattern.test(content),
      });
    }
    if (existing.some((entry) => entry.mentions)) continue;
    // Nothing reads it yet: pending while every reader is missing or still a stub, a failure once a real reader exists.
    if (existing.every((entry) => entry.stub)) report.pending.push(variable.name);
    else report.unread.push(`${variable.name} (readers: ${existing.map((entry) => entry.reader).join(', ')})`);
  }
  report.undocumented.sort();
  return report;
}

// ---- the scanner on throw-away trees -------------------------------------------------------------------------------------

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-env-vars-'));
  roots.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Names are assembled at run time so that this file never contains an undocumented name itself.
const bogus = mcs('NOT_DOCUMENTED_X');
const hookName = mcs('TEST_SOMETHING_NEW');
const sampleHook = mcs('TEST_HOOK');
const longer = mcs('HOME_OTHER');

const SAMPLE: readonly DocumentedEnvVar[] = [
  { name: 'MCS_HOME', scope: 'runtime', readers: ['runtime/packages/engine/src/paths.ts'] },
  { name: 'MCS_FS_WATCH', scope: 'runtime', readers: ['runtime/packages/engine/src/missing.ts'] },
  { name: sampleHook, scope: 'test', readers: [TEST_HOOK_HOME] },
];

describe('scanEnvironment on throw-away trees', () => {
  it('finds a name that is read and documented, and reports the others as pending', () => {
    const skill = tree({
      'runtime/packages/engine/src/paths.ts': "export const h = process.env['MCS_HOME'];\n",
      [TEST_HOOK_HOME]: `export const t = process.env['${sampleHook}'];\n`,
    });
    const report = scanEnvironment(skill, SAMPLE);
    expect(report).toEqual({
      undocumented: [],
      staleExceptions: [],
      pending: ['MCS_FS_WATCH'],
      unread: [],
      hookLeaks: [],
    });
  });

  it('reports an undocumented name in production code, in a test file, in scripts and in a config file', () => {
    const skill = tree({
      'runtime/packages/engine/src/paths.ts': `export const a = process.env['${bogus}'];\n`,
      'runtime/packages/engine/src/a.test.ts': `export const b = process.env['${bogus}'];\n`,
      'runtime/scripts/x.mjs': `export const c = process.env.${bogus};\n`,
      'runtime/vitest.config.ts': `export const d = process.env.${bogus};\n`,
      'runtime/packages/web/vite.config.ts': `export const e = process.env.${bogus};\n`,
      'runtime/tests/tooling/y.test.ts': `export const f = process.env.${bogus};\n`,
      'scripts/mcs.mjs': `export const g = process.env.${bogus};\n`,
    });
    const report = scanEnvironment(skill, []);
    expect(report.undocumented).toEqual(
      [
        'runtime/packages/engine/src/a.test.ts',
        'runtime/packages/engine/src/paths.ts',
        'runtime/packages/web/vite.config.ts',
        'runtime/scripts/x.mjs',
        'runtime/tests/tooling/y.test.ts',
        'runtime/vitest.config.ts',
        'scripts/mcs.mjs',
      ].map((file) => `${file}: ${bogus}`),
    );
  });

  it('finds a name used in a skill script of the plugin layout and ignores the committed bundle/ of a skill folder', () => {
    const skill = tree({
      'skills/monitoring-claude-sessions/scripts/mcs-hook.mjs': `export const a = process.env.${bogus};\n`,
      'skills/monitoring-claude-sessions/bundle/mcs-cli.mjs': `export const b = process.env.${bogus};\n`,
      'skills/monitoring-claude-sessions/bundle/scripts/x.mjs': `export const c = process.env.${bogus};\n`,
      'runtime/packages/engine/src/bundle/y.ts': `export const d = process.env.${bogus};\n`,
    });
    expect(scanEnvironment(skill, []).undocumented).toEqual([
      `runtime/packages/engine/src/bundle/y.ts: ${bogus}`,
      `skills/monitoring-claude-sessions/scripts/mcs-hook.mjs: ${bogus}`,
    ]);
  });

  it('does not scan node_modules, dist, the declaration of the list or non-source files', () => {
    const skill = tree({
      'runtime/packages/engine/node_modules/x/index.js': `${bogus}\n`,
      'runtime/packages/engine/dist/index.js': `${bogus}\n`,
      'runtime/packages/engine/src/notes.md': `${bogus}\n`,
      [DECLARATION]: `export const all = ['${bogus}'];\n`,
    });
    expect(scanEnvironment(skill, []).undocumented).toEqual([]);
  });

  it('treats a name that ends with an underscore as a prefix, not as a name', () => {
    const skill = tree({ 'runtime/packages/engine/src/a.ts': "export const p = 'MCS_TEST_'.length;\n" });
    expect(scanEnvironment(skill, []).undocumented).toEqual([]);
  });

  it('lets a test file set a sample variable without reading it, but not read an undocumented one', () => {
    const skill = tree({
      'runtime/packages/engine/src/a.test.ts': `vi.stubEnv('${bogus}', 'x');\nconst env = { ${bogus}: 'y' };\n`,
      'runtime/packages/testkit/src/helper.ts': `export const env = { ${bogus}: 'y' };\n`,
      'runtime/packages/engine/src/b.test.ts': `export const v = process.env['${bogus}'];\n`,
    });
    expect(scanEnvironment(skill, []).undocumented).toEqual([`runtime/packages/engine/src/b.test.ts: ${bogus}`]);
  });

  it('fails a documented name whose existing reader never mentions it', () => {
    const skill = tree({ 'runtime/packages/engine/src/paths.ts': 'export const h = 1;\n' });
    expect(scanEnvironment(skill, SAMPLE).unread).toEqual(['MCS_HOME (readers: runtime/packages/engine/src/paths.ts)']);
  });

  it('counts a reader that is still a scaffold stub as not existing', () => {
    const skill = tree({
      'runtime/packages/engine/src/paths.ts': '// Entry (scaffold stub): a later WP replaces this file.\nexport {};\n',
    });
    const report = scanEnvironment(skill, SAMPLE);
    expect(report.pending).toContain('MCS_HOME');
    expect(report.unread).toEqual([]);
  });

  it('does not let a name inside a longer name satisfy a reader', () => {
    const skill = tree({ 'runtime/packages/engine/src/paths.ts': `export const h = process.env['${longer}'];\n` });
    const report = scanEnvironment(skill, SAMPLE);
    expect(report.unread).toEqual(['MCS_HOME (readers: runtime/packages/engine/src/paths.ts)']);
    expect(report.undocumented).toEqual([`runtime/packages/engine/src/paths.ts: ${longer}`]);
  });

  it('reports a MCS_TEST_* name in production sources outside test-hooks.ts, but not in test files', () => {
    const skill = tree({
      'runtime/packages/engine/src/runtime/other.ts': `export const t = process.env['${hookName}'];\n`,
      'runtime/packages/engine/src/runtime/other.test.ts': `export const t = process.env['${hookName}'];\n`,
      [TEST_HOOK_HOME]: `export const t = process.env['${hookName}'];\n`,
    });
    const documented: DocumentedEnvVar[] = [{ name: hookName, scope: 'test', readers: [TEST_HOOK_HOME] }];
    expect(scanEnvironment(skill, documented).hookLeaks).toEqual([
      `runtime/packages/engine/src/runtime/other.ts: ${hookName}`,
    ]);
  });

  it('reports an undocumented CAW_ name as it does an MCS_ one', () => {
    const cawBogus = caw('NOT_DOCUMENTED_X');
    const skill = tree({
      'runtime/packages/engine/src/a.ts': `export const a = process.env['${cawBogus}'];\n`,
      'runtime/packages/engine/src/a.test.ts': `export const b = process.env['${cawBogus}'];\n`,
      'runtime/packages/engine/src/c.test.ts': `vi.stubEnv('${cawBogus}', 'x');\n`,
    });
    expect(scanEnvironment(skill, []).undocumented).toEqual([
      `runtime/packages/engine/src/a.test.ts: ${cawBogus}`,
      `runtime/packages/engine/src/a.ts: ${cawBogus}`,
    ]);
  });

  it('accepts a name and a legacyName of the registry, and nothing else of the same family', () => {
    const flipped: readonly DocumentedEnvVar[] = [
      {
        name: caw('SAMPLE'),
        legacyName: mcs('SAMPLE'),
        scope: 'runtime',
        readers: ['runtime/packages/engine/src/a.ts'],
      },
    ];
    const skill = tree({
      'runtime/packages/engine/src/a.ts': `export const a = [process.env.${caw('SAMPLE')}, process.env.${mcs('SAMPLE')}];\n`,
      'runtime/packages/engine/src/b.ts': `export const b = [process.env.${caw('SAMPLE_OTHER')}, process.env.${mcs('SAMPL')}];\n`,
    });
    expect(scanEnvironment(skill, flipped).undocumented).toEqual([
      `runtime/packages/engine/src/b.ts: ${caw('SAMPLE_OTHER')}`,
      `runtime/packages/engine/src/b.ts: ${mcs('SAMPL')}`,
    ]);
  });

  it('lets a reader satisfy an entry by mentioning either spelling, in a .bat file too', () => {
    const entry = (readers: string[]): DocumentedEnvVar[] => [
      { name: caw('SAMPLE'), legacyName: mcs('SAMPLE'), scope: 'runtime', readers },
    ];
    const canonicalOnly = tree({
      'runtime/packages/engine/src/a.ts': `export const a = process.env.${caw('SAMPLE')};\n`,
    });
    expect(scanEnvironment(canonicalOnly, entry(['runtime/packages/engine/src/a.ts'])).unread).toEqual([]);
    const legacyOnly = tree({ 'runtime/packages/engine/src/a.ts': `export const a = process.env.${mcs('SAMPLE')};\n` });
    expect(scanEnvironment(legacyOnly, entry(['runtime/packages/engine/src/a.ts'])).unread).toEqual([]);
    const bat = tree({ 'skills/x/scripts/start.bat': `if "%${caw('SAMPLE')}%"=="" exit /b 1\n` });
    const report = scanEnvironment(bat, entry(['skills/x/scripts/start.bat']));
    expect(report.unread).toEqual([]);
    expect(report.pending).toEqual([]);
    const silent = tree({ 'skills/x/scripts/start.bat': '@echo off\n' });
    expect(scanEnvironment(silent, entry(['skills/x/scripts/start.bat'])).unread).toHaveLength(1);
  });

  it('reports a CAW_TEST_ hook name in production sources outside test-hooks.ts, but not in test files', () => {
    const hook = caw('TEST_SOMETHING_NEW');
    const skill = tree({
      'runtime/packages/engine/src/runtime/other.ts': `export const t = process.env['${hook}'];\n`,
      'runtime/packages/engine/src/runtime/other.test.ts': `export const t = process.env['${hook}'];\n`,
      [TEST_HOOK_HOME]: `export const t = process.env['${hook}'];\n`,
    });
    const documented: DocumentedEnvVar[] = [{ name: hook, scope: 'test', readers: [TEST_HOOK_HOME] }];
    expect(scanEnvironment(skill, documented).hookLeaks).toEqual([
      `runtime/packages/engine/src/runtime/other.ts: ${hook}`,
    ]);
  });

  it('scans the compatibility scripts of a skill folder', () => {
    const skill = tree({
      'skills/sample-skill/compat/old.mjs': `export const a = process.env.${caw('NOT_DOCUMENTED_X')};\n`,
      'skills/sample-skill/compat/readme.md': `${caw('NOT_DOCUMENTED_X')}\n`,
    });
    expect(scanEnvironment(skill, []).undocumented).toEqual([
      `skills/sample-skill/compat/old.mjs: ${caw('NOT_DOCUMENTED_X')}`,
    ]);
  });

  it('accepts a known exception, and reports one that is documented or no longer present', () => {
    const skill = tree({ 'runtime/packages/engine/src/a.test.ts': `export const n = process.env['${bogus}'];\n` });
    const known = [{ file: 'runtime/packages/engine/src/a.test.ts', name: bogus }];
    expect(scanEnvironment(skill, [], known)).toMatchObject({ undocumented: [], staleExceptions: [] });
    const documented: DocumentedEnvVar[] = [{ name: bogus, scope: 'runtime', readers: [] }];
    expect(scanEnvironment(skill, documented, known).staleExceptions).toHaveLength(1);
    const gone = tree({ 'runtime/packages/engine/src/a.test.ts': 'export const n = 1;\n' });
    expect(scanEnvironment(gone, [], known).staleExceptions).toHaveLength(1);
  });
});

// ---- the real tree -------------------------------------------------------------------------------------------------------

describe('environment variables of the repository (01 section 2.10)', () => {
  const report = scanEnvironment(SKILL, DOCUMENTED_ENV_VARS, KNOWN_UNDOCUMENTED);

  it('reads no MCS_* name that is not documented in DOCUMENTED_ENV_VARS', () => {
    expect(report.undocumented).toEqual([]);
  });

  it('has none of the variables of the Python era in the registry or the exceptions (ADR 0066)', () => {
    const removed = ['PYTHON', 'GOLDEN_LIVE_CONFIG', 'GOLDEN_LIVE_INPUTS', 'GOLDEN_DIR', 'PARITY_LIVE'].map(mcs);
    const listed = [...DOCUMENTED_ENV_VARS.map((v) => v.name), ...KNOWN_UNDOCUMENTED.map((e) => e.name)];
    for (const name of removed) expect(listed, name).not.toContain(name);
  });

  it('keeps the list of known undocumented mentions honest', () => {
    expect(KNOWN_UNDOCUMENTED).toEqual([]);
    expect(report.staleExceptions).toEqual([]);
    for (const exception of KNOWN_UNDOCUMENTED) expect(exception.reason.length).toBeGreaterThan(20);
  });

  it('has a reader that mentions every documented name whose reader files exist', () => {
    expect(report.unread).toEqual([]);
  });

  it('keeps every MCS_TEST_* hook inside test-hooks.ts in production sources', () => {
    expect(report.hookLeaks).toEqual([]);
  });

  it('prints the documented names that have no reader yet (zero is required at the Phase 6 gate)', () => {
    process.stdout.write(`env-vars: ${report.pending.length} pending: ${report.pending.join(', ')}
`);
    expect(report.pending.length).toBeLessThanOrEqual(DOCUMENTED_ENV_VARS.length);
    for (const name of report.pending) expect(DOCUMENTED_ENV_VARS.map((v) => v.name)).toContain(name);
  });
});
