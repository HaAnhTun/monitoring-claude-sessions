// DA-T-AL-3 and DA-T-AL-5: the pure conditions of every rule. Table tests of what holds, what clears and where the severity
// changes, with the health inputs (`import_lag`, `hook_failing`, `db_disk`), coverage (`hook_gap`) and lower-bound token totals.
import { RuntimeFileSchema, type IngestHealth } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { healthFixture, type HealthPatch } from '../../test/support/alert-fixtures.ts';
import { cleared, compactNumber, evaluate, safeCode, type AlertFacts, type ScopedResult } from './evaluator.ts';
import { effectiveRules, type EffectiveRule } from './rules.ts';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const UID_B = 'aaaaaaaa-0000-4000-8000-000000000002';

function rulesWith(alerts: Record<string, unknown> = {}): EffectiveRule[] {
  return [...effectiveRules({ runtime: RuntimeFileSchema.parse({ schema_version: 1, alerts }) }).rules];
}

function rule<K extends EffectiveRule['kind']>(
  kind: K,
  alerts: Record<string, unknown> = {},
): Extract<EffectiveRule, { kind: K }> {
  const found = rulesWith(alerts).find((candidate) => candidate.kind === kind);
  if (found === undefined) throw new Error(`no rule ${kind}`);
  return found as Extract<EffectiveRule, { kind: K }>;
}

function health(patch: HealthPatch = {}): IngestHealth {
  return healthFixture(NOW, patch);
}

function facts(over: Partial<AlertFacts> = {}): AlertFacts {
  return {
    now: NOW,
    health: health(),
    importLagWarnMs: 30_000,
    activeSessions: [],
    tokenSessions: [],
    errorCounts: {},
    downtime: null,
    freeDiskMb: 100_000,
    dbMb: 10,
    gaps: [],
    ...over,
  };
}

const ref = (rowId: number, uid: string): { rowId: number; uid: string } => ({ rowId, uid });

function only(results: ScopedResult[]): ScopedResult {
  expect(results).toHaveLength(1);
  const [first] = results;
  if (first === undefined) throw new Error('unreachable');
  return first;
}

describe('inactivity', () => {
  const r = rule('inactivity');
  const session = (idleMs: number) => ({ ...ref(1, UID_A), lastActivityAt: NOW - idleMs });

  it('holds from the threshold on and clears below it', () => {
    expect(evaluate(r, facts({ activeSessions: [session(30 * MIN - 1)] }))).toEqual([]);
    const at = only(evaluate(r, facts({ activeSessions: [session(30 * MIN)] })));
    expect(at.scopeKey).toBe(UID_A);
    expect(at.result).toMatchObject({
      holds: true,
      severity: 'warning',
      value: 30,
      title: 'No activity for 30 min',
      sessionId: 1,
      sessionUid: UID_A,
    });
  });

  it('turns critical at four times the threshold', () => {
    expect(only(evaluate(r, facts({ activeSessions: [session(120 * MIN - 1)] }))).result.severity).toBe('warning');
    const critical = only(evaluate(r, facts({ activeSessions: [session(120 * MIN)] })));
    expect(critical.result).toMatchObject({ severity: 'critical', title: 'No activity for 120 min' });
  });

  it('follows the configured minutes and answers per session', () => {
    const fast = rule('inactivity', { rules: { inactivity: { minutes: 5 } } });
    const both = evaluate(
      fast,
      facts({
        activeSessions: [session(6 * MIN), { ...ref(2, UID_B), lastActivityAt: NOW - 2 * MIN }],
      }),
    );
    expect(both.map((entry) => entry.scopeKey)).toEqual([UID_A]);
  });

  it('never holds for activity in the future (a clock step back)', () => {
    expect(evaluate(r, facts({ activeSessions: [session(-5 * MIN)] }))).toEqual([]);
  });

  it('holds nowhere when the rule is disabled', () => {
    const off = rule('inactivity', { rules: { inactivity: { enabled: false } } });
    expect(evaluate(off, facts({ activeSessions: [session(500 * MIN)] }))).toEqual([]);
  });
});

