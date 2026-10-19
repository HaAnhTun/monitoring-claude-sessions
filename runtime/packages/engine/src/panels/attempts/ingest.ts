// The attempts tick (06 3.10.3, 3.10.6, 3.10.7, ADR 0059): the chain log is read incrementally into the tables
// `attempt_sources` and `attempt_runs`, the runs are matched to sessions, and the lifecycle evidence is published through the
// shared writer. One tick is
//   1. kept evidence batches are offered to the writer again (a refused batch waits for a free queue);
//   2. read OUTSIDE any transaction: the identity of the chain log (inode and head hash: truncated or replaced files start a
//      new generation) and one slice of complete lines from the stored offset;
//   3. ONE `withWriteTx`: a rebuild when the configuration of the patterns changed, the START and END lines, the offset, the
//      matching of unmatched runs, and the plan of the evidence (reads only). A throw rolls everything back, including the
//      offset, so the next tick reads the same bytes;
//   4. only after the COMMIT: the evidence events go to `writer.submit` as one batch (persist before publish, N-01).
// A tick that has nothing to write (no new bytes, nothing to match) opens no transaction at all.
//
// Gates (06 3.1): `panels.attempts` gates the panel route; `attempts` plus `chain_log` gate this ingestion and the lifecycle
// evidence, whether or not the panel is shown. Invalid patterns and time formats are refused at configuration load
// (`CONFIG_INVALID`), never here.
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Clock, RuntimeConfig } from '@mcs/shared';

import type { LegacyConfig } from '../../config/defaults.ts';
import type { CompiledPatterns } from '../../config/validate-legacy.ts';
import type { InstanceDb, RepoContext } from '../../db/open.ts';
import { withWriteTx, type WriteTx } from '../../db/write.ts';
import {
  IDENTITY_HEAD_BYTES,
  classifyFsError,
  errorCodeOf,
  type FileIdentity,
} from '../../ingest/tail/file-identity.ts';
import { checkIdentity, readIdentity, readLines, type ReadResult } from '../../ingest/tail/jsonl-tailer.ts';
import type { RawLine } from '../../ingest/tail/line-splitter.ts';
import type { Logger } from '../../log/logger.ts';
import { pySplitlines } from '../../platform/fsx.ts';
import { canonicalPath, pathKey } from '../../platform/paths.ts';
import type { AttemptsTickResult } from '../../runtime/instance-runtime.ts';
import {
  EMPTY_PLAN,
  closeEvidenceState,
  createEvidenceState,
  drainPending,
  planEvidence,
  publishEvidence,
  type EvidencePlan,
  type EvidenceState,
  type EvidenceWriter,
} from './evidence.ts';
import { matchRuns, type MatchRun } from './match.ts';
import { DEFAULT_TIME_FORMAT, parseChainLine, type ChainLine, type ChainPatterns } from './parse.ts';
import { createAttemptsStore, type AttemptsStore } from './repo.ts';
import { OPEN_EVIDENCE, externalState, supersededEvidence } from './state.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

/** How much of the chain log one tick may look at and take (06 3.10.3 step 5). */
export interface AttemptsLimits {
  /** Bytes from the stored offset that one tick looks at. */
  readonly rangeBytes: number;
  /** Bytes after which the tick stops taking lines: what one transaction applies stays small. */
  readonly sliceBytes: number;
  /** Time the splitter may spend on one slice. */
  readonly sliceDeadlineMs: number;
}

export const ATTEMPTS_LIMITS: AttemptsLimits = { rangeBytes: 8 * MIB, sliceBytes: 128 * KIB, sliceDeadlineMs: 20 };

/** A line longer than this is skipped, not parsed (the tailer counts it). */
const MAX_LINE_BYTES = MIB;
const CHUNK_BYTES = MIB;
/** Unmatched runs that one tick tries to match besides the ones it changed (06 3.10.3 step 7). */
const MAX_RUNS_TO_MATCH = 500;
/** One line of the file is cut into at most this many pieces at Python-style line breaks. */
const MAX_PIECES_PER_LINE = 10_000;

// ---- configuration ------------------------------------------------------------------------------------------------------------

/** What the tick reads of the instance context (`InstanceContext` satisfies it). */
export interface AttemptsTickContext {
  readonly repoDir: string;
  readonly clock: Clock;
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly logger: Pick<Logger, 'debug' | 'warn'>;
  readonly config: {
    readonly monitor: Pick<LegacyConfig, 'chain_log' | 'attempts' | 'include_unmatched'>;
    readonly patterns: Pick<CompiledPatterns, 'attempts'>;
    readonly runtime: { readonly panelOptions: Pick<RuntimeConfig['panelOptions'], 'attemptsWindowHours'> };
  };
}

