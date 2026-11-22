// The user-instance harness (design 08 section 3.2, design 06 section 6): one real app instance (`caw start`) inside a hermetic
// temp root, driven only through the built CLI and HTTP. It lives in the testkit because it imports no engine code: the stack,
// browser and benchmark suites build on it.
//
//   const app = await startUserInstance();              // sandbox + `start --user --no-open --json`, health 200
//   const cookie = await app.exchange();                // `open --print --json` -> a fresh single-use code -> the session cookie
//   const session = await app.createSession(app.project('demo'));
//   const { client } = await app.ws(session.name);      // RawWsClient after `ready` and `live`
//   app.fakeLog().count('start');                       // what the fake claude saw (fake-log.ts)
//   await app.restart();                                // `restart --user --force --no-open`, waits for health, new pid
//   await app.stop();                                   // `stop --user`, then: port closed, no process of the root, temp tree gone
//
// `createUserSandbox()` is the same root without a start (`runCli`, `runJson`, `start()`): the lifecycle tests use it to look at an
// app that never ran. Both register their cleanup with `killAllTracked`, so a test file needs `afterEach(killAllTracked)` and
// nothing else. What the app should find when it starts (monitored sessions from `buildClaudeHome(paths.claudeHome)`, the DA
// memory below `paths.home`, registry entries) is written by the `prepare` option, or between `createUserSandbox()` and `start()`.
//
// The temp root: `home/` (HOME, USERPROFILE, with `AppData/Roaming` as APPDATA and `AppData/Local` as LOCALAPPDATA),
// `claude-home/` (CLAUDE_CONFIG_DIR), `mcs-home/` (MCS_HOME; the instance is `mcs-home/instances/user`), `fakebin/` (the fake
// claude and its launchers, first on a PATH that cannot reach a real claude), `projects/FIXTURE-<name>/` (folders for sessions),
// `fake-claude.log` (FAKE_CLAUDE_LOG) and `opened-urls.txt` (MCS_TEST_OPEN_FILE: a browser is never opened, even by a call that
// forgets `--no-open`). The port comes from `allocatePort` (18000-18999) and is written to the configuration with `config set
// server.port` before the first start, with `server.portScan` 0, so the app binds that port or fails. `terminal.*` options are
// written the same way (`config set` for the keys it knows, `configure --user --set` for the others).
//
// SAFETY. A person's real app instance may be running on this machine (port 7690, `<per-user folder>/instances/user`), and `start`,
// `stop` and `restart` act on the user instance of whatever environment they are given. So:
//   1. every CLI call gets exactly the sandbox environment; `assertHermeticEnv` throws before a process starts when a home
//      variable is missing or leaves the temp root, when test mode is off, or when the instance folder is not below the root;
//   2. `assertTestPort` and `assertSafeCliArgs` throw for port 7690 and for every port outside 18000-18999, wherever it is named;
//   3. before the first command that changes anything, `proveHermetic` runs the read-only `status --user` and requires "not
//      running", a folder below the temp root and no mention of port 7690 or of the real per-user folder;
//   4. the harness kills by pid only what a scan just found with the name of its own temp root in the command line.
// The access code is a password for the terminals: `accessUrl()` returns it in memory, nothing here writes or logs it, and no
// error text carries it.
//
// Not for tests of `POST /api/v3/terminal/open-native`: on a real instance that route opens a window of the person's terminal.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { CliEnvelopeSchema, type CliEnvelope } from '@mcs/shared';
import { LOGIN_URL_RE } from '@mcs/shared/protocol';

import { assertClaudeFree, installFakeClaude, terminalEnv, type FakeClaudeFlavour } from '../fake-claude/install.ts';
import { httpRequest, type HttpReply } from '../http.ts';
import { allocatePort, assertPortClosed, type PortRange } from '../ports.ts';
import { cliEntryPath, killPidTree, onKillAll, runProcess, type CliResult } from '../processes.ts';
import { makeTempDir, type TempDir } from '../temp.ts';
import { waitFor } from '../wait.ts';
import { readFakeLog, type FakeLog } from './fake-log.ts';
import { MIN_MARKER_LENGTH, findProcesses, type FoundProcess } from './process-scan.ts';
import { scaled } from './pty-support.ts';
import { openTerminalSocket, type OpenedTerminalSocket } from './ws-client.ts';

// ---- the guards ------------------------------------------------------------------------------------------------------------------

