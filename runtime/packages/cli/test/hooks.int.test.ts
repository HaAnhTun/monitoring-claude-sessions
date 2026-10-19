// `mcs hooks ...` through a real bundled CLI on real processes (T-IN-10, T-CLI-10; 01 6.3, 6.4; 02 3.1, 3.8; ADR 0014, ADR 0070).
// A bundle of the current sources (CLI and hook handler) is built once into a temporary folder and copied for every test, so a
// "plugin update" is a change of the copy's `mcs-hook.mjs`. Every call passes `--repo <temp repo>`; every settings file is the
// project-local file of the temporary repository or a file below the temporary root; the real settings and the real MCS_HOME are
// never named. A decoy settings file with a canary line sits in the temporary Claude home and must stay byte-identical.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultSkillDir } from '@mcs/engine';
import {
  CliEnvelopeSchema,
  HooksApplyResultSchema,
  HooksStatusResultSchema,
  HooksVerifyResultSchema,
  type CliEnvelope,
} from '@mcs/shared';
import { HANDLER_VERSION, INSTALLED_HOOK_EVENTS } from '@mcs/shared/protocol';
import { allocatePort, buildRepo, hermeticEnv, killAllTracked, snapshotTree, useTempDirs } from '@mcs/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const SLUG = 'demo';
const CANARY_LINE = 'FIXTURE canary: this file must stay as it is';
const ORIGINAL = `${JSON.stringify(
  {
    theme: 'dark',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE user hook' }] }] },
    env: { FIXTURE_NAME: 'FIXTURE value' },
  },
  null,
  2,
)}\n`;

/** A bundle of the current sources, built once for the file and copied for every sandbox. */
let template = '';

beforeAll(async () => {
  template = mkdtempSync(path.join(tmpdir(), 'mcs-hooks-cli-bundle-'));
  const outDir = path.join(template, 'bundle');
  await buildBundle({
    outDir,
    entries: { 'mcs-cli': ENTRIES['mcs-cli'] ?? '', 'mcs-hook': ENTRIES['mcs-hook'] ?? '' },
    web: false,
  });
  // the layout resolver recognises a bundle by its server entry; no hooks command starts the server
  writeFileSync(path.join(outDir, 'mcs-server.mjs'), '');
}, 120_000);

