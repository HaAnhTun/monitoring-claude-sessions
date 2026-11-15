import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The boundaries of the terminal (design 01 sections 3.11 and 9, ADR 0080, 0082 and 0083), read from the source text:
// - one file loads the addon package (the loader), and a second one is allowed to name it only as the constant of the package name;
// - the addon's `spawn` is called in one place (the backend adapter), and the service starts interactive children only through
//   the `PtyBackend` seam (`backend.spawn`);
// - nothing outside the terminal folder reaches the loader, the adapter or a platform package;
// - the scripted pseudo terminal never reaches a production file.
// The ESLint rule that bans the import is probed in `tests/tooling/lint-rules.test.ts`; this test looks at what the files really do.
//
// Module names are assembled from parts: scripts/check-deps.mjs scans source text with a regex and must not take the text of a
// probe for a real import.

const RUNTIME_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENGINE_SRC = join(RUNTIME_ROOT, 'packages', 'engine', 'src');
const TERMINAL_DIR = join(ENGINE_SRC, 'terminal');
const ADDON = ['@lydell', 'node-pty'].join('/');
const CHILD_PROCESS = ['node', 'child_process'].join(':');
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.vite']);

const posix = (file: string): string => relative(RUNTIME_ROOT, file).replaceAll('\\', '/');
const underEngine = (file: string): string => relative(ENGINE_SRC, file).replaceAll('\\', '/');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/[.](?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const isTestFile = (file: string): boolean => /[.]test[.][cm]?[jt]sx?$/.test(file);

const texts = new Map<string, string>();
function textOf(file: string): string {
  let text = texts.get(file);
  if (text === undefined) {
    text = readFileSync(file, 'utf8');
    texts.set(file, text);
  }
  return text;
}

// ---- reading a file ----------------------------------------------------------------------------------------------------

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

/** `require(...)`, `import(...)` and `createRequire(...)(...)`: the calls that load a module for certain. */
function isDirectLoad(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  return (
    ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire'
  );
}

/**
 * True when the source really loads a module whose specifier `matches`: an import or export declaration (type-only included),
 * `import x = require()`, an import type, or a call whose first argument is such a string. `strict` counts only the calls that
 * load for certain (`require()`, `import()`, `createRequire(...)(...)`); the default also counts a stored `createRequire`
 * result (`load('x')`), and so any call that is handed the name as data. Strings and comments do not count.
 */
function loadsModule(
  fileName: string,
  source: string,
  matches: (specifier: string) => boolean,
  strict = false,
): boolean {
  const isModule = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isStringLiteralLike(node) && matches(node.text);
  const visit = (node: ts.Node): boolean => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isModule(node.moduleSpecifier)) return true;
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isModule(node.moduleReference.expression)
    ) {
      return true;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isModule(node.argument.literal))
      return true;
    if (ts.isCallExpression(node) && isModule(node.arguments[0]) && (!strict || isDirectLoad(node))) return true;
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(parse(fileName, source));
}

/** The text of every string literal of the source (comments are not literals). */
function literalsOf(fileName: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(fileName, source));
  return found;
}

/**
 * Calls to a function named `name`: `obj.name(...)` when `member` is true (any receiver, `this.#x.name(...)` included), else a bare
 * `name(...)`. A property that is only declared (`name: () => ...`, `name(...) {}`) is not a call.
 */
function callsFunction(fileName: string, source: string, name: string, member: boolean): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (member && ts.isPropertyAccessExpression(callee) && callee.name.text === name) return true;
      if (!member && ts.isIdentifier(callee) && callee.text === name) return true;
    }
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(parse(fileName, source));
}

// ---- the detectors, proved before they are trusted --------------------------------------------------------------------

