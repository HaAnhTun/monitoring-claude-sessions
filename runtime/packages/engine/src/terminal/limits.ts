// Fixed constants of the terminal service (design 01 sections 3.3, 3.4, 3.7, 3.8). None of them is configuration: the
// values that an operator may change (session count, replay size, timeouts) are keys of the `terminal` config section.

/** The session name pattern of MTOP: the name appears in URLs and in the WebSocket path. */
export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Longest session name: the base, a dash and the number. */
export const SESSION_NAME_MAX = 64;
/** Longest folder-name part of a session name (MTOP `session_base`); the rest of the 64 is the dash and the number. */
export const SESSION_BASE_MAX = 60;

/** Smallest and largest size a terminal gets, in character cells (the clamps of MTOP). */
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;
/** Size of a new session when the request names none (MTOP). */
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;

/** Trailing debounce of a resize: the inbox conhost repaints the screen on every resize. */
export const RESIZE_DEBOUNCE_MS = 60;
/** Largest frame of a replay; also the cap of `replayFrames`. */
export const REPLAY_FRAME_BYTES = 65_536;
/** Bytes a viewer may have queued before the session evicts it as too slow. */
export const VIEWER_BACKLOG_LIMIT_BYTES = 4 * 1024 * 1024;
/** Period of the liveness watchdog that covers a missed exit event. */
export const LIVENESS_PROBE_MS = 5000;

/** A Claude session id as `claude --resume` takes it: a UUID, or any id of the same alphabet. */
export const RESUME_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/** The value of `TERM_PROGRAM` in a session. It follows the product name, so it changes with the rename. */
export const TERM_PROGRAM = 'CAW';

/** Longest Windows working folder: MAX_PATH once a file name is appended (CreateProcess fails with exit 267 beyond it). */
export const FOLDER_MAX_CHARS = 240;
/** Longest working folder on a POSIX host (PATH_MAX). */
export const FOLDER_MAX_CHARS_POSIX = 4096;
/** Input longer than this is refused before any work is done on it (the longest accepted folder fits twice). */
export const FOLDER_INPUT_MAX_CHARS = 8192;
