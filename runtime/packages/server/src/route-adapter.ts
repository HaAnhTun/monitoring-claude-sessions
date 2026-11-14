// `registerRoute(app, route, handler)` (03 13 item 2): the one way a handler reaches Express. The route definition of
// `@mcs/shared` says the path, the parameters, the query, the body and the response; this adapter validates the path parameters
// and the query with those schemas (400 `validation_failed` with Zod issue codes only, 400 `param_repeated` for a repeated key),
// calls the handler, validates the answer with `route.response` unless `NODE_ENV` is `production` (a mismatch is a 500 and a
// ring entry, never data on the wire), and maps every throw to the envelope. Route modules never touch `res` for a JSON route.
//
// It also builds the per-route guard chain from the definition (CAW design 02 3, ADR 0084), in this order:
//   1. the route id marker;  2. `csrfGuard` on every POST unless the route registers with `csrf: false` (the hook nudge);
//   3. the access guard of `route.access` (`session`, `reader`, `ticket`; none for `open`);  4. the `before` guards of the route;
//   5. params and query, then the body of a POST route: at most `route.maxBodyBytes` (413), strict UTF-8 JSON (400), the strict
//      schema of the route (400 with paths and issue codes only);  6. the handler.
// Fail closed: a `session` or `ticket` route cannot be mounted on an app that has no access service (it throws, naming the
// route), while a `reader` route on such an app (a task instance) is served open, as it always was.
import type { InstanceContext, InstanceRuntime, Logger } from '@mcs/engine';
import { classifyQueryIssues, type ErrorCode, type RouteDefinition } from '@mcs/shared';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { ensureRequestId, mapError, sendError, type SendErrorOptions } from './errors.ts';
import { accessGuard, type AccessVerifier } from './http/access-guard.ts';
import { csrfGuard, parseJson, readCapped, type PortSource } from './http/guards.ts';

/** One entry of the server error ring, without the optional session id. */
export interface RingEntry {
  readonly source: string;
  readonly code: string;
  readonly where: string | null;
  readonly message: string;
}

/** The access service of a user instance as the adapter uses it: who may call (the verifier) and the port for the Origin check. */
export interface AccessBinding {
  readonly verifier: AccessVerifier;
  /** The bound port, or a function that reads it when a request arrives (the server may scan for a free port first). */
  readonly port: PortSource;
}

