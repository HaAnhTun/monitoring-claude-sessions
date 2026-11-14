// Staging of the native terminal files (ADR 0082, design 01 section 2.3). The bundle ships the files of the two Windows platform
// packages of `@lydell/node-pty` (the `.node` addons, `conpty.dll`, `OpenConsole.exe` and the JavaScript that loads them). They
// come from one of four sources, in this order, and every source is checked against the same two records before a byte is used:
//   1. the installed package `node_modules/<package>` (`npm ci` installs only the one of the host platform);
//   2. the cache `node_modules/.cache/mcs-native/<tarball name>/` that an earlier run extracted (`npm ci` clears it);
//   3. `$MCS_NATIVE_TARBALLS/<tarball name>.tgz`, a folder of tarballs for a build without network (the Docker harness);
//   4. `npm pack <package>@<version>` into a temp folder.
// A tarball (3, 4) must have exactly the sha512 integrity of the lockfile AND of `native-pins.json`, is read by a tar reader that
// refuses `..`, absolute and link entries, and only the files the pins name are extracted. Each binary file must then have the
// size and sha256 of its pin; text files are normalised to LF by `nativeFilesOf`. A changed byte fails the build.
// Zero dependencies, Node only, like the other scripts. Used by `bundle.mjs`; `node scripts/native-stage.mjs` stages the pinned
// targets and prints where each one came from.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { RUNTIME_ROOT, readJson } from './lib.mjs';

export const NATIVE_PINS_FILE = join(RUNTIME_ROOT, 'scripts', 'native-pins.json');

/** Limits that keep a hostile or damaged tarball from filling the disk or the memory. */
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const MAX_TAR_ENTRIES = 2000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PACK_TIMEOUT_MS = 5 * 60 * 1000;

const TARGET_NAME = /^[a-z0-9]+-[a-z0-9]+$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A relative posix path: segments of letters, digits, `_`, `-` and `.`, none starting with a dot (so no `.` and no `..`). */
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
/** The same, with `*` allowed in the last segment (one folder level, never `**`). */
const SAFE_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_*][A-Za-z0-9_.*-]*$/;

const fail = (message) => {
  throw new Error(`native-stage: ${message}`);
};
const failPins = (label, message) => {
  throw new Error(`native-pins: ${label}: ${message}`);
};

// ---- the pins file -----------------------------------------------------------------------------------------------------------

function checkKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) failPins(label, `unknown key "${key}"`);
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validates the shape of the pins file (design 01 section 2.2) and returns it. Any deviation throws a `native-pins:` error. */
export function validateNativePins(value, label = 'native-pins.json') {
  if (!isObject(value)) failPins(label, 'the file must hold a JSON object');
  checkKeys(value, ['schemaVersion', 'package', 'version', 'equivalentUpstream', 'targets'], label);
  if (value.schemaVersion !== 1) failPins(label, 'schemaVersion must be 1');
  if (typeof value.package !== 'string' || !PACKAGE_NAME.test(value.package))
    failPins(label, 'package is not a package name');
  if (typeof value.version !== 'string' || !EXACT_VERSION.test(value.version))
    failPins(label, 'version must be an exact version');
  if (value.equivalentUpstream !== undefined && typeof value.equivalentUpstream !== 'string') {
    failPins(label, 'equivalentUpstream must be a string');
  }
  if (!isObject(value.targets) || Object.keys(value.targets).length === 0)
    failPins(label, 'targets must name at least one target');
  for (const [name, target] of Object.entries(value.targets)) {
    const where = `${label} target ${name}`;
    if (!TARGET_NAME.test(name)) failPins(label, `target name "${name}" is not <os>-<arch>`);
    if (!isObject(target)) failPins(where, 'must be an object');
    checkKeys(target, ['package', 'integrity', 'text', 'binary'], where);
    if (typeof target.package !== 'string' || !PACKAGE_NAME.test(target.package))
      failPins(where, 'package is not a package name');
    if (typeof target.integrity !== 'string' || !INTEGRITY.test(target.integrity)) {
      failPins(where, 'integrity must be a sha512 string of a lockfile');
    }
    if (!Array.isArray(target.text) || target.text.length === 0) failPins(where, 'text must list at least one pattern');
    for (const pattern of target.text) {
      if (typeof pattern !== 'string' || !SAFE_PATTERN.test(pattern) || pattern.includes('**')) {
        failPins(where, `text pattern ${JSON.stringify(pattern)} is not a safe relative pattern`);
      }
    }
    for (const required of ['package.json', 'LICENSE']) {
      if (!target.text.includes(required)) failPins(where, `text must list ${required} (the notices read it)`);
    }
    if (!isObject(target.binary) || Object.keys(target.binary).length === 0)
      failPins(where, 'binary must name at least one file');
    for (const [rel, pin] of Object.entries(target.binary)) {
      if (!SAFE_PATH.test(rel)) failPins(where, `binary path ${JSON.stringify(rel)} is not a safe relative path`);
      if (!isObject(pin)) failPins(where, `binary pin of ${rel} must be an object`);
      checkKeys(pin, ['bytes', 'sha256'], `${where} ${rel}`);
      if (!Number.isSafeInteger(pin.bytes) || pin.bytes <= 0)
        failPins(where, `${rel}: bytes must be a positive integer`);
      if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256))
        failPins(where, `${rel}: sha256 must be 64 lower-case hex digits`);
    }
  }
  return value;
}

