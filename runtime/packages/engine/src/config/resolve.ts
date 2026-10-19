// Effective configuration (01 section 2.3): built-in, skill, instance, environment and CLI layers, merged with the
// legacy rule, validated with the legacy messages, with per-key provenance. A pure function apart from the file reads:
// no network, no process spawn, nothing is written (the shared legacy defaults least of all).
import path from 'node:path';

import {
  LogLevelSchema,
  McsError,
  R_DERIVED_DEFAULTS,
  R_MERGED,
  RuntimeFileSchema,
  RuntimeOverridesSchema,
  applyDerivedMap,
  type ConfigFileStatus,
  type ConfigSource,
  type LogLevel,
  type RuntimeConfig,
} from '@mcs/shared';

import { toPlain } from '../json/index.ts';
import { isMsysPath } from '../platform/paths.ts';
import {
  checkSchemaVersion,
  defaultSkillDir,
  getEntry,
  loadSkillDefaults,
  parseLegacyConfig,
  readConfigJson,
  readOptionalConfigJson,
  schemaVersionOf,
  type LegacyConfig,
  type JsonObject,
} from './defaults.ts';
import { L_MERGED, isPlainObject, mergeLayer, setOwn, type PlainObject } from './merge.ts';
import { legacyProvenance, runtimeProvenance, type RuntimeLayer } from './provenance.ts';
import { compileConfigPatterns, validateLegacy, type CompiledPatterns } from './validate-legacy.ts';

/**
 * The workspace handle as far as configuration needs it: the folder that holds `task.json`, `config.json` and
 * `runtime.json`. The workspace module's own `WorkspaceRef` (WP-13) satisfies it.
 */
export interface ConfigWorkspace {
  readonly dir: string;
}

export interface ResolveInput {
  readonly workspace: ConfigWorkspace | null;
  /** The environment; only `MCS_LOG_LEVEL` is read (01 2.10, layer 3.5). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Layer 4: `--port` (0 or absent = not given) and `--log-level`. */
  readonly cli: { readonly port?: number; readonly logLevel?: LogLevel };
  /** The skill folder (`config/defaults.json`, `runtime/defaults.json`); the folder this code ships in by default. */
  readonly skillDir?: string;
  /**
   * Already parsed documents that stand in for the files of the workspace, so that a change can be resolved before it is
   * written (`configure` checks its intended result this way, with nothing copied or written). `config` replaces
   * `config.json`; `runtime` replaces `runtime.json`, and `null` means that file does not exist. A key that is absent
   * is read from disk. `task.json` is always read from the workspace. Ignored without a workspace.
   */
  readonly override?: { readonly config?: JsonObject; readonly runtime?: JsonObject | null };
}

export interface ResolvedConfig {
  /** Merged legacy (L) keys; `repo` is absolute; no `_` keys and no `_source_path`. */
  readonly monitor: LegacyConfig;
  /** Merged and defaulted runtime (R) keys. */
  readonly runtime: RuntimeConfig;
  readonly effectivePort: number;
  /** Dotted key to the layer that produced the value, plus `effectivePort` (01 2.5). */
  readonly provenance: Record<string, ConfigSource>;
  readonly patterns: CompiledPatterns;
  readonly files: ConfigFileStatus[];
  readonly source: 'task' | 'defaults';
}

const PORT_MAX = 65535;
const LEVELS = LogLevelSchema.options.join(', ');

function invalid(message: string, cause?: unknown): McsError {
  return new McsError('CONFIG_INVALID', message, cause === undefined ? {} : { cause });
}

/** The plain object of a parsed document; an integer beyond 2^53-1 cannot be held by a number and is refused. */
function plainObject(doc: JsonObject, file: string): PlainObject {
  let plain: unknown;
  try {
    plain = toPlain(doc);
  } catch (error) {
    if (error instanceof RangeError) throw invalid(`${file}: an integer is beyond 2^53-1 in magnitude`, error);
    throw error;
  }
  if (!isPlainObject(plain)) throw invalid(`${file} must contain a JSON object`);
  return plain;
}

function formatPath(segments: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of segments) {
    out += typeof segment === 'number' ? `[${String(segment)}]` : `${out === '' ? '' : '.'}${String(segment)}`;
  }
  return out;
}

function getPath(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(root: PlainObject, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    const next = Object.hasOwn(cur, part) ? cur[part] : undefined;
    if (!isPlainObject(next)) throw new Error(`cannot set ${dotted}: ${part} is not an object`);
    cur = next;
  }
  setOwn(cur, parts[parts.length - 1] ?? dotted, value);
}

interface RuntimeFile {
  readonly overrides: PlainObject;
  readonly status: ConfigFileStatus;
}

