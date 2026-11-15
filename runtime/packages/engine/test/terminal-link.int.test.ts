// The link between a terminal and its monitored session over a real registry folder, a real ingest service, a real database and a
// synthetic Claude home (CAW design 03 5.3, 6 and 8, ADR 0090). A script plays `claude`: it writes the registry entry of its process,
// later its transcript, later rewrites its session id (`/clear`); a fake process table stands in for the tree below the terminal. The
// linker, the registry snapshot, the folder service and the ingest service are the real ones. What is proved: pending to linked on
// the registry and the tree, the transcript found once it is written, the row of `listSessions?session=` with state and tokens, `/clear`
// followed, a stale entry from before the spawn ignored, and the resume of a known session (the eligibility sees the terminal as the
// owner, then as "elsewhere" once the terminal is forgotten). Real timers (the importer polls once a second at the fastest);
// every directory is a temp directory, the pids are invented, and nothing leaves this process.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION, SessionListQuerySchema } from '@mcs/shared';
import {
  TranscriptBuilder,
  buildClaudeHome,
  rewriteRegistryEntry,
  useTempDirs,
  waitFor,
  writeRegistryEntry,
} from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createRegistrySnapshot } from '../src/external/registry.ts';
import { createDaMemoryReader } from '../src/folders/da-memory.ts';
import { createFolderService, type FolderService } from '../src/folders/service.ts';
import { projectFolderName } from '../src/ingest/transcripts/discovery.ts';
import { createIngestService, type IngestService } from '../src/ingest/service.ts';
import { createTerminalLinker } from '../src/link/linker.ts';
import type { ProcessTreePort, TerminalLinker, TerminalProbe } from '../src/link/types.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const HOUR = 3_600_000;

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S_OLD = '33333333-3333-4333-8333-333333333333';
const S_KNOWN = '44444444-4444-4444-8444-444444444444';

// the processes are invented: a terminal root (the cmd.exe of the shim route) and the claude below it
const ROOT = 7001;
const CLAUDE = 7002;
const ROOT_RESUME = 7101;
const CLAUDE_RESUME = 7102;

class FakeTree implements ProcessTreePort {
  rows: Record<number, readonly number[] | null> = {};
  asked: number[] = [];

  descendants(root: number): Promise<ReadonlySet<number> | null> {
    this.asked.push(root);
    const row = this.rows[root];
    return Promise.resolve(row === undefined ? new Set<number>() : row === null ? null : new Set(row));
  }
}

interface Harness {
  readonly ctx: InstanceContext;
  readonly claudeHome: string;
  readonly folder: string;
  readonly dirName: string;
  readonly service: IngestService;
  readonly linker: TerminalLinker;
  readonly folders: FolderService;
  readonly tree: FakeTree;
  /** The terminal of the test, as the host would track it. */
  probe(name: string, pid: number, over?: Partial<TerminalProbe>): TerminalProbe;
  /** The path of the transcript of a session of the project folder. */
  transcriptPath(sessionId: string): string;
  /** Writes the transcript a claude writes at its first prompt, with one turn of 100 input and 20 output tokens. */
  writeTranscript(sessionId: string, startMs?: number): void;
  list(sessionIds: readonly string[]): ReturnType<InstanceContext['queries']['listSessions']>['items'];
}

const services: IngestService[] = [];
const linkers: TerminalLinker[] = [];
const contexts: InstanceContext[] = [];

afterEach(async () => {
  for (const linker of linkers.splice(0)) await linker.stop();
  for (const service of services.splice(0)) await service.stop(Date.now() + 2000).catch(() => undefined);
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    // the log file of the workspace is open until the logger is closed; Windows cannot delete the folder before that
    await ctx.logger.close();
  }
  vi.unstubAllEnvs();
});

