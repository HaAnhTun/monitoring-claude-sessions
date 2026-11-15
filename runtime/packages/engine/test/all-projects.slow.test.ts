// All-projects discovery against the performance budget of CAW design 03 2.7: forty project folders of 250 sessions each (10,000
// main files, all older than the window) cost one listing, a short look into the folders that are hot, and a full sweep that stays
// within a bound, and a second sweep over an unchanged home finds nothing and creates no work. The budgets are the measured warm
// numbers with a wide margin for a cold cache and a busy machine, times `MCS_PERF_FACTOR`. Every file is synthetic.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { FakeClock, TranscriptBuilder, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../src/db/open.ts';
import { createIngestWriter, type IngestWriterHandle } from '../src/ingest/writer.ts';
import { listProjectFolders } from '../src/ingest/transcripts/discover-projects.ts';
import { createTranscriptImporter, type TranscriptImporter } from '../src/ingest/transcripts/importer.ts';

const makeTemp = useTempDirs();
const PERF = Math.max(1, Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1);
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = { instanceId: INSTANCE_ID };
const HOUR = 3_600_000;
const FOLDERS = 40;
const SESSIONS_PER_FOLDER = 250;
const HOT_FOLDERS = 3;
const FULL_SWEEP_MS = 60_000;

/** The numbers of design 03 2.7 (warm: 1 ms, about 3 ms a folder, 91 ms for 10,000 files) with room for a cold first sweep. */
const BUDGET = {
  listMs: 100 * PERF,
  hotTickMs: 500 * PERF,
  fullSweepMs: 3000 * PERF,
};

const opened: InstanceDb[] = [];
const writers: IngestWriterHandle[] = [];
const importers: TranscriptImporter[] = [];

afterEach(async () => {
  for (const importer of importers.splice(0)) importer.close();
  for (const writer of writers.splice(0)) await writer.close();
  for (const db of opened.splice(0)) db.close();
});

const sessionId = (folder: number, n: number): string =>
  `${String(folder).padStart(4, '0')}${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

interface Home {
  readonly root: string;
  readonly projects: string;
  readonly now: number;
  /** The folders that hold one session inside the window. */
  readonly hot: readonly string[];
}

/** 40 folders of 250 old sessions; the first three folders also hold one session of the last hour. */
function buildHome(): Home {
  const root = path.join(makeTemp('all-projects-slow').path, 'claude-home');
  const projects = path.join(root, 'projects');
  const now = Date.now();
  const old = new Date(now - 40 * HOUR);
  const hot: string[] = [];
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    const name = `D--work-p${String(folder)}`;
    const dir = path.join(projects, name);
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < SESSIONS_PER_FOLDER; n += 1) {
      const file = path.join(dir, `${sessionId(folder, n)}.jsonl`);
      writeFileSync(file, '{"type":"user"}\n');
      utimesSync(file, old, old);
    }
    if (folder < HOT_FOLDERS) {
      const id = sessionId(folder, SESSIONS_PER_FOLDER);
      const file = path.join(dir, `${id}.jsonl`);
      new TranscriptBuilder({ sessionId: id, cwd: `D:/work/p${String(folder)}`, startMs: now - HOUR })
        .user('a recent prompt')
        .assistant({ messageId: `msg_${String(folder)}`, stop: 'end_turn' })
        .write(file);
      utimesSync(file, new Date(now - HOUR / 2), new Date(now - HOUR / 2));
      hot.push(name);
    }
  }
  return { root, projects, now, hot };
}

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await run();
  return { result, ms: performance.now() - started };
}

describe('all-projects discovery over 10,000 sessions in 40 folders', () => {
  it('lists the folders, sweeps them all once, looks only into the hot ones after that, and a second sweep creates no work', async () => {
    const home = buildHome();
    const clock = new FakeClock(home.now);
    const db = openInstanceDb({
      path: path.join(makeTemp('all-projects-slow-db').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock,
    });
    opened.push(db);
    const writer = createIngestWriter({
      db,
      scope: SCOPE,
      retryBaseMs: 1,
      retryMaxMs: 2,
      sleep: () => Promise.resolve(),
    });
    writers.push(writer);
    const importer = createTranscriptImporter({
      db,
      scope: SCOPE,
      writer,
      clock,
      transcriptsDir: null,
      projectScope: 'all',
      projectsRoot: home.projects,
      fullSweepIntervalMs: FULL_SWEEP_MS,
    });
    importers.push(importer);

    const listing = await timed(() => listProjectFolders(home.projects));
    expect(listing.result.folders).toHaveLength(FOLDERS);
    expect(listing.ms).toBeLessThan(BUDGET.listMs);

    // the first call is the full sweep: every folder, the three recent sessions are the only ones that are tracked
    const first = await timed(() => importer.discover());
    expect(first.result).toMatchObject({
      folders: FOLDERS,
      sessions: HOT_FOLDERS,
      newFiles: HOT_FOLDERS,
      missingDir: false,
      truncatedFolders: 0,
    });
    expect(first.ms).toBeLessThan(BUDGET.fullSweepMs);

    // a quiet tick: only the folders that hold an active file are looked into, and nothing new is found
    const tick = await timed(() => importer.discover());
    expect(tick.result).toMatchObject({ folders: HOT_FOLDERS, sessions: HOT_FOLDERS, newFiles: 0 });
    expect(tick.ms).toBeLessThan(BUDGET.hotTickMs);

    // let the importer finish the three recent sessions, then sweep everything again
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = importer.work()[0];
      if (next === undefined) break;
      await importer.runSlice(next, performance.now() + 50);
    }
    await writer.flushNow();
    clock.advance(FULL_SWEEP_MS);
    const second = await timed(() => importer.discover());
    expect(second.result).toMatchObject({ folders: FOLDERS, newFiles: 0, truncatedFolders: 0 });
    expect(second.ms).toBeLessThan(BUDGET.fullSweepMs);
    expect(importer.work()).toEqual([]);
    expect(importer.stats().filesTracked).toBe(HOT_FOLDERS);
  }, 120_000);
});
