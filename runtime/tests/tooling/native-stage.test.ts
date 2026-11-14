// The staging of the native terminal files (ADR 0082, design 01 section 2.3): the reviewed pins file, the pure-Node tar reader
// that refuses `..`, absolute and link entries, the check of a package against the pins file, the lockfile and its own
// integrity, and the order of the sources (installed package, extracted cache, a folder of tarballs, `npm pack`). Everything
// runs on synthetic tarballs in temp folders, so the file needs no network and no installed platform package; the last block
// checks the real pins file against the repository (lockfile, engine manifest) and, where the host package is installed,
// against `node_modules`.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as stageModule from '../../scripts/native-stage.mjs';

interface BinaryPin {
  bytes: number;
  sha256: string;
}
interface TargetPins {
  package: string;
  integrity: string;
  text: string[];
  binary: Record<string, BinaryPin>;
}
interface Pins {
  schemaVersion: number;
  package: string;
  version: string;
  equivalentUpstream?: string;
  targets: Record<string, TargetPins>;
}
interface Lock {
  packages: Record<string, { version?: string; integrity?: string }>;
}
interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
type Run = (file: string, args: string[], options: { cwd: string }) => Promise<RunResult>;
interface StageDeps {
  target: string;
  pins?: Pins;
  lock?: Lock;
  runtimeRoot?: string;
  cacheDir?: string;
  tarballDir?: string | null;
  npmCli?: string | null;
  run?: Run;
  env?: Record<string, string | undefined>;
  tmpRoot?: string;
}
const {
  NATIVE_PINS_FILE,
  integrityOf,
  nativeFilesOf,
  readNativePins,
  readTgz,
  resolveNpmCli,
  stageNativeTargets,
  stageTarget,
  tarballFileName,
  toLf,
  validateNativePins,
} = stageModule as unknown as {
  NATIVE_PINS_FILE: string;
  integrityOf: (bytes: Buffer) => string;
  nativeFilesOf: (opts: { dir: string; pins: Pins; target: string }) => Map<string, Buffer>;
  readNativePins: (file?: string) => Pins;
  readTgz: (buffer: Buffer, options?: { maxBytes?: number }) => Map<string, Buffer>;
  resolveNpmCli: (opts: {
    env: Record<string, string | undefined>;
    execPath: string;
    exists: (file: string) => boolean;
  }) => string | null;
  stageNativeTargets: (opts: Omit<StageDeps, 'target'> & { targets?: string[] }) => Promise<Map<string, string>>;
  stageTarget: (deps: StageDeps) => Promise<{ dir: string; via: 'installed' | 'cache' | 'tarball-dir' | 'pack' }>;
  tarballFileName: (pkg: string, version: string) => string;
  toLf: (bytes: Buffer) => Buffer;
  validateNativePins: (value: unknown, label?: string) => Pins;
};

const RUNTIME = join(import.meta.dirname, '..', '..');
const HOST_TARGET = `${process.platform}-${process.arch}`;

// ---- a minimal tar writer (ustar, pax and GNU long names) --------------------------------------------------------------------

interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** The typeflag character; `0` (a file) by default. */
  type?: string;
  linkname?: string;
  prefix?: string;
}

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

function tarHeader(entry: TarEntry): Buffer {
  const data = Buffer.from(entry.data ?? '');
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(data.length, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(entry.type ?? '0', 156, 1, 'ascii');
  if (entry.linkname !== undefined) block.write(entry.linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  if (entry.prefix !== undefined) block.write(entry.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function tar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    chunks.push(tarHeader(entry), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const tgz = (entries: readonly TarEntry[]): Buffer => gzipSync(tar(entries));

/** One pax record: `<length> <key>=<value>\n`, where the length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}

// ---- the fixture package ------------------------------------------------------------------------------------------------------

const PACKAGE = '@fixture/pty';
const PLATFORM = '@fixture/pty-win32-x64';
const VERSION = '1.0.0';
const TARGET = 'win32-x64';
const TEXT_FILES: Readonly<Record<string, string>> = {
  'package.json': `{\r\n  "name": "${PLATFORM}",\r\n  "version": "${VERSION}",\r\n  "license": "MIT"\r\n}\r\n`,
  LICENSE: 'MIT License\r\n\r\nFixture licence text.\r\n',
  'README.md': 'Fixture readme.\r\n',
  'lib/index.js': 'module.exports = 1;\r\n',
  'lib/other.js': "module.exports = 'other';\rlone carriage return\r\n",
  'lib/shared/conout.js': 'module.exports = 2;\r\n',
  'lib/worker/work.js': 'module.exports = 3;\r\n',
};
/** Binary files whose bytes contain CR LF pairs: a verbatim copy keeps them. */
const BINARY_FILES: Readonly<Record<string, Buffer>> = {
  'prebuilds/win32-x64/a.node': Buffer.from([0x4d, 0x5a, 0x0d, 0x0a, 0x00, 0x01, 0x02, 0x0d, 0x0a, 0xff]),
  'prebuilds/win32-x64/sub/b.dll': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x0d, 0x0a, 0x0d]),
};
/** Present in the package, named by no pin: never copied. */
const EXTRA_FILES: Readonly<Record<string, string>> = {
  'prebuilds/win32-x64/a.pdb': 'debug symbols\r\n',
  'lib/types.d.ts': 'export {};\r\n',
};
const TEXT_PATTERNS = ['package.json', 'LICENSE', 'README.md', 'lib/*.js', 'lib/shared/*.js', 'lib/worker/*.js'];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function packageEntries(
  overrides: { files?: Record<string, string | Buffer>; drop?: string[]; extra?: TarEntry[] } = {},
): TarEntry[] {
  const files: Record<string, string | Buffer> = { ...TEXT_FILES, ...BINARY_FILES, ...EXTRA_FILES, ...overrides.files };
  const dropped = overrides.drop ?? [];
  return [
    { name: 'package/', type: '5' },
    ...Object.entries(files)
      .filter(([name]) => !dropped.includes(name))
      .map(([name, data]) => ({ name: `package/${name}`, data })),
    ...(overrides.extra ?? []),
  ];
}

function binaryPins(files: Readonly<Record<string, Buffer>> = BINARY_FILES): Record<string, BinaryPin> {
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }]),
  );
}

