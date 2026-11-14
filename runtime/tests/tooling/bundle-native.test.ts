// The native terminal files in the bundle (ADR 0082, design 01 sections 2.1, 2.4 and 2.6): `native/<target>/` holds exactly the
// files the pins name (text as LF, binaries byte for byte, no debug symbols), nothing native lives anywhere else, two builds are
// byte-identical, the manifest and the notices list the files and packages, and a tampered file or a tarball with the wrong
// integrity stops the build before a byte is written. The builds use a fixture package and fixture pins (a small entry, no
// network, any OS); the last block checks the real pins against the installed package of the host.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../scripts/bundle.mjs';
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
  targets: Record<string, TargetPins>;
}
interface Manifest {
  buildStamp: string;
  files: Record<string, { bytes: number; sha256: string }>;
}
interface NativeOption {
  targets?: string[];
  stage?: (target: string) => Promise<string>;
  pins?: Pins;
}
interface BuildOptions {
  outDir: string;
  entries?: Record<string, string>;
  web?: boolean;
  native?: NativeOption | boolean;
}
const { ENTRIES, NATIVE_ENTRIES, buildBundle, compareBundles, listFiles, nativeWanted } = bundleModule as unknown as {
  ENTRIES: Readonly<Record<string, string>>;
  NATIVE_ENTRIES: readonly string[];
  buildBundle: (opts: BuildOptions) => Promise<{ files: string[]; packages: string[] }>;
  compareBundles: (a: string, b: string) => { changed: string[]; missing: string[]; extra: string[] };
  listFiles: (dir: string) => string[];
  nativeWanted: (entries: Record<string, string>) => boolean;
};
const { integrityOf, nativeFilesOf, readNativePins, stageTarget } = stageModule as unknown as {
  integrityOf: (bytes: Buffer) => string;
  nativeFilesOf: (opts: { dir: string; pins: Pins; target: string }) => Map<string, Buffer>;
  readNativePins: () => Pins;
  stageTarget: (deps: Record<string, unknown>) => Promise<{ dir: string; via: string }>;
};

