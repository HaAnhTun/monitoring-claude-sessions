import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

import { TranscriptBuilder, useTempDirs } from '@mcs/testkit';
import { MAX_LINE_BYTES } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import { JsonlTailer, lineStartAtOrAfter, readLines, type RawLine } from './jsonl-tailer.ts';

const makeTemp = useTempDirs();
const FAR = Number.POSITIVE_INFINITY;
const MIB = 1024 * 1024;

function workDir(): string {
  const dir = join(makeTemp('tailer').path, 'work');
  mkdirSync(dir);
  return dir;
}

const rec = (n: number, pad = 0): string => JSON.stringify({ type: 'user', n, pad: 'x'.repeat(pad) });
const sizeOf = (file: string): number => statSync(file).size;
const decode = (lines: readonly RawLine[]): unknown[] =>
  lines.map((l): unknown => JSON.parse(l.bytes.toString('utf8')));

async function readAll(
  file: string,
  opts: { chunkBytes?: number; maxLineBytes?: number; accept?: boolean } = {},
): ReturnType<typeof readLines> {
  return readLines(file, 0, sizeOf(file), FAR, {
    chunkBytes: opts.chunkBytes ?? MIB,
    ...(opts.maxLineBytes === undefined ? {} : { maxLineBytes: opts.maxLineBytes }),
    acceptValidUnterminatedTail: opts.accept ?? true,
  });
}

