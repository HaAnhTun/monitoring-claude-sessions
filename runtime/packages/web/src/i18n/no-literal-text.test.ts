// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LITERAL_BASELINE } from './literal-baseline.ts';

// The audit of ADR 0072 decision 6: no user-facing text is written in a component. It parses every non-test source file of the
// web package with the TypeScript compiler API and reports
//   - JSX text that contains a letter                                    (rule jsx-text)
//   - a string in a user-facing JSX attribute                            (attribute)
//   - a string shown as a JSX child, or chosen between with ?: && ||     (jsx-child)
//   - a string in a label-like property or variable                      (label)
//   - a sentence passed to announce or showToast, or held by a *Label, *Text or *Message property or variable   (sentence)
//   - a template literal that reads as a sentence                        (template)
//   - a capitalised phrase of plain words in a value position ('Tool calls')   (phrase)
//   - an Intl constructor or a toLocale*String call that names a locale or takes the browser default   (intl)
// Class names, ids, routes, query keys and `throw new Error` diagnostics are technical and exempt. A file that is not converted
// yet is listed in `literal-baseline.ts` (one block per work package): the test fails for a violation outside the list and for a
// listed file that no longer has one, so the list only shrinks. It must be empty when the last UI work package lands.

type Rule = 'jsx-text' | 'attribute' | 'jsx-child' | 'label' | 'sentence' | 'template' | 'phrase' | 'intl';

interface Violation {
  rule: Rule;
  line: number;
  excerpt: string;
}

/** Files whose English text is permanent, each with the reason. */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  'data/api-errors.ts':
    'ApiError.message is an English diagnostic for logs; the UI derives its text from ApiError.info through the catalogue (ADR 0072 decision 5)',
  'data/api-client.ts':
    'ApiError.message is an English diagnostic for logs; the UI derives its text from ApiError.info through the catalogue (ADR 0072 decision 5)',
};

const USER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'caption',
  'tip',
  'subject',
  'noun',
  'description',
  'summary',
  'heading',
]);

/** Property names that hold display text whatever the value (a single word counts). */
const LABEL_NAMES: ReadonlySet<string> = new Set([
  'label',
  'title',
  'description',
  'tip',
  'hint',
  'header',
  'placeholder',
  'text',
  'message',
  'noun',
  'caption',
  'summary',
  'subject',
  'heading',
]);

const SENTENCE_SUFFIX = /(Labels?|Texts?|Messages?|_LABELS?|_TEXTS?|_MESSAGES?)$/;
/** A constant that maps ids to display names: every string it holds is shown. */
const LABEL_TABLE = /(Labels|Titles|_LABELS|_TITLES)$/;
const SENTENCE_CALLS: ReadonlySet<string> = new Set(['announce', 'showToast']);
const TECHNICAL_ELEMENTS: ReadonlySet<string> = new Set(['code', 'kbd', 'samp', 'pre', 'var']);
const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);
const INTL_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'NumberFormat',
  'DateTimeFormat',
  'RelativeTimeFormat',
  'PluralRules',
  'ListFormat',
  'Collator',
  'DisplayNames',
  'Segmenter',
]);
const TO_LOCALE_STRING: ReadonlySet<string> = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

