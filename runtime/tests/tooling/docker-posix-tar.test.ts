// Worktree source of the Docker POSIX harness (`scripts/docker-posix-tar.mjs`): the file list comes from git (tracked plus
// untracked, not ignored, without deleted files), the ustar archive reads back with `tar` byte for byte and mode for mode,
// unusual paths survive, symbolic links and oversized files are refused, and only read-only git commands run.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as harnessModule from '../../scripts/docker-posix.mjs';
// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as tarModule from '../../scripts/docker-posix-tar.mjs';

const gitInstalled = spawnSync('git', ['--version']).status === 0;
const tarInstalled = spawnSync('tar', ['--version']).status === 0;
const ODD = 'dir with space/caf\u00e9 \u0111\u1ed3.txt';

interface Entry {
  path: string;
  mode: number;
  size: number;
}

interface HarnessIo {
  env: NodeJS.ProcessEnv;
  dockerBin: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  signals: EventEmitter;
}
type RunGit = (cwd: string, args: string[]) => Buffer;

const { runHarness } = harnessModule as unknown as { runHarness: (argv: string[], io: HarnessIo) => Promise<number> };
const { READ_ONLY_GIT, createWorktreeTar, listWorktreeFiles } = tarModule as unknown as {
  READ_ONLY_GIT: Set<string>;
  createWorktreeTar: (root: string, files: Entry[], opts?: { maxSize?: number }) => NodeJS.ReadableStream;
  listWorktreeFiles: (root: string, opts?: { runGit?: RunGit }) => Entry[];
};

let root = '';
let repo = '';

function git(args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-docker-tar-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'dir with space'), { recursive: true });
  if (!gitInstalled) return;
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
  writeFileSync(join(repo, 'gone.txt'), 'deleted later\n');
  writeFileSync(join(repo, ODD), 'odd path\n');
  git(['init', '-q']);
  git(['add', '.']);
  git(['update-index', '--chmod=+x', 'run.sh']);
  git(['commit', '-q', '-m', 'init']);
  unlinkSync(join(repo, 'gone.txt'));
  writeFileSync(join(repo, 'tracked.txt'), 'edited, not committed\n');
  writeFileSync(join(repo, 'untracked.txt'), 'new file\n');
  writeFileSync(join(repo, 'ignored.txt'), 'ignored\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(gitInstalled)('worktree snapshot', () => {
  it('lists tracked and untracked files, skips ignored and deleted ones, and runs read-only git only', () => {
    const seen: string[][] = [];
    const runGit = (cwd: string, args: string[]) => {
      seen.push(args);
      return spawnSync('git', args, { cwd, encoding: 'buffer' }).stdout;
    };
    const files = listWorktreeFiles(repo, { runGit });
    expect(files.map((f) => f.path)).toEqual(['.gitignore', ODD, 'run.sh', 'tracked.txt', 'untracked.txt']);
    expect(seen[0]).toEqual(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    for (const args of seen) expect(READ_ONLY_GIT.has(args[0] ?? '')).toBe(true);
    expect(files.find((f) => f.path === 'run.sh')!.mode).toBe(0o755);
    expect(files.find((f) => f.path === 'tracked.txt')!.mode).toBe(0o644);
  });

  it.runIf(tarInstalled)('writes a ustar archive that tar reads back with the same bytes and modes', async () => {
    const files = listWorktreeFiles(repo);
    const tarFile = join(root, 'snap.tar');
    writeFileSync(tarFile, await toBuffer(createWorktreeTar(repo, files)));
    const dest = join(root, 'dest');
    mkdirSync(dest);
    // Relative names keep GNU tar on Windows away from drive-letter paths ("C:" reads as a remote host).
    const extract = spawnSync('tar', ['-x', '-f', 'snap.tar', '-C', 'dest'], { cwd: root, encoding: 'utf8' });
    expect(extract.status, extract.stderr).toBe(0);
    for (const file of files) {
      expect(readFileSync(join(dest, file.path)).equals(readFileSync(join(repo, file.path)))).toBe(true);
    }
    const listing = spawnSync('tar', ['-t', '-v', '-f', 'snap.tar'], { cwd: root, encoding: 'utf8' }).stdout;
    expect(listing).toMatch(/-rwxr-xr-x .*run\.sh/);
    expect(listing).toMatch(/-rw-r--r-- .*tracked\.txt/);
    expect(readFileSync(join(dest, 'tracked.txt'), 'utf8')).toBe('edited, not committed\n');
  });

  it('refuses a file above the ustar size limit with a clear message', () => {
    const files = listWorktreeFiles(repo);
    expect(() => createWorktreeTar(repo, files, { maxSize: 4 })).toThrow(/above the ustar size limit/);
  });

  it('refuses a symbolic link with a clear message', () => {
    try {
      symlinkSync('tracked.txt', join(repo, 'link.txt'));
    } catch {
      return; // no symlink permission on this machine (Windows without developer mode)
    }
    expect(() => listWorktreeFiles(repo)).toThrow(/symbolic links are not supported: link\.txt/);
  });

  it('--worktree together with --ref exits 2', async () => {
    let stderr = '';
    const code = await runHarness(['--worktree', '--ref', 'HEAD', '--repo', repo], {
      env: process.env,
      dockerBin: join(root, 'no-such-docker'),
      stdout: { write: () => true },
      stderr: { write: (t: string) => (stderr += t) },
      signals: new EventEmitter(),
    });
    expect(code).toBe(2);
    expect(stderr).toContain('mutually exclusive');
  });

  it('pipes the snapshot into the container through the fake docker', async () => {
    const log = join(root, 'docker.log');
    const stdinDir = join(root, 'stdin');
    mkdirSync(stdinDir);
    writeFileSync(log, '');
    const code = await runHarness(['--worktree', '--targets', 'node24', '--repo', repo, '--out', join(root, 'out')], {
      dockerBin: join(import.meta.dirname, 'fixtures', 'fake-docker.mjs'),
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: log,
        FAKE_DOCKER_DIR: stdinDir,
        FAKE_DOCKER_PLAN: JSON.stringify({ inspect: 0 }),
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
      signals: new EventEmitter(),
    });
    expect(code).toBe(0);
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    const runIndex = calls.findIndex((c) => c[0] === 'run');
    const sent = readFileSync(join(stdinDir, `${runIndex}.stdin`));
    const expected = await toBuffer(createWorktreeTar(repo, listWorktreeFiles(repo)));
    expect(sent.length).toBe(expected.length);
    expect(sent.includes(Buffer.from('edited, not committed'))).toBe(true);
    expect(sent.includes(Buffer.from('ignored\n'))).toBe(false);
  });
});
