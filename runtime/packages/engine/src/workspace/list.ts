// Listing the workspaces of a tasks root (legacy `list_tasks`, 01 1.1) with the Node identity of each.
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { McsError, SLUG_RE, type InstanceFile } from '@mcs/shared';

import { readInstanceFile } from './adopt.ts';
import { isMissingFileError } from './fsio.ts';
import { resolveWorkspace, type WorkspaceRef } from './paths.ts';

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * The slugs of a tasks root in name order: folders whose name is a slug and that hold a `task.json` file. Staging
 * folders (`.init-*`), plain files and folders without `task.json` are not workspaces. Unlike the legacy listing a link is
 * not followed: a workspace that is a link, or whose `task.json` is one, cannot be read or written (01 3.2) and is left out.
 * An absent root has none.
 */
export async function listWorkspaceSlugs(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new McsError('WORKSPACE_INVALID', `cannot list the tasks root ${root}`, { cause: error });
  }
  const slugs: string[] = [];
  for (const name of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!SLUG_RE.test(name)) continue;
    const folder = await lstatOrNull(path.join(root, name));
    if (folder?.isDirectory() !== true) continue;
    const task = await lstatOrNull(path.join(root, name, 'task.json'));
    if (task?.isFile() === true) slugs.push(name);
  }
  return slugs;
}

export interface WorkspaceEntry {
  readonly slug: string;
  /** The resolved workspace; `null` when `resolveWorkspace` refused it (the reason is in `problem`). */
  readonly ws: WorkspaceRef | null;
  /** `instance.json`; `null` for a legacy-only workspace and for one whose file cannot be used. */
  readonly instance: InstanceFile | null;
  /** Why the workspace or its `instance.json` cannot be used (a link, a broken or copied file); `null` when fine. */
  readonly problem: string | null;
}

/** Every workspace of the root with its Node identity. A broken workspace is reported in `problem`, never thrown. */
export async function listWorkspaces(root: string): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  for (const slug of await listWorkspaceSlugs(root)) {
    let ws: WorkspaceRef | null = null;
    try {
      ws = resolveWorkspace(root, slug);
      entries.push({ slug, ws, instance: await readInstanceFile(ws), problem: null });
    } catch (error) {
      if (!(error instanceof McsError)) throw error;
      entries.push({ slug, ws, instance: null, problem: error.message });
    }
  }
  return entries;
}
