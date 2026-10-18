// Worktree source of the Docker POSIX harness (ADR 0065 item 4, D-11): a read-only snapshot of the working tree (tracked and
// untracked files that git does not ignore) written as a ustar archive by a small Node writer. Only read-only git commands run.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** Largest file size a ustar header can hold (11 octal digits). */
export const USTAR_MAX_SIZE = 0o77777777777;
const BLOCK = 512;
/** The only git subcommands this module may run. */
export const READ_ONLY_GIT = new Set(['ls-files', 'rev-parse']);

function defaultRunGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

function git(runGit, cwd, args) {
  if (!READ_ONLY_GIT.has(args[0]))
    throw new Error(`refusing to run git ${args[0]}: only read-only commands are allowed`);
  return runGit(cwd, args);
}

/**
 * Files of the working tree under `root` (a git work tree): `git ls-files -z --cached --others --exclude-standard`, sorted and
 * de-duplicated, without tracked files that were deleted in the working tree. Each entry carries the git index mode when tracked.
 */
export function listWorktreeFiles(root, { runGit = defaultRunGit } = {}) {
  const names = git(runGit, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const indexModes = new Map();
  for (const entry of git(runGit, root, ['ls-files', '-z', '--stage']).toString('utf8').split('\0')) {
    const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/s.exec(entry);
    if (match) indexModes.set(match[2], match[1]);
  }
  const files = [];
  for (const name of [...new Set(names)].sort()) {
    let stat;
    try {
      stat = lstatSync(join(root, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue; // tracked but deleted in the working tree
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`worktree snapshot: symbolic links are not supported: ${name}`);
    if (!stat.isFile()) throw new Error(`worktree snapshot: not a regular file (submodule?): ${name}`);
    const indexMode = indexModes.get(name);
    const executable = indexMode ? indexMode === '100755' : (stat.mode & 0o111) !== 0;
    files.push({
      path: name,
      mode: executable ? 0o755 : 0o644,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  }
  return files;
}

function writeString(header, text, offset, length, label) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > length) throw new Error(`ustar ${label} too long: ${text}`);
  bytes.copy(header, offset);
}

function writeOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** Splits a path into the ustar `prefix` (<= 155 bytes) and `name` (<= 100 bytes) fields, or throws. */
export function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new Error(`worktree snapshot: path too long for a ustar archive: ${path}`);
}

/** One 512-byte ustar header for a regular file. */
export function ustarHeader({ path, mode, size, mtime }, maxSize = USTAR_MAX_SIZE) {
  if (size > maxSize) throw new Error(`worktree snapshot: file above the ustar size limit (${size} bytes): ${path}`);
  const { prefix, name } = splitUstarPath(path);
  const header = Buffer.alloc(BLOCK);
  writeString(header, name, 0, 100, 'name');
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 1000, 108, 8);
  writeOctal(header, 1000, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtime, 136, 12);
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeString(header, 'node', 265, 32, 'uname');
  writeString(header, 'node', 297, 32, 'gname');
  writeString(header, prefix, 345, 155, 'prefix');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/**
 * The ustar archive of `files` (from `listWorktreeFiles`) as a Readable. Headers are checked up front for the whole list, so an
 * unsupported path fails before the first byte is written.
 */
export function createWorktreeTar(root, files, { maxSize = USTAR_MAX_SIZE } = {}) {
  for (const file of files) {
    splitUstarPath(file.path);
    if ((file.size ?? 0) > maxSize) {
      throw new Error(`worktree snapshot: file above the ustar size limit (${file.size} bytes): ${file.path}`);
    }
  }
  async function* blocks() {
    for (const file of files) {
      const data = readFileSync(join(root, file.path));
      yield ustarHeader({ ...file, size: data.length }, maxSize);
      yield data;
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(blocks(), { objectMode: false });
}

/** Repository root of `dir` (read-only `git rev-parse --show-toplevel`). */
export function repoRoot(dir, { runGit = defaultRunGit } = {}) {
  return git(runGit, dir, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
}
