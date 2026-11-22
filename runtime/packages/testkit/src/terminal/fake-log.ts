// Reading the out-of-band log of the fake claude (design 08, section 2.4). `FAKE_CLAUDE_LOG=<file>` makes every fake claude of a
// test root append one JSON line per event (`start`, `stdin`, `resize`, `signal`, `cmd`, `exit`); the line format and its parser
// (`parseFakeLog`) are `fake-claude/protocol.ts`. This module is what a harness hands to a test: the entries of the file as they are
// now, and the questions tests ask of them (how many processes started, which bytes the pseudo console delivered, which commands
// ran, with which exit codes). Every process of the root appends to the same file and each numbers its own entries from 1, so the
// entries of two sessions that run at the same time interleave: the per-process questions (`runs`) are exact for sessions that ran
// one after the other, and the whole-file questions (`count`, `stdin`, `commands`, `exitCodes`) are exact always.
import { readFileSync } from 'node:fs';

import { parseFakeLog, type FakeLogEntry, type FakeLogEvent } from '../fake-claude/protocol.ts';

/** The log of the fake claudes of one test root, read at one moment. */
export interface FakeLog {
  /** Every entry of the file, in file order. Empty when no fake claude has written yet. */
  readonly entries: readonly FakeLogEntry[];
  /** The entries of one event. */
  of(ev: FakeLogEvent): FakeLogEntry[];
  /** How many entries of one event there are (`count('start')` is the number of fake claude processes that started). */
  count(ev: FakeLogEvent): number;
  /** The bytes the processes received on stdin, in file order: what the pseudo console really delivered. */
  stdin(): Buffer;
  /** The command words of the `cmd` entries, in file order (`/size`; `text` for a plain line, `paste` for a paste). */
  commands(): string[];
  /** The codes of the `exit` entries, in file order. A process that was killed wrote none. */
  exitCodes(): number[];
  /** The entries split at each `start` entry: one group per process, exact when the processes did not overlap. */
  runs(): FakeLogEntry[][];
}

/** The text of the file up to its last line feed: a line that a process is still writing is left for the next read. */
function completeLines(text: string): string {
  const end = text.lastIndexOf('\n');
  return end < 0 ? '' : text.slice(0, end + 1);
}

/** Wraps parsed entries in the questions of {@link FakeLog}. */
export function fakeLogOf(entries: readonly FakeLogEntry[]): FakeLog {
  const of = (ev: FakeLogEvent): FakeLogEntry[] => entries.filter((entry) => entry.ev === ev);
  return {
    entries,
    of,
    count: (ev) => of(ev).length,
    stdin: () =>
      Buffer.concat(
        of('stdin').map((entry) => {
          const hex = entry['hex'];
          return Buffer.from(typeof hex === 'string' ? hex : '', 'hex');
        }),
      ),
    commands: () => of('cmd').map((entry) => String(entry['name'])),
    exitCodes: () =>
      of('exit')
        .map((entry) => entry['code'])
        .filter((code): code is number => typeof code === 'number'),
    runs: () => {
      const groups: FakeLogEntry[][] = [];
      for (const entry of entries) {
        if (entry.ev === 'start' || groups.length === 0) groups.push([]);
        groups[groups.length - 1]?.push(entry);
      }
      return groups;
    },
  };
}

/**
 * Reads `file` (the `FAKE_CLAUDE_LOG` of a test root). A file that does not exist yet is an empty log: no fake claude has started.
 * Only complete lines are parsed; a line that is not a log entry throws (`parseFakeLog`), because the log is machine written.
 */
export function readFakeLog(file: string): FakeLog {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return fakeLogOf([]);
    throw error;
  }
  return fakeLogOf(parseFakeLog(completeLines(text)));
}
