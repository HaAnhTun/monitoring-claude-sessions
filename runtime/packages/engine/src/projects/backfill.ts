// The project backfill (CAW design 03 2.5): a database written before the project dimension was filled has sessions with no
// project. One idempotent pass at ingest start gives each of them the project of the folder its main transcript file lies in,
// by the same rule the writer uses (`projectOfSeen`), 500 sessions per transaction, each announced as a changed session so a
// client that holds the old row reads the new one. No migration: the columns exist.
import { setImmediate as yieldToLoop } from 'node:timers/promises';

import { createChangeSink } from '../db/change-sink.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { ProjectsRepo } from '../db/repos/projects.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import { projectOfSeen } from './folder-key.ts';

/** Sessions per transaction: one short write at a time keeps the writer and the readers of the instance responsive. */
export const BACKFILL_BATCH = 500;

export interface BackfillOptions {
  /** Sessions per transaction (default 500). */
  readonly batchSize?: number;
}

export interface BackfillResult {
  /** Sessions with a main file and no project that the pass looked at. */
  readonly scanned: number;
  /** Of those, the ones that got a project (the rest lie in a folder whose name is no project name). */
  readonly assigned: number;
}

/**
 * Assigns the projects that are missing. Safe to run at every start: a session that has a project is never looked at, and one
 * that cannot be assigned is passed over without a write. The loop yields to the event loop between transactions.
 */
export async function backfillProjects(
  db: InstanceDb,
  scope: RepoContext,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? BACKFILL_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('the backfill batch is a positive whole number of sessions');
  }
  const sessions = new SessionsRepo(db);
  const projects = new ProjectsRepo(db);
  let scanned = 0;
  let assigned = 0;
  let afterId = 0;
  for (;;) {
    const batch = withWriteTx(db, scope, (tx) => {
      const candidates = sessions.withoutProject(scope, afterId, batchSize);
      const sink = createChangeSink(tx);
      let done = 0;
      for (const candidate of candidates) {
        const seen = projectOfSeen(candidate.transcriptPath, candidate.cwd ?? undefined);
        if (seen === null) continue;
        const projectId = projects.ensure(scope, tx, {
          projectKey: seen.key,
          dirName: seen.dirName,
          rootPath: seen.root,
          at: candidate.lastActivityAt,
        });
        const seq = sink.record('session', `${String(candidate.id)}:${candidate.sessionUid}`, 'update');
        sessions.update(scope, tx, candidate.id, { projectId }, seq);
        done += 1;
      }
      return { size: candidates.length, assigned: done, last: candidates[candidates.length - 1]?.id ?? afterId };
    });
    scanned += batch.size;
    assigned += batch.assigned;
    afterId = batch.last;
    if (batch.size < batchSize) return { scanned, assigned };
    await yieldToLoop();
  }
}