/** Stands for a non-literal part of a template or a concatenation. */
const SLOT = String.fromCharCode(1);
/** A key of the catalogue ('state.working'): a table may hold keys instead of text. */
const MESSAGE_KEY = /^[a-z][A-Za-z0-9]*(?:[.][A-Za-z0-9_-]+)+$/;
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/g;
// A plain word: two or more letters with a lowercase one, an apostrophe inside, punctuation around. "is-loading", "foo/bar",
// "x2", "KB" and "B" are not words (class names, paths, unit symbols).
const WORD = /^[\p{Ps}\p{Pi}"']?\p{L}[\p{L}'\p{Pf}]*[\p{Pe}\p{Pf}\p{Po}"']*$/u;

// A capitalised phrase: 'Tool calls', 'Last 7 days', 'Focus the search field'. A name, a path or a constant is not one.
const PHRASE = /^\p{Lu}\p{Ll}+(?:\s+[\p{L}\p{N}][\p{L}\p{N}'.,;:!?()-]*)+$/u;

const hasLetters = (text: string): boolean => /\p{L}/u.test(text.replaceAll(SLOT, ''));
const hasTwoLetters = (text: string): boolean => /\p{L}{2}/u.test(text.replaceAll(SLOT, ''));

function isWord(token: string): boolean {
  return WORD.test(token) && /\p{L}.*\p{L}/u.test(token) && /\p{Ll}/u.test(token);
}

/** A value that is filled in: "${n}", "(${n})", "${n}%", "${n}s", "${n}ms". Text glued to the value in front of it ("tone-${x}") is not. */
function isSlot(token: string): boolean {
  const index = token.indexOf(SLOT);
  if (index === -1) return false;
  const before = token.slice(0, index);
  const after = token.slice(index).replaceAll(SLOT, '');
  return !/[\p{L}\p{N}]/u.test(before) && /^\p{L}{0,2}[^\p{L}\p{N}]*$/u.test(after);
}

/** A sentence has two plain words, or one plain word next to a value that is filled in ("${n} running"). */
function readsAsSentence(text: string): boolean {
  let words = 0;
  let slots = 0;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    // A value glued to a hyphenated prefix ("tone-${x}") makes the text a class list: it names styles, it is no sentence.
    const at = token.indexOf(SLOT);
    if (at > 0 && token.charAt(at - 1) === '-') return false;
    if (isSlot(token)) slots += 1;
    else if (isWord(token)) words += 1;
  }
  return words >= 2 || (words >= 1 && slots >= 1);
}

function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  if (node === undefined) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

function flattenPlus(node: ts.Expression): ts.Expression[] {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...flattenPlus(node.left), ...flattenPlus(node.right)];
  }
  return [node];
}

/** The texts an expression can show: its string literals, templates (with a slot per value) and string concatenations. */
function textsOf(node: ts.Expression): string[] {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return textsOf(node.expression);
  }
  if (ts.isConditionalExpression(node)) return [...textsOf(node.whenTrue), ...textsOf(node.whenFalse)];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text + node.templateSpans.map((span) => SLOT + span.literal.text).join('')];
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.PlusToken) {
      const parts = flattenPlus(node);
      const isText = (part: ts.Expression): boolean => textsOf(part).length > 0;
      if (!parts.some(isText)) return [];
      return [parts.map((part) => textsOf(part)[0] ?? SLOT).join('')];
    }
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...textsOf(node.left), ...textsOf(node.right)];
    }
  }
  return [];
}

function nameOf(name: ts.PropertyName | ts.BindingName | ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return null;
}

function isBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node) || ts.isStatement(node);
}

/** The parents of a node, nearest first, up to (not including) the source file. */
function* ancestors(node: ts.Node): Generator<ts.Node> {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) yield current;
}

/** The parents of a node up to the nearest statement or function: the expression the node belongs to. */
function* expressionAncestors(node: ts.Node): Generator<ts.Node> {
  for (const current of ancestors(node)) {
    if (isBoundary(current)) return;
    yield current;
  }
}

function extendsError(node: ts.Node): boolean {
  for (const current of ancestors(node)) {
    if (ts.isClassLike(current)) {
      const base = current.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      return base !== undefined && ts.isIdentifier(base.expression) && base.expression.text.endsWith('Error');
    }
  }
  return false;
}

/**
 * True when the node is an argument of a diagnostic: `new Error(...)` (or another built-in error class), `super(...)` of a class
 * that extends an error class, or a `console` call. Diagnostics are for logs and developers, not for the person at the screen.
 */
function insideDiagnostic(node: ts.Node): boolean {
  for (const current of expressionAncestors(node)) {
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(current.expression) &&
      ERROR_CLASSES.has(current.expression.text)
    ) {
      return true;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (callee.kind === ts.SyntaxKind.SuperKeyword && extendsError(current)) return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'console'
      ) {
        return true;
      }
    }
  }
  return false;
}

/** True when the node sits in the value of a JSX attribute (the attribute rule decides about those). */
function insideJsxAttribute(node: ts.Node): boolean {
  for (const current of expressionAncestors(node)) if (ts.isJsxAttribute(current)) return true;
  return false;
}

const COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** False for a string that is compared, imported, a case label, an index, a type or the name of a property. */
function isValuePosition(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)) return false;
  if (ts.isCaseClause(parent) || ts.isElementAccessExpression(parent) || ts.isEnumMember(parent)) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return false;
  return true;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function firstArgument(args: readonly ts.Expression[] | undefined): ts.Expression | undefined {
  return args?.[0];
}

function isUndefinedLiteral(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === 'undefined';
}

/** A locale argument that names a language: a string, or a list that holds strings. */
function namesLocale(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
    return true;
  return ts.isArrayLiteralExpression(node) && node.elements.some((element) => namesLocale(element));
}

