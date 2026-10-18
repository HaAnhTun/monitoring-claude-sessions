// The pattern step of `mcs migrate-workspace` (ADR 0068, ADR 0067): which configuration patterns of a pre-4.0 workspace
// are translated from Python syntax, which are kept as written and which block the migration. Nothing here reads or writes
// a file, and no result ever holds a pattern text except the translated text that the caller stores.
import { dumpPyJson, type PyJsonValue } from '../pyjson/index.ts';
import { tryCompileRegex, type RegexContext } from '../regex/index.ts';
import { translateToDialect } from './regex/index.ts';

type PyObject = Extract<PyJsonValue, { k: 'obj' }>;

/** One configuration pattern and what the migration does with it. `code` and `position` only for `blocked`. */
export interface PatternStep {
  /** `session_rules[0].match`, `attempts.start` or `attempts.end`. */
  readonly where: string;
  readonly action: 'translate' | 'keep' | 'blocked';
  /** The refusal class of the translator (`SYNTAX`, `UNSUPPORTED_CONSTRUCT`, ...). */
  readonly code?: string;
  /** Code point of the refused construct in the Python pattern, when one position applies. */
  readonly position?: number;
}

export interface PatternPlan {
  readonly steps: readonly PatternStep[];
  /** The configuration with every `translate` step applied (the same object when nothing is translated). */
  readonly doc: PyObject;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

interface Located {
  readonly where: string;
  readonly context: RegexContext;
  readonly source: string;
  /** Builds the configuration with this pattern replaced by `text`. */
  readonly replace: (doc: PyObject, text: string) => PyObject;
}

function entryOf(doc: PyObject, key: string): PyJsonValue | undefined {
  return doc.v.find(([k]) => k === key)?.[1];
}

function withEntry(doc: PyObject, key: string, value: PyJsonValue): PyObject {
  return { k: 'obj', v: doc.v.map(([k, v]): [string, PyJsonValue] => (k === key ? [k, value] : [k, v])) };
}

/** Every string pattern of `session_rules[].match`, `attempts.start` and `attempts.end`, in file order. */
function locatePatterns(doc: PyObject): Located[] {
  const found: Located[] = [];
  const rules = entryOf(doc, 'session_rules');
  if (rules?.k === 'arr') {
    rules.v.forEach((rule, index) => {
      if (rule.k !== 'obj') return;
      const match = entryOf(rule, 'match');
      if (match?.k !== 'str') return;
      found.push({
        where: `session_rules[${String(index)}].match`,
        context: 'session_rule',
        source: match.v,
        replace: (current, text) => {
          const list = entryOf(current, 'session_rules');
          if (list?.k !== 'arr') return current;
          const item = list.v[index];
          if (item?.k !== 'obj') return current;
          const next = list.v.slice();
          next[index] = withEntry(item, 'match', { k: 'str', v: text });
          return withEntry(current, 'session_rules', { k: 'arr', v: next });
        },
      });
    });
  }
  const attempts = entryOf(doc, 'attempts');
  if (attempts?.k === 'obj') {
    for (const key of ['start', 'end'] as const) {
      const pattern = entryOf(attempts, key);
      if (pattern?.k !== 'str') continue;
      found.push({
        where: `attempts.${key}`,
        context: 'attempts',
        source: pattern.v,
        replace: (current, text) => {
          const block = entryOf(current, 'attempts');
          if (block?.k !== 'obj') return current;
          return withEntry(current, 'attempts', withEntry(block, key, { k: 'str', v: text }));
        },
      });
    }
  }
  return found;
}

function compiles(source: string, context: RegexContext): boolean {
  return tryCompileRegex(source, context).ok;
}

function keptWarning(where: string): string {
  return `${where}: kept as written (it compiles as a JavaScript regular expression; check its meaning once)`;
}

/**
 * Plans the patterns of `doc`. Without `instance.json` every pattern is Python-era and is translated; with it only a
 * pattern that does not compile as JavaScript is. A pattern that compiles is kept (a warning names it), also when the
 * translator refuses it. A pattern that neither translates exactly nor compiles is `blocked` (`REGEX_UNSUPPORTED`).
 */
export function planPatterns(doc: PyObject, hasInstance: boolean): PatternPlan {
  const steps: PatternStep[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let next = doc;
  for (const p of locatePatterns(doc)) {
    const valid = compiles(p.source, p.context);
    if (hasInstance && valid) {
      steps.push({ where: p.where, action: 'keep' });
      warnings.push(keptWarning(p.where));
      continue;
    }
    const translated = translateToDialect(p.source, p.context);
    if (translated.ok) {
      if (translated.value.text === p.source) {
        steps.push({ where: p.where, action: 'keep' });
      } else {
        steps.push({ where: p.where, action: 'translate' });
        next = p.replace(next, translated.value.text);
      }
      continue;
    }
    if (valid) {
      steps.push({ where: p.where, action: 'keep' });
      warnings.push(keptWarning(p.where));
      continue;
    }
    const { code, position } = translated.error;
    steps.push({ where: p.where, action: 'blocked', code, ...(position === null ? {} : { position }) });
    const at = position === null ? '' : ` at code point ${String(position)}`;
    blockers.push(
      `REGEX_UNSUPPORTED: ${p.where} cannot be translated exactly (${code}${at}) and is not valid JavaScript`,
    );
  }
  return { steps, doc: next, blockers, warnings };
}

/** True when the two configurations are the same JSON text (entry order included). */
export function sameConfig(a: PyJsonValue, b: PyJsonValue): boolean {
  return dumpPyJson(a, { indent: 2 }) === dumpPyJson(b, { indent: 2 });
}
