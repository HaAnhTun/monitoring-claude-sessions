#!/usr/bin/env node
// Dispatcher and command registry of the mcs CLI (01 6.1-6.5, ADR 0008, design 05 S-OUT). `main(argv, paths)` parses the command
// words, loads the command module, parses its options with `node:util` `parseArgs` against the command's option table,
// builds the `OpContext`, runs the command and renders its result: legacy text, legacy JSON or the `mcs.cli/1` envelope.
// Commands (`commands/<name>.ts`) hold an option table and call one engine operation; they print nothing themselves. Every
// byte of output goes through `io/terminal.ts`. Exit codes: 0 success, 1 failure or problems found, 2 usage error, 3 refused because
// terminals are live (06 3), 130 Ctrl+C.
//
// The scope rule (06 2.2, ADR 0092, `scope.ts`): a call acts on the app instance (`--user`) or on a task (`--task`, `--repo`, `--root`);
// a command that is given neither uses its `defaultScope`. For the app the kernel hands the command the user root as its context and
// sets the task of the command to `user`, so a command reads `--task` the way it always did. The engine words its hints for that
// task (`mcs start --task user`): the kernel words every text of an app call again (`scope.ts`, `appCommandText`), so no command
// has to.
//
// The registry below is the one place that knows the commands. Later work packages add entries inside their own marked
// block, in one of two forms (`RegistryEntry`): a command (`names` + a lazy loader of its module) or a provider of operation
// dependencies (`deps`: the probe of WP-19, transcript discovery of the ingestion WPs, ...), which the kernel merges and
// hands to every command.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import {
  USER_INSTANCE_SLUG,
  appCheckProviders,
  createLogger,
  tasksRootOf,
  testHook,
  userOpContext,
  type CheckDeps,
  type ConfigureDeps,
  type DiscoverDeps,
  type DoctorDeps,
  type InitDeps,
  type InspectDeps,
  type Logger,
  type OpContext,
  type VersionDeps,
} from '@mcs/engine';
import {
  CLI_NAME,
  McsError,
  PRODUCT_NAME,
  RUNTIME_VERSION,
  cliExitCode,
  systemClock,
  toCliError,
  type CliError,
} from '@mcs/shared';

import { printErrorLine, printLine } from './io/terminal.ts';
import { buildInfoOf, buildState, mainPathsOf } from './paths.ts';
import { describeCommand, errorEnvelope, renderEnvelope, resultEnvelope } from './render/json.ts';
import { renderLegacy } from './render/legacy.ts';
import {
  commandHelpLines,
  generalHelpLines,
  renderError,
  renderLines,
  renderWarnings,
  usageLine,
} from './render/text.ts';
import { appCommandText, appErrorOf, inAppScope, resolveScope, type Scope, type ScopeResolution } from './scope.ts';

// ---- contract of a command

/** Where the launcher (or the entry guard below) says the skill lives. */
export interface MainPaths {
  readonly launcherPath: string;
  readonly skillDir: string;
  readonly runtimeDir: string;
  /**
   * The name the person typed to start the launcher (the launcher says it). `mcs` is the alias: it gets the one note about the
   * new default scope (ADR 0092). Absent means `mcs`, which is what `node dist/main.js` is.
   */
  readonly program?: 'caw' | 'mcs';
}

export type OptionType = 'string' | 'boolean';

/** One option of a command: the source of parsing, validation and the help page. */
export interface OptionSpec {
  readonly type: OptionType;
  readonly short?: string;
  /** The option may repeat; `ParsedArgs.strings` returns every value. */
  readonly multiple?: boolean;
  /** Missing: usage error `<command> needs --<name> <VALUE>`. */
  readonly required?: boolean;
  /** Shown in the help page instead of `VALUE`. */
  readonly valueName?: string;
  /** The only accepted values. */
  readonly choices?: readonly string[];
  /** The option belongs to one scope: giving it to a call of the other scope is a usage error (`--force` is the app's). */
  readonly scope?: Scope;
  /** Options that cannot be given together with this one (usage error), by name. */
  readonly conflictsWith?: readonly string[];
  /** An integer option: inclusive bounds. Read it with `ParsedArgs.int`. */
  readonly integer?: readonly [min: number, max: number];
  readonly description: string;
}

export type OptionTable = Readonly<Record<string, OptionSpec>>;