export function scan(fileName: string, source: string): Violation[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found = new Map<number, Violation>();

  function report(rule: Rule, node: ts.Node): void {
    const start = node.getStart(file);
    if (found.has(start)) return;
    const line = file.getLineAndCharacterOfPosition(start).line + 1;
    found.set(start, { rule, line, excerpt: node.getText(file).replace(/\s+/g, ' ').slice(0, 80) });
  }

  /** Reports every expression of `texts` of `node` that satisfies `bad`. */
  function check(rule: Rule, node: ts.Expression, bad: (text: string) => boolean): void {
    if (textsOf(node).some((text) => !MESSAGE_KEY.test(text) && bad(text))) report(rule, node);
  }

  function visitJsxAttribute(node: ts.JsxAttribute): void {
    const name = nameOf(node.name);
    if (name === null || !USER_ATTRIBUTES.has(name) || node.initializer === undefined) return;
    if (ts.isStringLiteral(node.initializer)) {
      if (hasLetters(node.initializer.text)) report('attribute', node.initializer);
    } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
      check('attribute', node.initializer.expression, hasLetters);
    }
  }

  function visitJsxText(node: ts.JsxText): void {
    const parent = node.parent;
    if (ts.isJsxElement(parent) && TECHNICAL_ELEMENTS.has(parent.openingElement.tagName.getText(file))) return;
    if (/\p{L}/u.test(node.text.replace(ENTITY, ''))) report('jsx-text', node);
  }

  function visitProperty(name: string, initializer: ts.Expression): void {
    if (LABEL_NAMES.has(name)) check('label', initializer, hasTwoLetters);
    if (SENTENCE_SUFFIX.test(name)) check('sentence', initializer, readsAsSentence);
  }

  function visitIntl(node: ts.NewExpression | ts.CallExpression): void {
    const callee = node.expression;
    const isIntlConstructor =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Intl' &&
      INTL_CONSTRUCTORS.has(callee.name.text);
    const method = ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    const isToLocale = method !== null && TO_LOCALE_STRING.has(method);
    if (!isIntlConstructor && !isToLocale) return;
    const locale = firstArgument(node.arguments);
    if (locale !== undefined && namesLocale(locale)) {
      report('intl', node);
      return;
    }
    const readsOptionsOnly =
      isIntlConstructor && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'resolvedOptions';
    if ((locale === undefined || isUndefinedLiteral(locale)) && !readsOptionsOnly) report('intl', node);
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) visitJsxText(node);
    else if (ts.isJsxAttribute(node)) visitJsxAttribute(node);
    else if (ts.isJsxExpression(node) && node.expression !== undefined) {
      if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
        check('jsx-child', node.expression, hasLetters);
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name !== null) visitProperty(name, node.initializer);
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const name = nameOf(node.name);
      if (name !== null && SENTENCE_SUFFIX.test(name) && node.initializer !== undefined) {
        check('sentence', node.initializer, readsAsSentence);
      }
      const table = name !== null && LABEL_TABLE.test(name) ? unwrap(node.initializer) : undefined;
      if (table !== undefined && ts.isObjectLiteralExpression(table)) {
        for (const member of table.properties) {
          if (ts.isPropertyAssignment(member)) check('label', member.initializer, hasTwoLetters);
        }
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== null && SENTENCE_CALLS.has(name)) {
          for (const argument of node.arguments) check('sentence', argument, readsAsSentence);
        }
      }
      visitIntl(node);
    } else if (ts.isStringLiteral(node)) {
      if (PHRASE.test(node.text) && isValuePosition(node) && !insideJsxAttribute(node) && !insideDiagnostic(node)) {
        report('phrase', node);
      }
    } else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const tagged = ts.isTaggedTemplateExpression(node.parent);
      if (!tagged && !insideJsxAttribute(node) && !insideDiagnostic(node)) {
        const text = textsOf(node)[0];
        if (text !== undefined && readsAsSentence(text)) report('template', node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------------------------------

function slashes(path: string): string {
  return path.split(sep).join('/');
}

const SRC_ROOT = slashes(resolve(import.meta.dirname, '..'));

/** Paths relative to src/ of the files the audit covers: sources, not tests, test helpers or the catalogues themselves. */
function auditedFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => slashes(`${entry.parentPath}${sep}${entry.name}`).slice(SRC_ROOT.length + 1))
    .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts'))
    .filter((path) => !path.startsWith('test/') && !path.startsWith('i18n/messages/'))
    .sort();
}

