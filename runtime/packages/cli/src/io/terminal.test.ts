// Terminal-safe output (05 5.3 S-OUT, ADR 0046, SEC-18): every class of dangerous code point is escaped in text and in
// JSON, harmless text is left alone, and nothing else in the CLI writes to stdout or stderr.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  colorEnabled,
  printErrorLine,
  printJson,
  printLine,
  safeJsonStringify,
  sanitizeForTerminal,
} from './terminal.ts';

const cp = (code: number): string => String.fromCodePoint(code);
const escaped = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;

/** The classes of S-OUT-2, written down independently of the implementation. */
const ESCAPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 before TAB
  [0x000b, 0x001f], // C0 after LF (VT, FF, CR, ESC, ...)
  [0x007f, 0x009f], // DEL and C1
  [0x061c, 0x061c], // Arabic letter mark
  [0x200e, 0x200f], // LRM, RLM
  [0x2028, 0x2029], // LS, PS
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI
];

function mustEscape(code: number): boolean {
  return ESCAPED_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

describe('sanitizeForTerminal', () => {
  it('escapes every code point of the listed classes as a four-digit lower-case \\uXXXX', () => {
    for (const [lo, hi] of ESCAPED_RANGES) {
      for (let code = lo; code <= hi; code += 1) {
        expect(sanitizeForTerminal(cp(code)), `U+${code.toString(16)}`).toBe(escaped(code));
      }
    }
  });

  it('leaves every other BMP code point alone, including TAB and LF', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      if (mustEscape(code) || (code >= 0xd800 && code <= 0xdfff)) continue;
      const text = cp(code);
      expect(sanitizeForTerminal(text), `U+${code.toString(16)}`).toBe(text);
    }
    expect(sanitizeForTerminal('a\tb\nc')).toBe('a\tb\nc');
  });

  it('leaves astral characters and well-formed surrogate pairs alone', () => {
    for (const text of ['\u{1f600}', '\u{10000}', '\u{10ffff}', 'x\u{1f9ea}y', '\u{e0041}']) {
      expect(sanitizeForTerminal(text)).toBe(text);
    }
  });

  it('keeps ordinary text, CJK, accents, no-break space and zero-width joiner unchanged', () => {
    for (const text of [
      '',
      'hello world',
      'caf\u00e9',
      '\u4f60\u597d',
      'a\u00a0b',
      'a\u200db',
      'a\ufeffb',
      '\\u001b is text',
    ]) {
      expect(sanitizeForTerminal(text)).toBe(text);
    }
  });

  it('makes an OSC 52 clipboard write, a title change and a hyperlink inert but still readable', () => {
    const osc52 = '\u001b]52;c;aGVsbG8=\u0007';
    const title = '\u001b]0;pwned\u0007';
    const link = '\u001b]8;;http://evil.example\u001b\\click\u001b]8;;\u001b\\';
    const csi = '\u001b[2J\u001b[31mred\u001b[0m';
    expect(sanitizeForTerminal(osc52)).toBe('\\u001b]52;c;aGVsbG8=\\u0007');
    expect(sanitizeForTerminal(title)).toBe('\\u001b]0;pwned\\u0007');
    expect(sanitizeForTerminal(link)).toBe('\\u001b]8;;http://evil.example\\u001b\\click\\u001b]8;;\\u001b\\');
    expect(sanitizeForTerminal(csi)).toBe('\\u001b[2J\\u001b[31mred\\u001b[0m');
    for (const raw of [osc52, title, link, csi]) {
      expect(Array.from(sanitizeForTerminal(raw)).some((ch) => mustEscape(ch.codePointAt(0) ?? 0))).toBe(false);
    }
  });

  it('turns bidi controls into visible escapes so a spoofed command line shows its trick', () => {
    expect(sanitizeForTerminal(`rm ${cp(0x202e)}fdp.txt`)).toBe('rm \\u202efdp.txt');
    expect(sanitizeForTerminal(`${cp(0x2066)}a${cp(0x2069)}`)).toBe('\\u2066a\\u2069');
  });

  it('escapes a carriage return, so a line cannot overwrite the one before it', () => {
    expect(sanitizeForTerminal('safe\rEVIL')).toBe('safe\\u000dEVIL');
    expect(sanitizeForTerminal('a\r\nb')).toBe('a\\u000d\nb');
  });

  it('is idempotent on its own output', () => {
    const hostile = `a${cp(0x1b)}[2Jb${cp(0x9b)}c${cp(0x202e)}d${cp(0x2028)}e${cp(0x7f)}`;
    const once = sanitizeForTerminal(hostile);
    expect(sanitizeForTerminal(once)).toBe(once);
  });
});

