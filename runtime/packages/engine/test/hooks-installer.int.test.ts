// The hooks installer against the real file system, a real bundle and real processes (T-IN-05, T-IN-07, T-IN-09, ADR 0070):
// the stable copy is a byte copy of a freshly built `mcs-hook.mjs` that runs on its own; a plugin update refreshes the copy and
// leaves the settings alone; two processes installing into one settings file serialize; a child process in test mode refuses a
// settings file outside its temporary folder; a program that holds the settings file open makes the replace fail cleanly.
// Everything happens in temporary folders with decoy settings files next to the real work; no real path is read or written.
// The children import the built `dist`, so the integration gate builds the runtime first.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HANDLER_VERSION, INSTALLED_HOOK_EVENTS, normalizePath } from '@mcs/shared/protocol';
import {
  FILE_HOLDER_SKIP_REASON,
  hermeticEnv,
  holdFileOpen,
  killAllTracked,
  spawnTracked,
  useTempDirs,
} from '@mcs/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';
import { makeHarness, treeOf, type Harness } from './fixtures/settings/harness.ts';
import { installsOf, readManifest } from '../src/hooks/installer/manifest.ts';
import { settingsPathFor } from '../src/hooks/installer/settings-io.ts';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const SettingsFile = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.looseObject({ hooks: z.array(z.looseObject({ args: z.array(z.string()).optional() })) })),
  ),
});
const runtimeDir = fileURLToPath(new URL('../../../', import.meta.url));
const dist = (...parts: string[]): string => path.join(runtimeDir, 'packages', 'engine', 'dist', ...parts);

let buildRoot = '';
let builtHook = '';

