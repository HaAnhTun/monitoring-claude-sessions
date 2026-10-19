// T-IN-05 (atomic apply with fault injection), T-IN-06 (backups), T-IN-07 (test guard), T-IN-09 (dry run) and the stable-path
// rules of ADR 0070 for `applyHooks`. Every test lives in a temporary world (MCS_HOME, config folder, bundle) with the test guard
// on; the faults are injected through the `SettingsIo` seam.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HooksApplyResultSchema, McsError } from '@mcs/shared';
import { ASYNC_HOOK_EVENTS, HANDLER_VERSION, INSTALLED_HOOK_EVENTS, normalizePath } from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  HANDLER_V1,
  HANDLER_V2,
  makeHarness,
  treeOf,
  withIo,
  type Harness,
} from '../../../test/fixtures/settings/harness.ts';
import { changeEntryText } from '../../audit/writer.ts';
import { MutexTimeoutError } from '../../platform/mutex.ts';
import { hooksWarnings, LOCK_TIMEOUT_MS, MAX_ATTEMPTS } from './apply.ts';
import { backupFolder, realSettingsIo, sha256Hex } from './settings-io.ts';
import { readManifest, manifestPath, installsOf } from './manifest.ts';
import { stableScriptPath } from './script-copy.ts';

const makeTemp = useTempDirs();

const SettingsShape = z.object({
  hooks: z.record(z.string(), z.array(z.looseObject({ hooks: z.array(z.record(z.string(), z.unknown())) }))),
});

function hooksIn(text: string): z.infer<typeof SettingsShape>['hooks'] {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  return SettingsShape.parse(parsed).hooks;
}

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

function stable(h: Harness): string {
  return stableScriptPath(h.mcsHome);
}

function backupsOf(h: Harness): string[] {
  const dir = backupFolder(h.mcsHome, h.settingsPath);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

const USER_SETTINGS = `${JSON.stringify(
  {
    theme: 'dark',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE user hook' }] }] },
    env: { FIXTURE_NAME: 'FIXTURE value' },
  },
  null,
  2,
)}\n`;

describe('applyHooks: a first install', () => {
  it('writes all 21 events, the stable copy of the script and the manifest', async () => {
    const h = makeHarness(makeTemp);
    const { result, audit } = await h.install();
    HooksApplyResultSchema.parse(result);
    expect(result).toMatchObject({
      scope: 'file',
      action: 'applied',
      backupPath: null,
      replaced: [],
      removed: [],
      kept: [],
    });
    expect(result.settingsPath).toBe(normalizePath(h.settingsPath));
    expect(result.added).toEqual([...INSTALLED_HOOK_EVENTS]);
    expect(result.script).toEqual({ action: 'created', path: stable(h), sha256: sha256Hex(HANDLER_V1) });
    expect(result.diff).toContain('@@ -0,0 +1,');

    const hooks = hooksIn(h.settings());
    expect(Object.keys(hooks)).toEqual([...INSTALLED_HOOK_EVENTS]);
    expect(readFileSync(path.join(h.mcsHome, 'hooks', 'mcs-hook.mjs'), 'utf8')).toBe(HANDLER_V1);

    const read = await readManifest(h.mcsHome);
    expect(read.problem).toBeNull();
    expect(installsOf(read.manifest)).toEqual([
      {
        settingsPath: normalizePath(h.settingsPath),
        scope: 'file',
        op: 'install',
        at: h.clock.now,
        events: 21,
        handlerVersion: HANDLER_VERSION,
        nodePath: 'C:/FIXTURE/node.exe',
        hookEntryPath: stable(h),
        async: true,
        backup: null,
      },
    ]);
    expect(audit).toEqual({
      action: 'hooks-install',
      summary: 'file settings ~/claude-home/settings.json: 21 added, 0 replaced, 0 removed',
      reason: null,
      files: [],
      validation: 'settings re-read and verified',
      outcome: 'applied',
    });
  });

  it('entries run the Node executable and the stable copy, and name no path below the source folder', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    const text = h.settings();
    const sourceDir = normalizePath(path.dirname(h.source));
    expect(text).not.toContain(sourceDir);
    expect(text).not.toContain(path.dirname(h.source));
    for (const [event, groups] of Object.entries(hooksIn(text))) {
      expect(groups).toHaveLength(1);
      const entry = groups[0]?.hooks[0];
      expect(entry).toMatchObject({ type: 'command', command: 'C:/FIXTURE/node.exe' });
      expect(entry?.['args']).toEqual([
        '--no-warnings',
        stable(h),
        '--mcs-hook',
        event,
        ...(ASYNC_HOOK_EVENTS.some((e) => e === event) ? ['--async'] : []),
      ]);
    }
  });

  it('--sync-tool-events installs the tool events without async', async () => {
    const h = makeHarness(makeTemp);
    await h.install({ syncToolEvents: true });
    for (const event of ASYNC_HOOK_EVENTS) {
      const entry = hooksIn(h.settings())[event]?.[0]?.hooks[0];
      expect(entry?.['async']).toBeUndefined();
      expect(entry?.['args']).not.toContain('--async');
    }
    expect(installsOf((await readManifest(h.mcsHome)).manifest)[0]?.async).toBe(false);
  });

  it('creates the folder of a new project-local settings file', async () => {
    const h = makeHarness(makeTemp);
    const file = path.join(h.root, 'repo', '.claude', 'settings.local.json');
    const out = await h.install({ scope: 'project-local', settingsPath: file });
    expect(out.result.scope).toBe('project-local');
    expect(existsSync(file)).toBe(true);
  });

  it('warns that running sessions reload, and about the user scope and an unignored project-local file', async () => {
    const h = makeHarness(makeTemp);
    const user = await h.install({ scope: 'user', settingsPath: path.join(h.claudeHome, 'settings.json') });
    expect(user.result.warnings.map((w) => w.code)).toEqual(['HOOKS_USER_SCOPE', 'HOOKS_LIVE_RELOAD']);
    const local = await h.install({
      scope: 'project-local',
      settingsPath: path.join(h.root, 'repo', '.claude', 'settings.local.json'),
      gitIgnored: false,
    });
    expect(local.result.warnings.map((w) => w.code)).toEqual(['HOOKS_SETTINGS_NOT_IGNORED', 'HOOKS_LIVE_RELOAD']);
    expect(hooksWarnings('project-local', true).map((w) => w.code)).toEqual(['HOOKS_LIVE_RELOAD']);
    expect(hooksWarnings('project-local', null).map((w) => w.code)).toEqual(['HOOKS_LIVE_RELOAD']);
  });
});

