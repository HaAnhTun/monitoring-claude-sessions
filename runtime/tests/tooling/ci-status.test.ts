// `scripts/ci-status.mjs` (ADR 0065 item 3): `summarize` builds one bounded, sanitized job record; `publish` commits a run to the
// orphan branch `ci-status` of a temporary bare repository (never a network remote: outside GitHub Actions those are refused);
// `read` reads only the local remote-tracking ref and never fetches. A recording git (fixtures/fake-git.mjs) checks that every
// git call disables the credential store and prompts, that nothing force-pushes and that the token never reaches a log.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as statusModule from '../../scripts/ci-status.mjs';

interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  gitBin: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}
interface JobRecord {
  name: string;
  os: string | null;
  arch: string | null;
  node: string | null;
  result: string;
  gates: { name: string; result: string; ms: number }[];
  failedGate: string | null;
  tail: string[];
}
interface GitCall {
  argv: string[];
  prompt: string | null;
  askpass: string | null;
  header: boolean;
}

const { main, sanitizeLine, remoteKind } = statusModule as unknown as {
  main: (argv: string[], io: Partial<Io>) => number;
  sanitizeLine: (line: string) => string;
  remoteKind: (remote: string) => 'local' | 'https' | 'other';
};

const RUNTIME = join(import.meta.dirname, '..', '..');
const SCRIPT = join(RUNTIME, 'scripts', 'ci-status.mjs');
const FAKE_GIT = join(import.meta.dirname, 'fixtures', 'fake-git.mjs');
const gitInstalled = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TOKEN = 'fake-token-value-for-the-test-0123456789';
const ESC = String.fromCharCode(27);

let root = '';
let out = '';
let err = '';
let gitLog = '';

/** The process environment without anything GitHub Actions would set (the tests may themselves run in Actions). */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GITHUB_|GIT_CONFIG_|GIT_TRACE|MCS_CI_)/i.test(name)),
  );
  return { ...env, FAKE_GIT_LOG: gitLog, ...extra };
}

function io(env: NodeJS.ProcessEnv, cwd = root): Partial<Io> {
  return {
    env,
    cwd,
    gitBin: FAKE_GIT,
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
  };
}

function calls(): GitCall[] {
  if (!existsSync(gitLog)) return [];
  return readFileSync(gitLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as GitCall);
}

function git(args: string[], cwd = root): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function record(name: string, result: string, extra: Partial<JobRecord> = {}): JobRecord {
  return { name, os: 'Linux', arch: 'X64', node: '24', result, gates: [], failedGate: null, tail: [], ...extra };
}

function writeJobs(dir: string, jobs: JobRecord[]): string {
  const target = join(root, dir);
  jobs.forEach((job, index) => {
    mkdirSync(join(target, `ci-job-${index}`), { recursive: true });
    writeFileSync(join(target, `ci-job-${index}`, 'ci-job.json'), JSON.stringify(job));
  });
  return target;
}

function runEnv(sha: string, runId: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: 'refs/heads/main',
    ...extra,
  });
}

function makeBare(): string {
  const bare = join(root, 'remote.git');
  git(['init', '-q', '--bare', bare]);
  return bare;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-ci-status-test-'));
  gitLog = join(root, 'git-calls.jsonl');
  out = '';
  err = '';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sanitizing', () => {
  it('removes colour codes, control characters and anything that looks like a credential', () => {
    expect(sanitizeLine(`${ESC}[31mFAIL${ESC}[0m done`)).toBe('FAIL done');
    expect(sanitizeLine('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end')).not.toContain('ghp_abc');
    expect(sanitizeLine('AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0')).not.toContain('eC1hY2Nl');
    expect(sanitizeLine('https://user:pw@example.invalid/repo.git')).toBe('https://***@example.invalid/repo.git');
    expect(sanitizeLine(`opaque ${TOKEN} end`)).not.toContain(TOKEN);
    expect(sanitizeLine('expected 1 to be 2 in packages/engine/src/platform/process.test.ts')).toBe(
      'expected 1 to be 2 in packages/engine/src/platform/process.test.ts',
    );
    expect(sanitizeLine('x'.repeat(1000)).length).toBeLessThan(410);
  });

  it('classifies remotes: only a path or file:// is local, scp-like and ssh are refused kinds', () => {
    expect(remoteKind('/tmp/remote.git')).toBe('local');
    expect(remoteKind('C:/work/remote.git')).toBe('local');
    expect(remoteKind('../remote.git')).toBe('local');
    expect(remoteKind('file:///tmp/remote.git')).toBe('local');
    expect(remoteKind('https://example.invalid/o/r.git')).toBe('https');
    expect(remoteKind('ssh://git@example.invalid/o/r.git')).toBe('other');
    expect(remoteKind('git@example.invalid:o/r.git')).toBe('other');
    expect(remoteKind('http://example.invalid/o/r.git')).toBe('other');
  });
});

