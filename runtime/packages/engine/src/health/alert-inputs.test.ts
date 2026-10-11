// The alert inputs of 02 8.3 (T-HE-07): each condition fires once when it begins or changes and not again while it stays the same.
import { describe, expect, it } from 'vitest';

import {
  activeAlertConditions,
  createAlertInputTracker,
  emitAlertInputs,
  subscribeAlertInputs,
  type AlertInput,
  type AlertInputSnapshot,
} from './alert-inputs.ts';
import { computeIngestHealth, type HealthThresholds, type IngestHealthFacts } from './ingest-health.ts';

const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const THRESHOLDS: HealthThresholds = {
  activeSeconds: 120,
  staleAfterSeconds: 1800,
  importLagWarnMs: 30_000,
  backlogWarnMs: 10_000,
};
const S1 = '00000000-0000-4000-8000-0000000000d1';
const S2 = '00000000-0000-4000-8000-0000000000d2';

function facts(over: Partial<IngestHealthFacts> = {}): IngestHealthFacts {
  return {
    now: NOW,
    startedAt: NOW - 600_000,
    eventLoopDelayP99Ms: 1,
    queryFailures: 0,
    headSeq: 1,
    lastEnvelopeAt: NOW - 1000,
    newestTranscriptMtime: null,
    newestSpoolMtime: null,
    hooks: {
      installed: [],
      envelopes1h: 1,
      duplicates1h: 0,
      invalid1h: 0,
      handlerErrors: [],
      handlerFailing: false,
      transcriptHookFailures: 0,
      coverage: { full: 1, partial: 0, none: 0 },
    },
    spool: {
      segments: 0,
      bytes: 0,
      bytesBehind: 0,
      oldestPendingReceivedAt: null,
      lastNudgeAt: null,
      lastDrainAt: null,
      foreignFiles: 0,
    },
    transcripts: {
      dir: 'x',
      dirFound: true,
      filesTracked: 2,
      filesMissing: 0,
      filesUnreadable: 0,
      bytesBehind: 0,
      maxLagMs: 0,
      backfillRemainingBytes: 0,
      lastScanAt: null,
      lastSyncAt: null,
      errors: {},
      recentProblems: 0,
    },
    persisted: {
      lastCommitAt: NOW,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 0,
      failures1h: 0,
      lastError: null,
      lastCommitFailed: false,
      paused: false,
      backlogSince: null,
    },
    ...over,
  };
}

function snapshot(over: Partial<IngestHealthFacts> = {}, extra: Partial<AlertInputSnapshot> = {}): AlertInputSnapshot {
  return {
    report: computeIngestHealth(facts(over), THRESHOLDS),
    workingSessionUids: [],
    errorsByCode10min: {},
    downtime: null,
    gaps: [],
    noActivityMs: 1_800_000,
    ...extra,
  };
}

const codes = (inputs: readonly AlertInput[]): string[] => inputs.map((input) => input.code);

