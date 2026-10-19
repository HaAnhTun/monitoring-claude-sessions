// One line of the chain log through the configured START and END patterns (06 3.10.3 steps 6a to 6c, ADR 0059, ADR 0067).
//
// - Every match goes through `CompiledRegex.exec` (sticky, position 0, no state kept between calls); the named groups come
//   from `RegexMatch.groupdict()` and a group that did not take part is `null`.
// - A line is clipped to `MAX_MATCH_CODE_POINTS` code points before it is matched, so a hostile pattern or a hostile line of a
//   megabyte costs a bounded amount of work.
// - A START whose `time` group does not parse is skipped entirely: the END pattern is not tried on it (legacy `continue`).
//   An END whose time does not parse is kept with `endedAt: null`; the caller then uses the start time of the run.
// - Which panel and which rows exist is not decided here: `panels.attempts` gates the panel route, `attempts` plus `chain_log`
//   gate ingestion (06 3.1), and `ingest.ts` is the one caller.
import { clipCodePoints } from '../../platform/fsx.ts';
import { parseTimeWithFormat, timeFieldsToEpochMs } from '../../platform/time-format.ts';
import type { CompiledRegex } from '../../regex/index.ts';

/** The time format of a chain log when `attempts.time_format` is not set. */
export const DEFAULT_TIME_FORMAT = '%Y-%m-%d %H:%M:%S';

/** A line is matched on its first this many code points. */
export const MAX_MATCH_CODE_POINTS = 4096;

/** The earliest and the latest instant that has an ISO text with a four-digit year (0000-01-01 and 9999-12-31). */
const EARLIEST_MS = -62_167_219_200_000;
const LATEST_MS = 253_402_300_799_999;

/** The compiled patterns of `attempts` and the format of their `time` groups. */
export interface ChainPatterns {
  readonly start: CompiledRegex;
  readonly end: CompiledRegex;
  /** `attempts.time_format` or `DEFAULT_TIME_FORMAT`; validated at configuration load. */
  readonly timeFormat: string;
}

export interface ChainStart {
  readonly kind: 'start';
  /** The `part` group, `''` when the pattern has none or the group did not take part. */
  readonly part: string;
  /** `label_prefix` + `part`: the label of the session that belongs to this run. */
  readonly label: string;
  /** The exact text of the `n` group. */
  readonly nRaw: string | null;
  /** The `model` group, `null` when empty or absent. */
  readonly model: string | null;
  /** The `effort` group, `null` when empty or absent. */
  readonly effort: string | null;
  /** Epoch ms of the `time` group. */
  readonly startedAt: number;
}

export interface ChainEnd {
  readonly kind: 'end';
  /** The `part` group, `null` when the pattern has none or the group did not take part: such an END closes nothing. */
  readonly part: string | null;
  readonly label: string | null;
  /** Epoch ms of the `time` group, `null` when it does not parse. */
  readonly endedAt: number | null;
  readonly exitRaw: string | null;
  readonly statusRaw: string | null;
}

export type ChainLine = ChainStart | ChainEnd;

/** The first 4096 code points of `line`, without walking a line of a megabyte code point by code point. */
function clipLine(line: string): string {
  // A code point is at most two UTF-16 units, so 2 * 4096 units always hold the first 4096 code points.
  const window = line.length > 2 * MAX_MATCH_CODE_POINTS ? line.slice(0, 2 * MAX_MATCH_CODE_POINTS) : line;
  return clipCodePoints(window, MAX_MATCH_CODE_POINTS);
}

/** Epoch ms of a `time` group, or `null` when it is absent, does not follow the format, or has no ISO year-four-digit instant. */
function timeOf(text: string | null | undefined, format: string): number | null {
  if (text === null || text === undefined) return null;
  const fields = parseTimeWithFormat(text, format);
  if (fields === null) return null;
  const ms = timeFieldsToEpochMs(fields);
  return Number.isFinite(ms) && ms >= EARLIEST_MS && ms <= LATEST_MS ? ms : null;
}

/**
 * Reads one line of the chain log: a START, an END, or `null` (not a chain line, or a START whose time does not parse).
 * `labelPrefix` is `attempts.label_prefix` (`''` when not set).
 */
export function parseChainLine(line: string, patterns: ChainPatterns, labelPrefix: string): ChainLine | null {
  const text = clipLine(line);
  const start = patterns.start.exec(text);
  if (start !== null) {
    const groups = start.groupdict();
    const startedAt = timeOf(groups['time'], patterns.timeFormat);
    if (startedAt === null) return null;
    const part = groups['part'] ?? '';
    const model = groups['model'];
    const effort = groups['effort'];
    return {
      kind: 'start',
      part,
      label: labelPrefix + part,
      nRaw: groups['n'] ?? null,
      model: model === undefined || model === '' ? null : model,
      effort: effort === undefined || effort === '' ? null : effort,
      startedAt,
    };
  }
  const end = patterns.end.exec(text);
  if (end === null) return null;
  const groups = end.groupdict();
  const part = groups['part'] ?? null;
  return {
    kind: 'end',
    part,
    label: part === null ? null : labelPrefix + part,
    endedAt: timeOf(groups['time'], patterns.timeFormat),
    exitRaw: groups['exit'] ?? null,
    statusRaw: groups['status'] ?? null,
  };
}
