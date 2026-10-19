// The JSON writer (design 01 section 1.9, ADR 0003, ADR 0067): the one layout every workspace file is written in.
//
// `{ indent: 2 }` is the file layout: two spaces per level, one entry per line, empty containers inline, non-ASCII text
// kept as is. `{ compact: true }` is one line with `, ` and `: ` separators; `escapeNonAscii` writes every code unit from
// 0x7f up as a `\uXXXX` escape. `NaN` and the infinities have no JSON form and are refused.
import { formatFloat } from './number.ts';
import { JsonEncodeError, type JsonDumpOptions, type JsonDoc } from './value.ts';

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

/** The JSON text of a string, quotes included. A lone surrogate is refused, unless `escapeNonAscii` writes it as an escape. */
export function escapeJsonString(s: string, escapeNonAscii: boolean): string {
  let out = '';
  let chunk = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let replacement: string | undefined;
    if (code < 0x20 || code === 0x22 || code === 0x5c) {
      replacement = SHORT_ESCAPES.get(code) ?? hex4(code);
    } else if (escapeNonAscii) {
      if (code >= 0x7f) replacement = hex4(code);
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new JsonEncodeError('a lone surrogate cannot be written as UTF-8');
    }
    if (replacement !== undefined) {
      out += s.slice(chunk, i) + replacement;
      chunk = i + 1;
    }
  }
  return `"${out}${s.slice(chunk)}"`;
}

function floatText(x: number, forMessage: boolean): string {
  if (Number.isFinite(x)) return formatFloat(x);
  if (!forMessage) throw new JsonEncodeError('a non-finite number cannot be written as JSON');
  return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
}

interface Layout {
  readonly indent: boolean;
  readonly escapeNonAscii: boolean;
  /** Text for a message, not for a file: a non-finite float prints as a token instead of being refused. */
  readonly forMessage: boolean;
}

function write(v: JsonDoc, layout: Layout, level: number, out: string[]): void {
  switch (v.k) {
    case 'null':
      out.push('null');
      return;
    case 'bool':
      out.push(v.v ? 'true' : 'false');
      return;
    case 'str':
      out.push(escapeJsonString(v.v, layout.escapeNonAscii));
      return;
    case 'int':
      out.push(v.v.toString());
      return;
    case 'float':
      out.push(floatText(v.v, layout.forMessage));
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
        out.push(index === 0 ? inner : separator, escapeJsonString(key, layout.escapeNonAscii), ': ');
        write(item, layout, level + 1, out);
      });
      out.push(layout.indent ? `\n${'  '.repeat(level)}}` : '}');
      return;
    }
  }
}

/** The text of a document: indent 2 (no trailing newline) or the one-line form; see the module comment. */
export function dumpJson(v: JsonDoc, o: JsonDumpOptions): string {
  const layout: Layout =
    'indent' in o
      ? { indent: true, escapeNonAscii: false, forMessage: false }
      : { indent: false, escapeNonAscii: o.escapeNonAscii === true, forMessage: false };
  const out: string[] = [];
  write(v, layout, 0, out);
  return out.join('');
}

/**
 * The one-line form of a document for a message or an audit line, never for a file: the layout of
 * `dumpJson(v, { compact: true })`, except that `NaN`, `Infinity` and `-Infinity` print as those tokens instead of being
 * refused (a message must show a value the operator typed even when no file could hold it).
 */
export function messageJson(v: JsonDoc, o: { escapeNonAscii?: boolean } = {}): string {
  const out: string[] = [];
  write(v, { indent: false, escapeNonAscii: o.escapeNonAscii === true, forMessage: true }, 0, out);
  return out.join('');
}

/** The text of a workspace JSON file: the indent-2 dump plus one LF (the body of `writeJsonFile`, 01 1.2). */
export function jsonFileText(v: JsonDoc): string {
  return `${dumpJson(v, { indent: 2 })}\n`;
}