describe('applyHooks: an existing settings file', () => {
  it('keeps what the user has, and writes a backup that equals the original bytes (T-IN-06)', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const { result, audit } = await h.install();
    const hooks = hooksIn(h.settings());
    expect(hooks['Stop']).toHaveLength(2);
    expect(hooks['Stop']?.[0]?.hooks[0]?.['command']).toBe('echo FIXTURE user hook');
    expect(JSON.parse(h.settings())).toMatchObject({ theme: 'dark', env: { FIXTURE_NAME: 'FIXTURE value' } });
    expect(Object.keys(JSON.parse(h.settings()) as object).slice(0, 3)).toEqual(['theme', 'hooks', 'env']);

    expect(result.backupPath).not.toBeNull();
    const backup = result.backupPath ?? '';
    expect(path.dirname(path.normalize(backup))).toBe(backupFolder(h.mcsHome, h.settingsPath));
    expect(readFileSync(backup, 'utf8')).toBe(USER_SETTINGS);
    expect(audit?.outcome).toBe(`applied; settings backup ${backup}`);
    expect(audit?.summary).toBe('file settings ~/claude-home/settings.json: 21 added, 0 replaced, 0 removed');
    expect(result.added).toHaveLength(21);
    expect(installsOf((await readManifest(h.mcsHome)).manifest)[0]?.backup).toBe(backup);
  });

  it('the audit entry has the text of the template in 01 7.2 for a plan with one replaced entry', async () => {
    const h = makeHarness(makeTemp);
    await h.install({ nodePath: 'C:/FIXTURE/old-node.exe' });
    const { result, audit } = await h.install();
    expect(result.replaced).toHaveLength(21);
    expect(result.added).toEqual([]);
    expect(audit).not.toBeNull();
    const text = changeEntryText(audit!, Date.UTC(2026, 9, 11, 14, 5, 7));
    expect(text).toBe(
      [
        '## 2026-10-11T14:05:07Z | hooks-install',
        '- Summary: file settings ~/claude-home/settings.json: 0 added, 21 replaced, 0 removed',
        '- Reason: not given',
        '- Files changed: none',
        '- Validation: settings re-read and verified',
        `- Outcome: applied; settings backup ${result.backupPath ?? ''}`,
        '- Unresolved: none',
        '',
        '',
      ].join('\n'),
    );
  });

  it('keeps 20 backups of one file and prunes the older ones (T-IN-06)', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    for (let i = 0; i < 12; i += 1) {
      h.clock.now += 1000;
      await h.uninstall();
      h.clock.now += 1000;
      await h.install();
    }
    const kept = backupsOf(h);
    expect(kept).toHaveLength(20);
    const newest = [...kept].sort().at(-1) ?? '';
    expect(newest).toMatch(/install\.json$/);
  });

  it('replaces the file behind a link and not the link (a dotfile manager owns it); the backup holds the real file', async () => {
    const h = makeHarness(makeTemp);
    const real = path.join(h.root, 'dotfiles', 'claude-settings.json');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, USER_SETTINGS);
    // what `read` answers for a link: the snapshot of the real file, whose `target` is the real path (see settings-io.test.ts)
    const seams = withIo(h, {
      read: (file) => realSettingsIo.read(file === h.settingsPath ? real : file),
    });
    const { result } = await h.install({ seams });
    expect(result.action).toBe('applied');
    expect(Object.keys(hooksIn(readFileSync(real, 'utf8')))).toHaveLength(21);
    expect(existsSync(h.settingsPath)).toBe(false);
    expect(readFileSync(result.backupPath ?? '', 'utf8')).toBe(USER_SETTINGS);
    expect(readdirSync(path.dirname(real)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const again = await h.install({ seams });
    expect(again.result.action).toBe('noop');
    await h.uninstall({ seams });
    expect(readFileSync(real, 'utf8')).toBe(USER_SETTINGS);
  });

  it('keeps the permission bits of the file it replaces', async () => {
    if (process.platform === 'win32') return; // Windows has no permission bits to keep
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    chmodSync(h.settingsPath, 0o600);
    await h.install();
    expect(readFileSync(h.settingsPath, 'utf8').length).toBeGreaterThan(USER_SETTINGS.length);
    expect(statSync(h.settingsPath).mode & 0o777).toBe(0o600);
  });
});

