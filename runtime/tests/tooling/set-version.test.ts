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
  let base = '';
  let root = '';

  beforeEach(() => {
    // `<base>/runtime`: the script looks for the plugin layout in `<base>/.claude-plugin`
    base = mkdtempSync(join(tmpdir(), 'mcs-set-version-'));
    root = join(base, 'runtime');
    mkdirSync(join(root, 'scripts'), { recursive: true });
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
    rmSync(base, { recursive: true, force: true });
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

  describe('with the plugin layout', () => {
    const pluginFile = (): string => join(base, '.claude-plugin', 'plugin.json');
    const marketFile = (): string => join(base, '.claude-plugin', 'marketplace.json');

    function writePluginLayout(entries: readonly string[]): void {
      mkdirSync(join(base, '.claude-plugin'));
      writeFileSync(
        pluginFile(),
        `${JSON.stringify({ name: 'demo-plugin', version: '3.0.0' }, null, 2)}
`,
      );
      const market = {
        name: 'demo-market',
        owner: { name: 'Example' },
        plugins: entries.map((name) => ({ name, source: './skills/demo', version: '3.0.0' })),
      };
      writeFileSync(
        marketFile(),
        `${JSON.stringify(market, null, 2)}
`,
      );
    }

    it('writes the version into the manifests, plugin.json and the marketplace entry', () => {
      writePluginLayout(['demo-plugin']);
      expect(run('3.2.1')).toBe(0);
      expect(new Set(versions(root))).toEqual(new Set(['3.2.1']));
      expect((JSON.parse(readFileSync(pluginFile(), 'utf8')) as { version: string }).version).toBe('3.2.1');
      const market = JSON.parse(readFileSync(marketFile(), 'utf8')) as { plugins: { version: string }[] };
      expect(market.plugins.map((p) => p.version)).toEqual(['3.2.1']);
    });

    it('refuses a marketplace without exactly one entry of the plugin and writes nothing', () => {
      writePluginLayout(['other-plugin']);
      const before = [...snapshot(root), readFileSync(pluginFile(), 'utf8'), readFileSync(marketFile(), 'utf8')];
      expect(run('3.2.1')).toBe(2);
      expect([...snapshot(root), readFileSync(pluginFile(), 'utf8'), readFileSync(marketFile(), 'utf8')]).toEqual(
        before,
      );
    });
  });
});