afterAll(() => {
  if (template !== '') rmSync(template, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(async () => {
  await killAllTracked();
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly claudeHome: string;
  readonly bundleDir: string;
  readonly cliEntry: string;
  /** The project-local settings file of the temporary repository (the default scope). */
  readonly localSettings: string;
  /** The decoy: a settings file of the temporary Claude home with a canary line. */
  readonly decoy: string;
  mcs(args: readonly string[], options?: { stdin?: string; env?: Record<string, string> }): Promise<Run>;
}

function sandbox(purpose: string): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(path.join(root, 'repo'));
  const skillDir = path.join(root, 'skill');
  const bundleDir = path.join(skillDir, 'bundle');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(path.join(skillDir, 'runtime'), { recursive: true });
  cpSync(path.join(template, 'bundle'), bundleDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  copyFileSync(
    path.join(defaultSkillDir(), 'runtime', 'defaults.json'),
    path.join(skillDir, 'runtime', 'defaults.json'),
  );
  const env = hermeticEnv(root);
  const claudeHome = env['CLAUDE_CONFIG_DIR'] ?? path.join(root, 'claude-home');
  mkdirSync(claudeHome, { recursive: true });
  const decoy = path.join(claudeHome, 'settings.json');
  writeFileSync(decoy, `${CANARY_LINE}\n`);
  const cliEntry = path.join(bundleDir, 'mcs-cli.mjs');
  const mcs: Sandbox['mcs'] = (args, options = {}) =>
    runCli(
      cliEntry,
      [...args, '--repo', repo],
      root,
      {
        ...env,
        ...options.env,
      },
      options.stdin,
    );
  return {
    root,
    repo,
    ws: path.join(repo, '.claude', 'monitor', 'tasks', SLUG),
    env,
    mcsHome: env['MCS_HOME'] ?? path.join(root, 'mcs-home'),
    claudeHome,
    bundleDir,
    cliEntry,
    localSettings: path.join(repo, '.claude', 'settings.local.json'),
    decoy,
    mcs,
  };
}

function runCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal: AbortSignal.timeout(90_000),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    child.once('error', (error) => {
      reject(new Error(`mcs ${args.join(' ')} did not finish: ${error.message}`));
    });
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function initTask(sb: Sandbox): Promise<void> {
  const port = await allocatePort();
  const run = await sb.mcs(['init', '--slug', SLUG, '--name', `FIXTURE ${SLUG}`, '--port', String(port)]);
  expect(run.code, run.stderr).toBe(0);
}

/** The one envelope of a `--json` run (stdout is exactly one JSON document). */
function envelopeOf(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

function instanceId(sb: Sandbox): string {
  return (JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;
}

function hooksOf(settings: string): Record<string, { hooks: { command?: string; args?: string[] }[] }[]> {
  const parsed = JSON.parse(settings) as {
    hooks: Record<string, { hooks: { command?: string; args?: string[] }[] }[]>;
  };
  return parsed.hooks;
}

describe('T-IN-10: the full cycle of the hooks commands in temporary folders', () => {
  it('dry run, install --yes, enable, verify, status, a plugin update, uninstall: the settings end byte equal to the original', async () => {
    const sb = sandbox('hooks-cycle');
    await initTask(sb);
    mkdirSync(path.dirname(sb.localSettings), { recursive: true });
    writeFileSync(sb.localSettings, ORIGINAL);

    // discover: no hooks yet
    const first = await sb.mcs(['discover']);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('hooks: not installed');

    // the dry run writes nothing, says that exec-form hooks need a release with `args`, and a pipe carrying the word is no consent
    const before = snapshotTree(sb.root);
    const dry = await sb.mcs(['hooks', 'install'], { stdin: 'install\n' });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('supports "args" in command hooks');
    expect(dry.stdout).toContain('dry run: nothing was written; re-run with --yes after the user agreed');
    expect(dry.stdout).toContain(`+ ${INSTALLED_HOOK_EVENTS[0]}`);
    expect(snapshotTree(sb.root)).toBe(before);
    expect(existsSync(sb.mcsHome)).toBe(false);

    const dryJson = envelopeOf(await sb.mcs(['hooks', 'install', '--json'], { stdin: 'install\n' }));
    expect(dryJson).toMatchObject({ schema: 'mcs.cli/1', command: 'hooks install', ok: true, exitCode: 0 });
    const plan = HooksApplyResultSchema.parse(dryJson.data);
    expect(plan).toMatchObject({ action: 'plan', scope: 'project-local' });
    expect(plan.added).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    expect(snapshotTree(sb.root)).toBe(before);

    // install --yes
    const applied = await sb.mcs(['hooks', 'install', '--yes', '--task', SLUG, '--json']);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    const result = HooksApplyResultSchema.parse(envelopeOf(applied).data);
    expect(result).toMatchObject({ action: 'applied', scope: 'project-local', script: { action: 'created' } });
    expect(result.backupPath).not.toBeNull();
    const settings = readFileSync(sb.localSettings, 'utf8');
    const hooks = hooksOf(settings);
    expect(Object.keys(hooks)).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    // the user's own hook is still there, ahead of ours
    expect(hooks['Stop']?.[0]?.hooks[0]?.command).toBe('echo FIXTURE user hook');
    expect((settings.match(/--mcs-hook/g) ?? []).length).toBe(INSTALLED_HOOK_EVENTS.length);
    // every entry names the stable copy in MCS_HOME and nothing below the bundle folder
    const copy = path.join(sb.mcsHome, 'hooks', 'mcs-hook.mjs');
    expect(readFileSync(copy).equals(readFileSync(path.join(sb.bundleDir, 'mcs-hook.mjs')))).toBe(true);
    expect(settings).not.toContain(sb.bundleDir.split(path.sep).join('/'));
    expect(readFileSync(path.join(sb.ws, 'audit', 'changes.md'), 'utf8')).toContain('| hooks-install');

    // discover now shows the install
    const second = await sb.mcs(['discover']);
    expect(second.stdout).toContain('hooks: installed (project-local)');
    expect(second.stdout).not.toContain('script stale');

    // enable routes the hooks to the task; verify runs the installed command with a probe
    const enabled = await sb.mcs(['hooks', 'enable', '--task', SLUG, '--json']);
    expect(enabled.code, enabled.stderr).toBe(0);
    expect(envelopeOf(enabled)).toMatchObject({ command: 'hooks enable', ok: true });
    expect(existsSync(path.join(sb.mcsHome, 'routes', `${instanceId(sb)}.json`))).toBe(true);
    const verified = await sb.mcs(['hooks', 'verify', '--task', SLUG, '--json']);
    expect(verified.code, verified.stdout + verified.stderr).toBe(0);
    const checks = HooksVerifyResultSchema.parse(envelopeOf(verified).data).checks;
    expect(checks.map((check) => [check.check, check.ok])).toEqual([
      ['V1', true],
      ['V2', true],
      ['V3', true],
      ['V4', true],
      ['V5', true],
      ['V6', true],
      ['V7', null],
    ]);
    expect(checks.find((check) => check.check === 'V4')?.detail).toContain(HANDLER_VERSION);

    // status
    const status = await sb.mcs(['hooks', 'status', '--task', SLUG, '--json']);
    const state = HooksStatusResultSchema.parse(envelopeOf(status).data);
    expect(state.installs).toHaveLength(1);
    expect(state.installs[0]).toMatchObject({ scope: 'project-local', events: INSTALLED_HOOK_EVENTS.length });
    expect(state.script.state).toBe('current');
    expect(typeof state.lastEnvelopeAt[instanceId(sb)]).toBe('number');
    const statusText = await sb.mcs(['hooks', 'status']);
    expect(statusText.stdout).toContain('mcs hooks uninstall');

    // a plugin update changes the bundled script: settings stay, the copy is refreshed only by the next install
    const settingsBefore = readFileSync(sb.localSettings);
    appendFileSync(path.join(sb.bundleDir, 'mcs-hook.mjs'), '\n// FIXTURE plugin update\n');
    expect((await sb.mcs(['discover'])).stdout).toContain('hooks: installed (project-local), script stale');
    const staleDry = await sb.mcs(['hooks', 'install']);
    expect(staleDry.stdout).toContain('would be refreshed');
    expect(readFileSync(copy).equals(readFileSync(path.join(sb.bundleDir, 'mcs-hook.mjs')))).toBe(false);
    const refreshed = await sb.mcs(['hooks', 'install', '--yes', '--json']);
    const refreshedResult = HooksApplyResultSchema.parse(envelopeOf(refreshed).data);
    expect(refreshedResult).toMatchObject({ action: 'noop', script: { action: 'refreshed' } });
    expect(readFileSync(sb.localSettings).equals(settingsBefore)).toBe(true);
    expect((await sb.mcs(['discover'])).stdout).toContain('hooks: installed (project-local)\n');

    // uninstall: the settings are as they were, the copy and the manifest go with the last install
    const gone = await sb.mcs(['hooks', 'uninstall', '--yes', '--task', SLUG, '--json']);
    expect(gone.code, gone.stdout + gone.stderr).toBe(0);
    const removed = HooksApplyResultSchema.parse(envelopeOf(gone).data);
    expect(removed).toMatchObject({ action: 'applied', script: { action: 'removed' } });
    expect(removed.removed).toHaveLength(INSTALLED_HOOK_EVENTS.length);
    expect(readFileSync(sb.localSettings, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(path.join(sb.mcsHome, 'hooks', 'installs.json'))).toBe(false);
    expect((await sb.mcs(['discover'])).stdout).toContain('hooks: not installed');
    const audit = readFileSync(path.join(sb.ws, 'audit', 'changes.md'), 'utf8');
    expect(audit).toContain('| hooks-enable');
    expect(audit).toContain('| hooks-uninstall');

    // the decoy next to the real work was never read or written
    expect(readFileSync(sb.decoy, 'utf8')).toBe(`${CANARY_LINE}\n`);
  }, 240_000);

  it('verify exits 1 and says which check failed once the stable copy is gone', async () => {
    const sb = sandbox('hooks-verify-fail');
    await initTask(sb);
    expect((await sb.mcs(['hooks', 'install', '--yes'])).code).toBe(0);
    expect((await sb.mcs(['hooks', 'enable', '--task', SLUG])).code).toBe(0);
    rmSync(path.join(sb.mcsHome, 'hooks', 'mcs-hook.mjs'));
    const run = await sb.mcs(['hooks', 'verify', '--task', SLUG, '--json']);
    expect(run.code).toBe(1);
    const envelope = envelopeOf(run);
    expect(envelope).toMatchObject({ ok: false, exitCode: 1, error: null });
    const checks = HooksVerifyResultSchema.parse(envelope.data).checks;
    expect(checks.some((check) => check.ok === false)).toBe(true);
    const text = await sb.mcs(['hooks', 'verify', '--task', SLUG]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('[FAIL] V3');
  }, 120_000);
});

describe('failures are one envelope with HOOKS_FAILED and a reason, usage errors exit 2', () => {
  it('shared project scope, a shared project settings file, invalid JSON and an invalid scope word', async () => {
    const sb = sandbox('hooks-failures');
    await initTask(sb);

    const project = await sb.mcs(['hooks', 'install', '--scope', 'project', '--json']);
    expect(project.code).toBe(1);
    expect(envelopeOf(project).error).toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'SCOPE_NOT_ALLOWED' } });

    const shared = path.join(sb.repo, '.claude', 'settings.json');
    const sharedRun = await sb.mcs(['hooks', 'install', '--settings-file', shared, '--yes', '--json']);
    expect(sharedRun.code).toBe(1);
    expect(envelopeOf(sharedRun).error).toMatchObject({
      code: 'HOOKS_FAILED',
      details: { reason: 'SCOPE_NOT_ALLOWED' },
    });
    expect(existsSync(shared)).toBe(false);

    mkdirSync(path.dirname(sb.localSettings), { recursive: true });
    writeFileSync(sb.localSettings, '{ not json');
    const invalid = await sb.mcs(['hooks', 'install', '--yes', '--json']);
    expect(invalid.code).toBe(1);
    expect(envelopeOf(invalid).error).toMatchObject({
      code: 'HOOKS_FAILED',
      details: { reason: 'SETTINGS_INVALID_JSON' },
    });
    expect(readFileSync(sb.localSettings, 'utf8')).toBe('{ not json');

    const bogus = await sb.mcs(['hooks', 'install', '--scope', 'machine', '--json']);
    expect(bogus.code).toBe(2);
    expect(envelopeOf(bogus).error).toMatchObject({ code: 'USAGE' });
    const both = await sb.mcs(['hooks', 'install', '--yes', '--dry-run', '--json']);
    expect(both.code).toBe(2);
    expect(envelopeOf(both).error).toMatchObject({ code: 'USAGE' });
    const mixed = await sb.mcs(['hooks', 'install', '--scope', 'user', '--settings-file', sb.localSettings, '--json']);
    expect(mixed.code).toBe(2);
    expect(envelopeOf(mixed).error).toMatchObject({ code: 'USAGE' });

    const slug = await sb.mcs(['hooks', 'enable', '--task', '../demo', '--json']);
    expect(slug.code).toBe(1);
    expect(envelopeOf(slug).error).toMatchObject({ code: 'SLUG_INVALID' });
    expect(readFileSync(sb.decoy, 'utf8')).toBe(`${CANARY_LINE}\n`);
  }, 120_000);

  it('--scope user is chosen only when it is asked for: the plan then names the settings file of the Claude home, and nothing is written', async () => {
    const sb = sandbox('hooks-user-scope');
    await initTask(sb);
    // the user settings file of the temporary Claude home: a plan reads it, never writes it
    writeFileSync(sb.decoy, ORIGINAL);
    const before = snapshotTree(sb.root);
    const run = await sb.mcs(['hooks', 'install', '--scope', 'user', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const plan = HooksApplyResultSchema.parse(envelopeOf(run).data);
    expect(plan.scope).toBe('user');
    expect(plan.settingsPath).toBe(sb.decoy.split(path.sep).join('/'));
    expect(plan.warnings.map((warning) => warning.code)).toContain('HOOKS_USER_SCOPE');
    expect(snapshotTree(sb.root)).toBe(before);
    expect(readFileSync(sb.decoy, 'utf8')).toBe(ORIGINAL);
    // without the flag the same call plans the project-local file
    const plain = HooksApplyResultSchema.parse(envelopeOf(await sb.mcs(['hooks', 'install', '--json'])).data);
    expect(plain.scope).toBe('project-local');
  }, 120_000);
});

describe('two commands at once', () => {
  it('two hooks install --yes on one settings file serialize: both exit 0 and the file holds one set of entries', async () => {
    const sb = sandbox('hooks-concurrent-install');
    await initTask(sb);
    const file = path.join(sb.root, 'elsewhere', 'settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, ORIGINAL);
    const runs = await Promise.all([
      sb.mcs(['hooks', 'install', '--yes', '--settings-file', file, '--json']),
      sb.mcs(['hooks', 'install', '--yes', '--settings-file', file, '--json']),
    ]);
    for (const run of runs) expect(run.code, run.stdout + run.stderr).toBe(0);
    const actions = runs.map((run) => HooksApplyResultSchema.parse(envelopeOf(run).data).action).sort();
    expect(actions).toEqual(['applied', 'noop']);
    expect((readFileSync(file, 'utf8').match(/--mcs-hook/g) ?? []).length).toBe(INSTALLED_HOOK_EVENTS.length);
  }, 120_000);

  it('two hooks enable on one task serialize: both exit 0, instance.json says enabled and the audit has one entry', async () => {
    const sb = sandbox('hooks-concurrent-enable');
    await initTask(sb);
    const runs = await Promise.all([
      sb.mcs(['hooks', 'enable', '--task', SLUG, '--json']),
      sb.mcs(['hooks', 'enable', '--task', SLUG, '--json']),
    ]);
    for (const run of runs) expect(run.code, run.stdout + run.stderr).toBe(0);
    const changed = runs.map((run) => (envelopeOf(run).data as { changed: boolean }).changed).sort();
    expect(changed).toEqual([false, true]);
    const instance = JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as {
      hooks: { enabled: boolean };
    };
    expect(instance.hooks.enabled).toBe(true);
    expect((readFileSync(path.join(sb.ws, 'audit', 'changes.md'), 'utf8').match(/\| hooks-enable/g) ?? []).length).toBe(
      1,
    );
    const off = await sb.mcs(['hooks', 'disable', '--task', SLUG]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout).toContain('hooks disabled');
  }, 120_000);
});

describe('T-IN-07 at the process level: the guard looks at the location of the settings file', () => {
  it('a child with a narrow temporary folder refuses a settings file outside it, touches nothing, and accepts one inside it', async () => {
    const sb = sandbox('hooks-guard');
    await initTask(sb);
    // the narrow temporary folder of the child: `os.tmpdir()` inside it is <root>/tmp, and MCS_HOME is below it
    const narrow = path.join(sb.root, 'tmp');
    mkdirSync(narrow, { recursive: true });
    // the decoy and its canary sibling lie in the test root but not in the narrow folder
    const outside = path.join(sb.root, 'outside');
    mkdirSync(outside, { recursive: true });
    const decoy = path.join(outside, 'settings.json');
    const sibling = path.join(outside, 'canary.txt');
    writeFileSync(decoy, `${CANARY_LINE}\n`);
    writeFileSync(sibling, `${CANARY_LINE} (sibling)\n`);
    const env = { TMPDIR: narrow, TEMP: narrow, TMP: narrow, MCS_HOME: path.join(narrow, 'mcs-home') };
    const treeBefore = snapshotTree(outside);

    const refused = await sb.mcs(['hooks', 'install', '--yes', '--settings-file', decoy, '--json'], { env });
    expect(refused.code, refused.stdout + refused.stderr).toBe(1);
    expect(envelopeOf(refused)).toMatchObject({
      ok: false,
      error: { code: 'HOOKS_FAILED', details: { reason: 'REAL_SETTINGS_IN_TEST' } },
    });
    expect(readFileSync(decoy, 'utf8')).toBe(`${CANARY_LINE}\n`);
    expect(readFileSync(sibling, 'utf8')).toBe(`${CANARY_LINE} (sibling)\n`);
    expect(snapshotTree(outside)).toBe(treeBefore);
    expect(existsSync(env.MCS_HOME)).toBe(false);

    // positive control: the same child, a settings file inside the narrow folder, exits 0 and writes it
    const inside = path.join(narrow, 'settings.json');
    const accepted = await sb.mcs(['hooks', 'install', '--yes', '--settings-file', inside, '--json'], { env });
    expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
    expect(HooksApplyResultSchema.parse(envelopeOf(accepted).data).action).toBe('applied');
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(path.join(env.MCS_HOME, 'hooks', 'mcs-hook.mjs'))).toBe(true);
    // and the other commands that write below MCS_HOME refuse a MCS_HOME outside the narrow folder the same way
    const strayHome = path.join(outside, 'mcs-home');
    const enable = await sb.mcs(['hooks', 'enable', '--task', SLUG, '--json'], {
      env: { ...env, MCS_HOME: strayHome },
    });
    expect(enable.code).toBe(1);
    expect(envelopeOf(enable).error).toMatchObject({
      code: 'HOOKS_FAILED',
      details: { reason: 'REAL_SETTINGS_IN_TEST' },
    });
    expect(existsSync(strayHome)).toBe(false);
  }, 120_000);
});