/** Pins that describe `tarball`, and a lockfile that agrees. */
function fixture(tarball: Buffer): { pins: Pins; lock: Lock } {
  const integrity = integrityOf(tarball);
  return {
    pins: {
      schemaVersion: 1,
      package: PACKAGE,
      version: VERSION,
      targets: { [TARGET]: { package: PLATFORM, integrity, text: [...TEXT_PATTERNS], binary: binaryPins() } },
    },
    lock: {
      packages: {
        [`node_modules/${PACKAGE}`]: { version: VERSION },
        [`node_modules/${PLATFORM}`]: { version: VERSION, integrity },
      },
    },
  };
}

const PACKAGE_TGZ = tgz(packageEntries());
const GOOD = fixture(PACKAGE_TGZ);

// ---- temp folders ------------------------------------------------------------------------------------------------------------

let root = '';
const made: string[] = [];

function temp(label: string): string {
  const dir = mkdtempSync(join(root, `${label}-`));
  made.push(dir);
  return dir;
}

function put(dir: string, rel: string, data: string | Buffer): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

/** The package as `npm ci` leaves it: every file of the tarball, CRLF text included. */
function installPackage(dir: string, files: Record<string, string | Buffer> = {}): string {
  const target = join(dir, 'node_modules', ...PLATFORM.split('/'));
  for (const [rel, data] of Object.entries({ ...TEXT_FILES, ...BINARY_FILES, ...EXTRA_FILES, ...files })) {
    put(target, rel, data);
  }
  return target;
}

/** Every file below `dir` as sorted posix paths. */
function listAll(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAll(full, base));
    else out.push(full.slice(base.length + 1).replaceAll('\\', '/'));
  }
  return out.sort();
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(listAll(dir).map((rel) => [rel, sha256(readFileSync(join(dir, rel)))]));
}

/** A `run` that behaves like `npm pack` and writes `tarball` into the folder after `--pack-destination`. */
function fakePack(tarball: Buffer): { run: Run; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const run: Run = (file, args) => {
    calls.push({ file, args });
    const dest = args[args.indexOf('--pack-destination') + 1] ?? '';
    writeFileSync(join(dest, tarballFileName(PLATFORM, VERSION)), tarball);
    return Promise.resolve({ status: 0, stdout: `${tarballFileName(PLATFORM, VERSION)}\n`, stderr: '' });
  };
  return { run, calls };
}

const NO_RUN: Run = () => Promise.reject(new Error('the test expects no npm run'));

/** A runtime folder with the given extras; the stage call gets an empty environment, so nothing ambient is read. */
function stageDeps(runtimeRoot: string, extra: Partial<StageDeps> = {}): StageDeps {
  return {
    target: TARGET,
    pins: GOOD.pins,
    lock: GOOD.lock,
    runtimeRoot,
    env: {},
    npmCli: 'npm-cli.js',
    run: NO_RUN,
    ...extra,
  };
}

function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-native-link-'));
  try {
    writeFileSync(join(dir, 'a'), 'x');
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const SYMLINKS = canSymlink();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-native-stage-'));
});

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---- the tar reader -----------------------------------------------------------------------------------------------------------

