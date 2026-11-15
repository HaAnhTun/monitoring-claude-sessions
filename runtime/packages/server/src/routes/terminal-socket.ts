// The socket route of the terminal (CAW-25, design 02 5.2, ADR 0087): `GET /api/v3/terminal/sessions/:name/socket`. It is a
// normal route of the registry, so the guards and the access chain of `registerRoute` have already run (Host, Origin present and
// exact, fetch metadata, the session cookie) when the handler starts. The handler decides, in this order, and every refusal is
// the JSON envelope on the socket, which then closes (`upgrade.ts`):
//   1. no upgrade request (a plain GET, or an `Upgrade` that is not exactly `websocket`, which is all `ws` accepts): `426 upgrade_required`;
//   2. no usable terminal host: `503 terminal_unavailable`;
//   3. a handshake the protocol cannot use (key, version, a subprotocol list `ws` cannot parse, no `caw.terminal.v1` offered):
//      `400 validation_failed`, details by header name, never a value;
//   4. a name that holds no session: `404 terminal_not_found`;
//   5. the caps of the gateway: `503 stream_limit`;
//   then the socket is detached from the response object and handed to the gateway, which answers `101` and speaks protocol v1.
// The route logs nothing (a refusal is in the access log by route id and status; the gateway logs counts and close codes) and
// never writes a session name.
import type { IncomingMessage } from 'node:http';

import { TERMINAL_SUBPROTOCOL, routes, type ErrorDetail } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { accessOf } from '../http/access-guard.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';
import type { TerminalGateway, TerminalPorts } from '../terminal/ports.ts';
import type { UpgradeRegistry } from '../terminal/upgrade.ts';

export interface TerminalSocketRoutesOptions {
  /** The terminal host, or `null` when the instance has none (every socket is then `terminal_unavailable`). */
  readonly ports: TerminalPorts | null;
  readonly gateway: TerminalGateway;
  /** Where the `head` bytes of an upgrade request are kept (`createUpgradeRegistry`). */
  readonly upgrades: Pick<UpgradeRegistry, 'take'>;
}

/** What `Sec-WebSocket-Key` looks like: 16 random bytes in base64 (RFC 6455 4.1). */
const KEY_RE = /^[+/0-9A-Za-z]{22}==$/;

/** The tokens of a `Connection` header: a comma list, any case (RFC 9110 7.6.1). */
function connectionTokens(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
}

/**
 * True for a request that asks to upgrade to a WebSocket: `Connection` names `upgrade` (a token list, any case) and `Upgrade` is
 * `websocket` and nothing else, in any case. That is the test `ws` applies to `Upgrade`, and a request it would refuse must not get
 * past here: `ws` answers such a refusal as a raw `text/html` 400 instead of the JSON envelope.
 */
function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (
    req.headers.upgrade?.trim().toLowerCase() === 'websocket' &&
    connectionTokens(req.headers.connection).includes('upgrade')
  );
}

/** A name of the subprotocol list: the token characters of RFC 9110 5.6.2, with the blanks that may surround it. */
const SUBPROTOCOL_ELEMENT_RE = /^[\t ]*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)[\t ]*$/;

/**
 * Judges `Sec-WebSocket-Protocol` by the rules `ws` parses it with, so that whatever passes here is also parsed there (a list it
 * cannot parse is answered by `ws` as a raw `text/html` 400): comma separated names of token characters, no empty element, no
 * duplicate, and names compared as written, because `ws` hands the gateway the names as written and the gateway selects
 * `caw.terminal.v1` exactly. Node has already stripped the blanks around the whole value. A missing header, or one that does not
 * offer the subprotocol, is `invalid_value`; one that cannot be parsed is `invalid_format`. Never the value.
 */
function subprotocolFault(header: string | string[] | undefined): ErrorDetail | undefined {
  const path = 'Sec-WebSocket-Protocol';
  if (header === undefined) return { path, issue: 'invalid_value' };
  const offered = new Set<string>();
  for (const element of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const name = SUBPROTOCOL_ELEMENT_RE.exec(element)?.[1];
    if (name === undefined || offered.has(name)) return { path, issue: 'invalid_format' };
    offered.add(name);
  }
  return offered.has(TERMINAL_SUBPROTOCOL) ? undefined : { path, issue: 'invalid_value' };
}

/** The headers of the handshake that the protocol cannot use, by name only. */
function handshakeFaults(req: IncomingMessage): ErrorDetail[] {
  const faults: ErrorDetail[] = [];
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !KEY_RE.test(key)) faults.push({ path: 'Sec-WebSocket-Key', issue: 'invalid_format' });
  if (req.headers['sec-websocket-version'] !== '13')
    faults.push({ path: 'Sec-WebSocket-Version', issue: 'invalid_value' });
  // the subprotocol is required: a handshake that does not offer it is refused before the upgrade
  const protocolFault = subprotocolFault(req.headers['sec-websocket-protocol']);
  if (protocolFault !== undefined) faults.push(protocolFault);
  return faults;
}

/** The module that mounts the socket route. */
export function createTerminalSocketRoutes(options: TerminalSocketRoutesOptions): RouteModule {
  const { ports, gateway, upgrades } = options;

  return (app) => {
    registerRoute(app, routes.terminalSocket, ({ params, req, res }) => {
      const head = upgrades.take(req);
      if (head === undefined || !isWebSocketUpgrade(req)) throw new ApiError('upgrade_required');
      const admitted = accessOf(res);
      // the session guard admits a cookie only; anything else here is a wiring fault and gets no socket
      if (admitted?.via !== 'cookie') throw new ApiError('access_required');
      if (!ports?.capabilities().available) throw new ApiError('terminal_unavailable');
      const faults = handshakeFaults(req);
      if (faults.length > 0) throw new ApiError('validation_failed', { details: faults });
      const session = ports.sessions.get(params.name);
      if (session === null) throw new ApiError('terminal_not_found');
      gateway.admit(params.name);

      // from here the socket is the gateway's: the response object is abandoned and the adapter must not answer on it
      const { socket } = req;
      res.locals['handled'] = true;
      res.detachSocket(socket);
      try {
        gateway.accept({ req, socket, head, name: params.name, session, credentialId: admitted.session.credentialId });
      } catch (error: unknown) {
        socket.destroy();
        throw error;
      }
    });
  };
}