describe('summarize', () => {
  it('builds one job record with a bounded, sanitized tail from the ci.mjs summary', () => {
    const tail = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    tail[55] = `leaked ghp_${'z'.repeat(36)} here`;
    tail[56] = `Authorization: bearer ${TOKEN}`;
    writeFileSync(
      join(root, 'ci-summary.json'),
      JSON.stringify({
        schema: 'mcs.ci-run/1',
        result: 'fail',
        gates: [
          { name: 'lint', result: 'pass', ms: 12 },
          { name: 'test', result: 'fail', ms: 34 },
        ],
        failedGate: 'test',
        tail,
      }),
    );
    const env = baseEnv({
      MCS_CI_JOB: 'gates',
      MCS_CI_OS: 'Windows',
      MCS_CI_ARCH: 'X64',
      MCS_CI_NODE: '24',
      MCS_CI_JOB_STATUS: 'failure',
    });
    expect(main(['summarize', '--in', 'ci-summary.json', '--out', 'out/ci-job.json'], io(env))).toBe(0);
    const job = JSON.parse(readFileSync(join(root, 'out', 'ci-job.json'), 'utf8')) as JobRecord;
    expect(job).toMatchObject({
      name: 'gates',
      os: 'Windows',
      arch: 'X64',
      node: '24',
      result: 'fail',
      failedGate: 'test',
    });
    expect(job.gates).toEqual([
      { name: 'lint', result: 'pass', ms: 12 },
      { name: 'test', result: 'fail', ms: 34 },
    ]);
    expect(job.tail).toHaveLength(40);
    expect(job.tail[0]).toBe('line 20');
    const text = JSON.stringify(job);
    expect(text).not.toContain('ghp_zzzz');
    expect(text).not.toContain(TOKEN);
  });

  it('falls back to the job status when there is no summary (the lean macOS and e2e jobs)', () => {
    const env = baseEnv({
      MCS_CI_JOB: 'macos',
      MCS_CI_OS: 'macOS',
      MCS_CI_ARCH: 'ARM64',
      MCS_CI_JOB_STATUS: 'success',
    });
    expect(main(['summarize', '--out', 'ci-job.json'], io(env))).toBe(0);
    const job = JSON.parse(readFileSync(join(root, 'ci-job.json'), 'utf8')) as JobRecord;
    expect(job).toMatchObject({ name: 'macos', os: 'macOS', arch: 'ARM64', result: 'pass', gates: [], tail: [] });
  });

  it('turns a passing summary into a failure when a later step of the job failed', () => {
    writeFileSync(join(root, 's.json'), JSON.stringify({ schema: 'mcs.ci-run/1', result: 'pass', gates: [] }));
    const env = baseEnv({ MCS_CI_JOB: 'gates', MCS_CI_JOB_STATUS: 'failure' });
    expect(main(['summarize', '--in', 's.json', '--out', 'j.json'], io(env))).toBe(0);
    expect((JSON.parse(readFileSync(join(root, 'j.json'), 'utf8')) as JobRecord).result).toBe('fail');
  });
});

