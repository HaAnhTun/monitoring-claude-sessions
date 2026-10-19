// Engine operations behind `mcs hooks ...` (01 6.3, 6.4; 02 3.1; ADR 0014, ADR 0070): `install`, `uninstall`, `verify`, `status`
// and `setEnabled`, plus the two small readers the `discover` line and the `doctor` check of the hooks area use. The installer
// itself (plan, apply, verify, status) lives in `hooks/installer/`; this module chooses the settings file, runs the test guard
// before anything else, calls the installer and writes the audit entry of the task. It prints nothing: the CLI renders.
//
// Nothing here installs hooks on its own. `install` and `uninstall` are dry runs unless `yes` is true. `setEnabled` writes
// `instance.json` and the route file and never a settings file.
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  HOOKS_SCOPES,
  McsError,
  type DoctorCheck,
  type HooksApplyResult,
  type HooksScope,
  type HooksStatusResult,
  type HooksVerifyResult,
  type InstanceFile,
} from '@mcs/shared';
import { INSTALLED_HOOK_EVENTS, SID_RE, resolveMcsHome, sanitizeProjectName } from '@mcs/shared/protocol';

import { appendChange, type ChangeEntry } from '../audit/writer.ts';
import { resolveConfig } from '../config/resolve.ts';
import { applyHooks, runHooksChange, type HooksSeams } from '../hooks/installer/apply.ts';
import { hooksFailed } from '../hooks/installer/plan.ts';
import {
  assertNotRealInTest,
  assertScopeAllowed,
  settingsPathFor,
  type GuardTarget,
} from '../hooks/installer/settings-io.ts';
import { hooksStatus, type HooksScanTarget, type StatusSeams } from '../hooks/installer/status.ts';
import { verifyHooks, type VerifySeams } from '../hooks/installer/verify.ts';
import { readRouteFile, writeRouteFile, type RouteState } from '../ingest/routes-file.ts';
import { claudeHomeOf, detectTranscriptsDir } from '../ingest/transcripts/discovery.ts';
import { layoutOfRuntimeDir } from '../platform/layout.ts';
import { withTaskMutex, type WorkspaceRef } from '../workspace/paths.ts';
import { writeInstanceFile } from '../workspace/adopt.ts';
import { requireInstance } from './backup.ts';
import { nodeDoctorSeams } from './doctor-checks.ts';
import { isLiveState, isRunningState, probeInstance, type ProbeOptions, type ProbeResult } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

const HOUR_MS = 3_600_000;

/** What a test replaces; the defaults are the real installer seams, the real probe and `git`. */
export interface HooksOpDeps {
  /** The file system, mutex, clock and temporary folder of the installer (`apply.ts`). */
  readonly seams?: Partial<HooksSeams>;
  readonly verifySeams?: Partial<VerifySeams>;
  readonly statusSeams?: Partial<StatusSeams>;
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  /** `git check-ignore` of a project-local settings file: `true`, `false` or `null` (unknown). */
  readonly gitIgnored?: (settingsPath: string, repo: string) => Promise<boolean | null>;
  /** `process.execPath` of the installing CLI. */
  readonly nodePath?: string;
}

// ---- which file ----------------------------------------------------------------------------------------------------------------

/** The selectors every hooks command shares. */
export interface HooksTargetInput {
  /** `project-local` (the default) or `user`; `project` and anything else is refused (`SCOPE_NOT_ALLOWED`). */
  readonly scope?: string;
  /** `--settings-file`: an absolute path to use instead of a scope (the scope of the result is then `file`). */
  readonly settingsFile?: string;
  /** The task whose audit trail records the change. */
  readonly task?: string;
}

export interface HooksInstallInput extends HooksTargetInput {
  readonly yes?: boolean;
  readonly syncToolEvents?: boolean;
}

export interface HooksUninstallInput extends HooksTargetInput {
  readonly yes?: boolean;
}

export interface HooksVerifyInput extends HooksTargetInput {
  /** `hooks verify` checks the route and the probe of one instance. */
  readonly task: string;
}

export interface HooksStatusInput {
  readonly task?: string;
}

