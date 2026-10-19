// `hooks install` and `hooks uninstall` as the engine runs them (02 3.5; ADR 0014, ADR 0070). The order of one run:
//
//   guard (a test never touches a real path)  ->  bundle check  ->  settings mutex  ->  read and plan  ->  backup  ->  stable copy
//   of the script  ->  temporary file, verified  ->  nobody changed the file meanwhile  ->  rename (retried on Windows)  ->
//   post-check, with a restore  ->  manifest.
//
// Without `yes` it is a dry run: it reads the settings file, the bundle and the manifest and writes nothing anywhere. Every
// failure is a `HOOKS_FAILED` `McsError` with a `details.reason` (`HooksFailureReason`); the settings file is either replaced
// whole and verified or left as it was. The caller writes the audit entry from `HooksOutcome.audit` (the ops layer, WP-38).
//
// Which environment decides test mode is the one in the input (`MCS_TEST`, `VITEST`), never `process.env`: the ops layer passes
// the environment of the command.
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import type { HooksApplyResult, HooksScope, HooksScriptResult, HooksWarning } from '@mcs/shared';
import { HANDLER_VERSION, normalizePath, type EnvLike } from '@mcs/shared/protocol';

import type { ChangeEntry } from '../../audit/writer.ts';
import {
  MutexTimeoutError,
  acquireMutex,
  mutexName,
  type AcquireOptions,
  type ProcessMutex,
} from '../../platform/mutex.ts';
import {
  findInstall,
  hasInstall,
  manifestMutexName,
  readManifest,
  removeManifest,
  removesLastInstall,
  withInstall,
  withoutInstall,
  writeManifest,
  type HookInstallRecord,
} from './manifest.ts';
import {
  BOM,
  desiredEntries,
  hooksFailed,
  ourHandlers,
  planHooks,
  sameHandler,
  type HookCommandEntry,
  type HooksOp,
  type HooksPlan,
} from './plan.ts';
import {
  inspectHookScript,
  installHookScript,
  planHookScript,
  removeHookScript,
  stableScriptPath,
  type HookScriptInput,
} from './script-copy.ts';
import {
  assertNotRealInTest,
  assertScopeAllowed,
  decodeSettings,
  displayPath,
  encodeSettings,
  realSettingsIo,
  renameWithRetry,
  tempPathFor,
  writeBackup,
  type SettingsIo,
  type SettingsSnapshot,
} from './settings-io.ts';

/** How long a command waits for another one that is changing the same settings file. */
export const LOCK_TIMEOUT_MS = 10_000;
/** A settings file that keeps changing under us is given up after this many passes. */
export const MAX_ATTEMPTS = 3;

/** What a test replaces: the file system calls, the mutex, the clocks and the folders the guard compares with. */
export interface HooksSeams {
  readonly io: SettingsIo;
  readonly acquire: (name: string, options: AcquireOptions) => Promise<ProcessMutex>;
  /** Epoch ms. */
  readonly now: () => number;
  readonly tmpdir: () => string;
  readonly homedir: () => string;
}

function seamsOf(over: Partial<HooksSeams> | undefined): HooksSeams {
  return {
    io: realSettingsIo,
    acquire: acquireMutex,
    now: () => Date.now(),
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
    ...over,
  };
}

export interface HooksChangeInput {
  readonly scope: HooksScope;
  /** Absolute path of the settings file: `settingsPathFor(scope, ...)` or `--settings-file`. */
  readonly settingsPath: string;
  /** `resolveMcsHome(env)`: where the manifest, the backups and the stable copy live. */
  readonly mcsHome: string;
  /** The environment of the command; `MCS_TEST` and `VITEST` in it turn the test guard on. */
  readonly env: EnvLike;
  /** `--yes`. Without it nothing is written. */
  readonly yes: boolean;
  /** `git check-ignore` of a project-local file: `false` adds the `HOOKS_SETTINGS_NOT_IGNORED` warning. */
  readonly gitIgnored?: boolean | null;
  readonly seams?: Partial<HooksSeams>;
}

