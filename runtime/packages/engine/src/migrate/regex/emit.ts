// Emitter: the translator's tree to the readable text of the configuration dialect (design 01 section 2.8, ADR 0067, WP-138).
//
// The text is stored in a migrated configuration and read back with `compileRegex(text, context)`: JavaScript `v`-mode source
// with the flags `sv` for a session rule and `vy` for attempts. It is written the way a person would write it:
//
// - Printable characters stay literal. The JavaScript syntax characters get a backslash; inside a class so do the ones that `v`
//   mode reserves and the second punctuator of a reserved double (`&&`, `!!`, ...). Every other character is a braced escape.
// - `^` and `$` are used where they mean the same (JavaScript without the `m` flag). The Python `$` and the multiline anchors are
//   spelled with lookarounds, because the `m` flag would also treat CR and the Unicode separators as line ends.
// - `.` stays `.` where the dialect has the `s` flag (a session rule with DOTALL in force) and is a class otherwise.
// - `\d`, `\w`, `\s` and `\b` keep the Unicode meaning of Python through explicit classes, and the plain JavaScript escapes where
//   the meaning is the same (the ASCII flag). The dialect has no `i` flag and no modifier group, so every letter that is matched
//   case-insensitively is expanded to a class.
import type { AnchorKey, CategoryKey, Node, SetItem } from './ast.ts';
import type { PyRegexContext } from './types.ts';

const BS = '\\';

/** A braced code point escape; valid inside and outside a class. */
const u = (cp: number): string => `${BS}u{${cp.toString(16)}}`;

/** Characters that need a backslash outside a class. */
const SYNTAX: ReadonlySet<string> = new Set('^$\\.*+?()[]{}|');
/** Characters that need a backslash inside a `v`-mode class (`ClassSetSyntaxCharacter`). */
const CLASS_SYNTAX: ReadonlySet<string> = new Set('()[]{}/-\\|');
/** The punctuators of the reserved doubles of `v` mode (`ClassSetReservedDoublePunctuator`). */
const CLASS_DOUBLES: ReadonlySet<string> = new Set('&!#$%*+,.:;<=>?@^`~');
/** A non-ASCII character that reads as itself: a letter, number, punctuation or symbol (no mark, separator, control or format). */
const READABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
/** Letters and symbols that render as blank (the Hangul fillers and the braille blank): they are escaped too. */
const BLANK: ReadonlySet<number> = new Set([0x115f, 0x1160, 0x2800, 0x3164, 0xffa0]);

function isReadable(cp: number): boolean {
  if (cp < 0x80) return cp >= 0x20 && cp < 0x7f;
  return !BLANK.has(cp) && READABLE.test(String.fromCodePoint(cp));
}

/** A literal outside a class. */
function plain(cp: number): string {
  if (!isReadable(cp)) return u(cp);
  const ch = String.fromCodePoint(cp);
  return SYNTAX.has(ch) ? BS + ch : ch;
}

/** The members of one class, written the way `v` mode reads them. */
class ClassMembers {
  private text = '';
  /** The last reserved-double punctuator written, which the next one must not repeat unescaped. */
  private last = '';

  get value(): string {
    return this.text;
  }

  lit(cp: number): void {
    if (!isReadable(cp)) {
      this.raw(u(cp));
      return;
    }
    const ch = String.fromCodePoint(cp);
    const doubled = CLASS_DOUBLES.has(ch) && (ch === this.last || (ch === '^' && this.text === ''));
    this.text += CLASS_SYNTAX.has(ch) || doubled ? BS + ch : ch;
    this.last = CLASS_DOUBLES.has(ch) ? ch : '';
  }

  range(lo: number, hi: number): void {
    this.lit(lo);
    this.raw('-');
    this.lit(hi);
  }

  /** Text that is already valid class syntax. */
  raw(piece: string): void {
    this.text += piece;
    this.last = '';
  }
}

/** The 29 code points of Python's `\s` for str patterns. */
const SPACE_UNICODE = [
  `${u(0x9)}-${u(0xd)}`,
  `${u(0x1c)}-${u(0x20)}`,
  u(0x85),
  u(0xa0),
  u(0x1680),
  `${u(0x2000)}-${u(0x200a)}`,
  u(0x2028),
  u(0x2029),
  u(0x202f),
  u(0x205f),
  u(0x3000),
].join('');
const SPACE_ASCII = `${u(0x9)}-${u(0xd)}${u(0x20)}`;

