// `start.bat` and `stop.bat` of the repository root on a real app instance (06 4, 6; ADR 0095). Windows only: the files are batch
// files. The batch files are the real ones and the launcher is the real `caw.mjs` of this checkout, which runs the built `dist/` of
// the packages (`MCS_LAUNCHER_MODE=dev`: the tracked bundle is stale until the lead rebuilds it). Everything lives in a temp
// root: `MCS_HOME`, the Claude home, the profile and the Windows folders of the user are temp folders, the port comes from the test
// range and is passed with `--port`, `CAW_NO_PROMPT=1` keeps every pause and question away, and `--no-open` opens no browser.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StateFileSchema } from '@mcs/shared';
import { allocatePort, assertPortClosed, hermeticEnv, httpRequest, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

interface Sandbox {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly instanceDir: string;
  readonly port: number;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const sandboxes: Sandbox[] = [];

async function sandbox(purpose: string): Promise<Sandbox> {
  const root = makeTemp(purpose).path;
  const base = hermeticEnv(root);
  const local = path.join(root, 'local');
  const roaming = path.join(root, 'roaming');
  mkdirSync(local, { recursive: true });
  mkdirSync(roaming, { recursive: true });
  const env: Record<string, string> = {
    ...base,
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    ComSpec: process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe',
    LOCALAPPDATA: local,
    APPDATA: roaming,
    MCS_LAUNCHER_MODE: 'dev',
    CAW_NODE_PATH: process.execPath,
    CAW_NO_PROMPT: '1',
  };
  const made: Sandbox = {
    root,
    env,
    instanceDir: path.join(env['MCS_HOME'] ?? '', 'instances', 'user'),
    port: await allocatePort(),
  };
  sandboxes.push(made);
  return made;
}

function bat(sb: Sandbox, file: string, args: readonly string[], extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync(sb.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', path.join(REPO, file), ...args], {
    cwd: sb.root,
    env: { ...sb.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 150_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readPid(sb: Sandbox): number | null {
  const file = path.join(sb.instanceDir, 'state.json');
  if (!existsSync(file)) return null;
  return StateFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).pid;
}

async function healthStatus(port: number): Promise<number> {
  return (await httpRequest(port, '/api/v3/health').catch(() => ({ status: 0 }))).status;
}

afterEach(async () => {
  // whatever a test left running is stopped the way a person would: the batch file, forced, then the pid as the last resort
  for (const sb of sandboxes.splice(0)) {
    if (readPid(sb) !== null) bat(sb, 'stop.bat', ['--force']);
    const pid = readPid(sb);
    if (pid !== null) spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    await assertPortClosed(sb.port).catch(() => undefined);
  }
});

describe.runIf(IS_WINDOWS)('start.bat and stop.bat on a real app instance', () => {
  it('start.bat --no-open starts the app and health answers; stop.bat stops it and the port closes', async () => {
    const sb = await sandbox('bat-int');
    const started = bat(sb, 'start.bat', ['--no-open', '--port', String(sb.port)]);
    expect(started.code, started.stderr + started.stdout).toBe(0);
    expect(started.stdout).toContain(`started: http://127.0.0.1:${String(sb.port)}/`);
    // nothing was opened and no login code was minted: the output does not hold one
    expect(started.stdout + started.stderr).not.toContain('#code=');
    expect(started.stdout).toContain('next: caw open');
    expect(await healthStatus(sb.port)).toBe(200);
    const pid = readPid(sb);
    expect(pid).not.toBeNull();

    const stopped = bat(sb, 'stop.bat', []);
    expect(stopped.code, stopped.stderr + stopped.stdout).toBe(0);
    await waitFor(async () => (await healthStatus(sb.port)) !== 200, {
      what: 'the app to stop answering',
      timeoutMs: 30_000,
    });
    expect(readPid(sb)).toBeNull();
  }, 240_000);

  it('start.bat on a running app reports it and exits 0 (a second start is not an error)', async () => {
    const sb = await sandbox('bat-int-twice');
    expect(bat(sb, 'start.bat', ['--no-open', '--port', String(sb.port)]).code).toBe(0);
    const again = bat(sb, 'start.bat', ['--no-open', '--port', String(sb.port)]);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    expect(readPid(sb)).not.toBeNull();
  }, 240_000);

  it('stop.bat on an app that never started says there is nothing to stop and exits 0', async () => {
    const sb = await sandbox('bat-int-nothing');
    const stopped = bat(sb, 'stop.bat', []);
    expect(stopped.code, stopped.stderr + stopped.stdout).toBe(0);
    expect(stopped.stdout).toContain('nothing to stop');
  }, 120_000);

  it('with live terminals (two scripted sessions) and CAW_NO_PROMPT stop.bat exits 3 and the app keeps running; --force ends it', async () => {
    const sb = await sandbox('bat-int-live');
    const hook = { MCS_TEST_FAKE_TERMINALS: '2' };
    const started = bat(sb, 'start.bat', ['--no-open', '--port', String(sb.port)], hook);
    expect(started.code, started.stderr + started.stdout).toBe(0);
    const pid = readPid(sb);
    expect(pid).not.toBeNull();

    const refused = bat(sb, 'stop.bat', []);
    expect(refused.code, refused.stderr + refused.stdout).toBe(3);
    expect(refused.stderr).toContain('terminal');
    expect(await healthStatus(sb.port)).toBe(200);
    expect(readPid(sb)).toBe(pid);

    const forced = bat(sb, 'stop.bat', ['--force']);
    expect(forced.code, forced.stderr + forced.stdout).toBe(0);
    await waitFor(async () => (await healthStatus(sb.port)) !== 200, {
      what: 'the app to stop answering',
      timeoutMs: 30_000,
    });
  }, 240_000);
});
