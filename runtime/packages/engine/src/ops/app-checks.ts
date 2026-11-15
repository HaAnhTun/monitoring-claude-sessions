// The `app.*` checks of `caw check` and `caw doctor` (06 2.6, amendment A6): what the app needs on this machine. They are doctor
// providers (`DoctorDeps.extraChecks`): each answers `null` outside the user scope, so a task instance never sees them.
//
// Facts about the terminal (is claude there, does the pseudo console load, which Windows build) come from `diagnoseTerminal` of the
// terminal service, one implementation for the checks and for the sessions. Everything that touches the machine is a seam of
// `AppCheckDeps` with the real thing as its default, so the checks are tested with scripted answers.
//
// Every check starts nothing that lasts: the claude version is one short `--version` run, the shortcut is read by a constant
// script, `icacls` lists one folder. A check that cannot tell is not a failure; only `app.claude`, `app.pty` and `app.windows`
// can fail at error level (the exit code of `caw check`).
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { AutostartStatus, DoctorCheck, TerminalSection } from '@mcs/shared';

import { resolveConfig } from '../config/resolve.ts';
import { claudeHomeOf } from '../ingest/transcripts/discovery.ts';
import { findAppBrowser, type AppBrowser } from '../platform/browser.ts';
import { execFileText, firstLine, resolveExecutable, type ChildResult, type ChildSpec } from '../platform/exec.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { buildLaunch, resolveClaudeCommand, type CommandFs } from '../terminal/command.ts';
import { realTerminalFs } from '../terminal/default.ts';
import { diagnoseTerminal, type TerminalDiagnosis } from '../terminal/diagnose.ts';
import type { EnvSource } from '../terminal/env.ts';
import { MIN_WINDOWS_BUILD } from '../terminal/native-targets.ts';
import { USER_DEFAULT_PORT, isUserRoot } from '../user-instance/paths.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { autostartStatus } from './autostart.ts';
import type { DoctorCheckProvider } from './doctor.ts';
import { nodeDoctorSeams } from './doctor-checks.ts';
import { readCodeStamp } from './instances.ts';
import { httpGet, isLiveState, jsonBodyOf, probeInstance, type HttpAttempt, type ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

/** The ids of the checks, in the order of design 06 2.6 (the doctor prints extra checks sorted by id). */
export const APP_CHECK_IDS = [
  'app.claude',
  'app.pty',
  'app.windows',
  'app.port',
  'app.memory',
  'app.browser',
  'app.autostart',
  'app.instance',
] as const;

/**
 * What `caw check` runs, as the `only` list of `ops.doctor.run` (06 2.6): the machine checks that decide whether the app can
 * run at all (the doctor's own, by id) and the whole `app.` family. No task is needed for any of them.
 */
export const userCheckIds: readonly string[] = [
  'node.version',
  'node.sqlite',
  'runtime.layout',
  'claude.home',
  'mcshome.writable',
  'app.',
];

/** Time each check may take. A check bounds its own programs (5 s for claude, 20 s for PowerShell, 10 s for icacls). */
const APP_CHECK_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5000;
const ICACLS_TIMEOUT_MS = 10_000;
const MTOP_TIMEOUT_MS = 2000;

/** The settings the checks read, from the configuration of the user instance. */
export interface AppSettings {
  readonly terminal: Pick<TerminalSection, 'command' | 'conptyDll'>;
  readonly openAppWindow: boolean;
  /** The port the app is configured for: `--port`-less, `runtime.json` over `config.json` (seeded 7690). */
  readonly effectivePort: number;
  /** How many ports above it a start tries. */
  readonly portScan: number;
}

/** Everything that touches the machine, replaceable in tests. */
export interface AppCheckDeps {
  readonly platform?: HostPlatform;
  /** The configuration of the user instance; a broken one falls back to the defaults (`config.valid` reports it). */
  readonly settings?: (ctx: OpContext, ws: WorkspaceRef | null) => Promise<AppSettings>;
  /** `diagnoseTerminal` of the terminal service. */
  readonly diagnose?: (input: {
    readonly config: Pick<TerminalSection, 'command' | 'conptyDll'>;
    readonly env: EnvSource;
  }) => TerminalDiagnosis;
  /** The version of claude, best effort: `null` when it could not be read. */
  readonly claudeVersion?: (command: string, env: EnvSource) => Promise<string | null>;
  readonly probe?: (ws: WorkspaceRef, runtimeDir: string) => Promise<ProbeResult>;
  /** True when 127.0.0.1:<port> can be bound now (the socket is closed at once). */
  readonly canBind?: (port: number) => Promise<boolean>;
  readonly httpGet?: (url: string, o: { timeoutMs: number }) => Promise<HttpAttempt>;
  readonly exists?: (file: string) => Promise<boolean>;
  readonly findAppBrowser?: (env: OpContext['env']) => Promise<AppBrowser | null>;
  readonly autostart?: (ctx: OpContext, o: { launcherPath: string }) => Promise<AutostartStatus>;
  readonly codeStamp?: (runtimeDir: string) => Promise<string | null>;
  /** `icacls <folder>`; `null` when icacls is not installed. */
  readonly icacls?: (folder: string) => Promise<ChildResult | null>;
}

// ---- results -------------------------------------------------------------------------------------------------------------------

type Level = DoctorCheck['level'];

const pass = (id: string, level: Level, detail: string): DoctorCheck => ({ id, ok: true, level, detail });
const fail = (id: string, level: Level, detail: string, fix: string): DoctorCheck => ({
  id,
  ok: false,
  level,
  detail,
  fix,
});

// ---- the version of claude -----------------------------------------------------------------------------------------------------

/** A shim path that `cmd.exe /s /c` reads without quotes: no space, quote or special character. */
const PLAIN_SHIM_PATH = /^[A-Za-z]:[\\/][\p{L}\p{N}_.@+=\\/-]+$/u;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * The version `claude --version` prints, or `null`: best effort, and never a failure (06 8 risk R2). The program is found and
 * built by the terminal's own rules (`resolveClaudeCommand`, `buildLaunch`), with `--version` as the only argument: the configured
 * arguments stay out. An `.exe` runs directly; a `.cmd` shim runs as `cmd.exe /d /s /c "<shim> --version"`, which is only done for
 * a path that needs no quoting (the argument list of `execFileText` cannot carry the quotes that cmd.exe reads). Only the version
 * number leaves this function, never the rest of the output.
 */
export async function claudeVersionOf(
  command: string,
  o: {
    readonly env: EnvSource;
    readonly platform: HostPlatform;
    readonly fs: CommandFs;
    readonly exec: (spec: ChildSpec) => Promise<ChildResult>;
  },
): Promise<string | null> {
  const resolved = resolveClaudeCommand({ command, env: o.env, platform: o.platform, fs: o.fs });
  if (resolved === null) return null;
  let file: string;
  let args: readonly string[];
  try {
    const launch = buildLaunch(resolved, ['--version'], { env: o.env, platform: o.platform, fs: o.fs });
    if (launch.kind === 'exe') {
      file = launch.file;
      args = launch.args;
    } else {
      if (!PLAIN_SHIM_PATH.test(launch.display)) return null;
      file = launch.file;
      args = ['/d', '/s', '/c', `${launch.display} --version`];
    }
  } catch {
    // a program the terminal itself would refuse to start (no cmd.exe, an unsafe path): there is no version to show
    return null;
  }
  const result = await o.exec({
    kind: 'claude',
    file,
    args,
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutputBytes: 4096,
    encoding: 'utf8',
  });
  if (!result.ok) return null;
  return VERSION_RE.exec(firstLine(result.stdout))?.[0] ?? null;
}

// ---- icacls ---------------------------------------------------------------------------------------------------------------------

/** `icacls` names of the groups that must not read the run folder, and how the check calls them. English Windows only. */
const OPEN_ACCOUNTS: readonly (readonly [account: RegExp, name: string])[] = [
  [/(?:^|\s)Everyone:((?:\([^()]*\))+)\s*$/i, 'Everyone'],
  [/(?:^|\s)BUILTIN\\Users:((?:\([^()]*\))+)\s*$/i, 'Users'],
  [/(?:^|\s)NT AUTHORITY\\Authenticated Users:((?:\([^()]*\))+)\s*$/i, 'Authenticated Users'],
];
/** Inheritance flags: not rights. */
const FLAG_TOKENS = new Set(['OI', 'CI', 'IO', 'NP', 'I']);
/** Rights that open the folder to someone: full, modify, read and execute, read, write, the generic ones, and the data rights. */
const OPEN_RIGHTS = new Set(['F', 'M', 'RX', 'R', 'W', 'GR', 'GA', 'GW', 'RD', 'WD', 'AD']);

/**
 * The groups of `icacls <folder>` output (`Everyone`, `Users`, `Authenticated Users`) that hold a right to read or write, in the
 * order of the output, each once. A denied entry, a right that only traverses or reads attributes, and every other account are no
 * finding. The names are the English ones: on another language of Windows nothing is found, and the check stays silent.
 */
export function openRunFolderGroups(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    for (const [pattern, name] of OPEN_ACCOUNTS) {
      const groups = pattern.exec(line)?.[1];
      if (groups === undefined) continue;
      const tokens = [...groups.matchAll(/\(([^()]*)\)/g)].flatMap((match) => (match[1] ?? '').split(','));
      if (tokens.includes('DENY')) continue;
      const rights = tokens.filter((token) => !FLAG_TOKENS.has(token));
      if (rights.some((right) => OPEN_RIGHTS.has(right)) && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

// ---- the real seams ------------------------------------------------------------------------------------------------------------

async function realSettings(ctx: OpContext, ws: WorkspaceRef | null): Promise<AppSettings> {
  const resolve = (workspace: WorkspaceRef | null) =>
    resolveConfig({ workspace, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  let config: Awaited<ReturnType<typeof resolve>>;
  let own = ws !== null;
  try {
    config = await resolve(ws);
  } catch {
    // a broken runtime.json is the business of `config.valid`: these checks go on with the defaults
    config = await resolve(null);
    own = false;
  }
  return {
    terminal: { command: config.runtime.terminal.command, conptyDll: config.runtime.terminal.conptyDll },
    openAppWindow: config.runtime.app.openAppWindow,
    // the seeded port of a user instance is 7690; without a readable workspace of its own that is the answer
    effectivePort: own ? config.effectivePort : USER_DEFAULT_PORT,
    portScan: config.runtime.server.portScan,
  };
}

async function realExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function realIcacls(folder: string): Promise<ChildResult | null> {
  const file = await resolveExecutable('icacls');
  if (file === null) return null;
  return execFileText({
    kind: 'icacls',
    file,
    args: [folder],
    timeoutMs: ICACLS_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    encoding: 'utf8',
  });
}

/** True when `GET /api/state` answers 200 with a JSON object that has `folders`: MTOP's own answer (its `is_ours` test). */
async function mtopAnswers(get: NonNullable<AppCheckDeps['httpGet']>, port: number): Promise<boolean> {
  const attempt = await get(`http://127.0.0.1:${String(port)}/api/state`, { timeoutMs: MTOP_TIMEOUT_MS });
  if (!attempt.ok || attempt.reply.status !== 200) return false;
  const body = jsonBodyOf(attempt.reply);
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'folders' in body;
}

// ---- the providers --------------------------------------------------------------------------------------------------------------

/** True when the context is the one of the user instance: its tasks root is the user root. A context without a home is not. */
function inUserScope(ctx: OpContext): boolean {
  try {
    return isUserRoot(ctx.root, ctx.env);
  } catch {
    return false;
  }
}

function provider(run: (ctx: OpContext, ws: WorkspaceRef | null) => Promise<DoctorCheck>): DoctorCheckProvider {
  const check = async (ctx: OpContext, ws: WorkspaceRef | null): Promise<DoctorCheck | null> =>
    inUserScope(ctx) ? run(ctx, ws) : null;
  return Object.assign(check, { timeoutMs: APP_CHECK_TIMEOUT_MS });
}

const WINDOWS_FIX = 'Windows 10 1809 or newer is needed for the terminal';
const REINSTALL_FIX = 'reinstall the skill (the bundle folder is incomplete)';
const SET_COMMAND_FIX = 'install Claude Code, or: caw config set terminal.command <full path to claude>';

/**
 * The eight providers, keyed by id, for `DoctorDeps.extraChecks`. Each answers `null` outside the user scope. Every provider names
 * a time budget of its own (`timeoutMs`), longer than the default of the doctor, because some of them start a program.
 */
export function appCheckProviders(deps: AppCheckDeps = {}): Readonly<Record<string, DoctorCheckProvider>> {
  const platform = deps.platform ?? hostPlatform;
  const settingsOf = deps.settings ?? realSettings;
  const diagnose =
    deps.diagnose ??
    ((input: { config: Pick<TerminalSection, 'command' | 'conptyDll'>; env: EnvSource }) =>
      diagnoseTerminal({ ...input, ...(deps.platform === undefined ? {} : { platform: deps.platform }) }));
  const claudeVersion =
    deps.claudeVersion ??
    ((command: string, env: EnvSource) =>
      claudeVersionOf(command, { env, platform, fs: realTerminalFs, exec: (spec) => execFileText(spec) }));
  const probe = deps.probe ?? ((ws: WorkspaceRef, runtimeDir: string) => probeInstance(ws, { runtimeDir }));
  const canBind = deps.canBind ?? nodeDoctorSeams.canBind;
  const get = deps.httpGet ?? httpGet;
  const exists = deps.exists ?? realExists;
  const browserOf = deps.findAppBrowser ?? ((env: OpContext['env']) => findAppBrowser({ env }));
  const autostart = deps.autostart ?? ((ctx: OpContext, o: { launcherPath: string }) => autostartStatus(ctx, o));
  const stampOf = deps.codeStamp ?? readCodeStamp;
  const icacls = deps.icacls ?? realIcacls;

  const diagnosisOf = async (ctx: OpContext, ws: WorkspaceRef | null) => {
    const settings = await settingsOf(ctx, ws);
    return { settings, diagnosis: diagnose({ config: settings.terminal, env: ctx.env }) };
  };

  const claude = provider(async (ctx, ws) => {
    const id = 'app.claude';
    const { settings, diagnosis } = await diagnosisOf(ctx, ws);
    const { claude: found } = diagnosis;
    if (!found.found) {
      return fail(id, 'error', `"${settings.terminal.command}" was not found (terminal.command)`, SET_COMMAND_FIX);
    }
    const display = found.display ?? settings.terminal.command;
    if (found.kind === null) {
      return fail(
        id,
        'error',
        `${display} cannot be started in the terminal (only .exe, .com, .cmd and .bat programs can)`,
        SET_COMMAND_FIX,
      );
    }
    const version = await claudeVersion(settings.terminal.command, ctx.env);
    return pass(id, 'error', `claude found: ${display}${version === null ? '' : ` (${version})`}`);
  });

  const pty = provider(async (ctx, ws) => {
    const id = 'app.pty';
    const { diagnosis } = await diagnosisOf(ctx, ws);
    const level: Level = platform === 'win32' ? 'error' : 'warn';
    const reinstall =
      platform === 'win32' ? REINSTALL_FIX : 'the terminal is not supported on this OS; monitoring works';
    if (!diagnosis.supported) {
      switch (diagnosis.reason) {
        case 'os-too-old':
          return fail(id, level, 'the Windows build is too old for the pseudo console', WINDOWS_FIX);
        case 'native-missing':
          return fail(id, level, 'the terminal module (node-pty) was not found', reinstall);
        case 'native-load-failed':
          return fail(id, level, 'the terminal module (node-pty) failed to load', reinstall);
        case 'unsupported-os':
        case null:
          return fail(id, level, 'no terminal module ships for this operating system or processor', reinstall);
      }
    }
    if (diagnosis.conptyDll.filesPresent === false) {
      return fail(id, level, 'conpty.dll or OpenConsole.exe is missing next to the terminal module', reinstall);
    }
    const from = diagnosis.nodePty.via === 'bundle' ? 'the bundle' : 'node_modules';
    const files =
      diagnosis.conptyDll.filesPresent === true
        ? '; ConPTY files present'
        : platform === 'win32'
          ? '; ConPTY files not checked'
          : '';
    return pass(id, level, `terminal module loaded from ${from}${files}`);
  });

  const windows = provider(async (ctx, ws) => {
    const id = 'app.windows';
    const { diagnosis } = await diagnosisOf(ctx, ws);
    const build = diagnosis.windowsBuild;
    if (build === null) return pass(id, 'error', 'not Windows (not needed)');
    if (build.build === null) return fail(id, 'error', 'the Windows build could not be read', WINDOWS_FIX);
    return build.ok
      ? pass(
          id,
          'error',
          `Windows build ${String(build.build)} (the pseudo console needs ${String(MIN_WINDOWS_BUILD)} or newer)`,
        )
      : fail(
          id,
          'error',
          `Windows build ${String(build.build)} is older than ${String(MIN_WINDOWS_BUILD)}`,
          WINDOWS_FIX,
        );
  });

  const port = provider(async (ctx, ws) => {
    const id = 'app.port';
    const settings = await settingsOf(ctx, ws);
    const configured = settings.effectivePort;
    const mine = ws === null ? null : await probe(ws, ctx.runtimeDir);
    const held = mine !== null && isLiveState(mine.state) && mine.port !== null;
    if (held && mine.port === configured)
      return pass(id, 'warn', `port ${String(configured)} is held by this instance`);
    if (await canBind(configured)) return pass(id, 'warn', `port ${String(configured)} is free`);
    const elsewhere = await mtopAnswers(get, configured);
    const who = `port ${String(configured)} is held by something else${elsewhere ? ' (MTOP answers there)' : ''}`;
    const fix = 'caw start picks the next free port; set a fixed one with caw config set server.port N';
    if (held) return fail(id, 'warn', `${who}; this app runs on ${String(mine.port)}`, fix);
    for (let candidate = configured + 1; candidate <= configured + settings.portScan; candidate += 1) {
      if (await canBind(candidate)) return fail(id, 'warn', `${who}; the next free port is ${String(candidate)}`, fix);
    }
    return fail(id, 'warn', `${who}; no port is free up to ${String(configured + settings.portScan)}`, fix);
  });

  const memory = provider(async (ctx) => {
    const id = 'app.memory';
    return (await exists(path.join(claudeHomeOf(ctx.env), 'memory', 'index.json')))
      ? pass(id, 'warn', 'DA memory index found')
      : fail(
          id,
          'warn',
          'no memory/index.json in the Claude home (DA memory)',
          'optional: without it the project list shows ~/.claude/projects only',
        );
  });

  const browser = provider(async (ctx, ws) => {
    const id = 'app.browser';
    const settings = await settingsOf(ctx, ws);
    if (!settings.openAppWindow)
      return pass(id, 'warn', 'the default browser tab is used (app.openAppWindow is false)');
    const found = await browserOf(ctx.env);
    return found === null
      ? fail(
          id,
          'warn',
          'app.openAppWindow is true but neither Edge nor Chrome was found',
          'falls back to the default browser; install Edge or Chrome, or caw config set app.openAppWindow false',
        )
      : pass(id, 'warn', `an app window opens in ${found.kind === 'edge' ? 'Edge' : 'Chrome'}`);
  });

  const autostartCheck = provider(async (ctx) => {
    const id = 'app.autostart';
    const status = await autostart(ctx, { launcherPath: ctx.launcherPath });
    if (!status.supported) return pass(id, 'warn', 'autostart is available on Windows only');
    if (!status.enabled) return pass(id, 'warn', 'autostart is off');
    let problem: string | null = null;
    if (status.target === null) problem = 'the autostart shortcut exists but could not be read';
    else if (status.targetExists === false) problem = 'the autostart shortcut points to a program that does not exist';
    else if (status.matchesLauncher === false) problem = 'the autostart shortcut points to another launcher';
    else if (status.note !== null) problem = status.note;
    return problem === null
      ? pass(id, 'warn', 'autostart is on and current')
      : fail(id, 'warn', problem, 'caw autostart enable refreshes it');
  });

  const instance = provider(async (ctx, ws) => {
    const id = 'app.instance';
    if (ws === null) return pass(id, 'warn', 'the app instance has not been created yet (caw start creates it)');
    const problems: { detail: string; fix: string }[] = [];
    const state = await probe(ws, ctx.runtimeDir);
    let line = 'the app is not running';
    switch (state.state) {
      case 'running': {
        const running = state.identity?.codeStamp;
        const stamp = await stampOf(ctx.runtimeDir);
        if (running !== undefined && stamp !== null && stamp !== running) {
          problems.push({
            detail: 'the running app is outdated: the installed code changed since it started',
            fix: 'caw restart',
          });
        } else {
          line = 'the app is running and current';
        }
        break;
      }
      case 'starting':
      case 'stopping':
        line = `the app is ${state.state}`;
        break;
      case 'unhealthy':
        problems.push({ detail: `the app does not answer properly (${state.reason})`, fix: 'caw restart' });
        break;
      case 'unmanaged-running':
        problems.push({
          detail: `a program that this runtime did not start answers there (${state.reason})`,
          fix: 'stop that program with the tool that started it',
        });
        break;
      case 'stopped':
      case 'stale':
      case 'foreign-pid':
        break;
    }
    // control.token lives in the run folder and is the root of trust for the access codes (amendment A6)
    const runDir = path.join(ws.dir, 'run');
    if (platform === 'win32' && (await exists(runDir))) {
      const listing = await icacls(runDir);
      const open = listing?.ok === true ? openRunFolderGroups(listing.stdout) : [];
      if (open.length > 0) {
        problems.push({
          detail: `${open.join(', ')} can read the run folder of the app, where the control token lives`,
          fix: 'restrict the run folder of the app instance to your own account (icacls <folder> /inheritance:r), or move MCS_HOME to a folder in your profile',
        });
      }
    }
    return problems.length === 0
      ? pass(id, 'warn', line)
      : fail(
          id,
          'warn',
          problems.map((problem) => problem.detail).join('; '),
          problems.map((problem) => problem.fix).join('; '),
        );
  });

  return {
    'app.claude': claude,
    'app.pty': pty,
    'app.windows': windows,
    'app.port': port,
    'app.memory': memory,
    'app.browser': browser,
    'app.autostart': autostartCheck,
    'app.instance': instance,
  };
}
