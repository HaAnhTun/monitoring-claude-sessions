// The four-way ingestion health (02 8.2, T-HE-03 to T-HE-06): the rules are a pure function of facts, so each block and the
// overall verdict are table tests; the handler log parser (T-HE-04) and the evaluator with a real database are below.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IngestHealthSchema } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../test/fixtures/hooks.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { IngestHealthRepo } from '../db/repos/ingest-health.ts';
import type { SpoolStats } from '../ingest/spool/spool-drainer.ts';
import type { TranscriptStats } from '../ingest/transcripts/importer.ts';
import {
  computeIngestHealth,
  createIngestHealthEvaluator,
  parseHandlerLog,
  percentile95,
  type HealthContext,
  type HealthSources,
  type HealthThresholds,
  type IngestHealthFacts,
} from './ingest-health.ts';

const tempDir = useTempDirs();
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60_000;
const THRESHOLDS: HealthThresholds = {
  activeSeconds: 120,
  staleAfterSeconds: 1800,
  importLagWarnMs: 30_000,
  backlogWarnMs: 10_000,
};

/** Facts of a healthy instance: hooks arriving, transcripts caught up, nothing queued. */
function facts(over: Partial<IngestHealthFacts> = {}): IngestHealthFacts {
  return {
    now: NOW,
    startedAt: NOW - 10 * MIN,
    eventLoopDelayP99Ms: 3,
    queryFailures: 0,
    headSeq: 42,
    lastEnvelopeAt: NOW - 5_000,
    newestTranscriptMtime: NOW - 6_000,
    newestSpoolMtime: NOW - 5_000,
    hooks: {
      installed: [],
      envelopes1h: 10,
      duplicates1h: 0,
      invalid1h: 0,
      handlerErrors: [],
      handlerFailing: false,
      transcriptHookFailures: 0,
      coverage: { full: 1, partial: 0, none: 0 },
    },
    spool: {
      segments: 1,
      bytes: 1000,
      bytesBehind: 0,
      oldestPendingReceivedAt: null,
      lastNudgeAt: NOW - 5_000,
      lastDrainAt: NOW - 1_000,
      foreignFiles: 0,
    },
    transcripts: {
      dir: 'FIXTURE/projects/demo',
      dirFound: true,
      filesTracked: 3,
      filesMissing: 0,
      filesUnreadable: 0,
      bytesBehind: 0,
      maxLagMs: 0,
      backfillRemainingBytes: 0,
      lastScanAt: NOW - 1_000,
      lastSyncAt: NOW - 1_000,
      errors: {},
      recentProblems: 0,
    },
    persisted: {
      lastCommitAt: NOW - 1_000,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 2,
      failures1h: 0,
      lastError: null,
      lastCommitFailed: false,
      paused: false,
      backlogSince: null,
    },
    ...over,
  };
}

function reasonCodes(f: IngestHealthFacts): string[] {
  return computeIngestHealth(f, THRESHOLDS).reasons.map((r) => r.code);
}

describe('computeIngestHealth: provider', () => {
  it('is none without any activity and takes the newest of the three sources', () => {
    const none = computeIngestHealth(
      facts({ lastEnvelopeAt: null, newestTranscriptMtime: null, newestSpoolMtime: null }),
      THRESHOLDS,
    );
    expect(none.provider).toEqual({ lastActivityAt: null, source: null, status: 'none' });
    const viaHook = computeIngestHealth(facts(), THRESHOLDS).provider;
    expect(viaHook).toEqual({ lastActivityAt: NOW - 5_000, source: 'hook', status: 'active' });
    const viaTranscript = computeIngestHealth(
      facts({ lastEnvelopeAt: NOW - 90_000, newestTranscriptMtime: NOW - 10_000, newestSpoolMtime: null }),
      THRESHOLDS,
    ).provider;
    expect(viaTranscript).toEqual({ lastActivityAt: NOW - 10_000, source: 'transcript_mtime', status: 'active' });
  });

  it('is active below activeSeconds, quiet below staleAfterSeconds and silent beyond', () => {
    const at = (age: number) =>
      computeIngestHealth(
        facts({ lastEnvelopeAt: NOW - age, newestTranscriptMtime: null, newestSpoolMtime: null }),
        THRESHOLDS,
      ).provider.status;
    expect(at(119_999)).toBe('active');
    expect(at(120_000)).toBe('quiet');
    expect(at(1_799_999)).toBe('quiet');
    expect(at(1_800_000)).toBe('silent');
  });
});

