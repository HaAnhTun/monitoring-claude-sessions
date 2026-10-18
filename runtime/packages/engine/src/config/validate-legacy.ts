// Validation of the legacy (L) keys (01 section 2.4): the predicate table of `config.py` `SCHEMA` with the legacy messages
// (not Zod, so the strings stay byte for byte), plus the documented Node-only additions. The predicates run on the parsed
// `PyJsonValue` so that, as in Python, `true` is not a number and `1.0` is not an integer.
import { McsError } from '@mcs/shared';

import { dumpPyJson, pyRepr, type PyJsonValue } from '../pyjson/index.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { isMsysPath } from '../platform/paths.ts';
import { pyStrptimeValidate } from '../platform/pytime.ts';
import {
  PYTHON_SYNTAX_HINT,
  tryCompileRegex,
  type CompiledRegex,
  type RegexCompileError,
  type RegexContext,
} from '../regex/index.ts';

export interface LegacyKeySpec {
  /** The legacy predicate. */
  readonly check: (v: PyJsonValue) => boolean;
  /** The text after `expected` in the message. */
  readonly expected: string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function isNum(v: PyJsonValue): boolean {
  return v.k === 'int' || v.k === 'float';
}

function isPositive(v: PyJsonValue): boolean {
  if (v.k === 'int') return v.v > 0n;
  return v.k === 'float' && v.v > 0;
}

/** Python `str.isspace` for one code point (Unicode White_Space plus the C0 separators 0x1c-0x1f). */
function isPySpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function isNonBlank(s: string): boolean {
  for (const ch of s) if (!isPySpace(ch.codePointAt(0) ?? 0)) return true;
  return false;
}

function isStr(v: PyJsonValue | undefined): v is Extract<PyJsonValue, { k: 'str' }> {
  return v?.k === 'str';
}

function entry(v: PyJsonValue, key: string): PyJsonValue | undefined {
  return v.k === 'obj' ? v.v.find(([k]) => k === key)?.[1] : undefined;
}

function strList(v: PyJsonValue): boolean {
  return v.k === 'arr' && v.v.every((x) => x.k === 'str');
}

function optStr(v: PyJsonValue): boolean {
  return v.k === 'null' || v.k === 'str';
}

function rules(v: PyJsonValue): boolean {
  return v.k === 'arr' && v.v.every((r) => r.k === 'obj' && isStr(entry(r, 'match')));
}

function dictOf(v: PyJsonValue, member: (x: PyJsonValue) => boolean): boolean {
  return v.k === 'obj' && v.v.every(([, x]) => member(x));
}

function oneOf(v: PyJsonValue | undefined, allowed: readonly string[]): boolean {
  return v === undefined || (v.k === 'str' && allowed.includes(v.v));
}

function ui(v: PyJsonValue): boolean {
  return (
    v.k === 'obj' &&
    oneOf(entry(v, 'theme'), ['auto', 'light', 'dark']) &&
    oneOf(entry(v, 'density'), ['comfortable', 'compact']) &&
    v.v.every(([k, x]) => k === 'theme' || k === 'density' || x.k === 'bool')
  );
}

function attempts(v: PyJsonValue): boolean {
  return v.k === 'null' || (v.k === 'obj' && isStr(entry(v, 'start')) && isStr(entry(v, 'end')));
}

/** `config.py` `SCHEMA`: key to predicate and expected text, in the legacy order (the order of the keys in the table, not of a file). */
export const LegacyConfigFileSchema: Readonly<Record<string, LegacyKeySpec>> = {
  schema_version: { check: (v) => v.k === 'int', expected: 'integer' },
  title: { check: (v) => v.k === 'str' && isNonBlank(v.v), expected: 'non-empty string' },
  port: { check: (v) => v.k === 'int' && v.v >= 1n && v.v <= 65535n, expected: 'integer 1-65535' },
  repo: { check: (v) => v.k === 'str', expected: 'string path' },
  transcripts_dir: { check: (v) => v.k === 'str' || v.k === 'null', expected: "'auto' or a path" },
  window_hours: { check: isPositive, expected: 'positive number' },
  active_seconds: { check: isPositive, expected: 'positive number' },
  pending_tool_grace_seconds: { check: isPositive, expected: 'positive number' },
  include_unmatched: { check: (v) => v.k === 'bool', expected: 'boolean' },
  session_rules: { check: rules, expected: 'list of {match, label, scope?}' },
  session_ids: { check: strList, expected: 'list of session id strings' },
  panels: { check: (v) => dictOf(v, (x) => x.k === 'bool'), expected: 'object of booleans' },
  live_log_globs: { check: strList, expected: 'list of strings' },
  chain_log: { check: optStr, expected: 'string or null' },
  ledger: { check: optStr, expected: 'string or null' },
  stop_file: { check: optStr, expected: 'string or null' },
  attempts: { check: attempts, expected: 'null or {start, end, ...}' },
  watched_processes: { check: strList, expected: 'list of strings' },
  docker: { check: (v) => v.k === 'bool', expected: 'boolean' },
  ui: { check: ui, expected: 'object: theme auto|light|dark, density comfortable|compact, booleans' },
  poll: { check: (v) => dictOf(v, isNum), expected: 'object of numbers (milliseconds)' },
  limits: { check: (v) => dictOf(v, isNum), expected: 'object of numbers' },
};

export const LEGACY_KEYS: readonly string[] = Object.keys(LegacyConfigFileSchema);

export interface LegacyValidateOptions {
  /** `true` for a workspace `config.json` (unknown keys are problems); `false` ignores them (legacy flat files). */
  readonly strict: boolean;
  /** Platform for the `/c/...` rule; the host by default (tests pass another). */
  readonly platform?: HostPlatform;
}

/** `json.dumps(v)[:60]` of the legacy messages: ASCII JSON text, cut at 60 characters. */
function shortJson(v: PyJsonValue): string {
  return dumpPyJson(v, { compact: true, asciiOnly: true }).slice(0, 60);
}

/** Node-only: finite numbers and integers within 2^53-1 (`path` is the dotted key). */
function numberProblems(path: string, v: PyJsonValue): string[] {
  if (v.k === 'float' && !Number.isFinite(v.v)) return [`${path}: expected finite number`];
  if (v.k === 'int' && (v.v > MAX_SAFE || v.v < -MAX_SAFE)) {
    return [`${path}: expected integer within 2^53-1, got ${shortJson(v)}`];
  }
  return [];
}

const MSYS_MESSAGE = 'use C:/... instead of /c/...';

function pathProblems(path: string, v: PyJsonValue | undefined, platform: HostPlatform): string[] {
  return isStr(v) && isMsysPath(v.v, platform) ? [`${path}: ${MSYS_MESSAGE}`] : [];
}

function attemptsProblems(a: PyJsonValue): string[] {
  const out: string[] = [];
  const timeFormat = entry(a, 'time_format');
  if (timeFormat !== undefined) {
    if (!isStr(timeFormat)) out.push('attempts.time_format: expected string');
    else {
      const message = pyStrptimeValidate(timeFormat.v);
      if (message !== null) out.push(message);
    }
  }
  const prefix = entry(a, 'label_prefix');
  if (prefix !== undefined && !isStr(prefix)) out.push('attempts.label_prefix: expected string');
  return out;
}

/** The additions of 01 2.4 for one key whose legacy predicate passed. */
function nodeProblems(key: string, v: PyJsonValue, platform: HostPlatform): string[] {
  switch (key) {
    case 'window_hours':
    case 'active_seconds':
    case 'pending_tool_grace_seconds':
      return numberProblems(key, v);
    case 'poll':
    case 'limits':
      return v.k === 'obj' ? v.v.flatMap(([k, x]) => numberProblems(`${key}.${k}`, x)) : [];
    case 'session_rules':
      return v.k === 'arr'
        ? v.v.flatMap((r, i) => {
            const label = entry(r, 'label');
            return label !== undefined && !isStr(label) ? [`session_rules[${String(i)}].label: expected string`] : [];
          })
        : [];
    case 'attempts':
      return v.k === 'obj' ? attemptsProblems(v) : [];
    case 'repo':
    case 'transcripts_dir':
    case 'chain_log':
    case 'ledger':
    case 'stop_file':
      return pathProblems(key, v, platform);
    case 'live_log_globs':
      return v.k === 'arr' ? v.v.flatMap((g, i) => pathProblems(`live_log_globs[${String(i)}]`, g, platform)) : [];
    default:
      return [];
  }
}

/** The reason of a refused pattern, with the migration hint when it uses a Python-only construct. */
function refusalText(error: RegexCompileError): string {
  return error.pythonSyntax ? `${error.reason}; ${PYTHON_SYNTAX_HINT}` : error.reason;
}

/**
 * A pattern that is not a JavaScript regular expression (or that V8 cannot compile, which is forced here) is a validation
 * problem, so it is `CONFIG_INVALID` at check, configure and start time.
 */
function syntaxProblem(source: string, context: RegexContext): string | null {
  const result = tryCompileRegex(source, context);
  return result.ok ? null : refusalText(result.error);
}

function regexProblems(doc: Extract<PyJsonValue, { k: 'obj' }>): string[] {
  const out: string[] = [];
  const ruleList = entry(doc, 'session_rules');
  if (ruleList !== undefined && rules(ruleList) && ruleList.k === 'arr') {
    for (const rule of ruleList.v) {
      const match = entry(rule, 'match');
      if (!isStr(match)) continue;
      const message = syntaxProblem(match.v, 'session_rule');
      if (message !== null) out.push(`session_rules: invalid regex ${pyRepr(match.v)} (${message})`);
    }
  }
  const a = entry(doc, 'attempts');
  if (a?.k === 'obj') {
    for (const k of ['start', 'end'] as const) {
      const pattern = entry(a, k);
      if (!isStr(pattern)) continue;
      const message = syntaxProblem(pattern.v, 'attempts');
      if (message !== null) out.push(`attempts.${k}: invalid regex (${message})`);
    }
  }
  return out;
}

/**
 * Problems with a (partial or full) configuration, empty when valid: key order of the file, then regex problems (legacy
 * order). Messages are the legacy strings; the Node-only additions of 01 2.4 follow the key they belong to.
 */
export function validateLegacy(doc: PyJsonValue, options: LegacyValidateOptions): string[] {
  if (doc.k !== 'obj') return ['config must be a JSON object'];
  const platform = options.platform ?? hostPlatform;
  const problems: string[] = [];
  for (const [key, value] of doc.v) {
    if (key.startsWith('_')) continue;
    const spec = Object.hasOwn(LegacyConfigFileSchema, key) ? LegacyConfigFileSchema[key] : undefined;
    if (spec === undefined) {
      if (options.strict) problems.push(`unknown key ${pyRepr(key)}`);
      continue;
    }
    if (!spec.check(value)) {
      problems.push(`${key}: expected ${spec.expected}, got ${shortJson(value)}`);
      continue;
    }
    problems.push(...nodeProblems(key, value, platform));
  }
  problems.push(...regexProblems(doc));
  return problems;
}

// ---- step 7: compile the patterns

export interface CompiledPatterns {
  /** One compiled pattern per `session_rules[i].match`, same order (context `session_rule`: search, flag `s`). */
  readonly sessionRules: readonly CompiledRegex[];
  /** `attempts.start` and `attempts.end` (context `attempts`: match at position 0), `null` when `attempts` is null. */
  readonly attempts: { readonly start: CompiledRegex; readonly end: CompiledRegex } | null;
}

interface PatternSource {
  readonly session_rules: readonly { readonly match: string }[];
  readonly attempts: { readonly start: string; readonly end: string } | null;
}

interface PatternFailure {
  readonly where: string;
  readonly pythonSyntax: boolean;
  readonly message: string;
}

function tryCompile(
  source: string,
  context: RegexContext,
  where: string,
  failures: PatternFailure[],
): CompiledRegex | null {
  const result = tryCompileRegex(source, context);
  if (result.ok) return result.value;
  failures.push({ where, pythonSyntax: result.error.pythonSyntax, message: refusalText(result.error) });
  return null;
}

/**
 * Step 7 of `resolveConfig`: compiles every pattern. Validation already refuses an invalid pattern, so a failure here is a
 * caller that skipped it; it is `CONFIG_INVALID` too, the message lists every failing pattern as
 * `session_rules[1]: <reason>` or `attempts.end: <reason>` and never repeats a pattern text.
 */
export function compileConfigPatterns(source: PatternSource): CompiledPatterns {
  const failures: PatternFailure[] = [];
  const sessionRules: CompiledRegex[] = [];
  source.session_rules.forEach((rule, i) => {
    const compiled = tryCompile(rule.match, 'session_rule', `session_rules[${String(i)}]`, failures);
    if (compiled !== null) sessionRules.push(compiled);
  });
  let compiledAttempts: CompiledPatterns['attempts'] = null;
  if (source.attempts !== null) {
    const start = tryCompile(source.attempts.start, 'attempts', 'attempts.start', failures);
    const end = tryCompile(source.attempts.end, 'attempts', 'attempts.end', failures);
    if (start !== null && end !== null) compiledAttempts = { start, end };
  }
  if (failures.length > 0) {
    const python = failures.some((f) => f.pythonSyntax);
    throw new McsError('CONFIG_INVALID', failures.map((f) => `${f.where}: invalid regex (${f.message})`).join('; '), {
      hint: python
        ? 'Run `mcs migrate-workspace --task <slug>` (dry run first) to convert Python regex syntax.'
        : 'Write the pattern as a JavaScript regular expression (v flag rules; see docs/configuration.md).',
      details: { patterns: failures.map((f) => ({ where: f.where, pythonSyntax: f.pythonSyntax })) },
    });
  }
  return { sessionRules, attempts: compiledAttempts };
}
