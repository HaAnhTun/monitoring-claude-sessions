// The terminal side of the user instance as one object (CAW-32, design 02 section 9, ADR 0084): the route modules the boot code
// mounts beside the built-in ones, the upgrade registry its `http.on('upgrade')` listener is made from, and the one `close()` the
// shutdown awaits before the HTTP server closes. The pieces exist already (the auth routes, the terminal routes, the event feed,
// the socket route and its gateway, the folder routes); this module only builds them from the same host and the same access
// service, so that the boot code has one thing to wire and the sockets and streams have one thing to close.
//   - The modules are returned in a fixed order: auth, terminal, events, socket, folders (the last only with a folder service).
//   - `ports` is the terminal host or `null` (an instance without a usable host: the routes then say `terminal_unavailable`).
//   - `close()` ends every socket with 1001 `shutting_down` and waits for the grace of the gateway, then destroys the event
//     streams. It is idempotent and safe before any request. The server never starts a process; nothing here logs a name or a path.
import type { AccessService, Logger } from '@mcs/engine';

import type { AppContext, RouteModule } from '../route-adapter.ts';
import { createAuthRoutes } from '../routes/auth.ts';
import { createFolderRoutes, type FolderRoutesOptions } from '../routes/folders.ts';
import { createTerminalRoutes } from '../routes/terminal.ts';
import { createTerminalSocketRoutes } from '../routes/terminal-socket.ts';
import { createTerminalEventsRoutes, type TerminalEventLimits, type TerminalEvents } from './events.ts';
import { TERMINAL_CLOSE_REASONS, createTerminalGateway, type TerminalSocketLimits } from './gateway.ts';
import type { TerminalPorts } from './ports.ts';
import { createUpgradeRegistry, type UpgradeRegistry } from './upgrade.ts';

/** What the terminal side asks of the access service: the exchange and logout routes, the socket and the stream revocations. */
export type TerminalAccess = Pick<AccessService, 'exchange' | 'verify' | 'verifyBearer' | 'revoke' | 'onRevoked'>;

export interface TerminalServerOptions {
  /** The instance: its id names the cookie, its database gives the stream epoch, its clock stamps the state. */
  readonly ctx: Pick<AppContext, 'instanceId' | 'clock' | 'db'>;
  /** The terminal host, or `null` when the instance has none. */
  readonly ports: TerminalPorts | null;
  readonly access: TerminalAccess;
  /** The folder service of the sidebar; `null` or absent mounts no folder route. */
  readonly folders?: FolderRoutesOptions['folders'] | null;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Shorter limits and intervals (tests). */
  readonly limits?: { readonly socket?: Partial<TerminalSocketLimits>; readonly events?: Partial<TerminalEventLimits> };
}

export interface TerminalServer {
  /** The route modules to hand to `createApp` as `extraModules`. */
  readonly modules: readonly RouteModule[];
  /** The `upgrade` listener of the HTTP server is `upgrades.listener(app)`. */
  readonly upgrades: UpgradeRegistry;
  /** Closes every socket (1001) and every event stream. Idempotent. */
  close(): Promise<void>;
}

export function createTerminalServer(options: TerminalServerOptions): TerminalServer {
  const { ctx, ports, access, folders = null, logger, limits } = options;
  const upgrades = createUpgradeRegistry();
  const gateway = createTerminalGateway({
    access,
    logger,
    ...(limits?.socket === undefined ? {} : { limits: limits.socket }),
  });
  let events: TerminalEvents | undefined;

  const modules: RouteModule[] = [
    createAuthRoutes({ access, instanceId: ctx.instanceId }),
    createTerminalRoutes({ ports, epoch: ctx.db.epoch, now: () => ctx.clock.now() }),
    createTerminalEventsRoutes({
      ports,
      access,
      epoch: ctx.db.epoch,
      now: () => ctx.clock.now(),
      ...(limits?.events === undefined ? {} : { limits: limits.events }),
      onEvents: (created) => {
        events = created;
      },
    }),
    createTerminalSocketRoutes({ ports, gateway, upgrades }),
  ];
  if (folders !== null) modules.push(createFolderRoutes({ folders }));

  let closing: Promise<void> | null = null;
  return {
    modules,
    upgrades,
    close() {
      closing ??= (async () => {
        events?.closeAll();
        await gateway.closeAll(1001, TERMINAL_CLOSE_REASONS.shuttingDown);
      })();
      return closing;
    },
  };
}