/** Steps 4: gate, then strict validation of a runtime file; the overrides without `schema_version`. */
function runtimeOverrides(doc: JsonObject, name: 'runtime/defaults.json' | 'runtime.json', file: string): RuntimeFile {
  checkSchemaVersion(doc, file, 'runtime.json');
  const plain = plainObject(doc, file);
  const parsed = RuntimeOverridesSchema.safeParse(plain);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = formatPath(issue.path);
      return where === '' ? `${name}: ${issue.message}` : `${name}: ${where}: ${issue.message}`;
    });
    throw invalid(`invalid runtime config ${file}: ${problems.join('; ')}`, parsed.error);
  }
  const overrides: PlainObject = {};
  for (const [key, value] of Object.entries(plain)) if (key !== 'schema_version') setOwn(overrides, key, value);
  return { overrides, status: { name, path: file, schemaVersion: schemaVersionOf(doc), present: true, ok: true } };
}

function absentStatus(name: 'runtime/defaults.json' | 'runtime.json', file: string): ConfigFileStatus {
  return { name, path: file, schemaVersion: null, present: false, ok: true };
}

function parseLevel(value: unknown, label: string): LogLevel {
  const parsed = LogLevelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : String(value);
  throw invalid(`${label}: expected one of ${LEVELS}, got ${shown}`);
}

function cliPort(port: number | undefined): number | null {
  if (port === undefined || port === 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > PORT_MAX) {
    throw invalid(`--port: expected integer 1-${String(PORT_MAX)}, got ${String(port)}`);
  }
  return port;
}

/** Step 1 and the validation of the shared defaults themselves (they ship valid; an edited file is refused early). */
async function sharedDefaults(skillDir: string): Promise<{ plain: PlainObject; status: ConfigFileStatus }> {
  const loaded = await loadSkillDefaults(skillDir);
  const problems = validateLegacy(loaded.doc, { strict: true });
  if (problems.length > 0) throw invalid(`invalid shared defaults ${loaded.path}: ${problems.join('; ')}`);
  return {
    plain: plainObject(loaded.doc, loaded.path),
    status: {
      name: 'defaults.json',
      path: loaded.path,
      schemaVersion: schemaVersionOf(loaded.doc),
      present: true,
      ok: true,
    },
  };
}

interface Instance {
  readonly over: PlainObject;
  readonly task: JsonObject;
  readonly configStatus: ConfigFileStatus;
}

/** Step 2: `task.json` (an object) and the gated, strictly validated `config.json`. */
async function instanceLegacy(dir: string, override: JsonObject | undefined): Promise<Instance> {
  const task = await readConfigJson(path.join(dir, 'task.json'));
  const configPath = path.join(dir, 'config.json');
  const doc = override ?? (await readConfigJson(configPath));
  checkSchemaVersion(doc, configPath, 'config.json');
  const problems = validateLegacy(doc, { strict: true });
  if (problems.length > 0) throw invalid(`invalid task config ${configPath}: ${problems.join('; ')}`);
  return {
    over: plainObject(doc, configPath),
    task,
    configStatus: {
      name: 'config.json',
      path: configPath,
      schemaVersion: schemaVersionOf(doc),
      present: true,
      ok: true,
    },
  };
}

/** Step 3: `repo` is the merged value, or the `task.json` one when `config.json` has none; made absolute. */
function resolveRepo(
  merged: PlainObject,
  over: PlainObject,
  task: JsonObject | null,
  base: string,
  taskFile: string,
): string {
  const configured = merged['repo'];
  let repo = typeof configured === 'string' ? configured : '.';
  if (task !== null && !Object.hasOwn(over, 'repo')) {
    const fromTask = getEntry(task, 'repo');
    if (fromTask?.k === 'str' && fromTask.v !== '') {
      if (isMsysPath(fromTask.v)) throw invalid(`invalid task config ${taskFile}: repo: use C:/... instead of /c/...`);
      repo = fromTask.v;
    }
  }
  return path.resolve(base, repo);
}

/** The five derived keys that no layer set (01 1.6): computed from the merged legacy values and checked with the key's bounds. */
function fillDerived(
  merged: PlainObject,
  monitor: PlainObject,
  legacySources: Readonly<Record<string, ConfigSource>>,
): Record<string, ConfigSource> {
  const sources: Record<string, ConfigSource> = {};
  const problems: string[] = [];
  for (const [key, derived] of Object.entries(R_DERIVED_DEFAULTS)) {
    if (getPath(merged, key) !== null) continue;
    const from = getPath(monitor, derived.from);
    const hint = `set ${key} in runtime.json`;
    if (typeof from !== 'number') {
      problems.push(`runtime: ${key} derived from ${derived.from} (${String(from)}): expected a number; ${hint}`);
      continue;
    }
    const value = applyDerivedMap(derived.map, from);
    const [section = '', name = ''] = key.split('.');
    const checked = RuntimeOverridesSchema.safeParse({ schema_version: 1, [section]: { [name]: value } });
    if (!checked.success) {
      const message = checked.error.issues[0]?.message ?? 'value rejected';
      problems.push(`runtime: ${key} derived from ${derived.from} (${String(from)}): ${message}; ${hint}`);
      continue;
    }
    setPath(merged, key, value);
    sources[key] = legacySources[derived.from] ?? 'skill';
  }
  if (problems.length > 0) throw invalid(problems.join('; '));
  return sources;
}