describe('computeIngestHealth: hooks', () => {
  const hookStatus = (over: Partial<IngestHealthFacts>) =>
    computeIngestHealth(facts(over), THRESHOLDS).receiving.hooks.status;
  const withHooks = (patch: Partial<IngestHealthFacts['hooks']>): Partial<IngestHealthFacts> => ({
    hooks: { ...facts().hooks, ...patch },
  });

  it('is ok while envelopes arrive and everything is covered', () => {
    expect(hookStatus({})).toBe('ok');
  });

  it('is not_installed when nothing is installed and no envelope was ever received', () => {
    expect(hookStatus({ lastEnvelopeAt: null })).toBe('not_installed');
  });

  it('is failing when the handler log names a failure of this instance, or the transcripts show hook failures', () => {
    expect(hookStatus(withHooks({ handlerFailing: true }))).toBe('failing');
    expect(hookStatus(withHooks({ transcriptHookFailures: 2 }))).toBe('failing');
    // a handler that never delivered anything is failing, not "not installed"
    expect(hookStatus({ ...withHooks({ handlerFailing: true }), lastEnvelopeAt: null })).toBe('failing');
  });

  it('is gap when a session of the last hour has partial coverage', () => {
    expect(hookStatus(withHooks({ coverage: { full: 1, partial: 1, none: 0 } }))).toBe('gap');
  });

  it('is idle when the provider is active but no envelope came for staleAfterSeconds', () => {
    expect(
      hookStatus({ lastEnvelopeAt: NOW - 1_800_000, newestTranscriptMtime: NOW - 1_000, newestSpoolMtime: null }),
    ).toBe('idle');
    // a quiet provider with no envelopes is not an idle hook
    expect(
      hookStatus({ lastEnvelopeAt: NOW - 1_800_000, newestTranscriptMtime: NOW - 600_000, newestSpoolMtime: null }),
    ).toBe('ok');
  });

  it('carries the counters and the handler errors through', () => {
    const report = computeIngestHealth(
      facts(
        withHooks({
          envelopes1h: 7,
          duplicates1h: 2,
          invalid1h: 1,
          handlerErrors: [{ code: 'ROUTE_INVALID', count: 2, lastAt: NOW - 1000 }],
        }),
      ),
      THRESHOLDS,
    );
    expect(report.receiving.hooks).toMatchObject({
      lastEnvelopeAt: NOW - 5_000,
      envelopes1h: 7,
      duplicates1h: 2,
      invalid1h: 1,
      handlerErrors: [{ code: 'ROUTE_INVALID', count: 2, lastAt: NOW - 1000 }],
    });
  });
});

describe('computeIngestHealth: transcripts', () => {
  const status = (patch: Partial<IngestHealthFacts['transcripts']>) =>
    computeIngestHealth(facts({ transcripts: { ...facts().transcripts, ...patch } }), THRESHOLDS).receiving.transcripts
      .status;

  it('orders not_found, errors, lagging, backfilling, ok', () => {
    expect(status({ dir: null, dirFound: false })).toBe('not_found');
    expect(status({ recentProblems: 1, maxLagMs: 99_999, backfillRemainingBytes: 5 })).toBe('errors');
    expect(status({ maxLagMs: 30_001, backfillRemainingBytes: 5 })).toBe('lagging');
    expect(status({ maxLagMs: 30_000, backfillRemainingBytes: 5 })).toBe('backfilling');
    expect(status({})).toBe('ok');
  });

  it('does not expose the problem counter and keeps the counters of the importer', () => {
    const report = computeIngestHealth(
      facts({ transcripts: { ...facts().transcripts, recentProblems: 3, errors: { invalid_json: 2 } } }),
      THRESHOLDS,
    );
    expect(report.receiving.transcripts).not.toHaveProperty('recentProblems');
    expect(report.receiving.transcripts.errors).toEqual({ invalid_json: 2 });
  });
});

