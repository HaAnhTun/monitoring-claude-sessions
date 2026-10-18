import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { McsError } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { HostPlatform } from './host.ts';
import {
  BUNDLE_SERVER_FILE,
  SKILL_FOLDER_NAME,
  layoutOfModule,
  layoutOfRuntimeDir,
  type LayoutFs,
  type RuntimeLayout,
} from './layout.ts';

const makeTemp = useTempDirs();

function touch(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}

/** `<root>/skill/{SKILL.md, bundle/{mcs-server.mjs, mcs-cli.mjs, mcs-hook.mjs, migrations/}}`. */
function bundleTree(sub = 'plain'): { skillDir: string; bundle: string } {
  const skillDir = path.join(makeTemp('layout').path, sub, SKILL_FOLDER_NAME);
  const bundle = path.join(skillDir, 'bundle');
  for (const file of ['mcs-server.mjs', 'mcs-cli.mjs', 'mcs-hook.mjs', path.join('migrations', '0001_init.sql')]) {
    touch(path.join(bundle, file));
  }
  touch(path.join(skillDir, 'SKILL.md'));
  return { skillDir, bundle };
}

/** `<repo>/{runtime/packages/{engine/package.json, engine/src/db/x.ts, engine/dist/db/x.js}, skills/<name>/SKILL.md}`. */
function sourceTree(): { repo: string; runtime: string; skillDir: string } {
  const repo = makeTemp('source').path;
  const runtime = path.join(repo, 'runtime');
  touch(path.join(runtime, 'packages', 'engine', 'package.json'));
  touch(path.join(runtime, 'packages', 'engine', 'src', 'db', 'migrations.ts'));
  touch(path.join(runtime, 'packages', 'engine', 'dist', 'db', 'migrations.js'));
  const skillDir = path.join(repo, 'skills', SKILL_FOLDER_NAME);
  touch(path.join(skillDir, 'SKILL.md'));
  return { repo, runtime, skillDir };
}

function bundleFields(skillDir: string, runtimeDir: string, p: path.PlatformPath = path): RuntimeLayout {
  return {
    mode: 'bundle',
    skillDir,
    runtimeDir,
    launcherPath: p.join(skillDir, 'scripts', 'mcs.mjs'),
    serverEntry: p.join(runtimeDir, 'mcs-server.mjs'),
    hookEntry: p.join(runtimeDir, 'mcs-hook.mjs'),
    webDir: p.join(runtimeDir, 'web'),
    migrationsDir: p.join(runtimeDir, 'migrations'),
    stampFile: p.join(runtimeDir, '.mcs-build.json'),
  };
}

function sourceFields(skillDir: string, runtimeDir: string, p: path.PlatformPath = path): RuntimeLayout {
  return {
    mode: 'source',
    skillDir,
    runtimeDir,
    launcherPath: p.join(skillDir, 'scripts', 'mcs.mjs'),
    serverEntry: p.join(runtimeDir, 'packages', 'server', 'dist', 'main.js'),
    hookEntry: p.join(runtimeDir, 'packages', 'cli', 'dist', 'hook.js'),
    webDir: p.join(runtimeDir, 'packages', 'web', 'dist'),
    migrationsDir: p.join(runtimeDir, 'packages', 'engine', 'migrations'),
    stampFile: p.join(runtimeDir, '.mcs-build.json'),
  };
}

/** A scripted file system: exactly these paths exist. */
function scripted(platform: HostPlatform, files: readonly string[]): LayoutFs {
  const set = new Set(files);
  return { platform, exists: (file) => set.has(file) };
}

