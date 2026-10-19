// The panel service inside a real runtime (06 3.4, 3.11; WP-41): a temporary repository shaped like a chain task (a git repository,
// a ledger, a chain log, a stop file, live log files, watched processes, Docker on, JavaScript patterns for the attempts), a
// real workspace and database, and the runtime of `createInstanceRuntime` with the real factories. All six panels answer; the
// 2 s attempts timer of the runtime drives the real tick (nothing here calls `tickAttempts`); the session of a part that
// ended with PASS becomes `completed` on observed evidence; `HealthReport.panels` lists the sources that were read and
// `children` counts the git spawns. The `docker` child is replaced by a fixed answer: no container is started or listed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PanelResponseSchema, RUNTIME_VERSION, type PanelKey } from '@mcs/shared';
import { buildDemo, useTempDirs, waitFor, type DemoResult } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../../src/config/defaults.ts';
import { childStats, execFileText, resolveExecutable, type ChildResult } from '../../src/platform/exec.ts';
import { buildInstanceContext, type ExecApi, type InstanceContext } from '../../src/runtime/context.ts';
import type { Logger } from '../../src/log/logger.ts';
import { createInstanceRuntime, type InstanceRuntime } from '../../src/runtime/instance-runtime.ts';
import { initWorkspace } from '../../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const ALL_KEYS: readonly PanelKey[] = ['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs'];
const DOCKER_ANSWER = 'fixture-db (Up 2 hours)\nfixture-cache (Up 5 minutes)\n';

interface Open {
  readonly ctx: InstanceContext;
  readonly runtime: InstanceRuntime;
  readonly demo: DemoResult;
  /** The columns of the state of one session. */
  state(sessionId: string): { state: string; basis: string; rule: string } | undefined;
  /** Every `docker` spawn that was asked for, to prove none reached the real binary. */
  readonly dockerCalls: string[][];
  /** The `phase` field of every `runtime_stub_service` warning the runtime logged. */
  readonly stubWarnings: string[];
}

const opened: Open[] = [];

afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.runtime.stop(Date.now() + 5000).catch(() => undefined);
    o.ctx.db.close();
    await o.ctx.logger.close();
  }
});

/** Runs a git command in the repository with a hermetic configuration and no discovery above the temp root. */
async function git(exec: ExecApi, cwd: string, ...args: string[]): Promise<void> {
  const file = await exec.resolveExecutable('git');
  if (file === null) throw new Error('git is not available');
  const done = await exec.execFileText({
    kind: 'git',
    file,
    args,
    cwd,
    timeoutMs: 20_000,
    maxOutputBytes: 1_000_000,
    encoding: 'utf8',
  });
  if (!done.ok) throw new Error(`git ${args[0] ?? ''} failed: ${done.stderr}`);
}

