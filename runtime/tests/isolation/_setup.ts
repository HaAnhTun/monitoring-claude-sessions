// Shared setup of the isolation suite (05 4.8, 01 3.5): two real instances, A and B, on the real built CLI and server, with
// a teardown that stops both and proves that both ports are closed. Every instance lives in a temp root with the hermetic
// environment (`MCS_HOME`, `CLAUDE_CONFIG_DIR` and `HOME` in the temp root, hooks off), on a port of the test range, and every
// CLI call passes `--repo <temp repo>`; nothing touches a real workspace, a real Claude home or the owner's monitors.
//
// Importing this file registers one `afterEach` that stops every instance started through it and then kills what is left
// (`killAllTracked`), so a test that fails half way never leaves a listener or a process behind. The test files assert on
// behaviour that is the same on Windows, Linux and macOS: no shell, no drive letter and no process tool appears in an assertion.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutOfRuntimeDir, listRuntimeProcesses, type RuntimeProcess } from '@mcs/engine';
import { RUNTIME_VERSION, StateFileSchema, type StateFile } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildRepo,
  createUserSandbox,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  runCli,
  startInstance,
  useTempDirs,
  type StartedInstance,
  type UserInstance,
  type UserSandbox,
} from '@mcs/testkit';
import { afterEach } from 'vitest';

const makeTemp = useTempDirs();

/** `<skill>/runtime`: this file sits in `tests/isolation`, two levels below it. */
export const RUNTIME_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');

/** The server entry of the built runtime, for the rows that start `serve` by hand (T-ISO-20). */
export function serverEntryPath(): string {
  return layoutOfRuntimeDir(RUNTIME_DIR).serverEntry;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One initialised workspace with its own temp repo (or a task of a shared repo) and the hermetic environment. */
export interface IsolatedWorkspace {
  readonly slug: string;
  readonly repo: string;
  /** The workspace folder `<repo>/.claude/monitor/tasks/<slug>`. */
  readonly dir: string;
  readonly env: Record<string, string>;
  /** The port written to the configuration by `init` (a start passes it again with `--port`). */
  readonly configuredPort: number;
  /** The `instanceId` of `instance.json`. */
  readonly instanceId: string;
  /** `state.json` of the workspace. */
  readonly statePath: string;
  /** `data/monitor.db` of the workspace. */
  readonly dbPath: string;
  /** `mcs <args> --repo <repo>` with the hermetic environment. */
  mcs(args: readonly string[]): Promise<CliRun>;
  /** `mcs start --task <slug> --port <port>` to its end (default port: the configured one); `stop` is registered for the teardown. */
  startRaw(port?: number): Promise<CliRun>;
  /** `mcs stop --task <slug>` to its end. */
  stopRaw(): Promise<CliRun>;
  /** `startInstance` of the testkit: a started instance that waited for health 200. */
  start(port?: number): Promise<RunningInstance>;
  /** `state.json` parsed, or `null` when it is missing or unusable. */
  readState(): StateFile | null;
  /** The bytes of `state.json`, or `null`. */
  stateBytes(): Buffer | null;
  /** The processes whose command line carries the runtime marker of this instance. */
  markerProcesses(): Promise<RuntimeProcess[]>;
  /** `GET /api/v3/health` on `port`: the status and the `instanceId` of the body (`null` when the body names none). */
  health(port: number): Promise<{ status: number; instanceId: string | null }>;
}

export interface RunningInstance extends IsolatedWorkspace {
  readonly port: number;
  readonly pid: number;
  readonly handle: StartedInstance;
}

export interface TwoWorkspaces {
  readonly a: IsolatedWorkspace;
  readonly b: IsolatedWorkspace;
}

export interface TwoInstances {
  readonly a: RunningInstance;
  readonly b: RunningInstance;
  /** Stops both (a failure of one never spares the other) and asserts that both ports are closed; safe to call twice. */
  teardown(): Promise<void>;
}

export interface PairOptions {
  /** Both tasks live in one repository (`<repo>/.claude/monitor/tasks/{a,b}`); default: two repositories. */
  readonly sameRepo?: boolean;
  /** Both tasks are configured with the same port (T-ISO-18); default: two ports. */
  readonly samePort?: boolean;
}

const stops: (() => Promise<void>)[] = [];

/** Stops every instance started through this file, then kills what is left. Runs after each test. */
async function stopEverything(): Promise<void> {
  const todo = stops.splice(0);
  for (const stop of todo) {
    try {
      await stop();
    } catch {
      // the next step kills what is left; the test already failed or its own teardown reported the problem
    }
  }
  await killAllTracked();
}

afterEach(stopEverything);

function readInstanceId(dir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'instanceId' in parsed &&
    typeof parsed.instanceId === 'string'
  ) {
    return parsed.instanceId;
  }
  throw new Error(`no instanceId in ${join(dir, 'instance.json')}`);
}