async function harness(o: { knownSession?: boolean } = {}): Promise<Harness> {
  const root = makeTemp('terminal-link').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    `${JSON.stringify({
      schema_version: 1,
      // the fastest cycle the keys allow, so that the tests wait seconds and not minutes
      import: { discoveryIntervalMs: 1000 },
      lifecycle: { registryPollMs: 1000 },
    })}\n`,
  );
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  // the user instance reads every project of the Claude home, so the folder of the terminals need not be the repository
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', kind: 'user' });
  const folder = path.join(root, 'work', 'app');
  mkdirSync(folder, { recursive: true });
  const dirName = projectFolderName(folder).name;
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, {
    nowMs: Date.now(),
    sessions:
      o.knownSession === true
        ? [
            {
              id: S_KNOWN,
              project: dirName,
              cwd: folder,
              mtimeAgeMs: HOUR,
              startMs: Date.now() - 2 * HOUR,
              build: (b) => {
                b.user('a prompt of the known session').assistant({ messageId: 'msg_known', stop: 'end_turn' });
              },
            },
          ]
        : [],
  });
  mkdirSync(path.join(claudeHome, 'projects', dirName), { recursive: true });
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
  const registry = createRegistrySnapshot({ claudeHome, pidAlive: () => true, now: () => Date.now(), memoMs: 0 });
  const tree = new FakeTree();
  const linker = createTerminalLinker({
    registry,
    tree,
    clock: ctx.clock,
    config: ctx.config.runtime.projects,
    sessionKnown: (sessionId) => ctx.queries.resumeFacts(ctx.scope, sessionId) !== null,
    sessionsSince: (key, sinceMs) =>
      ctx.db.driver
        .prepare<{ uid: string }>(
          `SELECT s.session_uid AS uid FROM sessions s JOIN projects p ON p.id = s.project_id
            WHERE p.project_key = :key AND s.first_seen_at >= :since ORDER BY s.first_seen_at, s.session_uid`,
        )
        .all({ key, since: sinceMs })
        .map((row) => row.uid),
    hintSession: (sessionId) => {
      service.hintSession(sessionId);
    },
    logger: ctx.logger,
  });
  linkers.push(linker);
  const folders = createFolderService(ctx, {
    linker,
    registry,
    // the DA memory of the person is never read: a folder that does not exist
    daMemory: createDaMemoryReader({ dir: path.join(root, 'no-da-memory'), cacheMs: 0 }),
    homeDir: root,
  });
  const transcriptPath = (sessionId: string): string =>
    path.join(claudeHome, 'projects', dirName, `${sessionId}.jsonl`);
  return {
    ctx,
    claudeHome,
    folder,
    dirName,
    service,
    linker,
    folders,
    tree,
    probe: (name, pid, over = {}) => ({
      name,
      pid,
      cwd: folder,
      spawnedAtMs: Date.now(),
      resumeSessionId: null,
      fork: false,
      nameToken: null,
      ...over,
    }),
    transcriptPath,
    writeTranscript: (sessionId, startMs = Date.now()) => {
      new TranscriptBuilder({ sessionId, cwd: folder, startMs })
        .user(`first prompt of ${sessionId.slice(0, 4)}`)
        .assistant({
          messageId: `msg_${sessionId.slice(0, 8)}`,
          usage: { input_tokens: 100, output_tokens: 20 },
          stop: 'end_turn',
        })
        .write(transcriptPath(sessionId));
    },
    list: (sessionIds) =>
      ctx.queries.listSessions(ctx.scope, SessionListQuerySchema.parse({ range: 'all', session: sessionIds.join(',') }))
        .items,
  };
}

/** Ticks the linker until the link of a terminal satisfies `done`. */
async function until(
  h: Harness,
  name: string,
  done: (link: NonNullable<ReturnType<TerminalLinker['link']>>) => boolean,
  what: string,
): Promise<void> {
  await waitFor(
    async () => {
      await h.linker.tick();
      const link = h.linker.link(name);
      return link !== null && done(link);
    },
    { what, timeoutMs: 25_000, intervalMs: 100 },
  );
}