interface Target {
  readonly scope: HooksScope;
  readonly settingsPath: string;
}

/** The settings file of the selectors: an explicit file, or the file of a scope. Nothing is opened. */
export function targetOf(ctx: Pick<OpContext, 'repo' | 'env'>, input: HooksTargetInput): Target {
  if (input.settingsFile !== undefined) {
    if (input.scope !== undefined) {
      throw new McsError('USAGE', '--scope and --settings-file exclude each other', {
        hint: 'pass --scope project-local|user, or --settings-file FILE',
      });
    }
    return { scope: 'file', settingsPath: input.settingsFile };
  }
  const scope = input.scope ?? 'project-local';
  const settingsPath = settingsPathFor(scope, { repoRoot: ctx.repo, env: ctx.env });
  return { scope: scope === 'user' ? 'user' : 'project-local', settingsPath };
}

/** The guard of ADR 0070 item 6, first of all: in test mode neither the settings file nor `MCS_HOME` may be outside the temporary folder. */
function guard(env: OpContext['env'], targets: readonly GuardTarget[], deps: HooksOpDeps): void {
  const tmpdir = deps.seams?.tmpdir ?? deps.statusSeams?.tmpdir ?? deps.verifySeams?.tmpdir;
  assertNotRealInTest({ env, targets, ...(tmpdir === undefined ? {} : { tmpdir }) });
}

function guardedTarget(ctx: OpContext, input: HooksTargetInput, deps: HooksOpDeps): Target & { mcsHome: string } {
  const target = targetOf(ctx, input);
  const mcsHome = resolveMcsHome(ctx.env);
  if (path.isAbsolute(target.settingsPath)) {
    guard(
      ctx.env,
      [
        { label: 'settings file', path: path.resolve(target.settingsPath) },
        { label: 'MCS_HOME', path: mcsHome },
      ],
      deps,
    );
    assertScopeAllowed(target.scope, path.resolve(target.settingsPath), ctx.env);
  }
  return { ...target, mcsHome };
}

// ---- install and uninstall -----------------------------------------------------------------------------------------------------

async function gitIgnoredOf(ctx: OpContext, target: Target, deps: HooksOpDeps): Promise<boolean | null> {
  if (target.scope !== 'project-local') return null;
  try {
    if (deps.gitIgnored !== undefined) return await deps.gitIgnored(target.settingsPath, ctx.repo);
    const result = await nodeDoctorSeams.run('git', ['check-ignore', '-q', target.settingsPath], ctx.repo);
    if (result === null) return null;
    if (result.code === 0) return true;
    return result.code === 1 ? false : null;
  } catch {
    return null;
  }
}

/** The audit entry of the task, when the call named one and the settings file changed. A lost entry is logged, never a failure. */
async function auditOf(ctx: OpContext, ws: WorkspaceRef | null, entry: ChangeEntry | null): Promise<void> {
  if (ws === null || entry === null) return;
  try {
    await appendChange(ws, entry, ctx.clock.now());
  } catch (error) {
    const code = error instanceof McsError ? error.code : 'ERROR';
    ctx.log.warn('hooks_audit_failed', { code });
  }
}

/**
 * `ops.hooks.install` (02 3.1, 3.5): plans the merge of our entries into one settings file and, with `yes`, applies it. The
 * default scope is `project-local`; the user scope only when it is asked for. A dry run writes nothing anywhere.
 */
export async function install(
  ctx: OpContext,
  input: HooksInstallInput,
  deps: HooksOpDeps = {},
): Promise<HooksApplyResult> {
  const target = guardedTarget(ctx, input, deps);
  const ws = input.task === undefined ? null : await openWorkspace(ctx, input.task);
  const layout = layoutOfRuntimeDir(ctx.runtimeDir);
  const outcome = await applyHooks({
    scope: target.scope,
    settingsPath: target.settingsPath,
    mcsHome: target.mcsHome,
    env: ctx.env,
    yes: input.yes === true,
    gitIgnored: await gitIgnoredOf(ctx, target, deps),
    source: layout.hookEntry,
    nodePath: deps.nodePath ?? process.execPath,
    syncToolEvents: input.syncToolEvents === true,
    ...(deps.seams === undefined ? {} : { seams: deps.seams }),
  });
  await auditOf(ctx, ws, outcome.audit);
  return outcome.result;
}

