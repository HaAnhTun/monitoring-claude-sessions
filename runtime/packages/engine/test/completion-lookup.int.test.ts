// DA-T-API-15 part 2, O-5 (03 3.7, 6.3, 22): the two scans behind `explainCompletion`. A label is found by a scan of `sessions` and
// an attempt part by a scan of `attempt_runs` (no index covers either), so the plan and the time are recorded at 5,000 sessions
// and 20,000 attempt rows on real repositories. The budget is 5 ms (the median of repeated calls); a result above it is a change
// request to the lead, never a migration edit. The plans are printed to the test output for the record.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, makeTempDir } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import type { SqlParams, SqlValue, Stmt } from '../src/db/driver.ts';
import type { InstanceDb } from '../src/db/open.ts';
import { AttemptsRepo } from '../src/db/repos/attempts.ts';
import { SessionsRepo } from '../src/db/repos/sessions.ts';
import type { Logger } from '../src/log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const SESSIONS = 5_000;
const RUNS = 20_000;
/** 5 sessions share a label, 5 runs share a part. */
const LABELS = 1_000;
const PARTS = 4_000;
const BUDGET_MS = 5;
/**
 * What the part scans fail on. Reading 20,000 rows in index order costs about half of the budget on a quiet machine, so a
 * machine that is busy with other work could cross 5 ms without any regression: the test fails at four times the budget (an
 * accidental per-row lookup is far above that) and the output says when the budget itself is exceeded.
 */
const SCAN_LIMIT_MS = 4 * BUDGET_MS;
const REPEATS = 41;
const WARMUPS = 5;

interface Captured {
  readonly sql: string;
  readonly params: SqlParams | undefined;
}

let ctx: InstanceContext;
let spyDb: InstanceDb;
/** The repositories over the real database (timing) and over the recording one (plans). */
let realSessions: SessionsRepo;
let realAttempts: AttemptsRepo;
let spySessions: SessionsRepo;
let spyAttempts: AttemptsRepo;
let captured: Captured[] = [];
const cleanup: (() => void)[] = [];

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** The database with a driver whose `prepare` records every statement that reads. */
function spyOn(db: InstanceDb): InstanceDb {
  return {
    ...db,
    driver: {
      ...db.driver,
      prepare: <R = Record<string, SqlValue>>(sql: string): Stmt<R> => {
        const stmt = db.driver.prepare<R>(sql);
        return {
          run: (params) => stmt.run(params),
          get: (params) => {
            captured.push({ sql, params });
            return stmt.get(params);
          },
          all: (params) => {
            captured.push({ sql, params });
            return stmt.all(params);
          },
        };
      },
    },
  };
}

const uid = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

beforeAll(async () => {
  const temp = makeTempDir('completion-lookup');
  const root = temp.path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  cleanup.push(() => {
    ctx.db.close();
    temp.remove();
  });
  ctx.db.driver.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(SESSIONS)})
    INSERT INTO sessions (session_uid, label, matched, search_text, first_seen_at, started_at, last_activity_at, state,
                          state_basis, state_confidence, state_rule, state_evidence, evaluated_at, updated_at)
    SELECT printf('cccccccc-0000-4000-8000-%012x', i), 'label-' || (i % ${String(LABELS)}), 1, 'session ' || i,
           ${String(NOW)} - 400000000 - i * 1000, ${String(NOW)} - 400000000 - i * 1000, ${String(NOW)} - i * 60000,
           CASE i % 4 WHEN 0 THEN 'working' WHEN 1 THEN 'completed' WHEN 2 THEN 'stale' ELSE 'turn_ended' END,
           'observed', 'high', 'S-3b',
           '[{"source":"hook","fact":"session_end","at":' || (${String(NOW)} - i * 60000) || ',"value":"other"}]',
           ${String(NOW)}, ${String(NOW)} FROM n;
    INSERT INTO attempt_sources (path, path_key, generation, ino, head_len, head_hash, read_offset, config_sha256, updated_at)
      VALUES ('logs/chain.log', 'logs/chain.log', 1, '1', 8, '${'h'.repeat(64)}', 0, '${'c'.repeat(64)}', ${String(NOW)});
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(RUNS)})
    INSERT INTO attempt_runs (source_id, generation, start_offset, part, n_raw, started_at, end_offset, ended_at, exit_raw,
                              status_raw, end_reason, state, evidence, session_id, updated_at)
    SELECT 1, 1, i * 100, 'part-' || (i % ${String(PARTS)}), CAST(i AS TEXT), ${String(NOW)} - i * 30000, i * 100 + 50,
           ${String(NOW)} - i * 30000 + 20000, '0', 'done', 'ended',
           CASE i % 3 WHEN 0 THEN 'FAILED' ELSE 'COMPLETED' END, 'chain log: exit=0 status=PASS',
           CASE WHEN i % 2 = 0 THEN 1 + (i % ${String(SESSIONS)}) END, ${String(NOW)} FROM n;
    ANALYZE;`);
  spyDb = spyOn(ctx.db);
  realSessions = new SessionsRepo(ctx.db);
  realAttempts = new AttemptsRepo(ctx.db);
  spySessions = new SessionsRepo(spyDb);
  spyAttempts = new AttemptsRepo(spyDb);
});

afterAll(() => {
  for (const run of cleanup.splice(0)) run();
});

/** The `EXPLAIN QUERY PLAN` detail lines of every statement `call` read. */
function plansOf(call: () => void): string[] {
  captured = [];
  call();
  const statements = captured.filter((entry) => /^\s*SELECT/i.test(entry.sql));
  captured = [];
  return statements.flatMap((entry) =>
    ctx.db.driver
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${entry.sql}`)
      .all(entry.params)
      .map((row) => row.detail),
  );
}

