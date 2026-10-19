// `ops.cleanup` (`mcs cleanup`, 01 6.4, ADR 0009): the explicit removal of what a workspace no longer needs. Six scopes, every
// one a dry run until `--yes` (`data` also needs the task name again in `--confirm`):
//
//   stale-state     `state.json` of a monitor that is gone, `run/control.token` without a runtime, `*.tmp` and
//                   `data/exports/.tmp-*` older than 10 minutes
//   init-leftovers  staging folders of crashed inits in the tasks root
//   logs            rotated `logs/*.log.N` and `logs/diagnostics-*.json` older than `--older-than` (default 30 days)
//   backups         finished backups beyond `--keep`, oldest first, never the newest `upgrade` or `db-rebuild` one
//   spool           fully drained spool segments of a stopped instance
//   data            sessions (and old timeline rows) by the retention policy, on a stopped instance, after a `cleanup` backup
//
// Every candidate is a plain file or folder below the workspace (the tasks root for `init-leftovers`): its real path is checked
// to lie inside, and a link is never followed, deleted or counted, it is reported as skipped. Nothing here removes a whole
// workspace, and no scope reads a flag to decide whether the instance runs: the probe of 01 4.8 does. The deletion is checked by
// listing the targets again. An applied run is audited as `cleanup` (not `stale-state`, `init-leftovers` or an empty run).
import type { Stats } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  McsError,
  RUNTIME_VERSION,
  isoSecondsZ,
  type CleanupData,
  type CleanupResult,
  type CleanupScope,
  type CleanupSkipped,
  type CleanupTarget,
} from '@mcs/shared';

import { appendChange } from '../audit/writer.ts';
import { resolveConfig } from '../config/resolve.ts';
import { openInstanceDb, type InstanceDb, type OpenMode } from '../db/open.ts';
import { SpoolCursorsRepo } from '../db/repos/spool-cursors.ts';
import { withWriteTx } from '../db/write.ts';
import { listSegments, retentionExpired } from '../ingest/spool/segments.ts';
import { applyRetention, type RetentionPolicy, type RetentionResult } from '../maintenance/retention.ts';
import { canonicalPath } from '../platform/paths.ts';
import { readSmallFile } from '../platform/fsx.ts';
import { findStaging } from '../workspace/init.ts';
import { compareAndDelete, isMissingFileError } from '../workspace/fsio.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import {
  assertNotLive,
  dbFailure,
  humanBytes,
  listBackups,
  make,
  migrationsOf,
  probeOf,
  pruneAfter,
  pruneCandidates,
  removeBackup,
  removeFile,
  requireInstance,
  type BackupOpDeps,
  type ListedBackup,
} from './backup.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export interface CleanupInput {
  readonly scope: CleanupScope;
  /** Required by every scope except `init-leftovers`, which works on the tasks root. */
  readonly task?: string;
  /** `--older-than DAYS`: `logs` (default 30), `spool` (default: `spool.retainHours`) and `data` (default: the `retention` policy). */
  readonly olderThanDays?: number;
  /** `--keep N`: `backups` only (default `backup.keep`). */
  readonly keep?: number;
  readonly yes?: boolean;
  /** `--dry-run`: wins over `--yes`. */
  readonly dryRun?: boolean;
  /** `--confirm SLUG`: the typed task name that `data` needs together with `--yes`. */
  readonly confirm?: string;
}

export interface CleanupDeps extends BackupOpDeps {
  /** Runs before the named step of an applied run (the crash and ordering hook of the tests). */
  readonly beforeStep?: (step: 'backup' | 'delete' | 'audit') => void | Promise<void>;
}

// ---- constants ----------------------------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A stray `*.tmp` or export temp database younger than this may belong to a write in progress. */
const TMP_MIN_AGE_MS = 10 * MINUTE_MS;
const DEFAULT_LOG_DAYS = 30;
const LOG_ROTATED_RE = /^[A-Za-z0-9_.-]+\.log\.[0-9]+$/;
const DIAGNOSTICS_RE = /^diagnostics-[A-Za-z0-9_.-]+\.json$/;
const TMP_SUFFIX = '.tmp';
const EXPORT_TMP_PREFIX = '.tmp-';
const WALK_MAX_DEPTH = 6;
const MAX_DAYS = 36_500;
const MAX_KEEP = 1000;
const TOKEN_MAX_BYTES = 4096;
const BACKUPS_REL = 'data/backups';
const SPOOL_REL = 'data/spool';
const DB_REL = 'data/monitor.db';

