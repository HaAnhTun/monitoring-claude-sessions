import { describe, expect, it } from 'vitest';

import { Prng } from '../../test/support/prng.ts';
import { REPLAY_FRAME_BYTES } from './limits.ts';
import { ReplayBuffer, prepareReplay, replayFrames, stripTerminalQueries } from './replay.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const RESET = Buffer.from(`${ESC}[0m`, 'latin1');
const MIB = 1024 * 1024;

/** Bytes of a text made of ASCII and escape characters only. */
const raw = (text: string): Buffer => Buffer.from(text, 'latin1');
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

/** Time budgets stretch on a loaded machine: QA_TIME_SCALE (1 to 5, the factor of the QA time helper), default 1. */
function scaled(ms: number): number {
  const factor = Number(process.env['QA_TIME_SCALE'] ?? '1');
  return ms * (Number.isFinite(factor) ? Math.min(5, Math.max(1, factor)) : 1);
}

const CONTINUATION = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

// ---- ReplayBuffer -----------------------------------------------------------------------------------------------

describe('TC-UNIT-02 ReplayBuffer', () => {
  it('starts empty', () => {
    const buffer = new ReplayBuffer(100);
    expect(buffer.size).toBe(0);
    expect(buffer.trimmed).toBe(false);
    expect(buffer.snapshot().length).toBe(0);
  });

  it('keeps everything up to the exact capacity, without trimming', () => {
    const buffer = new ReplayBuffer(10);
    buffer.append(raw('abcde'));
    buffer.append(raw('fghij'));
    expect(buffer.size).toBe(10);
    expect(buffer.trimmed).toBe(false);
    expect(buffer.snapshot().toString('latin1')).toBe('abcdefghij');
  });

  it('drops whole oldest chunks while the size is over the capacity', () => {
    const buffer = new ReplayBuffer(10);
    buffer.append(raw('aaaa'));
    buffer.append(raw('bbbb'));
    buffer.append(raw('cccc'));
    expect(buffer.trimmed).toBe(true);
    expect(buffer.size).toBe(8);
    expect(buffer.snapshot().toString('latin1')).toBe('bbbbcccc');
  });

  it('drops several chunks at once when one large chunk arrives', () => {
    const buffer = new ReplayBuffer(10);
    for (const c of ['a', 'b', 'c', 'd']) buffer.append(raw(c.repeat(2)));
    buffer.append(raw('XXXXXXXXX'));
    expect(buffer.snapshot().toString('latin1')).toBe('XXXXXXXXX');
    expect(buffer.size).toBe(9);
  });

  it('a chunk larger than the capacity keeps its tail', () => {
    const buffer = new ReplayBuffer(8);
    buffer.append(raw('old'));
    buffer.append(raw('0123456789abcdefghij'));
    expect(buffer.trimmed).toBe(true);
    expect(buffer.size).toBe(8);
    expect(buffer.snapshot().toString('latin1')).toBe('cdefghij');
  });

  it('the tail of a large chunk starts on a UTF-8 start byte', () => {
    const buffer = new ReplayBuffer(8);
    // bytes 0..4 ASCII, then four three-byte euro signs at 5, 8, 11 and 14; the cut at byte 9 lands inside the second
    buffer.append(utf8(`xxxxx${'\u20ac'.repeat(4)}`));
    const snapshot = buffer.snapshot();
    expect(snapshot.toString('utf8')).toBe('\u20ac\u20ac');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(snapshot)).toBe('\u20ac\u20ac');
    expect(buffer.size).toBe(6);
  });

  it('after dropping chunks the new first byte is a start byte, even when a character was split across chunks', () => {
    const euro = utf8('\u20ac');
    const buffer = new ReplayBuffer(6);
    buffer.append(euro.subarray(0, 2)); // E2 82
    buffer.append(Buffer.concat([euro.subarray(2), raw('ab')])); // AC a b
    buffer.append(raw('cd')); // 7 bytes: the first chunk goes, and the next one starts with the stray AC
    expect(buffer.trimmed).toBe(true);
    expect(buffer.snapshot().toString('latin1')).toBe('abcd');
    expect(buffer.size).toBe(4);
  });

  it('never skips more than the three continuation bytes of one character', () => {
    const buffer = new ReplayBuffer(8);
    buffer.append(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]));
    expect(buffer.size).toBe(5);
  });

  it('copies what it is given and what it hands out', () => {
    const buffer = new ReplayBuffer(100);
    const chunk = raw('hello');
    buffer.append(chunk);
    chunk.fill(0x78);
    const first = buffer.snapshot();
    first.fill(0x79);
    expect(buffer.snapshot().toString('latin1')).toBe('hello');
  });

  it('takes any Uint8Array and ignores an empty chunk', () => {
    const buffer = new ReplayBuffer(100);
    buffer.append(new Uint8Array([0x61, 0x62]));
    buffer.append(new Uint8Array(0));
    buffer.append(Buffer.alloc(0));
    expect(buffer.snapshot().toString('latin1')).toBe('ab');
    expect(buffer.size).toBe(2);
  });

  it('a view into a larger Buffer copies only its own bytes', () => {
    const pool = raw('0123456789');
    const buffer = new ReplayBuffer(100);
    buffer.append(pool.subarray(3, 6));
    expect(buffer.snapshot().toString('latin1')).toBe('345');
  });

  it('stays trimmed once it trimmed, and clear() releases everything', () => {
    const buffer = new ReplayBuffer(4);
    buffer.append(raw('abc'));
    buffer.append(raw('def'));
    expect(buffer.trimmed).toBe(true);
    buffer.append(raw('g'));
    expect(buffer.trimmed).toBe(true);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.trimmed).toBe(false);
    expect(buffer.snapshot().length).toBe(0);
    buffer.append(raw('xy'));
    expect(buffer.snapshot().toString('latin1')).toBe('xy');
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses the capacity %s', (capacity) => {
    expect(() => new ReplayBuffer(capacity)).toThrow(RangeError);
  });

  it('holds at most the capacity under three times that much output (the 1 MiB cap of a session)', () => {
    const buffer = new ReplayBuffer(MIB);
    const piece = Buffer.alloc(8192, 0x61);
    for (let i = 0; i < (3 * MIB) / piece.length; i += 1) buffer.append(piece);
    expect(buffer.size).toBeLessThanOrEqual(MIB);
    expect(buffer.size).toBeGreaterThan(MIB - piece.length);
    expect(buffer.snapshot().length).toBe(buffer.size);
    expect(buffer.trimmed).toBe(true);
  });

  const TEXT_POOL = ['a', 'b', ' ', '\n', '\u00e9', '\u1ef1', '\u20ac', '\u65e5', '\u{1f600}', '\u001b[0m'];

  function randomStream(prng: Pick<Prng, 'range' | 'pick'>, chars: number): { bytes: Buffer; chars: string[] } {
    const list: string[] = [];
    for (let i = 0; i < chars; i += 1) list.push(prng.pick(TEXT_POOL));
    return { bytes: utf8(list.join('')), chars: list };
  }

  it('property: any byte chunking keeps the capacity, a suffix of the stream and a start byte at the head', () => {
    const prng = new Prng(14_002);
    for (let round = 0; round < 250; round += 1) {
      const capacity = prng.range(64, 2048);
      const maxChunk = prng.range(1, 400);
      const { bytes } = randomStream(prng, prng.range(0, 3000));
      const buffer = new ReplayBuffer(capacity);
      const label = `seed ${String(prng.seed)} round ${String(round)} capacity ${String(capacity)} chunk<=${String(maxChunk)}`;
      let fed = 0;
      let largest = 0;
      while (fed < bytes.length) {
        const size = Math.min(prng.range(1, maxChunk), bytes.length - fed);
        buffer.append(bytes.subarray(fed, fed + size));
        fed += size;
        largest = Math.max(largest, size);
        const snapshot = buffer.snapshot();
        expect(buffer.size, label).toBe(snapshot.length);
        expect(snapshot.length, label).toBeLessThanOrEqual(capacity);
        expect(bytes.subarray(fed - snapshot.length, fed).equals(snapshot), label).toBe(true);
        expect(buffer.trimmed, label).toBe(fed > capacity);
        if (buffer.trimmed) {
          expect(snapshot.length, label).toBeGreaterThanOrEqual(capacity - largest - 3);
          expect(CONTINUATION(snapshot[0]), label).toBe(false);
        }
      }
    }
  });

  it('property: with chunks that end on character boundaries the whole snapshot is valid UTF-8 after a trim', () => {
    const prng = new Prng(14_003);
    const strict = new TextDecoder('utf-8', { fatal: true });
    for (let round = 0; round < 250; round += 1) {
      const capacity = prng.range(16, 1024);
      const { bytes, chars } = randomStream(prng, prng.range(0, 1500));
      const buffer = new ReplayBuffer(capacity);
      const label = `seed ${String(prng.seed)} round ${String(round)} capacity ${String(capacity)}`;
      let index = 0;
      let fed = 0;
      while (index < chars.length) {
        const count = prng.range(1, 12);
        const text = chars.slice(index, index + count).join('');
        index += count;
        const chunk = utf8(text);
        buffer.append(chunk);
        fed += chunk.length;
        const snapshot = buffer.snapshot();
        expect(() => strict.decode(snapshot), label).not.toThrow();
        expect(bytes.subarray(fed - snapshot.length, fed).equals(snapshot), label).toBe(true);
      }
    }
  });
});

