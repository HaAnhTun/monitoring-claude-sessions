import { describe, expect, it } from 'vitest';

import { LineSplitter, type RawLine } from './line-splitter.ts';

const NEVER = (): boolean => false;
const enc = (text: string): Buffer => Buffer.from(text, 'utf8');
const texts = (lines: readonly RawLine[]): string[] => lines.map((l) => l.bytes.toString('utf8'));

function splitter(over: { from?: number; firstLineNo?: number; maxLineBytes?: number } = {}): LineSplitter {
  return new LineSplitter({ from: 0, firstLineNo: 1, maxLineBytes: 1024, ...over });
}

describe('LineSplitter', () => {
  it('cuts at every LF and keeps offsets, lengths and line numbers of the content', () => {
    const s = splitter();
    const out: RawLine[] = [];
    expect(s.push(enc('ab\ncde\nf\n'), 0, NEVER, out)).toBe(false);
    expect(out.map((l) => [l.offset, l.length, l.lineNo, l.bytes.toString('utf8')])).toEqual([
      [0, 2, 1, 'ab'],
      [3, 3, 2, 'cde'],
      [7, 1, 3, 'f'],
    ]);
    expect(s.lineStart).toBe(9);
    expect(s.nextLineNo).toBe(4);
    expect(s.pendingBytes).toBe(0);
  });

  it('holds an unterminated tail back and joins it with the next chunk', () => {
    const s = splitter();
    const out: RawLine[] = [];
    s.push(enc('one\ntw'), 100, NEVER, out);
    expect(texts(out)).toEqual(['one']);
    expect(s.lineStart).toBe(104);
    expect(s.pendingBytes).toBe(2);
    s.push(enc('o\nthree'), 106, NEVER, out);
    expect(texts(out)).toEqual(['one', 'two']);
    expect(out[1]).toMatchObject({ offset: 104, length: 3 });
    expect(s.takeUnterminated()?.toString('utf8')).toBe('three');
  });

  it('strips one trailing CR per line and counts it', () => {
    const s = splitter();
    const out: RawLine[] = [];
    s.push(enc('a\r\nb\r\r\nc\n'), 0, NEVER, out);
    expect(texts(out)).toEqual(['a', 'b\r', 'c']);
    expect(s.counters.crlfLines).toBe(2);
    expect(out.map((l) => l.length)).toEqual([1, 2, 1]);
  });

  it('strips a BOM at offset 0 only and reports the offset after it', () => {
    const s = splitter();
    const out: RawLine[] = [];
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    s.push(Buffer.concat([bom, enc('x\n'), bom, enc('y\n')]), 0, NEVER, out);
    expect(out[0]).toMatchObject({ offset: 3, length: 1, lineNo: 1 });
    expect(out[0]?.bytes.toString('utf8')).toBe('x');
    expect(out[1]?.bytes.equals(Buffer.concat([bom, enc('y')]))).toBe(true);
    expect(s.counters.bomStripped).toBe(1);
  });

  it('skips empty lines without counting them but numbers the lines after them', () => {
    const s = splitter();
    const out: RawLine[] = [];
    s.push(enc('a\n\n\r\nb\n'), 0, NEVER, out);
    expect(out.map((l) => [l.lineNo, l.bytes.toString('utf8')])).toEqual([
      [1, 'a'],
      [4, 'b'],
    ]);
    expect(s.counters.crlfLines).toBe(0);
  });

  it('counts a line that is not valid UTF-8 and still returns its bytes', () => {
    const s = splitter();
    const out: RawLine[] = [];
    s.push(Buffer.concat([Buffer.from([0xc3, 0x28, 0x0a]), enc('ok\n')]), 0, NEVER, out);
    expect(out).toHaveLength(2);
    expect(s.counters.utf8Invalid).toBe(1);
  });

  it('skips a line longer than the cap inside one chunk, counts it and continues', () => {
    const s = splitter({ maxLineBytes: 10 });
    const out: RawLine[] = [];
    s.push(enc(`ok\n${'x'.repeat(11)}\nexact-ten!\nnext\n`), 0, NEVER, out);
    expect(texts(out)).toEqual(['ok', 'exact-ten!', 'next']);
    expect(s.counters.oversized).toBe(1);
    expect(out.map((l) => l.lineNo)).toEqual([1, 3, 4]);
  });

  it('skips an oversized line that spans chunks without accumulating it', () => {
    const s = splitter({ maxLineBytes: 10 });
    const out: RawLine[] = [];
    s.push(enc('a\n' + 'x'.repeat(8)), 0, NEVER, out);
    s.push(enc('x'.repeat(8)), 10, NEVER, out);
    expect(s.pendingBytes).toBeLessThanOrEqual(10);
    s.push(enc('x'.repeat(8) + '\nb\n'), 18, NEVER, out);
    expect(texts(out)).toEqual(['a', 'b']);
    expect(s.counters.oversized).toBe(1);
    expect(s.lineStart).toBe(18 + 9 + 2);
  });

  it('does not count an oversized line before its end is seen', () => {
    const s = splitter({ maxLineBytes: 10 });
    const out: RawLine[] = [];
    s.push(enc('x'.repeat(40)), 0, NEVER, out);
    expect(s.counters.oversized).toBe(0);
    expect(s.lineStart).toBe(0);
    expect(s.takeUnterminated()).toBeNull();
  });

  it('stops after the line that makes the callback true and leaves the rest unread', () => {
    const s = splitter();
    const out: RawLine[] = [];
    let seen = 0;
    const stopped = s.push(
      enc('a\nb\nc\n'),
      0,
      () => {
        seen += 1;
        return seen === 2;
      },
      out,
    );
    expect(stopped).toBe(true);
    expect(texts(out)).toEqual(['a', 'b']);
    expect(s.lineStart).toBe(4);
    expect(s.nextLineNo).toBe(3);
  });

  it('starts from the offset and line number it is given', () => {
    const s = splitter({ from: 1000, firstLineNo: 51 });
    const out: RawLine[] = [];
    s.push(enc('a\nb\n'), 1000, NEVER, out);
    expect(out.map((l) => [l.offset, l.lineNo])).toEqual([
      [1000, 51],
      [1002, 52],
    ]);
  });

  it('never splits a multi-byte character because LF cannot occur inside one', () => {
    const text = 'a' + String.fromCodePoint(0xe9, 0x20ac, 0x1f600) + 'z';
    const bytes = enc(`${text}\n${text}\n`);
    const s = splitter();
    const out: RawLine[] = [];
    for (let i = 0; i < bytes.length; i += 3) s.push(bytes.subarray(i, i + 3), i, NEVER, out);
    expect(texts(out)).toEqual([text, text]);
    expect(s.counters.utf8Invalid).toBe(0);
  });
});
