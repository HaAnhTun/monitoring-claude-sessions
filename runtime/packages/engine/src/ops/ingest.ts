// `ops.ingest.replay` (`mcs ingest replay`, 01 6.4, I-29; behaviour owned by 02 2.7): read the spool segments of a task again.
// The segments stay on disk; the cursors of the selected ones are reset, the next drain reads them from byte 0, and dedupe by
// `event_uid` makes the re-read a no-op for every line that was already committed. A dry run (no `yes`) lists the plan and
// writes nothing. A stopped instance is changed directly under the task mutex (the database is opened in maintenance mode);
// a running one is asked through the control channel, so the server resets the cursors from its own writer queue.
import { lstat } from 'node:fs/promises';

import { McsError, RUNTIME_VERSION } from '@mcs/shared';
import { SPOOL_SEGMENT_RE, controlTimeoutMs, type ControlRequest } from '@mcs/shared/protocol';

import { appendChange } from '../audit/writer.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SpoolCursorsRepo } from '../db/repos/spool-cursors.ts';
import { SpoolSegmentNotFoundError } from '../ingest/errors.ts';
import { applySpoolReplay, planSpoolReplay, type SpoolReplayPlan } from '../ingest/spool/replay.ts';
import { listSegments } from '../ingest/spool/segments.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { controlTokenOf, dbFailure, liveError, migrationsOf, requireInstance, type BackupOpDeps } from './backup.ts';
import {
  controlAddressOf,
  isLiveState,
  probeInstance,
  requestControl,
  type ControlAttempt,
  type ProbeOptions,
  type ProbeResult,
} from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export interface ReplayInput {
  readonly task: string;
  /** `--from SEGMENT`: the first segment to read again (`hooks-<YYYYMMDD>T<HH>Z.ndjson`); absent: every retained segment. */
  readonly from?: string;
  /** `--yes`: without it nothing is changed. */
  readonly yes?: boolean;
}

/** What a test replaces: the probe and the control client. */
export interface ReplayDeps extends Pick<BackupOpDeps, 'migrations' | 'mutexTimeoutMs'> {
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  readonly control?: (address: string, message: ControlRequest, o: { timeoutMs: number }) => Promise<ControlAttempt>;
}

export interface ReplaySegment {
  readonly segment: string;
  readonly bytes: number;
  /** Where the cursor stands now (0 for a segment without a cursor). */
  readonly offset: number;
  readonly sealed: boolean;
}

export interface ReplayResult {
  readonly task: string;
  /** `--from`, or `null` for every segment. */
  readonly from: string | null;
  readonly applied: boolean;
  /** `dry-run`; `stopped` (the cursors were reset directly); `running` (the server did it); `no-database` (nothing to reset yet). */
  readonly mode: 'dry-run' | 'stopped' | 'running' | 'no-database';
  /** The segments that the replay selects (for a dry run, the plan). */
  readonly segments: readonly ReplaySegment[];
  readonly totalBytes: number;
  /** How many cursors were reset; 0 for a dry run. */
  readonly segmentsReset: number;
}

function notFound(error: SpoolSegmentNotFoundError): McsError {
  return new McsError('NOT_FOUND', `no spool segment named '${error.segment}' in data/spool`, {
    hint: 'list the segment names in the data/spool folder of the task; a name looks like hooks-<YYYYMMDD>T<HH>Z.ndjson',
    cause: error,
  });
}

/** `--from` must be a segment name: a usage error otherwise (a path or a wildcard never reaches the file system). */
function checkFrom(from: string | undefined): string | null {
  if (from === undefined) return null;
  if (!SPOOL_SEGMENT_RE.test(from)) {
    throw new McsError(
      'USAGE',
      `--from expects a spool segment name like hooks-20261011T08Z.ndjson, got ${JSON.stringify(from.slice(0, 80))}`,
    );
  }
  return from;
}