/** `ops.hooks.uninstall`: removes every handler of ours from one settings file; a dry run unless `yes`. */
export async function uninstall(
  ctx: OpContext,
  input: HooksUninstallInput,
  deps: HooksOpDeps = {},
): Promise<HooksApplyResult> {
  const target = guardedTarget(ctx, input, deps);
  const ws = input.task === undefined ? null : await openWorkspace(ctx, input.task);
  const outcome = await runHooksChange(
    'uninstall',
    {
      scope: target.scope,
      settingsPath: target.settingsPath,
      mcsHome: target.mcsHome,
      env: ctx.env,
      yes: input.yes === true,
      ...(deps.seams === undefined ? {} : { seams: deps.seams }),
    },
    null,
  );
  await auditOf(ctx, ws, outcome.audit);
  return outcome.result;
}

// ---- the instance of a task ------------------------------------------------------------------------------------------------------

/** The transcripts folder of the configuration, or the one found for the repository, or `null`. */
async function resolvedTranscriptsDir(
  ctx: OpContext,
  monitor: { readonly repo: string; readonly transcripts_dir: string | null },
): Promise<string | null> {
  const configured = monitor.transcripts_dir;
  if (configured !== null && configured !== '' && configured !== 'auto') return path.resolve(configured);
  return detectTranscriptsDir(monitor.repo, path.join(claudeHomeOf(ctx.env), 'projects'));
}

function probeOf(ws: WorkspaceRef, deps: HooksOpDeps): Promise<ProbeResult> {
  return (deps.probe ?? probeInstance)(ws);
}

/**
 * `ops.hooks.verify` (02 3.7): the seven checks for one instance and one settings file. It never writes a settings file; the
 * probe runs exactly the installed `Notification` command with a synthetic payload.
 */
export async function verify(
  ctx: OpContext,
  input: HooksVerifyInput,
  deps: HooksOpDeps = {},
): Promise<HooksVerifyResult> {
  const target = guardedTarget(ctx, input, deps);
  const ws = await openWorkspace(ctx, input.task);
  const instance = await requireInstance(ws);
  const config = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  const found = await resolvedTranscriptsDir(ctx, config.monitor);
  // while no folder exists the route lists the predicted one (02 2.6.2)
  const transcriptsDir =
    found ?? path.join(claudeHomeOf(ctx.env), 'projects', sanitizeProjectName(config.monitor.repo));
  const probe = await probeOf(ws, deps);
  return verifyHooks({
    settingsPath: path.resolve(target.settingsPath),
    mcsHome: target.mcsHome,
    env: ctx.env,
    instance: { instanceId: instance.instanceId, transcriptsDir, repoDir: config.monitor.repo },
    source: layoutOfRuntimeDir(ctx.runtimeDir).hookEntry,
    serverBase: isRunningState(probe.state) ? probe.url : null,
    ...(deps.verifySeams === undefined ? {} : { seams: deps.verifySeams }),
  });
}

// ---- status ---------------------------------------------------------------------------------------------------------------------

/** The known scopes of this repository and user. In test mode a path outside the temporary folder is left out, never opened. */
function scanTargets(ctx: OpContext, deps: HooksOpDeps): HooksScanTarget[] {
  const candidates: HooksScanTarget[] = [
    { scope: 'project-local', settingsPath: settingsPathFor('project-local', { repoRoot: ctx.repo, env: ctx.env }) },
    { scope: 'user', settingsPath: settingsPathFor('user', { env: ctx.env }) },
  ];
  return candidates.filter((candidate) => {
    try {
      guard(ctx.env, [{ label: 'settings file', path: candidate.settingsPath }], deps);
      return true;
    } catch {
      return false;
    }
  });
}

