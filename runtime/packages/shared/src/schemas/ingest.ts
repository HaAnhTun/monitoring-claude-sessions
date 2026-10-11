/**
 * Zod schemas of the ingestion boundary (02 4.2): the spool line, the route file, the transcript record shape, the
 * nudge body and the ingest health report. The zod-free types they mirror live in `../protocol/`.
 */
import { z } from 'zod';

import {
  AGENT_RE,
  ENVELOPE_FLAG_RE,
  ENVELOPE_MAX_BYTES,
  NAME_MAX_CHARS,
  PATH_MAX_CHARS,
  SID_RE,
  TOOL_ID_RE,
} from '../protocol/hook-envelope.ts';

/** Lowercase 8-4-4-4-12 hex; the version nibble is not checked (route files and fixtures may use any uuid). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** No C0 control characters or DEL. Built from code points so the source holds no control characters. */
const CONTROL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + ']',
);

const uuid = z.string().regex(UUID_RE);
const timestampMs = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const nullableTimestampMs = timestampMs.nullable();

/** A short enum-like string: at most 64 chars and no control character (02 2.3.2). */
const nameString = z
  .string()
  .max(NAME_MAX_CHARS)
  .refine((value) => !CONTROL_RE.test(value), { message: 'control characters are not allowed' });
const pathString = z.string().max(PATH_MAX_CHARS);

// ---- HookEnvelopeV1Schema (02 2.3.1, strict) ---------------------------------------------------------------------

const envelopeDataValue = z.union([
  z.string().max(ENVELOPE_MAX_BYTES),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.record(z.string().max(NAME_MAX_CHARS), z.string().max(ENVELOPE_MAX_BYTES).nullable())).max(64),
]);

export const HookEnvelopeV1Schema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['hook', 'probe']),
  instance_id: uuid,
  event_uid: uuid,
  received_at: timestampMs,
  event: z.string().min(1).max(NAME_MAX_CHARS),
  argv_event: z.string().max(NAME_MAX_CHARS),
  session_id: z.string().regex(SID_RE).nullable(),
  transcript_path: pathString.nullable(),
  cwd: pathString.nullable(),
  prompt_id: z.string().regex(TOOL_ID_RE).nullable(),
  agent_id: z.string().regex(AGENT_RE).nullable(),
  agent_type: nameString.nullable(),
  tool_use_id: z.string().regex(TOOL_ID_RE).nullable(),
  permission_mode: nameString.nullable(),
  claude_pid: z.number().int().nonnegative().max(9_999_999_999).nullable(),
  payload_bytes: count,
  content_hash: z.string().regex(/^[0-9a-f]{32}$/),
  handler: z.strictObject({ version: z.string().min(1).max(NAME_MAX_CHARS), pid: count, async: z.boolean() }),
  flags: z.array(z.string().regex(ENVELOPE_FLAG_RE)).max(32),
  data: z
    .record(z.string().max(NAME_MAX_CHARS), envelopeDataValue)
    .refine((data) => Object.keys(data).length <= 64, { message: 'data holds at most 64 keys' }),
});

// ---- HookRouteV1Schema (02 2.6.2) --------------------------------------------------------------------------------

export const HookRouteV1Schema = z.object({
  v: z.literal(1),
  instanceId: uuid,
  workspace: pathString.min(1),
  spoolDir: pathString.min(1),
  stateFile: pathString.min(1),
  enabled: z.boolean(),
  match: z.object({
    transcriptsDirs: z.array(pathString).max(8),
    sessionIds: z.array(z.string().regex(SID_RE)).max(256),
  }),
  stoppedAt: nullableTimestampMs,
  spoolUntil: nullableTimestampMs,
  updatedAt: timestampMs,
});

// ---- NudgeBodySchema (02 2.8) ------------------------------------------------------------------------------------

export const NudgeBodySchema = z.strictObject({ instanceId: uuid });

