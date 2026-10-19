// `hooksStatus` (02 3.1, ADR 0070): the installs from the manifest and a scan of the known scopes, the state of the stable copy of
// the hook script, the summary of the handler log and the newest spool segment per instance. It reads and never writes; a settings
// file edited by hand shows in the scan, and nothing it reads from the manifest or a route is trusted as a path to execute or to
// read outside the places the design names.
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { HooksStatusResultSchema } from '@mcs/shared';
import { HANDLER_VERSION, INSTALLED_HOOK_EVENTS, normalizePath, spoolSegmentName } from '@mcs/shared/protocol';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_CLOCK_MS,
  HANDLER_V1,
  HANDLER_V2,
  makeHarness,
  treeOf,
  type Harness,
} from '../../../test/fixtures/settings/harness.ts';
import { writeRouteFile } from '../../ingest/routes-file.ts';
import { handlerLogPath, rotatedLogPath } from './handler-log.ts';
import { manifestPath } from './manifest.ts';
import { stableScriptPath } from './script-copy.ts';
import { sha256Hex } from './settings-io.ts';
import { hooksStatus } from './status.ts';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

async function installed(): Promise<Harness> {
  const h = makeHarness(makeTemp);
  await h.install();
  return h;
}

function status(h: Harness, over: Partial<Parameters<typeof hooksStatus>[0]> = {}): ReturnType<typeof hooksStatus> {
  return hooksStatus({ mcsHome: h.mcsHome, env: h.env, source: h.source, seams: { tmpdir: () => h.root }, ...over });
}

function settingsWithout(h: Harness, events: readonly string[]): string {
  const parsed: unknown = JSON.parse(h.settings());
  if (typeof parsed !== 'object' || parsed === null) throw new Error('settings is not an object');
  const hooks: unknown = Reflect.get(parsed, 'hooks');
  if (typeof hooks !== 'object' || hooks === null) throw new Error('hooks is not an object');
  for (const event of events) Reflect.deleteProperty(hooks, event);
  return `${JSON.stringify(parsed, null, 2)}${LF}`;
}

describe('hooksStatus: nothing installed', () => {
  it('gives an empty list, no copy and no log, and the result matches the schema', async () => {
    const h = makeHarness(makeTemp);
    const result = await status(h);
    HooksStatusResultSchema.parse(result);
    expect(result).toEqual({
      installs: [],
      script: { state: 'not_installed', path: stableScriptPath(h.mcsHome), sha256: null, handlerVersion: null },
      handlerLog: [],
      lastEnvelopeAt: {},
    });
  });

  it('writes nothing, not even the folders it looks in', async () => {
    const h = makeHarness(makeTemp);
    const before = treeOf(h.root);
    await status(h);
    await status(h, { scan: [{ scope: 'file', settingsPath: h.settingsPath }] });
    expect(treeOf(h.root)).toEqual(before);
  });
});

describe('hooksStatus: after an install', () => {
  it('lists the install with the number of events that are really in the settings file', async () => {
    const h = await installed();
    const result = await status(h);
    HooksStatusResultSchema.parse(result);
    expect(result.installs).toEqual([
      {
        settingsPath: normalizePath(h.settingsPath),
        scope: 'file',
        events: INSTALLED_HOOK_EVENTS.length,
        handlerVersion: HANDLER_VERSION,
        at: FIXTURE_CLOCK_MS,
      },
    ]);
  });

  it('reports the copy as current and gives its hash and the installed handler version', async () => {
    const h = await installed();
    const result = await status(h);
    expect(result.script).toEqual({
      state: 'current',
      path: stableScriptPath(h.mcsHome),
      sha256: sha256Hex(HANDLER_V1),
      handlerVersion: HANDLER_VERSION,
    });
  });

  it('says unknown when no bundled source is given to compare with', async () => {
    const h = await installed();
    expect((await status(h, { source: null })).script).toMatchObject({
      state: 'unknown',
      sha256: sha256Hex(HANDLER_V1),
    });
    expect((await hooksStatus({ mcsHome: h.mcsHome, env: h.env, seams: { tmpdir: () => h.root } })).script.state).toBe(
      'unknown',
    );
  });

  it('says unknown when the bundled source cannot be read, and does not fail', async () => {
    const h = await installed();
    const result = await status(h, { source: path.join(h.root, 'nowhere', 'mcs-hook.mjs') });
    expect(result.script.state).toBe('unknown');
  });

  it('says stale after a plugin update changed the bundled script and nobody refreshed the copy', async () => {
    const h = await installed();
    h.setSource(HANDLER_V2);
    const result = await status(h);
    expect(result.script.state).toBe('stale');
    expect(result.script.sha256).toBe(sha256Hex(HANDLER_V1));
  });

  it('says missing when the copy was deleted but an install is recorded', async () => {
    const h = await installed();
    rmSync(stableScriptPath(h.mcsHome));
    const result = await status(h);
    expect(result.script).toEqual({
      state: 'missing',
      path: stableScriptPath(h.mcsHome),
      sha256: null,
      handlerVersion: HANDLER_VERSION,
    });
  });

  it('says stale for a copy that is a link, whatever it points to', async () => {
    const h = await installed();
    const decoy = path.join(h.root, 'decoy');
    mkdirSync(decoy);
    rmSync(stableScriptPath(h.mcsHome));
    makeJunction(stableScriptPath(h.mcsHome), decoy); // a junction on Windows, no privilege needed
    expect((await status(h)).script.state).toBe('stale');
  });

  it('after the last uninstall the status is the empty one again', async () => {
    const h = await installed();
    await h.uninstall();
    expect(await status(h)).toEqual({
      installs: [],
      script: { state: 'not_installed', path: stableScriptPath(h.mcsHome), sha256: null, handlerVersion: null },
      handlerLog: [],
      lastEnvelopeAt: {},
    });
  });
});