async function open(): Promise<Open> {
  const root = makeTemp('panel-service').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');

  const demo = await buildDemo({ root: path.join(root, 'demo'), nowMs: Date.now(), letters: ['A', 'B', 'C'] });
  // live logs next to the chain log; a stop file that exists
  writeFileSync(path.join(demo.repo, 'logs', 'run-1.log'), 'FIXTURE line one\nFIXTURE line two\n');
  writeFileSync(path.join(demo.repo, 'STOP'), 'stop\n');

  const dockerCalls: string[][] = [];
  const extraEnv = {
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(demo.repo),
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  writeFileSync(extraEnv.GIT_CONFIG_GLOBAL, '');
  const ok = (stdout: string): ChildResult => ({
    ok: true,
    code: 0,
    stdout,
    stderr: '',
    error: null,
    truncated: false,
    durationMs: 1,
  });
  const exec: ExecApi = {
    resolveExecutable: (name) => (name === 'docker' ? Promise.resolve('docker-fixture') : resolveExecutable(name)),
    execFileText: (spec, signal) => {
      if (spec.kind === 'docker') {
        dockerCalls.push([...spec.args]);
        return Promise.resolve(ok(DOCKER_ANSWER));
      }
      return execFileText({ ...spec, extraEnv: { ...spec.extraEnv, ...extraEnv } }, signal);
    },
    childStats,
  };
  await git(exec, demo.repo, '-c', 'init.defaultBranch=main', 'init', '-q');
  await git(exec, demo.repo, 'add', 'docs', 'logs');
  await git(exec, demo.repo, 'commit', '-q', '-m', 'first commit');

  // every panel on, the chain files of the task set, Docker on; the demo config narrows the event window below what the
  // runtime accepts, and that key is not the subject of this test
  const seed = {
    ...Object.fromEntries(Object.entries(demo.configJson).filter(([key]) => key !== 'limits')),
    panels: { machine: true, git: true, logs: true, ledger: true, chain_log: true, attempts: true },
    stop_file: 'STOP',
    live_log_globs: ['logs/*.log'],
    watched_processes: ['node.exe', 'node'],
    docker: true,
  };
  const seedFile = path.join(root, 'seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const { ws } = await initWorkspace({ repo: demo.repo, name: 'Demo', slug: 'demo', seedConfig: seedFile });

  const stubWarnings: string[] = [];
  const none = (): void => undefined;
  const logger: Logger = {
    debug: none,
    info: none,
    warn: (event, fields) => {
      if (event === 'runtime_stub_service') stubWarnings.push(String(fields?.['phase']));
    },
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: demo.claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    exec,
    logger,
  });
  const runtime = createInstanceRuntime(ctx);
  const o: Open = {
    ctx,
    runtime,
    demo,
    dockerCalls,
    stubWarnings,
    state: (sessionId) =>
      ctx.db.driver
        .prepare<{ state: string; basis: string; rule: string }>(
          'SELECT state, state_basis AS basis, state_rule AS rule FROM sessions WHERE session_uid = :sessionId',
        )
        .get({ sessionId }),
  };
  opened.push(o);
  await runtime.start();
  await runtime.ingestUntilIdle({ timeoutMs: 30_000 });
  return o;
}

describe('the panel service in a runtime shaped like a chain task (WP-41)', () => {
  it('answers all six panels with a body that parses', async () => {
    const o = await open();
    for (const key of ALL_KEYS) {
      const response = await o.runtime.panels.get(key);
      expect(PanelResponseSchema.safeParse(response).success, key).toBe(true);
      expect(response.key).toBe(key);
      expect(response.data, key).not.toBeNull();
      expect(['ok', 'partial'], key).toContain(response.status);
    }
    const git = await o.runtime.panels.get('git');
    expect(git.data).toMatchObject({ branch: 'main', repoState: 'ok', stopFile: true });
    expect(git.data?.commits.map((c) => c.subject)).toEqual(['first commit']);
    const ledger = await o.runtime.panels.get('ledger');
    expect(ledger.data?.exists).toBe(true);
    expect(ledger.data?.lines.length).toBeGreaterThan(0);
    const chain = await o.runtime.panels.get('chainLog');
    expect(chain.data?.lines.length).toBeGreaterThan(0);
    const logs = await o.runtime.panels.get('logs');
    expect(logs.data?.files.map((f) => f.name).sort()).toEqual(['chain.log', 'run-1.log']);
    const machine = await o.runtime.panels.get('machine');
    expect(machine.data).toMatchObject({
      docker: ['fixture-db (Up 2 hours)', 'fixture-cache (Up 5 minutes)'],
      dockerEnabled: true,
      dockerStatus: 'ok',
    });
    expect(machine.data?.totalGb).toBeGreaterThan(0);
    expect(o.dockerCalls).toHaveLength(1);
  });

  it('shows the attempts rows and completes the session of a part that ended with PASS, on observed evidence', async () => {
    const o = await open();
    const a = o.demo.sessions.A.sessionId;
    const b = o.demo.sessions.B.sessionId;
    const c = o.demo.sessions.C.sessionId;
    const attempts = await o.runtime.panels.get('attempts');
    expect(attempts.data?.sourceState).toBe('ok');
    expect(attempts.data?.rows.map((r) => [r.part, r.state, r.sessionId])).toEqual([
      ['A', 'COMPLETED', a],
      ['B', 'FAILED', b],
      ['C', 'RUNNING', c],
    ]);
    expect(o.state(a)).toEqual({ state: 'completed', basis: 'observed', rule: 'S-1' });
    expect(o.state(b)).toEqual({ state: 'failed', basis: 'observed', rule: 'S-1' });
    expect(o.state(c)?.rule).not.toBe('S-1');
  });

  it('closes a part by itself: the 2 s timer of the runtime reads the END that was appended', async () => {
    const o = await open();
    const c = o.demo.sessions.C.sessionId;
    expect(o.state(c)?.rule).not.toBe('S-1');
    const chainLog = path.join(o.demo.repo, 'logs', 'chain.log');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    appendFileSync(chainLog, `${stamp} STEP C END exit=0 status=PASS\n`);
    // nothing calls the tick here: the runtime's own timer does, within a few seconds
    await waitFor(() => o.state(c)?.rule === 'S-1', {
      what: 'the session of part C completed by the timer of the runtime',
      timeoutMs: 15_000,
      intervalMs: 200,
    });
    expect(o.state(c)).toEqual({ state: 'completed', basis: 'observed', rule: 'S-1' });
  });

  it('lists the sources that were read in HealthReport.panels and counts the git spawns in children', async () => {
    const o = await open();
    expect(o.runtime.health().panels).not.toHaveProperty('git.status');
    for (const key of ALL_KEYS) await o.runtime.panels.get(key);
    const health = o.runtime.health();
    const read = Object.keys(health.panels).sort();
    for (const source of [
      'attempts',
      'chainLog',
      'cpu',
      'docker',
      'git.log',
      'git.status',
      'ledger',
      'logs',
      'memory',
    ]) {
      expect(read, source).toContain(source);
    }
    expect(health.panels['git.status']).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
    // one status and one log call for the repository, and nothing for a source that was never read
    expect(health.children.git.spawned).toBeGreaterThanOrEqual(2);
    expect(health.children.git.failed).toBe(0);
  });

  it('runs on the real panel service: the runtime logs no stub warning for the panels', async () => {
    const o = await open();
    expect(o.stubWarnings).not.toContain('panels');
    // the stub of the service rejects every request; the real one answers
    await expect(o.runtime.panels.get('ledger')).resolves.toMatchObject({ key: 'ledger' });
  });

  it('samples nothing without a request: the sources of a panel nobody asked for stay unread', async () => {
    const o = await open();
    expect(o.runtime.health().panels).toEqual({});
    expect(o.dockerCalls).toHaveLength(0);
  });
});
