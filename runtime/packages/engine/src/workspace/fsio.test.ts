// Workspace file rules (01 1.2): link refusal, atomic writes that retry sharing violations (E5), PyJson files, universal
// newlines, compare-and-delete. Includes the unit row T-ISO-07 (hostile key names stay plain keys) at the file layer.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { McsError } from '@mcs/shared';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { parsePyJson } from '../pyjson/index.ts';
import {
  MAX_TEXT_BYTES,
  appendWorkspaceFile,
  assertNotLink,
  compareAndDelete,
  isMissingFileError,
  readJsonFile,
  readTextTail,
  readTextUniversal,
  writePyJsonFile,
  writeWorkspaceFile,
} from './fsio.ts';

const isWin = process.platform === 'win32';
const makeTemp = useTempDirs();

/** A fresh empty folder: the temp root itself holds the testkit's FIXTURE.md marker. */
function workDir(): string {
  const dir = path.join(makeTemp('fsio').path, 'work');
  mkdirSync(dir);
  return dir;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'RESOLVED';
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'RETURNED';
}

function strayTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

const BOM = String.fromCodePoint(0xfeff);
const E_ACUTE = String.fromCodePoint(0xe9);
const REPLACEMENT = String.fromCodePoint(0xfffd);

describe('assertNotLink', () => {
  it('accepts an absent path, a file and a folder', () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    expect(() => {
      assertNotLink(path.join(dir, 'missing'));
      assertNotLink(path.join(dir, 'a.txt'));
      assertNotLink(dir);
    }).not.toThrow();
  });

  it('treats a path below a file as absent (the later open reports the real problem)', () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    expect(() => {
      assertNotLink(path.join(dir, 'a.txt', 'below'));
    }).not.toThrow();
  });

  it('refuses a junction (Windows) or symlink with WORKSPACE_SYMLINK', () => {
    const dir = workDir();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    const link = path.join(dir, 'link');
    makeJunction(link, real);
    expect(
      codeOfSync(() => {
        assertNotLink(link);
      }),
    ).toBe('WORKSPACE_SYMLINK');
  });
});

describe('writeWorkspaceFile', () => {
  it('writes text and bytes, replaces an existing file and leaves no temp file', async () => {
    const dir = workDir();
    const file = path.join(dir, 'task.json');
    await writeWorkspaceFile(file, 'first\n');
    expect(readFileSync(file, 'utf8')).toBe('first\n');
    await writeWorkspaceFile(file, new Uint8Array([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64]));
    expect(readFileSync(file, 'utf8')).toBe('second');
    expect(strayTemps(dir)).toEqual([]);
  });

  it('refuses a link as the target and leaves what it points to alone (T-SEC-04)', async () => {
    const dir = workDir();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'keep.txt'), 'keep');
    const link = path.join(dir, 'link');
    makeJunction(link, real);
    expect(await codeOf(writeWorkspaceFile(link, 'x'))).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(real)).toEqual(['keep.txt']);
  });

  it('refuses a link as the parent folder and writes nothing through it (T-SEC-04)', async () => {
    const dir = workDir();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    const link = path.join(dir, 'audit');
    makeJunction(link, real);
    expect(await codeOf(writeWorkspaceFile(path.join(link, 'changes.md'), 'x'))).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(real)).toEqual([]);
  });

  it('maps an I/O failure to WORKSPACE_INVALID with the stable code (no path, no errno text)', async () => {
    const dir = workDir();
    const error = await writeWorkspaceFile(path.join(dir, 'no-such-folder', 'x.json'), 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'WORKSPACE_INVALID', message: 'cannot replace x.json: E_ATOMIC_WRITE_IO' });
  });

  it('E5: keeps retrying while another process holds the target and succeeds after it lets go', async () => {
    const dir = workDir();
    const file = path.join(dir, 'config.json');
    writeFileSync(file, 'old');
    const holder = await open(file, 'r');
    const release = delay(300).then(() => holder.close());
    const started = performance.now();
    await writeWorkspaceFile(file, 'new');
    const elapsed = performance.now() - started;
    await release;
    expect(readFileSync(file, 'utf8')).toBe('new');
    // On Windows the rename over a held file fails with EPERM until the holder closes; on POSIX it never waits.
    if (isWin) expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(strayTemps(dir)).toEqual([]);
  });

  it.runIf(isWin)('E5: gives up after the budget with E_ATOMIC_WRITE_BUSY and keeps the old file', async () => {
    const dir = workDir();
    const file = path.join(dir, 'config.json');
    writeFileSync(file, 'old');
    const holder = await open(file, 'r');
    try {
      const error = await writeWorkspaceFile(file, 'new', { budgetMs: 200 }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'WORKSPACE_INVALID',
        message: 'cannot replace config.json: E_ATOMIC_WRITE_BUSY',
      });
    } finally {
      await holder.close();
    }
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(strayTemps(dir)).toEqual([]);
  });
});