// ---- prepareReplay ----------------------------------------------------------------------------------------------

describe('TC-UNIT-02 prepareReplay', () => {
  it('leaves a snapshot that was never trimmed as it is', () => {
    const snapshot = utf8('first line\nsecond line\u001b[1mbold\u001b[0m');
    expect(prepareReplay(snapshot, false).equals(snapshot)).toBe(true);
  });

  it('after a trim restarts just after the first line feed and resets the colour first', () => {
    const out = prepareReplay(raw('cut off run\nfull line\nnext\n'), true);
    expect(out.equals(Buffer.concat([RESET, raw('full line\nnext\n')]))).toBe(true);
  });

  it('looks for the line feed only in the first 4 KiB', () => {
    const inside = Buffer.concat([Buffer.alloc(4095, 0x61), raw('\ntail')]);
    expect(prepareReplay(inside, true).equals(Buffer.concat([RESET, raw('tail')]))).toBe(true);
    const outside = Buffer.concat([Buffer.alloc(4096, 0x61), raw('\ntail')]);
    expect(prepareReplay(outside, true).equals(Buffer.concat([RESET, outside]))).toBe(true);
  });

  it('keeps a trimmed snapshot without any line feed as it is, after the colour reset', () => {
    const out = prepareReplay(raw('no line feed here'), true);
    expect(out.equals(Buffer.concat([RESET, raw('no line feed here')]))).toBe(true);
  });

  it('a trimmed snapshot whose only line feed is its last byte leaves just the reset', () => {
    expect(prepareReplay(raw('partial\n'), true).equals(RESET)).toBe(true);
  });

  it('an empty snapshot stays empty when it was not trimmed', () => {
    expect(prepareReplay(Buffer.alloc(0), false).length).toBe(0);
  });

  it('removes terminal queries, and after the skip of a trimmed head', () => {
    const snapshot = raw(`${ESC}[6n half\nline one${ESC}[c${ESC}]11;?${BEL}\nline two`);
    expect(prepareReplay(snapshot, false).toString('latin1')).toBe(' half\nline one\nline two');
    expect(prepareReplay(snapshot, true).toString('latin1')).toBe(`${ESC}[0mline one\nline two`);
  });

  it('keeps the colour sequences that follow the skipped line', () => {
    const snapshot = raw(`${ESC}[31mred cut\n${ESC}[32mgreen${ESC}[0m\n`);
    expect(prepareReplay(snapshot, true).toString('latin1')).toBe(`${ESC}[0m${ESC}[32mgreen${ESC}[0m\n`);
  });

  it('does not change its input', () => {
    const snapshot = raw(`abc\n${ESC}[6ndef`);
    const before = Buffer.from(snapshot);
    prepareReplay(snapshot, true);
    prepareReplay(snapshot, false);
    expect(snapshot.equals(before)).toBe(true);
  });
});

