// A real database, a chain log in a temp folder and a stub writer for the tests of the attempts tick
// (`panels/attempts/attempts-{ingest,evidence}.test.ts`). Everything is synthetic; nothing leaves the temp folder.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach } from 'vitest';

import { compileConfigPatterns } from '../../src/config/validate-legacy.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../../src/db/open.ts';
import { SessionsRepo } from '../../src/db/repos/sessions.ts';
import { withWriteTx } from '../../src/db/write.ts';
import { IngestWriterClosedError } from '../../src/ingest/errors.ts';
import type { LogicalEvent } from '../../src/ingest/event-row.ts';
import type { IngestBatch } from '../../src/ingest/writer.ts';
import type { AttemptsTickContext } from '../../src/panels/attempts/ingest.ts';
import { createAttemptsStore, type AttemptsStore } from '../../src/panels/attempts/repo.ts';

export const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
export const SCOPE: RepoContext = { instanceId: INSTANCE_ID };
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** The clock of every harness starts here: 2026-01-01T10:00:00Z. */
export const BASE_MS = FIXTURE_EPOCH_MS + 10 * HOUR;

/** START and END patterns of a chain log such as `2026-01-01 10:00:05 STEP C START attempt 1 model haiku effort low`. */
export const START_PATTERN = String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) START attempt (?<n>[0-9]+) model (?<model>[a-z]+) effort (?<effort>[a-z]+)`;
export const END_PATTERN = String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) END exit=(?<exit>[0-9]+) status=(?<status>[A-Z_]+)`;

/** `YYYY-MM-DD HH:MM:SS` in UTC (the tests run with TZ=UTC), the default time format. */
export function logTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function startLine(ms: number, part: string, n = 1): string {
  return `${logTime(ms)} STEP ${part} START attempt ${String(n)} model haiku effort low`;
}

export function endLine(ms: number, part: string, exit: number, status: string): string {
  return `${logTime(ms)} STEP ${part} END exit=${String(exit)} status=${status}`;
}

/** A provider session id (36 characters) for the number `n`. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export interface HarnessConfig {
  start: string;
  end: string;
  labelPrefix: string;
  timeFormat: string | undefined;
  includeUnmatched: boolean;
  windowHours: number;
}

export interface WarnLog {
  readonly warnings: { event: string; fields: unknown }[];
}

export interface AttemptsHarness {
  readonly dir: string;
  readonly repoDir: string;
  /** Absolute path of the chain log. */
  readonly logFile: string;
  readonly dbPath: string;
  readonly clock: FakeClock;
  readonly db: InstanceDb;
  readonly store: AttemptsStore;
  /** Edit between ticks to change the configuration. */
  readonly config: HarnessConfig;
  readonly warns: WarnLog;
  /** The context of the tick for the configuration as it is now. */
  context(): AttemptsTickContext;
  writeLog(data: string | Uint8Array): void;
  appendLog(text: string): void;
  /** A session with a transcript whose first record is at `firstMs`; returns the row id. */
  addSession(
    sessionUid: string,
    o: { label: string; firstMs: number | null; matched?: boolean; lastActivityMs?: number },
  ): number;
  /** Counts the rows of `attempt_runs` that another connection sees: what is committed. */
  committedRuns(): number;
  /** Executes SQL on the harness database. */
  sql(text: string): void;
}