function toResult(
  input: ReplayInput,
  from: string | null,
  plan: SpoolReplayPlan,
  mode: ReplayResult['mode'],
  segmentsReset: number,
): ReplayResult {
  return {
    task: input.task,
    from,
    applied: mode !== 'dry-run',
    mode,
    segments: plan.segments,
    totalBytes: plan.totalBytes,
    segmentsReset,
  };
}

/** The plan from the files alone, for a task whose database does not exist yet (every cursor is "not read"). */
async function planWithoutDatabase(spoolDir: string, from: string | null): Promise<SpoolReplayPlan> {
  const listing = await listSegments(spoolDir);
  if (from !== null && !listing.segments.some((file) => file.name === from)) throw new SpoolSegmentNotFoundError(from);
  const segments = listing.segments
    .filter((file) => from === null || file.name >= from)
    .map((file) => ({ segment: file.name, bytes: file.bytes, offset: 0, sealed: false }));
  return { segments, totalBytes: segments.reduce((sum, file) => sum + file.bytes, 0) };
}

async function planOf(db: InstanceDb | null, spoolDir: string, from: string | null): Promise<SpoolReplayPlan> {
  try {
    if (db === null) return await planWithoutDatabase(spoolDir, from);
    return await planSpoolReplay(
      { instanceId: db.instanceId },
      { spoolCursors: new SpoolCursorsRepo(db) },
      spoolDir,
      from,
    );
  } catch (error) {
    if (error instanceof SpoolSegmentNotFoundError) throw notFound(error);
    throw error;
  }
}

async function hasDatabase(ws: WorkspaceRef): Promise<boolean> {
  try {
    return (await lstat(workspacePath(ws, 'data', 'monitor.db'))).isFile();
  } catch {
    return false;
  }
}

function openDatabase(
  ctx: OpContext,
  ws: WorkspaceRef,
  instanceId: string,
  mode: 'readonly' | 'maintenance',
  deps: ReplayDeps,
): InstanceDb {
  try {
    return openInstanceDb({
      path: workspacePath(ws, 'data', 'monitor.db'),
      expectedInstanceId: instanceId,
      mode,
      runtimeVersion: RUNTIME_VERSION,
      clock: ctx.clock,
      ...migrationsOf(ctx, deps),
    });
  } catch (error) {
    throw dbFailure(error);
  }
}

/** The plan of a dry run: the files, with the cursors of the database when there is one (read-only, also while it runs). */
async function dryRunPlan(
  ctx: OpContext,
  ws: WorkspaceRef,
  instanceId: string,
  from: string | null,
  deps: ReplayDeps,
): Promise<SpoolReplayPlan> {
  const spoolDir = workspacePath(ws, 'data', 'spool');
  if (!(await hasDatabase(ws))) return planOf(null, spoolDir, from);
  const db = openDatabase(ctx, ws, instanceId, 'readonly', deps);
  try {
    return await planOf(db, spoolDir, from);
  } finally {
    db.close();
  }
}

/** The control operation of a running instance: the server resets the cursors from its writer queue and replies the count. */
async function replayThroughServer(
  ws: WorkspaceRef,
  instanceId: string,
  from: string | null,
  deps: ReplayDeps,
): Promise<number> {
  const token = await controlTokenOf(ws);
  if (token === null) {
    throw new McsError('DB_ERROR', 'the running server cannot be asked to replay: it left no control token', {
      hint: `mcs doctor --task ${ws.slug}`,
    });
  }
  const attempt = await (deps.control ?? requestControl)(
    controlAddressOf(instanceId),
    { v: 1, op: 'ingest-replay', instanceId, token, fromSegment: from },
    { timeoutMs: controlTimeoutMs('ingest-replay') },
  );
  if (attempt.kind === 'reply' && attempt.response.op === 'ingest-replay') return attempt.response.segments;
  const why =
    attempt.kind === 'refusal'
      ? `it refused (${attempt.error})`
      : attempt.kind === 'silent'
        ? `it did not answer (${attempt.reason})`
        : 'its control channel is gone';
  throw new McsError('DB_ERROR', `the running server did not replay the spool: ${why}`, {
    hint: `mcs doctor --task ${ws.slug}`,
  });
}

