// The daemon job reader (02 7.10): `<claudeHome>/jobs/<id>/state.json`. The jobs folder holds thousands of temporary files of
// the jobs' own work, so it is listed one level deep and only `<id>/state.json` is ever read (never a tree walk, TS:6.3). An
// entry matches a session through `sessionId` or `resumeSessionId` when this instance knows that session. An event is produced
// when the state or the time of a job changes (the first sighting counts as a change). The event carries the time the job
// file recorded for its state, never the time of the read (ADR 0069): an old finished job reads "done 6d ago".
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';
import { z } from 'zod';

import type { LogicalEvent } from '../ingest/event-row.ts';
import { JOB_FAILED_STATES } from '../lifecycle/derive-session.ts';
import { nodeExternalFs, type ExternalFs, type ExternalPoll } from './fs.ts';

export type JobEvent = Extract<LogicalEvent, { k: 'external.job' }>;

export const JOB_FILE_MAX_BYTES = 64 * 1024;
const MAX_JOBS = 2000;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STATE_MAX_CHARS = 32;

const JobFileSchema = z.looseObject({
  state: z.string().min(1).max(STATE_MAX_CHARS),
  sessionId: z.string().regex(SID_RE).optional(),
  resumeSessionId: z.string().regex(SID_RE).optional(),
});

/** The states after which a job does not run any more: `done` (S-4a) and the failure states (S-4b). */
export const JOB_TERMINAL_STATES: ReadonlySet<string> = new Set(['done', ...JOB_FAILED_STATES]);

const TERMINAL_TIME_FIELDS = ['lastTerminalAt', 'firstTerminalAt', 'updatedAt', 'createdAt'] as const;
const OTHER_TIME_FIELDS = ['updatedAt', 'createdAt'] as const;
/** ISO-8601 date and time with an explicit zone (`Z` or an offset); a zone-less text would be read as local time. */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A time field as epoch milliseconds: ISO-8601 text or a positive finite number; anything else is null. */
function timeOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (typeof value !== 'string' || value.length > 40 || !ISO_TIME_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The time of the observed state of a job file (ADR 0069 item 2): for a terminal state `lastTerminalAt`, `firstTerminalAt`,
 * `updatedAt`, `createdAt`; for any other state `updatedAt`, `createdAt`; then the modification time of the file. A time after
 * `nowMs` is clamped to `nowMs` (clock skew). Null: nothing usable, the file is counted as unreadable.
 */
export function jobEventTime(
  file: Readonly<Record<string, unknown>>,
  state: string,
  nowMs: number,
  mtimeMs: number | null,
): number | null {
  const fields = JOB_TERMINAL_STATES.has(state) ? TERMINAL_TIME_FIELDS : OTHER_TIME_FIELDS;
  for (const field of fields) {
    const at = Object.hasOwn(file, field) ? timeOf(file[field]) : null;
    if (at !== null) return Math.min(at, nowMs);
  }
  const mtime = timeOf(mtimeMs);
  return mtime === null ? null : Math.min(mtime, nowMs);
}

export interface JobsReaderOptions {
  readonly claudeHome: string;
  readonly now: () => number;
  readonly isKnownSession: (sessionUid: string) => boolean;
  readonly fs?: ExternalFs;
}

export interface JobsReader {
  poll(): Promise<ExternalPoll<JobEvent>>;
}

export function createJobsReader(options: JobsReaderOptions): JobsReader {
  const fs = options.fs ?? nodeExternalFs;
  const root = path.join(options.claudeHome, 'jobs');
  /** `<session>|<job>` -> the last announced `<state>|<time>`. */
  const last = new Map<string, string>();

  return {
    async poll() {
      const now = options.now();
      const names = (await fs.readdir(root)).filter((name) => JOB_ID_RE.test(name)).slice(0, MAX_JOBS);
      const events: JobEvent[] = [];
      const seen = new Map<string, string>();
      let readFailures = 0;
      for (const jobId of names.sort()) {
        const file = path.join(root, jobId, 'state.json');
        const bytes = await fs.readSmall(file, JOB_FILE_MAX_BYTES);
        if (bytes === null) continue; // a job folder without a state file is normal (not yet written, already cleaned)
        let parsed: z.infer<typeof JobFileSchema>;
        try {
          const result = JobFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
          if (!result.success) {
            readFailures += 1;
            continue;
          }
          parsed = result.data;
        } catch {
          readFailures += 1;
          continue;
        }
        const sessionId = [parsed.sessionId, parsed.resumeSessionId].find(
          (candidate): candidate is string => candidate !== undefined && options.isKnownSession(candidate),
        );
        if (sessionId === undefined) continue;
        let at = jobEventTime(parsed, parsed.state, now, null);
        at ??= jobEventTime(parsed, parsed.state, now, (await fs.mtimeMs?.(file)) ?? null);
        if (at === null) {
          readFailures += 1; // never "just now": a job without a time is no evidence (ADR 0069)
          continue;
        }
        const key = `${sessionId}|${jobId}`;
        const change = `${parsed.state}|${String(at)}`;
        seen.set(key, change);
        if (last.get(key) !== change) {
          events.push({ k: 'external.job', sessionId, jobId, state: parsed.state, observedAt: at });
        }
      }
      return {
        events,
        readFailures,
        commit: () => {
          last.clear();
          for (const [key, change] of seen) last.set(key, change);
        },
      };
    },
  };
}