// ---- stripTerminalQueries ---------------------------------------------------------------------------------------

/** One row per query form of design 01 section 3.8 (the parameters are generic, so a few spellings each). */
const QUERIES: readonly (readonly [string, string])[] = [
  ['DA1', `${ESC}[c`],
  ['DA1 with a parameter', `${ESC}[0c`],
  ['DA2', `${ESC}[>c`],
  ['DA2 with a parameter', `${ESC}[>0c`],
  ['DA2 with parameters', `${ESC}[>1;2c`],
  ['DA3', `${ESC}[=c`],
  ['DA3 with a parameter', `${ESC}[=0c`],
  ['DSR 5 (status)', `${ESC}[5n`],
  ['DSR 6 (cursor position)', `${ESC}[6n`],
  ['DSR 6 with a leading zero', `${ESC}[06n`],
  ['DEC DSR 6', `${ESC}[?6n`],
  ['DEC DSR 15', `${ESC}[?15n`],
  ['DEC DSR 25', `${ESC}[?25n`],
  ['DEC DSR 996 (colour scheme)', `${ESC}[?996n`],
  ['DECRQM private 2004', `${ESC}[?2004$p`],
  ['DECRQM private 1049', `${ESC}[?1049$p`],
  ['DECRQM ANSI 2', `${ESC}[2$p`],
  ['DECRQM ANSI 4', `${ESC}[4$p`],
  ['kitty keyboard flags', `${ESC}[?u`],
  ['XTVERSION', `${ESC}[>q`],
  ['XTVERSION with a parameter', `${ESC}[>0q`],
  ['window report 11', `${ESC}[11t`],
  ['window report 13', `${ESC}[13t`],
  ['window report 14', `${ESC}[14t`],
  ['window report 15', `${ESC}[15t`],
  ['window report 16', `${ESC}[16t`],
  ['window report 18', `${ESC}[18t`],
  ['window report 19', `${ESC}[19t`],
  ['window report 20', `${ESC}[20t`],
  ['window report 21', `${ESC}[21t`],
  ['window report 13 with a parameter', `${ESC}[13;2t`],
  ['window report 14 with a parameter', `${ESC}[14;2t`],
  ['OSC 10 query, BEL', `${ESC}]10;?${BEL}`],
  ['OSC 10 query, ST', `${ESC}]10;?${ST}`],
  ['OSC 11 query, BEL', `${ESC}]11;?${BEL}`],
  ['OSC 12 query, ST', `${ESC}]12;?${ST}`],
  ['OSC 17 query', `${ESC}]17;?${BEL}`],
  ['OSC 19 query', `${ESC}]19;?${BEL}`],
  ['OSC 4 query, BEL', `${ESC}]4;1;?${BEL}`],
  ['OSC 4 query, ST', `${ESC}]4;255;?${ST}`],
  ['OSC 4 with two colours', `${ESC}]4;1;?;2;?${BEL}`],
  ['OSC 52 clipboard query', `${ESC}]52;c;?${BEL}`],
  ['DECRQSS for SGR', `${ESC}P$qm${ST}`],
  ['DECRQSS for DECSCA', `${ESC}P$q"q${ST}`],
  ['DECRQSS for DECSCUSR', `${ESC}P$q q${ST}`],
  ['DECRQSS for DECSTBM', `${ESC}P$qr${ST}`],
];

