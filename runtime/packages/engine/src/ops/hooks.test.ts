// `ops.hooks.*` (01 6.4, T-CLI-10 at the operation layer; 02 3.1, 3.8; ADR 0014, ADR 0070): the choice of the settings file, the
// guard of test mode, the dry run that writes nothing, the audit entry of 01 7.2, `hooks enable|disable` that write
// `instance.json` and the route file but never a settings file, and the two readers of `discover` and `doctor`.
// Everything lives in temporary folders with decoy settings files; no real path is read or written. The hook script is a
// small text file named like the bundled one, so no build is needed.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { InstanceFileSchema, McsError } from '@mcs/shared';
import { INSTALLED_HOOK_EVENTS, normalizePath } from '@mcs/shared/protocol';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { CHANGES_HEADER, changeEntryText } from '../audit/writer.ts';
import { defaultSkillDir } from '../config/defaults.ts';
import type { HooksSeams } from '../hooks/installer/apply.ts';
import { readRouteFile } from '../ingest/routes-file.ts';
import type { Logger } from '../log/logger.ts';
import { doctorCheck, install, setEnabled, status, summary, uninstall, verify, type HooksOpDeps } from './hooks.ts';
import type { ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111'; // FIXTURE instance id
const HANDLER_V1 = 'import { readFileSync } from "node:fs";\nexport const VERSION = "FIXTURE-1";\n';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function probeResult(over: Partial<ProbeResult>): ProbeResult {
  return {
    state: 'stopped',
    engine: null,
    pid: null,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: '',
    ...over,
  };
}

interface World {
  readonly root: string;
  readonly ctx: OpContext;
  readonly repo: string;
  readonly ws: string;
  readonly mcsHome: string;
  readonly claudeHome: string;
  /** `<claude home>/settings.json`: what `--scope user` and the decoy tests use. */
  readonly userSettings: string;
  /** `<repo>/.claude/settings.local.json`: the default scope. */
  readonly localSettings: string;
  /** A settings file outside every scope, for `--settings-file`. */
  readonly fileSettings: string;
  readonly hookSource: string;
  readonly deps: HooksOpDeps;
  readonly clock: FakeClock;
  audit(): string;
  instance(): ReturnType<typeof InstanceFileSchema.parse>;
}

function world(): World {
  const root = makeTemp('ops-hooks').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const ws = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId: ID },
  });
  const bundle = path.join(root, 'skill', 'bundle');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, 'mcs-server.mjs'), '');
  const hookSource = path.join(bundle, 'mcs-hook.mjs');
  writeFileSync(hookSource, HANDLER_V1);
  const mcsHome = path.join(root, 'mcs-home');
  const claudeHome = path.join(root, 'claude-home');
  mkdirSync(claudeHome, { recursive: true });
  const skillDir = defaultSkillDir();
  const clock = new FakeClock(NOW);
  const ctx: OpContext = {
    repo,
    root: tasksRoot,
    skillDir,
    runtimeDir: bundle,
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: { MCS_TEST: '1', MCS_HOME: mcsHome, CLAUDE_CONFIG_DIR: claudeHome, HOME: root, USERPROFILE: root },
    clock,
    log: silent,
  };
  const seams: Partial<HooksSeams> = { now: () => clock.now(), homedir: () => root };
  const deps: HooksOpDeps = {
    seams,
    gitIgnored: () => Promise.resolve(true),
    probe: () => Promise.resolve(probeResult({})),
  };
  return {
    root,
    ctx,
    repo,
    ws,
    mcsHome,
    claudeHome,
    userSettings: path.join(claudeHome, 'settings.json'),
    localSettings: path.join(repo, '.claude', 'settings.local.json'),
    fileSettings: path.join(root, 'elsewhere', 'hooks-settings.json'),
    hookSource,
    deps,
    clock,
    audit: () => {
      const file = path.join(ws, 'audit', 'changes.md');
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    instance: () => InstanceFileSchema.parse(JSON.parse(readFileSync(path.join(ws, 'instance.json'), 'utf8'))),
  };
}

