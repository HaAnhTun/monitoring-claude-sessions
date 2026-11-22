// The last activity of a session over the real ingest service, importer, writer and sweeper on a synthetic Claude home
// (CAW-147; UI review R-36, N-4): no record of a session is later than its last activity, in whatever order the file of the
// parent and the files of its subagents arrive, and the time of the ingest never becomes the last activity. The orders at
// the level of one transaction are in `src/ingest/session-last-activity.test.ts`. Real timers; every directory is a temp one.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import { buildClaudeHome, useTempDirs, type SessionSpec, type TranscriptBuilder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createIngestService, type IngestService } from '../src/ingest/service.ts';
import { createLifecycleSweeper } from '../src/lifecycle/sweeper.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const SESSION = '66666666-6666-4666-8666-666666666666';
const HELPER = 'a1b2c3d4e5f6a7b8c';
const WORKFLOW_HELPER = 'b1b2c3d4e5f6a7b8c';
const RUN = 'wf_fixture_last_activity';
const MIN = 60_000;

interface Times {
  readonly started: number;
  readonly last: number;
  readonly mainLast: number;
  readonly newestEvent: number;
  readonly lateEvents: number;
}

interface Harness {
  readonly ctx: InstanceContext;
  readonly service: IngestService;
  /** A second service over the same context (a restart: no cached facts). */
  another(): IngestService;
  /** Copies one file or folder of the staged session into the Claude home the instance reads, with its mtimes. */
  deliver(relative: string): void;
  one(sql: string, params?: Record<string, string | number>): number;
  times(): Times;
}

const services: IngestService[] = [];
const contexts: InstanceContext[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop(Date.now() + 2000).catch(() => undefined);
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    // the log file of the workspace is open until the logger is closed; Windows cannot delete the folder before that
    await ctx.logger.close();
  }
});

/**
 * An instance whose Claude home is empty, and the session written to a staging folder next to it: a test moves the files
 * over in the order it wants the importer to see them.
 */
async function harness(session: (repo: string, nowMs: number) => SessionSpec): Promise<Harness> {
  const root = makeTemp('last-activity').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });
  const project = sanitizeProjectName(repo);
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, { nowMs: Date.now(), sessions: [] });
  mkdirSync(path.join(claudeHome, 'projects', project), { recursive: true });
  const staging = path.join(root, 'staging');
  buildClaudeHome(staging, { nowMs: Date.now(), sessions: [session(repo, Date.now())] });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
  });
  contexts.push(ctx);
  const make = (): IngestService => {
    const service = createIngestService(ctx);
    services.push(service);
    return service;
  };
  const one: Harness['one'] = (sql, params = {}) => ctx.db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? -1;
  return {
    ctx,
    service: make(),
    another: make,
    deliver: (relative) => {
      cpSync(path.join(staging, 'projects', project, relative), path.join(claudeHome, 'projects', project, relative), {
        recursive: true,
        preserveTimestamps: true,
      });
    },
    one,
    times: () => {
      const row = ctx.db.driver
        .prepare<Times>(
          `SELECT s.started_at AS started, s.last_activity_at AS last,
                  (SELECT a.last_activity_at FROM agents a WHERE a.session_id = s.id AND a.agent_uid = 'main') AS mainLast,
                  coalesce((SELECT max(e.ts) FROM events e WHERE e.session_id = s.id AND (e.sources & 3) != 0), 0) AS newestEvent,
                  (SELECT count(*) FROM events e WHERE e.session_id = s.id AND e.ts > s.last_activity_at) AS lateEvents
             FROM sessions s WHERE s.session_uid = :uid`,
        )
        .get({ uid: SESSION });
      if (row === undefined) throw new Error('the session of the test has no row');
      return row;
    },
  };
}

const MAIN_FILE = `${SESSION}.jsonl`;
const SUBAGENTS = path.join(SESSION, 'subagents');