/** The options after parsing and validation. A name that is not in the command's table (or the common table) is a bug. */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  string(name: string): string | undefined;
  strings(name: string): readonly string[];
  flag(name: string): boolean;
  int(name: string): number | undefined;
}

/**
 * The dependencies of the engine operations that belong to other work packages (transcript discovery, the instance probe,
 * hooks, the route file). Their field names are the ones of the operations' own `*Deps` types, so a
 * command passes `ctx.deps` straight on. Without a provider the operations degrade as designed (01 6.4).
 */
export interface OpDeps
  extends DiscoverDeps, VersionDeps, InspectDeps, CheckDeps, ConfigureDeps, InitDeps, DoctorDeps {}

export interface CommandCatalog {
  all(): Promise<readonly CommandDefinition[]>;
  /** The command named by `words` (`['config', 'migrate']`), or `null`. */
  find(words: readonly string[]): Promise<CommandDefinition | null>;
}

export interface CommandContext {
  readonly op: OpContext;
  readonly args: ParsedArgs;
  readonly deps: OpDeps;
  /**
   * The scope of the call (`scope.ts`): `user` acts on the app instance, `task` on a task. The kernel always sets it; a context
   * built by hand (a unit test of a command that does not care) leaves it out, which means `task`.
   */
  readonly scope?: Scope;
  /** `--json` was given: the kernel prints the envelope; a command never branches on it except for its `data`. */
  readonly json: boolean;
  /** The options every command takes (`--repo`, `--root`, `--user`, `--json`, `--help`). */
  readonly globalOptions: OptionTable;
  readonly catalog: CommandCatalog;
}

/** What a command returns; the kernel renders it (nothing is printed by the command). */
export interface CommandResult {
  /** The `data` of the `--json` envelope. */
  readonly data: unknown;
  /** Default output: result lines on stdout. */
  readonly text?: readonly string[];
  /** Default output of the five legacy-JSON commands: the legacy object, pretty printed (instead of `text`). */
  readonly legacy?: unknown;
  /** 1 when the command found problems (exit 1 without an error object). Default 0. */
  readonly exitCode?: 0 | 1;
  /** `warning: ...` lines on stderr, and `warnings` of the envelope. */
  readonly warnings?: readonly string[];
}

export interface CommandDefinition {
  /** The words that select it, `init` or `config migrate`. */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  /** What follows `mcs <name>` in the usage line. */
  readonly synopsis: string;
  readonly options: OptionTable;
  /** Positional arguments after the options: at most `max` (default: none). */
  readonly positionals?: { readonly max: number };
  /**
   * Who handles Ctrl+C while the command runs: the kernel (default), which ends the call with exit code 130, or the command
   * itself, which then forwards the signal (`serve` hands it to the server for a graceful shutdown). A command that owns
   * the signal never touches the kernel's listeners; the kernel does not register one for it.
   */
  readonly interruptible?: 'kernel' | 'command';
  /**
   * The scope of a call that gives none of `--user`, `--task`, `--repo` and `--root` (default `task`). The lifecycle family
   * (`start`, `stop`, `restart`, `status`, `serve`, `verify`, `doctor`, `check`) says `user`: without a selector they act on the app.
   */
  readonly defaultScope?: Scope;
  /**
   * The command acts on the app instance and on nothing else (`open`, `autostart *`, `config get|set`, 06 2.3). It has no `task`
   * option, so `--task` is an unknown option; the kernel refuses `--repo` and `--root`, which would select a task. Set it together
   * with `defaultScope: 'user'`.
   */
  readonly userOnly?: boolean;
  run(ctx: CommandContext): Promise<CommandResult>;
}

/** What a command module exports. */
export interface CommandModule {
  readonly command: CommandDefinition;
}

// ---- registry

/** A command: selected by `names[0]` or any alias word sequence; the module loads on demand. */
export interface CommandEntry {
  readonly names: readonly [string, ...string[]];
  readonly load: () => Promise<CommandModule>;
}

/** Contributes operation dependencies; later entries override earlier ones key by key. */
export interface DepsEntry {
  readonly deps: (op: OpContext) => OpDeps;
}

export type RegistryEntry = CommandEntry | DepsEntry;