describe('readTgz', () => {
  it('returns the files below package/ without the prefix and skips directories', () => {
    const files = readTgz(PACKAGE_TGZ);
    expect([...files.keys()].sort()).toEqual(
      [...Object.keys(TEXT_FILES), ...Object.keys(BINARY_FILES), ...Object.keys(EXTRA_FILES)].sort(),
    );
    expect(files.get('prebuilds/win32-x64/a.node')).toEqual(BINARY_FILES['prebuilds/win32-x64/a.node']);
    expect(files.get('LICENSE')?.toString('utf8')).toBe(TEXT_FILES['LICENSE']);
  });

  it('reads a ustar prefix field, a pax path record and a GNU long name', () => {
    const long = `lib/${'d'.repeat(60)}/${'f'.repeat(60)}.js`;
    const archive = gzipSync(
      tar([
        { name: `${'f'.repeat(60)}.js`, prefix: `package/lib/${'d'.repeat(60)}`, data: 'ustar prefix' },
        { name: 'PaxHeader/x', type: 'x', data: paxRecord('path', `package/${long}.pax`) },
        { name: 'truncated-name', data: 'pax' },
        { name: '././@LongLink', type: 'L', data: `package/${long}.gnu\0` },
        { name: 'truncated-name', data: 'gnu' },
        { name: 'PaxHeader/g', type: 'g', data: paxRecord('comment', 'a global header is ignored') },
        { name: 'package/after.txt', data: 'after' },
      ]),
    );
    const files = readTgz(archive);
    expect(files.get(long)?.toString()).toBe('ustar prefix');
    expect(files.get(`${long}.pax`)?.toString()).toBe('pax');
    expect(files.get(`${long}.gnu`)?.toString()).toBe('gnu');
    expect(files.get('after.txt')?.toString()).toBe('after');
    expect(files.size).toBe(4);
  });

  it.each([
    ['a .. segment', 'package/../evil.txt'],
    ['a .. segment in the middle', 'package/lib/../../evil.txt'],
    ['an absolute posix path', '/etc/passwd'],
    ['a drive letter', 'C:/Windows/evil.txt'],
    ['a backslash', 'package\\evil.txt'],
    ['a path outside package/', 'other/evil.txt'],
    ['a dot segment', 'package/./evil.txt'],
    ['an empty segment', 'package//evil.txt'],
  ])('refuses an entry with %s', (_label, name) => {
    expect(() => readTgz(tgz([{ name, data: 'x' }]))).toThrow(/refused/);
  });

  it('refuses a traversal name that arrives through a pax record or a GNU long name', () => {
    const pax = tgz([
      { name: 'PaxHeader/x', type: 'x', data: paxRecord('path', 'package/../evil.txt') },
      { name: 'package/safe.txt', data: 'x' },
    ]);
    const gnu = tgz([
      { name: '././@LongLink', type: 'L', data: '/absolute/evil.txt\0' },
      { name: 'package/safe.txt', data: 'x' },
    ]);
    expect(() => readTgz(pax)).toThrow(/refused/);
    expect(() => readTgz(gnu)).toThrow(/refused/);
  });

  it.each([
    ['a symbolic link', '2'],
    ['a hard link', '1'],
    ['a character device', '3'],
    ['a block device', '4'],
    ['a fifo', '6'],
    ['an unknown type', 'Z'],
  ])('refuses %s', (_label, type) => {
    expect(() => readTgz(tgz([{ name: 'package/link', type, linkname: 'package/target' }]))).toThrow(/refused/);
  });

  it('refuses a file that appears twice, an archive over the size limit and a damaged archive', () => {
    expect(() =>
      readTgz(
        tgz([
          { name: 'package/a.txt', data: '1' },
          { name: 'package/a.txt', data: '2' },
        ]),
      ),
    ).toThrow(/twice/);
    expect(() =>
      readTgz(tgz([{ name: 'package/big.bin', data: Buffer.alloc(64 * 1024) }]), { maxBytes: 4096 }),
    ).toThrow(/size limit/);
    const raw = tar([{ name: 'package/a.txt', data: 'hello' }]);
    const badSum = Buffer.from(raw);
    badSum[0] = (badSum[0] ?? 0) ^ 0x01;
    expect(() => readTgz(gzipSync(badSum))).toThrow(/checksum/);
    expect(() => readTgz(gzipSync(raw.subarray(0, 600)))).toThrow(/truncated/);
    expect(() => readTgz(Buffer.from('this is not gzip data'))).toThrow();
  });
});

