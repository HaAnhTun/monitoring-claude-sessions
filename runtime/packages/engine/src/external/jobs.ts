// The daemon job reader (02 7.10): `<claudeHome>/jobs/<id>/state.json`. The jobs folder holds thousands of temporary files of
// the jobs' own work, so it is listed one level deep and only `<id>/state.json` is ever read (never a tree walk, TS:6.3). An
// entry matches a session through `sessionId` or `resumeSessionId` when this instance knows that session. An event is produced
// when the state of a job changes (the first sighting counts as a change).
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';
import { z } from 'zod';

import type { LogicalEvent } from '../ingest/event-row.ts';
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
  /** `<session>|<job>` -> the last announced state. */
  const last = new Map<string, string>();

  return {
    async poll() {
      const now = options.now();
      const names = (await fs.readdir(root)).filter((name) => JOB_ID_RE.test(name)).slice(0, MAX_JOBS);
      const events: JobEvent[] = [];
      const seen = new Map<string, string>();
      let readFailures = 0;
      for (const jobId of names.sort()) {
        const bytes = await fs.readSmall(path.join(root, jobId, 'state.json'), JOB_FILE_MAX_BYTES);
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
        const key = `${sessionId}|${jobId}`;
        seen.set(key, parsed.state);
        if (last.get(key) !== parsed.state) {
          events.push({ k: 'external.job', sessionId, jobId, state: parsed.state, observedAt: now });
        }
      }
      return {
        events,
        readFailures,
        commit: () => {
          last.clear();
          for (const [key, state] of seen) last.set(key, state);
        },
      };
    },
  };
}
