// FIXTURE: invented terminal output for the visual QA tool (CAW-49, design 05 section 7.2).
// What the canned terminal socket (`terminal-fixture.ts`) writes to xterm: three screens, each drawn for the size it is given.
//   - `colors`: the 16 ANSI colours as text and as background, bold, dim, italic, underline, inverse and strike, the 256-colour and
//     true-colour ramps (the cells xterm styles one by one), the glyphs Claude Code and terminals draw (design 05 section 2.6) and
//     the box-drawing characters, inside a frame;
//   - `vietnamese`: the 134 letters of the Vietnamese alphabet that are not ASCII, in each of the 16 colours;
//   - `session`: a short screen in the shape of a Claude Code session.
// No character outside ASCII is typed in this file: every glyph is a code point, and every Vietnamese letter is a base letter
// plus combining marks, normalised to NFC. The escape character is built from its number too, so that no tool that rewrites
// backslash escapes can change a sequence.

/** The screens the canned socket can draw. */
export const SAMPLE_NAMES = ['colors', 'vietnamese', 'session'] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];

export interface SampleSize {
  readonly cols: number;
  readonly rows: number;
}

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const CRLF = String.fromCharCode(13, 10);

/** Select Graphic Rendition: `sgr(1, 31)` is bold red, `sgr()` resets. */
export function sgr(...codes: readonly number[]): string {
  return `${CSI}${codes.join(';')}m`;
}

const RESET = sgr(0);

/** Moves the cursor to a column of its row (1 is the first): a frame closes at its column whatever the widths before it were. */
function toColumn(column: number): string {
  return `${CSI}${String(column)}G`;
}

/** The request for the cursor position (DSR 6): the terminal answers `ESC [ row ; column R` once it has parsed everything before. */
export const CURSOR_REPORT_REQUEST = `${CSI}6n`;

/**
 * Splits what a terminal sent (one character per byte) into the answers to `CURSOR_REPORT_REQUEST` and everything else: `reports`
 * counts the answers, `rest` is the input a person typed.
 */
export function splitCursorReports(text: string): { reports: number; rest: string } {
  let reports = 0;
  let rest = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf(CSI, at);
    if (start < 0) break;
    const end = text.indexOf('R', start);
    if (end >= 0 && /^[0-9]+;[0-9]+$/.test(text.slice(start + CSI.length, end))) {
      reports += 1;
      rest += text.slice(at, start);
      at = end + 1;
    } else {
      rest += text.slice(at, start + CSI.length);
      at = start + CSI.length;
    }
  }
  return { reports, rest: rest + text.slice(at) };
}

/** Erases the screen and the scrollback and puts the cursor at the top left: what a program does before it draws again. */
export const CLEAR_SCREEN = `${CSI}2J${CSI}3J${CSI}H`;

// ---- glyphs ----------------------------------------------------------------------------------------------------------------------

const glyph = (codePoint: number): string => String.fromCodePoint(codePoint);

/** The glyphs Claude Code and terminals draw that the first fonts of the stack lack (design 05 section 2.6), by code point. */
export const TERMINAL_GLYPH_CODE_POINTS: readonly number[] = [
  0x273b, // teardrop-spoked asterisk (the Claude Code mark)
  0x2733, // eight spoked asterisk
  0x2722, // four teardrop-spoked asterisk
  0x23fa, // black circle for record (a tool call)
  0x23bf, // dentistry symbol (the result corner)
  0x276f, // heavy right-pointing angle quotation mark (the prompt)
  0x2713, // check mark
  0x2717, // ballot x
  0x25d0, // circle with left half black
  0x258e, // left one quarter block
  0x25b6, // black right-pointing triangle
  0x26a0, // warning sign
  0x26a1, // high voltage sign (two cells wide in Unicode 11)
];

const MARK = glyph(0x273b);
const TOOL = glyph(0x23fa);
const RESULT = glyph(0x23bf);
const PROMPT = glyph(0x276f);

