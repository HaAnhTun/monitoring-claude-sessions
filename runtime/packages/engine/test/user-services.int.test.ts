// The user services of a running user instance (CAW-31, design 06 1.7, design 02 8 and 9, design 03 7.3, ADR 0084, 0090, 0091, 0093):
// the real runtime over a real workspace, database, ingest service, registry folder and folder service, with the real terminal
// service over a scripted pseudo terminal (`FakePtyBackend`) and no folder dialog. What is proved: the census follows the sessions,
// a code is minted and exchanged and the control token is accepted as a Bearer value, the registry of a dead run is swept at start
// and the own file is removed at stop, a terminal is linked to its monitored session through the registry, a known session is
// resumed (and not twice), a stop kills every session, tells its viewers and takes the exit hook off, and a drain refuses new sessions.
// Real timers (the linker polls every 100 ms here); every directory is a temp directory, the pids are invented, and nothing leaves
// this process.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { ACCESS_CODE_RE } from '@mcs/shared/protocol';
import { buildClaudeHome, useTempDirs, waitFor, writeRegistryEntry } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createDaMemoryReader } from '../src/folders/da-memory.ts';
import { projectFolderName } from '../src/ingest/transcripts/discovery.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { createUserServices, type ExitHook } from '../src/runtime/create-user-services.ts';
import { createInstanceRuntime, type InstanceRuntime } from '../src/runtime/instance-runtime.ts';
import { FakePtyBackend } from '../src/terminal/fake-pty.ts';
import type { HostExit, HostViewer } from '../src/terminal/host.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const HOUR = 3_600_000;
const TOKEN = 'cd'.repeat(32);

// FIXTURE: invented ids and pids. 70001 and up are not processes of this machine that anything here touches.
const S_LIVE = '11111111-1111-4111-8111-111111111111';
const S_KNOWN = '44444444-4444-4444-8444-444444444444';
const FIRST_PID = 70_001;

class FakeProcess implements ExitHook {
  readonly listeners = new Set<() => void>();
  on(_event: 'exit', listener: () => void): this {
    this.listeners.add(listener);
    return this;
  }
  off(_event: 'exit', listener: () => void): this {
    this.listeners.delete(listener);
    return this;
  }
}

class Viewer implements HostViewer {
  readonly exits: HostExit[] = [];
  onData = (): void => undefined;
  onSize = (): void => undefined;
  onExit(exit: HostExit): void {
    this.exits.push(exit);
  }
}

interface Harness {
  readonly ctx: InstanceContext;
  readonly runtime: InstanceRuntime;
  readonly backend: FakePtyBackend;
  readonly process: FakeProcess;
  readonly root: string;
  readonly claudeHome: string;
  readonly folder: string;
  /** The user services of the runtime. */
  user(): NonNullable<InstanceRuntime['user']>;
  /** The stale registry folder of a dead run. */
  readonly terminalsDir: string;
}

const contexts: InstanceContext[] = [];
const runtimes: InstanceRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop(Date.now() + 10_000);
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    // the log file of the workspace is open until the logger is closed; Windows cannot delete the folder before that
    await ctx.logger.close();
  }
  vi.unstubAllEnvs();
});

async function harness(o: { knownSession?: boolean } = {}): Promise<Harness> {
  const root = makeTemp('user-services-int').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    `${JSON.stringify({
      schema_version: 1,
      import: { discoveryIntervalMs: 1000 },
      lifecycle: { registryPollMs: 1000 },
      // the program of a session is the Node binary: the scripted pseudo terminal never starts it, but it has to exist
      terminal: { command: process.execPath, killTimeoutMs: 500 },
      projects: { linkPollMs: 100 },
    })}\n`,
  );
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
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
  const backend = new FakePtyBackend({ firstPid: FIRST_PID });
  const fakeProcess = new FakeProcess();
  const runtime = createInstanceRuntime(ctx, {
    factories: {
      // the ingest, the sweeper, the scheduler and the panels are the registered real ones; only the user services get their scripts
      createUserServices: (c, services) =>
        createUserServices(c, services, {
          terminal: { backend, env: () => ({}) },
          picker: null,
          folders: {
            daMemory: createDaMemoryReader({ dir: path.join(root, 'no-da-memory'), cacheMs: 0 }),
            homeDir: root,
          },
          // no process table is asked: the terminals of the test link by the pid of their registry entry
          tree: { descendants: () => Promise.resolve(new Set<number>()) },
          // the processes of the registry entries of a test are not real: they all live
          pidAlive: () => true,
          exitHook: fakeProcess,
        }),
    },
  });
  runtimes.push(runtime);
  return {
    ctx,
    runtime,
    backend,
    process: fakeProcess,
    root,
    claudeHome,
    folder,
    terminalsDir: path.join(ctx.mcsHome, 'terminals'),
    user: () => {
      if (runtime.user === null) throw new Error('a user instance has user services');
      return runtime.user;
    },
  };
}

