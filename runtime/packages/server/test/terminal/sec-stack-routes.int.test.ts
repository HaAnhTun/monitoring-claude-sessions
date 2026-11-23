// The security matrix over the real stack, route half (CAW-57, design 08 section 3.6, ids TC-SEC-02, 18, 20, 21, 23 and 45): the
// production app and guards over the REAL engine host, terminal service, folder service and access service, with a scripted
// pseudo terminal (`startTerminalHarness`). Design 02's suite proves the guards over a scripted host; here the question is what
// a refused request did to the real thing: nothing. Every loop runs over `ACCESS_POLICY`, so a route that is added later is
// tested the day it is added, and a write route without a row in the tables below fails the suite instead of being skipped.
//   - A refused request carries a body that WOULD have an effect (a folder that exists, the name of a live session, a session
//     that can be resumed), and the same requests with a live cookie do have it: the refusal is the credential and nothing else.
//   - "Nothing happened" is a snapshot of the real service: the session rows, the census, the spawns, and per pseudo terminal
//     what was written, resized, killed and attached, plus the folder list.
// Expected codes are typed with the shared `ErrorCode` and their statuses come from the catalogue.
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';

import { projectFolderName } from '@mcs/engine';
import type { FakePty } from '@mcs/engine/testing';
import {
  ACCESS_POLICY,
  CreateSessionResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  FolderListResponseSchema,
  FolderSchema,
  PANEL_KEYS,
  ResumeResponseSchema,
  TerminalSessionInfoSchema,
  TerminalStateSchema,
  WRITE_ROUTE_IDS,
  routes,
  type ErrorCode,
  type RouteAccess,
  type RouteId,
} from '@mcs/shared';
import { CANARY, RawWsClient } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { COOKIE_MAX_AGE_SECONDS } from '../../src/http/cookie.ts';
import { mintAndExchange, pageOrigin } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

type Reply = Awaited<ReturnType<TerminalHarness['http']>>;

// FIXTURE: invented session ids
const RESUMABLE = 'abcd5555-5555-4555-8555-55555555abcd';
const TRANSCRIPT_GONE = '77777777-7777-4777-8777-777777777777';
const UNKNOWN_SESSION = '99999999-9999-4999-8999-999999999999';
/** A control token as boot writes it (64 hex digits); invented. */
const CONTROL_TOKEN = 'c0ffee'.repeat(10) + 'abcd';
/** A well-formed credential that no access service issued. */
const NEVER_ISSUED = Buffer.alloc(32, 9).toString('base64url');
/** A word that a hostile name or path carries, so that an answer that repeats its input is seen. */
const ECHO_MARK = 'zq-echo-mark';

const ALL_IDS = Object.keys(ACCESS_POLICY) as RouteId[];
const idsOf = (access: RouteAccess): RouteId[] => ALL_IDS.filter((id) => ACCESS_POLICY[id] === access);
const SESSION_ROUTES = idsOf('session');
const READER_ROUTES = idsOf('reader');
const OPEN_ROUTES = idsOf('open');
const TICKET_ROUTES = idsOf('ticket');
const methodOf = (id: RouteId): 'GET' | 'POST' => routes[id].method;
const isStream = (id: RouteId): boolean => routes[id].contentType === 'text/event-stream';

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

// ---- the stack: a real instance with something to lose -------------------------------------------------------------------------

interface Stack {
  readonly h: TerminalHarness;
  /** A live cookie. */
  readonly valid: string;
  /** A real credential of this instance that is older than its lifetime. */
  readonly expired: string;
  /** A real credential of this instance that was signed out. */
  readonly revoked: string;
  /** A session that runs: a refused kill must not end it, a refused socket must not attach to it. */
  readonly live: { readonly name: string; readonly pty: FakePty };
  /** The key of a folder that was added by hand: a refused remove must not drop it. */
  readonly handKey: string;
  /** A folder that exists and is not in the list: a refused add must not list it. */
  readonly extraFolder: string;
  /** A file, for the folder table. */
  readonly file: string;
}

