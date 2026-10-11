// `projects` (03 3.5): one row per provider project folder. SQL only.
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export interface ProjectRow {
  id: number;
  projectKey: string;
  dirName: string;
  rootPath: string | null;
  firstSeenAt: number;
  lastActivityAt: number;
}

export interface NewProject {
  /** Lower-cased key (the column checks it). */
  projectKey: string;
  dirName: string;
  rootPath: string | null;
  at: number;
}

const COLUMNS = `id, project_key AS projectKey, dir_name AS dirName, root_path AS rootPath, first_seen_at AS firstSeenAt,
  last_activity_at AS lastActivityAt`;

export class ProjectsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** Inserts the project or advances it: the first seen time and a known root path stay, the last activity only grows. */
  ensure(ctx: RepoContext, _tx: WriteTx, p: NewProject): number {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<{ id: number }>(
        `INSERT INTO projects (project_key, dir_name, root_path, first_seen_at, last_activity_at)
         VALUES (:projectKey, :dirName, :rootPath, :at, :at)
         ON CONFLICT(project_key) DO UPDATE SET
           root_path = coalesce(projects.root_path, excluded.root_path),
           last_activity_at = max(projects.last_activity_at, excluded.last_activity_at)
         RETURNING id`,
      )
      .get({ projectKey: p.projectKey, dirName: p.dirName, rootPath: p.rootPath, at: p.at });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    return row.id;
  }

  byKey(ctx: RepoContext, projectKey: string): ProjectRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE project_key = :projectKey`)
      .get({ projectKey });
  }

  /** Most recently active first. */
  list(ctx: RepoContext): ProjectRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ProjectRow>(`SELECT ${COLUMNS} FROM projects ORDER BY last_activity_at DESC, id DESC`)
      .all();
  }
}