/** Reads and validates the pins file. */
export function readNativePins(file = NATIVE_PINS_FILE) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `native-pins: ${basename(file)} cannot be read as JSON (${error instanceof Error ? error.name : 'error'})`,
      {
        cause: error,
      },
    );
  }
  return validateNativePins(value, basename(file));
}

function targetPins(pins, target) {
  if (typeof target !== 'string' || !Object.hasOwn(pins.targets, target)) fail(`no pins for target ${String(target)}`);
  return pins.targets[target];
}

// ---- small pure helpers --------------------------------------------------------------------------------------------------------

/** `sha512-<base64>`, the form of `integrity` in a lockfile. */
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The file name `npm pack` gives a tarball: `@scope/name` at `1.2.3` is `scope-name-1.2.3.tgz`. */
export function tarballFileName(pkg, version) {
  return `${pkg.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** CR LF and a lone CR become LF, byte by byte (a text file of the tarball has CR LF line ends; the repository stores LF). */
export function toLf(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0d) {
      out[length] = 0x0a;
      length += 1;
      if (bytes[i + 1] === 0x0a) i += 1;
    } else {
      out[length] = byte;
      length += 1;
    }
  }
  return Buffer.from(out.subarray(0, length));
}

/** A glob with `*` (anything but `/`) as a RegExp over a whole posix path. */
function globToRegExp(pattern) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

// ---- the tar reader ------------------------------------------------------------------------------------------------------------

const cString = (bytes) => {
  const end = bytes.indexOf(0);
  return bytes.toString('utf8', 0, end === -1 ? bytes.length : end);
};

function parseOctal(block, start, length) {
  if ((block[start] ?? 0) & 0x80) fail('tar entry uses a base-256 number, which is not supported');
  const text = block
    .toString('ascii', start, start + length)
    .replace(/[\0 ]+$/g, '')
    .replace(/^ +/, '');
  if (!/^[0-7]*$/.test(text)) fail('tar header holds a number that is not octal');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function checksumOk(block) {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum === parseOctal(block, 148, 8);
}

function parsePax(data) {
  const records = new Map();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(data.toString('ascii', at, space === -1 ? at : space), 10);
    if (space === -1 || !Number.isSafeInteger(length) || length <= space - at + 1 || at + length > data.length) {
      fail('tar pax header is damaged');
    }
    const record = data.toString('utf8', space + 1, at + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/**
 * The path of an entry relative to `package/`, or `''` for the folder itself. Refuses an absolute path, a drive letter, a
 * backslash, an empty, `.` or `..` segment, a NUL, and any path outside `package/`.
 */
function packageRelativePath(name) {
  const shown = JSON.stringify(name.slice(0, 120));
  const refuse = (reason) => fail(`tar entry refused: ${shown} (${reason})`);
  if (name === '') refuse('empty name');
  if (name.includes('\0')) refuse('NUL in the name');
  if (name.includes('\\')) refuse('backslash in the name');
  if (name.startsWith('/')) refuse('absolute path');
  if (/^[A-Za-z]:/.test(name)) refuse('drive letter');
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') refuse('empty, . or .. segment');
  }
  if (segments[0] !== 'package') refuse('outside package/');
  return segments.slice(1).join('/');
}

/**
 * The files of an npm tarball (gzip of a tar archive) as `Map<posix path below package/, Buffer>`. Understands ustar, pax and
 * GNU long names. Refuses (throws) a link, a device or any other non-file entry, a path that leaves `package/`, a file named
 * twice, a damaged header or checksum and an archive that unpacks to more than `maxBytes`.
 */
export function readTgz(buffer, { maxBytes = MAX_TAR_BYTES } = {}) {
  let raw;
  try {
    raw = gunzipSync(buffer, { maxOutputLength: maxBytes });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'error';
    if (code === 'ERR_BUFFER_TOO_LARGE') fail(`the unpacked tarball exceeds the size limit of ${maxBytes} bytes`);
    throw new Error(`native-stage: the tarball is not a valid gzip stream (${code})`, { cause: error });
  }
  const files = new Map();
  let offset = 0;
  let nextPath = null;
  let ended = false;
  let entries = 0;
  while (offset + 512 <= raw.length) {
    const block = raw.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(block)) fail(`tar checksum mismatch at offset ${offset}`);
    entries += 1;
    if (entries > MAX_TAR_ENTRIES) fail(`tar entry refused: more than ${MAX_TAR_ENTRIES} entries`);
    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156] ?? 0x30);
    const size = parseOctal(block, 124, 12);
    const start = offset + 512;
    if (start + size > raw.length) fail('the tarball is truncated');
    const data = raw.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      nextPath = parsePax(data).get('path') ?? nextPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      nextPath = cString(data);
      continue;
    }
    let name = cString(block.subarray(0, 100));
    if (block.toString('ascii', 257, 263) === 'ustar\0') {
      const prefix = cString(block.subarray(345, 500));
      if (prefix !== '') name = `${prefix}/${name}`;
    }
    if (nextPath !== null) name = nextPath;
    nextPath = null;
    const rel = packageRelativePath(name);
    if (type === '5') continue;
    if (type !== '0')
      fail(
        `tar entry refused: ${JSON.stringify(name.slice(0, 120))} (entry type ${JSON.stringify(type)}, only files are read)`,
      );
    if (rel === '')
      fail(`tar entry refused: ${JSON.stringify(name.slice(0, 120))} (a file named like the package folder)`);
    if (files.has(rel)) fail(`tar entry ${JSON.stringify(rel)} appears twice`);
    files.set(rel, Buffer.from(data));
  }
  if (!ended) fail('the tarball is truncated (no end-of-archive marker)');
  return files;
}

// ---- the files of one staged package ------------------------------------------------------------------------------------------

/** Every file below `dir` as `Map<posix path, { link: boolean }>`; a symbolic link or junction is listed, never followed. */
function listPackageFiles(dir) {
  const found = new Map();
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) found.set(rel, { link: true });
      else if (entry.isDirectory()) visit(join(current, entry.name), rel);
      else if (entry.isFile()) found.set(rel, { link: false });
    }
  };
  if (existsSync(dir)) visit(dir, '');
  return found;
}

/**
 * The files the pins of `target` name, found below `dir`, as `Map<posix path, Buffer>` sorted by path: the text files
 * (the `text` patterns) with LF line ends, the binary files (`binary`) byte for byte. Nothing else in `dir` is returned (a
 * `.pdb` file is ignored). Throws when a text pattern matches no file, a pinned file is missing, a link or has another size or
 * sha256 than its pin, a text file holds a NUL byte, or `package.json` names another package or version than the pins.
 */
export function nativeFilesOf({ dir, pins, target }) {
  const entry = targetPins(pins, target);
  const present = listPackageFiles(dir);
  const texts = new Set();
  for (const pattern of entry.text) {
    const regexp = globToRegExp(pattern);
    const matches = [...present.keys()].filter((rel) => regexp.test(rel));
    if (matches.length === 0) fail(`${target}: text pattern ${pattern} matches no file`);
    for (const rel of matches) texts.add(rel);
  }
  const out = new Map();
  for (const rel of [...texts].sort()) {
    if (present.get(rel)?.link === true) fail(`${rel}: refused, it is a symbolic link and not a regular file`);
    if (Object.hasOwn(entry.binary, rel)) fail(`${rel}: both a text pattern and a binary pin name this file`);
    const bytes = readFileSync(join(dir, ...rel.split('/')));
    if (bytes.length > MAX_TEXT_BYTES) fail(`${rel}: a text file larger than ${MAX_TEXT_BYTES} bytes`);
    if (bytes.includes(0)) fail(`${rel}: a text file holds a NUL byte`);
    out.set(rel, toLf(bytes));
  }
  for (const rel of Object.keys(entry.binary).sort()) {
    const pin = entry.binary[rel];
    const found = present.get(rel);
    if (found === undefined) fail(`${rel}: missing`);
    if (found.link) fail(`${rel}: refused, it is a symbolic link and not a regular file`);
    const bytes = readFileSync(join(dir, ...rel.split('/')));
    if (bytes.length !== pin.bytes) fail(`${rel}: ${bytes.length} bytes, the pin says ${pin.bytes} bytes`);
    if (sha256Of(bytes) !== pin.sha256) fail(`${rel}: sha256 differs from the pin`);
    out.set(rel, bytes);
  }
  let manifest;
  try {
    manifest = JSON.parse((out.get('package.json') ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    fail(`${target}: package.json is not valid JSON`);
  }
  if (manifest?.name !== entry.package || manifest?.version !== pins.version) {
    fail(
      `${target}: package.json names ${String(manifest?.name)}@${String(manifest?.version)}, ` +
        `the pins say ${entry.package}@${pins.version}`,
    );
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---- staging -------------------------------------------------------------------------------------------------------------------

/** The npm CLI (`npm-cli.js`): next to `npm_execpath` when the run came from npm or npx, else the one that ships with node. */
export function resolveNpmCli({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const started = env.npm_execpath;
  if (typeof started === 'string' && started !== '') {
    const name = basename(started);
    if (name === 'npm-cli.js' && exists(started)) return started;
    if (name === 'npx-cli.js') {
      const sibling = join(dirname(started), 'npm-cli.js');
      if (exists(sibling)) return sibling;
    }
  }
  const home = dirname(execPath);
  const candidates = [
    join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(home, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Runs a process without a shell and resolves to `{ status, stdout, stderr }` (the tails of the output; status null on a timeout). */
function runProcess(file, args, { cwd } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const tail = (text, chunk) => `${text}${chunk}`.slice(-2000);
    const timer = setTimeout(() => child.kill(), PACK_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout = tail(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr, chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ status: null, stdout, stderr: tail(stderr, error.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

/** Both records that describe a platform package must agree before any source is read. */
function assertPinsMatchLock(pins, entry, target, lock) {
  const main = lock.packages?.[`node_modules/${pins.package}`];
  if (main === undefined) fail(`${pins.package} is not in the lockfile`);
  if (main.version !== pins.version) {
    fail(`${pins.package}: the lockfile has version ${String(main.version)}, the pins say ${pins.version}`);
  }
  const locked = lock.packages?.[`node_modules/${entry.package}`];
  if (locked === undefined) fail(`${entry.package} is not in the lockfile`);
  if (locked.version !== pins.version) {
    fail(`${entry.package}: the lockfile has version ${String(locked.version)}, the pins say ${pins.version}`);
  }
  if (locked.integrity !== entry.integrity) {
    fail(`${target}: the integrity in native-pins.json differs from the lockfile entry of ${entry.package}`);
  }
}

const removeTree = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * Checks a tarball against the lockfile and the pins, reads it, and extracts the pinned files into `destination` (replacing
 * what is there). Everything is verified in a sibling temp folder first; a failure leaves `destination` as it was.
 */
function extractTarball({ bytes, label, pins, entry, target, lock, destination }) {
  const integrity = integrityOf(bytes);
  const locked = lock.packages?.[`node_modules/${entry.package}`]?.integrity;
  if (integrity !== locked)
    fail(`integrity of ${label} differs from the lockfile (${integrity} against ${String(locked)})`);
  if (integrity !== entry.integrity) fail(`integrity of ${label} differs from native-pins.json`);
  const files = readTgz(bytes);
  const wanted = [
    ...entry.text.map(globToRegExp),
    ...Object.keys(entry.binary).map((rel) => new RegExp(`^${rel.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`)),
  ];
  const scratch = `${destination}.tmp-${process.pid}`;
  removeTree(scratch);
  try {
    for (const [rel, data] of files) {
      if (!wanted.some((regexp) => regexp.test(rel))) continue;
      mkdirSync(dirname(join(scratch, ...rel.split('/'))), { recursive: true });
      writeFileSync(join(scratch, ...rel.split('/')), data);
    }
    nativeFilesOf({ dir: scratch, pins, target });
    removeTree(destination);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(scratch, destination);
  } finally {
    removeTree(scratch);
  }
}

/**
 * Makes the package of `target` available as a folder whose pinned files are verified, from the first source that has it
 * (see the top of this file). Resolves to `{ dir, via }` with `via` one of `installed`, `cache`, `tarball-dir`, `pack`.
 * An installed package that fails the pins is an error (run `npm ci`), never a reason to try another source; a damaged cache
 * is discarded and staged again.
 *
 * `tarballDir`: a folder (default `$MCS_NATIVE_TARBALLS`), `null` for none. A folder that lacks the tarball is an error, so an
 * offline run never reaches for the network. `run(file, args, { cwd })` runs `npm pack` and resolves to `{ status, stdout, stderr }`.
 */
export async function stageTarget({
  target,
  pins = readNativePins(),
  lock,
  runtimeRoot = RUNTIME_ROOT,
  cacheDir,
  tarballDir,
  npmCli,
  run = runProcess,
  env = process.env,
  tmpRoot = tmpdir(),
} = {}) {
  const entry = targetPins(pins, target);
  const lockfile = lock ?? readJson(join(runtimeRoot, 'package-lock.json'));
  assertPinsMatchLock(pins, entry, target, lockfile);
  const tarball = tarballFileName(entry.package, pins.version);
  const cached = join(
    cacheDir ?? join(runtimeRoot, 'node_modules', '.cache', 'mcs-native'),
    tarball.replace(/\.tgz$/, ''),
  );

  const installed = join(runtimeRoot, 'node_modules', ...entry.package.split('/'));
  if (existsSync(installed)) {
    nativeFilesOf({ dir: installed, pins, target });
    return { dir: installed, via: 'installed' };
  }

  if (existsSync(cached)) {
    try {
      nativeFilesOf({ dir: cached, pins, target });
      return { dir: cached, via: 'cache' };
    } catch {
      removeTree(cached);
    }
  }

  const folder = tarballDir === undefined ? env.MCS_NATIVE_TARBALLS : tarballDir;
  if (typeof folder === 'string' && folder !== '') {
    const file = join(resolve(folder), tarball);
    if (!existsSync(file))
      fail(`MCS_NATIVE_TARBALLS has no ${tarball} (the folder ${folder} is used instead of the network)`);
    extractTarball({
      bytes: readFileSync(file),
      label: tarball,
      pins,
      entry,
      target,
      lock: lockfile,
      destination: cached,
    });
    return { dir: cached, via: 'tarball-dir' };
  }

  const cli = npmCli === undefined ? resolveNpmCli({ env }) : npmCli;
  if (cli === null) {
    fail(`the npm CLI was not found: run through npm, or set MCS_NATIVE_TARBALLS to a folder with ${tarball}`);
  }
  const scratch = mkdtempSync(join(tmpRoot, 'mcs-native-pack-'));
  try {
    const spec = `${entry.package}@${pins.version}`;
    const packed = await run(
      process.execPath,
      [cli, 'pack', spec, '--pack-destination', scratch, '--ignore-scripts', '--loglevel=error'],
      {
        cwd: runtimeRoot,
      },
    );
    if (packed.status !== 0) {
      const reason = packed.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      fail(
        `npm pack ${spec} failed (exit ${String(packed.status)}): ${reason}. Set MCS_NATIVE_TARBALLS to a folder with ${tarball} to stage without the network`,
      );
    }
    const file = join(scratch, tarball);
    if (!existsSync(file)) fail(`npm pack ${spec} did not produce ${tarball}`);
    extractTarball({
      bytes: readFileSync(file),
      label: tarball,
      pins,
      entry,
      target,
      lock: lockfile,
      destination: cached,
    });
  } finally {
    removeTree(scratch);
  }
  return { dir: cached, via: 'pack' };
}

/** Stages `targets` (default: every pinned target) one after the other and resolves to `Map<target, folder>`. */
export async function stageNativeTargets({ targets, ...deps } = {}) {
  const pins = deps.pins ?? readNativePins();
  const names = targets ?? Object.keys(pins.targets);
  for (const name of names) {
    if (!Object.hasOwn(pins.targets, name)) {
      fail(`unknown native target ${name} (pinned: ${Object.keys(pins.targets).join(', ')})`);
    }
  }
  const lock = deps.lock ?? readJson(join(deps.runtimeRoot ?? RUNTIME_ROOT, 'package-lock.json'));
  const staged = new Map();
  for (const target of names) staged.set(target, (await stageTarget({ ...deps, pins, lock, target })).dir);
  return staged;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const pins = readNativePins();
    const targets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(pins.targets);
    for (const target of targets) {
      const { via } = await stageTarget({ target, pins });
      console.log(`native-stage: ${target} staged from ${via}`);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
