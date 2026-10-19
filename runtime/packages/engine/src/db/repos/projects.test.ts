import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { ProjectsRepo } from './projects.ts';
import { expectEveryMethodScoped } from '../../../test/support/repo-scope.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('projects-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

describe('ProjectsRepo (03 3.5 projects)', () => {
  it('ensures one row per project key and keeps the first-seen time', () => {
    const db = database();
    const repo = new ProjectsRepo(db);
    const first = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { projectKey: 'c--work-app', dirName: 'C--work-app', rootPath: null, at: T0 + 10 }),
    );
    const again = withWriteTx(db, CTX, (tx) =>
      repo.ensure(CTX, tx, { projectKey: 'c--work-app', dirName: 'C--work-app', rootPath: 'C:/work/app', at: T0 + 50 }),
    );
    expect(again).toBe(first);
    expect(repo.byKey(CTX, 'c--work-app')).toEqual({
      id: first,
      projectKey: 'c--work-app',
      dirName: 'C--work-app',
      rootPath: 'C:/work/app',
      firstSeenAt: T0 + 10,
      lastActivityAt: T0 + 50,
    });
  });

  it('never moves last activity back and keeps a known root path', () => {
    const db = database();
    const repo = new ProjectsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.ensure(CTX, tx, { projectKey: 'p', dirName: 'P', rootPath: 'C:/p', at: T0 + 100 });
      repo.ensure(CTX, tx, { projectKey: 'p', dirName: 'P', rootPath: null, at: T0 + 20 });
    });
    const row = repo.byKey(CTX, 'p');
    expect(row?.lastActivityAt).toBe(T0 + 100);
    expect(row?.rootPath).toBe('C:/p');
  });

  it('lists the most recently active project first', () => {
    const db = database();
    const repo = new ProjectsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.ensure(CTX, tx, { projectKey: 'old', dirName: 'old', rootPath: null, at: T0 + 1 });
      repo.ensure(CTX, tx, { projectKey: 'new', dirName: 'new', rootPath: null, at: T0 + 9 });
    });
    expect(repo.list(CTX).map((p) => p.projectKey)).toEqual(['new', 'old']);
    expect(repo.byKey(CTX, 'missing')).toBeUndefined();
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new ProjectsRepo(db);
    const project = { projectKey: 'c--work-app', dirName: 'C--work-app', rootPath: null, at: T0 };
    withWriteTx(db, CTX, (tx) => repo.ensure(CTX, tx, project));
    expectEveryMethodScoped(repo, {
      ensure: () => withWriteTx(db, CTX, (tx) => repo.ensure(FOREIGN, tx, { ...project, projectKey: 'other' })),
      byKey: () => repo.byKey(FOREIGN, project.projectKey),
      list: () => repo.list(FOREIGN),
    });
    expect(repo.list(CTX)).toHaveLength(1);
  });
});
