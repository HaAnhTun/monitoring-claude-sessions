// The constants of the panel sources (06 3.5 source table, 3.8, 3.9). Everything here is a code constant: the one value
// that an owner can change, the process list interval, comes from `panelOptions.machineProcessIntervalMs` (WP-104).
// The machine sources are in the table too, so that the machine sampler of WP-104 edits no file of this one.
import type { PanelSource } from '@mcs/shared';

import type { SourceResult, SourceSpec } from './source-cache.ts';

/** The timing of one source (06 3.5): see `SourceSpec` for the meaning of each field. */
export interface SourceTiming {
  readonly ttlMs: number;
  /** `0`: the source is synchronous, a read waits for the load itself (still bounded by the hard deadline of the cache). */
  readonly firstWaitMs: number;
  readonly timeoutMs: number;
  readonly retryAfterUnavailableMs: number;
}

export const PANEL_SOURCE_TABLE: Readonly<Record<PanelSource, SourceTiming>> = {
  memory: { ttlMs: 1800, firstWaitMs: 0, timeoutMs: 1000, retryAfterUnavailableMs: 1800 },
  cpu: { ttlMs: 1800, firstWaitMs: 0, timeoutMs: 1000, retryAfterUnavailableMs: 1800 },
  // `ttlMs` here is the default of `panelOptions.machineProcessIntervalMs`; the machine sampler passes the configured one.
  processes: { ttlMs: 20_000, firstWaitMs: 3000, timeoutMs: 10_000, retryAfterUnavailableMs: 300_000 },
  docker: { ttlMs: 15_000, firstWaitMs: 3000, timeoutMs: 8000, retryAfterUnavailableMs: 300_000 },
  'git.status': { ttlMs: 15_000, firstWaitMs: 3000, timeoutMs: 10_000, retryAfterUnavailableMs: 300_000 },
  // The log is read again when `headOid` changes (a new cache) or after this ttl.
  'git.log': { ttlMs: 120_000, firstWaitMs: 3000, timeoutMs: 10_000, retryAfterUnavailableMs: 300_000 },
  stopFile: { ttlMs: 2000, firstWaitMs: 1000, timeoutMs: 1000, retryAfterUnavailableMs: 2000 },
  ledger: { ttlMs: 5000, firstWaitMs: 1000, timeoutMs: 1000, retryAfterUnavailableMs: 5000 },
  chainLog: { ttlMs: 5000, firstWaitMs: 1000, timeoutMs: 1000, retryAfterUnavailableMs: 5000 },
  logs: { ttlMs: 2000, firstWaitMs: 1000, timeoutMs: 2000, retryAfterUnavailableMs: 2000 },
  attempts: { ttlMs: 2000, firstWaitMs: 1000, timeoutMs: 2000, retryAfterUnavailableMs: 2000 },
};

/** A `SourceSpec` from the table; `over` replaces fields (the configured process interval, a test's short ttl). */
export function specFor<T>(
  source: PanelSource,
  load: (signal: AbortSignal) => Promise<SourceResult<T>>,
  over: Partial<SourceTiming> = {},
): SourceSpec<T> {
  return { source, ...PANEL_SOURCE_TABLE[source], ...over, load };
}

/** A failed refresh waits `ttl * 2^failures`, at most this long (06 3.5 step 2). */
export const ERROR_BACKOFF_CAP_MS = 300_000;

/** A source that does not settle within `timeoutMs` plus this grace is abandoned and counts as an error. */
export const HARD_DEADLINE_GRACE_MS = 1000;

/** The same `(source, message)` goes to the error ring at most once in this window. */
export const ERROR_RING_WINDOW_MS = 60_000;

/** A message of a source state is clipped to this many code points (contract: at most 200). */
export const SOURCE_MESSAGE_MAX_CHARS = 200;

// ---- git (06 3.8) ----------------------------------------------------------------------------------------------------

/** The log is read again after this long even when the head did not move. */
export const GIT_LOG_MAX_AGE_MS = 120_000;
export const GIT_COMMITS_SHOWN = 3;
/** A commit subject is clipped to this many code points. */
export const GIT_SUBJECT_MAX_CHARS = 300;
/** `status --porcelain=v2` of a very dirty repository; above this the call is an error rather than a wrong count. */
export const GIT_STATUS_MAX_BYTES = 4 * 1024 * 1024;
export const GIT_LOG_MAX_BYTES = 256 * 1024;

// ---- files (06 3.9) --------------------------------------------------------------------------------------------------

export const LEDGER_TAIL_LINES = 30;
export const CHAIN_LOG_TAIL_LINES = 10;
export const LOG_FILES_SHOWN = 4;
/** Only the newest files of this count get a tail. */
export const LOG_FILES_WITH_TAIL = 2;
export const LOG_TAIL_LINES = 16;
export const LOG_LINE_MAX_CODE_POINTS = 220;
export const LOG_GLOB_MAX_MATCHES = 500;
export const LOG_GLOB_MAX_DEPTH = 8;
export const LOG_CAPPED_MESSAGE = `more than ${String(LOG_GLOB_MAX_MATCHES)} files match live_log_globs; showing the newest of the first ${String(LOG_GLOB_MAX_MATCHES)}`;