/** Four records, one a second: the last one three seconds after `startMs`. */
function parent(b: TranscriptBuilder): void {
  b.user('FIXTURE review the release');
  b.assistant({ messageId: 'msg_fixture_main_1', text: 'FIXTURE Handing the review to a helper.', stop: null });
  b.toolResult(b.toolUse('Task', { description: 'FIXTURE helper' }, { messageId: 'msg_fixture_main_1' }));
}

/** Three records: the last one two seconds after `startMs`. */
function helper(b: TranscriptBuilder): void {
  b.user('FIXTURE read the diff');
  b.assistant({ messageId: 'msg_fixture_helper_1', text: 'FIXTURE Reading.', stop: null });
  b.toolUse('Bash', { command: 'echo FIXTURE diff' }, { messageId: 'msg_fixture_helper_1' });
}

/** A parent that stopped ten minutes ago and a subagent that wrote for a minute longer. */
function sessionWithLateHelper(repo: string, nowMs: number): SessionSpec {
  const t0 = nowMs - 10 * MIN;
  return {
    id: SESSION,
    project: sanitizeProjectName(repo),
    cwd: repo,
    startMs: t0,
    mtimeAgeMs: 10 * MIN - 3000,
    build: parent,
    subagents: [
      {
        agentId: HELPER,
        meta: { agentType: 'general-purpose', description: 'FIXTURE helper' },
        build: helper,
        startMs: t0 + MIN,
        mtimeAgeMs: 9 * MIN - 2000,
      },
    ],
  };
}

/** `untilIdle` looks for new files before it waits, so what a test just delivered is read when it resolves. */
async function ingested(h: Harness, service: IngestService, what: string, sql: string): Promise<void> {
  await service.untilIdle({ timeoutMs: 30_000 });
  expect(h.one(sql), what).toBeGreaterThanOrEqual(1);
}

const HAS_MAIN = `SELECT count(*) AS n FROM events e JOIN agents a ON a.id = e.agent_id WHERE a.agent_uid = 'main'`;
const HAS_HELPER = `SELECT count(*) AS n FROM events e JOIN agents a ON a.id = e.agent_id WHERE a.agent_uid = '${HELPER}' AND e.kind = 'tool.call'`;

describe('the last activity of a session whose subagent writes after its parent (CAW-147, R-36)', () => {
  /** The newest record is the tool call of the helper, 62 s after the first record of the parent. */
  function expectNewestIsTheHelper(h: Harness): void {
    const times = h.times();
    expect(times.lateEvents).toBe(0);
    expect(times.last).toBe(times.newestEvent);
    expect(times.last - times.started).toBe(MIN + 2000);
    expect(times.mainLast).toBe(times.last);
    // ten minutes old, not the time of this ingest
    expect(Date.now() - times.last).toBeGreaterThan(8 * MIN);
  }

  it('the parent file first, the subagent file at a later tick of the same service', async () => {
    const h = await harness(sessionWithLateHelper);
    await h.service.start();
    h.deliver(MAIN_FILE);
    await ingested(h, h.service, 'the records of the parent', HAS_MAIN);
    const alone = h.times();
    expect(alone.last - alone.started).toBe(3000);
    h.deliver(SUBAGENTS);
    await ingested(h, h.service, 'the records of the subagent', HAS_HELPER);
    expectNewestIsTheHelper(h);
    await h.service.stop(Date.now() + 2000);
  });

  it('the subagent file before the file of its parent, at two ticks of the same service', async () => {
    const h = await harness(sessionWithLateHelper);
    await h.service.start();
    h.deliver(SUBAGENTS);
    await h.service.untilIdle({ timeoutMs: 30_000 });
    // the importer finds the file of a subagent through the file of its session, so it may have read nothing yet; whatever
    // it stored obeys the rule (the order inside one transaction and between two is in the writer tests)
    expect(
      h.one(
        'SELECT count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.ts > s.last_activity_at',
      ),
    ).toBe(0);
    h.deliver(MAIN_FILE);
    await ingested(h, h.service, 'the records of the parent', HAS_MAIN);
    expect(h.one(HAS_HELPER), 'the records of the subagent').toBeGreaterThanOrEqual(1);
    expectNewestIsTheHelper(h);
    await h.service.stop(Date.now() + 2000);
  });

  it('both files at the start of the service', async () => {
    const h = await harness(sessionWithLateHelper);
    h.deliver(MAIN_FILE);
    h.deliver(SUBAGENTS);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expectNewestIsTheHelper(h);
    await h.service.stop(Date.now() + 2000);
  });

  it('the parent file before a restart, the subagent file after it', async () => {
    const h = await harness(sessionWithLateHelper);
    h.deliver(MAIN_FILE);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    await h.service.stop(Date.now() + 2000);
    h.deliver(SUBAGENTS);
    const second = h.another();
    await second.start();
    await second.untilIdle({ timeoutMs: 30_000 });
    expectNewestIsTheHelper(h);
    await second.stop(Date.now() + 2000);
  });

  it('a row that an earlier version stored too early heals when the sweeper derives the session again', async () => {
    const h = await harness(sessionWithLateHelper);
    h.deliver(MAIN_FILE);
    h.deliver(SUBAGENTS);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    // what the engine stored before CAW-147: the last record of the parent, and the session due for its next check
    h.ctx.db.driver
      .prepare('UPDATE sessions SET last_activity_at = started_at + 3000, next_check_at = :due')
      .run({ due: Date.now() - 1 });
    expect(h.times().lateEvents).toBeGreaterThan(0);
    const sweeper = createLifecycleSweeper(h.ctx, h.service, { pidAlive: () => true });
    await sweeper.tickNow();
    await h.service.writer.flushNow();
    expectNewestIsTheHelper(h);
    await h.service.stop(Date.now() + 2000);
  });
});