// ---- candidates ---------------------------------------------------------------------------------------------------------------

/** Something a scope would delete. `abs` has been looked at with `lstat`; `rel` is what the result shows. */
interface Candidate {
  readonly rel: string;
  readonly abs: string;
  readonly bytes: number;
  readonly kind: 'file' | 'folder';
  /** Delete the file only while it still holds these bytes (a state file, a token). */
  readonly expect?: Uint8Array;
  /** A finished backup: removed through its manifest. */
  readonly backup?: ListedBackup;
}

interface Plan {
  readonly candidates: Candidate[];
  readonly skipped: CleanupSkipped[];
  readonly note: string | null;
}

type Entry = Stats;

async function lstatOrNull(target: string): Promise<Entry | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new McsError('WORKSPACE_INVALID', `cannot inspect ${path.basename(target)}`, { cause: error });
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Why `abs` may not be deleted, or `null` when it may: it is a link (a junction on Windows too), or its real path lies outside
 * `base`. A path that is gone is reported as such.
 */
async function refusal(base: string, abs: string): Promise<string | null> {
  const entry = await lstatOrNull(abs);
  if (entry === null) return 'is gone';
  if (entry.isSymbolicLink()) return 'is a link; links are never followed or deleted';
  if (!isInside(canonicalPath(base), canonicalPath(abs))) return 'resolves outside the workspace';
  return null;
}

/** The size of a folder tree, and whether it holds a link anywhere (links are not followed). */
async function treeOf(dir: string): Promise<{ bytes: number; hasLink: boolean }> {
  let bytes = 0;
  let hasLink = false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    for (const name of await readdir(current)) {
      const entry = await lstatOrNull(path.join(current, name));
      if (entry === null) continue;
      if (entry.isSymbolicLink()) hasLink = true;
      else if (entry.isDirectory()) stack.push(path.join(current, name));
      else bytes += entry.size;
    }
  }
  return { bytes, hasLink };
}

function relOf(parts: readonly string[]): string {
  return parts.join('/');
}

/** A regular file with a planned name: a candidate, or a skipped entry that says why not. */
async function fileCandidate(
  base: string,
  abs: string,
  rel: string,
  skipped: CleanupSkipped[],
): Promise<Candidate | null> {
  const entry = await lstatOrNull(abs);
  if (entry === null) return null;
  if (entry.isSymbolicLink()) {
    skipped.push({ path: rel, reason: 'is a link; links are never followed or deleted' });
    return null;
  }
  if (!entry.isFile()) {
    skipped.push({ path: rel, reason: 'is not a regular file' });
    return null;
  }
  const outside = await refusal(base, abs);
  if (outside !== null) {
    skipped.push({ path: rel, reason: outside });
    return null;
  }
  return { rel, abs, bytes: entry.size, kind: 'file' };
}

// ---- stale-state ----------------------------------------------------------------------------------------------------------

/** `*.tmp` files (and the temp databases of exports) older than ten minutes anywhere in the workspace but the backups. */
async function staleTemporaries(ws: WorkspaceRef, now: number, skipped: CleanupSkipped[]): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const stack: { dir: string; parts: string[] }[] = [{ dir: ws.dir, parts: [] }];
  while (stack.length > 0) {
    const { dir, parts } = stack.pop() ?? { dir: ws.dir, parts: [] };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw new McsError('WORKSPACE_INVALID', `cannot list ${relOf(parts) || 'the workspace'}`, { cause: error });
    }
    for (const name of names.sort()) {
      const rel = relOf([...parts, name]);
      if (rel === BACKUPS_REL) continue;
      const full = path.join(dir, name);
      const entry = await lstatOrNull(full);
      if (entry === null) continue;
      const exportTemp = relOf(parts) === 'data/exports' && name.startsWith(EXPORT_TMP_PREFIX);
      const wanted = name.endsWith(TMP_SUFFIX) || exportTemp;
      if (entry.isSymbolicLink()) {
        if (wanted) skipped.push({ path: rel, reason: 'is a link; links are never followed or deleted' });
        continue;
      }
      if (entry.isDirectory()) {
        if (parts.length < WALK_MAX_DEPTH) stack.push({ dir: full, parts: [...parts, name] });
        continue;
      }
      if (!wanted || !entry.isFile() || now - entry.mtimeMs <= TMP_MIN_AGE_MS) continue;
      const candidate = await fileCandidate(ws.dir, full, rel, skipped);
      if (candidate !== null) found.push(candidate);
    }
  }
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