// ---- TranscriptRecordShape (02 4.2, loose) -----------------------------------------------------------------------

const looseTyped = z.looseObject({ type: z.string() });

/**
 * Only what the importer reads is checked; everything else passes through. A record that fails is counted as an
 * invalid line (`RECORD_SHAPE`), so the shape stays as permissive as the importer's own use allows.
 */
export const TranscriptRecordShape = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  promptId: z.string().optional(),
  subtype: z.string().optional(),
  message: z
    .looseObject({
      id: z.string().optional(),
      model: z.string().optional(),
      role: z.string().optional(),
      stop_reason: z.string().nullable().optional(),
      usage: z.looseObject({}).optional(),
      content: z.union([z.string(), z.array(looseTyped)]).optional(),
    })
    .optional(),
  toolUseResult: z.unknown().optional(),
  attachment: looseTyped.optional(),
  origin: z.looseObject({ kind: z.string().optional() }).optional(),
  toolDenialKind: z.string().optional(),
  toolEndsTurn: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(),
  isAbortedMidStream: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  compactMetadata: z.looseObject({}).optional(),
});

// ---- IngestHealthSchema (02 8.2) ---------------------------------------------------------------------------------

const reasonCode = z.string().min(1);

export const IngestHealthSchema = z.object({
  evaluatedAt: timestampMs,
  provider: z.object({
    lastActivityAt: nullableTimestampMs,
    source: z.enum(['hook', 'transcript_mtime']).nullable(),
    status: z.enum(['active', 'quiet', 'silent', 'none']),
  }),
  receiving: z.object({
    hooks: z.object({
      installed: z.array(
        z.object({
          scope: z.string(),
          settingsPath: z.string(),
          verifiedAt: nullableTimestampMs,
          ok: z.boolean().nullable(),
        }),
      ),
      lastEnvelopeAt: nullableTimestampMs,
      envelopes1h: count,
      duplicates1h: count,
      invalid1h: count,
      handlerErrors: z.array(z.object({ code: z.string(), count, lastAt: timestampMs })),
      transcriptHookFailures: count,
      coverage: z.object({ full: count, partial: count, none: count }),
      status: z.enum(['ok', 'not_installed', 'idle', 'gap', 'failing']),
    }),
    spool: z.object({
      segments: count,
      bytes: count,
      bytesBehind: count,
      oldestPendingReceivedAt: nullableTimestampMs,
      lastNudgeAt: nullableTimestampMs,
      lastDrainAt: nullableTimestampMs,
      foreignFiles: count,
    }),
    transcripts: z.object({
      dir: z.string().nullable(),
      dirFound: z.boolean(),
      filesTracked: count,
      filesMissing: count,
      filesUnreadable: count,
      bytesBehind: count,
      maxLagMs: z.number().nonnegative(),
      backfillRemainingBytes: count,
      lastScanAt: nullableTimestampMs,
      lastSyncAt: nullableTimestampMs,
      errors: z.record(z.string(), count),
      status: z.enum(['ok', 'backfilling', 'lagging', 'errors', 'not_found']),
    }),
  }),
  persisted: z.object({
    lastCommitAt: nullableTimestampMs,
    queueItems: count,
    queueBytes: count,
    commitP95Ms: z.number().nonnegative(),
    failures1h: count,
    lastError: z.object({ code: z.string(), at: timestampMs }).nullable(),
    status: z.enum(['ok', 'backlog', 'failing', 'db_error']),
  }),
  display: z.object({ headSeq: count, serverTime: timestampMs }),
  runtime: z.object({ startedAt: timestampMs, eventLoopDelayP99Ms: z.number().nonnegative() }),
  status: z.enum(['ok', 'degraded', 'down']),
  reasons: z.array(z.object({ code: reasonCode, severity: z.enum(['info', 'warn', 'error']), since: timestampMs })),
});

export type IngestHealth = z.infer<typeof IngestHealthSchema>;
