// Emitter: the translator's tree to JavaScript `v`-mode source (design 01 section 2.8).
//
// The JavaScript `m` and `s` flags are never used. Line and dot semantics are emulated so that they follow Python:
// `.` excludes only LF, `^` and `$` see only LF as a line end, and `$` also matches before a final LF.
import type { AnchorKey, CategoryKey, Node, SetItem } from './ast.ts';

const BS = '\\';
const CASE_PAIR = `${BS}u{130}${BS}u{131}`;

const RAW_LITERAL = /^[A-Za-z0-9_]$/;

/** Literal emission rule: `[A-Za-z0-9_]` raw, every other code point as a braced escape (valid inside and outside sets). */
function literal(cp: number): string {
  const ch = String.fromCodePoint(cp);
  return RAW_LITERAL.test(ch) ? ch : `${BS}u{${cp.toString(16)}}`;
}

const u = (cp: number): string => `${BS}u{${cp.toString(16)}}`;

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

/** Members (without brackets) of the positive form of a category. */
function categoryMembers(key: 'd' | 'w' | 's', ascii: boolean): string {
  switch (key) {
    case 'd':
      return ascii ? '0-9' : `${BS}p{Nd}`;
    case 'w':
      return ascii ? 'A-Za-z0-9_' : `${BS}p{L}${BS}p{N}_`;
    case 's':
      return ascii ? SPACE_ASCII : SPACE_UNICODE;
  }
}

function categoryParts(key: CategoryKey): { members: 'd' | 'w' | 's'; negated: boolean } {
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

/** A category outside a set: a class of its own. */
function categoryClass(key: CategoryKey, ascii: boolean): string {
  const { members, negated } = categoryParts(key);
  return `[${negated ? '^' : ''}${categoryMembers(members, ascii)}]`;
}

/** A category inside a set: the members inline, a negated category as a nested class. */
function categoryInSet(key: CategoryKey, ascii: boolean): string {
  const { members, negated } = categoryParts(key);
  return negated ? `[^${categoryMembers(members, ascii)}]` : categoryMembers(members, ascii);
}

function wordClass(ascii: boolean): string {
  return `[${categoryMembers('w', ascii)}]`;
}

function anchor(key: AnchorKey, multiline: boolean, ascii: boolean): string {
  const start = `(?<![${BS}s${BS}S])`;
  const end = `(?![${BS}s${BS}S])`;
  switch (key) {
    case 'bol':
      return multiline ? `(?:${start}|(?<=${BS}n))` : start;
    case 'eol':
      return multiline ? `(?=${BS}n|${end})` : `(?=${BS}n?${end})`;
    case 'bos':
      return start;
    case 'eos':
      return end;
    case 'wb': {
      const w = wordClass(ascii);
      return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
    }
    case 'nwb': {
      const w = wordClass(ascii);
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
function manualLetter(cp: number): string {
  const lower = cp | 0x20;
  return `${literal(lower)}${literal(lower - 0x20)}${CASE_EXTRAS.get(lower) ?? ''}`;
}

/** Members of a range under manual IGNORECASE: the range, its letters in the other case, and the extras they bring. */
function manualRange(lo: number, hi: number): string {
  let out = `${literal(lo)}-${literal(hi)}`;
  const lowerLo = Math.max(lo, 0x61);
  const lowerHi = Math.min(hi, 0x7a);
  if (lowerLo <= lowerHi) out += `${literal(lowerLo - 0x20)}-${literal(lowerHi - 0x20)}`;
  const upperLo = Math.max(lo, 0x41);
  const upperHi = Math.min(hi, 0x5a);
  if (upperLo <= upperHi) out += `${literal(upperLo + 0x20)}-${literal(upperHi + 0x20)}`;
  for (const [letter, extras] of CASE_EXTRAS) {
    if ((lo <= letter && letter <= hi) || (lo <= letter - 0x20 && letter - 0x20 <= hi)) out += extras;
  }
  return out;
}

function coversCaseLetter(lo: number, hi: number): boolean {
  return (lo <= 0x49 && 0x49 <= hi) || (lo <= 0x69 && 0x69 <= hi);
}

function setSource(
  neg: boolean,
  items: readonly SetItem[],
  ignoreCase: boolean,
  ascii: boolean,
  manual: boolean,
): string {
  let out = '';
  let needsCasePair = false;
  for (const item of items) {
    if (item.t === 'lit') {
      if (ignoreCase && manual && isAsciiLetter(item.cp)) {
        out += manualLetter(item.cp);
      } else {
        out += literal(item.cp);
        if (item.cp === 0x49 || item.cp === 0x69) needsCasePair = true;
      }
    } else if (item.t === 'range') {
      if (ignoreCase && manual) {
        out += manualRange(item.lo, item.hi);
      } else {
        out += `${literal(item.lo)}-${literal(item.hi)}`;
        if (coversCaseLetter(item.lo, item.hi)) needsCasePair = true;
      }
    } else {
      out += categoryInSet(item.k, ascii);
    }
  }
  if (ignoreCase && !manual && needsCasePair) out += CASE_PAIR;
  return `[${neg ? '^' : ''}${out}]`;
}

function quantifier(min: number, max: number | null, lazy: boolean): string {
  let q: string;
  if (max === null) q = min === 0 ? '*' : min === 1 ? '+' : `{${String(min)},}`;
  else if (min === 0 && max === 1) q = '?';
  else if (min === max) q = `{${String(min)}}`;
  else q = `{${String(min)},${String(max)}}`;
  return lazy ? `${q}?` : q;
}

function emitNode(node: Node, manual: boolean): string {
  switch (node.t) {
    case 'lit':
      if (node.f.i && manual && isAsciiLetter(node.cp)) return `[${manualLetter(node.cp)}]`;
      if (node.f.i && (node.cp === 0x49 || node.cp === 0x69)) return `[iI${CASE_PAIR}]`;
      return literal(node.cp);
    case 'any':
      return node.f.s ? `[${BS}s${BS}S]` : `[^${BS}n]`;
    case 'at':
      return anchor(node.k, node.f.m, node.f.a);
    case 'set':
      return setSource(node.neg, node.items, node.f.i, node.f.a, manual);
    case 'cat':
      return categoryClass(node.k, node.f.a);
    case 'seq':
      return node.items.map((item) => emitNode(item, manual)).join('');
    case 'alt':
      return node.alts.map((alt) => emitNode(alt, manual)).join('|');
    case 'group': {
      const body = emitNode(node.body, manual);
      if (node.index === null) return `(?:${body})`;
      return node.name === null ? `(${body})` : `(?<${node.name}>${body})`;
    }
    case 'rep':
      return `${emitNode(node.body, manual)}${quantifier(node.min, node.max, node.lazy)}`;
    case 'look':
      return `(?${node.behind ? '<' : ''}${node.neg ? '!' : '='}${emitNode(node.body, manual)})`;
    case 'backref':
      return `(?:${BS}${String(node.index)})`;
  }
}

/**
 * JavaScript source for the tree. With `manual` the source never relies on the JavaScript `i` flag or on `(?i:)`
 * modifiers: letters matched case-insensitively are expanded to explicit classes.
 */
export function emit(root: Node, manual: boolean): string {
  return emitNode(root, manual);
}
