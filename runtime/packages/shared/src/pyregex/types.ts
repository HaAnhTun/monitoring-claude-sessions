// Public types of the Python-regex translator (design 01 section 2.8, ADR 0002, registry 1.9).

/** Where the pattern is used: `re.search(p, text, re.S)` for a session rule, `re.match(p, line)` for attempts. */
export type PyRegexContext = 'session_rule' | 'attempts';

export type PyRegexErrorCode =
  'SYNTAX' | 'UNSUPPORTED_CONSTRUCT' | 'UNSUPPORTED_FLAG' | 'INEXACT_SEMANTICS' | 'JS_COMPILE';

/** `position` counts code points of the Python pattern; `null` when no single position applies. */
export interface PyRegexError {
  readonly code: PyRegexErrorCode;
  readonly message: string;
  readonly position: number | null;
}

export interface TranslatedPattern {
  /** The Python pattern as stored in `config.json`. */
  readonly source: string;
  /** The JavaScript `v`-mode source. */
  readonly jsSource: string;
  /** `v`, plus `i` for a global IGNORECASE and `y` for `attempts`, in canonical order. */
  readonly jsFlags: string;
  readonly groupCount: number;
  /** Names of the named groups, in definition order. */
  readonly groupNames: readonly string[];
  readonly mode: 'search' | 'match';
}

/** A match with Python's `re.Match` accessors; offsets count code points, not UTF-16 units. */
export interface PyMatch {
  readonly start: number;
  readonly end: number;
  /** Group `n` (0 is the whole match); `null` when the group did not take part. Throws `RangeError` for an unknown group. */
  group(n: number): string | null;
  /** Groups 1..n like `m.groups()`. */
  groups(): (string | null)[];
  /** Named groups like `m.groupdict()`, in definition order. */
  groupdict(): Record<string, string | null>;
}

export interface CompiledPyRegex {
  readonly t: TranslatedPattern;
  /** The JavaScript regular expression; for `attempts` it is sticky, so set `lastIndex = 0` before calling `exec` yourself. */
  readonly regex: RegExp;
  /** `search` for session rules, `match` at position 0 for attempts. */
  exec(text: string): PyMatch | null;
}
