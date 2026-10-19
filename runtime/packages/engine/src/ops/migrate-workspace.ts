// `mcs migrate-workspace` (ADR 0068, ADR 0067): the one-time conversion of a pre-4.0 task workspace. `plan` is the dry run:
// it reads only, takes no lock and writes nothing. `apply` takes the task mutex around read, validate, backup, write, adopt,
// re-resolve and audit; it writes nothing for a blocked or current workspace, never signals a process and never touches
// `logs/`, the database, `runtime.json` or another task. `--all` (WP-140) visits every workspace of the tasks root one after
// the other, each exactly like a single task under its own mutex: a workspace that is blocked, or that fails with an
// expected error, is reported and left as it was, and the others are still converted. Folders that are links are never
// followed; they are listed as skipped.
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { McsError, SLUG_RE, type DoctorCheck } from '@mcs/shared';

import { appendChange } from '../audit/writer.ts';
import { resolveConfig } from '../config/resolve.ts';
import { validateLegacy } from '../config/validate-legacy.ts';
import { auditSummary, reportLines, type WorkspaceMigrationReport } from '../migrate/report.ts';
import { backupWorkspace, restoreConfig, type MigrationBackup } from '../migrate/backup.ts';
import { planPatterns, sameConfig, type PatternPlan } from '../migrate/patterns.ts';
import { jsonFileText, type JsonDoc } from '../json/index.ts';
import { ensureWorkspaceDir, newInstanceFile, readInstanceFile, writeInstanceFile } from '../workspace/adopt.ts';
import { isMissingFileError, readJsonFile, writeWorkspaceFile } from '../workspace/fsio.ts';
import { listWorkspaceSlugs } from '../workspace/list.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { isLiveState, probeInstance, type ProbeState } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export { reportLines };
export type { WorkspaceMigrationReport } from '../migrate/report.ts';
export type { PatternStep } from '../migrate/patterns.ts';

/** One workspace: `plan` and `apply` return its report. */
export interface TaskInput {
  readonly task?: string;
  readonly all?: false;
}

/** Every workspace of the tasks root: `plan` and `apply` return a `MigrationSweep`. Not together with a task. */
export interface SweepInput {
  readonly all: true;
  readonly task?: undefined;
}

export type MigrateInput = TaskInput | SweepInput;

/** A folder of the tasks root that looks like a workspace and was not visited. */
export interface SkippedFolder {
  readonly slug: string;
  readonly reason: string;
}

export interface MigrationCounts {
  readonly total: number;
  /** Nothing to do. */
  readonly current: number;
  /** Would be converted (dry run) or was converted (applied). */
  readonly needsMigration: number;
  readonly blocked: number;
}

/** The result of `--all`: one report per workspace in slug order, the folders that were skipped and the tally. */
export interface MigrationSweep {
  readonly mode: WorkspaceMigrationReport['mode'];
  readonly workspaces: readonly WorkspaceMigrationReport[];
  readonly skipped: readonly SkippedFolder[];
  readonly counts: MigrationCounts;
}

/** Test seams; the defaults are the real probe and the real configuration resolver. */
export interface MigrateDeps {
  readonly probe?: (ws: WorkspaceRef) => Promise<{ readonly state: ProbeState }>;
  /** The re-resolve after the write; throws when the converted configuration does not resolve. */
  readonly resolve?: (ws: WorkspaceRef) => Promise<void>;
}

type JsonObject = Extract<JsonDoc, { k: 'obj' }>;

/** Folders that the adoption adds to a workspace without `instance.json`. */
const ADOPT_DIRS = ['audit', 'data', 'logs'] as const;

/** A validation problem of a pattern: its own step reports it, and its text repeats the pattern, so it is dropped here. */
const PATTERN_PROBLEM = /^(?:session_rules|attempts\.start|attempts\.end): invalid regex/u;

interface Analysis {
  readonly ws: WorkspaceRef;
  readonly hasInstance: boolean;
  readonly configText: string | null;
  readonly plan: PatternPlan | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly changed: boolean;
}

function codeOf(error: unknown): string {
  return error instanceof McsError ? error.code : 'INTERNAL';
}

async function liveBlocker(ws: WorkspaceRef, deps: MigrateDeps): Promise<string | null> {
  const probe = deps.probe ?? ((w: WorkspaceRef) => probeInstance(w));
  const { state } = await probe(ws);
  if (!isLiveState(state)) return null;
  if (state === 'unmanaged-running') {
    // never signalled by this runtime (ADR 0066): `mcs stop` refuses it, so the hint names the tool that started it
    return `INSTANCE_RUNNING: a monitor that was not started by this runtime runs for this workspace (${state}); stop it with the tool that started it`;
  }
  return `INSTANCE_RUNNING: a monitor runs for this workspace (${state}); stop it first with \`mcs stop --task ${ws.slug}\``;
}

