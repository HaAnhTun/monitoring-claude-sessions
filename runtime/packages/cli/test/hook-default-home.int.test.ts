// WP-87: the hook stub of a temp skill copy and the runtime agree on the default MCS_HOME (02 2.6.1). The stub runs with a
// payload on stdin, HOME (and on win32 USERPROFILE and LOCALAPPDATA) in temp folders and no MCS_HOME; its spool line lands
// through the route stored under the folder `resolveMcsHome` returns for the same environment, with and without
// XDG_STATE_HOME, and a stub without a handler logs HANDLER_UNAVAILABLE under that same folder. Runs on every OS.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMcsHome, routeKey, type HookRouteV1 } from '@mcs/shared/protocol';
import { buildRepo, buildTaskWorkspace, hookPayload, useTempDirs } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const SID = '11111111-2222-4333-8444-555555555555';
const INSTANCE = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const win32 = process.platform === 'win32';
const fwd = (p: string): string => p.split(sep).join('/');
/** `<skill>/`: this file sits in `<skill>/runtime/packages/cli/test`. */
const SKILL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let buildRoot = '';
let bundledHook = '';

beforeAll(async () => {
  buildRoot = mkdtempSync(join(tmpdir(), 'mcs-hook-home-'));
  await buildBundle({
    outDir: join(buildRoot, 'bundle'),
    entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' },
    web: false,
  });
  bundledHook = join(buildRoot, 'bundle', 'mcs-hook.mjs');
}, 120_000);

afterAll(() => {
  if (buildRoot !== '') rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A temp skill copy: the committed stub in `scripts/`, the fresh handler bundle in `bundle/` (unless `withHandler` is false). */
function skillCopy(root: string, withHandler: boolean): string {
  const scripts = join(root, 'skill', 'scripts');
  mkdirSync(scripts, { recursive: true });
  const stub = join(scripts, 'mcs-hook.mjs');
  copyFileSync(join(SKILL_ROOT, 'skills', 'monitoring-claude-sessions', 'scripts', 'mcs-hook.mjs'), stub);
  if (withHandler) {
    mkdirSync(join(root, 'skill', 'bundle'));
    copyFileSync(bundledHook, join(root, 'skill', 'bundle', 'mcs-hook.mjs'));
  }
  return stub;
}

function baseEnv(root: string, xdg: boolean): Record<string, string> {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { TZ: 'UTC', HOME: home };
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (win32) {
    env['USERPROFILE'] = home;
    if (xdg) env['LOCALAPPDATA'] = join(root, 'local-app-data');
  } else if (xdg) {
    env['XDG_STATE_HOME'] = join(root, 'xdg-state');
  }
  return env;
}

function run(stub: string, env: Record<string, string>, stdin: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', stub, '--mcs-hook', 'Stop'], {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code);
    });
  });
}

/** Writes the route of a workspace into `<home>/routes` and returns the spool folder and a matching payload. */
function routeUnder(root: string, mcsHome: string): { spoolDir: string; payload: string } {
  const { repo } = buildRepo(join(root, 'repo'));
  const workspace = fwd(buildTaskWorkspace(repo, { slug: 'task-a', config: {}, instance: { instanceId: INSTANCE } }));
  const transcriptsDir = fwd(join(root, 'claude', 'projects', 'proj'));
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(join(mcsHome, 'routes'), { recursive: true });
  const route: HookRouteV1 = {
    v: 1,
    instanceId: INSTANCE,
    workspace,
    spoolDir: `${workspace}/data/spool`,
    stateFile: `${workspace}/state.json`,
    enabled: true,
    match: { transcriptsDirs: [routeKey(transcriptsDir)], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: Date.now(),
  };
  writeFileSync(join(mcsHome, 'routes', `${INSTANCE}.json`), JSON.stringify(route));
  const base = { sessionId: SID, cwd: fwd(repo), transcriptPath: `${transcriptsDir}/${SID}.jsonl` };
  return { spoolDir: route.spoolDir, payload: JSON.stringify(hookPayload('Stop', base)) };
}

function spoolLineCount(spoolDir: string): number {
  if (!existsSync(spoolDir)) return 0;
  return readdirSync(spoolDir)
    .flatMap((name) => readFileSync(join(spoolDir, name), 'utf8').split('\n'))
    .filter((line) => line !== '').length;
}

describe.each([
  [win32 ? 'LOCALAPPDATA unset' : 'XDG_STATE_HOME unset', false],
  [win32 ? 'LOCALAPPDATA set' : 'XDG_STATE_HOME set', true],
])('the hook stub without MCS_HOME (%s)', (_name, xdg) => {
  it('spools through the route stored under resolveMcsHome of the same environment', async () => {
    const root = makeTemp('hook-home').path;
    const env = baseEnv(root, xdg);
    const home = resolveMcsHome(env);
    expect(home.startsWith(fwd(root)) || home.startsWith(root)).toBe(true);
    const { spoolDir, payload } = routeUnder(root, home);
    expect(await run(skillCopy(root, true), env, payload)).toBe(0);
    expect(spoolLineCount(spoolDir)).toBe(1);
  }, 30_000);

  it('logs HANDLER_UNAVAILABLE under the same folder when the skill copy has no handler', async () => {
    const root = makeTemp('hook-home-nohandler').path;
    const env = baseEnv(root, xdg);
    expect(await run(skillCopy(root, false), env, '{}')).toBe(0);
    const log = join(resolveMcsHome(env), 'logs', 'hook-handler.jsonl');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('HANDLER_UNAVAILABLE');
  }, 30_000);
});
