// The project dimension over a real workspace, database, spool, Claude home and writer (CAW design 03 2.5, 2.8): the importer and
// the hooks give a session its project, the project rows hold the folder and the first working directory, `listSessions`,
// `projectStats` and `resumeFacts` read them, and a database that was written before the dimension is filled at the next start.
// Real timers; every directory is a temp directory and nothing leaves this process.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION, SessionListQuerySchema } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import { buildClaudeHome, useTempDirs, type SessionSpec } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createIngestService, type IngestService, type IngestServiceOptions } from '../src/ingest/service.ts';
import { backfillProjects, type BackfillResult } from '../src/projects/backfill.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';
import { labSequence } from './fixtures/hook-sequences.ts';
import { fixtureEnvelope } from './fixtures/hooks.ts';
import { appendEnvelopes } from './fixtures/spool.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const SESSION_A = '66666666-6666-4666-8666-666666666666';
const SESSION_B = '77777777-7777-4777-8777-777777777777';
const SESSION_C = '88888888-8888-4888-8888-888888888888';
const MIN = 60_000;

interface Harness {
  readonly ctx: InstanceContext;
  readonly repo: string;
  readonly claudeHome: string;
  readonly spoolDir: string;
  /** The folder Claude Code would use for the repository. */
  readonly projectDirName: string;
  readonly service: IngestService;
  /** A new service over the same instance (a restart), with its own options. */
  restart(options?: IngestServiceOptions): IngestService;
  all<T>(sql: string, params?: Record<string, string | number>): T[];
  one(sql: string, params?: Record<string, string | number>): number;
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

async function harness(sessions: (repo: string) => SessionSpec[] = () => []): Promise<Harness> {
  const root = makeTemp('project-dimension').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, { nowMs: Date.now(), sessions: sessions(repo) });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
  });
  contexts.push(ctx);
  const service = createIngestService(ctx);
  services.push(service);
  return {
    ctx,
    repo,
    claudeHome,
    spoolDir: path.join(ctx.instanceDir, 'data', 'spool'),
    projectDirName: sanitizeProjectName(repo),
    service,
    restart: (options) => {
      const next = createIngestService(ctx, options);
      services.push(next);
      return next;
    },
    all: (sql, params = {}) => ctx.db.driver.prepare<never>(sql).all(params),
    one: (sql, params = {}) => ctx.db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? -1,
  };
}

/** A session of the repository of the harness: its transcript lies in the folder Claude Code uses for that repository. */
function sessionIn(repo: string, id: string, startMs: number): SessionSpec {
  return {
    id,
    project: sanitizeProjectName(repo),
    cwd: repo,
    startMs,
    build: (b) => {
      b.user('FIXTURE prompt');
      b.assistant({ messageId: `msg_${id.slice(0, 8)}`, stop: 'end_turn' });
    },
  };
}

interface ProjectRow {
  project_key: string;
  dir_name: string;
  root_path: string | null;
}

const projects = (h: Harness): ProjectRow[] =>
  h.all<ProjectRow>('SELECT project_key, dir_name, root_path FROM projects ORDER BY project_key');

const projectKeyOf = (h: Harness, uid: string): string | null | undefined =>
  h.all<{ key: string | null }>(
    'SELECT p.project_key AS key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.session_uid = :uid',
    { uid },
  )[0]?.key;