/** Writes what the ingestion would have written for one session of the folder `h.work` (a project, a session, its main file). */
function seedSession(h: TerminalHarness, uid: string, transcript: 'on-disk' | 'gone'): void {
  const now = h.clock.now();
  const put = (table: string, row: Record<string, string | number | null>): number => {
    const columns = Object.keys(row);
    return h.ctx.db.driver
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
      .run(row).lastInsertRowid;
  };
  const dirName = projectFolderName(h.work).name;
  const key = dirName.toLowerCase();
  const known = h.ctx.db.driver
    .prepare<{ id: number }>('SELECT id FROM projects WHERE project_key = :key')
    .get({ key });
  const project =
    known?.id ??
    put('projects', {
      project_key: key,
      dir_name: dirName,
      root_path: h.work,
      first_seen_at: now,
      last_activity_at: now,
    });
  put('sessions', {
    session_uid: uid,
    project_id: project,
    first_seen_at: now,
    started_at: now,
    last_activity_at: now,
    state: 'completed',
    cwd: h.work,
    entrypoint: 'cli',
    continued_in: null,
    updated_at: now,
  });
  if (transcript === 'gone') return;
  const file = path.join(h.ctx.claudeHome, 'projects', dirName, `${uid}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  // what a transcript holds is never the terminal API's to return (TC-SEC-45)
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: CANARY.prompt } })}\n`);
  put('transcript_files', {
    path: file,
    path_key: file.toLowerCase(),
    kind: 'session',
    session_uid: uid,
    state: 'active',
    discovered_at: now,
    updated_at: now,
  });
}

async function startStack(): Promise<Stack> {
  const h = await startTerminalHarness();
  const handFolder = path.join(h.work, 'added-by-hand');
  const extraFolder = path.join(h.work, 'not-in-the-list');
  const file = path.join(h.work, 'a-file.txt');
  mkdirSync(handFolder);
  mkdirSync(extraFolder);
  writeFileSync(file, 'FIXTURE: invented data for tests\n');
  seedSession(h, RESUMABLE, 'on-disk');
  seedSession(h, TRANSCRIPT_GONE, 'gone');
  // the control token of the instance, where boot writes it: the reader routes take it as a Bearer value on GET
  mkdirSync(path.join(h.ctx.instanceDir, 'run'), { recursive: true });
  writeFileSync(path.join(h.ctx.instanceDir, 'run', 'control.token'), `${CONTROL_TOKEN}\n`);

  const added = await h.http('POST', routes.addFolder.path, { body: { path: handFolder } });
  expect(added.status, added.body).toBe(200);
  const handKey = FolderSchema.parse(added.json).key;
  const made = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
  expect(made.status, made.body).toBe(200);
  const { name } = CreateSessionResponseSchema.parse(made.json).session;
  const pty = h.backend.last;
  if (pty === undefined) throw new Error('the create route answered a session and nothing was spawned');

  // a second credential, signed out
  const revoked = await mintAndExchange(h.port, h.access);
  expect((await h.http('POST', routes.authLogout.path, { cookie: revoked })).status).toBe(200);
  // the cookie of the harness grows older than its lifetime; a fresh one is the live cookie of the tests
  const expired = h.cookie;
  h.clock.advance(COOKIE_MAX_AGE_SECONDS * 1000 + 1000);
  const valid = await mintAndExchange(h.port, h.access);
  return { h, valid, expired, revoked, live: { name, pty }, handKey, extraFolder, file };
}

/** The value of every `:param` a route path can hold; a new parameter name fails here until it has a row. */
function paramOf(s: Stack, id: RouteId, param: string): string {
  if (param === 'sessionId') return RESUMABLE;
  if (param === 'name') return s.live.name;
  if (param === 'key') return id === 'panel' ? PANEL_KEYS[0] : s.handKey;
  if (param === 'eventId' || param === 'workItemId' || param === 'probeSessionId') return '1';
  throw new Error(`sec-stack-routes: the path parameter ":${param}" of route ${id} has no sample value`);
}

function pathOf(s: Stack, id: RouteId, overrides: Readonly<Record<string, string>> = {}): string {
  return routes[id].path.replace(
    /:(\w+)/g,
    (_match, param: string) => overrides[param] ?? encodeURIComponent(paramOf(s, id, param)),
  );
}

/**
 * The body of every write route that needs the session: one that would change something. A write route that is added to the
 * registry without a row fails the suite (`bodyOf`).
 */
const WRITE_BODIES: Partial<Record<RouteId, (s: Stack) => unknown>> = {
  addFolder: (s) => ({ path: s.extraFolder }),
  removeFolder: () => ({}),
  authLogout: () => ({}),
  terminalCreateSession: (s) => ({ path: s.h.work }),
  terminalKillSession: () => ({}),
  terminalPickFolder: () => ({}),
  terminalResume: () => ({ sessionId: RESUMABLE }),
  terminalOpenNative: () => ({ sessionId: RESUMABLE }),
};

