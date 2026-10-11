// `scripts/lib.mjs` `require-build`: the clear failure of the standalone test scripts (`test:int`, `test:isolation`,
// `test:resilience`) when `npm run build` has not run. About 150 tests spawn `dist/main.js`, `dist/hook.js` or
// `dist/boot.js` and read `.mcs-build.json`; without a build they fail with unrelated messages. Run against a throw-away
// copy of the script, so the real workspace is neither read nor changed.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');

const OUTPUTS = [
  '.mcs-build.json',
  'packages/cli/dist/main.js',
  'packages/cli/dist/hook.js',
  'packages/server/dist/boot.js',
] as const;

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-build-required-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(RUNTIME, 'scripts', 'lib.mjs'), join(root, 'scripts', 'lib.mjs'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(rel: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), '');
}

function requireBuild(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'lib.mjs'), 'require-build'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/lib.mjs require-build', () => {
  it('fails with a message that names every missing output and the command that builds them', () => {
    const run = requireBuild();
    expect(run.status).toBe(1);
    for (const output of OUTPUTS) expect(run.stderr).toContain(output);
    expect(run.stderr).toContain('npm run build');
    expect(run.stdout).toBe('');
  });

  it('names only what is missing', () => {
    for (const output of OUTPUTS.slice(0, 3)) touch(output);
    const run = requireBuild();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('packages/server/dist/boot.js');
    expect(run.stderr).not.toContain('.mcs-build.json');
    expect(run.stderr).not.toContain('packages/cli/dist/main.js');
  });

  it('passes silently when the build and its stamp are there', () => {
    for (const output of OUTPUTS) touch(output);
    const run = requireBuild();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('is only a command line when run as a script: importing the helpers prints nothing and exits nothing', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { missingBuildOutputs } from ${JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib.mjs')).href)};` +
          'console.log(JSON.stringify(missingBuildOutputs()));',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual([...OUTPUTS]);
  });
});