describe('the project of a session read from the transcripts', () => {
  it('gives every session of a folder the one project of that folder, with the first working directory as its root', async () => {
    const t0 = Date.now() - 30 * MIN;
    const h = await harness((repo) => [sessionIn(repo, SESSION_A, t0), sessionIn(repo, SESSION_B, t0 + 5 * MIN)]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(projects(h)).toEqual([
      { project_key: h.projectDirName.toLowerCase(), dir_name: h.projectDirName, root_path: h.repo },
    ]);
    expect(projectKeyOf(h, SESSION_A)).toBe(h.projectDirName.toLowerCase());
    expect(projectKeyOf(h, SESSION_B)).toBe(h.projectDirName.toLowerCase());
  });

  it('shows in the list as the project id and a label made of the last segment of the root', async () => {
    const t0 = Date.now() - 30 * MIN;
    const h = await harness((repo) => [sessionIn(repo, SESSION_A, t0)]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const page = h.ctx.queries.listSessions(
      h.ctx.scope,
      SessionListQuerySchema.parse({ includeUnmatched: '1', range: 'all' }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.projectId).toBe(h.projectDirName.toLowerCase());
    expect(page.items[0]?.projectLabel).toBe('repo');
    const byProject = h.ctx.queries.listSessions(
      h.ctx.scope,
      SessionListQuerySchema.parse({ project: h.projectDirName.toLowerCase(), includeUnmatched: '1', range: 'all' }),
    );
    expect(byProject.items.map((item) => item.id)).toEqual([SESSION_A]);
  });

  it('counts the sessions of the project and gives the facts of a resume, from the real rows', async () => {
    const t0 = Date.now() - 30 * MIN;
    const h = await harness((repo) => [sessionIn(repo, SESSION_A, t0), sessionIn(repo, SESSION_B, t0 + 5 * MIN)]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const stats = h.ctx.queries.projectStats(h.ctx.scope, { windowFromMs: Date.now() - 8 * 60 * MIN });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      key: h.projectDirName.toLowerCase(),
      dirName: h.projectDirName,
      rootPath: h.repo,
      sessionsInWindow: 2,
      totalSessions: 2,
    });
    const facts = h.ctx.queries.resumeFacts(h.ctx.scope, SESSION_A);
    expect(facts).toMatchObject({
      sessionId: SESSION_A,
      projectKey: h.projectDirName.toLowerCase(),
      dirName: h.projectDirName,
      rootPath: h.repo,
      sessionCwd: h.repo,
      mainFile: { state: 'active' },
    });
    expect(path.basename(facts?.mainFile?.path ?? '')).toBe(`${SESSION_A}.jsonl`);
    expect(path.basename(path.dirname(facts?.mainFile?.path ?? ''))).toBe(h.projectDirName);
    expect(h.ctx.queries.resumeFacts(h.ctx.scope, SESSION_C)).toBeNull();
  });
});

describe('the project of a session read from the hooks', () => {
  it('gives a hook session of another folder that folder as its project', async () => {
    const h = await harness();
    const other = path.join(h.claudeHome, 'projects', 'D--Work-Other');
    appendEnvelopes(
      h.spoolDir,
      labSequence({
        startAt: Date.now() - 20 * MIN,
        stepMs: 1000,
        sessionId: SESSION_C,
        instanceId: h.ctx.instanceId,
      }).map((envelope) => ({
        ...envelope,
        transcript_path: path.join(other, `${SESSION_C}.jsonl`),
        cwd: path.join(path.sep, 'work', 'other'),
      })),
    );
    await h.service.start();
    expect(projects(h)).toEqual([
      { project_key: 'd--work-other', dir_name: 'D--Work-Other', root_path: path.join(path.sep, 'work', 'other') },
    ]);
    expect(projectKeyOf(h, SESSION_C)).toBe('d--work-other');
  });

  it('agrees with the transcript of the same session: one project, whichever source arrives first', async () => {
    const t0 = Date.now() - 30 * MIN;
    const h = await harness((repo) => [sessionIn(repo, SESSION_A, t0)]);
    const file = path.join(h.claudeHome, 'projects', h.projectDirName, `${SESSION_A}.jsonl`);
    appendEnvelopes(h.spoolDir, [
      fixtureEnvelope('UserPromptSubmit', {
        receivedAt: t0 + 1000,
        top: { instance_id: h.ctx.instanceId, session_id: SESSION_A, transcript_path: file, cwd: h.repo },
      }),
    ]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(projects(h)).toEqual([
      { project_key: h.projectDirName.toLowerCase(), dir_name: h.projectDirName, root_path: h.repo },
    ]);
    expect(h.one('SELECT count(*) AS n FROM sessions')).toBe(1);
    expect(projectKeyOf(h, SESSION_A)).toBe(h.projectDirName.toLowerCase());
  });
});

describe('a database written before the project dimension', () => {
  /** What the backfill of a start did, in the order of the starts. */
  function spied(results: BackfillResult[]): IngestServiceOptions {
    return {
      backfillProjects: async (db, scope, options) => {
        const result = await backfillProjects(db, scope, options);
        results.push(result);
        return result;
      },
    };
  }

  it('is given its projects at the next start, announced as changed sessions, and not again at the start after', async () => {
    const t0 = Date.now() - 30 * MIN;
    const h = await harness((repo) => [sessionIn(repo, SESSION_A, t0), sessionIn(repo, SESSION_B, t0 + 5 * MIN)]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    await h.service.stop(Date.now() + 2000);
    // the state of an older database: the sessions exist, the transcript files are registered, no project is known
    h.ctx.db.driver.exec('DELETE FROM projects');
    expect(h.one('SELECT count(*) AS n FROM sessions WHERE project_id IS NULL')).toBe(2);
    const mark = h.one('SELECT coalesce(max(seq), 0) AS n FROM changes');

    const results: BackfillResult[] = [];
    const second = h.restart(spied(results));
    await second.start();
    expect(results).toEqual([{ scanned: 2, assigned: 2 }]);
    expect(projects(h)).toEqual([
      { project_key: h.projectDirName.toLowerCase(), dir_name: h.projectDirName, root_path: h.repo },
    ]);
    expect(h.one('SELECT count(*) AS n FROM sessions WHERE project_id IS NULL')).toBe(0);
    expect(
      h.one("SELECT count(DISTINCT entity_id) AS n FROM changes WHERE seq > :mark AND kind = 'session'", { mark }),
    ).toBe(2);
    await second.stop(Date.now() + 2000);

    const again: BackfillResult[] = [];
    const third = h.restart(spied(again));
    await third.start();
    expect(again).toEqual([{ scanned: 0, assigned: 0 }]);
    expect(projects(h)).toHaveLength(1);
  });
});
