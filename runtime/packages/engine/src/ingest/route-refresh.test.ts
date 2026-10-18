// The route file after `configure` (CR-WP-14-2): only an existing file is rewritten, with the transcripts folders and pinned
// sessions of the configuration now on disk, and the lifecycle fields of the server are kept. Temp workspaces and homes only.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { routeKey } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { initWorkspace } from '../workspace/init.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { refreshRouteFile } from './route-refresh.ts';
import { readRouteFile, writeRouteFile } from './routes-file.ts';
import { projectFolderName } from './transcripts/discovery.ts';

const makeTemp = useTempDirs();
const ID = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const SID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const HOUR = 3_600_000;

interface Fixture {
  readonly ws: WorkspaceRef;
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly projects: string;
  readonly skillDir: string;
  readonly clock: FakeClock;
}

async function fixture(): Promise<Fixture> {
  const root = makeTemp('route-refresh').path;
  const skillDir = path.join(root, 'skill');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  writeFileSync(
    path.join(skillDir, 'config', 'defaults.json'),
    readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8'),
  );
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const mcsHome = path.join(root, 'mcs-home');
  const claudeHome = path.join(root, 'claude-home');
  return {
    ws,
    repo,
    env: { MCS_HOME: mcsHome, CLAUDE_CONFIG_DIR: claudeHome },
    mcsHome,
    projects: path.join(claudeHome, 'projects'),
    skillDir,
    clock,
  };
}

function setConfig(ws: WorkspaceRef, keys: Record<string, unknown>): void {
  const file = path.join(ws.dir, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...config, ...keys }, null, 2)}\n`);
}

async function stoppedRoute(fx: Fixture): Promise<void> {
  await writeRouteFile(
    {
      instanceId: ID,
      instanceDir: realpathSync(fx.ws.dir),
      mcsHome: fx.mcsHome,
      repoDir: fx.repo,
      hooksEnabled: false,
      sessionIds: [],
      transcriptsDir: null,
      projectsRoot: fx.projects,
    },
    { stoppedAt: NOW - HOUR, spoolUntil: NOW + HOUR },
    { now: NOW - HOUR },
  );
}

describe('refreshRouteFile', () => {
  it('writes nothing when the instance has no route file', async () => {
    const fx = await fixture();
    const ctx = { env: fx.env, skillDir: fx.skillDir, clock: fx.clock };
    expect(await refreshRouteFile(ctx, fx.ws)).toBe(false);
    expect(existsSync(path.join(fx.mcsHome, 'routes'))).toBe(false);
  });

  it('rewrites an existing route with the new folders and pinned sessions and keeps stoppedAt and spoolUntil', async () => {
    const fx = await fixture();
    await stoppedRoute(fx);
    const explicit = path.join(path.dirname(fx.projects), 'elsewhere');
    setConfig(fx.ws, { transcripts_dir: explicit, session_ids: [SID, 'not-a-session-id'] });
    fx.clock.set(NOW + 5000);

    expect(await refreshRouteFile({ env: fx.env, skillDir: fx.skillDir, clock: fx.clock }, fx.ws)).toBe(true);
    const route = readRouteFile(fx.mcsHome, ID);
    expect(route?.match.transcriptsDirs[0]).toBe(routeKey(explicit));
    expect(route?.match.sessionIds).toEqual([SID]);
    expect(route?.stoppedAt).toBe(NOW - HOUR);
    expect(route?.spoolUntil).toBe(NOW + HOUR);
    expect(route?.updatedAt).toBe(NOW + 5000);
  });

  it('resolves transcripts_dir auto to the discovered project folder of the repository', async () => {
    const fx = await fixture();
    await stoppedRoute(fx);
    const real = realpathSync(fx.repo);
    const found = path.join(fx.projects, projectFolderName(real).name);
    mkdirSync(found, { recursive: true });
    setConfig(fx.ws, { transcripts_dir: 'auto', repo: real });

    expect(await refreshRouteFile({ env: fx.env, skillDir: fx.skillDir, clock: fx.clock }, fx.ws)).toBe(true);
    expect(readRouteFile(fx.mcsHome, ID)?.match.transcriptsDirs).toContain(routeKey(found));
  });
});
