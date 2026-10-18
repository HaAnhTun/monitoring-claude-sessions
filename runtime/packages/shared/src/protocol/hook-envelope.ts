/**
 * Hook envelope v1, caps, spool segment names and id patterns (02 2.3, 2.7; 98 1.7 and 10.1).
 *
 * Zod-free and dependency-free: the hook handler imports this file (through `@mcs/shared/protocol`) and must
 * start fast. The zod mirror of `HookEnvelopeV1` is `HookEnvelopeV1Schema` in `schemas/ingest.ts`.
 */

export const HOOK_ENVELOPE_VERSION = 1 as const;

/** Version the handler reports (`--version`, envelope `handler.version`). Equals `RUNTIME_VERSION` (98 1.7, N2). */
export const HANDLER_VERSION = '4.0.0';

// ---- caps (98 10.1) ----------------------------------------------------------------------------------------------
/** Hard exit of the handler process, ms. */
export const HANDLER_HARD_EXIT_MS = 1200;
/** Stdin bytes kept in memory by the handler. */
export const STDIN_MAX_BYTES = 8 * 1024 * 1024;
/** Largest spool line; a longer one is replaced by the minimal envelope. */
export const ENVELOPE_MAX_BYTES = 16 * 1024;
/** Above this segment size every new line is a minimal envelope. */
export const SPOOL_SEGMENT_SOFT_CAP = 64 * 1024 * 1024;
/** Above this segment size nothing is written (`SPOOL_FULL`). */
export const SPOOL_SEGMENT_HARD_CAP = 256 * 1024 * 1024;
/** Longest the handler waits for the nudge request, ms. */
export const NUDGE_TIMEOUT_MS = 300;
/** Tool summaries and previews, code points. */
export const SUMMARY_MAX_CP = 160;
/** Title previews, code points. */
export const TITLE_MAX_CP = 80;
/** Paths, chars (after normalization). */
export const PATH_MAX_CHARS = 1024;
/** Ids, chars. */
export const ID_MAX_CHARS = 128;
/** Event names, agent types and enums, chars. */
export const NAME_MAX_CHARS = 64;
/** Route files read per event. */
export const ROUTES_MAX_FILES = 64;
/** Largest route file, bytes. */
export const ROUTE_FILE_MAX_BYTES = 16 * 1024;
/** Entries kept in `data.calls` of a minimal envelope. */
export const MINIMAL_CALLS_MAX = 16;

// ---- spool segments (02 2.7) -------------------------------------------------------------------------------------
/** Never `.jsonl`: the legacy audit flags every `*.jsonl` in a workspace (02 2.7, X1, I-02). */
export const SPOOL_SEGMENT_EXT = '.ndjson' as const;
export const SPOOL_SEGMENT_RE = /^hooks-(\d{8})T(\d{2})Z\.ndjson$/;

/** `hooks-<YYYYMMDD>T<HH>Z.ndjson`: the UTC hour of `receivedAt`. */
export function spoolSegmentName(receivedAt: number): string {
  const date = new Date(receivedAt);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(receivedAt) || Number.isNaN(year) || year < 0 || year > 9999) {
    throw new RangeError('spoolSegmentName: not a time with a four digit UTC year');
  }
  const two = (n: number): string => String(n).padStart(2, '0');
  const day = String(year).padStart(4, '0') + two(date.getUTCMonth() + 1) + two(date.getUTCDate());
  return 'hooks-' + day + 'T' + two(date.getUTCHours()) + 'Z' + SPOOL_SEGMENT_EXT;
}

// ---- id patterns (02 2.3.2; consumed by 03, 05 and the testkit instead of a second literal, I-26) ----------------
export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT_RE = /^[0-9A-Za-z_-]{3,64}$/;
export const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,64}$/;
/** `event` when the payload carries a usable `hook_event_name`. */
export const EVENT_NAME_RE = /^[A-Za-z]{1,64}$/;

// ---- probe (98 11.5) ---------------------------------------------------------------------------------------------
/** A probe payload has a `session_id` starting with this prefix and Notification type `mcs_probe`. */
export const PROBE_SESSION_PREFIX = '00000000-0000-4000-8000-';
export const PROBE_NOTIFICATION_TYPE = 'mcs_probe';

// ---- flags (02 2.3.3, closed set) --------------------------------------------------------------------------------
/**
 * `stdin_truncated`, `event_mismatch`, `minimal`, `redacted`, `routed_by_cwd`, `routed_by_session_pin`,
 * `invalid_<field>` (one per invalid id or path field) and `data_truncated:<field>`.
 */
export const ENVELOPE_FLAG_RE =
  /^(?:stdin_truncated|event_mismatch|minimal|redacted|routed_by_cwd|routed_by_session_pin|invalid_[a-z_]{1,48}|data_truncated:[A-Za-z_][A-Za-z0-9_]{0,47})$/;

/** Keys of `data` that survive in a minimal envelope (02 2.3.4); `calls` is cut to `MINIMAL_CALLS_MAX` entries. */
export const MINIMAL_DATA_KEYS = [
  'tool_name',
  'source',
  'reason',
  'notification_type',
  'trigger',
  'error',
  'exit_code',
  'calls',
] as const;

// ---- the envelope (02 2.3.1) -------------------------------------------------------------------------------------
export type EnvelopeKind = 'hook' | 'probe';

/** One value of `HookEnvelopeV1.data`: a scalar or a short list of flat string records (`calls`). */
export type EnvelopeDataValue = string | number | boolean | null | Record<string, string | null>[];

export interface HookEnvelopeV1 {
  v: 1;
  kind: EnvelopeKind;
  /** Route the line was written for (uuid); drainers reject other values. */
  instance_id: string;
  /** `crypto.randomUUID()`, generated once per handler run, the same in every routed copy. */
  event_uid: string;
  /** `T0 = Date.now()` at handler start (the closest available "occurred at"). */
  received_at: number;
  /** `payload.hook_event_name` if it matches `EVENT_NAME_RE`, else `argv_event`, else `'Unknown'`. */
  event: string;
  /** Event name from argv (`''` if absent). */
  argv_event: string;
  session_id: string | null;
  transcript_path: string | null;
  cwd: string | null;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  permission_mode: string | null;
  /** Env `CLAUDE_PID` when it is 1 to 10 digits. */
  claude_pid: number | null;
  /** Total stdin bytes (also beyond the cap). */
  payload_bytes: number;
  /** First 32 hex of the sha256 of the stdin bytes kept. */
  content_hash: string;
  handler: { version: string; pid: number; async: boolean };
  /** At most 32 entries, each matching `ENVELOPE_FLAG_RE`. */
  flags: string[];
  data: Record<string, EnvelopeDataValue>;
}