describe('applyHooks is idempotent, and a plugin update only refreshes the stable copy', () => {
  it('a second install changes nothing: noop, no backup, same bytes, copy current', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    const before = treeOf(h.root);
    const settings = h.settings();
    const again = await h.install();
    expect(again.result).toMatchObject({
      action: 'noop',
      backupPath: null,
      added: [],
      replaced: [],
      removed: [],
      diff: '',
      warnings: [],
    });
    expect(again.result.kept).toHaveLength(21);
    expect(again.result.script.action).toBe('current');
    expect(again.audit).toBeNull();
    expect(h.settings()).toBe(settings);
    expect(treeOf(h.root)).toEqual(before);
  });

  it('after the bundled script changed, a second install gives settings noop and script refreshed', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    const settings = h.settings();
    h.setSource(HANDLER_V2);
    const again = await h.install();
    expect(again.result.action).toBe('noop');
    expect(again.result.script).toEqual({ action: 'refreshed', path: stable(h), sha256: sha256Hex(HANDLER_V2) });
    expect(h.settings()).toBe(settings);
    expect(readFileSync(path.join(h.mcsHome, 'hooks', 'mcs-hook.mjs'), 'utf8')).toBe(HANDLER_V2);
    expect(backupsOf(h)).toEqual([]);
  });

  it('a lost manifest is written again by the next install', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    writeFileSync(manifestPath(h.mcsHome), 'not json');
    const again = await h.install();
    expect(again.result.action).toBe('noop');
    expect(installsOf((await readManifest(h.mcsHome)).manifest)).toHaveLength(1);
  });

  it('two installs at the same time serialize: one applies, the other finds it done', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const [a, b] = await Promise.all([h.install(), h.install()]);
    expect([a.result.action, b.result.action].sort()).toEqual(['applied', 'noop']);
    const hooks = hooksIn(h.settings());
    expect(Object.keys(hooks).sort()).toEqual([...INSTALLED_HOOK_EVENTS].sort());
    for (const groups of Object.values(hooks)) {
      const ours = groups.filter((g) =>
        g.hooks.some((x) => (x['args'] as string[] | undefined)?.includes('--mcs-hook')),
      );
      expect(ours).toHaveLength(1);
    }
    expect(installsOf((await readManifest(h.mcsHome)).manifest)).toHaveLength(1);
  });

  it('two settings files share one stable copy', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    const other = path.join(h.root, 'other', 'settings.json');
    const out = await h.install({ settingsPath: other });
    expect(out.result.script.action).toBe('current');
    expect(installsOf((await readManifest(h.mcsHome)).manifest)).toHaveLength(2);
  });
});