describe('ingest_errors', () => {
  const r = rule('ingest_errors');

  it('holds at the count, per code, and turns critical at criticalCount', () => {
    expect(evaluate(r, facts({ errorCounts: { READ_FAILED: 9 } }))).toEqual([]);
    const warn = only(evaluate(r, facts({ errorCounts: { READ_FAILED: 10 } })));
    expect(warn.scopeKey).toBe('READ_FAILED');
    expect(warn.result).toMatchObject({
      severity: 'warning',
      value: 10,
      title: '10 READ_FAILED errors in 10 min',
      sessionId: null,
    });
    expect(only(evaluate(r, facts({ errorCounts: { READ_FAILED: 49 } }))).result.severity).toBe('warning');
    expect(only(evaluate(r, facts({ errorCounts: { READ_FAILED: 50 } }))).result.severity).toBe('critical');
  });

  it('answers codes in a stable order and follows the configured window', () => {
    const custom = rule('ingest_errors', { rules: { ingest_errors: { count: 2, windowMinutes: 30 } } });
    const out = evaluate(custom, facts({ errorCounts: { ZED: 2, ALPHA: 3, QUIET: 1 } }));
    expect(out.map((entry) => entry.scopeKey)).toEqual(['ALPHA', 'ZED']);
    expect(out[0]?.result.title).toBe('3 ALPHA errors in 30 min');
  });

  it('keeps a code that is not a plain name out of the title', () => {
    const out = only(evaluate(r, facts({ errorCounts: { 'C:/Users/user/secret.txt': 12 } })));
    expect(out.result.title).toBe('12 UNKNOWN_CODE errors in 10 min');
    expect(JSON.stringify(out.result.detail)).not.toContain('Users');
  });
});

describe('runtime_unavailable', () => {
  const r = rule('runtime_unavailable');
  const gap = (at: number) => ({
    source: 'reconciliation' as const,
    at,
    from: at - 6 * MIN,
    to: at,
    envelopes: 14,
  });

  it('holds on a downtime and carries its length and the events that arrived', () => {
    const out = only(evaluate(r, facts({ downtime: gap(NOW - 10 * MIN) })));
    expect(out.scopeKey).toBe('instance');
    expect(out.result).toMatchObject({
      severity: 'warning',
      title: 'Monitor was not running for 6 min while 14 hook events arrived',
    });
  });

  it('holds for the handler report too', () => {
    const out = only(evaluate(r, facts({ downtime: { source: 'handler', at: NOW - MIN, count: 3 } })));
    expect(out.result.title).toBe('Hook handler could not reach the monitor 3 times');
  });

  it('does not hold without a downtime, and not any more after expireHours', () => {
    expect(evaluate(r, facts())).toEqual([]);
    expect(evaluate(r, facts({ downtime: gap(NOW - 24 * HOUR + 1) }))).toHaveLength(1);
    expect(evaluate(r, facts({ downtime: gap(NOW - 24 * HOUR) }))).toEqual([]);
    const short = rule('runtime_unavailable', { rules: { runtime_unavailable: { expireHours: 1 } } });
    expect(evaluate(short, facts({ downtime: gap(NOW - HOUR) }))).toEqual([]);
  });
});

describe('token_threshold (DA-T-AL-3)', () => {
  const on = (over: Record<string, unknown> = {}) =>
    rule('token_threshold', { rules: { token_threshold: { enabled: true, tokens: 2_000_000, ...over } } });
  const session = (total: number, output = 0) => ({ ...ref(7, UID_A), total, output });

  it('fires only when the lower-bound total reaches the threshold', () => {
    expect(evaluate(on(), facts({ tokenSessions: [session(1_999_999)] }))).toEqual([]);
    const out = only(evaluate(on(), facts({ tokenSessions: [session(2_000_000)] })));
    expect(out.scopeKey).toBe(UID_A);
    expect(out.result).toMatchObject({
      severity: 'warning',
      value: 2_000_000,
      title: 'Session used 2M tokens (threshold 2M)',
      sessionId: 7,
    });
  });

  it('turns critical at twice the threshold and writes the number compactly', () => {
    const out = only(evaluate(on(), facts({ tokenSessions: [session(4_100_000)] })));
    expect(out.result).toMatchObject({ severity: 'critical', title: 'Session used 4.1M tokens (threshold 2M)' });
  });

  it('compares the output only when the field says so', () => {
    const outputRule = on({ field: 'output' });
    expect(evaluate(outputRule, facts({ tokenSessions: [session(9_000_000, 1_000)] }))).toEqual([]);
    const out = only(evaluate(outputRule, facts({ tokenSessions: [session(9_000_000, 2_500_000)] })));
    expect(out.result.title).toBe('Session used 2.5M output tokens (threshold 2M)');
  });

  it('is silent while the rule has no threshold', () => {
    expect(evaluate(rule('token_threshold'), facts({ tokenSessions: [session(9e9)] }))).toEqual([]);
  });
});