describe('publish refuses network remotes outside GitHub Actions', () => {
  it.each([
    ['an https remote outside Actions', 'https://example.invalid/o/r.git', {}],
    [
      'an https remote in Actions with an empty token',
      'https://example.invalid/o/r.git',
      { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: '' },
    ],
    ['an scp-like ssh remote', 'git@example.invalid:o/r.git', { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: TOKEN }],
    ['an ssh URL', 'ssh://git@example.invalid/o/r.git', {}],
    [
      'an https remote with credentials in the URL',
      'https://user:pw@example.invalid/o/r.git',
      { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: TOKEN },
    ],
  ])('exits 2 and runs no git at all for %s', (_label, remote, extra: Record<string, string>) => {
    const jobs = writeJobs('jobs', [record('gates', 'pass')]);
    expect(main(['publish', '--dir', jobs, '--remote', remote], io(runEnv(SHA_A, '1', extra)))).toBe(2);
    expect(err).toContain('refused');
    expect(calls()).toEqual([]);
    expect(out + err).not.toContain(TOKEN);
  });

  it('defaults the remote to the repository of the Actions run and refuses it outside Actions', () => {
    const jobs = writeJobs('jobs', [record('gates', 'pass')]);
    const env = runEnv(SHA_A, '1', { GITHUB_SERVER_URL: 'https://example.invalid', GITHUB_REPOSITORY: 'o/r' });
    expect(main(['publish', '--dir', jobs], io(env))).toBe(2);
    expect(calls()).toEqual([]);
  });
});

