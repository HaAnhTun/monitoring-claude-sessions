// Terminal-safe output (05 5.3 S-OUT, ADR 0046, A.39): the only module of the CLI that writes to stdout or stderr.
// Untrusted text (labels, first prompts, paths and error text taken from transcripts) can carry terminal control
// sequences: OSC 52 sets the clipboard, OSC 0 the window title, OSC 8 makes a hyperlink, bidi controls spoof what a
// command line looks like. Such text is shown, never executed: every dangerous code point becomes a visible `\uXXXX`.
//   text mode: C0 except TAB and LF, DEL, C1, U+2028, U+2029, U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069;
//   JSON mode: `JSON.stringify` already escapes C0 and leaves the rest raw, so the same escape is applied to DEL, C1,
//   U+2028/2029 and the bidi controls inside the document (they occur only inside strings), which keeps it valid JSON.
// Colour is emitted only around trusted text and only on a terminal with NO_COLOR unset (S-OUT-4); the text inside a
// colour is escaped like any other, so untrusted text can never open or close a sequence.

const ESC = String.fromCharCode(0x1b);

/** True for a UTF-16 code unit that must not reach a terminal raw in text mode. All of them are in the BMP. */
function isUnsafeUnit(unit: number): boolean {
  if (unit <= 0x1f) return unit !== 0x09 && unit !== 0x0a;
  if (unit < 0x7f) return false;
  if (unit <= 0x9f) return true;
  if (unit === 0x061c || unit === 0x200e || unit === 0x200f || unit === 0x2028 || unit === 0x2029) return true;
  return (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);
}

/** Same set as `isUnsafeUnit` without C0, which `JSON.stringify` has escaped already. */
function isUnsafeInJson(unit: number): boolean {
  return unit >= 0x7f && isUnsafeUnit(unit);
}

function escapeUnit(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, '0')}`;
}

function escapeWhere(text: string, unsafe: (unit: number) => boolean): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (!unsafe(unit)) continue;
    out += text.slice(from, i) + escapeUnit(unit);
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** Neutralise terminal control sequences in untrusted text before it reaches a TTY. TAB and LF stay. */
export function sanitizeForTerminal(text: string): string {
  return escapeWhere(text, isUnsafeUnit);
}

/**
 * `JSON.stringify(value, null, space)` with DEL, C1, U+2028/2029 and the bidi controls escaped. The output parses back
 * to the same value. Throws a `TypeError` for a value JSON cannot represent (`undefined`, a function, a symbol), where
 * `JSON.stringify` would return `undefined`.
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  // The library types say `string`; at run time `undefined`, a function or a symbol give `undefined`.
  const text: unknown = JSON.stringify(value, null, space);
  if (typeof text !== 'string') throw new TypeError('safeJsonStringify: the value has no JSON representation');
  return escapeWhere(text, isUnsafeInJson);
}

export type TextStyle = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan';

const SGR: Readonly<Record<TextStyle, string>> = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
};

/**
 * Colour is allowed on a terminal when `NO_COLOR` is unset or empty (the convention of no-color.org: a non-empty value,
 * whatever it is, switches colour off).
 */
export function colorEnabled(
  stream: { readonly isTTY?: boolean | undefined },
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (stream.isTTY !== true) return false;
  const noColor = env['NO_COLOR'];
  return noColor === undefined || noColor === '';
}

function styled(text: string, stream: { readonly isTTY?: boolean | undefined }, style: TextStyle | undefined): string {
  const body = sanitizeForTerminal(text);
  if (style === undefined || !colorEnabled(stream)) return body;
  return `${ESC}[${SGR[style]}m${body}${ESC}[0m`;
}

/** The only place in the CLI that writes to stdout: escaped text and a newline. `style` colours trusted text only. */
export function printLine(text: string, style?: TextStyle): void {
  process.stdout.write(`${styled(text, process.stdout, style)}\n`);
}

/** The only place in the CLI that writes to stderr (`ERROR:`, `hint:`, `warning:`, `mcs:` progress lines). */
export function printErrorLine(text: string, style?: TextStyle): void {
  process.stderr.write(`${styled(text, process.stderr, style)}\n`);
}

/** One JSON document on stdout (`--json`, and the commands whose legacy output was JSON), safe for a terminal. */
export function printJson(value: unknown, space?: number): void {
  process.stdout.write(`${safeJsonStringify(value, space)}\n`);
}
