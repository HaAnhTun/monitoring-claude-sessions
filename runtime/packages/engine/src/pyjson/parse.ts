// Python `json.loads` compatible parser (design 01 section 1.9, ADR 0003).
//
// Differences from JSON.parse, all deliberate: the int/float distinction comes from the lexeme, integers are BigInt,
// object entries keep their order (a duplicate key keeps its first position and takes the last value, like a Python
// dict), `NaN`, `Infinity` and `-Infinity` are accepted tokens, and errors carry Python's reason texts and
// code point positions.
import type { PyJsonValue } from './value.ts';

const BS = String.fromCharCode(92);
const BOM = String.fromCharCode(0xfeff);
const REASON_VALUE = 'Expecting value';
const REASON_KEY = 'Expecting property name enclosed in double quotes';
const REASON_COLON = "Expecting ':' delimiter";
const REASON_COMMA = "Expecting ',' delimiter";
const REASON_EXTRA = 'Extra data';
const REASON_UNTERMINATED = 'Unterminated string starting at';
const REASON_CONTROL = 'Invalid control character at';
const REASON_ESCAPE = `Invalid ${BS}escape`;
const REASON_UNICODE = `Invalid ${BS}uXXXX escape`;
const REASON_SURROGATE = `Invalid ${BS}uXXXX escape (lone surrogate)`;
const REASON_BOM = 'Unexpected UTF-8 BOM (decode using utf-8-sig)';
const REASON_TRAILING_OBJECT = 'Illegal trailing comma before end of object';
const REASON_TRAILING_ARRAY = 'Illegal trailing comma before end of array';
const REASON_DEPTH = 'Maximum nesting depth exceeded';

/** Nesting limit; Python's recursive scanner fails at a similar depth (RecursionError). */
const MAX_DEPTH = 1000;

function codePointLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Python's `JSONDecodeError`: `message` is `<reason>: line L column C (char P)`, positions count code points. */
export class PyJsonSyntaxError extends Error {
  readonly reason: string;
  /** Zero-based code point offset (Python `pos`). */
  readonly pos: number;
  /** One-based line (Python `lineno`). */
  readonly line: number;
  /** One-based column in code points (Python `colno`). */
  readonly col: number;

  constructor(reason: string, text: string, unitIndex: number) {
    const prefix = text.slice(0, unitIndex);
    const pos = codePointLength(prefix);
    const lastNewline = prefix.lastIndexOf('\n');
    const line = prefix.split('\n').length;
    const col = lastNewline < 0 ? pos + 1 : codePointLength(prefix.slice(lastNewline + 1)) + 1;
    super(`${reason}: line ${String(line)} column ${String(col)} (char ${String(pos)})`);
    this.name = 'PyJsonSyntaxError';
    this.reason = reason;
    this.pos = pos;
    this.line = line;
    this.col = col;
  }
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  [BS, BS],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

class Scanner {
  private i = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  fail(reason: string, at: number): PyJsonSyntaxError {
    return new PyJsonSyntaxError(reason, this.text, at);
  }