function readStateOf(statePath: string): Buffer | null {
  try {
    return readFileSync(statePath);
  } catch {
    return null;
  }
}

/** The processes that carry the runtime marker of one instance: by instance id, or by the folder name of the workspace. */
export async function markerProcesses(
  target: string | Pick<IsolatedWorkspace, 'instanceId'>,
): Promise<RuntimeProcess[]> {
  const found = await listRuntimeProcesses(null);
  return typeof target === 'string'
    ? found.filter((p) => p.instanceDir !== null && basename(p.instanceDir.replace(/[\\/]+$/, '')) === target)
    : found.filter((p) => p.instanceId === target.instanceId);
}

async function initWorkspace(
  root: string,
  repo: string,
  slug: string,
  env: Record<string, string>,
  port: number,
): Promise<IsolatedWorkspace> {
  const mcsHome = env['MCS_HOME'];
  if (mcsHome === undefined) throw new Error('hermeticEnv gave no MCS_HOME');
  const mcs = (args: readonly string[]): Promise<CliRun> =>
    runCli([...args, '--repo', repo], { mcsHome, env, cwd: root });
  const made = await mcs(['init', '--name', `FIXTURE task ${slug}`, '--slug', slug, '--port', String(port)]);
  if (made.code !== 0)
    throw new Error(`init of task ${slug} exited ${String(made.code)}: ${made.stderr || made.stdout}`);
  const dir = join(repo, '.claude', 'monitor', 'tasks', slug);
  const statePath = join(dir, 'state.json');
  const instanceId = readInstanceId(dir);
  const ws: IsolatedWorkspace = {
    slug,
    repo,
    dir,
    env,
    configuredPort: port,
    instanceId,
    statePath,
    dbPath: join(dir, 'data', 'monitor.db'),
    mcs,
    stopRaw: () => mcs(['stop', '--task', slug]),
    startRaw: async (at = port) => {
      stops.push(async () => {
        await mcs(['stop', '--task', slug]);
      });
      return mcs(['start', '--task', slug, '--port', String(at)]);
    },
    start: async (at = port) => {
      const handle = await startInstance({ repo, slug, env }, { port: at });
      stops.push(() => handle.stop());
      return { ...ws, port: at, pid: handle.pid, handle };
    },
    readState: () => {
      const bytes = readStateOf(statePath);
      if (bytes === null) return null;
      try {
        return StateFileSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        return null;
      }
    },
    stateBytes: () => readStateOf(statePath),
    markerProcesses: () => markerProcesses({ instanceId }),
    health: async (at) => {
      const reply = await httpRequest(at, '/api/v3/health');
      let id: string | null = null;
      try {
        const body: unknown = JSON.parse(reply.body);
        if (typeof body === 'object' && body !== null && 'instanceId' in body && typeof body.instanceId === 'string') {
          id = body.instanceId;
        }
      } catch {
        // not JSON: the status tells
      }
      return { status: reply.status, instanceId: id };
    },
  };
  return ws;
}

/**
 * Two initialised workspaces A and B (slugs `a` and `b`) that are not started: temp root, hermetic environment, the real `init`.
 * Ports come from `allocatePort()`; `samePort` gives both the same configured port.
 */
export async function twoWorkspaces(opts: PairOptions = {}): Promise<TwoWorkspaces> {
  const root = makeTemp('iso-pair').path;
  const env = hermeticEnv(root);
  mkdirSync(env['HOME'] ?? join(root, 'home'), { recursive: true });
  const repoA = buildRepo(join(root, opts.sameRepo === true ? 'repo' : 'repo-a')).repo;
  const repoB = opts.sameRepo === true ? repoA : buildRepo(join(root, 'repo-b')).repo;
  const portA = await allocatePort();
  const portB = opts.samePort === true ? portA : await allocatePort();
  const a = await initWorkspace(root, repoA, 'a', env, portA);
  const b = await initWorkspace(root, repoB, 'b', env, portB);
  return { a, b };
}

