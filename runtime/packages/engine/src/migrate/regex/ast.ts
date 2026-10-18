// Internal syntax tree of the translator: a typed subset of CPython's sre_parse output.
import type { PyRegexErrorCode } from './types.ts';

/** Flags in force at a node (global flags plus the enclosing scoped flag groups). */
export interface Flags {
  readonly i: boolean;
  readonly m: boolean;
  readonly s: boolean;
  readonly a: boolean;
}

export type CategoryKey = 'd' | 'D' | 'w' | 'W' | 's' | 'S';

export type SetItem =
  | { readonly t: 'lit'; readonly cp: number }
  | { readonly t: 'range'; readonly lo: number; readonly hi: number }
  | { readonly t: 'cat'; readonly k: CategoryKey };

export type AnchorKey = 'bol' | 'eol' | 'bos' | 'eos' | 'wb' | 'nwb';

export type Node =
  | { readonly t: 'lit'; readonly cp: number; readonly f: Flags }
  | { readonly t: 'any'; readonly f: Flags }
  | { readonly t: 'at'; readonly k: AnchorKey; readonly f: Flags }
  | { readonly t: 'set'; readonly neg: boolean; readonly items: readonly SetItem[]; readonly f: Flags }
  | { readonly t: 'cat'; readonly k: CategoryKey; readonly f: Flags }
  | {
      readonly t: 'group';
      /** 1-based capture index, or `null` for `(?:...)` and `(?flags:...)`. */
      readonly index: number | null;
      readonly name: string | null;
      readonly body: Node;
      readonly pos: number;
    }
  | { readonly t: 'seq'; readonly items: readonly Node[] }
  | { readonly t: 'alt'; readonly alts: readonly Node[] }
  | {
      readonly t: 'rep';
      readonly min: number;
      /** `null` is unbounded. */
      readonly max: number | null;
      readonly lazy: boolean;
      readonly body: Node;
      readonly pos: number;
    }
  | { readonly t: 'look'; readonly behind: boolean; readonly neg: boolean; readonly body: Node; readonly pos: number }
  | { readonly t: 'backref'; readonly index: number; readonly pos: number };

/** What the parser hands to the analysis and the emitter. */
export interface ParsedPattern {
  readonly root: Node;
  readonly groupCount: number;
  readonly groupNames: readonly string[];
  /** Global IGNORECASE: becomes the JavaScript `i` flag unless `manualIgnoreCase` is set. */
  readonly globalIgnoreCase: boolean;
  /**
   * A scoped flag group switches IGNORECASE on or off somewhere in the pattern. V8 13.6 evaluates the character classes
   * that follow a JavaScript `(?i:...)` or `(?-i:...)` modifier with the wrong case mode in `v` mode, so such a pattern
   * is emitted without the `i` flag and without modifiers: every letter that is matched case-insensitively is expanded by hand.
   * A global IGNORECASE together with `\w`, `\W`, `` or `\B` takes the same route, because the JavaScript `i` flag folds
   * U+0345 into the letter iota and Python does not.
   */
  readonly manualIgnoreCase: boolean;
}

/** The one exception of the translator; `translatePyRegex` turns it into a result value. */
export class PyRegexFailure extends Error {
  readonly code: PyRegexErrorCode;
  readonly position: number | null;

  constructor(code: PyRegexErrorCode, message: string, position: number | null) {
    super(message);
    this.name = 'PyRegexFailure';
    this.code = code;
    this.position = position;
  }
}
