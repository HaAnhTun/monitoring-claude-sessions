// Retention (03 3.8, 11.3, ADR 0028): two classes with different safety rules.
//
//  - `runBookkeepingRetention` is the automatic one, run by the server schedule (job `retention`). It trims bookkeeping only:
//    the change log, ingest error rows, resolved alerts and idle alert states, instance level reconciliations, hook probes
//    older than 24 h and the leftovers of retired transcript files. It never touches sessions, events, usage, attempts or any
//    other table, and it deletes in transactions of at most 5,000 rows so the one writer connection is never held for long.
//  - `applyRetention` is the explicit one (`mcs cleanup --scope data`, on a stopped instance after its backup): it deletes
//    sessions that are old, not pinned and not active, and/or old timeline rows. `dryRun` only reads. Attempt runs are
//    evidence (06 3.10.8): their rows are detached from a deleted session and never deleted. A transcript file of a deleted
//    session stays as a `retired` tombstone with its cursors, so the importer never reads its history again.
//
// Both yield to the event loop between transactions (the ingest writer shares the connection and commits in the gaps), and
// both check the abort signal between transactions. SQL that no repository offers (batch selection, bulk deletes of a batch of
// files) is kept in this file next to the one algorithm that uses it.
import { statSync } from 'node:fs';

import { ACTIVE_STATES, LIFECYCLE_STATES } from '@mcs/shared';

import { pragmaNumber } from '../db/driver.ts';
import { DbError } from '../db/errors.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AlertsRepo } from '../db/repos/alerts.ts';
import { AttemptsRepo } from '../db/repos/attempts.ts';
import { ChangesRepo } from '../db/repos/changes.ts';
import { HookProbesRepo } from '../db/repos/hook-probes.ts';
import { IngestErrorsRepo } from '../db/repos/ingest-errors.ts';
import { ReconciliationsRepo } from '../db/repos/reconciliations.ts';
import { UsageRepo } from '../db/repos/usage.ts';
import { withWriteTx, type WriteTx } from '../db/write.ts';
import type { ResolvedConfig } from '../config/resolve.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Rows per transaction of the automatic retention and of the timeline step (03 3.8). */
const BATCH_ROWS = 5000;
/** Sessions per transaction of `applyRetention` (a cascade delete of 50 sessions took 1.1 s in one transaction, ADR 0028). */
const BATCH_SESSIONS = 10;
/** Pages per `incremental_vacuum` step (03 3.8). */
const VACUUM_PAGES = 2000;
/** The oldest sessions listed in a plan. */
const SAMPLE_SIZE = 20;
/** A hook probe is only needed until its answer is read (03 3.8). */
const PROBE_MAX_AGE_MS = 24 * HOUR_MS;

/** `retention.*` of `runtime.json` (03 3.8). */
export type RetentionSettings = ResolvedConfig['runtime']['retention'];

/** Lets the ingest writer (and the rest of the event loop) run between two transactions. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// ---- the automatic bookkeeping retention -----------------------------------------------------------------------------------

/** What one automatic run removed, per category (rows) and the pages `incremental_vacuum` gave back. */
export interface BookkeepingResult {
  readonly changes: number;
  readonly ingestErrors: number;
  readonly resolvedAlerts: number;
  readonly alertStates: number;
  readonly instanceReconciliations: number;
  readonly hookProbes: number;
  /** Rows of `transcript_checkpoints`, `usage_files` and `entry_occurrences` that belong to retired transcript files. */
  readonly retiredFileRows: number;
  readonly vacuumedPages: number;
}

export interface BookkeepingOptions {
  /** Rows per transaction; production 5,000. */
  readonly batchRows?: number;
  /** Pages per `incremental_vacuum` step; production 2,000. */
  readonly vacuumPages?: number;
  readonly signal?: AbortSignal;
}

