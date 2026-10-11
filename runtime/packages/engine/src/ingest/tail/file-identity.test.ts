import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  IDENTITY_HEAD_BYTES,
  checkIdentity,
  classifyFsError,
  hashHead,
  readIdentity,
  type FileIdentity,
} from './file-identity.ts';

const makeTemp = useTempDirs();

function workDir(): string {
  const dir = join(makeTemp('identity').path, 'work');
  mkdirSync(dir);
  return dir;
}

const LINE = (n: number): string => `{"type":"user","n":${String(n)},"pad":"${'p'.repeat(40)}"}\n`;
const lines = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => LINE(from + i)).join('');

describe('classifyFsError', () => {
  it.each([
    ['ENOENT', 'missing'],
    ['ENOTDIR', 'missing'],
    ['EACCES', 'unreadable'],
    ['EBUSY', 'unreadable'],
    ['EPERM', 'unreadable'],
    ['EISDIR', 'unreadable'],
    ['EMFILE', 'unreadable'],
  ] as const)('%s is %s', (code, expected) => {
    expect(classifyFsError(code)).toBe(expected);
  });
});

describe('readIdentity', () => {
  it('hashes the first 256 bytes and keeps the inode as a decimal string', async () => {
    const file = join(workDir(), 'a.jsonl');
    writeFileSync(file, lines(0, 20));
    const id = await readIdentity(file);
    expect(id.headLen).toBe(IDENTITY_HEAD_BYTES);
    expect(id.headHash).toBe(hashHead(Buffer.from(lines(0, 20)).subarray(0, 256)));
    expect(id.ino === null || /^[0-9]+$/.test(id.ino)).toBe(true);
  });

  it('uses the whole file when it is shorter than 256 bytes', async () => {
    const file = join(workDir(), 'short.jsonl');
    writeFileSync(file, 'abc\n');
    const id = await readIdentity(file);
    expect(id.headLen).toBe(4);
  });
});

describe('checkIdentity', () => {
  async function setup(content: string): Promise<{ file: string; id: FileIdentity; size: number }> {
    const file = join(workDir(), 'a.jsonl');
    writeFileSync(file, content);
    return { file, id: await readIdentity(file), size: Buffer.byteLength(content) };
  }

  it('reports unchanged for an untouched file and grown after an append', async () => {
    const { file, id, size } = await setup(lines(0, 10));
    expect((await checkIdentity(file, id, size, size)).kind).toBe('unchanged');
    appendFileSync(file, lines(10, 12));
    const grown = await checkIdentity(file, id, size, size);
    expect(grown.kind).toBe('grown');
    if (grown.kind === 'grown') expect(Number(grown.stat.size)).toBe(size + Buffer.byteLength(lines(10, 12)));
  });

  it('reports a truncation when the size falls below the lowest consumed cursor', async () => {
    const { file, id, size } = await setup(lines(0, 10));
    writeFileSync(file, lines(0, 4));
    const result = await checkIdentity(file, id, size, size);
    expect(result).toMatchObject({ kind: 'reset', reason: 'truncated' });
  });

  it('reports a replacement when a file is renamed over the path', async () => {
    const { file, id, size } = await setup(lines(0, 10));
    const other = `${file}.new`;
    writeFileSync(other, lines(100, 110));
    renameSync(other, file);
    const result = await checkIdentity(file, id, size, size);
    expect(result).toMatchObject({ kind: 'reset', reason: 'replaced' });
  });

  it('reports a replacement for delete and recreate with the same size and another head', async () => {
    const { file, id, size } = await setup(lines(10, 20));
    rmSync(file);
    writeFileSync(file, lines(50, 60));
    expect(Buffer.byteLength(lines(50, 60))).toBe(size);
    expect(await checkIdentity(file, id, size, size)).toMatchObject({ kind: 'reset', reason: 'replaced' });
  });

  it('reports a replacement when the same inode is rewritten with another head', async () => {
    const { file, id, size } = await setup(lines(0, 10));
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.from('{"type":"zzzz"'), 0);
    closeSync(fd);
    appendFileSync(file, lines(10, 11));
    expect(await checkIdentity(file, id, size, size)).toMatchObject({ kind: 'reset', reason: 'replaced' });
  });

  it('verifies the head on every check when the stored mtime is unknown, and skips it when nothing changed', async () => {
    const { file, id, size } = await setup(lines(0, 10));
    const first = await checkIdentity(file, id, size, size, null);
    expect(first.kind).toBe('unchanged');
    if (first.kind === 'unchanged') {
      const again = await checkIdentity(file, id, size, size, Number(first.stat.mtimeMs));
      expect(again.kind).toBe('unchanged');
    }
  });

  it('reports a missing file and keeps the caller in charge of its cursors', async () => {
    const { file, id, size } = await setup(lines(0, 3));
    rmSync(file);
    expect(await checkIdentity(file, id, size, size)).toEqual({ kind: 'missing' });
  });

  it('reports an unreadable path with the error code', async () => {
    const dir = join(workDir(), 'a-directory.jsonl');
    mkdirSync(dir);
    const result = await checkIdentity(dir, null, 0, 0);
    expect(result.kind).toBe('unreadable');
  });

  it('compares sizes alone when there is no stored identity yet', async () => {
    const { file, size } = await setup(lines(0, 3));
    expect((await checkIdentity(file, null, size, size)).kind).toBe('unchanged');
    appendFileSync(file, LINE(9));
    expect((await checkIdentity(file, null, size, size)).kind).toBe('grown');
  });

  it('accepts a stored identity that covers a shorter head as long as that prefix still matches', async () => {
    const file = join(workDir(), 'small.jsonl');
    writeFileSync(file, 'abc\n');
    const id = await readIdentity(file);
    appendFileSync(file, lines(0, 10));
    expect((await checkIdentity(file, id, 4, 4)).kind).toBe('grown');
    const extended = await readIdentity(file);
    expect(extended.headLen).toBe(IDENTITY_HEAD_BYTES);
  });
});