async function planStaleState(ctx: OpContext, ws: WorkspaceRef, deps: CleanupDeps): Promise<Plan> {
  const probe = await probeOf(ctx, ws, deps);
  const candidates: Candidate[] = [];
  const skipped: CleanupSkipped[] = [];
  const ownerGone = probe.state === 'stopped' || probe.state === 'stale' || probe.state === 'foreign-pid';
  if (probe.stateFileBytes !== null) {
    if (probe.state === 'stale' || probe.state === 'foreign-pid') {
      candidates.push({
        rel: 'state.json',
        abs: workspacePath(ws, 'state.json'),
        bytes: probe.stateFileBytes.length,
        kind: 'file',
        expect: probe.stateFileBytes,
      });
    } else {
      skipped.push({ path: 'state.json', reason: `the monitor is ${probe.state}; its state file is kept` });
    }
  }
  const token = workspacePath(ws, 'run', 'control.token');
  const entry = await lstatOrNull(token);
  if (entry !== null) {
    const rel = 'run/control.token';
    if (!ownerGone) {
      skipped.push({ path: rel, reason: `the monitor is ${probe.state}; its token is kept` });
    } else {
      const found = await fileCandidate(ws.dir, token, rel, skipped);
      if (found !== null) {
        let bytes: Uint8Array;
        try {
          bytes = await readSmallFile(token, TOKEN_MAX_BYTES);
        } catch {
          skipped.push({ path: rel, reason: 'cannot be read' });
          bytes = new Uint8Array();
        }
        if (bytes.length > 0) candidates.push({ ...found, expect: bytes });
      }
    }
  }
  candidates.push(...(await staleTemporaries(ws, ctx.clock.now(), skipped)));
  return { candidates, skipped, note: null };
}

// ---- init-leftovers ----------------------------------------------------------------------------------------------------------

async function planInitLeftovers(ctx: OpContext): Promise<Plan> {
  const candidates: Candidate[] = [];
  const skipped: CleanupSkipped[] = [];
  for (const name of await findStaging(ctx.root, ctx.clock)) {
    const abs = path.join(ctx.root, name);
    const why = await refusal(ctx.root, abs);
    if (why !== null) {
      skipped.push({ path: name, reason: why });
      continue;
    }
    const tree = await treeOf(abs);
    if (tree.hasLink) {
      skipped.push({ path: name, reason: 'holds a link; the folder is left alone' });
      continue;
    }
    candidates.push({ rel: name, abs, bytes: tree.bytes, kind: 'folder' });
  }
  return { candidates, skipped, note: null };
}

// ---- logs ------------------------------------------------------------------------------------------------------------------------

async function planLogs(ctx: OpContext, ws: WorkspaceRef, olderThanDays: number | undefined): Promise<Plan> {
  const days = olderThanDays ?? DEFAULT_LOG_DAYS;
  const cutoff = ctx.clock.now() - days * DAY_MS;
  const dir = workspacePath(ws, 'logs');
  const candidates: Candidate[] = [];
  const skipped: CleanupSkipped[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissingFileError(error)) return { candidates, skipped, note: null };
    throw new McsError('WORKSPACE_INVALID', 'cannot list the logs folder', { cause: error });
  }
  for (const name of names.sort()) {
    if (!LOG_ROTATED_RE.test(name) && !DIAGNOSTICS_RE.test(name)) continue;
    const abs = path.join(dir, name);
    const entry = await lstatOrNull(abs);
    if (entry === null) continue;
    if (!entry.isSymbolicLink() && entry.isFile() && entry.mtimeMs >= cutoff) continue;
    const candidate = await fileCandidate(ws.dir, abs, relOf(['logs', name]), skipped);
    if (candidate !== null) candidates.push(candidate);
  }
  return { candidates, skipped, note: null };
}