/** What the adapter needs from the instance: where to record an unexpected failure, where to log, whether to validate. */
export interface RouteServices {
  /** The server error ring (03 6.2): `source 'server'`, `code 'INTERNAL'`, `where` = route id; never request data. */
  readonly errors: { push(entry: RingEntry): void };
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Validate every JSON response with `route.response` (03 13 item 2; registry N3: off only when `NODE_ENV === 'production'`). */
  readonly validateResponses: boolean;
  /**
   * The access service of a user instance, or `null`/absent on a task instance. Without it a `reader` route is served open and a
   * `session` or `ticket` route cannot be mounted (fail closed).
   */
  readonly access?: AccessBinding | null;
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
  access: null,
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
  'instanceId' | 'slug' | 'clock' | 'scope' | 'db' | 'queries' | 'errors' | 'logger' | 'process' | 'config' | 'instance'
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

/** What a handler receives: the parsed path parameters, query and body, and the request for the rest. */
export interface RouteInput<R extends RouteDefinition = RouteDefinition> {
  readonly params: Parsed<R['params']>;
  readonly query: Parsed<R['query']>;
  /** The body, parsed with `route.body` (a route without a body schema, and every GET, gets `undefined`). */
  readonly body: Parsed<R['body']>;
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
  /**
   * Guards that run after the route matched and its csrf and access guards passed, and before the parameters and the body are
   * parsed (for example the nudge guard of 03 5.2 step 7).
   */
  readonly before?: readonly RequestHandler[];
  /**
   * `false` leaves out the csrf guard of a POST route (JSON content type and `X-MCS-Request`). Only the hook nudge does this:
   * the hook handler is not a browser, and its own guard in `before` is stricter. Default: true.
   */
  readonly csrf?: boolean;
  /**
   * A guard in `before` already read the body and published the validated value as `res.locals.body` (the nudge guard does): the
   * adapter takes it from there, checks it with `route.body` and does not read the request again.
   */
  readonly bodyConsumed?: boolean;
}

// ---- parsing -----------------------------------------------------------------------------------------------------------------

interface ParseFailure {
  readonly code: ErrorCode;
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
  // A `q` below its minimum is `query_too_short` (03 5.2); every other failure stays `validation_failed`, details unchanged.
  if (!checked.success)
    return { ok: false, code: classifyQueryIssues(checked.error.issues), details: detailsOf(checked.error.issues) };
  return { ok: true, params, query: checked.data };
}

// ---- registration --------------------------------------------------------------------------------------------------------------

function fail(services: RouteServices, route: RouteDefinition, message: string): void {
  services.errors.push({ source: 'server', code: 'INTERNAL', where: route.id, message });
  services.logger.error('route_failed', { route: route.id, code: 'INTERNAL' });
}

type BodyOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * The body of a POST route (design 02 3 step 5): read up to `route.maxBodyBytes` (the declared length first, then the streamed
 * byte count), strict UTF-8 JSON, then the strict schema of the route. Every refusal is answered here, with the connection closed
 * when the rest of the body is unread. A client that disappears first gets no answer.
 */
async function bodyOf(
  route: RouteDefinition,
  schema: z.ZodType,
  services: RouteServices,
  req: Request,
  res: Response,
  consumed: boolean,
): Promise<BodyOutcome> {
  let value: unknown;
  if (consumed) {
    value = res.locals['body'];
    if (value === undefined) {
      // the guard that was to publish the body did not: a fault of the route registration, never the client's
      fail(services, route, 'a guard consumed the body and did not publish it');
      sendError(res, 'internal_error');
      return { ok: false };
    }
  } else {
    const read = await readCapped(req, route.maxBodyBytes);
    if (read.kind === 'aborted') return { ok: false };
    if (read.kind === 'too_large') {
      sendError(res, 'payload_too_large', { closeConnection: true });
      return { ok: false };
    }
    const json = parseJson(read.bytes);
    if (!json.ok) {
      sendError(res, 'body_invalid_json');
      return { ok: false };
    }
    value = json.value;
  }
  const checked = schema.safeParse(value);
  if (!checked.success) {
    sendError(res, 'validation_failed', { details: detailsOf(checked.error.issues) });
    return { ok: false };
  }
  return { ok: true, value: checked.data };
}

async function handle(
  route: RouteDefinition,
  handler: (input: RouteInput) => unknown,
  services: RouteServices,
  options: RegisterRouteOptions,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = parseRequest(route, req);
  if (!parsed.ok) {
    sendError(res, parsed.code, parsed.details === undefined ? {} : { details: parsed.details });
    return;
  }
  let body: unknown;
  if (route.method === 'POST' && route.body !== null) {
    const outcome = await bodyOf(route, route.body, services, req, res, options.bodyConsumed === true);
    if (!outcome.ok) return;
    body = outcome.value;
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
      body,
      req,
      res,
      signal: controller.signal,
      requestId,
    });
    // the handler answered itself (a stream, an export), or will finish the response later (the socket route completes its upgrade)
    if (res.headersSent || res.locals['handled'] === true) return;
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
 * The access guard of one route, resolved on every request from the services bound to the app: a `reader` route is open while no
 * access service is bound (a task instance); a `session` or `ticket` route then refuses everything (it cannot be mounted without
 * one, so this covers an app whose access service was taken away afterwards). `requireOrigin` holds for every write and for the
 * socket route.
 */
function accessChain(
  table: AppTable,
  route: RouteDefinition,
  access: Exclude<RouteDefinition['access'], 'open'>,
): RequestHandler {
  const requireOrigin = route.method !== 'GET' || route.contentType === 'websocket';
  let built: { readonly binding: AccessBinding; readonly guard: RequestHandler } | undefined;
  return (req, res, next) => {
    const binding = table.services.access;
    if (binding === null || binding === undefined) {
      if (access === 'reader') {
        next();
        return;
      }
      sendError(res, 'access_required', route.method === 'GET' ? {} : { closeConnection: true });
      return;
    }
    if (built?.binding !== binding) {
      built = { binding, guard: accessGuard(binding.verifier, { access, requireOrigin, port: binding.port }) };
    }
    built.guard(req, res, next);
  };
}

/**
 * Registers `handler` for `route` on `app` (GET or POST of the route definition). Throws when the route id or the method
 * and path pair is already registered, and when a `session` or `ticket` route has no access service to answer to (fail
 * closed). The services come from `bindRouteServices`.
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
  if (
    (route.access === 'session' || route.access === 'ticket') &&
    (table.services.access === null || table.services.access === undefined)
  ) {
    throw new Error(`route ${route.id} has access '${route.access}' and this app has no access service bound`);
  }
  table.routes.push(route);
  const routeId: RequestHandler = (_req, res, next) => {
    res.locals['routeId'] = route.id;
    next();
  };
  const run: RequestHandler = async (req, res) => {
    await handle(route, handler, table.services, options, req, res);
  };
  const chain: RequestHandler[] = [routeId];
  if (route.method === 'POST' && options.csrf !== false) chain.push(csrfGuard());
  if (route.access !== 'open') chain.push(accessChain(table, route, route.access));
  chain.push(...(options.before ?? []), run);
  if (route.method === 'GET') app.get(route.path, ...chain);
  else app.post(route.path, ...chain);
}