type Members = 'd' | 'w' | 's';

/** Members (without brackets) of the positive form of a category. */
function categoryMembers(key: Members, ascii: boolean): string {
  switch (key) {
    case 'd':
      return ascii ? `${BS}d` : `${BS}p{Nd}`;
    case 'w':
      return ascii ? `${BS}w` : `${BS}p{L}${BS}p{N}_`;
    case 's':
      return ascii ? SPACE_ASCII : SPACE_UNICODE;
  }
}

function categoryParts(key: CategoryKey): { members: Members; negated: boolean } {
  switch (key) {
    case 'd':
    case 'w':
    case 's':
      return { members: key, negated: false };
    case 'D':
      return { members: 'd', negated: true };
    case 'W':
      return { members: 'w', negated: true };
    case 'S':
      return { members: 's', negated: true };
  }
}

/** The one-escape form of a category, when JavaScript has an escape that means the same (`\d` always, `\w` for ASCII). */
function singleEscape(members: Members, negated: boolean, ascii: boolean): string | null {
  if (members === 'd') return ascii ? `${BS}${negated ? 'D' : 'd'}` : `${BS}${negated ? 'P' : 'p'}{Nd}`;
  if (members === 'w' && ascii) return `${BS}${negated ? 'W' : 'w'}`;
  return null;
}

/** A category outside a set. */
function categoryClass(key: CategoryKey, ascii: boolean): string {
  const { members, negated } = categoryParts(key);
  return singleEscape(members, negated, ascii) ?? `[${negated ? '^' : ''}${categoryMembers(members, ascii)}]`;
}

/** A category inside a set: the members inline, a negated category as an escape or a nested class. */
function categoryInSet(key: CategoryKey, ascii: boolean): string {
  const { members, negated } = categoryParts(key);
  if (!negated) return categoryMembers(members, ascii);
  return singleEscape(members, true, ascii) ?? `[^${categoryMembers(members, ascii)}]`;
}

function wordClass(): string {
  return `[${categoryMembers('w', false)}]`;
}

function anchor(key: AnchorKey, multiline: boolean, ascii: boolean): string {
  switch (key) {
    case 'bol':
      return multiline ? `(?:^|(?<=${BS}n))` : '^';
    case 'eol':
      return multiline ? `(?=${BS}n|$)` : `(?=${BS}n?$)`;
    case 'bos':
      return '^';
    case 'eos':
      return '$';
    case 'wb': {
      if (ascii) return `${BS}b`;
      const w = wordClass();
      return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
    }
    case 'nwb': {
      if (ascii) return `${BS}B`;
      const w = wordClass();
      return `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`;
    }
  }
}

/** Non-ASCII code points that CPython's IGNORECASE also matches for an ASCII letter (verified against CPython 3.14). */
const CASE_EXTRAS: ReadonlyMap<number, string> = new Map([
  [0x69, `${u(0x130)}${u(0x131)}`],
  [0x6b, u(0x212a)],
  [0x73, u(0x17f)],
]);

function isAsciiLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/** An ASCII letter matched case-insensitively by hand: both cases plus CPython's extra equivalents. */
function addLetter(into: ClassMembers, cp: number): void {
  const lower = cp | 0x20;
  into.lit(lower);
  into.lit(lower - 0x20);
  const extras = CASE_EXTRAS.get(lower);
  if (extras !== undefined) into.raw(extras);
}

/** A range under case-insensitive matching: the range, its letters in the other case, and the extras they bring. */
function addRange(into: ClassMembers, lo: number, hi: number): void {
  into.range(lo, hi);
  const lowerLo = Math.max(lo, 0x61);
  const lowerHi = Math.min(hi, 0x7a);
  if (lowerLo <= lowerHi) into.range(lowerLo - 0x20, lowerHi - 0x20);
  const upperLo = Math.max(lo, 0x41);
  const upperHi = Math.min(hi, 0x5a);
  if (upperLo <= upperHi) into.range(upperLo + 0x20, upperHi + 0x20);
  for (const [letter, extras] of CASE_EXTRAS) {
    if ((lo <= letter && letter <= hi) || (lo <= letter - 0x20 && letter - 0x20 <= hi)) into.raw(extras);
  }
}

