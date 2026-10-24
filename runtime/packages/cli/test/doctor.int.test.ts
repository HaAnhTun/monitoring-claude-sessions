// `mcs doctor` through the real built CLI against a hermetic instance (01 6.4, V4): without a task only the machine-wide checks
// run, with `--task` the workspace checks too; a running instance's own port counts as free; the JSON envelope validates;
// doctor changes nothing in the workspace or MCS_HOME. The real `~/.claude` is never read (`hermeticEnv`).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CliEnvelopeSchema, DoctorReportSchema, type DoctorReport } from '@mcs/shared';
import {
  allocatePort,
  buildRepo,
  hermeticEnv,
  killAllTracked,
  runCli,
  snapshotTree,
  startInstance,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every test starts the real CLI (some also a real instance): on a loaded machine one needs far more than the 10 s default.
// A test with its own limit keeps it.
vi.setConfig({ testTimeout: 120_000 });

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);

interface Sandbox {
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

function sandbox(): Sandbox {
  const root = makeTemp('doctor-int').path;
  const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  mkdirSync(mcsHome, { recursive: true });
  return { repo, tasksRoot, env, mcsHome, mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }) };
}

function reportOf(stdout: string): DoctorReport {
  const envelope = CliEnvelopeSchema.parse(JSON.parse(stdout));
  expect(envelope.ok).toBe(true);
  return DoctorReportSchema.parse(envelope.data);
}

afterEach(async () => {
  await killAllTracked();
});

describe('mcs doctor', () => {
  it('without --task runs the machine-wide checks; a missing Claude home is a warning, not a failure', async () => {
    const sb = sandbox();
    const run = await sb.mcs(['doctor']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const lines = run.stdout.split(LF);
    expect(lines).toContain('[ok] node.sqlite: node:sqlite opens a database');
    expect(lines.some((l) => l.startsWith('[warn] claude.home: '))).toBe(true);
    expect(lines).toContain('[ok] database.integrity: no task selected (skipped)');
    expect(lines).toContain('[ok] hooks: not installed (optional: live hook events are opt-in)');
    const json = await sb.mcs(['doctor', '--json']);
    const report = reportOf(json.stdout);
    expect(report.task).toBeNull();
    expect(report.checks.map((c) => c.id)).toContain('runtime.bundle-integrity');
  });

  it('with --task checks the workspace, treats the running instance port as free and writes nothing', async () => {
    const sb = sandbox();
    const port = await allocatePort();
    const made = await sb.mcs(['init', '--name', 'Doctor task', '--slug', 'demo', '--port', String(port)]);
    expect(made.code, made.stderr).toBe(0);
    const wsDir = join(sb.tasksRoot, 'demo');
    const stopped = await sb.mcs(['doctor', '--task', 'demo', '--json']);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    const before = reportOf(stopped.stdout);
    expect(before.task).toBe('demo');
    expect(before.checks.find((c) => c.id === 'port.free')).toMatchObject({
      ok: true,
      detail: `port ${String(port)} is free`,
    });
    expect(before.checks.find((c) => c.id === 'instance.identity')?.ok).toBe(true);

    const instance = await startInstance({ repo: sb.repo, slug: 'demo', env: sb.env }, { port });
    const snapshot = [
      snapshotTree(wsDir, { exclude: ['logs', 'data', 'state.json', 'run'] }),
      snapshotTree(sb.mcsHome),
    ];
    const running = await sb.mcs(['doctor', '--task', 'demo', '--json']);
    expect(running.code, running.stdout + running.stderr).toBe(0);
    const report = reportOf(running.stdout);
    expect(report.checks.find((c) => c.id === 'port.free')?.detail).toBe(
      `port ${String(port)} is held by this instance`,
    );
    expect(report.checks.find((c) => c.id === 'state.current')).toMatchObject({ ok: true, detail: 'running' });
    expect(report.checks.find((c) => c.id === 'database.integrity')?.ok).toBe(true);
    expect([snapshotTree(wsDir, { exclude: ['logs', 'data', 'state.json', 'run'] }), snapshotTree(sb.mcsHome)]).toEqual(
      snapshot,
    );
    await instance.stop();
  });

  it('an unknown task is a usage-level error with exit 1', async () => {
    const sb = sandbox();
    const run = await sb.mcs(['doctor', '--task', 'nope']);
    expect(run.code).not.toBe(0);
  });
});