/** Light box drawing, by role. */
const BOX = {
  horizontal: glyph(0x2500),
  vertical: glyph(0x2502),
  topLeft: glyph(0x250c),
  topRight: glyph(0x2510),
  bottomLeft: glyph(0x2514),
  bottomRight: glyph(0x2518),
  roundTopLeft: glyph(0x256d),
  roundTopRight: glyph(0x256e),
  roundBottomLeft: glyph(0x2570),
  roundBottomRight: glyph(0x256f),
} as const;

/** More box drawing, shades and blocks, shown as one line of the colours screen. */
const BOX_SHOWCASE: readonly number[] = [
  0x250c, 0x252c, 0x2510, 0x251c, 0x253c, 0x2524, 0x2514, 0x2534, 0x2518, 0x20, 0x256d, 0x2500, 0x256e, 0x2570, 0x2500,
  0x256f, 0x20, 0x2554, 0x2550, 0x2557, 0x2551, 0x255a, 0x2550, 0x255d, 0x20, 0x2591, 0x2592, 0x2593, 0x2588, 0x20,
  0x2580, 0x2584, 0x258c, 0x2590,
];

// ---- the Vietnamese letters --------------------------------------------------------------------------------------------------------

const COMBINING = {
  grave: 0x300,
  acute: 0x301,
  tilde: 0x303,
  hook: 0x309,
  dot: 0x323,
  circumflex: 0x302,
  breve: 0x306,
  horn: 0x31b,
} as const;

/** The twelve vowel letters as a base letter plus its own mark (none, breve, circumflex or horn). */
const VOWELS: readonly (readonly [string, number | null])[] = [
  ['a', null],
  ['a', COMBINING.breve],
  ['a', COMBINING.circumflex],
  ['e', null],
  ['e', COMBINING.circumflex],
  ['i', null],
  ['o', null],
  ['o', COMBINING.circumflex],
  ['o', COMBINING.horn],
  ['u', null],
  ['u', COMBINING.horn],
  ['y', null],
];

const TONES: readonly number[] = [COMBINING.grave, COMBINING.acute, COMBINING.hook, COMBINING.tilde, COMBINING.dot];

/**
 * The 67 lower-case letters of the alphabet that are not ASCII: each vowel with its own mark alone (six of them), each vowel with
 * each of the five tones (sixty), and the stroked d. Composed from a base letter and combining marks, NFC.
 */
function lowerCaseLetters(): string[] {
  const letters: string[] = [];
  for (const [base, own] of VOWELS) {
    const ownMark = own === null ? '' : String.fromCharCode(own);
    if (own !== null) letters.push((base + ownMark).normalize('NFC'));
    for (const tone of TONES) letters.push((base + ownMark + String.fromCharCode(tone)).normalize('NFC'));
  }
  letters.push(String.fromCharCode(0x111));
  return letters;
}

/** The 134 Vietnamese letters outside ASCII: the 67 lower-case ones, then their capitals. One code point and one cell each. */
export function vietnameseLetters(): string[] {
  const lower = lowerCaseLetters();
  return [...lower, ...lower.map((letter) => letter.toUpperCase().normalize('NFC'))];
}

// ---- the colours -------------------------------------------------------------------------------------------------------------------

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** The 16 ANSI text colours as SGR codes: 30 to 37, then the bright ones, 90 to 97. */
export const ANSI_FOREGROUND_CODES: readonly number[] = [
  ...COLOR_NAMES.map((_name, index) => 30 + index),
  ...COLOR_NAMES.map((_name, index) => 90 + index),
];

/** The widest screen a sample draws: a frame of 78 cells fits the 80 columns every window width must give (design 05 section 7.4). */
const MAX_WIDTH = 78;
const MIN_WIDTH = 44;

function widthFor(size: SampleSize): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, size.cols));
}

interface Frame {
  top: (title: string) => string;
  row: (content: string) => string;
  bottom: () => string;
}

