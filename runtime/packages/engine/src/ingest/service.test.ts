// The pure parts of the ingest service (02 4.10): the error of `untilIdle`, and the mapping of the resolved configuration onto the
// lifecycle thresholds, the import settings and the session rules, and the one thing `start` wires for the schedule (the flush of
// the throttled announcements, CR-WP-35-1). The service over a real workspace is in `packages/engine/test/ingest-service.int.test.ts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import {
  FakeClock,
  buildClaudeHome,
  useTempDirs,
  waitFor,
  writeRegistryEntry,
  type SessionSpec,
  type TranscriptBuilder,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import { nodeExternalFs } from '../external/fs.ts';
import { DEFAULT_LIFECYCLE_CFG } from '../lifecycle/facts.ts';
import type { Logger } from '../log/logger.ts';
import { createDbSchedulerWith } from '../maintenance/schedule.ts';
import { backfillProjects as realBackfill } from '../projects/backfill.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { routeFilePath } from './routes-file.ts';
import { DEFAULT_IMPORT_SETTINGS } from './transcripts/importer.ts';
import {
  IngestIdleTimeoutError,
  createIngestService,
  importSettingsOf,
  lifecycleCfgOf,
  publishRouteFile,
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

/** What a test may put in the instance it builds: runtime defaults, the sessions of the Claude home, the project folder of the repo. */
interface InstanceExtras {
  /** Merged into `runtime/defaults.json` of the skill folder (`{ projects: { scope: 'all' } }`). */
  readonly runtimeDefaults?: Record<string, unknown>;
  /** Built into the Claude home before the context is: `(repo) => sessions`. */
  readonly sessions?: (repo: string) => SessionSpec[];
}

/** An instance with a fixed clock: the window of the throttle moves only when the test moves the clock. */
async function instance(
  options: IngestServiceOptions = {},
  extras: InstanceExtras = {},
): Promise<{ ctx: InstanceContext; clock: FakeClock; service: IngestService; claudeHome: string; repo: string }> {
  const root = tempDir('ingest-service-bind').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    `${JSON.stringify({ schema_version: 1, ...extras.runtimeDefaults })}\n`,
  );
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock });
  const claudeHome = path.join(root, 'claude-home');
  if (extras.sessions !== undefined) buildClaudeHome(claudeHome, { nowMs: NOW, sessions: extras.sessions(repo) });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  const service = createIngestService(ctx, options);
  started.push({ ctx, service });
  return { ctx, clock, service, claudeHome, repo };
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

// ---- scope all: the user instance reads every project (CAW design 03 2.2, 2.3) -----------------------------------------------

