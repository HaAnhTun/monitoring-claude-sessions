// Port of CPython's `re._parser.Tokenizer` over code points (design 01 section 2.8).
// A token is one code point, or a backslash followed by one code point.
import { PyRegexFailure } from './ast.ts';
import type { PyRegexErrorCode } from './types.ts';

export const BS = '\\';

function isSurrogateUnit(s: string): boolean {
  if (s.length !== 1) return false;
  const c = s.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdfff;
}

export class Tokenizer {
  private readonly chars: string[];
  private index = 0;
  /** The next token, or `null` at the end of the pattern. */
  next: string | null = null;

  constructor(source: string) {
    this.chars = Array.from(source);
    const lone = this.chars.findIndex(isSurrogateUnit);
    if (lone >= 0) throw new PyRegexFailure('SYNTAX', 'the pattern contains a lone surrogate', lone);
    this.advance();
  }

  get length(): number {
    return this.chars.length;
  }

  private advance(): void {
    let index = this.index;
    const ch = this.chars[index];
    if (ch === undefined) {
      this.next = null;
      return;
    }
    let token = ch;
    if (ch === BS) {
      index += 1;
      const following = this.chars[index];
      if (following === undefined) {
        throw new PyRegexFailure('SYNTAX', 'bad escape (end of pattern)', this.chars.length - 1);
      }
      token += following;
    }
    this.index = index + 1;
    this.next = token;
  }

  /** Whether the next token is a member of `charset` (false at the end of the pattern). */
  nextIn(charset: ReadonlySet<string>): boolean {
    return this.next !== null && charset.has(this.next);
  }

  match(ch: string): boolean {
    if (this.next === ch) {
      this.advance();
      return true;
    }
    return false;
  }

  get(): string | null {
    const token = this.next;
    this.advance();
    return token;
  }

  /** Up to `n` following tokens that are members of `charset`, joined. */
  getWhile(n: number, charset: ReadonlySet<string>): string {
    let result = '';
    for (let k = 0; k < n; k++) {
      const c = this.next;
      if (c === null || !charset.has(c)) break;
      result += c;
      this.advance();
    }
    return result;
  }

  /** Tokens up to `terminator` (consumed, not returned); errors like CPython for a missing name or terminator. */
  getUntil(terminator: string, name: string): string {
    let result = '';
    let count = 0;
    for (;;) {
      const c = this.next;
      this.advance();
      if (c === null) {
        if (result === '') throw this.error('SYNTAX', `missing ${name}`);
        throw this.error('SYNTAX', `missing ${terminator}, unterminated name`, count);
      }
      if (c === terminator) {
        if (result === '') throw this.error('SYNTAX', `missing ${name}`, 1);
        return result;
      }
      result += c;
      count += c.startsWith(BS) ? 2 : 1;
    }
  }

  /** Position of the next token in code points (CPython `tell`). */
  tell(): number {
    const width = this.next === null ? 0 : this.next.startsWith(BS) ? 2 : 1;
    return this.index - width;
  }

  seek(index: number): void {
    this.index = index;
    this.advance();
  }

  error(code: PyRegexErrorCode, message: string, offset = 0): PyRegexFailure {
    return new PyRegexFailure(code, message, Math.max(0, this.tell() - offset));
  }
}
