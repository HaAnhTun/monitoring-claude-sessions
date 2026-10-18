// Identity repair of a copied or renamed workspace (01 3.4). A workspace folder that was copied still carries the
// `instanceId` and `slug` of the original; the copy must never open the original's database. The repair gives the copy a
// new identity and moves the data it cannot own aside. It is explicit (`mcs instances repair`): a dry run is `planRepair`,
// `applyRepair` writes. The route files of the hook handler (02 2.6.2) belong to the operations layer, which calls this.
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError, isoSecondsZ, systemClock, type Clock, type InstanceFile } from '@mcs/shared';

import { appendChange } from '../audit/writer.ts';
import { listRuntimeProcesses, type RuntimeProcess } from '../platform/markers.ts';
import { unlinkWithRetry } from '../platform/fsx.ts';
import { isMissingFileError } from './fsio.ts';
import { readInstanceFile, writeInstanceFile } from './adopt.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from './paths.ts';

/** Answers whether a runtime of any of these instance ids is alive (the repair refuses while one is). */
export type RunningCheck = (instanceIds: readonly string[]) => Promise<boolean>;

type Lister = (runtimeDir: string | null) => Promise<readonly RuntimeProcess[]>;

export interface RepairOptions {
  readonly clock?: Clock;
  /** Test seam: the new instance id. */
  readonly newId?: () => string;
  /**
   * The running check; the default lists the runtime processes of every runtime folder (`listRuntimeProcesses(null)`) and
   * matches by instance id, so a runtime started from another folder of the install (a previous plugin version) is found.
   */
  readonly isRunning?: RunningCheck;
  /** Test seam of the default check: the process listing. */
  readonly listRuntimeProcesses?: Lister;
}

export interface RepairPlan {
  readonly slug: string;
  /** The slug `instance.json` carries (the original's, for a copy). */
  readonly oldSlug: string;
  readonly oldInstanceId: string;
  readonly newInstanceId: string;
  /** True when `instance.json` names another slug than the folder (the situation the repair is for). */
  readonly mismatch: boolean;
  /** `data/` exists and is moved to `orphanedDir`. */
  readonly moveData: boolean;
  /** `data/backups/orphaned-<UTC yyyymmddThhmmssZ>`, relative to the workspace; `null` without data. */
  readonly orphanedDir: string | null;
  readonly removeState: boolean;
  /** `run/` holds files (the control token of the original). */
  readonly removeRun: boolean;
}

export interface RepairResult {
  readonly plan: RepairPlan;
  /** The new `instance.json`. */
  readonly instance: InstanceFile;
}

const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_BUDGET_MS = 2000;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function compactStamp(ms: number): string {
  return isoSecondsZ(ms).replaceAll('-', '').replaceAll(':', '');
}

async function entryOf(file: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new McsError('WORKSPACE_INVALID', `cannot inspect ${path.basename(file)}`, { cause: error });
  }
}

async function runHasFiles(ws: WorkspaceRef): Promise<boolean> {
  try {
    return (await readdir(workspacePath(ws, 'run'))).length > 0;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new McsError('WORKSPACE_INVALID', 'cannot list run/', { cause: error });
  }
}

async function loadInstance(ws: WorkspaceRef): Promise<InstanceFile> {
  const instance = await readInstanceFile(ws, { allowSlugMismatch: true });
  if (instance === null) {
    throw new McsError('INSTANCE_NOT_INITIALIZED', `${ws.dir} has no instance.json; there is no identity to repair`, {
      hint: `mcs init --task ${ws.slug}`,
    });
  }
  return instance;
}

/** What `applyRepair` would do, without writing anything (the dry run of `mcs instances repair`). */
export async function planRepair(ws: WorkspaceRef, o: RepairOptions = {}): Promise<RepairPlan> {
  const instance = await loadInstance(ws);
  const nowMs = (o.clock ?? systemClock).now();
  const data = await entryOf(workspacePath(ws, 'data'));
  const moveData = data?.isDirectory() === true;
  return {
    slug: ws.slug,
    oldSlug: instance.slug,
    oldInstanceId: instance.instanceId,
    newInstanceId: o.newId?.() ?? randomUUID(),
    mismatch: instance.slug !== ws.slug,
    moveData,
    orphanedDir: moveData ? `data/backups/orphaned-${compactStamp(nowMs)}` : null,
    removeState: (await entryOf(workspacePath(ws, 'state.json'))) !== null,
    removeRun: await runHasFiles(ws),
  };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RETRY_CODES.has(code) || performance.now() - started >= RENAME_BUDGET_MS) {
        throw new McsError('WORKSPACE_INVALID', `cannot move ${path.basename(from)}: ${code ?? 'error'}`, {
          cause: error,
        });
      }
      await sleepMs(Math.min(50 * 2 ** Math.min(attempt, 10), 250));
    }
  }
}

