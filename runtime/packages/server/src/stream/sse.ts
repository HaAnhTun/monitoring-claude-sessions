// `GET /api/v3/stream` (03 9.2, registry section 4): the route module of the stream. It reads the cursor, answers
// `503 stream_limit` before any byte of the stream is written, writes the SSE head with the headers of 9.2, and hands the
// response to the hub as a sink. The hub, the hydrator and the change-log reader are created when the first client connects
// and live as long as the app: an instance that nobody watches holds no listener and no timer.
import type { ServerResponse } from 'node:http';

import { ChangesRepo, bindHealthGauges, onCommitted } from '@mcs/engine';
import { routes } from '@mcs/shared';
import type { Response } from 'express';

import { ApiError } from '../errors.ts';
import { registerRoute, type AppContext, type RouteModule } from '../route-adapter.ts';
import { createHydrator, hydrationQueriesOf } from './hydrate.ts';
import {
  createStreamHub,
  type ChangeLog,
  type StreamCursor,
  type StreamHub,
  type StreamLimitOverrides,
  type StreamSink,
} from './hub.ts';

/** The change log of the instance: `ChangesRepo` of the engine, bound to the scope of the context. */
function changeLogOf(ctx: AppContext): ChangeLog {
  const repo = new ChangesRepo(ctx.db);
  return {
    head: () => repo.headSeq(ctx.scope),
    oldest: () => repo.oldestSeq(ctx.scope),
    since: (afterSeq, limit) => repo.since(ctx.scope, afterSeq, limit),
  };
}

/** A non-negative decimal integer of at most 15 digits (a seq is far below 2^53). */
const SEQ_TEXT = /^\d{1,15}$/;

/**
 * The cursor of a request (03 9.2): the `Last-Event-ID` header wins over `since`. A header that is present but empty counts as
 * absent (a browser never sends an empty one); a header that is not a non-negative integer is an invalid cursor.
 */
export function cursorOf(lastEventId: string | undefined, since: number | undefined): StreamCursor {
  const header = lastEventId?.trim();
  if (header !== undefined && header !== '') {
    return SEQ_TEXT.test(header) ? { kind: 'seq', seq: Number(header) } : { kind: 'invalid' };
  }
  return since === undefined ? { kind: 'none' } : { kind: 'seq', seq: since };
}

/** A header as one string: a repeated one is joined, which is never a valid cursor. */
function headerText(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' || value === undefined ? value : value.join(', ');
}

function sinkOf(res: Response): StreamSink {
  return {
    write: (chunk) => res.write(chunk),
    onceDrain: (callback) => {
      res.once('drain', callback);
    },
    destroy: () => {
      res.destroy();
    },
  };
}

/** What a test may look at or change; production passes nothing. */
export interface StreamRouteOptions {
  /** Shorter limits (the stall timeout, for example). */
  readonly limits?: StreamLimitOverrides;
  /** Called once, with the hub, when it is created. */
  readonly onHub?: (hub: StreamHub) => void;
  /** Called with the response of every accepted stream. */
  readonly onResponse?: (res: ServerResponse) => void;
}

export function createStreamRoutes(options: StreamRouteOptions = {}): RouteModule {
  return (app, { ctx }) => {
    let hub: StreamHub | undefined;
    // the health report counts the open streams (CR-WP-17-3); the hub exists only once somebody connected, so no hub is zero
    bindHealthGauges(ctx, { sseClients: () => hub?.size ?? 0 });
    const hubOf = (): StreamHub => {
      if (hub !== undefined) return hub;
      const { db } = ctx;
      const created = createStreamHub({
        log: changeLogOf(ctx),
        hydrate: createHydrator({
          instanceId: ctx.instanceId,
          queries: hydrationQueriesOf(ctx),
          now: () => ctx.clock.now(),
          logger: ctx.logger,
        }),
        subscribe: (listener) => onCommitted(db, listener),
        info: {
          instanceId: ctx.instanceId,
          epoch: db.epoch,
          runtimeVersion: ctx.process.runtimeVersion,
          codeStamp: ctx.process.bootCodeStamp,
        },
        now: () => ctx.clock.now(),
        logger: ctx.logger,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      hub = created;
      options.onHub?.(created);
      return created;
    };

    registerRoute(app, routes.stream, ({ query, req, res }) => {
      const streams = hubOf();
      if (!streams.hasCapacity()) throw new ApiError('stream_limit');
      if (res.destroyed || req.socket.destroyed) {
        res.end(); // the client left before the answer began
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);

      const handle = streams.accept(sinkOf(res), {
        cursor: cursorOf(headerText(req.headers['last-event-id']), query.since),
        epoch: query.epoch,
      });
      if (handle === null) {
        // another request took the last place between the check and here: single threaded, so it cannot happen, but never hang
        res.end();
        return;
      }
      options.onResponse?.(res);
      const release = (): void => {
        handle.close();
      };
      res.once('close', release);
      res.once('error', release);
    });
  };
}

/** The module `app.ts` mounts. */
export const streamRoutes: RouteModule = createStreamRoutes();