async function statusOf(ctx: OpContext, task: string | undefined, deps: HooksOpDeps): Promise<HooksStatusResult> {
  let instanceIds: string[] | undefined;
  if (task !== undefined) {
    const ws = await openWorkspace(ctx, task);
    instanceIds = [(await requireInstance(ws)).instanceId];
  }
  return hooksStatus({
    mcsHome: resolveMcsHome(ctx.env),
    env: ctx.env,
    scan: scanTargets(ctx, deps),
    source: layoutOfRuntimeDir(ctx.runtimeDir).hookEntry,
    ...(instanceIds === undefined ? {} : { instanceIds }),
    ...(deps.statusSeams === undefined ? {} : { seams: deps.statusSeams }),
  });
}

/** `ops.hooks.status` (02 3.1): installed settings files, the stable copy, the handler log and the last envelope per instance. */
export function status(
  ctx: OpContext,
  input: HooksStatusInput = {},
  deps: HooksOpDeps = {},
): Promise<HooksStatusResult> {
  return statusOf(ctx, input.task, deps);
}

/** The scopes with an install, in the order project-local, user, file, each once. */
function scopesOf(result: HooksStatusResult): string[] {
  const present = new Set(result.installs.map((install) => install.scope));
  return HOOKS_SCOPES.filter((scope) => present.has(scope));
}

/**
 * The line `discover` prints after `hooks:` (CR-WP-14-2): `null` when nothing is installed, else `installed (<scopes>)`, with
 * `, script stale` or `, script missing` when the stable copy is not the bundled one. A status that cannot be read is `null`:
 * `discover` never fails for a missing piece.
 */
export async function summary(ctx: OpContext, deps: HooksOpDeps = {}): Promise<string | null> {
  const result = await statusOf(ctx, undefined, deps);
  if (result.installs.length === 0) return null;
  const head = `installed (${scopesOf(result).join(', ')})`;
  if (result.script.state === 'stale') return `${head}, script stale`;
  if (result.script.state === 'missing') return `${head}, script missing`;
  return head;
}

/**
 * The `hooks` line of `mcs doctor` (the key `hooks` of `DoctorDeps.extraChecks`). Hooks are opt-in, so "not installed" is fine;
 * a stale or missing copy, an incomplete install, or an install that is not enabled for the selected task is a warning with the
 * command that repairs it. It reads only: the probe of `hooks verify` is a separate command.
 */
export async function doctorCheck(
  ctx: OpContext,
  ws: WorkspaceRef | null,
  deps: HooksOpDeps = {},
): Promise<DoctorCheck> {
  const id = 'hooks';
  const result = await statusOf(ctx, undefined, deps);
  if (result.installs.length === 0) {
    return { id, ok: true, level: 'warn', detail: 'not installed (optional: live hook events are opt-in)' };
  }
  const scopes = scopesOf(result).join(', ');
  const all = INSTALLED_HOOK_EVENTS.length;
  const incomplete = result.installs.find((install) => install.events < all);
  if (incomplete !== undefined) {
    return {
      id,
      ok: false,
      level: 'warn',
      detail: `installed (${scopes}), but ${incomplete.scope} has ${String(incomplete.events)} of ${String(all)} events`,
      fix: 'mcs hooks install --yes (review the dry run first)',
    };
  }
  if (result.script.state === 'stale' || result.script.state === 'missing') {
    return {
      id,
      ok: false,
      level: 'warn',
      detail: `installed (${scopes}), script ${result.script.state}`,
      fix: 'mcs hooks install --yes refreshes the copy of the hook script (review the dry run first)',
    };
  }
  if (ws !== null) {
    const instance = await requireInstance(ws).catch(() => null);
    if (instance !== null && !instance.hooks.enabled) {
      return {
        id,
        ok: false,
        level: 'warn',
        detail: `installed (${scopes}), but hooks are not enabled for task ${ws.slug}`,
        fix: `mcs hooks enable --task ${ws.slug}`,
      };
    }
  }
  return { id, ok: true, level: 'warn', detail: `installed (${scopes}), script ${result.script.state}` };
}

// ---- enable and disable ------------------------------------------------------------------------------------------------------------

export interface HooksToggleInput {
  readonly task: string;
  readonly enabled: boolean;
}