async function refusal(run: Promise<unknown>): Promise<McsError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

const reasonOf = (error: McsError): unknown => error.details?.['reason'];

const ORIGINAL = `${JSON.stringify(
  { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE user hook' }] }] } },
  null,
  2,
)}\n`;

describe('the guard of test mode (T-CLI-10, ADR 0070 item 6)', () => {
  it('refuses a settings file outside the temporary folder before anything else is touched, and leaves a decoy as it was', async () => {
    const w = world();
    // The decoy plays the role of a real settings file: it lies in a folder that the narrowed guard does not allow.
    writeFileSync(w.userSettings, ORIGINAL);
    const canary = path.join(w.claudeHome, 'canary.txt');
    writeFileSync(canary, 'FIXTURE canary');
    const narrow = path.join(w.root, 'narrow');
    mkdirSync(narrow);
    const deps: HooksOpDeps = { ...w.deps, seams: { ...w.deps.seams, tmpdir: () => narrow } };
    const before = snapshotTree(w.root);

    for (const yes of [false, true]) {
      const error = await refusal(install(w.ctx, { scope: 'user', yes }, deps));
      expect(error.code).toBe('HOOKS_FAILED');
      expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
    }
    const uninstalled = await refusal(uninstall(w.ctx, { scope: 'user', yes: true }, deps));
    expect(reasonOf(uninstalled)).toBe('REAL_SETTINGS_IN_TEST');
    const toggled = await refusal(setEnabled(w.ctx, { task: 'demo', enabled: true }, deps));
    expect(reasonOf(toggled)).toBe('REAL_SETTINGS_IN_TEST');

    expect(snapshotTree(w.root)).toBe(before);
    expect(existsSync(w.mcsHome)).toBe(false);
  });

  it('the same call with the real temporary folder is accepted (the refusal comes from the location)', async () => {
    const w = world();
    writeFileSync(w.userSettings, ORIGINAL);
    const result = await install(w.ctx, { scope: 'user' }, w.deps);
    expect(result).toMatchObject({ action: 'plan', scope: 'user' });
    expect(result.settingsPath).toBe(normalizePath(w.userSettings));
  });

  it('the user scope is never chosen without being asked for: the default is the project-local file of the repository', async () => {
    const w = world();
    writeFileSync(w.userSettings, ORIGINAL);
    const result = await install(w.ctx, {}, w.deps);
    expect(result.scope).toBe('project-local');
    expect(result.settingsPath).toBe(normalizePath(w.localSettings));
    expect(result.warnings.map((warning) => warning.code)).not.toContain('HOOKS_USER_SCOPE');
  });
});

describe('which settings file', () => {
  it('refuses the shared project scope and a file that is a shared project settings file', async () => {
    const w = world();
    const project = await refusal(install(w.ctx, { scope: 'project' }, w.deps));
    expect(project.code).toBe('HOOKS_FAILED');
    expect(reasonOf(project)).toBe('SCOPE_NOT_ALLOWED');
    const shared = path.join(w.repo, '.claude', 'settings.json');
    for (const op of [install, uninstall]) {
      const error = await refusal(op(w.ctx, { settingsFile: shared, yes: true }, w.deps));
      expect(reasonOf(error)).toBe('SCOPE_NOT_ALLOWED');
    }
    expect(existsSync(shared)).toBe(false);
    const unknown = await refusal(install(w.ctx, { scope: 'machine' }, w.deps));
    expect(reasonOf(unknown)).toBe('SCOPE_NOT_ALLOWED');
  });

  it('--scope and --settings-file exclude each other; a relative settings file is a usage error', async () => {
    const w = world();
    const both = await refusal(install(w.ctx, { scope: 'user', settingsFile: w.fileSettings }, w.deps));
    expect(both.code).toBe('USAGE');
    const relative = await refusal(install(w.ctx, { settingsFile: 'settings.json' }, w.deps));
    expect(relative.code).toBe('USAGE');
  });

  it('a task name with path characters is refused and nothing is written', async () => {
    const w = world();
    const before = snapshotTree(w.root);
    const error = await refusal(install(w.ctx, { settingsFile: w.fileSettings, task: '../demo', yes: true }, w.deps));
    expect(error.code).toBe('SLUG_INVALID');
    expect(snapshotTree(w.root)).toBe(before);
  });
});

