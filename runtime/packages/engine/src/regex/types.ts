// Public types of the configuration regex dialect (ADR 0067, design 01 section 2.8): JavaScript `v`-mode patterns.

/** Where the pattern is used: a searched session rule (`s` flag) or an attempts line matched at position 0 (`y` flag). */
export type RegexContext = 'session_rule' | 'attempts';

/** A match; offsets count code points, not UTF-16 units. */
export interface RegexMatch {
  readonly start: number;
  readonly end: number;
  /** Group `n` (0 is the whole match); `null` when the group did not take part. Throws `RangeError` for an unknown group. */
  group(n: number): string | null;
  /** Groups 1..n, `null` for a group that did not take part. */
  groups(): (string | null)[];
  /** Named groups in definition order, `null` for a group that did not take part. */
  groupdict(): Record<string, string | null>;
}

export interface CompiledRegex {
  /** The JavaScript regular expression; for `attempts` it is sticky, so set `lastIndex = 0` before calling `exec` on it yourself. */
  readonly regex: RegExp;
  readonly context: RegexContext;
  readonly groupCount: number;
  /** Names of the named groups, in definition order. */
  readonly groupNames: readonly string[];
  /** Search for a session rule, match at position 0 for attempts. Never reads state left by a previous call. */
  exec(text: string): RegexMatch | null;
}