describe('activeAlertConditions', () => {
  it('has no condition for a healthy instance', () => {
    expect(activeAlertConditions(snapshot())).toEqual([]);
  });

  it('no_activity: a silent provider while sessions are working, with the sessions and the quiet time', () => {
    const silent: Partial<IngestHealthFacts> = { lastEnvelopeAt: NOW - 2_000_000 };
    expect(codes(activeAlertConditions(snapshot(silent)))).toEqual([]);
    const [input] = activeAlertConditions(snapshot(silent, { workingSessionUids: [S2, S1] }));
    expect(input?.code).toBe('no_activity');
    expect(input?.payload).toEqual({ sessionIds: [S1, S2], quietMs: 2_000_000 });
  });

  it('ingest_errors_repeated: at least 10 errors of one code in 10 minutes', () => {
    const inputs = activeAlertConditions(snapshot({}, { errorsByCode10min: { READ_FAILED: 10, LINE_TOO_LONG: 9 } }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.payload).toEqual({ code: 'READ_FAILED', count: 10, windowMs: 600_000 });
  });

  it('runtime_unavailable: a downtime reconciliation, or a handler that reports HANDLER_UNAVAILABLE', () => {
    const viaDowntime = activeAlertConditions(
      snapshot({}, { downtime: { from: NOW - 900_000, to: NOW - 600_000, envelopes: 4 } }),
    );
    expect(viaDowntime[0]?.payload).toEqual({ from: NOW - 900_000, to: NOW - 600_000, envelopes: 4 });
    const viaHandler = activeAlertConditions(
      snapshot({
        hooks: {
          ...facts().hooks,
          handlerFailing: true,
          handlerErrors: [{ code: 'HANDLER_UNAVAILABLE', count: 3, lastAt: NOW - 1000 }],
        },
      }),
    );
    expect(codes(viaHandler)).toEqual(['runtime_unavailable']);
  });

  it('import_lag, hook_gap, hook_failing, db_error and disk have their payloads', () => {
    expect(
      activeAlertConditions(snapshot({ transcripts: { ...facts().transcripts, maxLagMs: 45_000 } }))[0]?.payload,
    ).toEqual({ maxLagMs: 45_000, files: 2 });
    expect(
      activeAlertConditions(
        snapshot(
          { hooks: { ...facts().hooks, coverage: { full: 0, partial: 1, none: 0 } } },
          { gaps: [{ sessionId: S1, missingTools: 2, missingTurns: 1 }] },
        ),
      )[0],
    ).toMatchObject({ code: 'hook_gap', payload: { sessionId: S1, missingTools: 2, missingTurns: 1 } });
    expect(
      activeAlertConditions(snapshot({ hooks: { ...facts().hooks, transcriptHookFailures: 3 } }))[0],
    ).toMatchObject({ code: 'hook_failing', payload: { count: 3 } });
    const full = activeAlertConditions(
      snapshot({
        persisted: { ...facts().persisted, lastCommitFailed: true, lastError: { code: 'db_full', at: NOW } },
      }),
    );
    expect(codes(full)).toEqual(['db_error', 'disk']);
    expect(full[1]?.payload).toEqual({ errorCode: 'db_full', where: 'persisted' });
    const spoolFull = activeAlertConditions(
      snapshot({
        hooks: {
          ...facts().hooks,
          handlerFailing: true,
          handlerErrors: [{ code: 'SPOOL_FULL', count: 1, lastAt: NOW }],
        },
      }),
    );
    expect(spoolFull.find((input) => input.code === 'disk')?.payload).toEqual({
      errorCode: 'SPOOL_FULL',
      where: 'spool',
    });
  });
});

describe('T-HE-07 createAlertInputTracker', () => {
  it('fires a condition once and not again while it is unchanged', () => {
    const tracker = createAlertInputTracker();
    const lagging = snapshot({ transcripts: { ...facts().transcripts, maxLagMs: 45_000 } });
    expect(codes(tracker.evaluate(lagging))).toEqual(['import_lag']);
    expect(tracker.evaluate(lagging)).toEqual([]);
    // the payload moves, the condition does not
    const worse = snapshot({ transcripts: { ...facts().transcripts, maxLagMs: 90_000 } });
    expect(tracker.evaluate(worse)).toEqual([]);
  });

  it('fires again after the condition cleared and came back', () => {
    const tracker = createAlertInputTracker();
    const lagging = snapshot({ transcripts: { ...facts().transcripts, maxLagMs: 45_000 } });
    expect(tracker.evaluate(lagging)).toHaveLength(1);
    expect(tracker.evaluate(snapshot())).toEqual([]);
    expect(tracker.evaluate(lagging)).toHaveLength(1);
  });

  it('fires a hook gap again when its counts change, and a failing hook when the failures grow', () => {
    const tracker = createAlertInputTracker();
    const gap = (tools: number): AlertInputSnapshot =>
      snapshot(
        { hooks: { ...facts().hooks, coverage: { full: 0, partial: 1, none: 0 } } },
        { gaps: [{ sessionId: S1, missingTools: tools, missingTurns: 0 }] },
      );
    expect(tracker.evaluate(gap(1))).toHaveLength(1);
    expect(tracker.evaluate(gap(1))).toEqual([]);
    expect(tracker.evaluate(gap(2))).toHaveLength(1);
    const failing = (count: number): AlertInputSnapshot =>
      snapshot({ hooks: { ...facts().hooks, transcriptHookFailures: count } });
    expect(tracker.evaluate(failing(1))).toHaveLength(1);
    expect(tracker.evaluate(failing(1))).toEqual([]);
    expect(tracker.evaluate(failing(2))).toHaveLength(1);
  });

  it('keeps independent conditions apart: a second session with a gap fires, the first does not repeat', () => {
    const tracker = createAlertInputTracker();
    const partial = { hooks: { ...facts().hooks, coverage: { full: 0, partial: 2, none: 0 } } };
    expect(
      tracker.evaluate(snapshot(partial, { gaps: [{ sessionId: S1, missingTools: 1, missingTurns: 0 }] })),
    ).toHaveLength(1);
    const both = tracker.evaluate(
      snapshot(partial, {
        gaps: [
          { sessionId: S1, missingTools: 1, missingTurns: 0 },
          { sessionId: S2, missingTools: 1, missingTurns: 0 },
        ],
      }),
    );
    expect(both.map((input) => input.payload['sessionId'])).toEqual([S2]);
  });
});

describe('subscribeAlertInputs', () => {
  it('delivers to the subscribers of the target, not to those of another, until unsubscribed', () => {
    const target = {};
    const other = {};
    const seen: string[][] = [];
    const unsubscribe = subscribeAlertInputs(target, (inputs) => seen.push(codes(inputs)));
    subscribeAlertInputs(other, () => {
      throw new Error('must not be called');
    });
    const input: AlertInput = { code: 'import_lag', key: 'import_lag', payload: { maxLagMs: 1, files: 1 } };
    emitAlertInputs(target, [input]);
    emitAlertInputs(target, []);
    unsubscribe();
    emitAlertInputs(target, [input]);
    expect(seen).toEqual([['import_lag']]);
  });

  it('survives a listener that throws', () => {
    const target = {};
    const seen: number[] = [];
    subscribeAlertInputs(target, () => {
      throw new Error('listener failed');
    });
    subscribeAlertInputs(target, (inputs) => seen.push(inputs.length));
    expect(() => {
      emitAlertInputs(target, [{ code: 'import_lag', key: 'k', payload: {} }]);
    }).not.toThrow();
    expect(seen).toEqual([1]);
  });
});
