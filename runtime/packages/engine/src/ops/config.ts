// Engine operations behind `inspect`, `configure` and `check` (01 6.4, registry 2.1). `inspect` returns the legacy report and
// `ConfigInspection` as a pure projection of the same resolved configuration; `configure` applies the legacy semantics to
// parsed copies of `config.json` and `runtime.json` and writes only what changed; `check` is the legacy one-line summary.
// The CLI renders these results and the server serves the projection; no rule lives anywhere else (INV-12).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  McsError,
  R_TOP_KEYS,
  RuntimeOverridesSchema,
  toConfigInspection,
  type ConfigFileStatus,
  type ConfigInspection,
  type ConfigSource,
  type InstanceFile,
} from '@mcs/shared';

import { appendChange, appendDecision, lastChange, recentAudit } from '../audit/writer.ts';
import { pyStrip } from '../audit/reader.ts';
import {
  checkSchemaVersion,
  getEntry,
  loadSkillDefaults,
  readConfigJson,
  readOptionalConfigJson,
  type LegacyConfig,
  type JsonObject,
} from '../config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { validateLegacy } from '../config/validate-legacy.ts';
import {
  JsonSyntaxError,
  fromPlain,
  parseJson,
  jsonEquals,
  formatFloat,
  jsonFileText,
  quoteText,
  shortJson,
  toPlain,
  type JsonDoc,
} from '../json/index.ts';
import { readInstanceFile, readTaskFile } from '../workspace/adopt.ts';
import { readJsonFile, writeJsonFile } from '../workspace/fsio.ts';
import { listWorkspaceSlugs } from '../workspace/list.ts';
import { resolveWorkspace, withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { snapshotWorkspace } from '../workspace/snapshot.ts';
import { mutexName, tryAcquireMutex } from '../platform/mutex.ts';
import { compareCodePoints, openWorkspace, quickProbe, type OpContext, type ProbeSummary } from './workspace.ts';

type PlainRecord = Record<string, unknown>;

const DEFAULT_SLUG = 'default';
const CONFIG_FILE = 'config.json';
const RUNTIME_FILE = 'runtime.json';
const CHANGES_FILE = 'changes.md';
const DECISIONS_FILE = 'decisions.md';
/** `configure` rewrites the route file of the hook handler when one of these changes (01 6.4 `configure` step 9). */
const ROUTING_KEYS: ReadonlySet<string> = new Set(['repo', 'transcripts_dir', 'session_ids']);
const R_TOP: ReadonlySet<string> = new Set(R_TOP_KEYS);
/** Path segments that can never be a key of a configuration file (T-ISO-07). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const BACKSLASH = String.fromCharCode(92);

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain copy of a parsed document; an integer beyond 2^53-1 cannot be shown and is refused. */
function plainOf(value: JsonDoc, what: string): unknown {
  try {
    return toPlain(value);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new McsError('CONFIG_INVALID', `${what}: an integer is beyond 2^53-1 in magnitude`, { cause: error });
    }
    throw error;
  }
}

function plainRecordOf(value: JsonDoc, what: string): PlainRecord {
  const plain = plainOf(value, what);
  return isRecord(plain) ? plain : {};
}

/** The workspace `check` and the other no-`--task` forms fall back to: `default` when it exists (01 6.2). */
async function defaultWorkspace(ctx: OpContext): Promise<WorkspaceRef | null> {
  const slugs = await listWorkspaceSlugs(ctx.root);
  return slugs.includes(DEFAULT_SLUG) ? resolveWorkspace(ctx.root, DEFAULT_SLUG) : null;
}

/** `null` for a workspace without `instance.json` (a pre-4.0 workspace): there is no other engine (ADR 0066). */
function engineOf(instance: InstanceFile | null): 'node' | null {
  return instance?.engine ?? null;
}

// ---- inspect

export interface InspectDeps {
  /** The probe of the instance (`probeInstance`); the cheap look at `state.json` is used without it. */
  readonly probe?: (ws: WorkspaceRef) => Promise<ProbeSummary>;
}