function setSource(neg: boolean, items: readonly SetItem[], ignoreCase: boolean, ascii: boolean): string {
  const members = new ClassMembers();
  for (const item of items) {
    if (item.t === 'lit') {
      if (ignoreCase && isAsciiLetter(item.cp)) addLetter(members, item.cp);
      else members.lit(item.cp);
    } else if (item.t === 'range') {
      if (ignoreCase) addRange(members, item.lo, item.hi);
      else members.range(item.lo, item.hi);
    } else {
      members.raw(categoryInSet(item.k, ascii));
    }
  }
  return `[${neg ? '^' : ''}${members.value}]`;
}

function quantifier(min: number, max: number | null, lazy: boolean): string {
  let q: string;
  if (max === null) q = min === 0 ? '*' : min === 1 ? '+' : `{${String(min)},}`;
  else if (min === 0 && max === 1) q = '?';
  else if (min === max) q = `{${String(min)}}`;
  else q = `{${String(min)},${String(max)}}`;
  return lazy ? `${q}?` : q;
}

interface Scope {
  readonly context: PyRegexContext;
  /** Names of the named groups by capture index, for `\k<name>`. */
  readonly names: ReadonlyMap<number, string>;
}

function collectNames(node: Node, into: Map<number, string>): void {
  switch (node.t) {
    case 'group':
      if (node.index !== null && node.name !== null) into.set(node.index, node.name);
      collectNames(node.body, into);
      return;
    case 'seq':
      for (const item of node.items) collectNames(item, into);
      return;
    case 'alt':
      for (const alt of node.alts) collectNames(alt, into);
      return;
    case 'rep':
    case 'look':
      collectNames(node.body, into);
      return;
    case 'lit':
    case 'any':
    case 'at':
    case 'set':
    case 'cat':
    case 'backref':
      return;
  }
}

/** A sequence; a numbered backreference that a digit follows is wrapped, because `\1` then `0` would read as `\10`. */
function emitSequence(items: readonly Node[], scope: Scope): string {
  const parts = items.map((item) => emitNode(item, scope));
  return parts
    .map((part, index) => {
      const item = items[index];
      const next = parts[index + 1];
      const numbered = item?.t === 'backref' && !scope.names.has(item.index);
      return numbered && next !== undefined && /^[0-9]/.test(next) ? `(?:${part})` : part;
    })
    .join('');
}

function emitNode(node: Node, scope: Scope): string {
  switch (node.t) {
    case 'lit':
      if (node.f.i && isAsciiLetter(node.cp)) {
        const letter = new ClassMembers();
        addLetter(letter, node.cp);
        return `[${letter.value}]`;
      }
      return plain(node.cp);
    case 'any':
      if (!node.f.s) return `[^${BS}n]`;
      return scope.context === 'session_rule' ? '.' : `[${BS}s${BS}S]`;
    case 'at':
      return anchor(node.k, node.f.m, node.f.a);
    case 'set':
      return setSource(node.neg, node.items, node.f.i, node.f.a);
    case 'cat':
      return categoryClass(node.k, node.f.a);
    case 'seq':
      return emitSequence(node.items, scope);
    case 'alt':
      return node.alts.map((alt) => emitNode(alt, scope)).join('|');
    case 'group': {
      const body = emitNode(node.body, scope);
      if (node.index === null) return `(?:${body})`;
      return node.name === null ? `(${body})` : `(?<${node.name}>${body})`;
    }
    case 'rep':
      return `${emitNode(node.body, scope)}${quantifier(node.min, node.max, node.lazy)}`;
    case 'look':
      return `(?${node.behind ? '<' : ''}${node.neg ? '!' : '='}${emitNode(node.body, scope)})`;
    case 'backref': {
      const name = scope.names.get(node.index);
      return name === undefined ? `${BS}${String(node.index)}` : `${BS}k<${name}>`;
    }
  }
}

/**
 * Dialect text for the tree. The text never relies on the JavaScript `i` or `m` flag or on a modifier group: letters that are
 * matched case-insensitively are expanded to explicit classes and the multiline anchors are lookarounds. Only a session rule
 * relies on the `s` flag of the dialect, for a dot that DOTALL leaves in force.
 */
export function emit(root: Node, context: PyRegexContext): string {
  const names = new Map<number, string>();
  collectNames(root, names);
  return emitNode(root, { context, names });
}