describe('toLf, integrityOf and tarballFileName', () => {
  it('turns CR LF and a lone CR into LF and leaves LF alone', () => {
    expect(toLf(Buffer.from('a\r\nb\rc\nd\r\r\ne')).toString()).toBe('a\nb\nc\nd\n\ne');
    expect(toLf(Buffer.from('\r')).toString()).toBe('\n');
    expect(toLf(Buffer.from('plain')).toString()).toBe('plain');
  });

  it('writes sha512 integrity strings in the format of a lockfile', () => {
    const bytes = Buffer.from('abc');
    expect(integrityOf(bytes)).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    expect(integrityOf(bytes)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it('names a tarball the way npm pack does', () => {
    expect(tarballFileName('@lydell/node-pty-win32-arm64', '1.2.0-beta.18')).toBe(
      'lydell-node-pty-win32-arm64-1.2.0-beta.18.tgz',
    );
    expect(tarballFileName('plain', '1.0.0')).toBe('plain-1.0.0.tgz');
  });
});

describe('resolveNpmCli', () => {
  const execPath = join(tmpdir(), 'node-home', 'node.exe');
  const nodeCli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

  it('uses npm_execpath when it names npm-cli.js and the file exists', () => {
    const cli = join(tmpdir(), 'x', 'npm-cli.js');
    expect(resolveNpmCli({ env: { npm_execpath: cli }, execPath, exists: (f) => f === cli })).toBe(cli);
  });

  it('takes npm-cli.js next to an npx-cli.js that started the run', () => {
    const npx = join(tmpdir(), 'x', 'npx-cli.js');
    const npm = join(tmpdir(), 'x', 'npm-cli.js');
    expect(resolveNpmCli({ env: { npm_execpath: npx }, execPath, exists: (f) => f === npm })).toBe(npm);
  });

  it('falls back to the npm that ships next to the node binary, and to null', () => {
    expect(resolveNpmCli({ env: {}, execPath, exists: (f) => f === nodeCli })).toBe(nodeCli);
    expect(
      resolveNpmCli({ env: { npm_execpath: join(tmpdir(), 'yarn.js') }, execPath, exists: () => false }),
    ).toBeNull();
  });
});

// ---- the pins file ------------------------------------------------------------------------------------------------------------

describe('validateNativePins', () => {
  const clone = (): Pins => structuredClone(GOOD.pins);
  const first = (pins: Pins): TargetPins => {
    const target = pins.targets[TARGET];
    if (target === undefined) throw new Error('fixture target missing');
    return target;
  };

  it('accepts the fixture pins and returns them unchanged', () => {
    expect(validateNativePins(clone())).toEqual(GOOD.pins);
  });

  it.each<[string, (pins: Pins) => void, RegExp]>([
    ['another schema version', (p) => void (p.schemaVersion = 2), /schemaVersion/],
    ['an unknown top-level key', (p) => void Object.assign(p, { extra: 1 }), /unknown key/],
    ['an empty package name', (p) => void (p.package = ''), /package/],
    ['a version range', (p) => void (p.version = '^1.0.0'), /version/],
    ['no target', (p) => void (p.targets = {}), /targets/],
    ['a target name that is not os-arch', (p) => void (p.targets['Win32'] = first(p)), /target name/],
    ['an unknown key in a target', (p) => void Object.assign(first(p), { extra: 1 }), /unknown key/],
    ['an integrity that is not sha512', (p) => void (first(p).integrity = 'sha1-AAAA'), /integrity/],
    ['an integrity of the wrong length', (p) => void (first(p).integrity = 'sha512-AAAA=='), /integrity/],
    ['no package.json among the text files', (p) => void (first(p).text = ['LICENSE']), /package\.json/],
    ['no LICENSE among the text files', (p) => void (first(p).text = ['package.json']), /LICENSE/],
    ['a text pattern that climbs', (p) => void first(p).text.push('../x.js'), /text pattern/],
    ['a recursive text pattern', (p) => void first(p).text.push('lib/**/*.js'), /text pattern/],
    ['an absolute text pattern', (p) => void first(p).text.push('/lib/x.js'), /text pattern/],
    ['a backslash in a text pattern', (p) => void first(p).text.push('lib\\x.js'), /text pattern/],
    ['no binary file', (p) => void (first(p).binary = {}), /binary/],
    [
      'a binary path that climbs',
      (p) => void (first(p).binary['../x.node'] = { bytes: 1, sha256: '0'.repeat(64) }),
      /binary path/,
    ],
    [
      'an absolute binary path',
      (p) => void (first(p).binary['/x.node'] = { bytes: 1, sha256: '0'.repeat(64) }),
      /binary path/,
    ],
    [
      'a backslash in a binary path',
      (p) => void (first(p).binary['a\\b.node'] = { bytes: 1, sha256: '0'.repeat(64) }),
      /binary path/,
    ],
    [
      'an upper-case sha256',
      (p) => void (first(p).binary['prebuilds/win32-x64/a.node'] = { bytes: 1, sha256: 'A'.repeat(64) }),
      /sha256/,
    ],
    [
      'a short sha256',
      (p) => void (first(p).binary['prebuilds/win32-x64/a.node'] = { bytes: 1, sha256: 'ab' }),
      /sha256/,
    ],
    [
      'zero bytes',
      (p) => void (first(p).binary['prebuilds/win32-x64/a.node'] = { bytes: 0, sha256: '0'.repeat(64) }),
      /bytes/,
    ],
    [
      'fractional bytes',
      (p) => void (first(p).binary['prebuilds/win32-x64/a.node'] = { bytes: 1.5, sha256: '0'.repeat(64) }),
      /bytes/,
    ],
  ])('rejects %s', (_label, mutate, message) => {
    const pins = clone();
    mutate(pins);
    expect(() => validateNativePins(pins)).toThrow(message);
  });

  it('rejects a value that is not an object', () => {
    expect(() => validateNativePins(null)).toThrow(/native-pins/);
    expect(() => validateNativePins([])).toThrow(/native-pins/);
  });
});

// ---- the files of one staged package ------------------------------------------------------------------------------------------

describe('nativeFilesOf', () => {
  it('returns the pinned files sorted, text as LF, binaries verbatim, and nothing the pins do not name', () => {
    const dir = installPackage(temp('installed'));
    const files = nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET });
    const names = [...files.keys()];
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(
      [
        'LICENSE',
        'README.md',
        'lib/index.js',
        'lib/other.js',
        'lib/shared/conout.js',
        'lib/worker/work.js',
        'package.json',
        'prebuilds/win32-x64/a.node',
        'prebuilds/win32-x64/sub/b.dll',
      ].sort(),
    );
    for (const [rel, bytes] of files) {
      if (rel in BINARY_FILES) expect(bytes, rel).toEqual(BINARY_FILES[rel]);
      else expect(bytes.includes(0x0d), rel).toBe(false);
    }
    expect(files.get('lib/other.js')?.toString()).toBe("module.exports = 'other';\nlone carriage return\n");
    expect(names.some((rel) => rel.endsWith('.pdb') || rel.endsWith('.d.ts'))).toBe(false);
  });

  it('gives the same map twice (determinism)', () => {
    const dir = installPackage(temp('installed'));
    const a = nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET });
    const b = nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET });
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [rel, bytes] of a) expect(bytes.equals(b.get(rel) ?? Buffer.alloc(0)), rel).toBe(true);
  });

  it('refuses a binary with the right size and another byte (tampered binary)', () => {
    const tampered = Buffer.from(BINARY_FILES['prebuilds/win32-x64/a.node'] ?? []);
    tampered[2] = 0x7f;
    const dir = installPackage(temp('installed'), { 'prebuilds/win32-x64/a.node': tampered });
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(
      /prebuilds\/win32-x64\/a\.node: sha256 differs from the pin/,
    );
  });

  it('refuses a binary of another size and a missing binary', () => {
    const longer = Buffer.concat([BINARY_FILES['prebuilds/win32-x64/a.node'] ?? Buffer.alloc(0), Buffer.from([1])]);
    const dir = installPackage(temp('installed'), { 'prebuilds/win32-x64/a.node': longer });
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(/a\.node: .*bytes/);
    const missing = temp('missing');
    installPackage(missing);
    rmSync(join(missing, 'node_modules', ...PLATFORM.split('/'), 'prebuilds', 'win32-x64', 'sub', 'b.dll'));
    expect(() =>
      nativeFilesOf({ dir: join(missing, 'node_modules', ...PLATFORM.split('/')), pins: GOOD.pins, target: TARGET }),
    ).toThrow(/sub\/b\.dll: missing/);
  });

  it('does not follow a linked folder: a pinned file behind a junction or symbolic link is missing', () => {
    const dir = installPackage(temp('installed'));
    const outside = temp('outside');
    put(outside, 'b.dll', BINARY_FILES['prebuilds/win32-x64/sub/b.dll'] ?? Buffer.alloc(0));
    rmSync(join(dir, 'prebuilds', 'win32-x64', 'sub'), { recursive: true });
    symlinkSync(outside, join(dir, 'prebuilds', 'win32-x64', 'sub'), 'junction');
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(/sub\/b\.dll: missing/);
  });

  it('refuses a text pattern that matches no file', () => {
    const dir = installPackage(temp('installed'));
    rmSync(join(dir, 'lib', 'worker'), { recursive: true });
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(
      /lib\/worker\/\*\.js matches no file/,
    );
  });

  it('refuses a package whose package.json names another package or version', () => {
    const wrongName = installPackage(temp('name'), {
      'package.json': JSON.stringify({ name: '@evil/pty', version: VERSION, license: 'MIT' }),
    });
    expect(() => nativeFilesOf({ dir: wrongName, pins: GOOD.pins, target: TARGET })).toThrow(/package\.json names/);
    const wrongVersion = installPackage(temp('version'), {
      'package.json': JSON.stringify({ name: PLATFORM, version: '9.9.9', license: 'MIT' }),
    });
    expect(() => nativeFilesOf({ dir: wrongVersion, pins: GOOD.pins, target: TARGET })).toThrow(/package\.json names/);
  });

  it('refuses a text file that holds a NUL byte', () => {
    const dir = installPackage(temp('installed'), { 'lib/index.js': Buffer.from([0x61, 0x00, 0x62]) });
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(/lib\/index\.js: .*NUL/);
  });

  it.skipIf(!SYMLINKS)('refuses a symbolic link in place of a pinned file', () => {
    const dir = installPackage(temp('installed'));
    const outside = join(temp('outside'), 'a.node');
    writeFileSync(outside, BINARY_FILES['prebuilds/win32-x64/a.node'] ?? Buffer.alloc(0));
    rmSync(join(dir, 'prebuilds', 'win32-x64', 'a.node'));
    symlinkSync(outside, join(dir, 'prebuilds', 'win32-x64', 'a.node'), 'file');
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET })).toThrow(/a\.node: .*link/);
  });

  it('refuses a target that the pins do not know', () => {
    const dir = installPackage(temp('installed'));
    expect(() => nativeFilesOf({ dir, pins: GOOD.pins, target: 'linux-x64' })).toThrow(/no pins for target linux-x64/);
  });
});