describe('the readers of this test', () => {
  const quoted = (name: string): string => `'${name}'`;
  const statement = (...parts: string[]): string => `${parts.join(' ')};`;
  const isAddon = (specifier: string): boolean => specifier === ADDON;

  it('finds the addon in every form of import and ignores the name in a string or a comment', () => {
    const forms = [
      statement('import { spawn }', 'from', quoted(ADDON)),
      statement('import type * as P', 'from', quoted(ADDON)),
      statement('export * from', quoted(ADDON)),
      statement('const m = require(', `${quoted(ADDON)})`),
      statement('const m = await import(', `${quoted(ADDON)})`),
      statement('import m = require(', `${quoted(ADDON)})`),
      statement('const m = createRequire(import.meta.url)(', `${quoted(ADDON)})`),
      statement(`type M = typeof import(${quoted(ADDON)})`),
    ];
    for (const form of forms) expect(loadsModule('probe.ts', form, isAddon), form).toBe(true);
    expect(loadsModule('probe.ts', statement('export const name =', quoted(ADDON)), isAddon)).toBe(false);
    expect(
      loadsModule('probe.ts', `// ${statement('import m from', quoted(ADDON))}\nexport const a = 1;\n`, isAddon),
    ).toBe(false);
    expect(loadsModule('probe.ts', statement('import z from', quoted('zod')), isAddon)).toBe(false);
  });

  it('strict mode counts only the calls that load for certain, not a call that is handed the name as data', () => {
    const data = statement('const name = tarballFileName(', `${quoted(ADDON)}, '1.0.0')`);
    const stored = `const load = createRequire(import.meta.url);\n${statement('const m = load(', `${quoted(ADDON)})`)}`;
    expect(loadsModule('probe.ts', data, isAddon)).toBe(true);
    expect(loadsModule('probe.ts', data, isAddon, true)).toBe(false);
    expect(loadsModule('probe.ts', stored, isAddon)).toBe(true);
    expect(loadsModule('probe.ts', stored, isAddon, true)).toBe(false);
    for (const form of [
      statement('const m = require(', `${quoted(ADDON)})`),
      statement('const m = await import(', `${quoted(ADDON)})`),
      statement('const m = createRequire(import.meta.url)(', `${quoted(ADDON)})`),
      statement('import { m } from', quoted(ADDON)),
    ]) {
      expect(loadsModule('probe.ts', form, isAddon, true), form).toBe(true);
    }
  });

  it('finds a string literal that holds the name, and nothing in a comment', () => {
    expect(literalsOf('probe.ts', `export const NAME = ${quoted(ADDON)}; // ${ADDON}\n`)).toEqual([ADDON]);
    expect(literalsOf('probe.ts', `/* ${ADDON} */ export const a = 1;\n`)).toEqual([]);
  });

  it('finds a call of spawn through any receiver, and not a declaration of it or a comment', () => {
    for (const code of [
      'a.spawn(1);',
      'this.#module.spawn(cmd, args, options);',
      'deps.backend.spawn();',
      'x?.spawn(1);',
    ]) {
      expect(callsFunction('probe.ts', code, 'spawn', true), code).toBe(true);
    }
    for (const code of [
      'const o = { spawn: () => 1 };',
      'class A { spawn() { return 1; } }',
      '// a.spawn(1)\nexport const a = 1;',
      'a.spawnDetached(1);',
      'spawn(1);',
    ]) {
      expect(callsFunction('probe.ts', code, 'spawn', true), code).toBe(false);
    }
    expect(callsFunction('probe.ts', 'spawn(file, args);', 'spawn', false)).toBe(true);
    expect(callsFunction('probe.ts', 'a.spawn(file);', 'spawn', false)).toBe(false);
  });
});

// ---- the engine sources -----------------------------------------------------------------------------------------------------

const engineFiles = sourceFiles(ENGINE_SRC);
const engineProduction = engineFiles.filter((file) => !isTestFile(file));
const terminalProduction = engineProduction.filter((file) => file.startsWith(TERMINAL_DIR));

/** The files of `files` that load a module whose specifier matches; a file that never names `needle` is not parsed. */
function loaders(files: readonly string[], needle: string, matches: (specifier: string) => boolean): string[] {
  return files
    .filter((file) => textOf(file).includes(needle) && loadsModule(file, textOf(file), matches))
    .map(underEngine)
    .sort();
}

describe('the addon package (ADR 0080, 0082)', () => {
  it('is loaded by one file of the engine: terminal/node-pty-loader.ts', () => {
    expect(loaders(engineProduction, 'node-pty', (specifier) => specifier === ADDON)).toEqual([
      'terminal/node-pty-loader.ts',
    ]);
  }, 60_000);

  it('is spelled out in the loader and, as the constant of its name, in native-targets.ts, and nowhere else', () => {
    const holders = engineProduction
      .filter((file) => textOf(file).includes(ADDON))
      .filter((file) => literalsOf(file, textOf(file)).some((literal) => literal.startsWith(ADDON)))
      .map(underEngine)
      .sort();
    expect(holders).toEqual(['terminal/native-targets.ts', 'terminal/node-pty-loader.ts']);
  }, 60_000);

  it('is not loaded by any test file of the engine: the tests script the loader instead', () => {
    const tests = engineFiles.filter(isTestFile);
    expect(loaders(tests, 'node-pty', (specifier) => specifier === ADDON)).toEqual([]);
  }, 60_000);
});

