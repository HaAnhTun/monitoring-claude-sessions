// The tracked-binaries guard (TC-GATE-05, design 08 section 4.2): a native or executable file is tracked only below
// `skills/<skill>/bundle/native/`. Two rules: the extension (`.node .dll .exe .so .dylib .pdb .lib`) and the file header
// (a Windows PE, an ELF or a Mach-O image under any other name). Files come from `git ls-files -z`; the Docker harness
// unpacks a tar without `.git`, so a walk that skips `node_modules`, `dist`, `.git` and `.dev` is the fallback.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', '.dev']);

/** The extensions of native code and debug files. */
const BINARY_EXTENSIONS = ['.node', '.dll', '.exe', '.so', '.dylib', '.pdb', '.lib'];

/** The only place a native file may be tracked. */
const NATIVE_FOLDER = /^skills\/[^/]+\/bundle\/native\//;

/** Mach-O magic numbers (32 and 64 bit, both byte orders). `CAFEBABE` is left out: a Java class file shares it. */
const MACH_O_MAGIC = ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'];

const toPosix = (path: string): string => path.split(sep).join('/');

function listFiles(root: string): string[] {
  if (!existsSync(join(root, '.git'))) return walk(root);
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf8')
      .split('\0')
      .filter((p) => p !== '');
  } catch {
    return walk(root);
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_NAMES.has(name)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(full);
      else out.push(toPosix(relative(root, full)));
    }
  };
  visit(root);
  return out;
}

/** The first `length` bytes of a file (fewer for a short file). */
function head(full: string, length: number): Buffer {
  const fd = openSync(full, 'r');
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}

/** A Windows PE image: `MZ`, and the `PE\0\0` signature where the header at offset 0x3c points. */
function isPortableExecutable(full: string): boolean {
  const first = head(full, 4096);
  if (first.length < 0x40 || first[0] !== 0x4d || first[1] !== 0x5a) return false;
  const at = first.readUInt32LE(0x3c);
  if (at + 4 > first.length) return false;
  return first.subarray(at, at + 4).equals(Buffer.from([0x50, 0x45, 0, 0]));
}

/** `exe`, `elf` or `mach-o` when the file header is that of an executable image, else `null`. */
function imageKind(full: string): string | null {
  const first = head(full, 4);
  if (first.length < 4) return null;
  if (first.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf';
  if (MACH_O_MAGIC.includes(first.toString('hex'))) return 'mach-o';
  return isPortableExecutable(full) ? 'pe' : null;
}

/** Every violation of the guard in a tree, as `path: reason` lines. */
function findings(root: string): string[] {
  const hits: string[] = [];
  for (const rel of listFiles(root)) {
    if (NATIVE_FOLDER.test(rel)) continue;
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    const lower = rel.toLowerCase();
    const ext = BINARY_EXTENSIONS.find((e) => lower.endsWith(e));
    if (ext !== undefined) hits.push(`${rel}: ${ext} file outside skills/*/bundle/native/`);
    else {
      const kind = imageKind(full);
      if (kind !== null) hits.push(`${rel}: ${kind} executable image outside skills/*/bundle/native/`);
    }
  }
  return hits;
}

const temps: string[] = [];

function plant(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'mcs-tracked-binaries-'));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** A minimal PE: `MZ`, the header offset 0x40 at 0x3c, and `PE\0\0` there. */
function peImage(): Buffer {
  const image = Buffer.alloc(0x80);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(0x40, 0x3c);
  Buffer.from([0x50, 0x45, 0, 0]).copy(image, 0x40);
  return image;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('TC-GATE-05: tracked binaries only below skills/*/bundle/native/', () => {
  it('tracks no native or executable file outside the bundle native folder', () => {
    expect(findings(REPO)).toEqual([]);
  });

  describe('negative probes on a throw-away tree', () => {
    for (const ext of BINARY_EXTENSIONS) {
      it(`flags a planted ${ext} file outside the native folder`, () => {
        expect(findings(plant({ [`runtime/probe${ext}`]: 'x' }))).toHaveLength(1);
        expect(findings(plant({ [`runtime/PROBE${ext.toUpperCase()}`]: 'x' }))).toHaveLength(1);
      });

      it(`allows a ${ext} file below skills/<skill>/bundle/native/`, () => {
        expect(findings(plant({ [`skills/s/bundle/native/win32-x64/probe${ext}`]: 'x' }))).toEqual([]);
      });
    }

    it('anchors the allowed folder at the repository root and at the bundle', () => {
      expect(findings(plant({ 'docs/skills/s/bundle/native/a.node': 'x' }))).toHaveLength(1);
      expect(findings(plant({ 'skills/s/bundle/native-extra/a.node': 'x' }))).toHaveLength(1);
      expect(findings(plant({ 'skills/s/runtime/bundle/native/a.node': 'x' }))).toHaveLength(1);
      expect(findings(plant({ 'skills/bundle/native/a.node': 'x' }))).toHaveLength(1);
    });

    it('flags a Windows executable under a harmless name, and allows it in the native folder', () => {
      expect(findings(plant({ 'tools/helper.dat': peImage() }))).toEqual([
        'tools/helper.dat: pe executable image outside skills/*/bundle/native/',
      ]);
      expect(findings(plant({ 'skills/s/bundle/native/helper.dat': peImage() }))).toEqual([]);
    });

    it('flags an ELF and a Mach-O image under a harmless name', () => {
      const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16)]);
      const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(16)]);
      expect(findings(plant({ 'tools/a.dat': elf }))).toHaveLength(1);
      expect(findings(plant({ 'tools/b.dat': macho }))).toHaveLength(1);
    });

    it('does not flag text that starts with MZ, an image or an archive', () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]);
      const zip = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4]), Buffer.alloc(16)]);
      const root = plant({
        'docs/mz.txt': `MZ is not a program, ${'x'.repeat(100)}`,
        'docs/a.png': png,
        'docs/a.zip': zip,
        'docs/empty.txt': '',
      });
      expect(findings(root)).toEqual([]);
    });

    it('skips node_modules, dist, .git and .dev in the fallback walk', () => {
      const root = plant({
        'node_modules/p/x.node': 'x',
        'dist/x.dll': 'x',
        '.dev/x.exe': 'x',
        '.git/x.so': 'x',
        'kept/y.dylib': 'x',
      });
      expect(findings(root)).toEqual(['kept/y.dylib: .dylib file outside skills/*/bundle/native/']);
    });
  });
});