// ---- backups -------------------------------------------------------------------------------------------------------------------

async function keepOf(ctx: OpContext, ws: WorkspaceRef, keep: number | undefined): Promise<number> {
  if (keep !== undefined) return keep;
  const resolved = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  return resolved.runtime.backup.keep;
}

async function planBackups(ctx: OpContext, ws: WorkspaceRef, keep: number | undefined): Promise<Plan> {
  const limit = await keepOf(ctx, ws, keep);
  const listed = await listBackups(ws);
  const doomed = await pruneCandidates(ws, limit);
  const doomedIds = new Set(doomed.map((b) => b.id));
  const candidates: Candidate[] = [];
  const skipped: CleanupSkipped[] = [];
  for (const backup of doomed) {
    const rel = relOf([BACKUPS_REL, backup.id]);
    const why = await refusal(ws.dir, backup.dir);
    if (why !== null) {
      skipped.push({ path: rel, reason: why });
      continue;
    }
    candidates.push({
      rel,
      abs: backup.dir,
      bytes: backup.manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      kind: 'folder',
      backup,
    });
  }
  const listedIds = new Set(listed.map((b) => b.id));
  for (const backup of listed.slice(limit)) {
    if (!doomedIds.has(backup.id)) {
      skipped.push({
        path: relOf([BACKUPS_REL, backup.id]),
        reason: `the newest ${backup.manifest.reason} backup is always kept`,
      });
    }
  }
  let names: string[] = [];
  try {
    names = await readdir(workspacePath(ws, 'data', 'backups'));
  } catch (error) {
    if (!isMissingFileError(error))
      throw new McsError('WORKSPACE_INVALID', 'cannot list data/backups', { cause: error });
  }
  for (const name of names.sort()) {
    if (!listedIds.has(name)) {
      skipped.push({
        path: relOf([BACKUPS_REL, name]),
        reason: 'not a finished backup with a valid manifest; left alone',
      });
    }
  }
  return { candidates, skipped, note: null };
}

// ---- the database scopes -------------------------------------------------------------------------------------------------------

function openDatabase(
  ctx: OpContext,
  ws: WorkspaceRef,
  instanceId: string,
  mode: OpenMode,
  deps: CleanupDeps,
): InstanceDb {
  try {
    return openInstanceDb({
      path: workspacePath(ws, 'data', 'monitor.db'),
      expectedInstanceId: instanceId,
      mode,
      runtimeVersion: RUNTIME_VERSION,
      clock: ctx.clock,
      ...migrationsOf(ctx, deps),
    });
  } catch (error) {
    throw dbFailure(error);
  }
}

async function hasDatabase(ws: WorkspaceRef): Promise<boolean> {
  const entry = await lstatOrNull(workspacePath(ws, 'data', 'monitor.db'));
  return entry !== null && !entry.isSymbolicLink() && entry.isFile();
}

/**
 * The spool segments that are fully drained (02 2.7): older than the cutoff, a cursor that is sealed, and every byte of the
 * file consumed up to a line start (or a torn tail that was counted and sealed). A segment the importer has not finished, has
 * not seen, or that grew after it was sealed, is reported and kept.
 */
async function planSpool(ctx: OpContext, ws: WorkspaceRef, db: InstanceDb, hours: number): Promise<Plan> {
  const scope = { instanceId: db.instanceId };
  const cursors = new Map(new SpoolCursorsRepo(db).list(scope).map((c) => [c.segment, c]));
  const dir = workspacePath(ws, 'data', 'spool');
  const listing = await listSegments(dir);
  const now = ctx.clock.now();
  const candidates: Candidate[] = [];
  const skipped: CleanupSkipped[] = [];
  for (const segment of listing.segments) {
    if (!retentionExpired(segment.name, now, hours)) continue;
    const rel = relOf([SPOOL_REL, segment.name]);
    const cursor = cursors.get(segment.name);
    if (cursor === undefined) {
      skipped.push({ path: rel, reason: 'the importer has no cursor for it; it may not have been read' });
    } else if (!cursor.sealed || cursor.offsetBytes + cursor.partialBytes !== segment.bytes) {
      skipped.push({ path: rel, reason: 'not read completely yet' });
    } else {
      const candidate = await fileCandidate(ws.dir, path.join(dir, segment.name), rel, skipped);
      if (candidate !== null) candidates.push(candidate);
    }
  }
  return { candidates, skipped, note: null };
}