export interface ApplyHooksInput extends HooksChangeInput {
  /** The bundled handler (`layoutOfRuntimeDir(dir).hookEntry`), copied to the stable path. */
  readonly source: string;
  /** `process.execPath` of the installing CLI. */
  readonly nodePath: string;
  /** `--sync-tool-events`. */
  readonly syncToolEvents?: boolean;
}

export type UninstallHooksInput = HooksChangeInput;

export interface HooksOutcome {
  readonly result: HooksApplyResult;
  /** The audit entry for the task's `changes.md`; `null` unless the settings file was changed. */
  readonly audit: ChangeEntry | null;
}

export interface InstallParams {
  readonly source: string;
  readonly nodePath: string;
  readonly syncToolEvents: boolean;
}

/** The warnings of a change that would be or was made (02 3.1). */
export function hooksWarnings(scope: HooksScope, gitIgnored: boolean | null | undefined): HooksWarning[] {
  const warnings: HooksWarning[] = [];
  if (scope === 'project-local' && gitIgnored === false) {
    warnings.push({
      code: 'HOOKS_SETTINGS_NOT_IGNORED',
      message: 'the settings file is not ignored by git: do not commit hook configuration',
    });
  }
  if (scope === 'user') {
    warnings.push({
      code: 'HOOKS_USER_SCOPE',
      message: 'user scope: the hooks apply to every Claude Code session of this user on this machine',
    });
  }
  warnings.push({
    code: 'HOOKS_LIVE_RELOAD',
    message: 'running Claude Code sessions pick up a change of their hook settings without a restart',
  });
  return warnings;
}

/** Installs our hook entries for every installed event (`added`, `replaced`, `kept` in the result). */
export function applyHooks(input: ApplyHooksInput): Promise<HooksOutcome> {
  return runHooksChange('install', input, {
    source: input.source,
    nodePath: input.nodePath,
    syncToolEvents: input.syncToolEvents === true,
  });
}

interface Ctx {
  readonly op: HooksOp;
  readonly input: HooksChangeInput;
  readonly seams: HooksSeams;
  readonly settingsPath: string;
  readonly mcsHome: string;
  readonly desired: ReadonlyMap<string, HookCommandEntry>;
  readonly install: InstallParams | null;
}

function absolute(file: string, what: string): string {
  if (!path.isAbsolute(file)) {
    throw new McsError('USAGE', `the ${what} must be an absolute path`, { details: { value: file.slice(0, 200) } });
  }
  return path.resolve(file);
}

/** The core of `applyHooks` and `uninstallHooks`; `install` is `null` for an uninstall. */
export async function runHooksChange(
  op: HooksOp,
  input: HooksChangeInput,
  install: InstallParams | null,
): Promise<HooksOutcome> {
  const seams = seamsOf(input.seams);
  const settingsPath = absolute(input.settingsPath, 'settings file');
  const mcsHome = absolute(input.mcsHome, 'MCS_HOME');
  // First, before anything is opened or written: a test must never reach a real settings file or a real MCS_HOME.
  assertNotRealInTest({
    env: input.env,
    tmpdir: seams.tmpdir,
    targets: [
      { label: 'settings file', path: settingsPath },
      { label: 'MCS_HOME', path: mcsHome },
    ],
  });
  assertScopeAllowed(input.scope, settingsPath, input.env);
  const desired: ReadonlyMap<string, HookCommandEntry> =
    install === null
      ? new Map()
      : desiredEntries({
          nodePath: install.nodePath,
          hookEntryPath: stableScriptPath(mcsHome),
          syncToolEvents: install.syncToolEvents,
        });
  const ctx: Ctx = { op, input, seams, settingsPath, mcsHome, desired, install };
  // The bundle is checked before the settings file is read, in a dry run and in a real run: a checkout without a bundle fails
  // the same way every time, and nothing (no backup, no lock) has happened by then.
  const script = install === null ? null : await planHookScript(scriptInputOf(ctx, install));
  return input.yes ? withLocks(ctx, () => applyChange(ctx)) : dryRun(ctx, script);
}

// ---- locks ------------------------------------------------------------------------------------------------------------------