describe('computeIngestHealth: persisted', () => {
  const status = (patch: Partial<IngestHealthFacts['persisted']>) =>
    computeIngestHealth(facts({ persisted: { ...facts().persisted, ...patch } }), THRESHOLDS).persisted.status;

  it('is db_error after a full disk or a damaged database, failing after a failed commit, backlog after 10 s', () => {
    expect(status({ lastCommitFailed: true, lastError: { code: 'db_full', at: NOW - 100 } })).toBe('db_error');
    expect(status({ lastCommitFailed: true, lastError: { code: 'db_corrupt', at: NOW - 100 } })).toBe('db_error');
    expect(status({ paused: true })).toBe('db_error');
    expect(status({ lastCommitFailed: true, lastError: { code: 'db_busy', at: NOW - 100 } })).toBe('failing');
    expect(status({ backlogSince: NOW - 10_001, queueItems: 4 })).toBe('backlog');
    expect(status({ backlogSince: NOW - 10_000, queueItems: 4 })).toBe('ok');
    expect(status({})).toBe('ok');
  });

  it('keeps an old error visible without calling the database failing', () => {
    const report = computeIngestHealth(
      facts({ persisted: { ...facts().persisted, lastError: { code: 'db_busy', at: NOW - 600_000 } } }),
      THRESHOLDS,
    );
    expect(report.persisted.status).toBe('ok');
    expect(report.persisted.lastError).toEqual({ code: 'db_busy', at: NOW - 600_000 });
  });
});

describe('computeIngestHealth: overall verdict and reasons', () => {
  it('is ok with no reason for a healthy instance, and the report is a valid IngestHealth', () => {
    const report = computeIngestHealth(facts(), THRESHOLDS);
    expect(report.status).toBe('ok');
    expect(report.reasons).toEqual([]);
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
    expect(report.display).toEqual({ headSeq: 42, serverTime: NOW });
    expect(report.runtime).toEqual({ startedAt: NOW - 10 * MIN, eventLoopDelayP99Ms: 3 });
  });

  it('is down when persistence fails, or when there are neither transcripts nor hooks', () => {
    expect(
      computeIngestHealth(
        facts({ persisted: { ...facts().persisted, lastCommitFailed: true, lastError: { code: 'db_busy', at: NOW } } }),
        THRESHOLDS,
      ).status,
    ).toBe('down');
    expect(
      computeIngestHealth(
        facts({ lastEnvelopeAt: null, transcripts: { ...facts().transcripts, dir: null, dirFound: false } }),
        THRESHOLDS,
      ).status,
    ).toBe('down');
  });

  it('is degraded for any warn or error reason and ok for info reasons only', () => {
    const lagging = facts({ transcripts: { ...facts().transcripts, maxLagMs: 60_000 } });
    expect(computeIngestHealth(lagging, THRESHOLDS).status).toBe('degraded');
    expect(reasonCodes(lagging)).toEqual(['IMPORT_LAG']);
    const backfilling = facts({ transcripts: { ...facts().transcripts, backfillRemainingBytes: 10 } });
    expect(computeIngestHealth(backfilling, THRESHOLDS).status).toBe('ok');
    expect(computeIngestHealth(backfilling, THRESHOLDS).reasons).toEqual([
      { code: 'BACKFILLING', severity: 'info', since: NOW },
    ]);
    const notInstalled = facts({ lastEnvelopeAt: null });
    expect(computeIngestHealth(notInstalled, THRESHOLDS).status).toBe('ok');
    expect(reasonCodes(notInstalled)).toEqual(['HOOKS_NOT_INSTALLED']);
  });

  it('names every non-ok block with the codes of 02 8.2', () => {
    const everything = facts({
      lastEnvelopeAt: null,
      newestTranscriptMtime: null,
      newestSpoolMtime: null,
      eventLoopDelayP99Ms: 80,
      hooks: { ...facts().hooks, handlerFailing: true, coverage: { full: 0, partial: 1, none: 0 } },
      transcripts: { ...facts().transcripts, dir: null, dirFound: false },
      persisted: { ...facts().persisted, lastCommitFailed: true, lastError: { code: 'db_full', at: NOW } },
    });
    expect(reasonCodes(everything)).toEqual(
      expect.arrayContaining(['HOOKS_FAILING', 'TRANSCRIPTS_NOT_FOUND', 'DB_ERROR', 'EVENT_LOOP_SLOW']),
    );
    const silent = facts({
      lastEnvelopeAt: NOW - 2_000_000,
      newestTranscriptMtime: null,
      newestSpoolMtime: null,
    });
    expect(reasonCodes(silent)).toContain('PROVIDER_SILENT');
    const gap = facts({ hooks: { ...facts().hooks, coverage: { full: 0, partial: 2, none: 0 } } });
    expect(reasonCodes(gap)).toContain('HOOK_GAP');
    const backlog = facts({ persisted: { ...facts().persisted, backlogSince: NOW - 20_000, queueItems: 9 } });
    expect(reasonCodes(backlog)).toContain('SPOOL_BACKLOG');
  });

  it('is degraded with INGEST_HEALTH_PARTIAL when a fact query failed, never ok (UI-I4)', () => {
    expect(reasonCodes(facts({ queryFailures: 0 }))).toEqual([]);
    const report = computeIngestHealth(facts({ queryFailures: 2 }), THRESHOLDS);
    expect(report.status).toBe('degraded');
    expect(report.reasons).toEqual([{ code: 'INGEST_HEALTH_PARTIAL', severity: 'warn', since: NOW }]);
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
  });

  it('keeps the time a reason began and starts it at now when it is new', () => {
    const lagging = facts({ transcripts: { ...facts().transcripts, maxLagMs: 60_000 } });
    const since = new Map([['IMPORT_LAG', NOW - 5 * MIN]]);
    expect(computeIngestHealth(lagging, THRESHOLDS, since).reasons).toEqual([
      { code: 'IMPORT_LAG', severity: 'warn', since: NOW - 5 * MIN },
    ]);
    expect(computeIngestHealth(lagging, THRESHOLDS).reasons[0]?.since).toBe(NOW);
  });
});

