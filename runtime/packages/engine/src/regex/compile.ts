// The one compiler of the configuration patterns (ADR 0067, design 01 section 2.8). A pattern is a JavaScript regular
// expression source, compiled with the flag `v` always, `s` for a session rule (a dot matches a line break; the rule is
// searched) and `y` for attempts (the match starts at position 0; `lastIndex` is reset on every call). There is no flags
// key and no inline modifier group: `(?i:...)` is refused on every Node version, because V8 13.6 accepts it and Node 22
// does not, and a configuration must behave the same on every supported Node.
//
// Errors never contain the pattern text: the reason is the V8 message without its `/source/flags: ` prefix.
import type { CompiledRegex, RegexContext, RegexMatch } from './types.ts';

/** Appended to a refusal of a pattern that uses a Python-only construct. */
export const PYTHON_SYNTAX_HINT =
  'this looks like Python regex syntax; run `mcs migrate-workspace --task <slug>` (dry run first)';

const MODIFIER_REASON =
  'inline modifier groups such as (?i:...) are not supported; write the letter variants with classes';
const GENERIC_REASON = 'not a valid JavaScript regular expression';

const FLAGS: Readonly<Record<RegexContext, string>> = { session_rule: 'sv', attempts: 'vy' };

const BACKSLASH = 0x5c;
const OPEN_CLASS = 0x5b;
const CLOSE_CLASS = 0x5d;
const OPEN_GROUP = 0x28;

/** The refusal of `compileRegex`; `reason` never contains the pattern text. */
export class RegexCompileError extends Error {
  readonly reason: string;
  /** The pattern uses a Python-only construct (`(?P<name>...)`, `(?P=name)`, `(?#...)`, an inline flag group, `\A`, `\Z`). */
  readonly pythonSyntax: boolean;

  constructor(reason: string, pythonSyntax: boolean) {
    super(`invalid regular expression (${reason})`);
    this.name = 'RegexCompileError';
    this.reason = reason;
    this.pythonSyntax = pythonSyntax;
  }
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** An inline flag group at `i` (which holds `(?`): `(?flags)` is global, `(?flags:`, `(?-flags:` and `(?a-b:` are scoped. */
function flagGroupAt(source: string, i: number): 'global' | 'scoped' | null {
  let j = i + 2;
  let letters = 0;
  while (j < source.length && isAsciiLetter(source.charCodeAt(j))) {
    j += 1;
    letters += 1;
  }
  let dash = false;
  if (source[j] === '-') {
    dash = true;
    j += 1;
    while (j < source.length && isAsciiLetter(source.charCodeAt(j))) {
      j += 1;
      letters += 1;
    }
  }
  if (letters === 0 && !dash) return null;
  if (source[j] === ':') return 'scoped';
  if (source[j] === ')') return 'global';
  return null;
}

interface Scan {
  readonly python: boolean;
  readonly modifierGroup: boolean;
}

/** One pass over the source outside escapes, tracking (nested `v`-mode) classes, for the constructs this module refuses or explains. */
function scan(source: string): Scan {
  let python = false;
  let modifierGroup = false;
  let classDepth = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === BACKSLASH) {
      const next = source[i + 1];
      if (next === 'A' || next === 'Z') python = true;
      i += 1;
      continue;
    }
    if (code === OPEN_CLASS) {
      classDepth += 1;
      continue;
    }
    if (code === CLOSE_CLASS) {
      if (classDepth > 0) classDepth -= 1;
      continue;
    }
    if (classDepth > 0 || code !== OPEN_GROUP || source[i + 1] !== '?') continue;
    const head = source.slice(i + 2, i + 4);
    if (head === 'P<' || head === 'P=' || head === 'P>' || head.startsWith('#')) {
      python = true;
      continue;
    }
    const flags = flagGroupAt(source, i);
    if (flags !== null) {
      python = true;
      if (flags === 'scoped') modifierGroup = true;
    }
  }
  return { python, modifierGroup };
}

/** The hint for a pattern that uses a Python-only construct, else null. */
export function pythonSyntaxHint(source: string): string | null {
  return scan(source).python ? PYTHON_SYNTAX_HINT : null;
}

