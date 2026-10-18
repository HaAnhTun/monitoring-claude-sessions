// The route file after `configure` (02 2.6.2, CR-WP-14-2): when a key that routes changed (`repo`, `transcripts_dir`,
// `session_ids`), the route file of the instance is rewritten from the configuration as it is now on disk. Only an existing
// route file is rewritten: an instance that never ran (or was removed) has none, and `configure` does not create one. The
// lifecycle part of the route (`stoppedAt`, `spoolUntil`) is the server's and is kept as it is.
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { SID_RE, resolveMcsHome } from '@mcs/shared/protocol';

import { resolveConfig } from '../config/resolve.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { readRouteFile, writeRouteFile } from './routes-file.ts';
import { claudeHomeOf, detectTranscriptsDir, nodeDiscoveryFs, type DiscoveryFs } from './transcripts/discovery.ts';

/** What the rewrite needs of the caller (a subset of the operation context). */
export interface RouteRefreshContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly skillDir: string;
  readonly clock: { now(): number };
  /** The file system of the transcripts folder lookup (a test seam). */
  readonly fs?: DiscoveryFs;
}

/**
 * Rewrites the route file of the instance in `ws` with the transcripts folders and pinned sessions of its current
 * configuration. Answers whether a file was written: false when the workspace has no identity or no route file exists.
 */
export async function refreshRouteFile(ctx: RouteRefreshContext, ws: WorkspaceRef): Promise<boolean> {
  const instance = await readInstanceFile(ws);
  if (instance === null) return false;
  const mcsHome = resolveMcsHome(ctx.env);
  const existing = readRouteFile(mcsHome, instance.instanceId);
  if (existing === null) return false;
  const config = await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir });
  const monitor = config.monitor;
  const projects = path.join(claudeHomeOf(ctx.env), 'projects');
  const configured = monitor.transcripts_dir;
  const transcriptsDir =
    configured !== null && configured !== '' && configured !== 'auto'
      ? path.resolve(configured)
      : await detectTranscriptsDir(monitor.repo, projects, ctx.fs ?? nodeDiscoveryFs);
  // the server names the workspace by its real path (registry C07); the rewrite must name it the same way
  const instanceDir = await realpath(ws.dir).catch(() => ws.dir);
  await writeRouteFile(
    {
      instanceId: instance.instanceId,
      instanceDir,
      mcsHome,
      repoDir: monitor.repo,
      hooksEnabled: instance.hooks.enabled,
      sessionIds: monitor.session_ids.filter((id) => SID_RE.test(id)),
      transcriptsDir,
      projectsRoot: projects,
    },
    { stoppedAt: existing.stoppedAt, spoolUntil: existing.spoolUntil },
    { now: ctx.clock.now() },
  );
  return true;
}