const REGISTRY: readonly RegistryEntry[] = [
  { names: ['discover'], load: () => import('./commands/discover.ts') },
  { names: ['init', 'init-task'], load: () => import('./commands/init.ts') },
  { names: ['inspect'], load: () => import('./commands/inspect.ts') },
  { names: ['configure'], load: () => import('./commands/configure.ts') },
  { names: ['decide'], load: () => import('./commands/decide.ts') },
  { names: ['audit'], load: () => import('./commands/audit.ts') },
  { names: ['check'], load: () => import('./commands/check.ts') },
  { names: ['version'], load: () => import('./commands/version.ts') },
  { names: ['help'], load: () => import('./commands/help.ts') },
  { names: ['start'], load: () => import('./commands/start.ts') },
  { names: ['stop'], load: () => import('./commands/stop.ts') },
  { names: ['status'], load: () => import('./commands/status.ts') },
  { names: ['restart'], load: () => import('./commands/restart.ts') },
  { names: ['verify'], load: () => import('./commands/verify.ts') },
  { names: ['serve'], load: () => import('./commands/serve.ts') },
  // the full probe of 01 4.8 replaces the cheap look at state.json in inspect, discover and configure; the engine
  // module is loaded already (the static import above), so the dynamic import below costs nothing
  {
    deps: (op) => ({
      // the summary of the report: state, pid and url, not the identity and the bytes of the state file
      probe: async (ws) => {
        const engine = await import('@mcs/engine');
        const { state, pid, url } = await engine.probeInstance(ws, { runtimeDir: op.runtimeDir });
        return { state, pid, url };
      },
      isRunning: async (ws) => {
        const engine = await import('@mcs/engine');
        return engine.isLiveState((await engine.probeInstance(ws, { runtimeDir: op.runtimeDir })).state);
      },
    }),
  },

  // @wp-begin WP-22
  {
    names: ['instances list'],
    load: async () => ({ command: (await import('./commands/instances.ts')).listCommand }),
  },
  {
    names: ['instances repair'],
    load: async () => ({ command: (await import('./commands/instances.ts')).repairCommand }),
  },
  { names: ['doctor'], load: () => import('./commands/doctor.ts') },
  // @wp-end WP-22

  // @wp-begin WP-38
  { names: ['hooks install'], load: () => import('./commands/hooks/install.ts') },
  { names: ['hooks uninstall'], load: () => import('./commands/hooks/uninstall.ts') },
  { names: ['hooks verify'], load: () => import('./commands/hooks/verify.ts') },
  { names: ['hooks status'], load: () => import('./commands/hooks/status.ts') },
  {
    names: ['hooks enable'],
    load: async () => ({ command: (await import('./commands/hooks/toggle.ts')).enableCommand }),
  },
  {
    names: ['hooks disable'],
    load: async () => ({ command: (await import('./commands/hooks/toggle.ts')).disableCommand }),
  },
  { names: ['ingest replay'], load: () => import('./commands/ingest-replay.ts') },
  // the `hooks` line of `doctor` (the key `hooks` of `extraChecks` replaces the default line) and the `hooks:` line of `discover`
  {
    deps: (op) => ({
      hooksSummary: async () => (await import('@mcs/engine')).opsHooks.summary(op),
      extraChecks: {
        hooks: async (ctx, ws) => (await import('@mcs/engine')).opsHooks.doctorCheck(ctx, ws),
      },
    }),
  },
  // @wp-end WP-38

  // @wp-begin WP-61
  { names: ['sessions list'], load: () => import('./commands/sessions-list.ts') },
  { names: ['sessions show'], load: () => import('./commands/sessions-show.ts') },
  { names: ['usage'], load: () => import('./commands/usage.ts') },
  { names: ['errors'], load: () => import('./commands/errors.ts') },
  // @wp-end WP-61

  // @wp-begin WP-62
  { names: ['backup', 'backup create'], load: () => import('./commands/backup.ts') },
  { names: ['backup list'], load: () => import('./commands/backup-list.ts') },
  { names: ['backup restore'], load: () => import('./commands/backup-restore.ts') },
  { names: ['upgrade'], load: () => import('./commands/upgrade.ts') },
  { names: ['db migrate'], load: () => import('./commands/db-migrate.ts') },
  { names: ['db rebuild'], load: () => import('./commands/db-rebuild.ts') },
  // @wp-end WP-62

  // @wp-begin WP-108
  { names: ['export'], load: () => import('./commands/export.ts') },
  { names: ['verify-completion'], load: () => import('./commands/verify-completion.ts') },
  // @wp-end WP-108

  // @wp-begin WP-64
  { names: ['mcp'], load: () => import('./commands/mcp.ts') },
  // @wp-end WP-64

  // @wp-begin WP-85
  // transcript auto-detection (CR-WP-15-2) under the Claude home of the environment, and the rewrite of an existing route
  // file after `configure` changed a key that routes (CR-WP-14-2)
  {
    deps: (op) => ({
      transcripts: {
        detectDir: async (repo) => {
          const engine = await import('@mcs/engine');
          return engine.detectTranscriptsDir(repo, engine.projectsRoot(op.env));
        },
        recentSessions: async (dir, limit) => {
          const engine = await import('@mcs/engine');
          return engine.recentSessionsOf(dir, limit, op.clock.now(), engine.nodeDiscoveryFs, op.log);
        },
      },
      onRoutingChanged: async (ws) => {
        const engine = await import('@mcs/engine');
        await engine.refreshRouteFile({ env: op.env, skillDir: op.skillDir, clock: op.clock }, ws);
      },
    }),
  },
  // @wp-end WP-85

  // @wp-begin WP-95
  { names: ['migrate-workspace'], load: () => import('./commands/migrate-workspace.ts') },
  // @wp-end WP-95

  // @wp-begin WP-140
  // the doctor line that says whether the workspace still has the format of the monitor before 4.0 (read-only dry run)
  {
    deps: () => ({
      extraChecks: {
        'workspace.format': async (ctx, ws) => {
          const engine = await import('@mcs/engine');
          return engine.opsMigrate.workspaceFormatCheck(ctx, ws);
        },
      },
    }),
  },
  // @wp-end WP-140

  // @wp-begin WP-105
  // the doctor line that says which configuration keys do nothing (unsupported, unknown, or missing their partner key)
  {
    deps: () => ({
      extraChecks: {
        'config.keys': async (ctx, ws) => {
          const id = 'config.keys';
          if (ws === null) return { id, ok: true, level: 'error', detail: 'no task selected (skipped)' };
          const engine = await import('@mcs/engine');
          let resolved: Awaited<ReturnType<typeof engine.resolveConfig>>;
          try {
            resolved = await engine.resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
          } catch {
            return { id, ok: true, level: 'error', detail: 'no valid configuration (see config.valid)' };
          }
          // the shipped defaults alone must not warn (the logs panel is on without any log glob): only keys the task sets
          const explicit = new Set(
            Object.entries(resolved.provenance)
              .filter(([, source]) => source === 'config')
              .map(([key]) => key),
          );
          const warnings = engine.configKeyWarnings(resolved.monitor, { explicit });
          if (warnings.length === 0)
            return { id, ok: true, level: 'error', detail: 'every configured key has an effect' };
          return {
            id,
            ok: false,
            level: 'warn',
            detail: warnings.map((w) => w.message).join('; '),
            fix: `edit config.json of task ${ws.slug}: remove or correct the keys named above (mcs configure --task ${ws.slug} --unset KEY)`,
          };
        },
      },
    }),
  },
  // @wp-end WP-105

  // @wp-begin WP-107
  { names: ['cleanup'], load: () => import('./commands/cleanup.ts') },
  { names: ['config migrate'], load: () => import('./commands/config-migrate.ts') },
  // @wp-end WP-107

  // @wp-begin WP-141
  { names: ['diagnostics'], load: () => import('./commands/diagnostics.ts') },
  // @wp-end WP-141

  // @wp-begin CAW-33
  // the app.* checks of `caw doctor` and `caw check` (06 2.6): each answers `null` outside the app, so a task never sees them
  { deps: () => ({ extraChecks: appCheckProviders() }) },
  // @wp-end CAW-33

  // @wp-begin CAW-34
  // the commands of the app only (06 2.3): open the browser at a login URL, the Startup shortcut, and the seven settings a person
  // changes by name
  { names: ['open'], load: () => import('./commands/open.ts') },
  {
    names: ['autostart enable'],
    load: async () => ({ command: (await import('./commands/autostart.ts')).enableCommand }),
  },
  {
    names: ['autostart disable'],
    load: async () => ({ command: (await import('./commands/autostart.ts')).disableCommand }),
  },
  {
    names: ['autostart status'],
    load: async () => ({ command: (await import('./commands/autostart.ts')).statusCommand }),
  },
  { names: ['config get'], load: async () => ({ command: (await import('./commands/config-user.ts')).getCommand }) },
  { names: ['config set'], load: async () => ({ command: (await import('./commands/config-user.ts')).setCommand }) },
  // @wp-end CAW-34
];