const BUILD_MS = 120_000;
/** The smallest entry of the bundle: the native folder does not depend on what the entries contain. */
const HOOK_ENTRY: Record<string, string> = { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' };
const NATIVE_EXTENSIONS = ['.node', '.dll', '.exe', '.so', '.dylib'];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// ---- the fixture packages -----------------------------------------------------------------------------------------------------

const TARGETS = ['win32-x64', 'win32-arm64'] as const;
const VERSION = '2.0.0';
const TEXT_PATTERNS = ['package.json', 'LICENSE', 'README.md', 'lib/*.js'];

function binaryFilesOf(target: string): Record<string, Buffer> {
  return {
    [`prebuilds/${target}/conpty.node`]: Buffer.from([0x4d, 0x5a, 0x0d, 0x0a, 0x00, target.length, 0x0d, 0x0a]),
    [`prebuilds/${target}/conpty/conpty.dll`]: Buffer.from([0x4d, 0x5a, 0x01, 0x0d, 0x0a, 0x0d, target.length]),
    [`prebuilds/${target}/conpty/OpenConsole.exe`]: Buffer.from([0x4d, 0x5a, 0x02, 0x0d, 0x0a, 0xff, target.length]),
  };
}

function textFilesOf(target: string): Record<string, string> {
  return {
    'package.json': `{\r\n  "name": "@fixture/pty-${target}",\r\n  "version": "${VERSION}",\r\n  "license": "MIT"\r\n}\r\n`,
    LICENSE: `MIT License   \r\n\r\nFixture licence text of ${target}.  \r\n`,
    'README.md': 'Fixture readme.\r\n',
    'lib/index.js': `module.exports = '${target}';\r\n`,
    'lib/helper.js': 'module.exports = 1;\r\n',
  };
}

const EXTRAS: Record<string, string> = {
  'prebuilds/pdb/conpty.pdb': 'debug symbols\r\n',
  'lib/index.d.ts': 'export {};\r\n',
};

function pinsOf(overrides: { binary?: (target: string) => Record<string, Buffer> } = {}): Pins {
  return {
    schemaVersion: 1,
    package: '@fixture/pty',
    version: VERSION,
    targets: Object.fromEntries(
      TARGETS.map((target) => {
        const binaries = (overrides.binary ?? binaryFilesOf)(target);
        return [
          target,
          {
            package: `@fixture/pty-${target}`,
            integrity: integrityOf(Buffer.from(`fixture ${target}`)),
            text: [...TEXT_PATTERNS],
            binary: Object.fromEntries(
              Object.entries(binaries).map(([rel, bytes]) => [rel, { bytes: bytes.length, sha256: sha256(bytes) }]),
            ),
          },
        ];
      }),
    ),
  };
}

let root = '';
let counter = 0;

/** A new folder below the temp root of this file; `afterAll` removes the whole root. */
function temp(label: string): string {
  counter += 1;
  const dir = join(root, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, rel: string, data: string | Buffer): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

/** A staged folder per target, as `stage` returns it: the package files plus files the pins do not name. */
function stagedFolders(
  changes: (target: string, dir: string) => void = () => undefined,
): (target: string) => Promise<string> {
  const dirs = new Map<string, string>();
  for (const target of TARGETS) {
    const dir = temp(`staged-${target}`);
    for (const [rel, text] of Object.entries({ ...textFilesOf(target), ...EXTRAS })) put(dir, rel, text);
    for (const [rel, bytes] of Object.entries(binaryFilesOf(target))) put(dir, rel, bytes);
    changes(target, dir);
    dirs.set(target, dir);
  }
  return (target) => Promise.resolve(dirs.get(target) ?? '');
}

const entriesOf = (dir: string, target: string): string[] =>
  listFiles(join(dir, 'native', target)).map((rel) => `native/${target}/${rel}`);

/** Every file below the bundle folder, posix paths, sorted. */
const filesOf = (dir: string): string[] => listFiles(dir);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-bundle-native-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function build(options: Partial<BuildOptions> & { native: NativeOption | boolean }): Promise<string> {
  const outDir = join(temp('out'), 'bundle');
  await buildBundle({ outDir, entries: HOOK_ENTRY, web: false, ...options });
  return outDir;
}

describe('native/<target>/ of a bundle (fixture package)', () => {
  const pins = pinsOf();
  let first = '';
  let second = '';

  beforeAll(async () => {
    const stage = stagedFolders();
    first = await build({ native: { pins, stage } });
    second = await build({ native: { pins, stage } });
  }, BUILD_MS);

  it('holds exactly the files of the pins for each target: the text files and the binaries, nothing else', () => {
    for (const target of TARGETS) {
      const expected = [
        ...Object.keys(textFilesOf(target)).filter((rel) => rel !== 'lib/index.d.ts'),
        ...Object.keys(binaryFilesOf(target)),
      ].map((rel) => `native/${target}/${rel}`);
      expect(entriesOf(first, target)).toEqual(expected.sort());
    }
    expect(
      filesOf(first).filter((rel) => rel.startsWith('native/') && !/^native\/win32-(x64|arm64)\//.test(rel)),
    ).toEqual([]);
  });

  it('leaves out debug symbols and every file the pins do not name', () => {
    const all = filesOf(first);
    expect(all.filter((rel) => rel.endsWith('.pdb') || rel.endsWith('.d.ts'))).toEqual([]);
  });

  it('writes text files with LF only and binaries byte for byte (a CR LF inside a binary stays)', () => {
    for (const target of TARGETS) {
      for (const rel of Object.keys(textFilesOf(target)).filter((r) => r !== 'lib/index.d.ts')) {
        const bytes = readFileSync(join(first, 'native', target, rel));
        expect(bytes.includes(0x0d), `${target}/${rel}`).toBe(false);
      }
      for (const [rel, expected] of Object.entries(binaryFilesOf(target))) {
        expect(readFileSync(join(first, 'native', target, rel)), `${target}/${rel}`).toEqual(expected);
      }
    }
  });

  it('gives every binary the sha256 and size of its pin', () => {
    for (const [target, entry] of Object.entries(pins.targets)) {
      for (const [rel, pin] of Object.entries(entry.binary)) {
        const bytes = readFileSync(join(first, 'native', target, rel));
        expect(bytes.length, rel).toBe(pin.bytes);
        expect(sha256(bytes), rel).toBe(pin.sha256);
      }
    }
  });

  it('keeps native code out of the bundle everywhere but native/<pinned target>/prebuilds/', () => {
    const native = filesOf(first).filter((rel) => NATIVE_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext)));
    expect(native.length).toBe(TARGETS.length * 3);
    for (const rel of native)
      expect(rel, rel).toMatch(/^native\/win32-(?:x64|arm64)\/prebuilds\/win32-(?:x64|arm64)\//);
  });

  it('builds byte-identical folders twice', () => {
    expect(compareBundles(first, second)).toEqual({ changed: [], missing: [], extra: [] });
  });

  it(
    'lists every native file in the manifest with its size and hash, and the stamp follows a changed binary',
    async () => {
      const manifest = JSON.parse(readFileSync(join(first, '.mcs-build.json'), 'utf8')) as Manifest;
      for (const rel of filesOf(first).filter((r) => r.startsWith('native/'))) {
        const bytes = readFileSync(join(first, rel));
        expect(manifest.files[rel], rel).toEqual({ bytes: bytes.length, sha256: sha256(bytes) });
      }
      const changedPins = pinsOf({
        binary: (target) => ({
          ...binaryFilesOf(target),
          [`prebuilds/${target}/conpty.node`]: Buffer.from([0x4d, 0x5a, 0x55]),
        }),
      });
      const changedStage = stagedFolders((target, dir) => {
        put(dir, `prebuilds/${target}/conpty.node`, Buffer.from([0x4d, 0x5a, 0x55]));
      });
      const changed = await build({ native: { pins: changedPins, stage: changedStage } });
      const other = JSON.parse(readFileSync(join(changed, '.mcs-build.json'), 'utf8')) as Manifest;
      expect(other.buildStamp).not.toBe(manifest.buildStamp);
    },
    BUILD_MS,
  );

  it('lists both platform packages in the notices with the staged licence text, and names native/ in the header', () => {
    const notices = readFileSync(join(first, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const target of TARGETS) {
      expect(notices).toContain(
        `@fixture/pty-${target} ${VERSION}\nLicense: MIT\n\nMIT License\n\nFixture licence text of ${target}.`,
      );
    }
    expect(notices).toMatch(/web\/ and native\//);
    expect(notices).not.toContain('\r');
  });
});

describe('what buildBundle stages', () => {
  const pins = pinsOf();

  it(
    'skips the folder with native: false, and by default for a bundle without the server or CLI entry',
    async () => {
      const off = await build({ native: false });
      expect(filesOf(off).some((rel) => rel.startsWith('native/'))).toBe(false);
      // no `native` option and only the hook entry: nothing is staged (this build would otherwise need the network)
      const outDir = join(temp('out'), 'bundle');
      await buildBundle({ outDir, entries: HOOK_ENTRY, web: false });
      expect(filesOf(outDir).some((rel) => rel.startsWith('native/'))).toBe(false);
    },
    BUILD_MS,
  );

  it('wants the native files exactly for the entries that load the terminal addon', () => {
    expect([...NATIVE_ENTRIES]).toEqual(['mcs-cli', 'mcs-server']);
    expect(nativeWanted(ENTRIES)).toBe(true);
    expect(nativeWanted({ 'mcs-server': 'x' })).toBe(true);
    expect(nativeWanted({ 'mcs-cli': 'x' })).toBe(true);
    expect(nativeWanted(HOOK_ENTRY)).toBe(false);
    expect(nativeWanted({})).toBe(false);
  });

  it(
    'stages only the targets that are named, in sorted order, and refuses a name that is not pinned',
    async () => {
      const order: string[] = [];
      const stage = (target: string): Promise<string> => {
        order.push(target);
        return stagedFolders()(target);
      };
      const out = await build({ native: { pins, stage, targets: ['win32-x64'] } });
      expect(
        filesOf(out)
          .filter((rel) => rel.startsWith('native/'))
          .every((rel) => rel.startsWith('native/win32-x64/')),
      ).toBe(true);
      expect(order).toEqual(['win32-x64']);
      const both = await build({ native: { pins, stage: stagedFolders(), targets: ['win32-x64', 'win32-arm64'] } });
      expect(entriesOf(both, 'win32-arm64').length).toBeGreaterThan(0);

      const outDir = join(temp('out'), 'bundle');
      await expect(
        buildBundle({
          outDir,
          entries: HOOK_ENTRY,
          web: false,
          native: { pins, stage: stagedFolders(), targets: ['linux-x64'] },
        }),
      ).rejects.toThrow(/unknown native target linux-x64/);
      await expect(
        buildBundle({ outDir, entries: HOOK_ENTRY, web: false, native: { pins, stage: stagedFolders(), targets: [] } }),
      ).rejects.toThrow(/at least one native target/);
      expect(existsSync(outDir)).toBe(false);
    },
    BUILD_MS,
  );
});

describe('a tampered package stops the build before anything is written', () => {
  const pins = pinsOf();

  async function refused(stage: (target: string) => Promise<string>, message: RegExp): Promise<void> {
    const outDir = join(temp('out'), 'bundle');
    await expect(buildBundle({ outDir, entries: HOOK_ENTRY, web: false, native: { pins, stage } })).rejects.toThrow(
      message,
    );
    expect(existsSync(outDir), 'no output folder is created').toBe(false);
  }

  it('refuses a binary with the right size and another byte (tampered binary)', async () => {
    await refused(
      stagedFolders((target, dir) => {
        const rel = `prebuilds/${target}/conpty.node`;
        const bytes = Buffer.from(readFileSync(join(dir, rel)));
        bytes[2] = 0x7e;
        writeFileSync(join(dir, rel), bytes);
      }),
      /conpty\.node: sha256 differs from the pin/,
    );
  });

  it('refuses a binary of another size, a missing binary and a pinned text pattern that matches nothing', async () => {
    await refused(
      stagedFolders((target, dir) => {
        const rel = `prebuilds/${target}/conpty/conpty.dll`;
        writeFileSync(join(dir, rel), Buffer.concat([readFileSync(join(dir, rel)), Buffer.from([1])]));
      }),
      /conpty\.dll: .*bytes/,
    );
    await refused(
      stagedFolders((target, dir) => {
        rmSync(join(dir, `prebuilds/${target}/conpty/OpenConsole.exe`));
      }),
      /OpenConsole\.exe: missing/,
    );
    await refused(
      stagedFolders((_target, dir) => {
        rmSync(join(dir, 'lib'), { recursive: true });
      }),
      /text pattern lib\/\*\.js matches no file/,
    );
  });

  it('refuses a tarball whose integrity is not the one of the lockfile (wrong integrity)', async () => {
    const tarballDir = temp('tarballs');
    const runtimeRoot = temp('runtime');
    const tgz = gzipSync(Buffer.alloc(1024));
    for (const target of TARGETS) writeFileSync(join(tarballDir, `fixture-pty-${target}-${VERSION}.tgz`), tgz);
    const lock = {
      packages: {
        'node_modules/@fixture/pty': { version: VERSION },
        ...Object.fromEntries(
          TARGETS.map((target) => [
            `node_modules/@fixture/pty-${target}`,
            { version: VERSION, integrity: pins.targets[target]?.integrity },
          ]),
        ),
      },
    };
    await refused(
      (target) =>
        stageTarget({ target, pins, lock, runtimeRoot, tarballDir, env: {}, npmCli: null }).then((r) => r.dir),
      /integrity of fixture-pty-win32-(?:x64|arm64)-2\.0\.0\.tgz differs from the lockfile/,
    );
  });
});

// ---- the real pins against the installed package of the host ---------------------------------------------------------------------

const HOST = `${process.platform}-${process.arch}`;
const REAL_PINS = readNativePins();
const HOST_INSTALLED =
  HOST in REAL_PINS.targets &&
  existsSync(join(import.meta.dirname, '..', '..', 'node_modules', '@lydell', `node-pty-${HOST}`));

describe.runIf(HOST_INSTALLED)('the real pins and the installed package of the host', () => {
  it(
    'stages the host target into a bundle: the file set equals the pins and every binary has its sha256',
    async () => {
      const out = await build({ native: { targets: [HOST] } });
      const entry = REAL_PINS.targets[HOST];
      const staged = nativeFilesOf({
        dir: join(import.meta.dirname, '..', '..', 'node_modules', '@lydell', `node-pty-${HOST}`),
        pins: REAL_PINS,
        target: HOST,
      });
      expect(entriesOf(out, HOST)).toEqual([...staged.keys()].map((rel) => `native/${HOST}/${rel}`).sort());
      for (const [rel, pin] of Object.entries(entry?.binary ?? {})) {
        const bytes = readFileSync(join(out, 'native', HOST, rel));
        expect(bytes.length, rel).toBe(pin.bytes);
        expect(sha256(bytes), rel).toBe(pin.sha256);
      }
      expect(filesOf(out).filter((rel) => rel.endsWith('.pdb'))).toEqual([]);
      const notices = readFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
      expect(notices).toContain(`${entry?.package ?? ''} ${REAL_PINS.version}\nLicense: MIT`);
    },
    BUILD_MS,
  );
});
