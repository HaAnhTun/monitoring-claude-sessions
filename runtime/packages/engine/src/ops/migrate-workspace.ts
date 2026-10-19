// `mcs migrate-workspace` (ADR 0068, ADR 0067): the one-time conversion of a pre-4.0 task workspace. `plan` is the dry run:
// it reads only, takes no lock and writes nothing. `apply` takes the task mutex around read, validate, backup, write, adopt,
// re-resolve and audit; it writes nothing for a blocked or current workspace, never signals a process and never touches
// `logs/`, the database, `runtime.json` or another task. Single task only (the `--all` sweep is WP-95b).
import { McsError } from '@mcs/shared';

import { appendChange } from '../audit/writer.ts';
import { resolveConfig } from '../config/resolve.ts';
import { validateLegacy } from '../config/validate-legacy.ts';
import { auditSummary, type WorkspaceMigrationReport } from '../migrate/report.ts';
import { backupWorkspace, restoreConfig, type MigrationBackup } from '../migrate/backup.ts';
import { planPatterns, sameConfig, type PatternPlan } from '../migrate/patterns.ts';
import { jsonFileText, type JsonDoc } from '../json/index.ts';
import { ensureWorkspaceDir, newInstanceFile, readInstanceFile, writeInstanceFile } from '../workspace/adopt.ts';
import { isMissingFileError, readJsonFile, writeWorkspaceFile } from '../workspace/fsio.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { isLiveState, probeInstance, type ProbeState } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export { reportLines } from '../migrate/report.ts';
export type { WorkspaceMigrationReport } from '../migrate/report.ts';
export type { PatternStep } from '../migrate/patterns.ts';

export interface MigrateInput {
  readonly task?: string;
  /** Not built yet (WP-95b): refused with `USAGE`. */
  readonly all?: boolean;
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

async function openTask(ctx: OpContext, input: MigrateInput): Promise<WorkspaceRef> {
  if (input.all === true) {
    throw new McsError('USAGE', 'migrate-workspace --all is not available yet; migrate one task with --task SLUG');
  }
  if (input.task === undefined || input.task === '') throw new McsError('USAGE', 'migrate-workspace needs --task SLUG');
  return openWorkspace(ctx, input.task);
}

/** `opsMigrate.plan`: the dry run of one workspace. */
export async function plan(
  ctx: OpContext,
  input: MigrateInput,
  deps: MigrateDeps = {},
): Promise<WorkspaceMigrationReport> {
  const ws = await openTask(ctx, input);
  return reportOf(await analyse(ws, deps), 'dry-run', null);
}

async function defaultResolve(ctx: OpContext, ws: WorkspaceRef): Promise<void> {
  await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
}

async function adopt(ws: WorkspaceRef, nowMs: number): Promise<void> {
  for (const folder of ADOPT_DIRS) await ensureWorkspaceDir(ws, folder);
  await writeInstanceFile(ws, newInstanceFile(ws.slug, { nowMs }));
}

/** `opsMigrate.apply`: converts one workspace under its task mutex. */
export async function apply(
  ctx: OpContext,
  input: MigrateInput,
  deps: MigrateDeps = {},
): Promise<WorkspaceMigrationReport> {
  const ws = await openTask(ctx, input);
  return withTaskMutex(ws, async () => {
    const a = await analyse(ws, deps);
    if (verdictOf(a) !== 'needs-migration' || a.plan === null) return reportOf(a, 'applied', null);
    const nowMs = ctx.clock.now();
    const backup: MigrationBackup = await backupWorkspace(ws, nowMs);
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