/** The only ports a harness instance may use: the range of `allocatePort`. */
export const USER_INSTANCE_PORTS: PortRange = [18000, 18999];
/** The default port of the product, where a person's real app listens. Never used, never named in a command. */
export const PRODUCT_DEFAULT_PORT = 7690;
/** The variables that decide where the CLI and the server read and write: each must be an absolute path below the temp root. */
export const HERMETIC_PATH_VARIABLES = [
  'MCS_HOME',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * The comparison form of a path: absolute, links and Windows short names resolved for the part that exists, lower case where the
 * file system ignores case. Two spellings of one place give one text.
 */
function canonical(target: string): string {
  const absolute = path.resolve(target);
  const tail: string[] = [];
  let existing = absolute;
  let real: string | null = null;
  for (;;) {
    try {
      real = realpathSync.native(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const joined = path.join(real ?? existing, ...tail);
  return FOLD_CASE ? joined.toLowerCase() : joined;
}

/** True when `child` is `parent` or lies below it (canonical comparison). */
function isWithin(child: string, parent: string): boolean {
  const inner = canonical(child);
  const outer = canonical(parent);
  if (inner === outer) return true;
  const relative = path.relative(outer, inner);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The per-user folders of the person who runs the tests, as the product would resolve them from the environment of this process
 * (`MCS_HOME`, `%LOCALAPPDATA%\mcs`, the profile, the XDG state folder). A harness instance must never live in one of them.
 */
export function realPerUserFolders(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const found: string[] = [];
  const add = (base: string | undefined, ...parts: string[]): void => {
    if (base !== undefined && base !== '' && path.isAbsolute(base)) found.push(path.join(base, ...parts));
  };
  add(env['MCS_HOME']);
  add(env['LOCALAPPDATA'], 'mcs');
  add(env['USERPROFILE'], 'AppData', 'Local', 'mcs');
  add(env['XDG_STATE_HOME'], 'mcs');
  add(env['HOME'], '.local', 'state', 'mcs');
  add(env['HOME'], 'AppData', 'Local', 'mcs');
  add(homedir(), 'AppData', 'Local', 'mcs');
  add(homedir(), '.local', 'state', 'mcs');
  return found;
}

/**
 * True when `text` names the default port of the product as a number of its own: `:7690/`, `"configured_port": 7690`,
 * `7690 was busy`. The same digits inside an instance id or a folder name (next to a letter, a digit or a dash) are not a port.
 */
export function mentionsProductPort(text: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${String(PRODUCT_DEFAULT_PORT)}(?![A-Za-z0-9_-])`).test(text);
}

/**
 * Ends the process trees of `found`, the result of a scan for `marker` (the name of a harness's own temp root). It first checks
 * every entry: one whose command line does not carry the marker, or the process of this test run itself, and nothing at all is
 * killed. `kill` is `killPidTree`; a test passes a recorder.
 */
export function killOwned(
  found: readonly FoundProcess[],
  marker: string,
  kill: (pid: number) => void = killPidTree,
): void {
  if (marker.length < MIN_MARKER_LENGTH)
    refuse('the marker of the processes to kill is too short to be the name of a temp root');
  for (const entry of found) {
    if (!entry.commandLine.includes(marker))
      refuse(`pid ${String(entry.pid)} does not carry the marker of this harness`);
    if (entry.pid === process.pid || entry.pid === process.ppid)
      refuse('the scan named the process of the test run itself');
  }
  for (const entry of found) kill(entry.pid);
}

function refuse(reason: string): never {
  throw new Error(`user-instance harness: refusing to act: ${reason}`);
}

/** Throws unless `port` is a whole number inside 18000-18999 (so never 7690). */
export function assertTestPort(port: number): void {
  if (port === PRODUCT_DEFAULT_PORT) refuse(`port ${String(PRODUCT_DEFAULT_PORT)} is the port of a person's real app`);
  const [min, max] = USER_INSTANCE_PORTS;
  if (!Number.isInteger(port) || port < min || port > max) {
    refuse(`port ${String(port)} is outside the test range ${String(min)}-${String(max)}`);
  }
}

/**
 * Throws unless `root` is a temp root of the testkit (below the temp folder of the system, with the `FIXTURE.md` marker of
 * `makeTempDir`) that is not, and does not lie in, a real per-user folder.
 */
export function assertTempRoot(root: string, real: readonly string[] = realPerUserFolders()): void {
  if (!path.isAbsolute(root)) refuse('the root is not an absolute path');
  const temp = tmpdir();
  if (!isWithin(root, temp) || canonical(root) === canonical(temp)) {
    refuse('the root is not a folder below the temp folder of the system');
  }
  if (!existsSync(path.join(root, 'FIXTURE.md')))
    refuse('the root has no FIXTURE.md marker (it was not made by makeTempDir)');
  for (const folder of real) {
    if (isWithin(root, folder) || isWithin(folder, root)) refuse('the root overlaps a real per-user folder');
  }
}

/**
 * Throws unless `env` keeps every process inside `root`: each of {@link HERMETIC_PATH_VARIABLES} is an absolute path below the
 * root, test mode is on (`MCS_TEST=1`, which also keeps the browser closed), hooks are off (`MCS_HOOK_DISABLE=1`) and the user
 * instance that this environment resolves (`<MCS_HOME>/instances/user`) is below the root and in no real per-user folder.
 * Returns that instance folder.
 */
export function assertHermeticEnv(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
  real: readonly string[] = realPerUserFolders(),
): string {
  assertTempRoot(root, real);
  for (const name of HERMETIC_PATH_VARIABLES) {
    const value = env[name];
    if (value === undefined || value === '' || !path.isAbsolute(value))
      refuse(`${name} is not set to an absolute path`);
    if (!isWithin(value, root) || canonical(value) === canonical(root)) refuse(`${name} is not below the temp root`);
  }
  if (env['MCS_TEST'] !== '1')
    refuse('MCS_TEST is not 1 (test mode keeps the browser closed and the hooks installer out of real settings)');
  if (env['MCS_HOOK_DISABLE'] !== '1') refuse('MCS_HOOK_DISABLE is not 1');
  const recorder = env['MCS_TEST_OPEN_FILE'];
  if (recorder === undefined || !path.isAbsolute(recorder) || !isWithin(recorder, root)) {
    refuse('MCS_TEST_OPEN_FILE is not a file below the temp root (a login URL could open a real browser)');
  }
  const instanceDir = path.join(env['MCS_HOME'] ?? '', 'instances', 'user');
  if (!isWithin(instanceDir, root)) refuse('the instance folder is not below the temp root');
  for (const folder of real) {
    if (isWithin(instanceDir, folder)) refuse('the instance folder lies in a real per-user folder');
  }
  return instanceDir;
}

function portOfText(text: string): number {
  return /^[0-9]{1,6}$/.test(text) ? Number(text) : Number.NaN;
}

/**
 * Throws when the arguments of a CLI call name a port outside the test range: `--port N`, `--port=N`, `config set server.port N`
 * and `--set server.port=N` (also `--set=...`). A value that is not a number is left to the CLI, which refuses it.
 */
export function assertSafeCliArgs(args: readonly string[]): void {
  const check = (text: string): void => {
    const port = portOfText(text);
    if (!Number.isNaN(port)) assertTestPort(port);
  };
  args.forEach((arg, index) => {
    const next = args[index + 1];
    if (arg === '--port' && next !== undefined) check(next);
    if (arg.startsWith('--port=')) check(arg.slice('--port='.length));
    if (arg === 'server.port' && next !== undefined) check(next);
    const set = /^(?:--set=)?server\.port=(.*)$/.exec(arg);
    if (set !== null) check(set[1] ?? '');
  });
}

// ---- types -----------------------------------------------------------------------------------------------------------------------

export interface UserInstancePaths {
  /** `HOME` and `USERPROFILE`. */
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  /** `CLAUDE_CONFIG_DIR`. */
  readonly claudeHome: string;
  /** `MCS_HOME`. */
  readonly mcsHome: string;
  /** The workspace of the app: `<mcsHome>/instances/user`. */
  readonly instanceDir: string;
  readonly stateFile: string;
  readonly logsDir: string;
  /** The fake claude and its launchers; `null` when the sandbox was made without one. */
  readonly fakeBin: string | null;
  /** The parent of the `FIXTURE-<name>` folders of {@link UserSandbox.project}. */
  readonly projects: string;
  /** `FAKE_CLAUDE_LOG`. */
  readonly fakeLog: string;
  /** `MCS_TEST_OPEN_FILE`: the login URLs that `open` and `start` would have opened in a browser, one per line. */
  readonly openFile: string;
}

export interface UserInstanceOptions {
  /** A word for the name of the temp root (default `user-app`). */
  readonly purpose?: string;
  /** The launchers of the fake claude (default: the npm shim on Windows, the `sh` script elsewhere); `null`: no claude on the PATH. */
  readonly fakeClaude?: FakeClaudeFlavour | null;
  /**
   * `terminal.*` keys written before the first start: `command`, `args` and `maxSessions` through `config set`, every other key
   * (`conptyDll`, `startTimeoutMs`, ...) through `configure --user --set`.
   */
  readonly terminal?: Readonly<Record<string, unknown>>;
  /** `server.portScan` (default 0: the app binds the port of the sandbox or fails). */
  readonly portScan?: number;
  /** Where the port is allocated (default: the block of this Vitest worker). It must lie inside {@link USER_INSTANCE_PORTS}. */
  readonly portRange?: PortRange;
  /** Added to the environment of every CLI call, and so of the server (test hooks, `FAKE_CLAUDE_*`). Checked by the guards. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The CLI entry every command runs (default: the built CLI of the checkout). A test that needs its own build stamp or launcher
   * path passes the entry of a private runtime copy.
   */
  readonly cliEntry?: string;
}

export interface CliCallOptions {
  /** Added over the sandbox environment for this call only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Hard limit of the call (default 120 s, scaled by `QA_TIME_SCALE`). */
  readonly timeoutMs?: number;
}

export interface CliJsonResult extends CliResult {
  /** The `--json` envelope of stdout. */
  readonly envelope: CliEnvelope<unknown>;
}

/** A reply of the HTTP API with its body parsed (`null` when the body is not JSON). */
export interface ApiReply extends HttpReply {
  readonly json: unknown;
}

export interface UserApi {
  get(urlPath: string, headers?: Readonly<Record<string, string>>): Promise<ApiReply>;
  /** A write as the page sends it: JSON, the header of the csrf guard and the `Origin` of the app. `body` defaults to `{}`. */
  post(urlPath: string, body?: unknown, headers?: Readonly<Record<string, string>>): Promise<ApiReply>;
}

/** A hermetic root with the configuration of an app that may not run yet. */
export interface UserSandbox {
  readonly root: string;
  /** The configured port (`server.port`). */
  readonly port: number;
  /** The environment of every CLI call. */
  readonly env: Readonly<Record<string, string>>;
  readonly paths: UserInstancePaths;
  /** The text every process of this root carries in its command line (the name of the temp root). */
  readonly marker: string;
  /** Makes `projects/FIXTURE-<name>` and returns its real path (a folder for a terminal session). */
  project(name: string): string;
  /** Runs the CLI with the sandbox environment and the root as the working folder. The guards run first. */
  runCli(args: readonly string[], opts?: CliCallOptions): Promise<CliResult>;
  /** `runCli` of a call that carries `--json`, with the parsed envelope. */
  runJson(args: readonly string[], opts?: CliCallOptions): Promise<CliJsonResult>;
  /** The pid of `state.json`, or `null` when there is none. */
  statePid(): number | null;
  /** The processes that carry {@link marker} now: the server and every fake claude of this root. */
  processes(): Promise<FoundProcess[]>;
  /** `start --user --no-open --json --port <port>` and a wait for health 200. `env` is added for this start (and so for the server). */
  start(opts?: { readonly env?: Readonly<Record<string, string>> }): Promise<UserInstance>;
  /**
   * The cleanup: a forced stop when a state file or a process is left, the kill of what still carries the marker, the port
   * closed, the temp tree removed. Idempotent; `killAllTracked` runs it.
   */
  destroy(): Promise<void>;
}

/** A running app. */
export interface UserInstance extends UserSandbox {
  /** The pid of the server (the new one after `restart`). */
  readonly pid: number;
  /** `http://127.0.0.1:<port>`: also the `Origin` of the page. */
  readonly baseUrl: string;
  /** `open --print --no-start --json`: the login URL with a fresh single-use code. In memory only. */
  accessUrl(): Promise<string>;
  /** A fresh code exchanged over HTTP: the `<name>=<value>` pair for the `Cookie` header. */
  exchange(): Promise<string>;
  /** The cookie of one exchange, kept in memory for `createSession`, `killSession` and `ws` (a new one after `restart`). */
  cookie(): Promise<string>;
  /** The HTTP API; without a cookie the calls carry no credential. */
  api(cookie?: string): UserApi;
  /** Starts the configured claude in `folder`; answers the session row (`name`, `path`, ...). */
  createSession(folder: string): Promise<{ readonly name: string } & Readonly<Record<string, unknown>>>;
  killSession(name: string): Promise<void>;
  /** The terminal socket of a session after `ready` and `live`. Default cookie: {@link cookie}. */
  ws(name: string, opts?: { readonly cookie?: string; readonly origin?: string }): Promise<OpenedTerminalSocket>;
  fakeLog(): FakeLog;
  /** `restart --user --force --no-open --json`, then health 200 of the new process. */
  restart(): Promise<void>;
  /**
   * `stop --user` (`--force` ends live terminals) and the leak checks: the port is closed, no process carries the marker, and the
   * temp tree is gone (`keepFiles` leaves it for `destroy`). Throws when the stop is refused: the app then keeps running.
   */
  stop(opts?: { readonly force?: boolean; readonly keepFiles?: boolean }): Promise<void>;
}

// ---- the sandbox -----------------------------------------------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;
const CONFIG_SET_KEYS: readonly string[] = ['command', 'args', 'maxSessions'];
/** The commands that start a server of the user instance when no task is selected. */
const STARTING_COMMANDS: readonly string[] = ['start', 'restart', 'serve', 'open'];
const TASK_SELECTORS: readonly string[] = ['--task', '--repo', '--root'];
const WRITE_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function withJson(reply: HttpReply): ApiReply {
  return { ...reply, json: parseJson(reply.body) };
}

/** The value a `config set` or `--set` takes: text as it is, everything else as JSON. */
function settingText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function selectsTask(args: readonly string[]): boolean {
  return args.some((arg) => TASK_SELECTORS.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function namesPort(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--port' || arg.startsWith('--port='));
}

/** What the envelope of a failed call says, without its data (a login URL is data). */
function failureText(result: CliJsonResult | CliResult): string {
  if ('envelope' in result && result.envelope.error !== null) {
    return `${result.envelope.error.code}: ${result.envelope.error.message}`;
  }
  return `exit ${String(result.code)}`;
}

/**
 * A hermetic root for one app instance that is configured but not started: the folders, the fake claude, the environment, the
 * port, and the proof that the CLI resolves the instance inside the root (see SAFETY in the file header). Throws, having removed
 * the root, when the proof fails.
 */
export async function createUserSandbox(options: UserInstanceOptions = {}): Promise<UserSandbox> {
  const temp: TempDir = makeTempDir(options.purpose ?? 'user-app');
  const root = temp.path;
  try {
    return await buildSandbox(temp, options);
  } catch (error) {
    // nothing was started when a guard or the proof refuses; a failed start has registered its own cleanup
    if (!existsSync(path.join(root, 'mcs-home', 'instances', 'user', 'state.json'))) temp.remove();
    throw error;
  }
}

async function buildSandbox(temp: TempDir, options: UserInstanceOptions): Promise<UserSandbox> {
  const root = temp.path;
  const marker = path.basename(root);
  const port = await allocatePort(options.portRange);
  assertTestPort(port);
  const flavour = options.fakeClaude;
  const fakeBin = flavour === null ? null : path.join(root, 'fakebin');
  const install =
    flavour === null || fakeBin === null ? null : installFakeClaude(fakeBin, flavour === undefined ? {} : { flavour });
  const home = path.join(root, 'home');
  const paths: UserInstancePaths = {
    home,
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    claudeHome: path.join(root, 'claude-home'),
    mcsHome: path.join(root, 'mcs-home'),
    instanceDir: path.join(root, 'mcs-home', 'instances', 'user'),
    stateFile: path.join(root, 'mcs-home', 'instances', 'user', 'state.json'),
    logsDir: path.join(root, 'mcs-home', 'instances', 'user', 'logs'),
    fakeBin,
    projects: path.join(root, 'projects'),
    fakeLog: path.join(root, 'fake-claude.log'),
    openFile: path.join(root, 'opened-urls.txt'),
  };
  for (const dir of [paths.appData, paths.localAppData, paths.claudeHome, paths.mcsHome, paths.projects]) {
    mkdirSync(dir, { recursive: true });
  }
  const env: Readonly<Record<string, string>> = Object.freeze(
    terminalEnv(root, install, {
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      MCS_TEST_OPEN_FILE: paths.openFile,
      ...options.env,
    }),
  );
  assertHermeticEnv(env, root);
  const cliEntry = options.cliEntry ?? cliEntryPath();
  if (!existsSync(cliEntry)) throw new Error(`user-instance harness: ${cliEntry} is missing; build the runtime first`);

  /** True when a start of the user instance would use a port of the test range: `--port`, or `server.port` of `runtime.json`. */
  const configuredPortIsSafe = (): boolean => {
    const overrides = parseJson(readText(path.join(paths.instanceDir, 'runtime.json')) ?? '');
    const server = isRecord(overrides) ? overrides['server'] : undefined;
    const configured = isRecord(server) ? server['port'] : undefined;
    const [min, max] = USER_INSTANCE_PORTS;
    return typeof configured === 'number' && configured >= min && configured <= max;
  };

  // async: a guard that refuses is a rejection, like every other failure of the call
  const runCli = async (args: readonly string[], opts: CliCallOptions = {}): Promise<CliResult> => {
    const merged = { ...env, ...opts.env };
    assertHermeticEnv(merged, root);
    // a PATH of the call's own must not reach a claude that is not the fake either
    if (merged['PATH'] !== env['PATH']) assertClaudeFree(merged['PATH'] ?? '', fakeBin ?? '');
    assertSafeCliArgs(args);
    if (
      STARTING_COMMANDS.includes(args[0] ?? '') &&
      !selectsTask(args) &&
      !namesPort(args) &&
      !configuredPortIsSafe()
    ) {
      refuse(
        `\`${args[0] ?? ''}\` without --port while server.port is not a test port would start on the product default port`,
      );
    }
    return runProcess(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: merged,
      timeoutMs: opts.timeoutMs ?? scaled(CLI_TIMEOUT_MS),
    });
  };

  const runJson = async (args: readonly string[], opts: CliCallOptions = {}): Promise<CliJsonResult> => {
    const result = await runCli(args, opts);
    const parsed = CliEnvelopeSchema.safeParse(parseJson(result.stdout));
    if (!parsed.success) {
      throw new Error(
        `user-instance harness: \`${args[0] ?? ''}\` printed no --json envelope (exit ${String(result.code)})`,
      );
    }
    return { ...result, envelope: parsed.data };
  };

  const statePid = (): number | null => {
    const state = parseJson(readText(paths.stateFile) ?? '');
    return isRecord(state) && typeof state['pid'] === 'number' ? state['pid'] : null;
  };

  const processes = (): Promise<FoundProcess[]> => findProcesses(marker);

  /** Kills what carries the marker now and waits until nothing does. Only pids of the scan are ever killed. */
  const killLeftovers = async (): Promise<FoundProcess[]> => {
    const found = await processes();
    killOwned(found, marker);
    if (found.length > 0) {
      await waitFor(async () => (await processes()).length === 0, {
        what: `the processes of ${marker} to exit`,
        timeoutMs: scaled(EXIT_TIMEOUT_MS),
        intervalMs: 250,
      });
    }
    return found;
  };

  let destroyed = false;
  const usedPorts = new Set<number>([port]);
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    const failures: string[] = [];
    if (statePid() !== null) {
      await runCli(['stop', '--user', '--force', '--json'], { timeoutMs: scaled(CLI_TIMEOUT_MS) }).catch(
        () => undefined,
      );
    }
    await killLeftovers().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
    for (const used of usedPorts) {
      await waitFor(() => assertPortClosed(used).then(() => true), {
        what: `port ${String(used)} to close`,
        timeoutMs: scaled(10_000),
        intervalMs: 100,
      }).catch((error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
    }
    try {
      temp.remove();
    } catch {
      failures.push('the temp root could not be removed');
    }
    if (failures.length > 0)
      throw new Error(`user-instance harness: cleanup of ${marker} failed: ${failures.join('; ')}`);
  };
  onKillAll(destroy);

  const sandbox: UserSandbox = {
    root,
    port,
    env,
    paths,
    marker,
    project: (name) => {
      if (!/^[A-Za-z0-9._-]{1,48}$/.test(name))
        throw new RangeError('project: the name must be 1-48 letters, digits, dot, dash or underscore');
      const dir = path.join(paths.projects, `FIXTURE-${name}`);
      mkdirSync(dir, { recursive: true });
      return realpathSync.native(dir);
    },
    runCli,
    runJson,
    statePid,
    processes,
    start: (opts = {}) => startApp(opts.env ?? {}),
    destroy,
  };

  // ---- the proof, then the configuration (the first commands that write) -------------------------------------------------------

  await proveHermetic(sandbox);
  const configure = async (args: readonly string[]): Promise<void> => {
    const result = await runCli(args);
    if (result.code !== 0) {
      throw new Error(
        `user-instance harness: \`${args.slice(0, 3).join(' ')}\` exited ${String(result.code)}: ${result.stderr.trim()}`,
      );
    }
  };
  await configure(['config', 'set', 'server.port', String(port)]);
  await configure(['config', 'set', 'server.portScan', String(options.portScan ?? 0)]);
  for (const [key, value] of Object.entries(options.terminal ?? {})) {
    if (CONFIG_SET_KEYS.includes(key)) await configure(['config', 'set', `terminal.${key}`, settingText(value)]);
    else {
      await configure([
        'configure',
        '--user',
        '--set',
        `terminal.${key}=${JSON.stringify(value)}`,
        '--reason',
        'test harness',
      ]);
    }
  }
  const configured = await runJson(['status', '--user', '--json']);
  const report = configured.envelope.data;
  if (!isRecord(report) || report['configured_port'] !== port || report['running'] !== false) {
    refuse('after the configuration `status --user` does not report the sandbox port and "not running"');
  }
  if (mentionsProductPort(`${configured.stdout}${configured.stderr}`)) {
    refuse(`after the configuration \`status --user\` still mentions port ${String(PRODUCT_DEFAULT_PORT)}`);
  }

  // ---- the running app -----------------------------------------------------------------------------------------------------------

  async function startApp(extraEnv: Readonly<Record<string, string>>): Promise<UserInstance> {
    const started = await runJson(['start', '--user', '--no-open', '--json', '--port', String(port)], {
      env: extraEnv,
    });
    if (started.code !== 0) throw new Error(`startUserInstance: \`start\` failed (${failureText(started)})`);
    let current = runningOf(started.envelope.data, 'start');
    usedPorts.add(current.port);
    let cached: Promise<string> | null = null;
    const baseUrl = (): string => `http://127.0.0.1:${String(current.port)}`;

    const waitHealthy = (): Promise<unknown> =>
      waitFor(async () => (await httpRequest(current.port, '/api/v3/health')).status === 200, {
        what: `health of the app on port ${String(current.port)}`,
        timeoutMs: scaled(HEALTH_TIMEOUT_MS),
        intervalMs: 100,
      });
    await waitHealthy();

    const accessUrl = async (): Promise<string> => {
      const opened = await runJson(['open', '--user', '--print', '--no-start', '--json']);
      const data = opened.envelope.data;
      const login = isRecord(data) ? data['login'] : undefined;
      const url = isRecord(login) ? login['url'] : undefined;
      // the text of a failure never repeats the output: it may hold a code
      if (opened.code !== 0 || typeof url !== 'string' || !LOGIN_URL_RE.test(url) || !url.includes('#code=')) {
        throw new Error(`accessUrl: \`open --print\` gave no login URL (${failureText(opened)})`);
      }
      return url;
    };

    const exchange = async (): Promise<string> => {
      const url = await accessUrl();
      const code = url.slice(url.indexOf('#code=') + '#code='.length);
      const reply = await httpRequest(current.port, '/api/v3/auth/exchange', {
        method: 'POST',
        origin: baseUrl(),
        headers: { ...WRITE_HEADERS },
        body: JSON.stringify({ code }),
      });
      const pair = reply.headers['set-cookie']?.split(';')[0]?.trim() ?? '';
      if (reply.status !== 200 || !pair.includes('=')) {
        throw new Error(
          `exchange: the exchange route answered ${String(reply.status)}${pair === '' ? ' without a cookie' : ''}`,
        );
      }
      return pair;
    };

    const cookie = (): Promise<string> => {
      cached ??= exchange();
      // a failed exchange is not kept: the next call asks again
      cached.catch(() => {
        cached = null;
      });
      return cached;
    };

    const api = (credential?: string): UserApi => {
      const withCookie = (headers: Readonly<Record<string, string>> = {}): Record<string, string> => ({
        ...headers,
        ...(credential === undefined ? {} : { Cookie: credential }),
      });
      return {
        get: async (urlPath, headers) =>
          withJson(await httpRequest(current.port, urlPath, { headers: withCookie(headers) })),
        post: async (urlPath, body = {}, headers) =>
          withJson(
            await httpRequest(current.port, urlPath, {
              method: 'POST',
              origin: baseUrl(),
              headers: withCookie({ ...WRITE_HEADERS, ...headers }),
              body: JSON.stringify(body),
            }),
          ),
      };
    };

    const createSession: UserInstance['createSession'] = async (folder) => {
      const reply = await api(await cookie()).post('/api/v3/terminal/sessions', { path: folder });
      const session = isRecord(reply.json) ? reply.json['session'] : undefined;
      if (reply.status !== 200 || !isRecord(session) || typeof session['name'] !== 'string') {
        const code =
          isRecord(reply.json) && isRecord(reply.json['error']) ? String(reply.json['error']['code']) : 'no error code';
        throw new Error(`createSession: the create route answered ${String(reply.status)} (${code})`);
      }
      return { ...session, name: session['name'] };
    };

    const killSession = async (name: string): Promise<void> => {
      const reply = await api(await cookie()).post(`/api/v3/terminal/sessions/${encodeURIComponent(name)}/kill`);
      if (reply.status !== 200) throw new Error(`killSession: the kill route answered ${String(reply.status)}`);
    };

    const restart = async (): Promise<void> => {
      const restarted = await runJson(['restart', '--user', '--force', '--no-open', '--json', '--port', String(port)]);
      if (restarted.code !== 0) throw new Error(`restart: \`restart --force\` failed (${failureText(restarted)})`);
      const data = restarted.envelope.data;
      current = runningOf(isRecord(data) ? data['start'] : undefined, 'restart');
      usedPorts.add(current.port);
      cached = null;
      await waitHealthy();
    };

    const stop: UserInstance['stop'] = async (opts = {}) => {
      const stopped = await runJson(['stop', '--user', ...(opts.force === true ? ['--force'] : []), '--json']);
      if (stopped.code !== 0) throw new Error(`stop: \`stop\` failed (${failureText(stopped)})`);
      cached = null;
      await waitFor(() => assertPortClosed(current.port).then(() => true), {
        what: `port ${String(current.port)} to close after the stop`,
        timeoutMs: scaled(EXIT_TIMEOUT_MS),
        intervalMs: 100,
      });
      // the server is gone; a fake claude of a killed tree may take a moment to follow it
      const left = await waitFor(async () => ((await processes()).length === 0 ? [] : null), {
        what: 'every process of the root to exit',
        timeoutMs: scaled(EXIT_TIMEOUT_MS),
        intervalMs: 250,
      }).catch(() => processes());
      if (left.length > 0) {
        const named = left.map((found) => `${found.name} ${String(found.pid)}`).join(', ');
        await killLeftovers();
        throw new Error(`stop: ${String(left.length)} process(es) of the root outlived the stop: ${named}`);
      }
      if (statePid() !== null) throw new Error('stop: state.json is still there after the stop');
      if (opts.keepFiles !== true) {
        await destroy();
        if (existsSync(root)) throw new Error('stop: the temp tree is still there');
      }
    };

    return {
      ...sandbox,
      get pid() {
        return current.pid;
      },
      get port() {
        return current.port;
      },
      get baseUrl() {
        return baseUrl();
      },
      accessUrl,
      exchange,
      cookie,
      api,
      createSession,
      killSession,
      ws: async (name, opts = {}) =>
        openTerminalSocket(current.port, name, {
          cookie: opts.cookie ?? (await cookie()),
          origin: opts.origin ?? baseUrl(),
        }),
      fakeLog: () => readFakeLog(paths.fakeLog),
      restart,
      stop,
    };
  }

  return sandbox;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The pid and the port of the `data` of a start (or of the `start` part of a restart). Both must be usable. */
function runningOf(data: unknown, command: string): { pid: number; port: number } {
  const pid = isRecord(data) ? data['pid'] : undefined;
  const url = isRecord(data) ? data['url'] : undefined;
  let port = Number.NaN;
  try {
    if (typeof url === 'string') port = Number(new URL(url).port);
  } catch {
    // reported below
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || Number.isNaN(port)) {
    throw new Error(`user-instance harness: \`${command}\` did not report a pid and an address`);
  }
  assertTestPort(port);
  return { pid, port };
}

/**
 * The read-only proof that the CLI, given the sandbox environment, resolves the user instance inside the temp root: `status
 * --user` must say "not running" (exit 1), name a folder below the root and mention neither port 7690 nor a real per-user folder,
 * and `status --user --json` must agree (not running, no pid, no address, the state file below the root). Nothing was written
 * before this runs; when it fails nothing else is run.
 */
export async function proveHermetic(sandbox: Pick<UserSandbox, 'root' | 'runCli' | 'runJson'>): Promise<void> {
  const text = await sandbox.runCli(['status', '--user']);
  const output = `${text.stdout}\n${text.stderr}`;
  const lines = text.stdout.split(/\r?\n/);
  if (text.code !== 1 || !(lines[0] ?? '').endsWith(': not running')) {
    refuse('`status --user` of a new sandbox does not say "not running"');
  }
  if (mentionsProductPort(output)) refuse(`\`status --user\` mentions port ${String(PRODUCT_DEFAULT_PORT)}`);
  const folded = FOLD_CASE ? output.toLowerCase() : output;
  for (const folder of realPerUserFolders()) {
    const needle = FOLD_CASE ? path.join(folder, 'instances').toLowerCase() : path.join(folder, 'instances');
    if (folded.includes(needle)) refuse('`status --user` names a real per-user folder');
  }
  const folder = /^\s+folder:\s+(.+)$/m.exec(text.stdout)?.[1]?.trim();
  if (folder === undefined || !isWithin(folder, sandbox.root)) {
    refuse('`status --user` does not name a folder below the temp root');
  }
  const json = await sandbox.runJson(['status', '--user', '--json']);
  const report = json.envelope.data;
  if (
    json.code !== 1 ||
    !isRecord(report) ||
    report['running'] !== false ||
    report['pid'] !== undefined ||
    report['url'] !== undefined ||
    typeof report['home'] !== 'string' ||
    !isWithin(report['home'], sandbox.root) ||
    typeof report['state_file'] !== 'string' ||
    !isWithin(report['state_file'], sandbox.root)
  ) {
    refuse('`status --user --json` does not report a stopped instance below the temp root');
  }
}

/**
 * Starts one real app instance in a new hermetic root (see the file header): {@link createUserSandbox}, then `start --user
 * --no-open --json` and a wait for health 200.
 */
export async function startUserInstance(
  options: UserInstanceOptions & {
    /** Runs between the configuration and the start: the place to write what the app should find (sessions, DA memory). */
    readonly prepare?: (sandbox: UserSandbox) => void | Promise<void>;
  } = {},
): Promise<UserInstance> {
  const sandbox = await createUserSandbox(options);
  await options.prepare?.(sandbox);
  return sandbox.start();
}
