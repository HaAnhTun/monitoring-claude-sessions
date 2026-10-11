// Engine operations behind `decide` and `audit` (01 6.4, 7.1, registry 2.1): the decision entry of the audit trail and the
// static checks of a workspace, the legacy ones with the legacy texts plus the Node ones when `instance.json` exists.
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { McsError, stateEngine } from '@mcs/shared';
import { SPOOL_SEGMENT_RE } from '@mcs/shared/protocol';

import { auditFilePath, readAuditText } from '../audit/reader.ts';
import { appendDecision, decisionEntryText } from '../audit/writer.ts';
import {
  checkSchemaVersion,
  getEntry,
  readConfigJson,
  readOptionalConfigJson,
  type PyObject,
} from '../config/defaults.ts';
import { resolveConfig } from '../config/resolve.ts';
import { pyEquals, pyFloatRepr, pyRepr, type PyJsonValue } from '../pyjson/index.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { isMissingFileError } from '../workspace/fsio.ts';
import { listWorkspaceSlugs } from '../workspace/list.ts';
import { compareCodePoints, openWorkspace, readStateFile, type OpContext } from './workspace.ts';
import { resolveWorkspace, withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { runtimeProblems } from './config.ts';

const TASK_SCHEMA = 1;
const SPOOL_DIR = ['data', 'spool'] as const;

// ---- decide

export interface DecisionInput {
  readonly task: string;
  readonly title: string;
  readonly decision: string;
  /** `--rejected`; absent or empty: `none recorded`. */
  readonly rejected?: string;
}

export interface DecisionResult {
  /** `<workspace>/audit/decisions.md`. */
  readonly path: string;
  /** `recorded decision in <path>` (legacy). */
  readonly message: string;
}

/**
 * `ops.audit.recordDecision` (01 6.4): appends one decision entry under the task mutex and reads the appended bytes back.
 * Line breaks inside the fields become spaces (01 7.1), so an entry can never forge a second one.
 */
export async function recordDecision(ctx: OpContext, input: DecisionInput): Promise<DecisionResult> {
  const ws = await openWorkspace(ctx, input.task);
  const file = auditFilePath(ws, 'decisions');
  const rejected = input.rejected === undefined || input.rejected === '' ? null : input.rejected;
  await withTaskMutex(ws, async () => {
    // Read inside the lock: a call that waited for it must not be stamped earlier than the entries appended meanwhile.
    const now = ctx.clock.now();
    await appendDecision(ws, input.title, input.decision, rejected, now);
    const text = await readAuditText(ws, 'decisions');
    if (text?.endsWith(decisionEntryText(input.title, input.decision, rejected, now)) !== true) {
      throw new McsError('INTERNAL', 'audit/decisions.md does not end with the appended decision after the write');
    }
  });
  return { path: file, message: `recorded decision in ${file}` };
}

// ---- audit

export interface AuditReportItem {
  readonly task: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface AuditCheckInput {
  /** One workspace; absent: every workspace of the tasks root. */
  readonly task?: string;
}

/** Python `repr` of a parsed JSON value, as the legacy messages show a `task.json` field. */
function pyReprOf(value: PyJsonValue | undefined): string {
  if (value === undefined) return 'None';
  switch (value.k) {
    case 'null':
      return 'None';
    case 'str':
      return pyRepr(value.v);
    case 'bool':
      return value.v ? 'True' : 'False';
    case 'int':
      return value.v.toString();
    case 'float':
      return pyFloatRepr(value.v);
    case 'arr':
      return `[${value.v.map(pyReprOf).join(', ')}]`;
    case 'obj': {
      // Python keeps the position of the first occurrence of a repeated key and the value of the last one.
      const entries = new Map<string, PyJsonValue>();
      for (const [key, item] of value.v) entries.set(key, item);
      return `{${[...entries].map(([key, item]) => `${pyRepr(key)}: ${pyReprOf(item)}`).join(', ')}}`;
    }
  }
}

/** Relative path with `/` (the legacy command prints the OS separator; a report must read the same on every system). */
function relativeOf(ws: WorkspaceRef, full: string): string {
  return path.relative(ws.dir, full).split(path.sep).join('/');
}

/** The legacy `os.walk` checks: a link anywhere, and any `*.jsonl` (a transcript copy). Folders are listed before files, each in name order. */
async function walkProblems(ws: WorkspaceRef, dir: string, problems: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  entries.sort((a, b) => compareCodePoints(a.name, b.name));
  const folders = entries.filter((e) => e.isDirectory());
  const others = entries.filter((e) => !e.isDirectory());
  for (const entry of [...folders, ...others]) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      problems.push(`symlink inside task workspace: ${relativeOf(ws, full)}`);
    } else if (entry.name.endsWith('.jsonl')) {
      problems.push(`transcript copy found (never copy transcripts): ${relativeOf(ws, full)}`);
    }
  }
  for (const folder of folders) {
    if (!folder.isSymbolicLink()) await walkProblems(ws, path.join(dir, folder.name), problems);
  }
}

