// Compiled Python regex: a JavaScript RegExp plus Python-style match objects (design 01 section 2.8, registry 1.9).
import { McsError } from '../errors.ts';
import { translatePyRegex } from './translate.ts';
import type { CompiledPyRegex, PyMatch, PyRegexContext, PyRegexErrorCode, TranslatedPattern } from './types.ts';

const HINTS: Readonly<Record<PyRegexErrorCode, string>> = {
  SYNTAX: 'Fix the pattern: Python itself rejects it (or it uses a construct JavaScript cannot express).',
  UNSUPPORTED_CONSTRUCT:
    'Rewrite the pattern with plain groups, classes and quantifiers; the legacy engine still accepts it.',
  UNSUPPORTED_FLAG: 'Remove the flag; only i, m, s, a and u are supported, and only at the start or as (?flags:...).',
  INEXACT_SEMANTICS:
    'Rewrite the pattern so that every iteration sets its captures, no repeated group can be empty, and a searched pattern does not switch ASCII and Unicode with (?a:...) or (?u:...).',
  JS_COMPILE: 'This is a translator defect: report the pattern shape without its text.',
};

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

function makeMatch(t: TranslatedPattern, text: string, m: RegExpExecArray): PyMatch {
  const start = codePointLength(text.slice(0, m.index));
  const matched = m[0];
  const values = (): (string | null)[] => {
    const out: (string | null)[] = [];
    for (let i = 1; i <= t.groupCount; i++) out.push(m[i] ?? null);
    return out;
  };
  return {
    start,
    end: start + codePointLength(matched),
    group(n: number): string | null {
      if (!Number.isInteger(n) || n < 0 || n > t.groupCount) throw new RangeError('no such group');
      return n === 0 ? matched : (m[n] ?? null);
    },
    groups: values,
    groupdict(): Record<string, string | null> {
      return Object.fromEntries(t.groupNames.map((name) => [name, m.groups?.[name] ?? null]));
    },
  };
}

function isSurrogatePairAt(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  const low = text.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function isMidPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const low = text.charCodeAt(index);
  const high = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
}

/**
 * Translate and compile. Throws `McsError('REGEX_UNSUPPORTED')` whose `details` hold the construct `code` and the
 * `position` in code points; the message never repeats the pattern.
 *
 * V8 13.6 can report a match that starts between the two halves of a surrogate pair when a non-sticky `v`-mode search
 * fails at the pair's first half (for example `$` on a text that ends in an astral character). Python never starts a
 * match there, so such a result is discarded and the search continues position by position with a sticky copy of the
 * same pattern, which V8 evaluates correctly at every code point boundary.
 */
export function compilePyRegex(source: string, ctx: PyRegexContext): CompiledPyRegex {
  const result = translatePyRegex(source, ctx);
  if (!result.ok) {
    const { code, message, position } = result.error;
    throw new McsError('REGEX_UNSUPPORTED', `unsupported regular expression (${code}): ${message}`, {
      hint: HINTS[code],
      details: { code, position },
    });
  }
  const t = result.value;
  const regex = new RegExp(t.jsSource, t.jsFlags);
  let sticky: RegExp | null = null;

  const scanFrom = (text: string, from: number): RegExpExecArray | null => {
    sticky ??= new RegExp(t.jsSource, `${t.jsFlags}y`);
    for (let pos = from; pos <= text.length;) {
      sticky.lastIndex = pos;
      const found = sticky.exec(text);
      if (found !== null) return found;
      pos += isSurrogatePairAt(text, pos) ? 2 : 1;
    }
    return null;
  };

  return {
    t,
    regex,
    exec(text: string): PyMatch | null {
      regex.lastIndex = 0;
      let m = regex.exec(text);
      if (m !== null && t.mode === 'search' && isMidPair(text, m.index)) m = scanFrom(text, m.index + 1);
      return m === null ? null : makeMatch(t, text, m);
    },
  };
}