function describeViolations(path: string, violations: readonly Violation[]): string[] {
  return violations.map((v) => `${path}:${String(v.line)} [${v.rule}] ${v.excerpt}`);
}

describe('no literal user-facing text in the sources', () => {
  const files = auditedFiles();
  const violations = new Map<string, Violation[]>();
  for (const path of files) {
    if (Object.hasOwn(EXEMPT_FILES, path)) continue;
    const found = scan(path, readFileSync(`${SRC_ROOT}/${path}`, 'utf8'));
    if (found.length > 0) violations.set(path, found);
  }
  const baseline = new Set<string>(LITERAL_BASELINE);

  it('sees the source tree (the audit cannot pass by scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('app/routes.tsx');
    expect(files).toContain('i18n/format.ts');
    expect(files.some((path) => path.endsWith('.test.tsx'))).toBe(false);
    expect(files.some((path) => path.startsWith('test/'))).toBe(false);
  });

  it('finds no violation in a file that is not in the baseline', () => {
    const offenders = [...violations.entries()]
      .filter(([path]) => !baseline.has(path))
      .flatMap(([path, found]) => describeViolations(path, found));
    expect(offenders).toEqual([]);
  });

  it('lists no file in the baseline that is clean, missing or exempt (the ratchet only goes down)', () => {
    const stale = [...baseline].filter((path) => !violations.has(path));
    expect(stale).toEqual([]);
  });

  it('lists every baseline entry once, as a path relative to src/', () => {
    expect(LITERAL_BASELINE.length).toBe(baseline.size);
    for (const path of baseline) {
      expect(path).toMatch(/^[A-Za-z0-9_./[\]-]+\.(ts|tsx)$/);
      expect(files).toContain(path);
    }
  });

  it('exempts only files that exist, each with a written reason', () => {
    for (const [path, reason] of Object.entries(EXEMPT_FILES)) {
      expect(files).toContain(path);
      expect(reason.length).toBeGreaterThan(40);
      expect(baseline.has(path)).toBe(false);
    }
  });

  it('keeps the i18n module itself clean', () => {
    const own = [...violations.keys()].filter((path) => path.startsWith('i18n/'));
    expect(own).toEqual([]);
  });
});