describe('T-HE-03 four-way independence', () => {
  it('a failing database leaves the receiving side ok (b)', () => {
    const report = computeIngestHealth(
      facts({
        persisted: { ...facts().persisted, lastCommitFailed: true, lastError: { code: 'db_readonly', at: NOW } },
      }),
      THRESHOLDS,
    );
    expect(report.persisted.status).toBe('failing');
    expect(report.receiving.hooks.status).toBe('ok');
    expect(report.receiving.transcripts.status).toBe('ok');
  });

  it('a removed transcripts folder changes only the transcripts block (c)', () => {
    const report = computeIngestHealth(
      facts({ transcripts: { ...facts().transcripts, dir: null, dirFound: false } }),
      THRESHOLDS,
    );
    expect(report.receiving.transcripts.status).toBe('not_found');
    expect(report.receiving.hooks.status).toBe('ok');
    expect(report.persisted.status).toBe('ok');
  });

  it('the report has no input about a stream connection: the same facts give the same report (d)', () => {
    expect(computeIngestHealth(facts(), THRESHOLDS)).toEqual(computeIngestHealth(facts(), THRESHOLDS));
    expect(Object.keys(facts()).some((key) => /sse|stream|client/i.test(key))).toBe(false);
  });

  it('a spool backlog after the server was stopped shows in the spool block (a)', () => {
    const report = computeIngestHealth(
      facts({ spool: { ...facts().spool, bytesBehind: 4096, oldestPendingReceivedAt: NOW - 3_600_000 } }),
      THRESHOLDS,
    );
    expect(report.receiving.spool).toMatchObject({ bytesBehind: 4096, oldestPendingReceivedAt: NOW - 3_600_000 });
  });
});

describe('percentile95', () => {
  it('is 0 for no samples and the nearest rank otherwise', () => {
    expect(percentile95([])).toBe(0);
    expect(percentile95([5])).toBe(5);
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(percentile95([9, 1, 5])).toBe(9);
  });
});

