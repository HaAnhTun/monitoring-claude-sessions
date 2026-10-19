// The text forms of values in messages and audit lines (design 01 section 1.9): a document on one short line and a
// quoted string. They are the forms the operator already sees in 3.x output, so they stay as they are.
import { messageJson } from './write.ts';
import type { JsonDoc } from './value.ts';

const BS = String.fromCharCode(92);
const SHORT_LIMIT = 120;
const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const REPR_SHORT: ReadonlyMap<number, string> = new Map([
  [0x09, `${BS}t`],
  [0x0a, `${BS}n`],
  [0x0d, `${BS}r`],
]);

function hexPad(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

/** A document on one line: the compact dump (non-ASCII kept), longer than 120 code points becomes the first 117 plus `...`. */
export function shortJson(v: JsonDoc): string {
  const text = messageJson(v);
  if (text.length <= SHORT_LIMIT) return text;
  const points = Array.from(text);
  return points.length <= SHORT_LIMIT ? text : `${points.slice(0, SHORT_LIMIT - 3).join('')}...`;
}

/**
 * A string in quotes for a message: single quotes unless the text holds a single quote and no double quote, and `\xNN`,
 * `\uNNNN` or `\UNNNNNNNN` for a non-printable code point. "Printable" follows this runtime's Unicode tables (control,
 * format, surrogate, private-use, unassigned and separator code points are not printable).
 */
export function quoteText(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const short = REPR_SHORT.get(code);
    if (ch === quote || ch === BS) {
      out += BS + ch;
    } else if (short !== undefined) {
      out += short;
    } else if (code >= 0x20 && code < 0x7f) {
      out += ch;
    } else if (code < 0x80 || NON_PRINTABLE.test(ch)) {
      if (code <= 0xff) out += `${BS}x${hexPad(code, 2)}`;
      else if (code <= 0xffff) out += `${BS}u${hexPad(code, 4)}`;
      else out += `${BS}U${hexPad(code, 8)}`;
    } else {
      out += ch;
    }
  }
  return `${quote}${out}${quote}`;
}
