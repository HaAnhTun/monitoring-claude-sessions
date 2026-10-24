// `DbReader` (01 6.1, 03 12.2): the reader of an instance that does not run. It opens the database `readonly` (`query_only`, no
// write transaction exists on such a connection) and calls the same engine query functions the server routes call, then puts
// every result through the response schema of its route after a JSON round trip, so that the bytes it returns are the bytes the
// `ApiReader` gets from the same route. It never writes: no file of the workspace is created or changed by a read.
//
// The transcript window and the content search keep their entry index in the database, which a read-only connection cannot
// update. Those methods (and the export of transcript text) work on a private copy of the database made with the SQLite online backup
// into a fresh folder below the temporary directory, which is removed by `close`. The copy is made on first use, so every other
// method costs nothing for it, and it is never inside the workspace.
import { mkdtemp, rm, rmdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  McsError,
  RUNTIME_VERSION,
  SessionIdSchema,
  routes,
  type ExportSummary,
  type RouteDefinition,
} from '@mcs/shared';
import type { z } from 'zod';

import { entriesBetween } from '../audit/reader.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { backupDb } from '../db/backup.ts';
import { isDbError } from '../db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { CompletionTargetError } from '../lifecycle/completion.ts';
import { exportInstance, type ExportContext } from '../maintenance/export.ts';
import { dbFailure, migrationsOf } from '../ops/backup.ts';
import { createQueries, type Queries } from '../query/index.ts';
import { NotFoundError, QueryRefusal } from '../query/transitions.ts';
import { SearchBusyError } from '../search/service.ts';
import { TranscriptError } from '../transcript/index-service.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { parseBody, readerErrorOfCode, type InstanceReader, type ReaderDeps } from './open.ts';

/** A route with a JSON response of schema `S`: the schema the result is checked with. */
type JsonRoute<S extends z.ZodType> = RouteDefinition<
  string,
  z.ZodObject | null,
  z.ZodType | null,
  z.ZodType | null,
  S
>;

/** The error the API would have answered for a failure of the query layer (`readerErrorOfCode` is the shared mapping). */
export function readerFailureOf(error: unknown): Error {
  if (error instanceof McsError) return error;
  // `exportInstance` refuses `includeContent` with strict redaction before the first byte (the route answers 400 for it)
  if (error instanceof RangeError) return readerErrorOfCode('validation_failed');
  if (error instanceof QueryRefusal || error instanceof NotFoundError) return readerErrorOfCode(error.code);
  if (error instanceof TranscriptError)
    return readerErrorOfCode(error.code === 'aborted' ? 'internal_error' : error.code);
  if (error instanceof SearchBusyError) return readerErrorOfCode('search_busy');
  if (error instanceof CompletionTargetError) {
    return error.code === 'target_invalid'
      ? new McsError('USAGE', 'the completion target is not valid', { details: { reason: 'target_invalid' } })
      : new McsError('NOT_FOUND', 'no run matches the completion target', { details: { reason: 'target_not_found' } });
  }
  if (isDbError(error)) {
    const mapped = dbFailure(error);
    return mapped instanceof Error ? mapped : error;
  }
  return error instanceof Error ? error : new McsError('INTERNAL', 'the query layer failed');
}

/** Runs a synchronous query as a promise: a failure is a rejection with the mapped error, never a throw. */
function sync<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(readerFailureOf(error));
  }
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw readerFailureOf(error);
  }
}

/** The result as the API would send it: a JSON round trip, then the response schema of the route (strict, like the client's). */
function wire<S extends z.ZodType>(route: JsonRoute<S>, value: unknown): z.output<S> {
  const checked = parseBody(route.response, JSON.parse(JSON.stringify(value)));
  if (!checked.ok) {
    throw new McsError(
      'INTERNAL',
      `the query layer produced a body for ${route.id} that does not match the API contract`,
      {
        details: { reason: 'contract', route: route.id },
      },
    );
  }
  return checked.data;
}

function validId(id: string): string {
  if (!SessionIdSchema.safeParse(id).success) {
    throw new McsError('USAGE', 'the session id is not valid', { details: { reason: 'validation_failed' } });
  }
  return id;
}

/** The private writable copy of the database that the transcript methods use. */
interface Scratch {
  readonly dir: string;
  readonly file: string;
  readonly db: InstanceDb;
  readonly queries: Queries;
}

const SCRATCH_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

async function removeScratch(scratch: { readonly dir: string; readonly file: string }): Promise<void> {
  for (const suffix of SCRATCH_SUFFIXES) {
    await rm(`${scratch.file}${suffix}`, { force: true, maxRetries: 5, retryDelay: 50 });
  }
  await rmdir(scratch.dir).catch(() => undefined);
}

export interface DbReaderOptions {
  /**
   * The instance is known not to run (the probe said `stopped` or `stale`). The database is then read as an immutable file when
   * it has no committed frames in a `-wal` file, so a read leaves no `-wal` or `-shm` file behind (SQLite creates both for a
   * read-only connection to a WAL database otherwise). Without it, or with frames waiting, the usual read-only open is used.
   */
  readonly stopped?: boolean;
}

/** True when the `-wal` file of the database is absent or empty: nothing committed is waiting in it. */
async function walIsEmpty(file: string): Promise<boolean> {
  const wal = await lstat(`${file}-wal`).catch(() => null);
  return wal === null || wal.size === 0;
}

/**
 * Opens the database of the instance read-only and returns the reader. `DB_UPGRADE_REQUIRED` for an older schema,
 * `DB_NEWER_THAN_RUNTIME` for a newer one (nothing is written either way), `IDENTITY_MISMATCH` for the database of another instance.
 */