/**
 * `data/` cannot be renamed into its own subfolder: it is parked beside the workspace files, `data/` and `data/backups/` are
 * created again, and the parked folder is moved to its final name. A failure after the parking puts it back.
 */
async function moveDataAside(ws: WorkspaceRef, orphanedDir: string): Promise<void> {
  const data = workspacePath(ws, 'data');
  const target = workspacePath(ws, ...orphanedDir.split('/'));
  if ((await entryOf(target)) !== null) {
    throw new McsError('WORKSPACE_INVALID', `${orphanedDir} already exists; repair again in a second`);
  }
  const parked = workspacePath(ws, `data.orphaning-${randomBytes(4).toString('hex')}`);
  await renameWithRetry(data, parked);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await renameWithRetry(parked, target);
  } catch (error) {
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
    await renameWithRetry(parked, data).catch(() => undefined);
    throw error;
  }
}

async function clearRun(ws: WorkspaceRef): Promise<void> {
  const run = workspacePath(ws, 'run');
  let names: string[];
  try {
    names = await readdir(run);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new McsError('WORKSPACE_INVALID', 'cannot list run/', { cause: error });
  }
  for (const name of names)
    await rm(path.join(run, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function defaultIsRunning(list: Lister): RunningCheck {
  return async (ids) => {
    const alive = await list(null);
    return alive.some((p) => p.instanceId !== null && ids.includes(p.instanceId));
  };
}

/**
 * Applies a plan (01 3.4) under the task mutex: refuses while a runtime of either identity is alive (`INSTANCE_RUNNING`) or
 * when `instance.json` is no longer the one the plan was made for (`IDENTITY_MISMATCH`); moves `data/` to
 * `data/backups/orphaned-<UTC>/`; removes `state.json` and the contents of `run/`; writes the new `instance.json`
 * atomically (new `instanceId`, `slug` = the folder name, `dbSchemaVersion` 0, everything else kept); audits
 * `instances-repair`. The data is moved first and the identity written last, so an interrupted repair can be run again.
 */
export function applyRepair(ws: WorkspaceRef, plan: RepairPlan, o: RepairOptions = {}): Promise<RepairResult> {
  const clock = o.clock ?? systemClock;
  return withTaskMutex(ws, async () => {
    const instance = await loadInstance(ws);
    if (instance.instanceId !== plan.oldInstanceId) {
      throw new McsError(
        'IDENTITY_MISMATCH',
        `instance.json of '${ws.slug}' changed after the plan was made (it was ${plan.oldInstanceId.slice(0, 8)}, it is ${instance.instanceId.slice(0, 8)}); plan again`,
      );
    }
    const running = o.isRunning ?? defaultIsRunning(o.listRuntimeProcesses ?? listRuntimeProcesses);
    if (await running([plan.oldInstanceId, plan.newInstanceId])) {
      throw new McsError(
        'INSTANCE_RUNNING',
        `a runtime of instance ${plan.oldInstanceId.slice(0, 8)} is running; stop it first`,
        {
          hint: `mcs stop --task ${ws.slug}`,
        },
      );
    }
    if (plan.moveData && plan.orphanedDir !== null) await moveDataAside(ws, plan.orphanedDir);
    if (plan.removeState) await unlinkWithRetry(workspacePath(ws, 'state.json'));
    if (plan.removeRun) await clearRun(ws);
    const repaired: InstanceFile = {
      ...instance,
      instanceId: plan.newInstanceId,
      slug: ws.slug,
      dbSchemaVersion: 0,
    };
    await writeInstanceFile(ws, repaired);
    await appendChange(
      ws,
      {
        action: 'instances-repair',
        summary:
          `new instance ${plan.newInstanceId.slice(0, 8)} (was ${plan.oldInstanceId.slice(0, 8)}); ` +
          (plan.orphanedDir === null ? 'no data to move' : `data moved to ${plan.orphanedDir}/`),
        reason: null,
        files: plan.orphanedDir === null ? ['instance.json'] : ['instance.json', 'data/'],
        validation: 'schema ok',
        outcome: 'repaired',
      },
      clock.now(),
    );
    return { plan, instance: repaired };
  });
}