/** The legacy keys first, in the legacy order, then the keys that are new in the Node runtime (01 6.4). */
export interface InspectReport {
  readonly task: PlainRecord;
  readonly dir: string;
  readonly effective: PlainRecord;
  readonly provenance: Readonly<Record<string, ConfigSource>>;
  /** The raw `state.json`, or `null` when there is none or it cannot be read. */
  readonly runtime: PlainRecord | null;
  readonly last_change: { readonly t: string; readonly summary: string } | null;
  readonly config_hash: string;
  readonly recent_audit: string;
  readonly overridden_keys: readonly string[];
  readonly inherited_keys: readonly string[];
  readonly instance: InstanceFile | null;
  readonly runtime_effective: PlainRecord;
  readonly effective_port: number;
  readonly files: readonly ConfigFileStatus[];
  /** `null` for a workspace without `instance.json`. */
  readonly engine: 'node' | null;
  readonly probe: ProbeSummary;
}

export interface InspectResult {
  readonly report: InspectReport;
  /** `ConfigInspection` of the same resolution; the CLI adds it to the `--json` envelope as `data.inspection`. */
  readonly inspection: ConfigInspection;
}

/** Without a task: the legacy `tasks: a, b` line (and the list behind it). */
export interface InspectTasksResult {
  readonly tasks: readonly string[];
  readonly line: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => sortKeysDeep(v));
  if (isRecord(value)) {
    const out: PlainRecord = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** First 12 hex digits of the sha1 of the key-sorted effective configuration (a Node value, not comparable with the legacy hash). */
function configHash(effective: PlainRecord): string {
  return createHash('sha1')
    .update(JSON.stringify(sortKeysDeep(effective)))
    .digest('hex')
    .slice(0, 12);
}

async function rawState(ws: WorkspaceRef): Promise<PlainRecord | null> {
  try {
    const { value } = await readJsonFile(workspacePath(ws, 'state.json'));
    if (value.k !== 'obj') return null;
    const plain = toPlain(value);
    return isRecord(plain) ? plain : null;
  } catch (error) {
    if (error instanceof McsError || error instanceof RangeError) return null;
    throw error;
  }
}

/** `ops.config.inspect`: everything an agent needs to know about a task without starting it (01 6.4). */
export function inspect(ctx: OpContext, input: { readonly task: string }, deps?: InspectDeps): Promise<InspectResult>;
export function inspect(
  ctx: OpContext,
  input: { readonly task?: undefined },
  deps?: InspectDeps,
): Promise<InspectTasksResult>;
export async function inspect(
  ctx: OpContext,
  input: { readonly task?: string | undefined },
  deps: InspectDeps = {},
): Promise<InspectResult | InspectTasksResult> {
  if (input.task === undefined) {
    const tasks = await listWorkspaceSlugs(ctx.root);
    return { tasks, line: `tasks: ${tasks.length === 0 ? '(none)' : tasks.join(', ')}` };
  }
  const ws = await openWorkspace(ctx, input.task);
  const task = plainRecordOf(await readTaskFile(ws), 'task.json');
  const resolved = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  const instance = await readInstanceFile(ws);
  const effective = structuredClone<PlainRecord>({ ...resolved.monitor });
  const keys = Object.keys(resolved.provenance).filter((key) => key !== 'effectivePort');
  const inherited = (key: string): boolean => {
    const source = resolved.provenance[key];
    return source === 'builtin' || source === 'skill';
  };
  const engine = engineOf(instance);
  const report: InspectReport = {
    task,
    dir: ws.dir,
    effective,
    provenance: { ...resolved.provenance },
    runtime: await rawState(ws),
    last_change: await lastChange(ws, ctx.log),
    config_hash: configHash(effective),
    recent_audit: await recentAudit(ws, 3, ctx.log),
    overridden_keys: keys.filter((key) => !inherited(key)).sort(compareCodePoints),
    inherited_keys: keys.filter(inherited).sort(compareCodePoints),
    instance,
    runtime_effective: structuredClone<PlainRecord>({ ...resolved.runtime }),
    effective_port: resolved.effectivePort,
    files: resolved.files.map((f) => ({ ...f })),
    engine,
    probe: await (deps.probe ?? quickProbe)(ws),
  };
  return { report, inspection: toConfigInspection(resolved, engine) };
}

// ---- configure

export interface ConfigureInput {
  readonly task: string;
  /** `KEY=VALUE` items as typed (`--set`): the value is JSON, or the raw text when it is not JSON. */
  readonly set?: readonly string[];
  readonly unset?: readonly string[];
  readonly reason?: string;
  readonly decision?: string;
  readonly dryRun?: boolean;
}

export interface ConfigureDeps {
  /** Whether the instance of the workspace runs (then a restart is needed); `quickProbe` says `unverified` when the pid lives. */
  readonly isRunning?: (ws: WorkspaceRef) => Promise<boolean>;
  /** Rewrites the route file of the hook handler (02 2.6.2) after `repo`, `transcripts_dir` or `session_ids` changed. */
  readonly onRoutingChanged?: (ws: WorkspaceRef) => Promise<void>;
  /** Runs right after the files are written, before the audit and the second snapshot (a seam for the isolation tests). */
  readonly onWritten?: () => void | Promise<void>;
}

/** The legacy report keys, then `files`, `isolation`, `restart_needed` (and `dry_run`) for a change or a dry run. */
export interface ConfigureReport {
  readonly changed: boolean;
  readonly changes: readonly string[];
  readonly unchanged: readonly string[];
  readonly files?: readonly string[];
  readonly isolation?: 'ok';
  readonly restart_needed?: boolean;
  readonly dry_run?: boolean;
}

interface Edit {
  readonly key: string;
  readonly parts: readonly string[];
  readonly value: JsonDoc;
}

function usage(message: string): McsError {
  return new McsError('USAGE', message);
}

/** `--set KEY=VALUE` items to key/value pairs: first `=` splits, the key is stripped, a repeated key keeps its first place and its last value. */
function parseSets(items: readonly string[]): Edit[] {
  const edits = new Map<string, Edit>();
  for (const item of items) {
    const at = item.indexOf('=');
    if (at === -1) throw usage(`--set expects KEY=JSON_VALUE, got ${quoteText(item)}`);
    const key = pyStrip(item.slice(0, at));
    const raw = item.slice(at + 1);
    let value: JsonDoc;
    try {
      value = parseJson(raw);
    } catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      value = { k: 'str', v: raw };
    }
    edits.set(key, { key, parts: key.split('.'), value });
  }
  return [...edits.values()];
}

