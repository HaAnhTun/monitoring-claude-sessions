// Helpers of the isolation rows that need ingestion (WP-39): hooks switched on for an instance, a hook source that runs the real
// handler for a transcripts folder, a transcript that grows while an instance runs, and the readers that prove what an instance
// ingested (the ingest health route while it runs, the database file after it stopped). Everything is synthetic and lives in the
// temp roots of `_setup.ts`; the handler runs with the `MCS_HOME` of the pair, so it reads the route files that the instances
// wrote themselves.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openSqlite } from '@mcs/engine';
import { routes } from '@mcs/shared';
import type { HookEnvelopeV1 } from '@mcs/shared/protocol';
import { TranscriptBuilder, httpRequest, hookPayload, runHookHandler, type HookEventName } from '@mcs/testkit';
import { expect } from 'vitest';

import type { IsolatedWorkspace } from './_setup.ts';

export const forward = (path: string): string => path.replaceAll('\\', '/');

/** The transcripts folder of a task: below the Claude home of the pair, so the folder name tells whose it is. */
export const transcriptsFolder = (env: Record<string, string>, slug: string): string =>
  join(env['CLAUDE_CONFIG_DIR'] ?? '', 'projects', `FIXTURE-project-${slug}`);

/** `instance.json` of the workspace gets `hooks.enabled: true`, as `mcs hooks install` leaves it (the instance then publishes a route). */
export function enableHooks(ws: Pick<IsolatedWorkspace, 'dir'>): void {
  const file = join(ws.dir, 'instance.json');
  const instance = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...instance, hooks: { enabled: true } }, null, 2)}\n`);
}

/** Points `transcripts_dir` of the workspace at `dir` with the real `configure` (the instance must not run). */
export async function watchTranscriptsIn(ws: Pick<IsolatedWorkspace, 'slug' | 'mcs'>, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const run = await ws.mcs([
    'configure',
    '--task',
    ws.slug,
    '--set',
    `transcripts_dir=${JSON.stringify(dir)}`,
    '--reason',
    'isolation row',
  ]);
  expect(run.code, run.stderr).toBe(0);
}

/** Whatever the handler needs to route one session: the transcripts folder it lives in. */
export interface HookSource {
  readonly dir: string;
  readonly sessionId: string;
  /** Runs the real handler for one event and checks that it exited 0 and said nothing. */
  fire(event: HookEventName, extra?: Record<string, unknown>, env?: Record<string, string>): Promise<void>;
}

/** A session `sessionId` whose transcript lives in `dir`; the handler reads the routes in the `MCS_HOME` of `env`. */
export function hookSource(env: Record<string, string>, dir: string, sessionId: string): HookSource {
  const mcsHome = env['MCS_HOME'];
  if (mcsHome === undefined) throw new Error('hookSource: env needs MCS_HOME (use hermeticEnv)');
  const base = {
    sessionId,
    cwd: forward(join(dir, 'FIXTURE-cwd')),
    transcriptPath: `${forward(dir)}/${sessionId}.jsonl`,
  };
  return {
    dir,
    sessionId,
    fire: async (event, extra = {}, handlerEnv = {}) => {
      const result = await runHookHandler(hookPayload(event, base, extra), { mcsHome, event, env: handlerEnv });
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
        code: 0,
        stdout: '',
        stderr: '',
      });
    },
  };
}

/** A notification whose text differs per `n`, so that no two of them are one event to the duplicate rules. */
export function fireNotification(source: HookSource, n: number): Promise<void> {
  return source.fire('Notification', { message: `FIXTURE note ${String(n)}` });
}

/** The envelopes in the spool of the workspace, in file order. */
export function spoolEnvelopes(ws: Pick<IsolatedWorkspace, 'dir'>): HookEnvelopeV1[] {
  const dir = join(ws.dir, 'data', 'spool');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as HookEnvelopeV1),
    );
}

/** `GET <path>` of a running instance, parsed with the schema of the route. */
async function getFrom(port: number, path: string): Promise<unknown> {
  const reply = await httpRequest(port, path);
  expect(reply.status, `${path} on port ${String(port)}`).toBe(200);
  return JSON.parse(reply.body);
}

/** The events of the session in its timeline on a running instance; 0 while the instance does not know the session. */
export async function timelineEvents(port: number, sessionId: string): Promise<number> {
  const path = `${routes.sessionTimeline.path.replace(':sessionId', sessionId)}?limit=200`;
  const reply = await httpRequest(port, path);
  if (reply.status === 404) return 0;
  expect(reply.status, `${path} on port ${String(port)}`).toBe(200);
  const page = routes.sessionTimeline.response.parse(JSON.parse(reply.body));
  expect(page.nextCursor, 'the timeline fits one page').toBeNull();
  return page.items.length;
}

export interface TokenFour {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/** The instance-wide token totals that `GET /api/v3/analytics/usage` reports (all time). */
export async function tokenTotals(port: number): Promise<TokenFour> {
  const report = routes.analyticsUsage.response.parse(
    await getFrom(port, `${routes.analyticsUsage.path}?groupBy=none&range=all`),
  );
  const { usage } = report.totals;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheCreation: usage.cacheCreation ?? 0,
  };
}

/** A transcript file that grows by whole turns while an instance watches its folder. */
export class GrowingTranscript {
  readonly file: string;
  readonly #builder: TranscriptBuilder;
  readonly #tag: string;
  #written = 0;
  #turns = 0;

  constructor(dir: string, sessionId: string, cwd: string, startMs: number) {
    this.file = join(dir, `${sessionId}.jsonl`);
    this.#tag = sessionId.slice(0, 8);
    this.#builder = new TranscriptBuilder({ sessionId, cwd, startMs });
  }

  /** One prompt and one answer of 10 / 20 / 100 / 5 tokens (input / output / cache read / cache creation). */
  turn(): void {
    this.#turns += 1;
    this.#builder.user(`FIXTURE prompt ${String(this.#turns)}`);
    this.#builder.assistant({
      messageId: `msg_wp39_${this.#tag}_${String(this.#turns).padStart(4, '0')}`,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      stop: 'end_turn',
    });
    if (this.#written === 0) this.#builder.write(this.file);
    else this.#builder.appendTo(this.file, this.#written);
    this.#written = this.#builder.lines().length;
  }

  get turns(): number {
    return this.#turns;
  }

  /** What the instance must report once it has read every turn written so far. */
  expected(): TokenFour {
    return {
      input: 10 * this.#turns,
      output: 20 * this.#turns,
      cacheRead: 100 * this.#turns,
      cacheCreation: 5 * this.#turns,
    };
  }
}