describe('install and uninstall', () => {
  it('a dry run with --settings-file writes nothing anywhere: no settings, manifest, backup, script copy or audit', async () => {
    const w = world();
    mkdirSync(path.dirname(w.fileSettings), { recursive: true });
    writeFileSync(w.fileSettings, ORIGINAL);
    const before = snapshotTree(w.root);

    const result = await install(w.ctx, { settingsFile: w.fileSettings, task: 'demo' }, w.deps);
    expect(result).toMatchObject({ action: 'plan', scope: 'file', backupPath: null });
    expect(result.added).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    expect(result.script.action).toBe('created');
    expect(snapshotTree(w.root)).toBe(before);
    expect(existsSync(w.mcsHome)).toBe(false);
    expect(w.audit()).toBe('');

    const removal = await uninstall(w.ctx, { settingsFile: w.fileSettings, task: 'demo' }, w.deps);
    expect(removal.action).toBe('noop');
    expect(snapshotTree(w.root)).toBe(before);
  });

  it('install --yes then uninstall --yes with a task: the settings end byte equal to the original and both changes are audited', async () => {
    const w = world();
    mkdirSync(path.dirname(w.fileSettings), { recursive: true });
    writeFileSync(w.fileSettings, ORIGINAL);

    const installed = await install(w.ctx, { settingsFile: w.fileSettings, task: 'demo', yes: true }, w.deps);
    expect(installed.action).toBe('applied');
    expect(installed.added).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    expect(readFileSync(w.fileSettings, 'utf8')).not.toBe(ORIGINAL);

    const removed = await uninstall(w.ctx, { settingsFile: w.fileSettings, task: 'demo', yes: true }, w.deps);
    expect(removed.action).toBe('applied');
    expect(removed.removed).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    expect(readFileSync(w.fileSettings, 'utf8')).toBe(ORIGINAL);
    expect(removed.script.action).toBe('removed');

    const audit = w.audit();
    expect(audit).toContain('| hooks-install');
    expect(audit).toContain('| hooks-uninstall');
    expect(audit).toContain('- Files changed: none');
  });

  it('writes the audit entry of 01 7.2: two added, one replaced, none removed (the rest unchanged)', async () => {
    const w = world();
    mkdirSync(path.dirname(w.fileSettings), { recursive: true });
    const key = (name: string): string => name;
    await install(w.ctx, { settingsFile: w.fileSettings, yes: true }, w.deps);
    // two of our entries are gone and a third one points at an older place of the script
    const parsed = JSON.parse(readFileSync(w.fileSettings, 'utf8')) as {
      hooks: Record<string, { hooks: { args: string[] }[] }[]>;
    };
    const hooks = parsed.hooks;
    Reflect.deleteProperty(hooks, key('Stop'));
    Reflect.deleteProperty(hooks, key('SessionEnd'));
    const old = hooks[key('Notification')]?.[0]?.hooks[0];
    if (old === undefined) throw new Error('the fixture needs a Notification entry');
    old.args = ['--no-warnings', 'FIXTURE/old/mcs-hook.mjs', '--mcs-hook', 'Notification'];
    writeFileSync(w.fileSettings, `${JSON.stringify(parsed, null, 2)}\n`);

    w.clock.set(NOW + 60_000);
    const again = await install(w.ctx, { settingsFile: w.fileSettings, task: 'demo', yes: true }, w.deps);
    expect(again).toMatchObject({ action: 'applied' });
    expect(again.added).toHaveLength(2);
    expect(again.replaced).toEqual(['Notification']);
    expect(again.removed).toEqual([]);

    const backup = again.backupPath;
    expect(backup).not.toBeNull();
    const expected = changeEntryText(
      {
        action: 'hooks-install',
        summary: 'file settings ~/elsewhere/hooks-settings.json: 2 added, 1 replaced, 0 removed',
        reason: null,
        files: [],
        validation: 'settings re-read and verified',
        outcome: `applied; settings backup ${backup ?? ''}`,
      },
      NOW + 60_000,
    );
    expect(expected).toContain(
      '- Summary: file settings ~/elsewhere/hooks-settings.json: 2 added, 1 replaced, 0 removed',
    );
    expect(w.audit()).toBe(CHANGES_HEADER + expected);
  });

  it('install --yes on a settings file that is already current changes nothing and audits nothing', async () => {
    const w = world();
    await install(w.ctx, { settingsFile: w.fileSettings, task: 'demo', yes: true }, w.deps);
    const auditBefore = w.audit();
    const bytes = readFileSync(w.fileSettings);
    const again = await install(w.ctx, { settingsFile: w.fileSettings, task: 'demo', yes: true }, w.deps);
    expect(again.action).toBe('noop');
    expect(readFileSync(w.fileSettings).equals(bytes)).toBe(true);
    expect(w.audit()).toBe(auditBefore);
  });

  it('the project-local file of the repository is warned about when git does not ignore it', async () => {
    const w = world();
    const result = await install(w.ctx, {}, { ...w.deps, gitIgnored: () => Promise.resolve(false) });
    expect(result.warnings.map((warning) => warning.code)).toContain('HOOKS_SETTINGS_NOT_IGNORED');
  });
});