describe('safeJsonStringify', () => {
  const classes = ESCAPED_RANGES.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i));

  it('equals JSON.stringify when nothing is dangerous, with or without indentation', () => {
    const value = { a: 1, b: ['x', null, true], c: { d: 'caf\u00e9 \u4f60\u597d \u{1f600}' }, e: 'tab\there' };
    expect(safeJsonStringify(value)).toBe(JSON.stringify(value));
    expect(safeJsonStringify(value, 2)).toBe(JSON.stringify(value, null, 2));
    expect(safeJsonStringify('x')).toBe('"x"');
    expect(safeJsonStringify(null)).toBe('null');
    expect(safeJsonStringify(5)).toBe('5');
  });

  it('leaves no raw dangerous code point in the output and parses back to the same value', () => {
    for (const code of classes) {
      const text = `a${cp(code)}b`;
      const out = safeJsonStringify({ [text]: [text] });
      for (const ch of out) expect(mustEscape(ch.codePointAt(0) ?? 0), `U+${code.toString(16)}`).toBe(false);
      expect(JSON.parse(out)).toEqual({ [text]: [text] });
    }
  });

  it('escapes DEL, C1, U+2028, U+2029 and bidi controls that JSON.stringify leaves raw', () => {
    const raw = `${cp(0x7f)}${cp(0x85)}${cp(0x9b)}${cp(0x2028)}${cp(0x2029)}${cp(0x202e)}${cp(0x2066)}${cp(0x061c)}`;
    expect(JSON.stringify(raw)).toContain(cp(0x9b));
    expect(safeJsonStringify(raw)).toBe('"\\u007f\\u0085\\u009b\\u2028\\u2029\\u202e\\u2066\\u061c"');
    expect(JSON.parse(safeJsonStringify(raw))).toBe(raw);
  });

  it('keeps C0 escapes of JSON.stringify and the pretty-printing newlines', () => {
    expect(safeJsonStringify('a\u001bb\nc\td')).toBe('"a\\u001bb\\nc\\td"');
    expect(safeJsonStringify({ a: [1] }, 2)).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  it('produces valid JSON for a hostile envelope', () => {
    const envelope = {
      schema: 'mcs.cli/1',
      ok: false,
      error: { code: 'X', message: `bad ${cp(0x1b)}]52;c;AAAA${cp(0x07)} ${cp(0x202e)}` },
      data: { label: `first prompt${cp(0x2028)}second line` },
    };
    const out = safeJsonStringify(envelope, 2);
    expect(JSON.parse(out)).toEqual(envelope);
    expect(out).not.toContain(cp(0x1b));
    expect(out).not.toContain(cp(0x2028));
  });

  it('throws a TypeError for a value that JSON cannot represent, never printing "undefined"', () => {
    expect(() => safeJsonStringify(undefined)).toThrow(TypeError);
    expect(() => safeJsonStringify(() => 1)).toThrow(TypeError);
    expect(() => safeJsonStringify(Symbol('s'))).toThrow(TypeError);
  });

  it('lets JSON.stringify fail on circular structures and bigint', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => safeJsonStringify(loop)).toThrow(TypeError);
    expect(() => safeJsonStringify(10n)).toThrow(TypeError);
  });
});

describe('the only writer of the CLI', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.stdout, 'isTTY');
    Reflect.deleteProperty(process.stderr, 'isTTY');
  });

  function spyOut(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    return { out, err };
  }

  function setTty(stream: NodeJS.WriteStream, value: boolean): void {
    Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
  }

  it('printLine writes the escaped text and one newline to stdout only', () => {
    const { out, err } = spyOut();
    printLine(`label${cp(0x1b)}[2J`);
    printLine('two\nlines');
    expect(out).toEqual(['label\\u001b[2J\n', 'two\nlines\n']);
    expect(err).toEqual([]);
  });

  it('printErrorLine writes the escaped text to stderr only', () => {
    const { out, err } = spyOut();
    printErrorLine(`ERROR: ${cp(0x9b)}bad`);
    expect(err).toEqual(['ERROR: \\u009bbad\n']);
    expect(out).toEqual([]);
  });

  it('printJson writes one safe JSON document and a newline', () => {
    const { out } = spyOut();
    printJson({ a: `x${cp(0x2028)}y` });
    printJson({ a: 1 }, 2);
    expect(out).toEqual(['{"a":"x\\u2028y"}\n', '{\n  "a": 1\n}\n']);
  });

  it('adds no colour when stdout is not a terminal', () => {
    const { out } = spyOut();
    setTty(process.stdout, false);
    printLine('plain', 'red');
    expect(out).toEqual(['plain\n']);
  });

  it('colours trusted text on a terminal, and still escapes the text inside the colour', () => {
    const { out, err } = spyOut();
    vi.stubEnv('NO_COLOR', '');
    setTty(process.stdout, true);
    setTty(process.stderr, true);
    printLine(`hostile ${cp(0x1b)}]0;title${cp(0x07)}`, 'green');
    printErrorLine('failed', 'red');
    expect(out).toEqual([`${cp(0x1b)}[32mhostile \\u001b]0;title\\u0007${cp(0x1b)}[0m\n`]);
    expect(err).toEqual([`${cp(0x1b)}[31mfailed${cp(0x1b)}[0m\n`]);
    expect(out.join('').split(cp(0x1b)).length - 1).toBe(2);
  });

  it('adds no colour when NO_COLOR is set to a non-empty value', () => {
    const { out } = spyOut();
    vi.stubEnv('NO_COLOR', '1');
    setTty(process.stdout, true);
    printLine('plain', 'bold');
    expect(out).toEqual(['plain\n']);
  });
});

describe('colorEnabled (S-OUT-4)', () => {
  it('needs a terminal and an unset or empty NO_COLOR', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '0' })).toBe(false);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
    expect(colorEnabled({ isTTY: undefined }, {})).toBe(false);
  });
});