/** The options of every command (01 6.2). `--config FILE` is not here: it is the legacy flat-config flag, or `init`'s seed. */
export const GLOBAL_OPTIONS: OptionTable = {
  repo: { type: 'string', valueName: 'PATH', description: 'repository root (default: the current directory)' },
  root: {
    type: 'string',
    valueName: 'PATH',
    description: 'tasks root (default: <repo>/.claude/monitor/tasks)',
  },
  user: {
    type: 'boolean',
    description: `act on the ${PRODUCT_NAME} app instance (the default of start, stop, restart, status, serve, verify, doctor and check)`,
  },
  json: { type: 'boolean', description: 'print one mcs.cli/1 JSON document instead of the default output' },
  help: { type: 'boolean', short: 'h', description: 'show this help' },
};

function isCommandEntry(entry: RegistryEntry): entry is CommandEntry {
  return 'names' in entry;
}

function isDepsEntry(entry: RegistryEntry): entry is DepsEntry {
  return 'deps' in entry;
}

// ---- command lookup

/** The words before the first option: `['config', 'migrate']` of `config migrate --task a`. */
function leadingWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-')) break;
    words.push(token);
  }
  return words;
}

const MAX_COMMAND_WORDS = 3;

function findEntry(argv: readonly string[]): { entry: CommandEntry; consumed: number } | null {
  const words = leadingWords(argv);
  for (let n = Math.min(words.length, MAX_COMMAND_WORDS); n >= 1; n -= 1) {
    const key = words.slice(0, n).join(' ');
    for (const entry of REGISTRY) {
      if (isCommandEntry(entry) && entry.names.includes(key)) return { entry, consumed: n };
    }
  }
  return null;
}