/** A frame `width` cells wide. A row is closed by moving the cursor to the last column, so a wide glyph cannot push the border. */
function frame(width: number, rounded: boolean): Frame {
  const corners = rounded
    ? [BOX.roundTopLeft, BOX.roundTopRight, BOX.roundBottomLeft, BOX.roundBottomRight]
    : [BOX.topLeft, BOX.topRight, BOX.bottomLeft, BOX.bottomRight];
  const [topLeft = '', topRight = '', bottomLeft = '', bottomRight = ''] = corners;
  const dim = sgr(2);
  return {
    top: (title) => {
      const label = title === '' ? '' : ` ${title} `;
      const rule = BOX.horizontal.repeat(Math.max(0, width - 3 - label.length));
      return `${dim}${topLeft}${BOX.horizontal}${RESET}${sgr(1)}${label}${RESET}${dim}${rule}${topRight}${RESET}`;
    },
    row: (content) => `${dim}${BOX.vertical}${RESET} ${content}${RESET}${toColumn(width)}${dim}${BOX.vertical}${RESET}`,
    bottom: () => `${dim}${bottomLeft}${BOX.horizontal.repeat(width - 2)}${bottomRight}${RESET}`,
  };
}

const label = (text: string): string => `${sgr(2)}${text.padEnd(8)}${RESET}`;

function colorsScreen(size: SampleSize): string[] {
  const width = widthFor(size);
  const box = frame(width, false);
  // eight names share what the label and the borders leave
  const cell = Math.max(4, Math.floor((width - 4 - 8) / 8));
  const name = (index: number): string => (COLOR_NAMES[index] ?? '').slice(0, cell - 1).padEnd(cell);
  const eight = (codes: (index: number) => readonly number[]): string =>
    COLOR_NAMES.map((_name, index) => `${sgr(...codes(index))}${name(index)}${RESET}`).join('');
  const rampCells = Math.max(8, Math.min(36, width - 4 - 8 - 2));
  const ramp256 = Array.from({ length: rampCells }, (_unused, index) => `${sgr(48, 5, 16 + index * 6)} `).join('');
  const rampTrue = Array.from({ length: rampCells }, (_unused, index) => {
    const part = Math.round((index * 255) / (rampCells - 1));
    return `${sgr(48, 2, 255 - part, Math.round(part / 2) + 60, part)} `;
  }).join('');
  const glyphs = TERMINAL_GLYPH_CODE_POINTS.map(glyph).join(' ');
  const attributes = [
    `${sgr(1)}bold${RESET}`,
    `${sgr(2)}dim${RESET}`,
    `${sgr(3)}italic${RESET}`,
    `${sgr(4)}underline${RESET}`,
    `${sgr(7)}inverse${RESET}`,
    `${sgr(9)}strike${RESET}`,
    `${sgr(1, 4, 7)}all three${RESET}`,
  ].join('  ');
  return [
    box.top('FIXTURE terminal colours'),
    box.row(`${label('text')}${eight((index) => [30 + index])}`),
    box.row(`${label('bright')}${eight((index) => [90 + index])}`),
    box.row(`${label('bold')}${eight((index) => [1, 30 + index])}`),
    box.row(`${label('dim')}${eight((index) => [2, 30 + index])}`),
    box.row(`${label('inverse')}${eight((index) => [7, 30 + index])}`),
    box.row(`${label('back')}${eight((index) => [40 + index, index === 0 || index === 4 ? 97 : 30])}`),
    box.row(`${label('back +')}${eight((index) => [100 + index, 30])}`),
    box.row(`${label('style')}${attributes}`),
    box.row(`${label('256')}${ramp256}`),
    box.row(`${label('rgb')}${rampTrue}`),
    box.row(`${label('glyphs')}${glyphs}`),
    box.row(`${label('box')}${BOX_SHOWCASE.map(glyph).join('')}`),
    box.bottom(),
    '',
    `${sgr(33)}${MARK}${RESET} Welcome to the ${sgr(1)}FIXTURE${RESET} session`,
    `${sgr(32)}${TOOL}${RESET} ${sgr(1)}Bash${RESET}(npm test)`,
    `  ${sgr(2)}${RESULT}${RESET} ${sgr(32)}214 tests passed${RESET} ${sgr(2)}(12.4 s)${RESET}`,
    `${sgr(35)}${PROMPT}${RESET} `,
  ];
}

