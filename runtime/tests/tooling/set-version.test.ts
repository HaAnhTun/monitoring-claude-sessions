import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const PACKAGES = ['shared', 'engine', 'server', 'cli', 'web', 'testkit'];

function manifestPaths(root: string): string[] {
  return [join(root, 'package.json'), ...PACKAGES.map((name) => join(root, 'packages', name, 'package.json'))];
}

function versions(root: string): string[] {
  return manifestPaths(root).map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version);
}

function snapshot(root: string): string[] {
  return manifestPaths(root).map((file) => readFileSync(file, 'utf8'));
}

describe('scripts/set-version.mjs', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcs-set-version-'));
    mkdirSync(join(root, 'scripts'));
    cpSync(join(RUNTIME, 'scripts', 'set-version.mjs'), join(root, 'scripts', 'set-version.mjs'));
    cpSync(join(RUNTIME, 'scripts', 'lib.mjs'), join(root, 'scripts', 'lib.mjs'));
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'root', version: '3.0.0' }, null, 2)}\n`);
    for (const name of PACKAGES) {
      mkdirSync(join(root, 'packages', name), { recursive: true });
      const manifest = {
        name: `@mcs/${name}`,
        version: '3.0.0',
        dependencies: { '@mcs/shared': '3.0.0', zod: '4.0.0' },
      };
      writeFileSync(join(root, 'packages', name, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(version: string): number | null {
    return spawnSync(process.execPath, [join(root, 'scripts', 'set-version.mjs'), version], { encoding: 'utf8' })
      .status;
  }

  it.each(['3.0.10', '3.12.0', '10.0.0', '3.1.0-rc.1', '0.0.0'])('accepts %s and writes every manifest', (version) => {
    expect(run(version)).toBe(0);
    expect(new Set(versions(root))).toEqual(new Set([version]));
    const server = JSON.parse(readFileSync(join(root, 'packages', 'server', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(server.dependencies['@mcs/shared']).toBe(version);
    expect(server.dependencies['zod']).toBe('4.0.0');
  });

  it.each(['3x0y0', '01.0.0', '3.01.0', '3.0', '3.0.1x', '3.0.0.0', 'v3.0.0', ''])(
    'rejects %j and writes nothing',
    (version) => {
      const before = snapshot(root);
      expect(run(version)).toBe(2);
      expect(snapshot(root)).toEqual(before);
    },
  );
});
