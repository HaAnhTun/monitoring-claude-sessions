// The two readers of an instance on one real instance (01 6.1, 03 12.2; DA-T-CLI-1, T-CLI-05): the same fixture is read through
// the `ApiReader` (a real server process started by the CLI, a real loopback connection) and through the `DbReader` (the same
// database, read-only, the same engine query functions). Every method of `InstanceReader` must answer identical JSON in both modes
// except `asOfSeq` and the fields that depend on the moment of the call, and both are validated with the response schemas of
// the routes by the readers themselves. Then the instance is stopped and read again: the mode follows, and a read changes no
// byte of the workspace. A second instance proves that a reader never returns a row of another one. All data is synthetic.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  ExportLineSchema,
  McsError,
  routes,
  type ExportLine,
  type ExportQuery,
  type InstanceFile,
  type SessionSummary,
} from '@mcs/shared';
import {
  allocatePort,
  buildDemo,
  buildTaskWorkspace,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  runCli,
  snapshotTree,
  startInstance,
  makeTempDir,
  waitFor,
  type DemoLetter,
  type DemoResult,
  type StartedInstance,
} from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { openInstanceDb } from '../src/db/open.ts';
import { createApiReader } from '../src/reader/api-reader.ts';
import { openDbReader } from '../src/reader/db-reader.ts';
import { openInstanceReader, type InstanceReader, type ReaderDeps } from '../src/reader/open.ts';
import { readInstanceFile } from '../src/workspace/adopt.ts';
import { resolveWorkspace, type WorkspaceRef } from '../src/workspace/paths.ts';

/** The one temp tree of the file: the instance runs in it for all tests, so it is removed after the last one, not after each. */
const temp = makeTempDir('readers-int');
const SLUG = 'readers';
const LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** A synthetic price per million tokens; the numbers are invented and carry no meaning. */
const PRICES = [
  {
    match: '*',
    effectiveFrom: '2026-01-01',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWrite5mPerMTok: 3.75,
    cacheWrite1hPerMTok: 6,
  },
];

interface Live {
  readonly root: string;
  readonly repo: string;
  readonly ws: WorkspaceRef;
  readonly instance: InstanceFile;
  readonly demo: DemoResult;
  readonly env: Record<string, string>;
  readonly port: number;
  readonly started: StartedInstance;
  readonly deps: ReaderDeps;
}

afterAll(async () => {
  await killAllTracked();
  temp.remove();
});

function describeCli(result: { code: number; stdout: string; stderr: string }): string {
  return `exit ${String(result.code)}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 600)}`;
}

/** True when every transcript file of a session detail body is imported up to its end. */
function isSettled(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return false;
  return body.files.every(
    (file: unknown) =>
      typeof file === 'object' &&
      file !== null &&
      'behindBytes' in file &&
      file.behindBytes === 0 &&
      'state' in file &&
      file.state === 'active',
  );
}

