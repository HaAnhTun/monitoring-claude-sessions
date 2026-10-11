// Probe table of 05 section 3.3 / experiment E18 for `scripts/build-stamp.mjs`, driven through its CLI (`check`, `write`,
// `write-install`) on throw-away copies of a minimal workspace, plus the import contract the launcher relies on.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const PACKAGES = ['shared', 'engine', 'server', 'cli', 'web', 'testkit'] as const;

interface Staleness {
  install: boolean;
  build: boolean;
  reasons: string[];
  installStamp: string;
  buildStamp: string;
  ms: number;
}

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-build-stamp-'));
  roots.push(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'node_modules'));
  for (const name of ['build-stamp.mjs', 'lib.mjs']) cpSync(join(RUNTIME, 'scripts', name), join(dir, 'scripts', name));
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: '@mcs/runtime', version: '3.0.0' })}\n`,
    'package-lock.json': '{"lockfileVersion":3}\n',
    '.npmrc': 'ignore-scripts=true\n',
    'tsconfig.base.json': '{}\n',
    'tsconfig.build.json': '{}\n',
    'packages/web/index.html': '<!doctype html>\n',
    'packages/web/vite.config.ts': 'export default {};\n',
    'packages/web/public/logo.svg': '<svg/>\n',
  };
  for (const name of PACKAGES) {
    files[`packages/${name}/package.json`] = `${JSON.stringify({ name: `@mcs/${name}`, version: '3.0.0' })}\n`;
    files[`packages/${name}/tsconfig.json`] = '{}\n';
    files[`packages/${name}/tsconfig.build.json`] = '{}\n';
    files[`packages/${name}/src/index.ts`] = `export const ${name} = 1;\n`;
    files[`packages/${name}/src/index.test.ts`] = "import { it } from 'vitest';\nit('x', () => undefined);\n";
  }
  files['packages/web/src/test-setup.ts'] = 'export {};\n';
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function stamp(root: string, command?: string): { status: number | null; stdout: string; stderr: string } {
  const args = [join(root, 'scripts', 'build-stamp.mjs'), ...(command === undefined ? [] : [command])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function check(root: string): { status: number | null; state: Staleness } {
  const result = stamp(root, 'check');
  return { status: result.status, state: JSON.parse(result.stdout) as Staleness };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function edit(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Brings a fresh root to "installed and built". */
function settle(root: string): void {
  expect(stamp(root, 'write-install').status).toBe(0);
  expect(stamp(root, 'write').status).toBe(0);
}

beforeEach(() => {
  roots.length = 0;
});

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/build-stamp.mjs check', () => {
  it('reports a missing install stamp first and exits 1', () => {
    const { status, state } = check(makeRoot());
    expect(status).toBe(1);
    expect(state.install).toBe(true);
    expect(state.build).toBe(true);
    expect(state.reasons).toEqual(['no install stamp']);
  });

  it('reports a missing build stamp when only the install stamp exists', () => {
    const root = makeRoot();
    expect(stamp(root, 'write-install').status).toBe(0);
    const { status, state } = check(root);
    expect(status).toBe(1);
    expect(state.install).toBe(false);
    expect(state.build).toBe(true);
    expect(state.reasons).toEqual(['no build stamp']);
  });

  it('exits 0 with both stamps current and is the default command', () => {
    const root = makeRoot();
    settle(root);
    const { status, state } = check(root);
    expect(status).toBe(0);
    expect(state).toMatchObject({ install: false, build: false, reasons: [] });
    expect(JSON.parse(stamp(root).stdout)).toMatchObject({ install: false, build: false });
  });

  it('E18: editing a test file or test setup leaves the build current', () => {
    const root = makeRoot();
    settle(root);
    edit(root, 'packages/engine/src/index.test.ts', "import { it } from 'vitest';\nit('changed', () => undefined);\n");
    edit(root, 'packages/web/src/test-setup.ts', 'export const changed = true;\n');
    edit(root, 'packages/engine/test/helper.ts', 'export const helper = 1;\n');
    expect(check(root).state).toMatchObject({ install: false, build: false });
  });

  it('E18: editing a source file marks the build stale but not the install', () => {
    const root = makeRoot();
    settle(root);
    edit(root, 'packages/engine/src/index.ts', 'export const engine = 2;\n');
    const { status, state } = check(root);
    expect(status).toBe(1);
    expect(state).toMatchObject({ install: false, build: true, reasons: ['sources changed since last build'] });
  });

  it('E18: editing .npmrc or the lockfile marks the install stale (and so the build)', () => {
    for (const file of ['.npmrc', 'package-lock.json']) {
      const root = makeRoot();
      settle(root);
      edit(root, file, `${readFileSync(join(root, file), 'utf8')}# changed\n`);
      const { status, state } = check(root);
      expect(status, file).toBe(1);
      expect(state, file).toMatchObject({
        install: true,
        build: true,
        reasons: ['lockfile, .npmrc or platform changed'],
      });
    }
  });

  it.each([
    ['root package.json', 'package.json', '{"name":"@mcs/runtime","version":"3.0.1"}\n'],
    ['tsconfig.base.json', 'tsconfig.base.json', '{"a":1}\n'],
    ['tsconfig.build.json', 'tsconfig.build.json', '{"a":1}\n'],
    ['a package manifest', 'packages/cli/package.json', '{"name":"@mcs/cli","version":"3.0.1"}\n'],
    ['a package tsconfig', 'packages/server/tsconfig.build.json', '{"a":1}\n'],
    ['vite.config.ts', 'packages/web/vite.config.ts', 'export default { a: 1 };\n'],
    ['index.html', 'packages/web/index.html', '<!doctype html><title>x</title>\n'],
    ['a web public file', 'packages/web/public/logo.svg', '<svg width="1"/>\n'],
    ['a new nested source file', 'packages/shared/src/deep/er/new.ts', 'export const n = 1;\n'],
  ])('a change of %s marks the build stale', (_label, file, text) => {
    const root = makeRoot();
    settle(root);
    edit(root, file, text);
    expect(check(root).state).toMatchObject({ install: false, build: true });
  });

  it('does not hash the testkit package or folders named dist, node_modules, coverage and test-results', () => {
    const root = makeRoot();
    settle(root);
    edit(root, 'packages/testkit/src/index.ts', 'export const testkit = 2;\n');
    edit(root, 'packages/testkit/package.json', '{"name":"@mcs/testkit","version":"3.0.0","x":1}\n');
    edit(root, 'packages/engine/src/dist/out.js', 'x\n');
    edit(root, 'packages/engine/src/node_modules/x/index.js', 'x\n');
    edit(root, 'packages/engine/src/coverage/lcov.info', 'x\n');
    edit(root, 'packages/engine/src/test-results/r.json', 'x\n');
    expect(check(root).state).toMatchObject({ install: false, build: false });
  });

  it('E18: the stamps do not depend on the checkout location', () => {
    const first = makeRoot();
    const second = makeRoot();
    expect(check(first).state.buildStamp).toBe(check(second).state.buildStamp);
    expect(check(first).state.installStamp).toBe(check(second).state.installStamp);
    expect(check(first).state.buildStamp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefixes the install stamp with the platform, architecture and Node major', () => {
    const { state } = check(makeRoot());
    expect(state.installStamp).toMatch(
      new RegExp(`^${process.platform}-${process.arch}-node${process.versions.node.split('.')[0] ?? ''}:[0-9a-f]{64}$`),
    );
  });

  it('is fast on a small tree', () => {
    const root = makeRoot();
    expect(check(root).state.ms).toBeLessThan(2_000);
  });
});

