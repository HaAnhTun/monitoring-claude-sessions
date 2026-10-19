// `ops.diagnostics.bundle` (01 6.4, V4): the privacy-safe report a person attaches to a bug report. One call collects the
// doctor checks, the status, the health of a running instance, the effective configuration in a redacted form and the tail
// of the runtime log, rewrites every absolute path to `<repo>` or `<home>`, validates the result against
// `DiagnosticsBundleSchema` and writes it once to a new file (never over an existing one, never inside the Claude home).
//
// What can never be in the bundle: a prompt or any transcript text, a pattern or other configuration text (strings of the
// configuration are reduced to a marker, only numbers, booleans and members of closed word lists are kept), an environment
// value, a token. The collection itself reads only the places a status or a doctor reads; it starts no process and writes
// nothing but the one output file. The privacy rules are enforced twice: by construction (a section is built from allow-listed
// fields) and by a final scrub of every string of the bundle (paths, the values of secret-looking environment variables).
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  DIAGNOSTICS_LOG_RECORDS,
  DIAGNOSTICS_SCHEMA,
  DiagnosticsBundleSchema,
  DiagnosticsHealthSchema,
  HooksVerifyResultSchema,
  LogRecordSchema,
  McsError,
  RUNTIME_VERSION,
  isoMsZ,
  routes,
  toConfigInspection,
  type ConfigSource,
  type DiagnosticsBundle,
  type DiagnosticsStatus,
  type DoctorCheck,
  type HooksVerifyResult,
  type LogRecord,
} from '@mcs/shared';

import { resolveConfig } from '../config/resolve.ts';
import { claudeHomeOf } from '../ingest/transcripts/discovery.ts';
import { LOG_FIELD_NAMES } from '../log/logger.ts';
import { tailLines } from '../platform/fsx.ts';
import { pathsCaseInsensitive } from '../platform/host.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { run as runDoctor, type DoctorDeps } from './doctor.ts';
import { nodeDoctorSeams, type DoctorSeams } from './doctor-checks.ts';
import { status as lifecycleStatus, type LifecycleDeps, type StatusReport } from './lifecycle.ts';
import { httpGet, jsonBodyOf } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export interface DiagnosticsInput {
  /** The task to report on; without it the bundle holds the machine-wide sections only and `out` is required. */
  readonly task?: string;
  /** An absolute file to create. Default: `<workspace>/logs/diagnostics-<UTC>.json`. */
  readonly out?: string;
}

export interface DiagnosticsDeps extends DoctorDeps {
  /** The effects of the status call (the probe, the HTTP read of the health). */
  readonly lifecycle?: LifecycleDeps;
  /** The result of `hooks verify` for the task (the hooks area wires it); `null` or absent: the bundle says null. */
  readonly hooksVerify?: (ctx: OpContext, ws: WorkspaceRef) => Promise<HooksVerifyResult | null>;
}

/** The outside world of the collection; tests replace any of it. */
export interface DiagnosticsSeams {
  readonly doctor: Partial<DoctorSeams>;
  readonly arch: string;
  /** Home folders to rewrite to `<home>`, besides the ones the environment names. */
  readonly homeDirs: readonly string[];
  readonly tailLines: (file: string, n: number) => Promise<string[]>;
}

const NODE_SEAMS: DiagnosticsSeams = { doctor: {}, arch: process.arch, homeDirs: [], tailLines };

export interface DiagnosticsResult {
  /** The file that was written (an absolute path, for the operator; it is not inside the bundle). */
  readonly path: string;
  readonly bytes: number;
  readonly bundle: DiagnosticsBundle;
}

const LF = String.fromCharCode(10);
const HEALTH_TIMEOUT_MS = 3000;
/** A string longer than this is not a log field (the logger keeps 128 characters at most). */
const LOG_STRING_MAX = 128;
const KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SECRET_ENV_RE = /(token|secret|passw|credential|api_?key|auth|private)/i;
const SECRET_MIN_LENGTH = 6;

/** Failed checks whose detail can quote configuration text (a pattern, a key, a blocker): the text is withheld. */
const WITHHELD_DETAIL = new Set(['config.valid', 'config.keys', 'workspace.format']);
const WITHHELD_TEXT = 'details withheld because the message can quote configuration text; run `mcs doctor` to read it';

/**
 * The closed word lists of the configuration: a string value is kept only when its key is here and the value is a member.
 * Every other string becomes a marker. A key of this table that the configuration no longer has is harmless.
 */