/** The three tables that hold rows of a transcript file by `file_id`, with the columns of their primary key. */
const FILE_TABLES = [
  { table: 'transcript_checkpoints', key: 'file_id, entry_index' },
  { table: 'usage_files', key: 'file_id, message_key' },
  { table: 'entry_occurrences', key: 'file_id, byte_offset' },
] as const;

/** `WITHOUT ROWID` tables have no `rowid` to select, so the batch is chosen by the primary key as a row value. */
function orphanDeleteSql(table: string, key: string): string {
  return `DELETE FROM ${table} WHERE (${key}) IN (
    SELECT ${key} FROM ${table}
     WHERE file_id IN (SELECT id FROM transcript_files WHERE state = 'retired' AND session_id IS NULL) LIMIT :limit)`;
}

/**
 * Runs `step` in its own transaction until it removes fewer rows than a full batch, yielding in between. Returns the total.
 * A `step` that always reports a full batch without making progress would never end, so each step must delete what it counts.
 */
async function drain(
  db: InstanceDb,
  ctx: RepoContext,
  limit: number,
  signal: AbortSignal | undefined,
  step: (tx: WriteTx) => number,
): Promise<number> {
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const removed = withWriteTx(db, ctx, step);
    total += removed;
    if (removed < limit) return total;
    await yieldToLoop();
  }
}

/** Gives free pages back until the freelist is empty or a step frees nothing (the file is not in incremental mode). */
async function vacuum(db: InstanceDb, pages: number, signal: AbortSignal | undefined): Promise<number> {
  let freed = 0;
  let free = pragmaNumber(db.driver, 'freelist_count');
  while (free > 0) {
    signal?.throwIfAborted();
    db.driver.pragma(`incremental_vacuum(${String(pages)})`);
    const left = pragmaNumber(db.driver, 'freelist_count');
    if (left >= free) break;
    freed += free - left;
    free = left;
    if (free > 0) await yieldToLoop();
  }
  return freed;
}

/**
 * The automatic retention of the server (03 3.8, DA-T-E-5). `now` is epoch ms; the cutoffs come from `retention.*`. The change
 * log keeps the rows of the last `changesMaxAgeHours` and at most `changesMaxRows` of the newest, whichever removes more.
 */
export async function runBookkeepingRetention(
  db: InstanceDb,
  ctx: RepoContext,
  config: RetentionSettings,
  now: number,
  options: BookkeepingOptions = {},
): Promise<BookkeepingResult> {
  db.assertScope(ctx);
  const limit = options.batchRows ?? BATCH_ROWS;
  const { signal } = options;
  const changes = new ChangesRepo(db);
  const errors = new IngestErrorsRepo(db);
  const alerts = new AlertsRepo(db);
  const reconciliations = new ReconciliationsRepo(db);
  const probes = new HookProbesRepo(db);

  const byAge = await drain(db, ctx, limit, signal, (tx) =>
    changes.deleteOlderThan(ctx, tx, now - config.changesMaxAgeHours * HOUR_MS, limit),
  );
  const byCount = await drain(db, ctx, limit, signal, (tx) =>
    changes.deleteBeyondMaxRows(ctx, tx, config.changesMaxRows, limit),
  );
  const ingestErrors = await drain(db, ctx, limit, signal, (tx) =>
    errors.trimToNewest(ctx, tx, config.ingestErrorsMaxRows, limit),
  );
  const resolvedCutoff = now - config.resolvedAlertsDays * DAY_MS;
  const resolvedAlerts = await drain(db, ctx, limit, signal, (tx) =>
    alerts.deleteResolvedBefore(ctx, tx, resolvedCutoff, limit),
  );
  const alertStates = await drain(db, ctx, limit, signal, (tx) =>
    alerts.deleteIdleStatesBefore(ctx, tx, resolvedCutoff, limit),
  );
  const reconciliationCutoff = now - config.instanceReconciliationsDays * DAY_MS;
  const instanceReconciliations = await drain(db, ctx, limit, signal, (tx) =>
    reconciliations.deleteInstanceLevelBefore(ctx, tx, reconciliationCutoff, limit),
  );
  const probeCutoff = now - PROBE_MAX_AGE_MS;
  const hookProbes = await drain(db, ctx, limit, signal, (tx) =>
    probes.deleteCommittedBefore(ctx, tx, probeCutoff, limit),
  );
  let retiredFileRows = 0;
  for (const { table, key } of FILE_TABLES) {
    const statement = db.driver.prepare(orphanDeleteSql(table, key));
    retiredFileRows += await drain(db, ctx, limit, signal, () => statement.run({ limit }).changes);
  }
  const vacuumedPages = await vacuum(db, options.vacuumPages ?? VACUUM_PAGES, signal);
  return {
    changes: byAge + byCount,
    ingestErrors,
    resolvedAlerts,
    alertStates,
    instanceReconciliations,
    hookProbes,
    retiredFileRows,
    vacuumedPages,
  };
}