async function legacyProblems(ctx: OpContext, slug: string, ws: WorkspaceRef, problems: string[]): Promise<void> {
  const task = await readConfigJson(workspacePath(ws, 'task.json'));
  const id = getEntry(task, 'id');
  if (id?.k !== 'str' || id.v !== slug) {
    problems.push(`task.json id ${pyReprOf(id)} does not match folder ${pyRepr(slug)}`);
  }
  const version = getEntry(task, 'schema_version');
  if (version === undefined || !pyEquals(version, { k: 'int', v: BigInt(TASK_SCHEMA) })) {
    problems.push(`task.json schema_version ${pyReprOf(version)} unsupported`);
  }
  try {
    await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    problems.push(error.message);
  }
  try {
    const entries = await readdir(path.join(ws.dir, 'audit'), { withFileTypes: true });
    if (!entries.some((e) => e.name === 'changes.md' && e.isFile())) problems.push('audit/changes.md missing');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    problems.push('audit/changes.md missing');
  }
  await walkProblems(ws, ws.dir, problems);
}

/** `runtime.json` on its own, so that a broken `config.json` does not hide it; the text equals the one of `resolveConfig`. */
async function runtimeFileProblem(ws: WorkspaceRef): Promise<string | null> {
  const file = workspacePath(ws, 'runtime.json');
  try {
    const doc: PyObject | null = await readOptionalConfigJson(file);
    if (doc === null) return null;
    checkSchemaVersion(doc, file, 'runtime.json');
    const problems = runtimeProblems(doc);
    return problems.length === 0 ? null : `invalid runtime config ${file}: ${problems.join('; ')}`;
  } catch (error) {
    if (error instanceof McsError) return error.message;
    throw error;
  }
}

async function spoolProblems(ws: WorkspaceRef): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(workspacePath(ws, ...SPOOL_DIR));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  return names
    .filter((name) => !SPOOL_SEGMENT_RE.test(name))
    .sort(compareCodePoints)
    .map((name) => `unexpected file in ${SPOOL_DIR.join('/')}: ${name}`);
}

async function nodeProblems(ws: WorkspaceRef, problems: string[]): Promise<void> {
  const add = (message: string): void => {
    if (!problems.includes(message)) problems.push(message);
  };
  let instance: Awaited<ReturnType<typeof readInstanceFile>>;
  try {
    instance = await readInstanceFile(ws);
  } catch (error) {
    if (error instanceof McsError) {
      add(error.message);
      return;
    }
    throw error;
  }
  if (instance === null) return;
  const runtime = await runtimeFileProblem(ws);
  if (runtime !== null) add(runtime);
  for (const message of await spoolProblems(ws)) add(message);
  const state = await readStateFile(ws);
  if (state === null) return;
  if (state.instanceId !== undefined && state.instanceId !== instance.instanceId) {
    add('state.json instanceId does not match instance.json');
  } else if (stateEngine(state) === 'node' && instance.engine === 'legacy') {
    add("state.json engine 'node' does not match instance.json engine 'legacy'");
  }
}

async function auditOne(ctx: OpContext, slug: string): Promise<AuditReportItem> {
  const problems: string[] = [];
  try {
    const ws = resolveWorkspace(ctx.root, slug);
    await legacyProblems(ctx, slug, ws, problems);
    await nodeProblems(ws, problems);
  } catch (error) {
    // The legacy `except ConfigError`: the problem is the message and the remaining checks are skipped.
    if (!(error instanceof McsError)) throw error;
    problems.push(error.message);
  }
  return { task: slug, ok: problems.length === 0, problems };
}

/**
 * `ops.audit.check` (01 6.4): per workspace `{task, ok, problems[]}` with the legacy checks (id, schema, configuration
 * resolves, `changes.md`, links, `*.jsonl`) and, when `instance.json` exists, the Node ones (instance file, runtime file,
 * spool file names, state file consistency). Nothing is written. The exit code (1 when any problem) is the caller's.
 */
export async function check(ctx: OpContext, input: AuditCheckInput = {}): Promise<AuditReportItem[]> {
  const slugs = input.task === undefined ? await listWorkspaceSlugs(ctx.root) : [input.task];
  const report: AuditReportItem[] = [];
  for (const slug of slugs) report.push(await auditOne(ctx, slug));
  return report;
}