// ---- staging one target ------------------------------------------------------------------------------------------------------

describe('stageTarget: the sources, in order', () => {
  it('uses the installed package first, verified against the pins', async () => {
    const runtimeRoot = temp('runtime');
    const installed = installPackage(runtimeRoot);
    const staged = await stageTarget(stageDeps(runtimeRoot));
    expect(staged.via).toBe('installed');
    expect(staged.dir).toBe(installed);
    expect(existsSync(join(runtimeRoot, 'node_modules', '.cache'))).toBe(false);
  });

  it('refuses an installed package with a tampered binary instead of falling through to another source', async () => {
    const runtimeRoot = temp('runtime');
    const tampered = Buffer.from(BINARY_FILES['prebuilds/win32-x64/a.node'] ?? []);
    tampered[4] = 0x55;
    installPackage(runtimeRoot, { 'prebuilds/win32-x64/a.node': tampered });
    const { run, calls } = fakePack(PACKAGE_TGZ);
    await expect(stageTarget(stageDeps(runtimeRoot, { run }))).rejects.toThrow(/sha256 differs from the pin/);
    expect(calls).toEqual([]);
  });

  it('refuses an installed package with a missing pinned file', async () => {
    const runtimeRoot = temp('runtime');
    const installed = installPackage(runtimeRoot);
    rmSync(join(installed, 'prebuilds', 'win32-x64', 'a.node'));
    await expect(stageTarget(stageDeps(runtimeRoot))).rejects.toThrow(/a\.node: missing/);
  });

  it('extracts a tarball of $MCS_NATIVE_TARBALLS into the cache, only the pinned files, and reuses the cache the next time', async () => {
    const runtimeRoot = temp('runtime');
    const tarballDir = temp('tarballs');
    put(tarballDir, tarballFileName(PLATFORM, VERSION), PACKAGE_TGZ);
    const first = await stageTarget(stageDeps(runtimeRoot, { tarballDir }));
    expect(first.via).toBe('tarball-dir');
    expect(first.dir).toBe(
      join(
        runtimeRoot,
        'node_modules',
        '.cache',
        'mcs-native',
        tarballFileName(PLATFORM, VERSION).replace(/\.tgz$/, ''),
      ),
    );
    expect(listAll(first.dir)).toEqual(
      [
        'LICENSE',
        'README.md',
        'lib/index.js',
        'lib/other.js',
        'lib/shared/conout.js',
        'lib/worker/work.js',
        'package.json',
        'prebuilds/win32-x64/a.node',
        'prebuilds/win32-x64/sub/b.dll',
      ].sort(),
    );
    const again = await stageTarget(stageDeps(runtimeRoot, { tarballDir: null }));
    expect(again).toEqual({ dir: first.dir, via: 'cache' });
  });

  it('reads the folder of tarballs from the environment variable when no folder is passed', async () => {
    const runtimeRoot = temp('runtime');
    const tarballDir = temp('tarballs');
    put(tarballDir, tarballFileName(PLATFORM, VERSION), PACKAGE_TGZ);
    const env = { ['MCS_NATIVE_TARBALLS']: tarballDir };
    expect((await stageTarget(stageDeps(runtimeRoot, { env }))).via).toBe('tarball-dir');
  });

  it('discards a damaged cache and stages again from a tarball', async () => {
    const runtimeRoot = temp('runtime');
    const tarballDir = temp('tarballs');
    put(tarballDir, tarballFileName(PLATFORM, VERSION), PACKAGE_TGZ);
    const first = await stageTarget(stageDeps(runtimeRoot, { tarballDir }));
    const before = snapshot(first.dir);
    writeFileSync(join(first.dir, 'prebuilds', 'win32-x64', 'a.node'), 'tampered');
    const second = await stageTarget(stageDeps(runtimeRoot, { tarballDir }));
    expect(second.via).toBe('tarball-dir');
    expect(snapshot(second.dir)).toEqual(before);
  });

  it('runs npm pack into a temp folder when nothing else has the package, then cleans up', async () => {
    const runtimeRoot = temp('runtime');
    const tmpRoot = temp('tmp');
    const { run, calls } = fakePack(PACKAGE_TGZ);
    const staged = await stageTarget(stageDeps(runtimeRoot, { run, tmpRoot, npmCli: 'the-npm-cli.js' }));
    expect(staged.via).toBe('pack');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(process.execPath);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['the-npm-cli.js', 'pack', `${PLATFORM}@${VERSION}`]);
    expect(calls[0]?.args).toContain('--pack-destination');
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(listAll(staged.dir)).toContain('prebuilds/win32-x64/a.node');
  });

  it('runs the real npm command line through the default runner (a stand-in npm-cli.js)', async () => {
    const runtimeRoot = temp('runtime');
    const tmpRoot = temp('tmp');
    const bin = temp('bin');
    const stored = join(bin, 'stored.tgz');
    writeFileSync(stored, PACKAGE_TGZ);
    const cli = join(bin, 'npm-cli.cjs');
    writeFileSync(
      cli,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        "if (args[0] !== 'pack') process.exit(2);",
        "const dest = args[args.indexOf('--pack-destination') + 1];",
        `fs.copyFileSync(${JSON.stringify(stored)}, path.join(dest, ${JSON.stringify(tarballFileName(PLATFORM, VERSION))}));`,
        '',
      ].join('\n'),
    );
    const deps = stageDeps(runtimeRoot, { tmpRoot, npmCli: cli });
    delete deps.run;
    expect((await stageTarget(deps)).via).toBe('pack');
  });

  it('says how to stage offline when npm pack fails or the npm CLI cannot be found', async () => {
    const failing: Run = () => Promise.resolve({ status: 1, stdout: '', stderr: 'E404 not found' });
    await expect(stageTarget(stageDeps(temp('runtime'), { run: failing }))).rejects.toThrow(
      /npm pack .* failed \(exit 1\).*MCS_NATIVE_TARBALLS/s,
    );
    await expect(stageTarget(stageDeps(temp('runtime'), { npmCli: null }))).rejects.toThrow(
      /npm CLI.*MCS_NATIVE_TARBALLS/s,
    );
  });

  it('refuses a folder of tarballs that lacks the package instead of reaching for the network', async () => {
    const tarballDir = temp('tarballs');
    const { run, calls } = fakePack(PACKAGE_TGZ);
    await expect(stageTarget(stageDeps(temp('runtime'), { tarballDir, run }))).rejects.toThrow(
      /MCS_NATIVE_TARBALLS has no fixture-pty-win32-x64-1\.0\.0\.tgz/,
    );
    expect(calls).toEqual([]);
  });

  it('fails when npm pack reports success but leaves no tarball', async () => {
    const silent: Run = () => Promise.resolve({ status: 0, stdout: '', stderr: '' });
    await expect(stageTarget(stageDeps(temp('runtime'), { run: silent }))).rejects.toThrow(/did not produce/);
  });
});

