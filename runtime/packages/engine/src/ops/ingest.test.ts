// `ops.ingest.replay` (01 6.4, T-CLI-11 at the operation layer; 02 2.7): a dry run writes nothing, a stopped instance has its
// cursors reset by this process under the task mutex, a running one is asked through the control channel, `--from` is checked
// before anything else, and the audit entry has the template of 01 7.2. Everything lives in temporary folders; the database
// is a real SQLite file made by the real engine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import type { ControlRequest } from '@mcs/shared/protocol';
import { FakeClock, FIXTURE_EPOCH_MS, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../db/repos/spool-cursors.ts';
import { withWriteTx } from '../db/write.ts';
import type { Logger } from '../log/logger.ts';
import { replay, replayLines } from './ingest.ts';
import type { ControlAttempt, ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111'; // FIXTURE instance id
const SCOPE = { instanceId: ID };
const SEG_1 = 'hooks-20261011T08Z.ndjson';
const SEG_2 = 'hooks-20261011T09Z.ndjson';
const SEG_3 = 'hooks-20261011T10Z.ndjson';
const TOKEN = 'a'.repeat(64);
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};
// the folder of the engine's own migrations: the fake runtime folder of the context has none
const DEPS = { migrations: {} };

function probeResult(over: Partial<ProbeResult>): ProbeResult {
  return {
    state: 'stopped',
    engine: null,
    pid: null,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: '',
    ...over,
  };
}

interface World {
  readonly ctx: OpContext;
  readonly ws: string;
  readonly spool: string;
  readonly clock: FakeClock;
  readonly audit: () => string;
  /** Opens the real database (made at the first call) for the duration of `body`. */
  withDb<T>(body: (db: InstanceDb, cursors: SpoolCursorsRepo) => T): T;
}

function cursor(segment: string, offsetBytes: number, sealed: boolean): NewSpoolCursor {
  return {
    segment,
    offsetBytes,
    sizeSeen: offsetBytes,
    ino: null,
    headHash: null,
    lines: 3,
    partialBytes: 0,
    sealed,
    errors: 0,
    oldestReceivedAt: null,
    newestReceivedAt: null,
    drainedAt: null,
  };
}

/** A task with three spool segments; `database` also makes the database, with the first segment read to its end. */
function world(options: { database: boolean }): World {
  const root = makeTemp('ops-ingest').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const ws = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId: ID },
  });
  const spool = path.join(ws, 'data', 'spool');
  mkdirSync(spool, { recursive: true });
  for (const [name, text] of [
    [SEG_1, 'one\n'],
    [SEG_2, 'two-two\n'],
    [SEG_3, 'three\n'],
  ] as const) {
    writeFileSync(path.join(spool, name), text);
  }
  const skillDir = defaultSkillDir();
  const clock = new FakeClock(Date.UTC(2026, 9, 19, 12));
  const ctx: OpContext = {
    repo,
    root: tasksRoot,
    skillDir,
    runtimeDir: path.join(root, 'no-runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
  const dbFile = path.join(ws, 'data', 'monitor.db');
  const withDb = <T>(body: (db: InstanceDb, cursors: SpoolCursorsRepo) => T): T => {
    const db = openInstanceDb({
      path: dbFile,
      expectedInstanceId: ID,
      mode: 'serve',
      runtimeVersion: '4.0.0',
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    try {
      return body(db, new SpoolCursorsRepo(db));
    } finally {
      db.close();
    }
  };
  if (options.database) {
    withDb((db, cursors) => {
      withWriteTx(db, SCOPE, (tx) => {
        cursors.save(SCOPE, tx, cursor(SEG_1, 4, true));
      });
    });
  }
  return {
    ctx,
    ws,
    spool,
    clock,
    audit: () => {
      const file = path.join(ws, 'audit', 'changes.md');
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
    withDb,
  };
}

const SNAPSHOT = { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] };

async function refusal(run: Promise<unknown>): Promise<McsError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('ops.ingest.replay: the dry run', () => {
  it('lists the selected segments with their bytes and cursors and writes nothing', async () => {
    const w = world({ database: true });
    const before = snapshotTree(w.ws, SNAPSHOT);

    const all = await replay(w.ctx, { task: 'demo' }, DEPS);
    expect(all).toMatchObject({ applied: false, mode: 'dry-run', from: null, segmentsReset: 0, totalBytes: 18 });
    expect(all.segments).toEqual([
      { segment: SEG_1, bytes: 4, offset: 4, sealed: true },
      { segment: SEG_2, bytes: 8, offset: 0, sealed: false },
      { segment: SEG_3, bytes: 6, offset: 0, sealed: false },
    ]);

    const fromSecond = await replay(w.ctx, { task: 'demo', from: SEG_2 }, DEPS);
    expect(fromSecond.segments.map((s) => s.segment)).toEqual([SEG_2, SEG_3]);
    expect(fromSecond.from).toBe(SEG_2);

    expect(snapshotTree(w.ws, SNAPSHOT)).toBe(before);
    expect(w.audit()).toBe('');
    expect(replayLines(all).join('\n')).toContain(`${SEG_2}  8 bytes`);
  });

  it('plans from the files alone when the task has no database yet', async () => {
    const w = world({ database: false });
    const before = snapshotTree(w.ws);
    const result = await replay(w.ctx, { task: 'demo' }, DEPS);
    expect(result.mode).toBe('dry-run');
    expect(result.segments.map((s) => [s.segment, s.offset, s.sealed])).toEqual([
      [SEG_1, 0, false],
      [SEG_2, 0, false],
      [SEG_3, 0, false],
    ]);
    expect(existsSync(path.join(w.ws, 'data', 'monitor.db'))).toBe(false);
    expect(snapshotTree(w.ws)).toBe(before);
  });
});

describe('ops.ingest.replay: --from', () => {
  it('a name that is not a segment name is a usage error before anything is read; an unknown segment is NOT_FOUND', async () => {
    const w = world({ database: true });
    const before = snapshotTree(w.ws, SNAPSHOT);
    for (const bad of ['../hooks-20261011T08Z.ndjson', 'hooks-20261011T08Z.jsonl', 'nonsense', '']) {
      const error = await refusal(replay(w.ctx, { task: 'demo', from: bad, yes: true }, DEPS));
      expect(error.code, bad).toBe('USAGE');
    }
    const missing = await refusal(replay(w.ctx, { task: 'demo', from: 'hooks-20261011T23Z.ndjson' }, DEPS));
    expect(missing.code).toBe('NOT_FOUND');
    const missingApply = await refusal(
      replay(w.ctx, { task: 'demo', from: 'hooks-20261011T23Z.ndjson', yes: true }, DEPS),
    );
    expect(missingApply.code).toBe('NOT_FOUND');
    expect(snapshotTree(w.ws, SNAPSHOT)).toBe(before);
    expect(w.audit()).toBe('');
  });

  it('a task name with path characters is refused', async () => {
    const w = world({ database: false });
    const error = await refusal(replay(w.ctx, { task: '../demo' }, DEPS));
    expect(error.code).toBe('SLUG_INVALID');
  });
});

describe('ops.ingest.replay: a stopped instance', () => {
  it('resets the cursors of the selected segments and audits the replay with the template of 01 7.2', async () => {
    const w = world({ database: true });
    w.withDb((db, cursors) => {
      withWriteTx(db, SCOPE, (tx) => {
        cursors.save(SCOPE, tx, cursor(SEG_2, 8, true));
      });
    });
    const probe = (): Promise<ProbeResult> => Promise.resolve(probeResult({}));

    const result = await replay(w.ctx, { task: 'demo', from: SEG_2, yes: true }, { ...DEPS, probe });
    expect(result).toMatchObject({ applied: true, mode: 'stopped', segmentsReset: 2, from: SEG_2 });

    w.withDb((_db, cursors) => {
      const rows = new Map(cursors.list(SCOPE).map((row) => [row.segment, row] as const));
      expect(rows.get(SEG_1)).toMatchObject({ offsetBytes: 4, sealed: true });
      expect(rows.get(SEG_2)).toMatchObject({ offsetBytes: 0, sealed: false, lines: 0 });
      expect(rows.get(SEG_3)).toMatchObject({ offsetBytes: 0, sealed: false });
    });
    expect(w.audit()).toContain(
      [
        '## 2026-10-19T12:00:00Z | ingest-replay',
        `- Summary: spool replay of 2 segments from ${SEG_2}`,
        '- Reason: not given',
        '- Files changed: none',
        '- Validation: cursors re-read',
        '- Outcome: scheduled',
        '- Unresolved: none',
        '',
      ].join('\n'),
    );
    expect(replayLines(result)[0]).toBe('replay scheduled for 2 segments (duplicates are ignored by event_uid)');
  });

  it('without --from the summary says "all"; the segment files stay on disk', async () => {
    const w = world({ database: true });
    const probe = (): Promise<ProbeResult> => Promise.resolve(probeResult({ state: 'stale' }));
    const result = await replay(w.ctx, { task: 'demo', yes: true }, { ...DEPS, probe });
    expect(result.segmentsReset).toBe(3);
    expect(w.audit()).toContain('- Summary: spool replay of 3 segments from all');
    for (const name of [SEG_1, SEG_2, SEG_3]) expect(existsSync(path.join(w.spool, name))).toBe(true);
  });

  it('a task without a database has nothing to reset: no audit entry, the files stay as they are', async () => {
    const w = world({ database: false });
    const before = snapshotTree(w.ws);
    const probe = (): Promise<ProbeResult> => Promise.resolve(probeResult({}));
    const result = await replay(w.ctx, { task: 'demo', yes: true }, { ...DEPS, probe });
    expect(result).toMatchObject({ applied: true, mode: 'no-database', segmentsReset: 0 });
    expect(replayLines(result)[0]).toContain('no database yet');
    expect(w.audit()).toBe('');
    expect(snapshotTree(w.ws)).toBe(before);
  });
});

describe('ops.ingest.replay: a running instance', () => {
  it('asks the server through the control channel with the token and reports its segment count', async () => {
    const w = world({ database: true });
    mkdirSync(path.join(w.ws, 'run'), { recursive: true });
    writeFileSync(path.join(w.ws, 'run', 'control.token'), `${TOKEN}\n`);
    const sent: ControlRequest[] = [];
    const before = w.withDb((_db, cursors) => JSON.stringify(cursors.list(SCOPE)));
    const result = await replay(
      w.ctx,
      { task: 'demo', from: SEG_2, yes: true },
      {
        ...DEPS,
        probe: () => Promise.resolve(probeResult({ state: 'running', pid: 1 })),
        control: (_address, message) => {
          sent.push(message);
          const reply: ControlAttempt = {
            kind: 'reply',
            response: { v: 1, ok: true, op: 'ingest-replay', segments: 2 },
          };
          return Promise.resolve(reply);
        },
      },
    );
    expect(sent).toEqual([{ v: 1, op: 'ingest-replay', instanceId: ID, token: TOKEN, fromSegment: SEG_2 }]);
    expect(result).toMatchObject({ applied: true, mode: 'running', segmentsReset: 2 });
    // the server owns the database while it runs: this process changed no cursor
    expect(w.withDb((_db, cursors) => JSON.stringify(cursors.list(SCOPE)))).toBe(before);
    expect(w.audit()).toContain(`- Summary: spool replay of 2 segments from ${SEG_2}`);
  });

  it('a refusal or silence of the server is a DB_ERROR and no audit entry is written', async () => {
    const w = world({ database: true });
    mkdirSync(path.join(w.ws, 'run'), { recursive: true });
    writeFileSync(path.join(w.ws, 'run', 'control.token'), TOKEN);
    const error = await refusal(
      replay(
        w.ctx,
        { task: 'demo', yes: true },
        {
          ...DEPS,
          probe: () => Promise.resolve(probeResult({ state: 'running' })),
          control: () => Promise.resolve({ kind: 'refusal', error: 'NOT_READY' }),
        },
      ),
    );
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toContain('NOT_READY');
    expect(w.audit()).toBe('');
  });

  it('without a control token the running server cannot be asked', async () => {
    const w = world({ database: true });
    const error = await refusal(
      replay(
        w.ctx,
        { task: 'demo', yes: true },
        { ...DEPS, probe: () => Promise.resolve(probeResult({ state: 'running' })) },
      ),
    );
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toContain('no control token');
  });

  it('an instance that is starting, stopping or unhealthy is INSTANCE_RUNNING and nothing changes', async () => {
    const w = world({ database: true });
    const before = snapshotTree(w.ws, SNAPSHOT);
    for (const state of ['starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const) {
      const error = await refusal(
        replay(w.ctx, { task: 'demo', yes: true }, { ...DEPS, probe: () => Promise.resolve(probeResult({ state })) }),
      );
      expect(error.code, state).toBe('INSTANCE_RUNNING');
    }
    expect(snapshotTree(w.ws, SNAPSHOT)).toBe(before);
    expect(w.audit()).toBe('');
  });
});