/** A key that cannot name a configuration value: an empty segment, a path separator or a prototype name. */
function isForbiddenKey(parts: readonly string[]): boolean {
  return parts.some(
    (part) => part === '' || part.includes('/') || part.includes(BACKSLASH) || FORBIDDEN_SEGMENTS.has(part),
  );
}

function getAt(doc: JsonObject, parts: readonly string[]): JsonDoc | undefined {
  let cur: JsonDoc = doc;
  for (const part of parts) {
    if (cur.k !== 'obj') return undefined;
    const entry: [string, JsonDoc] | undefined = cur.v.find(([k]) => k === part);
    if (entry === undefined) return undefined;
    cur = entry[1];
  }
  return cur;
}

/** Python `_set_path`: missing intermediate objects are created, one that exists and is not an object is an error. */
function setAt(doc: JsonObject, parts: readonly string[], value: JsonDoc, dotted: string): void {
  let cur: JsonObject = doc;
  for (const part of parts.slice(0, -1)) {
    const entry = cur.v.find(([k]) => k === part);
    if (entry === undefined) {
      const created: JsonObject = { k: 'obj', v: [] };
      cur.v.push([part, created]);
      cur = created;
    } else if (entry[1].k === 'obj') {
      cur = entry[1];
    } else {
      throw new McsError('CONFIG_INVALID', `cannot set ${dotted}: ${part} is not an object`);
    }
  }
  const last = parts[parts.length - 1] ?? dotted;
  const existing = cur.v.find(([k]) => k === last);
  if (existing === undefined) cur.v.push([last, value]);
  else existing[1] = value;
}

