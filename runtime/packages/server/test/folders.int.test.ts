// The folder routes over real HTTP (CAW-29, design 03 7.2 and 8, ADR 0089): a real instance and app with every guard in front, the
// real access service and auth routes, the real folder service over a synthetic Claude home, a DA memory with canaries in
// `brain.md`, `action.md` and the sessions array, and a state file in the workspace. Response validation is on, as in every test
// app: each answer is parsed with `routes.<id>.response`. What is proved: the three routes refuse a request without the session
// cookie, the list merges the three sources, add and remove answer with `folder_invalid` (400, the reason only), `folder_limit`
// (409) and `folder_not_found` (404), a failure of the state file is an internal error without its path, and no DA canary
// reaches a response or the log. The last block covers the one change of `routes/panels.ts`: a user instance serves no
// per-repository panel.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

import {
  FolderError,
  buildInstanceContext,
  createAccessService,
  createDaMemoryReader,
  createFolderService,
  createLogger,
  createUserFolders,
  defaultSkillDir,
  initWorkspace,
  projectFolderName,
  type AccessService,
  type FolderService,
  type InstanceContext,
} from '@mcs/engine';
import {
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  PANEL_KEYS,
  RUNTIME_VERSION,
  routes,
  type ErrorCode,
  type Folder,
  type ResumeEligibility,
} from '@mcs/shared';
import {
  CANARY,
  FakeClock,
  allocatePort,
  assertPortClosed,
  buildClaudeHome,
  httpRequest,
  makeTempDir,
  scanFilesFor,
  writeDaMemory,
  writeRegistryEntry,
  type TempDir,
} from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';
import { createAccessVerifier } from '../src/http/access-guard.ts';
import { bindRouteServices, type RouteDeps } from '../src/route-adapter.ts';
import { createAuthRoutes } from '../src/routes/auth.ts';
import { createFolderRoutes } from '../src/routes/folders.ts';
import { readLegacyTask } from '../src/routes/meta.ts';
import { panelRoutes } from '../src/routes/panels.ts';
import { mintAndExchange, pageOrigin, writeHeaders } from './terminal/helpers/auth.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;
type FolderServiceForRoutes = Pick<FolderService, 'list' | 'add' | 'remove' | 'resumeEligibility'>;

// FIXTURE: invented data for tests
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const START = Date.UTC(2026, 10, 14, 12, 0, 0);
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ALL_CANARIES = Object.values(CANARY);

interface App {
  readonly port: number;
  readonly ctx: InstanceContext;
  readonly access: AccessService;
  readonly cookie: string;
  readonly logFile: string;
  /** The folder that both the DA memory and the Claude home name. */
  readonly sharedFolder: string;
  /** A folder that exists and that nobody has added yet. */
  readonly freshFolder: string;
  readonly stateFile: string;
  readonly root: string;
  /** The Claude home of the instance (the registry is its `sessions` folder). */
  readonly claudeHome: string;
  /** A folder the DA memory names and that does not exist. */
  readonly daOnlyFolder: string;
}

const running: { server: Server; ctx: InstanceContext; port: number; temp: TempDir; service: FolderService | null }[] =
  [];

afterEach(async () => {
  for (const { server, ctx, port, temp, service } of running.splice(0)) {
    await service?.stop();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await ctx.logger.close();
    await assertPortClosed(port);
    temp.remove();
  }
});

interface StartOptions {
  /** `userFoldersMax` of the state file (default 200). */
  readonly max?: number;
  /** A service of the test instead of the real one. */
  readonly folders?: FolderServiceForRoutes;
  /** The terminals of the app, for the real service: which session a terminal holds. Default: none. */
  readonly linker?: { sessionOwner(sessionId: string): string | null; ownedPids(): ReadonlySet<number> };
}