beforeAll(async () => {
  // one fresh bundle of the hook handler, shared by every test (never the tracked bundle)
  buildRoot = mkdtempSync(path.join(tmpdir(), 'mcs-hooks-installer-'));
  const outDir = path.join(buildRoot, 'bundle');
  await buildBundle({ outDir, entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' }, web: false });
  builtHook = path.join(outDir, 'mcs-hook.mjs');
}, 120_000);

afterAll(() => {
  if (buildRoot !== '') rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(async () => {
  await killAllTracked();
});

const ORIGINAL = `${JSON.stringify(
  {
    theme: 'dark',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE user hook' }] }] },
    env: { FIXTURE_NAME: 'FIXTURE value' },
  },
  null,
  2,
)}\n`;

function world(): Harness {
  const h = makeHarness(makeTemp);
  writeFileSync(h.source, readFileSync(builtHook));
  return h;
}

function builtUrl(file: string): string {
  if (!existsSync(file)) throw new Error(`${file} is missing: run the integration gate (it builds first)`);
  return pathToFileURL(file).href;
}

describe('the stable copy of a real hook bundle', () => {
  it('is a byte copy that runs on its own, survives a plugin update and goes with the last uninstall', async () => {
    const h = world();
    h.writeSettings(ORIGINAL);
    const before = treeOf(h.root);

    const dry = await h.install({ yes: false });
    expect(dry.result.action).toBe('plan');
    expect(dry.result.script.action).toBe('created');
    expect(treeOf(h.root)).toEqual(before);

    const { result } = await h.install();
    expect(result.action).toBe('applied');
    const copy = path.join(h.mcsHome, 'hooks', 'mcs-hook.mjs');
    expect(readFileSync(copy).equals(readFileSync(builtHook))).toBe(true);

    // every entry runs the stable copy with the Node that installed, and nothing names the folder of the bundle
    const text = h.settings();
    expect(text).not.toContain(normalizePath(path.dirname(h.source)));
    expect(text).toContain(normalizePath(copy));
    expect((text.match(/--mcs-hook/g) ?? []).length).toBe(INSTALLED_HOOK_EVENTS.length);

    // the copy is the whole handler: no sibling file is needed
    const env = { ...hermeticEnv(h.root), MCS_HOME: h.mcsHome, MCS_HOOK_DISABLE: '0' };
    const version = spawnSync(process.execPath, ['--no-warnings', copy, '--version'], { env, encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(`${HANDLER_VERSION}\n`);
    const hook = spawnSync(process.execPath, ['--no-warnings', copy, '--mcs-hook', 'SessionStart'], {
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000000', hook_event_name: 'SessionStart' }),
    });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toBe('');

    // a plugin update changes the bundled file: settings stay, the copy is refreshed
    const settingsBefore = h.settings();
    appendFileSync(h.source, '\n// FIXTURE plugin update\n');
    const update = await h.install();
    expect(update.result.action).toBe('noop');
    expect(update.result.script.action).toBe('refreshed');
    expect(h.settings()).toBe(settingsBefore);
    expect(readFileSync(copy).equals(readFileSync(h.source))).toBe(true);
    expect(installsOf((await readManifest(h.mcsHome)).manifest)).toHaveLength(1);

    // the last uninstall gives the settings back as they were and removes the copy
    const gone = await h.uninstall();
    expect(gone.result.script.action).toBe('removed');
    expect(h.settings()).toBe(ORIGINAL);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(path.join(h.mcsHome, 'hooks'))).toBe(false);
  });

  it('refuses the checkout layout: the copy of dist/hook.js would not run, and nothing is written', async () => {
    const h = world();
    const hookJs = path.join(runtimeDir, 'packages', 'cli', 'dist', 'hook.js');
    const before = treeOf(h.root);
    // dist/hook.js (a build output of this checkout) imports sibling modules; it is only named here, never copied
    await expect(h.install({ source: hookJs })).rejects.toMatchObject({
      code: 'HOOKS_FAILED',
      details: { reason: 'HOOK_BUNDLE_MISSING' },
    });
    expect(treeOf(h.root)).toEqual(before);
  });
});

describe('T-IN-07 decoys: the installer works on its own files only', () => {
  it('leaves decoy settings files of the home, the config folder and a repository byte for byte as they are', async () => {
    const h = world();
    const canary = '{"FIXTURE_CANARY":"do not touch"}\n';
    const decoys = [
      path.join(h.root, 'home', '.claude', 'settings.json'),
      path.join(h.root, 'home', '.claude', 'settings.local.json'),
      path.join(h.root, 'repo', '.claude', 'settings.json'),
      path.join(h.root, 'repo', '.claude', 'settings.local.json'),
      path.join(h.claudeHome, 'settings.local.json'),
    ];
    for (const decoy of decoys) {
      mkdirSync(path.dirname(decoy), { recursive: true });
      writeFileSync(decoy, canary);
    }
    const hashes = treeOf(path.join(h.root, 'home'));
    const repo = treeOf(path.join(h.root, 'repo'));

    // the user scope resolves to the config folder of the environment (the decoy home), never to the real one
    const user = settingsPathFor('user', { env: h.env });
    expect(user).toBe(path.join(h.claudeHome, 'settings.json'));
    await h.install({ scope: 'user', settingsPath: user });
    await h.install({
      scope: 'file',
      settingsPath: path.join(h.root, 'repo', '.claude', 'settings.local.json'),
      yes: false,
    });
    await h.uninstall({ scope: 'user', settingsPath: user });

    expect(treeOf(path.join(h.root, 'home'))).toEqual(hashes);
    expect(treeOf(path.join(h.root, 'repo'))).toEqual(repo);
    for (const decoy of decoys) expect(readFileSync(decoy, 'utf8')).toBe(canary);
  });
});

// A child process in test mode, started by the testkit (`hermeticEnv` sets MCS_TEST=1), with a narrowed temporary folder.
const CHILD = `
import { writeFileSync } from 'node:fs';
const [applyUrl, source, settingsPath, mcsHome, startAt, resultFile] = process.argv.slice(2);
const { applyHooks } = await import(applyUrl);
let out;
try {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < Number(startAt)) Atomics.wait(wait, 0, 0, 1);
  const { result } = await applyHooks({
    scope: 'file', settingsPath, mcsHome, env: process.env, yes: true, source, nodePath: process.execPath,
  });
  out = { ok: true, action: result.action, script: result.script.action };
} catch (error) {
  out = { ok: false, code: error.code, reason: error.details?.reason, message: error.message };
}
writeFileSync(resultFile, JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
`;

interface ChildResult {
  ok: boolean;
  action?: string;
  script?: string;
  code?: string;
  reason?: string;
  message?: string;
}

function runChild(
  scratch: string,
  env: Record<string, string>,
  args: { source: string; settingsPath: string; mcsHome: string; startAt: number; name: string },
): { exited: Promise<number | null>; result: () => ChildResult } {
  const script = path.join(scratch, 'child.mjs');
  if (!existsSync(script)) writeFileSync(script, CHILD);
  const resultFile = path.join(scratch, `result-${args.name}.json`);
  const child = spawnTracked(
    process.execPath,
    [
      script,
      builtUrl(dist('hooks', 'installer', 'apply.js')),
      args.source,
      args.settingsPath,
      args.mcsHome,
      String(args.startAt),
      resultFile,
    ],
    { env },
  );
  return { exited: child.exited, result: () => JSON.parse(readFileSync(resultFile, 'utf8')) as ChildResult };
}

describe('T-IN-07 in a real process: the guard compares with the temporary folder of that process', () => {
  it('refuses a settings file outside the narrowed temporary folder and accepts one inside it', async () => {
    const root = makeTemp('hooks-guard').path;
    const narrow = path.join(root, 'tmp');
    const outside = path.join(root, 'outside');
    mkdirSync(narrow);
    mkdirSync(outside);
    // the decoy sits in a sibling folder: inside the test root, not inside the child's temporary folder
    const decoy = path.join(outside, 'settings.json');
    const sibling = path.join(outside, 'canary.txt');
    writeFileSync(decoy, '{"FIXTURE_CANARY":"decoy"}\n');
    writeFileSync(sibling, 'FIXTURE canary');
    const source = path.join(narrow, 'bundle', 'mcs-hook.mjs');
    mkdirSync(path.dirname(source));
    writeFileSync(source, readFileSync(builtHook));
    const env = {
      ...hermeticEnv(root),
      TMPDIR: narrow,
      TEMP: narrow,
      TMP: narrow,
      MCS_HOME: path.join(narrow, 'mcs-home'),
    };
    const startAt = Date.now();

    const refused = runChild(root, env, {
      source,
      settingsPath: decoy,
      mcsHome: env.MCS_HOME,
      startAt,
      name: 'refused',
    });
    expect(await refused.exited).toBe(1);
    expect(refused.result()).toMatchObject({ ok: false, code: 'HOOKS_FAILED', reason: 'REAL_SETTINGS_IN_TEST' });
    expect(readFileSync(decoy, 'utf8')).toBe('{"FIXTURE_CANARY":"decoy"}\n');
    expect(readFileSync(sibling, 'utf8')).toBe('FIXTURE canary');
    expect(existsSync(env.MCS_HOME)).toBe(false);

    // the positive control: the same child, the same home, a file inside its temporary folder
    const inside = path.join(narrow, 'settings.json');
    const accepted = runChild(root, env, {
      source,
      settingsPath: inside,
      mcsHome: env.MCS_HOME,
      startAt,
      name: 'accepted',
    });
    expect(await accepted.exited).toBe(0);
    expect(accepted.result()).toMatchObject({ ok: true, action: 'applied', script: 'created' });
    expect(Object.keys(SettingsFile.parse(JSON.parse(readFileSync(inside, 'utf8'))).hooks)).toHaveLength(
      INSTALLED_HOOK_EVENTS.length,
    );
  }, 60_000);
});

describe('two processes installing into one settings file serialize through the mutex', () => {
  it('both succeed, one applies and one finds the work done, and the file ends valid with one entry per event', async () => {
    const h = world();
    h.writeSettings(ORIGINAL);
    const scratch = makeTemp('hooks-two').path;
    const env = { ...hermeticEnv(h.root), TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir() };
    const startAt = Date.now() + 3000;
    const args = { source: h.source, settingsPath: h.settingsPath, mcsHome: h.mcsHome, startAt };
    const a = runChild(scratch, env, { ...args, name: 'a' });
    const b = runChild(scratch, env, { ...args, name: 'b' });
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    expect([a.result().action, b.result().action].sort()).toEqual(['applied', 'noop']);

    const settings = SettingsFile.parse(JSON.parse(h.settings()));
    expect(Object.keys(settings.hooks).sort()).toEqual([...INSTALLED_HOOK_EVENTS].sort());
    for (const groups of Object.values(settings.hooks)) {
      const ours = groups.flatMap((g) => g.hooks).filter((x) => x.args?.includes('--mcs-hook'));
      expect(ours.length).toBe(1);
    }
    expect(installsOf((await readManifest(h.mcsHome)).manifest)).toHaveLength(1);
    // one backup of the original, and no temporary file left behind
    expect(readdirSync(h.claudeHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 60_000);
});

describe('a program that holds the settings file open', () => {
  it.skipIf(FILE_HOLDER_SKIP_REASON !== null)(
    'makes the replace fail with RENAME_FAILED after the retries, and the original stays (Windows sharing violation)',
    async () => {
      const h = world();
      h.writeSettings(ORIGINAL);
      const holder = await holdFileOpen(h.settingsPath, 60_000);
      try {
        await expect(h.install()).rejects.toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'RENAME_FAILED' } });
      } finally {
        await holder?.stop();
      }
      expect(h.settings()).toBe(ORIGINAL);
      expect(readdirSync(h.claudeHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      // and once the program lets go, the same command works
      expect((await h.install()).result.action).toBe('applied');
    },
    60_000,
  );
});

/** Whether this machine lets the process create a link to a file (Windows needs a privilege for it). */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcs-probe-links-'));
  try {
    writeFileSync(path.join(dir, 'probe-target'), 'x');
    symlinkSync(path.join(dir, 'probe-target'), path.join(dir, 'probe-link'), 'file');
    unlinkSync(path.join(dir, 'probe-link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a settings file that is a link (dotfile managers do this)', () => {
  it.skipIf(!canLinkFiles())(
    'is followed: the real file is replaced and the link stays a link (needs permission to create file links)',
    async () => {
      const h = world();
      const real = path.join(h.root, 'dotfiles', 'claude-settings.json');
      mkdirSync(path.dirname(real), { recursive: true });
      writeFileSync(real, ORIGINAL);
      symlinkSync(real, h.settingsPath, 'file');
      const { result } = await h.install();
      expect(result.action).toBe('applied');
      expect(lstatSync(h.settingsPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf8')).toContain('--mcs-hook');
      expect(readFileSync(result.backupPath ?? '', 'utf8')).toBe(ORIGINAL);
      await h.uninstall();
      expect(readFileSync(real, 'utf8')).toBe(ORIGINAL);
      expect(lstatSync(h.settingsPath).isSymbolicLink()).toBe(true);
    },
  );
});