/** Python `_del_path` without the null quirk: the removed value, `undefined` when nothing was there to remove. */
function deleteAt(doc: JsonObject, parts: readonly string[]): JsonDoc | undefined {
  let cur: JsonObject = doc;
  for (const part of parts.slice(0, -1)) {
    const entry = cur.v.find(([k]) => k === part);
    if (entry?.[1].k !== 'obj') return undefined;
    cur = entry[1];
  }
  const last = parts[parts.length - 1] ?? '';
  const at = cur.v.findIndex(([k]) => k === last);
  if (at === -1) return undefined;
  const [removed] = cur.v.splice(at, 1);
  return removed?.[1];
}

function isRuntimeKey(parts: readonly string[]): boolean {
  return R_TOP.has(parts[0] ?? '');
}

function plainAt(root: unknown, parts: readonly string[]): unknown {
  let cur: unknown = root;
  for (const part of parts) {
    if (!isRecord(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function formatZodPath(segments: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of segments) {
    out += typeof segment === 'number' ? `[${String(segment)}]` : `${out === '' ? '' : '.'}${String(segment)}`;
  }
  return out;
}

/** Problems of a `runtime.json` document with the messages of `resolveConfig` (`runtime.json: <path>: <message>`). */
export function runtimeProblems(doc: JsonObject): string[] {
  let plain: unknown;
  try {
    plain = toPlain(doc);
  } catch (error) {
    if (error instanceof RangeError) return [`${RUNTIME_FILE}: an integer is beyond 2^53-1 in magnitude`];
    throw error;
  }
  const parsed = RuntimeOverridesSchema.safeParse(plain);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const where = formatZodPath(issue.path);
    return where === '' ? `${RUNTIME_FILE}: ${issue.message}` : `${RUNTIME_FILE}: ${where}: ${issue.message}`;
  });
}

function rejected(code: McsError['code'], detail: string, cause?: unknown): McsError {
  return new McsError(code, `rejected, nothing written: ${detail}`, cause === undefined ? {} : { cause });
}

/**
 * The resolution of the intended files, run on the parsed documents instead of the files so that nothing is written or
 * copied: patterns, derived defaults and the final type check, exactly as the next `start` or `inspect` will see them.
 */
async function resolveIntended(
  ctx: OpContext,
  ws: WorkspaceRef,
  config: JsonObject,
  runtime: JsonObject | null,
): Promise<void> {
  try {
    await resolveConfig({
      workspace: ws,
      env: ctx.env,
      cli: {},
      skillDir: ctx.skillDir,
      override: { config, runtime },
    });
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    throw rejected(error.code, error.message, error);
  }
}

function topLevelKeys(doc: JsonObject | null): string[] {
  return doc === null ? [] : doc.v.map(([k]) => k).filter((k) => !k.startsWith('_'));
}

async function writeVerified(file: string, doc: JsonObject, wrote: () => void): Promise<void> {
  await writeJsonFile(file, doc);
  wrote();
  const intended = Buffer.from(jsonFileText(doc), 'utf8');
  const actual = await readFile(file);
  if (!actual.equals(intended)) {
    throw new McsError('INTERNAL', `${path.basename(file)} does not hold the intended bytes after the write`);
  }
}

async function runtimeIsRunning(ws: WorkspaceRef): Promise<boolean> {
  return (await quickProbe(ws)).state === 'unverified';
}

/**
 * `ops.config.configure` (01 6.4): the legacy semantics (`was`, change only when the value differs, `_set_path`, `unset`)
 * on parsed copies, routing of runtime keys to `runtime.json` (created on demand), whole-result validation before any
 * write, atomic write and read-back, the audit entry, and an isolation snapshot of every other workspace around it all.
 * A call that changes nothing writes nothing and audits nothing.
 */
export async function configure(
  ctx: OpContext,
  input: ConfigureInput,
  deps: ConfigureDeps = {},
): Promise<ConfigureReport> {
  const sets = parseSets(input.set ?? []);
  const unsets = input.unset ?? [];
  const ws = await openWorkspace(ctx, input.task);
  return withTaskMutex(ws, async () => {
    const configPath = workspacePath(ws, CONFIG_FILE);
    const runtimePath = workspacePath(ws, RUNTIME_FILE);
    const currentConfig = await readConfigJson(configPath);
    checkSchemaVersion(currentConfig, configPath, CONFIG_FILE);
    const currentRuntime = await readOptionalConfigJson(runtimePath);
    if (currentRuntime !== null) checkSchemaVersion(currentRuntime, runtimePath, RUNTIME_FILE);

    const defaults = (await loadSkillDefaults(ctx.skillDir)).doc;
    let before: ResolvedConfig | null = null;
    try {
      before = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
    } catch (error) {
      if (!(error instanceof McsError)) throw error;
    }

    const config: JsonObject = structuredClone(currentConfig);
    const runtime: JsonObject =
      currentRuntime === null ? fromObject({ schema_version: 1 }) : structuredClone(currentRuntime);
    const changes: string[] = [];
    const changedFiles = new Set<'config' | 'runtime'>();
    const changedRouting = { value: false };
    const badKeys: string[] = [];

    const was = (parts: readonly string[], doc: JsonObject, runtimeKey: boolean): string => {
      const current = getAt(doc, parts);
      if (current !== undefined && current.k !== 'null') return shortJson(current);
      const fallback = runtimeKey ? plainAt(before?.runtime, parts) : getAtPlainFromDoc(defaults, parts);
      return `(default ${shortJson(fromPlain(fallback ?? null))})`;
    };
    const record = (parts: readonly string[], runtimeKey: boolean, text: string): void => {
      changes.push(text);
      changedFiles.add(runtimeKey ? 'runtime' : 'config');
      if (!runtimeKey && ROUTING_KEYS.has(parts[0] ?? '')) changedRouting.value = true;
    };

    for (const edit of sets) {
      if (edit.parts[0] === 'schema_version')
        throw new McsError('CONFIG_INVALID', 'schema_version cannot be changed with configure');
      if (isForbiddenKey(edit.parts)) {
        badKeys.push(edit.key);
        continue;
      }
      const runtimeKey = isRuntimeKey(edit.parts);
      const doc = runtimeKey ? runtime : config;
      const previous = was(edit.parts, doc, runtimeKey);
      const current = getAt(doc, edit.parts) ?? ({ k: 'null' } as const);
      if (!jsonEquals(current, edit.value)) {
        setAt(doc, edit.parts, edit.value, edit.key);
        record(edit.parts, runtimeKey, `${edit.key}: ${previous} -> ${shortJson(edit.value)}`);
      }
    }
    for (const key of unsets) {
      const parts = key.split('.');
      if (parts[0] === 'schema_version') throw new McsError('CONFIG_INVALID', 'schema_version cannot be removed');
      if (isForbiddenKey(parts)) {
        badKeys.push(key);
        continue;
      }
      const runtimeKey = isRuntimeKey(parts);
      const doc = runtimeKey ? runtime : config;
      const previous = was(parts, doc, runtimeKey);
      const removed = deleteAt(doc, parts);
      if (removed !== undefined && removed.k !== 'null') {
        record(parts, runtimeKey, `${key}: ${previous} -> (removed, default applies)`);
      }
    }
    if (badKeys.length > 0)
      throw rejected('CONFIG_INVALID', badKeys.map((k) => `unknown key ${quoteText(k)}`).join('; '));

    // The whole intended result is validated before anything is written (also when nothing changed, as the legacy command does).
    const runtimeAfter = changedFiles.has('runtime') || currentRuntime !== null ? runtime : null;
    const problems = [
      ...validateLegacy(config, { strict: true }),
      ...(runtimeAfter === null ? [] : runtimeProblems(runtimeAfter)),
    ];
    if (problems.length > 0) throw rejected('CONFIG_INVALID', problems.join('; '));
    await resolveIntended(ctx, ws, config, runtimeAfter);

    const unchanged = (): string[] => {
      const touched = new Set(changes.map((c) => c.split(':')[0]?.split('.')[0] ?? ''));
      const keys = new Set([...topLevelKeys(config), ...topLevelKeys(runtimeAfter)]);
      return [...keys].filter((k) => !touched.has(k)).sort(compareCodePoints);
    };
    if (changes.length === 0) {
      const none: ConfigureReport = {
        changed: false,
        changes: [],
        unchanged: [...new Set([...topLevelKeys(currentConfig), ...topLevelKeys(currentRuntime)])].sort(
          compareCodePoints,
        ),
      };
      return input.dryRun === true ? { ...none, dry_run: true } : none;
    }

    const files = [
      ...(changedFiles.has('config') ? [CONFIG_FILE] : []),
      ...(changedFiles.has('runtime') ? [RUNTIME_FILE] : []),
    ];
    const running = await (deps.isRunning ?? runtimeIsRunning)(ws);
    if (input.dryRun === true) {
      return { changed: true, changes, unchanged: unchanged(), files, restart_needed: running, dry_run: true };
    }

    const snapshotBefore = await observeOthers(ctx.root, ws.slug);
    const progress: ApplyProgress = { written: [], step: `writing ${CONFIG_FILE}`, changeAudited: false };
    try {
      if (changedFiles.has('config')) {
        await writeVerified(configPath, config, () => progress.written.push(CONFIG_FILE));
      }
      if (changedFiles.has('runtime')) {
        progress.step = `writing ${RUNTIME_FILE}`;
        await writeVerified(runtimePath, runtime, () => progress.written.push(RUNTIME_FILE));
      }
      progress.step = 'the after-write hook';
      await deps.onWritten?.();
      if (changedRouting.value) {
        progress.step = 'rewriting the route file';
        await deps.onRoutingChanged?.(ws);
      }
      const now = ctx.clock.now();
      progress.step = `appending to ${CHANGES_FILE}`;
      await appendChange(
        ws,
        {
          action: 'configure',
          summary: changes.join('; '),
          reason: input.reason ?? null,
          files,
          validation: 'schema ok (strict)',
          outcome: 'applied',
        },
        now,
      );
      progress.changeAudited = true;
      if (input.decision !== undefined && input.decision !== '') {
        progress.step = `appending to ${DECISIONS_FILE}`;
        await appendDecision(ws, 'configuration', input.decision, null, now);
      }
    } catch (error) {
      throw partiallyApplied(error, progress);
    }
    const snapshotAfter = await observeOthers(ctx.root, ws.slug);
    const { violations, concurrent } = judgeIsolation(snapshotBefore, snapshotAfter);
    // A legitimate concurrent operation of another task (it audited what it did, or its task mutex was held): not an error.
    if (concurrent.length > 0) ctx.log.debug('configure.isolation.concurrent', { tasks: concurrent });
    if (violations.length > 0) {
      throw new McsError(
        'ISOLATION_VIOLATION',
        'isolation violated: another task changed during configure (this is a bug)',
        {
          details: { tasks: violations },
        },
      );
    }
    return { changed: true, changes, unchanged: unchanged(), files, isolation: 'ok', restart_needed: running };
  });
}

/**
 * What one isolation snapshot of another task holds (01 6.4 steps 6 and 10): the hash of the whole workspace and what lets
 * `judgeIsolation` tell a legitimate concurrent operation of that task from a stray write.
 */
interface TaskObservation {
  readonly hash: string;
  /** Digests of the audit trail (`changes.md`, `decisions.md`) taken before and after the hash. */
  readonly audit: readonly string[];
  /** The task mutex of the task was held when it was looked at, before or after the hash. */
  readonly mutexHeld: boolean;
}

async function auditDigest(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of [CHANGES_FILE, DECISIONS_FILE]) {
    try {
      hash.update(await readFile(path.join(dir, 'audit', name)));
    } catch {
      hash.update('absent');
    }
    hash.update(',');
  }
  return hash.digest('hex');
}