describe('stageTarget: the checks that refuse a package', () => {
  /** Stages `tarball` from a folder of tarballs and returns the rejection and the runtime folder. */
  async function stageTampered(
    tarball: Buffer,
    pinsAndLock: { pins: Pins; lock: Lock } = fixture(tarball),
  ): Promise<{ error: unknown; runtimeRoot: string }> {
    const runtimeRoot = temp('runtime');
    const tarballDir = temp('tarballs');
    put(tarballDir, tarballFileName(PLATFORM, VERSION), tarball);
    try {
      await stageTarget(stageDeps(runtimeRoot, { tarballDir, ...pinsAndLock }));
      return { error: undefined, runtimeRoot };
    } catch (error) {
      return { error, runtimeRoot };
    }
  }
  const cacheOf = (runtimeRoot: string): string => join(runtimeRoot, 'node_modules', '.cache');

  it('refuses a tarball whose integrity is not the one of the lockfile, and extracts nothing (tampered integrity)', async () => {
    const other = tgz(packageEntries({ files: { 'README.md': 'a different readme\r\n' } }));
    const { error, runtimeRoot } = await stageTampered(other, GOOD);
    expect(String(error)).toMatch(/integrity of .* differs from the lockfile/);
    expect(listAll(cacheOf(runtimeRoot))).toEqual([]);
  });

  it('refuses before reading any source when the lockfile and the pins disagree', async () => {
    const runtimeRoot = temp('runtime');
    installPackage(runtimeRoot);
    const lock: Lock = {
      packages: {
        ...GOOD.lock.packages,
        [`node_modules/${PLATFORM}`]: { version: VERSION, integrity: integrityOf(Buffer.from('other')) },
      },
    };
    await expect(stageTarget(stageDeps(runtimeRoot, { lock }))).rejects.toThrow(/differs from the lockfile/);
    await expect(stageTarget(stageDeps(runtimeRoot, { lock: { packages: {} } }))).rejects.toThrow(
      /not in the lockfile/,
    );
    const wrongVersion: Lock = {
      packages: {
        ...GOOD.lock.packages,
        [`node_modules/${PLATFORM}`]: { version: '2.0.0', integrity: GOOD.pins.targets[TARGET]?.integrity ?? '' },
      },
    };
    await expect(stageTarget(stageDeps(runtimeRoot, { lock: wrongVersion }))).rejects.toThrow(/version/);
  });

  it('refuses a binary that differs from its pin although the tarball integrity is right (tampered binary)', async () => {
    const tampered = Buffer.from(BINARY_FILES['prebuilds/win32-x64/a.node'] ?? []);
    tampered[3] = 0x42;
    // the fixture pins keep the hashes of the untampered binary files and take the integrity of this very archive
    const { error, runtimeRoot } = await stageTampered(
      tgz(packageEntries({ files: { 'prebuilds/win32-x64/a.node': tampered } })),
    );
    expect(String(error)).toMatch(/a\.node: sha256 differs from the pin/);
    expect(listAll(cacheOf(runtimeRoot))).toEqual([]);
  });

  it('refuses a tarball with a traversal entry and writes nothing outside the cache (traversal entry)', async () => {
    const archive = tgz(packageEntries({ extra: [{ name: 'package/../../escaped.txt', data: 'x' }] }));
    const { error, runtimeRoot } = await stageTampered(archive);
    expect(String(error)).toMatch(/refused/);
    expect(listAll(cacheOf(runtimeRoot))).toEqual([]);
    expect(existsSync(join(dirname(runtimeRoot), 'escaped.txt'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'escaped.txt'))).toBe(false);
  });

  it('refuses a tarball with a link entry', async () => {
    const archive = tgz(
      packageEntries({ extra: [{ name: 'package/lib/link.js', type: '2', linkname: '/etc/passwd' }] }),
    );
    expect(String((await stageTampered(archive)).error)).toMatch(/refused/);
  });

  it('refuses a tarball that lacks a pinned binary (missing pinned file)', async () => {
    const { error, runtimeRoot } = await stageTampered(
      tgz(packageEntries({ drop: ['prebuilds/win32-x64/sub/b.dll'] })),
    );
    expect(String(error)).toMatch(/sub\/b\.dll: missing/);
    expect(listAll(cacheOf(runtimeRoot))).toEqual([]);
  });

  it('refuses a tarball in which a text pattern matches nothing', async () => {
    const { error } = await stageTampered(tgz(packageEntries({ drop: ['lib/shared/conout.js'] })));
    expect(String(error)).toMatch(/lib\/shared\/\*\.js matches no file/);
  });
});