// ---- data retention --------------------------------------------------------------------------------------------------------

export interface RetentionPolicy {
  /** Sessions whose last activity is older than this many days are deleted; `null` keeps them. */
  readonly sessionsOlderThanDays: number | null;
  /** Timeline rows (events) older than this many days are deleted; `null` keeps them. Sessions and tool calls stay. */
  readonly eventsOlderThanDays: number | null;
}

export interface RetentionSessionSample {
  readonly sessionId: string;
  readonly label: string;
  /** Epoch ms. */
  readonly lastActivityAt: number;
  readonly state: string;
}

export interface RetentionPlan {
  /** Epoch ms the cutoffs were computed from. */
  readonly now: number;
  /** Sessions with `last_activity_at` below this are candidates; `null` = the policy keeps sessions. */
  readonly sessionsCutoff: number | null;
  readonly eventsCutoff: number | null;
  /** How many sessions the run deletes. */
  readonly sessions: number;
  /** The oldest of them, at most 20. */
  readonly sessionSample: readonly RetentionSessionSample[];
  /** Rows that go with them (events also counts the rows of the timeline step), and attempt runs that are detached. */
  readonly rows: {
    readonly agents: number;
    readonly events: number;
    readonly toolCalls: number;
    readonly turns: number;
    readonly usage: number;
    readonly usageFiles: number;
    readonly transitions: number;
    readonly reconciliations: number;
    readonly costStates: number;
    readonly checkpoints: number;
    readonly attemptRunsDetached: number;
  };
  /** Message keys that another session's file still holds: their owner moves there. */
  readonly reownedMessages: number;
}

export interface ApplyRetentionOptions {
  /** True only reads: nothing is written, not even a checkpoint. */
  readonly dryRun: boolean;
  /** Epoch ms. */
  readonly now: number;
  readonly signal?: AbortSignal;
  /** Test seams; production 10 sessions and 5,000 rows per transaction. */
  readonly batch?: { readonly sessions?: number; readonly rows?: number };
}

export type RetentionResult = RetentionPlan & {
  /** True when the deletion ran (`dryRun` was false). */
  readonly applied: boolean;
  /** Size of the database file before minus after, in bytes; `null` for a dry run. */
  readonly freedBytes: number | null;
};

/** Sessions that are in none of the active states (03 3.8 step 1). */
const ELIGIBLE_STATES = LIFECYCLE_STATES.filter((state) => !ACTIVE_STATES.some((active) => active === state));
const ELIGIBLE_LIST = ELIGIBLE_STATES.map((state) => `'${state}'`).join(', ');

/** A session that the session policy may delete: old, not pinned, not active. */
const candidate = (alias: string): string =>
  `${alias}.last_activity_at < :sessionsCutoff AND ${alias}.pinned = 0 AND ${alias}.state IN (${ELIGIBLE_LIST})`;
const CANDIDATE_IDS = `SELECT cs.id FROM sessions cs WHERE ${candidate('cs')}`;
const CANDIDATE_UIDS = `SELECT cs.session_uid FROM sessions cs WHERE ${candidate('cs')}`;
const CANDIDATE_FILES = `SELECT cf.id FROM transcript_files cf WHERE cf.session_uid IN (${CANDIDATE_UIDS})`;