/** True while another call chain or process holds the task mutex of `slug`. A workspace that cannot be resolved holds none. */
async function taskMutexHeld(root: string, slug: string): Promise<boolean> {
  let name: string;
  try {
    name = mutexName('task', resolveWorkspace(root, slug).realDir);
  } catch {
    return false;
  }
  const taken = await tryAcquireMutex(name);
  if (taken === null) return true;
  await taken.release();
  return false;
}

/**
 * The snapshot of every other task with its audit digests and its mutex state. The observations are ordered (mutex, audit,
 * hash, audit, mutex) so that an operation of that task, which holds its mutex from its first write to its audit append,
 * either shows in one of the mutex reads or has its whole run between two reads that differ in the audit digest.
 */
async function observeOthers(root: string, except: string): Promise<ReadonlyMap<string, TaskObservation>> {
  const out = new Map<string, TaskObservation>();
  for (const slug of await listWorkspaceSlugs(root)) {
    if (slug === except) continue;
    const dir = path.join(root, slug);
    const heldBefore = await taskMutexHeld(root, slug);
    const auditBefore = await auditDigest(dir);
    const hash = await snapshotWorkspace(dir);
    const auditAfter = await auditDigest(dir);
    const heldAfter = await taskMutexHeld(root, slug);
    out.set(slug, { hash, audit: [auditBefore, auditAfter], mutexHeld: heldBefore || heldAfter });
  }
  return out;
}

