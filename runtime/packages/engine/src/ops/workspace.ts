// Engine operations behind `discover`, `init` and `version` (01 6.1, 6.3, 6.4, registry 2.1): typed input, typed result,
// `McsError` for every expected failure. The CLI renders these results and the server may read them; nothing here prints.
// The operations that need modules of later work packages (transcript discovery, the control-channel probe, hooks and
// the Python engine) take them as optional dependencies and report "unknown" without them; they never guess.
import path from 'node:path';

import { McsError, RUNTIME_VERSION, StateFileSchema, stateEngine, type Clock, type StateFile } from '@mcs/shared';

import type { Logger } from '../log/logger.ts';
import { globFiles } from '../platform/glob.ts';
import { pidAlive } from '../platform/process.ts';
import { pyRepr, toPlain } from '../pyjson/index.ts';
import { readTaskFile, type EngineName } from '../workspace/adopt.ts';
import { readJsonFile } from '../workspace/fsio.ts';
import { initWorkspace } from '../workspace/init.ts';
import { listWorkspaceSlugs, listWorkspaces } from '../workspace/list.ts';
import { resolveWorkspace, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';

/** What every operation receives (01 6.1). All fields are resolved by the caller; operations read no process state. */
export interface OpContext {
  /** Absolute (`path.resolve(--repo ?? '.')`). */
  readonly repo: string;
  /** The tasks root. */
  readonly root: string;
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly launcherPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; `Date` values are derived at the call site (`new Date(clock.now())`). */
  readonly clock: Clock;
  readonly log: Logger;
}

// ---- the cheap probe of `inspect` and `discover`

/**
 * What a look at `state.json` and the process table can tell without a control-channel or HTTP query: `stopped` (no usable
 * state file), `stale` / `legacy-stale` (the pid is gone, by engine of the state file) and `unverified` (the pid is alive,
 * identity not checked). The full classification of 01 4.8 belongs to `probeInstance`.
 */
export type QuickProbeState = 'stopped' | 'stale' | 'legacy-stale' | 'unverified';

/** What `inspect` and `discover` show of an instance: a probe state name (01 4.8 or a quick one), the pid and the URL. */
export interface ProbeSummary {
  readonly state: string;
  readonly pid: number | null;
  readonly url: string | null;
}

export interface QuickProbe extends ProbeSummary {
  readonly state: QuickProbeState;
}

/** The state file of a workspace when it exists and is usable; any read or schema problem means "no state" (legacy `read_state`). */
export async function readStateFile(ws: Pick<WorkspaceRef, 'dir'>): Promise<StateFile | null> {
  let plain: unknown;
  try {
    plain = toPlain((await readJsonFile(workspacePath(ws, 'state.json'))).value);
  } catch (error) {
    if (error instanceof McsError || error instanceof RangeError) return null;
    throw error;
  }
  const parsed = StateFileSchema.safeParse(plain);
  return parsed.success ? parsed.data : null;
}

export async function quickProbe(ws: Pick<WorkspaceRef, 'dir'>): Promise<QuickProbe> {
  const state = await readStateFile(ws);
  if (state === null) return { state: 'stopped', pid: null, url: null };
  if (!pidAlive(state.pid)) {
    return { state: stateEngine(state) === 'node' ? 'stale' : 'legacy-stale', pid: state.pid, url: state.url };
  }
  return { state: 'unverified', pid: state.pid, url: state.url };
}

/** The workspace of an operation: a valid slug, and a `task.json` that names its own folder (`TASK_NOT_FOUND`, `IDENTITY_MISMATCH`). */
export async function openWorkspace(ctx: Pick<OpContext, 'root'>, slug: string): Promise<WorkspaceRef> {
  const ws = resolveWorkspace(ctx.root, slug);
  await readTaskFile(ws);
  return ws;
}

// ---- init

export interface InitInput {
  /** The task name; required unless `slug` is given (then the slug is the name). */
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly port?: number;
  /** `--config FILE`: a seed of legacy (L) keys. */
  readonly seedConfig?: string;
  readonly engine?: EngineName;
}

export interface InitDeps {
  /** Runs once the staging folder is complete and before it is renamed into place (the crash hook of the test harness). */
  readonly beforeRename?: () => void | Promise<void>;
}

export interface InitOpResult {
  readonly created: boolean;
  readonly adopted: boolean;
  readonly slug: string;
  readonly dir: string;
  readonly instanceId: string;
  readonly engine: EngineName;
  /** The legacy lines: `created task 'x' at <dir>`, or `reused (nothing overwritten) task 'x' at <dir>` and, when adopted, `added Node runtime files: instance.json`. */
  readonly message: readonly string[];
}

/**
 * `ops.workspace.init` (01 4.12): validates, then creates, reuses or adopts the workspace of `input` under the task
 * mutex. A new workspace is audited `init-task`, an adopted one `adopt-instance`; a reuse writes nothing.
 */
export async function init(ctx: OpContext, input: InitInput, deps: InitDeps = {}): Promise<InitOpResult> {
  const name = input.name ?? '';
  const slug = input.slug ?? '';
  if (name === '' && slug === '') throw new McsError('USAGE', 'init needs --name (or --slug)');
  const result = await initWorkspace({
    repo: ctx.repo,
    root: ctx.root,
    name: name === '' ? slug : name,
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.seedConfig === undefined ? {} : { seedConfig: input.seedConfig }),
    ...(input.engine === undefined ? {} : { engine: input.engine }),
    clock: ctx.clock,
    ...(deps.beforeRename === undefined ? {} : { beforeRename: deps.beforeRename }),
  });
  const where = `task ${pyRepr(result.ws.slug)} at ${result.ws.dir}`;
  const message = result.created
    ? [`created ${where}`]
    : [`reused (nothing overwritten) ${where}`, ...(result.adopted ? ['added Node runtime files: instance.json'] : [])];
  return {
    created: result.created,
    adopted: result.adopted,
    slug: result.ws.slug,
    dir: result.ws.dir,
    instanceId: result.instance.instanceId,
    engine: result.instance.engine,
    message,
  };
}