interface Counted {
  n: number;
}

function validDays(name: string, days: number | null): void {
  if (days !== null && (!Number.isSafeInteger(days) || days < 1)) {
    throw new RangeError(`${name} must be a whole number of days of at least 1, or null`);
  }
}

/** The plan: counts only, read in one read transaction (a dry run changes nothing). */
function planOf(db: InstanceDb, policy: RetentionPolicy, now: number): RetentionPlan {
  const sessionsCutoff = policy.sessionsOlderThanDays === null ? null : now - policy.sessionsOlderThanDays * DAY_MS;
  const eventsCutoff = policy.eventsOlderThanDays === null ? null : now - policy.eventsOlderThanDays * DAY_MS;
  return db.driver.transaction(() => {
    const { driver } = db;
    const count = (sql: string, params: Record<string, number>): number =>
      driver.prepare<Counted>(sql).get(params)?.n ?? 0;
    const empty = {
      agents: 0,
      events: 0,
      toolCalls: 0,
      turns: 0,
      usage: 0,
      usageFiles: 0,
      transitions: 0,
      reconciliations: 0,
      costStates: 0,
      checkpoints: 0,
      attemptRunsDetached: 0,
    };
    let sessions = 0;
    let sample: RetentionSessionSample[] = [];
    let rows = empty;
    let reownedMessages = 0;
    if (sessionsCutoff !== null) {
      const bound = { sessionsCutoff };
      const ofSessions = (table: string): number =>
        count(`SELECT count(*) AS n FROM ${table} WHERE session_id IN (${CANDIDATE_IDS})`, bound);
      const ofFiles = (table: string): number =>
        count(`SELECT count(*) AS n FROM ${table} WHERE file_id IN (${CANDIDATE_FILES})`, bound);
      sessions = count(`SELECT count(*) AS n FROM sessions s WHERE ${candidate('s')}`, bound);
      sample = driver
        .prepare<{ sessionId: string; label: string; lastActivityAt: number; state: string }>(
          `SELECT s.session_uid AS sessionId, s.label AS label, s.last_activity_at AS lastActivityAt, s.state AS state
             FROM sessions s WHERE ${candidate('s')} ORDER BY s.last_activity_at, s.id LIMIT ${String(SAMPLE_SIZE)}`,
        )
        .all(bound);
      rows = {
        agents: ofSessions('agents'),
        events: ofSessions('events'),
        toolCalls: ofSessions('tool_calls'),
        turns: ofSessions('turns'),
        usage: ofSessions('usage'),
        usageFiles: ofFiles('usage_files'),
        transitions: ofSessions('state_transitions'),
        reconciliations: ofSessions('reconciliations'),
        costStates: ofSessions('cost_states'),
        checkpoints: ofFiles('transcript_checkpoints'),
        attemptRunsDetached: ofSessions('attempt_runs'),
      };
      reownedMessages = count(
        `SELECT count(*) AS n FROM (
           SELECT DISTINCT uf.message_key FROM usage_files uf
            WHERE uf.file_id IN (${CANDIDATE_FILES})
              AND EXISTS (SELECT 1 FROM usage_files o WHERE o.message_key = uf.message_key
                            AND o.file_id NOT IN (${CANDIDATE_FILES})))`,
        bound,
      );
    }
    if (eventsCutoff !== null) {
      // the timeline step reaches every session that is not active and not pinned, except those the session policy deletes whole
      const except = sessionsCutoff === null ? '' : ` AND NOT (${candidate('s')})`;
      const timeline = count(
        `SELECT count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id
          WHERE e.ts < :eventsCutoff AND s.pinned = 0 AND s.state IN (${ELIGIBLE_LIST})${except}`,
        sessionsCutoff === null ? { eventsCutoff } : { eventsCutoff, sessionsCutoff },
      );
      rows = { ...rows, events: rows.events + timeline };
    }
    return { now, sessionsCutoff, eventsCutoff, sessions, sessionSample: sample, rows, reownedMessages };
  });
}