/** Reads and plans one workspace; writes nothing. */
async function analyse(ws: WorkspaceRef, deps: MigrateDeps): Promise<Analysis> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let hasInstance = false;
  try {
    hasInstance = (await readInstanceFile(ws)) !== null;
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    blockers.push(
      `${error.code === 'IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH' : 'WORKSPACE_INVALID'}: ${error.message}`,
    );
  }
  const live = await liveBlocker(ws, deps);
  if (live !== null) blockers.push(live);

  let configText: string | null = null;
  let doc: JsonObject | null = null;
  try {
    const read = await readJsonFile(workspacePath(ws, 'config.json'));
    configText = read.text;
    if (read.value.k === 'obj') doc = read.value;
    else blockers.push('CONFIG_INVALID: config.json is not a JSON object');
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    blockers.push(
      isMissingFileError(error.cause)
        ? 'WORKSPACE_INVALID: config.json is missing'
        : 'CONFIG_INVALID: config.json is not valid JSON (UTF-8 without a byte order mark)',
    );
  }
  if (doc === null) return { ws, hasInstance, configText, plan: null, blockers, warnings, changed: false };

  const plan = planPatterns(doc, hasInstance);
  blockers.push(...plan.blockers);
  warnings.push(...plan.warnings);
  for (const problem of validateLegacy(plan.doc, { strict: true })) {
    if (!PATTERN_PROBLEM.test(problem)) blockers.push(`CONFIG_INVALID: ${problem}`);
  }
  const changed = !sameConfig(doc, plan.doc);
  if (changed && configText !== jsonFileText(doc)) {
    warnings.push('config.json: is rewritten in the standard layout (indent 2, one key per line)');
  }
  return { ws, hasInstance, configText, plan, blockers, warnings, changed };
}

function verdictOf(a: Analysis): WorkspaceMigrationReport['verdict'] {
  if (a.blockers.length > 0) return 'blocked';
  return a.changed || !a.hasInstance ? 'needs-migration' : 'current';
}

function actionsOf(a: Analysis, backup: string | null): string[] {
  if (verdictOf(a) !== 'needs-migration' || a.plan === null) return [];
  const actions = [`back up the workspace files to ${backup ?? 'data/backups/pre-migrate-<UTC stamp>/'}`];
  for (const step of a.plan.steps) {
    if (step.action === 'translate') actions.push(`translate ${step.where} to the JavaScript dialect`);
  }
  if (a.changed) actions.push('write config.json');
  if (!a.hasInstance) actions.push('add instance.json, audit/, data/ and logs/');
  actions.push('append one migrate-workspace entry to audit/changes.md');
  return actions;
}

function reportOf(
  a: Analysis,
  mode: WorkspaceMigrationReport['mode'],
  backup: string | null,
  extraBlockers: readonly string[] = [],
): WorkspaceMigrationReport {
  const blocked = extraBlockers.length > 0;
  return {
    slug: a.ws.slug,
    verdict: blocked ? 'blocked' : verdictOf(a),
    mode,
    actions: blocked ? [] : actionsOf(a, backup),
    patterns: a.plan?.steps ?? [],
    blockers: [...a.blockers, ...extraBlockers],
    warnings: a.warnings,
    backup,
  };
}

/** The one task of a single-task call, or `null` for `--all`; `USAGE` for neither or both. */
function taskOf(input: MigrateInput): string | null {
  const task = input.task;
  if (input.all === true) {
    if (task !== undefined) throw new McsError('USAGE', 'migrate-workspace takes --task SLUG or --all, not both');
    return null;
  }
  if (task === undefined || task === '') throw new McsError('USAGE', 'migrate-workspace needs --task SLUG or --all');
  return task;
}

/** The dry run of one opened workspace. */
async function planWorkspace(ws: WorkspaceRef, deps: MigrateDeps): Promise<WorkspaceMigrationReport> {
  return reportOf(await analyse(ws, deps), 'dry-run', null);
}

async function defaultResolve(ctx: OpContext, ws: WorkspaceRef): Promise<void> {
  await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
}

async function adopt(ws: WorkspaceRef, nowMs: number): Promise<void> {
  for (const folder of ADOPT_DIRS) await ensureWorkspaceDir(ws, folder);
  await writeInstanceFile(ws, newInstanceFile(ws.slug, { nowMs }));
}

/** What `applyWorkspace` has done so far, for the report of a sweep when it stops with an error. */
interface Progress {
  backup: string | null;
}

