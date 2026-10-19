#!/usr/bin/env node
// Dispatcher and command registry of the mcs CLI (01 6.1-6.5, ADR 0008, design 05 S-OUT). `main(argv, paths)` parses the command
// words, loads the command module, parses its options with `node:util` `parseArgs` against the command's option table,
// builds the `OpContext`, runs the command and renders its result: legacy text, legacy JSON or the `mcs.cli/1` envelope.
// Commands (`commands/<name>.ts`) hold an option table and call one engine operation; they print nothing themselves. Every
// byte of output goes through `io/terminal.ts`. Exit codes: 0 success, 1 failure or problems found, 2 usage error, 130 Ctrl+C.
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
  createLogger,
  tasksRootOf,
  testHook,
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
import { McsError, RUNTIME_VERSION, cliExitCode, systemClock, toCliError, type CliError } from '@mcs/shared';

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

// ---- contract of a command

/** Where the launcher (or the entry guard below) says the skill lives. */
export interface MainPaths {
  readonly launcherPath: string;
  readonly skillDir: string;
  readonly runtimeDir: string;
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
  /** `--json` was given: the kernel prints the envelope; a command never branches on it except for its `data`. */
  readonly json: boolean;
  /** The options every command takes (`--repo`, `--root`, `--json`, `--help`). */
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
  // @wp-begin WP-19
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
  // @wp-end WP-19

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
  // @wp-end WP-38

  // @wp-begin WP-61
  // @wp-end WP-61

  // @wp-begin WP-62
  { names: ['backup', 'backup create'], load: () => import('./commands/backup.ts') },
  { names: ['backup list'], load: () => import('./commands/backup-list.ts') },
  { names: ['backup restore'], load: () => import('./commands/backup-restore.ts') },
  { names: ['upgrade'], load: () => import('./commands/upgrade.ts') },
  { names: ['db migrate'], load: () => import('./commands/db-migrate.ts') },
  { names: ['db rebuild'], load: () => import('./commands/db-rebuild.ts') },
  // @wp-end WP-62

  // @wp-begin WP-63
  // @wp-end WP-63

  // @wp-begin WP-64
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
];

/** The options of every command (01 6.2). `--config FILE` is not here: it is the legacy flat-config flag, or `init`'s seed. */
export const GLOBAL_OPTIONS: OptionTable = {
  repo: { type: 'string', valueName: 'PATH', description: 'repository root (default: the current directory)' },
  root: {
    type: 'string',
    valueName: 'PATH',
    description: 'tasks root (default: <repo>/.claude/monitor/tasks)',
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

function usageError(def: CommandDefinition, message: string): McsError {
  return new McsError('USAGE', message, { hint: `usage: ${usageLine(def)} (mcs help ${def.name})` });
}

/** Checks the values against the tables: required options, choices, integer bounds, positional count. */
function validate(def: CommandDefinition, args: ParsedArgs, values: ParsedValues): void {
  if (def.positionals === undefined ? args.positionals.length > 0 : args.positionals.length > def.positionals.max) {
    const extra = args.positionals[def.positionals?.max ?? 0] ?? '';
    throw usageError(def, `unexpected argument '${extra}'`);
  }
  for (const [name, spec] of Object.entries(def.options)) {
    const value = values[name];
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

function parseCommandArgs(
  def: CommandDefinition,
  rest: readonly string[],
): { args: ParsedArgs; helpRequested: boolean } {
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
  const args = viewOf(values, positionals);
  if (args.flag('help')) return { args, helpRequested: true };
  validate(def, args, values);
  return { args, helpRequested: false };
}

// ---- operation context and dependencies

function opContextOf(args: ParsedArgs, paths: MainPaths): OpContext {
  const repo = path.resolve(args.string('repo') ?? '.');
  const rootArg = args.string('root');
  // CLI logs reach stderr only at debug level (01 6.1): `MCS_DEBUG=1` turns them on.
  const level = process.env['MCS_DEBUG'] === '1' ? 'debug' : 'warn';
  return {
    repo,
    root: rootArg === undefined ? tasksRootOf(repo) : path.resolve(rootArg),
    skillDir: paths.skillDir,
    runtimeDir: paths.runtimeDir,
    launcherPath: paths.launcherPath,
    env: process.env,
    clock: systemClock,
    log: createLogger({ file: null, level, rotate: false, clock: systemClock }),
  };
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
  /** Takes the kernel's Ctrl+C listener off (for a command that owns the signal). */
  releaseInterrupt: () => void;
}

function reportFailure(run: RunState, error: unknown): number {
  const cli = cliErrorOf(error);
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
  return new McsError('USAGE', `unknown command '${typed}'`, { hint: "run 'mcs help' for the list of commands" });
}

async function dispatch(argv: readonly string[], paths: MainPaths, run: RunState): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    renderLines(generalHelpLines(await catalog.all(), GLOBAL_OPTIONS));
    return 2;
  }
  if (first === '-h' || first === '--help') return dispatch(['help', ...argv.slice(1)], paths, run);
  if (first === '--version') {
    printLine(`mcs ${RUNTIME_VERSION}`);
    return 0;
  }
  const found = findEntry(argv);
  if (found === null) {
    if (first.startsWith('-')) {
      throw new McsError('USAGE', `expected a command, got option '${first}'`, {
        hint: "run 'mcs help' for the list of commands",
      });
    }
    throw unknownCommand(leadingWords(argv), argv);
  }
  const def = await loadCommand(found.entry);
  run.command = def.name;
  if (def.interruptible === 'command') run.releaseInterrupt();
  const { args, helpRequested } = parseCommandArgs(def, argv.slice(found.consumed));
  run.json = args.flag('json');
  if (helpRequested) {
    if (run.json) renderEnvelope(resultEnvelope(def.name, { data: describeCommand(def, GLOBAL_OPTIONS) }));
    else renderLines(commandHelpLines(def, GLOBAL_OPTIONS));
    return 0;
  }
  const op = opContextOf(args, paths);
  run.log = op.log;
  const result = await def.run({
    op,
    args,
    deps: depsOf(op),
    json: run.json,
    globalOptions: GLOBAL_OPTIONS,
    catalog,
  });
  return renderResult(def, run.json, result);
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
