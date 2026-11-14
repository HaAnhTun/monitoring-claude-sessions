// The root installer `install.mjs` (ADR 0061 item 7, WP-89): fresh install with identical bytes and a working launcher, the
// refusals (existing install, checkout-like folders, links, files, roots, a project whose skill path is a link to the checkout),
// `--force` through a temp sibling with the backup restored on a failed copy or a failed self-check, `--dry-run`, `--uninstall`.
// Every run uses temp destinations and a temp HOME / USERPROFILE / CLAUDE_CONFIG_DIR; the real home is never used. Most runs use a
// fake checkout (a copy of `install.mjs` next to a tiny skill folder with a fake launcher) built like the owner's setup.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

import { hermeticEnv, makeJunction, snapshotTree } from '@mcs/testkit';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const INSTALLER = join(REPO, 'install.mjs');
const NAME = 'monitoring-claude-sessions';

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A fresh temp folder by its real path, with a space in its name. */
function tempRoot(label: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `mcs install ${label}-`)));
  temps.push(dir);
  return dir;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const SKILL_MD = `---\nname: ${NAME}\ndescription: Synthetic test skill.\n---\n\n# Test\n`;

function launcherSource(code: number, version: string): string {
  return code === 0
    ? `process.stdout.write('mcs ${version}\\n');\n`
    : `process.stderr.write('ERROR: broken launcher\\n');\nprocess.exitCode = ${String(code)};\n`;
}