async function lock(ctx: Ctx, name: string): Promise<ProcessMutex> {
  try {
    return await ctx.seams.acquire(name, { timeoutMs: LOCK_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof MutexTimeoutError) {
      throw hooksFailed('LOCKED', 'another mcs command is changing the same settings file; try again in a moment', {
        details: { settingsPath: normalizePath(ctx.settingsPath) },
        cause: error,
      });
    }
    throw error;
  }
}

/** The settings file first, then the manifest with the stable copy: the same order everywhere, so two runs cannot deadlock. */
async function withLocks<T>(ctx: Ctx, body: () => Promise<T>): Promise<T> {
  const settingsLock = await lock(ctx, mutexName('settings', ctx.settingsPath));
  try {
    const homeLock = await lock(ctx, manifestMutexName(ctx.mcsHome));
    try {
      return await body();
    } finally {
      await homeLock.release();
    }
  } finally {
    await settingsLock.release();
  }
}

// ---- reading and the result ----------------------------------------------------------------------------------------------------

async function readAndPlan(ctx: Ctx): Promise<{ snap: SettingsSnapshot; plan: HooksPlan }> {
  const snap = await ctx.seams.io.read(ctx.settingsPath);
  const text = snap.bytes === null ? null : decodeSettings(snap.bytes);
  return { snap, plan: planHooks(text, ctx.op, ctx.desired) };
}

function scriptInputOf(ctx: Ctx, install: InstallParams): HookScriptInput {
  return { source: install.source, mcsHome: ctx.mcsHome, env: ctx.input.env, tmpdir: ctx.seams.tmpdir };
}

function resultOf(
  ctx: Ctx,
  plan: HooksPlan,
  action: 'plan' | 'applied' | 'noop',
  backup: string | null,
  script: HooksScriptResult,
): HooksApplyResult {
  return {
    scope: ctx.input.scope,
    settingsPath: normalizePath(ctx.settingsPath),
    action,
    added: plan.added,
    replaced: plan.replaced,
    removed: plan.removed,
    kept: plan.kept,
    warnings: plan.changed ? hooksWarnings(ctx.input.scope, ctx.input.gitIgnored) : [],
    backupPath: backup === null ? null : normalizePath(backup),
    diff: plan.diff,
    script,
  };
}

/** The audit entry of 01 7.2 for a change that was made. */
function auditOf(ctx: Ctx, plan: HooksPlan, backup: string | null): ChangeEntry {
  const where = displayPath(ctx.settingsPath, ctx.seams.homedir());
  const counts = `${String(plan.added.length)} added, ${String(plan.replaced.length)} replaced, ${String(plan.removed.length)} removed`;
  return {
    action: ctx.op === 'install' ? 'hooks-install' : 'hooks-uninstall',
    summary: `${ctx.input.scope} settings ${where}: ${counts}`,
    reason: null,
    files: [],
    validation: 'settings re-read and verified',
    outcome: backup === null ? 'applied' : `applied; settings backup ${normalizePath(backup)}`,
  };
}

// ---- dry run -----------------------------------------------------------------------------------------------------------------

async function dryRun(ctx: Ctx, installPlan: HooksScriptResult | null): Promise<HooksOutcome> {
  const script = installPlan ?? (await uninstallScriptPlan(ctx));
  const { plan } = await readAndPlan(ctx);
  return { result: resultOf(ctx, plan, plan.changed ? 'plan' : 'noop', null, script), audit: null };
}

/** What an uninstall would do with the stable copy (ADR 0070 item 4). */
async function uninstallScriptPlan(ctx: Ctx): Promise<HooksScriptResult> {
  const copy = await inspectHookScript(ctx.mcsHome);
  const where = stableScriptPath(ctx.mcsHome);
  if (copy.kind === 'missing') return { action: 'absent', path: where, sha256: null };
  const { manifest } = await readManifest(ctx.mcsHome);
  if (removesLastInstall(manifest, ctx.settingsPath)) return { action: 'removed', path: where, sha256: null };
  return { action: 'kept', path: where, sha256: copy.kind === 'file' ? copy.sha256 : null };
}

// ---- apply ---------------------------------------------------------------------------------------------------------------------

/** Why a settings text is not what the plan says it should be, or `null` when it is. */
function problemWith(bytes: Buffer | null, plan: HooksPlan, ctx: Ctx): string | null {
  if (bytes === null) return 'the file is gone';
  if (!bytes.equals(encodeSettings(plan.text))) return 'the bytes differ from the plan';
  let parsed: unknown;
  try {
    const text = decodeSettings(bytes);
    parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return 'the file does not parse';
  }
  if (!isDeepStrictEqual(parsed, plan.obj)) return 'the content differs from the plan';
  const ours = ourHandlers(parsed);
  if (ctx.op === 'uninstall') return ours.size === 0 ? null : 'a handler of ours is still there';
  for (const [event, entry] of ctx.desired) {
    const list = ours.get(event);
    if (list?.length !== 1 || !sameHandler(list[0], entry)) return `the entry for ${event} is not as planned`;
  }
  for (const event of ours.keys()) if (!ctx.desired.has(event)) return `an entry for ${event} should not be there`;
  return null;
}

/** Writes the planned text next to the target, verifies it and renames it over the target; `retry` when the file changed. */
async function swapIn(ctx: Ctx, snap: SettingsSnapshot, plan: HooksPlan): Promise<'done' | 'retry'> {
  const { io } = ctx.seams;
  const target = snap.target;
  const tmp = tempPathFor(target);
  const bytes = encodeSettings(plan.text);
  try {
    try {
      await io.ensureDir(path.dirname(target));
      await io.writeTemp(tmp, bytes, snap.mode ?? 0o600);
    } catch (cause) {
      throw hooksFailed(
        'WRITE_FAILED',
        'could not write the new settings next to the settings file; nothing was changed',
        {
          details: { settingsPath: normalizePath(ctx.settingsPath) },
          cause,
        },
      );
    }
    const problem = problemWith(await io.readBack(tmp), plan, ctx);
    if (problem !== null) {
      throw hooksFailed(
        'WRITE_VALIDATION_FAILED',
        `the new settings did not verify (${problem}); the original is untouched`,
        {
          details: { settingsPath: normalizePath(ctx.settingsPath) },
        },
      );
    }
    // Optimistic concurrency: somebody else may have written the file since we read it.
    const now = await io.read(ctx.settingsPath);
    if (now.sha256 !== snap.sha256 || now.target !== snap.target) return 'retry';
    await renameWithRetry(io, tmp, target);
    return 'done';
  } finally {
    await io.remove(tmp);
  }
}

/** Puts the original back after a failed post-check; `true` when it worked. */
async function restore(ctx: Ctx, snap: SettingsSnapshot): Promise<boolean> {
  const { io } = ctx.seams;
  try {
    if (snap.bytes === null) {
      await io.remove(snap.target);
      return true;
    }
    const tmp = tempPathFor(snap.target);
    try {
      await io.writeTemp(tmp, snap.bytes, snap.mode ?? 0o600);
      await renameWithRetry(io, tmp, snap.target);
    } finally {
      await io.remove(tmp);
    }
    return true;
  } catch {
    return false;
  }
}

async function applyChange(ctx: Ctx): Promise<HooksOutcome> {
  const { io } = ctx.seams;
  let script: HooksScriptResult | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const { snap, plan } = await readAndPlan(ctx);
    if (!plan.changed) return unchanged(ctx, plan);

    if (snap.bytes !== null) await io.checkWritable(snap.target);
    const backup =
      snap.bytes === null
        ? null
        : await writeBackup({
            mcsHome: ctx.mcsHome,
            settingsPath: ctx.settingsPath,
            op: ctx.op,
            bytes: snap.bytes,
            nowMs: ctx.seams.now(),
          });
    if (ctx.install !== null) script ??= await installHookScript(scriptInputOf(ctx, ctx.install));

    if ((await swapIn(ctx, snap, plan)) === 'retry') {
      if (attempt >= MAX_ATTEMPTS) {
        throw hooksFailed(
          'SETTINGS_CHANGED_CONCURRENTLY',
          'the settings file keeps changing while it is being updated; nothing was changed',
          {
            details: { settingsPath: normalizePath(ctx.settingsPath), attempts: attempt },
            hint: 'run the command again',
          },
        );
      }
      continue;
    }

    const problem = problemWith(await io.readBack(snap.target), plan, ctx);
    if (problem !== null) {
      const restored = await restore(ctx, snap);
      throw hooksFailed(
        'POST_CHECK_FAILED',
        `the settings file did not verify after the replace (${problem}); ${restored ? 'the original was put back' : 'the original could NOT be put back: see the backup'}`,
        {
          details: {
            settingsPath: normalizePath(ctx.settingsPath),
            restored,
            backup: backup === null ? null : normalizePath(backup),
          },
        },
      );
    }
    const finished = await finishHome(ctx, plan, script, backup);
    return { result: resultOf(ctx, plan, 'applied', backup, finished), audit: auditOf(ctx, plan, backup) };
  }
}

