// Fixtures of the isolation suite (05 4.4, registry C33): hermetic env, real instances, impostors and links.
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { httpRequest } from './http.ts';
import { assertPortClosed } from './ports.ts';
import { baseEnv, killPidTree, onKillAll, runCli, spawnTracked, type TrackedProcess } from './processes.ts';
import { waitFor } from './wait.ts';

/**
 * Minimal environment of a test process: PATH and the Windows system variables, `HOME`/`USERPROFILE` in `<root>/home`,
 * `MCS_HOME=<root>/mcs-home`, `CLAUDE_CONFIG_DIR=<root>/claude-home`, `MCS_HOOK_DISABLE=1`, `MCS_TEST=1`, `TZ=UTC`. Nothing
 * named `MCS_*` or `CLAUDE_*` of the parent is inherited. Pure: it creates nothing.
 *
 * `MCS_TEST=1` is test mode: the hooks installer then refuses every settings file and `MCS_HOME` that is not below the
 * temporary folder (`REAL_SETTINGS_IN_TEST`), so no child process of a test can write real settings. It also makes the
 * `MCS_TEST_*` hooks of the runtime act, but only when a test sets one. A test that proves such a hook inert without test
 * mode passes `MCS_TEST: ''` after the spread of this environment.
 */
export function hermeticEnv(root: string): Record<string, string> {
  return {
    ...baseEnv(),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    MCS_HOME: join(root, 'mcs-home'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
    MCS_HOOK_DISABLE: '1',
    MCS_TEST: '1',
  };
}

export interface StartedInstance {
  readonly repo: string;
  readonly slug: string;
  readonly port: number;
  readonly pid: number;
  stop(): Promise<void>;
}

export interface InstanceWorkspace {
  repo: string;
  slug: string;
  env: Record<string, string>;
}

/** Arguments of the real `$MCS start` for one task (01 6.3: `start --task <slug> --port <n>`). */
export function startArgs(ws: Pick<InstanceWorkspace, 'repo' | 'slug'>, port: number): string[] {
  return ['start', '--task', ws.slug, '--repo', ws.repo, '--port', String(port)];
}

function stopArgs(ws: Pick<InstanceWorkspace, 'repo' | 'slug'>): string[] {
  return ['stop', '--task', ws.slug, '--repo', ws.repo];
}

function pidOf(ws: Pick<InstanceWorkspace, 'repo' | 'slug'>, stdout: string): number {
  const fromOutput = /\(pid (\d+)\)/.exec(stdout);
  if (fromOutput?.[1] !== undefined) return Number(fromOutput[1]);
  const state: unknown = JSON.parse(
    readFileSync(join(ws.repo, '.claude', 'monitor', 'tasks', ws.slug, 'state.json'), 'utf8'),
  );
  if (typeof state === 'object' && state !== null && 'pid' in state && typeof state.pid === 'number') return state.pid;
  throw new Error(`startInstance: cannot find the pid of task ${ws.slug} in the start output or state.json`);
}

/**
 * Starts a real instance through the CLI (`$MCS start`), waits for `/api/v3/health` to answer 200 and returns a handle.
 * `stop()` runs `$MCS stop` and asserts the port is closed; `killAllTracked` runs it too.
 */
export async function startInstance(ws: InstanceWorkspace, opts: { port: number }): Promise<StartedInstance> {
  const mcsHome = ws.env['MCS_HOME'];
  if (mcsHome === undefined) throw new Error('startInstance: ws.env needs MCS_HOME (use hermeticEnv)');
  const started = await runCli(startArgs(ws, opts.port), { mcsHome, env: ws.env });
  if (started.code !== 0) {
    throw new Error(`startInstance: \`start\` exited ${String(started.code)}: ${started.stderr || started.stdout}`);
  }
  // The server now runs detached from this process. The cleanup is registered before anything can fail or time out, so
  // `killAllTracked` always finds it; when the polite stop fails (a loaded machine, a timed-out test) it ends the tree by pid.
  let found: number | undefined;
  try {
    found = pidOf(ws, started.stdout);
  } catch {
    // reported after the health check, once the cleanup is in place
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      const result = await runCli(stopArgs(ws), { mcsHome, env: ws.env });
      if (result.code !== 0)
        throw new Error(`startInstance: \`stop\` exited ${String(result.code)}: ${result.stderr || result.stdout}`);
      await assertPortClosed(opts.port);
    } catch (error) {
      if (found !== undefined) killPidTree(found);
      throw error;
    }
  };
  onKillAll(stop);
  await waitFor(async () => (await httpRequest(opts.port, '/api/v3/health')).status === 200, {
    what: `health of task ${ws.slug} on port ${String(opts.port)}`,
    timeoutMs: 20_000,
    intervalMs: 100,
  });
  const pid = found ?? pidOf(ws, started.stdout);
  return { repo: ws.repo, slug: ws.slug, port: opts.port, pid, stop };
}

/**
 * An idle Node process whose command line ends with `argv`: simulates a reused pid that looks like an instance
 * (T-ISO-22, 01 4.9). Killed by `killAllTracked`.
 */
export function spawnImpostor(argv: readonly string[]): TrackedProcess {
  return spawnTracked(process.execPath, ['-e', 'setInterval(()=>{},60000)', '--', ...argv]);
}

/** A directory link: a junction on Windows (`fs.symlinkSync(target, link, 'junction')`, no shell, no privilege), a symlink elsewhere. */
export function makeJunction(link: string, target: string): void {
  symlinkSync(resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir');
}