describe('scripts/build-stamp.mjs write and write-install', () => {
  it('writes the build stamp with the documented fields and leaves no temporary file', () => {
    const root = makeRoot();
    const result = stamp(root, 'write');
    expect(result.status).toBe(0);
    const written = readJson(join(root, '.mcs-build.json'));
    const { state } = check(root);
    expect(Object.keys(written).sort()).toEqual(
      ['buildStamp', 'builtAt', 'codeStamp', 'node', 'runtimeVersion', 'schemaVersion'].sort(),
    );
    expect(written['schemaVersion']).toBe(1);
    expect(written['runtimeVersion']).toBe('3.0.0');
    expect(written['buildStamp']).toBe(state.buildStamp);
    expect(written['codeStamp']).toBe(state.buildStamp.slice(0, 10));
    expect(written['codeStamp']).toMatch(/^[0-9a-f]{10}$/);
    expect(written['node']).toBe(process.version);
    expect(Date.parse(String(written['builtAt']))).not.toBeNaN();
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(result.stdout).toContain('build-stamp: wrote .mcs-build.json');
  });

  it('writes the install stamp inside node_modules with the documented fields', () => {
    const root = makeRoot();
    const result = stamp(root, 'write-install');
    expect(result.status).toBe(0);
    const written = readJson(join(root, 'node_modules', '.mcs-install.json'));
    expect(Object.keys(written).sort()).toEqual(['installStamp', 'installedAt', 'schemaVersion']);
    expect(written['schemaVersion']).toBe(1);
    expect(written['installStamp']).toBe(check(root).state.installStamp);
    expect(readdirSync(join(root, 'node_modules')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('write-install fails without node_modules instead of creating a stamp that claims an install', () => {
    const root = makeRoot();
    rmSync(join(root, 'node_modules'), { recursive: true });
    const result = stamp(root, 'write-install');
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });
});

describe('scripts/build-stamp.mjs as imported by the launcher', () => {
  it('exports the documented API and has no side effect on import', () => {
    const root = makeRoot();
    const program = [
      `const m = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts', 'build-stamp.mjs')).href)});`,
      'const s = m.staleness(process.argv[1]);',
      'console.log(JSON.stringify({',
      '  names: Object.keys(m).sort(),',
      '  schema: m.STAMP_SCHEMA_VERSION, build: m.BUILD_STAMP_FILE, install: m.INSTALL_STAMP_FILE,',
      '  fn: [typeof m.computeStamps, typeof m.staleness],',
      '  stamps: Object.keys(m.computeStamps(process.argv[1])).sort(),',
      '  staleKeys: Object.keys(s).sort(),',
      '}));',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, root], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out['names']).toEqual(
      expect.arrayContaining([
        'BUILD_STAMP_FILE',
        'INSTALL_STAMP_FILE',
        'STAMP_SCHEMA_VERSION',
        'buildInputs',
        'computeStamps',
        'installInputs',
        'staleness',
      ]),
    );
    expect(out['schema']).toBe(1);
    expect(out['build']).toBe('.mcs-build.json');
    expect(out['install']).toBe(join('node_modules', '.mcs-install.json'));
    expect(out['fn']).toEqual(['function', 'function']);
    expect(out['stamps']).toEqual(['buildStamp', 'installStamp']);
    expect(out['staleKeys']).toEqual(['build', 'buildStamp', 'install', 'installStamp', 'reasons']);
    expect(existsSync(join(root, '.mcs-build.json'))).toBe(false);
  });
});

describe('scripts/build-stamp.mjs on the real workspace', () => {
  it('computes stamps without writing anything', () => {
    const before = existsSync(join(RUNTIME, '.mcs-build.json'))
      ? readFileSync(join(RUNTIME, '.mcs-build.json'), 'utf8')
      : null;
    const result = stamp(RUNTIME, 'check');
    const state = JSON.parse(result.stdout) as Staleness;
    expect(state.buildStamp).toMatch(/^[0-9a-f]{64}$/);
    expect(state.installStamp).toContain(`${process.platform}-${process.arch}`);
    const after = existsSync(join(RUNTIME, '.mcs-build.json'))
      ? readFileSync(join(RUNTIME, '.mcs-build.json'), 'utf8')
      : null;
    expect(after).toBe(before);
  });
});
