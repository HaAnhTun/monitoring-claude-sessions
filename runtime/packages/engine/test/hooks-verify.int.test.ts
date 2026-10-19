// `hooks verify` and `hooks status` against a real bundled hook handler, real processes, a real route file, a real spool and a real
// database behind a loopback socket (T-IN-08, ADR 0070). The installer puts the stable copy of a freshly built `mcs-hook.mjs`
// into a temporary MCS_HOME; the verifier starts exactly the installed command; the handler writes the probe envelope to the spool
// of a workspace; a spool drainer, a writer and a database read it back; a tiny HTTP server answers the probe lookup from that
// database. Everything happens in temporary folders; no real settings file, no real MCS_HOME and no port outside 18000-18999.
import { createServer, type Server } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HooksStatusResultSchema, HooksVerifyResultSchema, systemClock } from '@mcs/shared';
import type { HooksVerifyResult } from '@mcs/shared';
import { HANDLER_VERSION, INSTALLED_HOOK_EVENTS, normalizePath } from '@mcs/shared/protocol';
import { allocatePort, assertPortClosed, killAllTracked, useTempDirs } from '@mcs/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';
import { makeHarness, treeOf, type Harness } from './fixtures/settings/harness.ts';
import { dumpDatabase } from './fixtures/spool.ts';
import { openInstanceDb } from '../src/db/open.ts';
import { HookProbesRepo } from '../src/db/repos/hook-probes.ts';
import { handlerLogPath, summarizeHandlerLog } from '../src/hooks/installer/handler-log.ts';
import { stableScriptPath } from '../src/hooks/installer/script-copy.ts';
import { hooksStatus } from '../src/hooks/installer/status.ts';
import { verifyHooks, type VerifyInstance } from '../src/hooks/installer/verify.ts';
import { writeRouteFile } from '../src/ingest/routes-file.ts';
import { createSpoolDrainer } from '../src/ingest/spool/spool-drainer.ts';
import { createIngestWriter } from '../src/ingest/writer.ts';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };

let buildRoot = '';
let builtHook = '';