/** The settings file needs no change; the stable copy and the manifest are still brought in line (ADR 0070 item 3). */
async function unchanged(ctx: Ctx, plan: HooksPlan): Promise<HooksOutcome> {
  const script = ctx.install === null ? null : await installHookScript(scriptInputOf(ctx, ctx.install));
  const finished = await finishHome(ctx, plan, script, null);
  return { result: resultOf(ctx, plan, 'noop', null, finished), audit: null };
}

// ---- the manifest and the stable copy --------------------------------------------------------------------------------------------

/** The error for a failure after the settings file was dealt with; an error that already has a reason stays as it is. */
function homeFailure(plan: HooksPlan, cause: unknown): McsError {
  if (cause instanceof McsError) return cause;
  return hooksFailed(
    'MANIFEST_FAILED',
    'the settings file is in order, but the install manifest or the stable copy of the script could not be updated; run the same command again to repair it',
    { details: { settingsChanged: plan.changed }, cause },
  );
}

function sameInstall(a: HookInstallRecord, b: HookInstallRecord): boolean {
  return (
    a.settingsPath === b.settingsPath &&
    a.scope === b.scope &&
    a.events === b.events &&
    a.handlerVersion === b.handlerVersion &&
    a.nodePath === b.nodePath &&
    a.hookEntryPath === b.hookEntryPath &&
    a.async === b.async
  );
}