function retentionData(plan: RetentionResult): CleanupData {
  return {
    sessions: plan.sessions,
    sessionsBefore: plan.sessionsCutoff === null ? null : isoSecondsZ(plan.sessionsCutoff),
    eventsBefore: plan.eventsCutoff === null ? null : isoSecondsZ(plan.eventsCutoff),
    rows: { ...plan.rows },
    reownedMessages: plan.reownedMessages,
    freedBytes: plan.freedBytes,
  };
}

/** The retention policy of a `data` run: `--older-than` is the session cutoff, else the `retention` keys of `runtime.json`. */
async function policyOf(ctx: OpContext, ws: WorkspaceRef, olderThanDays: number | undefined): Promise<RetentionPolicy> {
  if (olderThanDays !== undefined) return { sessionsOlderThanDays: olderThanDays, eventsOlderThanDays: null };
  const { retention } = (await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir })).runtime;
  return { sessionsOlderThanDays: retention.sessionsDays, eventsOlderThanDays: retention.eventsDays };
}

const NO_POLICY_NOTE =
  'no retention policy: pass --older-than DAYS, or set retention.sessionsDays or retention.eventsDays with mcs configure';

// ---- the run -------------------------------------------------------------------------------------------------------------------

function validateInput(input: CleanupInput): void {
  const usage = (message: string): McsError => new McsError('USAGE', message);
  if (input.scope === 'init-leftovers') {
    if (input.task !== undefined) throw usage('cleanup --scope init-leftovers works on the tasks root: drop --task');
  } else if (input.task === undefined) {
    throw usage(`cleanup --scope ${input.scope} needs --task SLUG`);
  }
  if (input.olderThanDays !== undefined) {
    if (!['logs', 'spool', 'data'].includes(input.scope)) {
      throw usage(`--older-than has no effect on --scope ${input.scope}`);
    }
    if (!Number.isInteger(input.olderThanDays) || input.olderThanDays < 1 || input.olderThanDays > MAX_DAYS) {
      throw usage(`--older-than must be a whole number of days from 1 to ${String(MAX_DAYS)}`);
    }
  }
  if (input.keep !== undefined) {
    if (input.scope !== 'backups') throw usage(`--keep has no effect on --scope ${input.scope}`);
    if (!Number.isInteger(input.keep) || input.keep < 0 || input.keep > MAX_KEEP) {
      throw usage(`--keep must be a whole number from 0 to ${String(MAX_KEEP)}`);
    }
  }
}

const mutexOptions = (deps: Pick<BackupOpDeps, 'mutexTimeoutMs'>): { timeoutMs?: number } =>
  deps.mutexTimeoutMs === undefined ? {} : { timeoutMs: deps.mutexTimeoutMs };

function targetsOf(candidates: readonly Candidate[]): CleanupTarget[] {
  return candidates.map((c) => ({ path: c.rel, bytes: c.bytes }));
}

function resultOf(
  task: string | null,
  scope: CleanupScope,
  applied: boolean,
  plan: Plan,
  extra: Partial<CleanupResult> = {},
): CleanupResult {
  const targets = extra.targets ?? targetsOf(plan.candidates);
  return {
    task,
    scope,
    applied,
    targets,
    skipped: plan.skipped,
    count: targets.length,
    bytes: targets.reduce((sum, t) => sum + t.bytes, 0),
    remaining: [],
    backup: null,
    data: null,
    pruned: [],
    note: plan.note,
    ...extra,
  };
}