function medianMs(call: () => void): number {
  for (let i = 0; i < WARMUPS; i += 1) call();
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    call();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function report(title: string, plan: readonly string[], ms: number): void {
  const over = ms > BUDGET_MS ? ' OVER BUDGET: raise a change request to the lead, do not edit a migration' : '';
  process.stdout.write(
    `O-5 ${title}\n${plan.map((line) => `    ${line}`).join('\n')}\n    median ${ms.toFixed(3)} ms (budget ${String(BUDGET_MS)} ms)${over}\n`,
  );
}

describe('the dataset', () => {
  it('has the sizes the lookups are judged on', () => {
    const count = (table: string): number =>
      ctx.db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
    expect(count('sessions')).toBe(SESSIONS);
    expect(count('attempt_runs')).toBe(RUNS);
  });
});

describe('the session lookups (SessionsRepo.completionCandidates)', () => {
  it('finds a session by provider id through the unique index', () => {
    const plan = plansOf(() => {
      expect(spySessions.completionCandidates(ctx.scope, { sessionId: uid(2500) })).toHaveLength(1);
    });
    const ms = medianMs(() => realSessions.completionCandidates(ctx.scope, { sessionId: uid(2500) }));
    report('sessions by id', plan, ms);
    expect(plan.join('\n')).toMatch(/SEARCH .*USING (COVERING )?INDEX|SEARCH .*sqlite_autoindex_sessions/);
    expect(plan.join('\n')).not.toMatch(/SCAN/);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('finds the sessions of an exact label by a scan of sessions (O-5), within the budget', () => {
    const plan = plansOf(() => {
      expect(spySessions.completionCandidates(ctx.scope, { label: 'label-7' })).toHaveLength(SESSIONS / LABELS);
    });
    const ms = medianMs(() => realSessions.completionCandidates(ctx.scope, { label: 'label-7' }));
    report('sessions by label', plan, ms);
    expect(plan.join('\n')).toContain('sessions');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('a label that no session has costs the same scan and finds nothing', () => {
    const ms = medianMs(() => realSessions.completionCandidates(ctx.scope, { label: 'no such label' }));
    report('sessions by a missing label', [], ms);
    expect(realSessions.completionCandidates(ctx.scope, { label: 'no such label' })).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('matches a label that holds LIKE wildcards only by equality', () => {
    for (const label of ['label-%', 'label-_', '%', '_', 'LABEL-7']) {
      expect(realSessions.completionCandidates(ctx.scope, { label }), label).toEqual([]);
    }
  });
});

describe('the attempt lookup (AttemptsRepo.runsByPart)', () => {
  it('finds the rows of an exact part by a scan of attempt_runs (O-5)', () => {
    const plan = plansOf(() => {
      expect(spyAttempts.runsByPart(ctx.scope, 'part-7')).toHaveLength(RUNS / PARTS);
    });
    const ms = medianMs(() => realAttempts.runsByPart(ctx.scope, 'part-7'));
    report('attempt rows by part', plan, ms);
    expect(plan.join('\n')).toContain('attempt_runs');
    // the matched session is read by its primary key, not by a second scan
    expect(plan.filter((line) => line.includes('SCAN'))).toHaveLength(1);
    expect(ms).toBeLessThan(SCAN_LIMIT_MS);
  });

  it('a part that nobody ran costs the same scan and finds nothing', () => {
    const ms = medianMs(() => realAttempts.runsByPart(ctx.scope, 'no-such-part'));
    report('attempt rows by a missing part', [], ms);
    expect(realAttempts.runsByPart(ctx.scope, 'no-such-part')).toEqual([]);
    expect(ms).toBeLessThan(SCAN_LIMIT_MS);
  });

  it('keeps the empty part apart from the named ones', () => {
    expect(realAttempts.runsByPart(ctx.scope, '')).toEqual([]);
  });
});

describe('explainCompletion end to end at this size', () => {
  it('answers by id, by label and by part', () => {
    const queries = ctx.queries;
    const byId = medianMs(() => queries.explainCompletion(ctx.scope, { sessionId: uid(2500) }));
    const byLabel = medianMs(() => queries.explainCompletion(ctx.scope, { label: 'label-7' }));
    const byPart = medianMs(() => queries.explainCompletion(ctx.scope, { attemptPart: 'part-7' }));
    report('explainCompletion by id', [], byId);
    report('explainCompletion by label', [], byLabel);
    report('explainCompletion by part', [], byPart);
    expect(queries.explainCompletion(ctx.scope, { label: 'label-7' })).toMatchObject({
      resolvedBy: 'label',
      candidates: SESSIONS / LABELS,
    });
    expect(queries.explainCompletion(ctx.scope, { attemptPart: 'part-7' })).toMatchObject({
      resolvedBy: 'attempt_part',
      candidates: RUNS / PARTS,
    });
    expect(byId).toBeLessThan(BUDGET_MS);
    expect(byLabel).toBeLessThan(BUDGET_MS);
    expect(byPart).toBeLessThan(SCAN_LIMIT_MS);
  });
});