// ---- discover

export interface DiscoveredSession {
  readonly id: string;
  readonly ageSeconds: number;
  readonly bytes: number;
  /** The first real user prompt; shown clipped by `discover` only, never logged. */
  readonly firstPrompt: string;
}

/** Transcript discovery (ingestion design: `detectTranscriptsDir`, `realFirstPrompt`); the caller binds the Claude home. */
export interface TranscriptDiscovery {
  detectDir(repo: string): Promise<string | null>;
  recentSessions(dir: string, limit: number): Promise<readonly DiscoveredSession[]>;
}

export interface DiscoverDeps {
  readonly transcripts?: TranscriptDiscovery;
  /** Whether the compiled runtime matches its sources. */
  readonly buildStatus?: () => Promise<'current' | 'stale'>;
  /** The legacy Python engine, `null` when none is usable. */
  readonly legacyEngine?: () => Promise<{ readonly version: string; readonly exe: string } | null>;
  /** One line about the installed hooks, `null` when none are installed. */
  readonly hooksSummary?: () => Promise<string | null>;
  /** The probe state of an instance (`probeInstance`); the cheap probe is used without it. */
  readonly probeState?: (ws: WorkspaceRef) => Promise<string>;
}

export interface DiscoveredInstance {
  readonly slug: string;
  /** `unknown` for a workspace whose identity cannot be used (`state` is then `invalid`). */
  readonly engine: EngineName | 'unknown';
  readonly state: string;
  readonly url: string | null;
}

export interface DiscoverResult {
  readonly repo: string;
  readonly transcriptsDir: string | null;
  readonly recentSessions: readonly DiscoveredSession[];
  readonly logCandidates: readonly string[];
  readonly ledgerCandidates: readonly string[];
  readonly tasksRoot: string;
  readonly tasks: readonly string[];
  readonly runtime: { readonly version: string; readonly build: 'current' | 'stale' | 'unknown' };
  readonly legacyEngine: { readonly version: string; readonly exe: string } | null;
  readonly hooks: string | null;
  readonly instances: readonly DiscoveredInstance[];
  /** The output lines: the legacy ones first, then the Node ones (01 6.4 `discover`). */
  readonly lines: readonly string[];
}

