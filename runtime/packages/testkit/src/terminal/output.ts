// Terminal output in tests (design 08, section 3.2): the escape sequences removed, and a recorder that tests feed from a
// pseudo-terminal or from a WebSocket and wait on without sleeping.
import { StringDecoder } from 'node:string_decoder';

import { scaled } from './pty-support.ts';

const ESC = '\\x1b';

// The classes of terminal control sequences that an interactive program writes. Order matters: a string terminated sequence
// (OSC, DCS, PM, APC, SOS) is removed before the single-character escapes that share its introducer.
const SEQUENCES: readonly RegExp[] = [
  // OSC: ESC ] ... BEL or ST; an unterminated one at the end of the input.
  new RegExp(`${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\|$)`, 'g'),
  // DCS, SOS, PM, APC: ESC P|X|^|_ ... ST; an unterminated one at the end of the input.
  new RegExp(`${ESC}[PX^_][^${ESC}]*(?:${ESC}\\\\|$)`, 'g'),
  // CSI: ESC [ parameters intermediates final, and the 8-bit introducer.
  new RegExp(`(?:${ESC}\\[|\\u009b)[0-?]*[ -/]*[@-~]`, 'g'),
  // Charset selects (ESC ( B, ESC ) 0, ...), DEC line and screen modes (ESC # 8), and ESC space F|G|L|M|N.
  new RegExp(`${ESC}[()*+\\-./][0-~ ]`, 'g'),
  new RegExp(`${ESC}#[0-9]`, 'g'),
  new RegExp(`${ESC} [@-~]`, 'g'),
  // Everything else with one final character: ESC = and ESC > (keypad), ESC 7 and ESC 8 (cursor), ESC c, ESC D, ESC E, ESC H, ESC M, ...
  new RegExp(`${ESC}[0-9=>@-Z\\\\^_a-z]`, 'g'),
];

/** Text of terminal output with the control sequences removed. Bytes are decoded as UTF-8. */
export function stripAnsi(input: string | Uint8Array): string {
  let text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  for (const sequence of SEQUENCES) text = text.replace(sequence, '');
  return text;
}

interface Waiter {
  readonly pattern: string | RegExp;
  readonly resolve: (value: RegExpMatchArray | string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function describePattern(pattern: string | RegExp): string {
  return typeof pattern === 'string' ? JSON.stringify(pattern) : String(pattern);
}

/**
 * A recorder fed from `onData` of a pseudo-terminal or from the binary frames of a WebSocket. `text()` is the output decoded
 * as UTF-8 (a character split across chunks is kept whole) with the control sequences removed (also when one is split across
 * chunks). `until` waits on it without a sleep.
 */
export class TerminalOutput {
  #chunks: Buffer[] = [];
  #decoder = new StringDecoder('utf8');
  #decoded = '';
  #stripped: string | null = '';
  readonly #waiters = new Set<Waiter>();

  /** Adds a chunk and wakes the waiters whose pattern is now in the text. */
  push(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.#chunks.push(bytes);
    this.#decoded += this.#decoder.write(bytes);
    this.#stripped = null;
    this.#check();
  }

  /** Every byte received, unchanged. */
  raw(): Buffer {
    if (this.#chunks.length > 1) this.#chunks = [Buffer.concat(this.#chunks)];
    return this.#chunks[0] ?? Buffer.alloc(0);
  }

  /** The output as text, without control sequences. */
  text(): string {
    this.#stripped ??= stripAnsi(this.#decoded);
    return this.#stripped;
  }

  /** Number of non-overlapping occurrences of `substring` in `text()`. */
  count(substring: string): number {
    if (substring === '') throw new RangeError('TerminalOutput.count: the substring must not be empty');
    return this.text().split(substring).length - 1;
  }

  /** Forgets all output (waiters stay and look at what arrives next). */
  clear(): void {
    this.#chunks = [];
    this.#decoder = new StringDecoder('utf8');
    this.#decoded = '';
    this.#stripped = '';
  }

  /**
   * Resolves with the string (for a string pattern) or the match (for a regular expression) as soon as `text()` holds it, at
   * once when it already does. Rejects after `timeoutMs` (default 20 s times `QA_TIME_SCALE`); the error names the pattern and
   * the number of characters seen, never the output.
   */
  until(pattern: string | RegExp, opts: { timeoutMs?: number } = {}): Promise<RegExpMatchArray | string> {
    const found = this.#find(pattern);
    if (found !== null) return Promise.resolve(found);
    const timeoutMs = opts.timeoutMs ?? scaled(20_000);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new Error(
              `TerminalOutput.until: timed out after ${String(timeoutMs)} ms waiting for ${describePattern(pattern)}; ${String(this.text().length)} characters received`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #find(pattern: string | RegExp): RegExpMatchArray | string | null {
    const text = this.text();
    if (typeof pattern === 'string') return text.includes(pattern) ? pattern : null;
    const flags = pattern.flags.replace(/[gy]/g, '');
    return new RegExp(pattern.source, flags).exec(text);
  }

  #check(): void {
    for (const waiter of [...this.#waiters]) {
      const found = this.#find(waiter.pattern);
      if (found === null) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(found);
    }
  }
}
