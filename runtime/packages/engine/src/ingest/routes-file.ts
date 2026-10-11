// The route file writer (02 2.6.2, ADR 0011): `$MCS_HOME/routes/<instanceId>.json`, one small file per running or recent
// instance, written by the server and the CLI and read by the hook handler (`cli/src/hook/routes-reader.ts`). Atomic
// temp + rename; the handler never writes it.
//
// Writers: server start (`stoppedAt: null`, after the transcripts folder is resolved), graceful stop and `mcs stop`
// (`stoppedAt: now`, `spoolUntil: now + hooks.spoolWhileStoppedHours * 3600000`), `configure` of the keys that route, and
// instance removal (`removeRouteFile`). The caller computes `spoolUntil`; this module only writes what it is told.
import { mkdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HookRouteV1Schema } from '@mcs/shared';
import { normalizePath, routeKey, sanitizeProjectName, type HookRouteV1 } from '@mcs/shared/protocol';

import { atomicWriteFile } from '../platform/fsx.ts';

/** What the route needs to know about an instance (the context fields of 01 4.4a, 02 4.10). */
export interface RouteInstance {
  /** uuid: it is also the file name, so anything else is refused. */
  readonly instanceId: string;
  /** `ctx.instanceDir`: the task workspace. */
  readonly instanceDir: string;
  /** `ctx.mcsHome` */
  readonly mcsHome: string;
  /** `config.monitor.repo`, absolute. */
  readonly repoDir: string;
  /** `instance.json` `hooks.enabled`. */
  readonly hooksEnabled: boolean;
  /** Legacy pinned `session_ids`. */
  readonly sessionIds: readonly string[];
  /** The resolved transcripts folder, null while it is not found. */
  readonly transcriptsDir: string | null;
  /** `<claudeHome>/projects`: the predicted folder of the repo is `<projectsRoot>/<sanitized repo>`. */
  readonly projectsRoot: string;
}

export interface RouteState {
  /** null while the server runs. */
  readonly stoppedAt: number | null;
  /** A stopped instance keeps receiving envelopes until this time; absent or null on a stop means "not any more". */
  readonly spoolUntil?: number | null;
}

export interface RouteWriteOptions {
  /** `updatedAt` (default: the system clock). */
  readonly now?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TRANSCRIPT_DIRS = 8;
const MAX_SESSION_IDS = 256;

export function routeFilePath(mcsHome: string, instanceId: string): string {
  if (!UUID_RE.test(instanceId)) throw new RangeError('the instance id of a route file must be a lowercase uuid');
  return join(mcsHome, 'routes', `${instanceId}.json`);
}

/** The route document of an instance at `now` (pure). */
export function routeOf(instance: RouteInstance, state: RouteState, now: number): HookRouteV1 {
  if (!UUID_RE.test(instance.instanceId))
    throw new RangeError('the instance id of a route file must be a lowercase uuid');
  const workspace = normalizePath(instance.instanceDir);
  const dirs: string[] = [];
  const add = (dir: string | null): void => {
    if (dir === null || dir === '') return;
    const key = routeKey(dir);
    if (!dirs.includes(key)) dirs.push(key);
  };
  add(instance.transcriptsDir);
  // the first session of a fresh repo routes before its folder exists
  add(`${instance.projectsRoot}/${sanitizeProjectName(instance.repoDir)}`);
  return {
    v: 1,
    instanceId: instance.instanceId,
    workspace,
    spoolDir: `${workspace}/data/spool`,
    stateFile: `${workspace}/state.json`,
    enabled: instance.hooksEnabled,
    match: {
      transcriptsDirs: dirs.slice(0, MAX_TRANSCRIPT_DIRS),
      sessionIds: instance.sessionIds.slice(0, MAX_SESSION_IDS),
    },
    stoppedAt: state.stoppedAt,
    spoolUntil: state.stoppedAt === null ? null : (state.spoolUntil ?? null),
    updatedAt: now,
  };
}

/** Writes (replaces) the route file of the instance. The `routes` folder is created when it is missing. */
export async function writeRouteFile(
  instance: RouteInstance,
  state: RouteState,
  options: RouteWriteOptions = {},
): Promise<void> {
  const route = routeOf(instance, state, options.now ?? Date.now());
  const file = routeFilePath(instance.mcsHome, instance.instanceId);
  await mkdir(join(instance.mcsHome, 'routes'), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify(route, null, 2)}\n`);
}

/** The route of an instance as it is on disk, or null when it is missing or not a valid version 1 route. */
export function readRouteFile(mcsHome: string, instanceId: string): HookRouteV1 | null {
  let text: string;
  try {
    text = readFileSync(routeFilePath(mcsHome, instanceId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = HookRouteV1Schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Instance removal: deletes the route file. A file that is already gone is not an error. */
export async function removeRouteFile(mcsHome: string, instanceId: string): Promise<void> {
  try {
    await unlink(routeFilePath(mcsHome, instanceId));
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return;
    throw error;
  }
}
