// Recursive-descent port of the subset of CPython 3.x `re._parser` that the translator accepts (design 01 section 2.8).
// Everything outside the subset is refused here with the documented error code; the exactness analysis that needs the
// whole tree (captures in loops, backreferences) lives in analyze.ts.
import { PyRegexFailure, type CategoryKey, type Flags, type Node, type ParsedPattern, type SetItem } from './ast.ts';
import { BS, Tokenizer } from './tokenizer.ts';
import type { PyRegexContext } from './types.ts';

const MAXREPEAT = 4294967295;
const MAX_DEPTH = 150;
const DIGITS: ReadonlySet<string> = new Set('0123456789');
const OCT_DIGITS: ReadonlySet<string> = new Set('01234567');
const HEX_DIGITS: ReadonlySet<string> = new Set('0123456789abcdefABCDEF');
const SPECIAL: ReadonlySet<string> = new Set(['.', BS, '[', '{', '(', ')', '*', '+', '?', '^', '$', '|']);
const FLAG_CHARS: ReadonlySet<string> = new Set(['i', 'L', 'm', 's', 'x', 'a', 'u']);
const ASCII_LETTER = /^[A-Za-z]$/;
const LETTER = /^\p{L}$/u;
const ASCII_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNICODE_IDENTIFIER = /^[\p{ID_Start}_]\p{ID_Continue}*$/u;

/** `\a \b \f \n \r \t \v \\` as CPython reads them (`\b` is a backspace only inside a set). */
const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  [`${BS}a`, 0x07],
  [`${BS}b`, 0x08],
  [`${BS}f`, 0x0c],
  [`${BS}n`, 0x0a],
  [`${BS}r`, 0x0d],
  [`${BS}t`, 0x09],
  [`${BS}v`, 0x0b],
  [`${BS}${BS}`, 0x5c],
]);

const CATEGORY_ESCAPES: ReadonlyMap<string, CategoryKey> = new Map([
  [`${BS}d`, 'd'],
  [`${BS}D`, 'D'],
  [`${BS}w`, 'w'],
  [`${BS}W`, 'W'],
  [`${BS}s`, 's'],
  [`${BS}S`, 'S'],
]);

interface FlagSet {
  i: boolean;
  m: boolean;
  s: boolean;
  a: boolean;
  u: boolean;
}

type Width = readonly [number, number];

function emptyFlags(): FlagSet {
  return { i: false, m: false, s: false, a: false, u: false };
}

function codePointCount(text: string): number {
  return Array.from(text).length;
}

/** CPython `getwidth`: minimum and maximum number of code points a node consumes. */
export function widthOf(node: Node, groupWidths: readonly (Width | null)[]): Width {
  switch (node.t) {
    case 'lit':
    case 'any':
    case 'set':
    case 'cat':
      return [1, 1];
    case 'at':
    case 'look':
      return [0, 0];
    case 'group':
      return widthOf(node.body, groupWidths);
    case 'seq': {
      let lo = 0;
      let hi = 0;
      for (const item of node.items) {
        const [l, h] = widthOf(item, groupWidths);
        lo += l;
        hi += h;
      }
      return [lo, hi];
    }
    case 'alt': {
      let lo = Number.POSITIVE_INFINITY;
      let hi = 0;
      for (const alt of node.alts) {
        const [l, h] = widthOf(alt, groupWidths);
        lo = Math.min(lo, l);
        hi = Math.max(hi, h);
      }
      return [lo === Number.POSITIVE_INFINITY ? 0 : lo, hi];
    }
    case 'rep': {
      const [l, h] = widthOf(node.body, groupWidths);
      const hi = h === 0 ? 0 : node.max === null ? Number.POSITIVE_INFINITY : h * node.max;
      return [l * node.min, hi];
    }
    case 'backref':
      return groupWidths[node.index] ?? [0, Number.POSITIVE_INFINITY];
  }
}