describe('import_lag', () => {
  const r = rule('import_lag');
  const lagging = (maxLagMs: number) => health({ transcripts: { status: 'lagging', maxLagMs } });

  it('holds while the transcripts are lagging and clears otherwise', () => {
    expect(evaluate(r, facts({ health: health() }))).toEqual([]);
    expect(evaluate(r, facts({ health: null }))).toEqual([]);
    const out = only(evaluate(r, facts({ health: lagging(90_000) })));
    expect(out.scopeKey).toBe('instance');
    expect(out.result).toMatchObject({ severity: 'warning', value: 90, title: 'Transcript import 90 s behind' });
  });

  it('turns critical above ten times the warning threshold', () => {
    expect(only(evaluate(r, facts({ health: lagging(300_000) }))).result.severity).toBe('warning');
    expect(only(evaluate(r, facts({ health: lagging(300_001) }))).result.severity).toBe('critical');
    expect(only(evaluate(r, facts({ health: lagging(300_001), importLagWarnMs: 60_000 }))).result.severity).toBe(
      'warning',
    );
  });
});

describe('db_disk', () => {
  const r = rule('db_disk');

  it('does not hold on a healthy database with room to spare', () => {
    expect(evaluate(r, facts())).toEqual([]);
    expect(evaluate(r, facts({ health: null, freeDiskMb: null }))).toEqual([]);
  });

  it('holds below minFreeMb and turns critical below a quarter of it', () => {
    expect(evaluate(r, facts({ freeDiskMb: 500 }))).toEqual([]);
    const warn = only(evaluate(r, facts({ freeDiskMb: 410 })));
    expect(warn.scopeKey).toBe('instance');
    expect(warn.result).toMatchObject({ severity: 'warning', value: 410, title: 'Free disk space 410 MB' });
    expect(only(evaluate(r, facts({ freeDiskMb: 125 }))).result.severity).toBe('warning');
    expect(only(evaluate(r, facts({ freeDiskMb: 124 }))).result.severity).toBe('critical');
  });

  it('holds when the database and its WAL are larger than maxDbMb', () => {
    expect(evaluate(r, facts({ dbMb: 2048 }))).toEqual([]);
    const out = only(evaluate(r, facts({ dbMb: 2049 })));
    expect(out.result).toMatchObject({ severity: 'warning', value: 2049, title: 'Database size 2049 MB' });
  });

  it('is critical for a failing write and for a full spool', () => {
    const failing = health({ persisted: { status: 'db_error', lastError: { code: 'db_busy', at: NOW } } });
    const write = only(evaluate(r, facts({ health: failing })));
    expect(write.result).toMatchObject({ severity: 'critical', title: 'Database writes are failing' });
    expect(write.result.detail).toMatchObject({ writeFailing: true, spoolFull: false });

    const full = health({ hooks: { handlerErrors: [{ code: 'SPOOL_FULL', count: 2, lastAt: NOW }] } });
    const spool = only(evaluate(r, facts({ health: full })));
    expect(spool.result).toMatchObject({ severity: 'critical', title: 'Hook spool is full' });
    expect(spool.result.detail).toMatchObject({ spoolFull: true });
  });

  it('reads a disk error code of a failing queue as a failing write', () => {
    const diskFull = health({ persisted: { status: 'failing', lastError: { code: 'ENOSPC', at: NOW } } });
    expect(only(evaluate(r, facts({ health: diskFull }))).result.severity).toBe('critical');
    const recovered = health({ persisted: { status: 'ok', lastError: { code: 'ENOSPC', at: NOW } } });
    expect(evaluate(r, facts({ health: recovered }))).toEqual([]);
  });

  it('answers one alert for several conditions and names the worst', () => {
    const failing = health({ persisted: { status: 'db_error', lastError: { code: 'db_busy', at: NOW } } });
    const out = only(evaluate(r, facts({ health: failing, freeDiskMb: 300, dbMb: 5000 })));
    expect(out.result.severity).toBe('critical');
    expect(out.result.detail).toMatchObject({ freeDiskMb: 300, dbMb: 5000, writeFailing: true });
  });

  it('follows the configured limits', () => {
    const tight = rule('db_disk', { rules: { db_disk: { minFreeMb: 0, maxDbMb: 1 } } });
    expect(evaluate(tight, facts({ freeDiskMb: 0, dbMb: 1 }))).toEqual([]);
    expect(evaluate(tight, facts({ dbMb: 2 }))).toHaveLength(1);
  });
});