const SESSION_LIMIT = 15;
const CANDIDATE_LIMIT = 5;
const PROMPT_CHARS = 110;
const LF = String.fromCharCode(10);

/** Code-point order (Python `sorted` on `str`), independent of the locale; the one ordering helper of the ops modules. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `file` relative to the repo with `/` separators, as `discover` prints it. */
function relativeToRepo(repo: string, file: string): string {
  return path.relative(repo, file).split(path.sep).join('/');
}

/**
 * The legacy candidate globs through the engine glob (06 3.9.4): `logs/*.log` and `*.log` (at most five each) and the first
 * five `*status*.md` files at any depth without a `node_modules` part (the legacy filter runs after the cut, so it is kept in that order).
 * Matching follows the host (case-insensitive on Windows and macOS), hidden names and folders and folder links are skipped.
 */
async function logCandidatesOf(repo: string): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of ['logs/*.log', '*.log']) {
    const { files } = await globFiles(pattern, repo, { maxMatches: CANDIDATE_LIMIT });
    for (const file of files) out.push(relativeToRepo(repo, file));
  }
  return out;
}

async function ledgerCandidates(repo: string): Promise<string[]> {
  const { files } = await globFiles('**/*status*.md', repo, { maxMatches: CANDIDATE_LIMIT });
  return files.map((file) => relativeToRepo(repo, file)).filter((relative) => !relative.includes('node_modules'));
}

function clipPrompt(prompt: string): string {
  return Array.from(prompt.trim().split(LF).join(' ')).slice(0, PROMPT_CHARS).join('');
}

function sessionLine(s: DiscoveredSession): string {
  const age = String(Math.round(s.ageSeconds)).padStart(5);
  const bytes = String(s.bytes).padStart(8);
  return `  ${s.id}  ${age}s ago  ${bytes} B  ${clipPrompt(s.firstPrompt)}`;
}

/** A short, safe label of a failure for the log: an engine or errno code, never a message (it may hold a path or a prompt). */
function failureCode(error: unknown): string {
  if (error instanceof McsError) return error.code;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'ERROR';
}

/** One optional piece of `discover` or `version`: when it cannot be read the report shows it as missing (debug log, no text of the error). */
async function optionalPiece<T>(
  ctx: OpContext,
  piece: string,
  load: () => Promise<T>,
  missing: T,
  event = 'discover.degraded',
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    ctx.log.debug(event, { phase: piece, code: failureCode(error) });
    return missing;
  }
}

/**
 * `ops.workspace.discover` (01 6.4): what an agent needs to set up a monitor for `ctx.repo`, in the legacy line format
 * followed by the Node lines. Report only: it never fails for a missing piece. The first-prompt preview is for the operator
 * of the skill; it is never logged.
 */