async function loadCommand(entry: CommandEntry): Promise<CommandDefinition> {
  const { command } = await entry.load();
  if (command.name !== entry.names[0]) {
    throw new McsError('INTERNAL', `command module '${command.name}' is registered as '${entry.names[0]}'`);
  }
  for (const name of Object.keys(command.options)) {
    if (Object.hasOwn(GLOBAL_OPTIONS, name)) {
      throw new McsError('INTERNAL', `command '${command.name}' redeclares the common option --${name}`);
    }
  }
  return command;
}

const catalog: CommandCatalog = {
  async all() {
    const out: CommandDefinition[] = [];
    for (const entry of REGISTRY) if (isCommandEntry(entry)) out.push(await loadCommand(entry));
    return out;
  },
  async find(words) {
    const key = words.join(' ');
    for (const entry of REGISTRY) {
      if (isCommandEntry(entry) && entry.names.includes(key)) return loadCommand(entry);
    }
    return null;
  },
};

// ---- parsing

type ParsedValues = ReturnType<typeof parseArgs>['values'];

function parseOptionsOf(table: OptionTable): NonNullable<ParseArgsConfig['options']> {
  return Object.fromEntries(
    Object.entries(table).map(([name, spec]) => [
      name,
      {
        type: spec.type,
        ...(spec.short === undefined ? {} : { short: spec.short }),
        ...(spec.multiple === true ? { multiple: true } : {}),
      },
    ]),
  );
}

/** The first sentence of the `parseArgs` message, as a usage message (`unknown option '--x'`). */
function usageMessageOf(error: unknown): string | null {
  if (!(error instanceof TypeError) || !('code' in error) || typeof error.code !== 'string') return null;
  if (!error.code.startsWith('ERR_PARSE_ARGS')) return null;
  const first = error.message.split('. ')[0] ?? error.message;
  return first.charAt(0).toLowerCase() + first.slice(1);
}

function viewOf(values: ParsedValues, positionals: readonly string[]): ParsedArgs {
  return {
    positionals,
    string(name) {
      const value = values[name];
      return typeof value === 'string' ? value : undefined;
    },
    strings(name) {
      const value = values[name];
      if (typeof value === 'string') return [value];
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    },
    flag(name) {
      return values[name] === true;
    },
    int(name) {
      const value = values[name];
      return typeof value === 'string' ? Number(value) : undefined;
    },
  };
}

const INTEGER_RE = /^[+-]?[0-9]+$/;

/** `usage: caw start [--port N] ... (caw help start)`: what follows a usage error. */
function usageHint(def: CommandDefinition): string {
  return `usage: ${usageLine(def)} (${CLI_NAME} help ${def.name})`;
}

function usageError(def: CommandDefinition, message: string): McsError {
  return new McsError('USAGE', message, { hint: usageHint(def) });
}

