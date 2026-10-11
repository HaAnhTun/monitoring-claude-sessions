// Python regex to JavaScript `v`-mode translation (design 01 section 2.8, ADR 0002).
// A pattern is accepted only when the translation is exact for the supported constructs (INV-07); everything else is
// refused here, loudly, with the construct class as `code` and a position in code points.
import { PyRegexFailure } from './ast.ts';
import { checkExactness } from './analyze.ts';
import { emit } from './emit.ts';
import { parsePyRegex } from './parser.ts';
import type { PyRegexContext, PyRegexError, TranslatedPattern } from './types.ts';

function jsFlagsFor(ctx: PyRegexContext, ignoreCase: boolean): string {
  return `${ignoreCase ? 'i' : ''}v${ctx === 'attempts' ? 'y' : ''}`;
}

/**
 * V8 compiles a RegExp lazily, per subject width (one-byte and two-byte), so `new RegExp` alone never reports "Regular
 * expression too large" or a stack overflow; the first `exec` would, again on every call. Run both widths once here so
 * that the refusal happens at check, configure and start time, as a `JS_COMPILE` error. The probe subjects have no
 * characters to scan, so the run is instant whatever the pattern is.
 */
function forceCompilation(jsSource: string, jsFlags: string): void {
  try {
    const regex = new RegExp(jsSource, jsFlags);
    regex.exec('');
    regex.exec(String.fromCharCode(0x100));
  } catch (error) {
    throw new PyRegexFailure(
      'JS_COMPILE',
      `the translated pattern is not a valid JavaScript regular expression: ${engineReason(error, jsFlags)}`,
      null,
    );
  }
}

/** V8's reason without its leading `Invalid regular expression: /source/flags:`, which would repeat the pattern. */
function engineReason(error: unknown, jsFlags: string): string {
  if (!(error instanceof Error)) return 'unknown error';
  const marker = `/${jsFlags}: `;
  const at = error.message.lastIndexOf(marker);
  return at >= 0 ? error.message.slice(at + marker.length) : 'the engine refused the pattern';
}

function translateOrThrow(source: string, ctx: PyRegexContext): TranslatedPattern {
  const parsed = parsePyRegex(source, ctx);
  checkExactness(parsed.root, parsed.groupCount);
  const jsSource = emit(parsed.root, parsed.manualIgnoreCase);
  const jsFlags = jsFlagsFor(ctx, parsed.globalIgnoreCase && !parsed.manualIgnoreCase);
  forceCompilation(jsSource, jsFlags);
  return {
    source,
    jsSource,
    jsFlags,
    groupCount: parsed.groupCount,
    groupNames: parsed.groupNames,
    mode: ctx === 'attempts' ? 'match' : 'search',
  };
}

/**
 * Translate a Python pattern for the given context. `session_rule` is `re.search(p, text, re.S)`, `attempts` is
 * `re.match(p, line)`. Never throws for a bad pattern; the error names the construct and the position.
 */
export function translatePyRegex(
  source: string,
  ctx: PyRegexContext,
): { ok: true; value: TranslatedPattern } | { ok: false; error: PyRegexError } {
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