function bodyOf(s: Stack, id: RouteId): unknown {
  const make = WRITE_BODIES[id];
  if (make !== undefined) return make(s);
  // an open write (the hook nudge) takes an empty body; a write that needs the session must have a row
  if (ACCESS_POLICY[id] === 'session') {
    throw new Error(`sec-stack-routes: the write route ${id} has no body in WRITE_BODIES`);
  }
  return {};
}

interface Credential {
  readonly cookie?: string | null;
  readonly bearer?: string;
}

/**
 * One request to a route as the page sends it: the sample parameters, for a write the body that would change something and the
 * `Origin` of the page (the harness adds it to a POST), and the `Origin` also on the socket route, which asks for it like a write.
 */
function call(
  s: Stack,
  id: RouteId,
  credential: Credential = {},
  overrides?: Readonly<Record<string, string>>,
): Promise<Reply> {
  const headers = credential.bearer === undefined ? undefined : { Authorization: `Bearer ${credential.bearer}` };
  return s.h.http(methodOf(id), pathOf(s, id, overrides), {
    cookie: credential.cookie ?? null,
    ...(headers === undefined ? {} : { headers }),
    ...(routes[id].contentType === 'websocket' ? { origin: pageOrigin(s.h.port) } : {}),
    ...(methodOf(id) === 'POST' ? { body: bodyOf(s, id) } : {}),
  });
}