function effectivePortOf(
  cli: number | null,
  runtime: RuntimeConfig,
  monitor: LegacyConfig,
  provenance: Readonly<Record<string, ConfigSource>>,
): { port: number; source: ConfigSource } {
  if (cli !== null) return { port: cli, source: 'cli' };
  if (runtime.server.port !== null)
    return { port: runtime.server.port, source: provenance['server.port'] ?? 'builtin' };
  return { port: monitor.port, source: provenance['port'] ?? 'skill' };
}

/** The merged runtime configuration without the file marker: what `ResolvedConfig.runtime` holds. */
const RuntimeConfigSchema = RuntimeFileSchema.omit({ schema_version: true });

/** The built-in layer: every default of the runtime schema, derived keys `null`. */
function builtinRuntime(): PlainObject {
  return structuredClone({ ...RuntimeConfigSchema.parse({}) });
}

export async function resolveConfig(i: ResolveInput): Promise<ResolvedConfig> {
  const skillDir = i.skillDir ?? defaultSkillDir();
  const files: ConfigFileStatus[] = [];

  // 1. shared legacy defaults
  const defaults = await sharedDefaults(skillDir);
  files.push(defaults.status);

  // 2. the instance's legacy files
  const instance = i.workspace === null ? null : await instanceLegacy(i.workspace.dir, i.override?.config);
  const over = instance?.over ?? {};

  // 3. merge L, then repo
  const mergedL = mergeLayer(defaults.plain, over, L_MERGED);
  const base = i.workspace === null ? process.cwd() : i.workspace.dir;
  const taskFile = i.workspace === null ? '' : path.join(i.workspace.dir, 'task.json');
  setOwn(mergedL, 'repo', resolveRepo(mergedL, over, instance?.task ?? null, base, taskFile));
  const monitor = parseLegacyConfig(mergedL);
  const legacySources = legacyProvenance(defaults.plain, over);

  // 4. runtime files
  const skillRuntimeFile = path.join(skillDir, 'runtime', 'defaults.json');
  const skillDoc = await readOptionalConfigJson(skillRuntimeFile);
  const skill = skillDoc === null ? null : runtimeOverrides(skillDoc, 'runtime/defaults.json', skillRuntimeFile);
  files.push(skill?.status ?? absentStatus('runtime/defaults.json', skillRuntimeFile));
  let runtimeFile: RuntimeFile | null = null;
  if (i.workspace !== null) {
    if (instance !== null) files.push(instance.configStatus);
    const file = path.join(i.workspace.dir, 'runtime.json');
    const doc = i.override?.runtime !== undefined ? i.override.runtime : await readOptionalConfigJson(file);
    runtimeFile = doc === null ? null : runtimeOverrides(doc, 'runtime.json', file);
    files.push(runtimeFile?.status ?? absentStatus('runtime.json', file));
  }

  // 5. merge R, then the environment and the CLI
  const layers: RuntimeLayer[] = [];
  let mergedR = builtinRuntime();
  if (skill !== null) {
    mergedR = mergeLayer(mergedR, skill.overrides, R_MERGED);
    layers.push({ source: 'skill', overrides: skill.overrides });
  }
  if (runtimeFile !== null) {
    mergedR = mergeLayer(mergedR, runtimeFile.overrides, R_MERGED);
    layers.push({ source: 'runtime', overrides: runtimeFile.overrides });
  }
  const envLevel = i.env['MCS_LOG_LEVEL'];
  if (envLevel !== undefined) {
    const overrides = { logLevel: parseLevel(envLevel, 'MCS_LOG_LEVEL') };
    mergedR = mergeLayer(mergedR, overrides, R_MERGED);
    layers.push({ source: 'env', overrides });
  }
  if (i.cli.logLevel !== undefined) {
    const overrides = { logLevel: parseLevel(i.cli.logLevel, '--log-level') };
    mergedR = mergeLayer(mergedR, overrides, R_MERGED);
    layers.push({ source: 'cli', overrides });
  }
  const port = cliPort(i.cli.port);

  // 6. derived defaults, then the final parse
  const derivedSources = fillDerived(mergedR, mergedL, legacySources);
  const parsed = RuntimeConfigSchema.safeParse(mergedR);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `runtime: ${formatPath(issue.path)}: ${issue.message}`);
    throw invalid(problems.join('; '), parsed.error);
  }
  const runtime: RuntimeConfig = parsed.data;

  // 7. patterns
  const patterns = compileConfigPatterns(monitor);

  // 8. provenance and the effective port
  const provenance: Record<string, ConfigSource> = {
    ...legacySources,
    ...runtimeProvenance(layers, runtime, derivedSources),
  };
  const effective = effectivePortOf(port, runtime, monitor, provenance);
  provenance['effectivePort'] = effective.source;

  return {
    monitor,
    runtime,
    effectivePort: effective.port,
    provenance,
    patterns,
    files,
    source: i.workspace === null ? 'defaults' : 'task',
  };
}
