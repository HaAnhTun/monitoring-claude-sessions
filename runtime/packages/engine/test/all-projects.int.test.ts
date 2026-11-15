// All-projects ingestion over a real workspace, database, Claude home and ingest service (CAW design 03 2.2 to 2.4, ADR 0088): the
// user instance reads the transcripts of every project below the Claude home, windowed, with the project dimension, the registry
// hint for a session that is older than the window, a project folder that appears later, and the transcript of any project
// readable. The same fixtures with scope `repo` behave as they always did. Real timers (the service polls once a second at the
// fastest); every directory is a temp directory and nothing leaves this process.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION, SessionListQuerySchema, type InstanceKind } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import {
  CANARY,
  TranscriptBuilder,
  buildClaudeHome,
  scanForCanaries,
  useTempDirs,
  waitFor,
  writeRegistryEntry,
  type SessionSpec,
} from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { routeFilePath } from '../src/ingest/routes-file.ts';
import { createIngestService, type IngestService } from '../src/ingest/service.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const HOUR = 3_600_000;
const MIN = 60_000;

const ALPHA = 'D--work-alpha';
const ALPHA_CWD = 'D:/work/alpha';
// a lower-case drive letter, which Claude Code also writes
const BETA = 'd--work-beta';
const BETA_CWD = 'd:/work/beta';
// a dot folder: the folder name has two dashes
const DOT = 'D--work--claude';
const DOT_CWD = 'D:/work/.claude';
const GAMMA = 'D--work-gamma';
const GAMMA_CWD = 'D:/work/gamma';

const S_ALPHA = '11111111-1111-4111-8111-111111111111';
const S_BETA = '22222222-2222-4222-8222-222222222222';
const S_DOT = '33333333-3333-4333-8333-333333333333';
const S_OLD = '44444444-4444-4444-8444-444444444444';
const S_NEW = '55555555-5555-4555-8555-555555555555';
const S_REPO = '66666666-6666-4666-8666-666666666666';
const AGENT = 'a1b2c3d4e5f6a7b8c';

interface Harness {
  readonly ctx: InstanceContext;
  readonly repo: string;
  readonly claudeHome: string;
  readonly service: IngestService;
  readonly projects: string;
  all<T>(sql: string, params?: Record<string, string | number>): T[];
}

interface HarnessOptions {
  /** The key `projects.scope` of the runtime defaults; absent: the shipped `auto`. */
  readonly scope?: 'all' | 'repo';
  readonly kind?: InstanceKind;
  /** The sessions of the Claude home; the argument is the repository of the instance. */
  readonly sessions: (repo: string) => SessionSpec[];
  /** Merged over the runtime defaults (`projects.fullSweepIntervalMs` and the like). */
  readonly projects?: Record<string, unknown>;
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

async function harness(o: HarnessOptions): Promise<Harness> {
  const root = makeTemp('all-projects').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  const projects = { ...(o.scope === undefined ? {} : { scope: o.scope }), ...o.projects };
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    `${JSON.stringify({
      schema_version: 1,
      // the fastest cycle the keys allow, so that the tests wait seconds and not minutes
      import: { discoveryIntervalMs: 1000 },
      lifecycle: { registryPollMs: 1000 },
      projects,
    })}\n`,
  );
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    ...(o.kind === undefined ? {} : { kind: o.kind }),
  });
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, { nowMs: Date.now(), sessions: o.sessions(repo) });
  // the query layer names the Claude home through the environment of the server, as `buildInstanceContext` does
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
  });
  contexts.push(ctx);
  // the processes of the registry entries of a test are not real: they all live
  const service = createIngestService(ctx, { pidAlive: () => true });
  services.push(service);
  return {
    ctx,
    repo,
    claudeHome,
    service,
    projects: path.join(claudeHome, 'projects'),
    all: (sql, params = {}) => ctx.db.driver.prepare<never>(sql).all(params),
  };
}

function session(
  id: string,
  project: string,
  cwd: string,
  ageMs: number,
  build: (b: TranscriptBuilder) => void = (b) => {
    b.user(`first prompt of ${id.slice(0, 4)}`).assistant({ messageId: `msg_${id.slice(0, 8)}`, stop: 'end_turn' });
  },
): SessionSpec {
  return { id, project, cwd, mtimeAgeMs: ageMs, build };
}

/** Three projects with a session inside the window (the first with a subagent), one folder of a dot path, and an old session. */
function threeProjects(): SessionSpec[] {
  return [
    {
      ...session(S_ALPHA, ALPHA, ALPHA_CWD, HOUR),
      subagents: [{ agentId: AGENT, meta: { agentType: 'general-purpose' }, build: (b) => b.user('go') }],
    },
    session(S_BETA, BETA, BETA_CWD, 2 * HOUR),
    session(S_DOT, DOT, DOT_CWD, 3 * HOUR),
    session(S_OLD, GAMMA, GAMMA_CWD, 30 * HOUR),
  ];
}

