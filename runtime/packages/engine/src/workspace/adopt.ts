// `instance.json`, the Node identity of a workspace (01 1.5, 3.2), and the adoption of a workspace the legacy engine made
// (01 4.12 step 4, ADR 0001): a legacy workspace gains `instance.json`, `data/`, `logs/` and `audit/`; no legacy file is
// rewritten and no `runtime.json` appears.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import {
  InstanceFileSchema,
  McsError,
  RUNTIME_VERSION,
  isoSecondsZ,
  systemClock,
  type Clock,
  type InstanceFile,
} from '@mcs/shared';

import { appendChange, type ChangeEntry } from '../audit/writer.ts';
import type { PyObject } from '../config/defaults.ts';
import { fromPlain, pyRepr, pyShort, toPlain, type PyJsonValue } from '../pyjson/index.ts';
import { assertNotLink, isMissingFileError, readJsonFile, writePyJsonFile } from './fsio.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from './paths.ts';

export type EngineName = InstanceFile['engine'];

export interface NewInstanceOptions {
  readonly nowMs: number;
  /** Default: a fresh `crypto.randomUUID()`. */
  readonly instanceId?: string;
  /** Default `RUNTIME_VERSION`. */
  readonly runtimeVersion?: string;
}

/** The instance file of a new instance, with the creation defaults of 01 1.5. */
export function newInstanceFile(slug: string, o: NewInstanceOptions): InstanceFile {
  const runtimeVersion = o.runtimeVersion ?? RUNTIME_VERSION;
  return {
    schema_version: 1,
    instanceId: o.instanceId ?? randomUUID(),
    slug,
    createdAt: isoSecondsZ(o.nowMs),
    createdBy: `mcs ${runtimeVersion}`,
    runtimeVersion,
    dbSchemaVersion: 0,
    engine: 'node',
    hooks: { enabled: false },
    upgradedAt: null,
  };
}

/** The value written to disk: keys in the order of `InstanceFileSchema` whatever order the object came in. */
export function instanceFileToPy(file: InstanceFile): PyJsonValue {
  const parsed = InstanceFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new McsError('WORKSPACE_INVALID', `instance.json would be invalid: ${describeIssues(parsed.error.issues)}`);
  }
  const f = parsed.data;
  return fromPlain({
    schema_version: f.schema_version,
    instanceId: f.instanceId,
    slug: f.slug,
    createdAt: f.createdAt,
    createdBy: f.createdBy,
    runtimeVersion: f.runtimeVersion,
    dbSchemaVersion: f.dbSchemaVersion,
    engine: f.engine,
    hooks: { enabled: f.hooks.enabled },
    upgradedAt: f.upgradedAt,
  });
}

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** Replaces `instance.json` atomically (PyJson, indent 2). */
export function writeInstanceFile(ws: Pick<WorkspaceRef, 'dir'>, file: InstanceFile): Promise<void> {
  return writePyJsonFile(workspacePath(ws, 'instance.json'), instanceFileToPy(file));
}

export interface ReadInstanceOptions {
  /** Return the file of a copied workspace instead of failing (the repair reads it this way). */
  readonly allowSlugMismatch?: boolean;
}

/**
 * `instance.json` of a workspace, or `null` when it has none (a legacy-only workspace). A file that cannot be read or breaks
 * the schema is `WORKSPACE_INVALID`; one that belongs to another slug is `IDENTITY_MISMATCH` with the repair hint (01 3.2).
 */
export async function readInstanceFile(
  ws: Pick<WorkspaceRef, 'dir' | 'slug'>,
  o: ReadInstanceOptions = {},
): Promise<InstanceFile | null> {
  const file = workspacePath(ws, 'instance.json');
  let value: PyJsonValue;
  try {
    value = (await readJsonFile(file)).value;
  } catch (error) {
    if (error instanceof McsError && error.code === 'CONFIG_UNREADABLE') {
      if (isMissingFileError(error.cause)) return null;
      throw new McsError('WORKSPACE_INVALID', error.message, { cause: error });
    }
    throw error;
  }
  let plain: unknown;
  try {
    plain = toPlain(value);
  } catch (error) {
    throw new McsError('WORKSPACE_INVALID', `instance.json is invalid: an integer is beyond 2^53-1 in magnitude`, {
      cause: error,
    });
  }
  const parsed = InstanceFileSchema.safeParse(plain);
  if (!parsed.success) {
    throw new McsError('WORKSPACE_INVALID', `instance.json is invalid: ${describeIssues(parsed.error.issues)}`);
  }
  if (o.allowSlugMismatch !== true && parsed.data.slug !== ws.slug) {
    const repair = `mcs instances repair --task ${ws.slug}`;
    throw new McsError(
      'IDENTITY_MISMATCH',
      `instance.json belongs to '${parsed.data.slug}' but sits in '${ws.slug}' (copied workspace?); run \`${repair}\``,
      { hint: repair },
    );
  }
  return parsed.data;
}