/** Sequences that set state or draw, and replies that look like queries to a careless filter: all of them are kept. */
const KEPT: readonly (readonly [string, string])[] = [
  ['SGR reset', `${ESC}[0m`],
  ['SGR without a parameter', `${ESC}[m`],
  ['SGR bold red', `${ESC}[1;31m`],
  ['SGR true colour', `${ESC}[38;2;1;2;3m`],
  ['SGR true colour with colons', `${ESC}[38:2::1:2:3m`],
  ['SGR 256 colours', `${ESC}[48;5;200m`],
  ['cursor position', `${ESC}[10;20H`],
  ['erase display', `${ESC}[2J`],
  ['erase line', `${ESC}[K`],
  ['cursor up', `${ESC}[3A`],
  ['scroll region', `${ESC}[1;30r`],
  ['save cursor', `${ESC}[s`],
  ['restore cursor', `${ESC}[u`],
  ['bracketed paste on', `${ESC}[?2004h`],
  ['bracketed paste off', `${ESC}[?2004l`],
  ['alternate screen', `${ESC}[?1049h`],
  ['hide cursor', `${ESC}[?25l`],
  ['wrap on', `${ESC}[?7h`],
  ['a DA1 reply', `${ESC}[?1;2c`],
  ['kitty keyboard push', `${ESC}[>1u`],
  ['kitty keyboard pop', `${ESC}[<u`],
  ['kitty keyboard set', `${ESC}[=5u`],
  ['kitty keyboard reply', `${ESC}[?1u`],
  ['cursor style 0', `${ESC}[0 q`],
  ['cursor style 2', `${ESC}[2 q`],
  ['modifyOtherKeys', `${ESC}[>4;2m`],
  ['modifyOtherKeys reset', `${ESC}[>4n`],
  ['a DSR OK reply', `${ESC}[0n`],
  ['a DSR not-OK reply', `${ESC}[3n`],
  ['a cursor position reply', `${ESC}[12;40R`],
  ['push the title', `${ESC}[22;0;0t`],
  ['pop the title', `${ESC}[23;0;0t`],
  ['resize the window', `${ESC}[8;30;120t`],
  ['window operation 1', `${ESC}[1t`],
  ['window operation 10', `${ESC}[10t`],
  ['window operation 12', `${ESC}[12t`],
  ['window operation 17', `${ESC}[17t`],
  ['window operation 22', `${ESC}[22t`],
  ['title, BEL', `${ESC}]0;title${BEL}`],
  ['title, ST', `${ESC}]2;a title${ST}`],
  ['a title that is a question mark', `${ESC}]0;?${BEL}`],
  ['icon name that is a question mark', `${ESC}]1;?${BEL}`],
  ['set the background colour', `${ESC}]11;rgb:00/00/00${BEL}`],
  ['set the foreground colour', `${ESC}]10;#ffffff${ST}`],
  ['set the cursor colour by name', `${ESC}]12;red${BEL}`],
  ['set a palette colour', `${ESC}]4;1;rgb:ff/00/00${BEL}`],
  ['a hyperlink whose address ends in a question mark', `${ESC}]8;;http://example.test/a?${BEL}`],
  ['a hyperlink end', `${ESC}]8;;${BEL}`],
  ['a shell integration mark', `${ESC}]133;A${BEL}`],
  ['reset the palette', `${ESC}]104${BEL}`],
  ['reset one palette colour', `${ESC}]104;1${BEL}`],
  ['a clipboard write', `${ESC}]52;c;SGVsbG8=${BEL}`],
  ['sixel graphics', `${ESC}Pq#0;2;0;0;0${ST}`],
  ['a DECRQSS reply', `${ESC}P1$r0m${ST}`],
  ['save cursor (ESC 7)', `${ESC}7`],
  ['restore cursor (ESC 8)', `${ESC}8`],
  ['keypad application mode', `${ESC}=`],
  ['keypad numeric mode', `${ESC}>`],
  ['reverse index', `${ESC}M`],
  ['charset', `${ESC}(B`],
  ['a lone string terminator', `${ESC}\\`],
];