describe('T-IN-09 a dry run writes nothing', () => {
  it('on a world with nothing in it: no settings file, no MCS_HOME, no folder', async () => {
    const h = makeHarness(makeTemp);
    const before = treeOf(h.root);
    const { result, audit } = await h.install({ yes: false });
    HooksApplyResultSchema.parse(result);
    expect(result).toMatchObject({ action: 'plan', backupPath: null });
    expect(result.added).toHaveLength(21);
    expect(result.script.action).toBe('created');
    expect(result.diff).toContain('+  "hooks": {');
    expect(audit).toBeNull();
    expect(treeOf(h.root)).toEqual(before);
    expect(existsSync(h.mcsHome)).toBe(false);
  });

  it('on an installed world: settings, manifest, backups and the script copy are unchanged by hash', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    await h.install();
    h.setSource(HANDLER_V2);
    const before = treeOf(h.root);
    const install = await h.install({ yes: false, nodePath: 'C:/FIXTURE/other-node.exe' });
    expect(install.result.action).toBe('plan');
    expect(install.result.replaced).toHaveLength(21);
    expect(install.result.script.action).toBe('refreshed');
    expect(treeOf(h.root)).toEqual(before);
    const uninstall = await h.uninstall({ yes: false });
    expect(uninstall.result.action).toBe('plan');
    expect(uninstall.result.removed).toHaveLength(21);
    expect(uninstall.result.script.action).toBe('removed');
    expect(treeOf(h.root)).toEqual(before);
  });

  it('does not create the folder of a project-local file', async () => {
    const h = makeHarness(makeTemp);
    const file = path.join(h.root, 'repo', '.claude', 'settings.local.json');
    await h.install({ yes: false, scope: 'project-local', settingsPath: file });
    expect(existsSync(path.join(h.root, 'repo'))).toBe(false);
  });

  it('reports a file that needs nothing as noop', async () => {
    const h = makeHarness(makeTemp);
    await h.install();
    const out = await h.install({ yes: false });
    expect(out.result.action).toBe('noop');
    expect(out.result.script.action).toBe('current');
  });

  it('refuses a settings file it cannot edit in a dry run as well, and still writes nothing', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings('{ not json');
    const before = treeOf(h.root);
    expect(reasonOf(await refusal(h.install({ yes: false })))).toBe('SETTINGS_INVALID_JSON');
    expect(treeOf(h.root)).toEqual(before);
  });
});

describe('the source layout has no hook file that can be copied', () => {
  it('refuses an install and a dry run when the source is dist/hook.js, and writes nothing', async () => {
    const h = makeHarness(makeTemp);
    const dist = path.join(h.root, 'checkout', 'runtime', 'packages', 'cli', 'dist');
    mkdirSync(dist, { recursive: true });
    const hook = path.join(dist, 'hook.js');
    writeFileSync(hook, 'import { runHook } from "./hook/main.js";\n');
    const before = treeOf(h.root);
    for (const yes of [true, false]) {
      expect(reasonOf(await refusal(h.install({ source: hook, yes })))).toBe('HOOK_BUNDLE_MISSING');
    }
    expect(treeOf(h.root)).toEqual(before);
  });

  it('refuses a missing source before the settings file is touched', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const error = await refusal(h.install({ source: path.join(h.root, 'nowhere', 'mcs-hook.mjs') }));
    expect(reasonOf(error)).toBe('HOOK_BUNDLE_MISSING');
    expect(h.settings()).toBe(USER_SETTINGS);
    expect(backupsOf(h)).toEqual([]);
    expect(existsSync(h.mcsHome)).toBe(false);
  });
});

