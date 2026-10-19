import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  AtomicWriteError,
  SmallFileError,
  atomicWriteFile,
  clipCodePoints,
  createFsx,
  pySplitlines,
  readSmallFile,
  retryBusy,
  tailLines,
  unlinkWithRetry,
  type FsxDeps,
  type FsxFile,
} from './fsx.ts';

const makeTemp = useTempDirs();

// Invisible in an editor: built from code points so that no tool can normalise them away.
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const BOM = String.fromCodePoint(0xfeff);

/** A fresh empty folder: the temp root itself holds the testkit's FIXTURE.md marker. */
function workDir(): string {
  const dir = path.join(makeTemp('fsx').path, 'work');
  mkdirSync(dir);
  return dir;
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

interface StubState {
  readonly opened: { file: string; flags: string; mode: number | undefined }[];
  readonly written: Uint8Array[];
  readonly renames: { from: string; to: string }[];
  readonly unlinked: string[];
  readonly sleeps: number[];
  closed: number;
  /** The arguments of every read call. */
  reads: { offset: number; length: number; position: number }[];
  synced: number;
  /** Errors thrown by the next rename calls, in order; an empty queue lets the rename succeed. */
  renameErrors: NodeJS.ErrnoException[];
  /** Errors thrown by the next open calls (any flags), in order. */
  openErrors: NodeJS.ErrnoException[];
  /** Content a read-mode open returns. */
  content: Uint8Array;
  /** Reported size of that content (defaults to its length). */
  size: number | undefined;
  writeError: NodeJS.ErrnoException | undefined;
  unlinkErrors: NodeJS.ErrnoException[];
  clock: number;
}

/** The state plus the dependencies that read and write it. */
type Stub = StubState & { readonly deps: FsxDeps };

function makeStub(): Stub {
  const stub: StubState = {
    opened: [],
    written: [],
    renames: [],
    unlinked: [],
    sleeps: [],
    closed: 0,
    reads: [],
    synced: 0,
    renameErrors: [],
    openErrors: [],
    content: new Uint8Array(0),
    size: undefined,
    writeError: undefined,
    unlinkErrors: [],
    clock: 0,
  };
  const file: FsxFile = {
    stat: () => Promise.resolve({ size: stub.size ?? stub.content.length }),
    read: (buffer, offset, length, position) => {
      stub.reads.push({ offset, length, position });
      const chunk = stub.content.subarray(position, position + length);
      buffer.set(chunk, offset);
      return Promise.resolve({ bytesRead: chunk.length });
    },
    writeAll: (data) => {
      if (stub.writeError !== undefined) return Promise.reject(stub.writeError);
      stub.written.push(data);
      return Promise.resolve();
    },
    sync: () => {
      stub.synced += 1;
      return Promise.resolve();
    },
    close: () => {
      stub.closed += 1;
      return Promise.resolve();
    },
  };
  const deps: FsxDeps = {
    open: (target, flags, mode) => {
      stub.opened.push({ file: target, flags, mode });
      const failure = stub.openErrors.shift();
      return failure === undefined ? Promise.resolve(file) : Promise.reject(failure);
    },
    rename: (from, to) => {
      stub.renames.push({ from, to });
      const failure = stub.renameErrors.shift();
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    unlink: (target) => {
      stub.unlinked.push(target);
      const failure = stub.unlinkErrors.shift();
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    sleep: (ms) => {
      stub.sleeps.push(ms);
      stub.clock += ms;
      return Promise.resolve();
    },
    now: () => stub.clock,
    pid: 4242,
  };
  return Object.assign(stub, { deps });
}

describe('pySplitlines (Python str.splitlines)', () => {
  it('splits on every Python line boundary', () => {
    expect(pySplitlines('a\r\nb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\rb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\nb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u000bb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u000cb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u001cb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u001db')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u001eb')).toEqual(['a', 'b']);
    expect(pySplitlines('a\u0085b')).toEqual(['a', 'b']);
    expect(pySplitlines(`a${LS}b`)).toEqual(['a', 'b']);
    expect(pySplitlines(`a${PS}b`)).toEqual(['a', 'b']);
  });

  it('does not split on the unit separator or on a plain space', () => {
    expect(pySplitlines('a\u001fb')).toEqual(['a\u001fb']);
    expect(pySplitlines('a b')).toEqual(['a b']);
  });

  it('never creates an empty last element from a trailing terminator', () => {
    expect(pySplitlines('a\n')).toEqual(['a']);
    expect(pySplitlines('a\r\n')).toEqual(['a']);
    expect(pySplitlines('a\n\n')).toEqual(['a', '']);
    expect(pySplitlines('\n')).toEqual(['']);
    expect(pySplitlines('\r\n')).toEqual(['']);
    expect(pySplitlines('a\n\r')).toEqual(['a', '']);
  });

  it('keeps empty lines in the middle and treats CRLF as one terminator', () => {
    expect(pySplitlines('a\r\n\r\nb')).toEqual(['a', '', 'b']);
    expect(pySplitlines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('maps the empty string to an empty list', () => {
    expect(pySplitlines('')).toEqual([]);
    expect(pySplitlines('abc')).toEqual(['abc']);
  });
});

describe('clipCodePoints', () => {
  it('cuts by code point, never inside a surrogate pair, with no marker', () => {
    expect(clipCodePoints('abcdef', 3)).toBe('abc');
    expect(clipCodePoints('a\u{1f600}b\u{1f600}c', 3)).toBe('a\u{1f600}b');
    expect(clipCodePoints('\u{1f600}\u{1f600}', 1)).toBe('\u{1f600}');
  });

  it('returns short input unchanged and handles zero', () => {
    expect(clipCodePoints('abc', 220)).toBe('abc');
    expect(clipCodePoints('', 5)).toBe('');
    expect(clipCodePoints('abc', 0)).toBe('');
  });

  it('clips 220 emoji exactly like Python slicing', () => {
    const line = '\u{1f600}'.repeat(300);
    expect(Array.from(clipCodePoints(line, 220))).toHaveLength(220);
  });
});

describe('atomicWriteFile (real file system)', () => {
  it('writes the given bytes unchanged: BOM, invalid UTF-8 and NUL survive', async () => {
    const dir = workDir();
    const target = path.join(dir, 'bytes.bin');
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x00, 0x0d, 0x0a, 0xc3]);
    await atomicWriteFile(target, bytes);
    expect([...readFileSync(target)]).toEqual([...bytes]);
  });

  it('writes a string as UTF-8 without BOM and keeps line endings as given', async () => {
    const dir = workDir();
    const target = path.join(dir, 'text.txt');
    await atomicWriteFile(target, 'héllo\r\nworld\n');
    expect([...readFileSync(target)].slice(0, 3)).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(readFileSync(target, 'utf8')).toBe('héllo\r\nworld\n');
  });

  it('replaces an existing file and leaves no temp file behind', async () => {
    const dir = workDir();
    const target = path.join(dir, 'state.json');
    writeFileSync(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('creates the file when it does not exist', async () => {
    const dir = workDir();
    const target = path.join(dir, 'fresh.txt');
    await atomicWriteFile(target, '');
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  it('reports a missing parent folder as E_ATOMIC_WRITE_IO with the cause', async () => {
    const dir = workDir();
    const target = path.join(dir, 'missing', 'x.txt');
    const error = await atomicWriteFile(target, 'x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_IO', path: target });
    expect((error as AtomicWriteError).cause).toMatchObject({ code: 'ENOENT' });
  });
});

describe('atomicWriteFile (injected file system: temp name, retry, budget)', () => {
  it('writes <file>.<pid>.<random>.tmp next to the target with wx, syncs, closes, then renames', async () => {
    const stub = makeStub();
    const fsx = createFsx(stub.deps);
    await fsx.atomicWriteFile('/data/state.json', 'abc', { mode: 0o600 });
    expect(stub.opened).toHaveLength(1);
    const [opened] = stub.opened;
    expect(opened?.flags).toBe('wx');
    expect(opened?.mode).toBe(0o600);
    expect(opened?.file).toMatch(/^\/data\/state\.json\.4242\.[0-9a-f]{8}\.tmp$/);
    expect(stub.synced).toBe(1);
    expect(stub.closed).toBe(1);
    expect(stub.renames).toEqual([{ from: opened?.file, to: '/data/state.json' }]);
    expect(stub.unlinked).toEqual([]);
    expect(stub.sleeps).toEqual([]);
  });

  it('retries EPERM, EBUSY and EACCES with delays 50, 100, 200 ms and then succeeds', async () => {
    const stub = makeStub();
    stub.renameErrors.push(errno('EPERM'), errno('EBUSY'), errno('EACCES'));
    await createFsx(stub.deps).atomicWriteFile('/data/a.json', 'x');
    expect(stub.sleeps).toEqual([50, 100, 200]);
    expect(stub.renames).toHaveLength(4);
    expect(stub.unlinked).toEqual([]);
  });

  it('caps the delay at 250 ms', async () => {
    const stub = makeStub();
    for (let i = 0; i < 7; i += 1) stub.renameErrors.push(errno('EPERM'));
    await createFsx(stub.deps).atomicWriteFile('/data/a.json', 'x');
    expect(stub.sleeps).toEqual([50, 100, 200, 250, 250, 250, 250]);
  });

  it('gives up after the 3000 ms budget with E_ATOMIC_WRITE_BUSY and removes the temp file', async () => {
    const stub = makeStub();
    stub.renameErrors.push(...Array.from({ length: 100 }, () => errno('EPERM')));
    const error = await createFsx(stub.deps)
      .atomicWriteFile('/data/a.json', 'x')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_BUSY', path: '/data/a.json' });
    const slept = stub.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(slept).toBeGreaterThanOrEqual(3000);
    expect(slept).toBeLessThanOrEqual(3000 + 250);
    const [opened] = stub.opened;
    expect(stub.unlinked).toEqual([opened?.file]);
  });

  it('honours a custom budget', async () => {
    const stub = makeStub();
    stub.renameErrors.push(...Array.from({ length: 100 }, () => errno('EBUSY')));
    const error = await createFsx(stub.deps)
      .atomicWriteFile('/data/a.json', 'x', { budgetMs: 100 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_BUSY' });
    expect(stub.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(500);
  });

  it('maps any other rename error to E_ATOMIC_WRITE_IO at once and removes the temp file', async () => {
    const stub = makeStub();
    stub.renameErrors.push(errno('ENOSPC', 'disk full'));
    const error = await createFsx(stub.deps)
      .atomicWriteFile('/data/a.json', 'x')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_IO', path: '/data/a.json' });
    expect((error as AtomicWriteError).cause).toMatchObject({ code: 'ENOSPC' });
    expect(stub.sleeps).toEqual([]);
    expect(stub.unlinked).toHaveLength(1);
  });

  it('maps a failing write to E_ATOMIC_WRITE_IO, closes the handle and removes the temp file', async () => {
    const stub = makeStub();
    stub.writeError = errno('EIO');
    const error = await createFsx(stub.deps)
      .atomicWriteFile('/data/a.json', 'x')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_IO' });
    expect(stub.closed).toBe(1);
    expect(stub.renames).toEqual([]);
    expect(stub.unlinked).toHaveLength(1);
  });

  it('never reuses an existing temp file: an EEXIST on open is an I/O error without any unlink', async () => {
    const stub = makeStub();
    stub.openErrors.push(errno('EEXIST'));
    const error = await createFsx(stub.deps)
      .atomicWriteFile('/data/a.json', 'x')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_IO' });
    expect(stub.unlinked).toEqual([]);
  });
});

describe('unlinkWithRetry', () => {
  it('deletes a real file and reports absent for a missing one', async () => {
    const dir = workDir();
    const target = path.join(dir, 'gone.txt');
    writeFileSync(target, 'x');
    expect(await unlinkWithRetry(target)).toBe('deleted');
    expect(readdirSync(dir)).toEqual([]);
    expect(await unlinkWithRetry(target)).toBe('absent');
  });

  it('retries sharing violations and then deletes', async () => {
    const stub = makeStub();
    stub.unlinkErrors.push(errno('EPERM'), errno('EBUSY'));
    expect(await createFsx(stub.deps).unlinkWithRetry('/data/x')).toBe('deleted');
    expect(stub.sleeps).toEqual([50, 100]);
  });

  it('throws E_ATOMIC_WRITE_BUSY when the file stays busy for the whole budget', async () => {
    const stub = makeStub();
    stub.unlinkErrors.push(...Array.from({ length: 100 }, () => errno('EPERM')));
    const error = await createFsx(stub.deps)
      .unlinkWithRetry('/data/x', 500)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_BUSY', path: '/data/x' });
  });

  it('rethrows other errors as E_ATOMIC_WRITE_IO', async () => {
    const stub = makeStub();
    stub.unlinkErrors.push(errno('EISDIR'));
    const error = await createFsx(stub.deps)
      .unlinkWithRetry('/data/x')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_IO' });
  });
});

describe('retryBusy (ADR 0058, one retry rule for every caller)', () => {
  /** A clock that only the injected sleep moves, so a test counts the schedule exactly. */
  function manualTime(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let time = 1000;
    const sleeps: number[] = [];
    return {
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        time += ms;
        return Promise.resolve();
      },
      sleeps,
    };
  }

  it('returns the value of the first attempt without sleeping', async () => {
    const time = manualTime();
    const value = await retryBusy(() => Promise.resolve('done'), { startedAt: time.now(), budgetMs: 3000, ...time });
    expect(value).toBe('done');
    expect(time.sleeps).toEqual([]);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries %s on the schedule 50, 100, 200, 250, 250 ms', async (code) => {
    const time = manualTime();
    let calls = 0;
    const result = await retryBusy(
      () => {
        calls += 1;
        return calls <= 5 ? Promise.reject(errno(code)) : Promise.resolve(calls);
      },
      { startedAt: time.now(), budgetMs: 3000, ...time },
    );
    expect(result).toBe(6);
    expect(time.sleeps).toEqual([50, 100, 200, 250, 250]);
  });

  it('rethrows the last busy error once the budget is spent, after at least the budget of sleeping', async () => {
    const time = manualTime();
    let calls = 0;
    const error = await retryBusy(
      () => {
        calls += 1;
        return Promise.reject(errno('EBUSY'));
      },
      { startedAt: time.now(), budgetMs: 1000, ...time },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EBUSY' });
    const slept = time.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(slept).toBeGreaterThanOrEqual(1000);
    expect(slept - (time.sleeps.at(-1) ?? 0)).toBeLessThan(1000);
    expect(calls).toBe(time.sleeps.length + 1);
  });

  it('shares one budget between calls that pass the same start, so a chain of steps is bounded as a whole', async () => {
    const time = manualTime();
    const startedAt = time.now();
    const busy = (): Promise<never> => Promise.reject(errno('EPERM'));
    let first = 0;
    await retryBusy(() => (first++ < 4 ? busy() : Promise.resolve()), { startedAt, budgetMs: 1000, ...time });
    const spent = time.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(spent).toBe(600);
    const error = await retryBusy(busy, { startedAt, budgetMs: 1000, ...time }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EPERM' });
    // the second step could only use what the first left of the 1000 ms
    expect(time.sleeps.reduce((sum, ms) => sum + ms, 0) - spent).toBeLessThan(1000 - spent + 250);
  });

  it('counts the time spent inside the failing calls', async () => {
    const time = manualTime();
    let advance = 0;
    const clock = {
      now: () => time.now() + advance,
      sleep: time.sleep,
    };
    const error = await retryBusy(
      () => {
        advance += 600;
        return Promise.reject(errno('EBUSY'));
      },
      { startedAt: clock.now(), budgetMs: 1000, ...clock },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EBUSY' });
    expect(time.sleeps).toEqual([50]);
  });

  it('rethrows any other error at once, without sleeping', async () => {
    const time = manualTime();
    const error = await retryBusy(() => Promise.reject(errno('ENOENT')), {
      startedAt: time.now(),
      budgetMs: 3000,
      ...time,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(time.sleeps).toEqual([]);
    const plain = await retryBusy(() => Promise.reject(new Error('plain')), {
      startedAt: time.now(),
      budgetMs: 3000,
      ...time,
    }).catch((caught: unknown) => caught);
    expect(plain).toMatchObject({ message: 'plain' });
  });
});

describe('readSmallFile', () => {
  it('reads a real file and closes the handle', async () => {
    const dir = workDir();
    const target = path.join(dir, 'small.txt');
    writeFileSync(target, 'hello');
    const data = await readSmallFile(target, 1024);
    expect(data.toString('utf8')).toBe('hello');
  });

  it('allows a file of exactly maxBytes and rejects one byte more with E_FILE_TOO_LARGE', async () => {
    const dir = workDir();
    const target = path.join(dir, 'size.txt');
    writeFileSync(target, 'x'.repeat(10));
    expect((await readSmallFile(target, 10)).length).toBe(10);
    const error = await readSmallFile(target, 9).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmallFileError);
    expect(error).toMatchObject({ code: 'E_FILE_TOO_LARGE', path: target });
  });

  it('closes the handle also when the file is too large', async () => {
    const stub = makeStub();
    stub.content = new Uint8Array(100);
    await createFsx(stub.deps)
      .readSmallFile('/data/big', 10)
      .catch(() => undefined);
    expect(stub.closed).toBe(1);
  });

  it('detects growth after stat: a file that reports 0 bytes but yields more than maxBytes is too large', async () => {
    const stub = makeStub();
    stub.content = new Uint8Array(50);
    stub.size = 0;
    const error = await createFsx(stub.deps)
      .readSmallFile('/proc/self/cmdline', 10)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_FILE_TOO_LARGE' });
  });

  it('reads files that report size 0 (procfs style) until end of file', async () => {
    const stub = makeStub();
    stub.content = Uint8Array.from([97, 0, 98]);
    stub.size = 0;
    const data = await createFsx(stub.deps).readSmallFile('/proc/1/cmdline', 1024);
    expect([...data]).toEqual([97, 0, 98]);
  });

  it('retries EBUSY 10 times at 20 ms and then fails with E_FILE_BUSY', async () => {
    const stub = makeStub();
    stub.openErrors.push(...Array.from({ length: 50 }, () => errno('EBUSY')));
    const error = await createFsx(stub.deps)
      .readSmallFile('/data/state.json', 1024)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmallFileError);
    expect(error).toMatchObject({ code: 'E_FILE_BUSY', path: '/data/state.json' });
    expect(stub.sleeps).toEqual(Array.from({ length: 10 }, () => 20));
    expect(stub.opened).toHaveLength(11);
  });

  it('succeeds when the sharing violation clears within the 10 retries (EPERM and EACCES count too)', async () => {
    const stub = makeStub();
    stub.content = Uint8Array.from([1, 2, 3]);
    stub.openErrors.push(errno('EPERM'), errno('EACCES'), errno('EBUSY'));
    const data = await createFsx(stub.deps).readSmallFile('/data/state.json', 1024);
    expect([...data]).toEqual([1, 2, 3]);
    expect(stub.sleeps).toEqual([20, 20, 20]);
  });

  it('rejects a limit that is not a non-negative integer', async () => {
    const dir = workDir();
    const target = path.join(dir, 'x.txt');
    writeFileSync(target, 'x');
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readSmallFile(target, limit)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(readSmallFile(target, 0)).rejects.toMatchObject({ code: 'E_FILE_TOO_LARGE' });
  });

  it('rethrows ENOENT unchanged so callers can tell an absent file', async () => {
    const dir = workDir();
    const error = await readSmallFile(path.join(dir, 'absent'), 10).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(error).not.toBeInstanceOf(SmallFileError);
  });
});

describe('tailLines', () => {
  it('returns the last n lines of a small file', async () => {
    const dir = workDir();
    const target = path.join(dir, 'a.log');
    writeFileSync(target, 'one\ntwo\nthree\nfour\n');
    expect(await tailLines(target, 2)).toEqual(['three', 'four']);
    expect(await tailLines(target, 10)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('splits like Python: CRLF, CR, VT, FF, NEL, LS and PS', async () => {
    const dir = workDir();
    const target = path.join(dir, 'b.log');
    writeFileSync(target, `a\r\nb\rc\u000bd\u000ce\u0085f${LS}g${PS}h`);
    expect(await tailLines(target, 20)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('keeps a leading BOM as a character, like Python bytes.decode', async () => {
    const dir = workDir();
    const target = path.join(dir, 'bom.log');
    writeFileSync(target, `${BOM}START one\nline two\n`);
    expect(await tailLines(target, 5)).toEqual([`${BOM}START one`, 'line two']);
  });

  it('returns [] for an empty file, a missing file and a directory', async () => {
    const dir = workDir();
    const empty = path.join(dir, 'empty.log');
    writeFileSync(empty, '');
    mkdirSync(path.join(dir, 'folder'));
    expect(await tailLines(empty, 5)).toEqual([]);
    expect(await tailLines(path.join(dir, 'absent.log'), 5)).toEqual([]);
    expect(await tailLines(path.join(dir, 'folder'), 5)).toEqual([]);
  });

  it('reads only the last max(65536, n*400) bytes of a large file', async () => {
    const dir = workDir();
    const target = path.join(dir, 'big.log');
    const lines = Array.from({ length: 20000 }, (_, i) => `line-${String(i).padStart(6, '0')}`);
    writeFileSync(target, lines.join('\n') + '\n');
    expect(await tailLines(target, 3)).toEqual(lines.slice(-3));
    // n * 400 = 80000 > 65536: the window grows with n.
    expect(await tailLines(target, 200)).toEqual(lines.slice(-200));
  });

  it('replaces an invalid UTF-8 sequence at the cut with U+FFFD, like errors="replace"', async () => {
    const dir = workDir();
    const target = path.join(dir, 'cut.log');
    // 70000 bytes: the window starts at byte 4464, which is the second byte of a two byte character.
    writeFileSync(target, 'x' + 'é'.repeat(34999) + 'y');
    const result = await tailLines(target, 5);
    expect(result).toHaveLength(1);
    const [line] = result;
    expect(line?.charAt(0)).toBe('�');
    expect(line).toHaveLength(32769);
    expect(line?.endsWith('éy')).toBe(true);
  });

  it('maps ENOENT, EACCES, EISDIR and EPERM to an empty list and rethrows anything else', async () => {
    for (const code of ['ENOENT', 'EACCES', 'EISDIR', 'EPERM']) {
      const stub = makeStub();
      stub.openErrors.push(errno(code));
      expect(await createFsx(stub.deps).tailLines('/data/x.log', 5)).toEqual([]);
    }
    const stub = makeStub();
    stub.openErrors.push(errno('EMFILE'));
    await expect(createFsx(stub.deps).tailLines('/data/x.log', 5)).rejects.toMatchObject({ code: 'EMFILE' });
  });

  it('returns [] for a count that is not positive, without opening the file', async () => {
    const stub = makeStub();
    for (const n of [0, -1, Number.NaN]) expect(await createFsx(stub.deps).tailLines('/data/x.log', n)).toEqual([]);
    expect(stub.opened).toEqual([]);
  });

  it('never reads more than 64 MiB, however many lines are asked for', async () => {
    const stub = makeStub();
    stub.size = 300 * 1024 * 1024;
    expect(await createFsx(stub.deps).tailLines('/data/huge.log', 1_000_000_000)).toEqual([]);
    expect(stub.reads[0]).toEqual({ offset: 0, length: 64 * 1024 * 1024, position: 236 * 1024 * 1024 });
  });

  it('always closes the handle', async () => {
    const stub = makeStub();
    stub.content = new TextEncoder().encode('a\nb\n');
    await createFsx(stub.deps).tailLines('/data/x.log', 5);
    expect(stub.closed).toBe(1);
  });
});