async function start(options: StartOptions = {}): Promise<App> {
  const temp = makeTempDir('folders-int');
  const root = temp.path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(START);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => INSTANCE_ID });

  // a folder that the Claude home and the DA memory both know, one only the DA memory knows, one a person may add
  const sharedFolder = path.join(root, 'work', 'shared-app');
  const freshFolder = path.join(root, 'work', 'fresh-app');
  const daOnlyFolder = path.join(root, 'work', 'da-only-app');
  for (const folder of [sharedFolder, freshFolder]) mkdirSync(folder, { recursive: true });
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, {
    nowMs: START,
    sessions: [
      {
        id: SESSION_ID,
        project: projectFolderName(sharedFolder).name,
        cwd: sharedFolder,
        mtimeAgeMs: 3 * 60 * 60 * 1000,
        build: (b) => {
          b.user('a prompt of the fixture');
        },
      },
    ],
  });
  const daDir = path.join(root, 'da-memory');
  writeDaMemory(daDir, {
    nowMs: START,
    canary: true,
    keyDecoys: true,
    folders: [
      {
        path: sharedFolder,
        summary: 'FIXTURE summary of the shared folder',
        brainText: `brain ${CANARY.prompt}`,
        actionText: `action ${CANARY.toolResult}`,
      },
      { path: daOnlyFolder, ageMs: 30 * 60 * 60 * 1000, brainText: CANARY.thinking, actionText: CANARY.attachment },
    ],
  });

  const logFile = path.join(root, 'runtime.log');
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: createLogger({ file: logFile, level: 'debug', rotate: false, clock }),
  });
  const stateFile = path.join(ws.dir, 'data', 'folders.json');
  const real =
    options.folders === undefined
      ? createFolderService(ctx, {
          daMemory: createDaMemoryReader({ dir: daDir, cacheMs: 0 }),
          userFolders: createUserFolders({
            file: stateFile,
            now: () => ctx.clock.now(),
            ...(options.max === undefined ? {} : { max: options.max }),
          }),
          homeDir: root,
          ...(options.linker === undefined ? {} : { linker: options.linker }),
        })
      : null;
  await real?.start();
  const folders = options.folders ?? real;
  if (folders === null) throw new Error('no folder service');

  const access = createAccessService({ clock });
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    access: createAccessVerifier(access, ctx.instanceId),
    extraModules: [createAuthRoutes({ access, instanceId: ctx.instanceId }), createFolderRoutes({ folders })],
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  running.push({ server, ctx, port, temp, service: real });
  const cookie = await mintAndExchange(port, access);
  return { port, ctx, access, cookie, logFile, sharedFolder, freshFolder, stateFile, root, claudeHome, daOnlyFolder };
}

function codeOf(reply: HttpReply): ErrorCode | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function detailsOf(reply: HttpReply): readonly { path: string; issue: string }[] | undefined {
  return ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.details;
}

function get(app: App, cookie: string | null = app.cookie): Promise<HttpReply> {
  return httpRequest(app.port, routes.listFolders.path, {
    ...(cookie === null ? {} : { headers: { Cookie: cookie } }),
  });
}