/** A real instance on the eight demo sessions, started through the CLI, with prices configured and every transcript imported. */
async function startLive(): Promise<Live> {
  const root = temp.path;
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? path.join(root, 'mcs-home');
  for (const dir of [mcsHome, env['HOME'] ?? path.join(root, 'home')]) mkdirSync(dir, { recursive: true });
  // an hour of age keeps the demo sessions in a state that does not change while the test runs
  const demo = await buildDemo({ root, nowMs: Date.now() - 60 * 60_000 });
  const cli = (args: readonly string[]): ReturnType<typeof runCli> => runCli(args, { mcsHome, env });
  const seed = {
    ...Object.fromEntries(
      Object.entries(demo.configJson).filter(
        ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
      ),
    ),
    panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: false },
  };
  const seedFile = path.join(root, 'readers.seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const port = await allocatePort();
  const init = await cli([
    'init',
    '--name',
    'Readers',
    '--slug',
    SLUG,
    '--repo',
    demo.repo,
    '--port',
    String(port),
    '--config',
    seedFile,
  ]);
  if (init.code !== 0) throw new Error(`init ${describeCli(init)}`);
  const configure = await cli([
    'configure',
    '--task',
    SLUG,
    '--repo',
    demo.repo,
    '--set',
    `pricing.models=${JSON.stringify(PRICES)}`,
    '--reason',
    'reader integration fixture',
  ]);
  if (configure.code !== 0) throw new Error(`configure ${describeCli(configure)}`);
  const started = await startInstance({ repo: demo.repo, slug: SLUG, env }, { port });
  const get = async (urlPath: string): Promise<{ status: number; body: unknown }> => {
    const reply = await httpRequest(port, urlPath);
    try {
      return { status: reply.status, body: JSON.parse(reply.body) };
    } catch {
      return { status: reply.status, body: reply.body };
    }
  };
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=100&range=all&includeUnmatched=1`);
      const page = routes.listSessions.response.safeParse(reply.body);
      return reply.status === 200 && page.success && page.data.items.length >= LETTERS.length;
    },
    { what: `${String(LETTERS.length)} sessions in the list`, timeoutMs: 90_000, intervalMs: 250 },
  );
  await waitFor(
    async () => {
      for (const letter of LETTERS) {
        const reply = await get(`/api/v3/sessions/${demo.sessions[letter].sessionId}`);
        if (reply.status !== 200 || !isSettled(reply.body)) return false;
      }
      return true;
    },
    { what: 'every transcript file imported', timeoutMs: 90_000, intervalMs: 250 },
  );
  // the chain log and the lifecycle sweeps add their evidence after the files are imported: wait until the change log stops growing
  let lastHead = -1;
  let quietSince = Date.now();
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=1`);
      const head = routes.listSessions.response.safeParse(reply.body);
      if (!head.success) return false;
      if (head.data.asOfSeq !== lastHead) {
        lastHead = head.data.asOfSeq;
        quietSince = Date.now();
      }
      return Date.now() - quietSince >= 2500;
    },
    { what: 'the change log to be quiet', timeoutMs: 60_000, intervalMs: 300 },
  );
  const ws = resolveWorkspace(path.join(demo.repo, '.claude', 'monitor', 'tasks'), SLUG);
  const instance = await readInstanceFile(ws);
  if (instance === null) throw new Error('the workspace has no instance.json');
  const skillDir = defaultSkillDir();
  const deps: ReaderDeps = {
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    env,
    clock: { now: () => Date.now() },
  };
  return { root, repo: demo.repo, ws, instance, demo, env, port, started, deps };
}

// ---- comparing the two answers --------------------------------------------------------------------------------------------------------

/** The keys whose value depends on the moment of the call, and the change-log head the answer was read at. */
// (a cursor carries the time bound of the page it came from, and a search continuation is a random handle: two calls give two strings)
const MOMENT_KEYS: ReadonlySet<string> = new Set([
  'asOfSeq',
  'asOf',
  'generatedAt',
  'elapsedMs',
  'evaluatedAt',
  'exportedAt',
  'nextCursor',
  'newerCursor',
  'continuation',
]);

/** The bounds of a `window` object: a preset resolves against the clock of the call, so two calls a moment apart differ. */
const WINDOW_KEYS: ReadonlySet<string> = new Set(['from', 'to']);

/** The JSON of an answer without the fields that are relative to the moment it was given. */
function scrub(value: unknown, parent = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, parent));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !MOMENT_KEYS.has(key) && !(parent === 'window' && WINDOW_KEYS.has(key)))
        .map(([key, item]) => [key, scrub(item, key)]),
    );
  }
  return value;
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

async function bothModes<T>(
  api: InstanceReader,
  db: InstanceReader,
  ask: (reader: InstanceReader) => Promise<T>,
): Promise<T> {
  const fromApi = await ask(api);
  const fromDb = await ask(db);
  expect(scrub(plain(fromDb))).toEqual(scrub(plain(fromApi)));
  return fromApi;
}

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; reason: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError)
      return { code: error.code, reason: error.details?.['reason'], message: error.message };
    throw error;
  }
  throw new Error('expected a rejection');
}

