// Which letter a key event means, whatever the keyboard layout (ADR 0110). Pure: the terminal key table (`terminal/keys.ts`) reads
// its letter rows through it.

/** The part of a `KeyboardEvent` that is read; a real event satisfies it. */
export interface LetterEventLike {
  readonly key: string;
  /** The physical key (`KeyC`); optional because a synthetic event may carry none. */
  readonly code?: string;
}

const ASCII_LETTER = /^[a-z]$/i;
const LAST_ASCII = 0x7f;

/** One character outside ASCII: what a Cyrillic, Greek, Hebrew, Arabic or Thai layout types on a letter key. */
function isNonAsciiCharacter(key: string): boolean {
  const first = key.codePointAt(0);
  return first !== undefined && first > LAST_ASCII && key.length === String.fromCodePoint(first).length;
}

/**
 * True when the event is the letter `letter` (a-z): by `key` in either case; or, when `key` is a character outside ASCII (a
 * layout that types no Latin letter there), by the physical key `Key<LETTER>`. A different ASCII letter never matches (Dvorak:
 * the key that types `j` is not `c`), and neither does a named key (`Process` of an input method, `Dead`) or ASCII punctuation.
 */
export function isLetterKey(event: LetterEventLike, letter: string): boolean {
  const { key } = event;
  if (ASCII_LETTER.test(key)) return key.toLowerCase() === letter.toLowerCase();
  if (!isNonAsciiCharacter(key)) return false;
  return event.code === `Key${letter.toUpperCase()}`;
}