function post(app: App, route: string, body: unknown, cookie: string | null = app.cookie): Promise<HttpReply> {
  return httpRequest(app.port, route, {
    method: 'POST',
    headers: writeHeaders(cookie ?? undefined),
    origin: pageOrigin(app.port),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const addPath = (app: App, folder: string, cookie?: string | null): Promise<HttpReply> =>
  post(app, routes.addFolder.path, { path: folder }, cookie);
const removePath = (key: string): string => routes.removeFolder.path.replace(':key', key);

function rowsOf(reply: HttpReply): Folder[] {
  expect(reply.status).toBe(200);
  return routes.listFolders.response.parse(JSON.parse(reply.body)).folders;
}

describe('the list', () => {
  it('merges the DA memory, the Claude home and the added folders, and says what each source gave', async () => {
    const app = await start();
    const added = await addPath(app, app.freshFolder);
    expect(added.status).toBe(200);

    const reply = await get(app);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    const list = routes.listFolders.response.parse(JSON.parse(reply.body));
    expect(list.folders.map((row) => `${row.group}:${row.name}`)).toEqual([
      'outside-da:fresh-app',
      'da:shared-app',
      'da:da-only-app',
    ]);
    const shared = list.folders.find((row) => row.name === 'shared-app');
    expect(shared?.origins).toEqual(['da', 'claude']);
    expect(shared?.da?.summary).toBe('FIXTURE summary of the shared folder');
    expect(shared?.claude?.dirName).toBe(projectFolderName(app.sharedFolder).name);
    expect(shared?.canStart).toBe(true);
    expect(list.folders.find((row) => row.name === 'da-only-app')).toMatchObject({ exists: false, canStart: false });
    expect(list.folders.find((row) => row.name === 'fresh-app')).toMatchObject({ userAdded: true, pathSource: 'user' });
    expect(list.sources.daMemory).toMatchObject({ status: 'ok', folders: 2 });
    expect(list.sources.claudeHome).toMatchObject({ status: 'ok', folders: 1, truncated: false });
    expect(list.sources.userFolders).toEqual({ status: 'ok', count: 1 });
    expect(list.asOf).toBe(new Date(START).toISOString());
  });

  it('never lets the DA memory files that hold prompts into a response or the log', async () => {
    const app = await start();
    const bodies = [
      (await get(app)).body,
      (await addPath(app, app.freshFolder)).body,
      (await get(app)).body,
      (await post(app, routes.removeFolder.path.replace(':key', 'no-such-key'), {})).body,
      (await addPath(app, 'relative\\folder')).body,
    ];
    for (const body of bodies) {
      for (const canary of ALL_CANARIES) expect(body).not.toContain(canary);
    }
    await app.ctx.logger.close();
    expect(scanFilesFor([app.logFile], ALL_CANARIES)).toEqual([]);
  });
});

describe('access: the session cookie is required (TC-SEC-02)', () => {
  it('a request with no cookie, a garbage cookie or a cookie of another instance is 401 access_required, and nothing is written', async () => {
    const app = await start();
    const garbage = 'caw_11111111=not-a-credential';
    const other = app.cookie.replace(/^caw_[0-9a-f]+=/, 'caw_33333333=');
    for (const cookie of [null, garbage, other]) {
      const list = await get(app, cookie);
      expect(list.status).toBe(401);
      expect(codeOf(list)).toBe('access_required');
      const add = await addPath(app, app.freshFolder, cookie);
      expect(add.status).toBe(401);
      expect(codeOf(add)).toBe('access_required');
      const remove = await post(app, removePath('d--work-app'), {}, cookie);
      expect(remove.status).toBe(401);
      expect(codeOf(remove)).toBe('access_required');
    }
    expect(existsSync(app.stateFile)).toBe(false);
  });

  it('a write without the Origin of the page is refused before the service is asked', async () => {
    const app = await start();
    const reply = await httpRequest(app.port, routes.addFolder.path, {
      method: 'POST',
      headers: writeHeaders(app.cookie),
      body: JSON.stringify({ path: app.freshFolder }),
    });
    expect(reply.status).toBe(403);
    expect(existsSync(app.stateFile)).toBe(false);
  });
});

describe('add', () => {
  it('persists a folder, answers with its row and is idempotent', async () => {
    const app = await start();
    const first = await addPath(app, app.freshFolder);
    expect(first.status).toBe(200);
    const row = routes.addFolder.response.parse(JSON.parse(first.body));
    expect(row).toMatchObject({
      name: 'fresh-app',
      pathSource: 'user',
      userAdded: true,
      canStart: true,
      group: 'outside-da',
    });
    expect(existsSync(app.stateFile)).toBe(true);
    const again = routes.addFolder.response.parse(JSON.parse((await addPath(app, app.freshFolder)).body));
    expect(again).toEqual(row);
    expect(rowsOf(await get(app)).filter((entry) => entry.userAdded)).toHaveLength(1);
  });

  it('a folder the DA memory names comes back as the merged row', async () => {
    const app = await start();
    const row = routes.addFolder.response.parse(JSON.parse((await addPath(app, app.sharedFolder)).body));
    expect(row).toMatchObject({ group: 'da', origins: ['da', 'user', 'claude'], userAdded: true });
  });

  it('folder_invalid 400 names the reason and never the path', async () => {
    const app = await start();
    const cases: readonly (readonly [string, string])[] = [
      ['relative\\zq-token', 'relative'],
      ['\\\\host\\share\\zq-token', 'unc'],
      [path.join(app.root, 'no', 'such', 'zq-token'), 'not_directory'],
    ];
    for (const [folder, issue] of cases) {
      const reply = await addPath(app, folder);
      expect(reply.status, issue).toBe(ERROR_HTTP_STATUS.folder_invalid);
      expect(codeOf(reply), issue).toBe('folder_invalid');
      expect(detailsOf(reply), issue).toEqual([{ path: 'path', issue }]);
      expect(reply.body, issue).not.toContain('zq-token');
    }
    expect(existsSync(app.stateFile)).toBe(false);
  });

  it('a body the schema refuses is validation_failed, not folder_invalid', async () => {
    const app = await start();
    for (const body of ['{}', '{"path":""}', '{"path":"x","extra":1}', '[]', 'not json']) {
      const reply = await post(app, routes.addFolder.path, body);
      expect(reply.status, body).toBe(400);
      expect(codeOf(reply), body).not.toBe('folder_invalid');
    }
  });

  it('folder_limit 409 when the list of added folders is full', async () => {
    const app = await start({ max: 1 });
    expect((await addPath(app, app.freshFolder)).status).toBe(200);
    const reply = await addPath(app, app.sharedFolder);
    expect(reply.status).toBe(409);
    expect(codeOf(reply)).toBe('folder_limit');
    // the one that is listed already is still answered
    expect((await addPath(app, app.freshFolder)).status).toBe(200);
  });
});

describe('remove', () => {
  it('drops an added folder with 204 and no body; the row of a folder the Claude home still names stays', async () => {
    const app = await start();
    const fresh = routes.addFolder.response.parse(JSON.parse((await addPath(app, app.freshFolder)).body));
    const shared = routes.addFolder.response.parse(JSON.parse((await addPath(app, app.sharedFolder)).body));

    const gone = await post(app, removePath(fresh.key), {});
    expect(gone.status).toBe(204);
    expect(gone.body).toBe('');
    const kept = await post(app, removePath(shared.key), {});
    expect(kept.status).toBe(204);

    const rows = rowsOf(await get(app));
    expect(rows.some((row) => row.name === 'fresh-app')).toBe(false);
    expect(rows.find((row) => row.name === 'shared-app')).toMatchObject({
      userAdded: false,
      origins: ['da', 'claude'],
    });
  });

  it('folder_not_found 404 for a key nobody added, and for one that was removed already', async () => {
    const app = await start();
    const unknown = await post(app, removePath('no-such-key'), {});
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('folder_not_found');
    const row = routes.addFolder.response.parse(JSON.parse((await addPath(app, app.freshFolder)).body));
    expect((await post(app, removePath(row.key), {})).status).toBe(204);
    expect(codeOf(await post(app, removePath(row.key), {}))).toBe('folder_not_found');
  });

  it('a key that is no project key is a validation failure, and a body is not accepted', async () => {
    const app = await start();
    expect(codeOf(await post(app, removePath('UPPER'), {}))).toBe('validation_failed');
    expect(codeOf(await post(app, removePath('some-key'), { extra: 1 }))).toBe('validation_failed');
  });
});

function getResume(app: App, sessionId: string, cookie: string | null = app.cookie): Promise<HttpReply> {
  return httpRequest(app.port, routes.sessionResume.path.replace(':sessionId', sessionId), {
    ...(cookie === null ? {} : { headers: { Cookie: cookie } }),
  });
}

interface SeededSession {
  readonly uid: string;
  /** The folder the project lives in: gives the project key and the folder name below the Claude home. */
  readonly folder: string;
  readonly root?: string | null;
  readonly cwd?: string | null;
  /** The state of the main transcript file; `null`: the session has no file. Default `active`. */
  readonly fileState?: 'active' | 'missing' | 'retired' | null;
  readonly continuedIn?: string | null;
}

/** Writes what the ingestion would have written (a project, a session, its main file), with plain SQL: the route reads the facts. */
function seedSession(app: App, s: SeededSession): void {
  const put = (table: string, row: Record<string, string | number | null>): number => {
    const columns = Object.keys(row);
    return app.ctx.db.driver
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
      .run(row).lastInsertRowid;
  };
  const dirName = projectFolderName(s.folder).name;
  const key = dirName.toLowerCase();
  const existing = app.ctx.db.driver
    .prepare<{ id: number }>('SELECT id FROM projects WHERE project_key = :key')
    .get({ key });
  const project =
    existing?.id ??
    put('projects', {
      project_key: key,
      dir_name: dirName,
      root_path: s.root === undefined ? s.folder : s.root,
      first_seen_at: START,
      last_activity_at: START,
    });
  put('sessions', {
    session_uid: s.uid,
    project_id: project,
    first_seen_at: START,
    started_at: START,
    last_activity_at: START,
    state: 'completed',
    cwd: s.cwd === undefined ? s.folder : s.cwd,
    entrypoint: 'cli',
    continued_in: s.continuedIn ?? null,
    updated_at: START,
  });
  if (s.fileState === null) return;
  const file = path.join(app.claudeHome, 'projects', dirName, `${s.uid}.jsonl`);
  put('transcript_files', {
    path: file,
    path_key: file.toLowerCase(),
    kind: 'session',
    session_uid: s.uid,
    state: s.fileState ?? 'active',
    discovered_at: START,
    updated_at: START,
  });
}

describe('sessionResume: whether a session may be resumed in a terminal (CAW-30, ADR 0090)', () => {
  const RESUMABLE = '55555555-5555-4555-8555-555555555555';
  const MISSING_FOLDER = '66666666-6666-4666-8666-666666666666';
  const GONE = '77777777-7777-4777-8777-777777777777';
  const RETIRED = '88888888-8888-4888-8888-888888888888';
  const NEWER = '99999999-9999-4999-8999-999999999999';

  const eligibilityOf = (reply: HttpReply): ResumeEligibility => {
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    return routes.sessionResume.response.parse(JSON.parse(reply.body));
  };

  it('a session of a folder that exists is allowed, and so is a copy; the answer names the folder', async () => {
    const app = await start();
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    const decision = eligibilityOf(await getResume(app, RESUMABLE));
    expect(decision).toMatchObject({
      sessionId: RESUMABLE,
      allowed: true,
      forkAllowed: true,
      reason: null,
      liveElsewhere: false,
      liveTerminal: null,
      redirectTo: null,
    });
    expect(decision.folder?.key).toBe(projectFolderName(app.sharedFolder).name.toLowerCase());
    expect(decision.folder?.path.toLowerCase()).toBe(app.sharedFolder.toLowerCase());
  });

  it('a transcript that is missing or retired cannot be resumed, nor copied', async () => {
    const app = await start();
    seedSession(app, { uid: GONE, folder: app.sharedFolder, fileState: 'missing' });
    seedSession(app, { uid: RETIRED, folder: app.sharedFolder, fileState: 'retired' });
    for (const uid of [GONE, RETIRED]) {
      expect(eligibilityOf(await getResume(app, uid))).toMatchObject({
        allowed: false,
        forkAllowed: false,
        reason: 'transcript_gone',
        folder: null,
      });
    }
  });

  it('a project folder that is gone from the disk is folder_missing', async () => {
    const app = await start();
    seedSession(app, { uid: MISSING_FOLDER, folder: app.daOnlyFolder });
    expect(eligibilityOf(await getResume(app, MISSING_FOLDER))).toMatchObject({
      allowed: false,
      forkAllowed: false,
      reason: 'folder_missing',
      folder: null,
    });
  });

  it('a session that a terminal of the app holds is live_in_terminal, with the name of the terminal', async () => {
    const app = await start({
      linker: { sessionOwner: (id) => (id === RESUMABLE ? 'app-1' : null), ownedPids: () => new Set() },
    });
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    expect(eligibilityOf(await getResume(app, RESUMABLE))).toMatchObject({
      allowed: false,
      forkAllowed: false,
      reason: 'live_in_terminal',
      liveTerminal: 'app-1',
      liveElsewhere: false,
    });
  });

  it('a live process of the Claude registry that no terminal of the app owns is live_elsewhere: refused, a copy allowed', async () => {
    const app = await start();
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    // the process of this test is alive; the real liveness check of the platform sees it
    writeRegistryEntry(app.claudeHome, {
      pid: process.pid,
      sessionId: RESUMABLE,
      cwd: app.sharedFolder,
      status: 'busy',
    });
    expect(eligibilityOf(await getResume(app, RESUMABLE))).toMatchObject({
      allowed: false,
      forkAllowed: true,
      reason: 'live_elsewhere',
      liveElsewhere: true,
    });
  });

  it('the same entry belongs to the app when a terminal of the app owns that process', async () => {
    const app = await start({ linker: { sessionOwner: () => null, ownedPids: () => new Set([process.pid]) } });
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    writeRegistryEntry(app.claudeHome, { pid: process.pid, sessionId: RESUMABLE, cwd: app.sharedFolder });
    expect(eligibilityOf(await getResume(app, RESUMABLE))).toMatchObject({ allowed: true, reason: null });
  });

  it('redirectTo names the session that carried this one on, once the database knows that session', async () => {
    const app = await start();
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder, continuedIn: NEWER });
    expect(eligibilityOf(await getResume(app, RESUMABLE)).redirectTo).toBeNull();
    seedSession(app, { uid: NEWER, folder: app.sharedFolder });
    expect(eligibilityOf(await getResume(app, RESUMABLE))).toMatchObject({ allowed: true, redirectTo: NEWER });
  });

  it('a session nobody knows is 404 session_not_found, and the answer does not repeat the id', async () => {
    const app = await start();
    const reply = await getResume(app, RESUMABLE);
    expect(reply.status).toBe(404);
    expect(codeOf(reply)).toBe('session_not_found');
    expect(reply.body).not.toContain(RESUMABLE);
  });

  it('a path that is no session id is a validation failure, not a lookup', async () => {
    const app = await start();
    for (const id of ['not-a-session-id', 'UPPER-CASE', '1234']) {
      const reply = await getResume(app, id);
      expect(reply.status, id).toBe(400);
      expect(codeOf(reply), id).toBe('validation_failed');
    }
  });

  it('needs the session cookie: no cookie, a garbage cookie and the cookie of another instance are 401', async () => {
    const app = await start();
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    const other = app.cookie.replace(/^caw_[0-9a-f]+=/, 'caw_33333333=');
    for (const cookie of [null, 'caw_11111111=not-a-credential', other]) {
      const reply = await getResume(app, RESUMABLE, cookie);
      expect(reply.status).toBe(401);
      expect(codeOf(reply)).toBe('access_required');
      expect(reply.body).not.toContain(app.sharedFolder);
    }
  });

  it('never lets the DA memory files that hold prompts into an answer or the log', async () => {
    const app = await start();
    seedSession(app, { uid: RESUMABLE, folder: app.sharedFolder });
    seedSession(app, { uid: MISSING_FOLDER, folder: app.daOnlyFolder });
    seedSession(app, { uid: GONE, folder: app.sharedFolder, fileState: 'missing' });
    const bodies = [RESUMABLE, MISSING_FOLDER, GONE, NEWER].map(async (id) => (await getResume(app, id)).body);
    for (const body of await Promise.all(bodies)) {
      for (const canary of ALL_CANARIES) expect(body).not.toContain(canary);
    }
    await app.ctx.logger.close();
    expect(scanFilesFor([app.logFile], ALL_CANARIES)).toEqual([]);
  });
});

describe('what the service throws', () => {
  const failing = (error: Error): FolderServiceForRoutes => ({
    list: () => Promise.reject(error),
    add: () => Promise.reject(error),
    remove: () => Promise.reject(error),
    resumeEligibility: () => Promise.reject(error),
  });

  it('state_unwritable is an internal error with the fixed sentence, never the path', async () => {
    const app = await start({
      folders: failing(new FolderError('state_unwritable', null, new Error('EACCES D:\\secret\\file'))),
    });
    for (const reply of [await addPath(app, app.freshFolder), await post(app, removePath('some-key'), {})]) {
      expect(reply.status).toBe(500);
      expect(codeOf(reply)).toBe('internal_error');
      expect(reply.body).not.toContain('secret');
    }
  });

  it('any other failure of the service is an internal error too', async () => {
    const app = await start({ folders: failing(new Error('boom D:\\secret\\file')) });
    const reply = await get(app);
    expect(reply.status).toBe(500);
    expect(codeOf(reply)).toBe('internal_error');
    expect(reply.body).not.toContain('secret');
  });

  it('response validation is on: a row that breaks the schema never reaches the wire', async () => {
    const broken = {
      list: () => Promise.resolve({ folders: [{ key: 'UPPER' }] }),
      add: () => Promise.resolve({ key: 'UPPER' }),
      remove: () => Promise.resolve(),
      resumeEligibility: () => Promise.resolve({ sessionId: 'UPPER' }),
    } as unknown as FolderServiceForRoutes;
    const app = await start({ folders: broken });
    const reply = await get(app);
    expect(reply.status).toBe(500);
    expect(codeOf(reply)).toBe('internal_error');
    expect(reply.body).not.toContain('UPPER');
    const resume = await getResume(app, SESSION_ID);
    expect(resume.status).toBe(500);
    expect(codeOf(resume)).toBe('internal_error');
    expect(resume.body).not.toContain('UPPER');
  });

  it('a ResumeRefusal for a session nobody knows is 404, any other refusal is an internal error: the route never answers a refusal as data', async () => {
    const refusal = (code: string): Error =>
      Object.assign(new Error('resume refused: ' + code), { name: 'ResumeRefusal', code });
    const unknown = await start({ folders: failing(refusal('session_not_found')) });
    const notFound = await getResume(unknown, SESSION_ID);
    expect(notFound.status).toBe(404);
    expect(codeOf(notFound)).toBe('session_not_found');

    const other = await start({ folders: failing(refusal('live_in_terminal')) });
    const broken = await getResume(other, SESSION_ID);
    expect(broken.status).toBe(500);
    expect(codeOf(broken)).toBe('internal_error');
  });
});

describe('panels of a user instance (design 03 D11)', () => {
  const PER_REPOSITORY = ['git', 'attempts', 'ledger', 'chainLog'] as const;
  const CONFIG_KEYS: Readonly<Record<string, string>> = {
    git: 'git',
    attempts: 'attempts',
    ledger: 'ledger',
    chainLog: 'chain_log',
    machine: 'machine',
    logs: 'logs',
  };

  async function startPanels(
    kind: 'user' | 'task',
  ): Promise<{ port: number; asked: string[]; close: () => Promise<void> }> {
    const asked: string[] = [];
    const panels = Object.fromEntries(Object.values(CONFIG_KEYS).map((key) => [key, true]));
    const ctx = {
      config: { monitor: { panels } },
      instance: kind === 'user' ? { kind: 'user' } : {},
      errors: { push: () => undefined },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const runtime = {
      panels: {
        get: (key: string) => {
          asked.push(key);
          return Promise.resolve({ key });
        },
      },
    };
    const app = express();
    bindRouteServices(app, { ...ctx, validateResponses: false, access: null });
    panelRoutes(app, { ctx, runtime, nudge: () => undefined, task: null } as unknown as RouteDeps);
    const server = createServer(app);
    const port = await allocatePort();
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    return {
      port,
      asked,
      close: async () => {
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        });
        await assertPortClosed(port);
      },
    };
  }

  it('the four per-repository panels are 404 panel_disabled although config.json enables them; the others are served', async () => {
    const p = await startPanels('user');
    try {
      for (const key of PANEL_KEYS) {
        const reply = await httpRequest(p.port, `/api/v3/panels/${key}`);
        if ((PER_REPOSITORY as readonly string[]).includes(key)) {
          expect(reply.status, key).toBe(404);
          expect(codeOf(reply), key).toBe('panel_disabled');
        } else {
          expect(reply.status, key).toBe(200);
        }
      }
      expect(p.asked.sort()).toEqual(['logs', 'machine']);
    } finally {
      await p.close();
    }
  });

  it('a task instance serves every panel the configuration enables', async () => {
    const p = await startPanels('task');
    try {
      for (const key of PANEL_KEYS) expect((await httpRequest(p.port, `/api/v3/panels/${key}`)).status, key).toBe(200);
      expect(p.asked).toHaveLength(PANEL_KEYS.length);
    } finally {
      await p.close();
    }
  });
});