function vietnameseScreen(size: SampleSize): string[] {
  const letters = vietnameseLetters();
  // whole alphabets per row when the window is wide enough, else the lower case and the capitals on a row each
  const perRow = size.cols >= letters.length ? letters.length : Math.max(1, Math.min(size.cols, letters.length / 2));
  const lines: string[] = [];
  for (const code of ANSI_FOREGROUND_CODES) {
    for (let at = 0; at < letters.length; at += perRow) {
      lines.push(`${sgr(code)}${letters.slice(at, at + perRow).join('')}${RESET}`);
    }
  }
  const title = `${sgr(1)}FIXTURE${RESET} ${String(letters.length)} letters x ${String(ANSI_FOREGROUND_CODES.length)} colours`;
  // the title only where it does not push the first colour off the screen
  return lines.length + 1 <= size.rows ? [title, ...lines] : lines;
}

function sessionScreen(size: SampleSize): string[] {
  const width = widthFor(size);
  const box = frame(width, true);
  const tool = (call: string, result: string): string[] => [
    `${sgr(32)}${TOOL}${RESET} ${sgr(1)}Bash${RESET}(${call})`,
    `  ${sgr(2)}${RESULT}${RESET} ${result}`,
    '',
  ];
  return [
    box.top(''),
    box.row(`${sgr(33)}${MARK}${RESET} Welcome to the ${sgr(1)}FIXTURE${RESET} session`),
    box.row(`${sgr(2)}  /help for help, /status for the current setup${RESET}`),
    box.row(`${sgr(2)}  cwd: FIXTURE project${RESET}`),
    box.bottom(),
    '',
    `${sgr(2)}${PROMPT}${RESET} Run the release checklist`,
    '',
    `${TOOL} I will start with the lint check and then run the tests.`,
    '',
    ...tool('npm run lint', 'Lint finished without problems'),
    ...tool('npm test', `${sgr(32)}214 tests passed${RESET} ${sgr(2)}(12.4 s)${RESET}`),
    `${TOOL} Both checks pass. The checklist is done.`,
    '',
    box.top(''),
    box.row(`${PROMPT} `),
    box.bottom(),
    `${sgr(2)}  ? for shortcuts${RESET}`,
  ];
}

/** The lines of a screen, without line ends: what `sampleText` joins. */
export function sampleLines(name: SampleName, size: SampleSize): string[] {
  switch (name) {
    case 'colors':
      return colorsScreen(size);
    case 'vietnamese':
      return vietnameseScreen(size);
    case 'session':
      return sessionScreen(size);
  }
}

/** A screen as the text a program writes: the lines joined by CR LF, the cursor left at the end of the last line. */
export function sampleText(name: SampleName, size: SampleSize): string {
  return sampleLines(name, size).join(CRLF);
}

const encoder = new TextEncoder();

/** A screen as the bytes of a binary frame (UTF-8). */
export function sampleBytes(name: SampleName, size: SampleSize): Uint8Array {
  return encoder.encode(sampleText(name, size));
}

/** `text` without its escape sequences: the characters that land in cells. */
export function visibleText(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf(CSI, at);
    if (start < 0) return out + text.slice(at);
    out += text.slice(at, start);
    let end = start + CSI.length;
    // a control sequence ends at its first byte from 0x40 to 0x7e
    while (end < text.length && !/[@-~]/.test(text.charAt(end))) end += 1;
    at = end + 1;
  }
  return out;
}
