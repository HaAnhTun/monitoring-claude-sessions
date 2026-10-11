// Probe table of 05 section 2.5 / experiment E20 for `scripts/check-deps.mjs`: the script is copied into a throw-away
// workspace (it resolves its root from its own location), broken in one way per case, and must exit 1 with the exact
// `check-deps: <file>: <problem>` line. The real workspace is checked by the `check:deps` gate of `npm run ci`.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const PACKAGES = ['shared', 'engine', 'server', 'cli', 'web', 'testkit'] as const;

type Manifest = Record<string, unknown>;

interface Workspace {
  root: Manifest;
  packages: Record<(typeof PACKAGES)[number], Manifest>;
  files: Record<string, string>;
}

function cleanWorkspace(): Workspace {
  const manifest = (name: string, extra: Manifest = {}): Manifest => ({
    name: `@mcs/${name}`,
    version: '3.0.0',
    private: true,
    ...extra,
  });
  return {
    root: {
      name: '@mcs/runtime',
      version: '3.0.0',
      devDependencies: { vitest: '5.0.3', typescript: '6.0.3' },
      overrides: { 'eslint-plugin-jsx-a11y': { eslint: '$eslint' } },
    },
    packages: {
      shared: manifest('shared', { dependencies: { zod: '4.6.5' } }),
      engine: manifest('engine', { dependencies: { '@mcs/shared': '3.0.0', 'better-sqlite3': '12.0.0' } }),
      server: manifest('server', {
        dependencies: { '@mcs/engine': '3.0.0', '@mcs/shared': '3.0.0', express: '5.0.0' },
      }),
      cli: manifest('cli', { dependencies: { '@mcs/engine': '3.0.0' } }),
      web: manifest('web', { dependencies: { '@mcs/shared': '3.0.0' }, devDependencies: { axe: '1.0.0' } }),
      testkit: manifest('testkit', { dependencies: { '@mcs/shared': '3.0.0' } }),
    },
    files: {
      'packages/shared/src/a.ts': "import { z } from 'zod';\nexport const a = z.string();\n",
      'packages/engine/src/a.ts':
        "import { readFileSync } from 'node:fs';\nimport { join } from 'path';\nimport Database from 'better-sqlite3';\nimport { a } from '@mcs/shared';\nimport { b } from './b.ts';\nexport const all = [readFileSync, join, Database, a, b];\n",
      'packages/engine/src/b.ts': 'export const b = 1;\n',
    },
  };
}

let dir = '';