/**
 * Decision (1) of WP-14: a task whose snapshot differs is a violation only when nothing explains it. Explained, and so only
 * logged: its audit trail changed in the same window, or its task mutex was held at one of the observation instants (the
 * window between its `config.json` write and its audit append). A task that appeared or vanished is always a violation.
 */
function judgeIsolation(
  before: ReadonlyMap<string, TaskObservation>,
  after: ReadonlyMap<string, TaskObservation>,
): { violations: string[]; concurrent: string[] } {
  const violations: string[] = [];
  const concurrent: string[] = [];
  const slugs = [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints);
  for (const slug of slugs) {
    const a = before.get(slug);
    const b = after.get(slug);
    if (a === undefined || b === undefined) {
      violations.push(slug);
    } else if (a.hash !== b.hash) {
      const auditChanged = new Set([...a.audit, ...b.audit]).size > 1;
      (auditChanged || a.mutexHeld || b.mutexHeld ? concurrent : violations).push(slug);
    }
  }
  return { violations, concurrent };
}

/** How far `configure` got between its first file write and the end of the audit (the legacy order, no rollback). */
interface ApplyProgress {
  /** The files that already hold the new content. */
  readonly written: string[];
  /** What was being done when the failure came. */
  step: string;
  /** The `changes.md` entry exists. */
  changeAudited: boolean;
}