/** The configuration of the attempts, resolved: `null` from `attemptsSettings` means "not configured". */
export interface AttemptsSettings {
  /** `chain_log` as written. */
  readonly chainLog: string;
  /** The source texts of the patterns, for the configuration hash. */
  readonly startSource: string;
  readonly endSource: string;
  readonly labelPrefix: string;
  readonly timeFormat: string;
  readonly patterns: ChainPatterns;
  readonly includeUnmatched: boolean;
  readonly windowMs: number;
}

const HOUR_MS = 3_600_000;

/** `null` unless `chain_log` and `attempts` are both set (an empty `chain_log` counts as not set, like the legacy `not cfg.get`). */
export function attemptsSettings(config: AttemptsTickContext['config']): AttemptsSettings | null {
  const { chain_log: chainLog, attempts, include_unmatched: includeUnmatched } = config.monitor;
  const compiled = config.patterns.attempts;
  if (chainLog === null || chainLog === '' || attempts === null || compiled === null) return null;
  const timeFormat = attempts.time_format ?? DEFAULT_TIME_FORMAT;
  return {
    chainLog,
    startSource: attempts.start,
    endSource: attempts.end,
    labelPrefix: attempts.label_prefix ?? '',
    timeFormat,
    patterns: { start: compiled.start, end: compiled.end, timeFormat },
    includeUnmatched,
    windowMs: config.runtime.panelOptions.attemptsWindowHours * HOUR_MS,
  };
}

/** The hash that tells a changed configuration from an unchanged one (06 3.10.3 step 2). */
export function configHash(settings: AttemptsSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([settings.startSource, settings.endSource, settings.labelPrefix, settings.timeFormat]))
    .digest('hex');
}

// ---- state kept between ticks ------------------------------------------------------------------------------------------------

/** What a process remembers between ticks. One per panel service; `closeAttemptsState` ends it. */
export interface AttemptsState {
  readonly evidence: EvidenceState;
  /** The tick stopped inside a line longer than the cap: the next one continues skipping it (not stored in the database). */
  resumeSkip: { readonly key: string; readonly generation: number; readonly offset: number } | null;
  /** The code of the last read failure that was logged, so that a persistent failure is logged once. */
  lastReadError: string | null;
}

export function createAttemptsState(): AttemptsState {
  return { evidence: createEvidenceState(), resumeSkip: null, lastReadError: null };
}

/** Drops the evidence batches that the writer did not accept (service shutdown). */
export function closeAttemptsState(state: AttemptsState): void {
  closeEvidenceState(state.evidence);
}

export interface AttemptsDeps {
  /** The one writer of the ingest service (02 4.10); only `submit` and `onDrain` are used. */
  readonly writer: EvidenceWriter;
  readonly state: AttemptsState;
  /** Tests make the slices small. */
  readonly limits?: Partial<AttemptsLimits>;
}

// ---- lines ----------------------------------------------------------------------------------------------------------------------

interface Piece {
  readonly text: string;
  /** Offset of the first byte of the piece in the file. */
  readonly offset: number;
}

/**
 * The pieces of one LF-terminated line, cut at the line breaks that Python's `splitlines` knows (a lone CR, VT, FF, FS, GS, RS,
 * NEL, LS, PS): the pre-4.0 engine read the chain log that way. The offset of a piece is the offset of the line plus the bytes
 * before it, separators included.
 */
function piecesOf(raw: RawLine): Piece[] {
  const text = raw.bytes.toString('utf8');
  const parts = pySplitlines(text);
  if (parts.length === 1 && parts[0] === text) return [{ text, offset: raw.offset }];
  const pieces: Piece[] = [];
  let cursor = 0;
  let offset = raw.offset;
  for (const part of parts) {
    if (pieces.length >= MAX_PIECES_PER_LINE) break;
    pieces.push({ text: part, offset });
    offset += Buffer.byteLength(part);
    cursor += part.length;
    if (cursor < text.length) {
      const length = text.charAt(cursor) === '\r' && text.charAt(cursor + 1) === '\n' ? 2 : 1;
      offset += Buffer.byteLength(text.slice(cursor, cursor + length));
      cursor += length;
    }
  }
  return pieces;
}

/** What one tick changed, collected while the lines are applied. */
interface Changes {
  rows: number;
  /** Sessions whose matched run ended in this tick. */
  endedSessions: Set<number>;
  /** Runs inserted or ended in this tick that no session owns yet. */
  unmatched: Map<number, MatchRun>;
}