const trackedFiles = (h: Harness, uid: string): number =>
  h.all<{ n: number }>('SELECT count(*) AS n FROM transcript_files WHERE session_uid = :uid', { uid })[0]?.n ?? -1;

const listAll = (
  h: Harness,
  query: Record<string, string> = {},
): ReturnType<InstanceContext['queries']['listSessions']> =>
  h.ctx.queries.listSessions(h.ctx.scope, SessionListQuerySchema.parse({ range: 'all', ...query }));

/** Sets the modification time of a folder to a plain millisecond value that two looks read as the same number. */
function pinDir(dir: string, ms: number): void {
  utimesSync(dir, new Date(ms), new Date(ms));
}

describe('scope all over three projects', () => {
  it('tracks the sessions inside the window of every project, subagents included, and not the older one', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect([S_ALPHA, S_BETA, S_DOT, S_OLD].map((uid) => trackedFiles(h, uid))).toEqual([2, 1, 1, 0]);
    const kinds = h.all<{ kind: string }>('SELECT kind FROM transcript_files ORDER BY kind').map((row) => row.kind);
    expect(kinds).toEqual(['session', 'session', 'session', 'subagent']);
  });

  it('gives each session its project, with the first working directory as the root of the project', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(
      h.all<{ project_key: string; dir_name: string; root_path: string }>(
        'SELECT project_key, dir_name, root_path FROM projects ORDER BY project_key',
      ),
    ).toEqual([
      { project_key: 'd--work--claude', dir_name: DOT, root_path: DOT_CWD },
      { project_key: 'd--work-alpha', dir_name: ALPHA, root_path: ALPHA_CWD },
      { project_key: 'd--work-beta', dir_name: BETA, root_path: BETA_CWD },
    ]);
  });

  it('lists the sessions that no rule matched, with the first prompt as their label and the project of each', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    // no includeUnmatched in the request: in scope all the sessions of the projects are the point
    const items = listAll(h).items;
    expect(items.map((item) => item.id).sort()).toEqual([S_ALPHA, S_BETA, S_DOT].sort());
    for (const item of items) {
      expect(item.matched).toBe(false);
      expect(item.labelSource).toBe('first_prompt');
      expect(item.label).toBe(`first prompt of ${item.id.slice(0, 4)}`);
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    expect([S_ALPHA, S_BETA, S_DOT].map((id) => byId.get(id)?.projectId)).toEqual([
      'd--work-alpha',
      'd--work-beta',
      'd--work--claude',
    ]);
    expect([S_ALPHA, S_BETA, S_DOT].map((id) => byId.get(id)?.projectLabel)).toEqual(['alpha', 'beta', '.claude']);
    expect(listAll(h, { project: 'd--work-beta' }).items.map((item) => item.id)).toEqual([S_BETA]);
  });

  it('reports the scope it reads: all here, and the user instance reads it without being told', async () => {
    const forced = await harness({ scope: 'all', sessions: threeProjects });
    expect(forced.ctx.queries.instanceInfo(forced.ctx.scope).scope).toBe('all');
    const user = await harness({ kind: 'user', sessions: threeProjects });
    expect(user.ctx.queries.instanceInfo(user.ctx.scope).scope).toBe('all');
    await user.service.start();
    await user.service.untilIdle({ timeoutMs: 30_000 });
    expect(trackedFiles(user, S_BETA)).toBe(1);
  });

  it('writes no route file, because no hook can be routed to every project', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    expect(existsSync(routeFilePath(h.ctx.mcsHome, h.ctx.instanceId))).toBe(false);
  });
});