describe('stageNativeTargets and determinism', () => {
  it('stages every pinned target and returns the folders by target', async () => {
    const runtimeRoot = temp('runtime');
    const installed = installPackage(runtimeRoot);
    const result = await stageNativeTargets({ ...stageDeps(runtimeRoot), targets: [TARGET] });
    expect([...result.entries()]).toEqual([[TARGET, installed]]);
    const all = await stageNativeTargets({ ...stageDeps(runtimeRoot) });
    expect([...all.keys()]).toEqual([TARGET]);
  });

  it('refuses a target that the pins do not know', async () => {
    await expect(stageNativeTargets({ ...stageDeps(temp('runtime')), targets: ['linux-arm64'] })).rejects.toThrow(
      /unknown native target linux-arm64/,
    );
  });

  it('extracts the same tarball to the same bytes in two runtime folders', async () => {
    const stage = async (): Promise<Record<string, string>> => {
      const runtimeRoot = temp('runtime');
      const tarballDir = temp('tarballs');
      put(tarballDir, tarballFileName(PLATFORM, VERSION), PACKAGE_TGZ);
      return snapshot((await stageTarget(stageDeps(runtimeRoot, { tarballDir }))).dir);
    };
    expect(await stage()).toEqual(await stage());
  });

  it('gives the same files from the installed package, the cache and a fresh extraction', async () => {
    const installedRoot = temp('installed-root');
    const installedDir = installPackage(installedRoot);
    const fromInstalled = nativeFilesOf({ dir: installedDir, pins: GOOD.pins, target: TARGET });
    const runtimeRoot = temp('runtime');
    const tarballDir = temp('tarballs');
    put(tarballDir, tarballFileName(PLATFORM, VERSION), PACKAGE_TGZ);
    const { dir } = await stageTarget(stageDeps(runtimeRoot, { tarballDir }));
    const fromTarball = nativeFilesOf({ dir, pins: GOOD.pins, target: TARGET });
    expect([...fromTarball.keys()]).toEqual([...fromInstalled.keys()]);
    for (const [rel, bytes] of fromInstalled)
      expect(bytes.equals(fromTarball.get(rel) ?? Buffer.alloc(0)), rel).toBe(true);
  });
});

