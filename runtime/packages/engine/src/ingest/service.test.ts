// The pure parts of the ingest service (02 4.10): the error of `untilIdle`, and the mapping of the resolved configuration onto the
// lifecycle thresholds, the import settings and the session rules, and the one thing `start` wires for the schedule (the flush of
// the throttled announcements, CR-WP-35-1). The service over a real workspace is in `packages/engine/test/ingest-service.int.test.ts`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import { DEFAULT_LIFECYCLE_CFG } from '../lifecycle/facts.ts';
import type { Logger } from '../log/logger.ts';
import { createDbSchedulerWith } from '../maintenance/schedule.ts';
import { backfillProjects as realBackfill } from '../projects/backfill.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { DEFAULT_IMPORT_SETTINGS } from './transcripts/importer.ts';
import {
  IngestIdleTimeoutError,
  createIngestService,
  importSettingsOf,
  lifecycleCfgOf,
  sessionRulesOf,
  type IngestService,
  type IngestServiceOptions,
  type IngestStats,
} from './service.ts';

const tempDir = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

/** The configuration of a skill folder whose `runtime/defaults.json` holds `runtimeDefaults`. */
async function configOf(runtimeDefaults: Record<string, unknown> = {}): Promise<ResolvedConfig> {
  const skill = tempDir('ingest-service-unit').path;
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    JSON.stringify({ schema_version: 1, ...runtimeDefaults }),
  );
  return resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: skill });
}

const STATS: IngestStats = {
  queued: 3,
  queuedBytes: 600,
  lastCommitAt: 1,
  failures: 0,
  spoolBytesBehind: 10,
  transcriptBytesBehind: 20,
  backfillRemainingBytes: 30,
  filesTracked: 2,
};

describe('IngestIdleTimeoutError', () => {
  it('is an Error that carries what was pending and is recognised by its name', () => {
    const error = new IngestIdleTimeoutError(STATS);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IngestIdleTimeoutError');
    expect(error.pending).toEqual(STATS);
    expect(error.message).toMatch(/idle/);
  });
});

describe('lifecycleCfgOf', () => {
  it('gives the defaults of 02 7.8 for the shipped configuration', async () => {
    expect(lifecycleCfgOf(await configOf())).toEqual(DEFAULT_LIFECYCLE_CFG);
  });

  it('takes a threshold from the runtime configuration and the legacy keys for the derived ones', async () => {
    const cfg = lifecycleCfgOf(await configOf({ lifecycle: { sweepIntervalMs: 1234, staleAfterSeconds: 600 } }));
    expect(cfg).toMatchObject({
      sweepIntervalMs: 1234,
      staleAfterSeconds: 600,
      activeSeconds: 120,
      pendingToolGraceSeconds: 900,
    });
  });
});

describe('importSettingsOf', () => {
  it('gives the defaults of 02 1.2 for the shipped configuration', async () => {
    expect(importSettingsOf(await configOf())).toEqual(DEFAULT_IMPORT_SETTINGS);
  });

  it('takes the keys that are set', async () => {
    const settings = importSettingsOf(
      await configOf({ import: { sliceMs: 33, lookbackHours: 24, untrackAfterHours: 12 } }),
    );
    expect(settings).toMatchObject({ sliceMs: 33, lookbackHours: 24, untrackAfterHours: 12 });
  });
});

describe('sessionRulesOf', () => {
  it('keeps match and label and reads name and scope loosely', async () => {
    const config = await configOf();
    const withRules: ResolvedConfig = {
      ...config,
      monitor: {
        ...config.monitor,
        session_rules: [
          { match: 'alpha', label: 'A' },
          { match: 'beta', name: 'B', scope: 'any' },
          { match: 'gamma', name: 7, scope: null },
        ],
      },
    };
    expect(sessionRulesOf(withRules)).toEqual([
      { match: 'alpha', label: 'A' },
      { match: 'beta', name: 'B', scope: 'any' },
      { match: 'gamma' },
    ]);
  });

  it('is empty without rules', async () => {
    expect(sessionRulesOf(await configOf())).toEqual([]);
  });
});

// ---- start binds the flush of the throttled announcements (CR-WP-35-1, WP-99) ------------------------------------------------

const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const SESSION = '55555555-5555-4555-8555-555555555555';
const started: { ctx: InstanceContext; service: IngestService }[] = [];

