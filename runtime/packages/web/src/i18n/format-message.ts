// The message format of the catalogue (ADR 0072 decision 1): a small ICU subset.
//
//   text {name} text
//   {count, plural, =0 {no errors} one {# error} other {# errors}}
//
// `#` prints the counter inside a form. The categories are `zero one two few many other` and `=N`; `other` is required. There is no
// `select`, no nesting and no literal brace: a brace that is not part of an argument is a syntax error, so a typo cannot slip into
// a user-facing string. Quotes and apostrophes are ordinary characters.
import { numberFormat, pluralRules } from './format.ts';
import type { Locale, MessageValue } from './types.ts';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export type FormPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'number' };

export interface PluralForm {
  /** `=N` forms match this exact value. */
  readonly exact: number | null;
  /** The category of a keyword form, null for `=N`. */
  readonly category: PluralCategory | null;
  readonly parts: readonly FormPart[];
}

export type MessageNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'argument'; readonly name: string }
  | {
      readonly kind: 'plural';
      readonly name: string;
      readonly forms: readonly PluralForm[];
      readonly other: PluralForm;
    };

export interface ParsedMessage {
  readonly nodes: readonly MessageNode[];
  /** Every argument name; true when the name is the counter of a plural (it must be a number). */
  readonly args: ReadonlyMap<string, boolean>;
}

/** The text of a message is malformed. `position` is the index of the offending character. */
export class MessageSyntaxError extends Error {
  readonly position: number;
  constructor(reason: string, position: number) {
    super(`Malformed message at ${String(position)}: ${reason}`);
    this.name = 'MessageSyntaxError';
    this.position = position;
  }
}

/** An argument is missing or has the wrong type. */
export class MessageArgumentError extends Error {
  readonly argument: string;
  constructor(reason: string, argument: string) {
    super(`A ${reason} message argument: "${argument}"`);
    this.name = 'MessageArgumentError';
    this.argument = argument;
  }
}

const CATEGORIES: ReadonlySet<string> = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const NAME_CHAR = /[A-Za-z0-9_]/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIGIT = /[0-9]/;
const WORD_CHAR = /[A-Za-z]/;
const WHITESPACE = /\s/;
const MAX_EXACT_DIGITS = 15;

function isCategory(word: string): word is PluralCategory {
  return CATEGORIES.has(word);
}

class Parser {
  private pos = 0;
  private readonly args = new Map<string, boolean>();
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): ParsedMessage {
    const nodes: MessageNode[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') nodes.push({ kind: 'text', text });
      text = '';
    };
    while (this.pos < this.source.length) {
      const char = this.source.charAt(this.pos);
      if (char === '{') {
        flush();
        nodes.push(this.parseArgument());
      } else if (char === '}') {
        throw new MessageSyntaxError('unmatched closing brace', this.pos);
      } else {
        text += char;
        this.pos += 1;
      }
    }
    flush();
    return { nodes, args: this.args };
  }

  private fail(reason: string): never {
    throw new MessageSyntaxError(reason, this.pos);
  }

  private skipSpace(): void {
    while (this.pos < this.source.length && WHITESPACE.test(this.source.charAt(this.pos))) this.pos += 1;
  }

  private peek(): string {
    return this.source.charAt(this.pos);
  }

  private expect(char: string, reason: string): void {
    if (this.peek() !== char) this.fail(reason);
    this.pos += 1;
  }

  private readWhile(test: RegExp): string {
    const start = this.pos;
    while (this.pos < this.source.length && test.test(this.source.charAt(this.pos))) this.pos += 1;
    return this.source.slice(start, this.pos);
  }

  private note(name: string, plural: boolean): void {
    this.args.set(name, plural || this.args.get(name) === true);
  }

  private parseArgument(): MessageNode {
    this.expect('{', 'expected an opening brace');
    this.skipSpace();
    const start = this.pos;
    const name = this.readWhile(NAME_CHAR);
    if (!NAME.test(name)) {
      this.pos = start;
      this.fail('expected an argument name');
    }
    this.skipSpace();
    if (this.peek() === '}') {
      this.pos += 1;
      this.note(name, false);
      return { kind: 'argument', name };
    }
    if (this.peek() === '') this.fail('unterminated argument');
    this.expect(',', 'expected a closing brace or a comma after the argument name');
    this.skipSpace();
    const type = this.readWhile(WORD_CHAR);
    if (type !== 'plural') this.fail('only plural arguments are supported');
    this.skipSpace();
    this.expect(',', 'expected a comma after "plural"');
    const node = this.parsePluralForms(name);
    this.note(name, true);
    return node;
  }

  private parsePluralForms(name: string): MessageNode {
    const forms: PluralForm[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipSpace();
      if (this.peek() === '}') break;
      if (this.peek() === '') this.fail('unterminated plural');
      const selector = this.parseSelector();
      const label = selector.exact === null ? (selector.category ?? '') : `=${String(selector.exact)}`;
      if (seen.has(label)) this.fail('a form is repeated');
      seen.add(label);
      this.skipSpace();
      this.expect('{', 'expected an opening brace before the text of a form');
      forms.push({ ...selector, parts: this.parseFormText() });
    }
    this.pos += 1;
    const other = forms.find((form) => form.category === 'other');
    if (other === undefined) this.fail('a plural needs an "other" form');
    return { kind: 'plural', name, forms, other };
  }

  private parseSelector(): { exact: number | null; category: PluralCategory | null } {
    if (this.peek() === '=') {
      this.pos += 1;
      const digits = this.readWhile(DIGIT);
      if (digits === '' || digits.length > MAX_EXACT_DIGITS) this.fail('expected digits after "="');
      return { exact: Number(digits), category: null };
    }
    const word = this.readWhile(WORD_CHAR);
    if (!isCategory(word)) this.fail('unknown plural form');
    return { exact: null, category: word };
  }

  private parseFormText(): FormPart[] {
    const parts: FormPart[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') parts.push({ kind: 'text', text });
      text = '';
    };
    for (;;) {
      if (this.pos >= this.source.length) this.fail('unterminated plural form');
      const char = this.peek();
      if (char === '}') break;
      if (char === '{') this.fail('braces cannot be nested inside a plural form');
      if (char === '#') {
        flush();
        parts.push({ kind: 'number' });
      } else {
        text += char;
      }
      this.pos += 1;
    }
    this.pos += 1;
    flush();
    return parts;
  }
}