/**
 * Checks the values against the tables: the options of the other scope, options that exclude each other, required options,
 * choices, integer bounds, positional count.
 */
function validate(def: CommandDefinition, args: ParsedArgs, values: ParsedValues, scope: Scope): void {
  if (def.positionals === undefined ? args.positionals.length > 0 : args.positionals.length > def.positionals.max) {
    const extra = args.positionals[def.positionals?.max ?? 0] ?? '';
    throw usageError(def, `unexpected argument '${extra}'`);
  }
  for (const [name, spec] of Object.entries(def.options)) {
    const value = values[name];
    if (value !== undefined && spec.scope !== undefined && spec.scope !== scope) {
      throw usageError(
        def,
        spec.scope === 'user'
          ? `--${name} applies to the app instance, not to a task`
          : `--${name} applies to a task (--task SLUG), not to the app instance`,
      );
    }
    for (const other of spec.conflictsWith ?? []) {
      if (value !== undefined && values[other] !== undefined) {
        throw usageError(def, `--${name} cannot be combined with --${other}`);
      }
    }
    if (spec.required === true && value === undefined) {
      throw usageError(def, `${def.name} needs --${name} ${spec.valueName ?? 'VALUE'}`);
    }
    for (const text of args.strings(name)) {
      if (spec.choices !== undefined && !spec.choices.includes(text)) {
        throw usageError(def, `--${name} expects one of ${spec.choices.join(', ')}, got ${JSON.stringify(text)}`);
      }
      if (spec.integer !== undefined) {
        const [min, max] = spec.integer;
        const n = Number(text);
        if (!INTEGER_RE.test(text) || !Number.isSafeInteger(n) || n < min || n > max) {
          throw usageError(
            def,
            `--${name} expects an integer from ${String(min)} to ${String(max)}, got ${JSON.stringify(text)}`,
          );
        }
      }
    }
  }
}

/** The task of a command in the scope of the app: the slug of the one user instance (`ctx.args.string('task')` keeps working). */
const USER_TASK = USER_INSTANCE_SLUG;

type ParsedCall =
  | { readonly args: ParsedArgs; readonly helpRequested: true }
  | { readonly args: ParsedArgs; readonly helpRequested: false; readonly resolution: ScopeResolution };

/**
 * Parses and validates the options. The scope of the call is resolved before the validation: in the scope of the app a command
 * that has a `task` option gets `task = user`, so a required `--task` is satisfied and every read of it works unchanged.
 */
function parseCommandArgs(def: CommandDefinition, rest: readonly string[]): ParsedCall {
  let values: ParsedValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: parseOptionsOf({ ...GLOBAL_OPTIONS, ...def.options }),
      allowPositionals: def.positionals !== undefined,
      strict: true,
    }));
  } catch (error) {
    const message = usageMessageOf(error);
    if (message === null) throw error;
    throw usageError(def, message);
  }
  const typed = viewOf(values, positionals);
  if (typed.flag('help')) return { args: typed, helpRequested: true };
  const resolution = resolveScope(
    def,
    { user: typed.flag('user'), task: typed.string('task'), repo: typed.string('repo'), root: typed.string('root') },
    usageHint(def),
  );
  if (def.userOnly === true && resolution.scope === 'task') {
    throw usageError(def, `${def.name} acts on the app instance only; it cannot be combined with --repo or --root`);
  }
  const effective: ParsedValues =
    resolution.scope === 'user' && Object.hasOwn(def.options, 'task') ? { ...values, task: USER_TASK } : values;
  const args = viewOf(effective, positionals);
  validate(def, args, effective, resolution.scope);
  return { args, helpRequested: false, resolution };
}

// ---- operation context and dependencies

/**
 * The context of an operation. For the app (scope `user`) it is the user root, whatever the working directory is: `--repo` and
 * `--root` cannot be given in that scope. For a task it is the repository (`--repo` or the working directory) and its tasks root.
 */
function opContextOf(args: ParsedArgs, paths: MainPaths, scope: Scope): OpContext {
  // CLI logs reach stderr only at debug level (01 6.1): `MCS_DEBUG=1` turns them on.
  const level = process.env['MCS_DEBUG'] === '1' ? 'debug' : 'warn';
  const base = {
    skillDir: paths.skillDir,
    runtimeDir: paths.runtimeDir,
    launcherPath: paths.launcherPath,
    env: process.env,
    clock: systemClock,
    log: createLogger({ file: null, level, rotate: false, clock: systemClock }),
  };
  if (scope === 'user') return userOpContext(base);
  const repo = path.resolve(args.string('repo') ?? '.');
  const rootArg = args.string('root');
  return { ...base, repo, root: rootArg === undefined ? tasksRootOf(repo) : path.resolve(rootArg) };
}

