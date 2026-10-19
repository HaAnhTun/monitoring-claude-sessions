// T-LC-14 (01 4.16): crash recovery on a real server. The server is killed with a force kill (the pid of this test's own start)
// while it imports a large transcript and the real hook handler keeps appending to its spool. A new start then:
//   - reports `previousRunUnclean: true` in its health, and `false` after a clean stop and another start;
//   - leaves a database whose `PRAGMA integrity_check` says `ok`;
//   - holds every appended line exactly once (the lines written while the server was dead are read at the restart);
//   - stores nothing twice when the whole spool is replayed through the control channel (`ingest-replay`, 02 2.7).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { controlAddressOf, forceKill, openSqlite, requestControl, waitForExit } from '@mcs/engine';
import { StateFileSchema, routes } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  bigTranscript,
  buildRepo,
  hermeticEnv,
  hookPayload,
  httpRequest,
  killAllTracked,
  runCli,
  runHookHandler,
  startInstance,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'crash';
const SESSION = 'c0c0c0c0-0000-4000-8000-0000000000c1';

afterEach(killAllTracked);

const forward = (path: string): string => path.replaceAll('\\', '/');

interface Rig {
  readonly repo: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly port: number;
  readonly folder: string;
  readonly env: Record<string, string>;
  mcs(args: readonly string[]): ReturnType<typeof runCli>;
  fire(n: number): Promise<void>;
  instanceId(): string;
}