/**
 * Whatever fails after the first file was written leaves a changed workspace, and a retry of the same call would find
 * nothing to change and so never repair it. The error therefore keeps its code, says which files are already written, at
 * which step it stopped and what is missing from the audit trail. Before the first write the error is passed on unchanged.
 */
function partiallyApplied(error: unknown, progress: ApplyProgress): unknown {
  if (progress.written.length === 0) return error;
  const names = progress.written.join(' and ');
  const wasWere = progress.written.length === 1 ? 'was' : 'were';
  const code = error instanceof McsError ? error.code : 'INTERNAL';
  const reason = error instanceof Error ? error.message : String(error);
  const consequence = progress.changeAudited
    ? `${names} ${wasWere} written and the change is audited in ${CHANGES_FILE}, but the decision is not recorded`
    : `${names} ${wasWere} written but the change is not audited`;
  const hint = progress.changeAudited
    ? 'record the decision with the decide command'
    : 'record the change with the decide command';
  return new McsError(code, `${reason}; ${consequence} (failed at: ${progress.step})`, {
    details: {
      ...(error instanceof McsError ? error.details : {}),
      written: [...progress.written],
      ...(progress.changeAudited ? { audited: true } : {}),
    },
    cause: error,
    hint: error instanceof McsError && error.hint !== undefined ? error.hint : hint,
  });
}

function fromObject(value: Record<string, unknown>): JsonObject {
  const converted = fromPlain(value);
  if (converted.k !== 'obj') throw new McsError('INTERNAL', 'expected an object');
  return converted;
}