/** True when the tree has `\D`, `\W`, `\S` or a negated set that contains a category escape. */
function hasComplementedClass(node: Node): boolean {
  switch (node.t) {
    case 'cat':
      return node.k === 'D' || node.k === 'W' || node.k === 'S';
    case 'set':
      return node.items.some(
        (item) => item.t === 'cat' && (node.neg || item.k === 'D' || item.k === 'W' || item.k === 'S'),
      );
    case 'lit':
    case 'any':
    case 'at':
    case 'backref':
      return false;
    case 'group':
    case 'rep':
    case 'look':
      return hasComplementedClass(node.body);
    case 'seq':
      return node.items.some(hasComplementedClass);
    case 'alt':
      return node.alts.some(hasComplementedClass);
  }
}

class Parser {
  private readonly tok: Tokenizer;
  private flags: Flags;
  private globalA = false;
  private globalU = false;
  /** Widths of the closed groups; index 0 is the whole pattern, `null` marks a group that is still open. */
  private readonly groupWidths: (Width | null)[] = [null];
  private readonly groupIndexByName = new Map<string, number>();
  private readonly groupNames: string[] = [];
  private lookbehindGroups: number | null = null;
  private depth = 0;
  private manualIgnoreCase = false;
  private readonly ctx: PyRegexContext;

  constructor(source: string, ctx: PyRegexContext) {
    this.tok = new Tokenizer(source);
    this.ctx = ctx;
    this.flags = { i: false, m: false, s: ctx === 'session_rule', a: false };
  }

  parse(): ParsedPattern {
    const root = this.parseSub(0);
    if (this.tok.next !== null) throw this.tok.error('SYNTAX', 'unbalanced parenthesis');
    if (this.globalA && this.globalU) {
      throw new PyRegexFailure('SYNTAX', 'ASCII and UNICODE flags are incompatible', 0);
    }
    return {
      root,
      groupCount: this.groupWidths.length - 1,
      groupNames: this.groupNames,
      globalIgnoreCase: this.flags.i,
      manualIgnoreCase: this.manualIgnoreCase,
    };
  }

  // ---- structure -----------------------------------------------------------------------------------------------