describe('scan: positive probes (each of these is a violation)', () => {
  const positives: readonly [string, Rule, string, string][] = [
    ['JSX text', 'jsx-text', 'a.tsx', 'export const A = () => <p>Hello there</p>;'],
    ['one word of JSX text', 'jsx-text', 'a.tsx', 'export const A = () => <button>Retry</button>;'],
    ['JSX text with markup around it', 'jsx-text', 'a.tsx', 'export const A = () => <p><b>x</b> and more</p>;'],
    ['aria-label string', 'attribute', 'a.tsx', 'export const A = () => <button aria-label="Close dialog" />;'],
    ['title string', 'attribute', 'a.tsx', 'export const A = () => <span title="Copy" />;'],
    ['placeholder in an expression', 'attribute', 'a.tsx', "export const A = () => <input placeholder={'Search'} />;"],
    [
      'choice between two strings in an attribute',
      'attribute',
      'a.tsx',
      "export const A = (p: {ok: boolean}) => <i label={p.ok ? 'Yes' : 'No'} />;",
    ],
    [
      'template in an attribute',
      'attribute',
      'a.tsx',
      'export const A = (p: {n: string}) => <i aria-label={`Open ${p.n} details`} />;',
    ],
    [
      'string as a JSX child',
      'jsx-child',
      'a.tsx',
      "export const A = (p: {ok: boolean}) => <p>{p.ok ? 'Yes' : 'No'}</p>;",
    ],
    [
      'string behind && as a JSX child',
      'jsx-child',
      'a.tsx',
      "export const A = (p: {ok: boolean}) => <p>{p.ok && 'Done'}</p>;",
    ],
    ['label property', 'label', 'a.ts', "export const ROW = { tone: 'running', label: 'Working' };"],
    ['title property', 'label', 'a.ts', "export const ROW = { title: 'Active' };"],
    ['sentence in a *Label property', 'sentence', 'a.ts', "export const ROW = { ariaLabel: 'Close the dialog' };"],
    ['sentence in a *Text property', 'sentence', 'a.ts', "export const ROW = { emptyText: 'Nothing here yet' };"],
    [
      'sentence in a *Message variable',
      'sentence',
      'a.ts',
      "export const NOT_FOUND_MESSAGE = 'The monitor does not know this session';",
    ],
    [
      'announce with a sentence',
      'sentence',
      'a.ts',
      "export function f(announce: (m: string) => void) { announce('Link copied'); }",
    ],
    [
      'announce through a property',
      'sentence',
      'a.ts',
      "export function f(c: {announce: (m: string) => void}) { c.announce('Link copied'); }",
    ],
    [
      'showToast with a template',
      'sentence',
      'a.ts',
      'export function f(showToast: (m: string) => void, n: number) { showToast(`Saved ${String(n)} rows`); }',
    ],
    [
      'concatenated sentence',
      'sentence',
      'a.ts',
      "export function f(announce: (m: string) => void, n: number) { announce('Showing ' + String(n) + ' agents'); }",
    ],
    ['template sentence', 'template', 'a.ts', 'export const m = (n: number) => `Showing ${String(n)} agents`;'],
    ['value with a unit word', 'template', 'a.ts', 'export const m = (n: number) => `${String(n)} running`;'],
    [
      'template sentence as a JSX child',
      'jsx-child',
      'a.tsx',
      'export const A = (p: {n: number}) => <p>{`Loaded ${String(p.n)} events`}</p>;',
    ],
    ['Intl constructor with a locale', 'intl', 'a.ts', "export const f = new Intl.NumberFormat('en-US');"],
    ['Intl call with a locale', 'intl', 'a.ts', "export const f = Intl.DateTimeFormat('vi');"],
    [
      'Intl constructor with a list of locales',
      'intl',
      'a.ts',
      "export const f = new Intl.NumberFormat(['vi', 'en']);",
    ],
    ['Intl constructor without a locale', 'intl', 'a.ts', 'export const f = new Intl.PluralRules();'],
    [
      'Intl constructor with an undefined locale',
      'intl',
      'a.ts',
      'export const f = new Intl.NumberFormat(undefined, {});',
    ],
    ['toLocaleString with a locale', 'intl', 'a.ts', "export const f = (n: number) => n.toLocaleString('en');"],
    ['bare toLocaleString', 'intl', 'a.ts', 'export const f = (n: number) => n.toLocaleString();'],
    ['bare toLocaleDateString', 'intl', 'a.ts', 'export const f = (d: Date) => d.toLocaleDateString();'],
    [
      'toLocaleTimeString with an undefined locale',
      'intl',
      'a.ts',
      'export const f = (d: Date) => d.toLocaleTimeString(undefined, {});',
    ],
    [
      'a table of display names',
      'label',
      'a.ts',
      "export const KIND_LABELS = { prompt: 'Prompts', say: 'Claude' } as const;",
    ],
    [
      'a table of display names with satisfies',
      'label',
      'a.ts',
      "export const KIND_LABELS = { say: 'Claude' } satisfies Record<string, string>;",
    ],
    ['capitalised phrase in a table', 'phrase', 'a.ts', "export const NAMES = { tool: 'Tool calls' };"],
    ['capitalised phrase with a number', 'phrase', 'a.ts', "export const NAMES = ['Last 7 days'];"],
    ['capitalised phrase as a title', 'phrase', 'a.ts', "export const APP_TITLE = 'Claude session monitor';"],
  ];

  it.each(positives)('flags %s', (_label, rule, name, source) => {
    const found = scan(name, source);
    expect(found.map((v) => v.rule)).toContain(rule);
  });

  it('reports the line of the violation', () => {
    const found = scan('a.tsx', 'const a = 1;\n\nexport const A = () => <p>Hello there</p>;\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });
});

describe('scan: negative probes (technical text is not a violation)', () => {
  const negatives: readonly [string, string, string][] = [
    [
      'class names, ids and roles',
      'a.tsx',
      'export const A = () => <div className="state state--error" id="live-region" role="status" data-testid="x" />;',
    ],
    [
      'a computed class name',
      'a.tsx',
      'export const A = (p: {v: string}) => <div className={`skeleton skeleton--${p.v}`} />;',
    ],
    ['a class list template outside JSX', 'a.ts', 'export const c = (t: string, e: string) => `badge tone-${t} ${e}`;'],
    ['a class name template outside JSX', 'a.ts', 'export const cls = (base: string) => `${base} is-loading`;'],
    ['a route in a prop', 'a.tsx', 'export const A = () => <Link to="/sessions/abc" />;'],
    ['a route template', 'a.tsx', 'export const A = (p: {id: string}) => <Link to={`/sessions/${p.id}`} />;'],
    ['a route template outside JSX', 'a.ts', 'export const route = (id: string) => `/sessions/${id}?tab=errors`;'],
    [
      'an API url',
      'a.ts',
      'export const u = (s: number, e: string) => `/api/v3/stream?since=${String(s)}&epoch=${e}`;',
    ],
    ['an id suffix', 'a.ts', 'export const id = (p: string) => `${p}-body`;'],
    ['a query key', 'a.ts', "export const key = ['sessions', 'list'] as const;"],
    [
      'throw new Error with a sentence',
      'a.ts',
      "export function f() { throw new Error('index.html has no #root element'); }",
    ],
    [
      'new Error with a template',
      'a.ts',
      'export function f(s: string) { return new Error(`Unexpected state ${s} in the reducer`); }',
    ],
    [
      'new TypeError with a template',
      'a.ts',
      'export function f(s: string) { throw new TypeError(`Bad value ${s} here`); }',
    ],
    [
      'Intl with the locale of the caller',
      'a.ts',
      'export const f = (locale: string) => new Intl.NumberFormat(locale, { notation: "compact" });',
    ],
    [
      'toLocaleString with the locale of the caller',
      'a.ts',
      'export const f = (n: number, locale: string) => n.toLocaleString(locale);',
    ],
    ['the time zone of the browser', 'a.ts', 'export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;'],
    ['JSX text without letters', 'a.tsx', 'export const A = () => <span>/ - 12 %</span>;'],
    ['a character entity', 'a.tsx', 'export const A = () => <span>&nbsp;&middot;&#183;</span>;'],
    ['a value as JSX text', 'a.tsx', 'export const A = (p: {n: number}) => <span>{p.n}</span>;'],
    ['a space expression', 'a.tsx', "export const A = () => <span>{' '}</span>;"],
    ['text of a code element', 'a.tsx', 'export const A = () => <code>npm run build</code>;'],
    ['text of a kbd element', 'a.tsx', 'export const A = () => <kbd>Esc</kbd>;'],
    [
      'a message from the catalogue',
      'a.tsx',
      "export const A = (p: {t: (k: string) => string}) => <button aria-label={p.t('common.close')}>{p.t('common.retry')}</button>;",
    ],
    ['a label key', 'a.ts', "export const ROW = { tone: 'running', labelKey: 'state.working' };"],
    [
      'a label from the catalogue',
      'a.ts',
      "export const f = (t: (k: string) => string) => ({ label: t('state.working') });",
    ],
    [
      'announce with a message from the catalogue',
      'a.ts',
      "export function f(announce: (m: string) => void, t: (k: string) => string) { announce(t('common.copied')); }",
    ],
    ['a comparison with a phrase', 'a.ts', "export const f = (s: string) => s === 'turn ended';"],
    [
      'a case label',
      'a.ts',
      "export function f(s: string) { switch (s) { case 'turn ended': return 1; default: return 0; } }",
    ],
    ['a type-level template', 'a.ts', "export type ToneClass = `tone-${'a' | 'b'}`;"],
    ['words in a comment', 'a.ts', '// Hello there, this is a comment about the list of items.\nexport const x = 1;'],
    ['a tagged template', 'a.ts', "export const x = String.raw`path to ${'dir'}`;"],
    [
      'a value that holds no letters',
      'a.ts',
      'export const x = (a: number, b: number) => `${String(a)} ${String(b)}`;',
    ],
    ['a time of day', 'a.ts', 'export const x = (h: string, m: string) => `${h}:${m}`;'],
    ['a label with one letter', 'a.ts', "export const ROW = { label: 'x' };"],
    ['a table of display names from the catalogue', 'a.ts', "export const KIND_LABELS = { say: 'kind.say' } as const;"],
    ['a capitalised phrase in a comparison', 'a.ts', "export const f = (s: string) => s === 'Not found';"],
    ['a header name', 'a.ts', "export const h = { 'Content-Type': 'application/json' };"],
    ['a request line', 'a.ts', "export const line = 'GET /api/v3/sessions';"],
    ['a single capitalised word', 'a.ts', "export const unit = 'Seconds';"],
    ['a capitalised phrase in a diagnostic', 'a.ts', "export function f() { throw new Error('Not found here'); }"],
  ];

  it.each(negatives)('does not flag %s', (_label, name, source) => {
    expect(scan(name, source)).toEqual([]);
  });
});