/** Converts one opened workspace under its task mutex. */
async function applyWorkspace(
  ctx: OpContext,
  ws: WorkspaceRef,
  deps: MigrateDeps,
  progress: Progress = { backup: null },
): Promise<WorkspaceMigrationReport> {
  return withTaskMutex(ws, async () => {
    const a = await analyse(ws, deps);
    if (verdictOf(a) !== 'needs-migration' || a.plan === null) return reportOf(a, 'applied', null);
    const nowMs = ctx.clock.now();
    const backup: MigrationBackup = await backupWorkspace(ws, nowMs);
    progress.backup = backup.folder;
    if (a.changed) await writeWorkspaceFile(workspacePath(ws, 'config.json'), jsonFileText(a.plan.doc));
    if (!a.hasInstance) await adopt(ws, nowMs);
    try {
      await (deps.resolve ?? ((w: WorkspaceRef) => defaultResolve(ctx, w)))(ws);
    } catch (error) {
      if (a.changed) await restoreConfig(ws, backup);
      ctx.log.warn('migrate_workspace_restored', { code: codeOf(error) });
      return reportOf(a, 'applied', backup.folder, [
        `CONFIG_INVALID: the converted configuration did not resolve (${codeOf(error)}); config.json was restored from ${backup.folder}`,
      ]);
    }
    const files = [...(a.changed ? ['config.json'] : []), ...(a.hasInstance ? [] : ['instance.json'])];
    await appendChange(
      ws,
      {
        action: 'migrate-workspace',
        summary: auditSummary(a.plan.steps, !a.hasInstance),
        reason: 'one-time conversion of a pre-4.0 workspace (ADR 0068)',
        files,
        validation: 'patterns compile; configuration resolves',
        outcome: `migrated; backup in ${backup.folder}`,
      },
      nowMs,
    );
    return reportOf(a, 'applied', backup.folder);
  });
}

// ---- the sweep (--all)

/** Folders of the tasks root that have a slug for a name and are links: a workspace is a real folder, a link is never followed. */
async function linkedFolders(root: string): Promise<SkippedFolder[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new McsError('WORKSPACE_INVALID', `cannot list the tasks root ${root}`, { cause: error });
  }
  const skipped: SkippedFolder[] = [];
  for (const name of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!SLUG_RE.test(name)) continue;
    let isLink = false;
    try {
      isLink = (await lstat(path.join(root, name))).isSymbolicLink();
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    if (isLink) {
      skipped.push({ slug: name, reason: 'a link, not a folder; links are never followed or written through' });
    }
  }
  return skipped;
}

/** The report of a workspace that stopped with an expected error: blocked, with the code and the reason. */
function failedReport(
  slug: string,
  mode: WorkspaceMigrationReport['mode'],
  error: McsError,
  backup: string | null,
): WorkspaceMigrationReport {
  return {
    slug,
    verdict: 'blocked',
    mode,
    actions: [],
    patterns: [],
    blockers: [`${error.code}: ${error.message}`],
    warnings:
      backup === null
        ? []
        : [
            `the conversion of '${slug}' stopped after the backup was written; config.json is replaced atomically, so it is the old or the new text; run the command again once the cause is fixed`,
          ],
    backup,
  };
}

/** One workspace of the sweep: exactly the single-task path, with an expected error turned into a blocked report. */
async function visit(
  ctx: OpContext,
  slug: string,
  mode: WorkspaceMigrationReport['mode'],
  deps: MigrateDeps,
): Promise<WorkspaceMigrationReport> {
  const progress: Progress = { backup: null };
  try {
    const ws = await openWorkspace(ctx, slug);
    return mode === 'dry-run' ? await planWorkspace(ws, deps) : await applyWorkspace(ctx, ws, deps, progress);
  } catch (error) {
    if (!(error instanceof McsError)) throw error;
    return failedReport(slug, mode, error, progress.backup);
  }
}

function countsOf(reports: readonly WorkspaceMigrationReport[]): MigrationCounts {
  const of = (verdict: WorkspaceMigrationReport['verdict']): number =>
    reports.filter((r) => r.verdict === verdict).length;
  return {
    total: reports.length,
    current: of('current'),
    needsMigration: of('needs-migration'),
    blocked: of('blocked'),
  };
}

async function sweepOf(
  ctx: OpContext,
  mode: WorkspaceMigrationReport['mode'],
  deps: MigrateDeps,
): Promise<MigrationSweep> {
  const slugs = await listWorkspaceSlugs(ctx.root);
  const skipped = await linkedFolders(ctx.root);
  const workspaces: WorkspaceMigrationReport[] = [];
  for (const slug of slugs) workspaces.push(await visit(ctx, slug, mode, deps));
  return { mode, workspaces, skipped, counts: countsOf(workspaces) };
}

