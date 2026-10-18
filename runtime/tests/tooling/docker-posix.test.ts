// `scripts/docker-posix.mjs` (ADR 0065 item 4) driven with a fake `docker` (fixtures/fake-docker.mjs) that records its argument
// lists and stdin: the derived image build, the run call of every target, label-scoped cleanup (also on SIGINT), `--prune`,
// sequential targets, the summary, `--dry-run`, a missing docker and an unknown ref. These tests never start Docker.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as planModule from '../../scripts/docker-posix-plan.mjs';
// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as harnessModule from '../../scripts/docker-posix.mjs';

interface HarnessIo {
  env: NodeJS.ProcessEnv;
  dockerBin: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  signals: EventEmitter;
}
interface RunSpec {
  runId: string;
  target: string;
  platform: string;
  quick: boolean;
  bundle: boolean;
  keep: boolean;
}
interface GateRow {
  name: string;
  result: string;
  ms: number;
}

const { dockerfileFor, imageTag, parseGateTables, runArgs } = planModule as unknown as {
  dockerfileFor: (target: string, platform: string) => string;
  imageTag: (target: string, platform: string) => string;
  parseGateTables: (text: string) => GateRow[][];
  runArgs: (spec: RunSpec) => string[];
};
const { runHarness } = harnessModule as unknown as { runHarness: (argv: string[], io: HarnessIo) => Promise<number> };

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-docker.mjs');
const gitInstalled = spawnSync('git', ['--version']).status === 0;
const FORBIDDEN = [
  '-v',
  '--volume',
  '--mount',
  '--volumes-from',
  '--privileged',
  '--network=host',
  '-p',
  '--publish',
  '--pid',
];

let root = '';
let repo = '';
let out = '';
let logFile = '';
let stdinDir = '';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function makeRepo(): void {
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'runtime'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'committed\n');
  writeFileSync(join(repo, 'runtime', 'package.json'), '{}\n');
  git(['init', '-q']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
}

async function harness(args: string[], plan: object = {}, signals?: EventEmitter): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const env = {
    ...process.env,
    FAKE_DOCKER_LOG: logFile,
    FAKE_DOCKER_DIR: stdinDir,
    FAKE_DOCKER_PLAN: JSON.stringify(plan),
  };
  const code = await runHarness([...args, '--repo', repo, '--out', out], {
    env,
    dockerBin: FAKE,
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    signals: signals ?? new EventEmitter(),
  });
  return { code, stdout, stderr };
}