export const SAFE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  logLevel: ['error', 'warn', 'info', 'debug'],
  'ui.theme': ['auto', 'light', 'dark'],
  'ui.density': ['comfortable', 'compact'],
  'alerts.rules.token_threshold.field': ['total', 'output'],
  transcripts_dir: ['auto'],
};

// ---- redaction -------------------------------------------------------------------------------------------------------------

const PATH_KEY_RE = /(^|[._])(dir|dirs|path|paths|file|files|glob|globs|repo|root)($|[._])/i;
const PATTERN_KEY_RE = /pattern|regex|rule|match/i;
const PATH_VALUE_RE = /[\\/]|^[A-Za-z]:/;

type Classified = { readonly safe: number | boolean | string } | { readonly marker: string };

/** One configuration value: kept when it is a number, a boolean or a member of a closed list; otherwise a marker. */
export function classifyConfigValue(key: string, value: unknown): Classified {
  if (typeof value === 'number') return Number.isFinite(value) ? { safe: value } : { marker: '<number>' };
  if (typeof value === 'boolean') return { safe: value };
  if (value === null || value === undefined) return { marker: '<unset>' };
  if (typeof value === 'string') {
    if (SAFE_ENUMS[key]?.includes(value) === true) return { safe: value };
    if (PATTERN_KEY_RE.test(key)) return { marker: `<pattern length=${String(value.length)}>` };
    if (PATH_KEY_RE.test(key) || PATH_VALUE_RE.test(value)) return { marker: '<path>' };
    return { marker: `<text length=${String(value.length)}>` };
  }
  if (Array.isArray(value)) return { marker: `<list length=${String(value.length)}>` };
  if (typeof value === 'object') return { marker: `<object keys=${String(Object.keys(value).length)}>` };
  return { marker: '<value>' };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimEnd(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/** A pattern that matches `base` written with either kind of separator. */
function basePattern(base: string): string {
  return escapeRegExp(trimEnd(base)).replace(/\\\\|\//g, '[\\\\/]');
}

const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'<>|*?]*/g;
const UNC_PATH_RE = /\\\\[^\s\\/"'<>|]+[\\/][^\s"'<>|*?]*/g;
const POSIX_PATH_RE = /(?<![\w.<>-])\/(?:Users|home|root|private|var|tmp|mnt|opt|Volumes|srv|etc|usr)\/[^\s"'<>|*?]*/g;

export interface Scrubber {
  string(text: string): string;
  deep(value: unknown): unknown;
}

/**
 * Rewrites the repository to `<repo>` and the home folders to `<home>` (the longer base first, so that a repository inside the
 * home is `<repo>`), then every other absolute path to `<path>`, then the values of environment variables that look like
 * secrets to `<redacted>`.
 */
export function makeScrubber(
  env: Readonly<Record<string, string | undefined>>,
  repos: readonly string[],
  homeDirs: readonly string[],
  insensitive: boolean = pathsCaseInsensitive,
): Scrubber {
  const bases: { readonly base: string; readonly label: string }[] = repos.map((base) => ({ base, label: '<repo>' }));
  const envHomes = [env['HOME'], env['USERPROFILE']].filter((h): h is string => h !== undefined && h !== '');
  for (const home of [...envHomes, ...homeDirs]) bases.push({ base: home, label: '<home>' });
  const usable = bases
    .filter(({ base }) => trimEnd(base).length > 1)
    .sort((a, b) => trimEnd(b.base).length - trimEnd(a.base).length);
  const flags = insensitive ? 'gi' : 'g';
  const rules = usable.map(({ base, label }) => ({
    label,
    re: new RegExp(`${basePattern(base)}(?=$|[\\\\/\\s"'<>|*?])((?:[\\\\/][^\\s"'<>|*?]*)?)`, flags),
  }));
  const secrets = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([name, value]) => SECRET_ENV_RE.test(name) && value.length >= SECRET_MIN_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);

  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('<redacted>');
    for (const { label, re } of rules) {
      out = out.replace(re, (_whole, tail: string) => `${label}${tail.replace(/\\/g, '/')}`);
    }
    return out.replace(UNC_PATH_RE, '<path>').replace(WINDOWS_PATH_RE, '<path>').replace(POSIX_PATH_RE, '<path>');
  };
  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map((item: unknown) => deep(item));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = deep(item);
      return out;
    }
    return value;
  };
  return { string: scrub, deep };
}

// ---- the sections ----------------------------------------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (error instanceof McsError) return error.code;
  return error instanceof Error ? error.name : 'error';
}

