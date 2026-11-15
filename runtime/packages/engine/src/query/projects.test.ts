// `projectStats` and `resumeFacts` (CAW design 03 2.8): what the folder list and the resume decision read from the database,
// each in one indexed read. Rows are written with plain SQL: the query reads whatever the ingestion wrote.
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import type { SqlValue } from '../db/driver.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { createProjectQueries, type ProjectQueries } from './projects.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const HOUR = 3_600_000;
const uid = (n: number): string => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function fixture(): { db: InstanceDb; queries: ProjectQueries } {
  const db = openInstanceDb({
    path: join(tempDir('query-projects').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return { db, queries: createProjectQueries(db) };
}

function put(db: InstanceDb, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

function addProject(
  db: InstanceDb,
  key: string,
  over: { dirName?: string; root?: string | null; at?: number } = {},
): number {
  return put(db, 'projects', {
    project_key: key,
    dir_name: over.dirName ?? key,
    root_path: over.root === undefined ? null : over.root,
    first_seen_at: T0,
    last_activity_at: over.at ?? T0,
  });
}

function addSession(
  db: InstanceDb,
  n: number,
  over: {
    project?: number | null;
    state?: string;
    at?: number;
    cwd?: string | null;
    entrypoint?: string | null;
    continuedIn?: string | null;
  } = {},
): number {
  return put(db, 'sessions', {
    session_uid: uid(n),
    project_id: over.project === undefined ? null : over.project,
    first_seen_at: T0,
    started_at: Math.min(T0, over.at ?? T0),
    last_activity_at: over.at ?? T0,
    state: over.state ?? 'completed',
    cwd: over.cwd === undefined ? null : over.cwd,
    entrypoint: over.entrypoint === undefined ? null : over.entrypoint,
    continued_in: over.continuedIn === undefined ? null : over.continuedIn,
    updated_at: T0,
  });
}

function addFile(db: InstanceDb, n: number, over: { path?: string; kind?: string; state?: string } = {}): number {
  const file = over.path ?? `/projects/p/${uid(n)}.jsonl`;
  return put(db, 'transcript_files', {
    path: file,
    path_key: file.toLowerCase(),
    kind: over.kind ?? 'session',
    session_uid: uid(n),
    state: over.state ?? 'active',
    discovered_at: T0,
    updated_at: T0,
  });
}

describe('projectStats', () => {
  it('counts the sessions of each project: in the window, active now, and all, with the newest activity', () => {
    const { db, queries } = fixture();
    const app = addProject(db, 'd--work-app', { dirName: 'D--Work-App', root: '/work/app', at: T0 });
    const other = addProject(db, 'other', { at: T0 + 5 * HOUR });
    addSession(db, 1, { project: app, state: 'working', at: T0 + 10 * HOUR });
    addSession(db, 2, { project: app, state: 'waiting_tool', at: T0 + 9 * HOUR });
    addSession(db, 3, { project: app, state: 'completed', at: T0 + 8 * HOUR });
    addSession(db, 4, { project: app, state: 'stale', at: T0 + 1 * HOUR });
    addSession(db, 5, { project: other, state: 'running', at: T0 + 6 * HOUR });
    addSession(db, 6, { project: null, state: 'working', at: T0 + 20 * HOUR });
    const stats = queries.projectStats(SCOPE, { windowFromMs: T0 + 8 * HOUR });
    expect(stats).toEqual([
      {
        key: 'd--work-app',
        dirName: 'D--Work-App',
        rootPath: '/work/app',
        sessionsInWindow: 3,
        activeSessions: 2,
        lastActivityAt: T0 + 10 * HOUR,
        totalSessions: 4,
      },
      {
        key: 'other',
        dirName: 'other',
        rootPath: null,
        sessionsInWindow: 0,
        activeSessions: 1,
        lastActivityAt: T0 + 6 * HOUR,
        totalSessions: 1,
      },
    ]);
  });

  it('counts every session in the window when there is no lower bound', () => {
    const { db, queries } = fixture();
    const p = addProject(db, 'p');
    addSession(db, 1, { project: p, at: T0 - 100 * HOUR });
    addSession(db, 2, { project: p, at: T0 });
    expect(queries.projectStats(SCOPE, { windowFromMs: null })[0]).toMatchObject({
      sessionsInWindow: 2,
      totalSessions: 2,
    });
    // the window starts at the activity time itself
    expect(queries.projectStats(SCOPE, { windowFromMs: T0 })[0]?.sessionsInWindow).toBe(1);
    expect(queries.projectStats(SCOPE, { windowFromMs: T0 + 1 })[0]?.sessionsInWindow).toBe(0);
  });

  it('lists a project without sessions with zero counts and the activity the project itself has', () => {
    const { db, queries } = fixture();
    addProject(db, 'empty', { at: T0 + 3 * HOUR });
    expect(queries.projectStats(SCOPE, { windowFromMs: null })).toEqual([
      {
        key: 'empty',
        dirName: 'empty',
        rootPath: null,
        sessionsInWindow: 0,
        activeSessions: 0,
        lastActivityAt: T0 + 3 * HOUR,
        totalSessions: 0,
      },
    ]);
  });

  it('takes the later of the project time and its newest session, so a stale project row never hides activity', () => {
    const { db, queries } = fixture();
    const fresh = addProject(db, 'fresh', { at: T0 });
    const old = addProject(db, 'old', { at: T0 + 50 * HOUR });
    addSession(db, 1, { project: fresh, at: T0 + 4 * HOUR });
    addSession(db, 2, { project: old, at: T0 + 2 * HOUR });
    const stats = queries.projectStats(SCOPE, { windowFromMs: null });
    expect(stats.map((row) => [row.key, row.lastActivityAt])).toEqual([
      ['old', T0 + 50 * HOUR],
      ['fresh', T0 + 4 * HOUR],
    ]);
  });

  it('orders by the newest activity and then by key, and is empty for a database without projects', () => {
    const { db, queries } = fixture();
    expect(queries.projectStats(SCOPE, { windowFromMs: null })).toEqual([]);
    addProject(db, 'b', { at: T0 + HOUR });
    addProject(db, 'a', { at: T0 + HOUR });
    addProject(db, 'c', { at: T0 + 2 * HOUR });
    expect(queries.projectStats(SCOPE, { windowFromMs: null }).map((row) => row.key)).toEqual(['c', 'a', 'b']);
  });

  it('refuses a context of another instance', () => {
    const { queries } = fixture();
    expect(() => queries.projectStats(FOREIGN, { windowFromMs: null })).toThrow(
      expect.objectContaining({ code: 'scope_mismatch' }),
    );
  });
});

describe('resumeFacts', () => {
  it('names the project, the working directory, the entry point and the main file of a session', () => {
    const { db, queries } = fixture();
    const p = addProject(db, 'd--work-app', { dirName: 'D--Work-App', root: '/work/app' });
    addSession(db, 1, { project: p, cwd: '/work/app/sub', entrypoint: 'cli', continuedIn: uid(2) });
    addFile(db, 1, { path: '/projects/D--Work-App/one.jsonl', state: 'active' });
    expect(queries.resumeFacts(SCOPE, uid(1))).toEqual({
      sessionId: uid(1),
      projectKey: 'd--work-app',
      dirName: 'D--Work-App',
      rootPath: '/work/app',
      sessionCwd: '/work/app/sub',
      entrypoint: 'cli',
      continuedIn: uid(2),
      mainFile: { path: '/projects/D--Work-App/one.jsonl', state: 'active' },
    });
  });

  it('answers null for a session the database does not know', () => {
    const { queries } = fixture();
    expect(queries.resumeFacts(SCOPE, uid(9))).toBeNull();
  });

  it('has no project and no main file where the session has none', () => {
    const { db, queries } = fixture();
    addSession(db, 1);
    expect(queries.resumeFacts(SCOPE, uid(1))).toEqual({
      sessionId: uid(1),
      projectKey: null,
      dirName: null,
      rootPath: null,
      sessionCwd: null,
      entrypoint: null,
      continuedIn: null,
      mainFile: null,
    });
  });

  it('reports the state of the main file, also when it is gone, and never a subagent file as the main one', () => {
    const { db, queries } = fixture();
    addSession(db, 1);
    addFile(db, 1, { kind: 'subagent', path: '/projects/p/sub.jsonl' });
    expect(queries.resumeFacts(SCOPE, uid(1))?.mainFile).toBeNull();
    addFile(db, 1, { path: '/projects/p/main.jsonl', state: 'missing' });
    expect(queries.resumeFacts(SCOPE, uid(1))?.mainFile).toEqual({ path: '/projects/p/main.jsonl', state: 'missing' });
    addSession(db, 2);
    addFile(db, 2, { path: '/projects/p/retired.jsonl', state: 'retired' });
    expect(queries.resumeFacts(SCOPE, uid(2))?.mainFile?.state).toBe('retired');
  });

  it('takes the file the session names as its main file, else the first main file registered', () => {
    const { db, queries } = fixture();
    const id = addSession(db, 1);
    const first = addFile(db, 1, { path: '/projects/a/first.jsonl' });
    const second = addFile(db, 1, { path: '/projects/b/second.jsonl' });
    expect(queries.resumeFacts(SCOPE, uid(1))?.mainFile?.path).toBe('/projects/a/first.jsonl');
    db.driver.prepare('UPDATE sessions SET transcript_file_id = ? WHERE id = ?').run([second, id]);
    expect(queries.resumeFacts(SCOPE, uid(1))?.mainFile?.path).toBe('/projects/b/second.jsonl');
    // a session that names a file that is not a main file falls back to the first main file
    const sub = addFile(db, 1, { kind: 'subagent', path: '/projects/a/sub.jsonl' });
    db.driver.prepare('UPDATE sessions SET transcript_file_id = ? WHERE id = ?').run([sub, id]);
    expect(queries.resumeFacts(SCOPE, uid(1))?.mainFile?.path).toBe('/projects/a/first.jsonl');
    expect(first).toBeLessThan(second);
  });

  it('refuses a context of another instance', () => {
    const { queries } = fixture();
    expect(() => queries.resumeFacts(FOREIGN, uid(1))).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
  });
});