/** Deletes one candidate after looking at it again; `false` when it changed or vanished since the plan. */
async function deleteCandidate(base: string, c: Candidate, skipped: CleanupSkipped[]): Promise<boolean> {
  const why = await refusal(base, c.abs);
  if (why !== null) {
    skipped.push({ path: c.rel, reason: why });
    return false;
  }
  if (c.backup !== undefined) {
    await removeBackup(c.backup);
    return true;
  }
  if (c.kind === 'folder') {
    await rm(c.abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  }
  if (c.expect !== undefined) {
    const outcome = await compareAndDelete(c.abs, c.expect);
    if (outcome === 'changed') skipped.push({ path: c.rel, reason: 'changed after the plan; kept' });
    return outcome === 'deleted';
  }
  await removeFile(c.abs);
  return true;
}

/** Deletes the planned candidates, then lists them again: the paths that are still there. */
async function deleteAll(
  base: string,
  plan: Plan,
  deps: CleanupDeps,
): Promise<{ deleted: Candidate[]; skipped: CleanupSkipped[]; remaining: string[] }> {
  await deps.beforeStep?.('delete');
  const deleted: Candidate[] = [];
  const skipped = [...plan.skipped];
  for (const c of plan.candidates) if (await deleteCandidate(base, c, skipped)) deleted.push(c);
  const remaining: string[] = [];
  for (const c of deleted) if ((await lstatOrNull(c.abs)) !== null) remaining.push(c.rel);
  return { deleted, skipped, remaining };
}

async function audit(
  ctx: OpContext,
  ws: WorkspaceRef,
  scope: CleanupScope,
  deleted: readonly Candidate[],
  folder: string,
  remaining: readonly string[],
  deps: CleanupDeps,
): Promise<void> {
  if (deleted.length === 0) return;
  await deps.beforeStep?.('audit');
  const bytes = deleted.reduce((sum, c) => sum + c.bytes, 0);
  await appendChange(
    ws,
    {
      action: 'cleanup',
      summary: `${scope}: deleted ${String(deleted.length)} files, ${String(bytes)} bytes`,
      reason: null,
      files: [`${String(deleted.length)} files under ${folder}`],
      validation: 'targets re-listed',
      outcome: remaining.length === 0 ? 'applied' : `applied; ${String(remaining.length)} still present`,
    },
    ctx.clock.now(),
  );
}

async function runInitLeftovers(ctx: OpContext, apply: boolean, deps: CleanupDeps): Promise<CleanupResult> {
  const plan = await planInitLeftovers(ctx);
  if (!apply) return resultOf(null, 'init-leftovers', false, plan);
  const done = await deleteAll(ctx.root, plan, deps);
  return resultOf(
    null,
    'init-leftovers',
    true,
    { ...plan, skipped: done.skipped },
    { targets: targetsOf(done.deleted), remaining: done.remaining },
  );
}

async function runFileScope(
  ctx: OpContext,
  ws: WorkspaceRef,
  input: CleanupInput,
  apply: boolean,
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const { scope } = input;
  const plan =
    scope === 'stale-state'
      ? await planStaleState(ctx, ws, deps)
      : scope === 'logs'
        ? await planLogs(ctx, ws, input.olderThanDays)
        : await planBackups(ctx, ws, input.keep);
  if (!apply) return resultOf(ws.slug, scope, false, plan);
  const done = await deleteAll(ws.dir, plan, deps);
  if (scope !== 'stale-state') {
    await audit(ctx, ws, scope, done.deleted, scope === 'logs' ? 'logs' : BACKUPS_REL, done.remaining, deps);
  }
  return resultOf(
    ws.slug,
    scope,
    true,
    { ...plan, skipped: done.skipped },
    { targets: targetsOf(done.deleted), remaining: done.remaining },
  );
}

async function runSpool(
  ctx: OpContext,
  ws: WorkspaceRef,
  input: CleanupInput,
  apply: boolean,
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const instance = await requireInstance(ws);
  await assertNotLive(ctx, ws, deps);
  const empty: Plan = {
    candidates: [],
    skipped: [],
    note: 'no database: no spool segment can be shown to have been read, so none is listed',
  };
  if (!(await hasDatabase(ws))) return resultOf(ws.slug, 'spool', false, empty);
  const hours =
    input.olderThanDays === undefined
      ? (await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir })).runtime.spool
          .retainHours
      : input.olderThanDays * 24;
  const db = openDatabase(ctx, ws, instance.instanceId, apply ? 'maintenance' : 'readonly', deps);
  try {
    const plan = await planSpool(ctx, ws, db, hours);
    if (!apply) return resultOf(ws.slug, 'spool', false, plan);
    const done = await deleteAll(ws.dir, plan, deps);
    const repo = new SpoolCursorsRepo(db);
    const scope = { instanceId: db.instanceId };
    // a cursor of a file that is gone would only be read again by `ingest replay`; the drainer forgets it the same way
    withWriteTx(db, scope, (tx) => {
      for (const c of done.deleted) repo.delete(scope, tx, path.basename(c.rel));
    });
    await audit(ctx, ws, 'spool', done.deleted, SPOOL_REL, done.remaining, deps);
    return resultOf(
      ws.slug,
      'spool',
      true,
      { ...plan, skipped: done.skipped },
      { targets: targetsOf(done.deleted), remaining: done.remaining },
    );
  } finally {
    db.close();
  }
}