  private skipWs(): void {
    for (;;) {
      const c = this.text[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else return;
    }
  }

  parseDocument(): PyJsonValue {
    if (this.text.startsWith(BOM)) throw this.fail(REASON_BOM, 0);
    this.skipWs();
    const value = this.scanValue(0);
    this.skipWs();
    if (this.i !== this.text.length) throw this.fail(REASON_EXTRA, this.i);
    return value;
  }

  private scanValue(depth: number): PyJsonValue {
    const text = this.text;
    const start = this.i;
    const c = text[start];
    if (c === '"') {
      this.i++;
      return { k: 'str', v: this.scanString(start) };
    }
    if (c === '{') return this.scanObject(depth + 1);
    if (c === '[') return this.scanArray(depth + 1);
    if (c === 'n' && text.startsWith('null', start)) {
      this.i += 4;
      return { k: 'null' };
    }
    if (c === 't' && text.startsWith('true', start)) {
      this.i += 4;
      return { k: 'bool', v: true };
    }
    if (c === 'f' && text.startsWith('false', start)) {
      this.i += 5;
      return { k: 'bool', v: false };
    }
    if (c === 'N' && text.startsWith('NaN', start)) {
      this.i += 3;
      return { k: 'float', v: Number.NaN };
    }
    if (c === 'I' && text.startsWith('Infinity', start)) {
      this.i += 8;
      return { k: 'float', v: Number.POSITIVE_INFINITY };
    }
    if (c === '-' && text.startsWith('-Infinity', start)) {
      this.i += 9;
      return { k: 'float', v: Number.NEGATIVE_INFINITY };
    }
    return this.scanNumber(start);
  }

  private scanNumber(start: number): PyJsonValue {
    const text = this.text;
    let i = start;
    if (text[i] === '-') i++;
    const first = text[i];
    if (first !== undefined && first >= '1' && first <= '9') {
      i++;
      while (isDigit(text[i])) i++;
    } else if (first === '0') {
      i++;
    } else {
      throw this.fail(REASON_VALUE, start);
    }
    let isFloat = false;
    if (text[i] === '.' && isDigit(text[i + 1])) {
      isFloat = true;
      i += 2;
      while (isDigit(text[i])) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      let j = i + 1;
      if (text[j] === '+' || text[j] === '-') j++;
      if (isDigit(text[j])) {
        isFloat = true;
        while (isDigit(text[j])) j++;
        i = j;
      }
    }
    const lexeme = text.slice(start, i);
    this.i = i;
    return isFloat ? { k: 'float', v: Number(lexeme) } : { k: 'int', v: BigInt(lexeme) };
  }

  /** `begin` is the index of the opening quote; `this.i` is the index after it. */
  private scanString(begin: number): string {
    const text = this.text;
    const length = text.length;
    let out = '';
    let chunk = this.i;
    for (;;) {
      if (this.i >= length) throw this.fail(REASON_UNTERMINATED, begin);
      const code = text.charCodeAt(this.i);
      if (code === 0x22) {
        out += text.slice(chunk, this.i);
        this.i++;
        return out;
      }
      if (code < 0x20) throw this.fail(REASON_CONTROL, this.i);
      if (code !== 0x5c) {
        this.i++;
        continue;
      }
      out += text.slice(chunk, this.i);
      this.i++;
      if (this.i >= length) throw this.fail(REASON_UNTERMINATED, begin);
      const esc = text[this.i];
      if (esc === 'u') {
        const unit = this.readHex4(this.i + 1);
        // CPython's scanner also refuses the escape when the text ends right after its four digits (end >= len).
        if (unit < 0 || this.i + 5 >= length) throw this.fail(REASON_UNICODE, this.i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = text[this.i + 5] === BS && text[this.i + 6] === 'u' ? this.readHex4(this.i + 7) : -1;
          if (low < 0xdc00 || low > 0xdfff) throw this.fail(REASON_SURROGATE, this.i);
          out += String.fromCharCode(unit, low);
          this.i += 11;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw this.fail(REASON_SURROGATE, this.i);
        } else {
          out += String.fromCharCode(unit);
          this.i += 5;
        }
      } else {
        const mapped = esc === undefined ? undefined : SIMPLE_ESCAPES.get(esc);
        if (mapped === undefined) throw this.fail(REASON_ESCAPE, this.i - 1);
        out += mapped;
        this.i++;
      }
      chunk = this.i;
    }
  }

  private readHex4(at: number): number {
    let value = 0;
    for (let k = 0; k < 4; k++) {
      const digit = hexValue(this.text.charCodeAt(at + k));
      if (digit < 0) return -1;
      value = value * 16 + digit;
    }
    return value;
  }

  private scanObject(depth: number): PyJsonValue {
    if (depth > MAX_DEPTH) throw this.fail(REASON_DEPTH, this.i);
    const text = this.text;
    this.i++;
    this.skipWs();
    const entries: [string, PyJsonValue][] = [];
    if (text[this.i] === '}') {
      this.i++;
      return { k: 'obj', v: entries };
    }
    if (text[this.i] !== '"') throw this.fail(REASON_KEY, this.i);
    const position = new Map<string, number>();
    for (;;) {
      const quote = this.i;
      this.i++;
      const key = this.scanString(quote);
      this.skipWs();
      if (text[this.i] !== ':') throw this.fail(REASON_COLON, this.i);
      this.i++;
      this.skipWs();
      const value = this.scanValue(depth);
      const seen = position.get(key);
      if (seen === undefined) {
        position.set(key, entries.length);
        entries.push([key, value]);
      } else {
        entries[seen] = [key, value];
      }
      this.skipWs();
      const next = text[this.i];
      if (next === '}') {
        this.i++;
        return { k: 'obj', v: entries };
      }
      if (next !== ',') throw this.fail(REASON_COMMA, this.i);
      const comma = this.i;
      this.i++;
      this.skipWs();
      if (text[this.i] !== '"') {
        if (text[this.i] === '}') throw this.fail(REASON_TRAILING_OBJECT, comma);
        throw this.fail(REASON_KEY, this.i);
      }
    }
  }

  private scanArray(depth: number): PyJsonValue {
    if (depth > MAX_DEPTH) throw this.fail(REASON_DEPTH, this.i);
    const text = this.text;
    this.i++;
    this.skipWs();
    const values: PyJsonValue[] = [];
    if (text[this.i] === ']') {
      this.i++;
      return { k: 'arr', v: values };
    }
    for (;;) {
      values.push(this.scanValue(depth));
      this.skipWs();
      const next = text[this.i];
      if (next === ']') {
        this.i++;
        return { k: 'arr', v: values };
      }
      if (next !== ',') throw this.fail(REASON_COMMA, this.i);
      const comma = this.i;
      this.i++;
      this.skipWs();
      if (text[this.i] === ']') throw this.fail(REASON_TRAILING_ARRAY, comma);
    }
  }
}

/** Parse JSON text exactly like Python's `json.loads` (plus the nesting limit and the lone-surrogate refusal of 01 1.9). */
export function parsePyJson(text: string): PyJsonValue {
  return new Scanner(text).parseDocument();
}