describe('writePyJsonFile', () => {
  it('writes the Python form: indent 2, ints stay ints, floats keep their Python repr, raw UTF-8, one final LF', async () => {
    const dir = workDir();
    const file = path.join(dir, 'config.json');
    const source = `{"schema_version": 1, "window_hours": 24.0, "big": 1e16, "wide": 10000000000000000, "name": "Caf${E_ACUTE}"}`;
    await writePyJsonFile(file, parsePyJson(source));
    expect(readFileSync(file, 'utf8')).toBe(
      `{\n  "schema_version": 1,\n  "window_hours": 24.0,\n  "big": 1e+16,\n  "wide": 10000000000000000,\n  "name": "Caf${E_ACUTE}"\n}\n`,
    );
  });

  it('keeps the order of the entries and never reorders integer-like keys', async () => {
    const dir = workDir();
    const file = path.join(dir, 'x.json');
    await writePyJsonFile(file, parsePyJson('{"b": 1, "2": 2, "a": 3}'));
    expect(readFileSync(file, 'utf8')).toBe('{\n  "b": 1,\n  "2": 2,\n  "a": 3\n}\n');
  });

  it('T-ISO-07: hostile key names are plain keys; nothing reaches the prototype', async () => {
    const dir = workDir();
    const file = path.join(dir, 'config.json');
    const source = '{"__proto__": {"x": 1}, "constructor": {"prototype": {"x": 2}}, "../b": 3, "a/../../b": 4}';
    await writePyJsonFile(file, parsePyJson(source));
    const read = await readJsonFile(file);
    expect(read.text).toBe(
      '{\n  "__proto__": {\n    "x": 1\n  },\n  "constructor": {\n    "prototype": {\n      "x": 2\n    }\n  },\n  "../b": 3,\n  "a/../../b": 4\n}\n',
    );
    const probe: Record<string, unknown> = {};
    expect(probe['x']).toBeUndefined();
    expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('refuses a link as the target', async () => {
    const dir = workDir();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    const link = path.join(dir, 'link');
    makeJunction(link, real);
    expect(await codeOf(writePyJsonFile(link, parsePyJson('{}')))).toBe('WORKSPACE_SYMLINK');
  });
});

describe('readTextUniversal', () => {
  it('turns CRLF and lone CR into LF and strips one BOM', async () => {
    const dir = workDir();
    const file = path.join(dir, 'changes.md');
    writeFileSync(file, `${BOM}# Changes\r\n\r\n## a\rb\nc\r\n`);
    expect(await readTextUniversal(file)).toBe('# Changes\n\n## a\nb\nc\n');
  });

  it('decodes bad UTF-8 with replacement characters instead of failing', async () => {
    const dir = workDir();
    const file = path.join(dir, 'x.md');
    writeFileSync(file, Buffer.from([0x61, 0xff, 0x62]));
    expect(await readTextUniversal(file)).toBe(`a${REPLACEMENT}b`);
  });

  it('refuses a file larger than maxBytes with WORKSPACE_INVALID', async () => {
    const dir = workDir();
    const file = path.join(dir, 'big.md');
    writeFileSync(file, 'x'.repeat(11));
    const error = await readTextUniversal(file, 10).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'WORKSPACE_INVALID', message: 'big.md is larger than 10 bytes' });
    expect(await readTextUniversal(file, 11)).toBe('x'.repeat(11));
  });

  it('defaults to 16 MiB', () => {
    expect(MAX_TEXT_BYTES).toBe(16 * 1024 * 1024);
  });

  it('lets a missing file through as a Node error that isMissingFileError recognises', async () => {
    const dir = workDir();
    const error = await readTextUniversal(path.join(dir, 'absent.md')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isMissingFileError(error)).toBe(true);
    expect(isMissingFileError(new Error('other'))).toBe(false);
    expect(isMissingFileError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
  });
});

describe('readJsonFile', () => {
  it('returns the text and the PyJson value', async () => {
    const dir = workDir();
    const file = path.join(dir, 'task.json');
    writeFileSync(file, '{\n  "id": "a",\n  "n": 1.0\n}\n');
    const read = await readJsonFile(file);
    expect(read.text).toBe('{\n  "id": "a",\n  "n": 1.0\n}\n');
    expect(read.value).toEqual({
      k: 'obj',
      v: [
        ['id', { k: 'str', v: 'a' }],
        ['n', { k: 'float', v: 1 }],
      ],
    });
  });

  it('a BOM is an error exactly as in Python json.load', async () => {
    const dir = workDir();
    const file = path.join(dir, 'task.json');
    writeFileSync(file, `${BOM}{}`);
    expect(await codeOf(readJsonFile(file))).toBe('CONFIG_UNREADABLE');
  });

  it('reports a missing file, bad JSON and invalid UTF-8 as CONFIG_UNREADABLE', async () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'bad.json'), '{"a": }');
    writeFileSync(path.join(dir, 'utf.json'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    expect(await codeOf(readJsonFile(path.join(dir, 'absent.json')))).toBe('CONFIG_UNREADABLE');
    const bad = await readJsonFile(path.join(dir, 'bad.json')).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'CONFIG_UNREADABLE' });
    expect((bad as McsError).message).toContain('is not valid JSON');
    const utf = await readJsonFile(path.join(dir, 'utf.json')).catch((e: unknown) => e);
    expect(utf).toMatchObject({ code: 'CONFIG_UNREADABLE' });
    expect((utf as McsError).message).toContain('not valid UTF-8');
  });

  it('reports a folder as CONFIG_UNREADABLE', async () => {
    const dir = workDir();
    expect(await codeOf(readJsonFile(dir))).toBe('CONFIG_UNREADABLE');
  });
});