/** An initialised task with hooks on, a watched folder that holds a large transcript, and no server yet. */
async function rig(): Promise<Rig> {
  const root = makeTemp('crash-recovery').path;
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const { repo } = buildRepo(join(root, 'repo'));
  const port = await allocatePort();
  const mcs = (args: readonly string[]) => runCli([...args, '--repo', repo], { mcsHome, env, cwd: root });
  const made = await mcs(['init', '--name', 'FIXTURE crash', '--slug', SLUG, '--port', String(port)]);
  expect(made.code, made.stderr).toBe(0);
  const dir = join(repo, '.claude', 'monitor', 'tasks', SLUG);

  // hooks on, as `mcs hooks install` leaves the instance (the server then publishes its route)
  const file = join(dir, 'instance.json');
  const instance = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...instance, hooks: { enabled: true } }, null, 2)}\n`);

  const folder = join(env['CLAUDE_CONFIG_DIR'] ?? join(root, 'claude-home'), 'projects', 'FIXTURE-project-crash');
  const configured = await mcs([
    'configure',
    '--task',
    SLUG,
    '--set',
    `transcripts_dir=${JSON.stringify(folder)}`,
    '--reason',
    'crash recovery row',
  ]);
  expect(configured.code, configured.stderr).toBe(0);
  // a transcript that takes the importer a moment: the kill lands while it works
  bigTranscript({ sessionId: SESSION, targetBytes: 6 * 1024 * 1024 }).write(join(folder, `${SESSION}.jsonl`));

  const base = {
    sessionId: SESSION,
    cwd: forward(join(root, 'FIXTURE-cwd')),
    transcriptPath: `${forward(folder)}/${SESSION}.jsonl`,
  };
  return {
    repo,
    dir,
    dbPath: join(dir, 'data', 'monitor.db'),
    port,
    folder,
    env,
    mcs,
    fire: async (n) => {
      const result = await runHookHandler(hookPayload('Notification', base, { message: `FIXTURE note ${String(n)}` }), {
        mcsHome,
        event: 'Notification',
      });
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
        code: 0,
        stdout: '',
        stderr: '',
      });
    },
    instanceId: () => (JSON.parse(readFileSync(file, 'utf8')) as { instanceId: string }).instanceId,
  };
}

/** `GET /api/v3/health`: whether the previous run of the instance ended without a clean shutdown. */
async function previousRunUnclean(port: number): Promise<boolean> {
  const reply = await httpRequest(port, routes.health.path);
  expect(reply.status).toBe(200);
  return routes.health.response.parse(JSON.parse(reply.body)).runtime.previousRunUnclean;
}

interface Facts {
  readonly integrity: string;
  readonly notifications: number;
  readonly hookEvents: number;
  readonly distinctUids: number;
  /** Duplicates the writer saw, over every layer (`ingest_health.counters_json`). */
  readonly duplicates: number;
}

/** Read-only look at the database file; the server may still hold it open. */
function factsOf(dbPath: string): Facts {
  const db = openSqlite(dbPath, { readonly: true, fileMustExist: true, timeoutMs: 5000 });
  try {
    const n = (sql: string): number => db.prepare<{ n: number }>(sql).get()?.n ?? -1;
    const counters = db.prepare<{ counters_json: string }>('SELECT counters_json FROM ingest_health').get();
    const parsed = JSON.parse(counters?.counters_json ?? '{}') as { duplicates?: Record<string, number> };
    return {
      integrity: db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()?.integrity_check ?? '',
      notifications: n("SELECT count(*) AS n FROM events WHERE hook_event = 'Notification'"),
      hookEvents: n('SELECT count(*) AS n FROM events WHERE event_uid IS NOT NULL'),
      distinctUids: n('SELECT count(DISTINCT event_uid) AS n FROM events WHERE event_uid IS NOT NULL'),
      duplicates: Object.values(parsed.duplicates ?? {}).reduce((a, b) => a + b, 0),
    };
  } finally {
    db.close();
  }
}

describe('T-LC-14 crash recovery', () => {
  it('a force kill during ingestion, then a start: unclean flag, integrity ok, every line once, a replay adds nothing', async () => {
    const r = await rig();
    const first = await startInstance({ repo: r.repo, slug: SLUG, env: r.env }, { port: r.port });
    expect(await previousRunUnclean(r.port)).toBe(false);

    // ingestion is going on: the importer works through the transcript while the handler appends envelopes
    let sent = 0;
    for (; sent < 12; sent += 1) await r.fire(sent);
    await forceKill(first.pid);
    expect(await waitForExit(first.pid, 15_000)).toBe(true);
    await assertPortClosed(r.port);
    // the route still says the instance runs, so the handler goes on appending to the spool of the dead server
    for (; sent < 15; sent += 1) await r.fire(sent);
    expect(StateFileSchema.parse(JSON.parse(readFileSync(join(r.dir, 'state.json'), 'utf8'))).pid).toBe(first.pid);

    const second = await r.mcs(['start', '--task', SLUG, '--port', String(r.port)]);
    expect(second.code, second.stderr).toBe(0);
    expect(await previousRunUnclean(r.port)).toBe(true);

    // the lines of the dead time are read, the lines read twice are not stored twice, and the transcript is caught up
    await waitFor(() => factsOf(r.dbPath).notifications === sent, {
      what: `${String(sent)} notification events after the restart`,
      timeoutMs: 60_000,
      intervalMs: 200,
    });
    await waitFor(
      async () => {
        const reply = await httpRequest(r.port, routes.getSession.path.replace(':sessionId', SESSION));
        if (reply.status !== 200) return false;
        const { files } = routes.getSession.response.parse(JSON.parse(reply.body));
        return files.length > 0 && files.every((file) => file.behindBytes === 0 && file.state === 'active');
      },
      { what: 'the transcript caught up after the restart', timeoutMs: 120_000, intervalMs: 500 },
    );
    const settled = factsOf(r.dbPath);
    expect(settled.notifications).toBe(sent);
    expect(settled.hookEvents).toBe(sent);
    expect(settled.distinctUids).toBe(sent);

    // replay of the whole spool through the control channel: every line is read again and is a duplicate
    const token = readFileSync(join(r.dir, 'run', 'control.token'), 'utf8').trim();
    const replied = await requestControl(
      controlAddressOf(r.instanceId()),
      { v: 1, op: 'ingest-replay', instanceId: r.instanceId(), token, fromSegment: null },
      { timeoutMs: 30_000 },
    );
    expect(replied.kind).toBe('reply');
    if (replied.kind === 'reply') expect(replied.response).toMatchObject({ ok: true, op: 'ingest-replay' });
    await waitFor(() => factsOf(r.dbPath).duplicates >= settled.duplicates + sent, {
      what: 'every line of the spool read again as a duplicate',
      timeoutMs: 60_000,
      intervalMs: 200,
    });

    const stopped = await r.mcs(['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    await assertPortClosed(r.port);
    const after = factsOf(r.dbPath);
    expect(after.integrity).toBe('ok');
    expect(after.notifications).toBe(sent);
    expect(after.hookEvents).toBe(sent);
    expect(after.distinctUids).toBe(sent);

    // a clean stop leaves nothing to recover from: the next start does not report an unclean previous run
    const third = await r.mcs(['start', '--task', SLUG, '--port', String(r.port)]);
    expect(third.code, third.stderr).toBe(0);
    expect(await previousRunUnclean(r.port)).toBe(false);
    await waitFor(() => factsOf(r.dbPath).notifications === sent, { what: 'the same events after a clean restart' });
    const final = await r.mcs(['stop', '--task', SLUG]);
    expect(final.code, final.stderr).toBe(0);
    expect(factsOf(r.dbPath)).toMatchObject({ integrity: 'ok', notifications: sent, hookEvents: sent });
  }, 600_000);
});
