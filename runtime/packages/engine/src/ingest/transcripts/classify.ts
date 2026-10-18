// Session classification (02 5.2, T-TR-14): the port of `classify`, `user_texts`, `first_user_text` and `real_first_prompt` of
// the legacy `src/backend/sessions.py`. Pure: the input is the parsed head of a transcript, never a file.
//
// The head is the first 401 lines (indexes 0..400, an invalid or empty line consumes an index). Prompts are the user texts of
// that head that are not harness boilerplate; the first prompt, or the first user text with boilerplate included, is what the
// rules search (a JavaScript pattern compiled by `compileRegex(match, 'session_rule')`, flags `v` and `s`, registry C24). Only
// the label is kept; a session is "matched" when a rule matched or the session is pinned.
import { clipCodePoints } from '../../platform/fsx.ts';
import { applyLabelTemplate, tryCompileRegex, type CompiledRegex } from '../../regex/index.ts';

/** Number of head lines the classification may look at (legacy `i > 400` break). */
export const CLASSIFY_LINE_LIMIT = 401;
/** Lines the first user text looks at (legacy `i > 120` break). */
const FIRST_TEXT_LINE_LIMIT = 121;
/** Prompts collected for `scope: 'any'` (legacy `limit=25`). */
const USER_TEXT_LIMIT = 25;
/** Code points of an unmatched label (legacy `[:70]`). */
const UNMATCHED_LABEL_CP = 70;
const NO_PROMPT = '(no prompt)';
const DEFAULT_RULE_LABEL = 'session';

/** Harness text that is not a prompt (legacy `BOILER`). */
const BOILER = /^\s*<(local-command|ide_|browser_instruction|system-reminder|command-|user-prompt)/;

/** One rule of `session_rules`: `match` is a JavaScript regular expression (the config schema keeps unknown keys, so `name` and `scope` are read loosely). */
export interface SessionRule {
  readonly match: string;
  readonly label?: string;
  readonly name?: string;
  readonly scope?: string;
}

/** A rule as the classifier runs it: `regex` is null when the pattern does not compile (the rule is skipped). */
export interface CompiledRule {
  readonly regex: CompiledRegex | null;
  readonly template: string;
  readonly scopeAny: boolean;
}

/** One valid JSON line of the head with its 1-based line number; invalid and empty lines are absent but keep their number. */
export interface HeadRecord {
  readonly lineNo: number;
  readonly record: unknown;
}

export interface Classification {
  readonly label: string;
  readonly matched: boolean;
  /** Index into `session_rules` of the rule that matched. */
  readonly ruleIndex: number | null;
  /** The `sessions.label_source` value this result stands for. */
  readonly labelSource: 'rule' | 'first_prompt' | 'none';
  /** Head lines seen (at most 401): the classification is final once this reaches 401. */
  readonly classifiedLines: number;
}

export interface ClassifyOptions {
  /** `session_ids` lists the session: matched whatever the rules say. */
  readonly pinned: boolean;
  /** Number of head lines read, blank and invalid ones included. */
  readonly linesSeen: number;
}

/**
 * Compiles the rules in order. A rule whose pattern does not compile (invalid JavaScript, Python syntax, a modifier group)
 * stays in the list with a null regex, so the indexes are still those of the configuration and the rule is skipped.
 */
export function compileSessionRules(rules: readonly SessionRule[]): CompiledRule[] {
  return rules.map((rule) => {
    const result = tryCompileRegex(rule.match, 'session_rule');
    return {
      regex: result.ok ? result.value : null,
      template: rule.label ?? rule.name ?? DEFAULT_RULE_LABEL,
      scopeAny: rule.scope === 'any',
    };
  });
}

type Plain = Readonly<Record<string, unknown>>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text blocks of a user record (legacy `_blocks`): the string content, or the `text` of every `type: 'text'` block. */
function blocksOf(record: Plain): readonly unknown[] {
  const message = record['message'];
  const content = isPlain(message) ? message['content'] : undefined;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const blocks: unknown[] = content;
  const texts: unknown[] = [];
  for (const block of blocks) {
    if (isPlain(block) && block['type'] === 'text') texts.push(block['text'] ?? '');
  }
  return texts;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Python `str.isspace` for one code point (the set `str.strip()` removes). */
function isPySpace(code: number): boolean {
  if (code >= 9 && code <= 13) return true;
  if (code >= 0x1c && code <= 0x20) return true;
  if (code === 0x85 || code === 0xa0 || code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  return code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** Python `str.strip()`: whitespace by `isspace`, which is not the set of `String.prototype.trim` (it keeps U+FEFF, removes U+001C to U+001F). */
function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text.charCodeAt(start))) start += 1;
  while (end > start && isPySpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * The first real user texts of the head (legacy `user_texts`): within the first 401 lines, the text blocks of `user` records
 * that are not boilerplate. One record may add several; collection stops at the next line once `limit` is reached.
 */
export function userTexts(head: readonly HeadRecord[], limit: number = USER_TEXT_LIMIT): string[] {
  const out: string[] = [];
  for (const { lineNo, record } of head) {
    if (lineNo > CLASSIFY_LINE_LIMIT || out.length >= limit) break;
    if (!isPlain(record) || record['type'] !== 'user') continue;
    for (const text of blocksOf(record)) {
      if (nonEmpty(text) && !BOILER.test(text)) out.push(text);
    }
  }
  return out;
}

/** The first non-empty text block of a `user` record within the first 121 lines, boilerplate included (legacy `first_user_text`). */
function firstUserText(head: readonly HeadRecord[]): string {
  for (const { lineNo, record } of head) {
    if (lineNo > FIRST_TEXT_LINE_LIMIT) break;
    if (!isPlain(record) || record['type'] !== 'user') continue;
    for (const text of blocksOf(record)) if (nonEmpty(text)) return text;
  }
  return '';
}

/** The first prompt (legacy `real_first_prompt`): `userTexts()[0]`, else the first user text. Used by `discover` (01 6.4). */
export function realFirstPrompt(head: readonly HeadRecord[]): string {
  return userTexts(head, 1)[0] ?? firstUserText(head);
}

/**
 * The label of a session (02 5.2). The first rule that matches wins; an unmatched session is labelled by its first prompt,
 * stripped, with LF replaced by a space, cut at 70 code points, else `(no prompt)`.
 */
export function classify(
  head: readonly HeadRecord[],
  rules: readonly CompiledRule[],
  options: ClassifyOptions,
): Classification {
  const classifiedLines = Math.min(Math.max(options.linesSeen, 0), CLASSIFY_LINE_LIMIT);
  const first = realFirstPrompt(head);
  let anyText: string | null = null;
  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule.regex === null) continue;
    let text = first;
    if (rule.scopeAny) {
      anyText ??= userTexts(head).join('\n');
      text = anyText;
    }
    const match = rule.regex.exec(text);
    if (match !== null) {
      return {
        label: applyLabelTemplate(rule.template, match),
        matched: true,
        ruleIndex,
        labelSource: 'rule',
        classifiedLines,
      };
    }
  }
  const stripped = pyStrip(first).split('\n').join(' ');
  const label = clipCodePoints(stripped.slice(0, UNMATCHED_LABEL_CP * 2), UNMATCHED_LABEL_CP);
  return {
    label: label === '' ? NO_PROMPT : label,
    matched: options.pinned,
    ruleIndex: null,
    labelSource: label === '' ? 'none' : 'first_prompt',
    classifiedLines,
  };
}