const parsed = new Map<string, ParsedMessage>();
const PARSED_LIMIT = 5000;

/** Parses a message text; throws `MessageSyntaxError` when it is malformed. The result is cached by text. */
export function parseMessage(source: string): ParsedMessage {
  const known = parsed.get(source);
  if (known !== undefined) return known;
  const made = new Parser(source).parse();
  if (parsed.size >= PARSED_LIMIT) parsed.clear();
  parsed.set(source, made);
  return made;
}

/** The argument names of a message text and whether each is a plural counter. */
export function messageArguments(source: string): ReadonlyMap<string, boolean> {
  return parseMessage(source).args;
}

/** True for an arguments object: a plain object or an object with a null prototype (not null, not an array). */
export function isMessageArgs(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FormatOptions {
  /**
   * Default true: a missing or ill-typed argument throws `MessageArgumentError`, so a test or a development build fails at once.
   * False writes nothing for that argument, so a production page degrades instead of crashing.
   */
  strict?: boolean;
}

function readArgument(
  args: Readonly<Record<string, unknown>> | undefined,
  name: string,
  wantNumber: boolean,
  strict: boolean,
): MessageValue | undefined {
  const value: unknown = args !== undefined && Object.hasOwn(args, name) ? args[name] : undefined;
  if (typeof value === 'number') return value;
  if (!wantNumber && typeof value === 'string') return value;
  if (strict) {
    throw new MessageArgumentError(value === undefined ? 'missing' : 'invalid', name);
  }
  return undefined;
}

function chooseForm(node: Extract<MessageNode, { kind: 'plural' }>, count: number, locale: Locale): PluralForm {
  const exact = node.forms.find((form) => form.exact !== null && form.exact === count);
  if (exact !== undefined) return exact;
  const category = pluralRules(locale).select(count);
  return node.forms.find((form) => form.category === category) ?? node.other;
}

/**
 * The text of a message for a locale. A number argument is written with the number format of the locale; a string is used as it
 * is and its braces are not interpreted. The text may be given as a source string or as the result of `parseMessage`.
 */
export function formatMessage(
  message: string | ParsedMessage,
  args: Readonly<Record<string, unknown>> | undefined,
  locale: Locale,
  options: FormatOptions = {},
): string {
  const strict = options.strict !== false;
  const { nodes } = typeof message === 'string' ? parseMessage(message) : message;
  const numbers = numberFormat(locale);
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.text;
    } else if (node.kind === 'argument') {
      const value = readArgument(args, node.name, false, strict);
      if (value !== undefined) out += typeof value === 'number' ? numbers.format(value) : value;
    } else {
      const count = readArgument(args, node.name, true, strict);
      if (typeof count !== 'number') continue;
      for (const part of chooseForm(node, count, locale).parts) {
        out += part.kind === 'text' ? part.text : numbers.format(count);
      }
    }
  }
  return out;
}