async function runData(
  ctx: OpContext,
  ws: WorkspaceRef,
  input: CleanupInput,
  apply: boolean,
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const instance = await requireInstance(ws);
  await assertNotLive(ctx, ws, deps);
  const none = (note: string): CleanupResult => resultOf(ws.slug, 'data', false, { candidates: [], skipped: [], note });
  if (!(await hasDatabase(ws))) return none('no database: there is nothing to delete');
  const policy = await policyOf(ctx, ws, input.olderThanDays);
  if (policy.sessionsOlderThanDays === null && policy.eventsOlderThanDays === null) return none(NO_POLICY_NOTE);
  const now = ctx.clock.now();
  const planning = openDatabase(ctx, ws, instance.instanceId, 'readonly', deps);
  let plan: RetentionResult;
  try {
    plan = await applyRetention(planning, { instanceId: planning.instanceId }, policy, { dryRun: true, now });
  } finally {
    planning.close();
  }
  const planned = retentionData(plan);
  const emptyPlan: Plan = { candidates: [], skipped: [], note: null };
  const nothing = plan.sessions === 0 && plan.rows.events === 0;
  if (!apply || nothing) {
    return resultOf(
      ws.slug,
      'data',
      false,
      { ...emptyPlan, note: nothing ? 'nothing is older than the cutoff' : null },
      {
        count: plan.sessions,
        data: planned,
      },
    );
  }
  // the backup comes first: nothing is deleted before it is whole and verified (01 5.5)
  await deps.beforeStep?.('backup');
  const made = await make(ctx, ws, instance, { reason: 'cleanup' }, deps);
  await deps.beforeStep?.('delete');
  const db = openDatabase(ctx, ws, instance.instanceId, 'maintenance', deps);
  let applied: RetentionResult;
  try {
    applied = await applyRetention(db, { instanceId: db.instanceId }, policy, { dryRun: false, now });
  } finally {
    db.close();
  }
  await deps.beforeStep?.('audit');
  const eventRows = applied.rows.events;
  await appendChange(
    ws,
    {
      action: 'cleanup',
      summary: `data: deleted ${String(applied.sessions)} sessions, ${String(eventRows)} event rows`,
      reason: null,
      files: [DB_REL],
      validation: 'targets re-listed',
      outcome: `applied; backup ${made.id}`,
    },
    ctx.clock.now(),
  );
  const pruned = await pruneAfter(ctx, ws, [made.id]);
  return resultOf(ws.slug, 'data', true, emptyPlan, {
    count: applied.sessions,
    bytes: applied.freedBytes ?? 0,
    backup: made.id,
    data: retentionData(applied),
    pruned,
  });
}

/**
 * `ops.cleanup.run` (`mcs cleanup`, 01 6.4). Plans the scope, and with `yes` (and not `dryRun`) deletes what the plan lists.
 * An instance scope holds the task mutex from the plan to the audit entry. `data` needs `confirm` equal to the task name, a
 * stopped instance and makes a `cleanup` backup before the first row goes; `spool` needs a stopped instance too.
 */