function applyLine(
  store: AttemptsStore,
  tx: WriteTx,
  sourceId: number,
  generation: number,
  parsed: ChainLine,
  offset: number,
  changes: Changes,
): void {
  if (parsed.kind === 'start') {
    const open = store.openRun(sourceId, generation, parsed.part);
    if (open !== undefined && store.supersedeRun(tx, open.id, supersededEvidence(parsed.part))) changes.rows += 1;
    const id = store.insertRun(tx, {
      sourceId,
      generation,
      startOffset: offset,
      part: parsed.part,
      nRaw: parsed.nRaw,
      model: parsed.model,
      effort: parsed.effort,
      startedAt: parsed.startedAt,
      evidence: OPEN_EVIDENCE,
    });
    if (id !== undefined) {
      changes.rows += 1;
      changes.unmatched.set(id, { id, part: parsed.part, startedAt: parsed.startedAt });
    }
    return;
  }
  if (parsed.part === null) return;
  const open = store.openRun(sourceId, generation, parsed.part);
  if (open === undefined) return;
  const { state, evidence } = externalState(parsed.exitRaw, parsed.statusRaw);
  const ended = store.endRun(tx, open.id, {
    endOffset: offset,
    endedAt: parsed.endedAt ?? open.startedAt,
    exitRaw: parsed.exitRaw,
    statusRaw: parsed.statusRaw,
    state,
    evidence,
  });
  if (!ended) return;
  changes.rows += 1;
  if (open.sessionRowId !== null) changes.endedSessions.add(open.sessionRowId);
  else changes.unmatched.set(open.id, { id: open.id, part: open.part, startedAt: open.startedAt });
}

// ---- the tick -----------------------------------------------------------------------------------------------------------------

function outcome(state: AttemptsTickResult['state'], over: Partial<AttemptsTickResult> = {}): AttemptsTickResult {
  return { state, linesRead: 0, rowsChanged: 0, eventsSubmitted: 0, ...over };
}

/** Why a file read failed: ENOENT and ENOTDIR are `missing` (the rows are kept), anything else is `error`. */
function readFailure(ctx: AttemptsTickContext, state: AttemptsState, error: unknown): AttemptsTickResult['state'] {
  const code = errorCodeOf(error);
  if (classifyFsError(code) === 'missing') return 'missing';
  if (state.lastReadError !== code) ctx.logger.warn('attempts_read_failed', { code });
  state.lastReadError = code;
  return 'error';
}

interface ReadPlan {
  readonly file: string;
  readonly key: string;
  readonly generation: number;
  readonly identity: FileIdentity;
  readonly read: Pick<ReadResult, 'lines' | 'nextOffset' | 'skipping'>;
  readonly fresh: boolean;
}