function materialize(ws: Workspace): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const name of ['check-deps.mjs', 'lib.mjs']) cpSync(join(RUNTIME, 'scripts', name), join(dir, 'scripts', name));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(ws.root, null, 2)}\n`);
  for (const name of PACKAGES) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(join(dir, 'packages', name, 'package.json'), `${JSON.stringify(ws.packages[name], null, 2)}\n`);
  }
  for (const [file, text] of Object.entries(ws.files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function run(cwd = dir): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(cwd, 'scripts', 'check-deps.mjs')], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcs-check-deps-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scripts/check-deps.mjs on a throw-away workspace', () => {
  it('accepts a clean workspace and prints "check-deps: ok"', () => {
    materialize(cleanWorkspace());
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('check-deps: ok');
    expect(result.status).toBe(0);
  });

  it('accepts an exact prerelease and an npm alias, bare builtins and relative imports', () => {
    const ws = cleanWorkspace();
    ws.packages.shared['dependencies'] = { zod: '4.6.5', alias: 'npm:real@1.2.3', pre: '1.0.0-rc.1' };
    materialize(ws);
    expect(run().status).toBe(0);
  });

  it('E20: an import of an undeclared package in engine src is reported', () => {
    const ws = cleanWorkspace();
    ws.files['packages/engine/src/uses-vitest.ts'] = "import { it } from 'vitest';\nexport const x = it;\n";
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "check-deps: packages/engine/src/uses-vitest.ts: imports 'vitest' which is not declared in dependencies of packages/engine/package.json",
    );
    expect(result.stderr).toContain('check-deps: 1 problem(s)');
  });

  it('E20: a range spec in a manifest is reported', () => {
    const ws = cleanWorkspace();
    ws.packages.server['dependencies'] = { '@mcs/engine': '3.0.0', '@mcs/shared': '3.0.0', express: '^5.3.0' };
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-deps: packages/server/package.json: express@^5.3.0 is not an exact version');
  });

  it('E20: a workspace package used in web e2e without a declaration is reported, and passes once declared', () => {
    const ws = cleanWorkspace();
    ws.files['packages/web/e2e/spec.ts'] = "import { demo } from '@mcs/testkit';\nexport const d = demo;\n";
    materialize(ws);
    const failing = run();
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      "check-deps: packages/web/e2e/spec.ts: imports '@mcs/testkit' which is not declared in dependencies/devDependencies of packages/web/package.json",
    );

    ws.packages.web['devDependencies'] = { axe: '1.0.0', '@mcs/testkit': '3.0.0' };
    materialize(ws);
    expect(run().status).toBe(0);
  });

  it('lets test files use the devDependencies of the package and of the root, but production files not', () => {
    const ws = cleanWorkspace();
    ws.files['packages/web/src/a.test.ts'] =
      "import { it } from 'vitest';\nimport axe from 'axe';\nexport const all = [it, axe];\n";
    ws.files['packages/web/src/prod.ts'] = "import axe from 'axe';\nexport const x = axe;\n";
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("check-deps: packages/web/src/prod.ts: imports 'axe'");
    expect(result.stderr).not.toContain('a.test.ts');
    expect(result.stderr).toContain('check-deps: 1 problem(s)');
  });

  it('lets a type-only import use the devDependencies', () => {
    const ws = cleanWorkspace();
    ws.files['packages/web/src/types.ts'] = "import type { Axe } from 'axe';\nexport type T = Axe;\n";
    materialize(ws);
    expect(run().status).toBe(0);
  });

  it('reports a workspace version that differs from the root', () => {
    const ws = cleanWorkspace();
    ws.packages.cli['version'] = '3.0.1';
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-deps: packages/cli/package.json: version 3.0.1 != root 3.0.0');
  });

  it('reports a workspace that is not private', () => {
    const ws = cleanWorkspace();
    ws.packages.testkit['private'] = false;
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-deps: packages/testkit/package.json: must be private');
  });

  it('reports an @mcs dependency spec that differs from the root version', () => {
    const ws = cleanWorkspace();
    ws.packages.cli['dependencies'] = { '@mcs/engine': '2.9.0' };
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-deps: packages/cli/package.json: @mcs/engine@2.9.0 must equal 3.0.0');
  });

  it('reports root overrides other than eslint-plugin-jsx-a11y', () => {
    const ws = cleanWorkspace();
    ws.root['overrides'] = { 'eslint-plugin-jsx-a11y': { eslint: '$eslint' }, lodash: '4.17.21' };
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'check-deps: package.json overrides must contain only eslint-plugin-jsx-a11y (ADR-0042), found: eslint-plugin-jsx-a11y,lodash',
    );
  });

  it('reports a range in the root devDependencies', () => {
    const ws = cleanWorkspace();
    ws.root['devDependencies'] = { vitest: '~5.0.3' };
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check-deps: package.json devDependencies: vitest@~5.0.3 is not an exact version');
  });

  it('does not read a test title that ends in the word import as an import statement', () => {
    const ws = cleanWorkspace();
    ws.files['packages/engine/src/titles.test.ts'] = [
      "import { describe, it } from 'vitest';",
      "describe('malformed input never stops the import', () => {",
      "  it('nothing is written when there is nothing to import', () => {",
      '    expect(1).toBe(1);',
      '  });',
      "  it('a title with the word import', () => undefined);",
      '});',
      '',
    ].join('\n');
    materialize(ws);
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('still reads side-effect, dynamic, multi-line and re-export imports, and reports the undeclared ones', () => {
    const ws = cleanWorkspace();
    ws.files['packages/engine/src/side-effect.ts'] = `import 'undeclared-side';
import "undeclared-double";
`;
    ws.files['packages/engine/src/dynamic.ts'] = `export const load = () => import('undeclared-dynamic');
`;
    ws.files['packages/engine/src/multi.ts'] = `import {
  a,
  b,
} from 'undeclared-multi';
export { a, b };
`;
    ws.files['packages/engine/src/reexport.ts'] = `export { c } from 'undeclared-reexport';
`;
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    for (const name of ['side', 'double', 'dynamic', 'multi', 'reexport']) {
      expect(result.stderr).toContain(`imports 'undeclared-${name}'`);
    }
    expect(result.stderr).toContain('check-deps: 5 problem(s)');
  });

  it('treats the sources of the test-only testkit package as test code: vitest from the root is allowed, the rest is not', () => {
    const ws = cleanWorkspace();
    ws.files['packages/testkit/src/temp.ts'] = `import { afterEach } from 'vitest';
export const hook = afterEach;
`;
    materialize(ws);
    expect(run().status).toBe(0);

    ws.files['packages/testkit/src/other.ts'] = `import 'undeclared-testkit';
`;
    materialize(ws);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("check-deps: packages/testkit/src/other.ts: imports 'undeclared-testkit'");
    expect(result.stderr).not.toContain('temp.ts');
  });

  it('ignores node_modules and dist folders and declaration files', () => {
    const ws = cleanWorkspace();
    ws.files['packages/engine/node_modules/x/index.ts'] = "import 'undeclared-a';\n";
    ws.files['packages/engine/dist/index.ts'] = "import 'undeclared-b';\n";
    ws.files['packages/engine/src/types.d.ts'] = "import 'undeclared-c';\n";
    materialize(ws);
    expect(run().status).toBe(0);
  });
});
