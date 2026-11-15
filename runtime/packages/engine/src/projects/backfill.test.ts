// The one idempotent pass that gives a database written before the project dimension its projects (CAW design 03 2.5): a
// session without a project and with a main transcript file gets the project of the folder that file lies in, 500 sessions per
// transaction, each announced as a changed session.
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { onCommitted, withWriteTx } from '../db/write.ts';
import { backfillProjects } from './backfill.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = { instanceId: INSTANCE_ID };
const T0 = FIXTURE_EPOCH_MS;
const PROJECTS = '/home/me/.claude/projects';
const uid = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('backfill').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

/** A session row; `cwd` and `lastActivityAt` as given. Returns its row id. */
function addSession(db: InstanceDb, n: number, cwd: string | null = null, lastActivityAt = T0 + n): number {
  const repo = new SessionsRepo(db);
  const { id } = withWriteTx(db, SCOPE, (tx) =>
    repo.ensure(SCOPE, tx, { sessionUid: uid(n), projectId: null, startedAt: T0 }),
  );
  withWriteTx(db, SCOPE, (tx) => repo.update(SCOPE, tx, id, { cwd, lastActivityAt }, null));
  return id;
}

/** A transcript file of kind `session` of session `n` in the folder `dirName`; returns its id. */
function addFile(db: InstanceDb, n: number, dirName: string, kind = 'session', suffix = ''): number {
  const file = `${PROJECTS}/${dirName}/${uid(n)}${suffix}.jsonl`;
  return db.driver
    .prepare(
      `INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run([file, file.toLowerCase(), kind, uid(n), T0, T0]).lastInsertRowid;
}

interface Assigned {
  uid: string;
  key: string | null;
  dirName: string | null;
  root: string | null;
}

function assignments(db: InstanceDb): Assigned[] {
  return db.driver
    .prepare<Assigned>(
      `SELECT s.session_uid AS uid, p.project_key AS key, p.dir_name AS dirName, p.root_path AS root
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.id`,
    )
    .all();
}

const count = (db: InstanceDb, sql: string): number => db.driver.prepare<{ n: number }>(sql).get()?.n ?? -1;
const sessionChanges = (db: InstanceDb): number =>
  count(db, "SELECT count(*) AS n FROM changes WHERE kind = 'session'");

describe('backfillProjects', () => {
  it('gives each session the project of the folder of its main transcript file, with the working directory as the root', async () => {
    const db = database();
    addSession(db, 1, '/work/app');
    addFile(db, 1, 'D--Work-App');
    addSession(db, 2, null);
    addFile(db, 2, 'D--Work-Other');
    const result = await backfillProjects(db, SCOPE);
    expect(result).toEqual({ scanned: 2, assigned: 2 });
    expect(assignments(db)).toEqual([
      { uid: uid(1), key: 'd--work-app', dirName: 'D--Work-App', root: '/work/app' },
      { uid: uid(2), key: 'd--work-other', dirName: 'D--Work-Other', root: null },
    ]);
  });

  it('announces every assigned session as a changed session, and stamps its updated_seq', async () => {
    const db = database();
    addSession(db, 1, '/work/app');
    addFile(db, 1, 'app');
    const before = count(db, 'SELECT coalesce(max(seq), 0) AS n FROM changes');
    await backfillProjects(db, SCOPE);
    const announced = db.driver
      .prepare<{ seq: number; kind: string; op: string; session_uid: string }>(
        'SELECT seq, kind, op, session_uid FROM changes WHERE seq > ? ORDER BY seq',
      )
      .all([before]);
    expect(announced.map((row) => [row.kind, row.op, row.session_uid])).toEqual([['session', 'upsert', uid(1)]]);
    const stamped = db.driver
      .prepare<{ updated_seq: number }>('SELECT updated_seq FROM sessions WHERE session_uid = ?')
      .get([uid(1)]);
    expect(stamped?.updated_seq).toBe(announced[0]?.seq);
  });

  it('leaves sessions alone that have a project, no main file, or a folder name that is no project name', async () => {
    const db = database();
    // 1: has a project already, its file lies elsewhere
    addSession(db, 1, '/work/one');
    addFile(db, 1, 'folder-a');
    await backfillProjects(db, SCOPE);
    addFile(db, 1, 'folder-b', 'session', '-copy');
    // 2: no file at all (only hooks saw it)
    addSession(db, 2, '/work/two');
    // 3: only a subagent file, not a main one
    addSession(db, 3, '/work/three');
    addFile(db, 3, 'folder-c', 'subagent');
    // 4: a folder name that cannot be a project folder
    addSession(db, 4, '/work/four');
    addFile(db, 4, 'odd folder');
    // 5: a good one after the unusable ones
    addSession(db, 5, '/work/five');
    addFile(db, 5, 'folder-e');
    const result = await backfillProjects(db, SCOPE);
    expect(result.assigned).toBe(1);
    expect(assignments(db).map((row) => [row.uid, row.key])).toEqual([
      [uid(1), 'folder-a'],
      [uid(2), null],
      [uid(3), null],
      [uid(4), null],
      [uid(5), 'folder-e'],
    ]);
  });

  it('is idempotent: a second pass changes and announces nothing', async () => {
    const db = database();
    for (const n of [1, 2, 3]) {
      addSession(db, n, `/work/${String(n)}`);
      addFile(db, n, n === 3 ? 'odd folder' : 'shared');
    }
    expect(await backfillProjects(db, SCOPE)).toEqual({ scanned: 3, assigned: 2 });
    const projects = count(db, 'SELECT count(*) AS n FROM projects');
    const changes = sessionChanges(db);
    const rows = assignments(db);
    // the session that cannot be assigned is looked at again, and found unassignable again
    expect(await backfillProjects(db, SCOPE)).toEqual({ scanned: 1, assigned: 0 });
    expect(count(db, 'SELECT count(*) AS n FROM projects')).toBe(projects);
    expect(sessionChanges(db)).toBe(changes);
    expect(assignments(db)).toEqual(rows);
  });

  it('shares one project between the sessions of a folder, keeps the first root and fills a missing one', async () => {
    const db = database();
    addSession(db, 1, null);
    addFile(db, 1, 'Shared-Folder');
    addSession(db, 2, '/work/second');
    addFile(db, 2, 'shared-folder');
    addSession(db, 3, '/work/third');
    addFile(db, 3, 'SHARED-FOLDER');
    await backfillProjects(db, SCOPE);
    expect(count(db, 'SELECT count(*) AS n FROM projects')).toBe(1);
    expect(assignments(db)).toEqual([
      { uid: uid(1), key: 'shared-folder', dirName: 'Shared-Folder', root: '/work/second' },
      { uid: uid(2), key: 'shared-folder', dirName: 'Shared-Folder', root: '/work/second' },
      { uid: uid(3), key: 'shared-folder', dirName: 'Shared-Folder', root: '/work/second' },
    ]);
  });

  it('takes the folder of the file the session points at when it has two main files', async () => {
    const db = database();
    const id = addSession(db, 1, '/work/app');
    addFile(db, 1, 'older-folder');
    const second = addFile(db, 1, 'newer-folder', 'session', '-b');
    withWriteTx(db, SCOPE, (tx) => new SessionsRepo(db).update(SCOPE, tx, id, { transcriptFileId: second }, null));
    await backfillProjects(db, SCOPE);
    expect(assignments(db)[0]?.key).toBe('newer-folder');
    const other = database();
    addSession(other, 1, '/work/app');
    addFile(other, 1, 'older-folder');
    addFile(other, 1, 'newer-folder', 'session', '-b');
    await backfillProjects(other, SCOPE);
    // without a main file named by the session, the first file registered wins
    expect(assignments(other)[0]?.key).toBe('older-folder');
  });

  it('takes 500 sessions per transaction', async () => {
    const db = database();
    db.driver.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
      INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at)
      SELECT printf('aaaaaaaa-0000-4000-8000-%012x', i), ${String(T0)}, ${String(T0)}, ${String(T0)}, ${String(T0)} FROM n;
      INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at)
      SELECT '${PROJECTS}/bulk/' || session_uid || '.jsonl',
             'k' || session_uid, 'session', session_uid, ${String(T0)}, ${String(T0)} FROM sessions;`);
    let commits = 0;
    const unsubscribe = onCommitted(db, () => {
      commits += 1;
    });
    const result = await backfillProjects(db, SCOPE);
    unsubscribe();
    expect(result).toEqual({ scanned: 1200, assigned: 1200 });
    expect(commits).toBe(3);
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE project_id IS NULL')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM projects')).toBe(1);
  });

  it('takes a smaller batch when asked, and refuses one that is not a positive whole number', async () => {
    const db = database();
    for (const n of [1, 2, 3, 4, 5]) {
      addSession(db, n);
      addFile(db, n, 'small-batches');
    }
    let commits = 0;
    const unsubscribe = onCommitted(db, () => {
      commits += 1;
    });
    expect(await backfillProjects(db, SCOPE, { batchSize: 2 })).toEqual({ scanned: 5, assigned: 5 });
    unsubscribe();
    expect(commits).toBe(3);
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      await expect(backfillProjects(db, SCOPE, { batchSize })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('does nothing for an empty database and refuses a foreign scope', async () => {
    const db = database();
    expect(await backfillProjects(db, SCOPE)).toEqual({ scanned: 0, assigned: 0 });
    await expect(backfillProjects(db, { instanceId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow();
  });
});