interface BatchSession {
  id: number;
  uid: string;
}

function fileSize(path: string): number {
  return statSync(path).size;
}

/**
 * Deletes the sessions of one batch with everything that hangs on them, in the caller's transaction (03 3.8 step 3). The order
 * differs from the design text in one place: the open alerts are resolved first, because the delete of the sessions sets their
 * `session_id` to NULL and they could not be found afterwards.
 */
function deleteBatch(db: InstanceDb, ctx: RepoContext, tx: WriteTx, batch: readonly BatchSession[]): void {
  const { driver } = db;
  const ids = JSON.stringify(batch.map((session) => session.id));
  const uids = JSON.stringify(batch.map((session) => session.uid));
  new AlertsRepo(db).resolveForSessions(
    ctx,
    tx,
    batch.map((session) => session.id),
    tx.now,
  );
  const items = driver
    .prepare<{ id: number }>(
      'SELECT DISTINCT work_item_id AS id FROM work_item_sessions WHERE session_id IN (SELECT value FROM json_each(:ids))',
    )
    .all({ ids })
    .map((row) => row.id);
  const files = JSON.stringify(
    driver
      .prepare<{ id: number }>(
        'SELECT id FROM transcript_files WHERE session_uid IN (SELECT value FROM json_each(:uids))',
      )
      .all({ uids })
      .map((row) => row.id),
  );
  // the keys that another file still holds: after the delete their owner and aggregate must be computed again
  const reowned = driver
    .prepare<{ key: string }>(
      `SELECT DISTINCT uf.message_key AS key FROM usage_files uf
        WHERE uf.file_id IN (SELECT value FROM json_each(:files))
          AND EXISTS (SELECT 1 FROM usage_files o WHERE o.message_key = uf.message_key
                        AND o.file_id NOT IN (SELECT value FROM json_each(:files)))`,
    )
    .all({ files })
    .map((row) => row.key);

  // cascades to agents, workflow runs, turns, tool calls, events, usage, cost states, transitions, session reconciliations,
  // external observations and work item links; `alerts.session_id` becomes NULL
  driver.prepare('DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(:ids))').run({ ids });
  for (const { table } of FILE_TABLES) {
    driver.prepare(`DELETE FROM ${table} WHERE file_id IN (SELECT value FROM json_each(:files))`).run({ files });
  }
  // a tombstone: the cursors stay, so the importer never reads the deleted history again
  driver
    .prepare(
      `UPDATE transcript_files SET state = 'retired', session_id = NULL, agent_id = NULL, workflow_run_id = NULL,
              index_offset = 0, index_head_hash = NULL, entries_total = 0, updated_at = :now
        WHERE id IN (SELECT value FROM json_each(:files))`,
    )
    .run({ files, now: tx.now });
  const usage = new UsageRepo(db);
  for (const key of reowned) usage.recomputeKey(ctx, tx, key);

  for (const id of items) {
    const seq = tx.changes.reserve('work_item', 'upsert', { entityId: id, sessionUid: null });
    driver
      .prepare(
        `UPDATE work_items SET session_count = (SELECT count(*) FROM work_item_sessions WHERE work_item_id = :id),
                updated_seq = :seq, updated_at = :now WHERE id = :id`,
      )
      .run({ id, seq, now: tx.now });
  }
  for (const session of batch) {
    tx.changes.reserve('session', 'delete', { entityId: session.id, sessionUid: session.uid });
  }
  // attempts are evidence (06 3.10.8): detached from the session, never deleted
  new AttemptsRepo(db).detachSessions(
    ctx,
    tx,
    batch.map((session) => session.id),
  );
}

