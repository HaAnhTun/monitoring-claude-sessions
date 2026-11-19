// The REST routes of the terminal (CAW-20, design 02 2.1 and 8): the state, the start and the kill of a session, the folder
// dialog, the resume and the open in the native terminal. A handler asks the terminal host (`TerminalPorts`) and nothing else; the server starts no process.
//   - Usable ports: a host exists and says `capabilities().available`. Without them every route but the state answers
//     `terminal_unavailable`, and the state says so (`available: false`, the reason, an empty list), so the page can show why.
//   - Failures are the host's `TerminalError`: `mapError` turns each code into the code of the catalogue (and forwards its
//     `details`), so a handler adds no mapping. The one failure of this file's own is a `kill` of a name nobody holds.
//   - What reaches the port is only what the schemas let through: a session name is `TERMINAL_NAME_RE` (no dot, slash or NUL), a
//     folder path is not a UNC or device path and has no control character. The body never carries a command line.
//   - Logging: none. A handler never writes a folder path, a session name or an id; a failure is logged by the adapter with the
//     route id and a code only.
import { isoMsZ, routes, type TerminalCapabilities, type TerminalState } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';
import type { TerminalPorts } from '../terminal/ports.ts';

export interface TerminalRoutesOptions {
  /** The terminal host, or `null` when the instance has none (an unsupported system, the addon missing, nothing configured). */
  readonly ports: TerminalPorts | null;
  /** The stream epoch of this process (`ctx.db.epoch`). */
  readonly epoch: string;
  /** Epoch ms. */
  readonly now: () => number;
}

/** What the state says when there is no host at all. */
const NO_HOST: TerminalCapabilities = {
  available: false,
  reason: 'not_configured',
  folderPicker: false,
  resume: false,
  maxSessions: 0,
};

/** The module that mounts the six terminal routes; the access chain of `registerRoute` guards every one of them. */
export function createTerminalRoutes(options: TerminalRoutesOptions): RouteModule {
  const { ports, epoch, now } = options;

  /** The host when it can run a terminal; otherwise `terminal_unavailable`. */
  const usable = (): TerminalPorts => {
    if (!ports?.capabilities().available) throw new ApiError('terminal_unavailable');
    return ports;
  };

  return (app) => {
    registerRoute(app, routes.terminalState, (): TerminalState => {
      const capabilities = ports === null ? NO_HOST : ports.capabilities();
      return {
        capabilities,
        sessions: ports !== null && capabilities.available ? [...ports.sessions.list()] : [],
        epoch,
        generatedAt: isoMsZ(now()),
      };
    });

    registerRoute(app, routes.terminalCreateSession, async ({ body }) => {
      const session = await usable().sessions.create({ path: body.path });
      return { session };
    });

    registerRoute(app, routes.terminalKillSession, async ({ params }) => {
      const killed = await usable().sessions.kill(params.name);
      if (!killed) throw new ApiError('terminal_not_found');
      return { name: params.name };
    });

    registerRoute(app, routes.terminalPickFolder, async ({ signal }) => {
      const { picker } = usable();
      if (picker === null) throw new ApiError('terminal_unavailable');
      return { path: await picker.pick(signal) };
    });

    registerRoute(app, routes.terminalResume, async ({ body }) => {
      const session = await usable().resume({ sessionId: body.sessionId, fork: body.fork === true });
      return { session };
    });

    // CAW-145: a window of the person's own terminal. The body is the resume body (no folder, command or argument can be sent); the
    // host plans the folder. No logging here, like the other handlers: the host logs the way and the copy flag only.
    registerRoute(app, routes.terminalOpenNative, async ({ body }) => {
      return usable().openNative({ sessionId: body.sessionId, fork: body.fork === true });
    });
  };
}