describe('hooks enable and hooks disable', () => {
  it('flip hooks.enabled, rewrite the route file, audit hooks-enable and hooks-disable and never touch a settings file', async () => {
    const w = world();
    writeFileSync(w.userSettings, ORIGINAL);
    const settingsBefore = snapshotTree(w.claudeHome);
    expect(w.instance().hooks.enabled).toBe(false);

    const on = await setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps);
    expect(on).toMatchObject({ task: 'demo', enabled: true, previous: false, changed: true, running: false });
    expect(w.instance().hooks.enabled).toBe(true);
    const route = readRouteFile(w.mcsHome, ID);
    expect(route).toMatchObject({ instanceId: ID, enabled: true });
    expect(route?.spoolDir).toBe(`${route?.workspace ?? ''}/data/spool`);
    expect(on.routeFile).toBe(`${normalizePath(w.mcsHome)}/routes/${ID}.json`);
    expect(existsSync(on.routeFile)).toBe(true);

    w.clock.set(NOW + 1000);
    const off = await setEnabled(w.ctx, { task: 'demo', enabled: false }, w.deps);
    expect(off).toMatchObject({ enabled: false, previous: true, changed: true });
    expect(w.instance().hooks.enabled).toBe(false);
    expect(readRouteFile(w.mcsHome, ID)?.enabled).toBe(false);

    const audit = w.audit();
    expect(audit).toContain(
      [
        '## 2026-10-19T12:00:00Z | hooks-enable',
        '- Summary: hooks.enabled: false -> true',
        '- Reason: not given',
        '- Files changed: instance.json',
        '- Validation: schema ok',
        '- Outcome: applied',
      ].join('\n'),
    );
    expect(audit).toContain('## 2026-10-19T12:00:01Z | hooks-disable\n- Summary: hooks.enabled: true -> false');
    // no settings file was written anywhere: the decoy is as it was and the repository has no .claude/settings*.json
    expect(snapshotTree(w.claudeHome)).toBe(settingsBefore);
    expect(existsSync(w.localSettings)).toBe(false);
    expect(existsSync(path.join(w.repo, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(path.join(w.mcsHome, 'hooks'))).toBe(false);
  });

  it('a call that changes nothing writes no audit entry but repairs a missing route file', async () => {
    const w = world();
    await setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps);
    const auditBefore = w.audit();
    const route = path.join(w.mcsHome, 'routes', `${ID}.json`);
    rmSync(route);
    const again = await setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps);
    expect(again).toMatchObject({ changed: false, previous: true, enabled: true });
    expect(w.audit()).toBe(auditBefore);
    expect(readRouteFile(w.mcsHome, ID)).toMatchObject({ enabled: true });
  });

  it('keeps the lifecycle part of an existing route and reports a running monitor', async () => {
    const w = world();
    await setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps);
    const stopped = readRouteFile(w.mcsHome, ID);
    expect(stopped?.stoppedAt).toBe(NOW);
    const running: HooksOpDeps = { ...w.deps, probe: () => Promise.resolve(probeResult({ state: 'running', pid: 1 })) };
    const result = await setEnabled(w.ctx, { task: 'demo', enabled: false }, running);
    expect(result.running).toBe(true);
    expect(readRouteFile(w.mcsHome, ID)).toMatchObject({ enabled: false, stoppedAt: NOW });
  });

  it('a first route of a running instance has stoppedAt null', async () => {
    const w = world();
    const running: HooksOpDeps = { ...w.deps, probe: () => Promise.resolve(probeResult({ state: 'running', pid: 1 })) };
    await setEnabled(w.ctx, { task: 'demo', enabled: true }, running);
    expect(readRouteFile(w.mcsHome, ID)).toMatchObject({ enabled: true, stoppedAt: null, spoolUntil: null });
  });

  it('two concurrent calls on one task serialize: one changes the file, the other finds it changed, and the audit has one entry', async () => {
    const w = world();
    const results = await Promise.all([
      setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps),
      setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(w.instance().hooks.enabled).toBe(true);
    expect(w.audit().match(/\| hooks-enable/g)).toHaveLength(1);
  });

  it('refuses a task name with path characters and an unknown task', async () => {
    const w = world();
    expect((await refusal(setEnabled(w.ctx, { task: '..', enabled: true }, w.deps))).code).toBe('SLUG_INVALID');
    expect((await refusal(setEnabled(w.ctx, { task: 'nope', enabled: true }, w.deps))).code).toBe('TASK_NOT_FOUND');
  });
});