/** Step 4: events older than the cutoff of sessions that stay. Returns how many rows went. */
function deleteOldEvents(db: InstanceDb, tx: WriteTx, eventsCutoff: number, limit: number): number {
  const { driver } = db;
  const rows = driver
    .prepare<{ id: number; sid: number }>(
      `SELECT e.id AS id, e.session_id AS sid FROM events e JOIN sessions s ON s.id = e.session_id
        WHERE e.ts < :eventsCutoff AND s.pinned = 0 AND s.state IN (${ELIGIBLE_LIST})
        ORDER BY e.ts, e.id LIMIT :limit`,
    )
    .all({ eventsCutoff, limit });
  if (rows.length === 0) return 0;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const sessions = JSON.stringify([...new Set(rows.map((row) => row.sid))]);
  driver.prepare('DELETE FROM events WHERE id IN (SELECT value FROM json_each(:ids))').run({ ids });
  driver
    .prepare(
      `UPDATE sessions SET event_count = (SELECT count(*) FROM events WHERE session_id = sessions.id), updated_at = :now
        WHERE id IN (SELECT value FROM json_each(:sessions))`,
    )
    .run({ sessions, now: tx.now });
  return rows.length;
}

/**
 * Data retention (03 3.8, DA-T-E-4). The caller made the backup and holds an instance that no server runs. `dryRun` returns the
 * plan without writing; otherwise the sessions go in batches of 10 (one transaction each), then the old timeline rows in batches
 * of 5,000, then the file is checkpointed and its free pages are given back. Never deletes an active or a pinned session, or
 * the events of one.
 */
export async function applyRetention(
  db: InstanceDb,
  ctx: RepoContext,
  policy: RetentionPolicy,
  opts: ApplyRetentionOptions,
): Promise<RetentionResult> {
  db.assertScope(ctx);
  validDays('sessionsOlderThanDays', policy.sessionsOlderThanDays);
  validDays('eventsOlderThanDays', policy.eventsOlderThanDays);
  if (!opts.dryRun && db.mode === 'readonly') {
    throw new DbError('db_readonly', 'a read-only database cannot be cleaned');
  }
  const plan = planOf(db, policy, opts.now);
  if (opts.dryRun) return { ...plan, applied: false, freedBytes: null };

  const { signal } = opts;
  const sessionBatch = opts.batch?.sessions ?? BATCH_SESSIONS;
  const rowBatch = opts.batch?.rows ?? BATCH_ROWS;
  db.driver.pragma('wal_checkpoint(TRUNCATE)');
  const sizeBefore = fileSize(db.driver.path);

  if (plan.sessionsCutoff !== null) {
    const { sessionsCutoff } = plan;
    const next = db.driver.prepare<BatchSession>(
      `SELECT s.id AS id, s.session_uid AS uid FROM sessions s WHERE ${candidate('s')}
        ORDER BY s.last_activity_at, s.id LIMIT :limit`,
    );
    const seen = new Set<number>();
    for (;;) {
      signal?.throwIfAborted();
      const batch = next.all({ sessionsCutoff, limit: sessionBatch });
      if (batch.length === 0) break;
      if (batch.some((session) => seen.has(session.id))) throw new Error('retention made no progress on a batch');
      for (const session of batch) seen.add(session.id);
      withWriteTx(db, ctx, (tx) => {
        deleteBatch(db, ctx, tx, batch);
      });
      await yieldToLoop();
    }
  }
  if (plan.eventsCutoff !== null) {
    const { eventsCutoff } = plan;
    for (;;) {
      signal?.throwIfAborted();
      const removed = withWriteTx(db, ctx, (tx) => deleteOldEvents(db, tx, eventsCutoff, rowBatch));
      if (removed < rowBatch) break;
      await yieldToLoop();
    }
  }
  db.driver.pragma('wal_checkpoint(TRUNCATE)');
  await vacuum(db, VACUUM_PAGES, signal);
  db.driver.pragma('wal_checkpoint(TRUNCATE)');
  return { ...plan, applied: true, freedBytes: Math.max(0, sizeBefore - fileSize(db.driver.path)) };
}
