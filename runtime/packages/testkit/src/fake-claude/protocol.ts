// The protocol of the fake claude (design 08, section 2): the tags a test waits for, the out-of-band log entry, the burst oracle
// and the parsers. `assets/fake-claude.mjs` is self-contained (Node built-ins only, no import from the repository), so it holds
// its own copy of every constant below; `fake-claude.test.ts` fails when the two drift apart.
import { detUuid } from '../transcript.ts';

/** Every answer of the fake starts with one of these tags at the beginning of a line. */
export const TAG = {
  ready: 'READY',
  echo: 'ECHO:',
  size: 'SIZE:',
  resize: 'RESIZE:',
  pid: 'PID:',
  cwd: 'CWD:',
  args: 'ARGS:',
  env: 'ENV:',
  envNames: 'ENVNAMES:',
  envScan: 'ENVSCAN:',
  colorsDone: 'COLORS-DONE',
  burstDone: 'BURST-DONE:',
  utf8Done: 'UTF8-DONE:',
  bye: 'BYE:',
  crash: 'CRASH',
  child: 'CHILD:',
  paste: 'PASTE:',
  interrupt: 'INTERRUPT',
  tab: 'TAB',
  signal: 'SIGNAL:',
  ignoring: 'IGNORING',
  lastWords: 'LAST-WORDS:',
  hostileDone: 'HOSTILE-DONE',
  transcript: 'TRANSCRIPT:',
  status: 'STATUS:',
  rewrote: 'REWROTE:',
  query: 'QUERY:',
  unknown: 'UNKNOWN:',
  error: 'ERROR:',
} as const;

export type FakeTag = (typeof TAG)[keyof typeof TAG];

/** First line of the banner, printed before `READY`. */
export const FAKE_BANNER = 'Claude Code (fake) 0.0.0-test';
/** Printed after every answer (and at the start). */
export const FAKE_PROMPT = '> ';
/** Sent at startup, as the real client does, so that a terminal wraps pasted text in `ESC[200~` ... `ESC[201~`. */
export const BRACKETED_PASTE_ON = '\x1b[?2004h';
/** The seed of the session id and the record ids when `FAKE_CLAUDE_SEED` is not set. */
export const FAKE_DEFAULT_SEED = 'fake-claude';
/** Exit code of `/crash` without an argument. */
export const FAKE_CRASH_CODE = 3;
/** `/envscan` refuses a needle shorter than this (an empty or tiny needle would "find" itself everywhere). */
export const ENVSCAN_MIN_NEEDLE = 8;
/** Names whose value `/env` prints; any other name prints `set` or `UNSET`. */
export const SAFE_ENV_NAMES: readonly string[] = [
  'COLORTERM',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
];
/** What `/utf8` repeats: a two-byte, a three-byte and a four-byte character. */
export const UTF8_UNIT: string = String.fromCodePoint(0xe9, 0x6f22, 0x20000);
/** `/burst` limits (KiB) and the default and the smallest line (bytes, line end included). */
export const BURST_MAX_KIB = 8192;
export const BURST_DEFAULT_LINE_BYTES = 100;
export const BURST_MIN_LINE_BYTES = 12;
/** The line of `/hostile` that has no line end. */
export const HOSTILE_LONG_LINE_BYTES = 1024 * 1024;

export type FakeLogEvent = 'start' | 'stdin' | 'resize' | 'signal' | 'cmd' | 'exit';

/**
 * One line of the `FAKE_CLAUDE_LOG` file: a counter `n` (from 1) and the event, no timestamps. `start` has `argv` and the sorted
 * environment `env` NAMES, `stdin` the received bytes as `hex`, `resize` `cols` and `rows`, `signal` the `name`, `cmd` the command
 * word as `name` (`text` for a plain line, `paste` for a paste) and the number of its arguments as `args`, `exit` the `code`.
 */
export interface FakeLogEntry {
  n: number;
  ev: FakeLogEvent;
  [key: string]: unknown;
}

const LOG_EVENTS: readonly string[] = ['start', 'stdin', 'resize', 'signal', 'cmd', 'exit'];

function isLogEntry(value: unknown): value is FakeLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const n: unknown = Reflect.get(value, 'n');
  const ev: unknown = Reflect.get(value, 'ev');
  return typeof n === 'number' && typeof ev === 'string' && LOG_EVENTS.includes(ev);
}

