// `uninstallHooks` (T-IN-03 at the apply level, ADR 0070 item 4): our entries go, the user's stay, the settings file ends as it
// began, and the stable copy goes with the last install. A dry run writes nothing.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HooksApplyResultSchema, McsError } from '@mcs/shared';
import { INSTALLED_HOOK_EVENTS, normalizePath } from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { HANDLER_V1, makeHarness, treeOf, type Harness } from '../../../test/fixtures/settings/harness.ts';
import { hooksFolder, installsOf, manifestPath, readManifest } from './manifest.ts';
import { backupFolder, sha256Hex } from './settings-io.ts';
import { stableScriptPath } from './script-copy.ts';

const makeTemp = useTempDirs();
const JsonRecord = z.record(z.string(), z.unknown());

async function refusal(run: Promise<unknown>): Promise<McsError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the run to be refused');
}

const reasonOf = (error: McsError): unknown => error.details?.['reason'];
const scriptFile = (h: Harness): string => path.join(h.mcsHome, 'hooks', 'mcs-hook.mjs');

const USER_SETTINGS = `${JSON.stringify(
  {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE user hook' }] }],
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'node', args: ['C:/FIXTURE/user/hook.js'] }] },
      ],
    },
    env: { FIXTURE_NAME: 'FIXTURE value' },
  },
  null,
  2,
)}\n`;

describe('uninstallHooks after an install', () => {
  it('leaves the settings file as it was (byte equal), removes the copy and the manifest, and keeps the backups (T-IN-03)', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    h.clock.now += 1000;
    const { result, audit } = await h.uninstall();
    HooksApplyResultSchema.parse(result);
    expect(h.settings()).toBe(USER_SETTINGS);
    expect(result).toMatchObject({ action: 'applied', added: [], replaced: [], kept: [] });
    expect([...result.removed].sort()).toEqual([...INSTALLED_HOOK_EVENTS].sort());
    expect(result.script).toEqual({ action: 'removed', path: stableScriptPath(h.mcsHome), sha256: null });
    expect(result.backupPath).not.toBeNull();
    expect(audit).toEqual({
      action: 'hooks-uninstall',
      summary: 'file settings ~/claude-home/settings.json: 0 added, 0 replaced, 21 removed',
      reason: null,
      files: [],
      validation: 'settings re-read and verified',
      outcome: `applied; settings backup ${result.backupPath ?? ''}`,
    });
    expect(existsSync(scriptFile(h))).toBe(false);
    expect(existsSync(manifestPath(h.mcsHome))).toBe(false);
    expect(existsSync(hooksFolder(h.mcsHome))).toBe(false);
    expect(readdirSync(backupFolder(h.mcsHome, h.settingsPath)).filter((n) => n.endsWith('.json'))).toHaveLength(2);
    // the backup of the uninstall is the installed file
    expect(readFileSync(result.backupPath ?? '', 'utf8')).toContain('--mcs-hook');
  });

  it('a settings file that install created ends as an empty object, not as a missing file', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    await h.uninstall();
    expect(JSON.parse(h.settings())).toEqual({});
  });

  it('removes what is left of our entries after the user deleted some by hand, and leaves the others alone', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    // the user takes two events out by hand; the order of everything else stays
    const file = JsonRecord.parse(JSON.parse(h.settings()));
    const hooks = JsonRecord.parse(file['hooks']);
    const left = Object.fromEntries(Object.entries(hooks).filter(([e]) => e !== 'Notification' && e !== 'SessionEnd'));
    const edited = Object.fromEntries(Object.entries(file).map(([k, v]) => [k, k === 'hooks' ? left : v]));
    h.writeSettings(`${JSON.stringify(edited, null, 2)}\n`);
    const { result } = await h.uninstall();
    expect(result.removed).toHaveLength(19);
    expect(h.settings()).toBe(USER_SETTINGS);
  });

  it('keeps a user script that is called hook.js (T-IN-04)', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    await h.uninstall();
    expect(h.settings()).toContain('C:/FIXTURE/user/hook.js');
  });
});

describe('the stable copy goes with the last install only', () => {
  it('two settings files: the first uninstall keeps the copy, the second removes it', async () => {
    const h = makeHarness(makeTemp);
    const other = path.join(h.root, 'other', 'settings.json');
    await h.install();
    await h.install({ settingsPath: other });
    const first = await h.uninstall();
    expect(first.result.script).toEqual({
      action: 'kept',
      path: stableScriptPath(h.mcsHome),
      sha256: sha256Hex(HANDLER_V1),
    });
    expect(existsSync(scriptFile(h))).toBe(true);
    expect(installsOf((await readManifest(h.mcsHome)).manifest).map((r) => r.settingsPath)).toEqual([
      normalizePath(other),
    ]);
    const second = await h.uninstall({ settingsPath: other });
    expect(second.result.script.action).toBe('removed');
    expect(existsSync(scriptFile(h))).toBe(false);
    expect(existsSync(hooksFolder(h.mcsHome))).toBe(false);
  });

  it('a lost manifest cannot tell that nobody else uses the copy, so the copy stays', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    writeFileSync(manifestPath(h.mcsHome), 'damaged');
    const { result } = await h.uninstall();
    expect(result.removed).toHaveLength(21);
    expect(result.script.action).toBe('kept');
    expect(existsSync(scriptFile(h))).toBe(true);
  });

  it('without any copy the script action is absent', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    await h.uninstall();
    const again = await h.uninstall();
    expect(again.result.script).toEqual({ action: 'absent', path: stableScriptPath(h.mcsHome), sha256: null });
  });
});