/** What the kernel itself can provide: the build state of the runtime and the crash hook of `init` (01 2.10). */
function kernelDeps(op: OpContext): OpDeps {
  return {
    buildStatus: () => buildState(op.runtimeDir),
    buildInfo: () => buildInfoOf(op.runtimeDir),
    beforeRename: () => {
      if (testHook('INIT_CRASH', op.env) === 'before-rename') process.exit(70);
    },
  };
}

/**
 * Derived dependencies: `check` shows the transcripts folder the legacy monitor resolves from `auto` (null when no discovery
 * is wired or nothing is found, which the legacy line shows as `None`); `discover` and `inspect` show the state name of the
 * probe when there is one.
 */
function withDerived(deps: OpDeps): OpDeps {
  const transcripts = deps.transcripts;
  const probe = deps.probe;
  const resolveTranscripts: NonNullable<CheckDeps['transcriptsDir']> = async (monitor) => {
    const configured = monitor.transcripts_dir;
    if (configured !== null && configured !== 'auto') return configured;
    return transcripts === undefined ? null : transcripts.detectDir(monitor.repo);
  };
  const probeState: NonNullable<DiscoverDeps['probeState']> | undefined =
    probe === undefined ? undefined : async (ws) => (await probe(ws)).state;
  return {
    ...deps,
    ...(deps.transcriptsDir === undefined ? { transcriptsDir: resolveTranscripts } : {}),
    ...(deps.probeState === undefined && probeState !== undefined ? { probeState } : {}),
  };
}

function depsOf(op: OpContext): OpDeps {
  let merged: OpDeps = kernelDeps(op);
  for (const entry of REGISTRY) {
    if (!isDepsEntry(entry)) continue;
    const next = entry.deps(op);
    // every area adds its own doctor checks: the records are merged, not replaced (WP-22)
    const extraChecks =
      merged.extraChecks === undefined && next.extraChecks === undefined
        ? undefined
        : { ...merged.extraChecks, ...next.extraChecks };
    merged = { ...merged, ...next, ...(extraChecks === undefined ? {} : { extraChecks }) };
  }
  return withDerived(merged);
}

// ---- output

function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

function cliErrorOf(error: unknown): CliError {
  if (error instanceof McsError) return toCliError(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'INTERNAL',
    message: `internal error: ${message}`,
    hint: 'run again with MCS_DEBUG=1 for the stack',
    details: null,
  };
}

interface RunState {
  /** The command name for the envelope: the typed word until the command is known, then the canonical name. */
  command: string;
  json: boolean;
  log: Logger | null;
  /** The scope of the call once it is known (`null` before: a usage error is worded for no scope). */
  scope: Scope | null;
  /** Takes the kernel's Ctrl+C listener off (for a command that owns the signal). */
  releaseInterrupt: () => void;
}

function reportFailure(run: RunState, error: unknown): number {
  const raw = cliErrorOf(error);
  const cli = run.scope === 'user' ? appErrorOf(raw) : raw;
  if (run.json) {
    renderEnvelope(errorEnvelope(run.command === '' ? 'mcs' : run.command, cli));
  } else {
    renderError(cli);
    if (process.env['MCS_DEBUG'] === '1' && error instanceof Error && error.stack !== undefined) {
      printErrorLine(error.stack);
    }
  }
  return cliExitCode(cli.code);
}

/** The result of an app call worded for the person of the app: every text, the warnings and the data (`appCommandText`). */
function appResultOf(result: CommandResult): CommandResult {
  return {
    ...result,
    data: inAppScope(result.data),
    ...(result.text === undefined ? {} : { text: result.text.map(appCommandText) }),
    ...(result.legacy === undefined ? {} : { legacy: inAppScope(result.legacy) }),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings.map(appCommandText) }),
  };
}

function renderResult(def: CommandDefinition, json: boolean, result: CommandResult): number {
  if (json) {
    renderEnvelope(resultEnvelope(def.name, result));
  } else {
    renderWarnings(result.warnings ?? []);
    if (result.legacy !== undefined) renderLegacy(result.legacy);
    else renderLines(result.text ?? []);
  }
  return result.exitCode ?? 0;
}