describe('hook_gap', () => {
  const r = rule('hook_gap');
  const gap = (rowId: number, uid: string, missingTools: number, missingTurns = 0) => ({
    ...ref(rowId, uid),
    missingTools,
    missingTurns,
  });

  it('holds for each session with a gap and names what was missed', () => {
    expect(evaluate(r, facts())).toEqual([]);
    const out = evaluate(
      r,
      facts({ gaps: [gap(1, UID_A, 3), gap(2, UID_B, 0, 1), gap(3, 'cccccccc-0000-4000-8000-000000000003', 1, 2)] }),
    );
    expect(out.map((entry) => entry.result.title)).toEqual([
      'Hooks missed 3 tool calls in this session',
      'Hooks missed 1 turn in this session',
      'Hooks missed 1 tool call and 2 turns in this session',
    ]);
    expect(out[0]).toMatchObject({ scopeKey: UID_A });
    expect(out[0]?.result).toMatchObject({ severity: 'warning', sessionId: 1, sessionUid: UID_A, value: 3 });
  });
});

describe('hook_failing', () => {
  const r = rule('hook_failing');

  it('holds while the hooks are failing and clears when they are not', () => {
    expect(evaluate(r, facts())).toEqual([]);
    const failing = health({
      hooks: {
        status: 'failing',
        transcriptHookFailures: 2,
        handlerErrors: [{ code: 'HANDLER_UNAVAILABLE', count: 4, lastAt: NOW }],
      },
    });
    const out = only(evaluate(r, facts({ health: failing })));
    expect(out.scopeKey).toBe('instance');
    expect(out.result).toMatchObject({ severity: 'warning', title: 'Hook handler failing', value: 6 });
    expect(out.result.detail).toEqual({ handlerErrors: 4, transcriptHookFailures: 2 });
    expect(evaluate(r, facts({ health: health({ hooks: { status: 'gap' } }) }))).toEqual([]);
  });
});

describe('titles and details', () => {
  it('are numbers and fixed words only, and small', () => {
    const everything = facts({
      health: health({
        hooks: {
          status: 'failing',
          handlerErrors: [{ code: 'SPOOL_FULL', count: 1, lastAt: NOW }],
        },
        transcripts: { status: 'lagging', maxLagMs: 900_000 },
        persisted: { status: 'db_error', lastError: { code: 'db_busy', at: NOW } },
      }),
      activeSessions: [{ ...ref(1, UID_A), lastActivityAt: NOW - 500 * MIN }],
      tokenSessions: [{ ...ref(1, UID_A), total: 9e9, output: 9e9 }],
      errorCounts: { 'C:/Users/user/x': 99, READ_FAILED: 12 },
      downtime: { source: 'reconciliation', at: NOW, from: NOW - MIN, to: NOW, envelopes: 1 },
      freeDiskMb: 1,
      dbMb: 99_999,
      gaps: [{ ...ref(1, UID_A), missingTools: 1, missingTurns: 1 }],
    });
    const all = rulesWith({ rules: { token_threshold: { enabled: true, tokens: 1000 } } }).flatMap((r) =>
      evaluate(r, everything),
    );
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const { result } of all) {
      expect(result.title).toMatch(/^[A-Za-z0-9 .()_-]+$/);
      expect(result.title.length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(JSON.stringify(result.detail))).toBeLessThan(2048);
      for (const value of Object.values(result.detail)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});

describe('helpers', () => {
  it('compactNumber', () => {
    expect([0, 999, 1000, 1500, 99_999, 2_000_000, 2_140_000, 3_000_000_000].map(compactNumber)).toEqual([
      '0',
      '999',
      '1k',
      '1.5k',
      '100k',
      '2M',
      '2.1M',
      '3G',
    ]);
  });

  it('safeCode keeps names and replaces anything else', () => {
    expect(safeCode('READ_FAILED')).toBe('READ_FAILED');
    expect(safeCode('read failed')).toBe('UNKNOWN_CODE');
    expect(safeCode('')).toBe('UNKNOWN_CODE');
    expect(safeCode('A'.repeat(65))).toBe('UNKNOWN_CODE');
  });

  it('cleared names the session it clears', () => {
    expect(cleared(4, UID_A)).toMatchObject({ holds: false, sessionId: 4, sessionUid: UID_A });
    expect(cleared()).toMatchObject({ holds: false, sessionId: null, sessionUid: null });
  });
});
