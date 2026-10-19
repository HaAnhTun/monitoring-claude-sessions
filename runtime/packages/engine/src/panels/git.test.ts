import { mkdirSync, readFileSync, utimesSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PanelResponseSchema } from '@mcs/shared';
import { FakeClock, FIXTURE_EPOCH_MS, useTempDirs, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { buildChildEnv, execFileText, resolveExecutable, type ChildResult, type ChildSpec } from '../platform/exec.ts';
import { createErrorRing } from '../runtime/error-ring.ts';
import { createGitSampler, parseLogOutput, parseStatusV2, type GitExec } from './git.ts';
import { panelStatus } from './source-cache.ts';

const makeTemp = useTempDirs();
const gitPath = await resolveExecutable('git');

/** Lets the background refresh of a cache (microtasks only, the fake runner answers at once) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

const FAKE_GIT = path.resolve('/fixture/bin/git.exe');
const REPO = path.resolve('/fixture/repo');
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

const result = (over: Partial<ChildResult>): ChildResult => ({
  ok: over.error === undefined && (over.code ?? 0) === 0,
  code: 0,
  stdout: '',
  stderr: '',
  error: null,
  truncated: false,
  durationMs: 1,
  ...over,
});

const statusText = (oid: string, head: string, entries: readonly string[] = []): string =>
  [`# branch.oid ${oid}`, `# branch.head ${head}`, ...entries].join('\n') + '\n';

const logText = (...rows: readonly [string, string, string][]): string =>
  rows.map(([hash, at, subject]) => `${hash}\u001f${at}\u001f${subject}`).join('\n') + '\n';

interface Fake {
  exec: GitExec;
  calls: ChildSpec[];
  statusCalls(): ChildSpec[];
  logCalls(): ChildSpec[];
}

function fakeExec(
  handler: (verb: 'status' | 'log', spec: ChildSpec) => Partial<ChildResult>,
  path_: string | null = FAKE_GIT,
): Fake {
  const calls: ChildSpec[] = [];
  const verbOf = (spec: ChildSpec): 'status' | 'log' => (spec.args.includes('status') ? 'status' : 'log');
  return {
    calls,
    statusCalls: () => calls.filter((c) => verbOf(c) === 'status'),
    logCalls: () => calls.filter((c) => verbOf(c) === 'log'),
    exec: {
      resolveExecutable: () => Promise.resolve(path_),
      execFileText: (spec) => {
        calls.push(spec);
        return Promise.resolve(result(handler(verbOf(spec), spec)));
      },
    },
  };
}

function sampler(
  fake: Fake,
  over: { stopFile?: string | null; exists?: (file: string) => Promise<boolean>; folderExists?: boolean } = {},
) {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const errors = createErrorRing(clock);
  const git = createGitSampler({
    repoDir: REPO,
    stopFile: over.stopFile ?? null,
    clock,
    errors,
    exec: fake.exec,
    dirExists: () => Promise.resolve(over.folderExists ?? true),
    ...(over.exists === undefined ? {} : { fileExists: over.exists }),
  });
  return { clock, errors, git };
}

describe('parseStatusV2', () => {
  it('reads the branch, the head oid and counts every entry line', () => {
    const text = statusText(OID_A, 'main', [
      '1 .M N... 100644 100644 100644 aaa bbb src/changed.txt',
      '? untracked.txt',
    ]);
    expect(parseStatusV2(text)).toEqual({ headOid: OID_A, branch: 'main', detached: false, dirty: 2 });
  });

  it('reads an initial repository: no head oid, a branch name', () => {
    expect(parseStatusV2(statusText('(initial)', 'main', ['? new.txt']))).toEqual({
      headOid: null,
      branch: 'main',
      detached: false,
      dirty: 1,
    });
  });

  it('reads a detached head: no branch name', () => {
    expect(parseStatusV2(statusText(OID_A, '(detached)'))).toEqual({
      headOid: OID_A,
      branch: null,
      detached: true,
      dirty: 0,
    });
  });

  it('counts a renamed entry once and an unmerged entry once', () => {
    const text = statusText(OID_A, 'topic', [
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\told name.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
    ]);
    expect(parseStatusV2(text).dirty).toBe(2);
  });

  it('accepts CRLF line ends and ignores other header lines and blank lines', () => {
    const text = `# branch.oid ${OID_A}\r\n# branch.head main\r\n# branch.upstream origin/main\r\n# branch.ab +1 -0\r\n\r\n? a.txt\r\n`;
    expect(parseStatusV2(text)).toEqual({ headOid: OID_A, branch: 'main', detached: false, dirty: 1 });
  });

  it('keeps a branch name with spaces out of the picture only because git forbids them, and takes the rest of the line', () => {
    expect(parseStatusV2('# branch.head feature/x-1\n').branch).toBe('feature/x-1');
  });
});

describe('parseLogOutput', () => {
  it('splits hash, ISO author time and subject and keeps at most three commits', () => {
    const text = logText(
      ['abc1234', '2026-01-02T03:04:05+00:00', 'third'],
      ['abc1233', '2026-01-01T03:04:05+02:00', 'second'],
      ['abc1232', '2025-12-31T00:00:00+00:00', 'first'],
      ['abc1231', '2025-12-30T00:00:00+00:00', 'fourth, dropped'],
    );
    expect(parseLogOutput(text)).toEqual([
      { hash: 'abc1234', subject: 'third', at: '2026-01-02T03:04:05.000Z' },
      { hash: 'abc1233', subject: 'second', at: '2026-01-01T01:04:05.000Z' },
      { hash: 'abc1232', subject: 'first', at: '2025-12-31T00:00:00.000Z' },
    ]);
  });

  it('gives a null time for an invalid date, skips lines without three fields and clips a long subject', () => {
    const text = `h1\u001fnot a date\u001f${'s'.repeat(400)}\nbroken line\n\nh2\u001f\u001f\n`;
    const commits = parseLogOutput(text);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: 'h1', at: null });
    expect(Array.from(commits[0]?.subject ?? '')).toHaveLength(300);
    expect(commits[1]).toEqual({ hash: 'h2', subject: '', at: null });
  });
});

describe('git sampler with a fake runner', () => {
  const cleanRepo = (verb: 'status' | 'log'): Partial<ChildResult> =>
    verb === 'status'
      ? { stdout: statusText(OID_A, 'main', ['? a.txt', '1 .M N... 100644 100644 100644 aaa bbb b.txt']) }
      : { stdout: logText(['abc1234', '2026-01-02T03:04:05+00:00', 'subject one']) };

  it('runs the lock-free status and log commands in the repository folder and shapes the panel', async () => {
    const fake = fakeExec(cleanRepo);
    const { git } = sampler(fake);
    const sample = await git.read();
    expect(sample.data).toEqual({
      branch: 'main',
      dirty: 2,
      stopFile: false,
      commits: [{ hash: 'abc1234', subject: 'subject one', at: '2026-01-02T03:04:05.000Z' }],
      headOid: OID_A,
      detached: false,
      repoState: 'ok',
    });
    expect(sample.sources.map((s) => [s.source, s.status])).toEqual([
      ['git.status', 'ok'],
      ['git.log', 'ok'],
      ['stopFile', 'disabled'],
    ]);
    expect(panelStatus(sample.sources, sample.data !== null)).toBe('ok');
    expect(
      PanelResponseSchema.safeParse({
        key: 'git',
        status: 'ok',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sources: sample.sources,
        data: sample.data,
      }).success,
    ).toBe(true);

    const [status] = fake.statusCalls();
    const [log] = fake.logCalls();
    expect(status?.kind).toBe('git');
    expect(status?.file).toBe(FAKE_GIT);
    expect(status?.cwd).toBe(REPO);
    expect(status?.args).toEqual([
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'color.ui=never',
      'status',
      '--porcelain=v2',
      '--branch',
    ]);
    expect(log?.args).toEqual([
      '--no-optional-locks',
      '-c',
      'color.ui=never',
      'log',
      '-3',
      '--no-color',
      '--format=%h%x1f%aI%x1f%s',
    ]);
  });

  it('puts no configuration string into an argument or the environment of the call', async () => {
    const fake = fakeExec(cleanRepo);
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const git = createGitSampler({
      repoDir: REPO,
      stopFile: 'STOP-SENTINEL-FILE',
      clock,
      errors: createErrorRing(clock),
      exec: fake.exec,
      fileExists: () => Promise.resolve(true),
    });
    await git.read();
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain('SENTINEL');
      expect(call.args.join(' ')).not.toContain('fixture');
      expect(call.extraEnv).toBeUndefined();
    }
    // the lock and prompt switches arrive through the environment of kind git
    expect(buildChildEnv('git')['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(buildChildEnv('git')['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('makes no call for a second read inside the status ttl, and shares one call between concurrent reads', async () => {
    const fake = fakeExec(cleanRepo);
    const { git, clock } = sampler(fake);
    await Promise.all(Array.from({ length: 50 }, () => git.read()));
    expect(fake.statusCalls()).toHaveLength(1);
    expect(fake.logCalls()).toHaveLength(1);
    clock.advance(14_999);
    await git.read();
    expect(fake.calls).toHaveLength(2);
  });

  it('runs the log again only when the head oid changes or after 120 seconds', async () => {
    let oid = OID_A;
    const fake = fakeExec((verb) =>
      verb === 'status'
        ? { stdout: statusText(oid, 'main') }
        : { stdout: logText([oid.slice(0, 7), '2026-01-02T03:04:05+00:00', `at ${oid.slice(0, 1)}`]) },
    );
    const { git, clock } = sampler(fake);
    await git.read();
    expect(fake.logCalls()).toHaveLength(1);

    // same oid, status refreshed every 15 s: the log is not asked again inside 120 s
    for (let i = 0; i < 6; i += 1) {
      clock.advance(15_000);
      await git.read();
      await settle();
    }
    expect(fake.statusCalls().length).toBeGreaterThanOrEqual(6);
    expect(fake.logCalls()).toHaveLength(1);

    // a new head oid: the log is read again and the new commits are served at once
    oid = OID_B;
    clock.advance(15_000);
    await git.read(); // serves the old status and starts the refresh
    await settle();
    const after = await git.read();
    expect(fake.logCalls()).toHaveLength(2);
    expect(after.data?.headOid).toBe(OID_B);
    expect(after.data?.commits[0]?.subject).toBe('at b');

    // 120 s without a head move: one more log call
    for (let i = 0; i < 9; i += 1) {
      clock.advance(15_000);
      await git.read();
      await settle();
    }
    expect(fake.logCalls().length).toBeGreaterThanOrEqual(3);
  });

  it('does not run the log for an initial repository', async () => {
    const fake = fakeExec(() => ({ stdout: statusText('(initial)', 'main', ['? a.txt']) }));
    const { git } = sampler(fake);
    const sample = await git.read();
    expect(fake.logCalls()).toHaveLength(0);
    expect(sample.data).toMatchObject({ branch: 'main', dirty: 1, commits: [], headOid: null, repoState: 'ok' });
    expect(sample.sources[1]).toMatchObject({ source: 'git.log', status: 'ok' });
  });

  it('reports a detached head', async () => {
    const detached = fakeExec((verb) =>
      verb === 'status' ? { stdout: statusText(OID_A, '(detached)') } : cleanRepo(verb),
    );
    const sample = await sampler(detached).git.read();
    expect(sample.data).toMatchObject({ branch: null, detached: true, headOid: OID_A, dirty: 0 });
  });

  it('answers not_a_repository when the spawn fails with ENOENT and the repository folder is gone', async () => {
    const fake = fakeExec(() => ({ error: 'ENOENT', code: null }));
    const sample = await sampler(fake, { folderExists: false }).git.read();
    expect(sample.data).toMatchObject({ repoState: 'not_a_repository' });
    expect(sample.sources[0]).toMatchObject({ status: 'unavailable', message: 'the repository folder was not found' });
  });

  it('answers not_a_repository for exit 128 and does not ask again for five minutes', async () => {
    const fake = fakeExec(() => ({
      code: 128,
      error: 'NONZERO_EXIT',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    }));
    const { git, clock } = sampler(fake);
    const sample = await git.read();
    expect(sample.data).toEqual({
      branch: null,
      dirty: null,
      stopFile: false,
      commits: [],
      headOid: null,
      detached: false,
      repoState: 'not_a_repository',
    });
    expect(sample.sources.map((s) => s.status)).toEqual(['unavailable', 'unavailable', 'disabled']);
    expect(sample.sources[0]?.message).toBe('the repository folder is not a git repository');
    expect(panelStatus(sample.sources, true)).toBe('partial');
    clock.advance(299_000);
    await git.read();
    expect(fake.calls).toHaveLength(1);
    clock.advance(1000);
    await git.read();
    expect(fake.calls).toHaveLength(2);
  });

  it('answers git_missing without spawning when git cannot be found', async () => {
    const fake = fakeExec(cleanRepo, null);
    const sample = await sampler(fake).git.read();
    expect(fake.calls).toHaveLength(0);
    expect(sample.data).toMatchObject({ repoState: 'git_missing', branch: null, dirty: null, commits: [] });
    expect(sample.sources[0]).toMatchObject({ status: 'unavailable', message: 'git is not installed or not on PATH' });
  });

  it('answers git_missing when the spawn fails with ENOENT and the folder exists', async () => {
    const fake = fakeExec(() => ({ error: 'ENOENT', code: null }));
    const sample = await sampler(fake).git.read();
    expect(sample.data).toMatchObject({ repoState: 'git_missing' });
  });

  it('turns another non-zero exit into an error state with the first line of stderr', async () => {
    const fake = fakeExec(() => ({
      code: 128,
      error: 'NONZERO_EXIT',
      stderr: 'fatal: detected dubious ownership in repository\nhint: second line\n',
    }));
    const { git, errors } = sampler(fake);
    const sample = await git.read();
    expect(sample.data).toMatchObject({ repoState: 'error', branch: null, dirty: null });
    expect(sample.sources[0]).toMatchObject({
      status: 'error',
      message: 'fatal: detected dubious ownership in repository',
    });
    expect(errors.list()).toHaveLength(1);
    expect(errors.list()[0]?.where).toBe('panel.git.status');
  });

  it('turns a timeout, a truncated output and a refused spawn into error states', async () => {
    for (const [over, text] of [
      [{ error: 'TIMEOUT', code: null }, 'git status timed out'],
      [{ error: 'OUTPUT_LIMIT', code: null, truncated: true }, 'git status output is too large'],
      [{ error: 'QUEUE_FULL', code: null }, 'too many child processes are running'],
      [{ error: 'SPAWN_FAILED', code: null }, 'git could not be started'],
    ] as const) {
      const sample = await sampler(fakeExec(() => over)).git.read();
      expect(sample.sources[0]).toMatchObject({ status: 'error', message: text });
    }
  });

  it('is pending with no data when the first status does not finish within the first wait', async () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const git = createGitSampler({
      repoDir: REPO,
      stopFile: null,
      clock,
      errors: createErrorRing(clock),
      exec: {
        resolveExecutable: () => Promise.resolve(FAKE_GIT),
        execFileText: () => new Promise<ChildResult>(() => undefined),
      },
      timings: { 'git.status': { firstWaitMs: 20 } },
    });
    const sample = await git.read();
    expect(sample.data).toBeNull();
    expect(sample.sources[0]).toMatchObject({ source: 'git.status', status: 'pending' });
    expect(panelStatus(sample.sources, false)).toBe('error');
    git.abort();
  });

  it('keeps the last good status when a refresh fails and says so', async () => {
    let fail = false;
    const fake = fakeExec((verb) =>
      fail && verb === 'status'
        ? { error: 'TIMEOUT', code: null }
        : verb === 'status'
          ? { stdout: statusText(OID_A, 'main', ['? a.txt']) }
          : { stdout: logText(['abc1234', '2026-01-02T03:04:05+00:00', 's']) },
    );
    const { git, clock } = sampler(fake);
    await git.read();
    fail = true;
    clock.advance(15_000);
    await git.read();
    await settle();
    const sample = await git.read();
    expect(sample.data).toMatchObject({ branch: 'main', dirty: 1, repoState: 'ok' });
    expect(sample.sources[0]).toMatchObject({ status: 'error' });
    expect(panelStatus(sample.sources, true)).toBe('partial');
  });

  it('reports the stop file: present true, absent false, not configured false and disabled', async () => {
    const fake = fakeExec(cleanRepo);
    const seen: string[] = [];
    const present = await sampler(fake, {
      stopFile: 'STOP',
      exists: (file) => {
        seen.push(file);
        return Promise.resolve(true);
      },
    }).git.read();
    expect(present.data?.stopFile).toBe(true);
    expect(present.sources[2]).toMatchObject({ source: 'stopFile', status: 'ok' });
    expect(seen).toEqual([path.join(REPO, 'STOP')]);

    const absent = await sampler(fake, { stopFile: 'STOP', exists: () => Promise.resolve(false) }).git.read();
    expect(absent.data?.stopFile).toBe(false);
    expect(absent.sources[2]).toMatchObject({ status: 'ok' });

    const none = await sampler(fake).git.read();
    expect(none.data?.stopFile).toBe(false);
    expect(none.sources[2]).toMatchObject({ status: 'disabled', sampledAt: null });
  });

  it('uses an absolute stop file path as it is', async () => {
    const seen: string[] = [];
    const absolute = path.resolve('/fixture/elsewhere/STOP');
    await sampler(fakeExec(cleanRepo), {
      stopFile: absolute,
      exists: (file) => {
        seen.push(file);
        return Promise.resolve(false);
      },
    }).git.read();
    expect(seen).toEqual([absolute]);
  });

  it('counts the sources that were read in stats()', async () => {
    const { git } = sampler(fakeExec(cleanRepo));
    expect(git.stats()).toEqual({});
    await git.read();
    expect(Object.keys(git.stats()).sort()).toEqual(['git.log', 'git.status']);
    expect(git.stats()['git.status']).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
  });
});

describe.skipIf(gitPath === null)('git sampler with a real temporary repository (needs git on PATH)', () => {
  /** Runs git through the one exec helper, with a hermetic configuration and no discovery above the temp root. */
  function hermeticExec(root: string): GitExec {
    const configFile = path.join(root, 'empty-gitconfig');
    writeFileSync(configFile, '');
    const extraEnv = {
      GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(root),
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    return {
      resolveExecutable,
      execFileText: (spec, signal) => execFileText({ ...spec, extraEnv: { ...spec.extraEnv, ...extraEnv } }, signal),
    };
  }

  async function git(exec: GitExec, cwd: string, ...args: string[]): Promise<void> {
    const file = await exec.resolveExecutable('git');
    if (file === null) throw new Error('git vanished');
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

  it('gives dirty 2, two commits and the branch, and never takes the index lock', async () => {
    const root = makeTemp('git-panel').path;
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const exec = hermeticExec(root);
    await git(exec, repo, '-c', 'init.defaultBranch=main', 'init', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    writeFileSync(path.join(repo, 'b.txt'), 'one\n');
    writeFileSync(path.join(repo, 'd.txt'), 'unchanged\n');
    await git(exec, repo, 'add', '.');
    await git(exec, repo, 'commit', '-q', '-m', 'first commit');
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    await git(exec, repo, 'commit', '-q', '-a', '-m', 'second commit');
    // one modified and one untracked file
    writeFileSync(path.join(repo, 'b.txt'), 'changed in the working tree\n');
    writeFileSync(path.join(repo, 'c.txt'), 'untracked\n');
    // a tracked file whose stat data is stale but whose content is the same: a plain `git status` would rewrite the index
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, 'd.txt'), later, later);

    const gitDir = path.join(repo, '.git');
    const indexBefore = readFileSync(path.join(gitDir, 'index'));
    const names: string[] = [];
    const watcher = watch(gitDir, (_event, name) => {
      if (name !== null) names.push(name);
    });
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const sampler_ = createGitSampler({ repoDir: repo, stopFile: null, clock, errors: createErrorRing(clock), exec });
    let sample;
    try {
      sample = await sampler_.read();
      // a short grace for the watcher events that are still on their way
      const readAt = Date.now();
      await waitFor(() => Date.now() - readAt >= 100, { intervalMs: 20 });
    } finally {
      watcher.close();
    }

    expect(sample.data).toMatchObject({ branch: 'main', dirty: 2, detached: false, repoState: 'ok', stopFile: false });
    expect(sample.data?.commits.map((c) => c.subject)).toEqual(['second commit', 'first commit']);
    expect(sample.data?.headOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(sample.data?.commits.every((c) => c.at !== null)).toBe(true);
    expect(sample.sources.map((s) => s.status)).toEqual(['ok', 'ok', 'disabled']);
    expect(names).not.toContain('index.lock');
    expect(readFileSync(path.join(gitDir, 'index')).equals(indexBefore)).toBe(true);
  });

  it('answers not_a_repository for a folder that is not a repository', async () => {
    const root = makeTemp('git-panel-none').path;
    const folder = path.join(root, 'plain');
    mkdirSync(folder);
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const sampler_ = createGitSampler({
      repoDir: folder,
      stopFile: null,
      clock,
      errors: createErrorRing(clock),
      exec: hermeticExec(root),
    });
    const sample = await sampler_.read();
    expect(sample.data).toMatchObject({ repoState: 'not_a_repository', branch: null, dirty: null });
    expect(sample.sources[0]?.status).toBe('unavailable');
  });

  it('answers an unborn branch (initial repository) without a log call', async () => {
    const root = makeTemp('git-panel-init').path;
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const exec = hermeticExec(root);
    await git(exec, repo, '-c', 'init.defaultBranch=main', 'init', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const sampler_ = createGitSampler({ repoDir: repo, stopFile: null, clock, errors: createErrorRing(clock), exec });
    const sample = await sampler_.read();
    expect(sample.data).toMatchObject({ branch: 'main', headOid: null, commits: [], dirty: 1, repoState: 'ok' });
  });
});
