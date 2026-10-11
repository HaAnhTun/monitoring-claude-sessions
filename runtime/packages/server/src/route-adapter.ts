// `registerRoute(app, route, handler)` (03 13 item 2): the one way a handler reaches Express. The route definition of
// `@mcs/shared` says the path, the parameters, the query and the response; this adapter validates the path parameters and the
// query with those schemas (400 `validation_failed` with Zod issue codes only, 400 `param_repeated` for a repeated key),
// calls the handler, validates the answer with `route.response` unless `NODE_ENV` is `production` (a mismatch is a 500 and a
// ring entry, never data on the wire), and maps every throw to the envelope. Route modules never touch `res` for a JSON route.
import type { InstanceContext, InstanceRuntime, Logger } from '@mcs/engine';
import type { RouteDefinition } from '@mcs/shared';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { ensureRequestId, mapError, sendError, type SendErrorOptions } from './errors.ts';

/** One entry of the server error ring, without the optional session id. */
export interface RingEntry {
  readonly source: string;
  readonly code: string;
  readonly where: string | null;
  readonly message: string;
}

/** What the adapter needs from the instance: where to record an unexpected failure, where to log, whether to validate. */
export interface RouteServices {
  /** The server error ring (03 6.2): `source 'server'`, `code 'INTERNAL'`, `where` = route id; never request data. */
  readonly errors: { push(entry: RingEntry): void };
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Validate every JSON response with `route.response` (03 13 item 2; registry N3: off only when `NODE_ENV === 'production'`). */
  readonly validateResponses: boolean;
}

/** The `NODE_ENV` rule of 03 13 item 2. Nothing sets `NODE_ENV` for the detached server, so validation stays on (registry N3). */
export function defaultValidateResponses(): boolean {
  return process.env['NODE_ENV'] !== 'production';
}

const silent = (): void => undefined;
const FALLBACK_SERVICES: RouteServices = {
  errors: { push: silent },
  logger: { debug: silent, info: silent, warn: silent, error: silent },
  validateResponses: true,
};

interface AppTable {
  services: RouteServices;
  readonly routes: RouteDefinition[];
}

const tables = new WeakMap<Express, AppTable>();

function tableOf(app: Express): AppTable {
  let table = tables.get(app);
  if (table === undefined) {
    table = { services: { ...FALLBACK_SERVICES, validateResponses: defaultValidateResponses() }, routes: [] };
    tables.set(app, table);
  }
  return table;
}

/** Binds the services of one instance to an app, before or after routes are registered on it. */
export function bindRouteServices(app: Express, services: RouteServices): void {
  tableOf(app).services = services;
}

/** The routes registered on `app` through `registerRoute`, in registration order. */
export function mountedRoutes(app: Express): readonly RouteDefinition[] {
  return [...tableOf(app).routes];
}

// ---- what a route module receives ------------------------------------------------------------------------------------------

/** The part of the instance context that the HTTP layer uses (03 12.1: routes call `ctx.queries`, nothing else reads the DB). */
export type AppContext = Pick<
  InstanceContext,
  'instanceId' | 'slug' | 'clock' | 'scope' | 'queries' | 'errors' | 'logger' | 'process' | 'config' | 'instance'
>;