function statusOf(r: StatusReport): DiagnosticsStatus {
  return {
    running: r.running,
    probe: r.probe,
    pid: r.pid ?? null,
    url: r.url ?? null,
    uptimeS: r.uptime_s ?? null,
    codeStamp: r.code_stamp ?? null,
    runtimeVersion: r.runtime_version ?? null,
    outdated: r.outdated ?? null,
    outdatedReason: r.outdated_reason ?? null,
    dbSchemaVersion: r.db_schema_version ?? null,
    ingestion: r.ingestion === undefined ? null : { status: r.ingestion.status, reasons: [...r.ingestion.reasons] },
    sessions: r.sessions === undefined ? null : { ...r.sessions },
    partialSessions: r.partial_sessions ?? null,
    hint: r.hint ?? null,
    recentErrors: (r.recent_errors ?? []).map((e) => ({ at: e.at, where: e.where, message: e.message })),
  };
}

type Health = NonNullable<DiagnosticsBundle['health']>;

async function fetchHealth(url: string, deps: DiagnosticsDeps, notes: string[]): Promise<Health | null> {
  try {
    const get = deps.lifecycle?.httpGet ?? httpGet;
    const attempt = await get(`${url}/api/v3/health`, { timeoutMs: HEALTH_TIMEOUT_MS });
    if (!attempt.ok) {
      notes.push(`health: no answer (${attempt.reason})`);
      return null;
    }
    if (attempt.reply.status !== 200) {
      notes.push(`health: status ${String(attempt.reply.status)}`);
      return null;
    }
    const parsed = routes.health.response.safeParse(jsonBodyOf(attempt.reply));
    if (!parsed.success) {
      notes.push('health: the answer does not match the health schema');
      return null;
    }
    const alerts = parsed.data.alerts.map((a) => ({
      rule: a.rule,
      severity: a.severity,
      status: a.status,
      since: a.since,
      fireCount: a.fireCount,
    }));
    return DiagnosticsHealthSchema.parse({ ...parsed.data, alerts });
  } catch (error) {
    notes.push(`health: not read (${messageOf(error)})`);
    return null;
  }
}

async function configSection(
  ctx: OpContext,
  ws: WorkspaceRef,
  notes: string[],
): Promise<NonNullable<DiagnosticsBundle['config']> | null> {
  let resolved: Awaited<ReturnType<typeof resolveConfig>>;
  try {
    resolved = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  } catch (error) {
    notes.push(`config: not resolved (${messageOf(error)})`);
    return null;
  }
  const inspection = toConfigInspection(resolved, 'node');
  const provenance: Record<string, ConfigSource> = {};
  const safeValues: Record<string, number | boolean | string> = {};
  const redacted: Record<string, string> = {};
  let skipped = 0;
  for (const entry of inspection.entries) {
    if (!KEY_RE.test(entry.key)) {
      skipped += 1;
      continue;
    }
    provenance[entry.key] = entry.source;
    const kept = classifyConfigValue(entry.key, entry.value);
    if ('safe' in kept) safeValues[entry.key] = kept.safe;
    else redacted[entry.key] = kept.marker;
  }
  provenance['effectivePort'] = resolved.provenance['effectivePort'] ?? 'builtin';
  safeValues['effectivePort'] = resolved.effectivePort;
  if (skipped > 0) notes.push(`config: ${String(skipped)} keys with unusual names are left out`);
  return {
    files: inspection.files.map((f) => ({ ...f })),
    provenance,
    safeValues,
    redacted,
  };
}

/** The log records the logger would have written: only its allow-listed fields, with short plain values. */
export function logRecordOf(line: string): LogRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const { ts, level, event } = source;
  if (typeof ts !== 'string' || ts.length > LOG_STRING_MAX || typeof event !== 'string') return null;
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return null;
  if (event.length > LOG_STRING_MAX) return null;
  const record: Record<string, string | number | boolean> = { ts, level, event };
  for (const name of LOG_FIELD_NAMES) {
    if (name === 'event') continue;
    const field = source[name];
    if (typeof field === 'string' && field.length <= LOG_STRING_MAX) record[name] = field;
    else if (typeof field === 'number' && Number.isFinite(field)) record[name] = field;
    else if (typeof field === 'boolean') record[name] = field;
  }
  const parsed = LogRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