describe('a terminal and the session of its claude', () => {
  it('pending, then linked on the registry entry and the process tree, then tracked once the transcript is written', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = [CLAUDE];
    const probe = h.probe('app-1', ROOT);
    h.linker.track(probe);
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({ status: 'pending', sessionId: null, claudePid: null });

    // the script plays claude: it is up, and has written the entry of its process
    writeRegistryEntry(h.claudeHome, {
      pid: CLAUDE,
      sessionId: S1,
      cwd: h.folder,
      startedAt: probe.spawnedAtMs + 400,
      status: 'idle',
    });
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({
      status: 'linked',
      sessionId: S1,
      basis: 'registry-tree',
      confidence: 'high',
      claudePid: CLAUDE,
      transcript: 'none',
      registryStatus: 'idle',
      reason: null,
      shared: false,
    });
    expect(h.tree.asked).toEqual([ROOT]);
    expect(h.linker.sessionOwner(S1)).toBe('app-1');
    expect(h.linker.ownedPids()).toEqual(new Set([CLAUDE]));

    // the first prompt: the transcript appears, and the importer finds it
    h.writeTranscript(S1);
    await until(
      h,
      'app-1',
      (link) => link.transcript === 'tracked',
      'the transcript of the linked session to be tracked',
    );
    await h.service.untilIdle({ timeoutMs: 30_000 });

    // the row of the sidebar: state and tokens of the transcript, through the filter that the web uses
    const rows = h.list([S1]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ id: S1, projectId: h.dirName.toLowerCase() });
    expect(row?.state.state).toBeTypeOf('string');
    expect(row?.usageInclSubagents).toMatchObject({ input: 100, output: 20, total: 120 });
  });

  it('follows /clear: the entry of the same process gets a new session id, the old one is remembered, the new transcript is found', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = [CLAUDE];
    const probe = h.probe('app-1', ROOT);
    h.linker.track(probe);
    writeRegistryEntry(h.claudeHome, { pid: CLAUDE, sessionId: S1, cwd: h.folder, startedAt: probe.spawnedAtMs + 300 });
    h.writeTranscript(S1);
    await until(h, 'app-1', (link) => link.transcript === 'tracked', 'the first session to be tracked');

    // /clear: the same process, a new session
    rewriteRegistryEntry(h.claudeHome, CLAUDE, { sessionId: S2, status: 'busy' });
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({
      status: 'linked',
      sessionId: S2,
      previousSessionIds: [S1],
      claudePid: CLAUDE,
      basis: 'registry-tree',
      transcript: 'none',
      registryStatus: 'busy',
    });
    expect(h.linker.sessionOwner(S2)).toBe('app-1');
    expect(h.linker.sessionOwner(S1)).toBeNull();

    h.writeTranscript(S2);
    await until(
      h,
      'app-1',
      (link) => link.transcript === 'tracked' && link.sessionId === S2,
      'the second session to be tracked',
    );
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(
      h
        .list([S1, S2])
        .map((row) => row.id)
        .sort(),
    ).toEqual([S1, S2].sort());
  });

  it('ignores an entry from before the spawn, and links the one the new process writes over it', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = [CLAUDE];
    const probe = h.probe('app-1', ROOT);
    h.linker.track(probe);
    // a file the pid left behind from an older process
    writeRegistryEntry(h.claudeHome, {
      pid: CLAUDE,
      sessionId: S_OLD,
      cwd: h.folder,
      startedAt: probe.spawnedAtMs - HOUR,
    });
    await h.linker.tick();
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({ status: 'pending', sessionId: null });

    writeRegistryEntry(h.claudeHome, { pid: CLAUDE, sessionId: S1, cwd: h.folder, startedAt: probe.spawnedAtMs + 500 });
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({ status: 'linked', sessionId: S1, previousSessionIds: [] });
  });

  it('a claude that the person started by hand in the same folder is not linked to the terminal', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = [CLAUDE];
    const probe = h.probe('app-1', ROOT);
    h.linker.track(probe);
    writeRegistryEntry(h.claudeHome, {
      pid: 9999,
      sessionId: S_OLD,
      cwd: h.folder,
      startedAt: probe.spawnedAtMs + 100,
    });
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({ status: 'pending' });
    writeRegistryEntry(h.claudeHome, { pid: CLAUDE, sessionId: S1, cwd: h.folder, startedAt: probe.spawnedAtMs + 900 });
    await until(h, 'app-1', (link) => link.status === 'linked', 'the terminal to link to its own claude');
    expect(h.linker.link('app-1')).toMatchObject({ sessionId: S1, claudePid: CLAUDE });
    expect(h.linker.sessionOwner(S_OLD)).toBeNull();
  });

  it('with no process table, one terminal and one candidate still link, on the folder and with less confidence', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = null;
    const probe = h.probe('app-1', ROOT);
    h.linker.track(probe);
    writeRegistryEntry(h.claudeHome, { pid: CLAUDE, sessionId: S1, cwd: h.folder, startedAt: probe.spawnedAtMs + 100 });
    await h.linker.tick();
    expect(h.linker.link('app-1')).toMatchObject({ status: 'linked', basis: 'registry-cwd', confidence: 'medium' });
  });

  it('the polling timer links on its own', async () => {
    const h = await harness();
    await h.service.start();
    h.tree.rows[ROOT] = [CLAUDE];
    const probe = h.probe('app-1', ROOT);
    const changes: string[] = [];
    h.linker.onChange((name, link) => {
      changes.push(`${name}:${link.status}`);
    });
    h.linker.start();
    h.linker.track(probe);
    writeRegistryEntry(h.claudeHome, { pid: CLAUDE, sessionId: S1, cwd: h.folder, startedAt: probe.spawnedAtMs + 100 });
    await waitFor(() => h.linker.link('app-1')?.status === 'linked', {
      what: 'the timer of the linker to link the terminal',
      timeoutMs: 15_000,
    });
    expect(changes).toContain('app-1:linked');
    await h.linker.stop();
  });
});

