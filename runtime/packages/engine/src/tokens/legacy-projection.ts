// Legacy parity projection (02 6.5, ADR 0017): `TranscriptReader.usage()` and `add_usage` of the Python skill, reproduced from
// the persisted per-file rows so that the parity harness (06) and the legacy-compatible API fields can compare Node with Python.
//
// The legacy numbers are per FILE and per message id inside a file: the sum over the keys of the file of the largest top-level
// integer of each field, a missing value counting as 0 (`usage_files.legacy_*`, 02 6.2 rule 11). They are deliberately not the
// new totals: the new totals add the `iterations[0]` fallback and count a message copied into a resumed session once.
import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';

/** `usage` of one transcript file as `/api/sessions` shows it (legacy key names). */
export interface LegacyUsage {
  in: number;
  out: number;
  cr: number;
  cc: number;
  turns: number;
  /** Sorted distinct `message.model` values of the file, `<synthetic>` included. */
  models: string[];
  /** Timestamp string of the first record that has one ('' when none). */
  first: string;
  /** Lexicographic maximum of the timestamp strings of all records ('' when none). */
  last: string;
  /** `stop_reason` of the last assistant message in file order ('' when none). */
  stop: string;
  complete: boolean;
  scanned_pct: number;
  /** Present (true) only when the backfill of the file was skipped. */
  skipped?: true;
}

/** `usage_total` of a session: `add_usage` over its own file and every agent file. */
export interface LegacyUsageTotal {
  in: number;
  out: number;
  cr: number;
  cc: number;
  turns: number;
  complete: boolean;
}

interface FileDbRow {
  usage_state: 'complete' | 'partial' | 'skipped_backfill';
  head_end: number;
  backfill_offset: number;
  tail_start: number;
  tail_offset: number;
  size_seen: number;
  partial_bytes: number;
  first_ts_in_order: string | null;
  max_ts_string: string | null;
  last_stop_legacy: string | null;
}

interface SumsDbRow {
  in_sum: number | null;
  out_sum: number | null;
  cr_sum: number | null;
  cc_sum: number | null;
  turns: number;
}

const SUMS = `coalesce(sum(uf.legacy_in), 0) AS in_sum, coalesce(sum(uf.legacy_out), 0) AS out_sum,
  coalesce(sum(uf.legacy_cr), 0) AS cr_sum, coalesce(sum(uf.legacy_cc), 0) AS cc_sum, count(uf.message_key) AS turns`;

/** Models of one file kept in the answer (a file does not see more than a handful). */
const MODELS_LIMIT = 1000;

/** The kinds of transcript file that carry assistant messages. */
const USAGE_FILE_KINDS = "('session','subagent','workflow_agent')";

/** `scannedPct` of 02 5.5: the share of the file that the cursors have covered, at most 100. */
function scannedPct(row: FileDbRow): number {
  if (row.usage_state === 'skipped_backfill') return 0;
  const consumed = row.head_end + (row.backfill_offset - row.head_end) + (row.tail_offset - row.tail_start);
  return Math.min(100, Math.floor((100 * consumed) / Math.max(1, row.size_seen - row.partial_bytes)));
}

/** The legacy `usage` of one transcript file (`transcript_files.id`); `undefined` when the file is not known. */
export function legacyFileUsage(db: InstanceDb, ctx: RepoContext, fileId: number): LegacyUsage | undefined {
  db.assertScope(ctx);
  const file = db.driver
    .prepare<FileDbRow>(
      `SELECT usage_state, head_end, backfill_offset, tail_start, tail_offset, size_seen, partial_bytes,
              first_ts_in_order, max_ts_string, last_stop_legacy
         FROM transcript_files WHERE id = ?`,
    )
    .get([fileId]);
  if (file === undefined) return undefined;
  const sums = db.driver.prepare<SumsDbRow>(`SELECT ${SUMS} FROM usage_files uf WHERE uf.file_id = ?`).get([fileId]);
  const models = db.driver
    .prepare<{ model: string }>(
      'SELECT DISTINCT model FROM usage_files WHERE file_id = ? AND model IS NOT NULL ORDER BY model LIMIT ?',
    )
    .all([fileId, MODELS_LIMIT])
    .map((r) => r.model);
  const usage: LegacyUsage = {
    in: sums?.in_sum ?? 0,
    out: sums?.out_sum ?? 0,
    cr: sums?.cr_sum ?? 0,
    cc: sums?.cc_sum ?? 0,
    turns: sums?.turns ?? 0,
    models,
    first: file.first_ts_in_order ?? '',
    last: file.max_ts_string ?? '',
    stop: file.last_stop_legacy ?? '',
    complete: file.usage_state === 'complete',
    scanned_pct: scannedPct(file),
  };
  if (file.usage_state === 'skipped_backfill') usage.skipped = true;
  return usage;
}

/** The legacy `usage_total` of a session (`sessions.id`): sums of in, out, cr, cc, turns over its files, `complete` = AND. */
export function legacyUsageTotal(db: InstanceDb, ctx: RepoContext, sessionId: number): LegacyUsageTotal {
  db.assertScope(ctx);
  const params: SqlValue[] = [sessionId];
  const sums = db.driver
    .prepare<SumsDbRow>(
      `SELECT ${SUMS} FROM usage_files uf JOIN transcript_files f ON f.id = uf.file_id
        WHERE f.session_id = ? AND f.kind IN ${USAGE_FILE_KINDS} AND f.state <> 'retired'`,
    )
    .get(params);
  const incomplete = db.driver
    .prepare<{ found: number }>(
      `SELECT 1 AS found FROM transcript_files f
        WHERE f.session_id = ? AND f.kind IN ${USAGE_FILE_KINDS} AND f.state <> 'retired' AND f.usage_state <> 'complete' LIMIT 1`,
    )
    .get(params);
  return {
    in: sums?.in_sum ?? 0,
    out: sums?.out_sum ?? 0,
    cr: sums?.cr_sum ?? 0,
    cc: sums?.cc_sum ?? 0,
    turns: sums?.turns ?? 0,
    complete: incomplete === undefined,
  };
}