export async function openDbReader(
  ws: WorkspaceRef,
  instanceId: string,
  deps: ReaderDeps,
  options: DbReaderOptions = {},
): Promise<InstanceReader> {
  const file = workspacePath(ws, 'data', 'monitor.db');
  const entry = await lstat(file).catch(() => null);
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) {
    throw new McsError('DB_ERROR', `task '${ws.slug}' has no database yet; the monitor has not run`, {
      hint: `start it once with \`mcs start --task ${ws.slug}\``,
      details: { reason: 'no_database' },
    });
  }
  const config: ResolvedConfig = await resolveConfig({
    workspace: ws,
    env: deps.env,
    cli: {},
    skillDir: deps.skillDir,
  });
  const location = migrationsOf(deps, deps);
  const immutable = options.stopped === true && (await walIsEmpty(file));
  const open = (path: string, mode: 'readonly' | 'maintenance', asFile = false): InstanceDb => {
    try {
      return openInstanceDb({
        path,
        expectedInstanceId: instanceId,
        mode,
        ...(asFile ? { immutable: true } : {}),
        runtimeVersion: RUNTIME_VERSION,
        clock: deps.clock,
        ...location,
      });
    } catch (error) {
      throw dbFailure(error);
    }
  };
  const queryDeps = {
    config,
    now: () => deps.clock.now(),
    audit: {
      entriesBetween: (fromMs: number, toMs: number, limit: number) =>
        entriesBetween(ws, fromMs, toMs, limit, deps.log === undefined ? {} : { log: deps.log }),
    },
  };
  const db = open(file, 'readonly', immutable);
  let queries: Queries;
  try {
    queries = createQueries(db, queryDeps);
  } catch (error) {
    db.close();
    throw error;
  }
  const scope: RepoContext = { instanceId };
  let scratch: Promise<Scratch> | null = null;
  let closed = false;

  /** The private copy, made on first use. */
  function scratchOf(): Promise<Scratch> {
    scratch ??= (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'mcs-reader-'));
      const target = path.join(dir, 'reader.db');
      try {
        await backupDb(db, target);
        const copy = open(target, 'maintenance');
        return { dir, file: target, db: copy, queries: createQueries(copy, queryDeps) };
      } catch (error) {
        await removeScratch({ dir, file: target });
        throw error;
      }
    })();
    // a failed attempt is not kept: the next call tries again
    scratch.catch(() => {
      scratch = null;
    });
    return scratch;
  }

  const signal = new AbortController().signal;

  return {
    mode: 'db',
    instanceId,
    sessions: (q) => sync(() => wire(routes.listSessions, queries.listSessions(scope, q))),
    session: async (id) => {
      const checked = validId(id);
      return guarded(async () => {
        let detail: ReturnType<Queries['getSession']>;
        try {
          detail = queries.getSession(scope, checked);
        } catch (error) {
          if (error instanceof NotFoundError && error.code === 'session_not_found') return null;
          throw error;
        }
        const auditRefs = await queries.sessionAuditRefs(detail);
        return wire(routes.getSession, { ...detail, auditRefs });
      });
    },
    sessionAgents: (id, q) => sync(() => wire(routes.sessionAgents, queries.sessionAgents(scope, validId(id), q))),
    sessionEvents: (id, q) =>
      sync(() =>
        wire(
          routes.sessionTimeline,
          queries.listEvents(scope, { ...q, session: [validId(id)] }, { pathSession: true }),
        ),
      ),
    usage: (q) => sync(() => wire(routes.analyticsUsage, queries.usage(scope, q))),
    series: (q) => sync(() => wire(routes.analyticsSeries, queries.series(scope, q))),
    tools: (q) => sync(() => wire(routes.analyticsTools, queries.tools(scope, q))),
    errors: (q) => sync(() => wire(routes.errors, queries.errors(scope, q)).items),
    overview: (q) => sync(() => wire(routes.overview, queries.overview(scope, q))),
    alerts: (q) => sync(() => wire(routes.listAlerts, queries.listAlerts(scope, q))),
    explainCompletion: (target) => sync(() => wire(routes.explainCompletion, queries.explainCompletion(scope, target))),
    searchTranscript: (q) =>
      guarded(async () => {
        const copy = await scratchOf();
        return wire(routes.searchTranscript, await copy.queries.searchSession(scope, q, signal));
      }),
    searchTranscripts: (q) =>
      guarded(async () => {
        const copy = await scratchOf();
        return wire(routes.searchTranscripts, await copy.queries.searchInstance(scope, q, signal));
      }),
    transcriptWindow: ({ sessionId, ...query }) =>
      guarded(async () => {
        const copy = await scratchOf();
        return wire(
          routes.transcriptWindow,
          await copy.queries.window(scope, { ...query, sessionId: validId(sessionId) }, signal),
        );
      }),
    exportTo: (q, out) =>
      guarded(async (): Promise<ExportSummary> => {
        const context: ExportContext = {
          instanceId,
          slug: ws.slug,
          runtimeVersion: RUNTIME_VERSION,
          config,
          clock: deps.clock,
          ...(q.includeContent === true ? { transcripts: (await scratchOf()).queries } : {}),
        };
        return exportInstance(db, context, q, out, signal);
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      const copy = await scratch?.catch(() => null);
      db.close();
      if (copy !== null && copy !== undefined) {
        copy.db.close();
        await removeScratch(copy);
      }
    },
  };
}