function shownId(value: PyJsonValue | undefined): string {
  if (value === undefined || value.k === 'null') return 'None';
  return value.k === 'str' ? pyRepr(value.v) : pyShort(value);
}

/**
 * `task.json` of the workspace, checked as 01 1.3 says: it must exist (`TASK_NOT_FOUND`, hint `mcs init --slug <slug>`),
 * hold an object (`WORKSPACE_INVALID`) and name the folder as its `id` (`IDENTITY_MISMATCH`, the legacy wording). Nothing
 * else of it is validated here (legacy parity: only `audit` checks `schema_version`).
 */
export async function readTaskFile(ws: Pick<WorkspaceRef, 'dir' | 'slug'>): Promise<PyObject> {
  const file = workspacePath(ws, 'task.json');
  let value: PyJsonValue;
  try {
    value = (await readJsonFile(file)).value;
  } catch (error) {
    if (error instanceof McsError && error.code === 'CONFIG_UNREADABLE') {
      if (isMissingFileError(error.cause)) {
        throw new McsError('TASK_NOT_FOUND', `no task.json in ${ws.dir}`, { hint: `mcs init --slug ${ws.slug}` });
      }
      throw new McsError('WORKSPACE_INVALID', error.message, { cause: error });
    }
    throw error;
  }
  if (value.k !== 'obj') throw new McsError('WORKSPACE_INVALID', `${file} must contain a JSON object`);
  const id = value.v.find(([key]) => key === 'id')?.[1];
  if (id?.k !== 'str' || id.v !== ws.slug) {
    throw new McsError('IDENTITY_MISMATCH', `task.json id ${shownId(id)} does not match folder ${pyRepr(ws.slug)}`);
  }
  return value;
}

/** Creates a folder of the workspace tree unless it exists; a link there is refused. */
export async function ensureWorkspaceDir(ws: Pick<WorkspaceRef, 'dir'>, ...segments: string[]): Promise<void> {
  const folder = workspacePath(ws, ...segments);
  assertNotLink(folder);
  await mkdir(folder, { recursive: true });
}

export interface AdoptOptions {
  readonly clock?: Clock;
  /** Test seam: the instance id. */
  readonly newId?: () => string;
}

export interface AdoptResult {
  readonly adopted: boolean;
  readonly instance: InstanceFile;
}

/** The entry `adopt-instance` of 01 7.2. */
function adoptEntry(ws: Pick<WorkspaceRef, 'slug'>, instance: InstanceFile): ChangeEntry {
  return {
    action: 'adopt-instance',
    summary: `added Node runtime files to workspace '${ws.slug}' (instance ${instance.instanceId.slice(0, 8)})`,
    reason: null,
    files: ['instance.json'],
    validation: 'schema ok',
    outcome: 'adopted',
  };
}

/**
 * Makes a legacy-created workspace a Node instance (01 4.12 step 4): when `instance.json` is missing it is created
 * atomically together with `audit/`, `data/` and `logs/`, and one `adopt-instance` entry is audited. A workspace that has
 * `instance.json` is returned as it is, so the call is idempotent and safe from two processes. The legacy files are never
 * written. `TASK_NOT_FOUND` / `IDENTITY_MISMATCH` when `task.json` is missing or names another folder.
 */
export function adoptWorkspace(ws: WorkspaceRef, o: AdoptOptions = {}): Promise<AdoptResult> {
  return withTaskMutex(ws, async () => {
    await readTaskFile(ws);
    const existing = await readInstanceFile(ws);
    if (existing !== null) return { adopted: false, instance: existing };
    const nowMs = (o.clock ?? systemClock).now();
    const instance = newInstanceFile(ws.slug, {
      nowMs,
      ...(o.newId === undefined ? {} : { instanceId: o.newId() }),
    });
    for (const folder of ['audit', 'data', 'logs']) await ensureWorkspaceDir(ws, folder);
    await writeInstanceFile(ws, instance);
    await appendChange(ws, adoptEntry(ws, instance), nowMs);
    return { adopted: true, instance };
  });
}