/** The V8 message without the `Invalid regular expression: /source/flags: ` prefix, so the pattern is never repeated. */
function reasonOf(error: unknown, source: string, flags: string): string {
  const message = error instanceof Error ? error.message : '';
  const prefix = `Invalid regular expression: /${source}/${flags}: `;
  if (message.startsWith(prefix) && message.length > prefix.length) return message.slice(prefix.length);
  const marker = `/${flags}: `;
  const at = message.lastIndexOf(marker);
  if (at >= 0 && at + marker.length < message.length) return message.slice(at + marker.length);
  if (message !== '' && !message.includes(source)) return message;
  return GENERIC_REASON;
}

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

function makeMatch(groupCount: number, groupNames: readonly string[], text: string, m: RegExpExecArray): RegexMatch {
  const start = codePointLength(text.slice(0, m.index));
  const matched = m[0];
  return {
    start,
    end: start + codePointLength(matched),
    group(n: number): string | null {
      if (!Number.isInteger(n) || n < 0 || n > groupCount) throw new RangeError('no such group');
      return n === 0 ? matched : (m[n] ?? null);
    },
    groups(): (string | null)[] {
      const out: (string | null)[] = [];
      for (let i = 1; i <= groupCount; i++) out.push(m[i] ?? null);
      return out;
    },
    groupdict(): Record<string, string | null> {
      return Object.fromEntries(groupNames.map((name) => [name, m.groups?.[name] ?? null]));
    },
  };
}

/**
 * Compile a configuration pattern. Throws `RegexCompileError` for a source that is not valid JavaScript, that V8 cannot
 * compile (stack overflow, too large: forced here for both subject widths, so the refusal happens at validation time and
 * not on the first use) or that uses an inline modifier group.
 *
 * V8 13.6 can report a match that starts between the two halves of a surrogate pair when a non-sticky `v`-mode search
 * fails at the pair's first half (for example `$` on a text that ends in an astral character). Such a result is discarded
 * and the search continues code point by code point with a sticky copy of the same pattern.
 */
export function compileRegex(source: string, context: RegexContext): CompiledRegex {
  const found = scan(source);
  if (found.modifierGroup) throw new RegexCompileError(MODIFIER_REASON, true);
  const flags = FLAGS[context];
  let regex: RegExp;
  let probe: RegExpExecArray | null;
  try {
    regex = new RegExp(source, flags);
    regex.lastIndex = 0;
    regex.exec('');
    regex.lastIndex = 0;
    regex.exec(String.fromCharCode(0x100));
    regex.lastIndex = 0;
    probe = new RegExp(`(?:${source})|`, flags).exec('');
  } catch (error) {
    throw new RegexCompileError(reasonOf(error, source, flags), found.python);
  }
  const groupCount = probe === null ? 0 : probe.length - 1;
  const groupNames = probe?.groups === undefined ? [] : Object.keys(probe.groups);
  let sticky: RegExp | null = null;

  const scanFrom = (text: string, from: number): RegExpExecArray | null => {
    sticky ??= new RegExp(source, `${flags}y`);
    for (let pos = from; pos <= text.length;) {
      sticky.lastIndex = pos;
      const next = sticky.exec(text);
      if (next !== null) return next;
      pos += isSurrogatePairAt(text, pos) ? 2 : 1;
    }
    return null;
  };

  return {
    regex,
    context,
    groupCount,
    groupNames,
    exec(text: string): RegexMatch | null {
      regex.lastIndex = 0;
      let m = regex.exec(text);
      regex.lastIndex = 0;
      if (m !== null && context === 'session_rule' && isMidPair(text, m.index)) m = scanFrom(text, m.index + 1);
      return m === null ? null : makeMatch(groupCount, groupNames, text, m);
    },
  };
}

export type TryCompileResult =
  { readonly ok: true; readonly value: CompiledRegex } | { readonly ok: false; readonly error: RegexCompileError };

/** `compileRegex` as a result value; other exceptions still propagate. */
export function tryCompileRegex(source: string, context: RegexContext): TryCompileResult {
  try {
    return { ok: true, value: compileRegex(source, context) };
  } catch (error) {
    if (error instanceof RegexCompileError) return { ok: false, error };
    throw error;
  }
}