// ---- dispatch

function unknownCommand(words: readonly string[], argv: readonly string[]): McsError {
  const typed = words[0] ?? argv[0] ?? '';
  return new McsError('USAGE', `unknown command '${typed}'`, { hint: helpHint() });
}

function helpHint(): string {
  return `run '${CLI_NAME} help' for the list of commands`;
}

/**
 * The one note for people who still type `mcs` (06 2.2, ADR 0092): before the app existed, `mcs start`, `stop`, `status` and the rest
 * without a selector acted on the task `default`. The note ships in 4.1.0 and is shown by two releases (4.1 and 4.2): REMOVE it, its
 * use in `withScopeNote` and its tests in `main.test.ts` in 4.3.0 (the removal date of ADR 0092).
 */
const LEGACY_NAME_NOTE = `without --task, --repo or --root this command now acts on the ${PRODUCT_NAME} app (before it acted on the task 'default'); pass --task default to keep the old behaviour`;

/** The result with the note appended to its warnings, when the program is `mcs` and nobody chose the app: the default did. */
function withScopeNote(result: CommandResult, resolution: ScopeResolution, paths: MainPaths): CommandResult {
  const program = paths.program ?? 'mcs';
  if (program !== 'mcs' || resolution.scope !== 'user' || !resolution.defaulted) return result;
  return { ...result, warnings: [...(result.warnings ?? []), LEGACY_NAME_NOTE] };
}

async function dispatch(argv: readonly string[], paths: MainPaths, run: RunState): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    renderLines(generalHelpLines(await catalog.all(), GLOBAL_OPTIONS));
    return 2;
  }
  if (first === '-h' || first === '--help') return dispatch(['help', ...argv.slice(1)], paths, run);
  if (first === '--version') {
    printLine(`${CLI_NAME} ${RUNTIME_VERSION}`);
    return 0;
  }
  const found = findEntry(argv);
  if (found === null) {
    if (first.startsWith('-')) {
      throw new McsError('USAGE', `expected a command, got option '${first}'`, { hint: helpHint() });
    }
    throw unknownCommand(leadingWords(argv), argv);
  }
  const def = await loadCommand(found.entry);
  run.command = def.name;
  if (def.interruptible === 'command') run.releaseInterrupt();
  const parsed = parseCommandArgs(def, argv.slice(found.consumed));
  const { args } = parsed;
  run.json = args.flag('json');
  if (parsed.helpRequested) {
    if (run.json) renderEnvelope(resultEnvelope(def.name, { data: describeCommand(def, GLOBAL_OPTIONS) }));
    else renderLines(commandHelpLines(def, GLOBAL_OPTIONS));
    return 0;
  }
  const { resolution } = parsed;
  run.scope = resolution.scope;
  const op = opContextOf(args, paths, resolution.scope);
  run.log = op.log;
  const result = await def.run({
    op,
    args,
    scope: resolution.scope,
    deps: depsOf(op),
    json: run.json,
    globalOptions: GLOBAL_OPTIONS,
    catalog,
  });
  const worded = resolution.scope === 'user' ? appResultOf(result) : result;
  return renderResult(def, run.json, withScopeNote(worded, resolution, paths));
}

/**
 * Runs one CLI call and returns its exit code (the caller sets `process.exitCode`; nothing here calls `process.exit`
 * except Ctrl+C). The launcher calls this in-process (01 5.1 step 7).
 */
export async function main(argv: readonly string[], paths: MainPaths): Promise<number> {
  const onInterrupt = (): void => {
    process.exit(130);
  };
  const run: RunState = {
    command: leadingWords(argv)[0] ?? '',
    json: wantsJson(argv),
    log: null,
    scope: null,
    releaseInterrupt: () => {
      process.off('SIGINT', onInterrupt);
    },
  };
  process.once('SIGINT', onInterrupt);
  try {
    return await dispatch(argv, paths, run);
  } catch (error) {
    return reportFailure(run, error);
  } finally {
    process.off('SIGINT', onInterrupt);
    await run.log?.close();
  }
}

// ---- entry (`node dist/main.js <args>`; the launcher imports `main` instead)

function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // run directly (a checkout's dist, or a bundle entry): the layout resolver names the folders (ADR 0062 item 2)
  main(process.argv.slice(2), mainPathsOf(import.meta.url)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      printErrorLine(`ERROR: internal error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