describe('T-HE-04 parseHandlerLog', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({
      at: NOW - 1000,
      code: 'HANDLER_UNAVAILABLE',
      event: 'Stop',
      instanceId: FIXTURE_INSTANCE_ID,
      pid: 10,
      detail: 'FIXTURE',
      ...over,
    });
  const parse = (lines: string[]) => parseHandlerLog(lines.join('\n'), FIXTURE_INSTANCE_ID, NOW);

  it('is failing for HANDLER_UNAVAILABLE, SPOOL_FULL and SPOOL_WRITE_FAILED of this instance in the last hour', () => {
    for (const code of ['HANDLER_UNAVAILABLE', 'SPOOL_FULL', 'SPOOL_WRITE_FAILED']) {
      expect(parse([line({ code })])).toMatchObject({ failing: true });
    }
  });

  it('ignores the entries of another instance', () => {
    expect(parse([line({ instanceId: OTHER })])).toEqual({ errors: [], failing: false });
  });

  it('counts an entry without an instance id (the handler could not know it)', () => {
    expect(parse([line({ instanceId: null })]).failing).toBe(true);
  });

  it('does not count an entry older than an hour, and other codes do not make the hooks failing', () => {
    expect(parse([line({ at: NOW - 3_600_001 })])).toEqual({ errors: [], failing: false });
    const other = parse([line({ code: 'ROUTE_INVALID' }), line({ code: 'ROUTE_INVALID', at: NOW - 500 })]);
    expect(other.failing).toBe(false);
    expect(other.errors).toEqual([{ code: 'ROUTE_INVALID', count: 2, lastAt: NOW - 500 }]);
  });

  it('skips the cut first line of a tail, damaged lines and lines of the wrong shape', () => {
    const cut = `,"detail":"cut","pid":1}\n${line({ code: 'UNCAUGHT' })}\nnot json\n${JSON.stringify({ code: 'X' })}\n`;
    expect(parseHandlerLog(cut, FIXTURE_INSTANCE_ID, NOW).errors).toEqual([
      { code: 'UNCAUGHT', count: 1, lastAt: NOW - 1000 },
    ]);
  });

  it('keeps at most 20 distinct codes', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line({ code: `CODE_${String(i)}` }));
    expect(parse(lines).errors).toHaveLength(20);
  });
});

// ---- the evaluator over a real database --------------------------------------------------------------------------------

interface Rig {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly ctx: HealthContext;
  readonly mcsHome: string;
  readonly spoolDir: string;
  /** An existing folder that stands for the transcripts folder. */
  readonly projectDir: string;
}