describe('a session that is older than the window', () => {
  it('is found at once through the registry, whatever the age of its file, and shows in the list', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    writeRegistryEntry(h.claudeHome, { pid: 4242, sessionId: S_OLD, cwd: GAMMA_CWD, status: 'busy' });
    await h.service.start();
    await waitFor(() => trackedFiles(h, S_OLD) > 0, {
      what: 'the session of the registry entry to be tracked',
      timeoutMs: 15_000,
    });
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const old = listAll(h).items.find((item) => item.id === S_OLD);
    expect(old).toMatchObject({ projectId: 'd--work-gamma', projectLabel: 'gamma' });
  });

  it('stays out while nothing says it lives', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(trackedFiles(h, S_OLD)).toBe(0);
  });

  it('is found by the full sweep when it wakes up and the registry does not know it either', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects, projects: { fullSweepIntervalMs: 5000 } });
    const gamma = path.join(h.projects, GAMMA);
    pinDir(gamma, Date.now() - 40 * HOUR);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(trackedFiles(h, S_OLD)).toBe(0);
    // the session wakes up: its file is written, the modification time of its folder does not move
    const file = path.join(gamma, `${S_OLD}.jsonl`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"type":"user"}\n`);
    utimesSync(file, new Date(), new Date());
    pinDir(gamma, Date.now() - 40 * HOUR);
    await waitFor(() => trackedFiles(h, S_OLD) > 0, { what: 'the full sweep to find the session', timeoutMs: 25_000 });
  }, 40_000);
});

describe('a project folder that appears later', () => {
  it('is found within a few ticks, and its session is imported', async () => {
    const h = await harness({ scope: 'all', sessions: threeProjects });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const folder = path.join(h.projects, 'D--work-delta');
    mkdirSync(folder);
    new TranscriptBuilder({ sessionId: S_NEW, cwd: 'D:/work/delta', startMs: Date.now() - 5 * MIN })
      .user('first prompt of a new project')
      .assistant({ messageId: 'msg_new', stop: 'end_turn' })
      .write(path.join(folder, `${S_NEW}.jsonl`));
    await waitFor(() => trackedFiles(h, S_NEW) > 0, { what: 'the new project folder to be found', timeoutMs: 15_000 });
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const found = listAll(h).items.find((item) => item.id === S_NEW);
    expect(found).toMatchObject({ projectId: 'd--work-delta', label: 'first prompt of a new project' });
  });
});

describe('the transcript of a session of another project', () => {
  it('is read through the transcript window, whichever project holds it', async () => {
    const h = await harness({
      scope: 'all',
      sessions: () => [
        session(S_ALPHA, ALPHA, ALPHA_CWD, HOUR, (b) => {
          b.user('a question for alpha').assistant({ messageId: 'msg_alpha', text: 'an answer of alpha' });
        }),
        session(S_BETA, BETA, BETA_CWD, 2 * HOUR, (b) => {
          b.user('a question for beta').assistant({ messageId: 'msg_beta', text: 'an answer of beta' });
        }),
      ],
    });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    for (const [id, word] of [
      [S_ALPHA, 'alpha'],
      [S_BETA, 'beta'],
    ] as const) {
      const response = await h.ctx.queries.window(
        h.ctx.scope,
        { sessionId: id, agent: 'main', after: -1 },
        new AbortController().signal,
      );
      expect(response.total).toBeGreaterThan(1);
      expect(JSON.stringify(response.events)).toContain(`a question for ${word}`);
    }
  });
});

describe('what reaches the database', () => {
  it('holds the first prompt as a label and no other text of the transcripts of any project', async () => {
    const dirty = (id: string, project: string, cwd: string): SessionSpec =>
      session(id, project, cwd, HOUR, (b) => {
        b.user(`first prompt of ${id.slice(0, 4)}`);
        b.assistant({ messageId: `msg_${id.slice(0, 4)}a`, text: CANARY.thinking });
        const call = b.toolUse('Bash', { command: 'echo FIXTURE' });
        b.toolResult(call, { content: CANARY.toolResult });
        b.user(CANARY.prompt);
        b.assistant({ messageId: `msg_${id.slice(0, 4)}b`, text: CANARY.attachment, stop: 'end_turn' });
      });
    const h = await harness({
      scope: 'all',
      sessions: () => [dirty(S_ALPHA, ALPHA, ALPHA_CWD), dirty(S_BETA, BETA, BETA_CWD), dirty(S_DOT, DOT, DOT_CWD)],
    });
    writeRegistryEntry(h.claudeHome, { pid: 4242, sessionId: S_ALPHA, cwd: ALPHA_CWD }, { keyDecoy: true });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(listAll(h).items).toHaveLength(3);
    // the workspace holds the database, its journal and the logs of this run
    expect(scanForCanaries([h.ctx.instanceDir], [])).toEqual([]);
  });
});

describe('scope repo, the default of a task instance', () => {
  const sessions = (repo: string): SessionSpec[] => [
    session(S_REPO, sanitizeProjectName(repo), repo, HOUR),
    ...threeProjects(),
  ];

  it('tracks only the sessions of the repository and lists them as it always did', async () => {
    const h = await harness({ sessions });
    expect(h.ctx.queries.instanceInfo(h.ctx.scope).scope).toBe('repo');
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect([S_REPO, S_ALPHA, S_BETA, S_DOT, S_OLD].map((uid) => trackedFiles(h, uid))).toEqual([1, 0, 0, 0, 0]);
    // a session that no rule matched stays hidden unless the request asks for it
    expect(listAll(h).items).toEqual([]);
    expect(listAll(h, { includeUnmatched: '1' }).items.map((item) => item.id)).toEqual([S_REPO]);
    expect(existsSync(routeFilePath(h.ctx.mcsHome, h.ctx.instanceId))).toBe(true);
  });

  it('gives the same result when the key says repo for a user instance', async () => {
    const h = await harness({ scope: 'repo', kind: 'user', sessions });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect([S_REPO, S_ALPHA, S_BETA].map((uid) => trackedFiles(h, uid))).toEqual([1, 0, 0]);
  });

  it('does not take a session of another project up through the registry', async () => {
    const h = await harness({ sessions });
    writeRegistryEntry(h.claudeHome, { pid: 4242, sessionId: S_OLD, cwd: GAMMA_CWD });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(trackedFiles(h, S_OLD)).toBe(0);
  });
});
