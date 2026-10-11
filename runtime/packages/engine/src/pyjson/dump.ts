// Python `json.dumps` compatible writer (design 01 section 1.9, ADR 0003).
//
// `{ indent: 2 }` is `json.dump(indent=2, ensure_ascii=False)`, `{ compact: true }` is `json.dumps(ensure_ascii=False)`
// with the default `(', ', ': ')` separators, and `asciiOnly` switches to `ensure_ascii=True`.
import { pyFloatRepr } from './float-repr.ts';
import { PyJsonEncodeError, type PyJsonDumpOptions, type PyJsonValue } from './value.ts';

const BS = String.fromCharCode(92);
const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x22, `${BS}"`],
  [0x5c, `${BS}${BS}`],
  [0x08, `${BS}b`],
  [0x0c, `${BS}f`],
  [0x0a, `${BS}n`],
  [0x0d, `${BS}r`],
  [0x09, `${BS}t`],
]);

function hex4(unit: number): string {
  return `${BS}u${unit.toString(16).padStart(4, '0')}`;
}

/** Escape a string like Python's `encode_basestring` (`asciiOnly` false) or `encode_basestring_ascii`. */
export function escapePyString(s: string, asciiOnly: boolean): string {
  let out = '';
  let chunk = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let replacement: string | undefined;
    if (code < 0x20 || code === 0x22 || code === 0x5c) {
      replacement = SHORT_ESCAPES.get(code) ?? hex4(code);
    } else if (asciiOnly) {
      if (code >= 0x7f) replacement = hex4(code);
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new PyJsonEncodeError('a lone surrogate cannot be written as UTF-8');
    }
    if (replacement !== undefined) {
      out += s.slice(chunk, i) + replacement;
      chunk = i + 1;
    }
  }
  return `"${out}${s.slice(chunk)}"`;
}

function floatText(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Number.POSITIVE_INFINITY) return 'Infinity';
  if (x === Number.NEGATIVE_INFINITY) return '-Infinity';
  return pyFloatRepr(x);
}

interface Layout {
  readonly indent: boolean;
  readonly asciiOnly: boolean;
}

function write(v: PyJsonValue, layout: Layout, level: number, out: string[]): void {
  switch (v.k) {
    case 'null':
      out.push('null');
      return;
    case 'bool':
      out.push(v.v ? 'true' : 'false');
      return;
    case 'str':
      out.push(escapePyString(v.v, layout.asciiOnly));
      return;
    case 'int':
      out.push(v.v.toString());
      return;
    case 'float':
      out.push(floatText(v.v));
      return;
    case 'arr': {
      if (v.v.length === 0) {
        out.push('[]');
        return;
      }
      out.push('[');
      const inner = layout.indent ? `\n${'  '.repeat(level + 1)}` : '';
      const separator = layout.indent ? `,${inner}` : ', ';
      v.v.forEach((item, index) => {
        out.push(index === 0 ? inner : separator);
        write(item, layout, level + 1, out);
      });
      out.push(layout.indent ? `\n${'  '.repeat(level)}]` : ']');
      return;
    }
    case 'obj': {
      if (v.v.length === 0) {
        out.push('{}');
        return;
      }
      out.push('{');
      const inner = layout.indent ? `\n${'  '.repeat(level + 1)}` : '';
      const separator = layout.indent ? `,${inner}` : ', ';
      v.v.forEach(([key, item], index) => {
        out.push(index === 0 ? inner : separator, escapePyString(key, layout.asciiOnly), ': ');
        write(item, layout, level + 1, out);
      });
      out.push(layout.indent ? `\n${'  '.repeat(level)}}` : '}');
      return;
    }
  }
}

/** Serialize like Python: indent 2 (no trailing newline) or the compact `, ` / `: ` form; see the module comment. */
export function dumpPyJson(v: PyJsonValue, o: PyJsonDumpOptions): string {
  const layout: Layout =
    'indent' in o ? { indent: true, asciiOnly: false } : { indent: false, asciiOnly: o.asciiOnly === true };
  const out: string[] = [];
  write(v, layout, 0, out);
  return out.join('');
}

/** The text of a workspace JSON file: the indent-2 dump plus one LF (the body of `writePyJsonFile`, 01 1.2). */
export function pyJsonFileText(v: PyJsonValue): string {
  return `${dumpPyJson(v, { indent: 2 })}\n`;
}