/**
 * Instances A and B started with the real `$MCS start` on distinct ports, each answering health 200. The teardown stops both
 * and asserts both ports closed (the registered `afterEach` does the same for a test that never reaches its teardown).
 */
export async function twoInstances(opts: Pick<PairOptions, 'sameRepo'> = {}): Promise<TwoInstances> {
  const { a, b } = await twoWorkspaces(opts);
  const runningA = await a.start();
  const runningB = await b.start();
  let done = false;
  return {
    a: runningA,
    b: runningB,
    teardown: async () => {
      if (done) return;
      done = true;
      const failures: string[] = [];
      for (const running of [runningA, runningB]) {
        try {
          await running.handle.stop();
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      for (const running of [runningA, runningB]) {
        try {
          await assertPortClosed(running.port);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (failures.length > 0) throw new Error(`teardown of the two instances failed: ${failures.join('; ')}`);
    },
  };
}

// ---- the user instance beside tasks (06 section 6, isolation) ----------------------------------------------------------------------

/** The app instance of one temp per-user folder, with tasks that share its environment. */
export interface UserFixture {
  /** The hermetic root of the app (the testkit harness): its CLI, its paths, its port. Not started. */
  readonly sandbox: UserSandbox;
  /** `MCS_HOME` of the root. */
  readonly mcsHome: string;
  /** The `instanceId` of the app's `instance.json`. */
  readonly instanceId: string;
  /** Starts the app (`start --user --no-open`); the harness stops it after the test. */
  start(): Promise<UserInstance>;
  /**
   * A task of a repository inside the same root, initialised with the environment of the app: one `MCS_HOME`, one Claude home,
   * so the two kinds of instance can meet. `repo` names the repository folder (default `repo`).
   */
  task(slug: string, repo?: string): Promise<IsolatedWorkspace>;
}

/**
 * The `userInstance` fixture: a sandbox of the user-instance harness (temp root, the hermetic environment with the Windows
 * folders, a port of the test range, the proof that the CLI resolves the app inside the root) that is configured and not started.
 * Its cleanup is registered with `killAllTracked`, which the `afterEach` of this file runs after the tasks were stopped.
 */
export async function userInstance(purpose = 'iso-user'): Promise<UserFixture> {
  const sandbox = await createUserSandbox({ purpose });
  const env = { ...sandbox.env };
  return {
    sandbox,
    mcsHome: sandbox.paths.mcsHome,
    instanceId: readInstanceId(sandbox.paths.instanceDir),
    start: () => sandbox.start(),
    task: async (slug, repo = 'repo') =>
      initWorkspace(sandbox.root, buildRepo(join(sandbox.root, repo)).repo, slug, env, await allocatePort()),
  };
}

/** `cpSync` of a workspace to a new folder name, without its runtime state (`data/`, `run/`, `state.json`): a copied workspace (01 3.4). */
export function copyWorkspaceAs(from: IsolatedWorkspace, to: string): string {
  const dest = join(from.repo, '.claude', 'monitor', 'tasks', to);
  cpSync(from.dir, dest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(from.dir.length).replaceAll('\\', '/');
      return !(
        rel === '/data' ||
        rel.startsWith('/data/') ||
        rel === '/run' ||
        rel.startsWith('/run/') ||
        rel === '/state.json'
      );
    },
  });
  const task = join(dest, 'task.json');
  const parsed = JSON.parse(readFileSync(task, 'utf8')) as Record<string, unknown>;
  parsed['id'] = to;
  writeFileSync(task, `${JSON.stringify(parsed, null, 2)}\n`);
  return dest;
}

/** A state file that names `pid`, `port` and `url` as a crashed server (or a reused pid) would leave it, for the instance of `ws`. */
export function writeStateNaming(
  ws: IsolatedWorkspace,
  named: { readonly pid: number; readonly port: number; readonly instanceId?: string },
): void {
  const state = {
    pid: named.pid,
    url: `http://127.0.0.1:${String(named.port)}`,
    port: named.port,
    started: 1_700_000_000.5,
    version: RUNTIME_VERSION,
    task: ws.slug,
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId: named.instanceId ?? ws.instanceId,
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
  };
  mkdirSync(ws.dir, { recursive: true });
  writeFileSync(ws.statePath, `${JSON.stringify(state, null, 2)}\n`);
}
