// Synthetic ingestion health reports for the alert tests (WP-59): a healthy report and a patch over it. Every value is a
// FIXTURE; nothing is read from a real instance.
import { IngestHealthSchema, type IngestHealth } from '@mcs/shared';

export interface HealthPatch {
  readonly hooks?: Partial<IngestHealth['receiving']['hooks']>;
  readonly transcripts?: Partial<IngestHealth['receiving']['transcripts']>;
  readonly persisted?: Partial<IngestHealth['persisted']>;
}

/** A healthy report evaluated at `at`, with `patch` laid over its hooks, transcripts and persisted blocks. */
export function healthFixture(at: number, patch: HealthPatch = {}): IngestHealth {
  return IngestHealthSchema.parse({
    evaluatedAt: at,
    provider: { lastActivityAt: null, source: null, status: 'none' },
    receiving: {
      hooks: {
        installed: [],
        lastEnvelopeAt: null,
        envelopes1h: 0,
        duplicates1h: 0,
        invalid1h: 0,
        handlerErrors: [],
        transcriptHookFailures: 0,
        coverage: { full: 0, partial: 0, none: 0 },
        status: 'ok',
        ...patch.hooks,
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
        dir: null,
        dirFound: true,
        filesTracked: 3,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 0,
        backfillRemainingBytes: 0,
        lastScanAt: null,
        lastSyncAt: null,
        errors: {},
        status: 'ok',
        ...patch.transcripts,
      },
    },
    persisted: {
      lastCommitAt: null,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 0,
      failures1h: 0,
      lastError: null,
      status: 'ok',
      ...patch.persisted,
    },
    display: { headSeq: 0, serverTime: at },
    runtime: { startedAt: at - 3_600_000, eventLoopDelayP99Ms: 0 },
    status: 'ok',
    reasons: [],
  });
}