/** Registers the clean-up of the databases and returns the factory. Call it at the top of a test file. */
export function useAttemptsHarness(): (over?: Partial<HarnessConfig>) => AttemptsHarness {
  const tempDir = useTempDirs();
  const open: InstanceDb[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });
  return (over = {}) => {
    const dir = tempDir('attempts').path;
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const logFile = join(repoDir, 'chain.log');
    const dbPath = join(dir, 'monitor.db');
    const clock = new FakeClock(BASE_MS);
    const db = openInstanceDb({
      path: dbPath,
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '4.0.0',
      clock,
    });
    open.push(db);
    const config: HarnessConfig = {
      start: START_PATTERN,
      end: END_PATTERN,
      labelPrefix: 'step ',
      timeFormat: undefined,
      includeUnmatched: false,
      windowHours: 24,
      ...over,
    };
    const warns: WarnLog = { warnings: [] };
    const sessions = new SessionsRepo(db);
    return {
      dir,
      repoDir,
      logFile,
      dbPath,
      clock,
      db,
      store: createAttemptsStore(db, SCOPE),
      config,
      warns,
      context: () => ({
        repoDir,
        clock,
        db,
        scope: SCOPE,
        logger: {
          debug: () => undefined,
          warn: (event, fields) => {
            warns.warnings.push({ event, fields });
          },
        },
        config: {
          monitor: {
            chain_log: 'chain.log',
            attempts: {
              start: config.start,
              end: config.end,
              label_prefix: config.labelPrefix,
              ...(config.timeFormat === undefined ? {} : { time_format: config.timeFormat }),
            },
            include_unmatched: config.includeUnmatched,
          },
          patterns: compileConfigPatterns({
            session_rules: [],
            attempts: { start: config.start, end: config.end },
          }),
          runtime: { panelOptions: { attemptsWindowHours: config.windowHours } },
        },
      }),
      writeLog: (data) => {
        writeFileSync(logFile, data);
      },
      appendLog: (text) => {
        appendFileSync(logFile, text);
      },
      addSession: (sessionUid, o) => {
        const lastActivity = o.lastActivityMs ?? BASE_MS;
        const startedAt = Math.min(o.firstMs ?? lastActivity, lastActivity);
        const session = withWriteTx(db, SCOPE, (tx) =>
          sessions.ensure(SCOPE, tx, { sessionUid, projectId: null, startedAt }),
        );
        const file = db.driver
          .prepare(
            `INSERT INTO transcript_files (path, path_key, kind, session_uid, first_ts_in_order, mtime_seen, discovered_at, updated_at)
             VALUES (?, ?, 'session', ?, ?, ?, ?, ?)`,
          )
          .run([
            `C:/t/${sessionUid}.jsonl`,
            `c:/t/${sessionUid}.jsonl`,
            sessionUid,
            o.firstMs === null ? null : new Date(o.firstMs).toISOString(),
            lastActivity,
            BASE_MS,
            BASE_MS,
          ]).lastInsertRowid;
        withWriteTx(db, SCOPE, (tx) =>
          sessions.update(
            SCOPE,
            tx,
            session.id,
            {
              label: o.label,
              transcriptFileId: file,
              matched: o.matched ?? true,
              lastActivityAt: lastActivity,
            },
            null,
          ),
        );
        return session.id;
      },
      committedRuns: () => {
        const other = openInstanceDb({
          path: dbPath,
          expectedInstanceId: INSTANCE_ID,
          mode: 'readonly',
          runtimeVersion: '4.0.0',
          clock,
        });
        try {
          return other.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM attempt_runs').get()?.n ?? -1;
        } finally {
          other.close();
        }
      },
      sql: (text) => {
        db.driver.exec(text);
      },
    };
  };
}

// ---- the stub writer ------------------------------------------------------------------------------------------------------------

export interface StubWriter {
  submit(batch: IngestBatch): boolean;
  onDrain(cb: () => void): void;
  /** What `submit` answers. */
  accept: boolean;
  /** When true `submit` throws `IngestWriterClosedError`, like a closed writer. */
  closed: boolean;
  /** Every batch `submit` was asked for, with the answer. */
  readonly calls: { batch: IngestBatch; accepted: boolean }[];
  /** Called inside `submit`, before the answer. */
  onSubmit: ((batch: IngestBatch) => void) | null;
  /** Calls the registered `onDrain` callbacks, as the writer does when its queue has room again. */
  fireDrain(): void;
  readonly drainListeners: number;
  /** The events of the accepted batches, in order. */
  acceptedEvents(): LogicalEvent[];
}

export function stubWriter(): StubWriter {
  const listeners: (() => void)[] = [];
  const writer: StubWriter = {
    accept: true,
    closed: false,
    calls: [],
    onSubmit: null,
    submit(batch) {
      if (writer.closed) throw new IngestWriterClosedError();
      writer.onSubmit?.(batch);
      writer.calls.push({ batch, accepted: writer.accept });
      return writer.accept;
    },
    onDrain(cb) {
      listeners.push(cb);
    },
    fireDrain() {
      for (const cb of [...listeners]) cb();
    },
    get drainListeners() {
      return listeners.length;
    },
    acceptedEvents: () =>
      writer.calls.filter((c) => c.accepted).flatMap((c) => c.batch.items.flatMap((item) => [...item.events])),
  };
  return writer;
}

export interface EvidenceRow {
  k: string;
  sessionId: string;
  state?: string;
  rowKey?: string;
  observedAt: number;
}

/** The attempts events of the accepted batches, reduced to what the tests compare. */
export function evidenceOf(events: readonly LogicalEvent[]): EvidenceRow[] {
  return events.flatMap((e): EvidenceRow[] => {
    if (e.k === 'external.attempt') {
      return [{ k: e.k, sessionId: e.sessionId, state: e.state, rowKey: e.rowKey, observedAt: e.observedAt }];
    }
    if (e.k === 'external.attempt_cleared') return [{ k: e.k, sessionId: e.sessionId, observedAt: e.observedAt }];
    return [];
  });
}
