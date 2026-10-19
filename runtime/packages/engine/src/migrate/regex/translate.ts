// Python regex to the configuration dialect (ADR 0002 amended, ADR 0067, design 01 section 2.8), for the migration of a
// pre-4.0 workspace only. A pattern is accepted only when the translation is exact for the supported constructs (INV-07);
// everything else is refused here, loudly, with the construct class as `code` and a position in code points.
//
// The dialect compiles every pattern with fixed flags (`sv` for a session rule, `vy` for attempts) and has no `i` flag,
// so the emitter expands case-insensitive letters by hand and never relies on the `i` or `m` flag. The text is the
// readable dialect text of ADR 0067 (WP-138): printable characters stay literal, `^` and `$` are used where they mean
// the same, and only a session rule relies on the `s` flag, for a dot that DOTALL leaves in force. The text therefore
// means the same under the dialect flags.
import { RegexCompileError, compileRegex } from '../../regex/index.ts';
import { PyRegexFailure } from './ast.ts';
import { checkExactness } from './analyze.ts';
import { emit } from './emit.ts';
import { parsePyRegex } from './parser.ts';
import type { DialectPattern, PyRegexContext, TranslateResult } from './types.ts';

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * The self-check: the dialect compiler must accept the text (it also forces V8 to compile it for both subject widths, so
 * "too large" and stack overflows are refused now) and see the groups that the Python parser saw.
 */
function checkDialect(text: string, ctx: PyRegexContext, groupCount: number, groupNames: readonly string[]): void {
  let compiled;
  try {
    compiled = compileRegex(text, ctx);
  } catch (error) {
    if (!(error instanceof RegexCompileError)) throw error;
    throw new PyRegexFailure(
      'JS_COMPILE',
      `the translated pattern is not a valid dialect pattern: ${error.reason}`,
      null,
    );
  }
  if (compiled.groupCount !== groupCount || !sameNames(compiled.groupNames, groupNames)) {
    throw new PyRegexFailure(
      'JS_COMPILE',
      'the translated pattern does not keep the groups of the Python pattern',
      null,
    );
  }
}

function translateOrThrow(source: string, ctx: PyRegexContext): DialectPattern {
  const parsed = parsePyRegex(source, ctx);
  checkExactness(parsed.root, parsed.groupCount);
  const text = emit(parsed.root, ctx);
  checkDialect(text, ctx, parsed.groupCount, parsed.groupNames);
  return { source, text, context: ctx, groupCount: parsed.groupCount, groupNames: parsed.groupNames };
}

/**
 * Translate a Python pattern for the given context. `session_rule` is `re.search(p, text, re.S)`, `attempts` is
 * `re.match(p, line)`. Never throws for a bad pattern; the error names the construct and the position.
 */
export function translateToDialect(source: string, ctx: PyRegexContext): TranslateResult {
  try {
    return { ok: true, value: translateOrThrow(source, ctx) };
  } catch (error) {
    if (error instanceof PyRegexFailure) {
      return { ok: false, error: { code: error.code, message: error.message, position: error.position } };
    }
    if (error instanceof RangeError) {
      return {
        ok: false,
        error: { code: 'UNSUPPORTED_CONSTRUCT', message: 'the pattern is nested too deeply', position: null },
      };
    }
    throw error;
  }
}