describe('the ingest service in scope all', () => {
  const ALPHA = 'D--work-alpha';
  const BETA = 'D--work-beta';
  const RECENT_A = '11111111-1111-4111-8111-111111111111';
  const RECENT_B = '33333333-3333-4333-8333-333333333333';
  const OLD = '22222222-2222-4222-8222-222222222222';
  const HOUR = 3_600_000;
  const ALL = { projects: { scope: 'all' } };

  const prompt = (b: TranscriptBuilder, text: string): void => {
    b.user(text).assistant({ messageId: `msg_${text.replace(/\W/g, '')}` });
  };

  /** A recent session in two projects and one older than the window in the second. */
  const threeSessions = (): SessionSpec[] => [
    {
      id: RECENT_A,
      project: ALPHA,
      cwd: 'D:/work/alpha',
      mtimeAgeMs: HOUR,
      build: (b) => {
        prompt(b, 'alpha');
      },
    },
    {
      id: RECENT_B,
      project: BETA,
      cwd: 'D:/work/beta',
      mtimeAgeMs: 2 * HOUR,
      build: (b) => {
        prompt(b, 'beta');
      },
    },
    {
      id: OLD,
      project: BETA,
      cwd: 'D:/work/beta',
      mtimeAgeMs: 30 * HOUR,
      build: (b) => {
        prompt(b, 'old');
      },
    },
  ];

  const tracked = (ctx: InstanceContext, id: string): number =>
    ctx.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM transcript_files WHERE session_uid = ?').get([id])
      ?.n ?? -1;

  it('reads the sessions inside the window of every project folder, and writes no route file for the hooks', async () => {
    const { ctx, clock, service } = await instance({}, { runtimeDefaults: ALL, sessions: threeSessions });
    await service.start();
    await service.untilIdle({ timeoutMs: 20_000 });
    expect([tracked(ctx, RECENT_A), tracked(ctx, RECENT_B), tracked(ctx, OLD)]).toEqual([1, 1, 0]);
    expect(existsSync(routeFilePath(ctx.mcsHome, ctx.instanceId))).toBe(false);
    await service.stop(clock.now() + 2000);
    expect(existsSync(routeFilePath(ctx.mcsHome, ctx.instanceId))).toBe(false);
  });

  it('keeps the route file in scope repo, where the hooks need it', async () => {
    const { ctx, clock, service } = await instance({}, { sessions: threeSessions });
    await service.start();
    expect(existsSync(routeFilePath(ctx.mcsHome, ctx.instanceId))).toBe(true);
    await service.stop(clock.now() + 2000);
  });

  it('publishRouteFile writes nothing in scope all and writes the file in scope repo', async () => {
    const all = await instance({}, { runtimeDefaults: ALL });
    await publishRouteFile(all.ctx);
    expect(existsSync(routeFilePath(all.ctx.mcsHome, all.ctx.instanceId))).toBe(false);
    const repo = await instance();
    await publishRouteFile(repo.ctx);
    expect(existsSync(routeFilePath(repo.ctx.mcsHome, repo.ctx.instanceId))).toBe(true);
  });

  describe('hintSession', () => {
    it('does nothing before start, takes up an old session of another project after start, and ignores a bad id', async () => {
      const { ctx, service } = await instance({}, { runtimeDefaults: ALL, sessions: threeSessions });
      service.hintSession(OLD);
      await service.start();
      await service.untilIdle({ timeoutMs: 20_000 });
      expect(tracked(ctx, OLD)).toBe(0);
      service.hintSession('not-a-session-id');
      service.hintSession(OLD);
      await waitFor(() => tracked(ctx, OLD) > 0, { what: 'the hinted session to be tracked' });
      expect(tracked(ctx, RECENT_A)).toBe(1);
    });

    it('does nothing after stop', async () => {
      const { ctx, clock, service } = await instance({}, { runtimeDefaults: ALL, sessions: threeSessions });
      await service.start();
      await service.untilIdle({ timeoutMs: 20_000 });
      await service.stop(clock.now() + 2000);
      expect(() => {
        service.hintSession(OLD);
      }).not.toThrow();
      expect(tracked(ctx, OLD)).toBe(0);
    });

    it('works in scope repo too: the session is taken up from the folder of the repository', async () => {
      const { ctx, service } = await instance(
        {},
        {
          sessions: (repo) => [
            {
              id: OLD,
              project: sanitizeProjectName(repo),
              cwd: repo,
              mtimeAgeMs: 30 * HOUR,
              build: (b) => {
                prompt(b, 'old');
              },
            },
          ],
        },
      );
      await service.start();
      await service.untilIdle({ timeoutMs: 20_000 });
      expect(tracked(ctx, OLD)).toBe(0);
      service.hintSession(OLD);
      await waitFor(() => tracked(ctx, OLD) > 0, { what: 'the hinted session to be tracked' });
    });
  });

  describe('a live process of a session this instance has not seen', () => {
    /** A registry entry for `OLD` (a live process, as far as the instance can tell) before the service starts. */
    function withRegistryEntry(claudeHome: string): void {
      writeRegistryEntry(claudeHome, { pid: 4242, sessionId: OLD, cwd: 'D:/work/beta' });
    }

    it('is found at once through the registry in scope all, whatever the age of its file', async () => {
      const { ctx, claudeHome, service } = await instance(
        { pidAlive: () => true },
        { runtimeDefaults: ALL, sessions: threeSessions },
      );
      withRegistryEntry(claudeHome);
      await service.start();
      await waitFor(() => tracked(ctx, OLD) > 0, { what: 'the session of the registry entry to be tracked' });
    });

    it('is not looked for in scope repo, where the registry only reports on the sessions that are known', async () => {
      const reads: string[] = [];
      const { ctx, claudeHome, service } = await instance(
        {
          pidAlive: () => true,
          externalFs: {
            readdir: (dir) => nodeExternalFs.readdir(dir),
            readSmall: (file, max) => {
              reads.push(path.basename(file));
              return nodeExternalFs.readSmall(file, max);
            },
          },
        },
        {
          sessions: (repo) => [
            {
              id: OLD,
              project: sanitizeProjectName(repo),
              cwd: repo,
              mtimeAgeMs: 30 * HOUR,
              build: (b) => {
                prompt(b, 'old');
              },
            },
          ],
        },
      );
      withRegistryEntry(claudeHome);
      await service.start();
      await waitFor(() => reads.includes('4242.json'), { what: 'the registry poll to read the entry' });
      await service.untilIdle({ timeoutMs: 20_000 });
      expect(tracked(ctx, OLD)).toBe(0);
    });
  });
});

// ---- a tool call whose input line is longer than the summary column is stored (CAW-146) ---------------------------------------

describe('a tool call with a long input line', () => {
  const LONG = '66666666-6666-4666-8666-666666666666';
  // one line of 394 code points: the summary of 02 2.5.2 is its first 160 code points plus the clip marker of 02 2.5.1
  const COMMAND = `echo ${'fixture-word '.repeat(30)}`.trimEnd();

  it('is stored with the first 160 code points of its summary, and no record is dropped', async () => {
    const { ctx, clock, service } = await instance(
      {},
      {
        sessions: (repo) => [
          {
            id: LONG,
            project: sanitizeProjectName(repo),
            cwd: repo,
            mtimeAgeMs: 3_600_000,
            build: (b) => {
              b.user('run it');
              b.toolResult(b.toolUse('Bash', { command: COMMAND }));
              b.assistant({ messageId: 'msg_done' });
            },
          },
        ],
      },
    );
    await service.start();
    await service.untilIdle({ timeoutMs: 20_000 });
    const calls = ctx.db.driver
      .prepare<{ summary: string | null; ended: number }>(
        'SELECT summary, ended_at IS NOT NULL AS ended FROM tool_calls',
      )
      .all();
    expect(calls).toEqual([{ summary: COMMAND.slice(0, 160), ended: 1 }]);
    // the row of the timeline keeps the marker: its column has room for it (03 3.1)
    const rows = ctx.db.driver
      .prepare<{ summary: string | null }>("SELECT summary FROM events WHERE kind = 'tool.call'")
      .all();
    expect(rows).toEqual([{ summary: `${COMMAND.slice(0, 160)} ... [truncated 234 chars]` }]);
    expect(ctx.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM ingest_errors').get()?.n).toBe(0);
    expect(service.writer.stats.failures).toBe(0);
    await service.stop(clock.now() + 2000);
  });
});