describe('TC-UNIT-02 stripTerminalQueries: every query form is removed', () => {
  it.each(QUERIES)('%s', (_label, sequence) => {
    expect(stripTerminalQueries(raw(`A${sequence}B`)).toString('latin1')).toBe('AB');
    expect(stripTerminalQueries(raw(sequence)).length).toBe(0);
    expect(stripTerminalQueries(raw(`${sequence}${sequence}`)).length).toBe(0);
  });

  it('removes queries next to each other and spread through ordinary output', () => {
    const input = raw(`one${ESC}[c${ESC}[>q${ESC}[6ntwo${ESC}]10;?${BEL}${ESC}]11;?${ST}three${ESC}P$qm${ST}`);
    expect(stripTerminalQueries(input).toString('latin1')).toBe('onetwothree');
  });

  it('works on a query at the very start and at the very end', () => {
    expect(stripTerminalQueries(raw(`${ESC}[6nabc`)).toString('latin1')).toBe('abc');
    expect(stripTerminalQueries(raw(`abc${ESC}[6n`)).toString('latin1')).toBe('abc');
  });
});

describe('TC-UNIT-02 stripTerminalQueries: every control that sets state or draws is kept', () => {
  it.each(KEPT)('%s', (_label, sequence) => {
    const input = raw(`A${sequence}B`);
    expect(stripTerminalQueries(input).toString('latin1')).toBe(`A${sequence}B`);
    expect(stripTerminalQueries(raw(sequence)).toString('latin1')).toBe(sequence);
  });
});