describe('resuming a session that the monitor knows', () => {
  it('the plan, the link by id with the transcript tracked at once, the terminal as owner, and "elsewhere" once it is forgotten', async () => {
    const h = await harness({ knownSession: true });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    await waitFor(() => h.ctx.queries.resumeFacts(h.ctx.scope, S_KNOWN) !== null, {
      what: 'the known session to be imported',
    });

    // nothing holds the session: it may be resumed, and the plan is what the terminal host starts claude from
    expect(await h.folders.resumeEligibility(S_KNOWN)).toMatchObject({
      allowed: true,
      forkAllowed: true,
      reason: null,
      folder: { key: h.dirName.toLowerCase() },
    });
    const plan = await h.folders.planResume(S_KNOWN);
    expect(plan).toMatchObject({
      sessionId: S_KNOWN,
      args: ['--resume', S_KNOWN],
      mode: 'resume',
      expectsSameId: true,
    });
    expect(plan.folderPath.toLowerCase()).toBe(h.folder.toLowerCase());
    expect((await h.folders.planResume(S_KNOWN, { fork: true })).args).toEqual(['--resume', S_KNOWN, '--fork-session']);

    // the host creates the terminal and tracks it: the session is the terminal's before the process has written anything
    h.tree.rows[ROOT_RESUME] = [CLAUDE_RESUME];
    const probe = h.probe('app-2', ROOT_RESUME, { resumeSessionId: S_KNOWN });
    h.linker.track(probe);
    expect(await h.folders.resumeEligibility(S_KNOWN)).toMatchObject({
      reason: 'live_in_terminal',
      liveTerminal: 'app-2',
    });

    // claude resumes: its registry entry carries the id and the start of the ORIGINAL session, two hours back
    writeRegistryEntry(h.claudeHome, {
      pid: CLAUDE_RESUME,
      sessionId: S_KNOWN,
      cwd: h.folder,
      startedAt: probe.spawnedAtMs - 2 * HOUR,
    });
    await h.linker.tick();
    expect(h.linker.link('app-2')).toMatchObject({
      status: 'linked',
      sessionId: S_KNOWN,
      basis: 'registry-tree',
      confidence: 'high',
      previousSessionIds: [],
      transcript: 'tracked',
    });
    expect(await h.folders.resumeEligibility(S_KNOWN)).toMatchObject({
      allowed: false,
      forkAllowed: false,
      reason: 'live_in_terminal',
      liveTerminal: 'app-2',
    });
    await expect(h.folders.planResume(S_KNOWN)).rejects.toMatchObject({
      code: 'live_in_terminal',
      liveTerminal: 'app-2',
    });
    await expect(h.folders.planResume(S_KNOWN, { fork: true })).rejects.toMatchObject({ code: 'live_in_terminal' });

    // the terminal ends but the process of the registry lives on (nobody removed its entry): now it is somebody else's
    h.linker.forget('app-2');
    expect(await h.folders.resumeEligibility(S_KNOWN)).toMatchObject({
      allowed: false,
      forkAllowed: true,
      reason: 'live_elsewhere',
      liveElsewhere: true,
      liveTerminal: null,
    });
    await expect(h.folders.planResume(S_KNOWN)).rejects.toMatchObject({ code: 'live_elsewhere' });
    expect((await h.folders.planResume(S_KNOWN, { fork: true })).mode).toBe('fork');
  });

  it('a session the monitor never saw is not found, whatever the registry says', async () => {
    const h = await harness();
    await h.service.start();
    writeRegistryEntry(h.claudeHome, { pid: CLAUDE_RESUME, sessionId: S_OLD, cwd: h.folder });
    await expect(h.folders.resumeEligibility(S_OLD)).rejects.toMatchObject({ code: 'session_not_found' });
  });
});