describe('hooks verify and hooks status', () => {
  it('verify without an installed settings file reports a failed first check and writes nothing', async () => {
    const w = world();
    const before = snapshotTree(w.root);
    const result = await verify(w.ctx, { task: 'demo', settingsFile: w.fileSettings }, w.deps);
    expect(result.checks.map((check) => check.check)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']);
    expect(result.checks.find((check) => check.check === 'V1')?.ok).toBe(false);
    expect(snapshotTree(w.root)).toBe(before);
  });

  it('verify needs an existing task and a settings file inside the temporary folder in test mode', async () => {
    const w = world();
    expect((await refusal(verify(w.ctx, { task: 'nope', settingsFile: w.fileSettings }, w.deps))).code).toBe(
      'TASK_NOT_FOUND',
    );
    const narrow = path.join(w.root, 'narrow');
    mkdirSync(narrow);
    const error = await refusal(
      verify(
        w.ctx,
        { task: 'demo', settingsFile: w.fileSettings },
        { ...w.deps, verifySeams: { tmpdir: () => narrow }, seams: { tmpdir: () => narrow } },
      ),
    );
    expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
  });

  it('status lists the installs and the state of the script copy', async () => {
    const w = world();
    const empty = await status(w.ctx, {}, w.deps);
    expect(empty.installs).toEqual([]);
    expect(empty.script.state).toBe('not_installed');
    await install(w.ctx, { settingsFile: w.fileSettings, yes: true }, w.deps);
    const after = await status(w.ctx, { task: 'demo' }, w.deps);
    expect(after.installs).toHaveLength(1);
    expect(after.installs[0]).toMatchObject({ scope: 'file', events: INSTALLED_HOOK_EVENTS.length });
    expect(after.script.state).toBe('current');
    expect(Object.keys(after.lastEnvelopeAt)).toEqual([ID]);
  });
});

describe('the lines of discover and doctor (CR-WP-14-2)', () => {
  it('summary is null, then "installed (project-local)", then the stale and missing forms', async () => {
    const w = world();
    expect(await summary(w.ctx, w.deps)).toBeNull();

    await install(w.ctx, { yes: true }, w.deps);
    expect(await summary(w.ctx, w.deps)).toBe('installed (project-local)');

    writeFileSync(w.hookSource, `${HANDLER_V1}// FIXTURE plugin update\n`);
    expect(await summary(w.ctx, w.deps)).toBe('installed (project-local), script stale');

    writeFileSync(w.hookSource, HANDLER_V1);
    writeFileSync(path.join(w.mcsHome, 'hooks', 'mcs-hook.mjs'), 'x');
    expect(await summary(w.ctx, w.deps)).toBe('installed (project-local), script stale');
    await install(w.ctx, { yes: true }, w.deps);
    expect(await summary(w.ctx, w.deps)).toBe('installed (project-local)');
  });

  it('summary reports a missing copy', async () => {
    const w = world();
    await install(w.ctx, { yes: true }, w.deps);
    rmSync(path.join(w.mcsHome, 'hooks', 'mcs-hook.mjs'));
    expect(await summary(w.ctx, w.deps)).toBe('installed (project-local), script missing');
  });

  it('a user settings file outside the temporary folder is left out of the scan in test mode and never opened', async () => {
    const w = world();
    await install(w.ctx, { yes: true }, w.deps);
    // the user scope points at a folder that the narrowed guard (the world itself) does not allow
    const outside = makeTemp('ops-hooks-outside').path;
    writeFileSync(path.join(outside, 'settings.json'), ORIGINAL);
    const ctx: OpContext = { ...w.ctx, env: { ...w.ctx.env, CLAUDE_CONFIG_DIR: outside } };
    const narrowed: HooksOpDeps = {
      ...w.deps,
      seams: { ...w.deps.seams, tmpdir: () => w.root },
      statusSeams: { tmpdir: () => w.root },
    };
    const result = await status(ctx, {}, narrowed);
    expect(result.installs.map((install) => install.scope)).toEqual(['project-local']);
    expect(await summary(ctx, narrowed)).toBe('installed (project-local)');
  });

  it('the doctor check passes when nothing is installed and warns, with the repairing command, for a stale copy or a disabled task', async () => {
    const w = world();
    const none = await doctorCheck(w.ctx, null, w.deps);
    expect(none).toMatchObject({ id: 'hooks', ok: true });
    expect(none.detail).toContain('not installed');

    await install(w.ctx, { yes: true }, w.deps);
    const ws = { slug: 'demo', root: w.ctx.root, dir: w.ws, realDir: w.ws };
    const disabled = await doctorCheck(w.ctx, ws, w.deps);
    expect(disabled).toMatchObject({ ok: false, level: 'warn', fix: 'mcs hooks enable --task demo' });

    await setEnabled(w.ctx, { task: 'demo', enabled: true }, w.deps);
    expect(await doctorCheck(w.ctx, ws, w.deps)).toMatchObject({
      ok: true,
      detail: 'installed (project-local), script current',
    });

    writeFileSync(w.hookSource, `${HANDLER_V1}// FIXTURE plugin update\n`);
    const stale = await doctorCheck(w.ctx, ws, w.deps);
    expect(stale).toMatchObject({ ok: false, level: 'warn', detail: 'installed (project-local), script stale' });
    expect(stale.fix).toContain('mcs hooks install --yes');
  });
});