describe('the last activity of a session and the records that are no activity facts (CAW-147, R-36)', () => {
  it('includes the record that closes the turn, of the parent and of a workflow agent', async () => {
    const h = await harness((repo, nowMs) => ({
      id: SESSION,
      project: sanitizeProjectName(repo),
      cwd: repo,
      startMs: nowMs - 10 * MIN,
      mtimeAgeMs: 9 * MIN,
      build: (b) => {
        b.user('FIXTURE run the checklist');
        b.assistant({ messageId: 'msg_fixture_main_1', text: 'FIXTURE Starting.', stop: null });
        // an `end_turn` record and, a second later, `system/turn_duration`: the newest record of the parent
        b.turnEnd();
      },
      subagents: [
        {
          agentId: WORKFLOW_HELPER,
          meta: { agentType: 'workflow-subagent', description: 'FIXTURE workflow helper' },
          build: (b) => {
            b.user('FIXTURE check the docs');
            b.assistant({ messageId: 'msg_fixture_wf_1', text: 'FIXTURE Checking.', stop: null });
            b.turnEnd();
          },
          startMs: nowMs - 9 * MIN,
          mtimeAgeMs: 8 * MIN,
        },
      ],
      workflow: { runId: RUN, finished: false, agents: [WORKFLOW_HELPER] },
    }));
    h.deliver(MAIN_FILE);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const alone = h.times();
    expect(alone.lateEvents).toBe(0);
    expect(alone.last - alone.started).toBe(3000);
    expect(
      h.one("SELECT count(*) AS n FROM events WHERE kind = 'turn.duration' AND ts = :at", { at: alone.last }),
    ).toBe(1);

    h.deliver(SESSION);
    await ingested(
      h,
      h.service,
      'the turn end of the workflow agent',
      `SELECT count(*) AS n FROM events e JOIN agents a ON a.id = e.agent_id WHERE a.agent_uid = '${WORKFLOW_HELPER}' AND e.kind = 'turn.duration'`,
    );
    const times = h.times();
    expect(times.lateEvents).toBe(0);
    expect(times.last).toBe(times.newestEvent);
    expect(times.last - times.started).toBe(MIN + 3000);
    expect(h.one("SELECT count(*) AS n FROM agents WHERE kind = 'workflow_agent'")).toBe(1);
    await h.service.stop(Date.now() + 2000);
  });
});