async function logTailOf(ws: WorkspaceRef | null, seams: DiagnosticsSeams, notes: string[]): Promise<LogRecord[]> {
  if (ws === null) return [];
  try {
    const lines = await seams.tailLines(workspacePath(ws, 'logs', 'runtime.log'), DIAGNOSTICS_LOG_RECORDS);
    const records: LogRecord[] = [];
    for (const line of lines) {
      const record = logRecordOf(line);
      if (record !== null) records.push(record);
    }
    return records.slice(-DIAGNOSTICS_LOG_RECORDS);
  } catch (error) {
    notes.push(`logTail: not read (${messageOf(error)})`);
    return [];
  }
}

function doctorChecksOf(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks.map((c) => (!c.ok && WITHHELD_DETAIL.has(c.id) ? { ...c, detail: WITHHELD_TEXT } : { ...c }));
}

// ---- the bundle ------------------------------------------------------------------------------------------------------------

/** Collects the bundle; nothing is written. Every string is already scrubbed and the whole is validated. */
export async function collect(
  ctx: OpContext,
  input: Pick<DiagnosticsInput, 'task'> = {},
  deps: DiagnosticsDeps = {},
  seams: Partial<DiagnosticsSeams> = {},
): Promise<DiagnosticsBundle> {
  const all: DiagnosticsSeams = { ...NODE_SEAMS, ...seams };
  const doctorSeams: DoctorSeams = { ...nodeDoctorSeams, ...all.doctor };
  const ws = input.task === undefined ? null : await openWorkspace(ctx, input.task);
  const notes: string[] = [];

  const doctor = await runDoctor(ctx, input.task === undefined ? {} : { task: input.task }, deps, all.doctor);

  let status: DiagnosticsStatus | null = null;
  let health: Health | null = null;
  if (ws !== null) {
    try {
      const { report } = await lifecycleStatus(ctx, { task: ws.slug }, deps.lifecycle);
      status = statusOf(report);
      if (report.running && report.url !== undefined) health = await fetchHealth(report.url, deps, notes);
      else notes.push('health: no runtime runs');
    } catch (error) {
      notes.push(`status: not read (${messageOf(error)})`);
    }
  }

  let instance: DiagnosticsBundle['instance'] = null;
  if (ws !== null) {
    try {
      const file = await readInstanceFile(ws);
      if (file === null) notes.push('instance: the workspace has no instance.json');
      else {
        instance = {
          instanceId: file.instanceId,
          slug: file.slug,
          dbSchemaVersion: health?.db.schemaVersion ?? file.dbSchemaVersion,
          hooksEnabled: file.hooks.enabled,
        };
      }
    } catch (error) {
      notes.push(`instance: not read (${messageOf(error)})`);
    }
  }

  let hooks: HooksVerifyResult | null = null;
  if (ws !== null && deps.hooksVerify !== undefined) {
    try {
      const answer = await deps.hooksVerify(ctx, ws);
      const parsed = HooksVerifyResultSchema.safeParse(answer);
      if (parsed.success) hooks = parsed.data;
      else if (answer !== null) notes.push('hooks: the answer does not match the hooks schema');
    } catch (error) {
      notes.push(`hooks: not verified (${messageOf(error)})`);
    }
  }

  let freeBytes: number | null = null;
  try {
    freeBytes = Math.max(0, Math.floor(await doctorSeams.freeBytes(ws?.dir ?? ctx.repo)));
  } catch {
    notes.push('disk: free space not read');
  }

  const bundle: DiagnosticsBundle = {
    schema: DIAGNOSTICS_SCHEMA,
    generatedAt: isoMsZ(ctx.clock.now()),
    runtime: {
      version: RUNTIME_VERSION,
      codeStamp: await doctorSeams.codeStamp(ctx.runtimeDir),
      node: doctorSeams.nodeVersion,
      platform: doctorSeams.platform,
      arch: all.arch,
      buildCurrent: status?.outdated === null || status === null ? null : !status.outdated,
    },
    instance,
    config: ws === null ? null : await configSection(ctx, ws, notes),
    doctor: doctorChecksOf(doctor.checks),
    status,
    health,
    hooks,
    logTail: await logTailOf(ws, all, notes),
    disk: { freeBytes },
    notes,
  };
  const envHomes = [ctx.env['HOME'], ctx.env['USERPROFILE']].filter((h): h is string => h !== undefined && h !== '');
  const repos = [ctx.repo, await realOrSelf(ctx.repo)];
  const homes = [...all.homeDirs, ...(await Promise.all(envHomes.map(realOrSelf)))];
  const scrubber = makeScrubber(ctx.env, repos, homes);
  return DiagnosticsBundleSchema.parse(scrubber.deep(bundle));
}