describe('an uninstall with nothing to remove', () => {
  it('is a noop and does not create a missing settings file', async () => {
    const h = makeHarness(makeTemp);
    const before = treeOf(h.root);
    const { result, audit } = await h.uninstall();
    expect(result).toMatchObject({ action: 'noop', removed: [], diff: '', warnings: [], backupPath: null });
    expect(audit).toBeNull();
    expect(existsSync(h.settingsPath)).toBe(false);
    expect(treeOf(h.root)).toEqual(before);
  });

  it('leaves a file without our entries byte for byte as it is, whatever its layout', async () => {
    const h = makeHarness(makeTemp);
    const odd = '\uFEFF{\r\n\t"theme":   "dark",\r\n\t"hooks": {}}\r\n';
    h.writeSettings(odd);
    const { result } = await h.uninstall();
    expect(result.action).toBe('noop');
    expect(h.settings()).toBe(odd);
    expect(readdirSync(h.claudeHome)).toEqual(['settings.json']);
  });

  it('takes a settings file that no longer holds our entries out of the manifest, and the copy with the last one', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    h.writeSettings('{}\n'); // the user wiped the hooks by hand
    const { result } = await h.uninstall();
    expect(result.action).toBe('noop');
    expect(result.script.action).toBe('removed');
    expect(existsSync(manifestPath(h.mcsHome))).toBe(false);
    expect(existsSync(scriptFile(h))).toBe(false);
  });
});

describe('a dry run of an uninstall', () => {
  it('writes nothing and says what it would do with the copy', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    const before = treeOf(h.root);
    const { result, audit } = await h.uninstall({ yes: false });
    HooksApplyResultSchema.parse(result);
    expect(result.action).toBe('plan');
    expect(result.removed).toHaveLength(21);
    expect(result.script.action).toBe('removed');
    expect(result.diff).toContain('-');
    expect(audit).toBeNull();
    expect(treeOf(h.root)).toEqual(before);
  });

  it('reports the copy as kept while another install remains', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    await h.install({ settingsPath: path.join(h.root, 'other', 'settings.json') });
    const out = await h.uninstall({ yes: false });
    expect(out.result.script.action).toBe('kept');
  });
});

describe('refusals', () => {
  it('a file that cannot be edited is refused and left alone, copy and manifest included', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    h.writeSettings('{"hooks": {"Stop": {}}}');
    const before = treeOf(h.root);
    expect(reasonOf(await refusal(h.uninstall()))).toBe('SETTINGS_EVENT_NOT_ARRAY');
    expect(treeOf(h.root)).toEqual(before);
  });

  it('refuses real settings paths and a real MCS_HOME in test mode, before any file is looked at (T-IN-07)', async () => {
    const h = makeHarness(makeTemp);
    const outside = path.join(path.parse(os.tmpdir()).root, 'FIXTURE-not-the-temp-folder');
    const trap = (): never => {
      throw new Error('the file system was touched');
    };
    const seams = {
      ...h.seams,
      io: {
        read: trap,
        ensureDir: trap,
        writeTemp: trap,
        readBack: trap,
        rename: trap,
        remove: trap,
        checkWritable: trap,
        sleep: trap,
      },
      acquire: trap,
    };
    for (const over of [
      { settingsPath: path.join(os.homedir(), '.claude', 'settings.json') },
      { settingsPath: path.join(outside, 'repo', '.claude', 'settings.local.json') },
      { mcsHome: path.join(outside, 'mcs-home') },
    ]) {
      for (const yes of [true, false]) {
        expect(reasonOf(await refusal(h.uninstall({ ...over, yes, seams })))).toBe('REAL_SETTINGS_IN_TEST');
      }
    }
  });

  it('refuses the shared project file even in a temporary folder', async () => {
    const h = makeHarness(makeTemp);
    const shared = path.join(h.root, 'repo', '.claude');
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, 'settings.json'), '{}');
    expect(reasonOf(await refusal(h.uninstall({ settingsPath: path.join(shared, 'settings.json') })))).toBe(
      'SCOPE_NOT_ALLOWED',
    );
  });
});