async function tickOnce(ctx: AttemptsTickContext, deps: AttemptsDeps): Promise<AttemptsTickResult> {
  const settings = attemptsSettings(ctx.config);
  if (settings === null) return outcome('not_configured');
  const { state } = deps;
  const limits: AttemptsLimits = { ...ATTEMPTS_LIMITS, ...deps.limits };
  const store = createAttemptsStore(ctx.db, ctx.scope);
  const now = ctx.clock.now();
  const file = canonicalPath(path.resolve(ctx.repoDir, settings.chainLog));
  const key = pathKey(file);
  const source = store.getSource(key);
  const cfgHash = configHash(settings);
  const rebuild = source !== undefined && source.configSha256 !== cfgHash;

  // ---- read, outside any transaction
  let plan: ReadPlan;
  try {
    const stored =
      source === undefined || rebuild ? null : { ino: source.ino, headLen: source.headLen, headHash: source.headHash };
    const check = await checkIdentity(file, stored, source?.readOffset ?? 0, rebuild ? 0 : (source?.readOffset ?? 0));
    if (check.kind === 'missing') return outcome('missing');
    if (check.kind === 'unreadable') return outcome(readFailure(ctx, state, { code: check.code }));
    // the stored cursor holds unless the configuration changed or the file was truncated or replaced
    const prior = source === undefined || rebuild || check.kind === 'reset' ? undefined : source;
    const fresh = prior === undefined;
    const size = Number(check.stat.size);
    // a head shorter than 256 bytes is extended as the file grows, so that the check keeps its strength
    const identity: FileIdentity =
      prior === undefined || prior.headLen < IDENTITY_HEAD_BYTES
        ? await readIdentity(file, check.stat)
        : { ino: prior.ino, headLen: prior.headLen, headHash: prior.headHash };
    const generation =
      source === undefined || rebuild ? 1 : prior === undefined ? source.generation + 1 : source.generation;
    const from = prior === undefined ? 0 : prior.readOffset;
    const to = Math.min(size, from + limits.rangeBytes);
    const resume = state.resumeSkip;
    const resumeSkip =
      resume !== null && resume.key === key && resume.generation === generation && resume.offset === from;
    const read: ReadPlan['read'] =
      from < to
        ? await readLines(file, from, to, performance.now() + limits.sliceDeadlineMs, {
            chunkBytes: CHUNK_BYTES,
            maxLineBytes: MAX_LINE_BYTES,
            acceptValidUnterminatedTail: false,
            sliceBytes: limits.sliceBytes,
            resumeSkip,
          })
        : { lines: [], nextOffset: from, skipping: false };
    plan = { file, key, generation, identity, read, fresh };
    state.lastReadError = null;
  } catch (error) {
    return outcome(readFailure(ctx, state, error));
  }

  // ---- nothing to write: no new bytes, the same identity and nothing that could be matched
  const { read, identity, generation } = plan;
  const unchanged =
    source !== undefined &&
    !plan.fresh &&
    read.lines.length === 0 &&
    read.nextOffset === source.readOffset &&
    identity.headLen === source.headLen &&
    identity.headHash === source.headHash &&
    identity.ino === source.ino;
  const options = {
    labelPrefix: settings.labelPrefix,
    includeUnmatched: settings.includeUnmatched,
    windowMs: settings.windowMs,
    now,
  };
  if (unchanged) {
    const waiting = store.runsToMatch(now - settings.windowMs, MAX_RUNS_TO_MATCH);
    const none = waiting.length === 0 || matchRuns(store, waiting, options).length === 0;
    if (none) return outcome('ok');
  }

  // ---- one transaction: rows, offset, matching, and the plan of the evidence
  const written = withWriteTx(ctx.db, ctx.scope, (tx) => {
    const sourceInput = (readOffset: number): Parameters<AttemptsStore['saveSource']>[1] => ({
      path: file,
      pathKey: key,
      generation,
      ino: identity.ino,
      headLen: identity.headLen,
      headHash: identity.headHash,
      readOffset,
      configSha256: cfgHash,
    });
    let cleared: number[] = [];
    let sourceId: number;
    if (source === undefined) {
      sourceId = store.saveSource(tx, sourceInput(0));
    } else {
      sourceId = source.id;
      if (rebuild) cleared = store.resetSource(tx, source.id, cfgHash);
    }
    const changes: Changes = { rows: 0, endedSessions: new Set(), unmatched: new Map() };
    for (const raw of read.lines) {
      for (const piece of piecesOf(raw)) {
        const parsed = parseChainLine(piece.text, settings.patterns, settings.labelPrefix);
        if (parsed !== null) applyLine(store, tx, sourceId, generation, parsed, piece.offset, changes);
      }
    }
    store.saveSource(tx, sourceInput(read.nextOffset));

    const toMatch = new Map<number, MatchRun>(changes.unmatched);
    for (const run of store.runsToMatch(now - settings.windowMs, MAX_RUNS_TO_MATCH)) {
      if (!toMatch.has(run.id)) toMatch.set(run.id, { id: run.id, part: run.part, startedAt: run.startedAt });
    }
    const touched = new Set<number>(changes.endedSessions);
    const uids = new Map<number, string>();
    for (const match of matchRuns(store, [...toMatch.values()], options)) {
      if (!store.setMatch(tx, match.runId, match.sessionRowId, match.deltaMs)) continue;
      changes.rows += 1;
      touched.add(match.sessionRowId);
      uids.set(match.sessionRowId, match.sessionUid);
    }
    const evidence: EvidencePlan =
      touched.size + cleared.length === 0
        ? EMPTY_PLAN
        : planEvidence(store, { touched, cleared, uids, published: state.evidence.published });
    return { rows: changes.rows, evidence };
  });

  // ---- after the COMMIT
  state.resumeSkip = read.skipping ? { key, generation, offset: read.nextOffset } : null;
  const submitted = publishEvidence(
    { clock: ctx.clock, writer: deps.writer, state: state.evidence, logger: ctx.logger },
    written.evidence,
    source?.updatedAt ?? 0,
  );
  return outcome('ok', { linesRead: read.lines.length, rowsChanged: written.rows, eventsSubmitted: submitted });
}

/**
 * One tick of the attempts (06 3.10.3): offers the kept evidence batches to the writer, reads the new lines of the chain log,
 * stores the runs and their matches in ONE transaction, and after its COMMIT submits the evidence as ONE batch.
 *
 * Answers `not_configured` (no `attempts` or no `chain_log`), `missing` (the file is not there: rows are kept) or `error` (the
 * file cannot be read) without throwing for file problems. A failure of the database rejects: the transaction rolled back, no
 * event was submitted, and the next tick reads the same bytes again. Ticks must not overlap (the panel service serialises them).
 */
export async function tickAttempts(ctx: AttemptsTickContext, deps: AttemptsDeps): Promise<AttemptsTickResult> {
  const kept = drainPending({ clock: ctx.clock, writer: deps.writer, state: deps.state.evidence, logger: ctx.logger });
  const result = await tickOnce(ctx, deps);
  return kept === 0 ? result : { ...result, eventsSubmitted: result.eventsSubmitted + kept };
}