// ---- the output file -------------------------------------------------------------------------------------------------------

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

const same = (a: string, b: string): boolean => (pathsCaseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

function isInside(parent: string, child: string): boolean {
  const rel = pathsCaseInsensitive
    ? path.relative(parent.toLowerCase(), child.toLowerCase())
    : path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function forbidden(message: string, hint: string): McsError {
  return new McsError('OUTPUT_PATH_FORBIDDEN', message, { hint });
}

/** `20261020T101500Z` */
function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

interface Target {
  /** The real, existing folder. */
  readonly dir: string;
  /** The file names to try, in order. */
  readonly names: readonly string[];
}

async function targetOf(ctx: OpContext, ws: WorkspaceRef | null, out: string | undefined): Promise<Target> {
  const claudeHome = await realOrSelf(claudeHomeOf(ctx.env));
  const tasksRoot = await realOrSelf(ctx.root);
  let dir: string;
  let names: string[];
  if (out === undefined) {
    if (ws === null) {
      throw new McsError('USAGE', 'diagnostics needs --task SLUG or --out FILE', {
        hint: 'with --task the bundle is written to the logs folder of the task',
      });
    }
    const logs = workspacePath(ws, 'logs');
    await mkdir(logs, { recursive: true });
    dir = await realpath(logs);
    const stem = `diagnostics-${utcStamp(ctx.clock.now())}`;
    names = [`${stem}.json`, ...Array.from({ length: 99 }, (_unused, i) => `${stem}-${String(i + 2)}.json`)];
  } else {
    const wanted = path.resolve(out);
    const base = path.basename(wanted);
    if (base === '' || base === '.' || base === '..') {
      throw new McsError('USAGE', '--out must name a file', { hint: 'for example --out ./diagnostics.json' });
    }
    try {
      dir = await realpath(path.dirname(wanted));
    } catch {
      throw forbidden('the folder of --out does not exist', 'create the folder first, or choose another file');
    }
    names = [base];
  }
  if (isInside(claudeHome, dir)) {
    throw forbidden('a bundle is never written inside the Claude home', 'choose a file outside the .claude folder');
  }
  if (isInside(tasksRoot, dir)) {
    const logs = ws === null ? null : await realOrSelf(workspacePath(ws, 'logs'));
    if (logs === null || !same(dir, logs)) {
      throw forbidden(
        'a bundle inside a task workspace may only go to the logs folder of the task it describes',
        'choose a file outside the tasks folder, or use --task and no --out',
      );
    }
    if (names.some((n) => n.toLowerCase().endsWith('.jsonl'))) {
      throw forbidden('a .jsonl file inside a task workspace fails the audit', 'use the .json extension');
    }
  }
  return { dir, names };
}

/** Creates the first of `names` that does not exist (`wx`), so an existing file is never touched. */
async function createExclusive(target: Target, text: string): Promise<string> {
  for (const name of target.names) {
    const file = path.join(target.dir, name);
    let handle;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(text, 'utf8');
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(file).catch(() => undefined);
      throw error;
    }
    return file;
  }
  throw new McsError('OUTPUT_EXISTS', `${target.names[0] ?? 'the output file'} already exists`, {
    hint: 'choose another file name; an existing file is never overwritten',
  });
}

/**
 * `ops.diagnostics.bundle`: collects the bundle and writes it once, to a file that did not exist. The written file is read
 * back and validated against `DiagnosticsBundleSchema` before the call returns.
 */
export async function bundle(
  ctx: OpContext,
  input: DiagnosticsInput = {},
  deps: DiagnosticsDeps = {},
  seams: Partial<DiagnosticsSeams> = {},
): Promise<DiagnosticsResult> {
  const ws = input.task === undefined ? null : await openWorkspace(ctx, input.task);
  const target = await targetOf(ctx, ws, input.out);
  const collected = await collect(ctx, input, deps, seams);
  const text = `${JSON.stringify(collected, null, 2)}${LF}`;
  const file = await createExclusive(target, text);
  const written = DiagnosticsBundleSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  return { path: file, bytes: Buffer.byteLength(text, 'utf8'), bundle: written };
}

/** The text lines of the command: the file, its size and what could not be collected. */
export function bundleLines(result: DiagnosticsResult): string[] {
  const lines = [result.path];
  if (result.bundle.notes.length > 0) lines.push(...result.bundle.notes.map((n) => `note: ${n}`));
  return lines;
}