export async function discover(ctx: OpContext, deps: DiscoverDeps = {}): Promise<DiscoverResult> {
  const lines: string[] = [`repo: ${ctx.repo}`];
  const discovery = deps.transcripts;
  const transcriptsDir =
    discovery === undefined ? null : await optionalPiece(ctx, 'transcripts', () => discovery.detectDir(ctx.repo), null);
  lines.push(`transcripts: ${transcriptsDir ?? '(not found: pass transcripts_dir explicitly)'}`);
  let recentSessions: readonly DiscoveredSession[] = [];
  if (transcriptsDir !== null && discovery !== undefined) {
    const listed = await optionalPiece<readonly DiscoveredSession[] | null>(
      ctx,
      'sessions',
      () => discovery.recentSessions(transcriptsDir, SESSION_LIMIT),
      null,
    );
    if (listed !== null) {
      recentSessions = listed;
      lines.push('recent sessions (newest first):');
      for (const s of recentSessions) lines.push(sessionLine(s));
    }
  }
  const logCandidates = await logCandidatesOf(ctx.repo);
  for (const relative of logCandidates) lines.push(`log candidate: ${relative}`);
  const ledgers = await ledgerCandidates(ctx.repo);
  for (const relative of ledgers) lines.push(`ledger candidate: ${relative}`);
  const tasks = await listWorkspaceSlugs(ctx.root);
  lines.push(`tasks: ${tasks.length === 0 ? '(none)' : tasks.join(', ')}  [${ctx.root}]`);

  const buildStatus = deps.buildStatus;
  const build =
    buildStatus === undefined
      ? 'unknown'
      : await optionalPiece<'current' | 'stale' | 'unknown'>(ctx, 'build', buildStatus, 'unknown');
  lines.push(`runtime: mcs ${RUNTIME_VERSION} (build ${build})`);
  const legacyEngine = deps.legacyEngine;
  const legacy = legacyEngine === undefined ? null : await optionalPiece(ctx, 'legacy-engine', legacyEngine, null);
  lines.push(legacy === null ? 'legacy engine: not found' : `legacy engine: python ${legacy.version} at ${legacy.exe}`);
  const hooksSummary = deps.hooksSummary;
  const hooks = hooksSummary === undefined ? null : await optionalPiece(ctx, 'hooks', hooksSummary, null);
  lines.push(`hooks: ${hooks ?? 'not installed'}`);

  const instances: DiscoveredInstance[] = [];
  for (const entry of await listWorkspaces(ctx.root)) {
    const ws = entry.ws;
    if (ws === null || entry.problem !== null) {
      // The identity cannot be trusted (a link, a corrupt `instance.json`, a copied workspace): no engine, no probe.
      instances.push({ slug: entry.slug, engine: 'unknown', state: 'invalid', url: null });
      continue;
    }
    const probe = await quickProbe(ws);
    const probeState = deps.probeState;
    const state =
      probeState === undefined ? probe.state : await optionalPiece(ctx, 'probe', () => probeState(ws), 'unknown');
    instances.push({ slug: entry.slug, engine: entry.instance?.engine ?? 'legacy', state, url: probe.url });
  }
  if (instances.length === 0) {
    lines.push('instances: (none)');
  } else {
    lines.push('instances:');
    for (const i of instances) lines.push(`  ${i.slug} engine=${i.engine} state=${i.state} ${i.url ?? '-'}`);
  }
  return {
    repo: ctx.repo,
    transcriptsDir,
    recentSessions,
    logCandidates,
    ledgerCandidates: ledgers,
    tasksRoot: ctx.root,
    tasks,
    runtime: { version: RUNTIME_VERSION, build },
    legacyEngine: legacy,
    hooks,
    instances,
    lines,
  };
}

// ---- version

export interface VersionDeps {
  /** The code stamp and build state of the runtime; unknown without it. */
  readonly buildInfo?: () => Promise<{ readonly code: string; readonly build: 'current' | 'stale' }>;
}

export interface VersionResult {
  readonly version: string;
  readonly code: string | null;
  readonly node: string;
  readonly build: 'current' | 'stale' | 'unknown';
  /** `mcs <version> (code <code>, node <node>, build <build>)`. */
  readonly text: string;
}

/** `ops.version` (registry N14: placed here by the plan). */
export async function version(ctx: OpContext, deps: VersionDeps = {}): Promise<VersionResult> {
  // `version` exits 1 never (01 6.3): a build info that cannot be read shows as an unknown code and build.
  const buildInfo = deps.buildInfo;
  const info =
    buildInfo === undefined ? null : await optionalPiece(ctx, 'build-info', buildInfo, null, 'version.degraded');
  const node = process.versions.node;
  const code = info?.code ?? null;
  const build = info?.build ?? 'unknown';
  return {
    version: RUNTIME_VERSION,
    code,
    node,
    build,
    text: `mcs ${RUNTIME_VERSION} (code ${code ?? 'unknown'}, node ${node}, build ${build})`,
  };
}