export async function run(ctx: OpContext, input: CleanupInput, deps: CleanupDeps = {}): Promise<CleanupResult> {
  validateInput(input);
  const apply = input.yes === true && input.dryRun !== true;
  if (input.scope === 'init-leftovers') return runInitLeftovers(ctx, apply, deps);
  const ws = await openWorkspace(ctx, input.task ?? '');
  if (apply && input.scope === 'data' && input.confirm !== ws.slug) {
    throw new McsError(
      'CONFIRMATION_REQUIRED',
      `cleanup --scope data deletes sessions: type the task name with --confirm ${ws.slug}; nothing was changed`,
      { hint: `mcs cleanup --task ${ws.slug} --scope data --yes --confirm ${ws.slug}` },
    );
  }
  return withTaskMutex(
    ws,
    () => {
      if (input.scope === 'spool') return runSpool(ctx, ws, input, apply, deps);
      if (input.scope === 'data') return runData(ctx, ws, input, apply, deps);
      return runFileScope(ctx, ws, input, apply, deps);
    },
    mutexOptions(deps),
  );
}

// ---- text ----------------------------------------------------------------------------------------------------------------------

const LISTED = 20;

function listing(items: readonly string[]): string[] {
  const shown = items.slice(0, LISTED).map((line) => `    ${line}`);
  return items.length > LISTED ? [...shown, `    ... and ${String(items.length - LISTED)} more`] : shown;
}

function dataLines(result: CleanupResult, data: CleanupData): string[] {
  const rows = Object.entries(data.rows)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${String(n)}`);
  const head = result.applied ? 'deleted' : 'would delete';
  return [
    `  ${head} ${String(data.sessions)} sessions${data.sessionsBefore === null ? '' : ` with the last activity before ${data.sessionsBefore}`}`,
    ...(data.eventsBefore === null
      ? []
      : [`  ${head} timeline rows before ${data.eventsBefore} of the sessions that stay`]),
    ...(rows.length === 0 ? [] : [`  rows that go with them: ${rows.join(', ')}`]),
    ...(data.reownedMessages > 0
      ? [`  usage of ${String(data.reownedMessages)} messages moves to another session's transcript`]
      : []),
    '  active and pinned sessions are never deleted; attempt runs are kept (detached from their session)',
    ...(data.freedBytes === null ? [] : [`  database space given back: ${humanBytes(data.freedBytes)}`]),
  ];
}

function skippedLines(result: CleanupResult): string[] {
  return result.skipped.length === 0
    ? []
    : ['  left alone:', ...listing(result.skipped.map((s) => `${s.path} (${s.reason})`))];
}

/** The text of `cleanup`. */
export function lines(result: CleanupResult): string[] {
  const where = result.task === null ? 'the tasks root' : `task '${result.task}'`;
  const out: string[] = [];
  if (!result.applied) {
    out.push(`cleanup --scope ${result.scope} on ${where} (dry run, nothing deleted)`);
    if (result.data !== null) out.push(...dataLines(result, result.data));
    else if (result.targets.length === 0) out.push('  nothing to delete');
    else {
      out.push(`  would delete ${String(result.count)} items, ${humanBytes(result.bytes)}:`);
      out.push(...listing(result.targets.map((t) => `${t.path} (${humanBytes(t.bytes)})`)));
    }
    out.push(...skippedLines(result));
    if (result.note !== null) out.push(`  ${result.note}`);
    const needs = result.scope === 'data' ? `--yes --confirm ${result.task ?? ''}` : '--yes';
    if (
      result.targets.length > 0 ||
      (result.data !== null && result.data.sessions + (result.data.rows['events'] ?? 0) > 0)
    ) {
      out.push(`run again with ${needs} to apply`);
    }
    return out;
  }
  out.push(`cleanup --scope ${result.scope} on ${where}`);
  if (result.data !== null) {
    out.push(...dataLines(result, result.data));
    if (result.backup !== null) out.push(`  backup made first: data/backups/${result.backup}/`);
  } else if (result.targets.length === 0) {
    out.push('  nothing was deleted');
  } else {
    out.push(`  deleted ${String(result.count)} items, ${humanBytes(result.bytes)}:`);
    out.push(...listing(result.targets.map((t) => t.path)));
  }
  out.push(...skippedLines(result));
  if (result.pruned.length > 0)
    out.push(`  removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`);
  out.push(
    result.remaining.length === 0
      ? '  checked: none of the targets is still there'
      : `  NOT confirmed: still present after the deletion: ${result.remaining.join(', ')}`,
  );
  return out;
}