describe.runIf(gitInstalled)('publish and read against a temporary bare repository', () => {
  function branchFile(bare: string, path: string): string {
    return git(['--git-dir', bare, 'show', `ci-status:${path}`]);
  }

  it('creates the orphan branch on first use, then adds a run file and moves latest.json', () => {
    const bare = makeBare();
    const jobs = writeJobs('jobs', [record('gates', 'pass'), record('macos', 'pass', { os: 'macOS', arch: 'ARM64' })]);
    expect(main(['publish', '--dir', jobs, '--remote', bare], io(runEnv(SHA_A, '7')))).toBe(0);
    expect(git(['--git-dir', bare, 'rev-list', '--count', 'ci-status'])).toBe('1');
    expect(git(['--git-dir', bare, 'rev-list', '--parents', '-n', '1', 'ci-status']).split(' ')).toHaveLength(1);
    const run = JSON.parse(branchFile(bare, `runs/${SHA_A}/7-1.json`)) as {
      schema: string;
      result: string;
      jobs: JobRecord[];
    };
    expect(run.schema).toBe('mcs.ci-status/1');
    expect(run.result).toBe('pass');
    expect(run.jobs.map((job) => job.name)).toEqual(['gates', 'macos']);
    expect(JSON.parse(branchFile(bare, 'latest.json'))).toEqual({ sha: SHA_A, runId: '7', result: 'pass' });

    const failing = writeJobs('jobs2', [record('gates', 'fail', { failedGate: 'test', tail: [`poisoned ${TOKEN}`] })]);
    expect(main(['publish', '--dir', failing, '--remote', bare], io(runEnv(SHA_B, '8')))).toBe(0);
    expect(git(['--git-dir', bare, 'rev-list', '--count', 'ci-status'])).toBe('2');
    expect(git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'ci-status']).split('\n')).toEqual([
      'latest.json',
      `runs/${SHA_A}/7-1.json`,
      `runs/${SHA_B}/8-1.json`,
    ]);
    expect(JSON.parse(branchFile(bare, 'latest.json'))).toEqual({ sha: SHA_B, runId: '8', result: 'fail' });
    expect(branchFile(bare, `runs/${SHA_B}/8-1.json`)).not.toContain(TOKEN);

    const all = calls();
    expect(all.length).toBeGreaterThan(5);
    for (const call of all) {
      expect(call.argv.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
      expect(call.prompt).toBe('0');
      expect(call.askpass).toBeNull();
      expect(call.argv).not.toContain('--force');
      expect(call.argv).not.toContain('-f');
      expect(call.argv.some((arg) => arg.startsWith('+'))).toBe(false);
    }
    expect(all.filter((call) => call.argv[2] === 'push')).toHaveLength(2);
  });

  it('in Actions sends the token only as an extra header through the environment, never in argv, output or the git trace', () => {
    const bare = makeBare();
    const jobs = writeJobs('jobs', [record('gates', 'pass')]);
    const trace = join(root, 'git-trace.log');
    const env = runEnv(SHA_A, '9', { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: TOKEN, GIT_TRACE: trace });
    expect(main(['publish', '--dir', jobs, '--remote', bare], io(env))).toBe(0);
    const all = calls();
    expect(all.every((call) => call.header)).toBe(true);
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const traceText = readFileSync(trace, 'utf8');
    expect(traceText).toContain('push');
    for (const textOut of [traceText, out, err, JSON.stringify(all.map((call) => call.argv))]) {
      expect(textOut).not.toContain(TOKEN);
      expect(textOut).not.toContain(encoded);
      expect(textOut.toLowerCase()).not.toContain('extraheader');
    }
  });

  it('survives two concurrent publishers (a relative path remote): both runs land, the history stays linear', async () => {
    const bare = makeBare();
    const jobs = writeJobs('jobs', [record('gates', 'pass')]);
    const publishOnce = (runId: string): Promise<number> =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [SCRIPT, 'publish', '--dir', jobs, '--remote', 'remote.git'], {
          cwd: root,
          env: runEnv(SHA_A, runId),
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('close', (code) => {
          resolvePromise(code ?? 1);
        });
      });
    expect(await Promise.all([publishOnce('20'), publishOnce('21')])).toEqual([0, 0]);
    expect(git(['--git-dir', bare, 'rev-list', '--count', 'ci-status'])).toBe('2');
    expect(git(['--git-dir', bare, 'rev-list', '--merges', 'ci-status'])).toBe('');
    const files = git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'ci-status']).split('\n');
    expect(files).toEqual(['latest.json', `runs/${SHA_A}/20-1.json`, `runs/${SHA_A}/21-1.json`]);
  }, 60_000);

  it('read returns 3 without a result, 0 for a green run, 1 for a failed one, and never fetches', () => {
    const bare = makeBare();
    const clone = join(root, 'clone');
    git(['init', '-q', clone]);
    git(['-c', 'user.name=t', '-c', 'user.email=', 'commit', '-q', '--allow-empty', '-m', 'x'], clone);
    const head = git(['rev-parse', 'HEAD'], clone);
    const fetchLead = (): void => {
      git(['fetch', '-q', bare, 'ci-status:refs/remotes/origin/ci-status'], clone);
    };
    const readOnce = (args: string[], cwd = clone): number => {
      writeFileSync(gitLog, '');
      out = '';
      const code = main(['read', ...args], io(baseEnv(), cwd));
      const verbs = calls().map((call) => call.argv[2] ?? '');
      expect(
        verbs.every((verb) => ['rev-parse', 'ls-tree', 'show'].includes(verb)),
        verbs.join(' '),
      ).toBe(true);
      return code;
    };
    expect(readOnce(['--sha', 'HEAD'])).toBe(3);
    expect(out).toContain('git fetch origin ci-status');

    const green = writeJobs('j1', [record('gates', 'pass')]);
    expect(main(['publish', '--dir', green, '--remote', bare], io(runEnv(head, '30')))).toBe(0);
    expect(readOnce(['--sha', 'HEAD'])).toBe(3); // not fetched yet: the tool never fetches
    fetchLead();
    expect(readOnce(['--sha', 'HEAD'])).toBe(0);
    expect(out).toContain('run 30-1: pass');
    const subfolder = join(clone, 'runtime', 'scripts');
    mkdirSync(subfolder, { recursive: true });
    expect(readOnce(['--sha', 'HEAD'], subfolder)).toBe(0); // the usage runs read from runtime/
    expect(out).toContain('run 30-1: pass');
    expect(readOnce(['--sha', SHA_B, '--remote', 'origin'])).toBe(3);

    const red = writeJobs('j2', [record('gates', 'fail', { failedGate: 'lint' })]);
    expect(main(['publish', '--dir', red, '--remote', bare], io(runEnv(head, '31')))).toBe(0);
    fetchLead();
    expect(readOnce(['--sha', head])).toBe(1);
    expect(out).toContain('run 31-1: fail');
    expect(out).toContain('at lint');
  }, 60_000);

  it('read with the remote tracking ref missing never runs fetch, ls-remote or push', () => {
    const clone = join(root, 'clone');
    git(['init', '-q', clone]);
    git(['-c', 'user.name=t', '-c', 'user.email=', 'commit', '-q', '--allow-empty', '-m', 'x'], clone);
    expect(main(['read', '--sha', 'HEAD'], io(baseEnv(), clone))).toBe(3);
    const verbs = calls().map((call) => call.argv[2]);
    expect(verbs).toEqual(['rev-parse', 'rev-parse']);
  });
});