describe('TC-UNIT-02 stripTerminalQueries: partial and broken sequences', () => {
  it.each([
    ['an unterminated CSI', `A${ESC}[`, `A${ESC}[`],
    ['a CSI without its final byte', `A${ESC}[6`, `A${ESC}[6`],
    ['a CSI with parameters and no final byte', `A${ESC}[1;2`, `A${ESC}[1;2`],
    ['a lone ESC at the end', `A${ESC}`, `A${ESC}`],
    ['an unterminated OSC query', `A${ESC}]10;?`, `A${ESC}]10;?`],
    ['an OSC query cut right before its ST', `A${ESC}]10;?${ESC}`, `A${ESC}]10;?${ESC}`],
    ['an unterminated DECRQSS', `A${ESC}P$qm`, `A${ESC}P$qm`],
    ['a DECRQSS cut right before its ST', `A${ESC}P$qm${ESC}`, `A${ESC}P$qm${ESC}`],
    ['a CSI interrupted by a control character', `A${ESC}[6\nnB`, `A${ESC}[6\nnB`],
    ['a CSI with a parameter byte after an intermediate byte', `A${ESC}[1$2pB`, `A${ESC}[1$2pB`],
    ['a CSI broken by a new ESC, then a real query', `${ESC}[${ESC}[6n`, `${ESC}[`],
    ['an OSC aborted by a new sequence, then a real query', `${ESC}]10;?${ESC}[6n`, `${ESC}]10;?`],
    ['a DECRQSS aborted by a new sequence, then a real query', `${ESC}P$qm${ESC}[6n`, `${ESC}P$qm`],
    ['a doubled ESC before a query', `${ESC}${ESC}[6n`, ESC],
    ['an ST that closes nothing', `a${ESC}\\b`, `a${ESC}\\b`],
    ['a BEL that closes an OSC, then text that looks like a query', `${ESC}]0;a${BEL}]10;?`, `${ESC}]0;a${BEL}]10;?`],
    ['no escape at all', 'plain text 123 ?c 6n', 'plain text 123 ?c 6n'],
    ['nothing', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(stripTerminalQueries(raw(input)).toString('latin1')).toBe(expected);
  });

  it('leaves bytes above 0x7f alone: Vietnamese letters, an emoji and a stray continuation byte', () => {
    const input = Buffer.concat([
      utf8('D\u1ef1 \u00e1n \u{1f600} b\u00e0i'),
      Buffer.from([0x80, 0xff, 0xc3]),
      raw(`${ESC}[1m`),
    ]);
    expect(stripTerminalQueries(input).equals(input)).toBe(true);
    const mixed = Buffer.concat([utf8('D\u1ef1 '), raw(`${ESC}[6n`), utf8('\u00e1n')]);
    expect(stripTerminalQueries(mixed).toString('utf8')).toBe('D\u1ef1 \u00e1n');
  });

  it('does not change its input', () => {
    const input = raw(`a${ESC}[6nb${ESC}[1mc`);
    const before = Buffer.from(input);
    stripTerminalQueries(input);
    expect(input.equals(before)).toBe(true);
  });

  it('returns the bytes unchanged when there is nothing to remove', () => {
    const input = raw(`plain ${ESC}[31mred${ESC}[0m\r\n`);
    expect(stripTerminalQueries(input).equals(input)).toBe(true);
  });

  it('property: random output with queries mixed in comes back with exactly the queries removed', () => {
    const prng = new Prng(14_006);
    const text: Buffer[] = [
      'hello',
      ' ',
      '\n',
      '\r\n',
      'x'.repeat(40),
      '\t',
      'D\u1ef1 \u00e1n',
      '\u{1f600}',
      '123;?',
    ].map(utf8);
    for (let round = 0; round < 300; round += 1) {
      const parts: Buffer[] = [];
      const expected: Buffer[] = [];
      for (let k = prng.range(0, 40); k > 0; k -= 1) {
        const kind = prng.int(3);
        if (kind === 0) {
          const piece = prng.pick(text);
          parts.push(piece);
          expected.push(piece);
        } else if (kind === 1) {
          const piece = raw(prng.pick(KEPT)[1]);
          parts.push(piece);
          expected.push(piece);
        } else {
          parts.push(raw(prng.pick(QUERIES)[1]));
        }
      }
      const out = stripTerminalQueries(Buffer.concat(parts));
      expect(out.equals(Buffer.concat(expected)), `seed ${String(prng.seed)} round ${String(round)}`).toBe(true);
    }
  });
});

describe('TC-UNIT-02 stripTerminalQueries: adversarial input of 1 MiB stays inside a coarse budget', () => {
  const fill = (unit: string, bytes = MIB): Buffer =>
    raw(unit.repeat(Math.ceil(bytes / unit.length))).subarray(0, bytes);
  const noQuery: readonly (readonly [string, Buffer])[] = [
    ['ESC [ repeated', fill(`${ESC}[`)],
    ['ESC ] repeated', fill(`${ESC}]`)],
    ['ESC P repeated', fill(`${ESC}P`)],
    ['ESC ESC repeated', fill(`${ESC}${ESC}`)],
    ['ESC [ 1 repeated', fill(`${ESC}[1`)],
    ['one unterminated OSC query with a 1 MiB payload', Buffer.concat([raw(`${ESC}]10;?`), fill('a', MIB - 6)])],
    ['an unterminated OSC full of ESC bytes', fill(`${ESC}]10;?${ESC}`)],
    ['one CSI with a million parameter bytes and no final byte', Buffer.concat([raw(`${ESC}[`), fill('1;', MIB - 2)])],
    ['one unterminated DECRQSS with a 1 MiB body', Buffer.concat([raw(`${ESC}P$q`), fill('m', MIB - 4)])],
    ['an unterminated DCS full of ESC P', fill(`${ESC}P$qm${ESC}P`)],
    ['sixel-like DCS strings', fill(`${ESC}Pq#0;2;0;0;0${ST}`)],
    ['colour sequences and text', fill(`${ESC}[38;2;255;0;0mx${ESC}[0m`)],
    ['text without any ESC', fill('the quick brown fox \u00e1 ')],
  ];

  it.each(noQuery)('%s: unchanged, fast', (_label, input) => {
    expect(input.length).toBe(MIB);
    const before = Buffer.from(input);
    const started = performance.now();
    const out = stripTerminalQueries(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(scaled(2000));
    expect(out.equals(before)).toBe(true);
    expect(input.equals(before)).toBe(true);
  });

  it('1 MiB of real queries is removed completely and fast', () => {
    const input = fill(`${ESC}[6n`);
    const started = performance.now();
    const out = stripTerminalQueries(input);
    expect(performance.now() - started).toBeLessThan(scaled(2000));
    expect(out.length).toBe(0);
  });

  it('1 MiB of queries and OSC strings in a mix is removed completely and fast', () => {
    const unit = `${ESC}]11;?${BEL}${ESC}[c${ESC}P$qm${ST}${ESC}[?u`;
    const input = fill(unit, Math.floor(MIB / unit.length) * unit.length);
    const started = performance.now();
    const out = stripTerminalQueries(input);
    expect(performance.now() - started).toBeLessThan(scaled(2000));
    expect(out.length).toBe(0);
  });

  it('prepareReplay on a full 1 MiB snapshot is inside the same budget', () => {
    const input = fill(`${ESC}[6n some text\n`);
    const started = performance.now();
    const out = prepareReplay(input, true);
    expect(performance.now() - started).toBeLessThan(scaled(2000));
    expect(out.toString('latin1').startsWith(`${ESC}[0m some text\n`)).toBe(true);
    expect(out.includes(raw(`${ESC}[6n`))).toBe(false);
  });
});

// ---- replayFrames -----------------------------------------------------------------------------------------------

describe('TC-UNIT-02 replayFrames', () => {
  it('cuts at 65536 bytes by default and the frames add up to the input', () => {
    const input = Buffer.alloc(150_000, 0x61);
    for (let i = 0; i < input.length; i += 1) input[i] = i % 251;
    const frames = [...replayFrames(input)];
    expect(frames.map((f) => f.length)).toEqual([65_536, 65_536, 18_928]);
    expect(Buffer.concat(frames).equals(input)).toBe(true);
    expect(REPLAY_FRAME_BYTES).toBe(65_536);
  });

  it('an exact multiple has no empty last frame, and nothing gives no frame at all', () => {
    expect([...replayFrames(Buffer.alloc(131_072))].map((f) => f.length)).toEqual([65_536, 65_536]);
    expect([...replayFrames(Buffer.alloc(65_536))].map((f) => f.length)).toEqual([65_536]);
    expect([...replayFrames(Buffer.alloc(1))].map((f) => f.length)).toEqual([1]);
    expect([...replayFrames(Buffer.alloc(0))]).toEqual([]);
  });

  it('takes a smaller frame size', () => {
    const frames = [...replayFrames(raw('abcdefghij'), 4)];
    expect(frames.map((f) => f.toString('latin1'))).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never exceeds 65536 bytes, whatever size is asked for', () => {
    const frames = [...replayFrames(Buffer.alloc(300_000), 10 * MIB)];
    expect(frames.length).toBe(5);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(65_536);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses the frame size %s', (size) => {
    expect(() => [...replayFrames(raw('abc'), size)]).toThrow(RangeError);
  });

  it('a full 1 MiB replay goes out in frames that are all within the bound', () => {
    const buffer = new ReplayBuffer(MIB);
    const piece = Buffer.alloc(8192, 0x61);
    for (let i = 0; i < 400; i += 1) buffer.append(piece);
    const out = prepareReplay(buffer.snapshot(), buffer.trimmed);
    const frames = [...replayFrames(out)];
    expect(frames.length).toBeGreaterThanOrEqual(16);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(REPLAY_FRAME_BYTES);
    expect(frames.reduce((n, f) => n + f.length, 0)).toBe(out.length);
    expect(out.length).toBeLessThanOrEqual(MIB + RESET.length);
  });
});
