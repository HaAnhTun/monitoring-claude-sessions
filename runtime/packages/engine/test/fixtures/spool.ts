// Spool fixtures (02 2.7, 9.1): write envelopes the way the hook handler does (one `appendFileSync` per line, LF, the segment of
// the UTC hour of `received_at`) so that the drainer reads real files. The malformed cases of 02 4.8 are built here too.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spoolSegmentName, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import { z } from 'zod';

import type { InstanceDb } from '../../src/db/open.ts';

/** The JSON line of an envelope, without its LF. */
export function envelopeLine(envelope: HookEnvelopeV1): string {
  return JSON.stringify(envelope);
}

/** Appends the envelopes to the segment of their hour. Returns the segment names touched, in first-use order. */
export function appendEnvelopes(spoolDir: string, envelopes: readonly HookEnvelopeV1[]): string[] {
  mkdirSync(spoolDir, { recursive: true });
  const touched: string[] = [];
  for (const envelope of envelopes) {
    const segment = spoolSegmentName(envelope.received_at);
    appendFileSync(join(spoolDir, segment), `${envelopeLine(envelope)}\n`);
    if (!touched.includes(segment)) touched.push(segment);
  }
  return touched;
}

/** Appends raw text (any bytes you like, including a torn line) to a named segment. */
export function appendRaw(spoolDir: string, segment: string, text: string | Buffer): void {
  mkdirSync(spoolDir, { recursive: true });
  appendFileSync(join(spoolDir, segment), text);
}

/** Replaces a segment (a replacement of the file: new inode on most systems). */
export function replaceSegment(spoolDir: string, segment: string, text: string): void {
  mkdirSync(spoolDir, { recursive: true });
  writeFileSync(join(spoolDir, segment), text);
}

/** The malformed lines of 02 4.8 for the spool, each paired with the code it must be counted as. */
export function malformedSpoolLines(valid: HookEnvelopeV1): { code: string; line: string }[] {
  const text = JSON.stringify(valid);
  const withKey = (patch: Record<string, unknown>): string => JSON.stringify({ ...valid, ...patch });
  return [
    { code: 'SPOOL_LINE_INVALID_JSON', line: '{"v":1,"kind":"hook",' },
    { code: 'SPOOL_LINE_INVALID_JSON', line: 'not json at all' },
    { code: 'ENVELOPE_SCHEMA', line: '[1,2,3]' },
    { code: 'ENVELOPE_SCHEMA', line: withKey({ unknown_top_level_key: 1 }) },
    { code: 'ENVELOPE_SCHEMA', line: withKey({ received_at: 'yesterday' }) },
    { code: 'ENVELOPE_VERSION', line: withKey({ v: 2 }) },
    { code: 'INSTANCE_MISMATCH', line: withKey({ instance_id: '99999999-9999-4999-8999-999999999999' }) },
    { code: 'INVALID_SESSION_ID', line: text.replace('"session_id":"', '"session_id":"NOT-A-UUID-') },
  ];
}

type Row = Record<string, string | number | null>;

/**
 * The rows the ingestion writes, with every autoincrement id replaced by the provider ids they stand for, in an order that
 * does not depend on the order of arrival: two databases that hold the same facts dump to equal values (T-PL-02, T-PL-09).
 * Times that the test clock fixes (`updated_at`, `evaluated_at`) are left out; the stamps of the facts are in.
 */
export function dumpDatabase(db: InstanceDb): Record<string, Row[]> {
  const all = (sql: string): Row[] => db.driver.prepare<Row>(sql).all();
  return {
    sessions: all(`SELECT session_uid, state, presence, wait_reason, stale_kind, end_reason, turn_outcome, state_rule,
        state_evidence, next_check_at, facts_json, event_count, tool_call_count, open_tool_count, error_count, warning_count,
        agent_count, started_at, last_activity_at, last_hook_at, ended_at, cwd, claude_pid, last_model,
        hook_coverage, hook_missing_tools, hook_missing_turns
      FROM sessions ORDER BY session_uid`),
    agents: all(`SELECT s.session_uid, a.agent_uid, a.kind, a.agent_type, a.spawn_tool_use_id, a.state, a.state_rule,
        a.facts_json, a.started_at, a.last_activity_at, a.ended_at
      FROM agents a JOIN sessions s ON s.id = a.session_id ORDER BY s.session_uid, a.agent_uid`),
    tool_calls: all(`SELECT s.session_uid, t.tool_use_id, t.name, t.prompt_id, t.summary, t.input_hash, t.started_at,
        t.ended_at, t.batch_at, t.outcome, t.exit_code, t.duration_ms, t.sources
      FROM tool_calls t JOIN sessions s ON s.id = t.session_id ORDER BY t.tool_use_id`),
    turns: all(`SELECT s.session_uid, u.prompt_id, u.started_at, u.ended_at, u.end_kind, u.origin, u.tool_count
      FROM turns u JOIN sessions s ON s.id = u.session_id ORDER BY s.session_uid, u.prompt_id`),
    events: all(`SELECT s.session_uid, e.kind, e.severity, e.sources, e.natural_key, e.event_uid, e.hook_event, e.ts,
        e.ts_rank, e.ts_tie, e.summary
      FROM events e JOIN sessions s ON s.id = e.session_id ORDER BY e.ts, e.ts_rank, e.ts_tie, e.id`),
    ingest_errors: all('SELECT code, count(*) AS n FROM ingest_errors GROUP BY code ORDER BY code'),
    reconciliations: all(
      'SELECT scope_key, kind, at, detail FROM reconciliations ORDER BY scope_key, kind, at, detail',
    ),
    hook_probes: all('SELECT probe_session_id, received_at FROM hook_probes ORDER BY probe_session_id'),
    spool_cursors: all(
      'SELECT segment, offset_bytes, size_seen, lines, partial_bytes, sealed, errors FROM spool_cursors ORDER BY segment',
    ),
  };
}

/** Changes by kind: a replay must add no `session`, `event`, `tool_call` or `agent` change. */
export function changeCounts(db: InstanceDb): Record<string, number> {
  const rows = db.driver
    .prepare<{ kind: string; n: number }>('SELECT kind, count(*) AS n FROM changes GROUP BY kind')
    .all();
  return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
}

const CountersSchema = z.object({
  envelopes: z.number(),
  probes: z.number(),
  persistFailed: z.number(),
  duplicates: z.record(z.string(), z.number()),
  errors: z.record(z.string(), z.number()),
});

/** The durable counters of `ingest_health` (envelopes, probes, duplicates by layer, errors by code). */
export function readCounters(db: InstanceDb): z.infer<typeof CountersSchema> {
  const row = db.driver.prepare<{ counters_json: string }>('SELECT counters_json FROM ingest_health').get();
  return CountersSchema.parse(JSON.parse(row?.counters_json ?? '{}'));
}

/** Duplicates seen, over every layer. */
export function duplicatesSeen(db: InstanceDb): number {
  return Object.values(readCounters(db).duplicates).reduce((a, b) => a + b, 0);
}