/** The plain value at `parts` of a parsed document (the shared defaults), or `undefined`. */
function getAtPlainFromDoc(doc: JsonObject, parts: readonly string[]): unknown {
  const found = getAt(doc, parts);
  return found === undefined ? undefined : toPlain(found);
}

// ---- check

export interface CheckInput {
  readonly task?: string;
}

export interface CheckDeps {
  /** The transcripts folder the legacy monitor resolves from `transcripts_dir` (ingestion design); the configured text is shown without it. */
  readonly transcriptsDir?: (monitor: LegacyConfig) => Promise<string | null>;
}

export interface CheckResult {
  /** `title: <t> | repo: <r> | transcripts: <dir> | rules: <n> | window: <h>h | panels: <on,...> | source: task` (legacy, byte for byte). */
  readonly line: string;
  readonly title: string;
  readonly repo: string;
  readonly transcripts: string;
  readonly rules: number;
  readonly windowHours: number;
  readonly panels: readonly string[];
  readonly source: 'task' | 'defaults';
  readonly effectivePort: number;
  /** `null` for a workspace without `instance.json`. */
  readonly engine: 'node' | null;
  readonly regex: { readonly checked: number; readonly ok: true };
}

/**
 * `window_hours` as the legacy line shows it: Python keeps the number type of the file it came from, so `8.0` prints `8.0`
 * while `8` prints `8`. The merged value is a JavaScript number and has lost that, so the source file is read again.
 */
async function windowHoursText(ctx: OpContext, ws: WorkspaceRef | null, resolved: ResolvedConfig): Promise<string> {
  const fallback = String(resolved.monitor.window_hours);
  const doc =
    ws !== null && resolved.provenance['window_hours'] === 'config'
      ? await readOptionalConfigJson(workspacePath(ws, CONFIG_FILE))
      : (await loadSkillDefaults(ctx.skillDir)).doc;
  const raw = doc === null ? undefined : getEntry(doc, 'window_hours');
  if (raw?.k === 'int') return raw.v.toString();
  return raw?.k === 'float' ? formatFloat(raw.v) : fallback;
}

/**
 * `ops.config.check` (01 6.4): resolves the configuration (every file, every regex) and summarises it in one line. Without a
 * task the `default` workspace is used when it exists, otherwise only the shared defaults are validated (legacy).
 */
export async function check(ctx: OpContext, input: CheckInput, deps: CheckDeps = {}): Promise<CheckResult> {
  // Parity with the legacy command: without a task and without a `default` workspace `resolveConfig` takes the repo of the
  // shared defaults from the working directory of the process, not from `ctx.repo` (decision kept, CR-WP-14-7).
  const ws = input.task === undefined ? await defaultWorkspace(ctx) : await openWorkspace(ctx, input.task);
  const resolved = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  const monitor = resolved.monitor;
  const instance = ws === null ? null : await readInstanceFile(ws);
  const configured = deps.transcriptsDir === undefined ? monitor.transcripts_dir : await deps.transcriptsDir(monitor);
  const transcripts = configured ?? 'None';
  const panels = Object.entries(monitor.panels)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const line =
    `title: ${monitor.title} | repo: ${monitor.repo} | transcripts: ${transcripts} | rules: ${String(monitor.session_rules.length)}` +
    ` | window: ${await windowHoursText(ctx, ws, resolved)}h | panels: ${panels.length === 0 ? '(none)' : panels.join(',')} | source: ${resolved.source}`;
  return {
    line,
    title: monitor.title,
    repo: monitor.repo,
    transcripts,
    rules: monitor.session_rules.length,
    windowHours: monitor.window_hours,
    panels,
    source: resolved.source,
    effectivePort: resolved.effectivePort,
    engine: ws === null ? 'node' : engineOf(instance),
    regex: {
      checked: resolved.patterns.sessionRules.length + (resolved.patterns.attempts === null ? 0 : 2),
      ok: true,
    },
  };
}

// @wp-begin WP-62
// @wp-end WP-62
