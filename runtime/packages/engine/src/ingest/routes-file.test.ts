import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { matchRoute, normalizePath, routeKey } from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  readRouteFile,
  removeRouteFile,
  routeFilePath,
  routeOf,
  writeRouteFile,
  type RouteInstance,
} from './routes-file.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const HOUR = 3_600_000;

function instance(root: string, over: Partial<RouteInstance> = {}): RouteInstance {
  return {
    instanceId: INSTANCE_ID,
    instanceDir: join(root, 'ws'),
    mcsHome: join(root, 'home'),
    repoDir: join(root, 'repo'),
    hooksEnabled: true,
    sessionIds: [],
    transcriptsDir: join(root, 'claude', 'projects', 'resolved-dir'),
    projectsRoot: join(root, 'claude', 'projects'),
    ...over,
  };
}

describe('writeRouteFile (02 2.6.2)', () => {
  it('writes a running route: stoppedAt null, spool and state paths inside the workspace', async () => {
    const root = tempDir('route-run').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: null }, { now: NOW });
    const route = readRouteFile(inst.mcsHome, INSTANCE_ID);
    expect(route).not.toBeNull();
    expect(route).toMatchObject({
      v: 1,
      instanceId: INSTANCE_ID,
      enabled: true,
      stoppedAt: null,
      spoolUntil: null,
      updatedAt: NOW,
    });
    expect(route?.workspace).toBe(normalizePath(inst.instanceDir));
    expect(route?.spoolDir).toBe(`${route?.workspace}/data/spool`);
    expect(route?.stateFile).toBe(`${route?.workspace}/state.json`);
  });

  it('lists the resolved folder and the predicted folder of the repo, as route keys', () => {
    const root = tempDir('route-dirs').path;
    const inst = instance(root);
    const route = routeOf(inst, { stoppedAt: null }, NOW);
    const predicted = routeKey(`${inst.projectsRoot}/${inst.repoDir.replace(/[^A-Za-z0-9]/g, '-')}`);
    expect(route.match.transcriptsDirs).toEqual([routeKey(inst.transcriptsDir ?? ''), predicted]);
  });

  it('lists only the predicted folder when none is resolved yet, and drops duplicates', () => {
    const root = tempDir('route-pred').path;
    const none = routeOf(instance(root, { transcriptsDir: null }), { stoppedAt: null }, NOW);
    expect(none.match.transcriptsDirs).toHaveLength(1);
    const same = routeOf(
      instance(root, { transcriptsDir: none.match.transcriptsDirs[0] ?? null }),
      { stoppedAt: null },
      NOW,
    );
    expect(same.match.transcriptsDirs).toHaveLength(1);
  });

  it('a stopped route keeps taking events until spoolUntil', async () => {
    const root = tempDir('route-stop').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: NOW, spoolUntil: NOW + 72 * HOUR }, { now: NOW });
    const route = readRouteFile(inst.mcsHome, INSTANCE_ID);
    expect(route).toMatchObject({ stoppedAt: NOW, spoolUntil: NOW + 72 * HOUR });
    if (route === null) throw new Error('route missing');
    const ids = { session_id: null, transcript_path: `${inst.transcriptsDir ?? ''}/s.jsonl`, cwd: null };
    expect(matchRoute(route, ids, NOW + HOUR)).toBe('transcript');
    expect(matchRoute(route, ids, NOW + 72 * HOUR)).toBeNull();
  });

  it('a stop without spoolUntil stops spooling at once', async () => {
    const root = tempDir('route-stop0').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: NOW }, { now: NOW });
    const route = readRouteFile(inst.mcsHome, INSTANCE_ID);
    expect(route?.spoolUntil).toBeNull();
    if (route === null) throw new Error('route missing');
    const ids = { session_id: null, transcript_path: `${inst.transcriptsDir ?? ''}/s.jsonl`, cwd: null };
    // a stopped route with a null spoolUntil never matches (02 2.6.2 rule 2)
    expect(matchRoute(route, ids, NOW + 1)).toBeNull();
  });

  it('carries the pinned session ids and the enabled flag', async () => {
    const root = tempDir('route-pin').path;
    const sid = '22222222-2222-4222-8222-222222222222';
    const inst = instance(root, { sessionIds: [sid], hooksEnabled: false });
    await writeRouteFile(inst, { stoppedAt: null }, { now: NOW });
    expect(readRouteFile(inst.mcsHome, INSTANCE_ID)).toMatchObject({ enabled: false, match: { sessionIds: [sid] } });
  });

  it('replaces the file atomically and leaves no temporary file behind', async () => {
    const root = tempDir('route-atomic').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: null }, { now: NOW });
    await writeRouteFile(inst, { stoppedAt: NOW + 1, spoolUntil: null }, { now: NOW + 1 });
    expect(readdirSync(join(inst.mcsHome, 'routes'))).toEqual([`${INSTANCE_ID}.json`]);
    expect(readRouteFile(inst.mcsHome, INSTANCE_ID)?.stoppedAt).toBe(NOW + 1);
  });

  it('refuses an instance id that is not a uuid (it names the file)', async () => {
    const root = tempDir('route-bad').path;
    await expect(
      writeRouteFile(instance(root, { instanceId: '../x' }), { stoppedAt: null }, { now: NOW }),
    ).rejects.toThrow(RangeError);
  });
});

describe('readRouteFile and removeRouteFile', () => {
  it('answers null for a missing file', () => {
    const root = tempDir('route-read').path;
    expect(readRouteFile(join(root, 'home'), INSTANCE_ID)).toBeNull();
  });

  it('removes the file and is quiet when it is gone', async () => {
    const root = tempDir('route-rm').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: null }, { now: NOW });
    expect(existsSync(routeFilePath(inst.mcsHome, INSTANCE_ID))).toBe(true);
    await removeRouteFile(inst.mcsHome, INSTANCE_ID);
    expect(existsSync(routeFilePath(inst.mcsHome, INSTANCE_ID))).toBe(false);
    await expect(removeRouteFile(inst.mcsHome, INSTANCE_ID)).resolves.toBeUndefined();
  });

  it('the file on disk is plain JSON with the registry fields', async () => {
    const root = tempDir('route-json').path;
    const inst = instance(root);
    await writeRouteFile(inst, { stoppedAt: null }, { now: NOW });
    const parsed: unknown = JSON.parse(readFileSync(routeFilePath(inst.mcsHome, INSTANCE_ID), 'utf8'));
    expect(parsed).toMatchObject({ v: 1, instanceId: INSTANCE_ID });
  });
});