beforeAll(async () => {
  // one fresh bundle of the hook handler, shared by every test (never the tracked bundle)
  buildRoot = mkdtempSync(path.join(tmpdir(), 'mcs-hooks-verify-'));
  const outDir = path.join(buildRoot, 'bundle');
  await buildBundle({ outDir, entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' }, web: false });
  builtHook = path.join(outDir, 'mcs-hook.mjs');
}, 120_000);

afterAll(() => {
  if (buildRoot !== '') rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const servers: Server[] = [];
afterEach(async () => {
  await killAllTracked();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
});

// ---- a world with a real handler --------------------------------------------------------------------------------------------

interface World {
  readonly h: Harness;
  readonly instance: VerifyInstance;
  readonly workspace: string;
  readonly spool: string;
}

/** An installed hook (real Node, real bundled handler) and the route of an instance whose workspace is `<root>/workspace`. */
async function world(): Promise<World> {
  const h = makeHarness(makeTemp);
  writeFileSync(h.source, readFileSync(builtHook));
  await h.install({ nodePath: process.execPath });
  const workspace = path.join(h.root, 'workspace');
  const transcriptsDir = path.join(h.root, 'projects', 'p');
  const repoDir = path.join(h.root, 'repo');
  for (const dir of [workspace, transcriptsDir, repoDir]) mkdirSync(dir, { recursive: true });
  await writeRouteFile(
    {
      instanceId: INSTANCE_ID,
      instanceDir: workspace,
      mcsHome: h.mcsHome,
      repoDir,
      hooksEnabled: true,
      sessionIds: [],
      transcriptsDir,
      projectsRoot: path.join(h.root, 'projects'),
    },
    { stoppedAt: null },
  );
  return {
    h,
    instance: { instanceId: INSTANCE_ID, transcriptsDir, repoDir },
    workspace,
    spool: path.join(workspace, 'data', 'spool'),
  };
}

function verify(
  w: World,
  over: { serverBase?: string | null; source?: string | null } = {},
): Promise<HooksVerifyResult> {
  return verifyHooks({
    settingsPath: w.h.settingsPath,
    mcsHome: w.h.mcsHome,
    env: w.h.env,
    instance: w.instance,
    source: over.source === undefined ? w.h.source : over.source,
    ...(over.serverBase === undefined ? {} : { serverBase: over.serverBase }),
    // a loaded machine gets more time than the design's 1500 ms for a handler that behaves
    seams: { tmpdir: () => w.h.root, limits: { probeMs: 20_000, versionMs: 20_000 } },
  });
}

function check(result: HooksVerifyResult, id: string): HooksVerifyResult['checks'][number] {
  const found = result.checks.find((c) => c.check === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

const oks = (result: HooksVerifyResult): (boolean | null)[] => result.checks.map((c) => c.ok);

/** Replaces the stable copy by a script (the installer's own copy is what the settings entries run). */
function replaceCopy(w: World, script: string): void {
  writeFileSync(stableScriptPath(w.h.mcsHome), script);
}

function script(version: string, hook: string): string {
  return [
    'const args = process.argv.slice(2);',
    `if (args.includes('--version')) { process.stdout.write('${version}' + String.fromCharCode(10)); process.exit(0); }`,
    hook,
    '',
  ].join(LF);
}

// ---- the happy path -----------------------------------------------------------------------------------------------------------

describe('the real handler: V1 to V6', () => {
  it('passes after an install, skips V7 while no server runs, and the probe is an envelope of kind probe in the spool', async () => {
    const w = await world();
    const result = await verify(w);
    HooksVerifyResultSchema.parse(result);
    expect(oks(result)).toEqual([true, true, true, true, true, true, null]);
    expect(check(result, 'V4').detail).toContain(HANDLER_VERSION);

    const segments = readdirSync(w.spool).filter((name) => name.endsWith('.ndjson'));
    expect(segments).toHaveLength(1);
    const lines = readFileSync(path.join(w.spool, segments[0] ?? ''), 'utf8')
      .split(LF)
      .filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      v: 1,
      kind: 'probe',
      instance_id: INSTANCE_ID,
      event: 'Notification',
      handler: { version: HANDLER_VERSION },
    });
  }, 60_000);

  it('writes nothing outside the spool: settings, manifest, backups, the copy and the decoy settings files stay as they were', async () => {
    const w = await world();
    const canary = `{"FIXTURE_CANARY":"do not touch"}${LF}`;
    const decoys = [
      path.join(w.h.root, 'home', '.claude', 'settings.json'),
      path.join(w.h.root, 'repo', '.claude', 'settings.local.json'),
      path.join(w.h.claudeHome, 'settings.local.json'),
    ];
    for (const decoy of decoys) {
      mkdirSync(path.dirname(decoy), { recursive: true });
      writeFileSync(decoy, canary);
    }
    const before = {
      claude: treeOf(w.h.claudeHome),
      mcs: treeOf(w.h.mcsHome),
      home: treeOf(path.join(w.h.root, 'home')),
    };
    await verify(w);
    await verify(w);
    expect(treeOf(w.h.claudeHome)).toEqual(before.claude);
    expect(treeOf(path.join(w.h.root, 'home'))).toEqual(before.home);
    // the handler writes a log only when something is wrong; a good run leaves MCS_HOME exactly as it was
    expect(treeOf(w.h.mcsHome)).toEqual(before.mcs);
    for (const decoy of decoys) expect(readFileSync(decoy, 'utf8')).toBe(canary);
  }, 60_000);

  it('V3 fails after the copy was deleted, and V4 and V6 fail with it: the command cannot find its script', async () => {
    const w = await world();
    rmSync(stableScriptPath(w.h.mcsHome));
    const result = await verify(w);
    expect(oks(result)).toEqual([true, true, false, false, true, false, null]);
    expect(check(result, 'V3').detail).toMatch(/missing/);
  }, 60_000);

  it('V3 fails when the copy differs from the bundled script, while the old copy still runs (V4, V6)', async () => {
    const w = await world();
    appendFileSync(w.h.source, `${LF}// FIXTURE plugin update${LF}`);
    const result = await verify(w);
    expect(oks(result)).toEqual([true, true, false, true, true, true, null]);
    expect(check(result, 'V3').detail).toMatch(/differs from the bundled script/);
    expect(check(result, 'V3').detail).toMatch(/hooks install --yes/);
  }, 60_000);

  it('V4 fails with a handler that prints another version', async () => {
    const w = await world();
    replaceCopy(w, script('3.9.9', 'process.exit(0);'));
    const result = await verify(w, { source: null });
    expect(check(result, 'V4')).toMatchObject({ ok: false });
    expect(check(result, 'V4').detail).toContain('3.9.9');
  }, 60_000);

  it('V6 fails with a handler that prints to stdout, one that exits non-zero, and one that takes longer than the limit', async () => {
    const w = await world();
    replaceCopy(w, script(HANDLER_VERSION, "process.stdout.write('hello');"));
    expect(check(await verify(w, { source: null }), 'V6').detail).toMatch(/prints nothing/);
    replaceCopy(w, script(HANDLER_VERSION, 'process.exit(1);'));
    expect(check(await verify(w, { source: null }), 'V6').detail).toMatch(/exited with code 1/);
    // the real limit of the design: a handler that hangs is killed at 1500 ms and the check is false
    replaceCopy(w, script(HANDLER_VERSION, 'setInterval(() => undefined, 1000);'));
    const started = Date.now();
    const hung = await verifyHooks({
      settingsPath: w.h.settingsPath,
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      instance: w.instance,
      seams: { tmpdir: () => w.h.root },
    });
    expect(check(hung, 'V6').ok).toBe(false);
    expect(check(hung, 'V6').detail).toMatch(/within 1500 ms and was killed/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 90_000);

  it('V6 fails with a handler that floods its output, and the flood is cut at the cap', async () => {
    const w = await world();
    replaceCopy(w, script(HANDLER_VERSION, "setInterval(() => process.stdout.write('x'.repeat(65536)), 1);"));
    const result = await verify(w, { source: null });
    expect(check(result, 'V6')).toMatchObject({ ok: false });
    expect(check(result, 'V6').detail).toMatch(/more than 8192 bytes/);
  }, 60_000);

  it('V5 fails when the instance has no route and V6 then finds no spool', async () => {
    const w = await world();
    rmSync(path.join(w.h.mcsHome, 'routes', `${INSTANCE_ID}.json`));
    const result = await verify(w);
    expect(oks(result).slice(0, 6)).toEqual([true, true, true, true, false, false]);
    expect(existsSync(w.spool)).toBe(false);
  }, 60_000);
});

// ---- the round trip through a server ------------------------------------------------------------------------------------------------

interface Rig {
  readonly port: number;
  readonly nudges: () => number;
  readonly lookups: () => number;
  stop(): Promise<void>;
}

/**
 * A server that does what the real one does for the hook path: it answers the nudge of the handler by draining the spool into a
 * real database through a real writer, and it answers `GET /api/v3/ingest/probes/:id` from that database.
 */
async function rig(w: World, dbPath: string): Promise<Rig & { readonly dump: () => ReturnType<typeof dumpDatabase> }> {
  const db = openInstanceDb({
    path: dbPath,
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: HANDLER_VERSION,
  });
  const writer = createIngestWriter({ db, scope: CTX });
  const drainer = createSpoolDrainer({
    db,
    scope: CTX,
    instanceId: INSTANCE_ID,
    spoolDir: w.spool,
    writer,
    clock: systemClock,
    pollMs: 250,
  });
  await drainer.start();
  const probes = new HookProbesRepo(db);
  let nudged = 0;
  let looked = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/api/v3/ingest/nudge') {
      nudged += 1;
      drainer.nudge();
      res.writeHead(204).end();
      return;
    }
    const match = /^\/api\/v3\/ingest\/probes\/([0-9a-f-]+)$/.exec(url);
    if (req.method === 'GET' && match?.[1] !== undefined) {
      looked += 1;
      const row = probes.get(CTX, match[1]);
      if (row === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'probe_not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          receivedAt: new Date(row.receivedAt).toISOString(),
          committedAt: new Date(row.committedAt).toISOString(),
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  const port = await allocatePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  // the handler finds the server through the state file of the workspace (02 2.8)
  writeFileSync(
    path.join(w.workspace, 'state.json'),
    JSON.stringify({ instanceId: INSTANCE_ID, engine: 'node', port }),
  );
  return {
    port,
    nudges: () => nudged,
    lookups: () => looked,
    dump: () => dumpDatabase(db),
    async stop() {
      await drainer.stop();
      await writer.close();
      db.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      servers.splice(servers.indexOf(server), 1);
      await assertPortClosed(port);
    },
  };
}

describe('the real handler: V7 through a server that drains the spool into a database', () => {
  it('commits the probe: the handler nudges, the drain stores it as a probe, and no session is ever created', async () => {
    const w = await world();
    const live = await rig(w, path.join(w.h.root, 'monitor.db'));
    try {
      const result = await verify(w, { serverBase: `http://127.0.0.1:${String(live.port)}` });
      expect(oks(result)).toEqual([true, true, true, true, true, true, true]);
      expect(check(result, 'V7').detail).toMatch(/committed the probe \d+ ms after/);
      expect(live.nudges()).toBeGreaterThanOrEqual(1);
      expect(live.lookups()).toBeGreaterThanOrEqual(1);

      const dump = live.dump();
      expect(dump['hook_probes']).toHaveLength(1);
      expect(String(dump['hook_probes']?.[0]?.['probe_session_id'])).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
      for (const table of ['sessions', 'agents', 'tool_calls', 'turns', 'events', 'ingest_errors']) {
        expect(dump[table], table).toEqual([]);
      }
    } finally {
      await live.stop();
    }
  }, 60_000);

  it('V7 is false when the server stays silent about the probe: it never reads the spool', async () => {
    const w = await world();
    const port = await allocatePort();
    const server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"probe_not_found"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const started = Date.now();
    const result = await verify(w, { serverBase: `http://127.0.0.1:${String(port)}` });
    expect(oks(result)).toEqual([true, true, true, true, true, true, false]);
    expect(check(result, 'V7').detail).toMatch(/within 3 s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('V7 is skipped when nothing listens at the address of the server', async () => {
    const w = await world();
    const port = await allocatePort();
    const result = await verify(w, { serverBase: `http://127.0.0.1:${String(port)}` });
    expect(check(result, 'V7')).toMatchObject({ ok: null });
    expect(oks(result).slice(0, 6)).toEqual([true, true, true, true, true, true]);
  }, 60_000);
});

// ---- status next to the real handler -------------------------------------------------------------------------------------------------

describe('hooks status next to the real handler', () => {
  it('shows the install, a current copy, the newest spool segment of the instance and the log of the handler', async () => {
    const w = await world();
    const quiet = await hooksStatus({
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      source: w.h.source,
      seams: { tmpdir: () => w.h.root },
    });
    HooksStatusResultSchema.parse(quiet);
    expect(quiet.installs).toMatchObject([
      { settingsPath: normalizePath(w.h.settingsPath), events: INSTALLED_HOOK_EVENTS.length },
    ]);
    expect(quiet.script).toMatchObject({ state: 'current', handlerVersion: HANDLER_VERSION });
    expect(quiet.lastEnvelopeAt).toEqual({ [INSTANCE_ID]: null });
    expect(quiet.handlerLog).toEqual([]);

    // a route file that is not valid: the real handler logs it, in its own format, at every run
    writeFileSync(path.join(w.h.mcsHome, 'routes', 'broken.json'), '{ not json');
    const before = Date.now();
    await verify(w);
    const after = await hooksStatus({
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      source: w.h.source,
      seams: { tmpdir: () => w.h.root },
    });
    HooksStatusResultSchema.parse(after);
    const newest = after.lastEnvelopeAt[INSTANCE_ID];
    expect(newest).not.toBeNull();
    expect(newest ?? 0).toBeGreaterThanOrEqual(before - 2000);
    expect(after.handlerLog).toHaveLength(1);
    expect(after.handlerLog[0]).toMatchObject({ code: 'ROUTE_INVALID' });
    expect(after.handlerLog[0]?.count).toBeGreaterThanOrEqual(1);
    expect(after.handlerLog[0]?.lastAt).toBeGreaterThanOrEqual(before - 2000);
    expect(await summarizeHandlerLog(handlerLogPath(w.h.mcsHome))).toEqual(after.handlerLog);
    // what the handler wrote about the broken file is a file name, and the summary does not carry it
    expect(JSON.stringify(after.handlerLog)).not.toContain('broken');
  }, 60_000);

  it('reports a stale copy after the bundled script changed, and missing after the copy is deleted', async () => {
    const w = await world();
    appendFileSync(w.h.source, `${LF}// FIXTURE plugin update${LF}`);
    const stale = await hooksStatus({
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      source: w.h.source,
      seams: { tmpdir: () => w.h.root },
    });
    expect(stale.script.state).toBe('stale');
    rmSync(stableScriptPath(w.h.mcsHome));
    const missing = await hooksStatus({
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      source: w.h.source,
      seams: { tmpdir: () => w.h.root },
    });
    expect(missing.script).toMatchObject({ state: 'missing', sha256: null });
  }, 60_000);
});
