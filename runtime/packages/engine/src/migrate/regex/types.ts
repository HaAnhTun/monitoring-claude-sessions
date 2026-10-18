// Types of the Python-regex translator, which survives only in the migration of a pre-4.0 workspace (ADR 0002 amended,
// ADR 0067, design 01 section 2.8). The runtime compiles configuration patterns with `regex/compile.ts` only.

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

/** A Python pattern translated to the configuration dialect. */
export interface DialectPattern {
  /** The Python pattern as stored in the pre-4.0 `config.json`. */
  readonly source: string;
  /** The dialect pattern to store; read it back with `compileRegex(text, context)`. */
  readonly text: string;
  readonly context: PyRegexContext;
  readonly groupCount: number;
  /** Names of the named groups, in definition order. */
  readonly groupNames: readonly string[];
}

export type TranslateResult =
  { readonly ok: true; readonly value: DialectPattern } | { readonly ok: false; readonly error: PyRegexError };