/** The status and the headers of a GET whose body never ends (an event stream): the request is dropped once they are in. */
function headOf(
  s: Stack,
  id: RouteId,
  credential: Credential = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: s.h.port,
        path: pathOf(s, id),
        method: 'GET',
        agent: false,
        headers: {
          Host: `127.0.0.1:${String(s.h.port)}`,
          Accept: 'text/event-stream',
          ...(typeof credential.cookie === 'string' ? { Cookie: credential.cookie } : {}),
          ...(credential.bearer === undefined ? {} : { Authorization: `Bearer ${credential.bearer}` }),
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        res.resume();
        req.destroy();
        resolve({ status: res.statusCode ?? 0, headers, body: '' });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

/** `call`, or `headOf` for a route that answers with an event stream when it admits the request. */
function admittedCall(s: Stack, id: RouteId, credential: Credential): Promise<{ status: number; body: string }> {
  return isStream(id) ? headOf(s, id, credential) : call(s, id, credential);
}

/** What the real service holds: compared before and after requests that must change nothing. */
async function snapshot(s: Stack): Promise<unknown> {
  const folders = await s.h.http('GET', routes.listFolders.path, { cookie: s.valid });
  expect(folders.status, folders.body).toBe(200);
  return {
    sessions: s.h.ports.sessions.list(),
    census: s.h.ports.census.count(),
    spawns: s.h.backend.spawns.length,
    terminals: s.h.backend.spawns.map(({ pty }) => ({
      written: pty.written.length,
      resized: pty.sizes.length,
      kills: pty.killCalls,
      exited: pty.exited,
      attached: pty.dataListeners,
    })),
    // which folders are listed and where they come from; the activity marks of a row follow the clock and the disk, not a request
    folders: FolderListResponseSchema.parse(folders.json)
      .folders.map((folder) => ({
        key: folder.key,
        path: folder.path,
        origins: folder.origins,
        userAdded: folder.userAdded,
      }))
      .sort((a, b) => a.key.localeCompare(b.key, 'en')),
    signedIn: (await s.h.http('GET', routes.authSession.path, { cookie: s.valid })).json,
  };
}

function expectRefused(reply: Reply, code: ErrorCode, label: string): void {
  expect(reply.status, label).toBe(ERROR_HTTP_STATUS[code]);
  expect(codeOf(reply), label).toBe(code);
  expect(reply.headers['cache-control'], label).toBe('no-store');
  expect(reply.headers['set-cookie'], label).toBeUndefined();
}

// ---- the matrix over ACCESS_POLICY ---------------------------------------------------------------------------------------------

describe('every route of ACCESS_POLICY, by what it asks for', () => {
  it('the policy has exactly the four kinds this suite knows, and every kind has routes', () => {
    const known: readonly RouteAccess[] = ['open', 'reader', 'session', 'ticket'];
    for (const id of ALL_IDS) expect(known, id).toContain(ACCESS_POLICY[id]);
    expect(ALL_IDS.sort()).toEqual(Object.keys(routes).sort());
    expect(SESSION_ROUTES.length + READER_ROUTES.length + OPEN_ROUTES.length + TICKET_ROUTES.length).toBe(
      ALL_IDS.length,
    );
    for (const group of [SESSION_ROUTES, READER_ROUTES, OPEN_ROUTES, TICKET_ROUTES]) {
      expect(group.length).toBeGreaterThan(0);
    }
    // every write that needs the session has a body that would change something
    for (const id of WRITE_ROUTE_IDS) {
      if (ACCESS_POLICY[id] === 'session') expect(WRITE_BODIES[id], id).toBeTypeOf('function');
    }
    // and every route of the session kind is either a GET or a known write
    for (const id of SESSION_ROUTES) {
      if (methodOf(id) === 'POST') expect(WRITE_ROUTE_IDS, id).toContain(id);
    }
  });

  it('TC-SEC-02: a session route without a live cookie is 401 access_required with WWW-Authenticate, and the real service is unchanged', async () => {
    const s = await startStack();
    const name = s.valid.slice(0, s.valid.indexOf('='));
    const value = s.valid.slice(s.valid.indexOf('=') + 1);
    const states: Readonly<Record<string, Credential>> = {
      'no cookie': {},
      'a junk cookie': { cookie: `${name}=not a credential` },
      'a credential that was never issued': { cookie: `${name}=${NEVER_ISSUED}` },
      'an expired cookie': { cookie: s.expired },
      'a signed-out cookie': { cookie: s.revoked },
      'the live credential under another cookie name': { cookie: `caw_00000000=${value}` },
      'the control token as a Bearer value': { bearer: CONTROL_TOKEN },
    };
    const before = await snapshot(s);
    for (const id of SESSION_ROUTES) {
      for (const [state, credential] of Object.entries(states)) {
        const reply = await call(s, id, credential);
        const label = `${id} with ${state}`;
        expectRefused(reply, 'access_required', label);
        expect(reply.headers['www-authenticate'], label).toBeDefined();
      }
    }
    expect(await snapshot(s)).toEqual(before);
    // the snapshot is not blind: the live session is in it
    expect(s.h.ports.sessions.list().map((session) => session.name)).toEqual([s.live.name]);
    expect(s.h.backend.spawns).toHaveLength(1);
  });

  it('TC-SEC-02: the same requests with a live cookie are admitted and do what they say (the refusal was the credential)', async () => {
    const s = await startStack();
    const cookie = s.valid;
    // the logout revokes the credential, so it goes last
    const ordered = [...SESSION_ROUTES.filter((id) => id !== 'authLogout'), 'authLogout' as const];
    const replies = new Map<RouteId, { status: number; body: string }>();
    for (const id of ordered) {
      const reply = await admittedCall(s, id, { cookie });
      expect(reply.status, id).not.toBe(ERROR_HTTP_STATUS.access_required);
      expect(reply.status, id).not.toBe(403);
      replies.set(id, reply);
    }
    const statusOf = (id: RouteId): number | undefined => replies.get(id)?.status;
    // the reads answered
    for (const id of ['listFolders', 'sessionResume', 'terminalState', 'terminalEvents'] as const) {
      expect(statusOf(id), id).toBe(200);
    }
    // a plain GET of the socket route is admitted and then told to upgrade
    expect(statusOf('terminalSocket')).toBe(ERROR_HTTP_STATUS.upgrade_required);
    // the writes changed the real service: two more terminals (create, resume), the live one killed, the folders edited
    for (const id of [
      'terminalCreateSession',
      'terminalKillSession',
      'terminalResume',
      'addFolder',
      'removeFolder',
    ] as const) {
      expect(statusOf(id), `${id}: ${replies.get(id)?.body ?? ''}`).toBe(routes[id].successStatus);
    }
    expect(s.h.backend.spawns).toHaveLength(3);
    expect(s.live.pty.killCalls).toBe(1);
    expect(s.h.ports.sessions.list().map((session) => session.name)).not.toContain(s.live.name);
    expect(s.h.ports.census.count()).toBe(2);
    // the harness has no folder dialog and no native terminal: admitted, and answered as a host without them
    for (const id of ['terminalPickFolder', 'terminalOpenNative'] as const) {
      expect(statusOf(id), id).toBe(ERROR_HTTP_STATUS.terminal_unavailable);
    }
    // the logout ended the credential
    expect(statusOf('authLogout')).toBe(200);
    expectRefused(await call(s, 'terminalState', { cookie }), 'access_required', 'the state after the logout');
    // the folder list of a fresh credential shows the add and the remove
    const fresh = await mintAndExchange(s.h.port, s.h.access);
    const listed = FolderListResponseSchema.parse((await call(s, 'listFolders', { cookie: fresh })).json).folders;
    const handAdded = listed.filter((folder) => folder.userAdded).map((folder) => folder.path);
    expect(handAdded).toEqual([s.extraFolder]);
    expect(listed.map((folder) => folder.key)).not.toContain(s.handKey);
  });

  it('the reader routes need the cookie or, on GET, the control token; nothing else passes, and the token opens no session route', async () => {
    const s = await startStack();
    const name = s.valid.slice(0, s.valid.indexOf('='));
    const refusedStates: Readonly<Record<string, Credential>> = {
      'no credential': {},
      'a credential that was never issued': { cookie: `${name}=${NEVER_ISSUED}` },
      'an expired cookie': { cookie: s.expired },
      'a signed-out cookie': { cookie: s.revoked },
      'a wrong Bearer value': { bearer: 'ab'.repeat(32) },
      'the access code as a Bearer value': { bearer: s.h.code },
    };
    const before = await snapshot(s);
    for (const id of READER_ROUTES) {
      expect(methodOf(id), id).toBe('GET');
      for (const [state, credential] of Object.entries(refusedStates)) {
        expectRefused(await call(s, id, credential), 'access_required', `${id} with ${state}`);
      }
      for (const [state, credential] of Object.entries({
        cookie: { cookie: s.valid },
        token: { bearer: CONTROL_TOKEN },
      })) {
        const reply = await admittedCall(s, id, credential);
        expect(reply.status, `${id} with the ${state}`).not.toBe(ERROR_HTTP_STATUS.access_required);
        expect(reply.status, `${id} with the ${state}`).not.toBe(403);
      }
    }
    // one reader route answers 200 both ways, so the passes above are not a coincidence of other refusals
    expect((await call(s, 'listToolCalls', { cookie: s.valid })).status).toBe(200);
    expect((await call(s, 'listToolCalls', { bearer: CONTROL_TOKEN })).status).toBe(200);
    expect(await snapshot(s)).toEqual(before);
  });

  it('the open routes answer without a credential, and the ticket route redeems nothing but a code', async () => {
    const s = await startStack();
    const before = await snapshot(s);
    // the one open write is the nudge of the hook handler, which is not a browser: no Origin at all, the instance id as the body
    const nudge = await s.h.http('POST', routes.ingestNudge.path, {
      cookie: null,
      origin: null,
      body: { instanceId: s.h.ctx.instanceId },
    });
    expect(nudge.status, nudge.body).toBe(routes.ingestNudge.successStatus);
    for (const id of OPEN_ROUTES) {
      if (methodOf(id) === 'POST') {
        // no other open write exists; a new one fails here until this suite knows how it is called
        expect(id).toBe('ingestNudge');
        continue;
      }
      const reply = isStream(id) ? await headOf(s, id) : await call(s, id);
      // (the harness runs no instance runtime, so the one open route that asks it, the panels, answers `internal_error` here:
      // what this loop pins is that no open route asks for a credential)
      expect(reply.status, id).not.toBe(ERROR_HTTP_STATUS.access_required);
      expect(reply.status, id).not.toBe(403);
    }
    for (const id of TICKET_ROUTES) {
      // a live cookie is not a code, and neither is a well-formed string nobody minted
      for (const code of [s.valid.slice(s.valid.indexOf('=') + 1), NEVER_ISSUED, s.h.code]) {
        const reply = await s.h.http('POST', pathOf(s, id), { cookie: null, body: { code } });
        expectRefused(reply, 'access_code_invalid', id);
      }
    }
    expect(await snapshot(s)).toEqual(before);
  });

  it('TC-SEC-18: no GET route has a side effect, and every answer of the API says Cache-Control: no-store', async () => {
    const s = await startStack();
    const gets = ALL_IDS.filter((id) => methodOf(id) === 'GET');
    expect(gets.length).toBeGreaterThan(30);
    const before = await snapshot(s);
    for (const id of gets) {
      // with the live cookie every GET reaches its handler: twice, so that a handler that changes something on a repeat shows
      for (let round = 0; round < 2; round += 1) {
        const reply = isStream(id) ? await headOf(s, id, { cookie: s.valid }) : await call(s, id, { cookie: s.valid });
        expect(reply.status, id).not.toBe(ERROR_HTTP_STATUS.access_required);
        expect(reply.headers['cache-control'], id).toBe('no-store');
        expect(reply.headers['set-cookie'], id).toBeUndefined();
      }
    }
    expect(await snapshot(s)).toEqual(before);
    // the answers of the writes are not cached either
    const made = await call(s, 'terminalCreateSession', { cookie: s.valid });
    expect(made.status).toBe(200);
    expect(made.headers['cache-control']).toBe('no-store');
    const out = await call(s, 'authLogout', { cookie: s.valid });
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
  });
});

// ---- names, folders, resume ----------------------------------------------------------------------------------------------------

describe('hostile names and paths against the real service', () => {
  it('TC-SEC-20: a session name the pattern refuses is 400 validation_failed on every :name route, and the real session is untouched', async () => {
    const s = await startStack();
    const named = ALL_IDS.filter((id) => routes[id].path.includes(':name'));
    expect(named).toEqual(expect.arrayContaining(['terminalKillSession', 'terminalSocket']));
    const { name } = s.live;
    // the path segment as it is sent (already percent-encoded where it has to be)
    const hostile: readonly string[] = [
      '..',
      '.',
      `${name}.`,
      `${name}%20`,
      `%20${name}`,
      `${name}%00`,
      `${name}%0A`,
      `${name}%2F..`,
      `..%2F${name}`,
      `${name}%5C..`,
      `${name};x`,
      `${name}%3Fx`,
      `${ECHO_MARK}.exe`,
      `${ECHO_MARK}%2F%2E%2E%2Fkill`,
      'caf%C3%A9',
      '%E2%80%AE',
      'a'.repeat(65),
      'CON.txt',
      '*',
    ];
    const before = await snapshot(s);
    for (const id of named) {
      for (const segment of hostile) {
        const reply = await call(s, id, { cookie: s.valid }, { name: segment });
        const label = `${id} with the name segment ${JSON.stringify(segment)}`;
        expectRefused(reply, 'validation_failed', label);
        // the answer names the parameter, never its value
        expect(reply.body, label).not.toContain(ECHO_MARK);
      }
      // a well-formed name that nobody holds is not the live session, whatever its case
      for (const segment of [name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase(), `${name}-9`]) {
        if (segment === name) continue;
        const reply = await call(s, id, { cookie: s.valid }, { name: segment });
        const expected: ErrorCode = id === 'terminalSocket' ? 'upgrade_required' : 'terminal_not_found';
        expectRefused(reply, expected, `${id} with a name nobody holds`);
      }
    }
    // the upgrade path is a separate code path: the handshake meets the same check before any session is looked up
    for (const segment of hostile) {
      const client = await RawWsClient.connect(s.h.port, {
        path: pathOf(s, 'terminalSocket', { name: segment }),
        cookie: s.valid,
        origin: pageOrigin(s.h.port),
      });
      expect(client.status, `the handshake with ${JSON.stringify(segment)}`).toBe(ERROR_HTTP_STATUS.validation_failed);
      expect(codeOf(client)).toBe('validation_failed');
      await client.waitClosed();
    }
    expect(await snapshot(s)).toEqual(before);
    expect(s.live.pty.killCalls).toBe(0);
    expect(s.live.pty.exited).toBe(false);
  });

  it('TC-SEC-21: a UNC, device, control-character or oversize folder is refused by the schema, a relative, missing or file path by the engine; nothing is spawned or listed', async () => {
    const s = await startStack();
    const work = s.h.work;
    // another machine, a device, a control character: the worst inputs. The create route refuses them in its schema, before any
    // layer sees them; the folder list checks only the size in its schema and lets the service name the reason.
    const remoteOrDevice: readonly string[] = [
      `\\\\${ECHO_MARK}\\share\\folder`,
      `//${ECHO_MARK}/share/folder`,
      `\\\\?\\C:\\${ECHO_MARK}`,
      `\\\\?\\UNC\\${ECHO_MARK}\\share`,
      '\\\\.\\COM1',
      `\\\\.\\pipe\\${ECHO_MARK}`,
      `\\??\\C:\\${ECHO_MARK}`,
      `${work}\u0000`,
      `${work}\u0000${ECHO_MARK}`,
      `${work}\n${ECHO_MARK}`,
      `${work}\u001b[2J`,
      `${work}\u007f`,
      `${work}\u0085`,
    ];
    const malformed: readonly unknown[] = [
      `${work}${path.sep}${'a'.repeat(1025)}`,
      '',
      42,
      null,
      [work],
      { path: work },
    ];
    const byEngine: readonly string[] = [
      'work',
      `.${path.sep}work`,
      `..${path.sep}${ECHO_MARK}`,
      path.basename(work),
      s.file,
      `${work}-${ECHO_MARK}-missing`,
      path.join(work, 'missing', 'deeper'),
      // a Unicode format character hides in the name (a right-to-left override)
      `${work}\u202e`,
      // longer than any working folder, shorter than the limit of the schema
      path.join(work, 'b'.repeat(300)),
    ];
    const windowsOnly: readonly string[] = [
      // relative to the current folder of a drive, an NTFS stream, a reserved device name
      `C:${ECHO_MARK}`,
      `${work}:stream`,
      `${work}\\NUL`,
      `${work}\\COM1.txt`,
    ];
    const rows: readonly (readonly [unknown, { readonly create: ErrorCode; readonly add: ErrorCode }])[] = [
      ...remoteOrDevice.map((folder) => [folder, { create: 'validation_failed', add: 'folder_invalid' }] as const),
      ...malformed.map((folder) => [folder, { create: 'validation_failed', add: 'validation_failed' }] as const),
      ...[...byEngine, ...(process.platform === 'win32' ? windowsOnly : [])].map(
        (folder) => [folder, { create: 'folder_invalid', add: 'folder_invalid' }] as const,
      ),
    ];
    const before = await snapshot(s);
    for (const [folder, verdict] of rows) {
      for (const [id, code] of [
        ['terminalCreateSession', verdict.create],
        ['addFolder', verdict.add],
      ] as const) {
        const reply = await s.h.http('POST', routes[id].path, { cookie: s.valid, body: { path: folder } });
        const label = `${id} with ${JSON.stringify(folder).slice(0, 80)}`;
        // every row is reported, not only the first that fails
        expect.soft(codeOf(reply), label).toBe(code);
        expect.soft(reply.status, label).toBe(ERROR_HTTP_STATUS[code]);
        // the answer names the field and the reason, never the path
        expect.soft(reply.body, label).not.toContain(ECHO_MARK);
      }
    }
    expect(await snapshot(s)).toEqual(before);
    expect(s.h.backend.spawns).toHaveLength(1);

    // the other spellings of a real folder are mapped to it, never to something else
    const spellings =
      process.platform === 'win32'
        ? [
            work.replaceAll('\\', '/'),
            `"${work}"`,
            `${work}\\`,
            `/mnt/${work.charAt(0).toLowerCase()}${work.slice(2).replaceAll('\\', '/')}`,
          ]
        : [`${work}/`, `"${work}"`, `${work}/./`];
    for (const spelling of spellings) {
      const made = await s.h.http('POST', routes.terminalCreateSession.path, {
        cookie: s.valid,
        body: { path: spelling },
      });
      expect(made.status, `${spelling}: ${made.body}`).toBe(200);
      expect(CreateSessionResponseSchema.parse(made.json).session.path).toBe(s.h.backend.spawns.at(-1)?.cwd);
      expect(s.h.backend.spawns.at(-1)?.cwd.toLowerCase()).toBe(work.toLowerCase());
    }
    expect(s.h.backend.spawns).toHaveLength(1 + spellings.length);
  });

  it('TC-SEC-23: a resume takes a session id and a flag and nothing else; hostile, unknown and unresumable ids are refused before any spawn', async () => {
    const s = await startStack();
    const malformed: readonly unknown[] = [
      {},
      { sessionId: 123 },
      { sessionId: null },
      { sessionId: [RESUMABLE] },
      { sessionId: RESUMABLE.toUpperCase() },
      { sessionId: `${RESUMABLE}\n` },
      { sessionId: ` ${RESUMABLE}` },
      { sessionId: `${RESUMABLE} --dangerously-skip-permissions` },
      { sessionId: `--${ECHO_MARK}` },
      { sessionId: `..\\..\\${ECHO_MARK}` },
      { sessionId: RESUMABLE, fork: 'yes' },
      { sessionId: RESUMABLE, fork: 1 },
      // no route takes a command line, arguments, an environment or a folder
      { sessionId: RESUMABLE, args: ['--dangerously-skip-permissions'] },
      { sessionId: RESUMABLE, env: { PATH: ECHO_MARK } },
      { sessionId: RESUMABLE, path: s.extraFolder },
      { sessionId: RESUMABLE, cwd: s.extraFolder },
      { sessionId: RESUMABLE, command: 'cmd.exe' },
      { sessionId: RESUMABLE, name: ECHO_MARK },
      [{ sessionId: RESUMABLE }],
    ];
    const before = await snapshot(s);
    for (const id of ['terminalResume', 'terminalOpenNative'] as const) {
      for (const body of malformed) {
        const reply = await s.h.http('POST', routes[id].path, { cookie: s.valid, body });
        const label = `${id} with ${JSON.stringify(body).slice(0, 90)}`;
        expectRefused(reply, 'validation_failed', label);
        expect(reply.body, label).not.toContain(ECHO_MARK);
      }
    }
    const resume = (body: unknown): Promise<Reply> =>
      s.h.http('POST', routes.terminalResume.path, { cookie: s.valid, body });
    for (const fork of [false, true]) {
      expectRefused(await resume({ sessionId: UNKNOWN_SESSION, fork }), 'session_not_found', 'an unknown session');
      const gone = await resume({ sessionId: TRANSCRIPT_GONE, fork });
      expectRefused(gone, 'resume_unavailable', 'a session without a transcript');
      // the refusal says why, never which session, folder or terminal
      expect(gone.body).not.toContain(TRANSCRIPT_GONE);
      expect(gone.body).not.toContain(path.basename(s.h.work));
    }
    expect(await snapshot(s)).toEqual(before);

    // the one thing a resume can start: the configured program with `--resume <id>`, in the folder the engine planned
    const resumed = await resume({ sessionId: RESUMABLE });
    expect(resumed.status, resumed.body).toBe(200);
    const row = ResumeResponseSchema.parse(resumed.json).session;
    const spawn = s.h.backend.spawns.at(-1);
    expect(s.h.backend.spawns).toHaveLength(2);
    expect(spawn?.cmd).toBe(s.h.ctx.config.runtime.terminal.command);
    expect(spawn?.args).toEqual(['--resume', RESUMABLE]);
    expect(spawn?.cwd).toBe(row.path);
    expect(row.path.toLowerCase()).toBe(s.h.work.toLowerCase());
    // a terminal of this app holds the session now: a second resume and a copy are both refused, and start nothing
    for (const fork of [false, true]) {
      expectRefused(
        await resume({ sessionId: RESUMABLE, fork }),
        'resume_unavailable',
        'a session that is live in a terminal',
      );
    }
    expect(s.h.backend.spawns).toHaveLength(2);
  });

  it('TC-SEC-45: the terminal API returns rows of the wire schema and never transcript text, terminal output or input', async () => {
    const s = await startStack();
    const resumed = await s.h.http('POST', routes.terminalResume.path, {
      cookie: s.valid,
      body: { sessionId: RESUMABLE },
    });
    expect(resumed.status, resumed.body).toBe(200);
    const row = ResumeResponseSchema.parse(resumed.json).session;
    const pty = s.h.backend.last;
    if (pty === undefined) throw new Error('the resume spawned nothing');
    // the process prints and is typed to: neither is the REST API's to return
    pty.emitData(`${CANARY.toolResult}\r\n`);
    const socket = await s.h.ws(row.name, { cookie: s.valid });
    expect(socket.replay.toString('utf8')).toContain(CANARY.toolResult);
    socket.client.sendBinary(Buffer.from(CANARY.key));
    await socket.client.close();

    const replies: Reply[] = [resumed];
    for (const id of ['terminalState', 'listFolders', 'sessionResume', 'authSession'] as const) {
      const reply = await call(s, id, { cookie: s.valid });
      expect(reply.status, id).toBe(200);
      replies.push(reply);
    }
    replies.push(await call(s, 'terminalKillSession', { cookie: s.valid }, { name: row.name }));
    for (const reply of replies) {
      for (const canary of Object.values(CANARY)) expect(reply.body).not.toContain(canary);
    }
    // a row is the strict wire object: the process facts, the link and the folder key, and no other field
    const state = TerminalStateSchema.parse((await call(s, 'terminalState', { cookie: s.valid })).json);
    expect(state.sessions.map((session) => session.name)).toEqual([s.live.name]);
    for (const session of [row, ...state.sessions]) {
      expect(Object.keys(TerminalSessionInfoSchema.parse(session)).sort()).toEqual(
        ['cols', 'createdAt', 'folderKey', 'link', 'name', 'path', 'rows', 'viewers'].sort(),
      );
    }
  });
});