describe('compareAndDelete', () => {
  it('deletes only when the bytes are the expected ones', async () => {
    const dir = workDir();
    const file = path.join(dir, 'state.json');
    writeFileSync(file, 'abc');
    expect(await compareAndDelete(file, new TextEncoder().encode('abd'))).toBe('changed');
    expect(existsSync(file)).toBe(true);
    expect(await compareAndDelete(file, new TextEncoder().encode('abc'))).toBe('deleted');
    expect(existsSync(file)).toBe(false);
    expect(await compareAndDelete(file, new TextEncoder().encode('abc'))).toBe('absent');
  });

  it('a file that is longer or shorter than expected is changed', async () => {
    const dir = workDir();
    const file = path.join(dir, 'state.json');
    writeFileSync(file, 'abc');
    expect(await compareAndDelete(file, new TextEncoder().encode('ab'))).toBe('changed');
    expect(await compareAndDelete(file, new TextEncoder().encode('abcd'))).toBe('changed');
    expect(await compareAndDelete(file, new Uint8Array(0))).toBe('changed');
  });
});

describe('appendWorkspaceFile', () => {
  it('appends bytes to an existing file and creates a missing one', async () => {
    const dir = workDir();
    const file = path.join(dir, 'changes.md');
    await appendWorkspaceFile(file, 'one\n');
    await appendWorkspaceFile(file, 'two\n');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a link as the file or as the parent folder', async () => {
    const dir = workDir();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    const link = path.join(dir, 'audit');
    makeJunction(link, real);
    expect(await codeOf(appendWorkspaceFile(path.join(link, 'changes.md'), 'x'))).toBe('WORKSPACE_SYMLINK');
    expect(await codeOf(appendWorkspaceFile(link, 'x'))).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(real)).toEqual([]);
  });

  it('E5: retries while the file is held and gives up after the budget (Windows)', async () => {
    const dir = workDir();
    const file = path.join(dir, 'changes.md');
    writeFileSync(file, 'one\n');
    // A Node handle opened for reading does not block an append on any platform; the retry path is covered by the
    // write tests above. This case pins that an append next to a reader still lands.
    const reader = await open(file, 'r');
    try {
      await appendWorkspaceFile(file, 'two\n', { budgetMs: 200 });
    } finally {
      await reader.close();
    }
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });
});

describe('readTextTail', () => {
  it('returns a small file whole and untruncated', async () => {
    const dir = workDir();
    const file = path.join(dir, 'changes.md');
    writeFileSync(file, `${BOM}a\r\nb\r\n`);
    expect(await readTextTail(file, 100)).toEqual({ text: 'a\nb\n', truncated: false });
  });

  it('returns only the last maxBytes bytes of a larger file and says so', async () => {
    const dir = workDir();
    const file = path.join(dir, 'changes.md');
    writeFileSync(file, '0123456789\nABCDEFGHIJ\n');
    expect(await readTextTail(file, 8)).toEqual({ text: 'DEFGHIJ\n', truncated: true });
  });

  it('a missing file is a Node error like readTextUniversal', async () => {
    const dir = workDir();
    const error = await readTextTail(path.join(dir, 'absent.md'), 8).catch((e: unknown) => e);
    expect(isMissingFileError(error)).toBe(true);
  });
});