/** A fake checkout like the owner's: `.git`, `runtime/package.json`, `.claude-plugin/`, `install.mjs` and the skill folder. */
function fakeCheckout(root: string, opts: { launcherCode?: number; version?: string } = {}): string {
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  write(join(checkout, 'runtime', 'package.json'), '{ "name": "fake", "version": "0.0.0" }\n');
  write(join(checkout, '.claude-plugin', 'plugin.json'), '{ "name": "fake" }\n');
  copyFileSync(INSTALLER, join(checkout, 'install.mjs'));
  const skill = join(checkout, 'skills', NAME);
  write(join(skill, 'SKILL.md'), SKILL_MD);
  write(join(skill, 'scripts', 'caw.mjs'), launcherSource(opts.launcherCode ?? 0, opts.version ?? '9.9.9-test'));
  write(join(skill, 'bundle', '.mcs-build.json'), `{ "runtimeVersion": "${opts.version ?? '9.9.9-test'}" }\n`);
  write(join(skill, 'reference', 'notes with space.md'), 'Synthetic test data. Not real data.\n');
  write(join(skill, 'bundle', 'web', 'a.js'), 'export const a = 1;\n');
  return checkout;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(installer: string, args: readonly string[], env: Record<string, string>, cwd?: string): Run {
  const r = spawnSync(process.execPath, [installer, ...args], {
    cwd: cwd ?? dirname(installer),
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A temp root with a fake checkout and a hermetic environment. */
function setup(label: string, opts: { launcherCode?: number; version?: string } = {}) {
  const root = tempRoot(label);
  const checkout = fakeCheckout(root, opts);
  const env = hermeticEnv(join(root, 'state'));
  const installer = join(checkout, 'install.mjs');
  const skills = join(root, 'dest skills');
  return { root, checkout, env, installer, skills, target: join(skills, NAME), source: join(checkout, 'skills', NAME) };
}

/** Relative path -> bytes (base64) of every file below `dir`. */
function filesOf(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, filesOf(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name)).toString('base64');
  }
  return out;
}

function siblingsOf(skills: string): string[] {
  return readdirSync(skills).sort();
}

describe('install.mjs: install', () => {
  it('copies the real skill folder byte for byte and the copy answers --version', () => {
    const root = tempRoot('real');
    const env = hermeticEnv(join(root, 'state'));
    const skills = join(root, 'my skills');
    const r = run(INSTALLER, ['--dest', skills], env, root);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const target = join(skills, NAME);
    const source = join(REPO, 'skills', NAME);
    const copied = filesOf(target);
    const marker = JSON.parse(Buffer.from(copied['.mcs-installed.json'] ?? '', 'base64').toString('utf8')) as {
      files: string[];
      version: string;
      installedAt: string;
    };
    delete copied['.mcs-installed.json'];
    expect(copied).toEqual(filesOf(source));
    expect([...marker.files].sort()).toEqual(Object.keys(copied).sort());
    expect(marker.installedAt).toMatch(/Z$/);
    // the self-check runs the canonical launcher; the alias next to it answers the same
    for (const file of ['caw.mjs', 'mcs.mjs']) {
      const version = spawnSync(process.execPath, [join(target, 'scripts', file), '--version'], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(version.status, file).toBe(0);
      expect(version.stdout.trim(), file).toBe(`mcs ${marker.version}`);
    }
    expect(siblingsOf(skills)).toEqual([NAME]);
    // nothing outside the destination: the temp state folders stay empty or absent
    expect(existsSync(join(root, 'state', 'claude-home'))).toBe(false);
  }, 60_000);

  it('uses CLAUDE_CONFIG_DIR, then the home folder, as the default destination', () => {
    const s = setup('default');
    const r = run(s.installer, [], s.env);
    expect(r.code).toBe(0);
    expect(existsSync(join(s.env['CLAUDE_CONFIG_DIR'] ?? '', 'skills', NAME, '.mcs-installed.json'))).toBe(true);
    const env = { ...s.env };
    delete env['CLAUDE_CONFIG_DIR'];
    const r2 = run(s.installer, [], env);
    expect(r2.code).toBe(0);
    expect(existsSync(join(env['USERPROFILE'] ?? '', '.claude', 'skills', NAME, 'SKILL.md'))).toBe(true);
  });

  it('refuses a second run without --force and changes nothing', () => {
    const s = setup('twice');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    const before = snapshotTree(s.skills);
    const r = run(s.installer, ['--dest', s.skills], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--force');
    expect(snapshotTree(s.skills)).toEqual(before);
  });

  it('--force replaces the copy through a temp sibling and removes the backup', () => {
    const s = setup('force');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    write(join(s.source, 'reference', 'notes with space.md'), 'Changed synthetic text.\n');
    const r = run(s.installer, ['--dest', s.skills, '--force'], s.env);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(s.target, 'reference', 'notes with space.md'), 'utf8')).toBe('Changed synthetic text.\n');
    expect(siblingsOf(s.skills)).toEqual([NAME]);
  });

  it('--force keeps the old copy when the copy fails midway', () => {
    const s = setup('midway');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    const before = snapshotTree(s.skills);
    // a link inside the source stops the copy after the files sorted before it were copied
    const elsewhere = join(s.root, 'elsewhere');
    mkdirSync(elsewhere);
    makeJunction(join(s.source, 'reference', 'zz-link'), elsewhere);
    const r = run(s.installer, ['--dest', s.skills, '--force'], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('copy failed');
    expect(snapshotTree(s.skills)).toEqual(before);
  });

  it('--force renames the old copy back when the self-check of the new one fails', () => {
    const s = setup('selfcheck');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    const before = snapshotTree(s.skills);
    write(join(s.source, 'scripts', 'caw.mjs'), launcherSource(1, 'x'));
    const r = run(s.installer, ['--dest', s.skills, '--force'], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('self-check');
    expect(snapshotTree(s.skills)).toEqual(before);
  });

  it('installs nothing when the self-check of a fresh copy fails', () => {
    const s = setup('fresh-fail', { launcherCode: 1 });
    const r = run(s.installer, ['--dest', s.skills], s.env);
    expect(r.code).toBe(1);
    expect(siblingsOf(s.skills)).toEqual([]);
  });

  it('runs the self-check through caw.mjs and never through the alias mcs.mjs next to it', () => {
    const s = setup('selfcheck-alias');
    write(join(s.source, 'scripts', 'mcs.mjs'), launcherSource(1, 'broken alias'));
    const r = run(s.installer, ['--dest', s.skills], s.env);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('9.9.9-test');
    expect(siblingsOf(s.skills)).toEqual([NAME]);
  });

  it('--dry-run prints the real paths and every decision and writes nothing', () => {
    const s = setup('dry');
    const r = run(s.installer, ['--dest', s.skills, '--dry-run'], s.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(realpathSync.native(s.source));
    expect(r.stdout).toContain(s.target);
    expect(r.stdout).toContain('decision:');
    expect(existsSync(s.skills)).toBe(false);
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    const before = snapshotTree(s.skills);
    const r2 = run(s.installer, ['--dest', s.skills, '--force', '--dry-run'], s.env);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('.bak-');
    expect(snapshotTree(s.skills)).toEqual(before);
  });
});

describe('install.mjs: refusals', () => {
  it('refuses a destination inside the source folder or the checkout, also relative', () => {
    const s = setup('inside');
    const before = snapshotTree(s.checkout);
    for (const args of [
      ['--dest', join(s.source, 'reference')],
      ['--dest', join(s.checkout, 'skills')],
      ['--dest', s.checkout],
    ]) {
      const r = run(s.installer, args, s.env);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/source (checkout|folder)/);
    }
    expect(run(s.installer, ['--dest', '.'], s.env, s.source).code).toBe(1);
    expect(run(s.installer, ['--dest', join('..', '..')], s.env, join(s.source, 'scripts')).code).toBe(1);
    expect(snapshotTree(s.checkout)).toEqual(before);
  });

  it('refuses a project whose skill path is a link to the checkout, even with --force or --uninstall', () => {
    const s = setup('project-link');
    const project = join(s.root, 'project');
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true });
    makeJunction(join(project, '.claude', 'skills', NAME), s.checkout);
    const before = snapshotTree(s.checkout);
    for (const extra of [[], ['--force'], ['--uninstall'], ['--dry-run']]) {
      const r = run(s.installer, ['--project', project, ...extra], s.env);
      expect(r.code, extra.join(' ')).toBe(1);
      expect(r.stderr).toContain('resolves to the source checkout');
    }
    expect(snapshotTree(s.checkout)).toEqual(before);
    expect(existsSync(join(s.checkout, 'install.mjs'))).toBe(true);
  });

  it('refuses a destination that is a file or a link to another folder', () => {
    const s = setup('file-link');
    write(s.target, 'a file\n');
    for (const extra of [[], ['--force'], ['--uninstall']]) {
      const r = run(s.installer, ['--dest', s.skills, ...extra], s.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not a folder');
    }
    rmSync(s.target);
    const other = join(s.root, 'other');
    write(join(other, 'keep.txt'), 'keep\n');
    write(join(other, '.mcs-installed.json'), '{}\n');
    write(join(other, 'SKILL.md'), SKILL_MD);
    makeJunction(s.target, other);
    for (const extra of [['--force'], ['--uninstall']]) {
      const r = run(s.installer, ['--dest', s.skills, ...extra], s.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('is a link');
    }
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses a source whose scripts folder holds only the legacy alias mcs.mjs and no caw.mjs', () => {
    const s = setup('no-caw');
    rmSync(join(s.source, 'scripts', 'caw.mjs'));
    write(join(s.source, 'scripts', 'mcs.mjs'), launcherSource(0, '9.9.9-test'));
    const r = run(s.installer, ['--dest', s.skills], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no skill folder next to install.mjs');
    expect(existsSync(s.skills)).toBe(false);
  });

  it('refuses a filesystem root as the destination folder', () => {
    const s = setup('root');
    const r = run(s.installer, ['--dest', parse(s.root).root, '--dry-run'], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('filesystem root');
  });

  it('refuses --force and --uninstall on a folder without the marker', () => {
    const s = setup('no-marker');
    write(join(s.target, 'SKILL.md'), SKILL_MD);
    write(join(s.target, 'own.txt'), 'not ours\n');
    const before = snapshotTree(s.skills);
    for (const extra of [['--force'], ['--uninstall']]) {
      const r = run(s.installer, ['--dest', s.skills, ...extra], s.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('.mcs-installed.json');
    }
    expect(snapshotTree(s.skills)).toEqual(before);
  });

  it('refuses --force and --uninstall on a marked folder that looks like a checkout', () => {
    for (const sign of ['.git', 'runtime/package.json', '.claude-plugin']) {
      const s = setup(`sign-${sign.replace(/[./]/g, '_')}`);
      write(join(s.target, 'SKILL.md'), SKILL_MD);
      write(join(s.target, '.mcs-installed.json'), '{}\n');
      if (sign === 'runtime/package.json') write(join(s.target, sign), '{}\n');
      else mkdirSync(join(s.target, sign));
      for (const extra of [['--force'], ['--uninstall']]) {
        const r = run(s.installer, ['--dest', s.skills, ...extra], s.env);
        expect(r.code, `${sign} ${extra.join(' ')}`).toBe(1);
        expect(r.stderr).toContain('looks like a checkout');
      }
      expect(existsSync(join(s.target, sign))).toBe(true);
    }
  });

  it('exits 2 on a usage error', () => {
    const s = setup('usage');
    for (const args of [['--bogus'], ['--dest'], ['--dest', 'a', '--project', 'b'], ['--force', '--uninstall']]) {
      const r = run(s.installer, args, s.env);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('usage:');
    }
  });
});

describe('install.mjs: uninstall', () => {
  it('removes an install made by the script and nothing else', () => {
    const s = setup('uninstall');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    write(join(s.skills, 'other-skill', 'SKILL.md'), '---\nname: other\n---\n');
    const dry = run(s.installer, ['--dest', s.skills, '--uninstall', '--dry-run'], s.env);
    expect(dry.code).toBe(0);
    expect(existsSync(s.target)).toBe(true);
    const r = run(s.installer, ['--dest', s.skills, '--uninstall'], s.env);
    expect(r.code).toBe(0);
    expect(siblingsOf(s.skills)).toEqual(['other-skill']);
    expect(run(s.installer, ['--dest', s.skills, '--uninstall'], s.env).code).toBe(1);
  });

  it('refuses a marked folder whose SKILL.md is not this skill', () => {
    const s = setup('uninstall-name');
    write(join(s.target, 'SKILL.md'), '---\nname: something-else\n---\n');
    write(join(s.target, '.mcs-installed.json'), '{}\n');
    const r = run(s.installer, ['--dest', s.skills, '--uninstall'], s.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('SKILL.md');
    expect(existsSync(join(s.target, 'SKILL.md'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('removes a read-only file of an installed copy', () => {
    const s = setup('readonly');
    expect(run(s.installer, ['--dest', s.skills], s.env).code).toBe(0);
    chmodSync(join(s.target, 'SKILL.md'), 0o444);
    expect(run(s.installer, ['--dest', s.skills, '--uninstall'], s.env).code).toBe(0);
    expect(existsSync(s.target)).toBe(false);
  });
});

describe('install.mjs: static', () => {
  it('imports only node:* modules', () => {
    const text = readFileSync(INSTALLER, 'utf8');
    const specifiers = [...text.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith('node:'))).toEqual([]);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/\brequire\(/);
  });
});