// ---- the real pins file -------------------------------------------------------------------------------------------------------

describe('the reviewed pins file', () => {
  const pins = readNativePins();
  const lock = JSON.parse(readFileSync(join(RUNTIME, 'package-lock.json'), 'utf8')) as Lock;
  const engine = JSON.parse(readFileSync(join(RUNTIME, 'packages', 'engine', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  it('lives next to the scripts and names the two Windows targets, four binaries each', () => {
    expect(NATIVE_PINS_FILE).toBe(join(RUNTIME, 'scripts', 'native-pins.json'));
    expect(Object.keys(pins.targets)).toEqual(['win32-x64', 'win32-arm64']);
    for (const [target, entry] of Object.entries(pins.targets)) {
      expect(Object.keys(entry.binary).sort(), target).toEqual(
        [
          `prebuilds/${target}/conpty.node`,
          `prebuilds/${target}/conpty_console_list.node`,
          `prebuilds/${target}/conpty/OpenConsole.exe`,
          `prebuilds/${target}/conpty/conpty.dll`,
        ].sort(),
      );
      expect(entry.package).toBe(`@lydell/node-pty-${target}`);
    }
  });

  it('pins the version of the engine dependency and the integrity of the lockfile, for both platform packages', () => {
    expect(pins.package).toBe('@lydell/node-pty');
    expect(engine.dependencies['@lydell/node-pty']).toBe(pins.version);
    expect(lock.packages['node_modules/@lydell/node-pty']?.version).toBe(pins.version);
    for (const entry of Object.values(pins.targets)) {
      const locked = lock.packages[`node_modules/${entry.package}`];
      expect(locked?.version, entry.package).toBe(pins.version);
      expect(locked?.integrity, entry.package).toBe(entry.integrity);
    }
  });

  it('rejects a damaged copy of itself through readNativePins', () => {
    const file = join(temp('pins'), 'native-pins.json');
    writeFileSync(file, JSON.stringify({ ...pins, schemaVersion: 7 }));
    expect(() => readNativePins(file)).toThrow(/schemaVersion/);
    writeFileSync(file, '{ not json');
    expect(() => readNativePins(file)).toThrow(/native-pins/);
  });

  it.runIf(
    existsSync(join(RUNTIME, 'node_modules', '@lydell', `node-pty-${HOST_TARGET}`)) && HOST_TARGET in pins.targets,
  )('matches the installed package of the host: every pinned file is there with its hash', () => {
    const dir = join(RUNTIME, 'node_modules', '@lydell', `node-pty-${HOST_TARGET}`);
    const files = nativeFilesOf({ dir, pins, target: HOST_TARGET });
    const entry = pins.targets[HOST_TARGET];
    for (const [rel, pin] of Object.entries(entry?.binary ?? {})) {
      const bytes = files.get(rel) ?? Buffer.alloc(0);
      expect(bytes.length, rel).toBe(pin.bytes);
      expect(sha256(bytes), rel).toBe(pin.sha256);
    }
    expect([...files.keys()].some((rel) => rel.endsWith('.pdb'))).toBe(false);
    expect(files.get('package.json')?.includes(0x0d)).toBe(false);
  });
});