function calls(): string[][] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function summary(): {
  schema: string;
  runId: string;
  result: string;
  targets: { key: string; result: string; gates: { name: string; result: string; ms: number }[] }[];
} {
  return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as ReturnType<typeof summary>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-docker-posix-'));
  out = join(root, 'out');
  stdinDir = join(root, 'stdin');
  mkdirSync(stdinDir);
  logFile = join(root, 'docker.log');
  writeFileSync(logFile, '');
  repo = root;
  if (gitInstalled) makeRepo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('derived image', () => {
  it('has a stable Dockerfile that installs git and ps on both families', () => {
    expect(dockerfileFor('node24', 'amd64')).toBe(dockerfileFor('node24', 'amd64'));
    expect(imageTag('node24', 'amd64')).toBe(imageTag('node24', 'amd64'));
    expect(imageTag('node24', 'amd64')).not.toBe(imageTag('node24', 'arm64'));
    expect(imageTag('node24', 'amd64')).toMatch(/^mcs-posix\/node24:[0-9a-f]{12}$/);
    const debian = dockerfileFor('node22', 'amd64');
    expect(debian).toContain('FROM --platform=linux/amd64 node:22-bookworm-slim');
    expect(debian).toContain('apt-get install -y --no-install-recommends git procps');
    const alpine = dockerfileFor('alpine24', 'arm64');
    expect(alpine).toContain('FROM --platform=linux/arm64 node:24-alpine');
    expect(alpine).toContain('apk add --no-cache git procps');
  });

  it('never puts a mount, port, host network, pid or privilege flag in a run call', () => {
    for (const target of ['node22', 'node24', 'node26', 'alpine24', 'floor']) {
      const args = runArgs({
        runId: 'r1',
        target,
        platform: 'amd64',
        quick: false,
        bundle: false,
        keep: false,
      });
      for (const flag of FORBIDDEN) expect(args.slice(0, -1)).not.toContain(flag);
      expect(args.some((a) => a.startsWith('--network') || a.startsWith('--mount') || a.startsWith('-v='))).toBe(false);
    }
  });

  it('scales the performance budgets on arm64 (emulated) and leaves amd64 at the default', () => {
    const spec = { runId: 'r1', target: 'node24', quick: true, bundle: false, keep: false };
    const arm = runArgs({ ...spec, platform: 'arm64' });
    const at = arm.indexOf('MCS_PERF_FACTOR=8');
    expect(at).toBeGreaterThan(0);
    expect(arm[at - 1]).toBe('-e');
    expect(arm.indexOf(imageTag('node24', 'arm64'))).toBeGreaterThan(at);
    const amd = runArgs({ ...spec, platform: 'amd64' });
    expect(amd.some((a) => a.startsWith('MCS_PERF_FACTOR'))).toBe(false);
  });
});

describe('summary table parser', () => {
  it('reads the last gate table and keeps the earlier ones', () => {
    const text = [
      '| gate | result | ms |',
      '|---|---|---|',
      '| lint | PASS | 12 |',
      'noise',
      '| gate | result | ms |',
      '|---|---|---|',
      '| npm ci | PASS | 5 |',
      '| ci | FAIL (exit 1) | 900 |',
    ].join('\n');
    const tables = parseGateTables(text);
    expect(tables).toHaveLength(2);
    expect(tables[1]).toEqual([
      { name: 'npm ci', result: 'PASS', ms: 5 },
      { name: 'ci', result: 'FAIL (exit 1)', ms: 900 },
    ]);
  });
});

describe.runIf(gitInstalled)('harness runs (fake docker)', () => {
  it('builds the image from stdin, runs the target with the fixed flags and pipes the git archive', async () => {
    const res = await harness(['--targets', 'node24', '--platform', 'amd64']);
    expect(res.code, res.stderr).toBe(0);
    const all = calls();
    const build = all.find((c) => c[0] === 'build');
    expect(build).toEqual([
      'build',
      '--label',
      'mcs-v4-harness=1',
      '--platform',
      'linux/amd64',
      '-t',
      imageTag('node24', 'amd64'),
      '-',
    ]);
    const buildIndex = all.indexOf(build!);
    expect(readFileSync(join(stdinDir, `${buildIndex}.stdin`), 'utf8')).toBe(dockerfileFor('node24', 'amd64'));

    const run = all.find((c) => c[0] === 'run')!;
    const { runId } = summary();
    const at = (flag: string) => run[run.indexOf(flag) + 1];
    expect(run).toContain('--rm');
    expect(run).toContain('-i');
    expect(run).toContain('--init');
    expect(at('--platform')).toBe('linux/amd64');
    expect(run.filter((_, i) => run[i - 1] === '--label')).toEqual(['mcs-v4-harness=1', `mcs-v4-run=${runId}`]);
    expect(at('--name')).toBe(`mcs-posix-${runId}-node24`);
    expect(at('--memory')).toBe('3g');
    expect(at('--user')).toBe('node');
    expect(run.filter((_, i) => run[i - 1] === '-e')).toEqual(['CI=1', 'TZ=UTC', 'MCS_HOOK_DISABLE=1']);
    expect(run.slice(-4, -1)).toEqual([imageTag('node24', 'amd64'), 'sh', '-c']);
    expect(run.at(-1)).toContain('tar -x -f -');
    expect(run.at(-1)).toContain('npm run ci -- --offline');
    for (const call of all) for (const flag of FORBIDDEN) expect(call.slice(0, -1)).not.toContain(flag);

    const sha = git(['rev-parse', 'HEAD']);
    const archive = spawnSync('git', ['archive', '--format=tar', sha], { cwd: repo }).stdout;
    expect(readFileSync(join(stdinDir, `${all.indexOf(run)}.stdin`)).equals(archive)).toBe(true);

    const ps = all.filter((c) => c[0] === 'ps');
    expect(ps).toEqual([['ps', '-a', '-q', '--filter', `label=mcs-v4-run=${runId}`]]);
    const s = summary();
    expect(s.schema).toBe('mcs.docker-posix/1');
    expect(s.result).toBe('pass');
    expect(s.targets[0]!.gates).toEqual([{ name: 'npm ci', result: 'PASS', ms: 5 }]);
    expect(existsSync(join(out, 'node24.log'))).toBe(true);
  });

  it('reuses an existing image and runs targets one after the other; a failing target does not stop the others', async () => {
    const res = await harness(['--targets', 'node22,node24,alpine24', '--quick'], {
      inspect: 0,
      run: { node24: { code: 1, out: '| gate | result | ms |\n|---|---|---|\n| test | FAIL (exit 1) | 7 |\n' } },
    });
    expect(res.code).toBe(1);
    const all = calls();
    expect(all.some((c) => c[0] === 'build')).toBe(false);
    const names = all.filter((c) => c[0] === 'run').map((c) => c[c.indexOf('--name') + 1]!.split('-').at(-1));
    expect(names).toEqual(['node22', 'node24', 'alpine24']);
    const s = summary();
    expect(s.result).toBe('fail');
    expect(s.targets.map((t) => t.result)).toEqual(['PASS', 'FAIL (exit 1)', 'PASS']);
    expect(s.targets[1]!.gates).toEqual([{ name: 'test', result: 'FAIL (exit 1)', ms: 7 }]);
  });

  it('fails a target whose image is missing under --no-build, and only that target', async () => {
    const res = await harness(['--targets', 'node24', '--no-build']);
    expect(res.code).toBe(1);
    expect(calls().some((c) => c[0] === 'build' || c[0] === 'run')).toBe(false);
    expect(summary().targets[0]!.result).toContain('--no-build');
  });

  it('cleans up only its own run label on SIGINT', async () => {
    const signals = new EventEmitter();
    const pending = harness(
      ['--targets', 'node24,node26'],
      { inspect: 0, ps: 'abc123def456\n', run: { node24: { hang: true } } },
      signals,
    );
    await waitFor(() => readFileSync(logFile, 'utf8').includes('#hanging') || undefined, {
      what: 'the fake container to start',
    });
    signals.emit('SIGINT');
    const res = await pending;
    expect(res.code).toBe(130);
    const all = calls();
    const { runId } = summary();
    expect(all.filter((c) => c[0] === 'run')).toHaveLength(1);
    expect(all.filter((c) => c[0] === 'ps')).toEqual([['ps', '-a', '-q', '--filter', `label=mcs-v4-run=${runId}`]]);
    expect(all.filter((c) => c[0] === 'rm')).toEqual([['rm', '-f', 'abc123def456']]);
    expect(summary().result).toBe('interrupted');
  });

  it('--prune filters on the harness label only, --images also on images', async () => {
    const res = await harness(['--prune', '--images'], { ps: 'aaa111bbb222\n', images: 'ccc333ddd444\n' });
    expect(res.code).toBe(0);
    const all = calls().filter((c) => c[0] !== 'version');
    expect(all).toEqual([
      ['ps', '-a', '-q', '--filter', 'label=mcs-v4-harness=1'],
      ['rm', '-f', 'aaa111bbb222'],
      ['images', '-q', '--filter', 'label=mcs-v4-harness=1'],
      ['rmi', 'ccc333ddd444'],
    ]);
    for (const call of all) expect(call.join(' ')).not.toMatch(/name=|ancestor=|reference=/);
  });

  it('--dry-run prints the plan and runs nothing', async () => {
    const res = await harness(['--dry-run', '--platform', 'all', '--targets', 'node22,node24,node26,alpine24,floor']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing was started');
    expect(res.stdout).toContain('node24-arm64');
    expect(res.stdout).not.toContain('floor-arm64');
    expect(calls()).toEqual([]);
  });

  it('an unknown ref exits 2 before any image build or container', async () => {
    const res = await harness(['--ref', 'no-such-ref']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown git ref');
    expect(calls()).toEqual([]);
  });

  it('a missing docker exits 2 with a clear message', async () => {
    let stderr = '';
    const code = await runHarness(['--targets', 'node24', '--repo', repo, '--out', out], {
      env: process.env,
      dockerBin: join(root, 'no-such-docker'),
      stdout: { write: () => true },
      stderr: { write: (t: string) => (stderr += t) },
      signals: new EventEmitter(),
    });
    expect(code).toBe(2);
    expect(stderr).toContain('docker command was not found');
  });
});