/** `task.json` as the legacy health body shows it (`task_brief()`): the id, the name and the description (default empty). */
export interface LegacyTask {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Everything a route module needs; `createApp` passes the same object to every module. */
export interface RouteDeps {
  readonly ctx: AppContext;
  /** `IngestService.nudge()`: schedule a spool drain and return at once (02 2.8). */
  readonly nudge: () => void;
  /** `null` when the workspace has no readable `task.json`. */
  readonly task: LegacyTask | null;
  /**
   * The instance runtime (01 4.4 step 8, 4.4a): `runtime.panels` for the panels route, the ingest and stream services of later
   * routes. Absent in an app that has no runtime (the unit tests of one route); a module that needs it throws when it is
   * mounted without one. A later work package that needs a service adds it to the runtime, not to this object.
   */
  readonly runtime?: InstanceRuntime | undefined;
}

/** A group of routes: it registers its handlers with `registerRoute`. `app.ts` lists the modules (plan section 4.2). */
export type RouteModule = (app: Express, deps: RouteDeps) => void;

// ---- the handler contract ------------------------------------------------------------------------------------------------

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

/** What a handler receives: the parsed path parameters and query, and the request for the rest. */
export interface RouteInput<R extends RouteDefinition = RouteDefinition> {
  readonly params: Parsed<R['params']>;
  readonly query: Parsed<R['query']>;
  readonly req: Request;
  readonly res: Response;
  /** Fires when the client goes away before the response ended (03 6.4): long work checks it between chunks. */
  readonly signal: AbortSignal;
  /** `X-Request-Id` of this response. */
  readonly requestId: string;
}

/** A JSON route returns its body; a `204` route returns nothing; a stream or export route writes `res` itself. */
export type RouteHandler<R extends RouteDefinition = RouteDefinition> = R['response'] extends z.ZodType
  ? (input: RouteInput<R>) => z.input<R['response']> | Promise<z.input<R['response']>>
  : (input: RouteInput<R>) => void | Promise<void>;

export interface RegisterRouteOptions {
  /** Guards that run after the route matched and before the parameters are parsed (for example the nudge guard of 03 5.2 step 7). */
  readonly before?: readonly RequestHandler[];
}

// ---- parsing -----------------------------------------------------------------------------------------------------------------

interface ParseFailure {
  readonly code: 'validation_failed' | 'param_repeated';
  readonly details?: SendErrorOptions['details'];
}

type ParseOutcome =
  | { readonly ok: true; readonly params: Record<string, unknown> | undefined; readonly query: unknown }
  | ({ readonly ok: false } & ParseFailure);

/** At most this many issues are listed in `details`. */
const MAX_DETAILS = 10;

function detailsOf(issues: readonly z.core.$ZodIssue[]): NonNullable<SendErrorOptions['details']> {
  return issues.slice(0, MAX_DETAILS).map((issue) => ({ path: issue.path.map(String).join('.'), issue: issue.code }));
}

function parseRequest(route: RouteDefinition, req: Request): ParseOutcome {
  let params: Record<string, unknown> | undefined;
  if (route.params !== null) {
    const checked = route.params.safeParse(req.params);
    if (!checked.success) return { ok: false, code: 'validation_failed', details: detailsOf(checked.error.issues) };
    params = checked.data;
  }
  // Express 5 parses the query with the `simple` parser: a repeated key is an array (exp X6). Lists are comma separated.
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(req.query));
  if (Object.values(raw).some((value) => Array.isArray(value))) return { ok: false, code: 'param_repeated' };
  if (route.query === null) {
    // a route without a query schema takes no query at all, like a strict empty object
    if (Object.keys(raw).length > 0)
      return { ok: false, code: 'validation_failed', details: [{ path: '', issue: 'unrecognized_keys' }] };
    return { ok: true, params, query: undefined };
  }
  const checked = route.query.safeParse(raw);
  if (!checked.success) return { ok: false, code: 'validation_failed', details: detailsOf(checked.error.issues) };
  return { ok: true, params, query: checked.data };
}

// ---- registration --------------------------------------------------------------------------------------------------------------

function fail(services: RouteServices, route: RouteDefinition, message: string): void {
  services.errors.push({ source: 'server', code: 'INTERNAL', where: route.id, message });
  services.logger.error('route_failed', { route: route.id, code: 'INTERNAL' });
}

async function handle(
  route: RouteDefinition,
  handler: (input: RouteInput) => unknown,
  services: RouteServices,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = parseRequest(route, req);
  if (!parsed.ok) {
    sendError(res, parsed.code, parsed.details === undefined ? {} : { details: parsed.details });
    return;
  }
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const requestId = ensureRequestId(res);
  try {
    const result = await handler({
      params: parsed.params,
      query: parsed.query,
      req,
      res,
      signal: controller.signal,
      requestId,
    });
    if (res.headersSent) return; // the handler answered itself (a stream, an export)
    if (route.response === null) {
      if (route.successStatus === 204) {
        res.status(204).end();
        return;
      }
      fail(services, route, 'the handler of a stream route did not answer');
      sendError(res, 'internal_error');
      return;
    }
    if (services.validateResponses) {
      const checked = route.response.safeParse(result);
      if (!checked.success) {
        fail(services, route, 'the response did not match its schema');
        services.logger.error('response_invalid', { route: route.id, count: checked.error.issues.length });
        sendError(res, 'internal_error');
        return;
      }
    }
    res.status(route.successStatus).json(result);
  } catch (error: unknown) {
    const mapped = mapError(error);
    if (mapped.internal) fail(services, route, 'unexpected error in the route handler');
    sendError(res, mapped.code, mapped.details === undefined ? {} : { details: mapped.details });
  }
}

/**
 * Registers `handler` for `route` on `app` (GET or POST of the route definition). Throws when the route id or the method
 * and path pair is already registered. The services come from `bindRouteServices`.
 */
export function registerRoute<R extends RouteDefinition>(
  app: Express,
  route: R,
  handler: RouteHandler<R>,
  options?: RegisterRouteOptions,
): void;
export function registerRoute(
  app: Express,
  route: RouteDefinition,
  handler: (input: RouteInput) => unknown,
  options: RegisterRouteOptions = {},
): void {
  const table = tableOf(app);
  for (const known of table.routes) {
    if (known.id === route.id) throw new Error(`route ${route.id} is already registered`);
    if (known.method === route.method && known.path === route.path) {
      throw new Error(`${route.method} ${route.path} is already registered as route ${known.id}`);
    }
  }
  table.routes.push(route);
  const routeId: RequestHandler = (_req, res, next) => {
    res.locals['routeId'] = route.id;
    next();
  };
  const run: RequestHandler = async (req, res) => {
    await handle(route, handler, table.services, req, res);
  };
  const chain = [routeId, ...(options.before ?? []), run];
  if (route.method === 'GET') app.get(route.path, ...chain);
  else app.post(route.path, ...chain);
}
