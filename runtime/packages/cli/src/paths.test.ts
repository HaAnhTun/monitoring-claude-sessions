import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { buildInfoOf, buildState, codeStampOf, mainPathsOf } from './paths.ts';

const tempDir = useTempDirs();

/** A scripted file-system seam: `files` are POSIX-style paths, compared after turning backslashes into slashes. */
function seam(platform: 'win32' | 'linux', files: readonly string[]) {
  const set = new Set(files);
  return { platform, exists: (file: string) => set.has(file.replaceAll('\\', '/')) } as const;
}

describe('mainPathsOf', () => {
  it('finds a checkout from a src URL and from a dist URL (source layout, Windows drive)', () => {
    const fs = seam('win32', [
      'C:/repo/runtime/packages/engine/package.json',
      'C:/repo/skills/monitoring-claude-sessions/SKILL.md',
    ]);
    const expected = {
      launcherPath: 'C:\\repo\\skills\\monitoring-claude-sessions\\scripts\\mcs.mjs',
      skillDir: 'C:\\repo\\skills\\monitoring-claude-sessions',
      runtimeDir: 'C:\\repo\\runtime',
    };
    expect(mainPathsOf('file:///C:/repo/runtime/packages/cli/src/main.ts', fs)).toEqual(expected);
    expect(mainPathsOf('file:///C:/repo/runtime/packages/cli/dist/main.js', fs)).toEqual(expected);
  });

  it('finds the bundle folder of an installed skill (POSIX)', () => {
    const fs = seam('linux', ['/opt/claude/skills/monitoring-claude-sessions/bundle/mcs-server.mjs']);
    expect(mainPathsOf('file:///opt/claude/skills/monitoring-claude-sessions/bundle/mcs-cli.mjs', fs)).toEqual({
      launcherPath: '/opt/claude/skills/monitoring-claude-sessions/scripts/mcs.mjs',
      skillDir: '/opt/claude/skills/monitoring-claude-sessions',
      runtimeDir: '/opt/claude/skills/monitoring-claude-sessions/bundle',
    });
  });

  it('decodes spaces and percent-escapes of a file URL (plugin cache path, Windows drive)', () => {
    const fs = seam('win32', ['D:/Plugin Cache/a%23b/monitoring-claude-sessions/bundle/mcs-server.mjs']);
    const paths = mainPathsOf('file:///D:/Plugin%20Cache/a%2523b/monitoring-claude-sessions/bundle/mcs-cli.mjs', fs);
    expect(paths.runtimeDir).toBe('D:\\Plugin Cache\\a%23b\\monitoring-claude-sessions\\bundle');
    expect(paths.skillDir).toBe('D:\\Plugin Cache\\a%23b\\monitoring-claude-sessions');
  });

  it('throws INTERNAL with a hint for a module outside any layout', () => {
    expect(() => mainPathsOf('file:///tmp/elsewhere/main.js', seam('linux', []))).toThrow(/no runtime layout/);
  });
});

/** A bundle-shaped runtime folder: the server entry marker and a deterministic stamp, no `scripts/build-stamp.mjs`. */
function bundleDir(): string {
  const dir = path.join(tempDir('paths-bundle').path, 'skill', 'bundle');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'mcs-server.mjs'), '');
  writeFileSync(path.join(dir, '.mcs-build.json'), JSON.stringify({ schemaVersion: 1, codeStamp: '0123456789' }));
  return dir;
}

/** A source-shaped runtime folder whose `scripts/build-stamp.mjs` answers the given staleness. */
function sourceDir(state: { install: boolean; build: boolean }): string {
  const dir = path.join(tempDir('paths-source').path, 'runtime');
  mkdirSync(path.join(dir, 'packages', 'server'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'scripts', 'build-stamp.mjs'),
    `export function staleness() { return ${JSON.stringify(state)}; }\n`,
  );
  writeFileSync(path.join(dir, '.mcs-build.json'), JSON.stringify({ codeStamp: 'abcdefabcd' }));
  return dir;
}

describe('build info', () => {
  it('is current and reads codeStamp in the bundle layout, without build-stamp.mjs', async () => {
    const dir = bundleDir();
    expect(await buildState(dir)).toBe('current');
    expect(await buildInfoOf(dir)).toEqual({ code: '0123456789', build: 'current' });
  });

  it('uses scripts/build-stamp.mjs in the source layout', async () => {
    expect(await buildState(sourceDir({ install: false, build: false }))).toBe('current');
    expect(await buildState(sourceDir({ install: false, build: true }))).toBe('stale');
    expect(await buildInfoOf(sourceDir({ install: true, build: false }))).toEqual({
      code: 'abcdefabcd',
      build: 'stale',
    });
  });

  it('a missing stamp is an error', async () => {
    const dir = path.join(tempDir('paths-empty').path, 'bundle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'mcs-server.mjs'), '');
    await expect(codeStampOf(dir)).rejects.toThrow();
  });
});