export interface DbFacts {
  readonly integrity: string;
  /** Events that came with an envelope (they carry an `event_uid`); transcript events do not. */
  readonly hookEvents: number;
  readonly distinctEventUids: number;
  readonly notifications: number;
}

/** The database of a stopped instance, opened read-only: the integrity check and the counts that the rows compare. */
export function inspectDatabase(dbPath: string): DbFacts {
  const db = openSqlite(dbPath, { readonly: true, fileMustExist: true, timeoutMs: 5000 });
  try {
    const one = (sql: string): number => db.prepare<{ n: number }>(sql).get()?.n ?? -1;
    return {
      integrity: db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()?.integrity_check ?? '',
      hookEvents: one('SELECT count(*) AS n FROM events WHERE event_uid IS NOT NULL'),
      distinctEventUids: one('SELECT count(DISTINCT event_uid) AS n FROM events WHERE event_uid IS NOT NULL'),
      notifications: one("SELECT count(*) AS n FROM events WHERE hook_event = 'Notification'"),
    };
  } finally {
    db.close();
  }
}

export interface Feeder {
  /** Stops after the round in flight and answers how many notifications each source sent, in the order of the sources. */
  stop(): Promise<number[]>;
}

/**
 * Appends one notification per source and round through the real handler, without a pause, until `stop()`. A round takes as
 * long as the slowest handler process, so the lines of the sources arrive a few times per second.
 */
export function startFeeder(sources: readonly HookSource[]): Feeder {
  const sent = sources.map(() => 0);
  const state = { stopping: false };
  const loop = (async (): Promise<void> => {
    while (!state.stopping) {
      await Promise.all(
        sources.map(async (source, i) => {
          await fireNotification(source, sent[i] ?? 0);
          sent[i] = (sent[i] ?? 0) + 1;
        }),
      );
    }
  })();
  // a failure of the loop is kept for `stop()`: nothing rejects unobserved while the test is busy elsewhere
  const outcome = loop.then(
    () => null,
    (error: unknown) => ({ error }),
  );
  return {
    stop: async () => {
      state.stopping = true;
      const failed = await outcome;
      if (failed !== null) throw failed.error;
      return [...sent];
    },
  };
}

/** The notification events committed so far, read from the database file of a workspace (a running instance may hold it open). */
export function countNotifications(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = openSqlite(dbPath, { readonly: true, fileMustExist: true, timeoutMs: 5000 });
  try {
    return (
      db.prepare<{ n: number }>("SELECT count(*) AS n FROM events WHERE hook_event = 'Notification'").get()?.n ?? -1
    );
  } finally {
    db.close();
  }
}