  private parseSub(nested: number): Node {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw this.tok.error('UNSUPPORTED_CONSTRUCT', 'the pattern is nested too deeply (the translator limit)');
    }
    const alts: Node[] = [];
    for (;;) {
      alts.push(this.parseSeq(nested, nested === 0 && alts.length === 0));
      if (!this.tok.match('|')) break;
    }
    this.depth -= 1;
    const only = alts[0];
    if (alts.length === 1 && only !== undefined) return only;
    return { t: 'alt', alts };
  }

  private parseSeq(nested: number, first: boolean): Node {
    const tok = this.tok;
    const items: Node[] = [];
    for (;;) {
      const token = tok.next;
      if (token === null || token === '|' || token === ')') break;
      tok.get();
      if (token.startsWith(BS)) {
        items.push(this.parseEscape(token));
      } else if (!SPECIAL.has(token)) {
        items.push(this.literal(token.codePointAt(0) ?? 0, tok.tell() - 1));
      } else if (token === '[') {
        items.push(this.parseSet());
      } else if (token === '*' || token === '+' || token === '?' || token === '{') {
        this.parseRepeat(token, items);
      } else if (token === '.') {
        items.push({ t: 'any', f: this.flags });
      } else if (token === '(') {
        this.parseGroup(nested, first, items);
      } else if (token === '^') {
        items.push({ t: 'at', k: 'bol', f: this.flags });
      } else {
        items.push({ t: 'at', k: 'eol', f: this.flags });
      }
    }
    return { t: 'seq', items };
  }

  private literal(cp: number, pos: number): Node {
    if (this.flags.i && cp > 0x7f) {
      throw new PyRegexFailure(
        'INEXACT_SEMANTICS',
        'IGNORECASE with a non-ASCII literal: case folding tables differ between Python and JavaScript',
        pos,
      );
    }
    return { t: 'lit', cp, f: this.flags };
  }

  // ---- repeats -------------------------------------------------------------------------------------------------

  private parseRepeat(token: string, items: Node[]): void {
    const tok = this.tok;
    const here = tok.tell();
    let min = 0;
    let max: number | null = null;
    if (token === '?') {
      max = 1;
    } else if (token === '+') {
      min = 1;
    } else if (token === '{') {
      if (tok.next === '}') {
        items.push(this.literal(0x7b, here - 1));
        return;
      }
      let lo = '';
      let hi = '';
      while (tok.nextIn(DIGITS)) lo += tok.get() ?? '';
      if (tok.match(',')) {
        while (tok.nextIn(DIGITS)) hi += tok.get() ?? '';
      } else {
        hi = lo;
      }
      if (!tok.match('}')) {
        items.push(this.literal(0x7b, here - 1));
        tok.seek(here);
        return;
      }
      if (lo !== '') {
        min = Number(lo);
        if (min >= MAXREPEAT) throw tok.error('SYNTAX', 'the repetition number is too large', tok.tell() - here + 1);
      }
      if (hi !== '') {
        max = Number(hi);
        if (max >= MAXREPEAT) throw tok.error('SYNTAX', 'the repetition number is too large', tok.tell() - here + 1);
        if (max < min) throw tok.error('SYNTAX', 'min repeat greater than max repeat', tok.tell() - here);
      }
    }
    const offset = tok.tell() - here + 1;
    const item = items[items.length - 1];
    if (item === undefined || item.t === 'at') throw tok.error('SYNTAX', 'nothing to repeat', offset);
    if (item.t === 'rep') throw tok.error('SYNTAX', 'multiple repeat', offset);
    if (item.t === 'look') {
      throw tok.error(
        'UNSUPPORTED_CONSTRUCT',
        'a quantifier on a lookaround is valid Python but not supported by the translator',
        offset,
      );
    }
    const lazy = tok.match('?');
    if (!lazy && tok.match('+')) {
      throw tok.error(
        'UNSUPPORTED_CONSTRUCT',
        'possessive quantifiers have no JavaScript equivalent',
        tok.tell() - here + 2,
      );
    }
    items[items.length - 1] = { t: 'rep', min, max, lazy, body: item, pos: here - 1 };
  }

  // ---- groups --------------------------------------------------------------------------------------------------

  private parseGroup(nested: number, first: boolean, items: Node[]): void {
    const tok = this.tok;
    const start = tok.tell() - 1;
    let capture = true;
    let name: string | null = null;
    let scoped: { add: FlagSet; del: FlagSet } | null = null;
    if (tok.match('?')) {
      const char = tok.get();
      if (char === null) throw tok.error('SYNTAX', 'unexpected end of pattern');
      if (char === 'P') {
        if (tok.match('<')) {
          name = tok.getUntil('>', 'group name');
          this.checkGroupName(name, 1);
        } else if (tok.match('=')) {
          const ref = tok.getUntil(')', 'group name');
          this.checkGroupName(ref, 1);
          const index = this.groupIndexByName.get(ref);
          if (index === undefined) throw tok.error('SYNTAX', 'unknown group name', codePointCount(ref) + 1);
          items.push(this.backreference(index, codePointCount(ref) + 1, start));
          return;
        } else {
          const extra = tok.get();
          if (extra === null) throw tok.error('SYNTAX', 'unexpected end of pattern');
          throw tok.error('SYNTAX', `unknown extension ?P${extra}`, codePointCount(extra) + 2);
        }
      } else if (char === ':') {
        capture = false;
      } else if (char === '#') {
        for (;;) {
          if (tok.next === null) throw tok.error('SYNTAX', 'missing ), unterminated comment', tok.tell() - start);
          if (tok.get() === ')') break;
        }
        return;
      } else if (char === '=' || char === '!' || char === '<') {
        items.push(this.parseLook(char, nested, start));
        return;
      } else if (char === '(') {
        throw tok.error('UNSUPPORTED_CONSTRUCT', 'conditional groups (?(id)yes|no) have no JavaScript equivalent', 2);
      } else if (char === '>') {
        throw tok.error('UNSUPPORTED_CONSTRUCT', 'atomic groups (?>...) have no JavaScript equivalent', 2);
      } else if (FLAG_CHARS.has(char) || char === '-') {
        const parsed = this.parseFlags(char);
        if (parsed.global) {
          if (!first || items.length > 0) {
            throw tok.error('SYNTAX', 'global flags not at the start of the expression', tok.tell() - start);
          }
          this.applyGlobalFlags(parsed.add, start);
          return;
        }
        capture = false;
        scoped = parsed;
      } else {
        throw tok.error('SYNTAX', `unknown extension ?${char}`, codePointCount(char) + 1);
      }
    }

    let index: number | null = null;
    if (capture) index = this.openGroup(name, start);
    const saved = this.flags;
    if (scoped !== null) {
      this.flags = this.combineFlags(saved, scoped.add, scoped.del, start);
      if (this.flags.i !== saved.i) this.manualIgnoreCase = true;
    }
    const flagsInScope = this.flags;
    const body = this.parseSub(nested + 1);
    this.flags = saved;
    if (!tok.match(')')) throw tok.error('SYNTAX', 'missing ), unterminated subpattern', tok.tell() - start);
    if (scoped !== null) this.checkSearchPrefilter(saved, flagsInScope, body, start);
    if (index !== null) this.groupWidths[index] = widthOf(body, this.groupWidths);
    items.push({ t: 'group', index, name, body, pos: start });
  }

  private openGroup(name: string | null, start: number): number {
    const index = this.groupWidths.length;
    if (name !== null) {
      if (this.groupIndexByName.has(name)) {
        throw new PyRegexFailure('SYNTAX', 'redefinition of group name', start);
      }
      this.groupIndexByName.set(name, index);
      this.groupNames.push(name);
    }
    this.groupWidths.push(null);
    return index;
  }

  private checkGroupName(name: string, offset: number): void {
    if (ASCII_IDENTIFIER.test(name)) return;
    const length = codePointCount(name) + offset;
    if (UNICODE_IDENTIFIER.test(name)) {
      throw this.tok.error('UNSUPPORTED_CONSTRUCT', 'non-ASCII group names are not supported', length);
    }
    throw this.tok.error('SYNTAX', 'bad character in group name', length);
  }

  private parseLook(char: string, nested: number, start: number): Node {
    const tok = this.tok;
    let kind = char;
    let behind = false;
    let outerLookbehind: number | null = null;
    if (char === '<') {
      const next = tok.get();
      if (next === null) throw tok.error('SYNTAX', 'unexpected end of pattern');
      if (next !== '=' && next !== '!') {
        throw tok.error('SYNTAX', `unknown extension ?<${next}`, codePointCount(next) + 2);
      }
      kind = next;
      behind = true;
      outerLookbehind = this.lookbehindGroups;
      this.lookbehindGroups ??= this.groupWidths.length;
    }
    const body = this.parseSub(nested + 1);
    if (behind && outerLookbehind === null) this.lookbehindGroups = null;
    if (!tok.match(')')) throw tok.error('SYNTAX', 'missing ), unterminated subpattern', tok.tell() - start);
    if (behind) {
      const [lo, hi] = widthOf(body, this.groupWidths);
      if (lo !== hi) throw new PyRegexFailure('SYNTAX', 'look-behind requires fixed-width pattern', start);
    }
    return { t: 'look', behind, neg: kind === '!', body, pos: start };
  }

  private backreference(index: number, offset: number, pos: number): Node {
    const tok = this.tok;
    if (this.groupWidths[index] === null) throw tok.error('SYNTAX', 'cannot refer to an open group', offset);
    if (this.lookbehindGroups !== null && index >= this.lookbehindGroups) {
      throw tok.error('SYNTAX', 'cannot refer to group defined in the same lookbehind subpattern', offset);
    }
    if (this.flags.i) {
      throw new PyRegexFailure(
        'INEXACT_SEMANTICS',
        'a backreference under IGNORECASE: case folding of captured text differs between Python and JavaScript',
        pos,
      );
    }
    return { t: 'backref', index, pos };
  }

  // ---- flags ---------------------------------------------------------------------------------------------------

  private parseFlags(first: string): { global: boolean; add: FlagSet; del: FlagSet } {
    const tok = this.tok;
    const add = emptyFlags();
    const del = emptyFlags();
    let char: string | null = first;
    const unsupported = (flag: string): PyRegexFailure =>
      tok.error(
        'UNSUPPORTED_FLAG',
        flag === 'x'
          ? 'the verbose flag (?x) is not supported'
          : 'the locale flag (?L) cannot be used with a str pattern',
      );

    if (char !== '-') {
      for (;;) {
        if (char === 'x' || char === 'L') throw unsupported(char);
        if (char === 'i' || char === 'm' || char === 's' || char === 'a' || char === 'u') add[char] = true;
        if ((char === 'a' || char === 'u') && add.a && add.u) {
          throw tok.error('SYNTAX', "bad inline flags: flags 'a', 'u' and 'L' are incompatible");
        }
        char = tok.get();
        if (char === null) throw tok.error('SYNTAX', 'missing -, : or )');
        if (char === ')' || char === '-' || char === ':') break;
        if (!FLAG_CHARS.has(char)) {
          if (LETTER.test(char)) throw tok.error('UNSUPPORTED_FLAG', 'unknown flag', 1);
          throw tok.error('SYNTAX', 'missing -, : or )', codePointCount(char));
        }
      }
    }
    if (char === ')') return { global: true, add, del };
    if (char === '-') {
      char = tok.get();
      if (char === null) throw tok.error('SYNTAX', 'missing flag');
      if (!FLAG_CHARS.has(char)) {
        if (LETTER.test(char)) throw tok.error('UNSUPPORTED_FLAG', 'unknown flag', 1);
        throw tok.error('SYNTAX', 'missing flag', codePointCount(char));
      }
      for (;;) {
        if (char === 'a' || char === 'u' || char === 'L' || char === 'x') {
          throw tok.error('UNSUPPORTED_FLAG', "cannot turn off flags 'a', 'u', 'L' and 'x'");
        }
        if (char === 'i' || char === 'm' || char === 's') del[char] = true;
        char = tok.get();
        if (char === null) throw tok.error('SYNTAX', 'missing :');
        if (char === ':') break;
        if (!FLAG_CHARS.has(char)) {
          if (LETTER.test(char)) throw tok.error('UNSUPPORTED_FLAG', 'unknown flag', 1);
          throw tok.error('SYNTAX', 'missing :', codePointCount(char));
        }
      }
    }
    if ((add.i && del.i) || (add.m && del.m) || (add.s && del.s)) {
      throw tok.error('SYNTAX', 'bad inline flags: flag turned on and off', 1);
    }
    return { global: false, add, del };
  }

  private applyGlobalFlags(add: FlagSet, pos: number): void {
    if (add.a) this.globalA = true;
    if (add.u) this.globalU = true;
    const next: Flags = {
      i: this.flags.i || add.i,
      m: this.flags.m || add.m,
      s: this.flags.s || add.s,
      a: this.flags.a || add.a,
    };
    this.checkAsciiCase(next, pos);
    this.flags = next;
  }

  private combineFlags(current: Flags, add: FlagSet, del: FlagSet, pos: number): Flags {
    const asciiBase = add.a || add.u ? false : current.a;
    const next: Flags = {
      i: (current.i || add.i) && !del.i,
      m: (current.m || add.m) && !del.m,
      s: (current.s || add.s) && !del.s,
      a: asciiBase || add.a,
    };
    this.checkAsciiCase(next, pos);
    return next;
  }

  private checkAsciiCase(flags: Flags, pos: number): void {
    if (flags.a && flags.i) {
      throw new PyRegexFailure(
        'INEXACT_SEMANTICS',
        'the ASCII flag combined with IGNORECASE is not supported: ASCII-only case folding has no JavaScript equivalent',
        pos,
      );
    }
  }

  /**
   * `\w`, `\W`, `\b` and `\B` under IGNORECASE: the JavaScript `i` flag folds U+0345 (COMBINING GREEK YPOGEGRAMMENI,
   * a mark) into the letter iota, so `[\p{L}\p{N}_]` would match it, which Python's `(?i)\w` does not. A pattern that has
   * this combination is emitted without the `i` flag, like a pattern with a scoped IGNORECASE switch.
   */
  private noteWordClass(key: CategoryKey): void {
    if (this.flags.i && (key === 'w' || key === 'W')) this.manualIgnoreCase = true;
  }

  /**
   * CPython `re.search` builds a pre-filter from the first class of the pattern (`_compile_info`, `_get_charset_prefix`)
   * and compiles it with the flags of the whole pattern, not the scoped ones. A scoped `(?a:...)` or `(?u:...)` group that
   * changes the ASCII/Unicode type therefore disagrees with `re.match` at every position when the pre-filter is
   * narrower than the real class. The pre-filter is only a superset when the pattern is Unicode, the group is ASCII and
   * the group has no complemented class (`\D \W \S` or a negated set with a category): Unicode `\d \w \s` contain
   * their ASCII forms. Every other switch is refused for `session_rule` (`re.search`); `attempts` (`re.match`) is exact.
   */
  private checkSearchPrefilter(outer: Flags, inner: Flags, body: Node, pos: number): void {
    if (this.ctx !== 'session_rule' || outer.a === inner.a) return;
    if (!outer.a && !hasComplementedClass(body)) return;
    throw new PyRegexFailure(
      'INEXACT_SEMANTICS',
      'a scoped ASCII or Unicode switch (?a:...) or (?u:...) can disagree with the CPython re.search pre-filter, which uses the flags of the whole pattern',
      pos,
    );
  }

  // ---- escapes -------------------------------------------------------------------------------------------------

  private parseEscape(escape: string): Node {
    const tok = this.tok;
    const f = this.flags;
    const category = CATEGORY_ESCAPES.get(escape);
    if (category !== undefined) {
      this.noteWordClass(category);
      return { t: 'cat', k: category, f };
    }
    switch (escape) {
      case `${BS}A`:
        return { t: 'at', k: 'bos', f };
      case `${BS}Z`:
        return { t: 'at', k: 'eos', f };
      case `${BS}b`:
        this.noteWordClass('w');
        return { t: 'at', k: 'wb', f };
      case `${BS}B`:
        this.noteWordClass('w');
        return { t: 'at', k: 'nwb', f };
      case `${BS}z`:
        throw tok.error('UNSUPPORTED_CONSTRUCT', `the escape ${BS}z only exists in Python 3.14: write ${BS}Z`, 2);
    }
    const simple = SIMPLE_ESCAPES.get(escape);
    if (simple !== undefined) return this.literal(simple, tok.tell() - 2);
    const c = escape.slice(1);
    const numeric = this.numericEscape(escape, c);
    if (numeric !== null) return this.literal(numeric, tok.tell() - 2);
    if (c === '0') {
      const digits = escape + tok.getWhile(2, OCT_DIGITS);
      return this.literal(Number.parseInt(digits.slice(1), 8), tok.tell() - digits.length);
    }
    if (DIGITS.has(c)) return this.digitEscape(escape);
    if (ASCII_LETTER.test(c)) throw tok.error('SYNTAX', `bad escape ${escape}`, 2);
    return this.literal(c.codePointAt(0) ?? 0, tok.tell() - 2);
  }

  /** `\x`, `\u`, `\U` and `\N` (shared by escapes inside and outside sets); `null` when `c` is none of them. */
  private numericEscape(escape: string, c: string): number | null {
    const tok = this.tok;
    const width = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0;
    if (c === 'N') {
      throw tok.error(
        'UNSUPPORTED_CONSTRUCT',
        `named Unicode escapes ${BS}N{...} are not supported: write the code point`,
        2,
      );
    }
    if (width === 0) return null;
    const digits = tok.getWhile(width, HEX_DIGITS);
    if (digits.length !== width) {
      throw tok.error('SYNTAX', `incomplete escape ${escape}${digits}`, escape.length + digits.length);
    }
    const value = Number.parseInt(digits, 16);
    if (value > 0x10ffff) throw tok.error('SYNTAX', `bad escape ${escape}${digits}`, escape.length + digits.length);
    return value;
  }

  private digitEscape(first: string): Node {
    const tok = this.tok;
    let escape = first;
    if (tok.nextIn(DIGITS)) {
      escape += tok.get() ?? '';
      const second = escape.charAt(1);
      const third = escape.charAt(2);
      if (OCT_DIGITS.has(second) && OCT_DIGITS.has(third) && tok.nextIn(OCT_DIGITS)) {
        escape += tok.get() ?? '';
        const value = Number.parseInt(escape.slice(1), 8);
        if (value > 0o377) {
          throw tok.error('SYNTAX', `octal escape value ${escape} outside of range 0-0o377`, escape.length);
        }
        return this.literal(value, tok.tell() - escape.length);
      }
    }
    const group = Number.parseInt(escape.slice(1), 10);
    if (group < this.groupWidths.length) return this.backreference(group, escape.length, tok.tell() - escape.length);
    throw tok.error('SYNTAX', `invalid group reference ${String(group)}`, escape.length - 1);
  }

  // ---- sets ----------------------------------------------------------------------------------------------------

  private setLiteral(cp: number, pos: number): SetItem {
    if (this.flags.i && cp > 0x7f) {
      throw new PyRegexFailure(
        'INEXACT_SEMANTICS',
        'IGNORECASE with a non-ASCII character in a set: case folding tables differ between Python and JavaScript',
        pos,
      );
    }
    return { t: 'lit', cp };
  }

  private setEscape(escape: string, pos: number): SetItem {
    const tok = this.tok;
    const simple = SIMPLE_ESCAPES.get(escape);
    if (simple !== undefined) return this.setLiteral(simple, pos);
    const category = CATEGORY_ESCAPES.get(escape);
    if (category !== undefined) {
      this.noteWordClass(category);
      return { t: 'cat', k: category };
    }
    const c = escape.slice(1);
    const numeric = this.numericEscape(escape, c);
    if (numeric !== null) return this.setLiteral(numeric, pos);
    if (OCT_DIGITS.has(c)) {
      const digits = escape + tok.getWhile(2, OCT_DIGITS);
      const value = Number.parseInt(digits.slice(1), 8);
      if (value > 0o377) {
        throw tok.error('SYNTAX', `octal escape value ${digits} outside of range 0-0o377`, digits.length);
      }
      return this.setLiteral(value, pos);
    }
    if (DIGITS.has(c) || ASCII_LETTER.test(c)) throw tok.error('SYNTAX', `bad escape ${escape}`, 2);
    return this.setLiteral(c.codePointAt(0) ?? 0, pos);
  }

  private parseSet(): Node {
    const tok = this.tok;
    const here = tok.tell() - 1;
    if (tok.next === '[') {
      throw tok.error(
        'UNSUPPORTED_CONSTRUCT',
        'a set that starts with [[ may change meaning (nested sets or POSIX classes)',
        1,
      );
    }
    const neg = tok.match('^');
    const items: SetItem[] = [];
    const unterminated = (): PyRegexFailure => tok.error('SYNTAX', 'unterminated character set', tok.tell() - here);
    for (;;) {
      const token = tok.get();
      if (token === null) throw unterminated();
      if (token === ']' && items.length > 0) break;
      let code1: SetItem;
      if (token.startsWith(BS)) {
        code1 = this.setEscape(token, tok.tell() - 2);
      } else {
        if (
          items.length > 0 &&
          (token === '-' || token === '&' || token === '~' || token === '|') &&
          tok.next === token
        ) {
          throw tok.error('UNSUPPORTED_CONSTRUCT', `a doubled ${token} inside a set is a possible set operation`, 1);
        }
        code1 = this.setLiteral(token.codePointAt(0) ?? 0, tok.tell() - 1);
      }
      if (tok.match('-')) {
        const that = tok.get();
        if (that === null) throw unterminated();
        if (that === ']') {
          items.push(code1, { t: 'lit', cp: 0x2d });
          break;
        }
        let code2: SetItem;
        if (that.startsWith(BS)) {
          code2 = this.setEscape(that, tok.tell() - 2);
        } else {
          if (that === '-') {
            throw tok.error('UNSUPPORTED_CONSTRUCT', 'a doubled - inside a set is a possible set difference', 2);
          }
          code2 = this.setLiteral(that.codePointAt(0) ?? 0, tok.tell() - 1);
        }
        if (code1.t !== 'lit' || code2.t !== 'lit') {
          throw tok.error('SYNTAX', 'bad character range', codePointCount(token) + 1 + codePointCount(that));
        }
        if (code2.cp < code1.cp) {
          throw tok.error('SYNTAX', 'bad character range', codePointCount(token) + 1 + codePointCount(that));
        }
        items.push({ t: 'range', lo: code1.cp, hi: code2.cp });
      } else {
        items.push(code1);
      }
    }
    return { t: 'set', neg, items, f: this.flags };
  }
}

/** Parse a Python pattern into the translator's tree; throws `PyRegexFailure` for every refusal. */
export function parsePyRegex(source: string, ctx: PyRegexContext): ParsedPattern {
  return new Parser(source, ctx).parse();
}
