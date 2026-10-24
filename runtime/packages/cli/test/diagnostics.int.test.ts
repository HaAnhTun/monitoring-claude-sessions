// `mcs diagnostics` through the real built CLI against a hermetic instance (01 6.4, V4): the bundle validates, holds none of the
// planted canaries (a prompt in a transcript, a pattern and a key in the configuration, an environment value, the control
// token) nor a raw home or repository path, is written to a new file once per call (never over an existing one, never inside
// the Claude home), and the command changes nothing else. The real `~/.claude` is never read (`hermeticEnv`).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliEnvelopeSchema, DiagnosticsBundleSchema, type DiagnosticsBundle } from '@mcs/shared';
import {
  CANARY,
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
const ENV_SECRET = 'fixture-env-secret-value-3d41c0';
const ENV_PLAIN = 'fixture-plain-env-value-77c2aa';

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly claudeHome: string;
  readonly wsDir: string;
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** An initialized task `demo` whose configuration and transcripts folder carry canaries. */
async function sandbox(port: number): Promise<Sandbox> {
  const root = makeTemp('diagnostics-int').path;
  const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
  const env: Record<string, string> = {
    ...hermeticEnv(root),
    API_TOKEN_FIXTURE: ENV_SECRET,
    FIXTURE_PLAIN_ENV: ENV_PLAIN,
  };
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const claudeHome = env['CLAUDE_CONFIG_DIR'] ?? join(root, 'claude-home');
  mkdirSync(mcsHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  const mcs: Sandbox['mcs'] = (args) => runCli([...args, '--repo', repo], { mcsHome, env });
  const made = await mcs(['init', '--name', 'Diagnostics task', '--slug', 'demo', '--port', String(port)]);
  expect(made.code, made.stderr).toBe(0);
  const wsDir = join(tasksRoot, 'demo');
  const transcripts = join(root, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const line = { type: 'user', sessionId: 'fixture-session', message: { role: 'user', content: CANARY.prompt } };
  writeFileSync(join(transcripts, 'fixture-session.jsonl'), `${JSON.stringify(line)}${LF}`);
  const configFile = join(wsDir, 'config.json');
  const config: Record<string, unknown> = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  config['transcripts_dir'] = transcripts;
  config['title'] = `Title ${CANARY.query}`;
  config['session_rules'] = [{ match: `(?:${CANARY.key})`, label: 'x' }];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}${LF}`);
  return { root, repo, tasksRoot, env, mcsHome, claudeHome, wsDir, mcs };
}

function bundleFile(file: string): DiagnosticsBundle {
  return DiagnosticsBundleSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function pathOf(stdout: string): string {
  const envelope = CliEnvelopeSchema.parse(JSON.parse(stdout));
  expect(envelope.ok, stdout).toBe(true);
  const data = envelope.data as { path: string; schema: string };
  expect(data.schema).toBe('mcs.diagnostics/1');
  return data.path;
}

function errorCodeOf(stdout: string): string | undefined {
  return CliEnvelopeSchema.parse(JSON.parse(stdout)).error?.code;
}

function expectClean(text: string, s: Sandbox, extra: readonly string[] = []): void {
  const needles = [
    CANARY.prompt,
    CANARY.key,
    CANARY.query,
    ENV_SECRET,
    ENV_PLAIN,
    s.repo,
    s.root,
    s.repo.replace(/\\/g, '/'),
    s.root.replace(/\\/g, '/'),
    ...extra,
  ];
  for (const needle of needles) expect(text.includes(needle), needle).toBe(false);
}

afterEach(async () => {
  await killAllTracked();
});

describe('mcs diagnostics', () => {
  it('writes a valid, canary-free bundle to --out for a stopped task and changes nothing else', async () => {
    const sb = await sandbox(await allocatePort());
    const out = join(sb.root, 'bundle.json');
    const snapshot = [snapshotTree(sb.wsDir, { exclude: ['logs'] }), snapshotTree(sb.mcsHome)];
    const run = await sb.mcs(['diagnostics', '--task', 'demo', '--out', out, '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(pathOf(run.stdout).toLowerCase()).toContain('bundle.json');
    const text = readFileSync(out, 'utf8');
    const bundle = bundleFile(out);
    expectClean(text, sb);
    expect(bundle.instance?.slug).toBe('demo');
    expect(bundle.status).toMatchObject({ running: false, probe: 'stopped' });
    expect(bundle.health).toBeNull();
    expect(bundle.config?.redacted['session_rules']).toBe('<list length=1>');
    expect(bundle.config?.files.some((f) => f.path.startsWith('<repo>/'))).toBe(true);
    expect(bundle.doctor.map((c) => c.id)).toContain('config.valid');
    expect([snapshotTree(sb.wsDir, { exclude: ['logs'] }), snapshotTree(sb.mcsHome)]).toEqual(snapshot);
  });

  it('without --out writes logs/diagnostics-<UTC>.json, a new file per call', async () => {
    const sb = await sandbox(await allocatePort());
    const first = await sb.mcs(['diagnostics', '--task', 'demo']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const second = await sb.mcs(['diagnostics', '--task', 'demo']);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const files = readdirSync(join(sb.wsDir, 'logs')).filter((n) => /^diagnostics-\d{8}T\d{6}Z(-\d+)?\.json$/.test(n));
    expect(files).toHaveLength(2);
    for (const name of files) expectClean(readFileSync(join(sb.wsDir, 'logs', name), 'utf8'), sb);
    expect(first.stdout.trim()).not.toBe(second.stdout.trim());
  });

  it('without --task needs --out and then holds only the machine-wide sections', async () => {
    const sb = await sandbox(await allocatePort());
    const missing = await sb.mcs(['diagnostics', '--json']);
    expect(missing.code).toBe(2);
    expect(errorCodeOf(missing.stdout)).toBe('USAGE');
    const out = join(sb.root, 'machine.json');
    const run = await sb.mcs(['diagnostics', '--out', out, '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const bundle = bundleFile(out);
    expect(bundle).toMatchObject({ instance: null, config: null, status: null, health: null, logTail: [] });
    expect(bundle.doctor.length).toBeGreaterThan(5);
    expectClean(readFileSync(out, 'utf8'), sb);
  });

  it('never overwrites a file and never writes inside the Claude home or another folder of the tasks root', async () => {
    const sb = await sandbox(await allocatePort());
    const out = join(sb.root, 'existing.json');
    writeFileSync(out, 'keep me');
    const exists = await sb.mcs(['diagnostics', '--task', 'demo', '--out', out, '--json']);
    expect(exists.code).toBe(1);
    expect(errorCodeOf(exists.stdout)).toBe('OUTPUT_EXISTS');
    expect(readFileSync(out, 'utf8')).toBe('keep me');
    for (const target of [join(sb.claudeHome, 'diag.json'), join(sb.wsDir, 'data', 'diag.json')]) {
      mkdirSync(join(target, '..'), { recursive: true });
      const forbidden = await sb.mcs(['diagnostics', '--task', 'demo', '--out', target, '--json']);
      expect(forbidden.code, target).toBe(1);
      expect(errorCodeOf(forbidden.stdout), target).toBe('OUTPUT_PATH_FORBIDDEN');
      expect(existsSync(target), target).toBe(false);
    }
  });

  it('reports a running instance: status, health, and not the control token', async () => {
    const port = await allocatePort();
    const sb = await sandbox(port);
    const instance = await startInstance({ repo: sb.repo, slug: 'demo', env: sb.env }, { port });
    const token = readFileSync(join(sb.wsDir, 'run', 'control.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(16);
    const snapshot = [
      snapshotTree(sb.wsDir, { exclude: ['logs', 'data', 'state.json', 'run'] }),
      snapshotTree(sb.mcsHome),
    ];
    const out = join(sb.root, 'running.json');
    const run = await sb.mcs(['diagnostics', '--task', 'demo', '--out', out, '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const text = readFileSync(out, 'utf8');
    const bundle = bundleFile(out);
    expect(bundle.status).toMatchObject({ running: true, pid: instance.pid, url: `http://127.0.0.1:${String(port)}` });
    expect(bundle.health?.status).toBeDefined();
    expect(bundle.health?.instanceId).toBe(bundle.instance?.instanceId);
    expect(bundle.logTail.length).toBeGreaterThan(0);
    expect(bundle.runtime.buildCurrent).toBe(true);
    expectClean(text, sb, [token]);
    expect([
      snapshotTree(sb.wsDir, { exclude: ['logs', 'data', 'state.json', 'run'] }),
      snapshotTree(sb.mcsHome),
    ]).toEqual(snapshot);
    const status = await sb.mcs(['status', '--task', 'demo']);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    await instance.stop();
  });

  it('an unknown task is an error', async () => {
    const sb = await sandbox(await allocatePort());
    const run = await sb.mcs(['diagnostics', '--task', 'nope', '--json']);
    expect(run.code).toBe(1);
    expect(errorCodeOf(run.stdout)).toBe('TASK_NOT_FOUND');
  });
});