describe('hooksStatus: the scan of the settings files', () => {
  it('shows an entry that somebody removed by hand', async () => {
    const h = await installed();
    writeFileSync(h.settingsPath, settingsWithout(h, ['Stop']));
    const result = await status(h);
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]?.events).toBe(INSTALLED_HOOK_EVENTS.length - 1);
  });

  it('keeps an install whose settings file is gone or damaged, with no events', async () => {
    const h = await installed();
    writeFileSync(h.settingsPath, '{ not json');
    expect((await status(h)).installs[0]?.events).toBe(0);
    rmSync(h.settingsPath);
    expect((await status(h)).installs[0]?.events).toBe(0);
  });

  it('finds our entries in a scanned file the manifest does not know (the manifest was lost)', async () => {
    const h = await installed();
    rmSync(manifestPath(h.mcsHome));
    const none = await status(h);
    expect(none.installs).toEqual([]);
    const found = await status(h, { scan: [{ scope: 'user', settingsPath: h.settingsPath }] });
    expect(found.installs).toEqual([
      {
        settingsPath: normalizePath(h.settingsPath),
        scope: 'user',
        events: INSTALLED_HOOK_EVENTS.length,
        handlerVersion: 'unknown',
        at: 0,
      },
    ]);
    // an install without a manifest still has a copy
    expect(found.script.state).toBe('current');
    expect(found.script.handlerVersion).toBeNull();
  });

  it('leaves out a scanned file that has none of our entries or does not exist', async () => {
    const h = makeHarness(makeTemp);
    const plain = path.join(h.claudeHome, 'plain.json');
    writeFileSync(
      plain,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo FIXTURE' }] }] } }),
    );
    const result = await status(h, {
      scan: [
        { scope: 'user', settingsPath: plain },
        { scope: 'project-local', settingsPath: path.join(h.root, 'repo', '.claude', 'settings.local.json') },
      ],
    });
    expect(result.installs).toEqual([]);
  });

  it('lists a file once when the manifest and the scan both name it', async () => {
    const h = await installed();
    const result = await status(h, {
      scan: [
        { scope: 'user', settingsPath: h.settingsPath },
        { scope: 'user', settingsPath: h.settingsPath },
      ],
    });
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]?.scope).toBe('file');
  });

  it('lists the installs in the order of their paths', async () => {
    const h = await installed();
    const second = path.join(h.root, 'aaa', 'settings.local.json');
    await h.install({ settingsPath: second });
    const result = await status(h);
    expect(result.installs.map((entry) => entry.settingsPath)).toEqual(
      [normalizePath(second), normalizePath(h.settingsPath)].sort(),
    );
  });

  it('counts only the 21 installed events, and copes with a settings file of 1000 hook groups', async () => {
    const h = await installed();
    const parsed = JSON.parse(h.settings()) as { hooks: Record<string, unknown[]> };
    const stop = parsed.hooks['Stop'] ?? [];
    for (let i = 0; i < 1000; i += 1)
      stop.unshift({ matcher: `FIXTURE-${String(i)}`, hooks: [{ type: 'command', command: 'echo FIXTURE' }] });
    parsed.hooks['FixtureOtherEvent'] = [
      { hooks: [{ type: 'command', command: 'x', args: ['--mcs-hook', 'FixtureOtherEvent'] }] },
    ];
    writeFileSync(h.settingsPath, JSON.stringify(parsed, null, 2));
    const started = Date.now();
    const result = await status(h);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.installs[0]?.events).toBe(INSTALLED_HOOK_EVENTS.length);
  });

  it('refuses a scan target outside the temporary folder in test mode, and reads nothing', async () => {
    const h = await installed();
    const narrow = path.join(h.root, 'narrow');
    mkdirSync(narrow);
    await expect(
      hooksStatus({
        mcsHome: h.mcsHome,
        env: h.env,
        scan: [{ scope: 'user', settingsPath: h.settingsPath }],
        seams: { tmpdir: () => narrow },
      }),
    ).rejects.toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'REAL_SETTINGS_IN_TEST' } });
  });

  it('refuses an MCS_HOME outside the temporary folder in test mode', async () => {
    const h = makeHarness(makeTemp);
    const narrow = path.join(h.root, 'narrow');
    mkdirSync(narrow);
    await expect(
      hooksStatus({ mcsHome: h.mcsHome, env: h.env, seams: { tmpdir: () => narrow } }),
    ).rejects.toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'REAL_SETTINGS_IN_TEST' } });
  });

  it('wants absolute paths', async () => {
    const h = makeHarness(makeTemp);
    await expect(hooksStatus({ mcsHome: 'relative/home', env: h.env })).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      hooksStatus({ mcsHome: h.mcsHome, env: h.env, scan: [{ scope: 'user', settingsPath: 'settings.json' }] }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('hooksStatus: a manifest is a register, not an instruction', () => {
  function tamper(h: Harness, change: (record: Record<string, unknown>) => void): void {
    const parsed = JSON.parse(readFileSync(manifestPath(h.mcsHome), 'utf8')) as {
      installs: Record<string, Record<string, unknown>>;
    };
    for (const record of Object.values(parsed.installs)) change(record);
    writeFileSync(manifestPath(h.mcsHome), JSON.stringify(parsed, null, 2));
  }

  it('does not read the settings file of a record outside the temporary folder in test mode', async () => {
    const h = await installed();
    // the decoy holds a full set of our entries; if it were read the record would show 21 events
    const outside = makeTemp('status-outside').path;
    const decoy = path.join(outside, 'settings.json');
    writeFileSync(decoy, h.settings());
    tamper(h, (record) => {
      record['settingsPath'] = normalizePath(decoy);
    });
    // the temporary folder of this run is the world of the harness; the decoy lies beside it
    const result = await hooksStatus({
      mcsHome: h.mcsHome,
      env: h.env,
      source: h.source,
      seams: { tmpdir: () => h.root },
    });
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]).toMatchObject({ settingsPath: normalizePath(decoy), events: 0 });
  });

  it('takes the state of the copy from MCS_HOME, never from the path the manifest names', async () => {
    const h = await installed();
    const elsewhere = path.join(h.root, 'elsewhere', 'mcs-hook.mjs');
    mkdirSync(path.dirname(elsewhere));
    writeFileSync(elsewhere, HANDLER_V2);
    tamper(h, (record) => {
      record['hookEntryPath'] = normalizePath(elsewhere);
      record['nodePath'] = normalizePath(elsewhere);
    });
    const result = await status(h);
    expect(result.script.path).toBe(stableScriptPath(h.mcsHome));
    expect(result.script.sha256).toBe(sha256Hex(HANDLER_V1));
    expect(result.script.state).toBe('current');
  });

  it('ignores a damaged manifest and a record of the wrong shape', async () => {
    const h = await installed();
    writeFileSync(manifestPath(h.mcsHome), '{ damaged');
    expect((await status(h)).installs).toEqual([]);
    writeFileSync(manifestPath(h.mcsHome), JSON.stringify({ v: 1, installs: { x: { settingsPath: 5 } } }));
    expect((await status(h)).installs).toEqual([]);
  });
});

describe('hooksStatus: the handler log', () => {
  it('carries the summary of the log and its rotated file', async () => {
    const h = await installed();
    const log = handlerLogPath(h.mcsHome);
    mkdirSync(path.dirname(log), { recursive: true });
    const row = (code: string, at: number): string =>
      JSON.stringify({ at, code, event: 'Stop', instanceId: null, pid: 1, detail: '' }) + LF;
    writeFileSync(rotatedLogPath(log), row('SPOOL_FULL', 100));
    writeFileSync(log, row('SPOOL_FULL', 300) + row('ROUTE_INVALID', 200));
    const result = await status(h);
    HooksStatusResultSchema.parse(result);
    expect(result.handlerLog).toEqual([
      { code: 'SPOOL_FULL', count: 2, lastAt: 300 },
      { code: 'ROUTE_INVALID', count: 1, lastAt: 200 },
    ]);
  });
});

describe('hooksStatus: the newest spool segment of each instance', () => {
  async function instance(h: Harness, instanceId: string, name: string): Promise<{ workspace: string; spool: string }> {
    const workspace = path.join(h.root, name);
    mkdirSync(workspace, { recursive: true });
    await writeRouteFile(
      {
        instanceId,
        instanceDir: workspace,
        mcsHome: h.mcsHome,
        repoDir: path.join(h.root, 'repo'),
        hooksEnabled: true,
        sessionIds: [],
        transcriptsDir: path.join(h.root, 'projects', name),
        projectsRoot: path.join(h.root, 'projects'),
      },
      { stoppedAt: null },
      { now: FIXTURE_CLOCK_MS },
    );
    return { workspace, spool: path.join(workspace, 'data', 'spool') };
  }

  function segment(spool: string, at: number, mtimeMs: number): void {
    mkdirSync(spool, { recursive: true });
    const file = path.join(spool, spoolSegmentName(at));
    writeFileSync(file, '{}' + LF);
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('is the modification time of the newest segment, and null for an instance that has none', async () => {
    const h = await installed();
    const a = await instance(h, ID_A, 'ws-a');
    await instance(h, ID_B, 'ws-b');
    segment(a.spool, Date.UTC(2026, 9, 20, 8), Date.UTC(2026, 9, 20, 8, 45, 12));
    segment(a.spool, Date.UTC(2026, 9, 20, 9), Date.UTC(2026, 9, 20, 9, 5, 30));
    const result = await status(h);
    const newest = statSync(path.join(a.spool, spoolSegmentName(Date.UTC(2026, 9, 20, 9)))).mtimeMs;
    expect(result.lastEnvelopeAt).toEqual({ [ID_A]: newest, [ID_B]: null });
  });

  it('can be limited to the instances asked for, and an unknown instance is null', async () => {
    const h = await installed();
    const a = await instance(h, ID_A, 'ws-a');
    await instance(h, ID_B, 'ws-b');
    segment(a.spool, Date.UTC(2026, 9, 20, 8), Date.UTC(2026, 9, 20, 8, 1));
    const result = await status(h, { instanceIds: [ID_A, '33333333-3333-4333-8333-333333333333', 'not-an-id'] });
    expect(Object.keys(result.lastEnvelopeAt).sort()).toEqual(
      [ID_A, '33333333-3333-4333-8333-333333333333', 'not-an-id'].sort(),
    );
    expect(result.lastEnvelopeAt[ID_A]).not.toBeNull();
    expect(result.lastEnvelopeAt['33333333-3333-4333-8333-333333333333']).toBeNull();
    expect(result.lastEnvelopeAt['not-an-id']).toBeNull();
  });

  it('ignores files in the spool folder that are not segments', async () => {
    const h = await installed();
    const a = await instance(h, ID_A, 'ws-a');
    mkdirSync(a.spool, { recursive: true });
    writeFileSync(path.join(a.spool, 'notes.txt'), 'FIXTURE');
    expect((await status(h)).lastEnvelopeAt[ID_A]).toBeNull();
  });

  it('does not look in a spool folder that a route names outside its workspace', async () => {
    const h = await installed();
    const a = await instance(h, ID_A, 'ws-a');
    const stray = path.join(h.root, 'stray-spool');
    segment(stray, Date.UTC(2026, 9, 20, 8), Date.UTC(2026, 9, 20, 8, 1));
    const routeFile = path.join(h.mcsHome, 'routes', `${ID_A}.json`);
    const route = JSON.parse(readFileSync(routeFile, 'utf8')) as Record<string, unknown>;
    route['spoolDir'] = normalizePath(stray);
    writeFileSync(routeFile, JSON.stringify(route));
    expect(a.workspace).not.toBe('');
    expect((await status(h)).lastEnvelopeAt[ID_A]).toBeNull();
  });

  it('skips a route file that is damaged', async () => {
    const h = await installed();
    mkdirSync(path.join(h.mcsHome, 'routes'), { recursive: true });
    writeFileSync(path.join(h.mcsHome, 'routes', `${ID_A}.json`), '{ damaged');
    writeFileSync(path.join(h.mcsHome, 'routes', 'not-a-route.txt'), 'x');
    expect((await status(h)).lastEnvelopeAt).toEqual({});
  });
});