describe('T-IN-07 the test guard', () => {
  // Path strings built at run time that lie outside the temporary folder; they are resolved and never opened.
  const outsideRoot = path.join(path.parse(os.tmpdir()).root, 'FIXTURE-not-the-temp-folder');
  const realLooking = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(outsideRoot, 'repo', '.claude', 'settings.json'),
    path.join(outsideRoot, 'repo', '.claude', 'settings.local.json'),
  ];
  /** A file system that fails the test if anything at all calls it. */
  function untouchable(h: Harness): Partial<typeof h.seams> {
    const trap = (): never => {
      throw new Error('the file system was touched');
    };
    return {
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
  }

  for (const file of realLooking) {
    for (const yes of [true, false]) {
      it(`refuses ${path.basename(path.dirname(file))}/${path.basename(file)} with yes=${String(yes)} before any other step`, async () => {
        const h = makeHarness(makeTemp);
        // the source does not exist either: the guard comes before the bundle check
        const error = await refusal(
          h.install({
            settingsPath: file,
            yes,
            source: path.join(h.root, 'nowhere', 'mcs-hook.mjs'),
            seams: untouchable(h),
          }),
        );
        expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
        expect(error.code).toBe('HOOKS_FAILED');
        const out = await refusal(h.uninstall({ settingsPath: file, yes, seams: untouchable(h) }));
        expect(reasonOf(out)).toBe('REAL_SETTINGS_IN_TEST');
      });
    }
  }

  it('refuses a MCS_HOME outside the temporary folder', async () => {
    const h = makeHarness(makeTemp);
    const error = await refusal(h.install({ mcsHome: path.join(outsideRoot, 'mcs-home'), seams: untouchable(h) }));
    expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
    expect(error.message).toContain('MCS_HOME');
  });

  it('acts on VITEST alone, and does nothing when neither variable is set', async () => {
    const h = makeHarness(makeTemp);
    const real = realLooking[0] ?? '';
    expect(
      reasonOf(await refusal(h.install({ settingsPath: real, env: { VITEST: 'true' }, seams: untouchable(h) }))),
    ).toBe('REAL_SETTINGS_IN_TEST');
    // test mode off: the guard lets the path through (a dry run here, against an io that answers "no such file")
    const quiet = withIo(h, { read: () => Promise.resolve({ target: real, bytes: null, sha256: null, mode: null }) });
    const out = await h.install({ settingsPath: real, env: { MCS_TEST: '' }, yes: false, seams: quiet });
    expect(out.result.action).toBe('plan');
  });

  it('refuses the shared project file for an explicit settings file, even inside the temporary folder', async () => {
    const h = makeHarness(makeTemp);
    const shared = path.join(h.root, 'repo', '.claude', 'settings.json');
    const before = treeOf(h.root);
    expect(reasonOf(await refusal(h.install({ settingsPath: shared })))).toBe('SCOPE_NOT_ALLOWED');
    expect(treeOf(h.root)).toEqual(before);
  });

  it('wants absolute paths', async () => {
    const h = makeHarness(makeTemp);
    const error = await refusal(h.install({ settingsPath: path.join('relative', 'settings.json') }));
    expect(error.code).toBe('USAGE');
  });
});