function memory(): { out: Writable; lines: () => string[] } {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return {
    out,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}

function exportLines(lines: readonly string[]): ExportLine[] {
  return lines.map((line) => ExportLineSchema.parse(JSON.parse(line)));
}

describe('InstanceReader: the same answers from the API and from the database', () => {
  // one instance for all tests; the test that stops it runs last
  let live: Live;
  beforeAll(async () => {
    live = await startLive();
  }, 240_000);

  it('answers every method with identical JSON in both modes, validated by the route schemas', async () => {
    const api = createApiReader({
      base: `http://127.0.0.1:${String(live.port)}`,
      instanceId: live.instance.instanceId,
    });
    // a connection to the database of a running instance: the server holds the writer, this one only reads
    const db = await openDbReader(live.ws, live.instance.instanceId, live.deps);
    try {
      expect([api.mode, db.mode]).toEqual(['api', 'db']);
      const ids = LETTERS.map((letter) => live.demo.sessions[letter].sessionId);

      const everything = {
        includeTotal: true,
        limit: 200,
        sort: 'lastActivity',
        range: 'all',
        includeUnmatched: true,
      } as const;
      const page = await bothModes(api, db, (r) => r.sessions(everything as never));
      expect(page.items.map((item: SessionSummary) => item.id).sort()).toEqual([...ids].sort());
      expect(page.total).toBe(LETTERS.length);
      await bothModes(api, db, (r) =>
        r.sessions({ limit: 3, sort: 'tokens', range: 'all', includeUnmatched: true } as never),
      );
      await bothModes(api, db, (r) =>
        r.sessions({
          limit: 50,
          sort: 'lastActivity',
          range: 'all',
          state: ['failed', 'completed', 'stale'],
          includeUnmatched: true,
        } as never),
      );
      await bothModes(api, db, (r) =>
        r.sessions({ limit: 50, sort: 'errors', range: 'all', hasErrors: true, includeUnmatched: true } as never),
      );

      for (const id of ids) {
        const detail = await bothModes(api, db, (r) => r.session(id));
        expect(detail?.id).toBe(id);
        expect(detail?.auditRefs).toBeInstanceOf(Array);
        await bothModes(api, db, (r) => r.sessionAgents(id, { limit: 200 }));
        await bothModes(api, db, (r) => r.sessionEvents(id, { limit: 20, dir: 'desc' } as never));
        await bothModes(api, db, (r) => r.explainCompletion({ sessionId: id }));
      }
      expect(await bothModes(api, db, (r) => r.session('dddddddd-0000-4000-8000-000000000009'))).toBeNull();

      const usage = await bothModes(api, db, (r) =>
        r.usage({ groupBy: 'model', limit: 50, range: 'all', includeCost: true } as never),
      );
      expect(usage.cost).not.toBeNull();
      await bothModes(api, db, (r) =>
        r.usage({ groupBy: 'session', limit: 50, range: 'all', includeCost: true } as never),
      );
      await bothModes(api, db, (r) => r.usage({ groupBy: 'none', limit: 50, range: 'all' } as never));
      await bothModes(api, db, (r) =>
        r.series({ bucket: 'day', tzOffsetMinutes: 0, groupBy: 'none', range: 'all' } as never),
      );
      const tools = await bothModes(api, db, (r) => r.tools({ groupBy: 'tool', limit: 50, range: 'all' } as never));
      expect(tools.items.length).toBeGreaterThan(0);

      await bothModes(api, db, (r) => r.errors({ limit: 50 }));
      await bothModes(api, db, (r) => r.overview({ range: 'all', includeUnmatched: true } as never));
      await bothModes(api, db, (r) => r.alerts({ status: ['open', 'resolved'], limit: 50 } as never));

      // the completion evidence of a label, of an attempt part, and the two refusals
      const label = page.items[0]?.label ?? '';
      await bothModes(api, db, (r) => r.explainCompletion({ label }));
      const unknownApi = await failureOf(api.explainCompletion({ sessionId: 'dddddddd-0000-4000-8000-000000000009' }));
      const unknownDb = await failureOf(db.explainCompletion({ sessionId: 'dddddddd-0000-4000-8000-000000000009' }));
      expect(unknownDb).toEqual(unknownApi);
      expect(unknownApi).toMatchObject({ code: 'NOT_FOUND', reason: 'target_not_found' });
      const invalidApi = await failureOf(api.explainCompletion({ label: '' }));
      const invalidDb = await failureOf(db.explainCompletion({ label: '' }));
      expect(invalidDb).toEqual(invalidApi);
      expect(invalidApi).toMatchObject({ code: 'USAGE', reason: 'target_invalid' });

      // transcript text: the window and both searches read the transcript files named by the database
      const first = ids[0] ?? '';
      const window = await bothModes(api, db, (r) =>
        r.transcriptWindow({ sessionId: first, agent: 'main', after: -1, limit: 10 }),
      );
      expect(window.events.length).toBeGreaterThan(0);
      const instanceSearch = await bothModes(api, db, (r) =>
        r.searchTranscripts({ q: 'FIXTURE', limit: 20, budgetMs: 5000 }),
      );
      expect(instanceSearch.matches.length).toBeGreaterThan(0);
      await bothModes(api, db, (r) => r.searchTranscript({ session: first, q: 'FIXTURE', limit: 20, budgetMs: 5000 }));

      // an answer both modes refuse in the same words
      for (const ask of [
        (r: InstanceReader) => r.sessionAgents('dddddddd-0000-4000-8000-000000000009', { limit: 10 }),
        (r: InstanceReader) => r.overview({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
        (r: InstanceReader) => r.sessions({ limit: 10, sort: 'lastActivity', cursor: 'bogus' } as never),
        (r: InstanceReader) =>
          r.transcriptWindow({ sessionId: 'dddddddd-0000-4000-8000-000000000009', agent: 'main', after: -1 }),
      ]) {
        expect(await failureOf(ask(db))).toEqual(await failureOf(ask(api)));
      }
    } finally {
      await api.close();
      await db.close();
    }
  }, 240_000);

  it('exports the same lines in both modes, and the API export is checked against its own trailer', async () => {
    const api = createApiReader({
      base: `http://127.0.0.1:${String(live.port)}`,
      instanceId: live.instance.instanceId,
    });
    const db = await openDbReader(live.ws, live.instance.instanceId, live.deps);
    try {
      for (const query of [
        {},
        { includeContent: true },
        { include: ['sessions', 'usage'], redaction: 'strict' },
      ] as ExportQuery[]) {
        const fromApi = memory();
        const fromDb = memory();
        const apiSummary = await api.exportTo(query, fromApi.out);
        const dbSummary = await db.exportTo(query, fromDb.out);
        const apiLines = exportLines(fromApi.lines());
        const dbLines = exportLines(fromDb.lines());
        expect(apiSummary.lines).toBe(apiLines.length);
        expect(dbSummary.lines).toBe(dbLines.length);
        expect(dbSummary.counts).toEqual(apiSummary.counts);
        expect(dbSummary.includeContent).toBe(query.includeContent === true);
        // every line but the header (its time) and the trailer (the checksum covers the header)
        const body = (lines: ExportLine[]): unknown => scrub(plain(lines.slice(1, -1)));
        expect(body(dbLines)).toEqual(body(apiLines));
        expect(apiLines.at(0)?.type).toBe('header');
        expect(apiLines.at(-1)?.type).toBe('trailer');
      }
    } finally {
      await api.close();
      await db.close();
    }
  }, 240_000);

  it('a reader of one instance never returns a row of another, and a port taken over by another instance is refused', async () => {
    // a second instance in the same repository, with its own database and its own sessions
    const other = buildTaskWorkspace(live.repo, {
      slug: 'other',
      config: { title: 'FIXTURE other' },
      instance: {
        slug: 'other',
        instanceId: '33333333-3333-4333-8333-333333333333',
        runtimeVersion: '4.0.0',
        dbSchemaVersion: 1,
      },
    });
    mkdirSync(path.join(other, 'data'), { recursive: true });
    const otherDb = openInstanceDb({
      path: path.join(other, 'data', 'monitor.db'),
      expectedInstanceId: '33333333-3333-4333-8333-333333333333',
      mode: 'serve',
      runtimeVersion: '4.0.0',
    });
    const FOREIGN = 'eeeeeeee-0000-4000-8000-000000000001';
    const at = Date.now() - 3_600_000;
    otherDb.driver
      .prepare(
        `INSERT INTO sessions (session_uid, label, label_source, matched, first_seen_at, started_at, last_activity_at, updated_at)
         VALUES (:uid, 'FIXTURE foreign session', 'rule', 1, :at, :at, :at, :at)`,
      )
      .run({ uid: FOREIGN, at });
    otherDb.close();
    const otherWs = resolveWorkspace(path.join(live.repo, '.claude', 'monitor', 'tasks'), 'other');

    const mine = await openDbReader(live.ws, live.instance.instanceId, live.deps);
    const theirs = await openDbReader(otherWs, '33333333-3333-4333-8333-333333333333', live.deps);
    const api = createApiReader({
      base: `http://127.0.0.1:${String(live.port)}`,
      instanceId: live.instance.instanceId,
    });
    try {
      const query = { limit: 200, sort: 'lastActivity', range: 'all', includeUnmatched: true } as never;
      const mineIds = (await mine.sessions(query)).items.map((item) => item.id);
      const theirIds = (await theirs.sessions(query)).items.map((item) => item.id);
      const apiIds = (await api.sessions(query)).items.map((item) => item.id);
      expect(theirIds).toEqual([FOREIGN]);
      expect(mineIds).not.toContain(FOREIGN);
      expect(apiIds).not.toContain(FOREIGN);
      expect(await mine.session(FOREIGN)).toBeNull();
      expect(await api.session(FOREIGN)).toBeNull();
      expect(await theirs.session(live.demo.sessions.A.sessionId)).toBeNull();
      // the database of one instance under the identity of another is refused, and so is a server that answers for another instance
      expect((await failureOf(openDbReader(otherWs, live.instance.instanceId, live.deps))).code).toBe(
        'IDENTITY_MISMATCH',
      );
      expect((await failureOf(openDbReader(live.ws, '33333333-3333-4333-8333-333333333333', live.deps))).code).toBe(
        'IDENTITY_MISMATCH',
      );
      const taken = createApiReader({
        base: `http://127.0.0.1:${String(live.port)}`,
        instanceId: '33333333-3333-4333-8333-333333333333',
      });
      expect((await failureOf(taken.sessions(query))).code).toBe('IDENTITY_MISMATCH');
    } finally {
      await mine.close();
      await theirs.close();
      await api.close();
    }
  }, 240_000);
  it('follows the probe: the API while the instance runs, the database after it stops, and a read changes no byte', async () => {
    const running = await openInstanceReader(live.ws, live.deps);
    expect(running.mode).toBe('api');
    const viaApi = await running.sessions({
      limit: 50,
      sort: 'lastActivity',
      range: 'all',
      includeUnmatched: true,
    } as never);
    await running.close();

    await live.started.stop();
    const sample = (): { tree: string; mtime: number; size: number } => {
      const file = path.join(live.ws.dir, 'data', 'monitor.db');
      return {
        tree: snapshotTree(live.ws.dir, { exclude: ['data/monitor.db-shm'] }),
        mtime: statSync(file).mtimeMs,
        size: statSync(file).size,
      };
    };
    const before = sample();
    const stopped = await openInstanceReader(live.ws, live.deps);
    try {
      expect(stopped.mode).toBe('db');
      const viaDb = await stopped.sessions({
        limit: 50,
        sort: 'lastActivity',
        range: 'all',
        includeUnmatched: true,
      } as never);
      expect(scrub(plain(viaDb))).toEqual(scrub(plain(viaApi)));
      const ids = LETTERS.map((letter) => live.demo.sessions[letter].sessionId);
      expect(sample()).toEqual(before);
      for (const id of ids) {
        await stopped.session(id);
        await stopped.sessionAgents(id, { limit: 200 });
        await stopped.sessionEvents(id, { limit: 20, dir: 'desc' } as never);
        await stopped.explainCompletion({ sessionId: id });
      }
      await stopped.usage({ groupBy: 'model', limit: 50, range: 'all', includeCost: true } as never);
      await stopped.series({ bucket: 'day', tzOffsetMinutes: 0, groupBy: 'none', range: 'all' } as never);
      await stopped.tools({ groupBy: 'tool', limit: 50, range: 'all' } as never);
      await stopped.errors({ limit: 50 });
      await stopped.overview({ range: 'all' } as never);
      await stopped.alerts({ status: ['open'], limit: 10 } as never);
      expect(sample()).toEqual(before);
      // text from the transcript files works offline too, on a private copy of the database that close removes
      const window = await stopped.transcriptWindow({
        sessionId: ids[0] ?? '',
        agent: 'main',
        after: -1,
        limit: 5,
      });
      expect(window.events.length).toBeGreaterThan(0);
      await stopped.searchTranscripts({ q: 'FIXTURE', limit: 5, budgetMs: 2000 });
      await stopped.exportTo({ includeContent: true }, memory().out);
      expect(sample()).toEqual(before);
    } finally {
      await stopped.close();
    }
    expect(sample()).toEqual(before);
  }, 240_000);
});