describe('layoutOfRuntimeDir', () => {
  it('a bundle folder (it holds mcs-server.mjs) is the bundle layout, every field', () => {
    const { skillDir, bundle } = bundleTree();
    expect(layoutOfRuntimeDir(bundle)).toEqual(bundleFields(skillDir, bundle));
  });

  it('the runtime workspace of a checkout is the source layout with the skill folder next to it', () => {
    const { runtime, skillDir } = sourceTree();
    expect(layoutOfRuntimeDir(runtime)).toEqual(sourceFields(skillDir, runtime));
  });

  it('a source fixture laid out as <skill>/runtime uses the parent as the skill folder', () => {
    const skill = makeTemp('fixture').path;
    const runtime = path.join(skill, 'runtime');
    mkdirSync(path.join(runtime, 'packages', 'server', 'dist'), { recursive: true });
    expect(layoutOfRuntimeDir(runtime)).toEqual(sourceFields(skill, runtime));
  });

  it('a bundle folder without its server entry is still the bundle layout', () => {
    const { skillDir, bundle } = bundleTree();
    const fs: LayoutFs = { exists: (file) => !file.endsWith(BUNDLE_SERVER_FILE) && existsSync(file) };
    expect(layoutOfRuntimeDir(bundle, fs).mode).toBe('bundle');
    expect(layoutOfRuntimeDir(bundle, fs).skillDir).toBe(skillDir);
  });

  it('a path with spaces and non-ASCII characters', () => {
    const { skillDir, bundle } = bundleTree('sp ace ñ 日本');
    expect(layoutOfRuntimeDir(bundle)).toEqual(bundleFields(skillDir, bundle));
  });

  it('a Windows drive path uses the win32 path module on any host', () => {
    const skill = 'C:\\Program Files\\plugins\\cache\\session-monitor\\4.0.0\\skills\\monitoring-claude-sessions';
    const bundle = `${skill}\\bundle`;
    const fs = scripted('win32', [`${bundle}\\mcs-server.mjs`]);
    expect(layoutOfRuntimeDir(bundle, fs)).toEqual(bundleFields(skill, bundle, path.win32));
    const repo = 'D:\\work\\repo';
    const src = scripted('win32', [
      `${repo}\\runtime\\packages\\engine\\package.json`,
      `${repo}\\skills\\${SKILL_FOLDER_NAME}\\SKILL.md`,
    ]);
    expect(layoutOfRuntimeDir(`${repo}\\runtime`, src)).toEqual(
      sourceFields(`${repo}\\skills\\${SKILL_FOLDER_NAME}`, `${repo}\\runtime`, path.win32),
    );
  });

  it('a POSIX path uses the POSIX path module on any host', () => {
    const skill = '/opt/claude/skills/monitoring-claude-sessions';
    const fs = scripted('linux', [`${skill}/bundle/mcs-server.mjs`]);
    expect(layoutOfRuntimeDir(`${skill}/bundle`, fs)).toEqual(bundleFields(skill, `${skill}/bundle`, path.posix));
    const src = scripted('darwin', ['/src/repo/runtime/packages/engine/package.json']);
    expect(layoutOfRuntimeDir('/src/repo/runtime', src)).toEqual(
      sourceFields('/src/repo', '/src/repo/runtime', path.posix),
    );
  });

  it('an unknown tree is INTERNAL with a hint', () => {
    const empty = makeTemp('empty').path;
    let caught: unknown;
    try {
      layoutOfRuntimeDir(empty);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McsError);
    expect((caught as McsError).code).toBe('INTERNAL');
    expect((caught as McsError).hint).toContain('reinstall');
  });
});

describe('layoutOfModule', () => {
  it('a bundle module (next to mcs-server.mjs) is the bundle layout', () => {
    const { skillDir, bundle } = bundleTree();
    const url = pathToFileURL(path.join(bundle, 'mcs-cli.mjs')).href;
    expect(layoutOfModule(url)).toEqual(bundleFields(skillDir, bundle));
  });

  it('a source module is found from src and from dist', () => {
    const { runtime, skillDir } = sourceTree();
    const fromSrc = pathToFileURL(path.join(runtime, 'packages', 'engine', 'src', 'db', 'migrations.ts'));
    const fromDist = pathToFileURL(path.join(runtime, 'packages', 'engine', 'dist', 'db', 'migrations.js')).href;
    expect(layoutOfModule(fromSrc)).toEqual(sourceFields(skillDir, runtime));
    expect(layoutOfModule(fromDist)).toEqual(sourceFields(skillDir, runtime));
  });

  it('this very module resolves to the source layout of this checkout', () => {
    const layout = layoutOfModule(import.meta.url);
    expect(layout.mode).toBe('source');
    expect(layout.serverEntry).toBe(path.join(layout.runtimeDir, 'packages', 'server', 'dist', 'main.js'));
  });

  it('Windows and POSIX module URLs follow the platform data, not the host', () => {
    const win = scripted('win32', ['C:\\a b\\ñ\\bundle\\mcs-server.mjs']);
    expect(layoutOfModule('file:///C:/a%20b/%C3%B1/bundle/mcs-cli.mjs', win)).toEqual(
      bundleFields('C:\\a b\\ñ', 'C:\\a b\\ñ\\bundle', path.win32),
    );
    const posix = scripted('linux', ['/r/runtime/packages/engine/package.json']);
    expect(layoutOfModule('file:///r/runtime/packages/cli/dist/main.js', posix)).toEqual(
      sourceFields('/r', '/r/runtime', path.posix),
    );
  });

  it('an unknown tree and a non-file URL are INTERNAL with a hint', () => {
    const lone = path.join(makeTemp('lone').path, 'x.mjs');
    expect(() => layoutOfModule(pathToFileURL(lone))).toThrow(McsError);
    for (const url of [pathToFileURL(lone).href, 'https://example.invalid/x.mjs']) {
      let caught: unknown;
      try {
        layoutOfModule(url);
      } catch (error) {
        caught = error;
      }
      expect((caught as McsError).code).toBe('INTERNAL');
      expect((caught as McsError).hint).toBeDefined();
    }
  });
});