describe('readLines', () => {
  it('T-TR-01: a torn last line is not consumed and is read exactly once when its end arrives', async () => {
    const file = join(workDir(), 't.jsonl');
    const whole = rec(2, 30);
    writeFileSync(file, `${rec(1)}\n${whole.slice(0, 20)}`);
    const first = await readAll(file);
    expect(decode(first.lines)).toEqual([{ type: 'user', n: 1, pad: '' }]);
    expect(first.nextOffset).toBe(Buffer.byteLength(rec(1)) + 1);
    expect(first.partialBytes).toBe(20);
    expect(first.eof).toBe(true);

    appendFileSync(file, `${whole.slice(20)}\n`);
    const second = await readLines(file, first.nextOffset, sizeOf(file), FAR, {
      chunkBytes: MIB,
      acceptValidUnterminatedTail: true,
    });
    expect(decode(second.lines)).toEqual([{ type: 'user', n: 2, pad: 'x'.repeat(30) }]);
    expect(second.partialBytes).toBe(0);
    expect(second.nextOffset).toBe(sizeOf(file));
  });

  it('T-TR-01: a torn line is never consumed even when it is cut inside a multi-byte character', async () => {
    const file = join(workDir(), 'mb.jsonl');
    const line = JSON.stringify({ type: 'user', text: 'a' + String.fromCodePoint(0x20ac, 0x1f600) });
    const bytes = Buffer.from(line);
    writeFileSync(file, bytes.subarray(0, bytes.length - 5));
    const first = await readAll(file, { accept: false });
    expect(first.lines).toEqual([]);
    expect(first.partialBytes).toBe(bytes.length - 5);
    appendFileSync(file, Buffer.concat([bytes.subarray(bytes.length - 5), Buffer.from('\n')]));
    const second = await readLines(file, 0, sizeOf(file), FAR, { chunkBytes: MIB, acceptValidUnterminatedTail: false });
    expect(second.lines.map((l) => l.bytes.toString('utf8'))).toEqual([line]);
  });

  it('T-TR-02: a complete object without LF is consumed (transcripts) and the later LF yields nothing', async () => {
    const file = join(workDir(), 'u.jsonl');
    writeFileSync(file, `${rec(1)}\n${rec(2)}`);
    const first = await readAll(file, { accept: true });
    expect(decode(first.lines)).toHaveLength(2);
    expect(first.nextOffset).toBe(sizeOf(file));
    expect(first.partialBytes).toBe(0);

    appendFileSync(file, '\n');
    const second = await readLines(file, first.nextOffset, sizeOf(file), FAR, {
      chunkBytes: MIB,
      acceptValidUnterminatedTail: true,
    });
    expect(second.lines).toEqual([]);
    expect(second.nextOffset).toBe(sizeOf(file));
  });

  it('T-TR-02: the spool setting never consumes an unterminated tail, even a complete object', async () => {
    const file = join(workDir(), 'spool.ndjson');
    writeFileSync(file, `${rec(1)}\n${rec(2)}`);
    const result = await readAll(file, { accept: false });
    expect(decode(result.lines)).toHaveLength(1);
    expect(result.partialBytes).toBe(Buffer.byteLength(rec(2)));
    expect(result.nextOffset).toBe(Buffer.byteLength(rec(1)) + 1);
  });

  it('T-TR-02: an unterminated tail that is not a JSON object stays unconsumed (text, array, number)', async () => {
    for (const tail of ['plain text', '[1,2]', '42', '{"type":"user"']) {
      const file = join(workDir(), `tail-${String(tail.length)}.jsonl`);
      writeFileSync(file, `${rec(1)}\n${tail}`);
      const result = await readAll(file, { accept: true });
      expect(result.lines, tail).toHaveLength(1);
      expect(result.partialBytes, tail).toBe(Buffer.byteLength(tail));
    }
  });

  it('T-TR-04: a chunk of 7 bytes over 2, 3 and 4 byte characters gives the records of a one-shot parse', async () => {
    const file = join(workDir(), 'utf8.jsonl');
    const words = [
      'caf' + String.fromCodePoint(0xe9),
      String.fromCodePoint(0x20ac, 0x20ac),
      String.fromCodePoint(0x1f600, 0x1f680),
      'plain',
    ];
    const records = words.map((w, i) => JSON.stringify({ type: 'user', i, w }));
    writeFileSync(file, records.join('\n') + '\n');
    const small = await readAll(file, { chunkBytes: 7 });
    const big = await readAll(file, { chunkBytes: MIB });
    expect(small.lines.map((l) => l.bytes.toString('utf8'))).toEqual(records);
    expect(small.lines.map((l) => [l.offset, l.length, l.lineNo])).toEqual(
      big.lines.map((l) => [l.offset, l.length, l.lineNo]),
    );
    expect(small.counters.utf8Invalid).toBe(0);
  });

  it('T-TR-05: lines of 1.3 MB and 3 MB parse with 1 MiB chunks', async () => {
    const file = join(workDir(), 'long.jsonl');
    writeFileSync(file, [rec(1), rec(2, 1_300_000), rec(3, 3_000_000), rec(4)].join('\n') + '\n');
    const result = await readAll(file);
    const parsed = decode(result.lines);
    expect(parsed).toHaveLength(4);
    expect(result.lines.map((l) => l.length > 1_000_000)).toEqual([false, true, true, false]);
    expect(result.counters.oversized).toBe(0);
  });

  it('T-TR-05: a line over the injected cap is skipped and counted and the next line parses', async () => {
    const file = join(workDir(), 'cap.jsonl');
    writeFileSync(file, [rec(1), rec(2, 1_300_000), rec(3, 3_000_000), rec(4)].join('\n') + '\n');
    const result = await readAll(file, { maxLineBytes: MIB });
    expect(decode(result.lines).map((r) => (r as { n: number }).n)).toEqual([1, 4]);
    expect(result.counters.oversized).toBe(2);
    expect(result.lines.map((l) => l.lineNo)).toEqual([1, 4]);
    expect(result.nextOffset).toBe(sizeOf(file));
  });

  it('T-TR-05: an oversized line that is still being written is skipped once, not re-read from its start on each poll', async () => {
    const file = join(workDir(), 'growing.jsonl');
    const cap = 100;
    const base = { chunkBytes: MIB, maxLineBytes: cap, acceptValidUnterminatedTail: true };
    writeFileSync(
      file,
      `${rec(1)}
${'x'.repeat(150)}`,
    );
    const first = await readLines(file, 0, sizeOf(file), FAR, base);
    expect(decode(first.lines)).toHaveLength(1);
    expect(first.skipping).toBe(true);
    expect(first.partialBytes).toBe(0);
    expect(first.nextOffset).toBe(sizeOf(file));
    expect(first.nextLineNo).toBe(2);

    appendFileSync(file, 'y'.repeat(300));
    const second = await readLines(file, first.nextOffset, sizeOf(file), FAR, {
      ...base,
      firstLineNo: first.nextLineNo,
      resumeSkip: true,
    });
    expect(second.lines).toEqual([]);
    expect(second.skipping).toBe(true);
    expect(second.nextOffset).toBe(sizeOf(file));
    expect(second.counters.oversized).toBe(0);

    appendFileSync(
      file,
      `zz
${rec(3)}
`,
    );
    const third = await readLines(file, second.nextOffset, sizeOf(file), FAR, {
      ...base,
      firstLineNo: second.nextLineNo,
      resumeSkip: true,
    });
    expect(decode(third.lines).map((r) => (r as { n: number }).n)).toEqual([3]);
    expect(third.lines.map((l) => l.lineNo)).toEqual([3]);
    expect(third.counters.oversized).toBe(1);
    expect(third.skipping).toBe(false);
    expect(third.nextOffset).toBe(sizeOf(file));
  });

  it('T-TR-05: JsonlTailer carries the skip across polls and counts the oversized line once', async () => {
    const file = join(workDir(), 'growing-tailer.jsonl');
    writeFileSync(
      file,
      `${rec(1)}
${'x'.repeat(150)}`,
    );
    const tailer = new JsonlTailer({ path: file, maxLineBytes: 100, acceptValidUnterminatedTail: true });
    const a = await tailer.poll();
    expect(a.status === 'ok' && a.lines.length).toBe(1);
    expect(tailer.state.skipping).toBe(true);
    appendFileSync(
      file,
      `${'y'.repeat(50)}
${rec(3)}
`,
    );
    const b = await tailer.poll();
    if (b.status !== 'ok') throw new Error('poll failed');
    expect(decode(b.lines).map((r) => (r as { n: number }).n)).toEqual([3]);
    expect(b.counters.oversized).toBe(1);
    expect(tailer.state.skipping).toBe(false);
    expect(tailer.state.offset).toBe(sizeOf(file));
  });

  it('T-TR-05: the production cap is the shared MAX_LINE_BYTES constant', () => {
    expect(MAX_LINE_BYTES).toBe(64 * MIB);
  });

  it('T-TR-06: CRLF and a BOM give the records of the LF file and set the counters', async () => {
    const dir = workDir();
    const b = new TranscriptBuilder({
      sessionId: '55555555-5555-4555-8555-555555555555',
      cwd: 'FIXTURE/p',
      startMs: 1_700_000_000_000,
    });
    b.user().assistant({ messageId: 'msg_fixture_1' }).user();
    const plain = join(dir, 'lf.jsonl');
    const crlf = join(dir, 'crlf.jsonl');
    b.write(plain);
    b.write(crlf, { crlf: true, bom: true });
    const a = await readAll(plain);
    const c = await readAll(crlf);
    expect(decode(c.lines)).toEqual(decode(a.lines));
    expect(c.counters).toMatchObject({ bomStripped: 1, crlfLines: 3 });
    expect(a.counters).toMatchObject({ bomStripped: 0, crlfLines: 0 });
    expect(c.lines[0]?.offset).toBe(3);
    expect(c.nextOffset).toBe(sizeOf(crlf));
  });

  it('counts a line that is not valid UTF-8 and still returns it', async () => {
    const file = join(workDir(), 'bad.jsonl');
    writeFileSync(file, Buffer.concat([Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]), Buffer.from(`${rec(1)}\n`)]));
    const result = await readAll(file);
    expect(result.lines).toHaveLength(2);
    expect(result.counters.utf8Invalid).toBe(1);
  });

  it('stops at the deadline after a whole line and reports where to resume', async () => {
    const file = join(workDir(), 'slice.jsonl');
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => rec(i)).join('\n') + '\n');
    const total: RawLine[] = [];
    let from = 0;
    let slices = 0;
    for (;;) {
      const result = await readLines(file, from, sizeOf(file), 0, {
        chunkBytes: 64,
        acceptValidUnterminatedTail: true,
      });
      slices += 1;
      expect(result.lines.length).toBeGreaterThanOrEqual(1);
      total.push(...result.lines);
      from = result.nextOffset;
      if (result.eof && from >= sizeOf(file)) break;
      expect(result.eof).toBe(false);
    }
    expect(slices).toBe(50);
    expect(decode(total).map((r) => (r as { n: number }).n)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('stops after the line that reaches the slice size, so a caller can bound the parsing it does per call', async () => {
    const file = join(workDir(), 'sliceb.jsonl');
    const one = Buffer.byteLength(rec(0)) + 1;
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => rec(i)).join('\n') + '\n');
    const result = await readLines(file, 0, sizeOf(file), FAR, {
      chunkBytes: MIB,
      acceptValidUnterminatedTail: true,
      sliceBytes: one * 3 - 1,
    });
    expect(result.lines).toHaveLength(3);
    expect(result.eof).toBe(false);
    expect(result.nextOffset).toBe(one * 3);
    await expect(
      readLines(file, 0, 10, FAR, { chunkBytes: MIB, acceptValidUnterminatedTail: true, sliceBytes: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('numbers lines from the given first line number', async () => {
    const file = join(workDir(), 'num.jsonl');
    writeFileSync(file, `${rec(1)}\n${rec(2)}\n`);
    const result = await readLines(file, 0, sizeOf(file), FAR, {
      chunkBytes: MIB,
      acceptValidUnterminatedTail: true,
      firstLineNo: 11,
    });
    expect(result.lines.map((l) => l.lineNo)).toEqual([11, 12]);
    expect(result.nextLineNo).toBe(13);
  });

  it('reads only up to `to` and treats a file shorter than `to` as the end', async () => {
    const file = join(workDir(), 'to.jsonl');
    writeFileSync(file, `${rec(1)}\n${rec(2)}\n${rec(3)}\n`);
    const one = Buffer.byteLength(rec(1)) + 1;
    const upToTwo = await readLines(file, 0, one * 2, FAR, { chunkBytes: MIB, acceptValidUnterminatedTail: true });
    expect(upToTwo.lines).toHaveLength(2);
    const beyond = await readLines(file, 0, one * 10, FAR, { chunkBytes: MIB, acceptValidUnterminatedTail: true });
    expect(beyond.lines).toHaveLength(3);
    expect(beyond.eof).toBe(true);
  });

  it('rejects a range that makes no sense', async () => {
    const file = join(workDir(), 'r.jsonl');
    writeFileSync(file, '\n');
    await expect(
      readLines(file, 5, 2, FAR, { chunkBytes: MIB, acceptValidUnterminatedTail: true }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      readLines(file, 0, 2, FAR, { chunkBytes: 0, acceptValidUnterminatedTail: true }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('lineStartAtOrAfter', () => {
  it('aligns a position forward to the start of a line (legacy _line_start)', async () => {
    const file = join(workDir(), 'ls.jsonl');
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    expect(await lineStartAtOrAfter(file, 0)).toBe(0);
    expect(await lineStartAtOrAfter(file, 5)).toBe(5);
    expect(await lineStartAtOrAfter(file, 6)).toBe(10);
    expect(await lineStartAtOrAfter(file, 4)).toBe(5);
    expect(await lineStartAtOrAfter(file, 14)).toBe(15);
    expect(await lineStartAtOrAfter(file, 15)).toBe(15);
    expect(await lineStartAtOrAfter(file, 99)).toBe(15);
  });

  it('returns the end of a file without a trailing newline', async () => {
    const file = join(workDir(), 'ls2.jsonl');
    writeFileSync(file, 'aaaa\nbbbb');
    expect(await lineStartAtOrAfter(file, 7)).toBe(9);
  });

  it('returns the position itself when the file cannot be read (legacy)', async () => {
    expect(await lineStartAtOrAfter(join(workDir(), 'absent.jsonl'), 7)).toBe(7);
  });
});

describe('JsonlTailer', () => {
  const opts = (file: string, accept = true): ConstructorParameters<typeof JsonlTailer>[0] => ({
    path: file,
    chunkBytes: MIB,
    acceptValidUnterminatedTail: accept,
  });

  it('T-TR-03: growth in random pieces gives the record set of a one-shot parse', async () => {
    const file = join(workDir(), 'grow.jsonl');
    const records = Array.from({ length: 10_000 }, (_, i) => rec(i, i % 17));
    const whole = Buffer.from(records.join('\n') + '\n');
    writeFileSync(file, '');
    // a seeded generator (the seed is printed on failure through the assertion message)
    const seed = 20_261_011;
    let state = seed;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const tailer = new JsonlTailer(opts(file));
    const got: string[] = [];
    let written = 0;
    while (written < whole.length) {
      const piece = Math.min(whole.length - written, 1 + Math.floor(next() * 4000));
      appendFileSync(file, whole.subarray(written, written + piece));
      written += piece;
      const poll = await tailer.poll();
      if (poll.status !== 'ok') throw new Error(`unexpected ${poll.status}`);
      expect(poll.reset, `seed ${String(seed)}`).toBeNull();
      for (const line of poll.lines) got.push(line.bytes.toString('utf8'));
    }
    expect(got, `seed ${String(seed)}`).toEqual(records);
    expect(tailer.state.offset).toBe(whole.length);
  });

  it('T-TR-07: truncation restarts at 0 and reports the reason', async () => {
    const file = join(workDir(), 'trunc.jsonl');
    writeFileSync(file, Array.from({ length: 20 }, (_, i) => rec(i, 10)).join('\n') + '\n');
    const tailer = new JsonlTailer(opts(file));
    const first = await tailer.poll();
    expect(first).toMatchObject({ status: 'ok', reset: null });
    truncateSync(file, 100);
    writeFileSync(file, `${rec(100)}\n${rec(101)}\n`);
    const second = await tailer.poll();
    if (second.status !== 'ok') throw new Error(second.status);
    expect(second.reset).toBe('truncated');
    expect(decode(second.lines).map((r) => (r as { n: number }).n)).toEqual([100, 101]);
    expect(tailer.state.offset).toBe(sizeOf(file));
  });

  it('T-TR-07: replace-by-rename restarts and does not read the old bytes twice', async () => {
    const file = join(workDir(), 'rename.jsonl');
    writeFileSync(file, Array.from({ length: 5 }, (_, i) => rec(i)).join('\n') + '\n');
    const tailer = new JsonlTailer(opts(file));
    await tailer.poll();
    const other = `${file}.new`;
    writeFileSync(other, Array.from({ length: 8 }, (_, i) => rec(100 + i)).join('\n') + '\n');
    renameSync(other, file);
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(poll.reset).toBe('replaced');
    expect(decode(poll.lines)).toHaveLength(8);
    const again = await tailer.poll();
    expect(again).toMatchObject({ status: 'ok', reset: null, lines: [] });
  });

  it('T-TR-07: delete and recreate with an equal size is a replacement', async () => {
    const file = join(workDir(), 'recreate.jsonl');
    const a = Array.from({ length: 6 }, (_, i) => rec(10 + i)).join('\n') + '\n';
    const b = Array.from({ length: 6 }, (_, i) => rec(50 + i)).join('\n') + '\n';
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b));
    writeFileSync(file, a);
    const tailer = new JsonlTailer(opts(file));
    await tailer.poll();
    rmSync(file);
    writeFileSync(file, b);
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(poll.reset).toBe('replaced');
    expect(decode(poll.lines).map((r) => (r as { n: number }).n)).toEqual([50, 51, 52, 53, 54, 55]);
  });

  it('T-TR-07: rewriting the same inode with another head is a replacement even when the file grows', async () => {
    const file = join(workDir(), 'rewrite.jsonl');
    writeFileSync(file, Array.from({ length: 12 }, (_, i) => rec(i, 20)).join('\n') + '\n');
    const tailer = new JsonlTailer(opts(file));
    await tailer.poll();
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.from('{"type":"zz"'), 0);
    closeSync(fd);
    appendFileSync(file, `${rec(99)}\n`);
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(poll.reset).toBe('replaced');
    expect(poll.lines.length).toBeGreaterThan(12);
  });

  it('T-TR-08: a deleted file is missing with its cursor kept, and recovers when it is appended after recreation', async () => {
    const file = join(workDir(), 'gone.jsonl');
    const original = Array.from({ length: 6 }, (_, i) => rec(i, 30)).join('\n') + '\n';
    writeFileSync(file, original);
    const tailer = new JsonlTailer(opts(file));
    await tailer.poll();
    const offset = tailer.state.offset;
    rmSync(file);
    expect(await tailer.poll()).toEqual({ status: 'missing' });
    expect(tailer.state.offset).toBe(offset);
    // the same bytes come back (a restore), then grow
    writeFileSync(file, original);
    appendFileSync(file, `${rec(77)}\n`);
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    // a recreated file normally has another inode (full re-read); a filesystem that reuses it gives the one new line
    if (poll.reset === null) {
      expect(poll.lines).toHaveLength(1);
    } else {
      expect(poll.reset).toBe('replaced');
      expect(poll.lines).toHaveLength(7);
    }
  });

  it('T-TR-08: an unreadable path reports its code and keeps the state', async () => {
    const dir = join(workDir(), 'dir.jsonl');
    mkdirSync(dir);
    const tailer = new JsonlTailer(opts(dir));
    const poll = await tailer.poll();
    expect(poll.status).toBe('unreadable');
    expect(tailer.state.offset).toBe(0);
  });

  it('keeps nothing consumed past a torn line and reports the partial byte count', async () => {
    const file = join(workDir(), 'torn.jsonl');
    writeFileSync(file, `${rec(1)}\n{"type":"us`);
    const tailer = new JsonlTailer(opts(file));
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(poll.lines).toHaveLength(1);
    expect(poll.partialBytes).toBe(11);
    expect(tailer.state.offset).toBe(Buffer.byteLength(rec(1)) + 1);
    expect(tailer.state.size).toBe(sizeOf(file));
  });

  it('extends a short head identity once the file is longer and does not mistake it for a replacement', async () => {
    const file = join(workDir(), 'short.jsonl');
    writeFileSync(file, `${rec(1)}\n`);
    const tailer = new JsonlTailer(opts(file));
    await tailer.poll();
    expect(tailer.state.identity?.headLen).toBeLessThan(256);
    appendFileSync(file, Array.from({ length: 8 }, (_, i) => rec(i + 2, 20)).join('\n') + '\n');
    const poll = await tailer.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(poll.reset).toBeNull();
    expect(poll.lines).toHaveLength(8);
    expect(tailer.state.identity?.headLen).toBe(256);
  });

  it('starts from a saved state: offset, line number and identity', async () => {
    const file = join(workDir(), 'resume.jsonl');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => rec(i, 12)).join('\n') + '\n');
    const first = new JsonlTailer(opts(file));
    await first.poll();
    const saved = first.state;
    appendFileSync(file, `${rec(10, 12)}\n`);
    const resumed = new JsonlTailer(opts(file), saved);
    const poll = await resumed.poll();
    if (poll.status !== 'ok') throw new Error(poll.status);
    expect(decode(poll.lines)).toEqual([{ type: 'user', n: 10, pad: 'x'.repeat(12) }]);
    expect(poll.lines[0]?.lineNo).toBe(11);
  });
});

describe('responsiveness (T-TR-11)', () => {
  it('importing a 100 MB file in 20 ms slices keeps the event loop free (delay under 50 ms)', async () => {
    const factor = Math.max(1, Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1);
    const file = join(workDir(), 'big.jsonl');
    const block = Buffer.from(Array.from({ length: 1000 }, (_, i) => rec(i, 1000)).join('\n') + '\n');
    const fd = openSync(file, 'w');
    for (let written = 0; written < 100 * MIB; written += block.length) writeSync(fd, block);
    closeSync(fd);
    const size = sizeOf(file);

    const delays: number[] = [];
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      delays.push(Math.max(0, now - last - 5));
      last = now;
    }, 5);

    let from = 0;
    let parsed = 0;
    while (from < size) {
      const result = await readLines(file, from, size, performance.now() + 20, {
        chunkBytes: MIB,
        acceptValidUnterminatedTail: true,
        sliceBytes: MIB,
      });
      for (const line of result.lines) {
        JSON.parse(line.bytes.toString('utf8'));
        parsed += 1;
      }
      from = result.nextOffset;
      await yieldToLoop();
    }
    clearInterval(probe);

    expect(parsed).toBeGreaterThan(90_000);
    const sorted = [...delays].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    expect(max, `max delay ${max.toFixed(1)} ms`).toBeLessThan(50 * factor);
    expect(p99, `p99 delay ${p99.toFixed(1)} ms`).toBeLessThan(25 * factor);
  }, 120_000);
});
