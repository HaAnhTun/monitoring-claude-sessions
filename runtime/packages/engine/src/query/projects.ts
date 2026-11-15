// `projectStats` and `resumeFacts` (CAW design 03 2.8). Two reads that the folder list and the resume decision share, each one
// indexed statement: the sessions of every project counted by `idx_sessions_project`, and the facts that a resume needs about
// one session (its project, its launch folder, the state of its main transcript file). Nothing here reads a transcript.
import { ACTIVE_STATES } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { TranscriptFileState } from '../db/repos/transcript-files.ts';
import { Binder, snapshot } from './transitions.ts';

/** What one project holds, as of the read. */
export interface ProjectStat {
  /** Lower-cased folder name: the `projectId` of the sessions. */
  readonly key: string;
  /** The folder name as Claude wrote it. */
  readonly dirName: string;
  /** The first working directory the project's sessions reported, or null. */
  readonly rootPath: string | null;
  /** Sessions whose last activity is inside the window. */
  readonly sessionsInWindow: number;
  /** Sessions in an active state now. */
  readonly activeSessions: number;
  /** The later of the project's own activity time and its newest session (epoch ms). */
  readonly lastActivityAt: number;
  readonly totalSessions: number;
}

/** What a resume needs to know about one session. */
export interface ResumeFacts {
  readonly sessionId: string;
  readonly projectKey: string | null;
  readonly dirName: string | null;
  readonly rootPath: string | null;
  /** The working directory the session reported last (a `cd` may have moved it from the launch folder). */
  readonly sessionCwd: string | null;
  readonly entrypoint: string | null;
  /** The session that carried this one on (`/clear`, a resume that made a new id), when the database knows it. */
  readonly continuedIn: string | null;
  /** The main transcript file, or null when the session has none. */
  readonly mainFile: { readonly path: string; readonly state: TranscriptFileState } | null;
}

export interface ProjectQueries {
  /**
   * Every project with its counts, newest activity first (ties by key). `windowFromMs` is the lower bound of "in the window"
   * (inclusive); null counts every session. A session without a project belongs to none of them.
   */
  projectStats(ctx: RepoContext, o: { readonly windowFromMs: number | null }): ProjectStat[];
  /** The facts of one session, or null when the database does not know it. */
  resumeFacts(ctx: RepoContext, sessionId: string): ResumeFacts | null;
}

interface StatRow {
  key: string;
  dirName: string;
  rootPath: string | null;
  sessionsInWindow: number;
  activeSessions: number;
  lastActivityAt: number;
  totalSessions: number;
}

interface FactsRow {
  sessionId: string;
  projectKey: string | null;
  dirName: string | null;
  rootPath: string | null;
  sessionCwd: string | null;
  entrypoint: string | null;
  continuedIn: string | null;
  filePath: string | null;
  fileState: TranscriptFileState | null;
}

export function createProjectQueries(db: InstanceDb): ProjectQueries {
  return {
    projectStats: (ctx, o) =>
      snapshot(db, ctx, () => {
        const bind = new Binder();
        // a NULL lower bound counts every session: `coalesce` turns it into the earliest time a column can hold
        const from = bind.bind(o.windowFromMs ?? Number.MIN_SAFE_INTEGER);
        const rows = db.driver
          .prepare<StatRow>(
            `SELECT p.project_key AS key, p.dir_name AS dirName, p.root_path AS rootPath,
                    coalesce(sum(s.last_activity_at >= ${from}), 0) AS sessionsInWindow,
                    coalesce(sum(s.state IN ${bind.list(ACTIVE_STATES)}), 0) AS activeSessions,
                    max(p.last_activity_at, coalesce(max(s.last_activity_at), 0)) AS lastActivityAt,
                    count(s.id) AS totalSessions
               FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
              GROUP BY p.id ORDER BY lastActivityAt DESC, p.project_key`,
          )
          .all(bind.params);
        return rows;
      }),

    resumeFacts: (ctx, sessionId) =>
      snapshot(db, ctx, () => {
        const row = db.driver
          .prepare<FactsRow>(
            `SELECT s.session_uid AS sessionId, p.project_key AS projectKey, p.dir_name AS dirName, p.root_path AS rootPath,
                    s.cwd AS sessionCwd, s.entrypoint AS entrypoint, s.continued_in AS continuedIn,
                    f.path AS filePath, f.state AS fileState
               FROM sessions s
               LEFT JOIN projects p ON p.id = s.project_id
               LEFT JOIN transcript_files f ON f.id = coalesce(
                      (SELECT x.id FROM transcript_files x WHERE x.id = s.transcript_file_id AND x.kind = 'session'),
                      (SELECT min(x.id) FROM transcript_files x WHERE x.session_uid = s.session_uid AND x.kind = 'session'))
              WHERE s.session_uid = :uid`,
          )
          .get({ uid: sessionId });
        if (row === undefined) return null;
        const { filePath, fileState, ...facts } = row;
        return {
          ...facts,
          mainFile: filePath === null || fileState === null ? null : { path: filePath, state: fileState },
        };
      }),
  };
}