const dbs: InstanceDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function rig(warn: HealthContext['logger']['warn'] = () => undefined): Rig {
  const root = tempDir('health').path;
  const clock = new FakeClock(NOW);
  const db = openInstanceDb({
    path: path.join(root, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const mcsHome = path.join(root, 'mcs-home');
  const spoolDir = path.join(root, 'data', 'spool');
  const projectDir = path.join(root, 'projects', 'demo');
  mkdirSync(spoolDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const ctx: HealthContext = {
    db,
    scope: { instanceId: FIXTURE_INSTANCE_ID },
    clock,
    instanceId: FIXTURE_INSTANCE_ID,
    mcsHome,
    process: { startedAtMs: NOW - 10 * MIN },
    logger: { debug: () => undefined, info: () => undefined, warn, error: () => undefined },
    thresholds: THRESHOLDS,
  };
  return { db, clock, ctx, mcsHome, spoolDir, projectDir };
}

function spoolStats(over: Partial<SpoolStats> = {}): SpoolStats {
  return { segments: 0, bytes: 0, bytesBehind: 0, lastNudgeAt: null, lastDrainAt: null, foreignFiles: 0, ...over };
}

function transcriptStats(over: Partial<TranscriptStats> = {}): TranscriptStats {
  return {
    filesTracked: 0,
    filesMissing: 0,
    filesUnreadable: 0,
    bytesBehind: 0,
    backfillRemainingBytes: 0,
    maxLagMs: 0,
    lastScanAt: null,
    lastSyncAt: null,
    usageFailed: 0,
    sliceFailures: 0,
    ...over,
  };
}

function sources(r: Rig, over: Partial<HealthSources> = {}): HealthSources {
  return {
    spoolDir: r.spoolDir,
    writer: () => ({
      queued: 0,
      queuedBytes: 0,
      lastCommitAt: null,
      failures: 0,
      lastError: null,
      paused: false,
    }),
    commitDurationsMs: () => [],
    spool: () => spoolStats(),
    transcripts: () => transcriptStats(),
    transcriptsDir: () => null,
    ...over,
  };
}

const PARTIAL = 'INGEST_HEALTH_PARTIAL';
// the evaluator measures the event loop of the real process: the tests below look at one reason, not at the overall status
const codesOf = (report: { readonly reasons: readonly { readonly code: string }[] }): string[] =>
  report.reasons.map((reason) => reason.code);

describe('createIngestHealthEvaluator', () => {
  it('stores a valid report in the ingest_health row that the query layer serves', async () => {
    const r = rig();
    const evaluator = createIngestHealthEvaluator(r.ctx, sources(r, { transcriptsDir: () => r.projectDir }));
    const headBefore = r.db.headSeq();
    const report = await evaluator.refresh();
    const row = new IngestHealthRepo(r.db).get(r.ctx.scope);
    expect(row?.status).toBe(report.status);
    expect(row?.evaluatedAt).toBe(NOW);
    expect(IngestHealthSchema.parse(JSON.parse(row?.reportJson ?? '{}'))).toEqual(report);
    // the report names the head at the time it was computed; storing it announced health/upsert after that
    expect(report.display.headSeq).toBe(headBefore);
    expect(r.db.headSeq()).toBeGreaterThan(headBefore);
  });

  it('reports the transcripts folder as not found again when it is removed after it was found (T-HE-03 c)', async () => {
    const r = rig();
    const evaluator = createIngestHealthEvaluator(r.ctx, sources(r, { transcriptsDir: () => r.projectDir }));
    expect((await evaluator.refresh()).receiving.transcripts).toMatchObject({ dirFound: true, dir: r.projectDir });
    rmSync(r.projectDir, { recursive: true });
    r.clock.advance(5000);
    expect((await evaluator.refresh()).receiving.transcripts).toMatchObject({ dirFound: false, status: 'not_found' });
  });

  it('reads the handler log of the Claude hooks and reports the hooks as failing (T-HE-04)', async () => {
    const r = rig();
    mkdirSync(path.join(r.mcsHome, 'logs'), { recursive: true });
    writeFileSync(
      path.join(r.mcsHome, 'logs', 'hook-handler.jsonl'),
      `${JSON.stringify({ at: NOW - 1000, code: 'HANDLER_UNAVAILABLE', event: 'Stop', instanceId: FIXTURE_INSTANCE_ID, pid: 1, detail: 'FIXTURE' })}\n`,
    );
    const evaluator = createIngestHealthEvaluator(r.ctx, sources(r));
    const report = await evaluator.refresh();
    expect(report.receiving.hooks.status).toBe('failing');
    expect(report.receiving.hooks.handlerErrors).toEqual([
      { code: 'HANDLER_UNAVAILABLE', count: 1, lastAt: NOW - 1000 },
    ]);
  });

  it('passes the importer figures through and keeps lastSyncAt where the importer left it (T-HE-06)', async () => {
    const r = rig();
    let stats = transcriptStats({ filesTracked: 1, lastSyncAt: NOW - 20_000, maxLagMs: 5_000, bytesBehind: 100 });
    const evaluator = createIngestHealthEvaluator(
      r.ctx,
      sources(r, { transcripts: () => stats, transcriptsDir: () => r.projectDir }),
    );
    const growing = await evaluator.refresh();
    expect(growing.receiving.transcripts).toMatchObject({
      lastSyncAt: NOW - 20_000,
      maxLagMs: 5_000,
      bytesBehind: 100,
    });
    r.clock.advance(10_000);
    stats = transcriptStats({ filesTracked: 1, lastSyncAt: NOW - 20_000, maxLagMs: 15_000, bytesBehind: 200 });
    const later = await evaluator.refresh();
    expect(later.receiving.transcripts.lastSyncAt).toBe(NOW - 20_000);
    expect(later.receiving.transcripts.maxLagMs).toBe(15_000);
    r.clock.advance(10_000);
    stats = transcriptStats({ filesTracked: 1, lastSyncAt: NOW + 20_000, maxLagMs: 0 });
    expect((await evaluator.refresh()).receiving.transcripts.lastSyncAt).toBe(NOW + 20_000);
  });

  it('counts a spool backlog as backlog only after backlogWarnMs, and clears it when the backlog is gone', async () => {
    const r = rig();
    let behind = 2048;
    const evaluator = createIngestHealthEvaluator(
      r.ctx,
      sources(r, { spool: () => spoolStats({ bytesBehind: behind }) }),
    );
    expect((await evaluator.refresh()).persisted.status).toBe('ok');
    r.clock.advance(10_001);
    expect((await evaluator.refresh()).persisted.status).toBe('backlog');
    behind = 0;
    expect((await evaluator.refresh()).persisted.status).toBe('ok');
  });

  it('reports a failed commit of the writer as failing and a full disk as db_error', async () => {
    const r = rig();
    let error: { code: string; at: number } | null = { code: 'db_busy', at: NOW + 1 };
    let paused = false;
    const evaluator = createIngestHealthEvaluator(
      r.ctx,
      sources(r, {
        writer: () => ({
          queued: 0,
          queuedBytes: 0,
          lastCommitAt: NOW,
          failures: 3,
          lastError: error,
          paused,
        }),
      }),
    );
    r.clock.advance(5);
    const failing = await evaluator.refresh();
    expect(failing.persisted).toMatchObject({ status: 'failing', failures1h: 0 });
    error = { code: 'db_full', at: NOW + 2 };
    paused = true;
    expect((await evaluator.refresh()).persisted.status).toBe('db_error');
  });

  it('reports a fact query that fails as INGEST_HEALTH_PARTIAL instead of reading it as zero (UI-I4)', async () => {
    const warnings: string[] = [];
    const r = rig((event) => void warnings.push(event));
    const evaluator = createIngestHealthEvaluator(r.ctx, sources(r, { transcriptsDir: () => r.projectDir }));
    const healthy = await evaluator.refresh();
    expect(codesOf(healthy)).not.toContain(PARTIAL);
    r.db.driver.exec('DROP TABLE ingest_errors');
    r.clock.advance(31_000); // past the 30 s cache of the hourly facts
    const report = await evaluator.refresh();
    expect(report.status).toBe('degraded');
    expect(report.reasons).toContainEqual(expect.objectContaining({ code: PARTIAL, severity: 'warn' }));
    const row = new IngestHealthRepo(r.db).get(r.ctx.scope);
    expect(row?.status).toBe('degraded');
    expect(IngestHealthSchema.parse(JSON.parse(row?.reportJson ?? '{}'))).toEqual(report);
    // the alert inputs lost a query too: that is logged, not swallowed
    expect(warnings).toContain('alert_inputs_partial');
  });

  it('never returns or stores the previous report as ok when a refresh fails (UI-I4)', async () => {
    const r = rig();
    let broken = false;
    const evaluator = createIngestHealthEvaluator(
      r.ctx,
      sources(r, {
        transcriptsDir: () => r.projectDir,
        spool: () => {
          if (broken) throw new Error('FIXTURE spool figures are not available');
          return spoolStats();
        },
      }),
    );
    expect(codesOf(await evaluator.refresh())).not.toContain(PARTIAL);
    broken = true;
    r.clock.advance(5_000);
    const failed = await evaluator.refresh();
    expect(failed.status).toBe('degraded');
    expect(failed.reasons).toContainEqual(expect.objectContaining({ code: PARTIAL, severity: 'warn' }));
    expect(evaluator.last()).toEqual(failed);
    const row = new IngestHealthRepo(r.db).get(r.ctx.scope);
    expect(row?.status).toBe('degraded');
    expect(IngestHealthSchema.parse(JSON.parse(row?.reportJson ?? '{}'))).toEqual(failed);
    // a second failure keeps the time the reason began
    r.clock.advance(5_000);
    const again = await evaluator.refresh();
    expect(again.reasons.find((reason) => reason.code === PARTIAL)?.since).toBe(
      failed.reasons.find((reason) => reason.code === PARTIAL)?.since,
    );
    // and the reason goes when the figures are back
    broken = false;
    r.clock.advance(5_000);
    expect(codesOf(await evaluator.refresh())).not.toContain(PARTIAL);
  });

  it('still returns the report when the row cannot be written', async () => {
    const r = rig();
    r.db.driver.pragma('query_only = ON');
    const evaluator = createIngestHealthEvaluator(r.ctx, sources(r));
    const report = await evaluator.refresh();
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
    expect(evaluator.last()).toEqual(report);
  });

  it('announces health/upsert only when a status changed, not on every refresh', async () => {
    const r = rig();
    let lag = 0;
    const evaluator = createIngestHealthEvaluator(
      r.ctx,
      sources(r, {
        transcripts: () => transcriptStats({ filesTracked: 1, maxLagMs: lag }),
        transcriptsDir: () => r.projectDir,
      }),
    );
    const healthChanges = (): number =>
      r.db.driver.prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE kind = 'health'").get()?.n ?? -1;
    await evaluator.refresh();
    const first = healthChanges();
    r.clock.advance(5_000);
    await evaluator.refresh();
    expect(healthChanges()).toBe(first);
    lag = 60_000;
    r.clock.advance(5_000);
    await evaluator.refresh();
    expect(healthChanges()).toBe(first + 1);
  });
});