describe('T-IN-05 atomic apply: faults injected through the io seam', () => {
  function noTemporaryFiles(h: Harness): void {
    expect(readdirSync(h.claudeHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }

  it('a crash after the temporary file was written keeps the original and removes the temporary file', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const seams = withIo(h, {
      readBack: () => Promise.reject(new Error('simulated crash')),
    });
    await expect(h.install({ seams })).rejects.toThrow('simulated crash');
    expect(h.settings()).toBe(USER_SETTINGS);
    noTemporaryFiles(h);
    expect(existsSync(path.join(h.mcsHome, 'hooks', 'installs.json'))).toBe(false);
  });

  it('a temporary file that does not verify is never renamed', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const seams = withIo(h, {
      writeTemp: (file, bytes, mode) => realSettingsIo.writeTemp(file, bytes.subarray(0, 10), mode),
    });
    const error = await refusal(h.install({ seams }));
    expect(reasonOf(error)).toBe('WRITE_VALIDATION_FAILED');
    expect(h.settings()).toBe(USER_SETTINGS);
    noTemporaryFiles(h);
  });

  it('a temporary file that cannot be written is WRITE_FAILED', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const seams = withIo(h, {
      writeTemp: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })),
    });
    expect(reasonOf(await refusal(h.install({ seams })))).toBe('WRITE_FAILED');
    expect(h.settings()).toBe(USER_SETTINGS);
  });

  it('a change between the read and the rename makes the run start again, on the new content', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    let reads = 0;
    const seams = withIo(h, {
      read: (file) => {
        reads += 1;
        // the second read of the first pass is the check before the rename: somebody saves the file just before it
        if (reads === 2)
          writeFileSync(h.settingsPath, `${JSON.stringify({ addedByOther: true, theme: 'light' }, null, 2)}\n`);
        return realSettingsIo.read(file);
      },
    });
    const { result } = await h.install({ seams });
    expect(result.action).toBe('applied');
    expect(reads).toBe(4);
    const final: unknown = JSON.parse(h.settings());
    expect(final).toMatchObject({ addedByOther: true, theme: 'light' });
    expect(Object.keys(hooksIn(h.settings()))).toHaveLength(21);
    // one backup per pass: the first holds the original, the second what the other program saved
    const dir = backupFolder(h.mcsHome, h.settingsPath);
    const saved = backupsOf(h).map((name) => readFileSync(path.join(dir, name), 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved).toContain(USER_SETTINGS);
    expect(saved.some((text) => text.includes('addedByOther'))).toBe(true);
    noTemporaryFiles(h);
  });

  it('a file that keeps changing is SETTINGS_CHANGED_CONCURRENTLY after three passes, and our text is never written', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    let reads = 0;
    const seams = withIo(h, {
      read: (file) => {
        reads += 1;
        if (reads % 2 === 0) writeFileSync(h.settingsPath, `${JSON.stringify({ round: reads })}\n`);
        return realSettingsIo.read(file);
      },
    });
    const error = await refusal(h.install({ seams }));
    expect(reasonOf(error)).toBe('SETTINGS_CHANGED_CONCURRENTLY');
    expect(error.details).toMatchObject({ attempts: MAX_ATTEMPTS });
    expect(reads).toBe(MAX_ATTEMPTS * 2);
    expect(JSON.parse(h.settings())).toEqual({ round: reads });
    noTemporaryFiles(h);
  });

  it('a rename that fails with EPERM three times and then works is retried and succeeds', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    let failures = 3;
    const sleeps: number[] = [];
    const seams = withIo(h, {
      rename: (from, to) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' }));
        }
        return realSettingsIo.rename(from, to);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const { result } = await h.install({ seams });
    expect(result.action).toBe('applied');
    expect(sleeps).toEqual([50, 50, 50]);
    expect(Object.keys(hooksIn(h.settings()))).toHaveLength(21);
    noTemporaryFiles(h);
  });

  it('a rename that never works is RENAME_FAILED and the original stays', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const seams = withIo(h, {
      rename: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })),
      sleep: () => Promise.resolve(),
    });
    expect(reasonOf(await refusal(h.install({ seams })))).toBe('RENAME_FAILED');
    expect(h.settings()).toBe(USER_SETTINGS);
    noTemporaryFiles(h);
    // the copy of the script was written before the settings (ADR 0070): harmless, nothing runs it, the manifest does not list it
    expect(readFileSync(path.join(h.mcsHome, 'hooks', 'mcs-hook.mjs'), 'utf8')).toBe(HANDLER_V1);
    expect(existsSync(manifestPath(h.mcsHome))).toBe(false);
    // and the next install, with the file system working again, finds the copy current
    const again = await h.install();
    expect(again.result.action).toBe('applied');
    expect(again.result.script.action).toBe('current');
  });

  it('a file that does not verify after the rename is put back from the original', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    let renames = 0;
    const seams = withIo(h, {
      rename: async (from, to) => {
        await realSettingsIo.rename(from, to);
        renames += 1;
        if (renames === 1) writeFileSync(to, '{"clobbered": true}\n'); // another program writes right after the replace
      },
    });
    const error = await refusal(h.install({ seams }));
    expect(reasonOf(error)).toBe('POST_CHECK_FAILED');
    expect(error.details).toMatchObject({ restored: true });
    expect(h.settings()).toBe(USER_SETTINGS);
    noTemporaryFiles(h);
  });

  it('a new file that does not verify after the rename is removed again', async () => {
    const h = makeHarness(makeTemp);
    const seams = withIo(h, {
      rename: async (from, to) => {
        await realSettingsIo.rename(from, to);
        writeFileSync(to, 'garbage');
      },
    });
    const error = await refusal(h.install({ seams }));
    expect(reasonOf(error)).toBe('POST_CHECK_FAILED');
    expect(error.details).toMatchObject({ restored: true });
    expect(existsSync(h.settingsPath)).toBe(false);
  });

  it('says so when the original cannot be put back, and names the backup', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    let renames = 0;
    const seams = withIo(h, {
      rename: async (from, to) => {
        renames += 1;
        if (renames > 1) throw Object.assign(new Error('gone'), { code: 'EXDEV' });
        await realSettingsIo.rename(from, to);
        writeFileSync(to, '{"clobbered": true}\n');
      },
    });
    const error = await refusal(h.install({ seams }));
    expect(reasonOf(error)).toBe('POST_CHECK_FAILED');
    expect(error.details).toMatchObject({ restored: false });
    expect(error.message).toContain('could NOT be put back');
    expect(error.details?.['backup']).toEqual(expect.stringContaining('backups/settings/'));
  });

  it('a read-only settings file is refused with the original intact and no backup made', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    chmodSync(h.settingsPath, 0o444);
    try {
      expect(reasonOf(await refusal(h.install()))).toBe('SETTINGS_NOT_WRITABLE');
      expect(h.settings()).toBe(USER_SETTINGS);
      expect(backupsOf(h)).toEqual([]);
      expect(existsSync(h.mcsHome)).toBe(false);
    } finally {
      chmodSync(h.settingsPath, 0o644);
    }
  });

  it('a held mutex is LOCKED after the wait, with nothing written; the mutex is let go after a run and after a failure', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const names: string[] = [];
    const released: string[] = [];
    const seams = {
      ...h.seams,
      acquire: (name: string, o: { timeoutMs: number }) => {
        names.push(name);
        expect(o.timeoutMs).toBe(LOCK_TIMEOUT_MS);
        return Promise.resolve({
          name,
          release: () => {
            released.push(name);
            return Promise.resolve();
          },
        });
      },
    };
    await h.install({ seams });
    expect(names).toHaveLength(2);
    expect(released).toEqual([names[1], names[0]]);

    h.writeSettings('{ broken');
    released.length = 0;
    await refusal(h.install({ seams }));
    expect(released).toHaveLength(2);

    const busy = {
      ...h.seams,
      acquire: (name: string) => Promise.reject(new MutexTimeoutError(name, 10_000)),
    };
    h.writeSettings(USER_SETTINGS);
    const before = treeOf(h.root);
    expect(reasonOf(await refusal(h.install({ seams: busy })))).toBe('LOCKED');
    expect(treeOf(h.root)).toEqual(before);
  });

  it('refuses a file that is not JSON, a folder instead of a file, and writes no backup, copy or manifest', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings('{ "hooks": ');
    expect(reasonOf(await refusal(h.install()))).toBe('SETTINGS_INVALID_JSON');
    expect(h.settings()).toBe('{ "hooks": ');
    expect(existsSync(h.mcsHome)).toBe(false);
    const dir = path.join(h.root, 'a-folder.json');
    mkdirSync(dir);
    expect(reasonOf(await refusal(h.install({ settingsPath: dir })))).toBe('SETTINGS_UNREADABLE');
  });

  it('fails with MANIFEST_FAILED, saying the settings are in order, when the manifest cannot be written', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    mkdirSync(manifestPath(h.mcsHome), { recursive: true }); // a folder where the manifest file goes
    const error = await refusal(h.install());
    expect(reasonOf(error)).toBe('MANIFEST_FAILED');
    expect(error.details).toMatchObject({ settingsChanged: true });
    expect(Object.keys(hooksIn(h.settings()))).toHaveLength(21);
  });

  it('the temporary file sits next to the settings file and is a dot file', async () => {
    const h = makeHarness(makeTemp);
    h.writeSettings(USER_SETTINGS);
    const seen: string[] = [];
    const seams = withIo(h, {
      writeTemp: (file, bytes, mode) => {
        seen.push(file);
        return realSettingsIo.writeTemp(file, bytes, mode);
      },
    });
    await h.install({ seams });
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0] ?? '')).toBe(h.claudeHome);
    expect(path.basename(seen[0] ?? '')).toMatch(/^\.settings\.json\.mcs-\d+-[0-9a-f]{6}\.tmp$/);
  });
});