/**
 * `ops.ingest.replay` (01 6.4 `ingest replay`): the plan without `yes`; with `yes` the cursors of the selected segments are
 * reset (by the server while it runs, by this process while it is stopped) and `ingest-replay` is audited with the template of
 * 01 7.2. An instance between ready and stopped is `INSTANCE_RUNNING`. A task without a database has nothing to reset: the first
 * start reads every segment, and nothing is audited.
 */
export async function replay(ctx: OpContext, input: ReplayInput, deps: ReplayDeps = {}): Promise<ReplayResult> {
  const from = checkFrom(input.from);
  const ws = await openWorkspace(ctx, input.task);
  const instance = await requireInstance(ws);
  if (input.yes !== true) {
    return toResult(input, from, await dryRunPlan(ctx, ws, instance.instanceId, from, deps), 'dry-run', 0);
  }
  return withTaskMutex(
    ws,
    async () => {
      const spoolDir = workspacePath(ws, 'data', 'spool');
      const probe = await (deps.probe ?? probeInstance)(ws, { runtimeDir: ctx.runtimeDir });
      let result: ReplayResult;
      if (probe.state === 'running') {
        const plan = await dryRunPlan(ctx, ws, instance.instanceId, from, deps);
        result = toResult(input, from, plan, 'running', await replayThroughServer(ws, instance.instanceId, from, deps));
      } else if (isLiveState(probe.state)) {
        throw liveError(ws, probe);
      } else if (!(await hasDatabase(ws))) {
        result = toResult(input, from, await planOf(null, spoolDir, from), 'no-database', 0);
      } else {
        const db = openDatabase(ctx, ws, instance.instanceId, 'maintenance', deps);
        try {
          const plan = await planOf(db, spoolDir, from);
          const { segmentsReset } = applySpoolReplay(db, { instanceId: db.instanceId }, plan);
          result = toResult(input, from, plan, 'stopped', segmentsReset);
        } finally {
          db.close();
        }
      }
      if (result.mode !== 'no-database') {
        await appendChange(
          ws,
          {
            action: 'ingest-replay',
            summary: `spool replay of ${String(result.segmentsReset)} segments from ${from ?? 'all'}`,
            reason: null,
            files: [],
            validation: 'cursors re-read',
            outcome: 'scheduled',
          },
          ctx.clock.now(),
        );
      }
      return result;
    },
    deps.mutexTimeoutMs === undefined ? {} : { timeoutMs: deps.mutexTimeoutMs },
  );
}

/** The text of `ingest replay`. */
export function replayLines(result: ReplayResult): string[] {
  const lines: string[] = [];
  if (result.mode === 'dry-run') {
    if (result.segments.length === 0) return [`task '${result.task}': no spool segments to read again`];
    lines.push(`task '${result.task}': would read ${String(result.segments.length)} spool segments again`);
    for (const segment of result.segments) {
      lines.push(`  ${segment.segment}  ${String(segment.bytes)} bytes  (read up to ${String(segment.offset)})`);
    }
    lines.push(`total ${String(result.totalBytes)} bytes`);
    return lines;
  }
  if (result.mode === 'no-database') {
    return [
      `task '${result.task}' has no database yet: nothing to reset; the first start reads ${String(result.segments.length)} spool segments`,
    ];
  }
  lines.push(`replay scheduled for ${String(result.segmentsReset)} segments (duplicates are ignored by event_uid)`);
  lines.push(
    result.mode === 'running'
      ? 'the running monitor reads them again now'
      : 'the segments are read again at the next start',
  );
  return lines;
}