function plural(n: number, one: string): string {
  return `${String(n)} ${n === 1 ? one : `${one}s`}`;
}

/** The default output of a sweep: the lines of each workspace, the skipped folders, one tally line and one closing hint. */
export function sweepLines(sweep: MigrationSweep): string[] {
  const lines: string[] = [];
  for (const report of sweep.workspaces) lines.push(...reportLines(report, { hint: false }));
  for (const folder of sweep.skipped) lines.push(`skipped '${folder.slug}': ${folder.reason}`);
  const { total, current, needsMigration, blocked } = sweep.counts;
  if (total === 0) {
    lines.push('no task workspaces found in the tasks root');
    return lines;
  }
  const dry = sweep.mode === 'dry-run';
  const tally = [
    `${String(needsMigration)} ${dry ? 'needing migration' : 'migrated'}`,
    `${String(current)} ${dry ? 'current' : 'already current'}`,
    `${String(blocked)} blocked`,
  ];
  lines.push(`${plural(total, 'task workspace')}: ${tally.join(', ')}${dry ? ' (dry run, nothing written)' : ''}`);
  if (dry && needsMigration > 0) {
    lines.push('run `mcs migrate-workspace --all --apply --yes` to convert them (a backup is written first)');
  }
  return lines;
}

/** `opsMigrate.plan`: the dry run of one workspace, or of every workspace with `all: true`. */
export function plan(ctx: OpContext, input: SweepInput, deps?: MigrateDeps): Promise<MigrationSweep>;
export function plan(ctx: OpContext, input: TaskInput, deps?: MigrateDeps): Promise<WorkspaceMigrationReport>;
export async function plan(
  ctx: OpContext,
  input: MigrateInput,
  deps: MigrateDeps = {},
): Promise<MigrationSweep | WorkspaceMigrationReport> {
  const task = taskOf(input);
  if (task === null) return sweepOf(ctx, 'dry-run', deps);
  return planWorkspace(await openWorkspace(ctx, task), deps);
}

/** `opsMigrate.apply`: converts one workspace under its task mutex, or every workspace one after the other with `all: true`. */
export function apply(ctx: OpContext, input: SweepInput, deps?: MigrateDeps): Promise<MigrationSweep>;
export function apply(ctx: OpContext, input: TaskInput, deps?: MigrateDeps): Promise<WorkspaceMigrationReport>;
export async function apply(
  ctx: OpContext,
  input: MigrateInput,
  deps: MigrateDeps = {},
): Promise<MigrationSweep | WorkspaceMigrationReport> {
  const task = taskOf(input);
  if (task === null) return sweepOf(ctx, 'applied', deps);
  return applyWorkspace(ctx, await openWorkspace(ctx, task), deps);
}

// ---- the doctor check

/** The format of a workspace is a question about its files: a running monitor is not an answer to it, so the probe says stopped. */
const NOT_RUNNING: MigrateDeps = { probe: () => Promise.resolve({ state: 'stopped' }) };

function formatDetail(report: WorkspaceMigrationReport): string {
  const translated = report.patterns.filter((p) => p.action === 'translate').length;
  const parts = [
    ...(translated > 0 ? [`${plural(translated, 'pattern')} in the old syntax`] : []),
    ...(report.actions.some((a) => a.startsWith('add instance.json')) ? ['no instance.json'] : []),
  ];
  return `written before 4.0 and not converted yet${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
}

/**
 * The doctor check `workspace.format` (`DoctorDeps.extraChecks`): `warn` when the dry run lists work for the workspace, or
 * cannot convert it, with the command that shows it; `ok` when it is current. Reads only, takes no lock and writes nothing.
 */
export async function workspaceFormatCheck(_ctx: OpContext, ws: WorkspaceRef | null): Promise<DoctorCheck> {
  const id = 'workspace.format';
  if (ws === null) return { id, ok: true, level: 'warn', detail: 'no task selected (skipped)' };
  const report = await planWorkspace(ws, NOT_RUNNING);
  const fix = `mcs migrate-workspace --task ${ws.slug}`;
  switch (report.verdict) {
    case 'current':
      return { id, ok: true, level: 'warn', detail: 'the workspace is in the 4.0 format' };
    case 'needs-migration':
      return { id, ok: false, level: 'warn', detail: formatDetail(report), fix };
    case 'blocked':
      return {
        id,
        ok: false,
        level: 'warn',
        detail: `cannot be converted automatically: ${report.blockers[0] ?? 'unknown reason'}`,
        fix,
      };
  }
}
