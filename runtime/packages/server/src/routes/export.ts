// `GET /api/v3/export` (03 11.1, 6.1, ADR 0028): streams the instance as `mcs.export/1` JSON lines (`application/x-ndjson`).
//
// The route never reads the writer connection of the server. It makes an online backup of the database into
// `<workspace>/data/exports/.tmp-<random>.db`, opens that copy read-only and exports from it, so the export is one consistent
// snapshot while ingestion goes on. The copy is deleted in `finally`: after the last byte, after a failure, when the client goes
// away (the abort signal of the adapter) and when the server shuts down (the connections are closed, which aborts the export).
// No request value names a path: the copy has a random name in the one folder. One export runs at a time (`429 export_busy`,
// `Retry-After: 2`). There is no size cap and no buffering of the whole export: the lines are written as they are read.
//
// Failures before the first byte become the JSON error envelope. A failure after the stream began destroys the connection:
// a clean end would look like a whole export, and an export without its trailer line is how a reader knows it is cut.
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  assertExportable,
  backupDb,
  exportInstance,
  openInstanceDb,
  type ExportContext,
  type InstanceDb,
} from '@mcs/engine';
import { routes, type ErrorCode } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type AppContext, type RouteModule } from '../route-adapter.ts';

/** The route needs the writer connection (the source of the copy) and the folder of the instance. */
type ExportRouteContext = AppContext & { readonly db: InstanceDb; readonly instanceDir: string };

function hasStorage(ctx: AppContext): ctx is ExportRouteContext {
  return (
    'db' in ctx &&
    typeof ctx.db === 'object' &&
    ctx.db !== null &&
    'instanceDir' in ctx &&
    typeof ctx.instanceDir === 'string'
  );
}

/** The 400 codes a refusal of the engine carries; recognised by the class name, like the other routes. */
function refusalCodeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error) || error.name !== 'QueryRefusal') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return code === 'range_invalid' || code === 'range_too_large' ? code : undefined;
}

/** A slug is already limited to lower-case letters, digits and hyphens; anything else would not be a safe part of a file name. */
function fileSafe(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** What a test may look at or replace; production passes nothing. */
export interface ExportRouteOptions {
  /** Replaces the export itself (a test makes it fail). */
  readonly exportInstance?: typeof exportInstance;
  /** Called with the path of the copy once it exists. */
  readonly onSnapshot?: (file: string) => void;
}

/** The copy and the files SQLite may have left next to it. */
async function removeSnapshot(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await rm(`${file}${suffix}`, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export function createExportRoutes(options: ExportRouteOptions = {}): RouteModule {
  const run = options.exportInstance ?? exportInstance;
  return (app, { ctx }) => {
    let running = false;

    registerRoute(app, routes.export, async ({ query, req, res, signal }) => {
      if (!hasStorage(ctx)) throw new ApiError('internal_error');
      const header = (): void => {
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="mcs-export-${fileSafe(ctx.slug)}.jsonl"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
      };
      if (req.method === 'HEAD') {
        // the headers of an export without the work of one
        header();
        res.end();
        return;
      }
      const context: ExportContext = {
        instanceId: ctx.instanceId,
        slug: ctx.slug,
        runtimeVersion: ctx.process.runtimeVersion,
        config: ctx.config,
        clock: ctx.clock,
        // the entries of a transcript are read through the live instance: its entry index lives in the writable database
        transcripts: ctx.queries,
      };
      // a query that no export can answer is a plain 400, before a copy is made and before any header is sent
      try {
        assertExportable(context, query);
      } catch (error: unknown) {
        const code = refusalCodeOf(error);
        throw code === undefined ? error : new ApiError(code, { cause: error });
      }
      if (running) throw new ApiError('export_busy');
      running = true;
      let snapshot: string | null = null;
      let copy: InstanceDb | null = null;
      try {
        const folder = path.join(ctx.instanceDir, 'data', 'exports');
        await mkdir(folder, { recursive: true });
        snapshot = path.join(folder, `.tmp-${randomBytes(8).toString('hex')}.db`);
        await backupDb(ctx.db, snapshot);
        options.onSnapshot?.(snapshot);
        signal.throwIfAborted();
        copy = openInstanceDb({
          path: snapshot,
          expectedInstanceId: ctx.instanceId,
          mode: 'readonly',
          runtimeVersion: ctx.process.runtimeVersion,
        });
        header();
        res.flushHeaders();
        const summary = await run(copy, context, query, res, signal);
        // the copy goes before the last byte: a client that has the whole export knows the copy is already gone
        copy.close();
        copy = null;
        await removeSnapshot(snapshot);
        snapshot = null;
        res.end();
        ctx.logger.info('export_done', { count: summary.lines, bytes: summary.bytes });
      } catch (error: unknown) {
        if (signal.aborted) {
          // the client left, or the server is closing its connections: nobody reads an answer
          if (!res.headersSent) res.end();
          else res.destroy();
          return;
        }
        if (res.headersSent) {
          res.destroy();
          ctx.logger.warn('export_failed', { code: error instanceof Error ? error.name : 'unknown' });
        }
        throw error;
      } finally {
        copy?.close();
        if (snapshot !== null) await removeSnapshot(snapshot);
        running = false;
      }
    });
  };
}

/** The module `app.ts` mounts. */
export const exportRoutes: RouteModule = createExportRoutes();