function terminalOf(h: Harness): NonNullable<NonNullable<InstanceRuntime['user']>['terminal']> {
  const terminal = h.user().terminal;
  if (terminal === null || terminal === undefined) throw new Error('the terminal host is missing');
  return terminal;
}

describe('the user services of a running user instance', () => {
  it('builds the real services for a user instance: census, the access service, the terminal host, the folder service', async () => {
    const h = await harness();
    const user = h.user();
    expect(user.census.count()).toBe(0);
    expect(user.access).not.toBeNull();
    expect(user.accessService).toBe(user.access);
    expect(user.terminal).not.toBeNull();
    expect(user.folders).not.toBeNull();
    expect(terminalOf(h).capabilities()).toMatchObject({ available: true, reason: null, resume: true, maxSessions: 8 });
    expect(user.components.map((c) => c.name)).toEqual(['folders', 'terminal-link', 'terminal']);
  });

  it('counts the sessions that run and lists them oldest first', async () => {
    const h = await harness();
    await h.runtime.start();
    const terminal = terminalOf(h);
    const first = await terminal.sessions.create({ path: h.folder });
    const second = await terminal.sessions.create({ path: h.folder });
    expect(h.user().census.count()).toBe(2);
    expect(
      h
        .user()
        .census.sessions(10)
        .map((entry) => entry.name),
    ).toEqual([first.name, second.name]);
    expect(terminal.sessions.list().map((row) => row.name)).toEqual([first.name, second.name]);
    expect(first.path).toBe(h.folder);
    expect(first.name).toMatch(/^app-[0-9]+$/);
  });

  it('mints an access code, exchanges it once, and accepts the control token of run/control.token as a Bearer value', async () => {
    const h = await harness();
    await h.runtime.start();
    const access = h.user().accessService;
    const minted = h.user().access?.mint();
    expect(minted?.code).toMatch(ACCESS_CODE_RE);
    const exchanged = access?.exchange(minted?.code ?? '');
    expect(exchanged?.ok).toBe(true);
    if (exchanged?.ok === true) expect(access?.verify(exchanged.credential)?.credentialId).toBe(exchanged.credentialId);
    expect(access?.exchange(minted?.code ?? '')).toMatchObject({ ok: false });
    // boot writes the token after the runtime was created: it is read at each check
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(false);
    mkdirSync(path.join(h.ctx.instanceDir, 'run'), { recursive: true });
    writeFileSync(path.join(h.ctx.instanceDir, 'run', 'control.token'), `${TOKEN}\n`);
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(true);
    expect(access?.verifyBearer(`Bearer ${'ef'.repeat(32)}`)).toBe(false);
  });

  it('sweeps the registry of a dead run at start, keeps its own file while sessions run and removes it at stop', async () => {
    const h = await harness();
    mkdirSync(h.terminalsDir, { recursive: true });
    const stale = path.join(h.terminalsDir, '99999-1.json');
    writeFileSync(stale, 'garbage of a dead run');
    await h.runtime.start();
    expect(existsSync(stale)).toBe(false);
    await terminalOf(h).sessions.create({ path: h.folder });
    // the registry writes its file behind the create (one writer, changes coalesced)
    await waitFor(() => readdirSync(h.terminalsDir).length === 1, {
      what: 'the registry file of this owner',
      timeoutMs: 10_000,
      intervalMs: 50,
    });
    await h.runtime.stop(Date.now() + 10_000);
    expect(existsSync(h.terminalsDir) ? readdirSync(h.terminalsDir) : []).toEqual([]);
  });

  it('registers the synchronous kill at process exit when it starts, and takes it off when it stops', async () => {
    const h = await harness();
    expect(h.process.listeners.size).toBe(0);
    await h.runtime.start();
    expect(h.process.listeners.size).toBe(1);
    await terminalOf(h).sessions.create({ path: h.folder });
    // the hook itself is never called here: the default service would signal the invented pid for real
    await h.runtime.stop(Date.now() + 10_000);
    expect(h.process.listeners.size).toBe(0);
  });

  it('links a terminal to its monitored session through the registry, and the row of the host shows it', async () => {
    const h = await harness();
    await h.runtime.start();
    const terminal = terminalOf(h);
    const row = await terminal.sessions.create({ path: h.folder });
    expect(row.link.status).toBe('pending');
    writeRegistryEntry(h.claudeHome, {
      pid: FIRST_PID,
      sessionId: S_LIVE,
      cwd: h.folder,
      startedAt: Date.now() + 400,
      status: 'idle',
    });
    await waitFor(() => terminal.sessions.list()[0]?.link.status === 'linked', {
      what: 'the terminal is linked to its session',
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    expect(terminal.sessions.list()[0]?.link).toMatchObject({
      status: 'linked',
      sessionId: S_LIVE,
      basis: 'registry-pid',
      claudePid: FIRST_PID,
      registryStatus: 'idle',
    });
    expect(terminal.sessions.list()[0]?.folderKey).toBe(projectFolderName(h.folder).name.toLowerCase());
  });

  it('resumes a known session in its folder, and refuses a second resume and a copy while a terminal holds it', async () => {
    const h = await harness({ knownSession: true });
    await h.runtime.start();
    await h.runtime.ingestUntilIdle({ timeoutMs: 25_000 });
    await waitFor(() => h.ctx.queries.resumeFacts(h.ctx.scope, S_KNOWN) !== null, {
      what: 'the known session is in the database',
      timeoutMs: 25_000,
      intervalMs: 100,
    });
    const terminal = terminalOf(h);
    const row = await terminal.resume({ sessionId: S_KNOWN, fork: false });
    expect(h.backend.spawns[0]?.args).toEqual(['--resume', S_KNOWN]);
    expect(row.path).toBe(h.folder);
    expect(await h.user().folders?.resumeEligibility(S_KNOWN)).toMatchObject({
      allowed: false,
      reason: 'live_in_terminal',
      liveTerminal: row.name,
    });
    for (const fork of [false, true]) {
      await expect(terminal.resume({ sessionId: S_KNOWN, fork })).rejects.toMatchObject({
        name: 'TerminalError',
        code: 'resume_unavailable',
        details: [{ path: 'sessionId', issue: 'live_in_terminal' }],
      });
    }
    expect(h.backend.spawns).toHaveLength(1);
    // a session the database does not know is not found
    await expect(terminal.resume({ sessionId: S_LIVE, fork: false })).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('starts a copy with --fork-session when nothing holds the session', async () => {
    const h = await harness({ knownSession: true });
    await h.runtime.start();
    await h.runtime.ingestUntilIdle({ timeoutMs: 25_000 });
    await waitFor(() => h.ctx.queries.resumeFacts(h.ctx.scope, S_KNOWN) !== null, {
      what: 'the known session is in the database',
      timeoutMs: 25_000,
      intervalMs: 100,
    });
    await terminalOf(h).resume({ sessionId: S_KNOWN, fork: true });
    expect(h.backend.spawns[0]?.args).toEqual(['--resume', S_KNOWN, '--fork-session']);
  });

  it('a stop kills every session, tells the viewers, empties the census and refuses new sessions', async () => {
    const h = await harness();
    await h.runtime.start();
    const terminal = terminalOf(h);
    const first = await terminal.sessions.create({ path: h.folder });
    await terminal.sessions.create({ path: h.folder });
    const viewer = new Viewer();
    terminal.sessions.get(first.name)?.attach(viewer);
    expect(h.user().census.count()).toBe(2);

    const stopped = await h.runtime.stop(Date.now() + 10_000);
    expect(stopped.completed).toBe(true);
    expect(h.backend.spawns.map((spawn) => spawn.pty.killCalls > 0)).toEqual([true, true]);
    expect(viewer.exits).toHaveLength(1);
    expect(h.user().census.count()).toBe(0);
    expect(terminal.sessions.list()).toEqual([]);
    await expect(terminal.sessions.create({ path: h.folder })).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });

  it('after the drain of a guarded stop decision no session can start, and nothing that runs is ended', async () => {
    const h = await harness();
    await h.runtime.start();
    const terminal = terminalOf(h);
    await terminal.sessions.create({ path: h.folder });
    h.user().census.beginDrain();
    await expect(terminal.sessions.create({ path: h.folder })).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    expect(h.user().census.count()).toBe(1);
    expect(h.backend.spawns[0]?.pty.killCalls).toBe(0);
  });

  it('refuses a session over the cap of the configuration with terminal_limit', async () => {
    const h = await harness();
    await h.runtime.start();
    const terminal = terminalOf(h);
    const max = terminal.capabilities().maxSessions;
    for (let n = 0; n < max; n += 1) await terminal.sessions.create({ path: h.folder });
    await expect(terminal.sessions.create({ path: h.folder })).rejects.toMatchObject({
      name: 'TerminalError',
      code: 'terminal_limit',
    });
  });
});