/** The entries of a log file's text, in order. A line that is not an entry throws: the log is machine written. */
export function parseFakeLog(text: string): FakeLogEntry[] {
  const entries: FakeLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const value: unknown = JSON.parse(line);
    if (!isLogEntry(value)) throw new Error(`parseFakeLog: not a fake claude log entry: ${line.slice(0, 80)}`);
    entries.push(value);
  }
  return entries;
}

/**
 * Merges runs of adjacent `stdin` entries (their `hex` joined) and numbers the entries again. The operating system may deliver
 * one write as several chunks; two runs of one scenario are equal after this.
 */
export function coalesceStdin(entries: readonly FakeLogEntry[]): FakeLogEntry[] {
  const merged: FakeLogEntry[] = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (entry.ev === 'stdin' && last?.ev === 'stdin') {
      last['hex'] = `${String(last['hex'])}${String(entry['hex'])}`;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged.map((entry, index) => ({ ...entry, n: index + 1 }));
}

/** FNV-1a, 32 bit, over the UTF-8 bytes of a string or over bytes. */
export function fnv1a32(data: string | Uint8Array): number {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1a32Hex(data: string | Uint8Array): string {
  return fnv1a32(data).toString(16).padStart(8, '0');
}

const BURST_FILL = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Line `seq` (from 0) of `/burst`: `B<seq, 6 digits>:<fill>` and CRLF, `lineBytes` bytes in all. The fill depends on `seq`, so a lost,
 * repeated or reordered line changes the checksum.
 */
export function burstLine(seq: number, lineBytes: number = BURST_DEFAULT_LINE_BYTES): string {
  if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) throw new RangeError(`burstLine: bad seq ${String(seq)}`);
  if (!Number.isInteger(lineBytes) || lineBytes < BURST_MIN_LINE_BYTES) {
    throw new RangeError(`burstLine: lineBytes must be an integer of at least ${String(BURST_MIN_LINE_BYTES)}`);
  }
  let fill = '';
  for (let i = 0; i < lineBytes - 10; i += 1) fill += BURST_FILL.charAt((seq + i) % BURST_FILL.length);
  return `B${String(seq).padStart(6, '0')}:${fill}\r\n`;
}

export interface BurstExpectation {
  readonly lines: number;
  readonly bytes: number;
  /** FNV-1a 32 of all line bytes, 8 hex digits. */
  readonly checksum: string;
  /** The text between the prompt of the command and the final tag. */
  readonly text: string;
  /** The final line without its line end: `BURST-DONE:<lines>:<checksum>`. */
  readonly done: string;
}

/** What `/burst <kib> [lineBytes]` writes (the arguments are clamped the way the fake clamps them). */
export function burstExpected(kib: number, lineBytes: number = BURST_DEFAULT_LINE_BYTES): BurstExpectation {
  const size = Math.min(Math.max(1, Math.trunc(kib)), BURST_MAX_KIB);
  const width = Math.max(BURST_MIN_LINE_BYTES, Math.trunc(lineBytes));
  const lines = Math.max(1, Math.floor((size * 1024) / width));
  let text = '';
  for (let seq = 0; seq < lines; seq += 1) text += burstLine(seq, width);
  const checksum = fnv1a32Hex(text);
  return { lines, bytes: lines * width, checksum, text, done: `${TAG.burstDone}${String(lines)}:${checksum}` };
}

export interface FakeReady {
  readonly pid: number;
  /** `null` when the fake has no terminal (pipe mode prints `unknown`). */
  readonly cols: number | null;
  readonly rows: number | null;
  readonly args: readonly string[];
}

/** Parses the `READY` line of the banner; `null` when the text has none. */
export function parseReady(text: string): FakeReady | null {
  const match = /^READY pid=(\d+) cols=(\d+|unknown) rows=(\d+|unknown) args=(.*)$/m.exec(text);
  if (match === null) return null;
  const [, pid, cols, rows, args] = match;
  const parsed: unknown = JSON.parse(args ?? '[]');
  if (!Array.isArray(parsed)) return null;
  const list: unknown[] = parsed;
  const strings = list.filter((item): item is string => typeof item === 'string');
  if (strings.length !== list.length) return null;
  return {
    pid: Number(pid),
    cols: cols === 'unknown' ? null : Number(cols),
    rows: rows === 'unknown' ? null : Number(rows),
    args: strings,
  };
}

/** The session id a fake claude starts with: seeded like the record ids of the transcript builder, so it is stable and distinct per seed. */
export function fakeSessionId(seed: string = FAKE_DEFAULT_SEED): string {
  return detUuid(seed, 'session-0');
}