async function finishHome(
  ctx: Ctx,
  plan: HooksPlan,
  installed: HooksScriptResult | null,
  backup: string | null,
): Promise<HooksScriptResult> {
  const settingsKey = ctx.settingsPath;
  if (ctx.install !== null) {
    if (installed === null) throw new Error('an install always has a script result');
    const record: HookInstallRecord = {
      settingsPath: normalizePath(settingsKey),
      scope: ctx.input.scope,
      op: 'install',
      at: ctx.seams.now(),
      events: ctx.desired.size,
      handlerVersion: HANDLER_VERSION,
      nodePath: normalizePath(ctx.install.nodePath),
      hookEntryPath: stableScriptPath(ctx.mcsHome),
      async: !ctx.install.syncToolEvents,
      backup: backup === null ? null : normalizePath(backup),
    };
    try {
      const { manifest } = await readManifest(ctx.mcsHome);
      const known = findInstall(manifest, settingsKey);
      if (!plan.changed && known !== undefined && sameInstall(known, record)) return installed;
      const next = plan.changed || known === undefined ? record : { ...record, at: known.at, backup: known.backup };
      await writeManifest(ctx.mcsHome, withInstall(manifest, next));
    } catch (error) {
      throw homeFailure(plan, error);
    }
    return installed;
  }

  // uninstall
  const where = stableScriptPath(ctx.mcsHome);
  try {
    const { manifest: before } = await readManifest(ctx.mcsHome);
    const copy = await inspectHookScript(ctx.mcsHome);
    if (removesLastInstall(before, settingsKey)) {
      const gone = await removeHookScript({ mcsHome: ctx.mcsHome, env: ctx.input.env, tmpdir: ctx.seams.tmpdir });
      await removeManifest(ctx.mcsHome);
      return { action: gone, path: where, sha256: null };
    }
    if (hasInstall(before, settingsKey)) await writeManifest(ctx.mcsHome, withoutInstall(before, settingsKey));
    if (copy.kind === 'missing') return { action: 'absent', path: where, sha256: null };
    return { action: 'kept', path: where, sha256: copy.kind === 'file' ? copy.sha256 : null };
  } catch (error) {
    throw homeFailure(plan, error);
  }
}
