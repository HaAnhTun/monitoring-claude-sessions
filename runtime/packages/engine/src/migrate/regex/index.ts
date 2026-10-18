// Python regex to configuration dialect, for the migration of a pre-4.0 workspace only (ADR 0002 amended, ADR 0067).
export type { DialectPattern, PyRegexContext, PyRegexError, PyRegexErrorCode, TranslateResult } from './types.ts';
export { translateToDialect } from './translate.ts';