export interface HooksToggleResult {
  readonly task: string;
  /** `instance.json` `hooks.enabled` after the call. */
  readonly enabled: boolean;
  /** The value before the call. */
  readonly previous: boolean;
  /** False when the instance already had this value (the route file is still rewritten). */
  readonly changed: boolean;
  /** `<MCS_HOME>/routes/<instanceId>.json`, forward slashes. */
  readonly routeFile: string;
  /** True when a monitor of this task is running: it keeps the old value in memory until it restarts. */
  readonly running: boolean;
}

/** The route file of the instance from its configuration as it is now, with the lifecycle part kept (02 2.6.2). */
async function rewriteRoute(
  ctx: OpContext,
  ws: WorkspaceRef,
  instance: InstanceFile,
  mcsHome: string,
  live: boolean,
): Promise<string> {
  const config = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  const projects = path.join(claudeHomeOf(ctx.env), 'projects');
  const transcriptsDir = await resolvedTranscriptsDir(ctx, config.monitor);
  const existing = readRouteFile(mcsHome, instance.instanceId);
  const now = ctx.clock.now();
  let state: RouteState;
  if (existing !== null) {
    state = { stoppedAt: existing.stoppedAt, spoolUntil: existing.spoolUntil };
  } else if (live) {
    state = { stoppedAt: null };
  } else {
    // a stopped instance keeps receiving envelopes for hooks.spoolWhileStoppedHours (0: not any more)
    const hours = config.runtime.hooks.spoolWhileStoppedHours;
    state = { stoppedAt: now, spoolUntil: hours > 0 ? now + hours * HOUR_MS : null };
  }
  // the server names the workspace by its real path (registry C07); the route must name it the same way
  const instanceDir = await realpath(ws.dir).catch(() => ws.dir);
  try {
    await writeRouteFile(
      {
        instanceId: instance.instanceId,
        instanceDir,
        mcsHome,
        repoDir: config.monitor.repo,
        hooksEnabled: instance.hooks.enabled,
        sessionIds: config.monitor.session_ids.filter((id) => SID_RE.test(id)),
        transcriptsDir,
        projectsRoot: projects,
      },
      state,
      { now },
    );
  } catch (cause) {
    throw hooksFailed(
      'WRITE_FAILED',
      'instance.json was updated, but the route file could not be written; run the same command again',
      { details: { task: ws.slug }, cause },
    );
  }
  return `${mcsHome.split(path.sep).join('/')}/routes/${instance.instanceId}.json`;
}

/**
 * `ops.hooks.setEnabled` (`hooks enable` / `hooks disable`, 01 6.4): flips `instance.json` `hooks.enabled`, rewrites the route
 * file and audits `hooks-enable` or `hooks-disable`, all under the task mutex. It never touches a settings file. A call that
 * changes nothing writes no audit entry; the route file is rewritten anyway, which repairs a missing one.
 */
export async function setEnabled(
  ctx: OpContext,
  input: HooksToggleInput,
  deps: HooksOpDeps = {},
): Promise<HooksToggleResult> {
  const mcsHome = resolveMcsHome(ctx.env);
  // the route file lives in MCS_HOME: in test mode that folder must be a temporary one
  guard(ctx.env, [{ label: 'MCS_HOME', path: mcsHome }], deps);
  const ws = await openWorkspace(ctx, input.task);
  return withTaskMutex(ws, async () => {
    const instance = await requireInstance(ws);
    const previous = instance.hooks.enabled;
    const changed = previous !== input.enabled;
    const next: InstanceFile = changed ? { ...instance, hooks: { enabled: input.enabled } } : instance;
    if (changed) await writeInstanceFile(ws, next);
    const probe = await probeOf(ws, deps);
    const live = isLiveState(probe.state);
    const routeFile = await rewriteRoute(ctx, ws, next, mcsHome, live);
    if (changed) {
      await appendChange(
        ws,
        {
          action: input.enabled ? 'hooks-enable' : 'hooks-disable',
          summary: `hooks.enabled: ${String(previous)} -> ${String(input.enabled)}`,
          reason: null,
          files: ['instance.json'],
          validation: 'schema ok',
          outcome: 'applied',
        },
        ctx.clock.now(),
      );
    }
    return { task: ws.slug, enabled: input.enabled, previous, changed, routeFile, running: live };
  });
}