describe('who starts a process (ADR 0051 as amended by ADR 0083)', () => {
  const isLoader = (specifier: string): boolean => /(?:^|\/)node-pty-loader(?:\.ts|\.js)?$/.test(specifier);

  it('only the backend adapter calls the addon spawn: the files that load the loader are the adapter and the check', () => {
    const importers = loaders(engineProduction, 'node-pty-loader', isLoader);
    expect(importers).toEqual(['terminal/diagnose.ts', 'terminal/index.ts', 'terminal/node-pty-backend.ts']);
    const spawning = importers.filter((file) => callsFunction(file, textOf(join(ENGINE_SRC, file)), 'spawn', true));
    expect(spawning).toEqual(['terminal/node-pty-backend.ts']);
  }, 60_000);

  it('the service starts a child only through the PtyBackend seam: `.spawn(` is called in the service and in the adapter', () => {
    const calling = engineProduction
      .filter((file) => textOf(file).includes('spawn') && callsFunction(file, textOf(file), 'spawn', true))
      .map(underEngine)
      .sort();
    expect(calling).toEqual(['terminal/manager.ts', 'terminal/node-pty-backend.ts']);
  }, 60_000);

  it('the short-lived children of the engine (and nothing else) go through platform/exec.ts', () => {
    expect(loaders(engineProduction, 'child_process', (specifier) => specifier === CHILD_PROCESS)).toEqual([
      'platform/exec.ts',
    ]);
    const bare = engineProduction
      .filter((file) => textOf(file).includes('spawn') && callsFunction(file, textOf(file), 'spawn', false))
      .map(underEngine)
      .sort();
    expect(bare).toEqual(['platform/exec.ts']);
  }, 60_000);

  it('the terminal folder loads no child_process of its own', () => {
    expect(loaders(terminalProduction, 'child_process', (specifier) => specifier.endsWith('child_process'))).toEqual(
      [],
    );
  }, 60_000);
});

describe('nothing outside terminal/ reaches the addon files (ADR 0082)', () => {
  const roots = [join(RUNTIME_ROOT, 'packages'), join(RUNTIME_ROOT, 'tests'), join(RUNTIME_ROOT, 'scripts')];
  const reachesAddon = (specifier: string): boolean =>
    /(?:^|\/)node-pty-(?:loader|backend)(?:\.ts|\.js)?$/.test(specifier) || specifier.startsWith(`${ADDON}-`);

  it('imports neither node-pty-loader, node-pty-backend nor a platform package', () => {
    const outside = roots
      .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory() === true)
      .flatMap(sourceFiles)
      .filter((file) => !file.startsWith(TERMINAL_DIR));
    const found = outside
      // strict: the tests and scripts of other packages hand package names to helpers as data (`tarballFileName(name, version)`)
      .filter((file) => textOf(file).includes('node-pty') && loadsModule(file, textOf(file), reachesAddon, true))
      .map(posix)
      .sort();
    expect(found).toEqual([]);
  }, 60_000);
});

describe('the scripted pseudo terminal (design 01 section 3.11)', () => {
  const isFake = (specifier: string): boolean => /(?:^|\/)fake-pty(?:\.ts|\.js)?$/.test(specifier);

  it('is reached by the testing entry only: no production file of the engine loads fake-pty', () => {
    expect(loaders(engineProduction, 'fake-pty', isFake)).toEqual(['terminal/testing.ts']);
  }, 60_000);
});

describe('the barrel terminal/index.ts', () => {
  const barrel = join(TERMINAL_DIR, 'index.ts');
  const exportsOf = (file: string): string[] => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, textOf(file)));
    return found.sort();
  };

  /** The scripted pty and its entry are reached through `@mcs/engine/testing`, never through the production barrel. */
  const NOT_IN_BARREL = new Set(['index.ts', 'fake-pty.ts', 'testing.ts']);

  it('re-exports every module of the terminal folder except the scripted pseudo terminal and the barrel itself', () => {
    const modules = terminalProduction
      .map((file) => relative(TERMINAL_DIR, file).replaceAll('\\', '/'))
      .filter((name) => !NOT_IN_BARREL.has(name))
      .map((name) => `./${name}`)
      .sort();
    expect(modules.length).toBeGreaterThan(10);
    expect(exportsOf(barrel)).toEqual(modules);
  });

  it('does not export the scripted pseudo terminal', () => {
    for (const specifier of exportsOf(barrel)) expect(specifier).not.toMatch(/fake-pty|testing/);
  });

  it('exports every terminal module with `.ts` specifiers, as the rest of the engine does', () => {
    for (const specifier of exportsOf(barrel)) expect(specifier).toMatch(/^\.\/[a-z-]+\.ts$/);
  });
});