afterEach(async () => {
  for (const { ctx, service } of started.splice(0)) {
    await service.stop(Date.now() + 2000).catch(() => undefined);
    ctx.db.close();
  }
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** An instance with a fixed clock: the window of the throttle moves only when the test moves the clock. */
async function instance(
  options: IngestServiceOptions = {},
): Promise<{ ctx: InstanceContext; clock: FakeClock; service: IngestService }> {
  const root = tempDir('ingest-service-bind').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  const service = createIngestService(ctx, options);
  started.push({ ctx, service });
  return { ctx, clock, service };
}

describe('start binds the flush of the throttled announcements', () => {
  it('the announcements job of the schedule flushes the writer of the service once the window has passed', async () => {
    const { ctx, clock, service } = await instance();
    await service.start();
    const item = (at: number, tie: string): Parameters<typeof service.writer.submit>[0] => ({
      source: 'external',
      bytes: 100,
      items: [
        {
          kind: 'record',
          events: [{ k: 'activity', sessionId: SESSION, agentId: null, stamp: { at, rank: 20, tie }, via: 'user' }],
          rows: [],
        },
      ],
    });
    const upserts = (): number =>
      ctx.db.driver
        .prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE kind = 'session' AND op = 'upsert'")
        .get()?.n ?? -1;
    // the first record creates the session; the second is activity inside the window and is held back
    expect(service.writer.submit(item(NOW - 2000, 'first'))).toBe(true);
    await service.writer.flushNow();
    const created = upserts();
    expect(created).toBe(1);
    expect(service.writer.submit(item(NOW - 1000, 'second'))).toBe(true);
    await service.writer.flushNow();
    expect(upserts()).toBe(created);

    const scheduler = createDbSchedulerWith(ctx, { evaluator: { refresh: () => Promise.resolve(undefined) } });
    await scheduler.runJob('announcements');
    expect(upserts()).toBe(created);
    clock.advance(1000);
    await scheduler.runJob('announcements');
    expect(upserts()).toBe(created + 1);
  });

  it('a service that never started binds nothing: the job does nothing', async () => {
    const { ctx, clock } = await instance();
    const scheduler = createDbSchedulerWith(ctx, { evaluator: { refresh: () => Promise.resolve(undefined) } });
    clock.advance(5000);
    await expect(scheduler.runJob('announcements')).resolves.toBeUndefined();
  });
});

// ---- start fills the project dimension of an older database (CAW design 03 2.5) ----------------------------------------------

describe('start gives the sessions that have no project their project', () => {
  /** A session row with a main transcript file in the folder `dirName` and no project, as a database of before the dimension has them. */
  function seedOldSession(ctx: InstanceContext, dirName: string): void {
    const sessions = new SessionsRepo(ctx.db);
    withWriteTx(ctx.db, ctx.scope, (tx) =>
      sessions.ensure(ctx.scope, tx, { sessionUid: SESSION, projectId: null, startedAt: NOW }),
    );
    const file = `/home/me/.claude/projects/${dirName}/${SESSION}.jsonl`;
    ctx.db.driver
      .prepare(
        `INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
         VALUES (?, ?, 'session', ?, ?, ?)`,
      )
      .run([file, file.toLowerCase(), SESSION, NOW, NOW]);
  }

  const projectOf = (ctx: InstanceContext): string | null | undefined =>
    ctx.db.driver
      .prepare<{ key: string | null }>(
        'SELECT p.project_key AS key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.session_uid = ?',
      )
      .get([SESSION])?.key;

  it('runs the backfill once, and the session then has its project', async () => {
    const calls: string[] = [];
    const { ctx, service } = await instance({
      backfillProjects: (db, scope, o) => {
        calls.push('backfill');
        return realBackfill(db, scope, o);
      },
    });
    seedOldSession(ctx, 'D--Work-App');
    expect(projectOf(ctx)).toBeNull();
    await service.start();
    expect(calls).toEqual(['backfill']);
    expect(projectOf(ctx)).toBe('d--work-app');
  });

  it('starts anyway when the backfill fails', async () => {
    const { ctx, service } = await instance({ backfillProjects: () => Promise.reject(new Error('disk full')) });
    seedOldSession(ctx, 'D--Work-App');
    await expect(service.start()).resolves.toBeUndefined();
    expect(projectOf(ctx)).toBeNull();
  });
});
